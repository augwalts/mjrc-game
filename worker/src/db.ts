/**
 * D1 access layer for the platform-services Worker.
 * Implements the query side of DESIGN.md §5.4 ("plain HTTP, no DO: identity,
 * match history, ... boring on purpose; queryable across all tables from day
 * 1") over ../schema.sql, which is migration 0001 and the authoritative shape.
 * Terminology: ../../TERMINOLOGY.md — HK Old Style only, in column names too.
 *
 * Four rules this file exists to hold:
 *
 *  1. PARAMETERISED ONLY. Every statement is a frozen constant in `SQL` with
 *     `?` placeholders. Nothing in here concatenates a value into SQL — not a
 *     LIMIT, not a cursor, not an ordering. A helper that needs a different
 *     shape gets its own constant rather than a string built at runtime.
 *
 *  2. ROWS ARE ROWS. Row interfaces carry the column names verbatim, in
 *     snake_case, because the point of a typed query helper is that what comes
 *     back is the row and not a translated copy of it. JSON columns keep their
 *     camelCase engine keys for the same reason (schema.sql, "Conventions").
 *
 *  3. NO AMBIENT TIME, NO AMBIENT RANDOMNESS. Timestamps and generated ids
 *     arrive as arguments. DESIGN.md §5.5 bans `Date.now` from anything that
 *     affects game state; the same discipline here is what makes the route
 *     tests assert on exact ids instead of on shapes. Credential material is
 *     the one thing that must NOT come from a seeded PRNG — see `randomId`.
 *
 *  4. SMALL AND INDEXED. Every read below is a primary-key lookup or a covered
 *     range over an index that schema.sql declares. The one exception is
 *     documented at `SQL.matchByJoinCode`.
 */
import type { Ruleset, SeatIndex, SelfDrawSettlement } from "@mjrc/engine";
import { isSpeed, type Speed } from "@mjrc/protocol";

/* ── the D1 surface actually used ──────────────────────────────────────────
 * Declared structurally rather than imported: the repo takes no dependencies
 * (DESIGN.md §8 — engine is "pure TS, no deps"), and a hand-written surface is
 * what makes the in-memory fake in ../test/db.test.ts possible at all. The real
 * `D1Database` satisfies these shapes.
 */

/** SQLite's storable scalars. `boolean` is deliberately absent: schema.sql
 *  stores booleans as INTEGER 0/1, and passing a JS boolean hides that. */
export type SqlValue = string | number | null;

export interface D1RunResult {
  success: boolean;
  /** Rows actually written. `INSERT OR IGNORE` reports 0 on a lost race. */
  meta: { changes: number };
}

export interface D1AllResult<T> {
  results: T[];
  success: boolean;
}

export interface D1Statement {
  bind(...values: SqlValue[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1AllResult<T>>;
  run(): Promise<D1RunResult>;
}

export interface D1Like {
  prepare(sql: string): D1Statement;
}

/* ── the R2 surface actually used ─────────────────────────────────────────── */

export interface R2ObjectLike {
  body: ReadableStream<Uint8Array> | null;
  size: number;
  httpEtag: string;
}

export interface R2Like {
  get(key: string): Promise<R2ObjectLike | null>;
}

/* ── encoding and digests ─────────────────────────────────────────────────── */

/**
 * Crockford base32 — the id alphabet schema.sql specifies, chosen to match the
 * Almanac's `users.id`. I, L, O and U are absent, so an id read aloud or typed
 * from a screenshot cannot become a different id.
 */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A random identifier of `length` Crockford symbols — 5 bits each.
 *
 * `random` is injected so tests are exact, and it is a CSPRNG in production
 * (`crypto.getRandomValues`), NEVER `prng(seed)` from engine/src/wall.ts. That
 * rule governs the wall and everything replay re-executes; a seat token or a
 * device credential drawn from a seeded, reproducible stream would be
 * guessable by anyone who knows the seed, which is the opposite of the point.
 */
export function randomId(random: (n: number) => Uint8Array, length: number): string {
  const bytes = random(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += CROCKFORD[bytes[i] % 32];
  return out;
}

/** Length of an app-generated id: 80 bits of entropy. */
export const ID_LENGTH = 16;

/** Join codes are ≥ 6 characters by DESIGN.md §5.3's abuse posture; 8 Crockford
 *  symbols is 40 bits, so guessing one is not a strategy even before the
 *  per-IP limit the lobby is meant to grow. The seat token stays the real gate. */
export const JOIN_CODE_LENGTH = 8;

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  }
  return out;
}

/** SHA-256, lowercase hex. The stored form of a device token — schema.sql:
 *  "a stolen database does not yield a usable credential". */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/**
 * Canonical JSON: object keys emitted in sorted order, at every depth.
 *
 * `JSON.stringify` walks keys in insertion order, so two structurally identical
 * rulesets built in different orders would hash differently and archive twice.
 * Sorting here is an explicit total order, which is exactly what DESIGN.md
 * §5.5's determinism rule asks for — the banned thing is *relying* on an
 * object's key order, not deciding one.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

/**
 * The archivable half of a Ruleset. `payment` is dropped because
 * `onDiscard`/`onSelfDraw` are functions and cannot be archived; schema.sql
 * records `payment_id` instead, so the row says which implementation was in
 * force without pretending to hold its source.
 */
export interface RulesetConfig {
  id: string;
  label: string;
  minimumFaan: number;
  limitFaan: number;
  useFlowers: boolean;
  paymentId: string;
  selfDrawSettlement: SelfDrawSettlement;
  faanTable: Record<string, number>;
}

export function rulesetConfig(r: Ruleset): RulesetConfig {
  return {
    id: r.id,
    label: r.label,
    minimumFaan: r.minimumFaan,
    limitFaan: r.limitFaan,
    useFlowers: r.useFlowers,
    paymentId: r.payment.id,
    selfDrawSettlement: r.payment.selfDraw,
    faanTable: r.faanTable,
  };
}

/** Content hash of a ruleset. `matches.ruleset_hash` points at this, so editing
 *  a faan value produces a new row and leaves every past match meaning what it
 *  meant (schema.sql, `rulesets`). */
export async function rulesetHash(r: Ruleset): Promise<string> {
  return sha256Hex(canonicalJson(rulesetConfig(r)));
}

/**
 * SQL enum values are snake_case (schema.sql, "Conventions"); the engine type
 * is camelCase. Translate at the boundary, in one named place, so nobody has to
 * guess which side of the wire a given spelling belongs to.
 */
export function selfDrawSettlementToColumn(s: SelfDrawSettlement): string {
  return s === "perPlayer" ? "per_player" : "total";
}

/* ── row types ────────────────────────────────────────────────────────────── */

export interface PlayerRow {
  id: string;
  kind: string;
  display_name: string;
  rating: number | null;
  rating_games: number;
  rating_season: string | null;
  /** §11 build decision 5 — the client's last-reported UTC offset, minutes.
   *  Defaults to 0 (UTC) for a device that has never sent one. */
  tz_offset_min: number;
}

/* ── the lobby (PVP-LOBBY-PROPOSAL-2026-09-02.md §7) ─────────────────────────
 * A seat spec is the creator's plan for one of the four seats, exactly as
 * submitted to `POST /api/tables` (§7.2) and stored verbatim in
 * `matches.seat_plan`. It is the one place a still-open seat's eventual bot
 * profile is recorded before the table ever opens — the header's `bot:<key>`
 * PlayerRef says the same thing but only for a seat the table HAS opened, so
 * `/fill` (worker/src/table.ts) and the lobby's `tables[]` view both read this
 * column instead.
 */
export type SeatKind = "human" | "bot";

export interface SeatSpec {
  kind: SeatKind;
  /** Bot catalogue key (gamepvp/src/bots.ts `BotCatalogueEntry.key`). Present
   *  iff `kind === 'bot'`; absent for a human seat. */
  bot?: string;
}

/** `matches.seat_plan` round-trips through this, never through a bare
 *  `JSON.parse` at a call site — a malformed or legacy-shape row must fail the
 *  same way everywhere it is read, not once per caller. */
export function parseSeatPlan(raw: string): SeatSpec[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return null;
  const plan: SeatSpec[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") return null;
    const kind = (entry as { kind?: unknown }).kind;
    if (kind === "human") {
      plan.push({ kind: "human" });
      continue;
    }
    if (kind === "bot") {
      const bot = (entry as { bot?: unknown }).bot;
      if (typeof bot !== "string" || bot === "") return null;
      plan.push({ kind: "bot", bot });
      continue;
    }
    return null;
  }
  return plan;
}

export function serializeSeatPlan(plan: readonly SeatSpec[]): string {
  return JSON.stringify(plan);
}

/** The four seat specs for a match row, tolerating rows written before
 *  `seat_plan` existed (schema.sql default `'[]'`, which `parseSeatPlan`
 *  rejects for being the wrong length) — those fall back to the OLD
 *  convention `bot_seats` alone used to mean: humans in the low seats, bots
 *  filling from the top. One fallback, shared by every reader (`postJoin`,
 *  the lobby), so a legacy row reads the same way everywhere. */
export function seatPlanOf(seatPlanJson: string, botSeats: number): SeatSpec[] {
  const parsed = parseSeatPlan(seatPlanJson);
  if (parsed !== null) return parsed;
  const firstBot = 4 - Math.max(0, Math.min(4, botSeats));
  return [0, 1, 2, 3].map((seat) =>
    seat < firstBot ? { kind: "human" as const } : { kind: "bot" as const },
  );
}

export interface MatchListRow {
  id: string;
  status: string;
  match_format: string;
  ruleset_id: string;
  rated: number;
  bot_seats: number;
  hand_count: number;
  room_code: string | null;
  join_code: string | null;
  log_key: string | null;
  started_at: string;
  ended_at: string | null;
  /** The caller's own seat, carried along so the list screen needs one query. */
  seat: number;
  place: number | null;
  final_chips: number;
  faan_won: number;
  rating_before: number | null;
  rating_after: number | null;
}

export interface MatchRow {
  id: string;
  status: string;
  match_format: string;
  ruleset_hash: string;
  ruleset_id: string;
  engine_version: string;
  log_schema_version: number;
  room_code: string | null;
  join_code: string | null;
  rated: number;
  bot_seats: number;
  hand_count: number;
  log_key: string | null;
  log_bytes: number | null;
  log_sha256: string | null;
  started_at: string;
  ended_at: string | null;
  access: string;
  mode: string;
  lobby_status: string;
  current_hand: number;
  hands_base: number;
  seat_plan: string;
  randomize_seats: number;
  created_by: string | null;
  /** §8a-2's clock speed, fixed at creation (`postTable`'s default rule, or a
   *  room's `settings.game.speed`) and carried into the table's `TableInit`. */
  speed: string;
}

/** Just enough of a match to decide whether its log may be served, and where
 *  from. Kept separate from MatchRow so the two blob routes read three columns
 *  rather than eighteen. */
export interface MatchLogRow {
  id: string;
  status: string;
  log_key: string | null;
}

export interface MatchSeatRow {
  seat: number;
  player_id: string;
  display_name: string;
  kind: string;
  wind: number;
  final_chips: number;
  faan_won: number;
  place: number | null;
  hands_won: number;
  self_draws: number;
  deal_ins: number;
  bot_takeover_hands: number;
  moves_graded: number;
  moves_matched: number;
  gap_sum: number;
  rating_before: number | null;
  rating_after: number | null;
}

export interface HandRow {
  hand_index: number;
  dealer_seat: number;
  round_wind: number;
  dealer_repeat: number;
  seed: number;
  outcome: string;
  winner_seat: number | null;
  win_from_seat: number | null;
  winning_tile: number | null;
  self_draw: number;
  robbed_kong: number;
  on_kong_replacement: number;
  faan: number;
  raw_faan: number;
  capped: number;
  /** FaanAward[] as JSON, camelCase keys. Parsed at the route, not here: a
   *  query helper that reshapes its rows stops being a query helper. */
  awards: string;
  delta_seat0: number;
  delta_seat1: number;
  delta_seat2: number;
  delta_seat3: number;
  refused_wins: number;
  wall_remaining: number | null;
  event_count: number;
  log_seq_start: number | null;
  log_seq_end: number | null;
  started_at: string;
  ended_at: string | null;
}

/* ── statements ───────────────────────────────────────────────────────────── */

/**
 * Every statement the Worker issues, by name. Frozen and exported for two
 * reasons: the fake D1 in the tests dispatches on identity rather than parsing
 * SQL, and a reviewer can read the whole query surface of the service in one
 * screen without chasing call sites.
 */
export const SQL = Object.freeze({
  /* identity */
  playerForCredential: `
    SELECT p.id, p.kind, p.display_name, p.rating, p.rating_games, p.rating_season, p.tz_offset_min
      FROM player_credentials c
      JOIN players p ON p.id = c.player_id
     WHERE c.id = ? AND c.revoked_at IS NULL AND p.deleted_at IS NULL`,

  insertPlayer: `
    INSERT INTO players (id, kind, display_name, created_at, updated_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)`,

  insertCredential: `
    INSERT INTO player_credentials (id, player_id, kind, label, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?)`,

  touchCredential: `
    UPDATE player_credentials SET last_used_at = ? WHERE id = ?`,

  touchPlayer: `
    UPDATE players SET last_seen_at = ?, updated_at = ? WHERE id = ?`,

  renamePlayer: `
    UPDATE players SET display_name = ?, updated_at = ?, last_seen_at = ? WHERE id = ?`,

  /* rulesets — archive once per content hash, never rewrite */
  archiveRuleset: `
    INSERT OR IGNORE INTO rulesets
      (hash, ruleset_id, label, minimum_faan, limit_faan, payment_id,
       self_draw_settlement, use_flowers, config, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  /* matches */
  insertMatch: `
    INSERT INTO matches
      (id, status, match_format, ruleset_hash, ruleset_id, engine_version,
       log_schema_version, room_code, join_code, rated, bot_seats, started_at,
       access, mode, lobby_status, hands_base, seat_plan, randomize_seats, created_by, speed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  matchById: `
    SELECT id, status, match_format, ruleset_hash, ruleset_id, engine_version,
           log_schema_version, room_code, join_code, rated, bot_seats,
           hand_count, log_key, log_bytes, log_sha256, started_at, ended_at,
           access, mode, lobby_status, current_hand, hands_base, seat_plan,
           randomize_seats, created_by, speed
      FROM matches
     WHERE id = ?`,

  /* Three columns, because deciding whether a blob may be served must not
   * require loading the match. */
  matchLogById: `
    SELECT id, status, log_key FROM matches WHERE id = ?`,

  /*
   * Join-by-code. `join_code` carries no index of its own; the partial index
   * idx_matches_running (status = 'running') bounds this to tables that are
   * live right now, which at P0 is a handful of rows. If the lobby ever holds
   * enough live tables for that to matter, the fix is an additive migration
   * adding a partial index on (join_code) WHERE status = 'running' — not a
   * different query. `status` leads the predicate on purpose so the planner
   * reaches for that index.
   */
  matchByJoinCode: `
    SELECT id, status, match_format, ruleset_hash, ruleset_id, engine_version,
           log_schema_version, room_code, join_code, rated, bot_seats,
           hand_count, log_key, log_bytes, log_sha256, started_at, ended_at,
           access, mode, lobby_status, current_hand, hands_base, seat_plan,
           randomize_seats, created_by, speed
      FROM matches
     WHERE status = 'running' AND join_code = ?`,

  /* "My matches", newest first — idx_match_players_player then PK lookups. */
  matchesForPlayer: `
    SELECT m.id, m.status, m.match_format, m.ruleset_id, m.rated, m.bot_seats,
           m.hand_count, m.room_code, m.join_code, m.log_key, m.started_at, m.ended_at,
           mp.seat, mp.place, mp.final_chips, mp.faan_won, mp.rating_before, mp.rating_after
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ?
     ORDER BY m.started_at DESC
     LIMIT ?`,

  /* Same read, one page older. A separate constant rather than a predicate
   * spliced into the one above — see rule 1 at the top of this file. */
  matchesForPlayerBefore: `
    SELECT m.id, m.status, m.match_format, m.ruleset_id, m.rated, m.bot_seats,
           m.hand_count, m.room_code, m.join_code, m.log_key, m.started_at, m.ended_at,
           mp.seat, mp.place, mp.final_chips, mp.faan_won, mp.rating_before, mp.rating_after
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND m.started_at < ?
     ORDER BY m.started_at DESC
     LIMIT ?`,

  /* The authorisation read. UNIQUE (match_id, player_id) makes it one probe. */
  seatOf: `
    SELECT seat FROM match_players WHERE match_id = ? AND player_id = ?`,

  seatsOfMatch: `
    SELECT mp.seat, mp.player_id, p.display_name, p.kind, mp.wind, mp.final_chips,
           mp.faan_won, mp.place, mp.hands_won, mp.self_draws, mp.deal_ins,
           mp.bot_takeover_hands, mp.moves_graded, mp.moves_matched, mp.gap_sum,
           mp.rating_before, mp.rating_after
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
     WHERE mp.match_id = ?
     ORDER BY mp.seat`,

  /*
   * OR IGNORE, not a pre-flight check: two clients joining the same code at the
   * same moment both compute the same free seat, and PRIMARY KEY (match_id,
   * seat) is what decides between them. `meta.changes` reports the loser, who
   * retries with the seat that is now visibly taken. Without this the loser's
   * insert raises, and a raised constraint is indistinguishable from a bug.
   */
  claimSeat: `
    INSERT OR IGNORE INTO match_players (match_id, seat, player_id, wind)
    VALUES (?, ?, ?, ?)`,

  handsOfMatch: `
    SELECT hand_index, dealer_seat, round_wind, dealer_repeat, seed, outcome,
           winner_seat, win_from_seat, winning_tile, self_draw, robbed_kong,
           on_kong_replacement, faan, raw_faan, capped, awards,
           delta_seat0, delta_seat1, delta_seat2, delta_seat3, refused_wins,
           wall_remaining, event_count, log_seq_start, log_seq_end,
           started_at, ended_at
      FROM hands
     WHERE match_id = ?
     ORDER BY hand_index`,

  /* ── the lobby ──────────────────────────────────────────────────────────
   * Three statements, one per `GET /api/lobby` panel (proposal §3.3: "three
   * queries"). Seat detail for a given match is a fourth, reused per match
   * rather than folded into a join — `match_players` holds a row only for a
   * seat a HUMAN has claimed (bots never claim through `claimSeat`), so the
   * lobby always falls back to `seat_plan` for a bot's display name anyway;
   * keeping this as its own statement means that fallback lives in one place
   * (index.ts `lobbySeats`) instead of duplicated per caller.
   */

  /** Everyone who pinged presence inside the "here now" window (index.ts
   *  `HERE_WINDOW_MS`). `p.deleted_at IS NULL` — a soft-deleted player's stale
   *  heartbeat must not resurrect them in the lobby. */
  presenceSince: `
    SELECT pr.player_id, pr.state, pr.seen_at, p.display_name
      FROM presence pr
      JOIN players p ON p.id = pr.player_id
     WHERE pr.seen_at >= ? AND p.deleted_at IS NULL`,

  /** The room-scoped `here` source (§8b: "members seen recently ... at the
   *  room's tables"). `presence` carries no room column — deliberately, see
   *  schema.sql — so scoping by room means joining through `room_players`
   *  instead of filtering `presence` itself. */
  presenceInRoom: `
    SELECT pr.player_id, pr.state, pr.seen_at, p.display_name
      FROM presence pr
      JOIN players p ON p.id = pr.player_id
      JOIN room_players rp ON rp.room_code = ? AND rp.player_id = pr.player_id AND rp.archived_at IS NULL
     WHERE pr.seen_at >= ? AND p.deleted_at IS NULL`,

  /** One row per player per heartbeat — presence is current state, not
   *  history, so this is always exactly one row before and after. */
  upsertPresence: `
    INSERT INTO presence (player_id, state, seen_at)
    VALUES (?, ?, ?)
    ON CONFLICT (player_id) DO UPDATE SET state = excluded.state, seen_at = excluded.seen_at`,

  /** The open-table panel: every match still looking for humans or still
   *  playing, newest first. Bounded defensively — the lobby lists "every"
   *  such table, and at P0 scale that is never near this many, but an
   *  unbounded read here is the one query on this screen with no natural cap.
   *
   *  UNFILTERED by room, on purpose (§8b, "the global lobby's `here`"): the
   *  global `GET /api/lobby` reads every waiting/playing table, room-scoped
   *  ones included, so a seated room member still shows up in `here` (tagged
   *  with their room code) even though `tables[]` renders only the rows
   *  whose `room_code IS NULL` — that filter happens in index.ts, not here,
   *  because `here` needs the rows this query's room-scoped sibling below
   *  would throw away. */
  matchesWaitingOrPlaying: `
    SELECT id, match_format, ruleset_id, access, mode, lobby_status,
           current_hand, hands_base, seat_plan, bot_seats, created_by,
           started_at, join_code, room_code, speed
      FROM matches
     WHERE lobby_status IN ('waiting', 'playing')
     ORDER BY started_at DESC
     LIMIT ?`,

  /** The same panel, scoped to one room (§8b `GET /api/lobby?room=CODE`) —
   *  a separate constant rather than a predicate spliced into the one above,
   *  per rule 1 at the top of this file. */
  matchesWaitingOrPlayingInRoom: `
    SELECT id, match_format, ruleset_id, access, mode, lobby_status,
           current_hand, hands_base, seat_plan, bot_seats, created_by,
           started_at, join_code, room_code, speed
      FROM matches
     WHERE lobby_status IN ('waiting', 'playing') AND room_code = ?
     ORDER BY started_at DESC
     LIMIT ?`,

  /** The recent-results strip: last N finished, newest first. `room_code IS
   *  NULL` (§8b decision 3): the global lobby's `recent` excludes room
   *  matches, same as `tables[]` — a room's own results belong to
   *  `matchesDoneInRoom`, read through `GET /api/lobby?room=CODE`. */
  matchesDone: `
    SELECT id, mode, ended_at
      FROM matches
     WHERE lobby_status = 'done' AND room_code IS NULL
     ORDER BY ended_at DESC
     LIMIT ?`,

  /** The room-scoped sibling of the above. */
  matchesDoneInRoom: `
    SELECT id, mode, ended_at
      FROM matches
     WHERE lobby_status = 'done' AND room_code = ?
     ORDER BY ended_at DESC
     LIMIT ?`,

  /** A match's HUMAN seats only — bots never appear here (see header comment).
   *  `connected` is the table object's own cache (schema.sql match_players,
   *  "Lobby-facing"), not derived from anything this query can see. */
  /** `AND p.kind = 'human'` is load-bearing, not defensive: bot seats got
   *  their OWN `match_players` rows once item 1 of the ranked-settlement
   *  brief landed (worker/src/table.ts `claimBotSeat`, gamepvp/src/index.ts
   *  `ensureBotSeatRows`) — before that, "nothing ever inserts one for a bot
   *  seat" was true by construction and this filter was unnecessary. The
   *  lobby still wants ONLY the human row here: a bot seat's label and
   *  "connected" (always false) come from `seat_plan` instead (`getLobby`'s
   *  `spec.kind === 'bot'` branch), which is the only place a bot's identity
   *  needs to reach the lobby view from. */
  humanSeatsOfMatch: `
    SELECT mp.seat, mp.player_id, p.display_name, mp.connected
      FROM match_players mp
      JOIN players p ON p.id = mp.player_id
     WHERE mp.match_id = ? AND p.kind = 'human'
     ORDER BY mp.seat`,

  /* ── lobby chat (§8) ────────────────────────────────────────────────────
   * `display_name` is stored on the row (schema.sql lobby_messages), so
   * neither statement joins `players` — the same reason `hands.awards`
   * carries stable ids rather than a lookup: a read-only history must not
   * change meaning under a later rename.
   */

  insertLobbyMessage: `
    INSERT INTO lobby_messages (player_id, display_name, text, room_code, created_at)
    VALUES (?, ?, ?, ?, ?)`,

  /** The one row the 1-per-2s rate check needs — this player's newest
   *  message, via idx_lobby_messages_player. One shared rate limit across
   *  global and every room's chat, deliberately: it is a per-player flood
   *  guard, not a per-surface budget. */
  lastLobbyMessageForPlayer: `
    SELECT created_at
      FROM lobby_messages
     WHERE player_id = ?
     ORDER BY id DESC
     LIMIT 1`,

  /** Newest `limit` GLOBAL messages (`room_code IS NULL`, §8b decision 3);
   *  the caller reverses to chronological order. */
  recentLobbyMessages: `
    SELECT id, player_id, display_name, text, created_at
      FROM lobby_messages
     WHERE room_code IS NULL
     ORDER BY id DESC
     LIMIT ?`,

  /** The room-scoped sibling of the above. */
  recentLobbyMessagesInRoom: `
    SELECT id, player_id, display_name, text, created_at
      FROM lobby_messages
     WHERE room_code = ?
     ORDER BY id DESC
     LIMIT ?`,

  /* ── stats and leaderboards (PVP-LOBBY-PROPOSAL-2026-09-02.md §7.2's last
   * two bullets) ────────────────────────────────────────────────────────── */

  playerById: `
    SELECT id, kind, display_name, rating, rating_games, rating_season, tz_offset_min
      FROM players
     WHERE id = ? AND deleted_at IS NULL`,

  /** §11 build decision 5: the client's UTC offset, minutes, set on identity
   *  and on every presence heartbeat that carries one. */
  updatePlayerTzOffset: `
    UPDATE players SET tz_offset_min = ? WHERE id = ?`,

  /** Every completed match this player was ever seated at, folded into one
   *  row — `match_players`/`matches` are canonical, this is a read-time fold
   *  over them, not a stored projection (schema.sql, "Regenerable vs
   *  stateful"). `place BETWEEN 1 AND 4` gates the whole row on a completed
   *  match, so `matches.status = 'complete'` needs no separate predicate. */
  statsTotalsForPlayer: `
    SELECT
      COUNT(*) AS matches,
      SUM(CASE WHEN m.mode = 'ranked' THEN 1 ELSE 0 END) AS ranked,
      SUM(CASE WHEN m.mode = 'casual' THEN 1 ELSE 0 END) AS casual,
      SUM(CASE WHEN mp.place = 1 THEN 1 ELSE 0 END) AS place1,
      SUM(CASE WHEN mp.place = 2 THEN 1 ELSE 0 END) AS place2,
      SUM(CASE WHEN mp.place = 3 THEN 1 ELSE 0 END) AS place3,
      SUM(CASE WHEN mp.place = 4 THEN 1 ELSE 0 END) AS place4,
      SUM(mp.hands_won) AS hands_won,
      SUM(mp.self_draws) AS self_draws,
      SUM(mp.deal_ins) AS deal_ins,
      SUM(mp.moves_graded) AS moves_graded,
      SUM(mp.moves_matched) AS moves_matched
    FROM match_players mp
    JOIN matches m ON m.id = mp.match_id
   WHERE mp.player_id = ? AND m.status = 'complete'`,

  /** Mean faan of every hand this player WON — `avgFaan` in the stats
   *  contract. Separate from `statsTotalsForPlayer` because it reads `hands`,
   *  not `match_players`, and mixing the two into one query would force a
   *  join whose row count no longer matches either table's own grain. */
  avgFaanForPlayer: `
    SELECT AVG(faan) AS avg_faan, COUNT(*) AS n
      FROM hands
     WHERE winner_player_id = ?`,

  /** Net chips across every hand this player was ever dealt into — the sum of
   *  the seat's own delta column, hand by hand, joined through `match_players`
   *  rather than stored anywhere: `hands.delta_seat<N>` is keyed by physical
   *  seat, and this player's seat can differ match to match. `netChips` in the
   *  stats contract. */
  netChipsForPlayer: `
    SELECT SUM(
      CASE mp.seat
        WHEN 0 THEN h.delta_seat0 WHEN 1 THEN h.delta_seat1
        WHEN 2 THEN h.delta_seat2 WHEN 3 THEN h.delta_seat3
      END
    ) AS net_chips
      FROM match_players mp
      JOIN hands h ON h.match_id = mp.match_id
     WHERE mp.player_id = ?`,

  /** Last 10 completed matches, newest first — the stats screen's "recent"
   *  list. `rating_before`/`rating_after` are null on a casual match; the
   *  route derives `ratingDelta` from the pair rather than reading a stored
   *  delta column, which does not exist. */
  recentMatchesForPlayer: `
    SELECT m.id AS match_id, m.ended_at AS ended_at, m.mode AS mode,
           mp.place AS place, mp.final_chips AS final_chips,
           mp.rating_before AS rating_before, mp.rating_after AS rating_after
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND m.status = 'complete'
     ORDER BY m.ended_at DESC
     LIMIT ?`,

  /** Last 30 rating changes, newest first — `idx_rating_history_player`
   *  covers this exactly (player_id, id DESC). */
  ratingHistoryForPlayer: `
    SELECT created_at AS at, rating_before AS before, rating_after AS after, match_id
      FROM rating_history
     WHERE player_id = ?
     ORDER BY id DESC
     LIMIT ?`,

  /** Ranked leaderboard: humans with at least one rated match, by rating
   *  desc — `idx_players_rating` (rating_season, rating DESC) WHERE kind =
   *  'human' AND deleted_at IS NULL AND rating IS NOT NULL covers this. */
  leaderboardRanked: `
    SELECT id, display_name, rating, rating_games
      FROM players
     WHERE kind = 'human' AND deleted_at IS NULL
       AND rating_season = ? AND rating_games >= 1
     ORDER BY rating DESC
     LIMIT ?`,

  /** Casual leaderboard: humans by wins then matches, over CASUAL matches
   *  only. An aggregate scan of `match_players`/`matches`/`players`, not an
   *  indexed point read — acceptable at P0's scale (worker/README.md), the
   *  same judgement call `matchesWaitingOrPlaying`'s defensive LIMIT makes. */
  leaderboardCasual: `
    SELECT p.id AS player_id, p.display_name AS display_name,
           COUNT(*) AS matches,
           SUM(CASE WHEN mp.place = 1 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN mp.place = 1 THEN 1 ELSE 0 END) AS place1,
           SUM(CASE WHEN mp.place = 2 THEN 1 ELSE 0 END) AS place2,
           SUM(CASE WHEN mp.place = 3 THEN 1 ELSE 0 END) AS place3,
           SUM(CASE WHEN mp.place = 4 THEN 1 ELSE 0 END) AS place4,
           SUM(mp.moves_graded) AS moves_graded,
           SUM(mp.moves_matched) AS moves_matched
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      JOIN players p ON p.id = mp.player_id
     WHERE m.mode = 'casual' AND m.status = 'complete'
       AND p.kind = 'human' AND p.deleted_at IS NULL
     GROUP BY p.id
     ORDER BY wins DESC, matches DESC
     LIMIT ?`,

  /* ── rooms (§8b) — `rooms`/`room_players`, not this schema's tables; see
   * schema.sql's "rooms" note and this file's own note above `RoomRow`. */

  roomByCode: `
    SELECT code, name, settings, admin_code_hash, created_at, updated_at
      FROM rooms
     WHERE code = ?`,

  /* `password_hash`/`password_attempts`/`password_locked_until` are the
   * Almanac's own fields (0004, reserved for a future password flow the game
   * does not use) — left at their column defaults (NULL / 0 / NULL) exactly
   * as an Almanac-created room would start out. */
  insertRoom: `
    INSERT OR IGNORE INTO rooms (code, name, password_hash, password_attempts, settings, admin_code_hash, created_at, updated_at)
    VALUES (?, ?, NULL, 0, ?, ?, ?, ?)`,

  /* The one write path that may touch `settings` after creation
   * (`postRoomSettings`) — always the WHOLE column, via
   * `withRoomGameSettings`, never a partial JSON patch: SQLite has no JSON1
   * guarantee here and D1's dialect stays "dialect-identical to the
   * Almanac's" (schema.sql, "Conventions"), which rules out relying on it. */
  updateRoomSettings: `
    UPDATE rooms SET settings = ?, updated_at = ? WHERE code = ?`,

  /* OR IGNORE: `room_players` PRIMARY KEY (room_code, player_id) makes a
   * repeat join a no-op, same doctrine as `claimSeat`. A rename does not
   * update this row — same "denormalized at write time, never rewritten"
   * rule `lobby_messages.display_name` follows; the game's own player
   * identity is the freshness source, this row is just room membership. */
  insertRoomPlayer: `
    INSERT OR IGNORE INTO room_players (room_code, player_id, name, seed_rating, archived_at)
    VALUES (?, ?, ?, NULL, NULL)`,

  roomMember: `
    SELECT 1 AS present
      FROM room_players
     WHERE room_code = ? AND player_id = ? AND archived_at IS NULL`,

  roomMemberCount: `
    SELECT COUNT(*) AS n
      FROM room_players
     WHERE room_code = ? AND archived_at IS NULL`,

  /** Every member's id — the room-notice fan-out (`postTable`'s §8 "room"
   *  inbox items) and `GET /api/rooms/:code`'s `players[]` membership
   *  filter both need the plain id list, not the display-name join. */
  roomPlayerIds: `
    SELECT player_id
      FROM room_players
     WHERE room_code = ? AND archived_at IS NULL`,

  /* "My rooms" (`GET /api/rooms/mine`), most recently touched first. */
  roomsForPlayer: `
    SELECT r.code, r.name, r.settings, r.admin_code_hash, r.created_at, r.updated_at
      FROM room_players rp
      JOIN rooms r ON r.code = rp.room_code
     WHERE rp.player_id = ? AND rp.archived_at IS NULL
     ORDER BY r.updated_at DESC`,

  /* `POST /api/rooms/:code/tables/:matchId/close` (admin, phase 2): a
   * WAITING table only — a playing or done table has nothing this route
   * should touch, and the caller checks `lobby_status` before calling this,
   * same doctrine as `postStart`'s D1-read-then-DO-call ordering. Does not
   * touch the Table DO: a waiting table's clocks never started, so there is
   * no live match state to reach for. */
  abandonWaitingMatch: `
    UPDATE matches
       SET status = 'abandoned', lobby_status = 'done', ended_at = ?
     WHERE id = ? AND lobby_status = 'waiting'`,

  /* ── friends (PVP-LOBBY-PROPOSAL-2026-09-02.md §11 build decision 1) ──────
   * "Friends" is not a table: everyone the caller has ever finished a match
   * with, folded at read time over `match_players`/`matches`, same doctrine
   * as `statsTotalsForPlayer`. `DISTINCT` is not needed — `GROUP BY` already
   * collapses repeats — but the join's second `match_players` alias (`mp2`)
   * is: every OTHER human seat of every match `mp`'s player finished. */
  friendsOfPlayer: `
    SELECT mp2.player_id AS friend_id, p.display_name AS display_name,
           p.rating AS rating, p.rating_games AS rating_games, p.last_seen_at AS last_seen_at,
           COUNT(DISTINCT mp.match_id) AS games
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id AND m.status = 'complete'
      JOIN match_players mp2 ON mp2.match_id = mp.match_id AND mp2.player_id <> mp.player_id
      JOIN players p ON p.id = mp2.player_id AND p.kind = 'human' AND p.deleted_at IS NULL
     WHERE mp.player_id = ?
     GROUP BY mp2.player_id`,

  insertFriendStar: `
    INSERT OR IGNORE INTO friend_stars (player_id, friend_id, created_at)
    VALUES (?, ?, ?)`,

  deleteFriendStar: `
    DELETE FROM friend_stars WHERE player_id = ? AND friend_id = ?`,

  friendStarsOfPlayer: `
    SELECT friend_id FROM friend_stars WHERE player_id = ?`,

  /* ── direct messages (§8) ─────────────────────────────────────────────── */

  insertDmMessage: `
    INSERT INTO dm_messages (from_player_id, to_player_id, text, created_at)
    VALUES (?, ?, ?, ?)`,

  /** One thread, either direction, oldest-first read by the caller reversing
   *  (same convention `recentLobbyMessages` uses) — newest 100 read here,
   *  newest-first, via `idx_dm_messages_from`/`idx_dm_messages_to`'s shared
   *  shape (both columns of the pair, id DESC). */
  dmThread: `
    SELECT id, from_player_id, to_player_id, text, created_at, read_at
      FROM dm_messages
     WHERE (from_player_id = ? AND to_player_id = ?)
        OR (from_player_id = ? AND to_player_id = ?)
     ORDER BY id DESC
     LIMIT ?`,

  /** Mark every message TO the caller FROM this counterpart read, in one
   *  statement — `GET /api/dm/:playerId`'s own read is what triggers this. */
  markDmThreadRead: `
    UPDATE dm_messages
       SET read_at = ?
     WHERE to_player_id = ? AND from_player_id = ? AND read_at IS NULL`,

  /** This sender's newest message, for the 1-per-2s rate check — same
   *  doctrine as `lastLobbyMessageForPlayer`. */
  lastDmMessageAt: `
    SELECT created_at FROM dm_messages
     WHERE from_player_id = ?
     ORDER BY id DESC
     LIMIT 1`,

  /** Every message touching the caller, newest first, bounded — the raw feed
   *  `GET /api/inbox` folds into per-counterpart thread summaries in
   *  application code (index.ts), the same "union built in JS, not SQL"
   *  doctrine `getLobby`'s `here` map already follows. */
  dmMessagesInvolving: `
    SELECT id, from_player_id, to_player_id, text, created_at, read_at
      FROM dm_messages
     WHERE from_player_id = ? OR to_player_id = ?
     ORDER BY id DESC
     LIMIT ?`,

  /* ── inbox (§8) ───────────────────────────────────────────────────────── */

  insertInboxItem: `
    INSERT OR IGNORE INTO inbox_items
      (id, player_id, kind, match_id, room_code, from_player_id, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

  inboxItemsForPlayer: `
    SELECT id, player_id, kind, match_id, room_code, from_player_id, text,
           created_at, read_at, dismissed_at
      FROM inbox_items
     WHERE player_id = ? AND dismissed_at IS NULL
     ORDER BY created_at DESC
     LIMIT ?`,

  inboxItemById: `
    SELECT id, player_id, kind, match_id, room_code, from_player_id, text,
           created_at, read_at, dismissed_at
      FROM inbox_items
     WHERE id = ?`,

  /** Accept and dismiss both end with this — the item leaves the live list
   *  either way (§8's `POST /api/inbox/:id/accept` and `.../dismiss`). */
  dismissInboxItem: `
    UPDATE inbox_items
       SET dismissed_at = ?, read_at = COALESCE(read_at, ?)
     WHERE id = ? AND player_id = ? AND dismissed_at IS NULL`,

  /* ── stats (§10) ──────────────────────────────────────────────────────── */

  /**
   * Every completed match the caller played that matches the scope, newest
   * first, bounded defensively (`STATS_SCOPE_LIMIT`, index.ts) — `lastN`
   * narrows this further by SLICING the (already newest-first) result in
   * application code rather than a second bound parameter, same "the cheap
   * knob lives in JS" doctrine `GET /api/matches`' `limit` clamp uses.
   *
   * Each optional filter is `(? IS NULL OR col = ?)`, the same value bound
   * twice — SQLite has no named parameters here (rule 1 at the top of this
   * file: `?` only), so an absent filter costs one redundant `IS NULL` check
   * rather than a second frozen statement per filter combination, which
   * would be 2^4 constants for four optional filters.
   */
  matchesForPlayerScoped: `
    SELECT m.id AS id, m.started_at AS started_at, m.ended_at AS ended_at,
           m.mode AS mode, m.ruleset_id AS ruleset_id, m.room_code AS room_code,
           m.hand_count AS hand_count,
           mp.seat AS seat, mp.place AS place, mp.final_chips AS final_chips,
           mp.hands_won AS hands_won, mp.self_draws AS self_draws, mp.deal_ins AS deal_ins,
           mp.moves_graded AS moves_graded, mp.moves_matched AS moves_matched,
           mp.rating_before AS rating_before, mp.rating_after AS rating_after
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ? AND m.status = 'complete'
       AND (? IS NULL OR m.mode = ?)
       AND (? IS NULL OR m.ruleset_id = ?)
       AND (? IS NULL OR m.room_code = ?)
       AND (? IS NULL OR m.started_at >= ?)
     ORDER BY m.started_at DESC
     LIMIT ?`,

  /** Candidate players for a leaderboard under the same scope shape as
   *  `matchesForPlayerScoped` — "minimum 5 games" (§10) is `HAVING`, not a
   *  post-filter, so the LIMIT above it is meaningful. Sorting (by rating or
   *  by worthPerHand) happens in index.ts once each candidate's Dataset A
   *  row is folded — worth/hand is not a SQL-aggregable quantity (it is a
   *  per-game ratio averaged across games, see `computeRecordRow`). */
  leaderboardCandidates: `
    SELECT p.id AS player_id, p.rating AS rating, p.rating_games AS rating_games,
           COUNT(*) AS games
      FROM match_players mp
      JOIN matches m ON m.id = mp.match_id
      JOIN players p ON p.id = mp.player_id
     WHERE m.status = 'complete' AND p.kind = 'human' AND p.deleted_at IS NULL
       AND (? IS NULL OR m.mode = ?)
       AND (? IS NULL OR m.ruleset_id = ?)
       AND (? IS NULL OR m.room_code = ?)
       AND (? IS NULL OR m.started_at >= ?)
     GROUP BY p.id
    HAVING COUNT(*) >= 5`,
});

/* ── identity ─────────────────────────────────────────────────────────────── */

/** Resolve a presented device token's digest to the player it authenticates.
 *  Revoked credentials and soft-deleted players resolve to null by the query,
 *  not by a filter a caller has to remember. */
export function playerForCredential(db: D1Like, credentialId: string): Promise<PlayerRow | null> {
  return db.prepare(SQL.playerForCredential).bind(credentialId).first<PlayerRow>();
}

export interface NewPlayer {
  id: string;
  kind: "human" | "bot";
  displayName: string;
  now: string;
}

export async function insertPlayer(db: D1Like, p: NewPlayer): Promise<void> {
  await db
    .prepare(SQL.insertPlayer)
    .bind(p.id, p.kind, p.displayName, p.now, p.now, p.now)
    .run();
}

export interface NewCredential {
  /** SHA-256 of the device token, or the passkey credential id. Never the token. */
  id: string;
  playerId: string;
  kind: "device" | "passkey";
  label: string | null;
  now: string;
}

export async function insertCredential(db: D1Like, c: NewCredential): Promise<void> {
  await db
    .prepare(SQL.insertCredential)
    .bind(c.id, c.playerId, c.kind, c.label, c.now, c.now)
    .run();
}

/** Mark a credential and its player as seen. Two statements rather than a join
 *  update, because D1 has no UPDATE ... FROM. */
export async function touchCredential(
  db: D1Like,
  credentialId: string,
  playerId: string,
  now: string,
): Promise<void> {
  await db.prepare(SQL.touchCredential).bind(now, credentialId).run();
  await db.prepare(SQL.touchPlayer).bind(now, now, playerId).run();
}

export async function renamePlayer(
  db: D1Like,
  playerId: string,
  displayName: string,
  now: string,
): Promise<void> {
  await db.prepare(SQL.renamePlayer).bind(displayName, now, now, playerId).run();
}

/* ── rulesets ─────────────────────────────────────────────────────────────── */

/** Archive a ruleset's bytes if this content hash has never been seen. Idempotent
 *  by construction: the same config always hashes the same, and OR IGNORE makes
 *  the second write a no-op rather than a conflict. */
export async function archiveRuleset(
  db: D1Like,
  hash: string,
  r: Ruleset,
  now: string,
): Promise<void> {
  const config = rulesetConfig(r);
  await db
    .prepare(SQL.archiveRuleset)
    .bind(
      hash,
      r.id,
      r.label,
      r.minimumFaan,
      r.limitFaan,
      r.payment.id,
      selfDrawSettlementToColumn(r.payment.selfDraw),
      r.useFlowers ? 1 : 0,
      canonicalJson(config),
      now,
    )
    .run();
}

/* ── matches ──────────────────────────────────────────────────────────────── */

export interface NewMatch {
  id: string;
  matchFormat: string;
  rulesetHash: string;
  rulesetId: string;
  engineVersion: string;
  logSchemaVersion: number;
  roomCode: string | null;
  joinCode: string | null;
  rated: boolean;
  botSeats: number;
  now: string;
  /** open | private (schema.sql matches.access). */
  access: string;
  /** casual | ranked (schema.sql matches.mode). */
  mode: string;
  /** 4 for `east`, 16 for `full` (schema.sql matches.hands_base). */
  handsBase: number;
  /** The four seat specs as submitted, JSON — `serializeSeatPlan`. */
  seatPlan: string;
  randomizeSeats: boolean;
  createdBy: string;
  /** §8a-2's clock speed, resolved by `postTable` before the row is written. */
  speed: Speed;
}

export async function insertMatch(db: D1Like, m: NewMatch): Promise<void> {
  await db
    .prepare(SQL.insertMatch)
    .bind(
      m.id,
      "running",
      m.matchFormat,
      m.rulesetHash,
      m.rulesetId,
      m.engineVersion,
      m.logSchemaVersion,
      m.roomCode,
      m.joinCode,
      m.rated ? 1 : 0,
      m.botSeats,
      m.now,
      m.access,
      m.mode,
      /* lobby_status starts 'waiting' always — a match is never created
       * mid-play. The table object moves it to 'playing' once clocks start. */
      "waiting",
      m.handsBase,
      m.seatPlan,
      m.randomizeSeats ? 1 : 0,
      m.createdBy,
      m.speed,
    )
    .run();
}

export function matchById(db: D1Like, matchId: string): Promise<MatchRow | null> {
  return db.prepare(SQL.matchById).bind(matchId).first<MatchRow>();
}

export function matchLogById(db: D1Like, matchId: string): Promise<MatchLogRow | null> {
  return db.prepare(SQL.matchLogById).bind(matchId).first<MatchLogRow>();
}

export function matchByJoinCode(db: D1Like, joinCode: string): Promise<MatchRow | null> {
  return db.prepare(SQL.matchByJoinCode).bind(joinCode).first<MatchRow>();
}

export async function matchesForPlayer(
  db: D1Like,
  playerId: string,
  limit: number,
  before: string | null,
): Promise<MatchListRow[]> {
  const stmt =
    before === null
      ? db.prepare(SQL.matchesForPlayer).bind(playerId, limit)
      : db.prepare(SQL.matchesForPlayerBefore).bind(playerId, before, limit);
  const { results } = await stmt.all<MatchListRow>();
  return results;
}

/**
 * The authorisation primitive for every match-scoped route: which seat, if any,
 * this player holds in this match. `null` means not a participant, and every
 * caller treats that identically to "no such match" — see the route layer.
 */
export async function seatOf(
  db: D1Like,
  matchId: string,
  playerId: string,
): Promise<number | null> {
  const row = await db.prepare(SQL.seatOf).bind(matchId, playerId).first<{ seat: number }>();
  return row === null ? null : row.seat;
}

export async function seatsOfMatch(db: D1Like, matchId: string): Promise<MatchSeatRow[]> {
  const { results } = await db.prepare(SQL.seatsOfMatch).bind(matchId).all<MatchSeatRow>();
  return results;
}

/** Claim a seat. Returns false when another client took it first; the caller
 *  re-reads the table and tries the next free seat. */
export async function claimSeat(
  db: D1Like,
  matchId: string,
  seat: SeatIndex,
  playerId: string,
): Promise<boolean> {
  /* wind = seat: this is the seat's wind at the FIRST deal, which is what fixes
   * the rotation order (schema.sql, match_players). It is not the seat's wind in
   * any later hand — that derives from hands.dealer_seat. */
  const res = await db.prepare(SQL.claimSeat).bind(matchId, seat, playerId, seat).run();
  return res.meta.changes > 0;
}

export async function handsOfMatch(db: D1Like, matchId: string): Promise<HandRow[]> {
  const { results } = await db.prepare(SQL.handsOfMatch).bind(matchId).all<HandRow>();
  return results;
}

/* ── rooms (PVP-LOBBY-PROPOSAL-2026-09-02.md §8b) ────────────────────────────
 * `rooms`/`room_players` are NOT this schema's tables — see schema.sql's
 * "rooms" note. These helpers read and write them anyway, over the same `db`
 * every other query in this file uses (one D1 database, `mjrc-scoring`), with
 * the same discipline: parameterised, frozen statements, rows are rows.
 */

export interface RoomRow {
  code: string;
  name: string;
  /** JSON. The game reads/writes only the `game` key — see
   *  `roomGameSettingsOf`/`withRoomGameSettings`. Never round-tripped through
   *  a narrower type: the Almanac's own keys (rulesetPresetId, purpose,
   *  leaderboard, notes) must survive a game write untouched. */
  settings: string;
  /** sha256 hex, or null when the room has no code of its own (0011). Never
   *  serve this column to a client — same rule the Almanac's own
   *  room-admin middleware states. */
  admin_code_hash: string | null;
  created_at: string;
  updated_at: string;
}

/** The game's own corner of `rooms.settings`, `{ rulesetId, matchFormat,
 *  access }` per §8b, plus an optional `speed` (§8a-2): when a room sets it,
 *  every table created in that room is fixed to it — `postTable` never falls
 *  back to its own default for a room that has one. */
export interface RoomGameSettings {
  rulesetId: string;
  matchFormat: string; // east | full
  access: string; // open | private
  speed?: Speed;
}

/** `rooms.settings` round-trips through this, never through a bare
 *  `JSON.parse` at a call site — same doctrine as `parseSeatPlan`. Malformed
 *  or absent JSON degrades to `{}` rather than throwing: a room row this
 *  file cannot parse must still be readable, just with no `game` key. */
export function parseRoomSettings(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Pull `settings.game` out, or null when the room has never had one set —
 *  the state every room is in until `POST /api/rooms` or `POST
 *  /api/rooms/:code/settings` writes it. */
export function roomGameSettingsOf(settings: Record<string, unknown>): RoomGameSettings | null {
  const game = settings.game;
  if (game === null || typeof game !== "object" || Array.isArray(game)) return null;
  const g = game as Record<string, unknown>;
  if (typeof g.rulesetId !== "string" || typeof g.matchFormat !== "string") return null;
  return {
    rulesetId: g.rulesetId,
    matchFormat: g.matchFormat,
    access: typeof g.access === "string" ? g.access : "open",
    speed: isSpeed(g.speed) ? g.speed : undefined,
  };
}

/** Replace `settings.game`, leaving every other key — the Almanac's own —
 *  exactly as it was. The one write path `postRoomSettings` uses. */
export function withRoomGameSettings(
  settings: Record<string, unknown>,
  game: RoomGameSettings,
): Record<string, unknown> {
  return { ...settings, game };
}

/* ── the lobby ────────────────────────────────────────────────────────────── */

export interface PresenceRow {
  player_id: string;
  state: string;
  seen_at: string;
  display_name: string;
}

/** Upsert this player's heartbeat. `state` is presence's own vocabulary
 *  (schema.sql presence.state: lobby | away), separate from a match's
 *  `lobby_status` — a player can be `lobby`-state and seated nowhere, or
 *  heartbeat `away` while still seated at a table the match row already
 *  describes. */
export async function upsertPresence(
  db: D1Like,
  playerId: string,
  state: string,
  now: string,
): Promise<void> {
  await db.prepare(SQL.upsertPresence).bind(playerId, state, now).run();
}

/** Every presence row seen at or after `sinceIso` — the "here now" window,
 *  computed by the caller (index.ts `HERE_WINDOW_MS`) so this file stays free
 *  of ambient time (rule 3 at the top). */
export async function presenceSince(db: D1Like, sinceIso: string): Promise<PresenceRow[]> {
  const { results } = await db.prepare(SQL.presenceSince).bind(sinceIso).all<PresenceRow>();
  return results;
}

/** The room-scoped `here` source — presence rows for players who are ALSO a
 *  member of this room (SQL.presenceInRoom's doc comment). */
export async function presenceInRoom(
  db: D1Like,
  roomCode: string,
  sinceIso: string,
): Promise<PresenceRow[]> {
  const { results } = await db.prepare(SQL.presenceInRoom).bind(roomCode, sinceIso).all<PresenceRow>();
  return results;
}

export interface LobbyMatchRow {
  id: string;
  match_format: string;
  ruleset_id: string;
  access: string;
  mode: string;
  lobby_status: string;
  current_hand: number;
  hands_base: number;
  seat_plan: string;
  bot_seats: number;
  created_by: string | null;
  started_at: string;
  join_code: string | null;
  room_code: string | null;
  /** §8a-2's clock speed — the lobby's table entries show it directly. */
  speed: string;
}

/** Every table still looking for humans or still playing, newest first,
 *  UNFILTERED by room (SQL.matchesWaitingOrPlaying's doc comment — the
 *  global `here` needs these rows even for tables `tables[]` will drop).
 *  `limit` is the defensive cap, not a page size the client controls — the
 *  lobby lists "every" such table. */
export async function matchesWaitingOrPlaying(
  db: D1Like,
  limit: number,
): Promise<LobbyMatchRow[]> {
  const { results } = await db.prepare(SQL.matchesWaitingOrPlaying).bind(limit).all<LobbyMatchRow>();
  return results;
}

/** The same panel, scoped to one room (§8b `GET /api/lobby?room=CODE`). */
export async function matchesWaitingOrPlayingInRoom(
  db: D1Like,
  roomCode: string,
  limit: number,
): Promise<LobbyMatchRow[]> {
  const { results } = await db
    .prepare(SQL.matchesWaitingOrPlayingInRoom)
    .bind(roomCode, limit)
    .all<LobbyMatchRow>();
  return results;
}

export interface DoneMatchRow {
  id: string;
  mode: string;
  ended_at: string | null;
}

/** The last `limit` finished GLOBAL matches, newest first — the
 *  recent-results strip. `room_code IS NULL` (§8b decision 3). */
export async function matchesDone(db: D1Like, limit: number): Promise<DoneMatchRow[]> {
  const { results } = await db.prepare(SQL.matchesDone).bind(limit).all<DoneMatchRow>();
  return results;
}

/** The room-scoped sibling of the above. */
export async function matchesDoneInRoom(
  db: D1Like,
  roomCode: string,
  limit: number,
): Promise<DoneMatchRow[]> {
  const { results } = await db.prepare(SQL.matchesDoneInRoom).bind(roomCode, limit).all<DoneMatchRow>();
  return results;
}

export interface LobbyMessageRow {
  id: number;
  player_id: string;
  display_name: string;
  text: string;
  created_at: string;
}

/** Append one lobby chat message (§8, §8b). `displayName` is denormalized at
 *  write time — see schema.sql `lobby_messages`'s header comment.
 *  `roomCode` null = the global lobby, same convention `matches.room_code`
 *  already uses. */
export async function insertLobbyMessage(
  db: D1Like,
  m: { playerId: string; displayName: string; text: string; roomCode: string | null; now: string },
): Promise<void> {
  await db
    .prepare(SQL.insertLobbyMessage)
    .bind(m.playerId, m.displayName, m.text, m.roomCode, m.now)
    .run();
}

/** This player's most recent message time, or null if they have never sent
 *  one — the whole state `postLobbyChat`'s 1-per-2s limit needs, with no
 *  extra table (§7 `POST /api/lobby/chat`'s doc comment). */
export async function lastLobbyMessageAt(db: D1Like, playerId: string): Promise<string | null> {
  const row = await db.prepare(SQL.lastLobbyMessageForPlayer).bind(playerId).first<{ created_at: string }>();
  return row === null ? null : row.created_at;
}

/** Newest `limit` GLOBAL lobby messages, NEWEST FIRST — the caller
 *  (`getLobby`) reverses this into chronological order for display, same
 *  shape the table's own K_CHAT ring already presents to a client. */
export async function recentLobbyMessages(db: D1Like, limit: number): Promise<LobbyMessageRow[]> {
  const { results } = await db.prepare(SQL.recentLobbyMessages).bind(limit).all<LobbyMessageRow>();
  return results;
}

/** The room-scoped sibling of the above. */
export async function recentLobbyMessagesInRoom(
  db: D1Like,
  roomCode: string,
  limit: number,
): Promise<LobbyMessageRow[]> {
  const { results } = await db
    .prepare(SQL.recentLobbyMessagesInRoom)
    .bind(roomCode, limit)
    .all<LobbyMessageRow>();
  return results;
}

export interface LobbySeatRow {
  seat: number;
  player_id: string;
  display_name: string;
  connected: number;
}

/** A match's human-claimed seats — bots never appear (schema.sql
 *  match_players: nothing ever inserts a row for a bot seat; a bot's identity
 *  lives in the header and in `matches.seat_plan` instead). Callers building a
 *  lobby view fall back to the seat plan for any seat missing here. */
export async function humanSeatsOfMatch(db: D1Like, matchId: string): Promise<LobbySeatRow[]> {
  const { results } = await db.prepare(SQL.humanSeatsOfMatch).bind(matchId).all<LobbySeatRow>();
  return results;
}

/* ── stats and leaderboards ──────────────────────────────────────────────── */

/** P0's one rating season (worker/src/table.ts `RATING_SEASON`, schema.sql
 *  `rating_history.season`/`players.rating_season`). Duplicated as a literal
 *  in both files rather than shared from a module either would have to take a
 *  new dependency on — `RATING_SYSTEM_ID`'s sibling, not a config value. */
export const RATING_SEASON = "p0-provisional";

export function playerById(db: D1Like, playerId: string): Promise<PlayerRow | null> {
  return db.prepare(SQL.playerById).bind(playerId).first<PlayerRow>();
}

export interface StatsTotalsRow {
  matches: number;
  ranked: number;
  casual: number;
  place1: number;
  place2: number;
  place3: number;
  place4: number;
  hands_won: number;
  self_draws: number;
  deal_ins: number;
  moves_graded: number;
  moves_matched: number;
}

/** Every field is a `SUM`/`COUNT` over zero rows when the player has never
 *  finished a match, and SQLite's aggregates return NULL over zero rows —
 *  never a bare 0 — so every caller reads through `?? 0`, not this helper. */
export async function statsTotalsForPlayer(db: D1Like, playerId: string): Promise<StatsTotalsRow | null> {
  return db.prepare(SQL.statsTotalsForPlayer).bind(playerId).first<StatsTotalsRow>();
}

export async function avgFaanForPlayer(db: D1Like, playerId: string): Promise<number | null> {
  const row = await db.prepare(SQL.avgFaanForPlayer).bind(playerId).first<{ avg_faan: number | null; n: number }>();
  return row === null || row.n === 0 ? null : row.avg_faan;
}

export async function netChipsForPlayer(db: D1Like, playerId: string): Promise<number> {
  const row = await db.prepare(SQL.netChipsForPlayer).bind(playerId).first<{ net_chips: number | null }>();
  return row?.net_chips ?? 0;
}

export interface RecentMatchRow {
  match_id: string;
  ended_at: string | null;
  mode: string;
  place: number | null;
  final_chips: number;
  rating_before: number | null;
  rating_after: number | null;
}

export async function recentMatchesForPlayer(
  db: D1Like,
  playerId: string,
  limit: number,
): Promise<RecentMatchRow[]> {
  const { results } = await db.prepare(SQL.recentMatchesForPlayer).bind(playerId, limit).all<RecentMatchRow>();
  return results;
}

export interface RatingHistoryPointRow {
  at: string;
  before: number;
  after: number;
  match_id: string | null;
}

export async function ratingHistoryForPlayer(
  db: D1Like,
  playerId: string,
  limit: number,
): Promise<RatingHistoryPointRow[]> {
  const { results } = await db.prepare(SQL.ratingHistoryForPlayer).bind(playerId, limit).all<RatingHistoryPointRow>();
  return results;
}

export interface RankedLeaderboardRow {
  id: string;
  display_name: string;
  rating: number;
  rating_games: number;
}

export async function leaderboardRanked(db: D1Like, limit: number): Promise<RankedLeaderboardRow[]> {
  const { results } = await db
    .prepare(SQL.leaderboardRanked)
    .bind(RATING_SEASON, limit)
    .all<RankedLeaderboardRow>();
  return results;
}

export interface CasualLeaderboardRow {
  player_id: string;
  display_name: string;
  matches: number;
  wins: number;
  place1: number;
  place2: number;
  place3: number;
  place4: number;
  moves_graded: number;
  moves_matched: number;
}

export async function leaderboardCasual(db: D1Like, limit: number): Promise<CasualLeaderboardRow[]> {
  const { results } = await db.prepare(SQL.leaderboardCasual).bind(limit).all<CasualLeaderboardRow>();
  return results;
}

/* ── rooms (§8b) ──────────────────────────────────────────────────────────── */

export function roomByCode(db: D1Like, code: string): Promise<RoomRow | null> {
  return db.prepare(SQL.roomByCode).bind(code).first<RoomRow>();
}

export interface NewRoom {
  code: string;
  name: string;
  /** Pre-serialized — always `{ game: {...} }` for a room the game creates
   *  (`postRooms`), so callers hold the `JSON.stringify` at the boundary,
   *  same convention `NewMatch.seatPlan` uses. `'{}'` for the Open Hall
   *  (§11 build decision 2) — no `game` key at all, "no presets". */
  settings: string;
  /** `null` for the Open Hall: nobody administers it, and `verifyRoomAdmin`
   *  already refuses outright when this column is null. */
  adminCodeHash: string | null;
  now: string;
}

export async function insertRoom(db: D1Like, r: NewRoom): Promise<void> {
  await db
    .prepare(SQL.insertRoom)
    .bind(r.code, r.name, r.settings, r.adminCodeHash, r.now, r.now)
    .run();
}

export async function updateRoomSettings(
  db: D1Like,
  code: string,
  settingsJson: string,
  now: string,
): Promise<void> {
  await db.prepare(SQL.updateRoomSettings).bind(settingsJson, now, code).run();
}

export async function insertRoomPlayer(
  db: D1Like,
  m: { roomCode: string; playerId: string; name: string },
): Promise<void> {
  await db.prepare(SQL.insertRoomPlayer).bind(m.roomCode, m.playerId, m.name).run();
}

export async function isRoomMember(db: D1Like, roomCode: string, playerId: string): Promise<boolean> {
  const row = await db.prepare(SQL.roomMember).bind(roomCode, playerId).first<{ present: number }>();
  return row !== null;
}

export async function roomMemberCount(db: D1Like, roomCode: string): Promise<number> {
  const row = await db.prepare(SQL.roomMemberCount).bind(roomCode).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function roomPlayerIdsOf(db: D1Like, roomCode: string): Promise<string[]> {
  const { results } = await db.prepare(SQL.roomPlayerIds).bind(roomCode).all<{ player_id: string }>();
  return results.map((r) => r.player_id);
}

/** "My rooms" — every room this player has joined (`POST
 *  /api/rooms/:code/join`, or was the creator of, since creation also joins). */
export async function roomsForPlayer(db: D1Like, playerId: string): Promise<RoomRow[]> {
  const { results } = await db.prepare(SQL.roomsForPlayer).bind(playerId).all<RoomRow>();
  return results;
}

/** `POST /api/rooms/:code/tables/:matchId/close` (admin, phase 2). Returns
 *  false when the match was not, at the moment of the UPDATE, a waiting
 *  match — the caller has already read the row and knows why (not found, not
 *  in this room, already started) and turns that into the right status code;
 *  this function only reports whether ITS OWN write happened, same
 *  `meta.changes` doctrine `claimSeat` uses for its own race. */
export async function abandonWaitingMatch(db: D1Like, matchId: string, now: string): Promise<boolean> {
  const res = await db.prepare(SQL.abandonWaitingMatch).bind(now, matchId).run();
  return res.meta.changes > 0;
}

/* ── players ──────────────────────────────────────────────────────────────── */

export async function updateTzOffset(db: D1Like, playerId: string, minutes: number): Promise<void> {
  await db.prepare(SQL.updatePlayerTzOffset).bind(minutes, playerId).run();
}

/* ── friends (§11 build decision 1) ──────────────────────────────────────── */

export interface FriendRow {
  friend_id: string;
  display_name: string;
  rating: number | null;
  rating_games: number;
  last_seen_at: string;
  games: number;
}

export async function friendsOfPlayer(db: D1Like, playerId: string): Promise<FriendRow[]> {
  const { results } = await db.prepare(SQL.friendsOfPlayer).bind(playerId).all<FriendRow>();
  return results;
}

export async function starFriend(db: D1Like, playerId: string, friendId: string, now: string): Promise<void> {
  await db.prepare(SQL.insertFriendStar).bind(playerId, friendId, now).run();
}

export async function unstarFriend(db: D1Like, playerId: string, friendId: string): Promise<void> {
  await db.prepare(SQL.deleteFriendStar).bind(playerId, friendId).run();
}

export async function friendStarsOfPlayer(db: D1Like, playerId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(SQL.friendStarsOfPlayer)
    .bind(playerId)
    .all<{ friend_id: string }>();
  return new Set(results.map((r) => r.friend_id));
}

/* ── direct messages (§8) ─────────────────────────────────────────────────── */

export interface DmMessageRow {
  id: number;
  from_player_id: string;
  to_player_id: string;
  text: string;
  created_at: string;
  read_at: string | null;
}

export async function insertDmMessage(
  db: D1Like,
  m: { fromPlayerId: string; toPlayerId: string; text: string; now: string },
): Promise<void> {
  await db.prepare(SQL.insertDmMessage).bind(m.fromPlayerId, m.toPlayerId, m.text, m.now).run();
}

/** One thread, either direction, newest first — the caller reverses for
 *  chronological display (same convention `recentLobbyMessages` uses). */
export async function dmThread(
  db: D1Like,
  playerA: string,
  playerB: string,
  limit: number,
): Promise<DmMessageRow[]> {
  const { results } = await db
    .prepare(SQL.dmThread)
    .bind(playerA, playerB, playerB, playerA, limit)
    .all<DmMessageRow>();
  return results;
}

export async function markDmThreadRead(
  db: D1Like,
  toPlayerId: string,
  fromPlayerId: string,
  now: string,
): Promise<void> {
  await db.prepare(SQL.markDmThreadRead).bind(now, toPlayerId, fromPlayerId).run();
}

export async function lastDmMessageAt(db: D1Like, fromPlayerId: string): Promise<string | null> {
  const row = await db.prepare(SQL.lastDmMessageAt).bind(fromPlayerId).first<{ created_at: string }>();
  return row === null ? null : row.created_at;
}

export async function dmMessagesInvolving(db: D1Like, playerId: string, limit: number): Promise<DmMessageRow[]> {
  const { results } = await db.prepare(SQL.dmMessagesInvolving).bind(playerId, playerId, limit).all<DmMessageRow>();
  return results;
}

/* ── inbox (§8) ───────────────────────────────────────────────────────────── */

export type InboxKind = "invite" | "room" | "result";

export interface InboxItemRow {
  id: string;
  player_id: string;
  kind: string;
  match_id: string | null;
  room_code: string | null;
  from_player_id: string | null;
  text: string | null;
  created_at: string;
  read_at: string | null;
  dismissed_at: string | null;
}

export interface NewInboxItem {
  id: string;
  playerId: string;
  kind: InboxKind;
  matchId?: string | null;
  roomCode?: string | null;
  fromPlayerId?: string | null;
  text?: string | null;
  now: string;
}

/** `OR IGNORE` on the primary key — every writer of a `room`/`result` item
 *  uses a DETERMINISTIC id precisely so a retried write is a no-op rather
 *  than a duplicate notification (schema.sql `inbox_items`' header comment). */
export async function insertInboxItem(db: D1Like, item: NewInboxItem): Promise<void> {
  await db
    .prepare(SQL.insertInboxItem)
    .bind(
      item.id,
      item.playerId,
      item.kind,
      item.matchId ?? null,
      item.roomCode ?? null,
      item.fromPlayerId ?? null,
      item.text ?? null,
      item.now,
    )
    .run();
}

export async function inboxItemsForPlayer(db: D1Like, playerId: string, limit: number): Promise<InboxItemRow[]> {
  const { results } = await db.prepare(SQL.inboxItemsForPlayer).bind(playerId, limit).all<InboxItemRow>();
  return results;
}

export function inboxItemById(db: D1Like, id: string): Promise<InboxItemRow | null> {
  return db.prepare(SQL.inboxItemById).bind(id).first<InboxItemRow>();
}

/** Returns false when the item was, at the moment of the UPDATE, already
 *  dismissed or did not belong to this player — same `meta.changes` doctrine
 *  `abandonWaitingMatch` uses for the same reason. */
export async function dismissInboxItem(db: D1Like, id: string, playerId: string, now: string): Promise<boolean> {
  const res = await db.prepare(SQL.dismissInboxItem).bind(now, now, id, playerId).run();
  return res.meta.changes > 0;
}

/* ── stats (§10) ──────────────────────────────────────────────────────────── */

export interface ScopedMatchRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  mode: string;
  ruleset_id: string;
  room_code: string | null;
  hand_count: number;
  seat: number;
  place: number | null;
  final_chips: number;
  hands_won: number;
  self_draws: number;
  deal_ins: number;
  moves_graded: number;
  moves_matched: number;
  rating_before: number | null;
  rating_after: number | null;
}

/** A stats scope, already resolved to SQL-ready values — `null` in any field
 *  below means "no filter", the value `matchesForPlayerScoped`'s `(? IS NULL
 *  OR ...)` clauses expect. Resolving the raw query-string scope into this
 *  shape (validating `mode`/`style`, parsing `since`) is index.ts's job; this
 *  file only ever sees values it can bind directly. */
export interface StatsScope {
  mode: string | null;
  rulesetId: string | null;
  roomCode: string | null;
  sinceIso: string | null;
}

/** Defensive cap, same role `LOBBY_TABLE_LIMIT` plays for the lobby: a scope
 *  with no `since`/`lastN` still gets a bounded read. `lastN` narrows this
 *  further in application code (SQL.matchesForPlayerScoped's doc comment). */
export const STATS_SCOPE_LIMIT = 500;

export async function matchesForPlayerScoped(
  db: D1Like,
  playerId: string,
  scope: StatsScope,
): Promise<ScopedMatchRow[]> {
  const { results } = await db
    .prepare(SQL.matchesForPlayerScoped)
    .bind(
      playerId,
      scope.mode, scope.mode,
      scope.rulesetId, scope.rulesetId,
      scope.roomCode, scope.roomCode,
      scope.sinceIso, scope.sinceIso,
      STATS_SCOPE_LIMIT,
    )
    .all<ScopedMatchRow>();
  return results;
}

export interface LeaderboardCandidateRow {
  player_id: string;
  rating: number | null;
  rating_games: number;
  games: number;
}

export async function leaderboardCandidates(
  db: D1Like,
  scope: StatsScope,
): Promise<LeaderboardCandidateRow[]> {
  const { results } = await db
    .prepare(SQL.leaderboardCandidates)
    .bind(
      scope.mode, scope.mode,
      scope.rulesetId, scope.rulesetId,
      scope.roomCode, scope.roomCode,
      scope.sinceIso, scope.sinceIso,
    )
    .all<LeaderboardCandidateRow>();
  return results;
}

export interface ScopedHandRow {
  match_id: string;
  hand_index: number;
  outcome: string;
  round_wind: number;
  winner_seat: number | null;
  win_from_seat: number | null;
  self_draw: number;
  faan: number;
  awards: string;
  delta_seat0: number;
  delta_seat1: number;
  delta_seat2: number;
  delta_seat3: number;
}

const SCOPED_HAND_COLUMNS =
  "match_id, hand_index, outcome, round_wind, winner_seat, win_from_seat, self_draw, faan, awards, " +
  "delta_seat0, delta_seat1, delta_seat2, delta_seat3";

/**
 * DOCUMENTED EXCEPTION to rule 1 at the top of this file, the second one
 * (the first is `SQL.matchByJoinCode`'s doc comment) — a genuinely
 * variable-length `IN (...)` over a match id list this file's own caller
 * already fetched (`matchesForPlayerScoped`, bounded by `STATS_SCOPE_LIMIT`).
 * Every placeholder is still bound, never interpolated; only the STATEMENT
 * TEXT varies with the count of ids, which is why this is a function and not
 * a frozen `SQL` entry. Returns `[]` without a query for an empty list —
 * `IN ()` is invalid SQL, and an empty scope is a real, common case (a new
 * player, an over-narrow filter).
 */
export async function handsForMatchIds(db: D1Like, matchIds: readonly string[]): Promise<ScopedHandRow[]> {
  if (matchIds.length === 0) return [];
  const placeholders = matchIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT ${SCOPED_HAND_COLUMNS} FROM hands WHERE match_id IN (${placeholders}) ORDER BY match_id, hand_index`,
    )
    .bind(...matchIds)
    .all<ScopedHandRow>();
  return results;
}

export interface ScopedSeatRow {
  match_id: string;
  seat: number;
  player_id: string;
  display_name: string;
  kind: string;
}

/** All four seats of every match in `matchIds` — the same documented
 *  exception `handsForMatchIds` states, for the same reason (feeds and the
 *  seat×round histogram need every OTHER seat's identity, not just the
 *  caller's own). */
export async function matchPlayersForMatchIds(db: D1Like, matchIds: readonly string[]): Promise<ScopedSeatRow[]> {
  if (matchIds.length === 0) return [];
  const placeholders = matchIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT mp.match_id AS match_id, mp.seat AS seat, mp.player_id AS player_id,
              p.display_name AS display_name, p.kind AS kind
         FROM match_players mp
         JOIN players p ON p.id = mp.player_id
        WHERE mp.match_id IN (${placeholders})`,
    )
    .bind(...matchIds)
    .all<ScopedSeatRow>();
  return results;
}

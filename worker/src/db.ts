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
    SELECT p.id, p.kind, p.display_name, p.rating, p.rating_games, p.rating_season
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
       log_schema_version, room_code, join_code, rated, bot_seats, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  matchById: `
    SELECT id, status, match_format, ruleset_hash, ruleset_id, engine_version,
           log_schema_version, room_code, join_code, rated, bot_seats,
           hand_count, log_key, log_bytes, log_sha256, started_at, ended_at
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
           hand_count, log_key, log_bytes, log_sha256, started_at, ended_at
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
           mp.bot_takeover_hands, mp.rating_before, mp.rating_after
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

/**
 * Platform services — the stateless half of the back end.
 * Implements DESIGN.md §5.4 (identity, match history, per-hand results, replay
 * blobs) and the lobby end of the §5.3 match handoff, over ../schema.sql.
 * Terminology: ../../TERMINOLOGY.md — HK Old Style only.
 *
 * TWO PLANES, NEVER ONE CHANNEL (DESIGN.md §2, sketches/BACKEND.md §1).
 * Everything in this file is HTTP. There is no WebSocket here and there must
 * never be one: the live match belongs to the Table Durable Object alone, and
 * the lobby never proxies match traffic. What this service hands out is a
 * *destination* — `{ tableId, seatToken, matchUuid }` — and then gets out of
 * the way while the client opens the socket itself (§5.3, Majsoul's shape).
 *
 * Consequently this Worker holds no state at all: no game state, no session, no
 * cookie. The device token is presented on every request; D1 and R2 hold
 * everything else. That is what makes it safe to run this on any edge instance
 * and what makes every screen the lobby renders — match list, results, review,
 * replay — a plain GET.
 *
 * Routes:
 *   POST /api/identity              device token + display name (P0)
 *   GET  /api/matches               the caller's match history
 *   GET  /api/matches/:id           match detail, including per-hand rows
 *   GET  /api/matches/:id/log       the R2 event-log blob, participants only
 *   POST /api/tables                create a table (creator takes the first
 *                                   human seat in `seats`)
 *   POST /api/tables/:code/join     join by code, lowest free human seat
 *   POST /api/tables/:id/start      creator only: fill empty seats with bots,
 *                                   shuffle if asked, start the clocks
 *   POST /api/tables/:id/leave      a participant hands their seat to a bot
 *                                   for the rest of the match
 *   GET  /api/lobby                 who is here, what tables are open, recent
 *                                   results, last 50 lobby chat messages
 *                                   (PVP-LOBBY-PROPOSAL-2026-09-02.md §7, §8)
 *   POST /api/lobby/chat            post one lobby chat message (§8)
 *   POST /api/presence              the lobby heartbeat, every 30s
 *   GET  /api/stats/me              the caller's own totals, recent matches,
 *                                   rating history
 *   GET  /api/players/:id/stats     same shape, any player — the leaderboard,
 *                                   Here now and a scoreboard all link here
 *   GET  /api/leaderboard           ?mode=ranked (by rating) or casual (by record)
 *   GET  /api/replay/:token         PUBLIC, unauthenticated — §2's only viral loop
 *
 * Not here, on purpose: CORS. The client ships same-origin behind the site's
 * host routing, and an allow-list belongs in the routing layer rather than
 * duplicated in every handler. Add it there if the client ever moves origin.
 */
import type { FaanAward, SeatIndex } from "@mjrc/engine";
import { EVENT_SCHEMA_VERSION } from "@mjrc/protocol";
import { DEFAULT_RULESET_ID, assertRulesetSound, ruleset } from "@mjrc/rulesets";
import { isProvisional } from "../../engine/src/rating.js";
import type {
  CasualLeaderboardRow,
  D1Like,
  DoneMatchRow,
  HandRow,
  LobbyMatchRow,
  LobbyMessageRow,
  MatchListRow,
  MatchRow,
  MatchSeatRow,
  PlayerRow,
  R2Like,
  RankedLeaderboardRow,
  RatingHistoryPointRow,
  RecentMatchRow,
  RoomGameSettings,
  RoomRow,
  SeatSpec,
  StatsTotalsRow,
} from "./db.js";
/* Re-exported: `TableSpec.seatPlan` and `postTable` both speak this type, and
 * gamepvp/src/index.ts (`tableInitOf`) needs it too — one shape, re-exported
 * from where it is defined rather than imported twice from two paths. */
export type { SeatSpec } from "./db.js";
import {
  ID_LENGTH,
  JOIN_CODE_LENGTH,
  abandonWaitingMatch,
  archiveRuleset,
  avgFaanForPlayer,
  claimSeat,
  handsOfMatch,
  humanSeatsOfMatch,
  insertCredential,
  insertLobbyMessage,
  insertMatch,
  insertPlayer,
  insertRoom,
  insertRoomPlayer,
  isRoomMember,
  lastLobbyMessageAt,
  leaderboardCasual,
  leaderboardRanked,
  matchById,
  matchByJoinCode,
  matchLogById,
  matchesDone,
  matchesDoneInRoom,
  matchesForPlayer,
  matchesWaitingOrPlaying,
  matchesWaitingOrPlayingInRoom,
  netChipsForPlayer,
  parseRoomSettings,
  parseSeatPlan,
  playerById,
  playerForCredential,
  presenceInRoom,
  presenceSince,
  randomId,
  ratingHistoryForPlayer,
  recentLobbyMessages,
  recentLobbyMessagesInRoom,
  recentMatchesForPlayer,
  renamePlayer,
  roomByCode,
  roomGameSettingsOf,
  roomMemberCount,
  roomsForPlayer,
  rulesetHash,
  seatOf,
  seatPlanOf,
  seatsOfMatch,
  serializeSeatPlan,
  sha256Hex,
  statsTotalsForPlayer,
  toHex,
  touchCredential,
  updateRoomSettings,
  upsertPresence,
  withRoomGameSettings,
} from "./db.js";

/* ── the Table DO seam ────────────────────────────────────────────────────────
 * The only thing this service asks the match plane for, and it is control
 * plane, not match traffic: a table opened, and a one-time seat token minted.
 *
 * The token is minted by the DO and not here because the DO is its only
 * consumer and its only store (worker/README.md §5: "Lives for seconds, one
 * consumer, and that consumer is the DO"). Putting it in D1 would buy a round
 * trip and a cleanup job for nothing, and minting it here would mean two
 * components own one credential.
 *
 * `idFromName(matchId)` is why `matches` carries no table_id column: the table's
 * address is derivable from the match id forever, by anyone, with no lookup.
 */
export interface TableId {
  toString(): string;
}

export interface TableSpec {
  matchId: string;
  rulesetId: string;
  rulesetHash: string;
  engineVersion: string;
  logSchemaVersion: number;
  matchFormat: string;
  /**
   * The four seat specs, in seat order (§7.2's `seats`, or the legacy
   * `botSeats`/`bots` converted to the same shape by `postTable`). A bot seat
   * with no `bot` key means "use the deployment's default lineup" for that
   * seat. Opaque past `kind`/`bot` to this file — resolving `bot` to a
   * `PlayerRef` is deployment-specific (gamepvp/src/index.ts `tableInitOf`).
   */
  seatPlan: readonly SeatSpec[];
  /** Shuffle the player↔seat mapping when `/fill` starts the clocks (§6
   *  decision 3) — carried into `TableInit.randomizeSeats` verbatim. */
  randomizeSeats: boolean;
  startedAt: string;
}

export interface SeatClaim {
  matchId: string;
  seat: SeatIndex;
  playerId: string;
  displayName: string;
}

export interface TableStub {
  /** Idempotent by matchId — a retry after a flaky response must not open two. */
  openTable(spec: TableSpec): Promise<void>;
  issueSeatToken(claim: SeatClaim): Promise<{ seatToken: string; expiresAt: string }>;
  /**
   * The creator's "start now, fill the rest with bots" (§7.2 `/start`). Every
   * still-empty human seat becomes a bot, seats shuffle if the table was
   * created with `randomizeSeats`, and the clocks start the same way a full
   * table always has. Idempotent once the table has started.
   */
  fill(): Promise<void>;
  /**
   * A participant's explicit leave (§7.2 `/leave`): the seat is played by a
   * bot for the rest of the match, exactly like a disconnect grace expiring,
   * and its socket is closed. The seat token still reclaims it. Idempotent.
   */
  leave(playerId: string): Promise<void>;
}

export interface TableNamespace {
  idFromName(name: string): TableId;
  get(id: TableId): TableStub;
}

/* ── environment and platform ─────────────────────────────────────────────── */

export interface Env {
  DB: D1Like;
  LOGS: R2Like;
  TABLES: TableNamespace;
  /**
   * The deployed build of the rules engine, pinned onto every match row so an
   * old match replays through the build that produced it (DESIGN.md §5.5). It
   * is a deploy-time fact — the artifact's version — which is exactly why it is
   * a var and not a constant the engine source asserts about itself.
   */
  ENGINE_VERSION?: string;
  /**
   * HMAC key for shared-replay links. See `mintReplayToken`: the share token is
   * a signed capability rather than a stored row, so no schema, no cleanup job,
   * and rotating this key revokes every outstanding link at once.
   */
  REPLAY_TOKEN_SECRET?: string;
}

/**
 * Everything a handler is allowed to reach. Time and randomness are members
 * rather than ambient calls, so the route tests assert on exact ids and exact
 * timestamps — the cheapest possible guard against the class of bug DESIGN.md
 * §5.5 names, where an unseeded call makes two identical inputs diverge.
 */
export interface Platform {
  db: D1Like;
  logs: R2Like;
  tables: TableNamespace;
  now(): string;
  random(n: number): Uint8Array;
  engineVersion: string;
  replayTokenSecret: string;
  /**
   * Is `key` a real bot profile? The catalogue lives with the game, not the
   * platform (gamepvp/src/bots.ts `isBotCatalogueKey`), so this is how
   * `postTable` gets a precise, pre-write 400 on an unknown `bots` pick
   * without this file importing a deployment's bot list. Omitted = accept
   * any non-empty key (a deployment with no catalogue of its own).
   */
  isBotKey?(key: string): boolean;
  /**
   * A bot seat's lobby display name — the same seam as `isBotKey`, for the
   * same reason (gamepvp/src/bots.ts owns `BOT_CATALOGUE`/`BOT_LINEUP`, not
   * this file). `key` is undefined for a seat plan entry that never named one
   * ("use the deployment's default lineup"); `seat` is that seat's index, the
   * only thing a caller with no key still knows. Omitted = a generic label.
   */
  botDisplayName?(key: string | undefined, seat: SeatIndex): string;
}

export class ConfigError extends Error {}

/** Fail closed on missing configuration: a match row written with a placeholder
 *  engine version is a broken replay nobody notices until gate 2 fails. */
export function platformFromEnv(env: Env): Platform {
  const engineVersion = (env.ENGINE_VERSION ?? "").trim();
  const replayTokenSecret = (env.REPLAY_TOKEN_SECRET ?? "").trim();
  if (engineVersion === "") throw new ConfigError("ENGINE_VERSION is not set");
  if (replayTokenSecret.length < 32) throw new ConfigError("REPLAY_TOKEN_SECRET is too short");
  return {
    db: env.DB,
    logs: env.LOGS,
    tables: env.TABLES,
    now: () => new Date().toISOString(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    engineVersion,
    replayTokenSecret,
  };
}

/* ── responses ────────────────────────────────────────────────────────────── */

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

/** Machine-readable code, never a sentence. The client owns the wording, and
 *  the wording is bilingual (TERMINOLOGY.md house style). */
function fail(code: string, status: number): Response {
  return json({ error: code }, status);
}

/* ── shared-replay tokens ─────────────────────────────────────────────────── */

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig)).slice(0, 32);
}

/** Length-independent comparison. A share token is a capability; leaking how
 *  many leading characters of a guess were right leaks the capability. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `<matchId>.<hmac>` — a signed capability, not a stored secret.
 *
 * The alternative was a `replay_token` column, and it loses on every axis: a
 * row to write, a row to index, a row to expire, and a token that survives key
 * rotation. This form needs no schema at all, which matters because schema.sql
 * is migration 0001 and additive-only (worker/README.md §3).
 */
export async function mintReplayToken(secret: string, matchId: string): Promise<string> {
  return `${matchId}.${await hmacHex(secret, matchId)}`;
}

export async function verifyReplayToken(secret: string, token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const matchId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  return constantTimeEqual(sig, await hmacHex(secret, matchId)) ? matchId : null;
}

/* ── authentication ───────────────────────────────────────────────────────── */

/**
 * P0 identity: the client mints a device token, keeps it, and presents it as a
 * bearer credential; only its SHA-256 is stored (schema.sql, player_credentials
 * — "a stolen database does not yield a usable credential"). Passkeys are P1
 * and are a second `kind` in that table, not a change to this function's shape.
 */
async function authenticate(req: Request, p: Platform): Promise<PlayerRow | null> {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (match === null) return null;
  const token = match[1].trim();
  if (!isPlausibleDeviceToken(token)) return null;
  return playerForCredential(p.db, await sha256Hex(token));
}

const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;

/** A short device token is a guessable one, and the client mints it, so the
 *  floor has to be enforced on this side. Checked before hashing so a garbage
 *  header costs no digest. */
function isPlausibleDeviceToken(token: string): boolean {
  return DEVICE_TOKEN_RE.test(token);
}

/* ── request parsing ──────────────────────────────────────────────────────── */

type JsonObject = Record<string, unknown>;

async function readJsonObject(req: Request): Promise<JsonObject | null> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as JsonObject;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isInteger(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * `body.bots` from the LEGACY `POST /api/tables` shape: `undefined` means
 * "the deployment's default lineup"; otherwise it must be exactly `botSeats`
 * non-empty keys, each one `isBotKey` accepts (when the deployment supplies
 * that check). Returns the sentinel `"invalid"` rather than throwing so the
 * one caller can turn every failure mode into a single, precise 400 before
 * any row is written — see the `postTable` doctrine comment on write ordering.
 */
function parseBots(
  v: unknown,
  botSeats: number,
  isBotKey: ((key: string) => boolean) | undefined,
): string[] | undefined | "invalid" {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length !== botSeats) return "invalid";
  const keys: string[] = [];
  for (const entry of v) {
    const key = str(entry);
    if (key === null) return "invalid";
    if (isBotKey && !isBotKey(key)) return "invalid";
    keys.push(key);
  }
  return keys;
}

/**
 * `body.seats` from `POST /api/tables` (§7.2): exactly 4 entries, each
 * `{ kind: 'human' }` or `{ kind: 'bot', bot?: key }`. A bot entry with no
 * `bot` key means "the deployment's default lineup for this seat" — the same
 * meaning `bots` being entirely absent used to carry for every bot seat at
 * once. `"invalid"` on any malformed entry, same doctrine as `parseBots`.
 */
function parseSeatsBody(
  v: unknown,
  isBotKey: ((key: string) => boolean) | undefined,
): SeatSpec[] | "invalid" {
  if (!Array.isArray(v) || v.length !== 4) return "invalid";
  const plan: SeatSpec[] = [];
  for (const entry of v) {
    if (entry === null || typeof entry !== "object") return "invalid";
    const kind = (entry as { kind?: unknown }).kind;
    if (kind === "human") {
      plan.push({ kind: "human" });
      continue;
    }
    if (kind === "bot") {
      const raw = (entry as { bot?: unknown }).bot;
      if (raw === undefined) {
        plan.push({ kind: "bot" });
        continue;
      }
      const bot = str(raw);
      if (bot === null) return "invalid";
      if (isBotKey && !isBotKey(bot)) return "invalid";
      plan.push({ kind: "bot", bot });
      continue;
    }
    return "invalid";
  }
  return plan;
}

/**
 * The seat plan `POST /api/tables` actually opens the table with: `seats` if
 * given, else the legacy `botSeats`/`bots` shape converted to the same shape
 * — humans in the low seats, bots filling from the top, exactly the layout
 * that shape always meant (worker/README.md §8, the P0 default). Both paths
 * return `"invalid"` for the single 400 `postTable` raises on either.
 */
function seatPlanFromBody(
  body: JsonObject,
  isBotKey: ((key: string) => boolean) | undefined,
): SeatSpec[] | "invalid" {
  if (body.seats !== undefined) return parseSeatsBody(body.seats, isBotKey);
  const botSeats = clampInt(body.botSeats, 0, 3, 0);
  const bots = parseBots(body.bots, botSeats, isBotKey);
  if (bots === "invalid") return "invalid";
  const firstBot = 4 - botSeats;
  return [0, 1, 2, 3].map((seat) => {
    if (seat < firstBot) return { kind: "human" as const };
    const key = bots?.[seat - firstBot];
    return key === undefined ? { kind: "bot" as const } : { kind: "bot" as const, bot: key };
  });
}

const MAX_DISPLAY_NAME = 40;
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

/**
 * Codes are read off a screen and typed into a phone. Crockford base32 already
 * drops I, L, O and U from the alphabet; folding the look-alikes on the way in
 * means "1" typed for a shown "I" still finds the table. Shared by join codes
 * (8 chars) and room codes (6, §8b) — the folding rule does not depend on
 * length.
 */
function normaliseCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/* ── row → JSON views ─────────────────────────────────────────────────────────
 * SQL is snake_case and stores booleans as 0/1 (schema.sql, "Conventions"); the
 * HTTP surface is camelCase with real booleans, matching the engine and
 * protocol JSON the client already speaks. The translation happens here, once,
 * at the boundary — never inside a query helper.
 */

const bool = (n: number): boolean => n !== 0;

function matchListView(r: MatchListRow) {
  return {
    matchId: r.id,
    status: r.status,
    matchFormat: r.match_format,
    rulesetId: r.ruleset_id,
    rated: bool(r.rated),
    botSeats: r.bot_seats,
    handCount: r.hand_count,
    roomCode: r.room_code,
    joinCode: r.join_code,
    hasLog: r.log_key !== null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    seat: r.seat,
    place: r.place,
    finalChips: r.final_chips,
    faanWon: r.faan_won,
    ratingBefore: r.rating_before,
    ratingAfter: r.rating_after,
  };
}

function matchView(r: MatchRow) {
  return {
    matchId: r.id,
    status: r.status,
    matchFormat: r.match_format,
    rulesetId: r.ruleset_id,
    rulesetHash: r.ruleset_hash,
    engineVersion: r.engine_version,
    logSchemaVersion: r.log_schema_version,
    roomCode: r.room_code,
    joinCode: r.join_code,
    rated: bool(r.rated),
    botSeats: r.bot_seats,
    handCount: r.hand_count,
    hasLog: r.log_key !== null,
    logBytes: r.log_bytes,
    logSha256: r.log_sha256,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function seatView(r: MatchSeatRow) {
  return {
    seat: r.seat,
    playerId: r.player_id,
    displayName: r.display_name,
    bot: r.kind === "bot",
    wind: r.wind,
    finalChips: r.final_chips,
    faanWon: r.faan_won,
    place: r.place,
    handsWon: r.hands_won,
    selfDraws: r.self_draws,
    dealIns: r.deal_ins,
    botTakeoverHands: r.bot_takeover_hands,
    movesGraded: r.moves_graded,
    movesMatched: r.moves_matched,
    gapSum: r.gap_sum,
    /* null when nothing was graded — a bot seat, or a human who never got a
     * gradable decision (a very short match, an all-forced hand). */
    agreement: r.moves_graded > 0 ? r.moves_matched / r.moves_graded : null,
    ratingBefore: r.rating_before,
    ratingAfter: r.rating_after,
  };
}

/** `awards` round-trips: FaanAward[] went in verbatim and comes out verbatim,
 *  stable pattern ids and never display strings (schema.sql, hands.awards). */
function parseAwards(raw: string): FaanAward[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FaanAward[]) : [];
  } catch {
    return [];
  }
}

function handView(r: HandRow) {
  return {
    handIndex: r.hand_index,
    dealerSeat: r.dealer_seat,
    roundWind: r.round_wind,
    dealerRepeat: r.dealer_repeat,
    seed: r.seed,
    outcome: r.outcome,
    winnerSeat: r.winner_seat,
    winFromSeat: r.win_from_seat,
    winningTile: r.winning_tile,
    selfDraw: bool(r.self_draw),
    robbedKong: bool(r.robbed_kong),
    onKongReplacement: bool(r.on_kong_replacement),
    faan: r.faan,
    rawFaan: r.raw_faan,
    capped: bool(r.capped),
    awards: parseAwards(r.awards),
    deltas: [r.delta_seat0, r.delta_seat1, r.delta_seat2, r.delta_seat3],
    refusedWins: r.refused_wins,
    wallRemaining: r.wall_remaining,
    eventCount: r.event_count,
    logSeqStart: r.log_seq_start,
    logSeqEnd: r.log_seq_end,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

/* ── log blobs ────────────────────────────────────────────────────────────────
 * The one genuinely dangerous read in this file. The R2 blob is the OMNISCIENT
 * serializer's output (DESIGN.md §5.5) — every tile in every hand. Serving it
 * for a match that is still running would hand a player the other three hands,
 * which is why `status` gates both routes and not merely `log_key`.
 */

function logIsSettled(status: string): boolean {
  return status === "complete" || status === "abandoned";
}

async function serveLog(
  p: Platform,
  logKey: string,
  cacheControl: string,
): Promise<Response> {
  const object = await p.logs.get(logKey);
  if (object === null || object.body === null) return fail("log_not_found", 404);
  /* A match-level key is a MANIFEST over per-hand blobs (the table archives one
   * blob per hand and lists them at match end). Stitch those into one log: the
   * header from the last hand, every hand's events in order. Buffered, because
   * it is assembled; a whole four-wind match is under a megabyte. */
  if (logKey.endsWith("/log.json")) {
    const manifest = (await new Response(object.body).json()) as { hands?: unknown };
    const keys = Array.isArray(manifest.hands) ? (manifest.hands as string[]) : [];
    let header: unknown = null;
    const events: unknown[] = [];
    for (const key of keys) {
      const part = await p.logs.get(key);
      if (part === null || part.body === null) return fail("log_not_found", 404);
      const hand = (await new Response(part.body).json()) as { header: unknown; events: unknown[] };
      header = hand.header;
      events.push(...hand.events);
    }
    if (header === null) return fail("log_not_found", 404);
    return new Response(JSON.stringify({ header, events }), {
      status: 200,
      headers: {
        ...BASE_HEADERS,
        "content-type": "application/json; charset=utf-8",
        "content-disposition": "inline",
        "cache-control": cacheControl,
      },
    });
  }
  /* Streamed, not buffered: a long match's log is megabytes and there is no
   * reason for it to pass through this Worker's heap on the way out. */
  return new Response(object.body, {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "inline",
      "cache-control": cacheControl,
      etag: object.httpEtag,
    },
  });
}

/* ── handlers ─────────────────────────────────────────────────────────────── */

/**
 * POST /api/identity — establish or re-present a device identity.
 *
 * Presenting a token that already hashes to a stored credential IS the
 * authentication path, so this route doubles as sign-in and returns the same
 * player. A token the server has never seen mints a new player: at P0 there is
 * nothing to steal by doing so, and the credential-per-row shape means adding
 * passkeys later touches this handler's data, not its shape.
 */
async function postIdentity(req: Request, p: Platform): Promise<Response> {
  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);

  const displayName = str(body.displayName);
  if (displayName === null || displayName.length > MAX_DISPLAY_NAME) {
    return fail("bad_display_name", 400);
  }

  const supplied = str(body.deviceToken);
  if (supplied !== null && !isPlausibleDeviceToken(supplied)) return fail("weak_device_token", 400);

  /* Server-minted when the client cannot generate good randomness. 32 Crockford
   * symbols is 160 bits, and this is the only response that ever carries the
   * token itself — after this it exists only as a digest. */
  const minted = supplied === null ? randomId(p.random, 32) : null;
  const token = supplied ?? minted!;
  const credentialId = await sha256Hex(token);
  const now = p.now();

  const existing = await playerForCredential(p.db, credentialId);
  if (existing !== null) {
    await touchCredential(p.db, credentialId, existing.id, now);
    /* A rename is a real edit and gets its own statement; touching is not. */
    if (existing.display_name !== displayName) {
      await renamePlayer(p.db, existing.id, displayName, now);
    }
    return json({ playerId: existing.id, displayName, rating: existing.rating, created: false });
  }

  const playerId = randomId(p.random, ID_LENGTH);
  await insertPlayer(p.db, { id: playerId, kind: "human", displayName, now });
  await insertCredential(p.db, {
    id: credentialId,
    playerId,
    kind: "device",
    label: str(body.label),
    now,
  });
  return json(
    { playerId, displayName, rating: null, created: true, deviceToken: minted },
    201,
  );
}

/** GET /api/matches — the caller's history, newest first. */
async function getMatches(url: URL, p: Platform, player: PlayerRow): Promise<Response> {
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isInteger(limitParam)
    ? Math.min(MAX_PAGE, Math.max(1, limitParam))
    : DEFAULT_PAGE;
  const before = str(url.searchParams.get("before"));
  const rows = await matchesForPlayer(p.db, player.id, limit, before);
  const matches = rows.map(matchListView);
  /* Keyset cursor, not an offset: the list is append-mostly and an offset page
   * shifts under the reader every time a match ends. */
  const nextBefore = rows.length === limit ? rows[rows.length - 1].started_at : null;
  return json({ matches, nextBefore });
}

/**
 * GET /api/matches/:id — detail, including every hand.
 *
 * Not a participant reads as 404, not 403. A 403 confirms that a match id
 * exists, which turns this route into a free enumeration oracle over every
 * match on the platform; a caller who is not in the match has no legitimate way
 * to tell the two apart, so it is told nothing.
 */
async function getMatchDetail(
  matchId: string,
  p: Platform,
  player: PlayerRow,
): Promise<Response> {
  const seat = await seatOf(p.db, matchId, player.id);
  if (seat === null) return fail("not_found", 404);

  const match = await matchById(p.db, matchId);
  if (match === null) return fail("not_found", 404);

  const [seats, hands] = await Promise.all([
    seatsOfMatch(p.db, matchId),
    handsOfMatch(p.db, matchId),
  ]);

  /* The share link (§2's viral loop) is only meaningful once the match is over
   * and its blob has landed; offering one before that would produce a link that
   * 404s for whoever it was sent to. */
  const shareable = match.status === "complete" && match.log_key !== null;
  const replayToken = shareable
    ? await mintReplayToken(p.replayTokenSecret, match.id)
    : null;

  return json({
    match: matchView(match),
    viewerSeat: seat,
    seats: seats.map(seatView),
    hands: hands.map(handView),
    replayToken,
  });
}

/** GET /api/matches/:id/log — the omniscient blob, participants only. */
async function getMatchLog(
  matchId: string,
  p: Platform,
  player: PlayerRow,
): Promise<Response> {
  /* Authorisation before R2, always: a non-participant must not be able to
   * measure whether a blob exists by timing this route. */
  const seat = await seatOf(p.db, matchId, player.id);
  if (seat === null) return fail("not_found", 404);

  const row = await matchLogById(p.db, matchId);
  if (row === null || row.log_key === null || !logIsSettled(row.status)) {
    return fail("log_not_ready", 404);
  }
  return serveLog(p, row.log_key, "private, no-store");
}

/**
 * GET /api/replay/:token — public, unauthenticated, no bearer of any kind.
 *
 * DESIGN.md §2: an invite-only alpha's only viral loop is the share artifact,
 * so this route exists at P0 or the loop does not exist. Two gates stand in for
 * the authentication that is deliberately absent: the token is an HMAC nobody
 * can forge, and the match must be `complete` — a running match's omniscient
 * log is every player's hand, and no share link may ever reach one.
 *
 * `abandoned` is servable to participants and not to the public: a match that
 * fell over is reviewable by the people who were in it and is not a share
 * artifact.
 */
async function getReplay(token: string, p: Platform): Promise<Response> {
  const matchId = await verifyReplayToken(p.replayTokenSecret, token);
  if (matchId === null) return fail("not_found", 404);

  const row = await matchLogById(p.db, matchId);
  if (row === null || row.log_key === null || row.status !== "complete") {
    return fail("not_found", 404);
  }
  /* A completed match's log is immutable by construction — nothing may
   * overwrite a match record (schema.sql, "Regenerable vs stateful") — so it
   * caches forever and a shared link costs the origin one read. */
  return serveLog(p, row.log_key, "public, max-age=31536000, immutable");
}

/** `access` unspecified in the request body falls back to the room's own
 *  default when the table is in a room (§8b: "access defaults from the
 *  room"), else "open" — same "unknown degrades to the safe default"
 *  doctrine `matchFormat`/`mode` already use. An EXPLICIT `access` in the
 *  body still wins over the room's default; only its absence defers. */
function resolveAccess(bodyAccess: unknown, roomDefault: string | undefined): string {
  if (bodyAccess === "open" || bodyAccess === "private") return bodyAccess;
  if (roomDefault === "open" || roomDefault === "private") return roomDefault;
  return "open";
}

/**
 * POST /api/tables — create a table and take the creator's seat.
 *
 * The §5.3 handoff in full: D1 rows first, then the table is opened, then the
 * seat token is minted. If the DO call fails the match row is left `running`
 * and is reaped by the ops query idx_matches_running covers; the reverse order
 * would leave a live table no row points at, which nothing sweeps.
 *
 * The creator takes the FIRST HUMAN seat in the plan (§6, decision 3) — not
 * always seat 0, now that a bot may sit anywhere. A plan with no human seat at
 * all has nowhere for the creator to sit and is refused before any row is
 * written, same as every other malformed `seats`.
 *
 * §8b: an optional `roomCode` scopes the table to a room. The room, not the
 * request, owns `rulesetId`/`matchFormat` once it is configured — a request
 * value is silently ignored, the same "the room is the source of truth, not
 * the client" doctrine `postStart`'s D1-read-before-DO-call already follows
 * for who may start a table. The caller must already be a member (`POST
 * /api/rooms/:code/join`) — creating a table is not itself a join, so a
 * stranger cannot summon a table into a room they were never let into.
 */
async function postTable(req: Request, p: Platform, player: PlayerRow): Promise<Response> {
  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);

  let room: RoomRow | null = null;
  let roomGame: RoomGameSettings | null = null;
  const roomCodeRaw = str(body.roomCode);
  if (roomCodeRaw !== null) {
    room = await roomByCode(p.db, normaliseCode(roomCodeRaw));
    if (room === null) return fail("not_found", 404);
    if (!(await isRoomMember(p.db, room.code, player.id))) return fail("not_room_member", 403);
    roomGame = roomGameSettingsOf(parseRoomSettings(room.settings));
    if (roomGame === null) return fail("room_not_configured", 409);
  }

  const rulesetId = roomGame?.rulesetId ?? str(body.rulesetId) ?? DEFAULT_RULESET_ID;
  const rules = ruleset(rulesetId);
  if (rules === undefined) return fail("unknown_ruleset", 400);
  try {
    assertRulesetSound(rules);
  } catch {
    /* A preset that fails its own soundness check is a deploy bug, not a
     * client one. Refuse to start a match under it rather than archive it. */
    return fail("server_misconfigured", 500);
  }

  const matchFormat = roomGame !== null ? roomGame.matchFormat : (body.matchFormat === "full" ? "full" : "east");
  const mode = body.mode === "ranked" ? "ranked" : "casual";
  const access = resolveAccess(body.access, roomGame?.access);
  const randomizeSeats = body.randomizeSeats === true;

  const seatPlan = seatPlanFromBody(body, p.isBotKey);
  if (seatPlan === "invalid") return fail("unknown_bot", 400);

  const creatorSeat = seatPlan.findIndex((s) => s.kind === "human");
  if (creatorSeat === -1) return fail("bad_seats", 400);

  /* Ranked needs identity and scale that a bot cannot supply (§1.5, §6
   * decision 5) — refused before any row is written, same as every other
   * `postTable` validation failure. */
  if (mode === "ranked" && seatPlan.some((s) => s.kind === "bot")) {
    return fail("ranked_needs_humans", 400);
  }

  const now = p.now();
  const hash = await rulesetHash(rules);
  await archiveRuleset(p.db, hash, rules, now);

  const matchId = randomId(p.random, ID_LENGTH);
  const joinCode = randomId(p.random, JOIN_CODE_LENGTH);
  const botSeats = seatPlan.filter((s) => s.kind === "bot").length;
  await insertMatch(p.db, {
    id: matchId,
    matchFormat,
    rulesetHash: hash,
    rulesetId: rules.id,
    engineVersion: p.engineVersion,
    logSchemaVersion: EVENT_SCHEMA_VERSION,
    roomCode: room !== null ? room.code : null,
    joinCode,
    /* Ranked is rated at creation and frozen (schema.sql, matches.rated) — the
     * ranked/bot check above already guarantees every seat is human. */
    rated: mode === "ranked",
    botSeats,
    now,
    access,
    mode,
    handsBase: matchFormat === "full" ? 16 : 4,
    seatPlan: serializeSeatPlan(seatPlan),
    randomizeSeats,
    createdBy: player.id,
  });

  if (!(await claimSeat(p.db, matchId, creatorSeat as SeatIndex, player.id))) return fail("conflict", 409);

  const handoff = await openAndSeat(p, matchId, creatorSeat as SeatIndex, player, {
    matchId,
    rulesetId: rules.id,
    rulesetHash: hash,
    engineVersion: p.engineVersion,
    logSchemaVersion: EVENT_SCHEMA_VERSION,
    matchFormat,
    seatPlan,
    randomizeSeats,
    startedAt: now,
  });
  if (handoff === null) return fail("table_unavailable", 503);

  return json(
    {
      tableId: handoff.tableId,
      matchUuid: matchId,
      joinCode,
      seat: creatorSeat,
      seatToken: handoff.seatToken,
      seatTokenExpiresAt: handoff.expiresAt,
      rulesetId: rules.id,
      rulesetHash: hash,
      engineVersion: p.engineVersion,
      matchFormat,
      mode,
      access,
      roomCode: room !== null ? room.code : null,
    },
    201,
  );
}

interface Handoff {
  tableId: string;
  seatToken: string;
  expiresAt: string;
}

/** Open the table if it is new, then mint this seat's token. `spec` is null on
 *  a join: the table is already open and reopening it is the joiner's business
 *  least of all. */
async function openAndSeat(
  p: Platform,
  matchId: string,
  seat: SeatIndex,
  player: PlayerRow,
  spec: TableSpec | null,
): Promise<Handoff | null> {
  try {
    const id = p.tables.idFromName(matchId);
    const stub = p.tables.get(id);
    if (spec !== null) await stub.openTable(spec);
    const { seatToken, expiresAt } = await stub.issueSeatToken({
      matchId,
      seat,
      playerId: player.id,
      displayName: player.display_name,
    });
    return { tableId: id.toString(), seatToken, expiresAt };
  } catch (e) {
    /* The caller turns this into a 503. Without a trace it is a 503 nobody can
     * ever diagnose, and the match plane is the half of the system this Worker
     * cannot see into. */
    console.error("table handoff failed", matchId, seat, e);
    return null;
  }
}

/**
 * POST /api/tables/:code/join — take a seat at an existing table.
 *
 * Idempotent for a player who already holds a seat: they get that same seat and
 * a fresh token. That is not a convenience, it is the reconnect path — §5.3's
 * "seat reclaim by server-issued credential on return" needs a way to ask for a
 * new token without the UNIQUE (match_id, player_id) constraint refusing it.
 */
async function postJoin(code: string, p: Platform, player: PlayerRow): Promise<Response> {
  const joinCode = normaliseCode(code);
  if (joinCode.length < 6) return fail("not_found", 404);

  const match = await matchByJoinCode(p.db, joinCode);
  if (match === null) return fail("not_found", 404);

  let seat = await seatOf(p.db, match.id, player.id);
  if (seat === null) {
    /* A bot seat may be at ANY seat index now (§7.2 `seats`), not only the
     * high ones — the free-seat search must consult the plan seat by seat
     * rather than the old single `firstBotSeat` cutoff. */
    const humanSeats = seatPlanOf(match.seat_plan, match.bot_seats)
      .map((s, i) => ({ spec: s, seat: i as SeatIndex }))
      .filter((s) => s.spec.kind === "human")
      .map((s) => s.seat);

    /* Bounded retry rather than a lock: seat assignment reads then writes, and
     * PRIMARY KEY (match_id, seat) is the arbiter. One attempt per human seat
     * is the most contention this table can produce. */
    for (let attempt = 0; attempt < humanSeats.length && seat === null; attempt += 1) {
      const seats = await seatsOfMatch(p.db, match.id);
      /* A concurrent duplicate of this very request may have seated us between
       * the check above and now. UNIQUE (match_id, player_id) would refuse every
       * remaining attempt, so read our own seat back rather than burning the
       * retries and answering 409 to a player who is in fact seated. */
      const own = seats.find((s) => s.player_id === player.id);
      if (own !== undefined) {
        seat = own.seat;
        break;
      }
      const taken = new Set(seats.map((s) => s.seat));
      const free = humanSeats.find((s) => !taken.has(s));
      if (free === undefined) return fail("table_full", 409);
      if (await claimSeat(p.db, match.id, free, player.id)) seat = free;
    }
    if (seat === null) return fail("conflict", 409);
  }

  const handoff = await openAndSeat(p, match.id, seat as SeatIndex, player, null);
  if (handoff === null) return fail("table_unavailable", 503);

  return json({
    tableId: handoff.tableId,
    matchUuid: match.id,
    seat,
    seatToken: handoff.seatToken,
    seatTokenExpiresAt: handoff.expiresAt,
    rulesetId: match.ruleset_id,
    matchFormat: match.match_format,
  });
}

/** A table stub for a match this file already knows exists — `/start` and
 *  `/leave` never open a table, only ever reach one that `postTable` did. */
function tableStubFor(p: Platform, matchId: string): TableStub {
  return p.tables.get(p.tables.idFromName(matchId));
}

/**
 * POST /api/tables/:matchId/start — the creator's "start now, fill the rest
 * with bots" (§7.2). Creator-only, while the table is still open to fill:
 * anyone else gets the same 404 a non-existent match would (getMatchDetail's
 * doctrine — a caller who fails this check has no legitimate way to learn
 * which is true). The actual fill/shuffle/start sequence lives on the table
 * object (`table.ts` `handleFill`) and is idempotent there, so a second call
 * after the table has already started is a harmless no-op rather than an
 * error this route needs to detect itself.
 */
async function postStart(matchId: string, p: Platform, player: PlayerRow): Promise<Response> {
  const match = await matchById(p.db, matchId);
  if (match === null || match.created_by !== player.id) return fail("not_found", 404);
  /* §7.2: creator only, `lobby_status = 'waiting'`. This D1 read can be stale
   * by the time the DO processes the call (two near-simultaneous starts, or a
   * clock that finished starting between the read and now) — that race is
   * `handleFill`'s to absorb, which is why IT is idempotent rather than this
   * check being loose. */
  if (match.lobby_status !== "waiting") return fail("already_started", 409);

  try {
    await tableStubFor(p, matchId).fill();
  } catch (e) {
    console.error("table fill failed", matchId, e);
    return fail("table_unavailable", 503);
  }
  return json({ ok: true });
}

/**
 * POST /api/tables/:matchId/leave — a participant's explicit leave (§7.2).
 * `seatOf` is the same authorisation primitive every match-scoped route uses:
 * a non-participant gets the same 404 a non-existent match would.
 */
async function postLeave(matchId: string, p: Platform, player: PlayerRow): Promise<Response> {
  const seat = await seatOf(p.db, matchId, player.id);
  if (seat === null) return fail("not_found", 404);

  try {
    await tableStubFor(p, matchId).leave(player.id);
  } catch (e) {
    console.error("table leave failed", matchId, player.id, e);
    return fail("table_unavailable", 503);
  }
  return json({ ok: true });
}

/* ── stats and leaderboards (PVP-LOBBY-PROPOSAL-2026-09-02.md §7.2's last two
 * bullets) ───────────────────────────────────────────────────────────────── */

/** "Last 10" / "last 30" per the stats contract. */
const RECENT_MATCHES_LIMIT = 10;
const RATING_HISTORY_LIMIT = 30;
const LEADERBOARD_LIMIT = 50;

/** `moves_graded`/`moves_matched` → an agreement rate, or null when nothing
 *  was graded — the same rule `seatView`'s per-match `agreement` uses. */
const agreementOf = (graded: number, matched: number): number | null => (graded > 0 ? matched / graded : null);

/**
 * `GET /api/stats/me` and `GET /api/players/:id/stats` — one function, two
 * routes: "me" is just "the caller's own id", never a different read. Every
 * number here folds `match_players`/`hands`/`rating_history` at read time
 * (schema.sql, "Regenerable vs stateful" — none of it is a stored
 * projection), so a stats screen is always exactly as fresh as the last
 * match to settle.
 *
 * Not a participant-only route: a player's stats are reachable by anyone
 * authenticated, the same "everyone sees everyone" the lobby itself already
 * grants (PVP-LOBBY-PROPOSAL-2026-09-02.md §6 decision 1) — the leaderboard,
 * the "here now" list and a match's own scoreboard all link a name here.
 */
async function getStatsFor(playerId: string, p: Platform): Promise<Response> {
  const player = await playerById(p.db, playerId);
  if (player === null) return fail("not_found", 404);

  const [totals, avgFaan, netChips, recent, ratingHistory] = await Promise.all([
    statsTotalsForPlayer(p.db, playerId),
    avgFaanForPlayer(p.db, playerId),
    netChipsForPlayer(p.db, playerId),
    recentMatchesForPlayer(p.db, playerId, RECENT_MATCHES_LIMIT),
    ratingHistoryForPlayer(p.db, playerId, RATING_HISTORY_LIMIT),
  ]);

  // SQLite's SUM/COUNT over zero matching rows is NULL, never 0 — `?? 0`
  // below is that translation, done once here rather than at every call site.
  const t: StatsTotalsRow = totals ?? {
    matches: 0, ranked: 0, casual: 0, place1: 0, place2: 0, place3: 0, place4: 0,
    hands_won: 0, self_draws: 0, deal_ins: 0, moves_graded: 0, moves_matched: 0,
  };

  return json({
    player: {
      id: player.id,
      displayName: player.display_name,
      rating: player.rating,
      ratingGames: player.rating_games,
      provisional: isProvisional(player.rating_games),
    },
    totals: {
      matches: t.matches ?? 0,
      ranked: t.ranked ?? 0,
      casual: t.casual ?? 0,
      wins: t.place1 ?? 0,
      places: [t.place1 ?? 0, t.place2 ?? 0, t.place3 ?? 0, t.place4 ?? 0],
      handsWon: t.hands_won ?? 0,
      selfDraws: t.self_draws ?? 0,
      dealIns: t.deal_ins ?? 0,
      avgFaan,
      netChips,
      movesGraded: t.moves_graded ?? 0,
      agreement: agreementOf(t.moves_graded ?? 0, t.moves_matched ?? 0),
    },
    recent: recent.map((r: RecentMatchRow) => ({
      matchId: r.match_id,
      endedAt: r.ended_at,
      mode: r.mode,
      place: r.place,
      chips: r.final_chips,
      ratingDelta:
        r.rating_before !== null && r.rating_after !== null ? r.rating_after - r.rating_before : null,
    })),
    ratingHistory: ratingHistory.map((h: RatingHistoryPointRow) => ({
      at: h.at,
      before: h.before,
      after: h.after,
      matchId: h.match_id,
    })),
  });
}

/** GET /api/leaderboard?mode=ranked|casual — defaults to ranked on anything
 *  else, same "unknown value degrades to the safe default" doctrine as
 *  `postTable`'s `matchFormat`/`access` parsing above. */
async function getLeaderboard(url: URL, p: Platform): Promise<Response> {
  const mode = url.searchParams.get("mode") === "casual" ? "casual" : "ranked";

  if (mode === "casual") {
    const rows = await leaderboardCasual(p.db, LEADERBOARD_LIMIT);
    return json({
      mode,
      entries: rows.map((r: CasualLeaderboardRow) => ({
        playerId: r.player_id,
        displayName: r.display_name,
        matches: r.matches,
        wins: r.wins,
        places: [r.place1, r.place2, r.place3, r.place4],
        agreement: agreementOf(r.moves_graded, r.moves_matched),
      })),
    });
  }

  const rows = await leaderboardRanked(p.db, LEADERBOARD_LIMIT);
  return json({
    mode,
    entries: rows.map((r: RankedLeaderboardRow) => ({
      playerId: r.id,
      displayName: r.display_name,
      rating: r.rating,
      games: r.rating_games,
      provisional: isProvisional(r.rating_games),
    })),
  });
}

/* ── the lobby ────────────────────────────────────────────────────────────── */

/** A heartbeat older than this is not "here" (proposal §3.2). */
const HERE_WINDOW_MS = 90_000;
/** Defensive cap on `tables[]` — see `SQL.matchesWaitingOrPlaying`. */
const LOBBY_TABLE_LIMIT = 200;
/** "Last five", per §7.2. */
const RECENT_LIMIT = 5;
/** "Last 50" lobby chat messages returned inside `GET /api/lobby` (§8) —
 *  same number the table's own K_CHAT ring keeps (worker/src/table.ts). */
const LOBBY_CHAT_LIMIT = 50;
/** §8: "length cap" for lobby chat, same number table chat enforces
 *  (protocol CHAT_TEXT_MAX_LENGTH) but re-stated here rather than imported —
 *  this file already re-derives its own small constants (MAX_DISPLAY_NAME)
 *  rather than reach into the protocol package for them. */
const LOBBY_CHAT_TEXT_MAX_LENGTH = 200;
/** §8: "per-player rate limit" for lobby chat, enforced off the newest row's
 *  own `created_at` rather than a second table. */
const LOBBY_CHAT_MIN_INTERVAL_MS = 2_000;

interface HereEntry {
  playerId: string;
  displayName: string;
  state: "lobby" | "waiting" | "playing";
  matchId?: string;
  joinCode?: string | null;
  hand?: number;
  handsBase?: number;
  /** §8b decision 3: the global lobby's `here` still shows a member seated at
   *  a room's table, tagged with which room — even though `tables[]` itself
   *  omits that room's tables. Absent for a room-scoped `here` entry (the
   *  room is already the whole context) and for a bare "in the lobby"
   *  heartbeat with no table at all. */
  roomCode?: string;
}

/** `access === 'private'` hides the code from every lobby view, same rule for
 *  `tables[]` and `here[]` — a private table is reachable only by the code its
 *  creator actually shared, never by browsing. */
const codeIfOpen = (access: string, joinCode: string | null): string | null =>
  access === "open" ? joinCode : null;

/** A bot seat's lobby label — `Platform.botDisplayName` if the deployment
 *  supplies one (gamepvp/src/bots.ts), else a generic placeholder. Never
 *  blank: an empty seat label reads as a bug, not as "nobody picked a name". */
function botSeatLabel(p: Platform, key: string | undefined, seat: SeatIndex): string {
  return p.botDisplayName?.(key, seat) ?? "Bot";
}

/**
 * One lobby-listed match, resolved into `tables[]`'s shape — shared by
 * `GET /api/lobby` and `GET /api/rooms/:code` (§8b's `tables: [...]`), so the
 * seat-plan/human-seat merge lives in exactly one place. When `here` is
 * given, every human seat found also updates it — `GET /api/lobby`'s way of
 * folding "seated at a table" into the richer state, without a second pass
 * over the same rows; `GET /api/rooms/:code` has no `here` panel and passes
 * `null`.
 */
async function tableViewOf(p: Platform, m: LobbyMatchRow, here: Map<string, HereEntry> | null) {
  const plan = seatPlanOf(m.seat_plan, m.bot_seats);
  const humanSeats = await humanSeatsOfMatch(p.db, m.id);
  const bySeat = new Map(humanSeats.map((s) => [s.seat, s]));
  const joinCode = codeIfOpen(m.access, m.join_code);
  const state: "waiting" | "playing" = m.lobby_status === "playing" ? "playing" : "waiting";

  const seats = plan.map((spec, seat) => {
    if (spec.kind === "bot") {
      return {
        seat,
        kind: "bot" as const,
        displayName: botSeatLabel(p, spec.bot, seat as SeatIndex),
        connected: false,
      };
    }
    const row = bySeat.get(seat);
    if (row !== undefined && here !== null) {
      here.set(row.player_id, {
        playerId: row.player_id,
        displayName: row.display_name,
        state,
        matchId: m.id,
        joinCode,
        hand: m.current_hand,
        handsBase: m.hands_base,
        roomCode: m.room_code ?? undefined,
      });
    }
    return {
      seat,
      kind: "human" as const,
      displayName: row?.display_name,
      connected: row !== undefined && row.connected !== 0,
    };
  });

  return {
    matchId: m.id,
    joinCode,
    access: m.access,
    mode: m.mode,
    rulesetId: m.ruleset_id,
    matchFormat: m.match_format,
    lobbyStatus: m.lobby_status,
    hand: m.current_hand,
    handsBase: m.hands_base,
    seats,
    createdBy: m.created_by,
    startedAt: m.started_at,
    roomCode: m.room_code,
  };
}

async function recentView(p: Platform, m: DoneMatchRow) {
  const seats = await seatsOfMatch(p.db, m.id);
  return {
    matchId: m.id,
    endedAt: m.ended_at,
    mode: m.mode,
    /* Standings for the seats `match_players` actually has rows for — every
     * human that was ever seated. A seat that was a bot from creation and
     * never claimed by a human has no row to read a name from (schema.sql
     * match_players: nothing ever inserts one for a bot seat) and is omitted
     * rather than guessed at. */
    standings: seats.map((s) => ({ displayName: s.display_name, chips: s.final_chips, place: s.place })),
  };
}

const chatView = (r: LobbyMessageRow) => ({
  id: r.id,
  playerId: r.player_id,
  displayName: r.display_name,
  text: r.text,
  at: r.created_at,
});

/**
 * GET /api/lobby, optionally `?room=CODE` (§8b) — four panels, four query
 * groups (proposal §3.3's "three queries" plus chat), merged here rather than
 * in SQL: `here` is a union of sources that mean the same thing (a player who
 * showed up), and building that union in application code keeps every query
 * in `db.ts` a single, obvious statement.
 *
 * Room-scoped: every panel reads only that room's rows (db.ts's `*InRoom`
 * statements) — `here` is members seen recently (joined through
 * `room_players`) or seated at the room's own tables.
 *
 * Unscoped (`roomCode === null`): `tables`/`recent`/`chat` exclude every
 * room-scoped row (`room_code IS NULL`, §8b decision 3) — a room's traffic
 * does not leak into the general list. `here` is the one deliberate
 * exception: it is read from the SAME unfiltered `matchesWaitingOrPlaying`
 * query `roomCode !== null` would otherwise use filtered, so a member seated
 * at a room's table still shows up in the global "who's around" list, tagged
 * with `roomCode` — the recorded decision (§8b) is "yes, tag it", on the
 * grounds that hiding a friend entirely because they wandered into a room is
 * worse than a harmless tag.
 */
async function getLobby(p: Platform, roomCode: string | null): Promise<Response> {
  // Authenticated caller only, checked by the router; the lobby view itself
  // has no per-viewer filtering (§6 decision 1: "everyone sees everyone").
  const now = p.now();
  const sinceIso = new Date(Date.parse(now) - HERE_WINDOW_MS).toISOString();

  if (roomCode !== null && (await roomByCode(p.db, roomCode)) === null) return fail("not_found", 404);

  const [presenceRows, openRows, doneRows, chatRows] = await Promise.all([
    roomCode === null ? presenceSince(p.db, sinceIso) : presenceInRoom(p.db, roomCode, sinceIso),
    roomCode === null
      ? matchesWaitingOrPlaying(p.db, LOBBY_TABLE_LIMIT)
      : matchesWaitingOrPlayingInRoom(p.db, roomCode, LOBBY_TABLE_LIMIT),
    roomCode === null ? matchesDone(p.db, RECENT_LIMIT) : matchesDoneInRoom(p.db, roomCode, RECENT_LIMIT),
    // Fail soft: a lobby without chat is a lobby; a lobby that 500s because
    // the chat table is missing on a deployment is not.
    (roomCode === null
      ? recentLobbyMessages(p.db, LOBBY_CHAT_LIMIT)
      : recentLobbyMessagesInRoom(p.db, roomCode, LOBBY_CHAT_LIMIT)
    ).catch((err: unknown) => {
      console.error("lobby chat unavailable", err);
      return [] as Awaited<ReturnType<typeof recentLobbyMessages>>;
    }),
  ]);

  /* Seeded from presence; a seated human below overwrites their entry with
   * the richer "at a table" state — that is strictly more specific than a
   * bare heartbeat, never a downgrade. */
  const here = new Map<string, HereEntry>();
  for (const row of presenceRows) {
    here.set(row.player_id, { playerId: row.player_id, displayName: row.display_name, state: "lobby" });
  }

  const tables: Awaited<ReturnType<typeof tableViewOf>>[] = [];
  for (const m of openRows) {
    const view = await tableViewOf(p, m, here);
    /* Global only: `openRows` here is UNFILTERED (matchesWaitingOrPlaying),
     * on purpose, so `here` above gets tagged for a room-seated player; the
     * room-scoped call already filtered its own `openRows` in SQL, so every
     * row here belongs in `tables[]`. */
    if (roomCode === null && m.room_code !== null) continue;
    tables.push(view);
  }

  const recent = await Promise.all(doneRows.map((m) => recentView(p, m)));

  // Chat rows come back newest-first (idx_lobby_messages_player's sibling
  // ordering — see recentLobbyMessages' doc comment); the lobby renders
  // oldest-first, same convention the table's own K_CHAT ring already uses.
  const chat = chatRows.slice().reverse().map(chatView);

  return json({ now, here: [...here.values()], tables, recent, chat });
}

/** POST /api/presence — the lobby heartbeat (proposal §3.2). Upsert, not
 *  insert: presence is current state, one row per player, never history. */
async function postPresence(req: Request, p: Platform, player: PlayerRow): Promise<Response> {
  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);
  const state = body.state === "away" ? "away" : "lobby";
  await upsertPresence(p.db, player.id, state, p.now());
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

/**
 * POST /api/lobby/chat — the lobby's chat (§8), optionally scoped to a room
 * by `roomCode` (§8b) — `null`/absent posts to the global lobby, same
 * convention `matches.room_code` and `lobby_messages.room_code` already use.
 * Length-capped like table chat, rate-limited per player off the newest
 * row's OWN `created_at` — no second table for "when did this player last
 * post", same doctrine `postPresence` uses for presence, and ONE limit
 * shared across every surface (db.ts `SQL.lastLobbyMessageForPlayer`'s doc
 * comment) rather than a per-room budget. 204, same as `postPresence`: the
 * row itself is read back through `GET /api/lobby`, not echoed here.
 *
 * No membership check: rooms are public and destructible until real accounts
 * exist (the Almanac's own room-admin doctrine, `room-admin/_middleware.ts`),
 * and §6 decision 1 already makes the platform "everyone sees everyone" —
 * gating who may TALK in a room more tightly than who may SEE it would be a
 * new, unrequested restriction, not this brief's.
 */
async function postLobbyChat(req: Request, p: Platform, player: PlayerRow): Promise<Response> {
  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);

  const text = str(body.text);
  if (text === null || text.length > LOBBY_CHAT_TEXT_MAX_LENGTH) return fail("bad_text", 400);

  const roomCodeRaw = str(body.roomCode);
  let roomCode: string | null = null;
  if (roomCodeRaw !== null) {
    roomCode = normaliseCode(roomCodeRaw);
    if ((await roomByCode(p.db, roomCode)) === null) return fail("not_found", 404);
  }

  const now = p.now();
  const last = await lastLobbyMessageAt(p.db, player.id);
  if (last !== null && Date.parse(now) - Date.parse(last) < LOBBY_CHAT_MIN_INTERVAL_MS) {
    return fail("rate_limited", 429);
  }

  await insertLobbyMessage(p.db, { playerId: player.id, displayName: player.display_name, text, roomCode, now });
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

/* ── rooms (PVP-LOBBY-PROPOSAL-2026-09-02.md §8b) ────────────────────────────
 * `rooms`/`room_players` belong to the Almanac (schema.sql's "rooms" note);
 * the game reads them and writes only its own `game` settings key and its
 * own membership rows. No route here ever touches `password_hash` — that is
 * the Almanac's own future flow, untouched by this file.
 */

const MAX_ROOM_NAME = 60;
/** 6 Crockford characters, per §8b — shorter than a join code (8, §5.3's
 *  abuse posture) because a room code is read aloud across a table far more
 *  than it is guessed at; the admin code, not the room code, is the real
 *  gate on anything destructive. */
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_MAX_ATTEMPTS = 10;

/** Draw a fresh room code, retried on collision with an existing `rooms.code`
 *  (§8b: "not colliding with Almanac codes" — this IS that check, since
 *  Almanac-created codes live in the same `rooms` table this reads). At
 *  6 Crockford symbols (30 bits) a collision inside `ROOM_CODE_MAX_ATTEMPTS`
 *  tries is astronomically unlikely at any scale this beta will ever reach;
 *  exhausting the budget is treated as a deploy-level anomaly, not a client
 *  error. */
async function generateRoomCode(p: Platform): Promise<string> {
  for (let attempt = 0; attempt < ROOM_CODE_MAX_ATTEMPTS; attempt += 1) {
    const code = randomId(p.random, ROOM_CODE_LENGTH);
    if ((await roomByCode(p.db, code)) === null) return code;
  }
  throw new Error("room code space exhausted");
}

function roomView(room: RoomRow, game: RoomGameSettings | null, memberCount: number, tables: unknown[]) {
  return { code: room.code, name: room.name, game, memberCount, tables };
}

/**
 * POST /api/rooms — create a room, online-first (§8b, §9's "an online room is
 * the same `rooms` row"). Sets `settings.game` and hashes `adminCode` into
 * `admin_code_hash` (0011's column, same sha256 treatment the Almanac's own
 * room-admin middleware reads) — that hash is the ONLY gate on
 * `POST /api/rooms/:code/settings` and the table-close route below; there is
 * deliberately no master-code fallback on the game side (see
 * gamepvp/README.md's Rooms section for why). The creator is also the room's
 * first member (`insertRoomPlayer`), same as `postTable` seating its creator.
 */
async function postRooms(req: Request, p: Platform, player: PlayerRow): Promise<Response> {
  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);

  const name = str(body.name);
  if (name === null || name.length > MAX_ROOM_NAME) return fail("bad_name", 400);

  const rulesetId = str(body.rulesetId) ?? DEFAULT_RULESET_ID;
  const rules = ruleset(rulesetId);
  if (rules === undefined) return fail("unknown_ruleset", 400);

  const matchFormat = body.matchFormat === "full" ? "full" : "east";
  const access = body.access === "private" ? "private" : "open";

  const adminCode = str(body.adminCode);
  if (adminCode === null) return fail("bad_admin_code", 400);

  let code: string;
  try {
    code = await generateRoomCode(p);
  } catch (e) {
    console.error("room code generation failed", e);
    return fail("server_misconfigured", 500);
  }

  const now = p.now();
  const game: RoomGameSettings = { rulesetId: rules.id, matchFormat, access };
  await insertRoom(p.db, {
    code,
    name,
    settings: JSON.stringify({ game }),
    adminCodeHash: await sha256Hex(adminCode),
    now,
  });
  await insertRoomPlayer(p.db, { roomCode: code, playerId: player.id, name: player.display_name });

  return json({ code }, 201);
}

/** GET /api/rooms/:code — public read (§6 decision 1: everyone sees
 *  everyone), same "browsable by design" doctrine the Almanac's own room GETs
 *  already follow (`room-admin/_middleware.ts`'s header comment). */
async function getRoom(codeRaw: string, p: Platform): Promise<Response> {
  const code = normaliseCode(codeRaw);
  const room = await roomByCode(p.db, code);
  if (room === null) return fail("not_found", 404);

  const [memberCount, openRows] = await Promise.all([
    roomMemberCount(p.db, room.code),
    matchesWaitingOrPlayingInRoom(p.db, room.code, LOBBY_TABLE_LIMIT),
  ]);
  const tables = await Promise.all(openRows.map((m) => tableViewOf(p, m, null)));
  const game = roomGameSettingsOf(parseRoomSettings(room.settings));

  return json(roomView(room, game, memberCount, tables));
}

/** GET /api/rooms/mine — every room the caller has joined, most recently
 *  touched first (creating a room joins it too — `postRooms`). */
async function getRoomsMine(p: Platform, player: PlayerRow): Promise<Response> {
  const rooms = await roomsForPlayer(p.db, player.id);
  return json({
    rooms: rooms.map((r) => ({
      code: r.code,
      name: r.name,
      game: roomGameSettingsOf(parseRoomSettings(r.settings)),
    })),
  });
}

/** POST /api/rooms/:code/join — membership, idempotent (`insertRoomPlayer`'s
 *  OR IGNORE) — the same reconnect-safe shape `postJoin`'s "already seated"
 *  path uses for a table. */
async function postRoomJoin(codeRaw: string, p: Platform, player: PlayerRow): Promise<Response> {
  const code = normaliseCode(codeRaw);
  const room = await roomByCode(p.db, code);
  if (room === null) return fail("not_found", 404);
  await insertRoomPlayer(p.db, { roomCode: room.code, playerId: player.id, name: player.display_name });
  return json({ code: room.code });
}

/** The room-admin gate (§8b): the room's OWN `admin_code_hash` (0011),
 *  compared exactly as the Almanac's `room-admin/_middleware.ts` compares its
 *  room-scoped code — sha256 hex, constant-time. Deliberately NOT the
 *  Almanac's master code (`MASTER_CODE = "8888"` in that middleware): that
 *  constant is scoped to the Almanac's OWN `/api/scoring/room-admin/*`
 *  surface, is not exposed to this Worker in any config, and hardcoding it
 *  here would let anyone who has read that file's source administer every
 *  game room — a much bigger blast radius than the Almanac ever accepted for
 *  its own surface. A room with no `admin_code_hash` at all (never possible
 *  through `postRooms`, but an Almanac-created room might have none) simply
 *  has no admin on the game side. */
async function verifyRoomAdmin(req: Request, room: RoomRow): Promise<boolean> {
  const given = req.headers.get("x-mjrc-admin-code") ?? "";
  if (given === "" || room.admin_code_hash === null) return false;
  return constantTimeEqual(await sha256Hex(given), room.admin_code_hash);
}

/**
 * POST /api/rooms/:code/settings — admin-only change to `settings.game`
 * (§8b). Unspecified fields keep their current value; every other key of
 * `settings` (the Almanac's own) round-trips untouched via
 * `withRoomGameSettings`. A room with no `game` yet (an Almanac-created room
 * that has never been configured for online play) defaults to the platform's
 * own defaults before this write establishes it for the first time.
 */
async function postRoomSettings(req: Request, codeRaw: string, p: Platform): Promise<Response> {
  const code = normaliseCode(codeRaw);
  const room = await roomByCode(p.db, code);
  if (room === null) return fail("not_found", 404);
  if (!(await verifyRoomAdmin(req, room))) return fail("unauthorized", 401);

  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);

  const settings = parseRoomSettings(room.settings);
  const current = roomGameSettingsOf(settings) ?? {
    rulesetId: DEFAULT_RULESET_ID,
    matchFormat: "east",
    access: "open",
  };

  const rulesetIdRaw = str(body.rulesetId);
  if (rulesetIdRaw !== null && ruleset(rulesetIdRaw) === undefined) return fail("unknown_ruleset", 400);

  const game: RoomGameSettings = {
    rulesetId: rulesetIdRaw ?? current.rulesetId,
    matchFormat: body.matchFormat === undefined ? current.matchFormat : body.matchFormat === "full" ? "full" : "east",
    access: body.access === undefined ? current.access : body.access === "private" ? "private" : "open",
  };

  await updateRoomSettings(p.db, room.code, JSON.stringify(withRoomGameSettings(settings, game)), p.now());
  return json({ code: room.code, game });
}

/**
 * POST /api/rooms/:code/tables/:matchId/close — admin-only (§8b phase 2): a
 * still-waiting table is abandoned. Does not touch the Table DO — a waiting
 * table's clocks never started, so there is nothing live to reach
 * (`abandonWaitingMatch`'s own doc comment). `matchById` first, not the
 * UPDATE's own `meta.changes`, so the response can tell "no such table" from
 * "that table is not in this room" from "already started" apart — the same
 * "read the row, THEN decide" ordering `postStart` uses for the same reason.
 */
async function postRoomTableClose(codeRaw: string, matchId: string, req: Request, p: Platform): Promise<Response> {
  const code = normaliseCode(codeRaw);
  const room = await roomByCode(p.db, code);
  if (room === null) return fail("not_found", 404);
  if (!(await verifyRoomAdmin(req, room))) return fail("unauthorized", 401);

  const match = await matchById(p.db, matchId);
  if (match === null || match.room_code !== room.code) return fail("not_found", 404);
  if (match.lobby_status !== "waiting") return fail("not_waiting", 409);

  await abandonWaitingMatch(p.db, matchId, p.now());
  return json({ ok: true });
}

/* ── router ───────────────────────────────────────────────────────────────── */

/**
 * Exported so tests drive the whole service through one function with a fake
 * platform, which is the only way the "not a participant" cases below are worth
 * anything: they have to be asserted on the real routing, not on a handler
 * called directly with an authorisation decision already made.
 */
export async function handle(request: Request, p: Platform): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  /* Path segments are values here — a join code, a match id, a share token — so
   * they are decoded, and a malformed escape is a 404 rather than a throw. */
  let seg: string[];
  try {
    seg = url.pathname.split("/").filter((s) => s !== "").map(decodeURIComponent);
  } catch {
    return fail("not_found", 404);
  }

  if (seg.length < 2 || seg[0] !== "api") return fail("not_found", 404);

  /* Public first, and it takes no Authorization header into account at all. */
  if (seg[1] === "replay" && seg.length === 3) {
    if (method !== "GET") return fail("method_not_allowed", 405);
    return getReplay(seg[2], p);
  }

  if (seg[1] === "identity" && seg.length === 2) {
    if (method !== "POST") return fail("method_not_allowed", 405);
    return postIdentity(request, p);
  }

  /* Everything past this line is authenticated. */
  const player = await authenticate(request, p);
  if (player === null) return fail("unauthorized", 401);

  if (seg[1] === "matches") {
    if (seg.length === 2) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getMatches(url, p, player);
    }
    if (seg.length === 3) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getMatchDetail(seg[2], p, player);
    }
    if (seg.length === 4 && seg[3] === "log") {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getMatchLog(seg[2], p, player);
    }
  }

  if (seg[1] === "tables") {
    if (seg.length === 2) {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postTable(request, p, player);
    }
    if (seg.length === 4 && seg[3] === "join") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postJoin(seg[2], p, player);
    }
    if (seg.length === 4 && seg[3] === "start") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postStart(seg[2], p, player);
    }
    if (seg.length === 4 && seg[3] === "leave") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postLeave(seg[2], p, player);
    }
  }

  if (seg[1] === "stats" && seg[2] === "me" && seg.length === 3) {
    if (method !== "GET") return fail("method_not_allowed", 405);
    return getStatsFor(player.id, p);
  }

  if (seg[1] === "players" && seg.length === 4 && seg[3] === "stats") {
    if (method !== "GET") return fail("method_not_allowed", 405);
    return getStatsFor(seg[2], p);
  }

  if (seg[1] === "leaderboard" && seg.length === 2) {
    if (method !== "GET") return fail("method_not_allowed", 405);
    return getLeaderboard(url, p);
  }

  if (seg[1] === "lobby") {
    if (seg.length === 2) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      /* §8b: ?room=CODE scopes every panel; absent/empty is the global lobby. */
      const roomParam = url.searchParams.get("room");
      const roomCode = roomParam === null || roomParam.trim() === "" ? null : normaliseCode(roomParam);
      return getLobby(p, roomCode);
    }
    if (seg.length === 3 && seg[2] === "chat") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postLobbyChat(request, p, player);
    }
  }

  if (seg[1] === "presence" && seg.length === 2) {
    if (method !== "POST") return fail("method_not_allowed", 405);
    return postPresence(request, p, player);
  }

  /* §8b: rooms. `mine` is checked before the generic `/:code` GET below —
   * otherwise a room happened to be coded "mine" would be unreachable, and a
   * caller asking for their own rooms would hit `getRoom("mine")` instead. */
  if (seg[1] === "rooms") {
    if (seg.length === 2) {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postRooms(request, p, player);
    }
    if (seg.length === 3 && seg[2] === "mine") {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getRoomsMine(p, player);
    }
    if (seg.length === 3) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getRoom(seg[2], p);
    }
    if (seg.length === 4 && seg[3] === "join") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postRoomJoin(seg[2], p, player);
    }
    if (seg.length === 4 && seg[3] === "settings") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postRoomSettings(request, seg[2], p);
    }
    if (seg.length === 6 && seg[3] === "tables" && seg[5] === "close") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postRoomTableClose(seg[2], seg[4], request, p);
    }
  }

  return fail("not_found", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let platform: Platform;
    try {
      platform = platformFromEnv(env);
    } catch (e) {
      if (e instanceof ConfigError) return fail("server_misconfigured", 500);
      throw e;
    }
    return handle(request, platform);
  },
};

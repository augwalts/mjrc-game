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
 *   GET  /api/players               the Players list — everyone, filtered by
 *                                   scope/format/games/sort/q
 *                                   (client/gamepvp/players-lab.html round 3)
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
import { EVENT_SCHEMA_VERSION, isSpeed, type Speed } from "@mjrc/protocol";
import { DEFAULT_RULESET_ID, assertRulesetSound, ruleset } from "@mjrc/rulesets";
import { isProvisional } from "../../engine/src/rating.js";
import type {
  D1Like,
  DmMessageRow,
  DoneMatchRow,
  FriendRow,
  HandRow,
  InboxItemRow,
  LeaderboardCandidateRow,
  LobbyMatchRow,
  LobbyMessageRow,
  MatchListRow,
  MatchRow,
  MatchSeatRow,
  PlayerDirectoryRow,
  PlayerMatchTotalRow,
  PlayerRow,
  R2Like,
  RatingHistoryPointRow,
  RecentMatchRow,
  RoomGameSettings,
  RoomRow,
  ScopedHandRow,
  ScopedMatchRow,
  ScopedSeatRow,
  SeatSpec,
  StatsScope,
  StatsTotalsRow,
} from "./db.js";
/* Re-exported: `TableSpec.seatPlan` and `postTable` both speak this type, and
 * gamepvp/src/index.ts (`tableInitOf`) needs it too — one shape, re-exported
 * from where it is defined rather than imported twice from two paths. */
export type { SeatSpec } from "./db.js";
import type { UserRow } from "./db.js";
import {
  ID_LENGTH,
  JOIN_CODE_LENGTH,
  STATS_SCOPE_LIMIT,
  abandonWaitingMatch,
  archiveRuleset,
  avgFaanForPlayer,
  claimSeat,
  credentialById,
  dismissInboxItem,
  dmMessagesInvolving,
  dmThread,
  friendStarsOfPlayer,
  friendsOfPlayer,
  handleTaken,
  handsForMatchIds,
  handsOfMatch,
  humanSeatsOfMatch,
  inboxItemById,
  inboxItemsForPlayer,
  insertConsent,
  insertCredential,
  insertDmMessage,
  insertInboxItem,
  insertLobbyMessage,
  insertMatch,
  insertPlayer,
  insertRoom,
  insertRoomPlayer,
  isRoomMember,
  isUniqueViolation,
  lastDmMessageAt,
  linkPlayerToUser,
  lastLobbyMessageAt,
  leaderboardCandidates,
  markDmThreadRead,
  matchById,
  matchByJoinCode,
  matchLogById,
  matchPlayersForMatchIds,
  matchesDone,
  matchesDoneInRoom,
  matchesForPlayer,
  matchesForPlayerScoped,
  matchesWaitingOrPlaying,
  matchesWaitingOrPlayingInRoom,
  netChipsForPlayer,
  onboardUser,
  parseRoomSettings,
  parseSeatPlan,
  playerById,
  playerForCredential,
  playerForUser,
  playerMatchTotals,
  playersDirectory,
  presenceInRoom,
  presenceSince,
  randomId,
  ratingHistoryForPlayer,
  recentLobbyMessages,
  recentLobbyMessagesInRoom,
  recentMatchesForPlayer,
  releaseHandle,
  renamePlayer,
  roomByCode,
  roomGameSettingsOf,
  roomMemberCount,
  roomPlayerIdsOf,
  roomsForPlayer,
  rulesetHash,
  scrubPlayer,
  scrubUser,
  seatOf,
  seatPlanOf,
  seatsOfMatch,
  serializeSeatPlan,
  sha256Hex,
  starFriend,
  statsTotalsForPlayer,
  toHex,
  touchUser,
  touchCredential,
  unstarFriend,
  updatePlayerAvatar,
  updateUserDisplayName,
  userById,
  updateRoomSettings,
  updateTzOffset,
  upsertPresence,
  withRoomGameSettings,
} from "./db.js";
import type { AuthConfig, ResolvedSession } from "./auth.js";
import { clearSessionCookie, isGrandfathered, resolveSession } from "./auth.js";

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
  /** §8a-2's clock speed, already resolved by `postTable` (the request, a
   *  room's fixed speed, or the human-count default) — carried verbatim into
   *  `TableInit.speed`. */
  speed: Speed;
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
  /**
   * The admin observer's read of a table (2026-09-03): every seat's own view
   * plus presence, as the table's `/observe` returns it. Relayed as JSON,
   * shaped by the client. Read-only.
   */
  observe(): Promise<Record<string, unknown>>;
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
  /* ── accounts (ACCOUNTS-GAME-SIGNIN-2026-09-04.md §2) ───────────────────
   * Three secrets, set by the owner with `wrangler secret put`; locally the
   * same three names in `gamepvp/.dev.vars`. All optional here on purpose:
   * a deployment without them still serves the game to grandfathered device
   * tokens and answers `GET /api/me` with `signedIn: false`, instead of
   * 500ing every route because sign-in is not configured yet. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  /** Local dev and the headless smoke only — enables `GET /auth/dev`. */
  AUTH_DEV_BYPASS?: string;
}

/** Just the sign-in half of `Env`. Separate so `gamepvp/src/index.ts` — whose
 *  own `Env` re-declares `TABLES` as a real Durable Object namespace — can call
 *  `authFromEnv` without its `Env` having to satisfy the platform's. */
export type AuthEnv = Pick<
  Env,
  "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "SESSION_SECRET" | "AUTH_DEV_BYPASS"
>;

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
  /**
   * Google sign-in and session cookies (worker/src/auth.ts). Optional: absent
   * means this deployment has no accounts configured, `GET /api/me` answers
   * `signedIn: false`, and `/auth/*` 503s — rather than every route failing
   * because one secret is missing.
   */
  auth?: AuthConfig;
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
    auth: authFromEnv(env),
  };
}

/**
 * `SESSION_SECRET` is the one hard requirement: without it there is no cookie
 * to sign, so accounts are off entirely and this returns `undefined`. The two
 * Google secrets are required as well UNLESS `AUTH_DEV_BYPASS` is set — local
 * dev signs in through `/auth/dev` and never talks to Google, and demanding a
 * real client id there would mean pasting production secrets into `.dev.vars`
 * to run the smoke. `/auth/google` refuses on its own when the client id is
 * empty, so the half-configured case cannot reach Google's endpoint.
 *
 * A half-configured sign-in fails to "off", never to "part-way on": a cookie
 * nobody can verify is worse than no cookie at all.
 */
export function authFromEnv(env: AuthEnv): AuthConfig | undefined {
  const sessionSecret = (env.SESSION_SECRET ?? "").trim();
  if (sessionSecret.length < 32) return undefined;
  const googleClientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
  const googleClientSecret = (env.GOOGLE_CLIENT_SECRET ?? "").trim();
  const devBypass = (env.AUTH_DEV_BYPASS ?? "").trim() !== "";
  if (!devBypass && (googleClientId === "" || googleClientSecret === "")) return undefined;
  return { sessionSecret, googleClientId, googleClientSecret, devBypass };
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

/* ── table name ───────────────────────────────────────────────────────────
 * Optional display name for a table (owner request 2026-09-04). schema.sql
 * matches.name: trimmed, control characters stripped, <= 40 chars, null for
 * none. Sanitised here rather than trusting `str()` alone — a pasted name can
 * carry control characters `str()`'s plain trim would let through.
 */
const MAX_TABLE_NAME = 40;

/** `undefined`/non-string/blank-after-cleanup all fold to `null` ("no name"),
 *  matching `str()`'s "empty means absent" convention elsewhere in this file.
 *  Length is checked by the caller so it can return `fail("bad_name", 400)`
 *  in the same style as `postRooms`'s `name`, rather than silently truncating. */
function cleanTableName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const stripped = v.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return stripped === "" ? null : stripped;
}

/* ── avatar ───────────────────────────────────────────────────────────────
 * Profile pictures (owner request 2026-09-03). schema.sql players.avatar: a
 * JPEG data URI, <= 12 KB, or null for the letter-avatar fallback. The client
 * (account.ts) does the crop/resize/quality-ladder work; this file only ever
 * checks the prefix and the decoded byte size — never decodes the image
 * itself, so a malformed JPEG body still round-trips as opaque bytes.
 */
const AVATAR_PREFIX = "data:image/jpeg;base64,";
const AVATAR_MAX_BYTES = 12 * 1024;

/**
 * `touched: false` means the request body had no `avatar` key at all — leave
 * the player's picture exactly as it is, same "absent means unchanged"
 * doctrine `displayName` already follows on this route. `touched: true` with
 * `value: null` is an explicit clear; `ok: false` is a malformed or
 * oversized picture, which the caller turns into `fail("bad_avatar", 400)`.
 */
function parseAvatarField(body: JsonObject): { touched: boolean; value: string | null; ok: boolean } {
  if (!("avatar" in body)) return { touched: false, value: null, ok: true };
  const v = body.avatar;
  if (v === null) return { touched: true, value: null, ok: true };
  if (typeof v !== "string" || !v.startsWith(AVATAR_PREFIX)) return { touched: true, value: null, ok: false };
  const b64 = v.slice(AVATAR_PREFIX.length);
  // Decoded byte count from the base64 length, padding-adjusted — no need to
  // actually decode: three bytes in every four base64 characters, minus one
  // byte per trailing '=' pad character.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { touched: true, value: null, ok: false };
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - pad;
  if (bytes <= 0 || bytes > AVATAR_MAX_BYTES) return { touched: true, value: null, ok: false };
  return { touched: true, value: v, ok: true };
}

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

/**
 * `normaliseCode`, except the Open Hall's literal sentinel (§11.2's
 * `OPEN_ROOM_CODE`) is checked FIRST, before the O→0 fold that would
 * otherwise corrupt it into `0PEN` — 'OPEN' is a name a client sends or a
 * URL segment (`/r/OPEN`, `/rooms/OPEN`), never a code someone typed off a
 * screen, so it is exempt from the look-alike folding that exists for typed
 * codes. Every room-code call site uses this, not `normaliseCode` directly;
 * `postJoin`'s join code is the one exception — a match's join code is never
 * the Open Hall and always wants the plain fold.
 */
function normaliseRoomCode(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return upper === OPEN_ROOM_CODE ? OPEN_ROOM_CODE : normaliseCode(raw);
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
    name: r.name,
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
    speed: r.speed,
    name: r.name,
  };
}

function seatView(r: MatchSeatRow) {
  return {
    seat: r.seat,
    playerId: r.player_id,
    displayName: r.display_name,
    avatar: r.avatar,
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

/* ── the Open Hall (PVP-LOBBY-PROPOSAL-2026-09-02.md §11 build decision 2,
 * §11.2) ─────────────────────────────────────────────────────────────────── */

/** A room code Crockford can never generate (`generateRoomCode` draws from
 *  `CROCKFORD`, which excludes 'O' entirely) — so no collision check is
 *  needed before this constant is used as a real `rooms.code`. */
export const OPEN_ROOM_CODE = "OPEN";
const OPEN_ROOM_NAME = "Open Hall";

/**
 * Lazily create the Open Hall — `INSERT OR IGNORE` on `rooms.code = 'OPEN'`,
 * so every caller can assume it exists without a migration seeding it up
 * front (schema.sql's "rooms" note). `settings = '{}'`: no `game` key at
 * all, which is what "no presets" means to every reader of
 * `roomGameSettingsOf` — `postTable` already treats a room with no `game`
 * key exactly like no room at all for ruleset/format/access/speed (falls
 * through to the request's own values, or the platform default), which is
 * precisely what the Open Hall wants. `adminCodeHash: null`: nobody
 * administers it — `verifyRoomAdmin` refuses outright when a room has no
 * admin code hash.
 */
async function ensureOpenRoom(p: Platform): Promise<void> {
  await insertRoom(p.db, {
    code: OPEN_ROOM_CODE,
    name: OPEN_ROOM_NAME,
    settings: "{}",
    adminCodeHash: null,
    now: p.now(),
  });
}

/** Every player is a member of the Open Hall (§11 build decision 2) — called
 *  from `POST /api/identity` for every sign-in, and defensively wherever a
 *  caller might reach the Open Hall before that (a room whose membership row
 *  predates this feature). Both writes are `OR IGNORE`, so this is cheap and
 *  idempotent on a repeat call. */
async function ensureOpenMembership(p: Platform, playerId: string, displayName: string): Promise<void> {
  await ensureOpenRoom(p);
  await insertRoomPlayer(p.db, { roomCode: OPEN_ROOM_CODE, playerId, name: displayName });
}

/* ── handlers ─────────────────────────────────────────────────────────────── */

/** §11 build decision 5: minutes east of UTC, `-720..840` (UTC-12..UTC+14) —
 *  the full range any real timezone offset can take, including the half-
 *  and quarter-hour zones. Out-of-range or non-integer is ignored rather
 *  than refused: a malformed value from a future client build must not
 *  break `POST /api/identity`/`POST /api/presence`, which do real work
 *  besides this. */
function parseTzOffsetMin(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  return v >= -720 && v <= 840 ? v : null;
}

/* ── accounts (ACCOUNTS-GAME-SIGNIN-2026-09-04.md §3) ─────────────────────── */

/** `^[a-z0-9_]{3,20}$` after lowercasing — §3's rule, verbatim. */
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

/** §3's reserved list. Short and closed on purpose: these are the words that
 *  would let a handle impersonate the site, the owner or a system surface. */
const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "admin",
  "mjrc",
  "augie",
  "sable",
  "open",
  "hall",
  "bot",
]);

type HandleVerdict = { available: true } | { available: false; reason: "taken" | "invalid" | "reserved" };

async function handleVerdict(p: Platform, raw: string): Promise<HandleVerdict> {
  const handle = raw.trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) return { available: false, reason: "invalid" };
  if (RESERVED_HANDLES.has(handle)) return { available: false, reason: "reserved" };
  if (await handleTaken(p.db, handle)) return { available: false, reason: "taken" };
  return { available: true };
}

/** Append a `Set-Cookie` to an already-built response. `new Response(body, res)`
 *  rather than mutating: a Response's headers are immutable once constructed. */
function withSetCookie(res: Response, cookie: string | null): Response {
  if (cookie === null) return res;
  const out = new Response(res.body, res);
  out.headers.append("set-cookie", cookie);
  return out;
}

/**
 * The one response shape three routes share — `GET /api/me`, `POST /api/signup`
 * and (in its `player`/`deviceToken` half) `POST /api/identity`. One function so
 * the client can parse all three with one type, which is the actual contract in
 * §3's table.
 */
function meView(user: UserRow, player: PlayerRow | null, deviceToken: string | null) {
  return {
    signedIn: true,
    user: {
      id: user.id,
      userNo: user.user_no,
      email: user.email,
      displayName: user.display_name,
      handle: user.handle,
      picture: user.picture,
      isAdmin: user.is_admin !== 0,
      onboarded: user.onboarded_at !== null,
      language: user.signup_lang,
    },
    player:
      player === null
        ? null
        : {
            playerId: player.id,
            displayName: player.display_name,
            avatar: player.avatar,
            rating: player.rating,
          },
    deviceToken,
  };
}

const SIGNED_OUT = { signedIn: false, user: null, player: null, deviceToken: null } as const;

/**
 * The signed-in user's game player: the linked one, else the player behind a
 * device token they are still carrying (adopted, history and rating intact),
 * else a new one.
 *
 * The middle case is the whole reason `deviceToken` appears in `POST
 * /api/signup`'s body: somebody who has been playing on this browser since
 * before accounts existed signs in and keeps their matches, instead of starting
 * over next to a duplicate of themselves. `linkPlayerToUser`'s
 * `almanac_user_id IS NULL` guard is what stops that from becoming a way to
 * steal somebody else's player with a copied token.
 */
async function playerForSession(
  p: Platform,
  user: UserRow,
  suppliedToken: string | null,
  displayName: string | null,
): Promise<{ player: PlayerRow; created: boolean }> {
  const linked = await playerForUser(p.db, user.id);
  if (linked !== null) return { player: linked, created: false };

  const now = p.now();

  if (suppliedToken !== null) {
    const cred = await credentialById(p.db, await sha256Hex(suppliedToken));
    if (cred !== null && cred.revoked_at === null) {
      const candidate = await playerById(p.db, cred.player_id);
      if (
        candidate !== null &&
        candidate.kind === "human" &&
        candidate.almanac_user_id === null &&
        (await linkPlayerToUser(p.db, candidate.id, user.id, "sign_in", now))
      ) {
        await ensureOpenMembership(p, candidate.id, candidate.display_name);
        return { player: { ...candidate, almanac_user_id: user.id }, created: false };
      }
    }
  }

  const name = (displayName ?? user.display_name).slice(0, MAX_DISPLAY_NAME);
  const playerId = randomId(p.random, ID_LENGTH);
  await insertPlayer(p.db, { id: playerId, kind: "human", displayName: name, avatar: null, now });
  await linkPlayerToUser(p.db, playerId, user.id, "sign_in", now);
  await ensureOpenMembership(p, playerId, name);
  const fresh = await playerById(p.db, playerId);
  if (fresh === null) throw new Error("player row vanished immediately after insert");
  return { player: fresh, created: true };
}

/**
 * Make sure this browser holds a device token that belongs to `player`, and
 * return it iff it had to be minted. The Bearer device token stays the
 * credential for every other `/api/*` route (§3's last row) — the session
 * cookie's job is to decide WHICH player the browser may hold a token for, not
 * to replace the token.
 */
async function bindDeviceToken(
  p: Platform,
  player: PlayerRow,
  suppliedToken: string | null,
  now: string,
): Promise<string | null> {
  if (suppliedToken !== null) {
    const id = await sha256Hex(suppliedToken);
    const cred = await credentialById(p.db, id);
    if (cred === null) {
      await insertCredential(p.db, { id, playerId: player.id, kind: "device", label: null, now });
      return null;
    }
    if (cred.player_id === player.id && cred.revoked_at === null) {
      await touchCredential(p.db, id, player.id, now);
      return null;
    }
    /* Somebody else's token, or a revoked one: mint a fresh one below rather
     * than reassigning a credential that is not this player's to take. */
  }
  const token = randomId(p.random, 32);
  await insertCredential(p.db, {
    id: await sha256Hex(token),
    playerId: player.id,
    kind: "device",
    label: null,
    now,
  });
  return token;
}

/** `GET /api/me`'s narrower rule (§3): mint only when the request carries no
 *  token that ALREADY belongs to this player. A GET never adopts an unbound
 *  token — that is `POST /api/identity`'s job, and only with a session. */
async function deviceTokenForBrowser(req: Request, p: Platform, player: PlayerRow): Promise<string | null> {
  const header = req.headers.get("authorization");
  const m = header === null ? null : /^Bearer (.+)$/.exec(header.trim());
  if (m !== null) {
    const token = m[1].trim();
    if (isPlausibleDeviceToken(token)) {
      const cred = await credentialById(p.db, await sha256Hex(token));
      if (cred !== null && cred.player_id === player.id && cred.revoked_at === null) return null;
    }
  }
  return bindDeviceToken(p, player, null, p.now());
}

/**
 * GET /api/me — the client's boot call. Answers three questions at once: is
 * there a session, has sign-up finished, and which player (and device token)
 * does this browser play as.
 */
async function getMe(req: Request, p: Platform, session: ResolvedSession | null): Promise<Response> {
  if (session === null) return json(SIGNED_OUT);
  const user = session.user;
  await touchUser(p.db, user.id, p.now());
  const player = await playerForUser(p.db, user.id);
  const deviceToken = player === null ? null : await deviceTokenForBrowser(req, p, player);
  return withSetCookie(json(meView(user, player, deviceToken)), session.refresh);
}

/** GET /api/handles/:handle — live availability for the sign-up screen. */
async function getHandleAvailability(raw: string, p: Platform): Promise<Response> {
  return json(await handleVerdict(p, raw));
}

const MAX_SIGNUP_SOURCE = 64;

/**
 * POST /api/signup — the one screen that turns a signed-in Google identity into
 * a playable account: handle, display name, language, consent, and the player
 * row.
 *
 * `onboardUser` is written BEFORE the player is touched on purpose. The handle
 * is the only thing here that can lose a race, and losing it after creating a
 * player would leave a player row belonging to an account that never finished
 * sign-up.
 */
async function postSignup(req: Request, p: Platform, session: ResolvedSession | null): Promise<Response> {
  if (session === null) return fail("sign_in_required", 401);
  const user = session.user;
  if (user.onboarded_at !== null) return fail("already_onboarded", 409);

  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);

  const displayName = str(body.displayName);
  if (displayName === null || displayName.length > MAX_DISPLAY_NAME) return fail("bad_display_name", 400);

  const handleRaw = str(body.handle);
  if (handleRaw === null) return fail("bad_handle", 400);
  const handle = handleRaw.toLowerCase();
  const verdict = await handleVerdict(p, handle);
  if (!verdict.available) {
    return fail(verdict.reason === "taken" ? "handle_taken" : `handle_${verdict.reason}`,
      verdict.reason === "taken" ? 409 : 400);
  }

  const language = body.language === "en" || body.language === "zh" ? body.language : null;
  if (language === null) return fail("bad_language", 400);

  const consents = body.consents;
  if (consents === null || typeof consents !== "object" || Array.isArray(consents)) {
    return fail("consent_required", 400);
  }
  const c = consents as JsonObject;
  if (c.terms !== true || c.privacy !== true) return fail("consent_required", 400);
  const marketing = c.marketing === true;

  const avatarField = parseAvatarField(body);
  if (!avatarField.ok) return fail("bad_avatar", 400);

  const suppliedToken = str(body.deviceToken);
  if (suppliedToken !== null && !isPlausibleDeviceToken(suppliedToken)) {
    return fail("weak_device_token", 400);
  }

  const source = str(body.source);
  const now = p.now();

  let onboarded: boolean;
  try {
    onboarded = await onboardUser(p.db, {
      userId: user.id,
      handle,
      displayName,
      signupLang: language,
      signupSource: source === null ? null : source.slice(0, MAX_SIGNUP_SOURCE),
      now,
    });
  } catch (e) {
    /* The UNIQUE index on users.handle is the real arbiter; the availability
     * check above is a courtesy, and this is the race it cannot close. */
    if (isUniqueViolation(e)) return fail("handle_taken", 409);
    throw e;
  }
  if (!onboarded) return fail("already_onboarded", 409);

  for (const [kind, granted] of [
    ["terms", true],
    ["privacy", true],
    ["marketing", marketing],
  ] as const) {
    await insertConsent(p.db, user.id, kind, granted, "signup", now);
  }

  const { player } = await playerForSession(p, user, suppliedToken, displayName);
  if (player.display_name !== displayName) await renamePlayer(p.db, player.id, displayName, now);
  if (avatarField.touched && avatarField.value !== player.avatar) {
    await updatePlayerAvatar(p.db, player.id, avatarField.value, now);
  }
  const deviceToken = await bindDeviceToken(p, player, suppliedToken, now);

  const fresh = (await userById(p.db, user.id)) ?? user;
  const view = meView(
    fresh,
    {
      ...player,
      display_name: displayName,
      avatar: avatarField.touched ? avatarField.value : player.avatar,
    },
    deviceToken,
  );
  return withSetCookie(json(view, 201), session.refresh);
}

/**
 * POST /api/account/delete — ACCOUNTS-BUILD-SPEC.md §9.3 scrub in place.
 *
 * Not a DELETE: three other people are in every match this player played, and
 * that history is not this player's to erase (worker/README.md, `players`).
 * What goes is the PII and the ability to sign back in — the handle is released
 * to `handle_history` so nobody can impersonate the departed account, the sub
 * is nulled so a future sign-in makes a FRESH account, and `session_epoch`
 * moves so every outstanding cookie stops verifying on the next request.
 */
async function postAccountDelete(
  req: Request,
  p: Platform,
  session: ResolvedSession | null,
): Promise<Response> {
  if (session === null) return fail("sign_in_required", 401);
  const user = session.user;
  const now = p.now();

  if (user.handle !== null) await releaseHandle(p.db, user.handle, user.id, now);
  await scrubUser(p.db, user.id, DELETED_EMAIL, DELETED_USER_NAME, now);

  const player = await playerForUser(p.db, user.id);
  if (player !== null) await scrubPlayer(p.db, player.id, DELETED_PLAYER_NAME, now);

  return new Response(null, {
    status: 204,
    headers: { ...BASE_HEADERS, "set-cookie": clearSessionCookie(req), "cache-control": "no-store" },
  });
}

/** §9.3's tombstones. Constants rather than inline literals so the scrub and
 *  any future audit of it agree on the exact strings. */
const DELETED_EMAIL = "deleted";
const DELETED_USER_NAME = "deleted user";
const DELETED_PLAYER_NAME = "deleted player";

/**
 * POST /api/identity — establish or re-present a device identity.
 *
 * Since 2026-09-04 this route is account-gated (ACCOUNTS-GAME-SIGNIN §3). Two
 * paths, and the difference between them is the whole point:
 *
 *  - **With a session:** resolve the user's linked player, creating or adopting
 *    one exactly as sign-up does, bind the supplied device token to it, and
 *    return the token when one had to be minted.
 *  - **Without a session:** allowed ONLY for a device token that already exists
 *    and whose player predates `ACCOUNTS_CUTOFF` — the headless smoke's demo
 *    tokens and the pre-accounts stand-ins. Everything else is 401
 *    `sign_in_required`, and no player is ever created.
 *
 * The owner's ruling behind it: "I don't want them to be able to use a random
 * name." A route that mints a player for any 32 random characters is exactly
 * that, so the anonymous mint is gone rather than merely discouraged.
 */
async function postIdentity(
  req: Request,
  p: Platform,
  session: ResolvedSession | null,
): Promise<Response> {
  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);

  /* Optional on a re-identify: a client booting with a stored token must not
   * rename the player from whatever its local copy of the name says (the
   * "logged in as somebody else" bug, 2026-09-03). */
  const displayName = str(body.displayName);
  if (displayName !== null && displayName.length > MAX_DISPLAY_NAME) {
    return fail("bad_display_name", 400);
  }

  const supplied = str(body.deviceToken);
  if (supplied !== null && !isPlausibleDeviceToken(supplied)) return fail("weak_device_token", 400);

  /* Same "absent means unchanged" rule `displayName` follows above — a
   * re-identify that never mentions `avatar` must not touch the picture. */
  const avatarField = parseAvatarField(body);
  if (!avatarField.ok) return fail("bad_avatar", 400);

  const tzOffsetMin = parseTzOffsetMin(body.tzOffsetMin);
  const now = p.now();

  if (session !== null) {
    const user = session.user;
    const { player, created } = await playerForSession(p, user, supplied, displayName);

    if (displayName !== null && player.display_name !== displayName) {
      await renamePlayer(p.db, player.id, displayName, now);
      /* §3, last paragraph: the account page's rename goes through this route
       * and must move the account's own name too, or the two disagree the
       * moment anyone looks at `/api/me`. */
      if (user.display_name !== displayName) {
        await updateUserDisplayName(p.db, user.id, displayName, now);
      }
    }
    if (avatarField.touched && avatarField.value !== player.avatar) {
      await updatePlayerAvatar(p.db, player.id, avatarField.value, now);
    }
    if (tzOffsetMin !== null) await updateTzOffset(p.db, player.id, tzOffsetMin);

    const name = displayName ?? player.display_name;
    const avatar = avatarField.touched ? avatarField.value : player.avatar;
    const minted = await bindDeviceToken(p, player, supplied, now);
    await ensureOpenMembership(p, player.id, name);
    return withSetCookie(
      json(
        {
          playerId: player.id,
          displayName: name,
          avatar,
          rating: player.rating,
          created,
          ...(minted === null ? {} : { deviceToken: minted }),
        },
        created ? 201 : 200,
      ),
      session.refresh,
    );
  }

  /* No session. The grandfather clause, and nothing else. */
  if (supplied === null) return fail("sign_in_required", 401);
  const credentialId = await sha256Hex(supplied);
  const existing = await playerForCredential(p.db, credentialId);
  if (existing === null || !isGrandfathered(existing.created_at)) return fail("sign_in_required", 401);

  await touchCredential(p.db, credentialId, existing.id, now);
  if (displayName !== null && existing.display_name !== displayName) {
    await renamePlayer(p.db, existing.id, displayName, now);
  }
  if (avatarField.touched && avatarField.value !== existing.avatar) {
    await updatePlayerAvatar(p.db, existing.id, avatarField.value, now);
  }
  const name = displayName ?? existing.display_name;
  const avatar = avatarField.touched ? avatarField.value : existing.avatar;
  if (tzOffsetMin !== null) await updateTzOffset(p.db, existing.id, tzOffsetMin);
  await ensureOpenMembership(p, existing.id, name);
  return json({ playerId: existing.id, displayName: name, avatar, rating: existing.rating, created: false });
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
/** `hands.delta_seat<N>` read by seat index, rather than four separate
 *  column reads at every call site — shared by progression folding here and
 *  by the stats datasets below (`deltaOf`). */
function handSeatDelta(h: { delta_seat0: number; delta_seat1: number; delta_seat2: number; delta_seat3: number }, seat: number): number {
  switch (seat) {
    case 0: return h.delta_seat0;
    case 1: return h.delta_seat1;
    case 2: return h.delta_seat2;
    default: return h.delta_seat3;
  }
}

/**
 * GET /api/matches/:id and GET /api/games/:id (§11.3: `/games/ID` is the
 * real URL path; `/api/matches/:id` keeps working as an alias — the same
 * detail, never two shapes). Adds `progression` (each seat's cumulative
 * chip total after every hand, folded from `hands.delta_seat<N>` — the
 * per-game view §10 asks for) and `grading`, the caller's own seat's move
 * grading pulled out of `seats[]` so a client does not have to search for
 * its own seat twice.
 */
async function getGameDetail(
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

  const progression: [number[], number[], number[], number[]] = [[], [], [], []];
  const cumulative: [number, number, number, number] = [0, 0, 0, 0];
  for (const h of hands) {
    for (let s = 0; s < 4; s += 1) {
      cumulative[s] += handSeatDelta(h, s);
      progression[s]!.push(cumulative[s]!);
    }
  }

  const seatViews = seats.map(seatView);
  const mine = seatViews.find((s) => s.seat === seat) ?? null;
  const grading = mine === null
    ? null
    : { movesGraded: mine.movesGraded, movesMatched: mine.movesMatched, gapSum: mine.gapSum, agreement: mine.agreement };

  return json({
    match: matchView(match),
    viewerSeat: seat,
    seats: seatViews,
    hands: hands.map(handView),
    progression,
    grading,
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
 * §8a-2's speed default: a room that has fixed one (`settings.game.speed`)
 * wins outright — same "the room owns it, the request does not" doctrine
 * `matchFormat`/`rulesetId` already follow for a room table, stricter than
 * `resolveAccess`'s "explicit request wins" because a speed is meant to be a
 * house rule, not a per-table pick, once a room sets one. Absent a room
 * default, an explicit `speed` in the request is honoured; absent that too,
 * "Beginners will really struggle with speed" (§8a-2): a plan with exactly
 * one human seat defaults to `untimed`, everything else to `normal`.
 */
function resolveSpeed(
  bodySpeed: unknown,
  roomDefault: Speed | undefined,
  seatPlan: readonly SeatSpec[],
): Speed {
  if (roomDefault !== undefined) return roomDefault;
  if (isSpeed(bodySpeed)) return bodySpeed;
  const humanSeats = seatPlan.filter((s) => s.kind === "human").length;
  return humanSeats === 1 ? "untimed" : "normal";
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

  /* §11.2: "tables created without roomCode go to OPEN" — the Open Hall is
   * the default room, not the absence of one, so an omitted `roomCode`
   * resolves to it rather than leaving `matches.room_code` null. */
  const normalizedRoomCode = normaliseRoomCode(str(body.roomCode) ?? OPEN_ROOM_CODE);
  if (normalizedRoomCode === OPEN_ROOM_CODE) await ensureOpenMembership(p, player.id, player.display_name);
  const room = await roomByCode(p.db, normalizedRoomCode);
  if (room === null) return fail("not_found", 404);
  if (!(await isRoomMember(p.db, room.code, player.id))) return fail("not_room_member", 403);
  /* The Open Hall has no `game` settings by construction (`ensureOpenRoom`'s
   * doc comment: "no presets") — every other room must be configured before
   * a table opens in it, same rule as before this change. */
  let roomGame: RoomGameSettings | null = null;
  if (room.code !== OPEN_ROOM_CODE) {
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

  const speed = resolveSpeed(body.speed, roomGame?.speed, seatPlan);

  const name = cleanTableName(body.name);
  if (name !== null && name.length > MAX_TABLE_NAME) return fail("bad_name", 400);

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
    roomCode: room.code,
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
    speed,
    name,
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
    speed,
    startedAt: now,
  });
  if (handoff === null) return fail("table_unavailable", 503);

  /* §8's "room" inbox kind: every OTHER member of a real (non-Open-Hall)
   * room the creator just opened a table in gets one notice. Skipped for
   * the Open Hall on purpose — everyone is a member of it, so this would
   * otherwise fire on every single table this build creates. Deterministic
   * id (schema.sql `inbox_items`' header comment): a retried request after
   * a flaky response writes the same rows, not a duplicate. */
  if (room.code !== OPEN_ROOM_CODE) {
    const memberIds = await roomPlayerIdsOf(p.db, room.code);
    for (const memberId of memberIds) {
      if (memberId === player.id) continue;
      await insertInboxItem(p.db, {
        id: `room:${matchId}:${memberId}`,
        playerId: memberId,
        kind: "room",
        matchId,
        roomCode: room.code,
        now,
      });
    }
  }

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
      roomCode: room.code,
      speed,
      name,
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

  const claimed = await claimFreeHumanSeat(p, match, player);
  if (claimed === "full") return fail("table_full", 409);
  if (claimed === "conflict") return fail("conflict", 409);

  const handoff = await openAndSeat(p, match.id, claimed, player, null);
  if (handoff === null) return fail("table_unavailable", 503);

  return json({
    tableId: handoff.tableId,
    matchUuid: match.id,
    seat: claimed,
    seatToken: handoff.seatToken,
    seatTokenExpiresAt: handoff.expiresAt,
    rulesetId: match.ruleset_id,
    matchFormat: match.match_format,
  });
}

/**
 * Claim `player`'s seat at `match`: their own seat if they already hold one
 * (the reconnect path, `postJoin`'s own doc comment), else the next free
 * human seat in the plan. Shared by `postJoin` (arrives by join code) and
 * `postInboxAccept` (an invite already names the match, no code needed) so
 * the seat-assignment retry loop exists in exactly one place.
 *
 * A bot seat may be at ANY seat index (§7.2 `seats`), not only the high
 * ones, so the free-seat search consults the plan seat by seat.  Bounded
 * retry rather than a lock: seat assignment reads then writes, and PRIMARY
 * KEY (match_id, seat) is the arbiter; one attempt per human seat is the
 * most contention this table can produce.
 */
async function claimFreeHumanSeat(
  p: Platform,
  match: MatchRow,
  player: PlayerRow,
): Promise<SeatIndex | "full" | "conflict"> {
  const already = await seatOf(p.db, match.id, player.id);
  if (already !== null) return already as SeatIndex;

  const humanSeats = seatPlanOf(match.seat_plan, match.bot_seats)
    .map((s, i) => ({ spec: s, seat: i as SeatIndex }))
    .filter((s) => s.spec.kind === "human")
    .map((s) => s.seat);

  for (let attempt = 0; attempt < humanSeats.length; attempt += 1) {
    const seats = await seatsOfMatch(p.db, match.id);
    /* A concurrent duplicate of this very request may have seated us between
     * the check above and now. UNIQUE (match_id, player_id) would refuse
     * every remaining attempt, so read our own seat back rather than
     * burning the retries and answering 409 to a player who is in fact
     * seated. */
    const own = seats.find((s) => s.player_id === player.id);
    if (own !== undefined) return own.seat as SeatIndex;
    const taken = new Set(seats.map((s) => s.seat));
    const free = humanSeats.find((s) => !taken.has(s));
    if (free === undefined) return "full";
    if (await claimSeat(p.db, match.id, free, player.id)) return free;
  }
  return "conflict";
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

/** Admin, decided by the account the player is linked to (`players.
 *  almanac_user_id` → `users.is_admin`). A player with no account, or whose
 *  account is deleted, is never an admin. */
async function isAdminPlayer(p: Platform, player: PlayerRow): Promise<boolean> {
  if (player.almanac_user_id === null) return false;
  const user = await userById(p.db, player.almanac_user_id);
  return user !== null && user.deleted_at === null && user.is_admin !== 0;
}

/**
 * GET /api/watch/:matchId — the admin observer (owner request 2026-09-03):
 * every seat's own view of a live table, for a host watching a playtest
 * from outside it. Admin only; anyone else gets the 404 a non-existent
 * match would, so the route's existence is not learnable by probing.
 * Read-only — the table object touches nothing on this call.
 */
async function getWatch(matchId: string, p: Platform, player: PlayerRow): Promise<Response> {
  if (!(await isAdminPlayer(p, player))) return fail("not_found", 404);
  const match = await matchById(p.db, matchId);
  if (match === null) return fail("not_found", 404);
  try {
    const view = await tableStubFor(p, matchId).observe();
    return json({
      matchId,
      rulesetId: match.ruleset_id,
      matchFormat: match.match_format,
      lobbyStatus: match.lobby_status,
      roomCode: match.room_code,
      ...view,
    });
  } catch (e) {
    console.error("table observe failed", matchId, e);
    return fail("table_unavailable", 503);
  }
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

/**
 * POST /api/tables/:matchId/invite — §8's "invite" inbox kind. Only a
 * participant may invite (the same `seatOf` authorisation primitive every
 * match-scoped route uses: not seated reads as 404, not a bare 403, exactly
 * `postLeave`'s doctrine), so a stranger cannot spam an invite for a table
 * they were never part of. A random id, not the deterministic
 * `kind:matchId:playerId` shape `room`/`result` items use — an invite is a
 * one-off human action, not a system write that might retry, so idempotency
 * does not matter here and a guessable id would (schema.sql `inbox_items`'
 * header comment).
 */
async function postTableInvite(matchId: string, req: Request, p: Platform, player: PlayerRow): Promise<Response> {
  const seat = await seatOf(p.db, matchId, player.id);
  if (seat === null) return fail("not_found", 404);

  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);
  const targetId = str(body.playerId);
  if (targetId === null) return fail("bad_player_id", 400);
  const target = await playerById(p.db, targetId);
  if (target === null) return fail("not_found", 404);

  const id = randomId(p.random, ID_LENGTH);
  await insertInboxItem(p.db, {
    id,
    playerId: targetId,
    kind: "invite",
    matchId,
    fromPlayerId: player.id,
    now: p.now(),
  });
  return json({ id }, 201);
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
      avatar: player.avatar,
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

/* ── stats: scope parsing (PVP-LOBBY-PROPOSAL-2026-09-02.md §10) ─────────────
 * One scope grammar off the query string, shared by every dataset below and
 * by the leaderboard — parsed once, here, so a bad `mode`/`style`/
 * `rulesetId`/`since`/`lastN`/`source` is refused identically everywhere.
 */

interface StatsScopeParsed {
  playerId: string;
  mode: string | null;
  rulesetId: string | null;
  roomCode: string | null;
  sinceIso: string | null;
  lastN: number | null;
  source: "all" | "online" | "offline";
  playersLeaderboard: boolean;
}

type ScopeParseResult = { ok: true; scope: StatsScopeParsed } | { ok: false; error: string };

function parseStatsScope(url: URL, callerId: string): ScopeParseResult {
  /* Unrecognised `mode` degrades to "no mode filter" rather than a 400 —
   * the same "unknown value degrades to the safe default" doctrine
   * `postTable`'s `matchFormat`/`access`/`speed` parsing already uses, and
   * what lets `GET /api/leaderboard?mode=<anything else>` fall back to its
   * own `ranked` default rather than erroring. */
  const modeParam = url.searchParams.get("mode");
  const modeRaw = modeParam === "ranked" || modeParam === "casual" ? modeParam : null;

  /* §10: "style (hk|tw; only hk exists — reject others with 400)" — every
   * ruleset this deployment ships is HK Old Style (TERMINOLOGY.md), so `hk`
   * (or absent) is the only value that can mean anything here. */
  const styleRaw = url.searchParams.get("style");
  if (styleRaw !== null && styleRaw !== "hk") return { ok: false, error: "unknown_style" };

  const rulesetIdRaw = url.searchParams.get("rulesetId");
  if (rulesetIdRaw !== null && ruleset(rulesetIdRaw) === undefined) return { ok: false, error: "unknown_ruleset" };

  const roomRaw = url.searchParams.get("room");
  const roomCode = roomRaw === null || roomRaw.trim() === "" ? null : normaliseRoomCode(roomRaw);

  const sinceRaw = url.searchParams.get("since");
  let sinceIso: string | null = null;
  if (sinceRaw !== null) {
    const t = Date.parse(sinceRaw);
    if (!Number.isFinite(t)) return { ok: false, error: "bad_since" };
    sinceIso = new Date(t).toISOString();
  }

  const lastNRaw = url.searchParams.get("lastN");
  let lastN: number | null = null;
  if (lastNRaw !== null) {
    const n = Number.parseInt(lastNRaw, 10);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "bad_lastN" };
    lastN = Math.min(n, STATS_SCOPE_LIMIT);
  }

  const sourceRaw = url.searchParams.get("source");
  const source = sourceRaw ?? "online";
  if (source !== "all" && source !== "online" && source !== "offline") return { ok: false, error: "bad_source" };

  const playerRaw = str(url.searchParams.get("player"));
  const playersRaw = url.searchParams.get("players");

  return {
    ok: true,
    scope: {
      playerId: playerRaw ?? callerId,
      mode: modeRaw,
      rulesetId: rulesetIdRaw,
      roomCode,
      sinceIso,
      lastN,
      source,
      playersLeaderboard: playersRaw === "leaderboard",
    },
  };
}

const dbScopeOf = (scope: StatsScopeParsed): StatsScope => ({
  mode: scope.mode,
  rulesetId: scope.rulesetId,
  roomCode: scope.roomCode,
  sinceIso: scope.sinceIso,
});

/** §10: "offline and all return online-only data plus sourceNote ... until
 *  the Almanac link exists" — every dataset route spreads this once, at the
 *  end of its response, rather than branching its own arithmetic on `source`. */
const sourceNoteOf = (scope: StatsScopeParsed): { sourceNote: string } | Record<string, never> =>
  scope.source === "online" ? {} : { sourceNote: "almanac_link_missing" };

/* ── stats: shared folds over a scoped match+hand set ────────────────────── */

async function loadScopedMatches(
  p: Platform,
  playerId: string,
  scope: StatsScopeParsed,
): Promise<{ matches: ScopedMatchRow[]; hands: ScopedHandRow[] }> {
  let matches = await matchesForPlayerScoped(p.db, playerId, dbScopeOf(scope));
  if (scope.lastN !== null) matches = matches.slice(0, scope.lastN);
  const hands = await handsForMatchIds(p.db, matches.map((m) => m.id));
  return { matches, hands };
}

function handsByMatch(hands: readonly ScopedHandRow[]): Map<string, ScopedHandRow[]> {
  const out = new Map<string, ScopedHandRow[]>();
  for (const h of hands) {
    const list = out.get(h.match_id);
    if (list === undefined) out.set(h.match_id, [h]);
    else list.push(h);
  }
  return out;
}

/** 14-bucket faan index, "13+ last" (§10 Dataset B): faan 0-12 at their own
 *  index, 13 and up all fall into index 13. */
const faanBucket = (faan: number): number => (faan >= 13 ? 13 : Math.max(0, Math.min(12, faan)));

/**
 * A match's own "worth" — this player's net chips per hand, priced in that
 * match's average winning-hand value (§10 Dataset A `worthPerHand`: "net per
 * hand priced in that game's average winning hand value, so rulesets
 * compare"). `null` when the match had no priceable win (every hand a draw,
 * or every win a zero/negative-value oddity), so callers average over games
 * that HAD a price rather than dividing by zero.
 */
function gameWorth(mh: readonly ScopedHandRow[], seat: number): number | null {
  if (mh.length === 0) return null;
  let net = 0;
  let winSum = 0;
  let winCount = 0;
  for (const h of mh) {
    net += handSeatDelta(h, seat);
    if (h.outcome === "win" && h.winner_seat !== null) {
      const winnerDelta = handSeatDelta(h, h.winner_seat);
      if (winnerDelta > 0) {
        winSum += winnerDelta;
        winCount += 1;
      }
    }
  }
  if (winCount === 0) return null;
  const avgWinningHandValue = winSum / winCount;
  return avgWinningHandValue > 0 ? net / mh.length / avgWinningHandValue : null;
}

/** Calendar days (in `tzOffsetMin`'s local time) with at least one match, as
 *  epoch-day integers so "consecutive" is `+1` — shared by `streakDays`/
 *  `bestStreak` and `buildActivity`. */
function localDaysOf(matches: readonly ScopedMatchRow[], tzOffsetMin: number): Set<number> {
  const dayMs = 86_400_000;
  const days = new Set<number>();
  for (const m of matches) {
    const at = m.ended_at ?? m.started_at;
    days.add(Math.floor((Date.parse(at) + tzOffsetMin * 60_000) / dayMs));
  }
  return days;
}

function computeStreaks(
  matches: readonly ScopedMatchRow[],
  tzOffsetMin: number,
  nowIso: string,
): { streakDays: number; bestStreak: number } {
  const days = localDaysOf(matches, tzOffsetMin);
  const sorted = [...days].sort((a, b) => a - b);

  let bestStreak = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of sorted) {
    run = prev !== null && d === prev + 1 ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    prev = d;
  }

  const dayMs = 86_400_000;
  const today = Math.floor((Date.parse(nowIso) + tzOffsetMin * 60_000) / dayMs);
  let streakDays = 0;
  /* "Alive" only if the most recent active day is today or yesterday — a
   * streak with no game in the last two days is broken, not paused. */
  let cursor = days.has(today) ? today : today - 1;
  while (days.has(cursor)) {
    streakDays += 1;
    cursor -= 1;
  }
  return { streakDays, bestStreak };
}

/** Densified day-by-day activity, every day present from the scope's
 *  `since` (or the earliest match in scope, or today) through today, in the
 *  player's own calendar. Capped so a scope with no matches and no `since`
 *  cannot walk an unbounded range. */
const ACTIVITY_MAX_DAYS = 366;

function buildActivity(
  matches: readonly ScopedMatchRow[],
  tzOffsetMin: number,
  sinceIso: string | null,
  nowIso: string,
): { day: string; games: number }[] {
  const dayKey = (iso: string): string =>
    new Date(Date.parse(iso) + tzOffsetMin * 60_000).toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  for (const m of matches) {
    const key = dayKey(m.ended_at ?? m.started_at);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const today = dayKey(nowIso);
  const startKey =
    sinceIso !== null ? dayKey(sinceIso) : counts.size > 0 ? [...counts.keys()].sort()[0]! : today;

  const out: { day: string; games: number }[] = [];
  let cursor = new Date(`${startKey}T00:00:00.000Z`);
  const end = new Date(`${today}T00:00:00.000Z`);
  for (let i = 0; cursor.getTime() <= end.getTime() && i < ACTIVITY_MAX_DAYS; i += 1) {
    const key = cursor.toISOString().slice(0, 10);
    out.push({ day: key, games: counts.get(key) ?? 0 });
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return out;
}

/* ── stats: Dataset A — record (§10) ─────────────────────────────────────── */

interface RecordRow {
  playerId: string;
  displayName: string;
  avatar: string | null;
  games: number;
  hands: number;
  wins: number;
  winPct: number | null;
  ins: number;
  inPct: number | null;
  handsW: number;
  handsL: number;
  ptsW: number;
  ptsL: number;
  netPerHand: number | null;
  worthPerHand: number | null;
  selfDraws: number;
  avgWinFan: number | null;
  placements: [number, number, number, number];
  rating: number | null;
  ratingGames: number;
  provisional: boolean;
  streakDays: number;
  bestStreak: number;
  movesGraded: number;
  agreement: number | null;
}

/** Dataset A for one player — the shared computation behind `GET
 *  /api/stats/record`, `GET /api/leaderboard`, and `players=leaderboard` on
 *  the former. `null` only when `playerId` does not resolve at all (a typo,
 *  a soft-deleted player); a player with zero matches in scope still gets a
 *  row of zeros/nulls, same "`?? 0` at read time" doctrine `getStatsFor`
 *  already uses for `statsTotalsForPlayer`. */
async function computeRecordRow(p: Platform, playerId: string, scope: StatsScopeParsed): Promise<RecordRow | null> {
  const player = await playerById(p.db, playerId);
  if (player === null) return null;

  const { matches, hands } = await loadScopedMatches(p, playerId, scope);
  const byMatch = handsByMatch(hands);

  let handsTotal = 0;
  let handsWithWinner = 0;
  let wins = 0;
  let ins = 0;
  let selfDraws = 0;
  let netChips = 0;
  let ptsW = 0;
  let ptsL = 0;
  let worthSum = 0;
  let worthCount = 0;
  let winFaanSum = 0;
  let winFaanCount = 0;
  const placements: [number, number, number, number] = [0, 0, 0, 0];
  let movesGraded = 0;
  let movesMatched = 0;

  for (const m of matches) {
    const mh = byMatch.get(m.id) ?? [];
    handsTotal += mh.length;
    wins += m.hands_won;
    ins += m.deal_ins;
    selfDraws += m.self_draws;
    movesGraded += m.moves_graded;
    movesMatched += m.moves_matched;
    if (m.place !== null) placements[(m.place - 1) as 0 | 1 | 2 | 3] += 1;

    for (const h of mh) {
      const delta = handSeatDelta(h, m.seat);
      netChips += delta;
      if (delta > 0) ptsW += delta;
      else if (delta < 0) ptsL += -delta;
      if (h.outcome === "win") {
        handsWithWinner += 1;
        if (h.winner_seat === m.seat) {
          winFaanSum += h.faan;
          winFaanCount += 1;
        }
      }
    }

    const worth = gameWorth(mh, m.seat);
    if (worth !== null) {
      worthSum += worth;
      worthCount += 1;
    }
  }

  const { streakDays, bestStreak } = computeStreaks(matches, player.tz_offset_min, p.now());

  return {
    playerId: player.id,
    displayName: player.display_name,
    avatar: player.avatar,
    games: matches.length,
    hands: handsTotal,
    wins,
    winPct: handsTotal > 0 ? wins / handsTotal : null,
    ins,
    inPct: handsTotal > 0 ? ins / handsTotal : null,
    handsW: wins,
    handsL: handsWithWinner - wins,
    ptsW,
    ptsL,
    netPerHand: handsTotal > 0 ? netChips / handsTotal : null,
    worthPerHand: worthCount > 0 ? worthSum / worthCount : null,
    selfDraws,
    avgWinFan: winFaanCount > 0 ? winFaanSum / winFaanCount : null,
    placements,
    rating: player.rating,
    ratingGames: player.rating_games,
    provisional: isProvisional(player.rating_games),
    streakDays,
    bestStreak,
    movesGraded,
    agreement: agreementOf(movesGraded, movesMatched),
  };
}

/** GET /api/stats/record?scope — Dataset A. One row for the scope's own
 *  player unless `players=leaderboard`, which reuses the exact leaderboard
 *  candidate set and sort (§10: "the caller alone unless players=leaderboard"). */
async function getStatsRecord(url: URL, p: Platform, caller: PlayerRow): Promise<Response> {
  const parsed = parseStatsScope(url, caller.id);
  if (!parsed.ok) return fail(parsed.error, 400);
  const scope = parsed.scope;

  if (scope.playersLeaderboard) {
    const rows = await recordRowsForLeaderboard(p, scope);
    return json({ players: rows, ...sourceNoteOf(scope) });
  }

  const row = await computeRecordRow(p, scope.playerId, scope);
  if (row === null) return fail("not_found", 404);
  return json({ players: [row], ...sourceNoteOf(scope) });
}

/** GET /api/stats/histograms?scope — Dataset B. `fan`/`fanByGame`/
 *  `handType`/`seatByRound` are the CALLER's own winning hands within the
 *  scope (`avgWinFan`'s sibling in Dataset A); `outcomes` is every hand in
 *  scope regardless of who won; `ins`/`feeds` are per-opponent and need
 *  every OTHER seat's identity, hence `matchPlayersForMatchIds`. */
async function getStatsHistograms(url: URL, p: Platform, caller: PlayerRow): Promise<Response> {
  const parsed = parseStatsScope(url, caller.id);
  if (!parsed.ok) return fail(parsed.error, 400);
  const scope = parsed.scope;

  if ((await playerById(p.db, scope.playerId)) === null) return fail("not_found", 404);

  const { matches, hands } = await loadScopedMatches(p, scope.playerId, scope);
  const matchIds = matches.map((m) => m.id);
  const seats = await matchPlayersForMatchIds(p.db, matchIds);

  const seatsByMatch = new Map<string, Map<number, ScopedSeatRow>>();
  const nameOf = new Map<string, string>();
  for (const s of seats) {
    let m = seatsByMatch.get(s.match_id);
    if (m === undefined) {
      m = new Map();
      seatsByMatch.set(s.match_id, m);
    }
    m.set(s.seat, s);
    nameOf.set(s.player_id, s.display_name);
  }
  const byMatch = handsByMatch(hands);

  const fanByRuleset: Record<string, number[]> = {};
  const fanByGame: number[][] = [];
  const handTypeAgg = new Map<string, { count: number; faanSum: number; pointsSum: number }>();
  const seatByRound: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  let outWin = 0;
  let outSelfDraw = 0;
  let outDraw = 0;
  const insAgg = new Map<string, { ins: number; hands: number }>();
  const feedsFrom = new Map<string, { points: number; hands: number }>();
  const feedsTo = new Map<string, { points: number; hands: number }>();

  for (const m of matches) {
    const mySeat = m.seat;
    const mh = byMatch.get(m.id) ?? [];
    const seatMap = seatsByMatch.get(m.id) ?? new Map<number, ScopedSeatRow>();
    const gameFanRow = new Array(14).fill(0) as number[];

    for (const [seatIdx, seatRow] of seatMap) {
      if (seatIdx === mySeat) continue;
      const agg = insAgg.get(seatRow.player_id) ?? { ins: 0, hands: 0 };
      agg.hands += mh.length;
      insAgg.set(seatRow.player_id, agg);
    }

    for (const h of mh) {
      if (h.outcome !== "win") {
        outDraw += 1;
        continue;
      }
      outWin += 1;
      if (h.self_draw) outSelfDraw += 1;
      const winnerSeat = h.winner_seat;
      if (winnerSeat === null) continue;
      const winnerId = seatMap.get(winnerSeat)?.player_id;

      if (winnerSeat === mySeat) {
        const bucket = faanBucket(h.faan);
        gameFanRow[bucket] += 1;
        const arr = fanByRuleset[m.ruleset_id] ?? (new Array(14).fill(0) as number[]);
        arr[bucket] += 1;
        fanByRuleset[m.ruleset_id] = arr;
        seatByRound[mySeat]![h.round_wind] += 1;
        for (const award of parseAwards(h.awards)) {
          const agg = handTypeAgg.get(award.id) ?? { count: 0, faanSum: 0, pointsSum: 0 };
          agg.count += 1;
          agg.faanSum += award.faan;
          agg.pointsSum += handSeatDelta(h, mySeat);
          handTypeAgg.set(award.id, agg);
        }
      }

      if (h.self_draw || h.win_from_seat === null) continue;
      const fromSeat = h.win_from_seat;
      const fromId = seatMap.get(fromSeat)?.player_id;
      const points = handSeatDelta(h, winnerSeat);
      if (winnerSeat === mySeat && fromId !== undefined) {
        const agg = feedsFrom.get(fromId) ?? { points: 0, hands: 0 };
        agg.points += points;
        agg.hands += 1;
        feedsFrom.set(fromId, agg);
      }
      if (fromSeat === mySeat && winnerId !== undefined) {
        const agg = feedsTo.get(winnerId) ?? { points: 0, hands: 0 };
        agg.points += points;
        agg.hands += 1;
        feedsTo.set(winnerId, agg);
        const insA = insAgg.get(winnerId) ?? { ins: 0, hands: 0 };
        insA.ins += 1;
        insAgg.set(winnerId, insA);
      }
    }
    fanByGame.push(gameFanRow);
  }

  return json({
    fan: { byRuleset: fanByRuleset },
    fanByGame,
    handType: [...handTypeAgg.entries()].map(([id, v]) => ({
      id,
      count: v.count,
      avgFan: Math.round((v.faanSum / v.count) * 10) / 10,
      points: v.pointsSum,
    })),
    seatByRound,
    outcomes: { win: outWin, selfDraw: outSelfDraw, draw: outDraw },
    ins: [...insAgg.entries()].map(([playerId, v]) => ({
      playerId, displayName: nameOf.get(playerId) ?? "", ins: v.ins, hands: v.hands,
    })),
    feeds: {
      from: [...feedsFrom.entries()].map(([playerId, v]) => ({
        playerId, displayName: nameOf.get(playerId) ?? "", points: v.points, hands: v.hands,
      })),
      to: [...feedsTo.entries()].map(([playerId, v]) => ({
        playerId, displayName: nameOf.get(playerId) ?? "", points: v.points, hands: v.hands,
      })),
    },
    ...sourceNoteOf(scope),
  });
}

/** GET /api/stats/series?scope — Dataset C. */
async function getStatsSeries(url: URL, p: Platform, caller: PlayerRow): Promise<Response> {
  const parsed = parseStatsScope(url, caller.id);
  if (!parsed.ok) return fail(parsed.error, 400);
  const scope = parsed.scope;

  const target = await playerById(p.db, scope.playerId);
  if (target === null) return fail("not_found", 404);

  const { matches, hands } = await loadScopedMatches(p, scope.playerId, scope);
  const byMatch = handsByMatch(hands);
  const chronological = [...matches].sort((a, b) => a.started_at.localeCompare(b.started_at));

  const games: number[][] = [];
  const worthByGame: { matchId: string; at: string; worth: number }[] = [];
  for (const m of chronological) {
    const mh = (byMatch.get(m.id) ?? []).slice().sort((a, b) => a.hand_index - b.hand_index);
    let cum = 0;
    const arr: number[] = [];
    for (const h of mh) {
      cum += handSeatDelta(h, m.seat);
      arr.push(cum);
    }
    games.push(arr);
    const worth = gameWorth(mh, m.seat);
    if (worth !== null) worthByGame.push({ matchId: m.id, at: m.ended_at ?? m.started_at, worth });
  }

  const maxLen = games.reduce((mx, g) => Math.max(mx, g.length), 0);
  const handsAxis = Array.from({ length: maxLen }, (_, i) => i);
  const mean: number[] = [];
  for (let i = 0; i < maxLen; i += 1) {
    const vals = games.filter((g) => g.length > i).map((g) => g[i]!);
    mean.push(vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
  }

  const ratingHistory = await ratingHistoryForPlayer(p.db, scope.playerId, RATING_HISTORY_LIMIT);
  const activity = buildActivity(matches, target.tz_offset_min, scope.sinceIso, p.now());

  return json({
    progressionAvg: { hands: handsAxis, mean, games },
    worthByGame,
    rating: ratingHistory.map((h: RatingHistoryPointRow) => ({
      at: h.at, before: h.before, after: h.after, matchId: h.match_id,
    })),
    activity,
    ...sourceNoteOf(scope),
  });
}

/* ── leaderboard (§10, superseding the pre-standard ranked/casual split) ─── */

/** Candidate players for the scope (≥5 games, `SQL.leaderboardCandidates`'
 *  `HAVING`), folded into full Dataset A rows and sorted — rating for
 *  `mode=ranked`, `worthPerHand` for anything else (§10: "sorted by rating
 *  (ranked) or worthPerHand (otherwise)"). Shared by `GET /api/leaderboard`
 *  and `GET /api/stats/record?players=leaderboard`, the same read by two
 *  names. */
async function recordRowsForLeaderboard(p: Platform, scope: StatsScopeParsed): Promise<RecordRow[]> {
  const candidates = await leaderboardCandidates(p.db, dbScopeOf(scope));
  const rows: RecordRow[] = [];
  for (const c of candidates) {
    const row = await computeRecordRow(p, c.player_id, scope);
    if (row !== null) rows.push(row);
  }
  const byRating = scope.mode !== "casual";
  rows.sort((a, b) =>
    byRating
      ? (b.rating ?? Number.NEGATIVE_INFINITY) - (a.rating ?? Number.NEGATIVE_INFINITY)
      : (b.worthPerHand ?? Number.NEGATIVE_INFINITY) - (a.worthPerHand ?? Number.NEGATIVE_INFINITY),
  );
  return rows.slice(0, LEADERBOARD_LIMIT);
}

/** GET /api/leaderboard?mode=ranked|casual[&rulesetId=&room=&since=] —
 *  Dataset A rows for the scope (§10: "the existing /api/leaderboard as a
 *  view over A"). Unknown/absent `mode` degrades to `ranked`, same "unknown
 *  value degrades to the safe default" doctrine `postTable`'s
 *  `matchFormat`/`access` parsing uses. */
async function getLeaderboard(url: URL, p: Platform, caller: PlayerRow): Promise<Response> {
  const parsed = parseStatsScope(url, caller.id);
  if (!parsed.ok) return fail(parsed.error, 400);
  const mode = url.searchParams.get("mode") === "casual" ? "casual" : "ranked";
  const scope: StatsScopeParsed = { ...parsed.scope, mode, playersLeaderboard: true };
  const rows = await recordRowsForLeaderboard(p, scope);
  return json({ mode, entries: rows });
}

/* ── friends (§11 build decision 1) ──────────────────────────────────────── */

/** Global "who is here" — the same fold `GET /api/lobby`'s own `here` panel
 *  performs, duplicated here (rather than refactored out of `getLobby`) so
 *  this addition cannot disturb that route's existing behaviour or tests.
 *  A friend absent from this map is offline. */
async function buildGlobalHere(p: Platform): Promise<Map<string, HereEntry>> {
  const now = p.now();
  const sinceIso = new Date(Date.parse(now) - HERE_WINDOW_MS).toISOString();
  const [presenceRows, openRows] = await Promise.all([
    presenceSince(p.db, sinceIso),
    matchesWaitingOrPlaying(p.db, LOBBY_TABLE_LIMIT),
  ]);
  const here = new Map<string, HereEntry>();
  for (const row of presenceRows) {
    here.set(row.player_id, { playerId: row.player_id, displayName: row.display_name, avatar: row.avatar, state: "lobby" });
  }
  for (const m of openRows) await tableViewOf(p, m, here);
  return here;
}

/* ── players + friends: ONE code path (players-lab.html round 3) ──────────
 * `GET /api/players` and `GET /api/friends` are two views of the same rows.
 * Friends is the older, narrower name for "the people you have played with",
 * and its response shape is frozen (home.ts still reads it), so it stays —
 * but as a PROJECTION of the rows below, never as a second derivation of
 * presence. A change to how "waiting at a table" is read now moves both.
 */

/** The list answers at most this many rows, however wide the scan behind it
 *  (`PLAYERS_SCAN_LIMIT`, db.ts). */
const PLAYERS_PAGE_LIMIT = 200;

/** The Players list's own presence vocabulary — the lab's four words, which
 *  are NOT the four `presence.state` values: "lobby" reads as *online*, and
 *  "waiting" reads as *queue*. */
type PlayerListState = "online" | "queue" | "playing" | "offline";

interface PlayerStatusView {
  state: PlayerListState;
  /** playing: 0-based hand index and the match length, exactly as `here`
   *  carries them — the client renders `hand + 1`. */
  hand?: number;
  handsBase?: number;
  /** queue: seats taken at that table, e.g. `"2/4"`. */
  queue?: string;
  /** The room's NAME (not its code) when the table belongs to a room. */
  room?: string;
  /** offline only: `players.last_seen_at`. */
  lastSeenAt?: string;
}

interface PlayerRecordTotals {
  games: number;
  winPct: number | null;
  worthPerHand: number | null;
}

const EMPTY_RECORD: PlayerRecordTotals = { games: 0, winPct: null, worthPerHand: null };

/** One directory row with everything both views need, read once. */
interface PlayerListRow {
  player: PlayerDirectoryRow;
  presence: HereEntry | undefined;
  starred: boolean;
  /** Completed matches this player and the caller both sat at; 0 = never. */
  gamesTogether: number;
  record: PlayerRecordTotals;
}

/** A single match's "worth" for one seat, from the SQL aggregate — the same
 *  arithmetic `gameWorth` performs over the raw hand rows, so the list and
 *  Dataset A cannot disagree. */
function matchWorthOf(r: PlayerMatchTotalRow): number | null {
  if (r.hands === 0) return null;
  const winCount = r.win_value_count ?? 0;
  if (winCount === 0) return null;
  const avgWinningHandValue = (r.win_value_sum ?? 0) / winCount;
  if (avgWinningHandValue <= 0) return null;
  return (r.net ?? 0) / r.hands / avgWinningHandValue;
}

/** Fold `playerMatchTotals`' per-(player, match) rows into per-player
 *  `games`/`winPct`/`worthPerHand`. `worthPerHand` averages over the games
 *  that HAD a priceable win, same as `computeRecordRow`. */
function foldRecordTotals(rows: readonly PlayerMatchTotalRow[]): Map<string, PlayerRecordTotals> {
  const acc = new Map<string, { games: number; hands: number; wins: number; worthSum: number; worthCount: number }>();
  for (const r of rows) {
    let a = acc.get(r.player_id);
    if (a === undefined) {
      a = { games: 0, hands: 0, wins: 0, worthSum: 0, worthCount: 0 };
      acc.set(r.player_id, a);
    }
    a.games += 1;
    a.hands += r.hands;
    a.wins += r.hands_won;
    const worth = matchWorthOf(r);
    if (worth !== null) {
      a.worthSum += worth;
      a.worthCount += 1;
    }
  }
  const out = new Map<string, PlayerRecordTotals>();
  for (const [id, a] of acc) {
    out.set(id, {
      games: a.games,
      winPct: a.hands > 0 ? a.wins / a.hands : null,
      worthPerHand: a.worthCount > 0 ? a.worthSum / a.worthCount : null,
    });
  }
  return out;
}

/**
 * The shared read. `withRecord` is the one knob: `GET /api/friends` never
 * shows a win% or a worth/hand, so it skips the one query in here that scans
 * every completed match — the presence/star/played-with derivation, which is
 * where the two views could actually drift, is shared unconditionally.
 */
async function buildPlayerListRows(
  p: Platform,
  caller: PlayerRow,
  withRecord: boolean,
): Promise<PlayerListRow[]> {
  const [directory, friendRows, stars, here, totals] = await Promise.all([
    playersDirectory(p.db),
    friendsOfPlayer(p.db, caller.id),
    friendStarsOfPlayer(p.db, caller.id),
    buildGlobalHere(p),
    withRecord ? playerMatchTotals(p.db) : Promise.resolve([] as PlayerMatchTotalRow[]),
  ]);

  const together = new Map<string, number>();
  for (const r of friendRows as FriendRow[]) together.set(r.friend_id, r.games);
  const records = foldRecordTotals(totals);

  return directory.map((player) => ({
    player,
    presence: here.get(player.id),
    starred: stars.has(player.id),
    gamesTogether: together.get(player.id) ?? 0,
    record: records.get(player.id) ?? EMPTY_RECORD,
  }));
}

/** "A friend" (both views): somebody you have finished a match with, or
 *  somebody you starred. Never yourself. */
const isFriendRow = (r: PlayerListRow, callerId: string): boolean =>
  r.player.id !== callerId && (r.gamesTogether > 0 || r.starred);

/** `here` carries a room CODE; the list shows the room's name. Read once per
 *  distinct code on the page (bounded by the open-table count, not by the
 *  player count). */
async function roomNamesFor(p: Platform, rows: readonly PlayerListRow[]): Promise<Map<string, string>> {
  const codes = new Set<string>();
  for (const r of rows) if (r.presence?.roomCode !== undefined) codes.add(r.presence.roomCode);
  const out = new Map<string, string>();
  await Promise.all([...codes].map(async (code) => {
    const room = await roomByCode(p.db, code);
    if (room !== null) out.set(code, room.name);
  }));
  return out;
}

function statusViewOf(r: PlayerListRow, roomNames: Map<string, string>): PlayerStatusView {
  const pr = r.presence;
  if (pr === undefined) return { state: "offline", lastSeenAt: r.player.last_seen_at };
  if (pr.state === "lobby") return { state: "online" };
  const name = pr.roomCode === undefined ? undefined : roomNames.get(pr.roomCode);
  const room = name === undefined ? {} : { room: name };
  if (pr.state === "waiting") return { state: "queue", queue: `${pr.seatsFilled ?? 0}/4`, ...room };
  return { state: "playing", hand: pr.hand, handsBase: pr.handsBase, ...room };
}

const playerSummaryOf = (r: PlayerListRow, format: RankFormat, roomNames: Map<string, string>) => {
  /* Four rank slots, one per format the site knows about, so the client's
   * tiles row never has to guess which ones exist:
   *   hk        = players.rating, this deployment's only rated ladder
   *   tw        = Taiwanese online play does not exist here at all
   *   offlineHk = the Almanac's offline estimate — it lives on the site
   *   offlineTw = ditto (LAMJ's paper archive), and neither is wired yet
   * The three nulls are placeholders on purpose: the shape is final, the
   * data source is not. */
  const ranks = {
    hk: r.player.rating,
    tw: null,
    offlineHk: null,
    offlineTw: null,
  } as const;
  return {
    id: r.player.id,
    displayName: r.player.display_name,
    handle: r.player.handle,
    avatar: r.player.avatar,
    linked: r.player.almanac_user_id !== null,
    /* `SQL.playersDirectory` selects `kind = 'human'` — a bot is never a row
     * here. The field is constant so the client can render one row shape. */
    bot: false as const,
    status: statusViewOf(r, roomNames),
    rank: rankOf(ranks, format),
    ranks,
    games: r.record.games,
    winPct: r.record.winPct,
    worthPerHand: r.record.worthPerHand,
    starred: r.starred,
  };
};

type RankFormat = "hk" | "tw" | "offline";
type RankSet = { hk: number | null; tw: null; offlineHk: null; offlineTw: null };

/** The phone sheet and the desktop chip row both offer three rank formats;
 *  `offline` reads the offline HK ladder (the offline TW one is only ever
 *  shown in the player page's tiles row, which sends every slot at once). */
const rankOf = (ranks: RankSet, format: RankFormat): number | null =>
  format === "tw" ? ranks.tw : format === "offline" ? ranks.offlineHk : ranks.hk;

const oneOf = <T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;

/**
 * GET /api/players — the Players list (players-lab.html round 3).
 *
 *   scope=all|friends|online   who is in the list          (default all)
 *   format=hk|tw|offline       which ladder `rank` reads   (default hk)
 *   games=all|online|offline   which games the record counts (default all)
 *   sort=recent|rank|games|worth                            (default recent)
 *   q=<text>                   substring of name or handle
 *
 * An unknown value for any of the four degrades to that field's default
 * rather than 400ing — the same doctrine `postTable`'s `access`/`speed`
 * parsing and `parseStatsScope`'s `mode` already use.
 */
async function getPlayers(url: URL, p: Platform, caller: PlayerRow): Promise<Response> {
  const scope = oneOf(url.searchParams.get("scope"), ["all", "friends", "online"] as const, "all");
  const format = oneOf(url.searchParams.get("format"), ["hk", "tw", "offline"] as const, "hk");
  const games = oneOf(url.searchParams.get("games"), ["all", "online", "offline"] as const, "all");
  const sort = oneOf(url.searchParams.get("sort"), ["recent", "rank", "games", "worth"] as const, "recent");
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();

  /* `games=offline` means "count only the games played away from the app,
   * through the Almanac". That join does not exist yet — no match row carries
   * an Almanac origin — so the honest answer is a record of zero, not the
   * online record relabelled. `online` and `all` are the same set today,
   * because every match in this database was played online. */
  const rows = await buildPlayerListRows(p, caller, games !== "offline");

  let list = rows;
  if (scope === "friends") list = list.filter((r) => isFriendRow(r, caller.id));
  else if (scope === "online") list = list.filter((r) => r.presence !== undefined);
  if (q !== "") {
    list = list.filter((r) =>
      r.player.display_name.toLowerCase().includes(q) ||
      (r.player.handle ?? "").toLowerCase().includes(q));
  }

  const rankValue = (r: PlayerListRow): number | null =>
    rankOf({ hk: r.player.rating, tw: null, offlineHk: null, offlineTw: null }, format);
  const nullsLast = (v: number | null): number => (v === null ? Number.NEGATIVE_INFINITY : v);

  const sorted = [...list].sort((a, b) => {
    if (sort === "rank") return nullsLast(rankValue(b)) - nullsLast(rankValue(a));
    if (sort === "games") return b.record.games - a.record.games;
    if (sort === "worth") return nullsLast(b.record.worthPerHand) - nullsLast(a.record.worthPerHand);
    /* recent: anybody present right now outranks every last_seen_at. */
    const aOn = a.presence === undefined ? 0 : 1;
    const bOn = b.presence === undefined ? 0 : 1;
    if (aOn !== bOn) return bOn - aOn;
    return b.player.last_seen_at.localeCompare(a.player.last_seen_at);
  }).slice(0, PLAYERS_PAGE_LIMIT);

  const roomNames = await roomNamesFor(p, sorted);
  return json({ players: sorted.map((r) => playerSummaryOf(r, format, roomNames)) });
}

/** GET /api/friends — the older, narrower view of the same rows: everyone the
 *  caller has finished a match with (or starred), online first, then starred,
 *  then most games together. `lastSeen` is "now" for anyone currently in
 *  `here`, else `players.last_seen_at`. Response shape frozen — home.ts reads
 *  it — so this projects `PlayerListRow` rather than deriving anything of its
 *  own. */
async function getFriends(p: Platform, player: PlayerRow): Promise<Response> {
  const rows = await buildPlayerListRows(p, player, false);
  const friends = rows
    .filter((r) => isFriendRow(r, player.id))
    .map((r) => ({
      playerId: r.player.id,
      displayName: r.player.display_name,
      avatar: r.player.avatar,
      rating: r.player.rating,
      games: r.gamesTogether,
      starred: r.starred,
      state: r.presence?.state ?? "offline",
      matchId: r.presence?.matchId ?? null,
      joinCode: r.presence?.joinCode ?? null,
      hand: r.presence?.hand ?? null,
      handsBase: r.presence?.handsBase ?? null,
      roomCode: r.presence?.roomCode ?? null,
      lastSeen: r.presence !== undefined ? p.now() : r.player.last_seen_at,
    }));

  friends.sort((a, b) => {
    const aOnline = a.state === "offline" ? 0 : 1;
    const bOnline = b.state === "offline" ? 0 : 1;
    if (aOnline !== bOnline) return bOnline - aOnline;
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    return b.games - a.games;
  });

  return json({ friends });
}

async function postFriendStar(friendId: string, p: Platform, player: PlayerRow): Promise<Response> {
  const friend = await playerById(p.db, friendId);
  if (friend === null) return fail("not_found", 404);
  await starFriend(p.db, player.id, friendId, p.now());
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

/** Unstarring a friend the caller never starred is a no-op, not an error —
 *  the same idempotent shape `insertRoomPlayer`'s repeat-join doctrine uses. */
async function postFriendUnstar(friendId: string, p: Platform, player: PlayerRow): Promise<Response> {
  await unstarFriend(p.db, player.id, friendId);
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

/* ── direct messages (§8) ─────────────────────────────────────────────────── */

const DM_TEXT_MAX_LENGTH = 500;
const DM_MIN_INTERVAL_MS = 2_000;
const DM_THREAD_LIMIT = 100;
const DM_INBOX_SCAN_LIMIT = 300;

const dmView = (r: DmMessageRow) => ({
  id: r.id,
  fromPlayerId: r.from_player_id,
  toPlayerId: r.to_player_id,
  text: r.text,
  at: r.created_at,
  read: r.read_at !== null,
});

/** GET /api/dm/:playerId — the thread, last 100, marks it read (§8). */
async function getDmThread(otherId: string, p: Platform, player: PlayerRow): Promise<Response> {
  const other = await playerById(p.db, otherId);
  if (other === null) return fail("not_found", 404);
  /* Mark read BEFORE the read, not after: against a real database (unlike
   * an in-memory fake that happens to share row references) a query issued
   * before the UPDATE commits would still report `read_at IS NULL` for the
   * very messages this same call is marking read, which is not what a
   * caller opening the thread should see. */
  await markDmThreadRead(p.db, player.id, otherId, p.now());
  const rows = await dmThread(p.db, player.id, otherId, DM_THREAD_LIMIT);
  return json({
    playerId: other.id,
    displayName: other.display_name,
    avatar: other.avatar,
    messages: rows.slice().reverse().map(dmView),
  });
}

/** POST /api/dm/:playerId — ≤500 chars, 1 per 2s (§8), same off-the-sender's-
 *  own-newest-row rate-limit doctrine `postLobbyChat` uses for lobby chat. */
async function postDmMessage(otherId: string, req: Request, p: Platform, player: PlayerRow): Promise<Response> {
  const other = await playerById(p.db, otherId);
  if (other === null) return fail("not_found", 404);

  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);
  const text = str(body.text);
  if (text === null || text.length > DM_TEXT_MAX_LENGTH) return fail("bad_text", 400);

  const now = p.now();
  const last = await lastDmMessageAt(p.db, player.id);
  if (last !== null && Date.parse(now) - Date.parse(last) < DM_MIN_INTERVAL_MS) return fail("rate_limited", 429);

  await insertDmMessage(p.db, { fromPlayerId: player.id, toPlayerId: otherId, text, now });
  return new Response(null, { status: 204, headers: BASE_HEADERS });
}

/* ── inbox (§8) ───────────────────────────────────────────────────────────── */

const INBOX_ITEM_LIMIT = 100;

const inboxItemView = (
  it: InboxItemRow,
  names: Map<string, string>,
  avatars: Map<string, string | null>,
) => ({
  kind: it.kind,
  id: it.id,
  matchId: it.match_id,
  roomCode: it.room_code,
  fromPlayerId: it.from_player_id,
  fromDisplayName: it.from_player_id !== null ? names.get(it.from_player_id) ?? null : null,
  fromAvatar: it.from_player_id !== null ? avatars.get(it.from_player_id) ?? null : null,
  at: it.created_at,
  read: it.read_at !== null,
});

/** GET /api/inbox — invites, room notices and results (real `inbox_items`
 *  rows, §8) merged with DM thread summaries (folded from `dm_messages` in
 *  application code, same "union built in JS" doctrine `getLobby`'s `here`
 *  map already follows) — newest first, one `unread` badge sum. */
async function getInbox(p: Platform, player: PlayerRow): Promise<Response> {
  const [items, dmRows] = await Promise.all([
    inboxItemsForPlayer(p.db, player.id, INBOX_ITEM_LIMIT),
    dmMessagesInvolving(p.db, player.id, DM_INBOX_SCAN_LIMIT),
  ]);

  const otherIds = new Set<string>();
  for (const it of items) if (it.from_player_id !== null) otherIds.add(it.from_player_id);
  for (const r of dmRows) otherIds.add(r.from_player_id === player.id ? r.to_player_id : r.from_player_id);
  const names = new Map<string, string>();
  const avatars = new Map<string, string | null>();
  await Promise.all(
    [...otherIds].map(async (id) => {
      const other = await playerById(p.db, id);
      if (other !== null) {
        names.set(id, other.display_name);
        avatars.set(id, other.avatar);
      }
    }),
  );

  const itemViews = items.map((it) => inboxItemView(it, names, avatars));

  /* `dmRows` is newest-first, so the FIRST row seen per counterpart below is
   * that thread's latest message — the loop relies on that ordering. */
  const threads = new Map<string, { text: string; at: string; unread: number }>();
  for (const r of dmRows) {
    const counterpart = r.from_player_id === player.id ? r.to_player_id : r.from_player_id;
    let t = threads.get(counterpart);
    if (t === undefined) {
      t = { text: r.text, at: r.created_at, unread: 0 };
      threads.set(counterpart, t);
    }
    if (r.to_player_id === player.id && r.read_at === null) t.unread += 1;
  }
  const dmViews = [...threads.entries()].map(([counterpart, t]) => ({
    kind: "dm" as const,
    id: `dm:${counterpart}`,
    playerId: counterpart,
    displayName: names.get(counterpart) ?? "",
    fromAvatar: avatars.get(counterpart) ?? null,
    text: t.text,
    at: t.at,
    unread: t.unread,
  }));

  const unread = itemViews.filter((v) => !v.read).length + dmViews.reduce((sum, v) => sum + v.unread, 0);
  const merged = [...itemViews, ...dmViews].sort((a, b) => b.at.localeCompare(a.at));

  return json({ unread, items: merged });
}

/**
 * POST /api/inbox/:id/accept — an `invite` item only: seats the caller
 * through the normal join path (`claimFreeHumanSeat`, the same primitive
 * `postJoin` uses) and returns the same handoff shape `POST
 * /api/tables/:code/join` does, then dismisses the item.
 */
async function postInboxAccept(id: string, p: Platform, player: PlayerRow): Promise<Response> {
  const item = await inboxItemById(p.db, id);
  if (item === null || item.player_id !== player.id || item.dismissed_at !== null) return fail("not_found", 404);
  if (item.kind !== "invite" || item.match_id === null) return fail("not_an_invite", 400);

  const match = await matchById(p.db, item.match_id);
  if (match === null) return fail("not_found", 404);

  const claimed = await claimFreeHumanSeat(p, match, player);
  if (claimed === "full") return fail("table_full", 409);
  if (claimed === "conflict") return fail("conflict", 409);

  const handoff = await openAndSeat(p, match.id, claimed, player, null);
  if (handoff === null) return fail("table_unavailable", 503);

  await dismissInboxItem(p.db, id, player.id, p.now());

  return json({
    tableId: handoff.tableId,
    matchUuid: match.id,
    seat: claimed,
    seatToken: handoff.seatToken,
    seatTokenExpiresAt: handoff.expiresAt,
    rulesetId: match.ruleset_id,
    matchFormat: match.match_format,
  });
}

/** POST /api/inbox/:id/dismiss — any kind, participant-only (checked inside
 *  `dismissInboxItem`'s own `player_id = ?`). */
async function postInboxDismiss(id: string, p: Platform, player: PlayerRow): Promise<Response> {
  const ok = await dismissInboxItem(p.db, id, player.id, p.now());
  if (!ok) return fail("not_found", 404);
  return new Response(null, { status: 204, headers: BASE_HEADERS });
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
  avatar: string | null;
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
  /** Seats already taken at that table, humans and bots together, out of
   *  four — the "queue · 2/4" the Players list shows for a waiting table
   *  (players-lab.html §1). Set for `waiting`/`playing`, absent for a bare
   *  lobby heartbeat. */
  seatsFilled?: number;
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
  /* Occupancy, for `here`'s "2/4": a bot seat is filled the moment the table
   * is created, a human seat only once somebody claims it. */
  const seatsFilled = plan.reduce((n, spec, seat) => n + (spec.kind === "bot" || bySeat.has(seat) ? 1 : 0), 0);

  const seats = plan.map((spec, seat) => {
    if (spec.kind === "bot") {
      return {
        seat,
        kind: "bot" as const,
        displayName: botSeatLabel(p, spec.bot, seat as SeatIndex),
        avatar: null,
        connected: false,
      };
    }
    const row = bySeat.get(seat);
    if (row !== undefined && here !== null) {
      here.set(row.player_id, {
        playerId: row.player_id,
        displayName: row.display_name,
        avatar: row.avatar,
        state,
        matchId: m.id,
        joinCode,
        hand: m.current_hand,
        handsBase: m.hands_base,
        roomCode: m.room_code ?? undefined,
        seatsFilled,
      });
    }
    return {
      seat,
      kind: "human" as const,
      /* So a client can tell "one of these seats is MINE" — the rejoin
       * button on a playing table hangs off this (2026-09-03). */
      playerId: row?.player_id,
      displayName: row?.display_name,
      avatar: row?.avatar ?? null,
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
    speed: m.speed,
    name: m.name,
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
    standings: seats.map((s) => ({ displayName: s.display_name, avatar: s.avatar, chips: s.final_chips, place: s.place })),
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
    here.set(row.player_id, { playerId: row.player_id, displayName: row.display_name, avatar: row.avatar, state: "lobby" });
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
  const tzOffsetMin = parseTzOffsetMin(body.tzOffsetMin);
  if (tzOffsetMin !== null) await updateTzOffset(p.db, player.id, tzOffsetMin);
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
    roomCode = normaliseRoomCode(roomCodeRaw);
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
  // §8a-2: a room may fix its tables' speed; absent, `postTable`'s own
  // default rule decides per table, exactly as it does for a room-less one.
  const speed = isSpeed(body.speed) ? body.speed : undefined;

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
  const game: RoomGameSettings = { rulesetId: rules.id, matchFormat, access, speed };
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

/**
 * GET /api/rooms/:code — public read (§6 decision 1: everyone sees
 * everyone), same "browsable by design" doctrine the Almanac's own room GETs
 * already follow (`room-admin/_middleware.ts`'s header comment).
 *
 * `players[]` (§11.2) is members who are online/waiting/playing right now —
 * NOT the whole roster (`memberCount` is that count) — built the same way
 * `getLobby`'s room-scoped `here` is: presence rows for members seen
 * recently, richened by any of them found seated at one of the room's own
 * open tables.
 */
async function getRoom(codeRaw: string, p: Platform): Promise<Response> {
  const code = normaliseRoomCode(codeRaw);
  if (code === OPEN_ROOM_CODE) await ensureOpenRoom(p);
  const room = await roomByCode(p.db, code);
  if (room === null) return fail("not_found", 404);

  const now = p.now();
  const sinceIso = new Date(Date.parse(now) - HERE_WINDOW_MS).toISOString();
  const [memberCount, memberIds, openRows, presenceRows] = await Promise.all([
    roomMemberCount(p.db, room.code),
    roomPlayerIdsOf(p.db, room.code),
    matchesWaitingOrPlayingInRoom(p.db, room.code, LOBBY_TABLE_LIMIT),
    presenceInRoom(p.db, room.code, sinceIso),
  ]);

  const here = new Map<string, HereEntry>();
  for (const row of presenceRows) {
    here.set(row.player_id, { playerId: row.player_id, displayName: row.display_name, avatar: row.avatar, state: "lobby" });
  }
  const tables: Awaited<ReturnType<typeof tableViewOf>>[] = [];
  for (const m of openRows) tables.push(await tableViewOf(p, m, here));

  const memberIdSet = new Set(memberIds);
  const players = [...here.values()].filter((e) => memberIdSet.has(e.playerId));
  const game = roomGameSettingsOf(parseRoomSettings(room.settings));

  return json({ ...roomView(room, game, memberCount, tables), players });
}

/** GET /api/rooms/mine — every room the caller has joined, most recently
 *  touched first (creating a room joins it too — `postRooms`). The Open
 *  Hall (§11.2) is pinned first regardless — every player is a member of it
 *  by construction, so it is prepended rather than relying on its own
 *  `updated_at` to sort there. */
async function getRoomsMine(p: Platform, player: PlayerRow): Promise<Response> {
  await ensureOpenMembership(p, player.id, player.display_name);
  const rooms = await roomsForPlayer(p.db, player.id);
  const mapped = rooms.map((r) => ({
    code: r.code,
    name: r.name,
    game: roomGameSettingsOf(parseRoomSettings(r.settings)),
  }));
  mapped.sort((a, b) => (a.code === OPEN_ROOM_CODE ? -1 : b.code === OPEN_ROOM_CODE ? 1 : 0));
  return json({ rooms: mapped });
}

/** POST /api/rooms/:code/join — membership, idempotent (`insertRoomPlayer`'s
 *  OR IGNORE) — the same reconnect-safe shape `postJoin`'s "already seated"
 *  path uses for a table. */
async function postRoomJoin(codeRaw: string, p: Platform, player: PlayerRow): Promise<Response> {
  const code = normaliseRoomCode(codeRaw);
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
  const code = normaliseRoomCode(codeRaw);
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
    // §8a-2: unspecified keeps the room's current speed (including "none set"
    // — `undefined` survives the JSON round trip as an absent key); an
    // explicit non-speed value does not clear it, same tolerance
    // `matchFormat`/`access` show any other unrecognised body value.
    speed: body.speed === undefined ? current.speed : isSpeed(body.speed) ? body.speed : current.speed,
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
  const code = normaliseRoomCode(codeRaw);
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

  /* ── the account routes (ACCOUNTS-GAME-SIGNIN-2026-09-04.md §3) ──────────
   * All five sit ABOVE the Bearer check below, because their credential is the
   * session cookie and not a device token — `GET /api/me` in particular has to
   * answer a browser that holds neither. `resolveSession` is one signature
   * verification plus one primary-key read, and it is skipped entirely on a
   * request with no cookie. */
  const session = await resolveSession(request, p);

  if (seg[1] === "me" && seg.length === 2) {
    if (method !== "GET") return fail("method_not_allowed", 405);
    return getMe(request, p, session);
  }

  if (seg[1] === "handles" && seg.length === 3) {
    if (method !== "GET") return fail("method_not_allowed", 405);
    return getHandleAvailability(seg[2], p);
  }

  if (seg[1] === "signup" && seg.length === 2) {
    if (method !== "POST") return fail("method_not_allowed", 405);
    return postSignup(request, p, session);
  }

  if (seg[1] === "account" && seg.length === 3 && seg[2] === "delete") {
    if (method !== "POST") return fail("method_not_allowed", 405);
    return postAccountDelete(request, p, session);
  }

  if (seg[1] === "identity" && seg.length === 2) {
    if (method !== "POST") return fail("method_not_allowed", 405);
    return postIdentity(request, p, session);
  }

  /* Everything past this line is authenticated by the Bearer device token, as
   * it always has been. A token can now only come from a grandfathered player
   * or from a session-issued mint, so that is enough (§3's last row). */
  const player = await authenticate(request, p);
  if (player === null) return fail("unauthorized", 401);

  if (seg[1] === "matches") {
    if (seg.length === 2) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getMatches(url, p, player);
    }
    if (seg.length === 3) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getGameDetail(seg[2], p, player);
    }
    if (seg.length === 4 && seg[3] === "log") {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getMatchLog(seg[2], p, player);
    }
  }

  /* §11.3: `/games/:id` is the real URL path; `/api/matches/:id` above stays
   * a working alias to the same handler, never a second shape. */
  if (seg[1] === "games") {
    if (seg.length === 3) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getGameDetail(seg[2], p, player);
    }
    if (seg.length === 4 && seg[3] === "log") {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getMatchLog(seg[2], p, player);
    }
  }

  if (seg[1] === "watch" && seg.length === 3) {
    if (method !== "GET") return fail("method_not_allowed", 405);
    return getWatch(seg[2], p, player);
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
    if (seg.length === 4 && seg[3] === "invite") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postTableInvite(seg[2], request, p, player);
    }
  }

  if (seg[1] === "stats") {
    if (seg[2] === "me" && seg.length === 3) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getStatsFor(player.id, p);
    }
    if (seg[2] === "record" && seg.length === 3) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getStatsRecord(url, p, player);
    }
    if (seg[2] === "histograms" && seg.length === 3) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getStatsHistograms(url, p, player);
    }
    if (seg[2] === "series" && seg.length === 3) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getStatsSeries(url, p, player);
    }
  }

  if (seg[1] === "players") {
    if (seg.length === 2) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getPlayers(url, p, player);
    }
    if (seg.length === 4 && seg[3] === "stats") {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getStatsFor(seg[2], p);
    }
  }

  if (seg[1] === "leaderboard" && seg.length === 2) {
    if (method !== "GET") return fail("method_not_allowed", 405);
    return getLeaderboard(url, p, player);
  }

  if (seg[1] === "friends") {
    if (seg.length === 2) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getFriends(p, player);
    }
    /* Two spellings of unstar, on purpose: `POST .../unstar` is the original,
     * `DELETE .../star` is what the client's `unstarFriend` has always sent
     * (client/gamepvp/net.ts) and what the Players list's star toggle uses. */
    if (seg.length === 4 && seg[3] === "star") {
      if (method === "POST") return postFriendStar(seg[2], p, player);
      if (method === "DELETE") return postFriendUnstar(seg[2], p, player);
      return fail("method_not_allowed", 405);
    }
    if (seg.length === 4 && seg[3] === "unstar") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postFriendUnstar(seg[2], p, player);
    }
  }

  if (seg[1] === "dm" && seg.length === 3) {
    if (method === "GET") return getDmThread(seg[2], p, player);
    if (method === "POST") return postDmMessage(seg[2], request, p, player);
    return fail("method_not_allowed", 405);
  }

  if (seg[1] === "inbox") {
    if (seg.length === 2) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      return getInbox(p, player);
    }
    if (seg.length === 4 && seg[3] === "accept") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postInboxAccept(seg[2], p, player);
    }
    if (seg.length === 4 && seg[3] === "dismiss") {
      if (method !== "POST") return fail("method_not_allowed", 405);
      return postInboxDismiss(seg[2], p, player);
    }
  }

  if (seg[1] === "lobby") {
    if (seg.length === 2) {
      if (method !== "GET") return fail("method_not_allowed", 405);
      /* §8b: ?room=CODE scopes every panel; absent/empty is the global lobby.
       * §11.2: the Open Hall may not exist yet for a caller who registered
       * before this feature — ensure it rather than 404ing on the one room
       * everyone is nominally already a member of. */
      const roomParam = url.searchParams.get("room");
      const roomCode = roomParam === null || roomParam.trim() === "" ? null : normaliseRoomCode(roomParam);
      if (roomCode === OPEN_ROOM_CODE) await ensureOpenMembership(p, player.id, player.display_name);
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

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
 *   POST /api/identity            device token + display name (P0)
 *   GET  /api/matches             the caller's match history
 *   GET  /api/matches/:id         match detail, including per-hand rows
 *   GET  /api/matches/:id/log     the R2 event-log blob, participants only
 *   POST /api/tables              create a table
 *   POST /api/tables/:code/join   join by code
 *   GET  /api/replay/:token       PUBLIC, unauthenticated — §2's only viral loop
 *
 * Not here, on purpose: CORS. The client ships same-origin behind the site's
 * host routing, and an allow-list belongs in the routing layer rather than
 * duplicated in every handler. Add it there if the client ever moves origin.
 */
import type { FaanAward, SeatIndex } from "@mjrc/engine";
import { EVENT_SCHEMA_VERSION } from "@mjrc/protocol";
import { DEFAULT_RULESET_ID, assertRulesetSound, ruleset } from "@mjrc/rulesets";
import type {
  D1Like,
  HandRow,
  MatchListRow,
  MatchRow,
  MatchSeatRow,
  PlayerRow,
  R2Like,
} from "./db.js";
import {
  ID_LENGTH,
  JOIN_CODE_LENGTH,
  archiveRuleset,
  claimSeat,
  handsOfMatch,
  insertCredential,
  insertMatch,
  insertPlayer,
  matchById,
  matchByJoinCode,
  matchLogById,
  matchesForPlayer,
  playerForCredential,
  randomId,
  renamePlayer,
  rulesetHash,
  seatOf,
  seatsOfMatch,
  sha256Hex,
  toHex,
  touchCredential,
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
  botSeats: number;
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

const MAX_DISPLAY_NAME = 40;
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

/**
 * Codes are read off a screen and typed into a phone. Crockford base32 already
 * drops I, L, O and U from the alphabet; folding the look-alikes on the way in
 * means "1" typed for a shown "I" still finds the table.
 */
function normaliseJoinCode(raw: string): string {
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

/**
 * POST /api/tables — create a table and take the first seat.
 *
 * The §5.3 handoff in full: D1 rows first, then the table is opened, then the
 * seat token is minted. If the DO call fails the match row is left `running`
 * and is reaped by the ops query idx_matches_running covers; the reverse order
 * would leave a live table no row points at, which nothing sweeps.
 */
async function postTable(req: Request, p: Platform, player: PlayerRow): Promise<Response> {
  const body = await readJsonObject(req);
  if (body === null) return fail("bad_json", 400);

  const rulesetId = str(body.rulesetId) ?? DEFAULT_RULESET_ID;
  const rules = ruleset(rulesetId);
  if (rules === undefined) return fail("unknown_ruleset", 400);
  try {
    assertRulesetSound(rules);
  } catch {
    /* A preset that fails its own soundness check is a deploy bug, not a
     * client one. Refuse to start a match under it rather than archive it. */
    return fail("server_misconfigured", 500);
  }

  const matchFormat = body.matchFormat === "full" ? "full" : "east";
  const botSeats = clampInt(body.botSeats, 0, 3, 0);
  const now = p.now();
  const hash = await rulesetHash(rules);
  await archiveRuleset(p.db, hash, rules, now);

  const matchId = randomId(p.random, ID_LENGTH);
  const joinCode = randomId(p.random, JOIN_CODE_LENGTH);
  await insertMatch(p.db, {
    id: matchId,
    matchFormat,
    rulesetHash: hash,
    rulesetId: rules.id,
    engineVersion: p.engineVersion,
    logSchemaVersion: EVENT_SCHEMA_VERSION,
    roomCode: str(body.roomCode),
    joinCode,
    /* Never rated at creation. `rated` is decided at match end and frozen
     * (schema.sql, matches.rated), and the bot-seat policy is still open
     * (worker/README.md §8, question 3). */
    rated: false,
    botSeats,
    now,
  });

  if (!(await claimSeat(p.db, matchId, 0, player.id))) return fail("conflict", 409);

  const handoff = await openAndSeat(p, matchId, 0, player, {
    matchId,
    rulesetId: rules.id,
    rulesetHash: hash,
    engineVersion: p.engineVersion,
    logSchemaVersion: EVENT_SCHEMA_VERSION,
    matchFormat,
    botSeats,
    startedAt: now,
  });
  if (handoff === null) return fail("table_unavailable", 503);

  return json(
    {
      tableId: handoff.tableId,
      matchUuid: matchId,
      joinCode,
      seat: 0,
      seatToken: handoff.seatToken,
      seatTokenExpiresAt: handoff.expiresAt,
      rulesetId: rules.id,
      rulesetHash: hash,
      engineVersion: p.engineVersion,
      matchFormat,
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

const SEATS: readonly SeatIndex[] = [0, 1, 2, 3];

/**
 * POST /api/tables/:code/join — take a seat at an existing table.
 *
 * Idempotent for a player who already holds a seat: they get that same seat and
 * a fresh token. That is not a convenience, it is the reconnect path — §5.3's
 * "seat reclaim by server-issued credential on return" needs a way to ask for a
 * new token without the UNIQUE (match_id, player_id) constraint refusing it.
 */
async function postJoin(code: string, p: Platform, player: PlayerRow): Promise<Response> {
  const joinCode = normaliseJoinCode(code);
  if (joinCode.length < 6) return fail("not_found", 404);

  const match = await matchByJoinCode(p.db, joinCode);
  if (match === null) return fail("not_found", 404);

  let seat = await seatOf(p.db, match.id, player.id);
  if (seat === null) {
    /* Bounded retry rather than a lock: seat assignment reads then writes, and
     * PRIMARY KEY (match_id, seat) is the arbiter. Four attempts is one per
     * seat, which is the most contention this table can produce. */
    for (let attempt = 0; attempt < SEATS.length && seat === null; attempt += 1) {
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
      /* Bots hold the HIGH seats and have no match_players row (they are a
       * count on the match), so the free-seat search must stop short of them
       * or a joiner is handed a seat the table will refuse. */
      const firstBotSeat = 4 - Math.max(0, Math.min(4, match.bot_seats));
      const free = SEATS.find((s) => !taken.has(s) && s < firstBotSeat);
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

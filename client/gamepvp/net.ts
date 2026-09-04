/**
 * The wire layer for gamepvp: identity + lobby HTTP calls, and `TableSocket`,
 * the WebSocket client for one seat at one table.
 *
 * DOCTRINE (see messages.ts): the client has zero authority. Every request is
 * a REQUEST — this module sends it, waits for `accepted`/`rejected`, and never
 * predicts an outcome. `TableSocket` does transport only: connect, join,
 * reconnect, resync, heartbeat echo, and routing every server message to a
 * typed callback. It holds no game state — `game.ts` owns `snap` and applies
 * events, this module never reads or writes it.
 *
 * Dependency-free on purpose (task spec): fetch + WebSocket + crypto, nothing
 * else.
 */
import type {
  AcceptedPayload,
  ChatMessagePayload,
  ChatPhrase,
  ChatRequestPayload,
  ClientRequest,
  ClientRequestType,
  PausedPayload,
  PausedState,
  PresencePayload,
  ProtocolFaultPayload,
  PromptPayload,
  RejectCode,
  RejectedPayload,
  RestorePayload,
  SeatDirectoryEntry,
  ServerToSeat,
  WelcomePayload,
} from "../../protocol/src/messages.js";
import { PROTOCOL_VERSION } from "../../protocol/src/messages.js";
import type { FourSeats, RedactedGameEvent, SeatSnapshot, SeatVisible } from "../../protocol/src/events.js";

/* ── identity ──────────────────────────────────────────────────────────── */

const LS_TOKEN = "mjrc.gamepvp.deviceToken";
const LS_NAME = "mjrc.gamepvp.displayName";
const LS_AVATAR = "mjrc.gamepvp.avatar";
const LS_PLAYER = "mjrc.gamepvp.playerId";

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** 40 symbols from that 62-letter alphabet is well past the server's 32-char,
 *  [A-Za-z0-9_-] floor (worker/src/index.ts DEVICE_TOKEN_RE). Minted here, not
 *  server-side: the client keeps this token forever in localStorage and it is
 *  the only thing that ever proves "the same device came back". */
function mintDeviceToken(): string {
  const bytes = new Uint8Array(40);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return s;
}

export interface Identity {
  playerId: string;
  displayName: string;
  /** Data URI, JPEG, <= 12 KB; null = no picture (letter avatar). Optional so
   *  a caller that only ever built this shape by hand (`bootIdentity`'s
   *  offline fallback in shell/session.ts) still compiles. */
  avatar?: string | null;
  rating: number | null;
  deviceToken: string;
}

/** What is on this device already, before the player has typed anything. */
export function storedIdentity(): { deviceToken: string | null; displayName: string | null; avatar: string | null } {
  return {
    deviceToken: localStorage.getItem(LS_TOKEN),
    displayName: localStorage.getItem(LS_NAME),
    avatar: localStorage.getItem(LS_AVATAR),
  };
}

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(`${code} (${status})`);
  }
}

async function apiFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`/api/${path}`, {
    method: opts.method ?? "GET",
    headers,
    body,
    credentials: "same-origin",
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* no/invalid JSON body — data stays null */
  }
  if (!res.ok) {
    const code =
      data && typeof data === "object" && "error" in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : `http_${res.status}`;
    throw new ApiError(code, res.status);
  }
  return data as T;
}

/** POST /api/identity. Mints a device token on first call, then reuses it —
 *  calling again with a new name just renames. `tzOffsetMin` (task brief
 *  §11.5): the client's UTC offset in minutes, `Date().getTimezoneOffset()`
 *  convention (positive west of UTC) — the server folds this into streak/
 *  "today" counting. Optional so an older caller of this module still
 *  compiles; every caller in this client now sends one. */
/** `displayName` null = re-identify with the stored token and take the
 *  server's name; never let a stale local copy rename the player. `avatar`
 *  (account.ts only — every other caller omits it): `undefined` = leave the
 *  picture alone, `null` = clear it, a `data:image/jpeg;base64,...` string =
 *  replace it. Same "absent means unchanged" contract the server's
 *  `parseAvatarField` implements (worker/src/index.ts). */
export async function identify(
  displayName: string | null,
  tzOffsetMin?: number,
  avatar?: string | null,
): Promise<Identity> {
  const token = localStorage.getItem(LS_TOKEN) ?? mintDeviceToken();
  const body: Record<string, unknown> = { deviceToken: token, tzOffsetMin };
  if (displayName !== null) body.displayName = displayName;
  if (avatar !== undefined) body.avatar = avatar;
  const data = await apiFetch<{ playerId: string; displayName: string; avatar?: string | null; rating: number | null }>(
    "identity",
    { method: "POST", body },
  );
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_NAME, data.displayName);
  localStorage.setItem(LS_PLAYER, data.playerId);
  if (data.avatar) localStorage.setItem(LS_AVATAR, data.avatar);
  else localStorage.removeItem(LS_AVATAR);
  return {
    playerId: data.playerId,
    displayName: data.displayName,
    avatar: data.avatar ?? null,
    rating: data.rating ?? null,
    deviceToken: token,
  };
}

/* ── accounts: Google sign-in, sign-up, account (ACCOUNTS-GAME-SIGNIN-2026-09-04 §3) ──
 * The one thing this section does NOT do is authenticate: `/auth/google` is a
 * plain link the browser follows (see shell/pages/signin.ts), and the session
 * lives in an HttpOnly cookie this client can neither read nor forge. Every
 * call below therefore rides on `credentials: "same-origin"` and says nothing
 * about who the caller is — the Worker decides.
 *
 * The device token stays exactly what it always was (Bearer on every other
 * `/api/*` call); the only change is that after accounts land it is MINTED BY
 * THE SERVER on `/api/me` and stored here, rather than minted client-side on
 * first `identify`. `identify` keeps its old mint path for the grandfathered
 * device players the contract's §3 `ACCOUNTS_CUTOFF` still allows. */

export type AccountLanguage = "en" | "zh";

export interface MeUser {
  id: string;
  userNo: number;
  email: string;
  displayName: string;
  /** null until sign-up confirms one. */
  handle: string | null;
  /** Google photo URL — NOT the game avatar (that is `MePlayer.avatar`). */
  picture: string | null;
  isAdmin: boolean;
  /** false = signed in, sign-up not finished → the client owes `/signup`. */
  onboarded: boolean;
  language: AccountLanguage | null;
}

export interface MePlayer {
  playerId: string;
  displayName: string;
  avatar?: string | null;
  rating: number | null;
}

export interface MeResponse {
  signedIn: boolean;
  user: MeUser | null;
  player: MePlayer | null;
  /** Server-minted, bound to `player`, for THIS browser. Store it and keep
   *  sending it as Bearer, same as today. */
  deviceToken: string | null;
}

/** Handle rule, contract §3: `^[a-z0-9_]{3,20}$` after lowercasing. Checked
 *  here before the network so the field can say "3–20 characters…" without a
 *  round trip; the server checks it again and is the authority. */
export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
export const normaliseHandle = (raw: string): string => raw.trim().replace(/^@+/, "").toLowerCase();

export interface HandleCheck { available: boolean; reason?: "taken" | "invalid" | "reserved"; }

export interface SignupBody {
  displayName: string;
  handle: string;
  language: AccountLanguage;
  /** Omitted = keep whatever the server decides (the Google picture is NOT
   *  copied into the player avatar at sign-up — the account page picker is
   *  where a game avatar gets set). */
  avatar?: string | null;
  consents: { terms: true; privacy: true; marketing: boolean };
  /** Landing path or room/table code — the invite that brought them here. */
  source?: string;
  /** Lets the server adopt an existing unclaimed device player and keep its
   *  history instead of creating a fresh one. */
  deviceToken?: string;
}

/** GET /api/me — the boot call. Never throws for "not signed in": that is a
 *  200 with `signedIn: false`. It DOES throw (ApiError) if the server is
 *  unreachable or unhappy, and shell/session.ts treats that as signed-out
 *  (fail closed — the contract forbids anonymous play). */
export const getMe = (): Promise<MeResponse> => apiFetch<MeResponse>("me");

/** GET /api/handles/:handle — live availability behind the sign-up field's
 *  debounce. `handle` is normalised and pre-validated here; an invalid one
 *  never reaches the network. */
export async function checkHandle(handle: string): Promise<HandleCheck> {
  const h = normaliseHandle(handle);
  if (!HANDLE_RE.test(h)) return { available: false, reason: "invalid" };
  return apiFetch<HandleCheck>(`handles/${encodeURIComponent(h)}`);
}

/** POST /api/signup — returns the same shape as `/api/me`. `handle_taken`
 *  (409) arrives as an `ApiError` with that code; the sign-up page shows it
 *  inline on the handle field rather than as a page-level failure. */
export async function signup(body: SignupBody): Promise<MeResponse> {
  const me = await apiFetch<MeResponse>("signup", { method: "POST", body });
  rememberMe(me);
  return me;
}

/** POST /auth/signout. Not under `/api/` — a plain fetch, and the only thing
 *  that matters is that the cookie comes back cleared, so a non-JSON 204 is
 *  the expected reply. */
export async function signout(): Promise<void> {
  const res = await fetch("/auth/signout", { method: "POST", credentials: "same-origin" });
  if (!res.ok) throw new ApiError(`http_${res.status}`, res.status);
  forgetDevice();
}

/** POST /api/account/delete — scrub-in-place server-side (contract §3), then
 *  drop everything this browser remembers so a reload lands on sign-in with
 *  no stale name or token. */
export async function deleteAccount(): Promise<void> {
  await apiFetch<null>("account/delete", { method: "POST" });
  forgetDevice();
}

/** Persist the server's view of this browser: the minted device token, and
 *  the player it is bound to. Safe to call with a half-empty response. */
export function rememberMe(me: MeResponse): void {
  if (me.deviceToken) localStorage.setItem(LS_TOKEN, me.deviceToken);
  if (me.player) {
    localStorage.setItem(LS_NAME, me.player.displayName);
    localStorage.setItem(LS_PLAYER, me.player.playerId);
    if (me.player.avatar) localStorage.setItem(LS_AVATAR, me.player.avatar);
    else localStorage.removeItem(LS_AVATAR);
  }
}

/** The `Identity` the rest of the client already runs on, rebuilt from a
 *  `/api/me` that carried both halves. Null when the server sent no player or
 *  no token yet — the caller falls back to `POST /api/identity`. */
export function identityFromMe(me: MeResponse): Identity | null {
  const token = me.deviceToken ?? localStorage.getItem(LS_TOKEN);
  if (!me.player || !token) return null;
  return {
    playerId: me.player.playerId,
    displayName: me.player.displayName,
    avatar: me.player.avatar ?? null,
    rating: me.player.rating ?? null,
    deviceToken: token,
  };
}

/** Everything this browser remembers about who it is. Sign-out and account
 *  deletion both call it; nothing else should. */
export function forgetDevice(): void {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_NAME);
  localStorage.removeItem(LS_PLAYER);
  localStorage.removeItem(LS_AVATAR);
}

/* ── lobby: tables and match history ──────────────────────────────────── */

export type MatchFormat = "east" | "full";
export type TableMode = "casual" | "ranked";
export type TableAccess = "open" | "private";

/**
 * PVP-LOBBY-PROPOSAL-2026-09-02.md §8a-2: a table's turn/claim pace. Declared
 * here rather than imported from protocol/src/messages.ts because the wire
 * contract for it (`POST /api/tables`'s `speed`, `LobbyTable.speed`, the
 * `starting` push) is still landing server-side (another agent's work, in
 * parallel with this client, per the task brief) — this is coded to the
 * DOCUMENTED contract and degrades gracefully wherever the server doesn't
 * send the field yet (every reader below treats a missing value as
 * "unknown", never as a crash). Replace with a `protocol/` import once that
 * lands there with the same shape.
 */
export const TABLE_SPEEDS = ["untimed", "very-slow", "normal", "faster", "insane"] as const;
export type TableSpeed = (typeof TABLE_SPEEDS)[number];
export const isTableSpeed = (v: unknown): v is TableSpeed =>
  typeof v === "string" && (TABLE_SPEEDS as readonly string[]).includes(v);

/**
 * `starting { startsAt, settings }` (§8a-2) — broadcast once before the first
 * turn, and echoed on `welcome`/`restore` as `starting: {...} | null` while
 * the hold is still up. Not yet in `protocol/src/messages.ts`'s
 * `ServerToSeat`/`WelcomePayload`/`RestorePayload` union (see the doc comment
 * above `TableSpeed`) — `TableSocket` reads it off the raw JSON before
 * narrowing to the typed union, see `handleMessage` below.
 */
export interface StartingSettings {
  style: string;
  rulesetId: string;
  rulesetLabel: string;
  minimumFaan: number;
  limitFaan: number;
  useFlowers: boolean;
  paymentId: string;
  matchFormat: MatchFormat;
  speed: TableSpeed;
  seats: FourSeats<SeatDirectoryEntry>;
}
export interface StartingPayload {
  startsAt: number;
  settings: StartingSettings;
}

export interface CreateTableResult {
  tableId: string;
  matchUuid: string;
  joinCode: string;
  /** Null when the creator hosts without a seat (`hostOnly`, 2026-09-03). */
  seat: 0 | 1 | 2 | 3 | null;
  seatToken: string | null;
  seatTokenExpiresAt: string | null;
  hostOnly?: boolean;
  rulesetId: string;
  rulesetHash: string;
  engineVersion: string;
  matchFormat: MatchFormat;
  /** Optional display name the creator gave the table (owner request
   *  2026-09-04) — worker/src/index.ts postTable, schema.sql matches.name. */
  name?: string | null;
}

/** One of the four seats as the creator laid them out — PVP-LOBBY-PROPOSAL
 *  §7.2's `POST /api/tables` body. The old `botSeats`/`bots` shape is still
 *  accepted server-side (converted), but this client always sends `seats`. */
export type SeatSpec = { kind: "human" } | { kind: "bot"; bot: string };

export async function createTable(
  token: string,
  opts: {
    rulesetId: string; matchFormat: MatchFormat; mode: TableMode; access: TableAccess;
    randomizeSeats: boolean; seats: [SeatSpec, SeatSpec, SeatSpec, SeatSpec];
    /** The creator takes no seat and hosts from the watch page (2026-09-03). */
    hostOnly?: boolean;
    /** §8a-2. Optional here only so an older caller of this module still
     *  compiles; `game.ts`'s `doCreateTable()` always sends one now. */
    speed?: TableSpeed;
    /** Optional display name (owner request 2026-09-04) — server trims,
     *  strips control characters and rejects it past 40 chars. */
    name?: string;
  },
): Promise<CreateTableResult> {
  return apiFetch("tables", { method: "POST", token, body: opts });
}

/** One row of GET /api/bots — see gamepvp/src/bots.ts `BOT_CATALOGUE`. */
export interface BotCatalogueEntry {
  key: string;
  displayName: string;
  blurb: string;
  strength: number;
}

export async function listBots(): Promise<BotCatalogueEntry[]> {
  const data = await apiFetch<{ bots: BotCatalogueEntry[] }>("bots");
  return data.bots;
}

export interface JoinTableResult {
  tableId: string;
  matchUuid: string;
  seat: 0 | 1 | 2 | 3;
  seatToken: string;
  seatTokenExpiresAt: string;
  rulesetId: string;
  matchFormat: MatchFormat;
}

export async function joinTable(token: string, joinCode: string): Promise<JoinTableResult> {
  return apiFetch(`tables/${encodeURIComponent(joinCode)}/join`, { method: "POST", token, body: {} });
}

/** POST /api/tables/:matchId/start — creator only, waiting only (§7.2): any
 *  unfilled human seat becomes a bot, seats shuffle if `randomizeSeats` was
 *  set at creation, and the clocks start. */
export async function startTable(token: string, matchId: string): Promise<void> {
  await apiFetch<void>(`tables/${encodeURIComponent(matchId)}/start`, { method: "POST", token, body: {} });
}

/** POST /api/tables/:matchId/leave — the seat plays out the rest of the
 *  match as a bot; the seat token still reclaims it (§7.2). */
/** POST /api/tables/:matchId/end — the creator ends the table for everyone. */
export async function endTable(token: string, matchId: string): Promise<void> {
  await apiFetch<void>(`tables/${encodeURIComponent(matchId)}/end`, { method: "POST", token, body: {} });
}
/** POST /api/tables/:matchId/kick — the creator removes a player from a seat. */
export async function kickSeat(token: string, matchId: string, seat: 0 | 1 | 2 | 3): Promise<void> {
  await apiFetch<void>(`tables/${encodeURIComponent(matchId)}/kick`, { method: "POST", token, body: { seat } });
}
export async function leaveTable(token: string, matchId: string): Promise<void> {
  await apiFetch<void>(`tables/${encodeURIComponent(matchId)}/leave`, { method: "POST", token, body: {} });
}

/* ── lobby: presence + open tables (PVP-LOBBY-PROPOSAL-2026-09-02.md §7.2) ─
 * `GET /api/lobby` is polled every 5s while the lobby screen is open; the
 * three arrays are read-only summaries, never partially applied — a fetch
 * failure (including "not implemented yet" while the backend lands this
 * contract) is the caller's to swallow and degrade, not this module's. */

export type PresenceState = "lobby" | "away";
export type HereState = "lobby" | "waiting" | "playing";

export interface LobbyHereEntry {
  playerId: string;
  displayName: string;
  avatar?: string | null;
  state: HereState;
  matchId?: string;
  joinCode?: string;
  /** 0-indexed current hand and the dealership-count denominator — see
   *  game.ts's `handLabel()` for the `hand + 1` / "past the base" rule. */
  hand?: number;
  handsBase?: number;
}

export interface LobbyTableSeat {
  seat: 0 | 1 | 2 | 3;
  kind: "human" | "bot";
  /** The seated player, for a human seat that has one — absent on a server
   *  that hasn't landed the field yet. "Is this seat mine" hangs off it. */
  playerId?: string;
  displayName?: string;
  avatar?: string | null;
  connected: boolean;
}

export type LobbyStatus = "waiting" | "playing" | "done";

export interface LobbyTable {
  matchId: string;
  /** Present only for open tables — a private table lists no code. */
  joinCode?: string;
  access: TableAccess;
  mode: TableMode;
  rulesetId: string;
  matchFormat: MatchFormat;
  lobbyStatus: LobbyStatus;
  /** §8a-2. Absent on a server that hasn't landed the field yet — every
   *  reader treats that the same as "unknown", never a crash. */
  speed?: TableSpeed;
  hand?: number;
  handsBase?: number;
  seats: LobbyTableSeat[];
  /** The creator's player id (schema.sql `matches.created_by`) — not a
   *  display name. The lobby screen resolves a name from `seats` instead. */
  createdBy: string;
  startedAt: number;
  /** The room the table was opened in, or null for one opened from Home. */
  roomCode?: string | null;
  /** Optional display name the creator gave the TABLE (owner request
   *  2026-09-04, schema.sql `matches.name`) — distinct from `createdBy`
   *  above, which is a player id. Null/absent means no name was set. */
  name?: string | null;
}

export interface LobbyRecentStanding {
  displayName: string;
  avatar?: string | null;
  chips: number;
  place: number;
}

export interface LobbyRecentMatch {
  matchId: string;
  endedAt: number;
  mode: TableMode;
  standings: LobbyRecentStanding[];
}

/** One row of the lobby chat (§8) — `GET /api/lobby`'s `chat[]`, last 50,
 *  oldest first. Unlike table chat's `ChatMessagePayload` this carries a
 *  `playerId` directly (no seat/directory indirection to resolve it through),
 *  which is what the mute feature keys on. */
export interface LobbyChatEntry {
  id: string;
  playerId: string;
  displayName: string;
  text: string;
  at: number;
}

export interface LobbyPayload {
  now: number;
  here: LobbyHereEntry[];
  tables: LobbyTable[];
  recent: LobbyRecentMatch[];
  chat: LobbyChatEntry[];
}

/** `?room=CODE` (§8b) scopes `here`/`tables`/`recent`/`chat` to one room —
 *  omit for the global lobby (Open hall). */
export async function getLobby(token: string, room?: string): Promise<LobbyPayload> {
  return apiFetch(`lobby${room ? `?room=${encodeURIComponent(room)}` : ""}`, { token });
}

/** POST /api/presence — sent every 30s while the app is open and visible,
 *  and once more on `visibilitychange` back to visible. `tzOffsetMin`: see
 *  `identify()`'s doc comment — sent here too since presence is the more
 *  frequent signal and "today" should never drift across a heartbeat. */
export async function postPresence(token: string, state: PresenceState, tzOffsetMin?: number): Promise<void> {
  await apiFetch<void>("presence", { method: "POST", token, body: { state, tzOffsetMin } });
}

/** POST /api/lobby/chat { text } → 204 (§8). 400 `bad_text`/429 `rate_limited`
 *  surface as `ApiError` like any other call — the caller (game.ts's lobby
 *  chat panel) reads `.code` to show "slow down" on a 429. */
export async function postLobbyChat(token: string, text: string, room?: string): Promise<void> {
  await apiFetch<void>("lobby/chat", { method: "POST", token, body: { text, room } });
}

/** One row of GET /api/matches — see worker/src/index.ts matchListView. */
export interface MatchListItem {
  matchId: string;
  status: string;
  matchFormat: MatchFormat;
  rulesetId: string;
  rated: boolean;
  botSeats: number;
  handCount: number;
  roomCode: string | null;
  joinCode: string | null;
  hasLog: boolean;
  startedAt: number;
  endedAt: number | null;
  /** Optional display name (owner request 2026-09-04, schema.sql
   *  `matches.name`); null/absent means none was set. */
  name?: string | null;
  seat: number | null;
  place: number | null;
  finalChips: number | null;
  faanWon: number | null;
  ratingBefore: number | null;
  ratingAfter: number | null;
}

export async function listMatches(
  token: string,
  opts: { limit?: number; before?: number } = {},
): Promise<{ matches: MatchListItem[]; nextBefore: number | null }> {
  const qs = new URLSearchParams();
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.before) qs.set("before", String(opts.before));
  const q = qs.toString();
  return apiFetch(`matches${q ? `?${q}` : ""}`, { token });
}

/** GET /api/matches/:id — see worker/src/index.ts matchView/seatView/handView.
 *  Shapes kept loose (Record) here: this client only reads a handful of
 *  fields for the match-detail panel and has no stake in the rest drifting. */
export interface MatchDetail {
  match: Record<string, unknown>;
  viewerSeat: number;
  seats: Record<string, unknown>[];
  hands: Record<string, unknown>[];
  replayToken: string | null;
}

export async function matchDetail(token: string, matchId: string): Promise<MatchDetail> {
  return apiFetch(`matches/${encodeURIComponent(matchId)}`, { token });
}

/* ── rooms (PVP-LOBBY-PROPOSAL-2026-09-02.md §8b; task item 3's Rooms tab) ─
 * Scheduled work another agent is building to this contract, in parallel
 * with this client — every call here is written to degrade gracefully (a
 * 404 `ApiError`) rather than assume the backend already exists. */

/** One row of `GET /api/rooms/mine` — not itself named in §8b (which only
 *  specifies `GET /api/rooms/:code`'s single-room shape), but what the lobby
 *  polls to fill its Rooms tab; a summary row, not the full detail shape. */
export interface RoomSummary {
  code: string;
  name: string;
  memberCount?: number;
  /** Server may not send these yet (older `rooms/mine`) — every reader
   *  treats a missing value the same as "unknown", never a crash. */
  rulesetId?: string;
  matchFormat?: MatchFormat;
  online?: number;
  live?: number;
  starred?: boolean;
}

/** `GET /api/rooms/mine` — the rooms this player belongs to. The caller
 *  (game.ts's Rooms tab) treats a 404 `ApiError` as "not built yet" and
 *  shows "rooms are coming" rather than a real error — see its doc comment. */
export async function getMyRooms(token: string): Promise<RoomSummary[]> {
  const data = await apiFetch<{ rooms: RoomSummary[] }>("rooms/mine", { token });
  return data.rooms ?? [];
}

export interface CreateRoomResult {
  code: string;
}

/** `POST /api/rooms { name, rulesetId, matchFormat, adminCode }` → `{ code
 *  }` (§8b) — a 6-char Crockford code, not colliding with the Almanac's own
 *  room codes (the two share the `rooms` table). */
export async function createRoom(
  token: string,
  opts: { name: string; rulesetId: string; matchFormat: MatchFormat; adminCode: string },
): Promise<CreateRoomResult> {
  return apiFetch("rooms", { method: "POST", token, body: opts });
}

/** `POST /api/rooms/:code/join` — membership only (a `room_players` row);
 *  sitting at one of the room's OWN tables is still the game's usual
 *  `joinTable`/`createTable` flow, unrelated to this call. */
export async function joinRoom(token: string, code: string): Promise<void> {
  await apiFetch<void>(`rooms/${encodeURIComponent(code)}/join`, { method: "POST", token, body: {} });
}

export async function starRoom(token: string, code: string): Promise<void> {
  await apiFetch<void>(`rooms/${encodeURIComponent(code)}/star`, { method: "POST", token, body: {} });
}
export async function unstarRoom(token: string, code: string): Promise<void> {
  await apiFetch<void>(`rooms/${encodeURIComponent(code)}/star`, { method: "DELETE", token });
}

/** `GET /api/rooms/:code` (§8b) — the room's own page: name, its `game`
 *  settings (ruleset/format fixed by the room), member count, and its
 *  currently open/playing tables (same `LobbyTable` shape `GET /api/lobby`
 *  uses). A 404 here reads as "no such room", not "not built yet" — the
 *  room-detail route itself may still be landing, same graceful-degrade
 *  posture as every other call in this section. */
export interface RoomDetail {
  code: string;
  name: string;
  game: { rulesetId: string; matchFormat: MatchFormat; access: TableAccess } | null;
  memberCount: number;
  tables: LobbyTable[];
  /** Members seen recently (§11.2) — NOT the whole roster, see `memberCount`.
   *  Same `LobbyHereEntry` shape `GET /api/lobby`'s `here[]` uses, since both
   *  are built off the same presence fold server-side. Optional: an older
   *  server may not send it yet. */
  players?: LobbyHereEntry[];
}
export async function getRoom(token: string, code: string): Promise<RoomDetail> {
  return apiFetch(`rooms/${encodeURIComponent(code)}`, { token });
}

/* ── friends (task brief §11.1: everyone you have played with) ──────────── */

export interface FriendEntry {
  playerId: string;
  displayName: string;
  avatar?: string | null;
  state: HereState | "offline";
  matchId?: string;
  hand?: number;
  handsBase?: number;
  rating: number | null;
  starred: boolean;
  gamesTogether: number;
  lastSeenAt?: number;
}
export async function getFriends(token: string): Promise<FriendEntry[]> {
  const data = await apiFetch<{ friends: FriendEntry[] }>("friends", { token });
  return data.friends ?? [];
}
export async function starFriend(token: string, playerId: string): Promise<void> {
  await apiFetch<void>(`friends/${encodeURIComponent(playerId)}/star`, { method: "POST", token, body: {} });
}
export async function unstarFriend(token: string, playerId: string): Promise<void> {
  await apiFetch<void>(`friends/${encodeURIComponent(playerId)}/star`, { method: "DELETE", token });
}

/* ── players (client/gamepvp/players-lab.html round 3) ───────────────────────
 * ONE list on every surface — the phone folds the filters behind an icon, the
 * desktop opens them out, and "the leaderboard" is this list sorted by rank.
 * `GET /api/friends` above is the same rows through a narrower window; both
 * come out of one code path server-side (worker/src/index.ts
 * `buildPlayerListRows`), so they can never disagree about who is online.
 */

/** The list's own presence vocabulary, which is NOT `HereState`: the lobby
 *  reads as "online" and a seat at a table nobody has started yet reads as
 *  "queue". */
export type PlayerListState = "online" | "queue" | "playing" | "offline";

export interface PlayerStatus {
  state: PlayerListState;
  /** playing: 0-based hand index — render `hand + 1`. */
  hand?: number;
  handsBase?: number;
  /** queue: seats taken at that table, e.g. `"2/4"`. */
  queue?: string;
  /** The room's NAME, when the table belongs to one. */
  room?: string;
  /** offline: ISO-8601, `players.last_seen_at`. */
  lastSeenAt?: string;
}

/** Four rank slots so the player page's tiles row never has to guess which
 *  ladders exist. Only `hk` carries a number today: Taiwanese online play does
 *  not exist here, and the two offline estimates live on the site and are not
 *  wired to the game yet. */
export interface PlayerRanks {
  hk: number | null;
  tw: number | null;
  offlineHk: number | null;
  offlineTw: number | null;
}

export interface PlayerSummary {
  id: string;
  displayName: string;
  handle: string | null;
  avatar: string | null;
  /** Has an account behind it (`players.almanac_user_id`). A false here is
   *  what the lab draws as a dashed avatar: a typed name, not a linked one. */
  linked: boolean;
  bot: false;
  status: PlayerStatus;
  /** `ranks[format]` for whichever format was asked for. */
  rank: number | null;
  ranks: PlayerRanks;
  games: number;
  winPct: number | null;
  worthPerHand: number | null;
  starred: boolean;
}

export interface PlayersQuery {
  scope?: "all" | "friends" | "online";
  format?: "hk" | "tw" | "offline";
  games?: "all" | "online" | "offline";
  sort?: "recent" | "rank" | "games" | "worth";
  q?: string;
}

/** `GET /api/players` — at most 200 rows. Every option degrades to its own
 *  default server-side rather than erroring, so a client one version behind
 *  still gets a list. */
export async function getPlayers(token: string, opts: PlayersQuery = {}): Promise<PlayerSummary[]> {
  const qs = new URLSearchParams();
  if (opts.scope) qs.set("scope", opts.scope);
  if (opts.format) qs.set("format", opts.format);
  if (opts.games) qs.set("games", opts.games);
  if (opts.sort) qs.set("sort", opts.sort);
  if (opts.q) qs.set("q", opts.q);
  const q = qs.toString();
  const data = await apiFetch<{ players: PlayerSummary[] }>(`players${q ? `?${q}` : ""}`, { token });
  return data.players ?? [];
}

/* ── inbox + direct messages (PVP-LOBBY-PROPOSAL §8, "Direct messages and
 * the inbox") ─────────────────────────────────────────────────────────── */

export type InboxKind = "invite" | "room" | "dm" | "result";
export interface InboxEntry {
  id: string;
  kind: InboxKind;
  fromPlayerId?: string;
  fromDisplayName: string;
  fromAvatar?: string | null;
  text: string;
  at: number;
  unread: boolean;
  /** Present on an `invite` — accepting mints a fresh seat token server-side
   *  rather than handing over a bare join code (§8). */
  matchId?: string;
  joinCode?: string;
  roomCode?: string;
}
export async function getInbox(token: string): Promise<InboxEntry[]> {
  const data = await apiFetch<{ inbox: InboxEntry[] }>("inbox", { token });
  return data.inbox ?? [];
}
/** Accepting a table invite returns a seat the same shape `joinTable` does —
 *  the inbox item's own seat token, never a bare code the client re-resolves
 *  itself. */
export async function acceptInbox(token: string, id: string): Promise<JoinTableResult> {
  return apiFetch(`inbox/${encodeURIComponent(id)}/accept`, { method: "POST", token, body: {} });
}
export async function dismissInbox(token: string, id: string): Promise<void> {
  await apiFetch<void>(`inbox/${encodeURIComponent(id)}/dismiss`, { method: "POST", token, body: {} });
}

export interface DmMessage {
  id: string;
  fromPlayerId: string;
  toPlayerId: string;
  text: string;
  at: number;
  readAt: number | null;
}
/** `GET /api/dm/:playerId` — the thread, last 100, oldest first. */
export async function getDm(token: string, playerId: string): Promise<DmMessage[]> {
  const data = await apiFetch<{ messages: DmMessage[] }>(`dm/${encodeURIComponent(playerId)}`, { token });
  return data.messages ?? [];
}
/** `POST /api/dm/:playerId { text }` — ≤ 500 chars, 1 per 2s (§8). */
export async function postDm(token: string, playerId: string, text: string): Promise<void> {
  await apiFetch<void>(`dm/${encodeURIComponent(playerId)}`, { method: "POST", token, body: { text } });
}

/* ── stats and leaderboards ────────────────────────────────────────────── */

/** GET /api/stats/me and GET /api/players/:id/stats — see worker/src/index.ts
 *  `getStatsFor`, the one function behind both routes. */
export interface PlayerStatsPlayer {
  id: string;
  displayName: string;
  avatar?: string | null;
  rating: number | null;
  ratingGames: number;
  /** Fewer than the engine's provisional threshold of games — show the label. */
  provisional: boolean;
}

export interface PlayerStatsTotals {
  matches: number;
  ranked: number;
  casual: number;
  /** Place-1 finishes. Same number as `places[0]`, kept separate because the
   *  stats screen shows it as its own tile. */
  wins: number;
  /** [1st, 2nd, 3rd, 4th] finishes. */
  places: [number, number, number, number];
  handsWon: number;
  selfDraws: number;
  dealIns: number;
  /** null when this player has never won a hand — nothing to average. */
  avgFaan: number | null;
  netChips: number;
  movesGraded: number;
  /** null when nothing was graded (web-only grading — see `DESKTOP` in game.ts). */
  agreement: number | null;
}

export interface PlayerStatsRecentMatch {
  matchId: string;
  endedAt: string | null;
  mode: TableMode;
  place: number | null;
  chips: number;
  /** null on a casual match, or a rated match not yet settled. */
  ratingDelta: number | null;
}

export interface PlayerStatsRatingPoint {
  at: string;
  before: number;
  after: number;
  /** null for a seed/reset/adjustment row — never happens at P0, but the
   *  server's `rating_history.kind` allows for it. */
  matchId: string | null;
}

export interface PlayerStats {
  player: PlayerStatsPlayer;
  totals: PlayerStatsTotals;
  /** Last 10, newest first. */
  recent: PlayerStatsRecentMatch[];
  /** Last 30, newest first. */
  ratingHistory: PlayerStatsRatingPoint[];
}

export async function getMyStats(token: string): Promise<PlayerStats> {
  return apiFetch("stats/me", { token });
}

export async function getPlayerStats(token: string, playerId: string): Promise<PlayerStats> {
  return apiFetch(`players/${encodeURIComponent(playerId)}/stats`, { token });
}

export type LeaderboardMode = "ranked" | "casual";

export interface RankedLeaderboardEntry {
  playerId: string;
  displayName: string;
  avatar?: string | null;
  rating: number;
  games: number;
  provisional: boolean;
}

export interface CasualLeaderboardEntry {
  playerId: string;
  displayName: string;
  avatar?: string | null;
  matches: number;
  wins: number;
  places: [number, number, number, number];
  agreement: number | null;
}

/** GET /api/leaderboard?mode=ranked|casual. Two overloads so a caller who
 *  passes a literal mode gets the matching entry shape back typed, not a
 *  union it has to narrow by hand. */
export function getLeaderboard(token: string, mode: "ranked"): Promise<{ mode: "ranked"; entries: RankedLeaderboardEntry[] }>;
export function getLeaderboard(token: string, mode: "casual"): Promise<{ mode: "casual"; entries: CasualLeaderboardEntry[] }>;
export function getLeaderboard(
  token: string,
  mode: LeaderboardMode,
): Promise<{ mode: LeaderboardMode; entries: (RankedLeaderboardEntry | CasualLeaderboardEntry)[] }> {
  return apiFetch(`leaderboard?mode=${mode}`, { token });
}

/* ── the standard stats vocabulary (PVP-LOBBY-PROPOSAL §10) ───────────────
 * One vocabulary, three datasets, produced identically by the Almanac, the
 * demo and gamepvp — GAMES · HANDS · WINS · WIN% · INS (hands paid in on) ·
 * IN% · HANDS W:L · PTS W:L · NET/HAND · WORTH/HAND. Every surface takes a
 * `StatsScope` and reads the same slice every time. */

export interface StatsScope {
  player?: string;
  players?: string[];
  room?: string;
  mode?: "ranked" | "casual";
  rulesetId?: string;
  since?: string;
  lastN?: number;
  source?: "all" | "online" | "offline";
}
function scopeQuery(scope: StatsScope): string {
  const qs = new URLSearchParams();
  if (scope.player) qs.set("player", scope.player);
  if (scope.players?.length) qs.set("players", scope.players.join(","));
  if (scope.room) qs.set("room", scope.room);
  if (scope.mode) qs.set("mode", scope.mode);
  if (scope.rulesetId) qs.set("rulesetId", scope.rulesetId);
  if (scope.since) qs.set("since", scope.since);
  if (scope.lastN) qs.set("lastN", String(scope.lastN));
  if (scope.source) qs.set("source", scope.source);
  return qs.toString();
}

/** Dataset A — one row per player in scope, the leaderboard shape. */
export interface StatsRecordRow {
  playerId: string; displayName: string; avatar?: string | null;
  games: number; hands: number; wins: number; winPct: number;
  ins: number; inPct: number;
  handsW: number; handsL: number; ptsW: number; ptsL: number;
  netPerHand: number; worthPerHand: number;
  selfDraws: number; avgWinFan: number | null;
  placements: [number, number, number, number];
  rating?: number | null; ratingGames?: number;
  streakDays: number; bestStreak: number;
  movesGraded?: number; agreement?: number | null;
}
export async function getStatsRecord(token: string, scope: StatsScope = {}): Promise<StatsRecordRow[]> {
  const q = scopeQuery(scope);
  // The Worker answers `{ players: [...] }` (one row per player in scope,
  // §10 dataset A); `rows` is accepted too so either name keeps working.
  const data = await apiFetch<{ players?: StatsRecordRow[]; rows?: StatsRecordRow[] }>(`stats/record${q ? `?${q}` : ""}`, { token });
  return data.players ?? data.rows ?? [];
}

/** Dataset B — counts, never averages of ratios. */
export interface StatsHistograms {
  fan: { byRuleset: Record<string, number[]> };
  fanByGame: number[][];
  handType: { id: string; count: number; avgFan: number; points: number }[];
  seatByRound: number[][];
  outcomes: { win: number; selfDraw: number; draw: number };
  ins: { playerId: string; displayName: string; ins: number; hands: number }[];
  feeds: {
    from: { playerId: string; displayName?: string; points: number; hands: number }[];
    to: { playerId: string; displayName?: string; points: number; hands: number }[];
  };
}
export async function getStatsHistograms(token: string, scope: StatsScope = {}): Promise<StatsHistograms> {
  const q = scopeQuery(scope);
  return apiFetch(`stats/histograms${q ? `?${q}` : ""}`, { token });
}

/** Dataset C — things over time or over hands. */
export interface StatsSeries {
  progression?: { matchId: string; hands: number[]; standings: number[][] }[];
  progressionAvg: { hands: number[]; mean: number[]; games: number[][] };
  worthByGame: { matchId: string; at: string; worth: number }[];
  rating: { at: string; before: number; after: number; matchId: string | null }[];
  activity: { day: string; games: number }[];
}
export async function getStatsSeries(token: string, scope: StatsScope = {}): Promise<StatsSeries> {
  const q = scopeQuery(scope);
  return apiFetch(`stats/series${q ? `?${q}` : ""}`, { token });
}

/** `GET /api/games/:id` (task brief §11.3/wiring) — one game's own page: the
 *  result with rating deltas, progression, the hand-by-hand table, this
 *  viewer's hands, this viewer's decisions (desktop), the game's chat, and a
 *  replay/share token. Loosely typed (`Record`) the same way `MatchDetail`
 *  already is — this client only ever reads a handful of named fields off
 *  it and has no stake in the rest of the shape drifting under it. */
export interface GameDetail {
  matchId: string;
  startedAt: string; endedAt: string | null;
  mode: TableMode; rulesetId: string; matchFormat: MatchFormat;
  roomCode: string | null; roomName: string | null;
  handCount: number;
  standings: { place: number; playerId: string; displayName: string; avatar?: string | null; chips: number; ratingBefore?: number | null; ratingAfter?: number | null; ratingDelta?: number | null }[];
  hands: Record<string, unknown>[];
  viewerSeat: number | null;
  replayToken: string | null;
  chat: LobbyChatEntry[];
}
/* ── admin observer (2026-09-03) ────────────────────────────────────────
 * GET /api/watch/:matchId — every seat's own view at once. Admin only; a
 * non-admin gets the same 404 a missing match would. `seats[i]` is exactly
 * the `SeatSnapshot` seat i's own client receives (own hand and drawn tile
 * present, the others' concealed), so four of them together show every hand. */
export interface WatchSeatOwn {
  seat: 0 | 1 | 2 | 3; wind: number; hand: number[]; drawn: number | null;
  melds: { tiles: number[] | null; kind?: string }[]; flowers: number[]; discards: number[];
  chips: number; connected: boolean; handCount: number;
}
export interface WatchSnapshot {
  handIndex: number; phase: string; seat: 0 | 1 | 2 | 3; roundWind: number; dealer: 0 | 1 | 2 | 3;
  turn: 0 | 1 | 2 | 3; wallRemaining: number; lastDiscard: { tile: number; from: 0 | 1 | 2 | 3 } | null;
  seats: (WatchSeatOwn | Record<string, unknown>)[]; standings: number[];
}
export interface WatchView {
  matchId: string; rulesetId: string; matchFormat: MatchFormat; lobbyStatus: LobbyStatus; roomCode: string | null;
  started: boolean; over: boolean;
  players: { playerId: string; displayName: string; seat: 0 | 1 | 2 | 3; bot: boolean }[];
  presence: { seat: 0 | 1 | 2 | 3; connected: boolean; botActing: boolean; botControlled: boolean }[];
  seats: WatchSnapshot[] | null;
}
export interface WatchTokens { matchId: string; rulesetId: string; matchFormat: MatchFormat; tokens: string[]; createdBy?: string; lobbyStatus?: LobbyStatus; }
export async function getWatchTokens(token: string, matchId: string): Promise<WatchTokens> {
  return apiFetch(`watch/${encodeURIComponent(matchId)}/tokens`, { token });
}
export async function getWatch(token: string, matchId: string): Promise<WatchView> {
  return apiFetch(`watch/${encodeURIComponent(matchId)}`, { token });
}

export async function getGame(token: string, matchId: string): Promise<GameDetail> {
  return apiFetch(`games/${encodeURIComponent(matchId)}`, { token });
}

/* ── the table socket ─────────────────────────────────────────────────── */

/** The requests that get an `accepted`/`rejected` reply keyed by
 *  requestId. `join`, `resync` and `heartbeat` are handled separately below —
 *  none of them answer through that channel (see messages.ts / table.ts). */
type AckRequestType = Exclude<ClientRequestType, "join" | "resync" | "heartbeat">;
type PayloadFor<T extends ClientRequestType> = Extract<ClientRequest, { type: T }>["payload"];

export class RequestRejected extends Error {
  constructor(public readonly code: RejectCode, public readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface TableSocketCallbacks {
  /** `starting`: `null` unless the table is currently in the pre-deal hold
   *  (§8a-2) — carried on `welcome` the same way `paused` already is, so a
   *  join/reload mid-hold shows the start card instead of missing it. */
  onWelcome(payload: WelcomePayload, starting: StartingPayload | null): void;
  /** `restore` carries the SAME contract as `events`: a batch to animate, plus
   *  the snapshot to snap to afterward — see the top of game.ts's consume().
   *  It also re-sends `directory`: who sits where may have changed (seats
   *  filled or shuffled) since this seat's own `welcome`. `paused` is the
   *  same field `welcome` carries — `null` means nobody has the table paused
   *  right now. `starting` mirrors `onWelcome`'s. */
  onRestore(
    events: SeatVisible<RedactedGameEvent>[],
    snapshot: SeatVisible<SeatSnapshot>,
    directory: FourSeats<SeatDirectoryEntry>,
    paused: PausedState | null,
    starting: StartingPayload | null,
    started?: boolean,
  ): void;
  onEvents(events: SeatVisible<RedactedGameEvent>[], snapshot: SeatVisible<SeatSnapshot> | null): void;
  onPrompt(payload: PromptPayload): void;
  onPresence(payload: PresencePayload): void;
  /** One new chat message, live off the socket (§8) — a bot-fill seat never
   *  produces one server-side, so this never fires for a bot. */
  onChat(payload: ChatMessagePayload): void;
  /** The table's last 50 chat messages, oldest first — handed over whole on
   *  `welcome` (a fresh join) and again on `restore` (a reconnect), same ring
   *  both times (messages.ts `WelcomePayload`/`RestorePayload`.`chat`). Fired
   *  in addition to `onWelcome`/`onRestore`, not instead of — this is just the
   *  chat slice of the same payload, pulled out so the caller's chat state
   *  doesn't have to reach into `onWelcome`'s/`onRestore`'s arguments too. */
  onChatHistory(list: ChatMessagePayload[]): void;
  /** The `paused` broadcast — not a reply to any request, a push like
   *  `presence`/`chat`, sent to every seat whenever the table's pause state
   *  changes (worker/src/table.ts `handlePause`/`resumeNow`). */
  onPaused(payload: PausedPayload): void;
  /** The `starting` push (§8a-2) — live, on an already-open socket, once
   *  before the first turn. `onWelcome`/`onRestore` cover the "already
   *  holding when this socket connects" case; this covers "starts holding
   *  while connected" (every human seat just filled). */
  onStarting(payload: StartingPayload): void;
  onFault(payload: ProtocolFaultPayload): void;
  /** The `join` itself was refused — a dead seat token, most likely. The
   *  caller's job is to fetch a fresh one (joinTable) and call setSeatToken. */
  onJoinRejected(payload: RejectedPayload): void;
  onClose(info: { code: number; reason: string; willRetry: boolean }): void;
  /** Fires once per open socket, right after `welcome` is applied — a good
   *  moment to clear a "reconnecting…" banner. */
  onOpen?(): void;
}

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** No message at all (not even a heartbeat) for this long means the socket is
 *  quietly dead — force a close so the reconnect loop takes over. */
const STALL_MS = 45_000;

/** One seat's live connection to one table. */
export class TableSocket {
  private ws: WebSocket | null = null;
  private seatToken: string;
  private readonly matchId: string;
  private readonly cb: TableSocketCallbacks;
  private closedByUser = false;
  private backoffMs = BASE_BACKOFF_MS;
  private reconnectTimer = 0;
  private stallTimer = 0;
  private lastMessageAt = 0;
  private pendingJoinId: string | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (v: AcceptedPayload) => void; reject: (e: Error) => void; timer: number }
  >();

  constructor(matchId: string, seatToken: string, cb: TableSocketCallbacks) {
    this.matchId = matchId;
    this.seatToken = seatToken;
    this.cb = cb;
  }

  /** Called after a `join` comes back `unauthenticated` — hand it the fresh
   *  token from `joinTable()` and the next connect attempt uses it. */
  setSeatToken(token: string): void {
    this.seatToken = token;
  }

  /** Re-send `join` — over the existing socket if it is still open (the
   *  server does not close the connection on a `rejected` join, so a fresh
   *  seat token can be retried without a whole new WebSocket), otherwise by
   *  reconnecting from scratch. */
  rejoin(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.sendJoin();
    else this.connect();
  }

  connect(): void {
    this.closedByUser = false;
    window.clearTimeout(this.reconnectTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/table/${encodeURIComponent(this.matchId)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastMessageAt = Date.now();
    this.armStallWatch();
    ws.addEventListener("open", () => this.sendJoin());
    ws.addEventListener("message", (e) => this.handleMessage(e));
    ws.addEventListener("close", (e) => this.handleClose(e));
    ws.addEventListener("error", () => {
      /* the close event follows; nothing to do here */
    });
  }

  /** Intentional shutdown — a finished match, or the player leaving. No
   *  further reconnect attempts. */
  close(): void {
    this.closedByUser = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.stallTimer);
    for (const { reject, timer } of this.pending.values()) {
      window.clearTimeout(timer);
      reject(new Error("socket closed"));
    }
    this.pending.clear();
    try {
      this.ws?.close(1000, "client closed");
    } catch {
      /* already gone */
    }
    this.ws = null;
  }

  /** §5.3 reconnect: snapshot + actions-since. Fire-and-forget — the answer
   *  arrives as a `restore` message, not through the accepted/rejected map
   *  (table.ts's resync handler never sends either). */
  resync(sinceSeq: number): void {
    this.sendRaw({
      p: PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      type: "resync",
      payload: { sinceSeq },
    });
  }

  /** One of the request* types. Resolves on `accepted`, rejects with
   *  `RequestRejected` on `rejected`, or on a timeout if the socket drops
   *  the exchange entirely (a retry after reconnect is the caller's job —
   *  the UI's job is only to re-enable the control). */
  /** `chat { text }` or `chat { phrase }` — exactly one, never both
   *  (`ChatRequestPayload`'s doc comment in messages.ts). Just a typed
   *  wrapper over `request("chat", …)`: the server answers `accepted`, or
   *  `rejected` with `chatRefused` (game.ts's `REJECT_NOTES`), through the
   *  same requestId map every other request uses. */
  sendChat(payload: { text: string } | { phrase: ChatPhrase }): Promise<AcceptedPayload> {
    return this.request("chat", payload as ChatRequestPayload);
  }

  request<T extends AckRequestType>(type: T, payload: PayloadFor<T>): Promise<AcceptedPayload> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const requestId = crypto.randomUUID();
    return new Promise<AcceptedPayload>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.sendRaw({ p: PROTOCOL_VERSION, requestId, type, payload } as ClientRequest);
    });
  }

  /** `requestNextHand {}` — sent during the handEnd intermission; the server
   *  ends it early once every connected human has sent one. */
  requestNextHand(): Promise<AcceptedPayload> {
    return this.request("requestNextHand", {});
  }
  /** Any human seat may pause or resume the table. */
  requestPause(): Promise<AcceptedPayload> {
    return this.request("requestPause", {});
  }
  requestResume(): Promise<AcceptedPayload> {
    return this.request("requestResume", {});
  }
  /** Player-toggled auto-play — see `RequestAutoPayload`'s doc comment. */
  requestAuto(on: boolean): Promise<AcceptedPayload> {
    return this.request("requestAuto", { on });
  }

  private sendJoin(): void {
    const requestId = crypto.randomUUID();
    this.pendingJoinId = requestId;
    this.sendRaw({
      p: PROTOCOL_VERSION,
      requestId,
      type: "join",
      payload: { matchId: this.matchId, seatToken: this.seatToken },
    });
  }

  private sendRaw(msg: ClientRequest): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      /* the close handler will pick this up and reconnect */
    }
  }

  private armStallWatch(): void {
    window.clearTimeout(this.stallTimer);
    this.stallTimer = window.setTimeout(() => {
      if (Date.now() - this.lastMessageAt >= STALL_MS) {
        try {
          this.ws?.close(4001, "stalled");
        } catch {
          /* ignore */
        }
      } else {
        this.armStallWatch();
      }
    }, STALL_MS);
  }

  private handleMessage(ev: MessageEvent): void {
    this.lastMessageAt = Date.now();
    let raw: unknown;
    try {
      raw = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object" || !("type" in raw)) return;
    // `starting` (§8a-2) is not yet in protocol/src/messages.ts's
    // `ServerToSeat` union — see `StartingPayload`'s doc comment above.
    // Handled here, off the raw parse, before narrowing to the typed union
    // below, so a server that already sends it works without waiting on
    // that type to land, and a server that never sends it just never hits
    // this branch (graceful degrade, per the task brief).
    if ((raw as { type: unknown }).type === "starting") {
      this.cb.onStarting((raw as unknown as { payload: StartingPayload }).payload);
      return;
    }
    const msg = raw as ServerToSeat;
    switch (msg.type) {
      case "welcome": {
        this.pendingJoinId = null;
        this.backoffMs = BASE_BACKOFF_MS;
        this.cb.onOpen?.();
        const starting = (msg.payload as WelcomePayload & { starting?: StartingPayload | null }).starting ?? null;
        this.cb.onWelcome(msg.payload, starting);
        this.cb.onChatHistory(msg.payload.chat);
        break;
      }
      case "restore": {
        const p = msg.payload as RestorePayload & { starting?: StartingPayload | null };
        this.cb.onRestore(p.events, p.snapshot, p.directory, p.paused, p.starting ?? null, p.started);
        this.cb.onChatHistory(p.chat);
        break;
      }
      case "events": {
        const p = msg.payload;
        this.cb.onEvents(p.events, p.snapshot ?? null);
        break;
      }
      case "chat":
        this.cb.onChat(msg.payload);
        break;
      case "prompt":
        this.cb.onPrompt(msg.payload);
        break;
      case "presence":
        this.cb.onPresence(msg.payload);
        break;
      case "paused":
        this.cb.onPaused(msg.payload);
        break;
      case "accepted": {
        const pend = this.pending.get(msg.payload.requestId);
        if (pend) {
          window.clearTimeout(pend.timer);
          this.pending.delete(msg.payload.requestId);
          pend.resolve(msg.payload);
        }
        break;
      }
      case "rejected": {
        if (msg.payload.requestId === this.pendingJoinId) {
          this.pendingJoinId = null;
          this.cb.onJoinRejected(msg.payload);
          break;
        }
        const pend = this.pending.get(msg.payload.requestId);
        if (pend) {
          window.clearTimeout(pend.timer);
          this.pending.delete(msg.payload.requestId);
          pend.reject(new RequestRejected(msg.payload.code, msg.payload.detail));
        }
        break;
      }
      case "heartbeat":
        this.sendRaw({ p: PROTOCOL_VERSION, requestId: crypto.randomUUID(), type: "heartbeat", payload: {} });
        break;
      case "protocolFault":
        this.cb.onFault(msg.payload);
        break;
    }
  }

  private handleClose(e: CloseEvent): void {
    this.ws = null;
    window.clearTimeout(this.stallTimer);
    const willRetry = !this.closedByUser && e.code !== 1000;
    this.cb.onClose({ code: e.code, reason: e.reason, willRetry });
    if (willRetry) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.6 + Math.random() * 200, MAX_BACKOFF_MS);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }
}

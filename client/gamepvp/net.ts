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
  ClientRequest,
  ClientRequestType,
  PresencePayload,
  ProtocolFaultPayload,
  PromptPayload,
  RejectCode,
  RejectedPayload,
  RestorePayload,
  ServerToSeat,
  WelcomePayload,
} from "../../protocol/src/messages.js";
import { PROTOCOL_VERSION } from "../../protocol/src/messages.js";
import type { RedactedGameEvent, SeatSnapshot, SeatVisible } from "../../protocol/src/events.js";

/* ── identity ──────────────────────────────────────────────────────────── */

const LS_TOKEN = "mjrc.gamepvp.deviceToken";
const LS_NAME = "mjrc.gamepvp.displayName";
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
  rating: number | null;
  deviceToken: string;
}

/** What is on this device already, before the player has typed anything. */
export function storedIdentity(): { deviceToken: string | null; displayName: string | null } {
  return { deviceToken: localStorage.getItem(LS_TOKEN), displayName: localStorage.getItem(LS_NAME) };
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
 *  calling again with a new name just renames. */
export async function identify(displayName: string): Promise<Identity> {
  const token = localStorage.getItem(LS_TOKEN) ?? mintDeviceToken();
  const data = await apiFetch<{ playerId: string; displayName: string; rating: number | null }>(
    "identity",
    { method: "POST", body: { deviceToken: token, displayName } },
  );
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_NAME, data.displayName);
  localStorage.setItem(LS_PLAYER, data.playerId);
  return { playerId: data.playerId, displayName: data.displayName, rating: data.rating ?? null, deviceToken: token };
}

/* ── lobby: tables and match history ──────────────────────────────────── */

export type MatchFormat = "east" | "full";
export type TableMode = "casual" | "ranked";
export type TableAccess = "open" | "private";

export interface CreateTableResult {
  tableId: string;
  matchUuid: string;
  joinCode: string;
  seat: 0 | 1 | 2 | 3;
  seatToken: string;
  seatTokenExpiresAt: string;
  rulesetId: string;
  rulesetHash: string;
  engineVersion: string;
  matchFormat: MatchFormat;
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
  displayName?: string;
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
  hand?: number;
  handsBase?: number;
  seats: LobbyTableSeat[];
  /** The creator's player id (schema.sql `matches.created_by`) — not a
   *  display name. The lobby screen resolves a name from `seats` instead. */
  createdBy: string;
  startedAt: number;
}

export interface LobbyRecentStanding {
  displayName: string;
  chips: number;
  place: number;
}

export interface LobbyRecentMatch {
  matchId: string;
  endedAt: number;
  mode: TableMode;
  standings: LobbyRecentStanding[];
}

export interface LobbyPayload {
  now: number;
  here: LobbyHereEntry[];
  tables: LobbyTable[];
  recent: LobbyRecentMatch[];
}

export async function getLobby(token: string): Promise<LobbyPayload> {
  return apiFetch("lobby", { token });
}

/** POST /api/presence — sent every 30s while the app is open and visible,
 *  and once more on `visibilitychange` back to visible. */
export async function postPresence(token: string, state: PresenceState): Promise<void> {
  await apiFetch<void>("presence", { method: "POST", token, body: { state } });
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

/* ── the table socket ─────────────────────────────────────────────────── */

/** The seven requests that get an `accepted`/`rejected` reply keyed by
 *  requestId. `join`, `resync` and `heartbeat` are handled separately below —
 *  none of them answer through that channel (see messages.ts / table.ts). */
type AckRequestType = Exclude<ClientRequestType, "join" | "resync" | "heartbeat">;
type PayloadFor<T extends ClientRequestType> = Extract<ClientRequest, { type: T }>["payload"];

export class RequestRejected extends Error {
  constructor(public readonly code: RejectCode, public readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** The `events`/`restore` payload as this build's server actually sends it.
 *  `messages.ts`'s `EventsPayload` does not carry `snapshot` yet — the server
 *  side of that change is landing at the same time as this client (see the
 *  task brief) — so this is coded to the documented wire shape rather than
 *  the (temporarily stale) type import. Treated as always present. */
interface EventsPayloadWire {
  events: SeatVisible<RedactedGameEvent>[];
  snapshot?: SeatVisible<SeatSnapshot>;
}

export interface TableSocketCallbacks {
  onWelcome(payload: WelcomePayload): void;
  /** `restore` carries the SAME contract as `events`: a batch to animate, plus
   *  the snapshot to snap to afterward — see the top of game.ts's consume(). */
  onRestore(events: SeatVisible<RedactedGameEvent>[], snapshot: SeatVisible<SeatSnapshot>): void;
  onEvents(events: SeatVisible<RedactedGameEvent>[], snapshot: SeatVisible<SeatSnapshot> | null): void;
  onPrompt(payload: PromptPayload): void;
  onPresence(payload: PresencePayload): void;
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

  /** One of the seven request* types. Resolves on `accepted`, rejects with
   *  `RequestRejected` on `rejected`, or on a timeout if the socket drops
   *  the exchange entirely (a retry after reconnect is the caller's job —
   *  the UI's job is only to re-enable the control). */
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
    let msg: ServerToSeat;
    try {
      msg = JSON.parse(ev.data as string) as ServerToSeat;
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        this.pendingJoinId = null;
        this.backoffMs = BASE_BACKOFF_MS;
        this.cb.onOpen?.();
        this.cb.onWelcome(msg.payload);
        break;
      case "restore": {
        const p = msg.payload as RestorePayload;
        this.cb.onRestore(p.events, p.snapshot);
        break;
      }
      case "events": {
        const p = msg.payload as unknown as EventsPayloadWire;
        this.cb.onEvents(p.events, p.snapshot ?? null);
        break;
      }
      case "prompt":
        this.cb.onPrompt(msg.payload);
        break;
      case "presence":
        this.cb.onPresence(msg.payload);
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

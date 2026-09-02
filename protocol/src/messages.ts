/**
 * Versioned client↔server messages. Implements DESIGN.md §5.3 and §5.5.
 * Terminology: ../../TERMINOLOGY.md.
 *
 * DOCTRINE: the client has ZERO authority. Every message it can send is a
 * REQUEST; the server decides, mutates, and reports the outcome as events.
 * That is why no client message is named after a state transition — there is
 * no `discard`, only `requestDiscard`. A client that "knows" it discarded is
 * predicting, and prediction is corrected by the next event batch.
 *
 * The seat socket carries `SeatVisible<…>` data only. Omniscient data has no
 * message type in this file AT ALL — it goes to the R2 archive and nowhere
 * else — and the `Omniscient<T>` brand makes trying to smuggle it into
 * `ServerToSeat` a compile error rather than a code-review catch (§5.5).
 */
import type { ClaimOption, SeatIndex, TileId } from "@mjrc/engine";
import type {
  FourSeats,
  RedactedGameEvent,
  SeatSnapshot,
  SeatVisible,
} from "./events.js";

/** Bump only for a breaking change. Sent on every message, both directions. */
export const PROTOCOL_VERSION = 1;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Versions this build can still serve. Old clients get a clear refusal. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

export const acceptsProtocolVersion = (v: number): boolean =>
  SUPPORTED_PROTOCOL_VERSIONS.includes(v);

/* ── client → server ───────────────────────────────────────────────────── */

export interface RequestEnvelope<T extends string, P> {
  p: ProtocolVersion;
  /**
   * Client-generated and unique per connection. The server echoes it on
   * `accepted`/`rejected`, so a retry after a flaky send is identifiable
   * rather than a second discard.
   */
  requestId: string;
  type: T;
  payload: P;
}

export interface JoinPayload {
  matchId: string;
  /**
   * The one-time credential the lobby issued (§5.3). The lobby never proxies
   * match traffic; this token is what binds a socket to a seat, and it is also
   * what lets a reconnecting player reclaim their seat from a bot.
   */
  seatToken: string;
  /**
   * What kind of client this seat is playing from, recorded on the match so
   * web and app behaviour stay comparable in the data later. Optional; a
   * client that omits it is recorded as unknown.
   */
  client?: ClientInfo;
}

export interface ClientInfo {
  kind: "web" | "ios" | "android" | "desktop" | "headless";
  /** A build id, e.g. a short commit hash. Free text, ≤ 40 chars. */
  version: string;
}

/** Reconnect, the snapshot + actions-since shape (§5.3). */
export interface ResyncPayload {
  /**
   * Last `seq` the client folded in. The server replies with a `restore`
   * carrying a fresh snapshot plus every seat-visible event after this.
   * Send -1 for "I have nothing, send me everything from the snapshot".
   */
  sinceSeq: number;
}

export interface RequestDiscardPayload {
  tile: TileId;
  /* 摸切 drawAndCut is DERIVED by the server from whether this is the drawn
     tile. A client-asserted flag would be a client-authored fact. */
}

export interface RequestClaimPayload {
  /**
   * The `seq` of the `claimOffered` event this answers. Anchoring the request
   * to the offer means a late click on a window that already closed is
   * rejected as stale instead of landing on the next discard.
   */
  offerSeq: number;
  option: ClaimOption;
}

export interface RequestPassPayload {
  offerSeq: number;
}

export interface RequestKongPayload {
  tile: TileId;
}

/**
 * Quick phrases for phones (PVP-LOBBY-PROPOSAL-2026-09-02.md §8): 好牌 nice ·
 * 快啲 hurry · 唔好意思 sorry · 再嚟 again · 👍 thumbs. Stable ids, never display
 * strings — same TERMINOLOGY.md discipline as every other pattern id in this
 * repo (e.g. FaanAward.id): the client renders and localises, the wire never
 * carries a sentence for these.
 */
export type ChatPhrase = "nice" | "hurry" | "sorry" | "again" | "thumbs";

export const CHAT_PHRASES = [
  "nice",
  "hurry",
  "sorry",
  "again",
  "thumbs",
] as const satisfies readonly ChatPhrase[];

export const isChatPhrase = (v: unknown): v is ChatPhrase =>
  typeof v === "string" && (CHAT_PHRASES as readonly string[]).includes(v);

/** Trimmed-length cap on free-text chat (§8). Table chat and lobby chat both
 *  enforce this — one number, read from here rather than restated per site. */
export const CHAT_TEXT_MAX_LENGTH = 200;

/**
 * `chat { text? }` or `chat { phrase? }` — exactly one, never both, never
 * neither. That EXACTLY-ONE rule is a request-validity question, so it is
 * enforced where every other request-validity question is (the table, §8),
 * not encoded in this type: a union of two payload shapes would just move the
 * same branch into the type checker without buying anything runtime
 * validation does not already have to do anyway (trimming, the length cap).
 */
export interface ChatRequestPayload {
  text?: string;
  phrase?: ChatPhrase;
}

export interface RequestWinOnDiscardPayload {
  offerSeq: number;
}

/** 搶槓 — answers a `robKongWindow`, which only ever offers a win. */
export interface RequestRobKongPayload {
  offerSeq: number;
}

/**
 * `requestAuto { on }` — player-toggled auto-play: while on, the table plays
 * this seat exactly as it does after a disconnect takeover (the bot brain, on
 * `botPace` pacing, over the same redacted view) until the player turns it
 * off or sends any game request themselves, which turns it off first and then
 * applies the move as normal (worker/src/table.ts `submit`).
 */
export interface RequestAutoPayload {
  on: boolean;
}

export type ClientRequest =
  | RequestEnvelope<"join", JoinPayload>
  | RequestEnvelope<"resync", ResyncPayload>
  | RequestEnvelope<"heartbeat", Record<string, never>>
  /** Table chat (§8). Never a game event, never in the event log or the R2
   *  archive — see ../../worker/src/table.ts's handling for why. */
  | RequestEnvelope<"chat", ChatRequestPayload>
  | RequestEnvelope<"requestDiscard", RequestDiscardPayload>
  | RequestEnvelope<"requestClaim", RequestClaimPayload>
  | RequestEnvelope<"requestPass", RequestPassPayload>
  /** 暗槓, declared on your own turn. */
  | RequestEnvelope<"requestConcealedKong", RequestKongPayload>
  /** 加槓, added onto your own exposed pung; opens a rob window. */
  | RequestEnvelope<"requestAddedKong", RequestKongPayload>
  /** 食糊 off a discard. */
  | RequestEnvelope<"requestWinOnDiscard", RequestWinOnDiscardPayload>
  | RequestEnvelope<"requestRobKong", RequestRobKongPayload>
  /** 自摸 on your own draw. */
  | RequestEnvelope<"requestWinOnSelfDraw", Record<string, never>>
  /** Any human seat may pause or resume the table (live-demo feature). */
  | RequestEnvelope<"requestPause", Record<string, never>>
  | RequestEnvelope<"requestResume", Record<string, never>>
  /** Ends the hand-end intermission early once every connected human seat
   *  has sent it. */
  | RequestEnvelope<"requestNextHand", Record<string, never>>
  | RequestEnvelope<"requestAuto", RequestAutoPayload>;

export type ClientRequestType = ClientRequest["type"];

export const CLIENT_REQUEST_TYPES = [
  "join",
  "resync",
  "heartbeat",
  "chat",
  "requestDiscard",
  "requestClaim",
  "requestPass",
  "requestConcealedKong",
  "requestAddedKong",
  "requestWinOnDiscard",
  "requestRobKong",
  "requestWinOnSelfDraw",
  "requestPause",
  "requestResume",
  "requestNextHand",
  "requestAuto",
] as const satisfies readonly ClientRequestType[];

type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time proof the runtime list matches the union exactly. */
const _requestTypesAreComplete: SameKeys<
  (typeof CLIENT_REQUEST_TYPES)[number],
  ClientRequestType
> = true;
void _requestTypesAreComplete;

/**
 * Cheap shape check before the request reaches the reducer. Everything past
 * this is still validated by the server against the real state — a well-formed
 * message is not a legal action.
 */
export function isKnownRequestType(t: unknown): t is ClientRequestType {
  return typeof t === "string" && (CLIENT_REQUEST_TYPES as readonly string[]).includes(t);
}

/* ── server → seat socket ──────────────────────────────────────────────── */

export interface ServerEnvelope<T extends string, P> {
  p: ProtocolVersion;
  type: T;
  payload: P;
}

/** Public identity of a seat. No tokens, no wall, no tiles. */
export interface SeatDirectoryEntry {
  seat: SeatIndex;
  playerId: string;
  displayName: string;
  bot: boolean;
  connected: boolean;
  /** Player-toggled auto-play is on for this seat (§`RequestAutoPayload`). */
  auto: boolean;
}

/**
 * One chat message as it reaches a seat socket, table or lobby (§8). `text`
 * XOR `phrase` — the table enforces exactly-one on the way in
 * (`ChatRequestPayload`'s doc comment); this is just the settled record of
 * which one won. `ts` is the DO's wall clock, stamped the same way every
 * other event's `ts` is (never the client's).
 */
export interface ChatMessagePayload {
  seat: SeatIndex;
  displayName: string;
  text?: string;
  phrase?: ChatPhrase;
  ts: number;
}

/** Who has the table paused, and since when (worker/src/table.ts `book.paused`). */
export interface PausedState {
  bySeat: SeatIndex;
  displayName: string;
  since: number;
}

export interface WelcomePayload {
  matchId: string;
  /** The seat this socket is bound to. Every redaction is relative to it. */
  seat: SeatIndex;
  /** Pinned on the header too; repeated here so the client can refuse a mismatch. */
  engineVersion: string;
  rulesetId: string;
  directory: FourSeats<SeatDirectoryEntry>;
  snapshot: SeatVisible<SeatSnapshot>;
  /** The table's last 50 chat messages (§8), oldest first, so a joiner meets
   *  the conversation already in progress. */
  chat: ChatMessagePayload[];
  /** `null` unless the table is currently paused. */
  paused: PausedState | null;
}

/** The reply to `resync`: snapshot + everything after it (§5.3). */
export interface RestorePayload {
  snapshot: SeatVisible<SeatSnapshot>;
  events: SeatVisible<RedactedGameEvent>[];
  /** Who sits where now — seats filled or shuffled since the welcome. */
  directory: FourSeats<SeatDirectoryEntry>;
  /** Same ring `WelcomePayload.chat` carries — a reconnect gets chat history
   *  exactly like a fresh join does (§8). */
  chat: ChatMessagePayload[];
  /** `null` unless the table is currently paused. */
  paused: PausedState | null;
}

export interface EventsPayload {
  events: SeatVisible<RedactedGameEvent>[];
  /**
   * This seat's snapshot AFTER the batch was applied. The live table always
   * sends it, so a client animates the events and then snaps to the snapshot
   * rather than folding events into state itself — the client holds no game
   * logic (DESIGN.md §5), and this is what makes that cheap. Optional in the
   * type only so a log-fed replay can stream events without one.
   */
  snapshot?: SeatVisible<SeatSnapshot>;
}

/**
 * What this seat may legally request right now, with the deadline it expires
 * on. Not an event — prompts are transport, and they are per-socket so an
 * onlooker cannot infer a held claim from the fact one was sent (§5.2).
 */
export interface LegalRequests {
  /** Tiles this seat may discard. Empty when it is not this seat's turn. */
  discard: TileId[];
  /** 暗槓 declarable now. */
  concealedKong: TileId[];
  /** 加槓 declarable now — tiles matching one of this seat's exposed pungs. */
  addedKong: TileId[];
  /** 自摸 available on the drawn tile, and it clears the faan minimum. */
  winOnSelfDraw: boolean;
  /** Open claim window against a discard, if this seat has any option in it. */
  claims: {
    offerSeq: number;
    tile: TileId;
    from: SeatIndex;
    options: ClaimOption[];
  } | null;
  /** Open 搶槓 window, if this seat can rob the added kong. */
  robKong: { offerSeq: number; tile: TileId; from: SeatIndex } | null;
}

export interface PromptPayload {
  legal: LegalRequests;
  /** Unix ms. The server acts for the seat when it passes; nothing hangs. */
  deadlineTs: number;
}

export interface AcceptedPayload {
  requestId: string;
  /** `seq` of the first event the request produced, for client reconciliation. */
  seq: number;
}

/**
 * Why a request was refused. NOTE what is NOT here: a win under the faan
 * minimum is NOT a rejection. It is accepted, then answered with a visible
 * `refusedWin` event, because it is a teaching moment and belongs in the log
 * and in the replay (§5.2). Rejections are for messages that were never a
 * coherent move in the first place.
 */
export type RejectCode =
  | "unauthenticated"
  | "notYourTurn"
  | "tileNotHeld"
  | "notALegalMove"
  | "staleOffer"
  | "windowClosed"
  | "duplicateRequest"
  | "rateLimited"
  | "matchOver"
  /** A `chat` request that failed validation: neither/both of text and
   *  phrase set, text too long, the per-seat 1/s limit, or a bot seat (bots
   *  never chat, §8). */
  | "chatRefused"
  /** `requestPause`/`requestResume` refused: a bot seat, the table is not
   *  full, the match is over, or the request does not match the current
   *  pause state (pausing while already paused, resuming while not). */
  | "pauseRefused"
  /** Any game request (`request*`) sent while the table is paused. */
  | "paused"
  /** `requestAuto` refused: a bot seat, or the table is not full. */
  | "autoRefused";

export interface RejectedPayload {
  requestId: string;
  code: RejectCode;
  /** Human-readable, for logs and dev clients. Never parsed by the client. */
  detail?: string;
}

export interface PresencePayload {
  seat: SeatIndex;
  connected: boolean;
  /**
   * The seat's current identity. A player who joins AFTER your welcome is
   * otherwise a nameless seat to you: the directory rides on `welcome` only,
   * so presence carries enough to keep every client's directory current.
   * `playerId` is "" for an unfilled human seat.
   */
  playerId: string;
  displayName: string;
  bot: boolean;
  /**
   * Set while a bot is playing a disconnected seat (§5.3 grace → takeover), so
   * the table can show it rather than letting the seat look merely slow.
   */
  botActing: boolean;
  /**
   * Player-toggled auto-play (`RequestAutoPayload`), distinct from
   * `botActing`: it survives a reconnect and only a fresh game request or an
   * explicit `requestAuto { on: false }` clears it.
   */
  auto: boolean;
}

/**
 * Broadcast on both a pause and a resume (worker/src/table.ts `handlePause` /
 * `resumeNow`). `bySeat`/`displayName` name the seat that paused the table;
 * on an auto-resume (`TableConfig.pauseMaxMs` elapsed with nobody resuming)
 * they are still the pauser's, since nobody else acted.
 */
export interface PausedPayload {
  on: boolean;
  bySeat: SeatIndex;
  displayName: string;
  ts: number;
}

/** Transport-level failure, distinct from a refused move. */
export type ProtocolFaultCode =
  | "unsupportedProtocolVersion"
  | "malformedMessage"
  | "unknownRequestType"
  | "notJoined";

export interface ProtocolFaultPayload {
  code: ProtocolFaultCode;
  supported?: readonly number[];
  detail?: string;
}

/**
 * Everything the server may put on a seat socket.
 *
 * The type-level guard lives here: every payload that carries game data is
 * `SeatVisible<…>`, and `Omniscient<T>` carries a different `__view` brand, so
 * assigning an omniscient event or an unredacted snapshot into one of these is
 * a compile error. Structural typing alone would not catch it — an omniscient
 * payload is a supertype of its redacted form.
 */
export type ServerToSeat =
  | ServerEnvelope<"welcome", WelcomePayload>
  | ServerEnvelope<"restore", RestorePayload>
  | ServerEnvelope<"events", EventsPayload>
  | ServerEnvelope<"chat", ChatMessagePayload>
  | ServerEnvelope<"prompt", PromptPayload>
  | ServerEnvelope<"accepted", AcceptedPayload>
  | ServerEnvelope<"rejected", RejectedPayload>
  | ServerEnvelope<"presence", PresencePayload>
  | ServerEnvelope<"paused", PausedPayload>
  | ServerEnvelope<"heartbeat", Record<string, never>>
  | ServerEnvelope<"protocolFault", ProtocolFaultPayload>;

export type ServerToSeatType = ServerToSeat["type"];

/* ── constructors ──────────────────────────────────────────────────────── */

/** Push a batch of already-redacted events. There is no unredacted overload. */
export const eventsMessage = (
  events: SeatVisible<RedactedGameEvent>[],
  snapshot?: SeatVisible<SeatSnapshot>,
): ServerToSeat => ({
  p: PROTOCOL_VERSION,
  type: "events",
  payload: snapshot ? { events, snapshot } : { events },
});

/** Broadcast one settled chat message (§8) to a seat socket. */
export const chatMessage = (payload: ChatMessagePayload): ServerToSeat => ({
  p: PROTOCOL_VERSION,
  type: "chat",
  payload,
});

export const rejected = (
  requestId: string,
  code: RejectCode,
  detail?: string,
): ServerToSeat => ({ p: PROTOCOL_VERSION, type: "rejected", payload: { requestId, code, detail } });

export const accepted = (requestId: string, seq: number): ServerToSeat => ({
  p: PROTOCOL_VERSION,
  type: "accepted",
  payload: { requestId, seq },
});

export const protocolFault = (
  code: ProtocolFaultCode,
  detail?: string,
): ServerToSeat => ({
  p: PROTOCOL_VERSION,
  type: "protocolFault",
  payload: {
    code,
    supported: code === "unsupportedProtocolVersion" ? SUPPORTED_PROTOCOL_VERSIONS : undefined,
    detail,
  },
});

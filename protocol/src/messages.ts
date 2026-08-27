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

export interface RequestWinOnDiscardPayload {
  offerSeq: number;
}

/** 搶槓 — answers a `robKongWindow`, which only ever offers a win. */
export interface RequestRobKongPayload {
  offerSeq: number;
}

export type ClientRequest =
  | RequestEnvelope<"join", JoinPayload>
  | RequestEnvelope<"resync", ResyncPayload>
  | RequestEnvelope<"heartbeat", Record<string, never>>
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
  | RequestEnvelope<"requestWinOnSelfDraw", Record<string, never>>;

export type ClientRequestType = ClientRequest["type"];

export const CLIENT_REQUEST_TYPES = [
  "join",
  "resync",
  "heartbeat",
  "requestDiscard",
  "requestClaim",
  "requestPass",
  "requestConcealedKong",
  "requestAddedKong",
  "requestWinOnDiscard",
  "requestRobKong",
  "requestWinOnSelfDraw",
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
}

/** The reply to `resync`: snapshot + everything after it (§5.3). */
export interface RestorePayload {
  snapshot: SeatVisible<SeatSnapshot>;
  events: SeatVisible<RedactedGameEvent>[];
}

export interface EventsPayload {
  events: SeatVisible<RedactedGameEvent>[];
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
  | "matchOver";

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
   * Set while a bot is playing a disconnected seat (§5.3 grace → takeover), so
   * the table can show it rather than letting the seat look merely slow.
   */
  botActing: boolean;
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
  | ServerEnvelope<"prompt", PromptPayload>
  | ServerEnvelope<"accepted", AcceptedPayload>
  | ServerEnvelope<"rejected", RejectedPayload>
  | ServerEnvelope<"presence", PresencePayload>
  | ServerEnvelope<"heartbeat", Record<string, never>>
  | ServerEnvelope<"protocolFault", ProtocolFaultPayload>;

export type ServerToSeatType = ServerToSeat["type"];

/* ── constructors ──────────────────────────────────────────────────────── */

/** Push a batch of already-redacted events. There is no unredacted overload. */
export const eventsMessage = (
  events: SeatVisible<RedactedGameEvent>[],
): ServerToSeat => ({ p: PROTOCOL_VERSION, type: "events", payload: { events } });

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

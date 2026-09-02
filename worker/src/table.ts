/**
 * The table — one Durable Object per match. Implements DESIGN.md §5.3, over the
 * event schema of §5.5 and the state machine of §5.2. Terminology: ../../TERMINOLOGY.md.
 *
 * Lifted from mj-queue (`../../mj-queue/src/board.ts`): lazy hydration,
 * hibernation-enabled `acceptWebSocket`, `serializeAttachment` for socket
 * identity, persist-then-broadcast commit. Its anti-patterns are fixed here:
 *
 *  1. mj-queue broadcasts ONE omniscient snapshot to every socket. This object
 *     exists to kill that: `viewFor(seat)` and `redactEventsFor(seat, …)` are
 *     the only ways game data reaches a socket, and the `SeatVisible` brand
 *     makes an omniscient leak a compile error rather than a review catch.
 *
 *  2. A DO HAS EXACTLY ONE ALARM AND `setAlarm()` OVERWRITES. mj-queue never
 *     needed one; a table needs four kinds at once. A named deadline map is
 *     persisted, `setAlarm(min(all))` is re-derived after every change, and
 *     `alarm()` dispatches EVERY due entry before re-arming. Without this a
 *     claim window silently clobbers a disconnect grace and the table hangs
 *     forever — the single easiest thing in this file to get wrong.
 *
 *  3. Fire-and-forget archival becomes an outbox: a hand's events stay in DO
 *     storage until BOTH the R2 blob part and the D1 `hands` row are confirmed,
 *     retried through the same deadline map. The DO is disposable at MATCH_END,
 *     not hand end.
 *
 * WHAT THIS OBJECT MAY NOT DO: decide anything about the game. It sequences,
 * times, persists, redacts and broadcasts. Every rule question goes to the
 * reducer (`TableRules`) and every bot question to `BotBrain`. If you find
 * yourself reading a tile in here, you are writing the reducer in the wrong file.
 *
 * Determinism (§5.5): the reducer never sees a clock. The DO stamps `ts`,
 * `seq` and deadline fields onto events AFTER the reducer has produced them,
 * because all three are coordination facts, not game facts — and a pure
 * reducer could not produce a wall clock even if it wanted to. Every random
 * number in here comes from `prng(seed)`; there is no `Math.random` and no
 * unordered key iteration on any path that affects state.
 */
import { prng } from "@mjrc/engine";
import type {
  Action,
  ClaimOption,
  FaanAward,
  GameState,
  SeatIndex,
  TileId,
  WindIndex,
} from "@mjrc/engine";
import {
  EVENT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  acceptsProtocolVersion,
  accepted,
  assertEventStreamWellFormed,
  eventsMessage,
  isKnownRequestType,
  omniscientMatchLog,
  protocolFault,
  redactEventsFor,
  rejected,
  snapshotFor,
} from "@mjrc/protocol";
import type {
  ClientRequest,
  FourSeats,
  GameEvent,
  HandEndPayload,
  LegalRequests,
  MatchEndPayload,
  MatchLogHeader,
  OmniscientMatchLog,
  PlayerRef,
  RejectCode,
  SeatDirectoryEntry,
  SeatSnapshot,
  SeatVisible,
  ServerToSeat,
} from "@mjrc/protocol";

/* ── 1. the runtime surface, structurally ──────────────────────────────────
 *
 * Declared as plain interfaces rather than imported from `cloudflare:workers`.
 * Two reasons, both load-bearing: this repo takes no new dependencies, and a
 * structural surface is what lets `worker/test/table.test.ts` drive the whole
 * object with plain objects — no wrangler, no miniflare, no workerd.
 * The real `DurableObjectState`, `R2Bucket` and `D1Database` satisfy these.
 */

/** The subset of the hibernation WebSocket API this object uses. */
export interface SeatSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface TableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<unknown>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(when: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface TableCtx {
  storage: TableStorage;
  acceptWebSocket(ws: SeatSocket): void;
  getWebSockets(): SeatSocket[];
}

export interface R2Like {
  put(key: string, value: string, options?: unknown): Promise<unknown>;
}
export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(query: string): D1PreparedLike;
}

export interface TableEnv {
  /** R2 `mjrc-game-logs` — the omniscient archive. Server only, forever. */
  LOGS?: R2Like;
  /** D1 `mjrc-game` — worker/schema.sql. */
  DB?: D1Like;
  /** Shared secret the lobby presents to initialize a table. */
  TABLE_SECRET?: string;
  /**
   * Optional JSON `Partial<TableConfig>` — clocks and bot pacing. Meant for
   * local development and the smoke test, where a full match at human pacing
   * would take half an hour. Malformed JSON is ignored, not fatal.
   */
  TABLE_CONFIG?: string;
}

/* ── 2. the collaborators ──────────────────────────────────────────────────
 *
 * Ports, not imports. The engine reducer is bound at module load by the Worker
 * entry (`installTableRules`) rather than statically imported here, because
 * §5.5 requires that an old hand replays through the engine build recorded on
 * its own header — "keep old reducer builds loadable". A hard import of one
 * build into the persistence layer forecloses exactly that.
 */

/** A `GameEvent` minus the four fields the DO owns. Distributive, so the
 *  discriminated union survives — a plain `Omit` over a union collapses it. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventDraft = DistributiveOmit<GameEvent, "v" | "matchId" | "seq" | "ts">;

/** What every reducer entry point returns: the next state and what it emitted. */
export interface Applied {
  state: GameState;
  events: EventDraft[];
}

/** Mirrors `MatchConfig` in engine/src/reducer.ts, so the port binds with no adapter. */
export interface MatchSpec {
  matchId: string;
  /** Every wall in the match derives from this one number (§5.1). */
  seed: number;
  rulesetId?: string;
  dealer?: SeatIndex;
  /** As the header spells it: a wind-round count, or the two legacy strings. */
  matchLength?: MatchLogHeader["matchLength"];
  startingChips?: number;
  startedAt?: number;
}

/**
 * The reducer seam (DESIGN.md §5.1). These four methods are exactly the shape
 * of `startMatch` / `startNextHand` / `applyAction` / `legalActions` in
 * engine/src/reducer.ts, so the production wiring is a direct bind with no
 * adapter in between. Declared as METHODS on purpose: method parameters are
 * bivariant, which is what lets a reducer whose state type EXTENDS `GameState`
 * satisfy a port written against `GameState`.
 *
 * CONTRACT NOTES the implementor must honour, because the DO relies on them:
 *
 *  - `startMatch` runs the deal AND the flower replacement chain to completion,
 *    in strict seat order (§5.2). Those need no player input, so a table that
 *    stopped half way through them would be waiting on itself.
 *  - `deadlineTs` on `claimOffered` / `robKongWindow` is a WALL CLOCK, and the
 *    reducer has none. Whatever it puts there is overwritten on the way out;
 *    the live table's `claimWindowMs` is the one that counts. Sequence numbers
 *    are likewise re-stamped — `seq` is the DO's to assign.
 *  - Claim answers arrive as one `claim`/`pass` per offered seat, in ASCENDING
 *    SEAT ORDER, all at the close of the window — never as they are clicked.
 *    The DO holds them precisely so a reducer that resolves on the last answer
 *    cannot close the window early and leak that somebody held a claim.
 *  - An illegal action THROWS. Attach a `code` property carrying a protocol
 *    `RejectCode` to say why; anything else is reported as `notALegalMove`.
 */
export interface TableRules {
  /**
   * Deal hand 0. Called once, at init — before anybody has connected. That is
   * deliberate and harmless: the wall is a pure function of the seed and no
   * seat can act until it joins, so dealing early decides nothing. The DO does
   * not start any clock until the table is full.
   */
  startMatch(spec: MatchSpec): Applied;
  /**
   * Called after every `handEnd`. Deals the next hand, or emits `matchEnd`.
   * Which of those a match is due is a §4 match-structure question and the DO
   * must not answer it.
   */
  startNextHand(state: GameState): Applied;
  applyAction(state: GameState, action: Action): Applied;
  /**
   * Everything this seat may do right now. The DO groups these into the
   * protocol's `LegalRequests` for the prompt — a projection, not a judgement.
   */
  legalActions(state: GameState, seat: SeatIndex): Action[];
}

/**
 * A bot is a player whose input is a function call (§6) — same action API as a
 * human, and the same INFORMATION as a human: it is handed the redacted seat
 * view, never the omniscient state. A bot that could see the wall would be a
 * cheat, and the type here is what stops one being written by accident.
 */
export interface BotBrain {
  /**
   * Deterministic. `rand` is a seeded `prng`; there is no other entropy.
   * `player` is this seat's `PlayerRef` from the header — how a brain that
   * serves more than one profile (gamepvp/src/bots.ts) tells seats apart.
   * Optional so a brain that only ever runs one profile need not read it.
   */
  decide(view: SeatVisible<SeatSnapshot>, legal: LegalRequests, rand: () => number, player?: PlayerRef): Action | null;
  /** Deterministic think time. Clamped by the DO and always inside the window. */
  paceMs(legal: LegalRequests, rand: () => number): number;
}

/** The `hands` row of worker/schema.sql, camelCase. Written by the outbox. */
export interface HandResultRow {
  matchId: string;
  handIndex: number;
  dealerSeat: SeatIndex;
  roundWind: WindIndex;
  dealerRepeat: number;
  seed: number;
  outcome: "win" | "exhaustive_draw" | "abandoned";
  winnerSeat: SeatIndex | null;
  winnerPlayerId: string | null;
  winFromSeat: SeatIndex | null;
  winFromPlayerId: string | null;
  winningTile: TileId | null;
  selfDraw: boolean;
  robbedKong: boolean;
  onKongReplacement: boolean;
  faan: number;
  rawFaan: number;
  capped: boolean;
  awards: FaanAward[];
  chipDeltas: FourSeats<number>;
  refusedWins: number;
  wallRemaining: number | null;
  eventCount: number;
  logSeqStart: number;
  logSeqEnd: number;
  startedAt: number;
  endedAt: number;
}

/** The `matches` / `match_players` close-out, written once at MATCH_END. */
export interface MatchSummaryRow {
  matchId: string;
  reason: MatchEndPayload["reason"];
  handsPlayed: number;
  standings: FourSeats<number>;
  placements: FourSeats<1 | 2 | 3 | 4>;
  /** Hands each seat was played by a bot after a takeover (§5.3). */
  botTakeoverHands: FourSeats<number>;
  /** The per-hand blob parts, in order, for the consolidated match log. */
  handLogKeys: string[];
  /** "kind/version" per seat as presented on join; null for bots and unknowns. */
  clients: FourSeats<string | null>;
  endedAt: number;
}

/**
 * The archive sinks. Each call must be IDEMPOTENT on its key: the outbox
 * retries, and a retry after a response that was lost in flight is the normal
 * case, not the exceptional one.
 */
export interface Archive {
  putHandLog(key: string, log: OmniscientMatchLog): Promise<void>;
  putHandResult(row: HandResultRow): Promise<void>;
  finishMatch(summary: MatchSummaryRow): Promise<void>;
}

export interface TableConfig {
  /** 摸 → 打. The seat's own clock; a bot takes the move when it expires. */
  turnMs: number;
  /** The FIXED MINIMUM claim window. It always runs in full — see openWindow. */
  claimWindowMs: number;
  /** How long a dropped socket holds its seat before a bot plays it. */
  disconnectGraceMs: number;
  botMinPaceMs: number;
  botMaxPaceMs: number;
  /** Margin keeping a bot's held answer strictly inside the window. */
  botWindowMarginMs: number;
  requestWindowMs: number;
  maxRequestsPerWindow: number;
  outboxBackoffMs: number;
  outboxMaxBackoffMs: number;
}

export const DEFAULT_TABLE_CONFIG: TableConfig = {
  turnMs: 20_000,
  claimWindowMs: 5_000,
  disconnectGraceMs: 30_000,
  botMinPaceMs: 700,
  botMaxPaceMs: 2_500,
  botWindowMarginMs: 400,
  requestWindowMs: 10_000,
  maxRequestsPerWindow: 40,
  outboxBackoffMs: 1_000,
  outboxMaxBackoffMs: 60_000,
};

export interface TableDeps {
  rules: TableRules;
  bots: BotBrain;
  archive: Archive;
  /**
   * Wall clock. Injected so tests are deterministic — and so it is visible in
   * one place that NOTHING this returns is ever handed to the reducer. Event
   * timestamps and deadlines are the only consumers.
   */
  clock: () => number;
  config?: Partial<TableConfig>;
  /**
   * The out-of-band seam for an ABSENT player: a push notification service
   * plugs in here (plan §3 W10 item 3) and nothing in the game flow changes.
   * Fire-and-forget by contract; a notifier must never throw into the table.
   * Absent by default — the seam exists before the service does.
   */
  notify?: SeatNotifier;
}

export type SeatNotice = "tableFull" | "yourTurn" | "matchEnd";
export type SeatNotifier = (matchId: string, seat: SeatIndex, playerId: string, notice: SeatNotice) => void;

/* ── 3. persisted shapes ───────────────────────────────────────────────── */

/** Written once by the lobby's init call. The wall seed never leaves here. */
export interface TableInit {
  matchId: string;
  header: MatchLogHeader;
  /** The match-level seed. Each hand's seed is derived from it and the index. */
  seed: number;
  /** One-time seat credentials issued by the lobby (§5.3). Also the reclaim key. */
  seatTokens: FourSeats<string>;
  rulesetHash?: string;
  roomCode?: string;
  joinCode?: string;
}

interface TableMeta extends TableInit {
  startedAt: number;
}

/** What a socket carries across hibernation. Never any tile, ever. */
interface SocketAttachment {
  matchId: string;
  seat: SeatIndex;
  playerId: string;
}

interface PresenceRecord {
  connected: boolean;
  /** A bot is playing this seat: either it always was, or grace expired. */
  botActing: boolean;
}

/**
 * Deadline names. `disconnectGrace` and `botPace` are per seat because three
 * seats can be in grace, or three bots deciding inside one claim window, at the
 * same moment — §5.3 names `botPace` in the singular, but a single-slot pace
 * deadline would drop two of those three answers on the floor.
 */
export type DeadlineName =
  | "turnClock"
  | "claimWindow"
  | "outboxFlush"
  | `disconnectGrace:${SeatIndex}`
  | `botPace:${SeatIndex}`;

interface DeadlineEntry {
  at: number;
  /**
   * What situation this deadline belongs to. A derived deadline is re-armed
   * only when its token changes, so a commit that does not change the turn
   * cannot quietly push the turn clock out forever.
   */
  token: string;
}

type DeadlineMap = Record<string, DeadlineEntry>;

/** An open claim or 搶槓 window. The DO's own bookkeeping, not game state. */
interface WindowRecord {
  kind: "claim" | "robKong";
  openedSeq: number;
  closesAt: number;
  tile: TileId;
  from: SeatIndex;
  /** Ascending. The only seats whose answers this window accepts. */
  offered: SeatIndex[];
  /** `claimOffered` seq per offered seat, so a stale click is refusable. */
  offerSeq: Record<string, number>;
  /** Held until `closesAt`. Answering early must never shorten the window. */
  answers: Record<string, Action>;
}

interface OutboxRecord {
  handIndex: number;
  logKey: string;
  seqFrom: number;
  seqTo: number;
  sealed: boolean;
  r2Done: boolean;
  d1Done: boolean;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  result?: HandResultRow;
}

/** Match-level bookkeeping the reducer has no business holding. */
interface BookKeeping {
  turnToken: string;
  dealerRepeat: number;
  handStartedAt: number;
  handsPlayed: number;
  /** The first deal has happened. A table only deals once every seat is there. */
  started: boolean;
  matchOver: boolean;
  matchSummaryPending: boolean;
  /** Why the match ended, carried from the matchEnd payload to the D1 close-out. */
  matchEndReason: MatchEndPayload["reason"] | null;
  summaryAttempts: number;
  botTakeoverHands: FourSeats<number>;
  /** Seats a bot has played in the CURRENT hand; folded into the totals at end. */
  botTookOverThisHand: FourSeats<boolean>;
  handLogKeys: string[];
  /** "kind/version" per seat from the join payload; null until a client says. */
  clients: FourSeats<string | null>;
}

/* ── 4. small helpers ──────────────────────────────────────────────────── */

const SEATS: readonly SeatIndex[] = [0, 1, 2, 3];
const MAX_DISPATCHES_PER_ALARM = 32;
const STORAGE_BATCH = 100;

const K_META = "meta";
const K_STATE = "state";
const K_SEQ = "seq";
const K_DEADLINES = "deadlines";
const K_WINDOW = "window";
const K_PRESENCE = "presence";
const K_BOOK = "book";
const K_TOMBSTONE = "tombstone";
const P_OUTBOX = "ob:";
const P_EVENT = "ev:";

const pad = (n: number, width: number): string => String(n).padStart(width, "0");
const outboxKey = (handIndex: number): string => `${P_OUTBOX}${pad(handIndex, 4)}`;
const eventKey = (handIndex: number, seq: number): string =>
  `${P_EVENT}${pad(handIndex, 4)}:${pad(seq, 12)}`;
const handEventPrefix = (handIndex: number): string => `${P_EVENT}${pad(handIndex, 4)}:`;
const handLogKey = (matchId: string, handIndex: number): string =>
  `matches/${matchId}/hands/${pad(handIndex, 4)}.json`;

const four = <T>(f: (seat: SeatIndex) => T): FourSeats<T> => [f(0), f(1), f(2), f(3)];

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const CLIENT_KINDS = new Set(["web", "ios", "android", "desktop", "headless"]);

/** "kind/version" from a join's ClientInfo, or null when absent or malformed.
 *  Bounded and character-restricted: it lands in a column and in logs. */
function clientLabel(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const { kind, version } = raw as { kind?: unknown; version?: unknown };
  if (typeof kind !== "string" || !CLIENT_KINDS.has(kind)) return null;
  const v = typeof version === "string" ? version.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) : "";
  return `${kind}/${v || "unknown"}`;
}

/** 192 bits from the platform's CSPRNG, as hex. Coordination, never game state. */
function mintSeatToken(): string {
  const bytes = new Uint8Array(24);
  (globalThis as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Length-independent-ish compare, so a token check is not a timing oracle. */
function tokensMatch(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Bot entropy. The WALL seed is not derived here — that belongs to the reducer
 * (`handSeedFor`), and a second formula for the same number in a second file is
 * how a replay quietly stops reproducing its match.
 *
 * Same match, same hand, same seq and same seat → the same decision, always.
 */
function botSeed(matchSeed: number, handIndex: number, seq: number, seat: SeatIndex): number {
  return (
    (matchSeed ^
      Math.imul(handIndex + 1, 0x9e3779b1) ^
      Math.imul(seq + 1, 0x85ebca6b) ^
      Math.imul(seat + 1, 0x27d4eb2f)) >>>
    0
  );
}

/**
 * Re-attach the four fields the DO owns. The cast is the one in this file:
 * `EventDraft` is `GameEvent` minus exactly these keys, so putting them back
 * reconstitutes the same union member — TypeScript just cannot see a spread of
 * a distributive union narrow back to it.
 */
function stampEvent(draft: EventDraft, matchId: string, seq: number, ts: number): GameEvent {
  return { ...draft, v: EVENT_SCHEMA_VERSION, matchId, seq, ts } as GameEvent;
}

const isRejectCode = (x: unknown): x is RejectCode =>
  typeof x === "string" &&
  [
    "unauthenticated",
    "notYourTurn",
    "tileNotHeld",
    "notALegalMove",
    "staleOffer",
    "windowClosed",
    "duplicateRequest",
    "rateLimited",
    "matchOver",
  ].includes(x);

const hasAnyRequest = (l: LegalRequests): boolean =>
  l.discard.length > 0 ||
  l.concealedKong.length > 0 ||
  l.addedKong.length > 0 ||
  l.winOnSelfDraw ||
  l.claims !== null ||
  l.robKong !== null;

/** Sorted, so no code path in this object iterates unordered object keys. */
const sortedKeys = (o: Record<string, unknown>): string[] => Object.keys(o).sort();

const isDerivedDeadline = (name: string): boolean =>
  name === "turnClock" || name === "claimWindow" || name.startsWith("botPace:");

/** The DO owns the clock, so it fills the deadline the reducer left at 0. */
function stampWindowDeadline(e: GameEvent, at: number): GameEvent {
  if (e.type === "claimOffered") return { ...e, payload: { ...e.payload, deadlineTs: at } };
  if (e.type === "robKongWindow") return { ...e, payload: { ...e.payload, deadlineTs: at } };
  return e;
}

const isHandEnd = (e: GameEvent): e is Extract<GameEvent, { type: "handEnd" }> =>
  e.type === "handEnd";
const isClaimOffered = (e: GameEvent): e is Extract<GameEvent, { type: "claimOffered" }> =>
  e.type === "claimOffered";
const isRobKongWindow = (e: GameEvent): e is Extract<GameEvent, { type: "robKongWindow" }> =>
  e.type === "robKongWindow";

const MAX_RESYNC_EVENTS = 400;

function emptyBook(): BookKeeping {
  return {
    turnToken: "t0",
    dealerRepeat: 0,
    handStartedAt: 0,
    handsPlayed: 0,
    started: false,
    matchOver: false,
    matchSummaryPending: false,
    matchEndReason: null,
    summaryAttempts: 0,
    botTakeoverHands: [0, 0, 0, 0],
    botTookOverThisHand: [false, false, false, false],
    handLogKeys: [],
    clients: [null, null, null, null],
  };
}

/* ── 5. the table ──────────────────────────────────────────────────────── */

/**
 * The whole implementation. Deliberately NOT extending `DurableObject` from
 * `cloudflare:workers`: a DO class only has to expose `fetch`, `alarm` and the
 * WebSocket handlers, and staying off the base class is what lets the test
 * suite construct one with plain objects. `TableDO` below is the production
 * binding target and is three lines long.
 */
export class TableCore {
  private readonly config: TableConfig;
  private hydrating: Promise<void> | null = null;

  private meta: TableMeta | null = null;
  private state: GameState | null = null;
  private seq = 0;
  private deadlines: DeadlineMap = {};
  private window: WindowRecord | null = null;
  private presence: FourSeats<PresenceRecord> = four(() => ({
    connected: false,
    botActing: false,
  }));
  private book: BookKeeping = emptyBook();
  private outbox = new Map<number, OutboxRecord>();
  private tombstone = false;
  /** Depth of the handEnd → startNextHand chain. A reducer that emitted a
   *  handEnd from `startNextHand` would otherwise spin here forever. */
  private advanceDepth = 0;

  /** In-memory only: losing these on a wake costs at most a duplicate refusal. */
  private rate = new Map<number, { windowStart: number; count: number }>();
  private seenRequests: string[] = [];

  constructor(
    private readonly ctx: TableCtx,
    private readonly env: TableEnv,
    private readonly deps: TableDeps,
  ) {
    this.config = { ...DEFAULT_TABLE_CONFIG, ...(deps.config ?? {}) };
  }

  /* ── hydration ───────────────────────────────────────────────────────── */

  /**
   * Lazy rather than `blockConcurrencyWhile` in the constructor (mj-queue's
   * shape). Same guarantee — every entry point awaits it before touching state
   * — and it is what makes the object constructible in a test without a
   * runtime that implements `blockConcurrencyWhile`.
   */
  private hydrate(): Promise<void> {
    if (!this.hydrating) this.hydrating = this.load();
    return this.hydrating;
  }

  private async load(): Promise<void> {
    const st = this.ctx.storage;
    this.tombstone = (await st.get<unknown>(K_TOMBSTONE)) !== undefined;
    this.meta = (await st.get<TableMeta>(K_META)) ?? null;
    this.state = (await st.get<GameState>(K_STATE)) ?? null;
    this.seq = (await st.get<number>(K_SEQ)) ?? 0;
    this.deadlines = (await st.get<DeadlineMap>(K_DEADLINES)) ?? {};
    this.window = (await st.get<WindowRecord>(K_WINDOW)) ?? null;
    this.presence =
      (await st.get<FourSeats<PresenceRecord>>(K_PRESENCE)) ??
      four(() => ({ connected: false, botActing: false }));
    this.book = (await st.get<BookKeeping>(K_BOOK)) ?? emptyBook();
    // Books persisted before the field existed.
    if (!Array.isArray(this.book.clients)) this.book.clients = [null, null, null, null];

    const records = await st.list<OutboxRecord>({ prefix: P_OUTBOX });
    this.outbox = new Map();
    for (const key of [...records.keys()].sort()) {
      const rec = records.get(key);
      if (rec) this.outbox.set(rec.handIndex, rec);
    }

    // Hibernation can evict this object without a close event reaching us, so
    // presence is RECONCILED from the live sockets on every wake and never
    // trusted from storage: the persisted flag is a cache, the sockets are the
    // truth. Getting this backwards leaves a seat looking connected forever and
    // its grace deadline never armed.
    const live = new Set<number>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (att) live.add(att.seat);
    }
    for (const seat of SEATS) {
      const isBot = this.meta?.header.players[seat].bot ?? false;
      this.presence[seat] = {
        connected: live.has(seat),
        botActing: isBot || this.presence[seat].botActing,
      };
    }
  }

  private requireMeta(): TableMeta {
    if (!this.meta) throw new Error("table is not initialised");
    return this.meta;
  }

  private requireState(): GameState {
    if (!this.state) throw new Error("table has no state");
    return this.state;
  }

  private async persistCore(): Promise<void> {
    await this.ctx.storage.put({
      [K_META]: this.meta,
      [K_STATE]: this.state,
      [K_SEQ]: this.seq,
      [K_DEADLINES]: this.deadlines,
      [K_WINDOW]: this.window,
      [K_PRESENCE]: this.presence,
      [K_BOOK]: this.book,
    });
  }

  /* ── HTTP ────────────────────────────────────────────────────────────── */

  async fetch(request: Request): Promise<Response> {
    await this.hydrate();
    const url = new URL(request.url);
    if (url.pathname.endsWith("/init")) return this.handleInit(request);
    if (url.pathname.endsWith("/seat")) return this.handleSeat(request);
    if (this.tombstone) return new Response("match over", { status: 410 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }
    const Pair = (globalThis as Record<string, unknown>)["WebSocketPair"] as
      | (new () => Record<number, SeatSocket>)
      | undefined;
    if (!Pair) return new Response("no WebSocketPair in this runtime", { status: 500 });
    const pair = new Pair();
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) return new Response("bad WebSocketPair", { status: 500 });
    // Hibernation-enabled accept: the socket survives the object being evicted,
    // which is the whole reason a seat can hold its place through a quiet spell.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  /** Lobby → table handoff (§5.3). Idempotent on the same matchId. */
  private async handleInit(request: Request): Promise<Response> {
    const secret = this.env.TABLE_SECRET;
    if (secret && !tokensMatch(request.headers.get("x-mjrc-table-secret") ?? "", secret)) {
      return new Response("forbidden", { status: 403 });
    }
    if (this.tombstone) return new Response("match over", { status: 410 });
    let init: TableInit;
    try {
      init = (await request.json()) as TableInit;
    } catch {
      return new Response("malformed init", { status: 400 });
    }
    if (this.meta) {
      return this.meta.matchId === init.matchId
        ? new Response(JSON.stringify({ ok: true, matchId: this.meta.matchId }), { status: 200 })
        : new Response("table already holds another match", { status: 409 });
    }
    if (
      !init ||
      typeof init.matchId !== "string" ||
      typeof init.seed !== "number" ||
      !Array.isArray(init.seatTokens) ||
      init.seatTokens.length !== 4 ||
      !init.header ||
      init.header.matchId !== init.matchId
    ) {
      return new Response("malformed init", { status: 400 });
    }
    this.meta = { ...init, startedAt: this.deps.clock() };
    this.book = emptyBook();
    this.seq = 0;
    await this.persistCore();
    // Hand 0 is dealt now, with nobody connected. The wall is a pure function
    // of the seed, so this decides nothing that waiting would decide
    // differently — and it means a joiner is handed a real table rather than an
    // empty shell the DO would have had to invent. No clock starts until the
    // table is full; see `maybeStartClocks`.
    const applied = this.deps.rules.startMatch({
      matchId: init.matchId,
      seed: init.seed,
      rulesetId: init.header.rulesetId,
      matchLength: init.header.matchLength,
      startingChips: init.header.startingChips[0],
      startedAt: 0,
    });
    // §5.5: THE HEADER PINS THE ENGINE, and the only authority on which build
    // actually ran is the state that build just produced. A header carrying the
    // lobby's guess would make the archive unreplayable in precisely the way
    // the pin exists to prevent, and it would do it silently.
    this.meta.header = {
      ...init.header,
      engineVersion: applied.state.engineVersion,
      rulesetId: applied.state.rulesetId,
    };
    await this.commit(applied);
    // A table of four bots has nobody to join it, so the clocks would never
    // start if only `handleJoin` could start them. P0 alpha is bot-backed.
    await this.maybeStartClocks();
    return new Response(JSON.stringify({ ok: true, matchId: init.matchId }), { status: 200 });
  }

  /**
   * Lobby → table, the other half of the handoff: bind a player to a human
   * seat and mint (or rotate) that seat's credential. The platform Worker
   * calls this on create and on every join — a returning player asking for a
   * fresh token is the reconnect path (`index.ts` `postJoin`), and rotating
   * on each call is what makes a leaked old token worthless. The seat's
   * previous token stops matching the moment this returns; the caller hands
   * the new one to the client, which is the only party that ever needed one.
   *
   * The token is NOT game state: it is coordination, so it comes from the
   * platform's entropy and never from `prng(seed)`.
   */
  private async handleSeat(request: Request): Promise<Response> {
    const secret = this.env.TABLE_SECRET;
    if (secret && !tokensMatch(request.headers.get("x-mjrc-table-secret") ?? "", secret)) {
      return new Response("forbidden", { status: 403 });
    }
    if (this.tombstone || this.book.matchOver) return new Response("match over", { status: 410 });
    if (!this.meta) return new Response("table not initialised", { status: 409 });
    let claim: { matchId?: unknown; seat?: unknown; playerId?: unknown; displayName?: unknown };
    try {
      claim = (await request.json()) as typeof claim;
    } catch {
      return new Response("malformed claim", { status: 400 });
    }
    const seat = claim.seat;
    if (
      !claim ||
      claim.matchId !== this.meta.matchId ||
      typeof seat !== "number" ||
      !SEATS.includes(seat as SeatIndex) ||
      typeof claim.playerId !== "string" ||
      claim.playerId === "" ||
      typeof claim.displayName !== "string"
    ) {
      return new Response("malformed claim", { status: 400 });
    }
    const s = seat as SeatIndex;
    const current = this.meta.header.players[s];
    if (current.bot) return new Response("seat is a bot", { status: 409 });
    if (current.playerId !== "" && current.playerId !== claim.playerId) {
      return new Response("seat taken", { status: 409 });
    }
    const seatToken = mintSeatToken();
    const players = four((i) => this.meta!.header.players[i]);
    players[s] = { playerId: claim.playerId, displayName: claim.displayName, seat: s, bot: false };
    const seatTokens = four((i) => this.meta!.seatTokens[i]);
    seatTokens[s] = seatToken;
    this.meta = { ...this.meta, header: { ...this.meta.header, players }, seatTokens };
    await this.persistCore();
    // Nominal: the credential lives as long as the match does (§5.3).
    const expiresAt = new Date(this.meta.startedAt + 24 * 60 * 60 * 1000).toISOString();
    return new Response(JSON.stringify({ seatToken, expiresAt }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  /* ── sockets ─────────────────────────────────────────────────────────── */

  async webSocketMessage(ws: SeatSocket, message: string | ArrayBuffer): Promise<void> {
    await this.hydrate();
    let msg: ClientRequest;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      this.send(ws, protocolFault("malformedMessage"));
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.requestId !== "string") {
      this.send(ws, protocolFault("malformedMessage"));
      return;
    }
    if (!acceptsProtocolVersion(msg.p)) {
      this.send(ws, protocolFault("unsupportedProtocolVersion", `got p=${String(msg.p)}`));
      return;
    }
    if (!isKnownRequestType(msg.type)) {
      this.send(ws, protocolFault("unknownRequestType", String(msg.type)));
      return;
    }
    if (msg.type === "join") {
      await this.handleJoin(ws, msg);
      return;
    }
    const att = this.attachmentOf(ws);
    if (!att) {
      this.send(ws, protocolFault("notJoined"));
      return;
    }
    if (this.tombstone || this.book.matchOver) {
      this.send(ws, rejected(msg.requestId, "matchOver"));
      return;
    }
    if (msg.type === "heartbeat") {
      this.send(ws, { p: PROTOCOL_VERSION, type: "heartbeat", payload: {} });
      return;
    }
    if (this.rateLimited(att.seat)) {
      this.send(ws, rejected(msg.requestId, "rateLimited"));
      return;
    }
    if (this.isDuplicate(att.seat, msg.requestId)) {
      this.send(ws, rejected(msg.requestId, "duplicateRequest"));
      return;
    }
    await this.handleRequest(ws, att, msg);
    await this.rearm();
  }

  async webSocketClose(ws: SeatSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  async webSocketError(ws: SeatSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  private async onSocketGone(ws: SeatSocket): Promise<void> {
    await this.hydrate();
    const att = this.attachmentOf(ws);
    if (!att) return;
    const stillUp = this.ctx
      .getWebSockets()
      .some((other) => other !== ws && this.attachmentOf(other)?.seat === att.seat);
    if (stillUp) return;
    const seat = att.seat;
    this.presence[seat] = { connected: false, botActing: this.presence[seat].botActing };
    // A NAMED deadline. If this shared the single alarm slot with the claim
    // window — the naive `setAlarm()` — the next discard would erase it and the
    // seat would never be taken over: the table hangs, forever, silently.
    this.setDeadline(
      `disconnectGrace:${seat}`,
      this.deps.clock() + this.config.disconnectGraceMs,
      `g${this.seq}`,
    );
    await this.persistCore();
    this.broadcastPresence(seat);
    await this.rearm();
  }

  private async handleJoin(
    ws: SeatSocket,
    msg: Extract<ClientRequest, { type: "join" }>,
  ): Promise<void> {
    const p = msg.payload;
    if (this.tombstone || this.book.matchOver) {
      this.send(ws, rejected(msg.requestId, "matchOver"));
      return;
    }
    if (!this.meta || !this.state) {
      this.send(ws, rejected(msg.requestId, "unauthenticated", "table not initialised"));
      return;
    }
    if (p?.matchId !== this.meta.matchId || typeof p.seatToken !== "string") {
      this.send(ws, rejected(msg.requestId, "unauthenticated"));
      return;
    }
    // The lobby's one-time seat token IS the reclaim credential (§5.3): it
    // outlives the socket on purpose, so a player coming back takes their seat
    // off the bot without the lobby being in the loop.
    let seat: SeatIndex | null = null;
    for (const s of SEATS) if (tokensMatch(this.meta.seatTokens[s], p.seatToken)) seat = s;
    if (seat === null) {
      this.send(ws, rejected(msg.requestId, "unauthenticated"));
      return;
    }
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      if (this.attachmentOf(other)?.seat === seat) other.close(4000, "seat reclaimed");
    }
    const player = this.meta.header.players[seat];
    ws.serializeAttachment({
      matchId: this.meta.matchId,
      seat,
      playerId: player.playerId,
    } satisfies SocketAttachment);
    this.presence[seat] = { connected: true, botActing: player.bot };
    this.clearDeadline(`disconnectGrace:${seat}`);
    const client = clientLabel(p.client);
    if (client !== null) this.book.clients[seat] = client;
    await this.persistCore();

    this.send(ws, {
      p: PROTOCOL_VERSION,
      type: "welcome",
      payload: {
        matchId: this.meta.matchId,
        seat,
        engineVersion: this.meta.header.engineVersion,
        rulesetId: this.meta.header.rulesetId,
        directory: this.directory(),
        snapshot: this.viewFor(seat),
      },
    });
    this.send(ws, accepted(msg.requestId, this.seq));
    this.broadcastPresence(seat);
    await this.maybeStartClocks();
    this.sendPrompts();
    await this.rearm();
  }

  private directory(): FourSeats<SeatDirectoryEntry> {
    const players = this.requireMeta().header.players;
    return four((seat) => ({
      seat,
      playerId: players[seat].playerId,
      displayName: players[seat].displayName,
      bot: players[seat].bot,
      connected: this.presence[seat].connected,
    }));
  }

  private attachmentOf(ws: SeatSocket): SocketAttachment | null {
    let raw: unknown;
    try {
      raw = ws.deserializeAttachment();
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object") return null;
    const att = raw as Partial<SocketAttachment>;
    if (typeof att.seat !== "number" || att.seat < 0 || att.seat > 3) return null;
    if (this.meta && att.matchId !== this.meta.matchId) return null;
    return att as SocketAttachment;
  }

  private send(ws: SeatSocket, msg: ServerToSeat): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket going away; the close handler arms the grace deadline */
    }
  }

  private rateLimited(seat: SeatIndex): boolean {
    const now = this.deps.clock();
    const bucket = this.rate.get(seat);
    if (!bucket || now - bucket.windowStart >= this.config.requestWindowMs) {
      this.rate.set(seat, { windowStart: now, count: 1 });
      return false;
    }
    bucket.count += 1;
    return bucket.count > this.config.maxRequestsPerWindow;
  }

  private isDuplicate(seat: SeatIndex, requestId: string): boolean {
    const key = `${seat}:${requestId}`;
    if (this.seenRequests.includes(key)) return true;
    this.seenRequests.push(key);
    if (this.seenRequests.length > 256) this.seenRequests.shift();
    return false;
  }

  /* ── requests ────────────────────────────────────────────────────────── */

  private async handleRequest(
    ws: SeatSocket,
    att: SocketAttachment,
    msg: ClientRequest,
  ): Promise<void> {
    const seat = att.seat;
    switch (msg.type) {
      case "join":
      case "heartbeat":
        return;

      case "resync": {
        const since = typeof msg.payload?.sinceSeq === "number" ? msg.payload.sinceSeq : -1;
        // Reconnect is snapshot + actions-since, NOT a replay from the top
        // (§5.3): the snapshot is the authoritative current fold and the events
        // are only the narrative needed to animate the gap.
        const events = await this.eventsSince(since);
        this.send(ws, {
          p: PROTOCOL_VERSION,
          type: "restore",
          payload: {
            snapshot: this.viewFor(seat),
            events: redactEventsFor(seat, events),
          },
        });
        return;
      }

      case "requestDiscard": {
        const tile = msg.payload?.tile;
        if (typeof tile !== "number") return this.send(ws, protocolFault("malformedMessage"));
        return this.submit(seat, { type: "discard", seat, tile }, ws, msg.requestId);
      }

      case "requestConcealedKong": {
        const tile = msg.payload?.tile;
        if (typeof tile !== "number") return this.send(ws, protocolFault("malformedMessage"));
        return this.submit(seat, { type: "concealedKong", seat, tile }, ws, msg.requestId);
      }

      case "requestAddedKong": {
        const tile = msg.payload?.tile;
        if (typeof tile !== "number") return this.send(ws, protocolFault("malformedMessage"));
        return this.submit(seat, { type: "addedKong", seat, tile }, ws, msg.requestId);
      }

      case "requestWinOnSelfDraw":
        return this.submit(seat, { type: "declareWin", seat, selfDraw: true }, ws, msg.requestId);

      case "requestClaim": {
        const option = msg.payload?.option as ClaimOption | undefined;
        if (!option || typeof option.kind !== "string") {
          return this.send(ws, protocolFault("malformedMessage"));
        }
        if (!this.offerIsCurrent(seat, msg.payload.offerSeq)) {
          return this.send(ws, rejected(msg.requestId, "staleOffer"));
        }
        return this.submit(seat, { type: "claim", seat, option }, ws, msg.requestId);
      }

      case "requestPass": {
        if (!this.offerIsCurrent(seat, msg.payload?.offerSeq)) {
          return this.send(ws, rejected(msg.requestId, "staleOffer"));
        }
        return this.submit(seat, { type: "pass", seat }, ws, msg.requestId);
      }

      case "requestWinOnDiscard":
      case "requestRobKong": {
        if (!this.offerIsCurrent(seat, msg.payload?.offerSeq)) {
          return this.send(ws, rejected(msg.requestId, "staleOffer"));
        }
        const win: Action = { type: "claim", seat, option: { kind: "win" } };
        return this.submit(seat, win, ws, msg.requestId);
      }
    }
  }

  /** A late click on a window that already closed is stale, never a live move. */
  private offerIsCurrent(seat: SeatIndex, offerSeq: unknown): boolean {
    const win = this.window;
    if (!win || typeof offerSeq !== "number") return false;
    return win.offerSeq[String(seat)] === offerSeq;
  }

  /**
   * The single funnel every action passes through — human click, bot decision
   * and expired clock alike. Nothing else in this file calls `applyAction`.
   */
  private async submit(
    seat: SeatIndex,
    action: Action,
    ws?: SeatSocket,
    requestId?: string,
  ): Promise<void> {
    if (!this.book.started) {
      if (ws && requestId) this.send(ws, rejected(requestId, "notALegalMove", "table is not full"));
      return;
    }
    const win = this.window;
    if (win) {
      if (!win.offered.includes(seat)) {
        if (ws && requestId) this.send(ws, rejected(requestId, "windowClosed"));
        return;
      }
      if (action.type !== "claim" && action.type !== "pass") {
        if (ws && requestId) this.send(ws, rejected(requestId, "notALegalMove"));
        return;
      }
      // HELD. The window always runs its full fixed minimum, so answering fast
      // can never shorten it — a window that closed the instant everyone had
      // answered would announce, by its own duration, that somebody was
      // holding a claim (§5.2). This is also why claim resolution is
      // deterministic: the answers are applied in seat order at the deadline,
      // never in the order the packets happened to arrive.
      win.answers[String(seat)] = action;
      this.armDerived(this.deps.clock());
      await this.persistCore();
      if (ws && requestId) this.send(ws, accepted(requestId, this.seq));
      return;
    }

    let applied: Applied;
    try {
      applied = this.deps.rules.applyAction(this.requireState(), action);
    } catch (err) {
      const code = isRejectCode((err as { code?: unknown })?.code)
        ? ((err as { code: RejectCode }).code)
        : "notALegalMove";
      if (ws && requestId) this.send(ws, rejected(requestId, code, String(err)));
      return;
    }
    if (ws && requestId) this.send(ws, accepted(requestId, this.seq));
    await this.commit(applied);
  }

  /* ── commit: persist, then broadcast ─────────────────────────────────── */

  /**
   * The one write path. Stamps the reducer's drafts, folds the DO's own
   * bookkeeping, writes EVERYTHING in one batch, and only then puts anything on
   * a socket. Persist-then-broadcast is not a style preference: a client that
   * saw an event the object never stored would be holding history the server
   * cannot reproduce, and gate 2 is exactly the promise that never happens.
   */
  private async commit(applied: Applied): Promise<void> {
    const meta = this.requireMeta();
    const ts = this.deps.clock();

    const events: GameEvent[] = [];
    for (const draft of applied.events) {
      const seq = this.seq++;
      const stamped = stampEvent(draft, meta.matchId, seq, ts);
      events.push(stampWindowDeadline(stamped, ts + this.config.claimWindowMs));
    }

    const previous = this.state;
    this.state = applied.state;

    const batch: Record<string, unknown> = {};
    for (const e of events) batch[eventKey(e.handIndex, e.seq)] = e;

    for (const e of events) {
      if (e.type === "deal") {
        this.book.handStartedAt = ts;
        this.book.botTookOverThisHand = [false, false, false, false];
        const rec: OutboxRecord = {
          handIndex: e.handIndex,
          logKey: handLogKey(meta.matchId, e.handIndex),
          seqFrom: e.seq,
          seqTo: e.seq,
          sealed: false,
          r2Done: false,
          d1Done: false,
          attempts: 0,
          nextAttemptAt: 0,
        };
        this.outbox.set(e.handIndex, rec);
        batch[outboxKey(e.handIndex)] = rec;
        if (!this.book.handLogKeys.includes(rec.logKey)) this.book.handLogKeys.push(rec.logKey);
      }
      if (e.type === "matchEnd") {
        this.book.matchOver = true;
        this.book.matchSummaryPending = true;
        this.book.matchEndReason = e.payload.reason;
      }
    }

    this.syncWindow(events);

    // The turn "situation" token. A derived deadline is re-armed only when this
    // changes, so a commit that leaves the same seat on turn cannot push the
    // turn clock out again and again until the table never times anyone out.
    const st = this.state;
    if (
      !previous ||
      previous.turn !== st.turn ||
      previous.phase !== st.phase ||
      previous.handIndex !== st.handIndex
    ) {
      this.book.turnToken = `t${st.handIndex}:${st.turn}:${st.phase}:${this.seq}`;
    }

    this.armDerived(ts);

    batch[K_META] = this.meta;
    batch[K_STATE] = this.state;
    batch[K_SEQ] = this.seq;
    batch[K_DEADLINES] = this.deadlines;
    batch[K_WINDOW] = this.window;
    batch[K_PRESENCE] = this.presence;
    batch[K_BOOK] = this.book;
    await this.putBatch(batch);

    this.broadcast(events);
    await this.afterCommit(events);
  }

  private async putBatch(batch: Record<string, unknown>): Promise<void> {
    const keys = sortedKeys(batch);
    for (let i = 0; i < keys.length; i += STORAGE_BATCH) {
      const slice: Record<string, unknown> = {};
      for (const k of keys.slice(i, i + STORAGE_BATCH)) slice[k] = batch[k];
      await this.ctx.storage.put(slice);
    }
  }

  /** Open a window the reducer just announced, or retire a spent one. */
  private syncWindow(events: readonly GameEvent[]): void {
    const rob = events.filter(isRobKongWindow).pop();
    const offers = events.filter(isClaimOffered);
    if (rob) {
      const offered = [...rob.payload.offeredTo].sort((a, b) => a - b);
      const offerSeq: Record<string, number> = {};
      for (const seat of offered) offerSeq[String(seat)] = rob.seq;
      this.window = {
        kind: "robKong",
        openedSeq: rob.seq,
        closesAt: rob.payload.deadlineTs,
        tile: rob.payload.tile,
        from: rob.payload.seat,
        offered,
        offerSeq,
        answers: {},
      };
      return;
    }
    if (offers.length > 0) {
      const first = offers[0];
      const offerSeq: Record<string, number> = {};
      for (const o of offers) offerSeq[String(o.payload.seat)] = o.seq;
      this.window = {
        kind: "claim",
        openedSeq: first.seq,
        closesAt: first.payload.deadlineTs,
        tile: first.payload.tile,
        from: first.payload.from,
        offered: offers.map((o) => o.payload.seat).sort((a, b) => a - b),
        offerSeq,
        answers: {},
      };
      return;
    }
    const phase = this.requireState().phase;
    if (phase !== "claimWindow" && phase !== "robKongWindow") this.window = null;
  }

  private async afterCommit(events: readonly GameEvent[]): Promise<void> {
    const ended = events.find(isHandEnd);
    if (ended) {
      // The row's facts are read off the book BEFORE advancing, because the
      // next deal resets them.
      const row = { dealerRepeat: this.book.dealerRepeat, startedAt: this.book.handStartedAt };
      // Advance FIRST. `startNextHand` either deals the next hand or emits the
      // `matchEnd`, and a matchEnd carries the ENDING hand's index — sealing
      // before it lands would archive a hand missing its last event.
      await this.advance(ended.payload);
      await this.sealHand(ended.handIndex, ended.payload, row);
    }
    if (this.book.matchOver) this.setDeadline("outboxFlush", this.deps.clock(), "flush");
    await this.persistCore();
    await this.rearm();
  }

  /**
   * The clocks start when the table is full, not when the object is created. A
   * turn clock ticking while the fourth player is still opening the app would
   * time out a seat that never had a turn to take.
   */
  private async maybeStartClocks(): Promise<void> {
    if (this.book.started || this.book.matchOver) return;
    const meta = this.requireMeta();
    for (const seat of SEATS) {
      if (!meta.header.players[seat].bot && !this.presence[seat].connected) return;
    }
    this.book.started = true;
    this.armDerived(this.deps.clock());
    await this.persistCore();
    await this.rearm();
    for (const seat of SEATS) this.notifySeat(seat, "tableFull");
  }

  /** Hand over to the reducer, which deals the next hand or ends the match. */
  private async advance(end: HandEndPayload): Promise<void> {
    if (this.advanceDepth > 2) {
      throw new Error("startNextHand kept ending hands — refusing to spin the table");
    }
    this.book.handsPlayed += 1;
    this.book.dealerRepeat = end.dealerRepeats ? this.book.dealerRepeat + 1 : 0;
    for (const seat of SEATS) {
      if (this.book.botTookOverThisHand[seat]) this.book.botTakeoverHands[seat] += 1;
    }
    this.advanceDepth += 1;
    try {
      await this.commit(this.deps.rules.startNextHand(this.requireState()));
    } finally {
      this.advanceDepth -= 1;
    }
  }

  /* ── views ───────────────────────────────────────────────────────────── */

  /**
   * §5.3's per-seat redacted view: own hand, all discards, all melds, all
   * flowers, the wall COUNT, and only the tile counts of other seats. There is
   * no other route from the omniscient state to a socket in this file.
   *
   * Presence is overlaid here rather than written into `GameState`, so the
   * reducer never has to know a socket exists and the game state stays a pure
   * function of the event stream.
   */
  viewFor(seat: SeatIndex): SeatVisible<SeatSnapshot> {
    const meta = this.requireMeta();
    const state = this.requireState();
    const seats = four((s) => ({ ...state.seats[s], connected: this.presence[s].connected }));
    const withPresence: GameState = { ...state, seats };
    return snapshotFor(seat, withPresence, {
      matchId: meta.matchId,
      seq: Math.max(this.seq - 1, 0),
    });
  }

  private broadcast(events: readonly GameEvent[]): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (!att) continue;
      const redacted = redactEventsFor(att.seat, events);
      // The post-batch snapshot rides along so the client never folds events
      // into state itself (EventsPayload.snapshot).
      if (redacted.length > 0) this.send(ws, eventsMessage(redacted, this.viewFor(att.seat)));
    }
    this.sendPrompts();
  }

  private broadcastPresence(seat: SeatIndex): void {
    const msg: ServerToSeat = {
      p: PROTOCOL_VERSION,
      type: "presence",
      payload: {
        seat,
        connected: this.presence[seat].connected,
        botActing: this.presence[seat].botActing,
      },
    };
    for (const ws of this.ctx.getWebSockets()) this.send(ws, msg);
  }

  private sendPrompts(): void {
    if (this.book.matchOver || !this.book.started || !this.state) return;
    const win = this.window;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (!att) continue;
      if (win && win.answers[String(att.seat)] !== undefined) continue;
      const legal = this.legalFor(att.seat);
      if (!hasAnyRequest(legal)) continue;
      this.send(ws, {
        p: PROTOCOL_VERSION,
        type: "prompt",
        payload: { legal, deadlineTs: win ? win.closesAt : (this.deadlines["turnClock"]?.at ?? 0) },
      });
    }
    // A human whose turn it is and who has no socket gets the out-of-band
    // notice instead of a prompt. Sockets were prompted above; this reaches
    // the phone in a pocket.
    if (this.deps.notify && !win && this.state.phase === "awaitDiscard") {
      const seat = this.state.turn;
      const player = this.requireMeta().header.players[seat];
      if (!player.bot && !this.presence[seat].connected) {
        this.notifySeat(seat, "yourTurn");
      }
    }
  }

  private notifySeat(seat: SeatIndex, notice: SeatNotice): void {
    const notify = this.deps.notify;
    if (!notify) return;
    const meta = this.requireMeta();
    const player = meta.header.players[seat];
    if (player.bot || player.playerId === "") return;
    try {
      notify(meta.matchId, seat, player.playerId, notice);
    } catch (err) {
      console.error("seat notifier threw", meta.matchId, seat, notice, err);
    }
  }

  /**
   * Group the reducer's legal actions into the protocol's prompt shape. A
   * PROJECTION, not a judgement: nothing is added, nothing is removed. The
   * offer's `seq`, `tile` and `from` come from the DO's own window record,
   * because a sequence number is not something a pure reducer can know.
   */
  private legalFor(seat: SeatIndex): LegalRequests {
    const legal: LegalRequests = {
      discard: [],
      concealedKong: [],
      addedKong: [],
      winOnSelfDraw: false,
      claims: null,
      robKong: null,
    };
    const options: ClaimOption[] = [];
    for (const action of this.deps.rules.legalActions(this.requireState(), seat)) {
      switch (action.type) {
        case "discard":
          legal.discard.push(action.tile);
          break;
        case "concealedKong":
          legal.concealedKong.push(action.tile);
          break;
        case "addedKong":
          legal.addedKong.push(action.tile);
          break;
        case "declareWin":
          if (action.selfDraw) legal.winOnSelfDraw = true;
          break;
        case "claim":
          options.push(action.option);
          break;
        case "pass":
          break;
      }
    }
    const win = this.window;
    if (win && win.answers[String(seat)] === undefined && options.length > 0) {
      const offerSeq = win.offerSeq[String(seat)] ?? win.openedSeq;
      if (win.kind === "robKong") {
        legal.robKong = { offerSeq, tile: win.tile, from: win.from };
      } else {
        legal.claims = { offerSeq, tile: win.tile, from: win.from, options };
      }
    }
    return legal;
  }

  private async eventsSince(sinceSeq: number): Promise<GameEvent[]> {
    const found = await this.ctx.storage.list<GameEvent>({ prefix: P_EVENT });
    const all: GameEvent[] = [];
    for (const key of [...found.keys()].sort()) {
      const e = found.get(key);
      if (e && e.seq > sinceSeq) all.push(e);
    }
    return all.slice(-MAX_RESYNC_EVENTS);
  }

  /* ── the deadline multiplexer ────────────────────────────────────────── */

  /** Every deadline in the map, sorted. Inspection only — never a decision. */
  deadlineSnapshot(): { name: string; at: number }[] {
    return sortedKeys(this.deadlines)
      .map((name) => ({ name, at: this.deadlines[name].at }))
      .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  }

  private setDeadline(name: DeadlineName, at: number, token: string): void {
    this.deadlines[name] = { at, token };
  }

  private setDeadlineIfNew(name: DeadlineName, at: number, token: string): void {
    const existing = this.deadlines[name];
    if (existing && existing.token === token) return;
    this.deadlines[name] = { at, token };
  }

  private clearDeadline(name: DeadlineName): void {
    delete this.deadlines[name];
  }

  /**
   * THE fix for the one-alarm problem. `setAlarm()` overwrites, so the alarm is
   * never used to mean "a claim window" or "a grace period" — it means "the
   * earliest thing in the map". Everything else is a named entry beside it.
   */
  private async rearm(): Promise<void> {
    if (this.tombstone) return;
    const names = sortedKeys(this.deadlines);
    let earliest = Number.POSITIVE_INFINITY;
    for (const name of names) earliest = Math.min(earliest, this.deadlines[name].at);
    if (!Number.isFinite(earliest)) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === earliest) return;
    await this.ctx.storage.setAlarm(earliest);
  }

  /**
   * Dispatch EVERY due entry, not just the one the alarm was set for. The
   * bounded loop is deliberate: a dispatch may arm something already due (a bot
   * whose pace lands in the past), and an unbounded loop would spin inside one
   * alarm invocation. Anything left over is picked up by the re-arm at the end,
   * which sets the alarm to a time already past and so fires again immediately.
   */
  async alarm(): Promise<void> {
    await this.hydrate();
    if (this.tombstone) return;
    for (let guard = 0; guard < MAX_DISPATCHES_PER_ALARM; guard++) {
      const due = this.nextDue(this.deps.clock());
      if (!due) break;
      delete this.deadlines[due];
      await this.persistCore();
      await this.dispatch(due);
    }
    await this.rearm();
  }

  /** Earliest due entry, ties broken by name — deterministic, never map order. */
  private nextDue(now: number): DeadlineName | null {
    let best: DeadlineName | null = null;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const name of sortedKeys(this.deadlines)) {
      const at = this.deadlines[name].at;
      if (at > now) continue;
      if (at < bestAt) {
        bestAt = at;
        best = name as DeadlineName;
      }
    }
    return best;
  }

  private async dispatch(name: DeadlineName): Promise<void> {
    if (name === "outboxFlush") return this.flushOutbox();
    if (this.book.matchOver) return;
    if (name === "claimWindow") return this.closeWindow();
    if (name === "turnClock") {
      // The seat's clock ran out. Handing the move to the bot immediately leaks
      // nothing: the window already ran its full length, which is the maximum
      // any observer could have inferred from it.
      const state = this.requireState();
      if (this.window || state.phase !== "awaitDiscard") return;
      return this.actAsBot(state.turn);
    }
    if (name.startsWith("disconnectGrace:")) {
      const seat = Number(name.slice("disconnectGrace:".length)) as SeatIndex;
      return this.onGraceExpired(seat);
    }
    if (name.startsWith("botPace:")) {
      const seat = Number(name.slice("botPace:".length)) as SeatIndex;
      return this.actAsBot(seat);
    }
  }

  private async onGraceExpired(seat: SeatIndex): Promise<void> {
    if (this.presence[seat].connected) return;
    this.presence[seat] = { connected: false, botActing: true };
    this.armDerived(this.deps.clock());
    await this.persistCore();
    this.broadcastPresence(seat);
  }

  private isBotControlled(seat: SeatIndex): boolean {
    const meta = this.meta;
    return (meta?.header.players[seat].bot ?? false) || this.presence[seat].botActing;
  }

  /**
   * Rebuild the deadlines that follow from the current situation. The
   * disconnect graces and the outbox retry are NOT touched here — they belong
   * to events that have nothing to do with whose turn it is, and clearing them
   * from this function is the naive-alarm bug wearing a different hat.
   */
  private armDerived(now: number): void {
    const keep = new Set<string>();
    const state = this.state;
    const win = this.window;
    if (state && this.book.started && !this.book.matchOver) {
      if (win) {
        keep.add("claimWindow");
        this.setDeadlineIfNew("claimWindow", win.closesAt, `w${win.openedSeq}`);
        for (const seat of win.offered) {
          if (win.answers[String(seat)] !== undefined) continue;
          if (!this.isBotControlled(seat)) continue;
          const name: DeadlineName = `botPace:${seat}`;
          keep.add(name);
          this.setDeadlineIfNew(
            name,
            this.paceAt(seat, now, win.closesAt - this.config.botWindowMarginMs),
            `w${win.openedSeq}:${seat}`,
          );
        }
      } else if (state.phase === "awaitDiscard") {
        keep.add("turnClock");
        this.setDeadlineIfNew("turnClock", now + this.config.turnMs, this.book.turnToken);
        if (this.isBotControlled(state.turn)) {
          const name: DeadlineName = `botPace:${state.turn}`;
          keep.add(name);
          this.setDeadlineIfNew(
            name,
            this.paceAt(state.turn, now, now + this.config.turnMs - this.config.botWindowMarginMs),
            this.book.turnToken,
          );
        }
      }
    }
    for (const name of sortedKeys(this.deadlines)) {
      if (isDerivedDeadline(name) && !keep.has(name)) delete this.deadlines[name];
    }
  }

  /* ── bots ────────────────────────────────────────────────────────────── */

  private paceAt(seat: SeatIndex, now: number, notAfter: number): number {
    const state = this.requireState();
    const legal = this.legalFor(seat);
    const rand = prng(botSeed(this.requireMeta().seed, state.handIndex, this.seq, seat));
    const cfg = this.config;
    const ms = clamp(this.deps.bots.paceMs(legal, rand), cfg.botMinPaceMs, cfg.botMaxPaceMs);
    return clamp(now + ms, now, Math.max(notAfter, now));
  }

  /**
   * A bot answers ONLY here, off the `botPace` deadline — never inline in the
   * message handler. A synchronous bot reply is a timing oracle: it would
   * resolve a claim window the instant a discard landed whenever no bot held a
   * claim, and take longer whenever one did (§5.2, §5.3).
   */
  private async actAsBot(seat: SeatIndex): Promise<void> {
    if (this.book.matchOver || !this.state) return;
    const state = this.state;
    const legal = this.legalFor(seat);
    if (!hasAnyRequest(legal)) return;
    const rand = prng(botSeed(this.requireMeta().seed, state.handIndex, this.seq, seat));
    const player = this.requireMeta().header.players[seat];
    let action: Action | null = null;
    try {
      action = this.deps.bots.decide(this.viewFor(seat), legal, rand, player);
    } catch {
      action = null;
    }
    if (!action && this.window?.offered.includes(seat)) action = { type: "pass", seat };
    if (!action) return;
    if (!this.requireMeta().header.players[seat].bot) this.book.botTookOverThisHand[seat] = true;
    await this.submit(seat, action);
  }

  /**
   * Close the window at its deadline and hand every answer to the reducer in
   * ASCENDING SEAT ORDER. Silence is a pass. Because the answers were held,
   * this order is a property of the rules and not of the network.
   */
  private async closeWindow(): Promise<void> {
    const win = this.window;
    if (!win) return;
    this.window = null;
    for (const seat of win.offered) {
      if (this.window) break;
      const phase = this.requireState().phase;
      if (phase !== "claimWindow" && phase !== "robKongWindow") break;
      const held = win.answers[String(seat)];
      const action: Action = held ?? { type: "pass", seat };
      try {
        const applied = this.deps.rules.applyAction(this.requireState(), action);
        await this.commit(applied);
      } catch {
        // A held answer the reducer now refuses (the state moved under it) is
        // dropped and the seat is treated as silent. Never fatal to the table.
      }
    }
  }

  /* ── the outbox ──────────────────────────────────────────────────────── */

  private async readHandEvents(handIndex: number): Promise<GameEvent[]> {
    const found = await this.ctx.storage.list<GameEvent>({ prefix: handEventPrefix(handIndex) });
    const out: GameEvent[] = [];
    for (const key of [...found.keys()].sort()) {
      const e = found.get(key);
      if (e) out.push(e);
    }
    return out;
  }

  private async deleteHandEvents(handIndex: number): Promise<void> {
    const found = await this.ctx.storage.list<unknown>({ prefix: handEventPrefix(handIndex) });
    const keys = [...found.keys()].sort();
    for (let i = 0; i < keys.length; i += STORAGE_BATCH) {
      await this.ctx.storage.delete(keys.slice(i, i + STORAGE_BATCH));
    }
  }

  /** Seal the hand and queue it. Nothing is sent to R2 or D1 on this path. */
  private async sealHand(
    handIndex: number,
    end: HandEndPayload,
    row: { dealerRepeat: number; startedAt: number },
  ): Promise<void> {
    const rec = this.outbox.get(handIndex);
    if (!rec || rec.sealed) return;
    const events = await this.readHandEvents(handIndex);
    rec.sealed = true;
    rec.seqTo = events.length > 0 ? events[events.length - 1].seq : rec.seqFrom;
    rec.nextAttemptAt = 0;
    rec.result = this.summariseHand(handIndex, end, events, row);
    this.outbox.set(handIndex, rec);
    await this.ctx.storage.put({ [outboxKey(handIndex)]: rec });
    this.setDeadline("outboxFlush", this.deps.clock(), "flush");
  }

  /**
   * Project the hand onto the `hands` row of worker/schema.sql. A mechanical
   * fold over events that already happened — it decides nothing and derives no
   * rule; every number here was produced by the reducer and is only being
   * copied into the index over the blob.
   */
  private summariseHand(
    handIndex: number,
    end: HandEndPayload,
    events: readonly GameEvent[],
    row: { dealerRepeat: number; startedAt: number },
  ): HandResultRow {
    const meta = this.requireMeta();
    const players = meta.header.players;
    let dealerSeat: SeatIndex = 0;
    let roundWind: WindIndex = 0;
    let seed = 0;
    let wallRemaining: number | null = null;
    let refusedWins = 0;
    let win: Extract<GameEvent, { type: "winOnDiscard" | "selfDraw" }> | null = null;

    for (const e of events) {
      switch (e.type) {
        case "deal":
          dealerSeat = e.payload.dealer;
          roundWind = e.payload.roundWind;
          seed = e.payload.seed;
          wallRemaining = e.payload.wallRemaining;
          break;
        case "draw":
        case "flowerReplacement":
        case "kongReplacement":
        case "exhaustiveDraw":
          wallRemaining = e.payload.wallRemaining;
          break;
        case "refusedWin":
          refusedWins += 1;
          break;
        case "winOnDiscard":
        case "selfDraw":
          win = e;
          break;
        default:
          break;
      }
    }

    const ctx = win?.payload.context ?? null;
    const winnerSeat = end.winner;
    const winFromSeat = ctx && !ctx.selfDraw ? ctx.from : null;
    return {
      matchId: meta.matchId,
      handIndex,
      dealerSeat,
      roundWind,
      dealerRepeat: row.dealerRepeat,
      seed,
      outcome: end.outcome === "exhaustiveDraw" ? "exhaustive_draw" : "win",
      winnerSeat,
      winnerPlayerId: winnerSeat === null ? null : players[winnerSeat].playerId,
      winFromSeat,
      winFromPlayerId: winFromSeat === null ? null : players[winFromSeat].playerId,
      winningTile: ctx ? ctx.winningTile : null,
      selfDraw: ctx ? ctx.selfDraw : false,
      robbedKong: ctx?.robbedKong ?? false,
      onKongReplacement: ctx?.onKongReplacement ?? false,
      faan: win?.payload.score.faan ?? 0,
      rawFaan: win?.payload.score.rawFaan ?? 0,
      capped: win?.payload.score.capped ?? false,
      awards: win?.payload.score.awards ?? [],
      chipDeltas: [...end.chipDeltas] as FourSeats<number>,
      refusedWins,
      wallRemaining,
      eventCount: events.length,
      logSeqStart: events.length > 0 ? events[0].seq : 0,
      logSeqEnd: events.length > 0 ? events[events.length - 1].seq : 0,
      startedAt: row.startedAt,
      endedAt: this.deps.clock(),
    };
  }

  /**
   * Drain the outbox. A hand's events are deleted from DO storage ONLY once
   * both sinks have confirmed — the R2 blob part AND the D1 row — because until
   * then this object is the only copy. Each sink carries its own done flag, so
   * a half-success is retried on the failing half alone and never re-runs the
   * one that landed. Nothing is ever dropped: a record that keeps failing keeps
   * its events and backs off to the ceiling.
   */
  private async flushOutbox(): Promise<void> {
    const now = this.deps.clock();
    let nextAttempt = Number.POSITIVE_INFINITY;

    for (const handIndex of [...this.outbox.keys()].sort((a, b) => a - b)) {
      const rec = this.outbox.get(handIndex);
      if (!rec || !rec.sealed) continue;
      if (rec.nextAttemptAt > now) {
        nextAttempt = Math.min(nextAttempt, rec.nextAttemptAt);
        continue;
      }
      const events = await this.readHandEvents(handIndex);

      if (!rec.r2Done) {
        try {
          assertEventStreamWellFormed(this.requireMeta().header, events);
          await this.deps.archive.putHandLog(
            rec.logKey,
            omniscientMatchLog(this.requireMeta().header, events),
          );
          rec.r2Done = true;
        } catch (err) {
          rec.lastError = String(err);
        }
      }
      if (!rec.d1Done && rec.result) {
        try {
          await this.deps.archive.putHandResult(rec.result);
          rec.d1Done = true;
        } catch (err) {
          rec.lastError = String(err);
        }
      }

      if (rec.r2Done && rec.d1Done) {
        await this.deleteHandEvents(handIndex);
        this.outbox.delete(handIndex);
        await this.ctx.storage.delete([outboxKey(handIndex)]);
      } else {
        rec.attempts += 1;
        rec.nextAttemptAt =
          now +
          Math.min(
            this.config.outboxMaxBackoffMs,
            this.config.outboxBackoffMs * 2 ** Math.min(rec.attempts - 1, 20),
          );
        this.outbox.set(handIndex, rec);
        await this.ctx.storage.put({ [outboxKey(handIndex)]: rec });
        nextAttempt = Math.min(nextAttempt, rec.nextAttemptAt);
      }
    }

    if (this.book.matchSummaryPending && this.outbox.size === 0) {
      try {
        await this.deps.archive.finishMatch({
          matchId: this.requireMeta().matchId,
          reason: this.book.matchEndReason ?? "abandoned",
          handsPlayed: this.book.handsPlayed,
          standings: four((s) => this.requireState().seats[s].chips),
          placements: this.placements(),
          botTakeoverHands: [...this.book.botTakeoverHands] as FourSeats<number>,
          handLogKeys: [...this.book.handLogKeys],
          clients: [...this.book.clients] as FourSeats<string | null>,
          endedAt: now,
        });
        this.book.matchSummaryPending = false;
        this.book.summaryAttempts = 0;
      } catch {
        this.book.summaryAttempts += 1;
        nextAttempt = Math.min(
          nextAttempt,
          now +
            Math.min(
              this.config.outboxMaxBackoffMs,
              this.config.outboxBackoffMs * 2 ** Math.min(this.book.summaryAttempts - 1, 20),
            ),
        );
      }
    }

    if (Number.isFinite(nextAttempt)) {
      this.setDeadline("outboxFlush", nextAttempt, "flush");
      await this.persistCore();
      return;
    }
    this.clearDeadline("outboxFlush");
    await this.persistCore();
    if (this.book.matchOver && !this.book.matchSummaryPending && this.outbox.size === 0) {
      await this.dispose();
    }
  }

  /** 1-4 by chips; ties break by seat order from the starting dealer (§5.5). */
  private placements(): FourSeats<1 | 2 | 3 | 4> {
    const state = this.requireState();
    const order = [...SEATS].sort((a, b) => state.seats[b].chips - state.seats[a].chips || a - b);
    const place = four(() => 1 as 1 | 2 | 3 | 4);
    order.forEach((seat, i) => {
      place[seat] = (i + 1) as 1 | 2 | 3 | 4;
    });
    return place;
  }

  /**
   * MATCH_END with the outbox drained — and only then. Everything this object
   * held is now in R2 and D1, so the DO is disposable (§5.3). The tombstone
   * stays behind so a late socket is told the match is over rather than finding
   * an empty table that looks initialisable.
   */
  private async dispose(): Promise<void> {
    const meta = this.meta;
    const all = await this.ctx.storage.list<unknown>({ prefix: "" });
    const keys = [...all.keys()].sort().filter((k) => k !== K_TOMBSTONE);
    for (let i = 0; i < keys.length; i += STORAGE_BATCH) {
      await this.ctx.storage.delete(keys.slice(i, i + STORAGE_BATCH));
    }
    await this.ctx.storage.put({
      [K_TOMBSTONE]: { matchId: meta?.matchId ?? null, endedAt: this.deps.clock() },
    });
    await this.ctx.storage.deleteAlarm();
    this.tombstone = true;
    this.deadlines = {};
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "match over");
      } catch {
        /* already gone */
      }
    }
  }
}

/* ── 6. production wiring ──────────────────────────────────────────────── */

/** R2 + D1, against worker/schema.sql. Both writes are idempotent on their key. */
export function bindingArchive(env: TableEnv): Archive {
  const iso = (ms: number): string => new Date(ms).toISOString();
  return {
    async putHandLog(key, log) {
      if (!env.LOGS) throw new Error("LOGS bucket is not bound");
      await env.LOGS.put(key, JSON.stringify(log), {
        httpMetadata: { contentType: "application/json" },
      });
    },
    async putHandResult(row) {
      if (!env.DB) throw new Error("DB is not bound");
      await env.DB.prepare(
        `INSERT OR REPLACE INTO hands (
           match_id, hand_index, dealer_seat, round_wind, dealer_repeat, seed, outcome,
           winner_seat, winner_player_id, win_from_seat, win_from_player_id, winning_tile,
           self_draw, robbed_kong, on_kong_replacement,
           faan, raw_faan, capped, awards,
           delta_seat0, delta_seat1, delta_seat2, delta_seat3,
           refused_wins, wall_remaining, event_count, log_seq_start, log_seq_end,
           started_at, ended_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          row.matchId,
          row.handIndex,
          row.dealerSeat,
          row.roundWind,
          row.dealerRepeat,
          row.seed,
          row.outcome,
          row.winnerSeat,
          row.winnerPlayerId,
          row.winFromSeat,
          row.winFromPlayerId,
          row.winningTile,
          row.selfDraw ? 1 : 0,
          row.robbedKong ? 1 : 0,
          row.onKongReplacement ? 1 : 0,
          row.faan,
          row.rawFaan,
          row.capped ? 1 : 0,
          JSON.stringify(row.awards),
          row.chipDeltas[0],
          row.chipDeltas[1],
          row.chipDeltas[2],
          row.chipDeltas[3],
          row.refusedWins,
          row.wallRemaining,
          row.eventCount,
          row.logSeqStart,
          row.logSeqEnd,
          iso(row.startedAt),
          iso(row.endedAt),
        )
        .run();
    },
    async finishMatch(summary) {
      if (!env.DB) throw new Error("DB is not bound");
      if (!env.LOGS) throw new Error("LOGS is not bound");
      // The match-level object is a MANIFEST over the per-hand blobs, not a
      // copy of them: the hands' events left this object's storage as each
      // hand was confirmed, and the manifest is what `matches.log_key` points
      // at so the API can stitch the whole log back together on read.
      const manifestKey = `matches/${summary.matchId}/log.json`;
      await env.LOGS.put(
        manifestKey,
        JSON.stringify({ matchId: summary.matchId, hands: summary.handLogKeys }),
        { httpMetadata: { contentType: "application/json" } },
      );
      await env.DB.prepare(
        `UPDATE matches
            SET status = 'complete', hand_count = ?, ended_at = ?, log_key = ?
          WHERE id = ?`,
      )
        .bind(summary.handsPlayed, iso(summary.endedAt), manifestKey, summary.matchId)
        .run();
      for (const seat of SEATS) {
        await env.DB.prepare(
          `UPDATE match_players
              SET final_chips = ?, place = ?, bot_takeover_hands = ?, client = ?
            WHERE match_id = ? AND seat = ?`,
        )
          .bind(
            summary.standings[seat],
            summary.placements[seat],
            summary.botTakeoverHands[seat],
            summary.clients[seat],
            summary.matchId,
            seat,
          )
          .run();
      }
    },
  };
}

/**
 * The reducer and the bot policy are bound at module load by the Worker entry
 * rather than imported here. §5.5 requires an old hand to replay through the
 * engine build recorded on its own header — "keep old reducer builds loadable"
 * — and a static import of one build into the persistence layer forecloses
 * that. The seam also lets the outbox be tested without the engine at all.
 */
let installed: { rules: TableRules; bots: BotBrain } | null = null;

export function installTableRules(rules: TableRules, bots: BotBrain): void {
  installed = { rules, bots };
}

/** Only known numeric keys survive, so a typo cannot smuggle in a field. */
function configOverride(raw: string | undefined): Partial<TableConfig> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const out: Partial<TableConfig> = {};
  for (const key of Object.keys(DEFAULT_TABLE_CONFIG) as (keyof TableConfig)[]) {
    const v = (parsed as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

/**
 * The Durable Object binding target. Deliberately not extending
 * `DurableObject`: a DO class only needs these five methods, and skipping the
 * base class keeps `cloudflare:workers` out of a package that has no
 * Cloudflare dependency.
 */
export class TableDO {
  private readonly core: TableCore;

  constructor(ctx: TableCtx, env: TableEnv) {
    if (!installed) {
      throw new Error("installTableRules(rules, bots) must run before a table is constructed");
    }
    this.core = new TableCore(ctx, env, {
      rules: installed.rules,
      bots: installed.bots,
      archive: bindingArchive(env),
      clock: () => Date.now(),
      config: configOverride(env.TABLE_CONFIG),
    });
  }

  fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }
  alarm(): Promise<void> {
    return this.core.alarm();
  }
  webSocketMessage(ws: SeatSocket, message: string | ArrayBuffer): Promise<void> {
    return this.core.webSocketMessage(ws, message);
  }
  webSocketClose(ws: SeatSocket): Promise<void> {
    return this.core.webSocketClose(ws);
  }
  webSocketError(ws: SeatSocket): Promise<void> {
    return this.core.webSocketError(ws);
  }
}

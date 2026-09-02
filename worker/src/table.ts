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
import { INITIAL_RATING, RATING_SYSTEM_ID, provisionalK, updateRatings } from "../../engine/src/rating.js";
import type {
  Action,
  ClaimKind,
  ClaimOption,
  FaanAward,
  GameState,
  SeatIndex,
  TileId,
  WindIndex,
} from "@mjrc/engine";
import {
  CHAT_TEXT_MAX_LENGTH,
  EVENT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  acceptsProtocolVersion,
  accepted,
  assertEventStreamWellFormed,
  chatMessage,
  eventsMessage,
  isChatPhrase,
  isKnownRequestType,
  isSpeed,
  omniscientMatchLog,
  protocolFault,
  redactEventsFor,
  rejected,
  snapshotFor,
} from "@mjrc/protocol";
import type {
  ChatMessagePayload,
  ClientRequest,
  FourSeats,
  GameEvent,
  HandEndPayload,
  LegalRequests,
  MatchEndPayload,
  MatchLogHeader,
  MatchStartSettings,
  OmniscientMatchLog,
  PlayerRef,
  RejectCode,
  SeatDirectoryEntry,
  SeatSnapshot,
  SeatVisible,
  ServerToSeat,
  Speed,
  StartingPayload,
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
  /** Read-only. Only `bindingArchive`'s ranked settlement (`settleRatedMatch`)
   *  reads through this — every other D1 write in this file is fire-and-forget. */
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
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
  /**
   * Grade one decision against the champion, for the "how you played it"
   * record (owner: grading is a web-only feature, but the record itself is
   * computed here — server-authoritative, like everything else a bot knows).
   * `view`/`legal` are the seat's state and options BEFORE `action` is
   * applied — same information a human at that seat had when they chose it.
   * `null` means this action is not a gradable decision (a win is never a
   * choice, and neither is answering a window nothing was offered in).
   * Optional: a `BotBrain` that never grades is a legal one. Deterministic,
   * like `decide` — `rand` is a seeded stream private to this call.
   */
  grade?(
    view: SeatVisible<SeatSnapshot>,
    legal: LegalRequests,
    action: Action,
    rand: () => number,
  ): { matched: boolean; gap: number } | null;
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
  /** Decisions graded against the champion (owner: web-only grading, §BotBrain.grade). */
  movesGraded: FourSeats<number>;
  movesMatched: FourSeats<number>;
  gapSum: FourSeats<number>;
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
  /**
   * 摸 → 打. The seat's own clock; a bot takes the move when it expires. NOT
   * armed at all when the table has exactly one human seat (§8a rule 4) — a
   * lone human's turn waits indefinitely, and the disconnect grace plus
   * auto-play are what still cover an absent player. Multi-human tables keep
   * it.
   */
  turnMs: number;
  /**
   * The claim window's duration, by the STRONGEST option offered to a HUMAN
   * seat in it (kong counts as pung; §8a rule 3). A window where every
   * offered seat is bot-controlled ignores this entirely and resolves as
   * soon as the last bot answers (rule 2) — these numbers never even become
   * its `closesAt`. Once every human in the window has answered, it closes
   * at once; the duration below is only the ceiling while a human is still
   * pending.
   */
  claimWindowMs: { pung: number; chow: number; win: number };
  /** How long a dropped socket holds its seat before a bot plays it. */
  disconnectGraceMs: number;
  botMinPaceMs: number;
  botMaxPaceMs: number;
  /**
   * Margin keeping a bot's held answer strictly inside a window that has a
   * human pending. Does NOT apply to a bot-only window (§8a rule 2) — there,
   * nothing human-visible is being protected, so a bot paces itself all the
   * way up to its own `botMaxPaceMs` and the window closes the instant it
   * answers.
   */
  botWindowMarginMs: number;
  requestWindowMs: number;
  maxRequestsPerWindow: number;
  outboxBackoffMs: number;
  outboxMaxBackoffMs: number;
  /** A pause auto-resumes after this long (`dispatch("pauseTimeout")`). */
  pauseMaxMs: number;
  /**
   * How long a `handEnd` is held before the next hand is dealt, when a human
   * seat is connected — so a win does not "snap" straight into the next deal
   * with nothing to look at. 0 disables the intermission: the table advances
   * at once, same as before this field existed.
   */
  handEndIntermissionMs: number;
  /**
   * §8a-2's `untimed` inactivity timeout: a human seat prompted (its turn, or
   * an open window it has not answered) with no request from it for this long
   * is switched to auto-play (`book.auto`), same as a player-toggled
   * `requestAuto { on: true }` — the seat's next request switches it off
   * again (§`RequestAutoPayload`). 0 disables the mechanism entirely, which is
   * every preset but `untimed` (`SPEED_PRESETS`) unless overridden.
   */
  inactivityMs: number;
  /**
   * The start card's hold (§8a-2): `maybeStartClocks` broadcasts `starting`
   * and waits this long before actually starting the clocks, so every seat
   * sees the match's rules before the first tile moves. 0 skips the hold —
   * the table starts the instant it is full, same as before this feature
   * existed; the fast dev config (`.dev.vars`) sets it to 0 for the same
   * reason it compresses every other clock. A bot-only table always skips
   * the hold regardless of this value (`maybeStartClocks`) — there is nobody
   * for the card to be shown to.
   */
  startDelayMs: number;
}

export const DEFAULT_TABLE_CONFIG: TableConfig = {
  turnMs: 20_000,
  claimWindowMs: { pung: 6_000, chow: 12_000, win: 15_000 },
  disconnectGraceMs: 30_000,
  botMinPaceMs: 250,
  botMaxPaceMs: 900,
  botWindowMarginMs: 400,
  requestWindowMs: 10_000,
  maxRequestsPerWindow: 40,
  outboxBackoffMs: 1_000,
  outboxMaxBackoffMs: 60_000,
  pauseMaxMs: 10 * 60_000,
  handEndIntermissionMs: 10_000,
  inactivityMs: 0,
  startDelayMs: 8_000,
};

/**
 * §8a-2's clock speeds, as `TableConfig` overrides layered on top of
 * `DEFAULT_TABLE_CONFIG` (`mergeTableConfig`). Deliberately data, not code —
 * this table IS the proposal's speed table, verbatim. Fields the proposal's
 * table does not mention for a given speed (`botWindowMarginMs`,
 * `disconnectGraceMs`, ...) are left for the default/env layers to decide.
 *
 * `untimed`'s `claimWindowMs: 0` and `turnMs: 0` are the "no deadline while a
 * human is unanswered" rule (`computeWindowClosesAt`, `armDerived`) — bots in
 * an `untimed` table still pace themselves at `botMinPaceMs`-`botMaxPaceMs`,
 * which is why `untimed` still sets those two like every other preset.
 * `untimed` is also the only preset that turns on `inactivityMs` — every
 * other speed already has a clock, so a silent human times out through that
 * instead.
 */
export const SPEED_PRESETS: Record<Speed, Partial<TableConfig>> = {
  untimed: {
    turnMs: 0,
    claimWindowMs: { pung: 0, chow: 0, win: 0 },
    botMinPaceMs: 250,
    botMaxPaceMs: 900,
    handEndIntermissionMs: 10_000,
    inactivityMs: 600_000,
  },
  "very-slow": {
    turnMs: 60_000,
    claimWindowMs: { pung: 15_000, chow: 20_000, win: 30_000 },
    botMinPaceMs: 600,
    botMaxPaceMs: 1_500,
    handEndIntermissionMs: 15_000,
  },
  normal: {
    turnMs: 40_000,
    claimWindowMs: { pung: 10_000, chow: 15_000, win: 20_000 },
    botMinPaceMs: 400,
    botMaxPaceMs: 1_200,
    handEndIntermissionMs: 12_000,
  },
  faster: {
    turnMs: 20_000,
    claimWindowMs: { pung: 6_000, chow: 12_000, win: 15_000 },
    botMinPaceMs: 250,
    botMaxPaceMs: 900,
    handEndIntermissionMs: 10_000,
  },
  insane: {
    turnMs: 8_000,
    claimWindowMs: { pung: 3_000, chow: 4_000, win: 6_000 },
    botMinPaceMs: 150,
    botMaxPaceMs: 400,
    handEndIntermissionMs: 5_000,
  },
};

const speedPresetFor = (speed: Speed | undefined): Partial<TableConfig> | undefined =>
  speed === undefined ? undefined : SPEED_PRESETS[speed];

/**
 * Layer zero or more `Partial<TableConfig>`s onto `DEFAULT_TABLE_CONFIG`, in
 * order — `TableCore`'s own "DEFAULT ← env `TABLE_CONFIG` ← speed preset ←
 * `TableInit.config`" resolution (`recomputeConfig`). `claimWindowMs` merges
 * key by key, same as `configOverride`'s env-var parsing: a later layer that
 * sets only `pung` leaves `chow`/`win` at whatever the earlier layers left
 * them, never resets them to `DEFAULT_TABLE_CONFIG`'s.
 */
function mergeTableConfig(...layers: readonly (Partial<TableConfig> | undefined)[]): TableConfig {
  let out: TableConfig = { ...DEFAULT_TABLE_CONFIG };
  for (const layer of layers) {
    if (!layer) continue;
    const { claimWindowMs, ...rest } = layer;
    out = { ...out, ...rest };
    if (claimWindowMs) out = { ...out, claimWindowMs: { ...out.claimWindowMs, ...claimWindowMs } };
  }
  return out;
}

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
  /**
   * Uniform [0, 1) for `handleFill`'s seat shuffle (lobby §6 decision 3) —
   * NEVER `prng(seed)`: that stream is reserved for game facts a replay must
   * reproduce, and who sat where before the clocks started is coordination,
   * exactly like `mintSeatToken`. Injected so the shuffle is testable;
   * production wiring uses the platform's CSPRNG. Defaults to that CSPRNG
   * when omitted, so every existing caller of `TableCore`'s constructor keeps
   * working unchanged.
   */
  rand?: () => number;
  /**
   * The bot profile that fills seat `seat` when `/fill` finds it still empty
   * and the seat plan named no specific key (worker/README.md §8: "use the
   * deployment's default lineup"). Opaque `key` — same seam as
   * `TableSpec.bots` (gamepvp/src/bots.ts `BOT_LINEUP`). Absent means every
   * unfilled seat falls back to a generic bot identity.
   */
  defaultBotFor?: (seat: SeatIndex) => { key: string; displayName: string };
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
  /**
   * Shuffle the player↔seat mapping when `/fill` starts the clocks (lobby §6
   * decision 3). Carried from `matches.randomize_seats` because the DECISION
   * was the creator's, made at `POST /api/tables` time — `/fill` only carries
   * it out, it does not re-decide it.
   */
  randomizeSeats?: boolean;
  /**
   * §8a-2's clock speed, resolved once by the platform Worker (`postTable`'s
   * default rule, or a room's `settings.game.speed`) — the table only ever
   * APPLIES a speed, it never re-derives the default from seat counts itself.
   * Absent (an older init, or a test that does not care) means no preset
   * layer at all: `DEFAULT_TABLE_CONFIG` and the env `TABLE_CONFIG` alone
   * decide, exactly as before this field existed.
   */
  speed?: Speed;
  /**
   * Extra `TableConfig` overrides layered on top of the speed preset
   * (`recomputeConfig`'s "DEFAULT ← env ← speed preset ← this"). Nothing in
   * production sets this today; the seam exists for a future per-table
   * override and for tests that want a precise config without a preset name.
   */
  config?: Partial<TableConfig>;
  /**
   * The start card's ruleset facts (§8a-2's `MatchStartSettings`), resolved
   * once by the platform Worker entry (`gamepvp/src/index.ts` `tableInitOf`)
   * via `@mjrc/rulesets` — so this file, which decides nothing about the
   * game, never has to import a ruleset preset to describe one. Absent (a
   * test, or an init that predates the start card) falls back to generic
   * values in `startingPayload` rather than failing the init.
   */
  matchSettings?: {
    rulesetLabel: string;
    minimumFaan: number;
    limitFaan: number;
    useFlowers: boolean;
    paymentId: string;
    /** east | full (DESIGN.md §4) — the wire spelling, not `header.matchLength`. */
    matchFormat: string;
  };
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
  | `botPace:${SeatIndex}`
  /** Auto-resumes a pause (`TableConfig.pauseMaxMs`). The one deadline that
   *  keeps ticking, and firing, while the table is paused — see `rearm`. */
  | "pauseTimeout"
  /** Fires the held next deal at the end of the hand-end intermission. */
  | "nextHand"
  /** Ends the start card's hold (§8a-2) and actually starts the clocks. */
  | "matchStart"
  /** §8a-2's `untimed` inactivity timeout: this seat has been prompted (its
   *  turn, or an open window) with no request from it for `inactivityMs`. */
  | `idle:${SeatIndex}`;

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
  /** Move grading against the champion, per seat (owner: web-only feature,
   *  computed here regardless — §BotBrain.grade). */
  grading: FourSeats<SeatGrading>;
  /**
   * `null` unless the table is paused. `bySeat` is who paused it; `at` is the
   * wall clock `deps.clock()` returned at that moment — `resumeNow`'s shift
   * (`now - at`) is what every other deadline moves by on resume.
   */
  paused: { bySeat: SeatIndex; at: number } | null;
  /**
   * Player-toggled auto-play (`RequestAutoPayload`), one flag per seat.
   * Deliberately separate from `presence.botActing`: a reconnect resets
   * `botActing` (`handleJoin`) but must NOT touch this — auto-play is a
   * standing choice, not a symptom of the socket being down.
   */
  auto: FourSeats<boolean>;
  /**
   * The `handEnd` this table is holding for the intermission (`afterCommit`),
   * or `null` when nothing is held. The next deal is one `dispatchNextHand`
   * away — either the `nextHand` deadline, or every connected human sending
   * `requestNextHand`.
   */
  pendingHandEnd: {
    handIndex: number;
    payload: HandEndPayload;
    row: { dealerRepeat: number; startedAt: number };
  } | null;
  /** Which connected human seats have asked to skip the rest of the
   *  intermission (`requestNextHand`) — OR, before the match has ever
   *  started, to end the start card's hold early (§8a-2). One flag, two
   *  holds, because the two never overlap in time: `pendingHandEnd` cannot
   *  exist before `started` is true, and `startingAt` cannot exist after.
   *  Reset every time a new hold — a `handEnd` or the start card — begins. */
  nextHandRequests: FourSeats<boolean>;
  /**
   * The start card's hold (§8a-2): the wall-clock time the clocks start on
   * their own, or `null` when no hold is open — either because the table has
   * not filled yet, has already started, or skipped the hold entirely (a
   * bot-only table, or `startDelayMs` disabled). Mirrors `pendingHandEnd`'s
   * shape: set once by `maybeStartClocks`, cleared by `dispatchMatchStart`.
   */
  startingAt: number | null;
}

interface SeatGrading {
  graded: number;
  matched: number;
  gapSum: number;
}

/* ── 4. small helpers ──────────────────────────────────────────────────── */

const SEATS: readonly SeatIndex[] = [0, 1, 2, 3];
const MAX_DISPATCHES_PER_ALARM = 32;
const STORAGE_BATCH = 100;

/** The `deadlineTs`/`closesAt` sentinel for "no deadline armed" — `sendPrompts`
 *  already falls back to this for a seat with no `turnClock` armed (§8a rule
 *  4); `computeWindowClosesAt` returns it for the same reason under §8a-2's
 *  `untimed` preset, so a client reads one convention for "waiting on a
 *  human, no countdown" everywhere. */
const NO_DEADLINE = 0;

const K_META = "meta";
const K_STATE = "state";
const K_SEQ = "seq";
const K_DEADLINES = "deadlines";
const K_WINDOW = "window";
const K_PRESENCE = "presence";
const K_BOOK = "book";
const K_CHAT = "chat";
const K_TOMBSTONE = "tombstone";
const P_OUTBOX = "ob:";
const P_EVENT = "ev:";

/** Table chat (§8): last N, and the per-seat minimum gap between messages —
 *  IN ADDITION to the table's general per-seat request limiter, never instead
 *  of it. Persisted under K_CHAT, never in the event log, never archived to
 *  R2 (this file's header, item 3: chat is not a game fact). */
const CHAT_RING_SIZE = 50;
const CHAT_MIN_INTERVAL_MS = 1_000;

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

/**
 * `bot:<key>`, or `bot:<key>#2`, `bot:<key>#3`, ... when the same catalogue
 * key already names another seat AT THIS TABLE — `used` is every playerId
 * already assigned there. Without this, two seats picking the same bot
 * profile (a client is free to ask for that — `parseSeatsBody`,
 * worker/src/index.ts, places no such restriction) would mint the SAME
 * playerId twice, and `UNIQUE (match_id, player_id)` on `match_players`
 * (schema.sql) would silently drop the second seat's standings row.
 *
 * The alternative — dropping that constraint — was rejected: it is a SQLite
 * table rebuild (no in-place `ALTER ... DROP CONSTRAINT`), and it would also
 * let a genuine bug (the SAME seat claimed twice) through silently instead of
 * failing loudly. A seat suffix costs one extra `players` row per duplicate
 * pick and nothing else — `gamepvp/src/bots.ts`'s `keyOfPlayerId` strips the
 * `#N` back off before it ever reaches a profile-dial lookup, so bot
 * strength/grading are unaffected by which occurrence a seat is.
 *
 * Exported so `gamepvp/src/index.ts`'s initial seat-plan resolution
 * (`tableInitOf`) and this file's own `/fill` path share one rule — two
 * independently-invented suffix schemes would be worse than either alone.
 */
export function botPlayerId(key: string, used: ReadonlySet<string>): string {
  const base = `bot:${key}`;
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}#${n}`)) n += 1;
  return `${base}#${n}`;
}

/** Coordination entropy, same rule as `mintSeatToken`: the platform's CSPRNG,
 *  never `prng(seed)`. The production default for `TableDeps.rand`. */
function cryptoRand(): number {
  const buf = new Uint32Array(1);
  (globalThis as { crypto: { getRandomValues(a: Uint32Array): Uint32Array } }).crypto.getRandomValues(buf);
  return buf[0]! / 0x1_0000_0000;
}

/** Fisher-Yates over the four seats. Pure function of `rand`, so a seeded
 *  `rand` makes the permutation reproducible in tests (`handleFill`'s doc
 *  comment). Returns `perm` where `perm[oldSeat]` is the NEW seat that
 *  player held `oldSeat` moves to. */
function shuffleSeats(rand: () => number): FourSeats<SeatIndex> {
  const order: SeatIndex[] = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  // `order[newSeat] = oldSeat` — the standard Fisher-Yates result read
  // exactly as it comes out, no inversion. `shufflePlayers` builds seat
  // `newSeat`'s new contents by reading `order[newSeat]`.
  return order as FourSeats<SeatIndex>;
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
    "chatRefused",
    "pauseRefused",
    "paused",
    "autoRefused",
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
  name === "turnClock" ||
  name === "claimWindow" ||
  name.startsWith("botPace:") ||
  name.startsWith("idle:");

/** The DO owns the clock, so it fills the deadline the reducer left at 0. */
function stampWindowDeadline(e: GameEvent, at: number): GameEvent {
  if (e.type === "claimOffered") return { ...e, payload: { ...e.payload, deadlineTs: at } };
  if (e.type === "robKongWindow") return { ...e, payload: { ...e.payload, deadlineTs: at } };
  return e;
}

/**
 * Stamps `HandEndPayload.nextHandTs` when the table is about to hold this
 * hand's end for the intermission — `undefined` (the field's default state,
 * meaning "advances at once") otherwise. Same shape as `stampWindowDeadline`:
 * a coordination fact the reducer never sets, filled in on the way out.
 */
function stampHandEndDeadline(e: GameEvent, nextHandTs: number | undefined): GameEvent {
  if (e.type !== "handEnd" || nextHandTs === undefined) return e;
  return { ...e, payload: { ...e.payload, nextHandTs } };
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
    grading: four(() => ({ graded: 0, matched: 0, gapSum: 0 })),
    paused: null,
    auto: [false, false, false, false],
    pendingHandEnd: null,
    nextHandRequests: [false, false, false, false],
    startingAt: null,
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
  /** The env `TABLE_CONFIG` layer alone (`TableDO`'s `configOverride`) — the
   *  one layer that never changes for this object's lifetime. `recomputeConfig`
   *  re-derives `config` from this plus whatever `meta.speed`/`meta.config`
   *  currently say, on every hydration and right after `handleInit` sets meta. */
  private readonly envConfig: Partial<TableConfig>;
  /** DEFAULT ← `envConfig` ← speed preset ← `meta.config` (`recomputeConfig`).
   *  NOT readonly: a speed is not known until `handleInit`, and hibernation
   *  means every wake has to re-derive it rather than trust an in-memory copy. */
  private config: TableConfig;
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
  /** Last 50 chat messages (§8), oldest first. Persisted under K_CHAT,
   *  outside `persistCore`'s batch because nothing else ever touches it —
   *  `handleChat` is the one writer. */
  private chat: ChatMessagePayload[] = [];
  private outbox = new Map<number, OutboxRecord>();
  private tombstone = false;

  /** Per-seat chat cadence (§8's 1/s, in addition to the general limiter).
   *  In-memory only, same doctrine as `rate`/`seenRequests` below: losing this
   *  on a wake costs at most one extra allowed message, never a stuck table. */
  private chatRate = new Map<number, number>();
  /** Depth of the handEnd → startNextHand chain. A reducer that emitted a
   *  handEnd from `startNextHand` would otherwise spin here forever. */
  private advanceDepth = 0;

  /** In-memory only: losing these on a wake costs at most a duplicate refusal. */
  private rate = new Map<number, { windowStart: number; count: number }>();
  private seenRequests: string[] = [];

  /**
   * The serialized JSON this object last actually WROTE for each of
   * `persistCore`'s seven keys (§`corePairs`) — never a value it merely read.
   * `persistCore`/`commit` diff against this so a key whose value has not
   * changed since the last write is left out of the batch entirely; a DO's
   * row-write quota (Cloudflare Workers Free: 100k/day) is charged one row
   * per KEY per `put`, so writing seven keys on every commit — most of them
   * unchanged — was most of this object's quota bill.
   *
   * Seeded from `load()`'s post-hydration values, not from the raw storage
   * read: `presence` in particular is RECONCILED from live sockets on every
   * wake and never trusted from storage (`load`'s own comment), so the
   * correct "already written" baseline is what hydration settled on, not
   * whatever byte happened to be on disk. Safe in general because every
   * field's cold-start default (`load`'s `?? …` fallbacks) is a pure,
   * deterministic function of nothing (or of already-durable data) — so a
   * key whose current value equals that recomputable baseline never needs a
   * row spent re-asserting it: a future `load()` reconstructs the identical
   * value whether or not this exact byte ever reached storage.
   *
   * Entries are updated ONLY after the corresponding `storage.put` call has
   * resolved without throwing — never optimistically before the write — so a
   * failed `put` (quota, transient error) leaves the diff still "dirty" and
   * the next attempt retries the same keys instead of silently losing them.
   */
  private lastWritten = new Map<string, string>();

  constructor(
    private readonly ctx: TableCtx,
    private readonly env: TableEnv,
    private readonly deps: TableDeps,
  ) {
    this.envConfig = deps.config ?? {};
    this.config = mergeTableConfig(this.envConfig);
  }

  /**
   * DEFAULT_TABLE_CONFIG ← `envConfig` ← the speed preset named by
   * `meta.speed` ← `meta.config` (§8a-2's resolution order, and this file's
   * header item 2: named deadlines still get this right because every deadline
   * math reads `this.config`, never a captured value from before a wake).
   * Meta not yet loaded (nothing initialised this table) resolves to just the
   * env layer, same as before `speed`/`config` existed.
   */
  private recomputeConfig(): void {
    const speed = this.meta && isSpeed(this.meta.speed) ? this.meta.speed : undefined;
    this.config = mergeTableConfig(this.envConfig, speedPresetFor(speed), this.meta?.config);
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
    // The effective config depends on `meta.speed`/`meta.config`, so it is
    // re-derived on every wake — see `recomputeConfig`'s doc comment: this is
    // what makes a speed picked before hibernation survive it.
    this.recomputeConfig();
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
    if (!Array.isArray(this.book.grading) || this.book.grading.length !== 4) {
      this.book.grading = four(() => ({ graded: 0, matched: 0, gapSum: 0 }));
    }
    if (this.book.paused === undefined) this.book.paused = null;
    if (!Array.isArray(this.book.auto) || this.book.auto.length !== 4) {
      this.book.auto = [false, false, false, false];
    }
    if (this.book.pendingHandEnd === undefined) this.book.pendingHandEnd = null;
    if (!Array.isArray(this.book.nextHandRequests) || this.book.nextHandRequests.length !== 4) {
      this.book.nextHandRequests = [false, false, false, false];
    }
    if (this.book.startingAt === undefined) this.book.startingAt = null;
    this.chat = (await st.get<ChatMessagePayload[]>(K_CHAT)) ?? [];
    if (!Array.isArray(this.chat)) this.chat = [];

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

    // Seed the write-diff baseline from what hydration settled on (see
    // `lastWritten`'s doc comment) — AFTER presence reconciliation, so a
    // reconnect-derived `connected` flip that storage never saw is not
    // mistaken for a pending change.
    this.lastWritten = new Map(this.corePairs().map(([key, value]) => [key, JSON.stringify(value)]));
  }

  private requireMeta(): TableMeta {
    if (!this.meta) throw new Error("table is not initialised");
    return this.meta;
  }

  private requireState(): GameState {
    if (!this.state) throw new Error("table has no state");
    return this.state;
  }

  /** The seven keys `persistCore`/`commit` keep durable, in the fixed order
   *  every caller must diff and stamp them in. */
  private corePairs(): [string, unknown][] {
    return [
      [K_META, this.meta],
      [K_STATE, this.state],
      [K_SEQ, this.seq],
      [K_DEADLINES, this.deadlines],
      [K_WINDOW, this.window],
      [K_PRESENCE, this.presence],
      [K_BOOK, this.book],
    ];
  }

  /**
   * The subset of `corePairs()` whose serialized value differs from
   * `lastWritten` — what actually needs a row this time. Returns the patch to
   * write AND every key's fresh serialization, so a caller that goes on to
   * `put` the patch successfully can hand the same map to `markCoreWritten`
   * without re-serializing. Pure: does not touch `lastWritten` itself, so a
   * caller that never writes (or whose write throws) leaves the diff dirty
   * for the next attempt.
   */
  private changedCore(): { patch: Record<string, unknown>; serialized: Map<string, string> } {
    const patch: Record<string, unknown> = {};
    const serialized = new Map<string, string>();
    for (const [key, value] of this.corePairs()) {
      const json = JSON.stringify(value);
      serialized.set(key, json);
      if (this.lastWritten.get(key) !== json) patch[key] = value;
    }
    return { patch, serialized };
  }

  /** Record that `keys` were just durably written as `serialized` says —
   *  call ONLY after the `storage.put` carrying them has resolved. */
  private markCoreWritten(serialized: Map<string, string>, keys: Iterable<string>): void {
    for (const key of keys) {
      const json = serialized.get(key);
      if (json !== undefined) this.lastWritten.set(key, json);
    }
  }

  /**
   * Writes only the core keys that changed since the last write — see
   * `lastWritten`'s doc comment. A no-op, with no `storage.put` call at all,
   * when nothing changed: most `alarm()` dispatches and every `flushOutbox`
   * pass that only touched the outbox record land here.
   */
  private async persistCore(): Promise<void> {
    const { patch, serialized } = this.changedCore();
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    await this.ctx.storage.put(patch);
    this.markCoreWritten(serialized, keys);
  }

  /* ── HTTP ────────────────────────────────────────────────────────────── */

  async fetch(request: Request): Promise<Response> {
    await this.hydrate();
    const url = new URL(request.url);
    if (url.pathname.endsWith("/init")) return this.handleInit(request);
    if (url.pathname.endsWith("/seat")) return this.handleSeat(request);
    if (url.pathname.endsWith("/fill")) return this.handleFill(request);
    if (url.pathname.endsWith("/leave")) return this.handleLeave(request);
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
      init.header.matchId !== init.matchId ||
      (init.speed !== undefined && !isSpeed(init.speed))
    ) {
      return new Response("malformed init", { status: 400 });
    }
    this.meta = { ...init, startedAt: this.deps.clock() };
    // The speed preset (if any) is part of `meta` from this line on, so
    // derive `config` from it now rather than leaving it at the env-only
    // baseline the constructor set before this table was ever initialised.
    this.recomputeConfig();
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

  /**
   * Lobby → table: the creator's "start now, fill the rest with bots" (§7.2
   * `/start`, PVP-LOBBY-PROPOSAL-2026-09-02.md §3.4). Every human seat nobody
   * has EVER claimed (`playerId === ""` — `handleSeat`'s own test) becomes a
   * bot; a seat a human already claimed but has not yet opened a socket is
   * left alone — that is "joined but currently offline", which the
   * disconnect-grace/bot-takeover path already covers, and `/fill` is
   * answering a different question ("nobody ever showed up at all"). Then, if
   * the table was created with `randomizeSeats`, the player↔seat mapping is
   * shuffled — before the clocks start, so it decides nothing about a hand
   * nobody has looked at yet. Finally the existing clock-start path runs,
   * same as when the last human seat connects on its own.
   *
   * Idempotent: once the table has started this is a no-op 200 — a retried
   * request, or a second click, changes nothing.
   */
  private async handleFill(request: Request): Promise<Response> {
    const secret = this.env.TABLE_SECRET;
    if (secret && !tokensMatch(request.headers.get("x-mjrc-table-secret") ?? "", secret)) {
      return new Response("forbidden", { status: 403 });
    }
    if (this.tombstone || this.book.matchOver) return new Response("match over", { status: 410 });
    if (!this.meta) return new Response("table not initialised", { status: 409 });

    const okResponse = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    if (this.book.started) return okResponse();

    const meta = this.meta;
    const players = four((seat) => meta.header.players[seat]);
    // Every bot playerId already at this table (seats the seat plan opened as
    // bots at `/init` time) — `botPlayerId`'s dedupe set, so a `/fill` pick
    // that collides with one of THOSE gets suffixed too, not just collisions
    // among `/fill`'s own picks.
    const used = new Set<string>(players.filter((p) => p.bot).map((p) => p.playerId));
    for (const seat of SEATS) {
      const current = players[seat];
      if (current.bot || current.playerId !== "") continue;
      const pick = this.deps.defaultBotFor?.(seat) ?? {
        key: `seat${seat}`,
        displayName: `Bot ${seat + 1}`,
      };
      const playerId = botPlayerId(pick.key, used);
      used.add(playerId);
      players[seat] = { playerId, displayName: pick.displayName, seat, bot: true };
      await this.ensureBotPlayerRow(playerId, pick.displayName);
      await this.claimBotSeat(seat, playerId);
    }
    this.meta = { ...meta, header: { ...meta.header, players } };

    if (this.meta.randomizeSeats) this.shufflePlayers(this.deps.rand ?? cryptoRand);

    await this.persistCore();
    await this.maybeStartClocks();
    return okResponse();
  }

  /**
   * Permute the player↔seat mapping (lobby §6 decision 3): `header.players`,
   * `seatTokens`, `presence` and the client-recorded bookkeeping move
   * together. The dealt hand (`state`) does NOT move — it stays keyed by
   * physical seat, because a permutation of who sits where before the clocks
   * start decides nothing about a hand nobody has looked at yet
   * (`handleInit`'s doc comment: hand 0 is dealt with nobody connected). Any
   * socket already open is rewritten in place, because the only thing a
   * client remembers is its seat token, and the token stays valid at
   * whichever seat it now resolves to — `handleJoin` matches by token, not by
   * the seat a client last heard it was at.
   */
  private shufflePlayers(rand: () => number): void {
    const meta = this.requireMeta();
    const order = shuffleSeats(rand); // order[newSeat] = the seat that moves there

    const newPlayers = four((newSeat) => ({ ...meta.header.players[order[newSeat]], seat: newSeat }));
    const newSeatTokens = four((newSeat) => meta.seatTokens[order[newSeat]]);
    const newPresence = four((newSeat) => this.presence[order[newSeat]]);
    const newClients = four((newSeat) => this.book.clients[order[newSeat]]);

    this.meta = { ...meta, header: { ...meta.header, players: newPlayers }, seatTokens: newSeatTokens };
    this.presence = newPresence;
    this.book.clients = newClients;

    const newSeatOfOld = new Map<SeatIndex, SeatIndex>();
    order.forEach((oldSeat, newSeat) => newSeatOfOld.set(oldSeat, newSeat as SeatIndex));
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (!att) continue;
      const newSeat = newSeatOfOld.get(att.seat);
      if (newSeat === undefined || newSeat === att.seat) continue;
      ws.serializeAttachment({
        matchId: att.matchId,
        seat: newSeat,
        playerId: att.playerId,
      } satisfies SocketAttachment);
    }
  }

  /** Bots are players (schema.sql `players.kind = 'bot'`) and `hands`
   *  references them by id, so a row must exist before the first hand that
   *  names this bot can be archived — same requirement `ensureBotPlayers`
   *  meets at table creation (gamepvp/src/index.ts), just reached from
   *  inside the table object because `/fill` is the first place a NEW bot
   *  identity can appear after creation. Idempotent (`INSERT OR IGNORE`);
   *  fire-and-forget like every other lobby write from this object (item 6:
   *  a D1 hiccup here must never stop `/fill` from starting the match). */
  private async ensureBotPlayerRow(playerId: string, displayName: string): Promise<void> {
    if (!this.env.DB) return;
    try {
      const now = new Date(this.deps.clock()).toISOString();
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO players (id, kind, display_name, created_at, updated_at, last_seen_at)
         VALUES (?, 'bot', ?, ?, ?, ?)`,
      )
        .bind(playerId, displayName, now, now, now)
        .run();
    } catch (err) {
      console.error("ensureBotPlayerRow failed", this.meta?.matchId, playerId, err);
    }
  }

  /**
   * `match_players` row for a bot seat filled by `/fill` — same UNIQUE-safe
   * insert `claimSeat` (worker/src/db.ts) uses for a human's, reused as a
   * literal statement here rather than imported: this file's `D1Like` is a
   * narrower structural surface than db.ts's (worker/README.md §2), and a
   * bot seat is never claimed through the platform's HTTP layer that
   * `claimSeat` serves. Without this a bot who only ever arrived via
   * `/fill` has no `match_players` row, and its standings vanish from match
   * detail and the lobby's recent-results strip exactly like the seats
   * `/init` opens as bots already did before this file's own dedupe fix —
   * see `botPlayerId`. Idempotent (`OR IGNORE`), best-effort like every
   * other lobby write from this object.
   */
  private async claimBotSeat(seat: SeatIndex, playerId: string): Promise<void> {
    if (!this.env.DB) return;
    try {
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO match_players (match_id, seat, player_id, wind) VALUES (?, ?, ?, ?)`,
      )
        .bind(this.requireMeta().matchId, seat, playerId, seat)
        .run();
    } catch (err) {
      console.error("claimBotSeat failed", this.meta?.matchId, seat, playerId, err);
    }
  }

  /** `matches.lobby_status` — 'playing' when the clocks start, 'done' at
   *  match end (`bindingArchive.finishMatch`, which folds it into the same
   *  UPDATE it already runs rather than a second round trip). Best-effort:
   *  the game itself never depends on this column, only the stateless lobby
   *  read does. */
  private async writeLobbyStatus(status: string): Promise<void> {
    if (!this.env.DB) return;
    try {
      await this.env.DB.prepare(`UPDATE matches SET lobby_status = ? WHERE id = ?`)
        .bind(status, this.requireMeta().matchId)
        .run();
    } catch (err) {
      console.error("writeLobbyStatus failed", this.meta?.matchId, status, err);
    }
  }

  /** `matches.current_hand`, so the lobby can show "hand 3 of ~8" without
   *  opening a socket (schema.sql, "Lobby-facing"). One UPDATE per deal,
   *  best-effort — a D1 hiccup here must never interrupt the hand that just
   *  started. */
  private async writeCurrentHand(handIndex: number): Promise<void> {
    if (!this.env.DB) return;
    try {
      await this.env.DB.prepare(`UPDATE matches SET current_hand = ? WHERE id = ?`)
        .bind(handIndex, this.requireMeta().matchId)
        .run();
    } catch (err) {
      console.error("writeCurrentHand failed", this.meta?.matchId, handIndex, err);
    }
  }

  /** `match_players.connected` — a lobby-facing cache of "is this seat's
   *  human here right now" (schema.sql, "Lobby-facing"). A no-op UPDATE for a
   *  bot seat, which never has a `match_players` row to match (nothing ever
   *  inserts one — see `humanSeatsOfMatch`'s doc comment in worker/src/db.ts).
   *  Best-effort, like every other lobby write from this object. */
  private async writeSeatConnected(seat: SeatIndex, connected: boolean): Promise<void> {
    if (!this.env.DB) return;
    try {
      await this.env.DB.prepare(`UPDATE match_players SET connected = ? WHERE match_id = ? AND seat = ?`)
        .bind(connected ? 1 : 0, this.requireMeta().matchId, seat)
        .run();
    } catch (err) {
      console.error("writeSeatConnected failed", this.meta?.matchId, seat, err);
    }
  }

  /**
   * Lobby → table: a participant's explicit leave (§7.2 `/leave`). The seat
   * is marked bot-acting for the rest of the match — the same state a
   * disconnect grace expiring produces (`onGraceExpired`) — so it plays out
   * exactly like a takeover: counted in `bot_takeover_hands`, decided by
   * `BotBrain` from here on. Its socket, if any, is closed with 4001 "left" so
   * the client can tell a deliberate leave from a network drop. The seat
   * token is untouched: reclaim stays possible, which is the feature — "I
   * left, changed my mind" is a rejoin (proposal §3.2).
   *
   * Idempotent: a seat already bot-acting, or a bot seat, answers 200 and
   * changes nothing further (the socket-close loop still runs, harmlessly,
   * in case a stray reconnect raced this call).
   */
  private async handleLeave(request: Request): Promise<Response> {
    const secret = this.env.TABLE_SECRET;
    if (secret && !tokensMatch(request.headers.get("x-mjrc-table-secret") ?? "", secret)) {
      return new Response("forbidden", { status: 403 });
    }
    if (this.tombstone || this.book.matchOver) return new Response("match over", { status: 410 });
    if (!this.meta) return new Response("table not initialised", { status: 409 });

    let body: { playerId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response("malformed leave", { status: 400 });
    }
    const playerId = body.playerId;
    if (typeof playerId !== "string" || playerId === "") {
      return new Response("malformed leave", { status: 400 });
    }

    const meta = this.meta;
    const seat = SEATS.find((s) => meta.header.players[s].playerId === playerId);
    if (seat === undefined) return new Response("not seated", { status: 404 });

    if (!meta.header.players[seat].bot && !this.presence[seat].botActing) {
      this.presence[seat] = { connected: false, botActing: true };
      this.armDerived(this.deps.clock());
      await this.persistCore();
      this.broadcastPresence(seat);
      await this.rearm();
    }
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (att?.seat === seat) ws.close(4001, "left");
    }
    return new Response(JSON.stringify({ ok: true }), {
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

  // Diagnostic logging on the socket lifecycle is deliberate: a dropped seat
  // on the live platform is invisible otherwise, and the close code is the
  // only clue whether the client, an intermediary or the runtime ended it.
  async webSocketClose(ws: SeatSocket, code?: number, reason?: string, wasClean?: boolean): Promise<void> {
    const att = this.attachmentOf(ws);
    console.log("ws close", this.meta?.matchId ?? "?", "seat", att?.seat ?? "?", "code", code, "reason", reason, "clean", wasClean);
    await this.onSocketGone(ws);
  }

  async webSocketError(ws: SeatSocket, error?: unknown): Promise<void> {
    const att = this.attachmentOf(ws);
    console.error("ws error", this.meta?.matchId ?? "?", "seat", att?.seat ?? "?", String(error));
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
    await this.writeSeatConnected(seat, false);
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
    await this.writeSeatConnected(seat, true);

    // Before the welcome, not after: when THIS join is the one that fills the
    // table, `maybeStartClocks` either starts it or opens the start card
    // (§8a-2) right here — and `startingPayload()` below must see that
    // outcome, not the pre-join "nothing has happened yet" state. Presence
    // is already set (just above), which is all `maybeStartClocks` reads.
    await this.maybeStartClocks();

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
        chat: [...this.chat],
        paused: this.pausedInfo(),
        starting: this.startingPayload(),
      },
    });
    this.send(ws, accepted(msg.requestId, this.seq));
    this.broadcastPresence(seat);
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
      auto: this.book.auto[seat],
    }));
  }

  /** `null` unless the table is currently paused — `welcome`/`restore`'s shape. */
  private pausedInfo(): { bySeat: SeatIndex; displayName: string; since: number } | null {
    const p = this.book.paused;
    if (!p) return null;
    return {
      bySeat: p.bySeat,
      displayName: this.requireMeta().header.players[p.bySeat].displayName,
      since: p.at,
    };
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
    // §8a-2's inactivity timeout: ANY request from this seat (this switch's
    // cases, not `join`/`heartbeat` — neither reaches `handleRequest` at all)
    // counts as presence and clears its `idle:` deadline, re-arming a fresh
    // one if it is still the seat expected to act (still its turn, or an
    // open window it has not answered) — the same "resets, does not merely
    // cancel" behaviour a genuine move gets for free from the `armDerived`
    // call already inside `submit`. Guarded on the deadline actually existing
    // so an idle table with `inactivityMs` off, or a seat that was never
    // idle, never pays an extra write for this.
    if (this.deadlines[`idle:${seat}`] !== undefined) {
      this.clearDeadline(`idle:${seat}`);
      this.armDerived(this.deps.clock());
      await this.persistCore();
    }
    switch (msg.type) {
      case "join":
      case "heartbeat":
        return;

      // Chat is handled here, BEFORE the game-request path below: it is not
      // a game action, never touches the reducer or the event log, and its
      // own validation (exactly one of text/phrase, the length cap, the
      // per-seat cadence, "bots never") is entirely its own.
      case "chat":
        return this.handleChat(seat, ws, msg);

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
            directory: this.directory(),
            chat: [...this.chat],
            paused: this.pausedInfo(),
            starting: this.startingPayload(),
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

      case "requestPause":
        return this.handlePause(seat, ws, msg.requestId);

      case "requestResume":
        return this.handleResume(seat, ws, msg.requestId);

      case "requestNextHand":
        return this.handleRequestNextHand(seat, ws, msg.requestId);

      case "requestAuto": {
        const on = msg.payload?.on;
        if (typeof on !== "boolean") return this.send(ws, protocolFault("malformedMessage"));
        return this.handleAuto(seat, on, ws, msg.requestId);
      }
    }
  }

  /**
   * Table chat (§8). Authenticated seat only — guaranteed by the caller, which
   * never reaches this without a joined `att` — bots never (a bot has no
   * business holding a socket, but the check is here rather than assumed),
   * exactly one of `text`/`phrase`, the length cap, and a per-seat 1-per-second
   * cadence ON TOP OF the table's general request limiter (`rateLimited`,
   * already checked in `webSocketMessage` before `handleRequest` runs at all).
   * A bad message is `rejected` with `chatRefused`; a good one is stamped,
   * appended to the ring, persisted, broadcast to every socket, and
   * `accepted` to the sender — never fed to the reducer, never logged as a
   * `GameEvent`, never archived (this file's header, item 3).
   */
  private async handleChat(
    seat: SeatIndex,
    ws: SeatSocket,
    msg: Extract<ClientRequest, { type: "chat" }>,
  ): Promise<void> {
    const meta = this.requireMeta();
    const player = meta.header.players[seat];
    if (player.bot) {
      this.send(ws, rejected(msg.requestId, "chatRefused", "bots do not chat"));
      return;
    }
    const now = this.deps.clock();
    const last = this.chatRate.get(seat);
    if (last !== undefined && now - last < CHAT_MIN_INTERVAL_MS) {
      this.send(ws, rejected(msg.requestId, "chatRefused", "1 message per second per seat"));
      return;
    }
    const payload = msg.payload ?? {};
    const text = typeof payload.text === "string" ? payload.text.trim() : undefined;
    const phrase = isChatPhrase(payload.phrase) ? payload.phrase : undefined;
    const hasText = text !== undefined && text !== "";
    const hasPhrase = phrase !== undefined;
    if (hasText === hasPhrase) {
      // Both set, or neither — never a coherent chat message.
      this.send(ws, rejected(msg.requestId, "chatRefused", "exactly one of text or phrase"));
      return;
    }
    if (hasText && text!.length > CHAT_TEXT_MAX_LENGTH) {
      this.send(ws, rejected(msg.requestId, "chatRefused", "text too long"));
      return;
    }

    this.chatRate.set(seat, now);
    const entry: ChatMessagePayload = hasText
      ? { seat, displayName: player.displayName, text, ts: now }
      : { seat, displayName: player.displayName, phrase, ts: now };

    this.chat.push(entry);
    if (this.chat.length > CHAT_RING_SIZE) this.chat = this.chat.slice(-CHAT_RING_SIZE);
    await this.ctx.storage.put({ [K_CHAT]: this.chat });

    const out = chatMessage(entry);
    for (const socket of this.ctx.getWebSockets()) this.send(socket, out);
    this.send(ws, accepted(msg.requestId, this.seq));
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
    // Every game action stops here while the table is paused (§requestPause) —
    // `ws` is only set for a genuine client request; a bot/auto decision never
    // reaches this branch because `rearm` never arms `botPace` while paused
    // (see `nextDue`), so there is nothing to guard on that side.
    if (this.book.paused) {
      if (ws && requestId) this.send(ws, rejected(requestId, "paused"));
      return;
    }
    // A human move is the one thing that turns auto-play off on its own
    // (`RequestAutoPayload`'s doc comment): switch it off FIRST, durably, then
    // fall through and validate the move as normal. `ws` is the same "this is
    // a real client request, not a bot/auto decision" signal used above —
    // `actAsBot` never passes one, so this can never turn itself off.
    if (ws && this.book.auto[seat]) {
      this.book.auto[seat] = false;
      this.armDerived(this.deps.clock());
      await this.persistCore();
      this.broadcastPresence(seat);
      await this.rearm();
    }
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
      // Graded here, at the moment the answer is HELD — the human's actual
      // choice, before it is ever resolved (`closeWindow` applies it later,
      // in seat order, and may even drop it if the state moved underneath).
      if (!this.isBotControlled(seat)) {
        this.tallyGrade(seat, this.viewFor(seat), this.legalFor(seat), action);
      }
      // HELD — resolution is still in SEAT ORDER at the close, never in the
      // order the packets happened to arrive, so an early close (below) is
      // exactly as deterministic as a timed-out one (§5.2). Answering fast no
      // longer shortens the window on its own (`windowReadyToClose` decides
      // that, per §8a): while a human this window was offered to has not yet
      // answered, holding every answer to the same close time is still what
      // stops one human reading another's hesitation.
      win.answers[String(seat)] = action;
      this.armDerived(this.deps.clock());
      await this.persistCore();
      if (ws && requestId) this.send(ws, accepted(requestId, this.seq));
      // §8a rules 2 and 3: once nothing is left pending that closing early
      // would leak, resolve now rather than waiting for `closesAt`.
      if (this.windowReadyToClose(win)) await this.closeWindow();
      return;
    }

    // Captured BEFORE the reducer runs, and only kept if applyAction actually
    // accepts the move — grading a request the table refuses would credit or
    // fault a decision the player never got to make.
    const preView = !this.isBotControlled(seat) ? this.viewFor(seat) : null;
    const preLegal = preView ? this.legalFor(seat) : null;
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
    if (preView && preLegal) this.tallyGrade(seat, preView, preLegal, action);
    await this.commit(applied);
  }

  /**
   * Fold one `BotBrain.grade` result into the seat's running tally. Never
   * lets grading throw into the game flow — a bug in the champion's analysis
   * must not be a bug in the table (owner: "grading is a bonus, not a
   * dependency"). Costs well under a millisecond per discard; no pacing
   * concern.
   */
  private tallyGrade(
    seat: SeatIndex,
    view: SeatVisible<SeatSnapshot>,
    legal: LegalRequests,
    action: Action,
  ): void {
    // Bound, not called through a bare destructured reference — a `grade`
    // that reads `this` (gamepvp/src/bots.ts's does not, but a future one
    // might) must see its own object, the same way `decide`/`paceMs` do.
    const grade = this.deps.bots.grade?.bind(this.deps.bots);
    if (!grade) return;
    try {
      const rand = prng(botSeed(this.requireMeta().seed, this.requireState().handIndex, this.seq, seat));
      const result = grade(view, legal, action, rand);
      if (!result) return;
      const g = this.book.grading[seat];
      g.graded += 1;
      if (result.matched) g.matched += 1;
      g.gapSum += result.gap;
    } catch (err) {
      console.error("grade threw", this.meta?.matchId, seat, err);
    }
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

    // Decided ONCE per commit, before any event is stamped, so the value we
    // tell `afterCommit` to hold for is EXACTLY the `nextHandTs` the wire
    // already carries — never a second, possibly different, evaluation.
    const nextHandTs = this.handEndIntermissionActive() ? ts + this.config.handEndIntermissionMs : undefined;

    // Same doctrine as `nextHandTs` just above: decided ONCE, from the drafts
    // themselves, before any event is stamped — every `claimOffered` /
    // `robKongWindow` event this commit produces gets exactly this one
    // `closesAt`, never a per-event re-evaluation.
    const windowClosesAt = this.computeWindowClosesAt(applied.events, ts);

    const events: GameEvent[] = [];
    for (const draft of applied.events) {
      const seq = this.seq++;
      let stamped = stampEvent(draft, meta.matchId, seq, ts);
      stamped = stampWindowDeadline(stamped, windowClosesAt);
      stamped = stampHandEndDeadline(stamped, nextHandTs);
      events.push(stamped);
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

    // Only the core keys that actually changed join the batch — `changedCore`
    // (see `lastWritten`'s doc comment) — but they join THIS SAME batch as
    // the events and outbox record above, in the one `putBatch` call: a crash
    // between committing an event and persisting the durable facts it implies
    // (the state that produced it, the seq it claimed, any deadline it opened
    // or closed) can never happen, because there is no gap between them for a
    // crash to land in.
    const { patch: corePatch, serialized } = this.changedCore();
    Object.assign(batch, corePatch);
    await this.putBatch(batch);
    this.markCoreWritten(serialized, Object.keys(corePatch));

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

  /** A claim kind's human decision duration (§8a rule 3) — kong counts as pung. */
  private claimDurationMs(kind: ClaimKind): number {
    if (kind === "chow") return this.config.claimWindowMs.chow;
    if (kind === "win") return this.config.claimWindowMs.win;
    return this.config.claimWindowMs.pung; // pung, kong
  }

  /**
   * The ceiling used for a window where every offered seat is bot-controlled
   * (§8a rule 2): generous enough that `paceAt`'s clamp never compresses a
   * bot's own pace, but otherwise irrelevant — `windowReadyToClose` resolves
   * the window the instant the last bot answers, never by waiting this out.
   */
  private botOnlyWindowCeiling(ts: number): number {
    return ts + this.config.botMaxPaceMs + this.config.botWindowMarginMs;
  }

  /**
   * `closesAt` for the window this commit's drafts open, if any — computed
   * from the drafts themselves (before they are stamped) because it depends
   * on WHICH seats are offered and WHAT they are offered, not only on when.
   * Returns `ts` when these drafts open no window; `stampWindowDeadline`
   * ignores that value since it only ever touches a `claimOffered` or
   * `robKongWindow` payload.
   *
   *  - A robKong window only ever offers a win (§ClaimOfferedPayload doc).
   *  - A claim window's duration is the longest option offered to any HUMAN
   *    seat in it (§8a rule 3); a window offered to no human at all — every
   *    seat in it bot-controlled — uses `botOnlyWindowCeiling` instead
   *    (§8a rule 2).
   *  - §8a-2's `untimed` preset sets every `claimWindowMs` kind to 0, which
   *    means "no deadline while a human in the window is unanswered" — this
   *    returns `NO_DEADLINE` (the same sentinel `sendPrompts` already falls
   *    back to for a seat with no armed `turnClock`) rather than `ts + 0`,
   *    which would read as "already expired" the instant the window opens.
   *    `armDerived` reads this sentinel and arms no `claimWindow` deadline at
   *    all — the window then closes only via `windowReadyToClose`, once every
   *    human offered has answered.
   */
  private computeWindowClosesAt(drafts: readonly EventDraft[], ts: number): number {
    const rob = drafts.find(
      (e): e is Extract<EventDraft, { type: "robKongWindow" }> => e.type === "robKongWindow",
    );
    if (rob) {
      const humanOffered = rob.payload.offeredTo.some((s) => !this.isBotControlled(s));
      if (!humanOffered) return this.botOnlyWindowCeiling(ts);
      const dur = this.config.claimWindowMs.win;
      return dur > 0 ? ts + dur : NO_DEADLINE;
    }
    const offers = drafts.filter(
      (e): e is Extract<EventDraft, { type: "claimOffered" }> => e.type === "claimOffered",
    );
    if (offers.length === 0) return ts;
    let longest = 0;
    let anyHuman = false;
    for (const o of offers) {
      if (this.isBotControlled(o.payload.seat)) continue;
      anyHuman = true;
      for (const opt of o.payload.options) longest = Math.max(longest, this.claimDurationMs(opt.kind));
    }
    if (!anyHuman) return this.botOnlyWindowCeiling(ts);
    return longest > 0 ? ts + longest : NO_DEADLINE;
  }

  /**
   * §8a rules 2 and 3, unified: a window with any human offered waits ONLY on
   * its humans — the whole reason the fixed minimum exists is to stop one
   * human reading another's hesitation, and once every human has answered
   * there is nothing left to protect, so the window closes at once even if a
   * bot offered in it has not yet answered (it still gets its own paced
   * deadline; §submit just stops making the table wait on it to close the
   * window). A window offered to no human at all waits on every bot instead,
   * because there nothing is hidden from anyone by holding it open longer.
   */
  private windowReadyToClose(win: WindowRecord): boolean {
    const humanSeats = win.offered.filter((s) => !this.isBotControlled(s));
    const pending = humanSeats.length > 0 ? humanSeats : win.offered;
    return pending.every((s) => win.answers[String(s)] !== undefined);
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

  /** `TableConfig.handEndIntermissionMs` doc comment: on, unless disabled or
   *  nobody would see it happen — a bot-only table, or one every human has
   *  left, advances at once, same as before this feature existed. */
  private handEndIntermissionActive(): boolean {
    if (this.config.handEndIntermissionMs <= 0) return false;
    const meta = this.meta;
    if (!meta) return false;
    return SEATS.some((s) => !meta.header.players[s].bot && this.presence[s].connected);
  }

  private async afterCommit(events: readonly GameEvent[]): Promise<void> {
    const dealt = events.find((e) => e.type === "deal");
    if (dealt) await this.writeCurrentHand(dealt.handIndex);
    const ended = events.find(isHandEnd);
    if (ended) {
      // The row's facts are read off the book BEFORE advancing, because the
      // next deal resets them.
      const row = { dealerRepeat: this.book.dealerRepeat, startedAt: this.book.handStartedAt };
      if (ended.payload.nextHandTs !== undefined) {
        // Hold: `commit` already stamped `nextHandTs` on the wire event, so
        // this is the SAME deadline the client was told about — never a
        // freshly computed one. Neither `advance` nor `sealHand` runs until
        // `dispatchNextHand` (the `nextHand` deadline, or every connected
        // human's `requestNextHand`).
        this.book.pendingHandEnd = { handIndex: ended.handIndex, payload: ended.payload, row };
        this.book.nextHandRequests = [false, false, false, false];
        this.setDeadline("nextHand", ended.payload.nextHandTs, `hand:${ended.handIndex}`);
      } else {
        // Advance FIRST. `startNextHand` either deals the next hand or emits
        // the `matchEnd`, and a matchEnd carries the ENDING hand's index —
        // sealing before it lands would archive a hand missing its last event.
        await this.advance(ended.payload);
        await this.sealHand(ended.handIndex, ended.payload, row);
      }
    }
    if (this.book.matchOver) this.setDeadline("outboxFlush", this.deps.clock(), "flush");
    await this.persistCore();
    await this.rearm();
  }

  /**
   * Ends the hand-end intermission: deals the next hand (or ends the match),
   * then seals the just-ended one — exactly the order `afterCommit` ran them
   * in before this feature existed, just deferred. Reached from the
   * `nextHand` deadline (`dispatch`) or early, once every connected human has
   * sent `requestNextHand` (`handleRequestNextHand`).
   */
  private async dispatchNextHand(): Promise<void> {
    const pending = this.book.pendingHandEnd;
    if (!pending) return;
    await this.advance(pending.payload);
    await this.sealHand(pending.handIndex, pending.payload, pending.row);
    this.book.pendingHandEnd = null;
    this.book.nextHandRequests = [false, false, false, false];
    this.clearDeadline("nextHand");
    await this.persistCore();
    await this.rearm();
  }

  /** Every connected human seat has sent `requestNextHand` — a bot seat, or a
   *  human seat with no open socket right now, is not in the way. */
  private allConnectedHumansRequestedNextHand(): boolean {
    const meta = this.requireMeta();
    return SEATS.every((s) => {
      if (meta.header.players[s].bot) return true;
      if (!this.presence[s].connected) return true;
      return this.book.nextHandRequests[s];
    });
  }

  /**
   * `requestNextHand` ends either of the two holds this file can have open —
   * the hand-end intermission (`pendingHandEnd`) or the start card
   * (`startingAt`, §8a-2) — early, once every connected human has sent it.
   * The two never overlap (a hold-doc comment on `BookKeeping.startingAt`),
   * so `nextHandRequests`/`allConnectedHumansRequestedNextHand` serve both
   * without needing to know which one is open.
   */
  private async handleRequestNextHand(seat: SeatIndex, ws: SeatSocket, requestId: string): Promise<void> {
    if (!this.book.pendingHandEnd && this.book.startingAt === null) {
      this.send(ws, rejected(requestId, "notALegalMove", "no hold is open"));
      return;
    }
    this.book.nextHandRequests[seat] = true;
    await this.persistCore();
    this.send(ws, accepted(requestId, this.seq));
    if (!this.allConnectedHumansRequestedNextHand()) return;
    if (this.book.startingAt !== null) await this.dispatchMatchStart();
    else await this.dispatchNextHand();
  }

  /**
   * The clocks start when the table is full, not when the object is created. A
   * turn clock ticking while the fourth player is still opening the app would
   * time out a seat that never had a turn to take.
   *
   * §8a-2's start card interposes a hold here: a table with at least one
   * human seat and a positive `startDelayMs` broadcasts `starting` and waits
   * (`matchStart` deadline, or every connected human's `requestNextHand`)
   * before actually starting — `startClocksNow` is what this used to do
   * unconditionally. A bot-only table, or `startDelayMs` disabled (the fast
   * dev config), skips the hold: there is nobody for the card to be shown to,
   * or the deployment has already said clocks should start at once.
   *
   * Called from `handleJoin`/`handleFill` every time a seat fills — the
   * `startingAt !== null` guard makes a second call while the hold is already
   * open a no-op, same idempotence `book.started` already gave this method.
   */
  private async maybeStartClocks(): Promise<void> {
    if (this.book.started || this.book.matchOver || this.book.startingAt !== null) return;
    const meta = this.requireMeta();
    for (const seat of SEATS) {
      if (!meta.header.players[seat].bot && !this.presence[seat].connected) return;
    }
    if (this.humanSeatCount() === 0 || this.config.startDelayMs <= 0) {
      await this.startClocksNow();
      return;
    }
    const now = this.deps.clock();
    this.book.startingAt = now + this.config.startDelayMs;
    // Fresh hold, fresh readiness — same reset `afterCommit` gives
    // `nextHandRequests` when it opens the hand-end intermission
    // (`handleRequestNextHand` reuses this same flag and helper for both).
    this.book.nextHandRequests = [false, false, false, false];
    this.setDeadline("matchStart", this.book.startingAt, `start:${this.seq}`);
    await this.persistCore();
    await this.rearm();
    this.broadcastStarting();
  }

  /** The actual clock start — `maybeStartClocks`'s whole body before the
   *  start card (§8a-2) interposed a hold in front of it. Reached either
   *  immediately (a bot-only table, or `startDelayMs` disabled) or once the
   *  hold ends (`dispatchMatchStart`). */
  private async startClocksNow(): Promise<void> {
    this.book.started = true;
    this.armDerived(this.deps.clock());
    await this.persistCore();
    await this.rearm();
    await this.writeLobbyStatus("playing");
    for (const seat of SEATS) this.notifySeat(seat, "tableFull");
  }

  /** `dispatch("matchStart")`: the start card's hold ran its full
   *  `startDelayMs`. Also reached early from `handleRequestNextHand` once
   *  every connected human has asked to skip it. */
  private async dispatchMatchStart(): Promise<void> {
    if (this.book.started || this.book.startingAt === null) return;
    this.book.startingAt = null;
    this.book.nextHandRequests = [false, false, false, false];
    this.clearDeadline("matchStart");
    await this.startClocksNow();
  }

  /** Broadcast to every open socket the instant the start card opens
   *  (`maybeStartClocks`) — a fresh joiner during the hold gets the same
   *  card via `welcome`'s own `starting` field, never a second broadcast. */
  private broadcastStarting(): void {
    const payload = this.startingPayload();
    if (payload === null) return;
    const msg: ServerToSeat = { p: PROTOCOL_VERSION, type: "starting", payload };
    for (const ws of this.ctx.getWebSockets()) this.send(ws, msg);
  }

  /**
   * `null` unless the start card is currently holding — `welcome`/`restore`'s
   * `starting` field, and `broadcastStarting`'s payload. Ruleset facts come
   * from `meta.matchSettings` (resolved once by the platform Worker entry,
   * `gamepvp/src/index.ts` `tableInitOf`, via `@mjrc/rulesets` — this file
   * stays free of that import); a `matchSettings`-less init (a test, or one
   * that predates the start card) falls back to generic values rather than
   * failing — the card is cosmetic, never a gate on the match itself.
   */
  private startingPayload(): StartingPayload | null {
    if (this.book.startingAt === null) return null;
    const meta = this.requireMeta();
    const ms = meta.matchSettings;
    const settings: MatchStartSettings = {
      style: "hkos",
      rulesetId: meta.header.rulesetId,
      rulesetLabel: ms?.rulesetLabel ?? meta.header.rulesetId,
      minimumFaan: ms?.minimumFaan ?? 0,
      limitFaan: ms?.limitFaan ?? 0,
      useFlowers: ms?.useFlowers ?? true,
      paymentId: ms?.paymentId ?? "",
      matchFormat: ms?.matchFormat ?? (meta.header.matchLength === "fourWindRounds" ? "full" : "east"),
      speed: isSpeed(meta.speed) ? meta.speed : "normal",
      seats: this.directory(),
    };
    return { startsAt: this.book.startingAt, settings };
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
        // A late joiner's name reaches the seats that were welcomed before
        // the join bound it.
        playerId: this.meta?.header.players[seat].playerId ?? "",
        displayName: this.meta?.header.players[seat].displayName ?? "",
        bot: this.meta?.header.players[seat].bot ?? false,
        auto: this.book.auto[seat],
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
    if (this.book.paused) {
      // Time stops: every other deadline's `at` sits untouched in the map
      // (`resumeNow` shifts them all at once) but NONE of them may fire while
      // paused, so the alarm is pinned to `pauseTimeout` alone — the one
      // deadline that must still go off on schedule (§requestPause).
      const pt = this.deadlines["pauseTimeout"];
      if (!pt) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const current = await this.ctx.storage.getAlarm();
      if (current === pt.at) return;
      await this.ctx.storage.setAlarm(pt.at);
      return;
    }
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

  /** Earliest due entry, ties broken by name — deterministic, never map order.
   *  While paused, ONLY `pauseTimeout` may come due: every other entry sits
   *  frozen with its pre-pause `at`, which by the time `pauseMaxMs` elapses is
   *  almost certainly also "due" by the clock — surfacing it here would
   *  dispatch (and so, one line up in `alarm`, PERMANENTLY DELETE) a turn
   *  clock or a claim window that `resumeNow` still needs to shift. */
  private nextDue(now: number): DeadlineName | null {
    if (this.book.paused) {
      const pt = this.deadlines["pauseTimeout"];
      return pt && pt.at <= now ? "pauseTimeout" : null;
    }
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
    if (name === "pauseTimeout") return this.autoResume();
    if (name === "matchStart") return this.dispatchMatchStart();
    if (this.book.matchOver) return;
    if (name === "claimWindow") return this.closeWindow();
    if (name === "nextHand") return this.dispatchNextHand();
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
    if (name.startsWith("idle:")) {
      const seat = Number(name.slice("idle:".length)) as SeatIndex;
      return this.onIdleExpired(seat);
    }
  }

  private async onGraceExpired(seat: SeatIndex): Promise<void> {
    if (this.presence[seat].connected) return;
    console.log("grace expired", this.meta?.matchId ?? "?", "seat", seat, "bot takes over at hand", this.state?.handIndex);
    this.presence[seat] = { connected: false, botActing: true };
    this.armDerived(this.deps.clock());
    await this.persistCore();
    this.broadcastPresence(seat);
  }

  /**
   * §8a-2's `untimed` inactivity timeout: this seat was prompted (its turn,
   * or an open window it had not answered — `armDerived`'s idle-arming
   * block) and sent no request for `inactivityMs`. Switches it to auto-play,
   * the exact mechanism `requestAuto { on: true }` uses, so the seat's own
   * next request turns it off again (`submit`'s existing rule) with no
   * special-casing for how it got turned on. A no-op if the seat is already
   * bot-controlled by the time this fires (a race with a disconnect grace,
   * an explicit `requestAuto`, or the match ending) — `armDerived` would not
   * have kept this deadline armed past that point, but the alarm loop can
   * still have queued it before the state changed.
   */
  private async onIdleExpired(seat: SeatIndex): Promise<void> {
    if (this.book.matchOver || this.isBotControlled(seat)) return;
    console.log("idle timeout", this.meta?.matchId ?? "?", "seat", seat, "switches to auto");
    this.book.auto[seat] = true;
    this.armDerived(this.deps.clock());
    await this.persistCore();
    this.broadcastPresence(seat);
  }

  /* ── pause / resume ──────────────────────────────────────────────────── */

  /** Any human seat may pause the table — simplest form, no confirmation. */
  private async handlePause(seat: SeatIndex, ws: SeatSocket, requestId: string): Promise<void> {
    const meta = this.requireMeta();
    if (meta.header.players[seat].bot) {
      this.send(ws, rejected(requestId, "pauseRefused", "bots do not pause"));
      return;
    }
    if (!this.book.started) {
      this.send(ws, rejected(requestId, "pauseRefused", "table is not full"));
      return;
    }
    if (this.book.paused) {
      this.send(ws, rejected(requestId, "pauseRefused", "already paused"));
      return;
    }
    const now = this.deps.clock();
    this.book.paused = { bySeat: seat, at: now };
    // The one deadline `rearm` still arms while paused (§DeadlineName).
    this.setDeadline("pauseTimeout", now + this.config.pauseMaxMs, `pause:${this.seq}`);
    await this.persistCore();
    await this.rearm();
    this.send(ws, accepted(requestId, this.seq));
    this.broadcastPaused(true, seat, meta.header.players[seat].displayName);
  }

  /** Any human seat may resume — not only the one that paused it. */
  private async handleResume(seat: SeatIndex, ws: SeatSocket, requestId: string): Promise<void> {
    const meta = this.requireMeta();
    if (meta.header.players[seat].bot) {
      this.send(ws, rejected(requestId, "pauseRefused", "bots do not resume"));
      return;
    }
    if (!this.book.paused) {
      this.send(ws, rejected(requestId, "pauseRefused", "not paused"));
      return;
    }
    await this.resumeNow(seat, meta.header.players[seat].displayName);
    this.send(ws, accepted(requestId, this.seq));
  }

  /** `dispatch("pauseTimeout")`: `TableConfig.pauseMaxMs` elapsed with nobody
   *  resuming. `bySeat`/`displayName` fall back to the original pauser's —
   *  nobody else acted, so there is no other seat to credit the resume to. */
  private async autoResume(): Promise<void> {
    const paused = this.book.paused;
    if (!paused) return;
    const player = this.requireMeta().header.players[paused.bySeat];
    await this.resumeNow(paused.bySeat, player.displayName);
  }

  /**
   * Shared by an explicit `requestResume` and `autoResume`: shift every
   * deadline (except `pauseTimeout`, which is about to be cleared) and the
   * open window's `closesAt`, if any, by however long the pause actually
   * lasted — `now - paused.at` — so a clock that had 7s left when it froze
   * has exactly 7s left once time moves again. `armDerived` runs nowhere in
   * here on purpose: shifting is the whole story, and re-deriving from
   * scratch (a fresh `turnMs`) is exactly the bug this function exists to
   * avoid.
   */
  private async resumeNow(bySeat: SeatIndex, displayName: string): Promise<void> {
    const paused = this.book.paused;
    if (!paused) return;
    const shift = this.deps.clock() - paused.at;
    for (const name of sortedKeys(this.deadlines)) {
      if (name === "pauseTimeout") continue;
      const entry = this.deadlines[name];
      this.deadlines[name] = { ...entry, at: entry.at + shift };
    }
    if (this.window) this.window = { ...this.window, closesAt: this.window.closesAt + shift };
    this.clearDeadline("pauseTimeout");
    this.book.paused = null;
    await this.persistCore();
    await this.rearm();
    // Every seat's `deadlineTs` just moved — tell them, the same way a fresh
    // commit does.
    this.sendPrompts();
    this.broadcastPaused(false, bySeat, displayName);
  }

  private broadcastPaused(on: boolean, bySeat: SeatIndex, displayName: string): void {
    const msg: ServerToSeat = {
      p: PROTOCOL_VERSION,
      type: "paused",
      payload: { on, bySeat, displayName, ts: this.deps.clock() },
    };
    for (const ws of this.ctx.getWebSockets()) this.send(ws, msg);
  }

  /* ── auto-play ───────────────────────────────────────────────────────── */

  /**
   * `requestAuto { on }`: while on, this seat plays exactly like a disconnect
   * takeover (`isBotControlled` folds `book.auto` in), until it is turned off
   * here or `submit` turns it off on the seat's own next game request.
   */
  private async handleAuto(seat: SeatIndex, on: boolean, ws: SeatSocket, requestId: string): Promise<void> {
    const meta = this.requireMeta();
    if (meta.header.players[seat].bot) {
      this.send(ws, rejected(requestId, "autoRefused", "bots do not toggle auto"));
      return;
    }
    if (!this.book.started) {
      this.send(ws, rejected(requestId, "autoRefused", "table is not full"));
      return;
    }
    this.book.auto[seat] = on;
    this.armDerived(this.deps.clock());
    await this.persistCore();
    this.send(ws, accepted(requestId, this.seq));
    this.broadcastPresence(seat);
    await this.rearm();
  }

  private isBotControlled(seat: SeatIndex): boolean {
    const meta = this.meta;
    return (
      (meta?.header.players[seat].bot ?? false) ||
      this.presence[seat].botActing ||
      this.book.auto[seat]
    );
  }

  /**
   * Seats the HEADER says are human — §8a rule 4's count. Deliberately not
   * `isBotControlled`: a disconnected or auto-played human seat is still a
   * human who might come back and want a turn clock's absence to still hold,
   * and `maybeStartClocks` already uses this same header field to decide the
   * table is "full" of humans in the first place.
   */
  private humanSeatCount(): number {
    const meta = this.requireMeta();
    return SEATS.filter((s) => !meta.header.players[s].bot).length;
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
    const idleMs = this.config.inactivityMs;
    if (state && this.book.started && !this.book.matchOver) {
      if (win) {
        // §8a-2: `NO_DEADLINE` means the strongest option offered to a human
        // in this window was configured at 0 (`untimed`) — no timeout arms at
        // all, and the window closes only once every human offered has
        // answered (`windowReadyToClose`, driven from `submit`).
        const humanOffered = win.offered.some((s) => !this.isBotControlled(s));
        if (win.closesAt !== NO_DEADLINE) {
          keep.add("claimWindow");
          this.setDeadlineIfNew("claimWindow", win.closesAt, `w${win.openedSeq}`);
        }
        // §8a rule 2: the margin exists to keep a bot's held answer strictly
        // inside a window a human might still be reading. A window with no
        // human offered has nothing to protect, so a bot there paces itself
        // all the way to its own `botMaxPaceMs` uncompressed — `closesAt` is
        // only `botOnlyWindowCeiling`, a safety net, not a real constraint. A
        // human-offered window with NO deadline (`untimed`) is the same
        // "uncompressed" case for the same reason: there is no ceiling to
        // stay inside.
        for (const seat of win.offered) {
          if (win.answers[String(seat)] !== undefined) continue;
          if (!this.isBotControlled(seat)) continue;
          const name: DeadlineName = `botPace:${seat}`;
          keep.add(name);
          const notAfter =
            humanOffered && win.closesAt !== NO_DEADLINE
              ? win.closesAt - this.config.botWindowMarginMs
              : Number.POSITIVE_INFINITY;
          this.setDeadlineIfNew(name, this.paceAt(seat, now, notAfter), `w${win.openedSeq}:${seat}`);
        }
        // §8a-2's inactivity timeout: every seat in the window still owed an
        // answer, offered to a genuine (not already bot-controlled) human.
        if (idleMs > 0) {
          for (const seat of win.offered) {
            if (win.answers[String(seat)] !== undefined) continue;
            if (this.isBotControlled(seat)) continue;
            const name: DeadlineName = `idle:${seat}`;
            keep.add(name);
            this.setDeadlineIfNew(name, now + idleMs, `w${win.openedSeq}:${seat}`);
          }
        }
      } else if (state.phase === "awaitDiscard") {
        // §8a rule 4, extended by §8a-2: a table with exactly one human seat
        // never arms the turn clock, and `untimed` (`turnMs: 0`) never arms
        // it regardless of human count — that seat's turn waits indefinitely
        // either way (the disconnect grace and auto-play still cover an
        // absent player). A bot's own turn is still paced below regardless,
        // so neither rule alone ever stalls the table.
        if (this.config.turnMs > 0 && this.humanSeatCount() !== 1) {
          keep.add("turnClock");
          this.setDeadlineIfNew("turnClock", now + this.config.turnMs, this.book.turnToken);
        }
        if (this.isBotControlled(state.turn)) {
          const name: DeadlineName = `botPace:${state.turn}`;
          keep.add(name);
          const notAfter =
            this.config.turnMs > 0
              ? now + this.config.turnMs - this.config.botWindowMarginMs
              : Number.POSITIVE_INFINITY;
          this.setDeadlineIfNew(name, this.paceAt(state.turn, now, notAfter), this.book.turnToken);
        }
        // §8a-2's inactivity timeout: the seat on turn, if it is a genuine
        // (not already bot-controlled) human.
        if (idleMs > 0 && !this.isBotControlled(state.turn)) {
          const name: DeadlineName = `idle:${state.turn}`;
          keep.add(name);
          this.setDeadlineIfNew(name, now + idleMs, this.book.turnToken);
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
          movesGraded: four((s) => this.book.grading[s].graded),
          movesMatched: four((s) => this.book.grading[s].matched),
          gapSum: four((s) => this.book.grading[s].gapSum),
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
      // lobby_status = 'done' folds into this same UPDATE (item 6) rather
      // than a second round trip — the outbox's own close-out is the one
      // place that already knows the match is over for both meanings of
      // "over" (schema.sql matches, "the lobby" comment on `lobby_status`).
      await env.DB.prepare(
        `UPDATE matches
            SET status = 'complete', hand_count = ?, ended_at = ?, log_key = ?, lobby_status = 'done'
          WHERE id = ?`,
      )
        .bind(summary.handsPlayed, iso(summary.endedAt), manifestKey, summary.matchId)
        .run();
      for (const seat of SEATS) {
        await env.DB.prepare(
          `UPDATE match_players
              SET final_chips = ?, place = ?, bot_takeover_hands = ?, client = ?,
                  moves_graded = ?, moves_matched = ?, gap_sum = ?
            WHERE match_id = ? AND seat = ?`,
        )
          .bind(
            summary.standings[seat],
            summary.placements[seat],
            summary.botTakeoverHands[seat],
            summary.clients[seat],
            summary.movesGraded[seat],
            summary.movesMatched[seat],
            summary.gapSum[seat],
            summary.matchId,
            seat,
          )
          .run();
      }
      await settleRatedMatch(env, summary);
    },
  };
}

/** P0's rating season (schema.sql `rating_history.season`, `players.rating_season`). */
const RATING_SEASON = "p0-provisional";

/**
 * Ranked settlement at match end (PVP-LOBBY-PROPOSAL-2026-09-02.md §6
 * decision 5, §7.2) — folded into `bindingArchive.finishMatch`'s close-out
 * rather than a separate outbox step, because it needs nothing the close-out
 * does not already have: the match's placements and chip standings.
 *
 * IDEMPOTENT on `rating_history.match_id`: `finishMatch` can run more than
 * once for the same match (the outbox retries a failed close-out, and this
 * function's own writes are not atomic with each other), so the first read
 * below — "does this match already have rating history" — is what makes a
 * retried settlement a no-op instead of a double-counted one.
 *
 * Casual matches (`matches.rated = 0`) write nothing. Bots are never rated:
 * `postTable` (worker/src/index.ts) already refuses to open a ranked table
 * with any bot seat, so every seat this reads is expected to be human — the
 * `kind !== 'human'` guard below is defensive (a corrupted row, a future
 * relaxation of that rule) rather than a path this build can take.
 *
 * Uses `DEFAULT_RATING_CONFIG` (engine/src/rating.ts) rather than a
 * ruleset-specific `chipScale`: the default is tuned for hkos-doubling — the
 * P0 default ruleset — and threading the actual ruleset's limit-hand value
 * through `MatchSummaryRow` is a refinement for when a second payment table
 * is actually rated, not before.
 */
async function settleRatedMatch(env: TableEnv, summary: MatchSummaryRow): Promise<void> {
  if (!env.DB) return;
  const db = env.DB;
  const iso = (ms: number): string => new Date(ms).toISOString();

  const matchRow = await db
    .prepare(`SELECT rated FROM matches WHERE id = ?`)
    .bind(summary.matchId)
    .first<{ rated: number }>();
  if (!matchRow || Number(matchRow.rated) === 0) return;

  const already = await db
    .prepare(`SELECT id FROM rating_history WHERE match_id = ? LIMIT 1`)
    .bind(summary.matchId)
    .first<{ id: number }>();
  if (already) return;

  const { results: seatRows } = await db
    .prepare(
      `SELECT mp.seat AS seat, mp.player_id AS player_id, p.kind AS kind,
              p.rating AS rating, p.rating_games AS rating_games
         FROM match_players mp
         JOIN players p ON p.id = mp.player_id
        WHERE mp.match_id = ?
        ORDER BY mp.seat`,
    )
    .bind(summary.matchId)
    .all<{ seat: number; player_id: string; kind: string; rating: number | null; rating_games: number }>();

  if (seatRows.length !== 4 || seatRows.some((r) => r.kind !== "human")) return;

  const before = seatRows.map((r) => r.rating ?? INITIAL_RATING);
  const matchesPlayed = seatRows.map((r) => r.rating_games);
  const placements = seatRows.map((r) => summary.placements[r.seat as SeatIndex]);
  const chips = seatRows.map((r) => summary.standings[r.seat as SeatIndex]);
  // Every seat's chips relative to an even split — computable from the
  // standings alone (schema.sql `hands`: every hand's deltas sum to zero, so
  // the match's do too, and the mean final_chips across the four seats is
  // exactly the ruleset's starting stake regardless of what that number is).
  const avgChips = chips.reduce((a, b) => a + b, 0) / chips.length;

  const after = updateRatings(before, placements, { matchesPlayed, chips });
  const now = iso(summary.endedAt);

  for (let i = 0; i < seatRows.length; i += 1) {
    const row = seatRows[i]!;
    const k = provisionalK(matchesPlayed[i]!);
    await db
      .prepare(
        `INSERT INTO rating_history
           (player_id, match_id, kind, system, season, rating_before, rating_after,
            games_played_before, k_factor, place, chip_delta, created_at)
         VALUES (?, ?, 'match', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.player_id,
        summary.matchId,
        RATING_SYSTEM_ID,
        RATING_SEASON,
        before[i],
        after[i],
        matchesPlayed[i],
        k,
        placements[i],
        Math.round(chips[i]! - avgChips),
        now,
      )
      .run();

    await db
      .prepare(`UPDATE players SET rating = ?, rating_games = ?, rating_season = ? WHERE id = ?`)
      .bind(after[i], matchesPlayed[i]! + 1, RATING_SEASON, row.player_id)
      .run();

    await db
      .prepare(`UPDATE match_players SET rating_before = ?, rating_after = ? WHERE match_id = ? AND seat = ?`)
      .bind(before[i], after[i], summary.matchId, row.seat)
      .run();
  }
}

/**
 * The reducer and the bot policy are bound at module load by the Worker entry
 * rather than imported here. §5.5 requires an old hand to replay through the
 * engine build recorded on its own header — "keep old reducer builds loadable"
 * — and a static import of one build into the persistence layer forecloses
 * that. The seam also lets the outbox be tested without the engine at all.
 */
let installed: {
  rules: TableRules;
  bots: BotBrain;
  defaultBotFor?: (seat: SeatIndex) => { key: string; displayName: string };
} | null = null;

export function installTableRules(
  rules: TableRules,
  bots: BotBrain,
  defaultBotFor?: (seat: SeatIndex) => { key: string; displayName: string },
): void {
  installed = { rules, bots, defaultBotFor };
}

const isFiniteNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * `claimWindowMs` alone within `configOverride`: accepts EITHER the old
 * shape — a single number, applied to all three kinds alike, so an existing
 * `TABLE_CONFIG` var keeps working untouched — or the new
 * `{ pung, chow, win }` object (§8a rule 3), partial or complete; any kind it
 * omits keeps `DEFAULT_TABLE_CONFIG`'s. Returns `undefined` when `raw` is
 * neither shape, so the caller's default (or its own default) survives.
 */
function claimWindowMsOverride(raw: unknown): TableConfig["claimWindowMs"] | undefined {
  if (isFiniteNonNegative(raw)) return { pung: raw, chow: raw, win: raw };
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const merged = { ...DEFAULT_TABLE_CONFIG.claimWindowMs };
  let any = false;
  for (const kind of ["pung", "chow", "win"] as const) {
    const v = rec[kind];
    if (isFiniteNonNegative(v)) {
      merged[kind] = v;
      any = true;
    }
  }
  return any ? merged : undefined;
}

/**
 * Only known keys survive, so a typo cannot smuggle in a field. Exported
 * only so worker/test/table.test.ts can exercise the `TABLE_CONFIG` var's
 * JSON shape directly — `TableDO` (below) is its one production caller.
 */
export function configOverride(raw: string | undefined): Partial<TableConfig> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const rec = parsed as Record<string, unknown>;
  const out: Partial<TableConfig> = {};
  for (const key of Object.keys(DEFAULT_TABLE_CONFIG) as (keyof TableConfig)[]) {
    if (key === "claimWindowMs") continue;
    const v = rec[key];
    if (isFiniteNonNegative(v)) out[key] = v;
  }
  const claimWindowMs = claimWindowMsOverride(rec.claimWindowMs);
  if (claimWindowMs) out.claimWindowMs = claimWindowMs;
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
      defaultBotFor: installed.defaultBotFor,
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

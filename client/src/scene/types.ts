/**
 * The renderer boundary — types.
 * Spec: sketches/RENDERING.md §4 (animation architecture), §4a (table layouts),
 * §5 (animation inventory), §7 (the interface). Doctrine: DESIGN.md §5 — the
 * client is disposable by design and holds no game logic.
 * Terminology: ../../../TERMINOLOGY.md — HK Old Style only.
 *
 * ONE IDEA RUNS THROUGH THIS FILE. Every shape the scene can name is either
 * imported from @mjrc/protocol or built only out of fields that already went
 * through `redactEventFor` / `snapshotFor`. The scene has no type in which
 * another seat's concealed tile could be written down, so a leak is a compile
 * error rather than a code-review catch.
 *
 * That is why `SceneEvent` is `SeatVisible<RedactedGameEvent>` and not the
 * `GameEvent` that RENDERING.md §7 sketches. §7 was written before the two
 * serializers existed (protocol/src/events.ts). `GameEvent` is the OMNISCIENT
 * union — it carries the wall seed, every seat's dealt hand and both hands at
 * an exhaustive draw. Handing that to a renderer would put the whole table in
 * the DOM for anyone with devtools. The `Omniscient<T>` brand makes the mistake
 * unrepresentable here, so this file tightens §7 deliberately.
 */
import type {
  ClaimOption,
  Meld,
  ScoreResult,
  SeatIndex,
  TileId,
  WindIndex,
} from "@mjrc/engine";
import type {
  AnySeatView,
  FourSeats,
  HandOutcome,
  MatchEndPayload,
  OtherSeatView,
  OwnSeatView,
  RedactedGameEvent,
  SeatSnapshot,
  SeatVisible,
  SeatVisibleMeld,
} from "@mjrc/protocol";

/* ── what the scene is handed ──────────────────────────────────────────── */

/**
 * RENDERING.md §7's `SeatView`: the authoritative table state AS ONE SEAT MAY
 * SEE IT. It is protocol's `SeatSnapshot`, branded — not a new shape, because
 * inventing a parallel view type here is exactly how a redaction rule gets
 * quietly relaxed by a renderer that "just needed one more field".
 *
 * Note the two levels, which are easy to confuse:
 *   `SeatView`     — the whole table (four seats, wall count, standings, phase)
 *   `AnySeatView`  — ONE row inside it: `OwnSeatView` for you, `OtherSeatView`
 *                    for everybody else. Narrow with `isOwnSeatView`; do not
 *                    test a flag by eye.
 *
 * `OtherSeatView` has `handCount: number` and no field capable of holding a
 * tile. The absence is structural. Preserve that property in anything derived.
 */
export type SeatView = SeatVisible<SeatSnapshot>;

/**
 * The event stream the scene animates: redacted, per-seat, branded.
 *
 * Two consequences worth stating out loud.
 *
 *  1. Passing a raw `GameEvent` is a COMPILE ERROR (no `__view` brand), and so
 *     is passing `Omniscient<GameEvent>` (brand mismatch). The only way to get
 *     one of these is `redactEventFor(seat, e)`.
 *  2. `redactEventFor` returns `null` for events this seat must not know
 *     happened at all — another seat's `claimOffered` / `claimDeclined`. The
 *     HOST drops those; the scene never sees them, and so cannot render a tell
 *     it was never told. Do not add a "hidden" branch here to accommodate them.
 */
export type SceneEvent = SeatVisible<RedactedGameEvent>;

export type { AnySeatView, FourSeats, OtherSeatView, OwnSeatView, SeatVisibleMeld };

/* ── mount options ─────────────────────────────────────────────────────── */

/**
 * §4a. `oldSchool` is the DEFAULT and is the Hong Kong table: one jumbled,
 * never-overlapping pile in the centre, melds where they sit, no score box.
 * `diagram` is the tidied teaching layout: ordered rows in throw order.
 *
 * Deliberately NOT named after the other game whose ordered rows inspired the
 * tidy layout — those rows exist there because discard order is load-bearing
 * under rules HK does not have (TERMINOLOGY.md).
 */
export type TableLayout = "oldSchool" | "diagram";

/**
 * Everything the scene needs at mount. Note what is NOT here: no socket, no
 * ruleset, no legality, no faan table. The scene is told what to draw and
 * reports what was touched. It decides nothing.
 */
export interface SceneOpts {
  /**
   * The seat at the bottom of the screen. Every orientation, every "own vs
   * other" decision and every redaction the scene can observe is relative to
   * this. It must equal the seat the socket is bound to.
   */
  seat: SeatIndex;

  /** §4a. Default `"oldSchool"`. */
  layout?: TableLayout;

  /**
   * Resolved by the HOST from `prefers-reduced-motion`, not queried by the
   * scene. Injected so a test and a replay export get the same answer as a
   * browser. §5: reduced motion falls back to cross-fades and KEEPS the
   * timings — it does not make everything instant.
   */
  reducedMotion?: boolean;

  /**
   * Multiplier on every budget in `ANIMATION_PROFILE`. 1 is real time, 2 is
   * double speed, 0 means every animation completes on the frame it starts —
   * which is how a replay scrub and a headless test run. Default 1.
   */
  timeScale?: number;

  /**
   * Seed for the discard pile's deterministic scatter (§4a: "if it is random
   * per frame the pile visibly reshuffles every tick"). Per match, from the
   * match id — never `Math.random`.
   */
  scatterSeed: number;

  /**
   * §4a: the per-seat colour ring that makes discard attribution visible. The
   * data is always present in the view; this only decides whether it is shown
   * without a tap. Default false — the HK look first.
   */
  showAttribution?: boolean;

  /**
   * Monotonic milliseconds. Defaults to `performance.now` in a browser.
   * Injected because a scene driven by a fake clock is a scene a test can step
   * frame by frame, and because a replay export must not depend on wall time.
   * Nothing here touches game state, so this is testability, not the §5.1
   * determinism rule — but the same discipline applies.
   */
  clock?: () => number;

  callbacks?: SceneCallbacks;
}

/** A tile the player touched. A REQUEST to the host, never an action. */
export interface TilePick {
  tile: TileId;
  /** Index within `OwnSeatView.hand`, or -1 when `source` is `"drawn"`. */
  index: number;
  source: "hand" | "drawn";
}

/**
 * §4a: "tap a tile to see who discarded it and on which turn". A physical HK
 * pile destroys this information; a digital one has no reason to. `seq` is the
 * event that threw it, which is also its position in the true ordered fold.
 */
export interface DiscardRef {
  seq: number;
  tile: TileId;
  seat: SeatIndex;
}

export type CeremonyKind = "deal" | "win" | "handEnd" | "matchEnd";

/**
 * The scene's only outbound edge. Every one of these is an observation. The
 * host decides whether it was legal, and the SERVER decides whether it happened
 * (messages.ts: "a client that 'knows' it discarded is predicting").
 */
export interface SceneCallbacks {
  onTilePicked?(pick: TilePick): void;
  onDiscardInspected?(ref: DiscardRef): void;
  /** `skipped` is true when the player dismissed it — hard rule 3. */
  onCeremonyFinished?(kind: CeremonyKind, skipped: boolean): void;
  /** Queue drained. Useful for tests and for pacing a replay; never for input. */
  onQueueIdle?(): void;
}

/* ── the animation queue ───────────────────────────────────────────────── */

/**
 * One entry in the §4 queue. `applyEvent` pushes exactly one of these per
 * event; the queue drains at its own pace behind the authoritative view.
 */
export interface QueuedAnimation {
  /**
   * `seq` of the source event. The ONLY ordering key — never arrival order,
   * because a resync replays a batch and a duplicate must be recognisable.
   */
  seq: number;
  /**
   * General-purpose deterministic jitter in [0, 1), hashed from `scatterSeed`
   * and this event's `seq`. Same event, same match, same value, forever.
   *
   * The centre pile does NOT use this one. A discard's resting angle is keyed
   * on `discardSlotKey(seat, indexWithinSeat)` instead, because `seq` does not
   * survive a resync — see the note on `discardSlotKey` in MatchScene.ts.
   */
  variant: number;
  /** Real-time budget in ms, already multiplied by `timeScale`. */
  budgetMs: number;
  /** Hard rule 3: a ceremony the player can tap away. */
  skippable: boolean;
  /**
   * Whether the QUEUE waits for this one before starting the next.
   *
   * This is about the queue, NOT about input. Hard rule 1 says no animation
   * ever gates input, serial or not. `claimOffered` is `serial: false` because
   * the call buttons rise ALONGSIDE the discard arc that is still in flight —
   * if they waited for it, the player would lose 180ms of a 5s window.
   */
  serial: boolean;
  anim: SceneAnimation;
}

export interface AnimationProfile {
  /** Unscaled budget in ms. */
  budgetMs: number;
  skippable: boolean;
  serial: boolean;
}

/**
 * §5's inventory as data. Timings marked "extrapolated" are NOT in §5's table —
 * §5 lists ten rows and the redacted union has seventeen members. They are
 * opening proposals on the same footing as §5's own, and tuning them is a
 * renderer change, not a boundary change.
 */
export const ANIMATION_PROFILE: Readonly<Record<SceneAnimation["kind"], AnimationProfile>> = {
  /** §5: 13 tiles per seat, staggered, arcing from wall to hand. */
  deal: { budgetMs: 800, skippable: true, serial: true },
  /** §5. "The signature HK animation — no competitor has one. Worth making it feel good." */
  flowerReplacement: { budgetMs: 260, skippable: false, serial: true },
  /** §5: lifts off the wall to the hand's right edge. */
  draw: { budgetMs: 160, skippable: false, serial: true },
  /** §5: the toss. Arc into the pile, deterministic angle, small bounce. */
  discard: { budgetMs: 180, skippable: false, serial: true },
  /** §5: 90ms, non-blocking, countdown ring ALREADY RUNNING when it appears. */
  claimOffered: { budgetMs: 90, skippable: false, serial: false },
  /** Extrapolated: dismiss the buttons. Never dwells — the window is over. */
  claimDeclined: { budgetMs: 120, skippable: false, serial: false },
  /** §5: tile flies from the pool, meld rotates to show the source seat. */
  claimed: { budgetMs: 320, skippable: false, serial: true },
  /** §5: as draw, from the dead-wall end. */
  kongReplacement: { budgetMs: 180, skippable: false, serial: true },
  /** Extrapolated: 暗槓 squares up face down. */
  concealedKong: { budgetMs: 320, skippable: false, serial: true },
  /** Extrapolated: 加槓 lands on the existing pung, face up so it can be robbed. */
  addedKong: { budgetMs: 320, skippable: false, serial: true },
  /** Extrapolated, mirrors `claimOffered`: 搶槓 is a claim window and must not block. */
  robKongWindow: { budgetMs: 90, skippable: false, serial: false },
  /** §5: tile pulses amber, floor message. The teaching moment — do not shorten. */
  refusedWin: { budgetMs: 400, skippable: false, serial: true },
  /** §5: hand reveals, faan bars stack in one at a time, total counts up. */
  winOnDiscard: { budgetMs: 1900, skippable: true, serial: true },
  /** §5, same ceremony. 自摸 is Cantonese and stays (TERMINOLOGY.md). */
  selfDraw: { budgetMs: 1900, skippable: true, serial: true },
  /** Extrapolated: 流局, hands turn over. */
  exhaustiveDraw: { budgetMs: 900, skippable: true, serial: true },
  /** Extrapolated: chips move, standings settle. */
  handEnd: { budgetMs: 900, skippable: true, serial: true },
  /** Extrapolated: placements. */
  matchEnd: { budgetMs: 1200, skippable: true, serial: true },
};

/* ── animation descriptors ─────────────────────────────────────────────── */

/**
 * One descriptor per member of `RedactedGameEvent`, and every tile-bearing
 * field carries the SAME nullability as the redacted payload it came from.
 * `tile: TileId | null` on a draw is not defensive — it is the fact that you
 * cannot see what another seat drew, expressed in the type the renderer reads.
 */

export interface DealAnimation {
  kind: "deal";
  dealer: SeatIndex;
  roundWind: WindIndex;
  seatWinds: FourSeats<WindIndex>;
  /** Own dealt tiles. `null` for every other seat. */
  hands: FourSeats<TileId[] | null>;
  /** How many, not which — the only thing a seat may know about the others. */
  handCounts: FourSeats<number>;
  wallRemaining: number;
  /** Per-tile stagger inside the budget. */
  staggerMs: number;
}

export interface FlowerReplacementAnimation {
  kind: "flowerReplacement";
  seat: SeatIndex;
  /** 花 is laid face up in front of the seat, so it is public. */
  flower: TileId;
  /** The replacement draw is concealed. `null` unless it is yours. */
  replacement: TileId | null;
  wallRemaining: number;
}

export interface DrawAnimation {
  kind: "draw";
  seat: SeatIndex;
  /** `null` for every seat but yours. Draw a back. */
  tile: TileId | null;
  /** §4a: the wall is an object, not a counter. Stacks vanish as it depletes. */
  wallRemaining: number;
}

export interface DiscardAnimation {
  kind: "discard";
  seat: SeatIndex;
  /** Public. A discard is face up on the table by definition. */
  tile: TileId;
  /** 摸切 — the discard is the tile just drawn. Server-derived, never claimed. */
  drawAndCut: boolean;
  /*
   * NO pile slot here on purpose. The slot is a function of how many tiles this
   * seat has already thrown, which is presentation state the scene already
   * holds — and keying it on the seat's own discard index rather than on `seq`
   * is what makes the pile survive a resync unchanged. See `discardSlotKey`.
   */
}

export interface ClaimOfferedAnimation {
  kind: "claimOffered";
  /** Always `opts.seat`: another seat's offer never reaches you at all. */
  seat: SeatIndex;
  tile: TileId;
  from: SeatIndex;
  /** 上 chow is only ever offered to the discarder's left-hand seat (§4). */
  options: ClaimOption[];
  /**
   * Unix ms, SERVER-SIDE. The ring is drawn against this, not against a
   * duration the client starts when the animation does — hard rule 1. If the
   * event arrives 300ms late, the ring must already be 300ms in.
   */
  deadlineTs: number;
}

export interface ClaimDeclinedAnimation {
  kind: "claimDeclined";
  seat: SeatIndex;
  tile: TileId;
  from: SeatIndex;
  /** "outranked" is a real logged path: a legal claim that lost the contest. */
  reason: "pass" | "timeout" | "outranked";
}

export interface ClaimedAnimation {
  kind: "claimed";
  seat: SeatIndex;
  /** A winning claim resolves to `winOnDiscard`, never to `claimed`. */
  claim: "chow" | "pung" | "kong";
  tile: TileId;
  from: SeatIndex;
  /** Public, and 明槓 off a discard is always exposed. Rotate to show `from`. */
  meld: Meld;
}

export interface KongReplacementAnimation {
  kind: "kongReplacement";
  seat: SeatIndex;
  tile: TileId | null;
  kongKind: "exposed" | "concealed" | "added";
  wallRemaining: number;
}

export interface ConcealedKongAnimation {
  kind: "concealedKong";
  seat: SeatIndex;
  /** 暗槓 lies face down until the hand ends. `null` unless it is yours. */
  tile: TileId | null;
  /** `HiddenKongView` for another seat — `tiles: null`, no slot for a tile. */
  meld: SeatVisibleMeld;
}

export interface AddedKongAnimation {
  kind: "addedKong";
  seat: SeatIndex;
  /** 加槓 is public by necessity: the seats that could rob it must see it. */
  tile: TileId;
  meld: Meld;
}

export interface RobKongWindowAnimation {
  kind: "robKongWindow";
  /** The seat declaring the 加槓. */
  seat: SeatIndex;
  tile: TileId;
  /**
   * Replaces the omniscient `offeredTo` list. Who ELSE was offered is the
   * strongest tell in the game — it says they are one tile from a win.
   */
  offeredToYou: boolean;
  deadlineTs: number;
}

export interface RefusedWinAnimation {
  kind: "refusedWin";
  seat: SeatIndex;
  winningTile: TileId;
  selfDraw: boolean;
  from: SeatIndex | null;
  /** 3 in canonical HK Old Style (§4). */
  minimumFaan: number;
  reason: "belowMinimum";
  melds: SeatVisibleMeld[];
  flowers: TileId[];
  /**
   * The breakdown is the declaring seat's teaching moment and goes only to
   * them. Everyone else sees THAT a win was refused, not what the hand held —
   * both `score` and `concealed` are `null` for them.
   */
  score: ScoreResult | null;
  concealed: TileId[] | null;
}

/** 食糊 — won on another seat's discard, or on a robbed 加槓. */
export interface WinOnDiscardAnimation {
  kind: "winOnDiscard";
  seat: SeatIndex;
  winningTile: TileId;
  from: SeatIndex;
  /**
   * The WINNER's concealed tiles, and this is the only place another seat's
   * concealed tiles are legitimately published: the hand is over and they are
   * face up on the table to be scored. The losers' hands are never published.
   */
  concealed: TileId[];
  melds: Meld[];
  flowers: TileId[];
  /** Bars stack in one at a time; the total counts up. */
  score: ScoreResult;
}

/** 自摸 — won on your own draw. */
export interface SelfDrawAnimation {
  kind: "selfDraw";
  seat: SeatIndex;
  winningTile: TileId;
  concealed: TileId[];
  melds: Meld[];
  flowers: TileId[];
  score: ScoreResult;
}

/** 流局 — the wall ran out with no winner. */
export interface ExhaustiveDrawAnimation {
  kind: "exhaustiveDraw";
  wallRemaining: number;
  /** Own tiles only. 流局 does not license publishing the losers' hands. */
  hands: FourSeats<TileId[] | null>;
  /** Distance to ready 聽牌, own only. */
  distanceToReady: FourSeats<number | null>;
}

export interface HandEndAnimation {
  kind: "handEnd";
  outcome: HandOutcome;
  winner: SeatIndex | null;
  loser: SeatIndex | null;
  faan: number | null;
  /** Signed chips moved this hand. Sums to zero. */
  chipDeltas: FourSeats<number>;
  standings: FourSeats<number>;
  /** 連莊 — the dealer repeats on a dealer win and on 流局 (§4). */
  dealerRepeats: boolean;
  nextDealer: SeatIndex;
  nextRoundWind: WindIndex;
}

export interface MatchEndAnimation {
  kind: "matchEnd";
  reason: MatchEndPayload["reason"];
  standings: FourSeats<number>;
  placements: FourSeats<1 | 2 | 3 | 4>;
  handsPlayed: number;
}

export type SceneAnimation =
  | DealAnimation
  | FlowerReplacementAnimation
  | DrawAnimation
  | DiscardAnimation
  | ClaimOfferedAnimation
  | ClaimDeclinedAnimation
  | ClaimedAnimation
  | KongReplacementAnimation
  | ConcealedKongAnimation
  | AddedKongAnimation
  | RobKongWindowAnimation
  | RefusedWinAnimation
  | WinOnDiscardAnimation
  | SelfDrawAnimation
  | ExhaustiveDrawAnimation
  | HandEndAnimation
  | MatchEndAnimation;

export type SceneAnimationKind = SceneAnimation["kind"];

type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/**
 * Compile-time proof that the descriptor union covers the redacted event union
 * exactly. Add an event type without a descriptor and this line goes red, which
 * is cheaper than discovering it as a silently un-animated move.
 */
const _descriptorsCoverEvents: SameKeys<SceneAnimationKind, RedactedGameEvent["type"]> = true;
void _descriptorsCoverEvents;

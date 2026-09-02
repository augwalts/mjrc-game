/**
 * 牌局 — the match state machine. Implements DESIGN.md §5.2 in the §5.1 shape:
 *
 *   applyAction(state, action) -> { state, events[] }      pure, deterministic
 *   legalActions(state, seat)  -> Action[]
 *
 * The Durable Object, the replay viewer, the drills and the bot simulations all
 * call this same function. It performs ZERO I/O and reads no ambient clock: no
 * Math.random, no Date.now, no iteration over unordered object keys. Every tile
 * comes out of `buildWall(seed)` and every timestamp out of a logical clock
 * carried in the state, because replay is re-execution (§5.5) and an unseeded
 * decision is the exact bug the prototype shipped.
 *
 * Terminology: ../../TERMINOLOGY.md — Hong Kong Old Style only.
 *
 * ── five decisions this file makes, and why ──────────────────────────────
 *
 * 1. `MatchState extends GameState`. types.ts is the contract and is not edited.
 *    GameState describes ONE hand in flight; a match also needs a match id, an
 *    event sequence, a logical clock, the wall's tail pointer, the open claim
 *    window and the dealer/round bookkeeping §4 defines. Those live in the
 *    extension. Anything that reads a GameState still reads a MatchState.
 *
 * 2. DEAL and the hand advance are SERVER steps, not player actions — the
 *    `Action` union in types.ts has no member for either, correctly, because no
 *    seat performs them. They are `startMatch()` and `startNextHand()`. The
 *    machine therefore rests in phase "handEnd" so the table can show a result
 *    screen before the next deal, which is what phase "handEnd" is for.
 *
 * 3. The FIXED MINIMUM claim window is a deadline, not a wait loop. A pure
 *    reducer has no clock, so it stamps `deadlineTs` onto every claimOffered
 *    and resolves as soon as every prompted seat has answered. The transport
 *    owes the other half of §5.2: it must not release the resolution before
 *    `deadlineTs`, and at the deadline it submits `pass` on behalf of seats
 *    that stayed silent. Both halves are needed for timing not to leak a held
 *    claim; neither half can live in the other.
 *
 * 4. Normal draws come off the head of the wall, replacement draws (花 and 槓)
 *    off the tail 執尾. GameState carries one pointer, `wallIndex`, so the tail
 *    pointer `wallEnd` is part of the extension. Live tiles left is
 *    `wallEnd - wallIndex`; 流局 is that reaching zero, matching the standard
 *    rule ExhaustiveDrawPayload documents (no reserved dead wall).
 *
 * 5. A win under the minimum is REFUSED and VISIBLE (§5.2 — it is a teaching
 *    moment). `refusedWin` is emitted with the whole scorer input and the whole
 *    ScoreResult, the declaring seat keeps playing, and — in a claim window —
 *    the contest is re-resolved among the claims that are left, so one seat's
 *    refused win never swallows another seat's 碰.
 */

import type {
  Action,
  ClaimKind,
  ClaimOption,
  GameState,
  Meld,
  Ruleset,
  ScoreResult,
  SeatIndex,
  SeatState,
  TileId,
  WinContext,
  WindIndex,
} from "./types.js";
import { CLAIM_PRIORITY, WALL_SIZE } from "./types.js";
import { counts, isFlower } from "./tiles.js";
import { buildWall } from "./wall.js";
import { distanceToReady } from "./ready.js";
import {
  canAddedKong,
  canConcealedKong,
  canExposedKong,
  canPung,
  chowOptions,
  leftOf,
  makeChow,
  makeConcealedKong,
  makeExposedKong,
  makePung,
  upgradePungToKong,
} from "./melds.js";
import { hasWinningShape } from "./decompose.js";
import { score } from "./scoring.js";
import { DEFAULT_RULESET_ID, ruleset as rulesetById } from "@mjrc/rulesets";
import { EVENT_SCHEMA_VERSION } from "@mjrc/protocol";
import type { Actor, EventType, FourSeats, GameEvent } from "@mjrc/protocol";

/** Pinned build of the reducer. Old hands replay through their own (§5.5). */
export const ENGINE_VERSION = "mjrc-engine/1.0.0";

/**
 * Logical milliseconds added per event. The reducer has no clock; a replay of
 * the same actions must produce the same `ts` on every event, so the clock is
 * a counter in the state. A live table overwrites `ts` at the transport edge
 * with the real wall clock if it wants one — the archive keeps both honest by
 * pinning the engine version.
 */
export const TICK_MS = 1;

/** The fixed minimum a claim window stays open. See decision 3 in the header. */
export const CLAIM_WINDOW_MS = 3000;

/* ── state ─────────────────────────────────────────────────────────────── */

/**
 * How many wind rounds a match runs: 1 東圈, 2 東南, 3 東南西, 4 東南西北 全莊.
 *
 * The two legacy spellings are kept because ~15 callers across the sim stack
 * pass them and, more importantly, they appear in persisted log headers — a
 * rename would make old replay logs unreadable for no gain. `roundsOf`
 * normalises either form; state stores the resolved number only.
 */
export type MatchRounds = 1 | 2 | 3 | 4;
export type MatchLength = "oneWindRound" | "fourWindRounds";
export const roundsOf = (m: MatchLength | MatchRounds): MatchRounds =>
  m === "oneWindRound" ? 1 : m === "fourWindRounds" ? 4 : m;

/** One prompted seat inside an open window, and what it has answered. */
export interface ClaimOffer {
  seat: SeatIndex;
  options: ClaimOption[];
  /** null until the seat answers. The transport supplies a `pass` at deadline. */
  answer: { kind: "pass" } | { kind: "claim"; option: ClaimOption } | null;
}

export interface ClaimWindow {
  /** The tile on offer: a discard, or the fourth tile of a 加槓 being robbed. */
  tile: TileId;
  /** Discarder, or the seat declaring the 加槓. */
  from: SeatIndex;
  /** 搶槓 windows take win claims only. */
  robKong: boolean;
  deadlineTs: number;
  /**
   * Prompted seats in resolution order: clockwise from `from`. Priority ties
   * break to the nearest seat clockwise from the discarder (§5.2), so the
   * array order IS the tie-break and no comparator has to re-derive it.
   */
  offers: ClaimOffer[];
}

export interface HandResult {
  outcome: "winOnDiscard" | "selfDraw" | "exhaustiveDraw";
  winner: SeatIndex | null;
  loser: SeatIndex | null;
  faan: number | null;
  score: ScoreResult | null;
  chipDeltas: FourSeats<number>;
  dealerRepeats: boolean;
  nextDealer: SeatIndex;
  nextRoundWind: WindIndex;
  /** True when this hand was the last of the match. */
  matchOver: boolean;
}

/**
 * The whole match. A GameState by construction — see decision 1 in the header.
 */
export interface MatchState extends GameState {
  matchId: string;
  /** Strictly +1 per event across the whole match. A gap is corruption (§5.5). */
  seq: number;
  /** Logical clock. Advanced by TICK_MS per event and by nothing else. */
  ts: number;
  /** Seed the per-hand wall seeds are derived from. */
  matchSeed: number;
  /** Seed of the hand in play — the wall is `buildWall(handSeed)`. */
  handSeed: number;
  /** One past the last live tile. Replacement draws come off here. */
  wallEnd: number;
  /** Resolved wind rounds. See MatchRounds — config may spell it either way. */
  rounds: MatchRounds;
  startingDealer: SeatIndex;
  startingChips: FourSeats<number>;
  handsPlayed: number;
  /** 連莊 — how many times running the dealer has held the seat. */
  dealerStreak: number;
  /** Full deal cycles completed. The match ends when this reaches its target. */
  roundsCompleted: number;
  /** Open window, or null. */
  claim: ClaimWindow | null;
  /** True while the tile in `seats[turn].drawn` came off a 槓 replacement. */
  onKongReplacement: boolean;
  /**
   * The 自摸 declaration this seat already had refused on the tile it is still
   * holding. `legalActions` stops offering it, so a bot reading legal actions
   * cannot spin forever re-declaring the same below-minimum hand and the log
   * carries the teaching moment once rather than a thousand times. Cleared the
   * instant the seat's tiles change.
   */
  refusedSelfDraw: { seat: SeatIndex; tile: TileId } | null;
  /** Set once the hand ends; null while a hand is in flight. */
  result: HandResult | null;
  matchOver: boolean;
}

export interface Applied {
  state: MatchState;
  events: GameEvent[];
}

export interface MatchConfig {
  matchId: string;
  /** Every wall in the match derives from this one number. */
  seed: number;
  rulesetId?: string;
  /** Convenience: pass the ruleset object itself; its id is used. Added
   * 2026-08-29 after the silent-fallback incident — every sim had been passing
   * this (then-undeclared, unread) field and unknowingly playing the DEFAULT
   * ruleset. The id must still be registered in @mjrc/rulesets. */
  ruleset?: { id: string };
  dealer?: SeatIndex;
  /** 1-4, or the legacy "oneWindRound" / "fourWindRounds". Defaults to 1. */
  matchLength?: MatchLength | MatchRounds;
  startingChips?: number;
  /** Logical clock origin. Defaults to 0 so a test's log is stable. */
  startedAt?: number;
}

/* ── small helpers ─────────────────────────────────────────────────────── */

const asc = (a: number, b: number): number => a - b;
const nextSeat = (s: SeatIndex): SeatIndex => (((s as number) + 1) % 4) as SeatIndex;
const isSeat = (s: number): s is SeatIndex => Number.isInteger(s) && s >= 0 && s <= 3;

function four<T>(f: (i: SeatIndex) => T): FourSeats<T> {
  return [f(0), f(1), f(2), f(3)];
}

/** Clockwise from `from`, excluding `from`. The claim tie-break order (§5.2). */
function clockwiseFrom(from: SeatIndex): SeatIndex[] {
  return [1, 2, 3].map((n) => (((from as number) + n) % 4) as SeatIndex);
}

/**
 * Per-hand wall seed. A pure function of the match seed and the hand index, so
 * the whole match reconstructs from `{ seed, handIndex }` and nothing else.
 */
export const handSeedFor = (matchSeed: number, handIndex: number): number =>
  Math.imul(matchSeed ^ (handIndex + 1), 0x9e3779b1) >>> 0;

function removeOne(hand: TileId[], tile: TileId): void {
  const i = hand.indexOf(tile);
  if (i < 0) throw new Error(`tile ${tile} is not in hand`);
  hand.splice(i, 1);
}

function insertSorted(hand: TileId[], tile: TileId): void {
  let i = 0;
  while (i < hand.length && hand[i] <= tile) i++;
  hand.splice(i, 0, tile);
}

const cloneSeat = (s: SeatState): SeatState => ({
  seat: s.seat,
  wind: s.wind,
  hand: s.hand.slice(),
  drawn: s.drawn,
  melds: s.melds.slice(),
  flowers: s.flowers.slice(),
  discards: s.discards.slice(),
  chips: s.chips,
  connected: s.connected,
});

const cloneOffer = (o: ClaimOffer): ClaimOffer => ({
  seat: o.seat,
  options: o.options.map((x) => ({ kind: x.kind, ...(x.with ? { with: x.with.slice() } : {}) })),
  answer: o.answer === null ? null : o.answer.kind === "pass"
    ? { kind: "pass" }
    : { kind: "claim", option: { kind: o.answer.option.kind, ...(o.answer.option.with ? { with: o.answer.option.with.slice() } : {}) } },
});

/**
 * A working copy. `wall` is shared by reference on purpose: it is written once
 * by `buildWall` at the deal and never mutated, and copying 144 numbers per
 * action would be pure waste in a bot simulation running 110K hands/sec.
 */
export function cloneState(s: MatchState): MatchState {
  return {
    ...s,
    seats: [cloneSeat(s.seats[0]), cloneSeat(s.seats[1]), cloneSeat(s.seats[2]), cloneSeat(s.seats[3])],
    wall: s.wall,
    startingChips: [...s.startingChips] as FourSeats<number>,
    lastDiscard: s.lastDiscard === null ? null : { ...s.lastDiscard },
    refusedSelfDraw: s.refusedSelfDraw === null ? null : { ...s.refusedSelfDraw },
    claim: s.claim === null
      ? null
      : { ...s.claim, offers: s.claim.offers.map(cloneOffer) },
    result: s.result === null
      ? null
      : { ...s.result, chipDeltas: [...s.result.chipDeltas] as FourSeats<number> },
  };
}

/* ── the event emitter ─────────────────────────────────────────────────── */

interface Draft {
  s: MatchState;
  events: GameEvent[];
  ruleset: Ruleset;
}

type PayloadOf<T extends EventType> = Extract<GameEvent, { type: T }>["payload"];

/**
 * Stamps the §5.5 envelope. The cast is the one place the correlation between
 * `type` and `payload` is asserted rather than proved — TypeScript cannot
 * distribute a generic over a discriminated union's construction — and it is
 * safe because `PayloadOf<T>` is derived from the union itself.
 */
function emit<T extends EventType>(d: Draft, actor: Actor, type: T, payload: PayloadOf<T>): void {
  d.s.ts += TICK_MS;
  d.events.push({
    v: EVENT_SCHEMA_VERSION,
    matchId: d.s.matchId,
    handIndex: d.s.handIndex,
    seq: d.s.seq++,
    ts: d.s.ts,
    actor,
    type,
    payload,
  } as GameEvent);
}

function resolveRuleset(id: string): Ruleset {
  const r = rulesetById(id) ?? rulesetById(DEFAULT_RULESET_ID);
  if (!r) throw new Error(`no ruleset "${id}" and no default ruleset`);
  return r;
}

/* ── wall access ───────────────────────────────────────────────────────── */

const liveTilesLeft = (s: MatchState): number => s.wallEnd - s.wallIndex;

/** Next live tile off the head. null when the wall is spent 流局. */
function takeHead(s: MatchState): TileId | null {
  if (s.wallIndex >= s.wallEnd) return null;
  return s.wall[s.wallIndex++];
}

/** Next replacement tile off the tail 執尾 — 花 and 槓 draws only. */
function takeTail(s: MatchState): TileId | null {
  if (s.wallIndex >= s.wallEnd) return null;
  return s.wall[--s.wallEnd];
}

/* ── flowers 花 ────────────────────────────────────────────────────────── */

/**
 * Replace every flower in a seat's HAND, lowest first, recursively: a
 * replacement that is itself a flower is replaced in turn. Strictly ordered so
 * re-execution reproduces the wall consumption exactly (§5.2).
 * @returns false when the wall ran out mid-replacement.
 */
function replaceHandFlowers(d: Draft, seat: SeatIndex): boolean {
  const st = d.s.seats[seat];
  for (;;) {
    // The hand is kept sorted and flowers hold the highest ids, so the first
    // flower scanned forward is the lowest flower held.
    let at = -1;
    for (let i = 0; i < st.hand.length; i++) {
      if (isFlower(st.hand[i])) {
        at = i;
        break;
      }
    }
    if (at < 0) return true;
    const flower = st.hand[at];
    const replacement = takeTail(d.s);
    if (replacement === null) return false;
    st.hand.splice(at, 1);
    st.flowers.push(flower);
    insertSorted(st.hand, replacement);
    emit(d, "server", "flowerReplacement", {
      seat,
      flower,
      replacement,
      wallIndex: d.s.wallIndex,
      wallRemaining: liveTilesLeft(d.s),
    });
  }
}

/**
 * Replace a flower sitting in `drawn`, recursively. Same ordering guarantee.
 * @returns false when the wall ran out mid-replacement.
 */
function replaceDrawnFlowers(d: Draft, seat: SeatIndex): boolean {
  const st = d.s.seats[seat];
  while (st.drawn !== null && isFlower(st.drawn)) {
    const flower = st.drawn;
    const replacement = takeTail(d.s);
    if (replacement === null) {
      st.drawn = null;
      return false;
    }
    st.flowers.push(flower);
    st.drawn = replacement;
    d.s.refusedSelfDraw = null;
    emit(d, "server", "flowerReplacement", {
      seat,
      flower,
      replacement,
      wallIndex: d.s.wallIndex,
      wallRemaining: liveTilesLeft(d.s),
    });
  }
  return true;
}

/* ── draws ─────────────────────────────────────────────────────────────── */

/** A turn draw off the head, with 花 auto-replacement. false = 流局. */
function drawForTurn(d: Draft, seat: SeatIndex): boolean {
  const tile = takeHead(d.s);
  if (tile === null) return false;
  d.s.seats[seat].drawn = tile;
  d.s.onKongReplacement = false;
  d.s.refusedSelfDraw = null;
  emit(d, "server", "draw", {
    seat,
    tile,
    wallIndex: d.s.wallIndex,
    wallRemaining: liveTilesLeft(d.s),
  });
  return replaceDrawnFlowers(d, seat);
}

/** 槓 replacement off the tail, with 花 auto-replacement. false = 流局. */
function drawKongReplacement(
  d: Draft,
  seat: SeatIndex,
  kongKind: "exposed" | "concealed" | "added",
): boolean {
  const tile = takeTail(d.s);
  if (tile === null) return false;
  d.s.seats[seat].drawn = tile;
  d.s.onKongReplacement = true;
  d.s.refusedSelfDraw = null;
  emit(d, "server", "kongReplacement", {
    seat,
    tile,
    kongKind,
    wallIndex: d.s.wallIndex,
    wallRemaining: liveTilesLeft(d.s),
  });
  return replaceDrawnFlowers(d, seat);
}

/* ── hand shape questions ──────────────────────────────────────────────── */

/** Concealed slot count: 13 - 3 per declared set, whatever the set's size. */
const waitingCount = (st: SeatState): number => 13 - 3 * st.melds.length;

/**
 * Could this seat win on `tile`, purely by shape? Faan is a separate question —
 * a below-minimum win is offered, declared, and then refused VISIBLY (§5.2).
 * `decomposeWin` throws on inputs that cannot be a hand at all; that is a
 * caller bug everywhere except here, where a seat mid-turn legitimately holds
 * the wrong count, so the guard is a count check rather than a catch.
 */
/**
 * Does this house play 七對子? A faanTable is both the price list and the
 * enable list, so pricing the pattern is what turns the shape on. A table that
 * does not price it never sees seven pairs offered as a win — which keeps
 * hkos-standard exactly as it was.
 */
const playsSevenPairs = (r: Ruleset): boolean => r.faanTable.sevenPairs !== undefined;

function shapeWins(st: SeatState, tile: TileId, sevenPairs: boolean): boolean {
  if (isFlower(tile)) return false;
  if (st.melds.length > 4) return false;
  if (st.hand.length !== waitingCount(st)) return false;
  return hasWinningShape(st.hand, st.melds, tile, sevenPairs);
}

/* ── claim windows ─────────────────────────────────────────────────────── */

/** Every legal claim the seat holds on a discard, in CLAIM_PRIORITY order. */
function claimOptionsFor(
  st: SeatState,
  tile: TileId,
  from: SeatIndex,
  sevenPairs: boolean,
): ClaimOption[] {
  const out: ClaimOption[] = [];
  if (shapeWins(st, tile, sevenPairs)) out.push({ kind: "win" });
  if (canExposedKong(st.hand, tile)) out.push({ kind: "kong" });
  if (canPung(st.hand, tile)) out.push({ kind: "pung" });
  // 上 is only ever available from 上家 — chowOptions enforces that itself.
  for (const pair of chowOptions(st.hand, tile, st.seat, from)) out.push({ kind: "chow", with: pair });
  return out;
}

/**
 * Open a window. Only seats WITH a legal claim are prompted, per seat and
 * private (§5.2), which is why claimOffered/claimDeclined are the two events
 * `redactEventFor` drops entirely for everyone else.
 * @returns true when at least one seat was prompted.
 */
function openClaimWindow(d: Draft, tile: TileId, from: SeatIndex, robKong: boolean): boolean {
  const offers: ClaimOffer[] = [];
  for (const seat of clockwiseFrom(from)) {
    const st = d.s.seats[seat];
    const sevenPairs = playsSevenPairs(d.ruleset);
    const options = robKong
      ? shapeWins(st, tile, sevenPairs)
        ? ([{ kind: "win" }] as ClaimOption[])
        : []
      : claimOptionsFor(st, tile, from, sevenPairs);
    if (options.length > 0) offers.push({ seat, options, answer: null });
  }
  if (offers.length === 0) return false;

  const deadlineTs = d.s.ts + CLAIM_WINDOW_MS;
  d.s.claim = { tile, from, robKong, deadlineTs, offers };
  d.s.phase = robKong ? "robKongWindow" : "claimWindow";

  if (robKong) {
    emit(d, "server", "robKongWindow", {
      seat: from,
      tile,
      offeredTo: offers.map((o) => o.seat),
      deadlineTs,
    });
  } else {
    for (const o of offers) {
      emit(d, "server", "claimOffered", {
        seat: o.seat,
        tile,
        from,
        options: o.options.map((x) => ({ kind: x.kind, ...(x.with ? { with: x.with.slice() } : {}) })),
        deadlineTs,
      });
    }
  }
  return true;
}

const priorityOf = (k: ClaimKind): number => CLAIM_PRIORITY.indexOf(k);

/**
 * Highest-priority live claim. `offers` is already clockwise from the source,
 * so a strict `>` comparison keeps the nearest seat on a tie — which is exactly
 * the §5.2 rule. 槓 outranking 碰 in CLAIM_PRIORITY never decides anything
 * between two seats: a kong claim needs three copies in hand and a pung claim
 * two, and five copies of a tile do not exist.
 */
function bestClaim(live: ClaimOffer[]): ClaimOffer {
  let best = live[0];
  for (const o of live) {
    const a = o.answer;
    const b = best.answer;
    if (a === null || a.kind !== "claim" || b === null || b.kind !== "claim") continue;
    if (priorityOf(a.option.kind) < priorityOf(b.option.kind)) best = o;
  }
  return best;
}

/* ── melding a claimed tile ────────────────────────────────────────────── */

/** Take the claimed tile off the discarder's pile — it is on the table now. */
function consumeDiscard(d: Draft, from: SeatIndex, tile: TileId): void {
  const pile = d.s.seats[from].discards;
  const i = pile.lastIndexOf(tile);
  if (i >= 0) pile.splice(i, 1);
  d.s.lastDiscard = null;
}

/* ── scoring and settlement ────────────────────────────────────────────── */

function winContext(
  s: MatchState,
  seat: SeatIndex,
  winningTile: TileId,
  selfDraw: boolean,
  from: SeatIndex | null,
  extra: { robbedKong?: boolean; onKongReplacement?: boolean; onLastTile?: boolean },
): WinContext {
  return {
    seat,
    selfDraw,
    from,
    winningTile,
    roundWind: s.roundWind,
    seatWind: s.seats[seat].wind,
    isDealer: seat === s.dealer,
    ...(extra.robbedKong ? { robbedKong: true } : {}),
    ...(extra.onKongReplacement ? { onKongReplacement: true } : {}),
    ...(extra.onLastTile ? { onLastTile: true } : {}),
    wallEmpty: liveTilesLeft(s) === 0,
  };
}

/**
 * What a declaration WOULD score, without taking it.
 *
 * `legalActions` offers a win on SHAPE alone, and `doDeclareWin` then refuses
 * it visibly if it falls under the floor — correct for the table, but it means
 * a client cannot tell a payable win from a shape until after the player has
 * committed to pressing the button. This answers that question first, using
 * the same winContext and the same scorer, so the two can never disagree.
 *
 * Pure: it reads the state and returns a score. Nothing is mutated.
 */
export function previewWin(
  state: MatchState,
  seat: SeatIndex,
  win: { selfDraw: boolean; tile: TileId; from: SeatIndex | null; robbedKong?: boolean },
): ScoreResult {
  const st = state.seats[seat]!;
  /* The two paths build DIFFERENT contexts, and the difference is worth faan.
     A self-draw can be 槓上開花 or 海底撈月; a claim on a discard can be
     neither — doClaims passes onLastTile:false — and can be 搶槓 instead.
     Collapsing them awarded 海底撈月 to discard wins and made this preview
     read 3 faan on a hand the reducer then refused at 2. */
  const ctx = win.selfDraw
    ? winContext(state, seat, win.tile, true, null, {
        onKongReplacement: state.onKongReplacement,
        onLastTile: liveTilesLeft(state) === 0,
      })
    : winContext(state, seat, win.tile, false, win.from, {
        ...(win.robbedKong ? { robbedKong: true } : {}),
        onLastTile: false,
      });
  // scoreDeclaration passes the hand as-is for both paths
  return score(st.hand.slice(), st.melds.slice(), st.flowers.slice(), win.tile, ctx,
    resolveRuleset(state.rulesetId));
}

/**
 * Score a declaration. Returns the result whether or not it clears the floor;
 * the caller decides between a win and a visible refusal.
 */
function scoreDeclaration(d: Draft, seat: SeatIndex, ctx: WinContext): ScoreResult {
  const st = d.s.seats[seat];
  return score(st.hand.slice(), st.melds.slice(), st.flowers.slice(), ctx.winningTile, ctx, d.ruleset);
}

function emitRefusedWin(d: Draft, seat: SeatIndex, ctx: WinContext, result: ScoreResult): void {
  const st = d.s.seats[seat];
  emit(d, seat, "refusedWin", {
    context: ctx,
    concealed: st.hand.slice(),
    melds: st.melds.slice(),
    flowers: st.flowers.slice(),
    score: result,
    minimumFaan: d.ruleset.minimumFaan,
    reason: "belowMinimum",
  });
}

/** Chip movement for a taken win. Sums to zero; 流局 moves nothing. */
function settle(d: Draft, ctx: WinContext, faan: number): FourSeats<number> {
  const t = d.ruleset.payment;
  const deltas: FourSeats<number> = [0, 0, 0, 0];
  if (ctx.selfDraw) {
    const each = t.onSelfDraw(faan);
    for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) {
      if (i === ctx.seat) continue;
      deltas[i] -= each;
      deltas[ctx.seat] += each;
    }
  } else {
    // 全銃 — the discarder carries the whole hand. The only settlement a
    // PaymentTable can express; payment.ts records that gap.
    const amount = t.onDiscard(faan);
    const loser = ctx.from as SeatIndex;
    deltas[loser] -= amount;
    deltas[ctx.seat] += amount;
  }
  return deltas;
}

/* ── hand end ──────────────────────────────────────────────────────────── */

function endHand(
  d: Draft,
  outcome: HandResult["outcome"],
  winner: SeatIndex | null,
  loser: SeatIndex | null,
  faan: number | null,
  result: ScoreResult | null,
  chipDeltas: FourSeats<number>,
): void {
  const s = d.s;
  for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) s.seats[i].chips += chipDeltas[i];

  // 連莊 — the dealer repeats on a dealer win and on 流局 (DESIGN.md §4).
  const dealerRepeats = outcome === "exhaustiveDraw" || winner === s.dealer;
  const nextDealer = dealerRepeats ? s.dealer : nextSeat(s.dealer);
  // The prevailing wind advances when the deal passes East's seat a full cycle.
  const cycleComplete = !dealerRepeats && nextDealer === s.startingDealer;
  const nextRoundWind = (cycleComplete
    ? (((s.roundWind as number) + 1) % 4)
    : (s.roundWind as number)) as WindIndex;

  const roundsCompleted = s.roundsCompleted + (cycleComplete ? 1 : 0);
  const target = s.rounds;
  const matchOver = roundsCompleted >= target;

  s.claim = null;
  s.phase = "handEnd";
  s.handsPlayed += 1;
  s.dealerStreak = dealerRepeats ? s.dealerStreak + 1 : 0;
  s.roundsCompleted = roundsCompleted;
  s.matchOver = matchOver;
  s.result = {
    outcome,
    winner,
    loser,
    faan,
    score: result,
    chipDeltas,
    dealerRepeats,
    nextDealer,
    nextRoundWind,
    matchOver,
  };

  emit(d, "server", "handEnd", {
    outcome,
    winner,
    loser,
    faan,
    chipDeltas: [...chipDeltas] as FourSeats<number>,
    standings: four((i) => s.seats[i].chips),
    dealerRepeats,
    nextDealer,
    nextRoundWind,
  });
}

/** Take a win: publish it, settle it, end the hand. */
function takeWin(d: Draft, ctx: WinContext, result: ScoreResult): void {
  const st = d.s.seats[ctx.seat];
  const payload = {
    context: ctx,
    concealed: st.hand.slice(),
    melds: st.melds.slice(),
    flowers: st.flowers.slice(),
    score: result,
  };
  const deltas = settle(d, ctx, result.faan);
  if (ctx.selfDraw) {
    emit(d, ctx.seat, "selfDraw", payload as PayloadOf<"selfDraw">);
    endHand(d, "selfDraw", ctx.seat, null, result.faan, result, deltas);
  } else {
    emit(d, ctx.seat, "winOnDiscard", payload as PayloadOf<"winOnDiscard">);
    endHand(d, "winOnDiscard", ctx.seat, ctx.from, result.faan, result, deltas);
  }
}

/** 流局 — the wall is spent with no winner. Dealer repeats (§4). */
function exhaustiveDraw(d: Draft): void {
  const s = d.s;
  for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) {
    const st = s.seats[i];
    if (st.drawn !== null) {
      insertSorted(st.hand, st.drawn);
      st.drawn = null;
    }
  }
  emit(d, "server", "exhaustiveDraw", {
    wallRemaining: liveTilesLeft(s),
    hands: four((i) => s.seats[i].hand.slice()),
    distanceToReady: four((i) =>
      distanceToReady(counts(s.seats[i].hand), s.seats[i].melds.length),
    ),
  });
  endHand(d, "exhaustiveDraw", null, null, null, null, [0, 0, 0, 0]);
}

/* ── turn advance ──────────────────────────────────────────────────────── */

/** Pass the turn to the next seat and draw. 流局 when the wall is spent. */
function advanceTurn(d: Draft, from: SeatIndex): void {
  const seat = nextSeat(from);
  d.s.turn = seat;
  d.s.phase = "awaitDiscard";
  if (!drawForTurn(d, seat)) exhaustiveDraw(d);
}

/* ── claim resolution ──────────────────────────────────────────────────── */

/**
 * Resolve a window once every prompted seat has answered. win > kong/pung >
 * chow, ties to the nearest seat clockwise from the source (§5.2).
 *
 * A refused win does NOT end the contest: the refusal is published and the
 * remaining claims are re-resolved, so a seat that declared a 2-faan hand
 * cannot rob a legitimate 碰 from the seat behind it.
 */
function resolveWindow(d: Draft): void {
  const w = d.s.claim;
  if (!w) throw new Error("no claim window to resolve");

  const passed: SeatIndex[] = [];
  let live: ClaimOffer[] = [];
  for (const o of w.offers) {
    if (o.answer !== null && o.answer.kind === "claim") live.push(o);
    else passed.push(o.seat);
  }

  let winner: { offer: ClaimOffer; option: ClaimOption } | null = null;
  const refused: SeatIndex[] = [];

  while (live.length > 0) {
    const best = bestClaim(live);
    const option = (best.answer as { kind: "claim"; option: ClaimOption }).option;
    if (option.kind !== "win") {
      winner = { offer: best, option };
      break;
    }
    const ctx = winContext(d.s, best.seat, w.tile, false, w.from, {
      robbedKong: w.robKong,
      onLastTile: false,
    });
    const result = scoreDeclaration(d, best.seat, ctx);
    if (result.legal) {
      winner = { offer: best, option };
      break;
    }
    // Visible refusal, then the contest continues without this seat. The
    // refusedWin event IS this seat's decline record, so no claimDeclined is
    // emitted for it as well.
    emitRefusedWin(d, best.seat, ctx, result);
    refused.push(best.seat);
    live = live.filter((o) => o !== best);
  }

  // Everyone who is not the winner and did not have a win refused is declined.
  for (const o of w.offers) {
    if (winner && o.seat === winner.offer.seat) continue;
    if (refused.includes(o.seat)) continue;
    emit(d, passed.includes(o.seat) ? o.seat : "server", "claimDeclined", {
      seat: o.seat,
      tile: w.tile,
      from: w.from,
      reason: passed.includes(o.seat) ? "pass" : "outranked",
    });
  }

  const { tile, from, robKong } = w;
  d.s.claim = null;

  if (!winner) {
    // All passed, or every win was refused.
    if (robKong) completeAddedKong(d, from);
    else advanceTurn(d, from);
    return;
  }

  const seat = winner.offer.seat;
  const option = winner.option;

  if (option.kind === "win") {
    if (robKong) revertAddedKong(d, from, tile);
    else consumeDiscard(d, from, tile);
    const ctx = winContext(d.s, seat, tile, false, from, {
      robbedKong: robKong,
      onLastTile: false,
    });
    // Re-scored under the same context that cleared the floor a moment ago;
    // score() is pure, so this is the same ScoreResult.
    takeWin(d, ctx, scoreDeclaration(d, seat, ctx));
    return;
  }

  consumeDiscard(d, from, tile);
  const st = d.s.seats[seat];
  let meld: Meld;
  if (option.kind === "chow") {
    const withTiles = option.with ?? [];
    meld = makeChow([tile, ...withTiles], seat, from);
    for (const t of withTiles) removeOne(st.hand, t);
  } else if (option.kind === "pung") {
    meld = makePung(tile, seat, from);
    removeOne(st.hand, tile);
    removeOne(st.hand, tile);
  } else {
    meld = makeExposedKong(tile, seat, from);
    removeOne(st.hand, tile);
    removeOne(st.hand, tile);
    removeOne(st.hand, tile);
  }
  st.melds.push(meld);
  emit(d, seat, "claimed", { seat, kind: option.kind, tile, from, meld });

  d.s.turn = seat;
  d.s.phase = "awaitDiscard";
  st.drawn = null;
  d.s.onKongReplacement = false;

  if (option.kind === "kong") {
    // 明槓 — the quad is replaced from the tail before the claimant discards.
    if (!drawKongReplacement(d, seat, "exposed")) exhaustiveDraw(d);
  }
  // 碰 and 上 take the turn with NO draw: the claimed tile is the 14th (§5.2).
}

/* ── 加槓 rob window aftermath ─────────────────────────────────────────── */

/** Nobody robbed it: the 加槓 stands and its replacement is drawn. */
function completeAddedKong(d: Draft, seat: SeatIndex): void {
  d.s.turn = seat;
  d.s.phase = "awaitDiscard";
  if (!drawKongReplacement(d, seat, "added")) exhaustiveDraw(d);
}

/**
 * 搶槓 succeeded: the fourth tile is taken off the 加槓, which reverts to the
 * 碰 it grew from. The declarer's melds are scored and archived as they truly
 * stood, not as they briefly appeared.
 */
function revertAddedKong(d: Draft, seat: SeatIndex, tile: TileId): void {
  const st = d.s.seats[seat];
  const i = st.melds.findIndex(
    (m) => m.kind === "kong" && m.addedToPung === true && m.tiles[0] === tile,
  );
  if (i < 0) throw new Error(`no 加槓 of tile ${tile} to rob at seat ${seat}`);
  const kong = st.melds[i];
  st.melds = st.melds.slice();
  st.melds[i] = { kind: "pung", tiles: [tile, tile, tile], from: kong.from, concealed: false };
}

/* ── the deal ──────────────────────────────────────────────────────────── */

/**
 * DEAL → FLOWER_REPLACEMENT → AWAIT_DISCARD(dealer).
 *
 * Thirteen tiles to each seat in the traditional 4-4-4-1 order starting at the
 * dealer, then flower replacement in seat order from the dealer, then the
 * dealer's fourteenth as a normal draw. Dealing the fourteenth BEFORE flower
 * replacement would leave the dealer holding fourteen tiles with no way to say
 * which one was drawn — and `drawn` is what a 自摸 declaration names as the
 * winning tile, 天糊 included.
 */
function dealHand(d: Draft): void {
  const s = d.s;
  s.phase = "deal";
  s.handSeed = handSeedFor(s.matchSeed, s.handIndex);
  s.wall = buildWall(s.handSeed, d.ruleset.useFlowers);
  s.wallIndex = 0;
  s.wallEnd = s.wall.length;
  s.lastDiscard = null;
  s.claim = null;
  s.result = null;
  s.onKongReplacement = false;
  s.refusedSelfDraw = null;

  for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) {
    const st = s.seats[i];
    st.hand = [];
    st.drawn = null;
    st.melds = [];
    st.flowers = [];
    st.discards = [];
    st.wind = ((((i as number) - (s.dealer as number) + 4) % 4)) as WindIndex;
  }

  const order = [0, 1, 2, 3].map((n) => (((s.dealer as number) + n) % 4) as SeatIndex);
  for (let block = 0; block < 3; block++) {
    for (const seat of order) {
      for (let n = 0; n < 4; n++) s.seats[seat].hand.push(s.wall[s.wallIndex++]);
    }
  }
  for (const seat of order) s.seats[seat].hand.push(s.wall[s.wallIndex++]);
  for (const seat of order) s.seats[seat].hand.sort(asc);

  emit(d, "server", "deal", {
    seed: s.handSeed,
    dealer: s.dealer,
    roundWind: s.roundWind,
    seatWinds: four((i) => s.seats[i].wind),
    hands: four((i) => s.seats[i].hand.slice()),
    wallIndex: s.wallIndex,
    wallRemaining: liveTilesLeft(s),
  });

  s.phase = "flowerReplacement";
  for (const seat of order) {
    if (!replaceHandFlowers(d, seat)) {
      exhaustiveDraw(d);
      return;
    }
  }

  s.phase = "awaitDiscard";
  s.turn = s.dealer;
  if (!drawForTurn(d, s.dealer)) exhaustiveDraw(d);
}

/* ── public entry points ───────────────────────────────────────────────── */

/** A fresh match with its first hand dealt, resting at AWAIT_DISCARD(dealer). */
export function startMatch(config: MatchConfig): Applied {
  const dealer = config.dealer ?? 0;
  if (!isSeat(dealer)) throw new Error(`dealer ${dealer} is not a seat`);
  const chips = config.startingChips ?? 0;
  const rulesetId = config.rulesetId ?? config.ruleset?.id ?? DEFAULT_RULESET_ID;
  if (!rulesetById(rulesetId)) throw new Error(`unknown ruleset ${rulesetId} — register it in @mjrc/rulesets`);

  const state: MatchState = {
    phase: "deal",
    seats: four((i) => ({
      seat: i,
      wind: ((((i as number) - (dealer as number) + 4) % 4)) as WindIndex,
      hand: [],
      drawn: null,
      melds: [],
      flowers: [],
      discards: [],
      chips,
      connected: true,
    })) as MatchState["seats"],
    roundWind: 0,
    dealer,
    turn: dealer,
    handIndex: 0,
    wall: [],
    wallIndex: 0,
    lastDiscard: null,
    rulesetId,
    engineVersion: ENGINE_VERSION,

    matchId: config.matchId,
    seq: 0,
    ts: config.startedAt ?? 0,
    matchSeed: config.seed >>> 0,
    handSeed: 0,
    wallEnd: WALL_SIZE,
    rounds: config.matchLength === undefined ? 1 : roundsOf(config.matchLength),
    startingDealer: dealer,
    startingChips: four(() => chips),
    handsPlayed: 0,
    dealerStreak: 0,
    roundsCompleted: 0,
    claim: null,
    onKongReplacement: false,
    refusedSelfDraw: null,
    result: null,
    matchOver: false,
  };

  const d: Draft = { s: state, events: [], ruleset: resolveRuleset(rulesetId) };
  dealHand(d);
  return { state: d.s, events: d.events };
}

/**
 * HAND_END → next DEAL, or MATCH_END. A server step: no seat performs it, so
 * it is not in the `Action` union (header decision 2).
 */
export function startNextHand(state: MatchState): Applied {
  if (state.phase !== "handEnd") {
    throw new Error(`startNextHand needs phase "handEnd", got "${state.phase}"`);
  }
  const d: Draft = {
    s: cloneState(state),
    events: [],
    ruleset: resolveRuleset(state.rulesetId),
  };
  const result = d.s.result;
  if (!result) throw new Error("hand ended with no result");

  if (result.matchOver) {
    d.s.phase = "matchEnd";
    // 1-4 by chips; ties break by seat order from the starting dealer, so the
    // sort is over that order and Array#sort is stable by specification.
    const byStart = [0, 1, 2, 3].map(
      (n) => (((d.s.startingDealer as number) + n) % 4) as SeatIndex,
    );
    const ranked = byStart.slice().sort((a, b) => d.s.seats[b].chips - d.s.seats[a].chips);
    const placements: FourSeats<1 | 2 | 3 | 4> = [1, 1, 1, 1];
    ranked.forEach((seat, i) => {
      placements[seat] = (i + 1) as 1 | 2 | 3 | 4;
    });
    emit(d, "server", "matchEnd", {
      reason: d.s.rounds === 1 ? "windRoundComplete" : "allRoundsComplete",
      standings: four((i) => d.s.seats[i].chips),
      placements,
      handsPlayed: d.s.handsPlayed,
    });
    return { state: d.s, events: d.events };
  }

  d.s.dealer = result.nextDealer;
  d.s.roundWind = result.nextRoundWind;
  d.s.handIndex += 1;
  d.s.result = null;
  dealHand(d);
  return { state: d.s, events: d.events };
}

/* ── legalActions ──────────────────────────────────────────────────────── */

/**
 * Everything `seat` may legally do right now. The bots and the client both
 * read this; nothing else is accepted by `applyAction`.
 */
export function legalActions(state: MatchState, seat: SeatIndex): Action[] {
  const out: Action[] = [];
  if (!isSeat(seat)) return out;

  if (state.phase === "claimWindow" || state.phase === "robKongWindow") {
    const w = state.claim;
    if (!w) return out;
    const offer = w.offers.find((o) => o.seat === seat);
    if (!offer || offer.answer !== null) return out;
    for (const option of offer.options) {
      out.push({
        type: "claim",
        seat,
        option: { kind: option.kind, ...(option.with ? { with: option.with.slice() } : {}) },
      });
    }
    out.push({ type: "pass", seat });
    return out;
  }

  if (state.phase !== "awaitDiscard" || state.turn !== seat) return out;

  const st = state.seats[seat];
  const drawn = st.drawn;

  const alreadyRefused =
    state.refusedSelfDraw !== null &&
    state.refusedSelfDraw.seat === seat &&
    state.refusedSelfDraw.tile === drawn;
  if (drawn !== null && !alreadyRefused
      && shapeWins(st, drawn, playsSevenPairs(resolveRuleset(state.rulesetId)))) {
    out.push({ type: "declareWin", seat, selfDraw: true });
  }

  const all = drawn === null ? st.hand : [...st.hand, drawn];
  // Distinct tiles, ascending — never an unordered key iteration (§5.5).
  const seen: boolean[] = [];
  const distinct: TileId[] = [];
  for (const t of all.slice().sort(asc)) {
    if (!seen[t]) {
      seen[t] = true;
      distinct.push(t);
    }
  }

  for (const tile of distinct) {
    if (canConcealedKong(all, tile)) out.push({ type: "concealedKong", seat, tile });
  }
  for (const tile of distinct) {
    if (canAddedKong(all, st.melds, tile)) out.push({ type: "addedKong", seat, tile });
  }
  for (const tile of distinct) out.push({ type: "discard", seat, tile });

  return out;
}

/* ── applyAction ───────────────────────────────────────────────────────── */

function requireTurn(state: MatchState, seat: SeatIndex): void {
  if (state.phase !== "awaitDiscard") {
    throw new Error(`seat ${seat} acted in phase "${state.phase}", expected "awaitDiscard"`);
  }
  if (state.turn !== seat) throw new Error(`seat ${seat} acted out of turn (turn is ${state.turn})`);
}

/** Fold `drawn` back into the hand so the 14 tiles are one sorted array. */
function absorbDrawn(st: SeatState): void {
  if (st.drawn === null) return;
  insertSorted(st.hand, st.drawn);
  st.drawn = null;
}

function doDiscard(d: Draft, seat: SeatIndex, tile: TileId): void {
  const st = d.s.seats[seat];
  const drawAndCut = st.drawn === tile;
  if (drawAndCut) {
    st.drawn = null;
  } else {
    absorbDrawn(st);
    removeOne(st.hand, tile);
  }
  st.discards.push(tile);
  d.s.lastDiscard = { tile, from: seat };
  d.s.onKongReplacement = false;
  d.s.refusedSelfDraw = null;
  emit(d, seat, "discard", { seat, tile, drawAndCut });

  if (!openClaimWindow(d, tile, seat, false)) advanceTurn(d, seat);
}

function doConcealedKong(d: Draft, seat: SeatIndex, tile: TileId): void {
  const st = d.s.seats[seat];
  absorbDrawn(st);
  if (!canConcealedKong(st.hand, tile)) {
    throw new Error(`seat ${seat} cannot declare 暗槓 of tile ${tile}`);
  }
  for (let n = 0; n < 4; n++) removeOne(st.hand, tile);
  const meld = makeConcealedKong(tile, seat);
  st.melds.push(meld);
  emit(d, seat, "concealedKong", { seat, tile, meld });
  // 暗槓 is laid down complete and is never robbable in HK Old Style
  // (melds.ts/opensRobKongWindow) — straight to the replacement draw.
  d.s.phase = "awaitDiscard";
  if (!drawKongReplacement(d, seat, "concealed")) exhaustiveDraw(d);
}

function doAddedKong(d: Draft, seat: SeatIndex, tile: TileId): void {
  const st = d.s.seats[seat];
  absorbDrawn(st);
  if (!canAddedKong(st.hand, st.melds, tile)) {
    throw new Error(`seat ${seat} cannot declare 加槓 of tile ${tile}`);
  }
  st.melds = upgradePungToKong(st.melds, tile, seat);
  removeOne(st.hand, tile);
  const meld = st.melds.find((m) => m.kind === "kong" && m.tiles[0] === tile) as Meld;
  emit(d, seat, "addedKong", { seat, tile, meld });

  // 搶槓 — the one kong form that can be robbed, and only by a win.
  if (!openClaimWindow(d, tile, seat, true)) completeAddedKong(d, seat);
}

function doDeclareWin(d: Draft, seat: SeatIndex): void {
  const st = d.s.seats[seat];
  if (st.drawn === null) throw new Error(`seat ${seat} has no drawn tile to win on`);
  if (!shapeWins(st, st.drawn, playsSevenPairs(d.ruleset))) {
    throw new Error(`seat ${seat} has no winning shape`);
  }
  const ctx = winContext(d.s, seat, st.drawn, true, null, {
    onKongReplacement: d.s.onKongReplacement,
    onLastTile: liveTilesLeft(d.s) === 0,
  });
  const result = scoreDeclaration(d, seat, ctx);
  if (!result.legal) {
    // Refused, VISIBLY, and the seat still owes a discard (§5.2). Never a
    // silent rollback: the log carries the whole breakdown as the teaching.
    emitRefusedWin(d, seat, ctx, result);
    d.s.refusedSelfDraw = { seat, tile: ctx.winningTile };
    return;
  }
  takeWin(d, ctx, result);
}

function doClaimOrPass(d: Draft, seat: SeatIndex, answer: ClaimOffer["answer"]): void {
  const w = d.s.claim;
  if (!w) throw new Error(`seat ${seat} answered a claim window that is not open`);
  const offer = w.offers.find((o) => o.seat === seat);
  if (!offer) throw new Error(`seat ${seat} was not prompted on tile ${w.tile}`);
  if (offer.answer !== null) throw new Error(`seat ${seat} has already answered`);
  if (answer && answer.kind === "claim") {
    const want = answer.option;
    // A 上 is identified by the pair it takes out of hand, whatever order the
    // client listed them in; every other claim is identified by its kind alone.
    const wantPair = want.with ? [...want.with].sort(asc).join(",") : "";
    const match = offer.options.find(
      (o) =>
        o.kind === want.kind &&
        (o.kind !== "chow" || (o.with !== undefined && o.with.slice().sort(asc).join(",") === wantPair)),
    );
    if (!match) throw new Error(`seat ${seat} claimed ${want.kind}, which it was not offered`);
    offer.answer = { kind: "claim", option: { kind: match.kind, ...(match.with ? { with: match.with.slice() } : {}) } };
  } else {
    offer.answer = { kind: "pass" };
  }
  if (w.offers.every((o) => o.answer !== null)) resolveWindow(d);
}

/**
 * The one entry point every caller shares. Pure: `state` is never mutated and
 * the returned state is a fresh object.
 *
 * Illegal actions THROW. The transport turns that into a rejected message
 * (protocol/src/messages.ts) — a malformed declaration is not an event, and
 * only a shape-complete hand under the faan floor reaches the log as a
 * `refusedWin`.
 */
export function applyAction(state: MatchState, action: Action): Applied {
  const d: Draft = {
    s: cloneState(state),
    events: [],
    ruleset: resolveRuleset(state.rulesetId),
  };
  if (!isSeat(action.seat)) throw new Error(`seat ${action.seat} is not a seat`);

  switch (action.type) {
    case "discard": {
      requireTurn(d.s, action.seat);
      const st = d.s.seats[action.seat];
      if (st.drawn !== action.tile && !st.hand.includes(action.tile)) {
        throw new Error(`seat ${action.seat} does not hold tile ${action.tile}`);
      }
      doDiscard(d, action.seat, action.tile);
      break;
    }
    case "concealedKong":
      requireTurn(d.s, action.seat);
      doConcealedKong(d, action.seat, action.tile);
      break;
    case "addedKong":
      requireTurn(d.s, action.seat);
      doAddedKong(d, action.seat, action.tile);
      break;
    case "declareWin":
      requireTurn(d.s, action.seat);
      if (!action.selfDraw) {
        throw new Error("a win on a discard is a claim, not a declaration — send { type: \"claim\" }");
      }
      doDeclareWin(d, action.seat);
      break;
    case "claim":
      if (d.s.phase !== "claimWindow" && d.s.phase !== "robKongWindow") {
        throw new Error(`claims are only legal in a claim window, not "${d.s.phase}"`);
      }
      doClaimOrPass(d, action.seat, { kind: "claim", option: action.option });
      break;
    case "pass":
      if (d.s.phase !== "claimWindow" && d.s.phase !== "robKongWindow") {
        throw new Error(`a pass is only legal in a claim window, not "${d.s.phase}"`);
      }
      doClaimOrPass(d, action.seat, { kind: "pass" });
      break;
  }
  return { state: d.s, events: d.events };
}

/* ── replay = re-execution (§5.5) ──────────────────────────────────────── */

/**
 * Re-execute a match from its event log and return the final state.
 *
 * The cursor into the log is the number of events re-execution has produced so
 * far, so the two stay in lockstep and any divergence surfaces immediately as a
 * wrong next event rather than as a silently different result.
 *
 * ONE reconstruction is lossy and deliberately so. `claimDeclined` records THAT
 * a seat lost a priority contest, not which option it had chosen — and it must
 * not, because the option is private to that seat. Replay therefore feeds every
 * non-winning prompted seat a `pass`. That is exact for the final state: a seat
 * whose claim was outranked and a seat that passed end the window in identical
 * condition, and the two paths emit the same number of events, so `seq` and the
 * logical clock land on the same values too.
 */
export function replayMatch(config: MatchConfig, events: readonly GameEvent[]): MatchState {
  let { state, events: produced } = startMatch(config);
  let i = produced.length;

  const advance = (a: Applied): void => {
    state = a.state;
    i += a.events.length;
  };

  while (i < events.length) {
    if (state.phase === "matchEnd") break;

    if (state.phase === "handEnd") {
      advance(startNextHand(state));
      continue;
    }

    if (state.phase === "claimWindow" || state.phase === "robKongWindow") {
      const answers = windowAnswers(events, i);
      const w = state.claim;
      if (!w) throw new Error("replay: window phase with no window");
      for (const offer of w.offers) {
        if (state.phase !== "claimWindow" && state.phase !== "robKongWindow") break;
        const chosen = answers.get(offer.seat);
        advance(
          chosen
            ? applyAction(state, { type: "claim", seat: offer.seat, option: chosen })
            : applyAction(state, { type: "pass", seat: offer.seat }),
        );
      }
      continue;
    }

    const e = events[i];
    switch (e.type) {
      case "discard":
        advance(applyAction(state, { type: "discard", seat: e.payload.seat, tile: e.payload.tile }));
        break;
      case "concealedKong":
        advance(
          applyAction(state, { type: "concealedKong", seat: e.payload.seat, tile: e.payload.tile }),
        );
        break;
      case "addedKong":
        advance(applyAction(state, { type: "addedKong", seat: e.payload.seat, tile: e.payload.tile }));
        break;
      case "selfDraw":
        advance(
          applyAction(state, { type: "declareWin", seat: e.payload.context.seat, selfDraw: true }),
        );
        break;
      case "refusedWin":
        advance(
          applyAction(state, { type: "declareWin", seat: e.payload.context.seat, selfDraw: true }),
        );
        break;
      default:
        throw new Error(`replay: unexpected event "${e.type}" at seq ${e.seq} in phase ${state.phase}`);
    }
  }
  return state;
}

/** Event types a window's resolution is made of. Nothing else can appear in it. */
const WINDOW_EVENTS = new Set<EventType>([
  "claimDeclined",
  "refusedWin",
  "claimed",
  "winOnDiscard",
]);

/**
 * The claims a window actually received, read off its resolution events.
 * Seats absent from the map passed (or were outranked — see `replayMatch`).
 */
function windowAnswers(
  events: readonly GameEvent[],
  start: number,
): Map<SeatIndex, ClaimOption> {
  const out = new Map<SeatIndex, ClaimOption>();
  for (let i = start; i < events.length; i++) {
    const e = events[i];
    if (!WINDOW_EVENTS.has(e.type)) break;
    switch (e.type) {
      case "refusedWin":
      case "winOnDiscard":
        out.set(e.payload.context.seat, { kind: "win" });
        break;
      case "claimed": {
        const p = e.payload;
        // A 碰 or 明槓 is fully described by its kind; only 上 needs the pair,
        // and `meld.tiles` minus one copy of the claimed tile IS that pair.
        if (p.kind === "chow") {
          const pair = p.meld.tiles.slice();
          pair.splice(pair.indexOf(p.tile), 1);
          out.set(p.seat, { kind: "chow", with: pair });
        } else {
          out.set(p.seat, { kind: p.kind });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

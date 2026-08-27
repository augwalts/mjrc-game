/**
 * Rule-derived hand analysis — the data layer behind the review screens.
 * Implements the "Now — exact, no theory" list in sketches/ANALYSIS.md §4 and
 * the P0 half of DESIGN.md §7. Terminology: ../../TERMINOLOGY.md.
 *
 * THE GOVERNING RULE: every annotation this file emits is a FACT read out of
 * the event log. Nothing here consults a route evaluator, a rollout, or a
 * heuristic, because a confident wrong annotation is worse than no annotation
 * at all — DESIGN.md §7 spends a paragraph on exactly that risk ("a strong
 * player screenshotting one wrong call at alpha hits the exact credibility leg
 * we're standing on").
 *
 * ── WHAT IS DELIBERATELY NOT HERE, AND WHY ──────────────────────────────────
 *
 *  · Move classification — Best / Inaccuracy / Mistake / Blunder. It is defined
 *    in sketches/ANALYSIS.md §3 as `EV(what you did) − EV(best available)`, and
 *    "best available" is the partial-hand route evaluator DESIGN.md §7 defers
 *    as "an unbudgeted 1-2 wk search problem that exists nowhere". No evaluator,
 *    no classification. There is no cheap approximation that is honest.
 *
 *  · Accuracy scores. Same blocker one level up: an accuracy percentage is an
 *    aggregate over classified moves, so it inherits every error in them and
 *    then hides it behind a single authoritative-looking number.
 *
 *  · Win probability, deal-in probability, expected chip delta. These need
 *    rollouts, and ANALYSIS.md §4 states the dependency plainly: rollout
 *    quality is policy quality, and today's bots are placeholders (DESIGN.md §6
 *    measures 69% dead draws and zero calls). The sketch renders the bracket
 *    legend and leaves the bar undrawn on purpose; this file does the same.
 *
 *  · "Safe discard". There is no such fact in HK Old Style. See the wording
 *    rule on `discardedVisibleTile` below — it is the one place this module
 *    could quietly become wrong, so the sentence is built here rather than left
 *    to a UI string that someone will later shorten to "safe".
 *
 *  · Opponents' concealed tiles. `handTimeline` reads one seat. The omniscient
 *    "every deal-in tile that was ever discarded" pass (ANALYSIS.md §5) is a
 *    separate, post-hoc, opt-in view and does not belong in a per-seat review.
 *
 * ── determinism (DESIGN.md §5.5) ────────────────────────────────────────────
 * No Math.random, no Date.now, no unordered key iteration that reaches a
 * result: `faanCeiling` sorts the faan-table ids before summing them even
 * though addition commutes, so the traversal order is pinned by the code and
 * not by an object literal's history.
 */
import type { GameEvent } from "@mjrc/protocol";
import {
  SCORING_KINDS,
  type Distance,
  type LiveTiles,
  type Meld,
  type Ruleset,
  type SeatIndex,
  type TileId,
  type WindIndex,
} from "./types.js";
import { TILE_NAMES, WIND_NAMES, counts, isDragon, isSuited, isWind } from "./tiles.js";
import { distanceToReady, liveTiles } from "./ready.js";

/* ── shared shapes ─────────────────────────────────────────────────────── */

/** Optional context. Absent means "do not infer" — never "guess a default". */
export interface AnalysisOptions {
  /**
   * The house ruleset. Supplied only when the caller genuinely knows it (the
   * match header pins `rulesetId`). Without it the faan-floor ground of
   * `meldedBelowFloor` is skipped entirely rather than assumed to be 3.
   */
  ruleset?: Ruleset;
}

const nameOf = (t: TileId): string => TILE_NAMES[t] ?? `tile ${t}`;

/** 下家 — the seat that plays after yours, and the only one that may 上 your discard. */
const rightOf = (seat: SeatIndex): SeatIndex => ((seat + 1) % 4) as SeatIndex;

/* ── the fold ──────────────────────────────────────────────────────────── */

/**
 * A read-only projection of the log. This is NOT the state machine — it holds
 * only what the review screens read, and it is deliberately LENIENT: removing a
 * tile that is not there is a no-op rather than a throw, so a log slice that
 * starts mid-hand still produces a partial answer instead of crashing a review.
 * Anything that must be strict about a malformed log belongs in the reducer.
 */
interface FoldSeat {
  /** Concealed tiles, ascending. The tile just drawn is merged in, not held apart. */
  hand: TileId[];
  melds: Meld[];
  /** 花 laid face up, in the order they were revealed. */
  flowers: TileId[];
  /** Face-up discards still in the pile — a claimed tile is moved out, into the meld. */
  discards: TileId[];
}

interface Fold {
  handIndex: number;
  seats: [FoldSeat, FoldSeat, FoldSeat, FoldSeat];
  seatWinds: [WindIndex, WindIndex, WindIndex, WindIndex];
  dealer: SeatIndex;
  roundWind: WindIndex;
  /** The last discard still awaiting a claim, or null once one landed. */
  lastDiscard: { tile: TileId; from: SeatIndex } | null;
}

const emptySeat = (): FoldSeat => ({ hand: [], melds: [], flowers: [], discards: [] });

function emptyFold(): Fold {
  return {
    handIndex: 0,
    seats: [emptySeat(), emptySeat(), emptySeat(), emptySeat()],
    seatWinds: [0, 1, 2, 3],
    dealer: 0,
    roundWind: 0,
    lastDiscard: null,
  };
}

const ascending = (a: TileId, b: TileId): number => a - b;

function addTile(s: FoldSeat, t: TileId): void {
  s.hand.push(t);
  s.hand.sort(ascending);
}

/** Lenient by design — see the note on `FoldSeat`. Returns whether it removed one. */
function removeTile(hand: TileId[], t: TileId): boolean {
  const i = hand.indexOf(t);
  if (i < 0) return false;
  hand.splice(i, 1);
  return true;
}

/**
 * Advance the projection by one event.
 *
 * The one subtle case is `claimed`: the claimed tile moves OUT of the
 * discarder's pile and INTO the meld. Leaving it in both places is the
 * double-count that produced the prototype's impossible "5 of 4 visible", so
 * the move happens here, once, where every reader of this fold inherits it.
 */
function apply(f: Fold, e: GameEvent): void {
  switch (e.type) {
    case "deal": {
      const p = e.payload;
      f.handIndex = e.handIndex;
      f.seats = [emptySeat(), emptySeat(), emptySeat(), emptySeat()];
      for (let i = 0; i < 4; i++) f.seats[i].hand = p.hands[i].slice().sort(ascending);
      f.seatWinds = [p.seatWinds[0], p.seatWinds[1], p.seatWinds[2], p.seatWinds[3]];
      f.dealer = p.dealer;
      f.roundWind = p.roundWind;
      f.lastDiscard = null;
      return;
    }
    case "flowerReplacement": {
      const p = e.payload;
      const s = f.seats[p.seat];
      // Dealt flowers sit in the hand and come out of it; a flower drawn during
      // play never enters the hand at all. Both shapes are legal in the log, so
      // the removal is conditional and the reveal is not.
      removeTile(s.hand, p.flower);
      s.flowers.push(p.flower);
      addTile(s, p.replacement);
      return;
    }
    case "draw":
    case "kongReplacement": {
      const p = e.payload;
      addTile(f.seats[p.seat], p.tile);
      return;
    }
    case "discard": {
      const p = e.payload;
      const s = f.seats[p.seat];
      removeTile(s.hand, p.tile);
      s.discards.push(p.tile);
      f.lastDiscard = { tile: p.tile, from: p.seat };
      return;
    }
    case "claimed": {
      const p = e.payload;
      const from = f.seats[p.from];
      // The claimed tile leaves the pile it was discarded onto. Counted once.
      const last = from.discards.length - 1;
      if (last >= 0 && from.discards[last] === p.tile) from.discards.pop();
      else removeTile(from.discards, p.tile);

      const s = f.seats[p.seat];
      let claimedTaken = false;
      for (const t of p.meld.tiles) {
        if (!claimedTaken && t === p.tile) {
          claimedTaken = true; // this copy came off the table, not out of hand
          continue;
        }
        removeTile(s.hand, t);
      }
      s.melds.push(p.meld);
      f.lastDiscard = null;
      return;
    }
    case "concealedKong": {
      const p = e.payload;
      const s = f.seats[p.seat];
      for (let k = 0; k < 4; k++) removeTile(s.hand, p.tile);
      s.melds.push(p.meld);
      return;
    }
    case "addedKong": {
      const p = e.payload;
      const s = f.seats[p.seat];
      removeTile(s.hand, p.tile);
      // 加槓 REPLACES the pung it grew from; pushing it would show seven copies.
      const i = s.melds.findIndex((m) => m.kind === "pung" && m.tiles[0] === p.tile);
      if (i >= 0) s.melds[i] = p.meld;
      else s.melds.push(p.meld);
      return;
    }
    case "claimOffered":
    case "claimDeclined":
    case "robKongWindow":
    case "refusedWin":
    case "winOnDiscard":
    case "selfDraw":
    case "exhaustiveDraw":
    case "handEnd":
    case "matchEnd":
      // None of these move a tile. A refused win is explicitly not a rollback
      // (§5.2) and the hand plays on; the winning tile of a real win stays in
      // the pile it was discarded onto, which is where it is face up.
      return;
  }
}

/* ── visibility ────────────────────────────────────────────────────────── */

/**
 * Copies of each tile visible to everyone: every discard still in a pile, plus
 * every tile in a declared meld. Indexed by tile id over the 34 scoring kinds —
 * the same shape `liveTiles(…, visible)` takes. Flowers are not in this space:
 * they are singletons, they never form a wait, and counting them here would put
 * a 1-copy tile in a 4-copy array.
 *
 * @param upTo how many events to fold, exclusive. A LOG INDEX, not a `seq` —
 *             `seq` is match-global and a sliced log does not start at zero.
 *
 * Two invariants this function exists to hold:
 *
 *  1. NO COUNT EVER EXCEEDS 4. A claimed discard becomes part of a meld and is
 *     counted ONCE. The prototype counted it in both places and printed the
 *     impossible "5 of 4 visible"; `apply` moves the tile rather than copying
 *     it, and analysis.test.ts asserts the bound across simulated hands.
 *  2. It resets on every `deal`. Visibility is a per-hand fact.
 *
 * CAVEAT — 暗槓. A concealed kong's four tiles are counted, because the review
 * screens read the omniscient archive of a finished hand, where it has been
 * turned face up to be scored. A LIVE per-seat view must not use this function
 * for another seat's 暗槓: while the hand is running those tiles are face down
 * and events.ts nulls them out of the redacted stream.
 */
export function visibilityCounts(log: readonly GameEvent[], upTo?: number): number[] {
  const end = Math.max(0, Math.min(upTo ?? log.length, log.length));
  const f = emptyFold();
  for (let i = 0; i < end; i++) apply(f, log[i]);
  return countVisible(f);
}

function countVisible(f: Fold): number[] {
  const c = new Array<number>(SCORING_KINDS).fill(0);
  for (const s of f.seats) {
    for (const t of s.discards) if (t < SCORING_KINDS) c[t]++;
    for (const m of s.melds) for (const t of m.tiles) if (t < SCORING_KINDS) c[t]++;
  }
  return c;
}

/* ── the faan ceiling (DESIGN.md §7's faan-floor warning) ──────────────── */

/** A winning hand is four sets plus the pair. The melds fix some of the four. */
const SET_SLOTS = 4;

/**
 * Pattern ids foreclosed by a given meld shape. Every entry is DEFINITIONAL —
 * the pattern's own name forbids the shape, so no reading of any house's faan
 * table can make it reachable again. That matters because this table lives
 * outside the scorer: an id it does not know is never excluded, so the only
 * drift a future pattern can cause is a ceiling that is too HIGH, which
 * under-reports. It can never invent a floor breach that is not there.
 */
const FORECLOSED_BY = {
  /** Triggered by any meld that is not a 暗槓: it took a tile off the table. */
  exposed: [
    "concealedHand",
    "fourConcealedPungs",
    "thirteenOrphans",
    "nineGates",
    "sevenPairs",
    "heavenlyHand",
    "earthlyHand",
  ],
  /**
   * Triggered by a declared 上. Each of these is every-set-a-triplet by
   * definition — including 混么九, which patterns.ts records as implying 對對糊
   * ("Does NOT subsume allPungs even though it implies it").
   */
  chow: [
    "allPungs",
    "allKongs",
    "allHonours",
    "allTerminals",
    "mixedTerminals",
    "fourConcealedPungs",
    "thirteenOrphans",
    "nineGates",
    "sevenPairs",
  ],
  /** Triggered by a declared 碰 or 槓: 平糊 is every set a run. */
  triplet: ["allChows"],
  /** Triggered by melds spanning two suits: each of these is one suit only. */
  twoSuits: ["fullFlush", "halfFlush", "nineGates"],
  /** Triggered by an honour tile: 清一色 and 九蓮寶燈 hold none. */
  honour: ["fullFlush", "nineGates"],
  /** Triggered by a suited tile: 字一色 holds nothing but honours. */
  suited: ["allHonours"],
  /** Triggered by a suited 2-8: these are built entirely from 么九 tiles. */
  simple: ["allTerminals", "mixedTerminals", "thirteenOrphans"],
} as const;

export interface FaanCeiling {
  /**
   * A SOUND upper bound on what a hand holding these melds can still score.
   * Not an estimate and not a prediction: the real total is always ≤ this.
   */
  ceiling: number;
  /** Pattern ids the melds have definitively foreclosed, ascending. */
  foreclosed: string[];
}

/**
 * The largest faan a hand carrying these melds could still reach, bounding
 * every enabled pattern from above and summing them.
 *
 * Summing patterns that cannot co-occur (平糊 and 對對糊 both survive a bare
 * 上) keeps the bound SOUND at the cost of keeping it LOOSE. That is the right
 * trade for the only question asked of it — "is the floor now unreachable?" —
 * because a loose bound can only ever answer "not certain", never "certain"
 * when it should not.
 *
 * BE HONEST ABOUT WHAT THIS MEANS IN PRACTICE: under HKOS_STANDARD it almost
 * never fires. HK Old Style pays 花, 自摸, 海底撈月 and the wind pungs on top
 * of everything, so three faan stays nominally reachable from nearly any set of
 * melds. That is not a gap in this function — it is the faan table saying the
 * hand is not yet provably dead, which is the truth. It bites on leaner house
 * tables, and it bites when the set slots run out.
 */
export function faanCeiling(
  melds: readonly Meld[],
  flowers: readonly TileId[],
  ruleset: Ruleset,
): FaanCeiling {
  const out = new Set<string>();
  const forecloseAll = (ids: readonly string[]) => { for (const id of ids) out.add(id); };

  let dragonPungs = 0;
  let windPungs = 0;
  const suits = new Set<number>();

  for (const m of melds) {
    if (!(m.kind === "kong" && m.concealed)) forecloseAll(FORECLOSED_BY.exposed);
    if (m.kind === "chow") forecloseAll(FORECLOSED_BY.chow);
    else forecloseAll(FORECLOSED_BY.triplet);
    for (const t of m.tiles) {
      if (isSuited(t)) {
        suits.add(Math.floor(t / 9));
        forecloseAll(FORECLOSED_BY.suited);
        if (t % 9 !== 0 && t % 9 !== 8) forecloseAll(FORECLOSED_BY.simple);
      } else {
        forecloseAll(FORECLOSED_BY.honour);
      }
    }
    if (m.kind !== "chow") {
      if (isDragon(m.tiles[0])) dragonPungs++;
      else if (isWind(m.tiles[0])) windPungs++;
    }
  }
  if (suits.size > 1) forecloseAll(FORECLOSED_BY.twoSuits);

  // Slot arithmetic. A pattern naming N triplets of one honour family cannot be
  // reached once the sets that could hold them are spent — pure counting.
  const slotsLeft = Math.max(0, SET_SLOTS - melds.length);
  const reachableDragonPungs = Math.min(3, dragonPungs + slotsLeft);
  const reachableWindPungs = Math.min(4, windPungs + slotsLeft);
  if (reachableDragonPungs < 3) out.add("bigThreeDragons");
  if (reachableDragonPungs < 2) out.add("smallThreeDragons");
  if (reachableWindPungs < 4) out.add("bigFourWinds");
  if (reachableWindPungs < 3) out.add("smallFourWinds");
  if (reachableWindPungs < 1) { out.add("seatWind"); out.add("roundWind"); }
  if (reachableDragonPungs < 1) out.add("dragonPung");

  // 無花 is a fact already settled by the log: a revealed flower kills it.
  if (flowers.length > 0) out.add("noFlowers");

  let total = 0;
  // Sorted, so the traversal is pinned by the ids and not by the faan table's
  // insertion order (DESIGN.md §5.5 — nothing that reaches a result may depend
  // on unordered iteration).
  for (const id of Object.keys(ruleset.faanTable).sort()) {
    if (out.has(id)) continue;
    const faan = ruleset.faanTable[id] ?? 0;
    // 三元牌 is awarded once per dragon, so the bound has to repeat it.
    total += id === "dragonPung" ? faan * reachableDragonPungs : faan;
  }
  return {
    ceiling: Math.min(total, ruleset.limitFaan),
    foreclosed: [...out].sort(),
  };
}

/* ── key moments ───────────────────────────────────────────────────────── */

export type MomentKind =
  | "dealtIntoWin"
  | "meldedBelowFloor"
  | "passedWinningClaim"
  | "discardedVisibleTile";

export interface MomentBase {
  kind: MomentKind;
  seat: SeatIndex;
  /** Index in the log this moment is anchored to. */
  index: number;
  seq: number;
  handIndex: number;
  /**
   * The sentence to show. Built here, not in the UI, because the wording on
   * `discardedVisibleTile` is load-bearing and a UI string gets shortened.
   */
  text: string;
}

/** 出銃 — this seat's discard was taken for a win. */
export interface DealtIntoWinMoment extends MomentBase {
  kind: "dealtIntoWin";
  tile: TileId;
  winner: SeatIndex;
  /** The faan the winning hand scored, straight out of the logged ScoreResult. */
  faan: number;
  /** 爆棚 — the total was capped at the limit. */
  capped: boolean;
}

export interface MeldedBelowFloorMoment extends MomentBase {
  kind: "meldedBelowFloor";
  /**
   * "refusedWin" — the engine itself refused the hand; a pure log fact.
   * "noPathToMinimum" — the melds' faan ceiling fell under the floor.
   */
  ground: "refusedWin" | "noPathToMinimum";
  minimumFaan: number;
  /** The refused total, or the ceiling that fell short. */
  faan: number;
  melds: Meld[];
}

/** A 食糊 (or 搶槓) this seat was offered and did not take. */
export interface PassedWinningClaimMoment extends MomentBase {
  kind: "passedWinningClaim";
  tile: TileId;
  from: SeatIndex;
  /** Only a real decline. "outranked" is the server's answer, not the seat's. */
  reason: "pass" | "timeout";
  /** 搶槓 — the offer was to rob an 加槓, not to take a discard. */
  robbingKong: boolean;
}

export interface DiscardedVisibleTileMoment extends MomentBase {
  kind: "discardedVisibleTile";
  tile: TileId;
  /** Copies face up BEFORE the cut. 2 or 3 — a fourth could not still be held. */
  visible: number;
  /**
   * True whenever the tile is suited. TWO OR MORE COPIES FACE UP RULES OUT 碰
   * AND 槓 AND NOTHING ELSE: HK plays 上, and it comes from the left, so this
   * seat's 下家 can still take the tile. Never render this as "safe".
   */
  chowStillPossible: boolean;
}

export type Moment =
  | DealtIntoWinMoment
  | MeldedBelowFloorMoment
  | PassedWinningClaimMoment
  | DiscardedVisibleTileMoment;

/** Copies face up at which a 碰 or 槓 becomes impossible: two are needed in hand. */
const CLAIM_BLOCKING_COPIES = 2;

/**
 * Rule-derived annotations for one seat, in log order.
 *
 * Four kinds, and only four, because these are the four things the log states
 * outright (sketches/ANALYSIS.md §4). Everything a review WANTS to say beyond
 * them is in the "not here" list at the top of this file.
 *
 * @param opts.ruleset supply it and the `noPathToMinimum` ground is available;
 *                     omit it and only log facts are reported.
 */
export function keyMoments(
  log: readonly GameEvent[],
  seat: SeatIndex,
  opts: AnalysisOptions = {},
): Moment[] {
  const out: Moment[] = [];
  const f = emptyFold();
  const wind = (s: SeatIndex): string => WIND_NAMES[f.seatWinds[s]] ?? `seat ${s}`;

  /** A win offer standing open for this seat, cleared the moment it resolves. */
  let winOffer: { tile: TileId; from: SeatIndex; robbingKong: boolean } | null = null;
  let floorReported = false;

  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    const at = { seat, index: i, seq: e.seq, handIndex: e.handIndex };

    if (e.type === "deal") {
      winOffer = null;
      floorReported = false;
    }
    // An offer is spent the moment the table moves on. Without this a standing
    // offer could be matched against an unrelated later decline of the same
    // tile, which would report a pass that never happened.
    if (
      e.type === "discard" || e.type === "claimed" ||
      e.type === "winOnDiscard" || e.type === "selfDraw" || e.type === "handEnd"
    ) {
      winOffer = null;
    }

    // ── discarded a tile with N of 4 already visible ──────────────────────
    // Read BEFORE the fold advances, so the cut tile is not counted as face up
    // against itself.
    if (e.type === "discard" && e.payload.seat === seat) {
      const tile = e.payload.tile;
      const visible = countVisible(f)[tile] ?? 0;
      if (visible >= CLAIM_BLOCKING_COPIES) {
        const chowStillPossible = isSuited(tile);
        // 上 is claimed from 上家, so the ONE seat that can still take this
        // tile is 下家 — the seat that plays next, whose 上家 is this one.
        const tail = chowStillPossible
          ? `碰 and 槓 are impossible, but 上 is not: your 下家 ${wind(rightOf(seat))} ` +
            "plays next and can still take it."
          : "碰 and 槓 are impossible, and honours never form runs, so it cannot be claimed at all.";
        out.push({
          ...at,
          kind: "discardedVisibleTile",
          tile,
          visible,
          chowStillPossible,
          text: `Cut ${nameOf(tile)} with ${visible} of 4 already face up — ${tail}`,
        });
      }
    }

    // ── passed a legal winning claim ──────────────────────────────────────
    if (e.type === "claimOffered" && e.payload.seat === seat) {
      if (e.payload.options.some((o) => o.kind === "win")) {
        winOffer = { tile: e.payload.tile, from: e.payload.from, robbingKong: false };
      }
    }
    if (e.type === "robKongWindow" && e.payload.offeredTo.includes(seat)) {
      // 搶槓 offers are win-only by construction (events.ts), so the offer
      // itself is the evidence — there is no options list to inspect.
      winOffer = { tile: e.payload.tile, from: e.payload.seat, robbingKong: true };
    }
    if (e.type === "claimDeclined" && e.payload.seat === seat) {
      const p = e.payload;
      if (winOffer && winOffer.tile === p.tile && (p.reason === "pass" || p.reason === "timeout")) {
        const what = winOffer.robbingKong ? "搶槓" : "食糊";
        out.push({
          ...at,
          kind: "passedWinningClaim",
          tile: p.tile,
          from: winOffer.from,
          reason: p.reason,
          robbingKong: winOffer.robbingKong,
          text:
            `Passed a legal ${what} on ${nameOf(p.tile)} from ${wind(winOffer.from)}` +
            (p.reason === "timeout" ? " — the window ran out." : "."),
        });
      }
      // "outranked" is a lost priority contest, not a decision. Nothing is said
      // about it here, and the offer is spent either way.
      winOffer = null;
    }

    // ── melded below the floor: the engine's own refusal ──────────────────
    if (e.type === "refusedWin" && e.payload.context.seat === seat) {
      const p = e.payload;
      out.push({
        ...at,
        kind: "meldedBelowFloor",
        ground: "refusedWin",
        minimumFaan: p.minimumFaan,
        faan: p.score.faan,
        melds: p.melds.slice(),
        text:
          `A winning shape on ${nameOf(p.context.winningTile)} worth ${p.score.faan} faan — ` +
          `under the ${p.minimumFaan}-faan minimum, so it could not be taken.`,
      });
      floorReported = true;
    }

    // ── dealt into a win ──────────────────────────────────────────────────
    // Anchored on the winning event but attributed to the discard that fed it:
    // a robbed 加槓 also carries `from`, and that is not a discard, so the
    // standing `lastDiscard` has to match before this fires.
    if (e.type === "winOnDiscard" && e.payload.context.from === seat) {
      const p = e.payload;
      const fed =
        p.context.robbedKong !== true &&
        f.lastDiscard !== null &&
        f.lastDiscard.from === seat &&
        f.lastDiscard.tile === p.context.winningTile;
      if (fed) {
        out.push({
          ...at,
          kind: "dealtIntoWin",
          tile: p.context.winningTile,
          winner: p.context.seat,
          faan: p.score.faan,
          capped: p.score.capped,
          text:
            `Dealt in — ${nameOf(p.context.winningTile)} was taken for 食糊 by ` +
            `${wind(p.context.seat)} at ${p.score.faan} faan` +
            (p.score.capped ? " (爆棚, capped at the limit)." : "."),
        });
      }
    }

    const declaredBySeat =
      (e.type === "claimed" || e.type === "concealedKong" || e.type === "addedKong") &&
      e.payload.seat === seat;

    apply(f, e);

    // ── melded below the floor: the ceiling fell under the minimum ────────
    // Checked after the fold so the meld that caused it is included, and
    // anchored on that meld's own event.
    const r = opts.ruleset;
    if (declaredBySeat && !floorReported && r) {
      const s = f.seats[seat];
      const c = faanCeiling(s.melds, s.flowers, r);
      if (c.ceiling < r.minimumFaan) {
        out.push({
          ...at,
          kind: "meldedBelowFloor",
          ground: "noPathToMinimum",
          minimumFaan: r.minimumFaan,
          faan: c.ceiling,
          melds: s.melds.slice(),
          text:
            `These melds leave no path to ${r.minimumFaan} faan — the most this hand can ` +
            `now score is ${c.ceiling}.`,
        });
        floorReported = true;
      }
    }
  }
  return out;
}

/* ── hand timeline ─────────────────────────────────────────────────────── */

/** Where the tile that opened this turn came from. */
export type IncomingKind =
  | "deal"
  | "draw"
  | "flowerReplacement"
  | "kongReplacement"
  | "chow"
  | "pung"
  | "kong";

export interface TurnIncoming {
  kind: IncomingKind;
  /** Null only for the dealer's opening cut, which nothing preceded. */
  tile: TileId | null;
  /** The seat the tile was claimed from; null when it came off the wall. */
  from: SeatIndex | null;
}

/**
 * What kind of turn this was.
 *
 * 摸切 `drawAndCut` IS ITS OWN STATE, not a flag on "draw". Drawing a tile and
 * cutting it straight back says the draw did nothing for the hand, and that is
 * different information from drawing one tile and cutting another
 * (sketches/ANALYSIS.md §4b). Collapsing the two loses the signal.
 */
export type TurnState =
  | "drawAndCut"
  | "drawThenCutFromHand"
  | "claimThenCutFromHand"
  | "dealtThenCutFromHand";

export interface Turn {
  /** Index in the log of the discard that closes this turn. */
  index: number;
  seq: number;
  handIndex: number;
  seat: SeatIndex;
  /** 1-based, per hand. Resets on every deal. */
  turn: number;
  /** Concealed tiles held immediately before the cut, incoming included. Ascending. */
  hand: TileId[];
  melds: Meld[];
  flowers: TileId[];
  incoming: TurnIncoming;
  discarded: TileId;
  state: TurnState;
  /** 上聽 as the hand was held. -1 means a winning shape was in hand. */
  distanceBefore: Distance;
  /** 上聽 after the cut. */
  distanceAfter: Distance;
  /** 有效牌 after the cut, against everything accountable at that moment. */
  live: LiveTiles;
  /**
   * Copies of every tile this seat could account for after the cut: the public
   * pile and melds, plus its own concealed hand. This is what `live` was
   * computed against, exposed so a caller can show the arithmetic.
   */
  visible: number[];
}

/**
 * One row per decision, for one seat: what the hand was, what came in, what
 * went out, and what that did to 上聽 and 有效牌.
 *
 * A turn is a CUT. Draws that ended in a win, a 暗槓 declaration, or the wall
 * running out do not produce rows, because the timeline is a record of choices
 * and those are not cuts. The distances and live counts are exact for what was
 * visible at that moment — no theory is involved in any of them.
 */
export function handTimeline(log: readonly GameEvent[], seat: SeatIndex): Turn[] {
  const out: Turn[] = [];
  const f = emptyFold();
  let incoming: TurnIncoming = { kind: "deal", tile: null, from: null };
  let turn = 0;
  /**
   * False until the hand's first cut. Every 花 revealed before it belongs to
   * the deal, not to a turn — DEAL → FLOWER_REPLACEMENT runs to completion
   * before AWAIT_DISCARD(dealer) (DESIGN.md §5.2). Counting a dealt
   * replacement as "what came in" would call the dealer's opening cut 摸切,
   * which it is not: nothing was drawn.
   */
  let inPlay = false;

  for (let i = 0; i < log.length; i++) {
    const e = log[i];

    if (e.type === "deal") {
      incoming = { kind: "deal", tile: null, from: null };
      turn = 0;
      inPlay = false;
    } else if (e.type === "draw" && e.payload.seat === seat) {
      incoming = { kind: "draw", tile: e.payload.tile, from: null };
    } else if (e.type === "kongReplacement" && e.payload.seat === seat) {
      incoming = { kind: "kongReplacement", tile: e.payload.tile, from: null };
    } else if (inPlay && e.type === "flowerReplacement" && e.payload.seat === seat) {
      incoming = { kind: "flowerReplacement", tile: e.payload.replacement, from: null };
    } else if (e.type === "claimed" && e.payload.seat === seat) {
      incoming = { kind: e.payload.kind, tile: e.payload.tile, from: e.payload.from };
    }

    if (e.type === "discard") inPlay = true;

    if (e.type === "discard" && e.payload.seat === seat) {
      const s = f.seats[seat];
      const before = s.hand.slice();
      const melds = s.melds.slice();
      const setCount = melds.length;
      const discarded = e.payload.tile;

      // Fold the cut in, then read the state after it. Folding FORWARD once
      // rather than refolding the prefix per turn is the O(n²) the appendix to
      // sketches/ANALYSIS.md asks to be fixed before this is real.
      apply(f, e);
      const after = s.hand.slice();

      // Everything face up after the cut, plus this seat's own concealed tiles.
      // The cut tile is now in the pile and out of the hand, so it is counted
      // exactly once either way.
      const visible = countVisible(f);
      for (const t of after) if (t < SCORING_KINDS) visible[t]++;

      const fromWall = incoming.kind === "draw" || incoming.kind === "kongReplacement" ||
        incoming.kind === "flowerReplacement";
      const state: TurnState =
        incoming.kind === "deal"
          ? "dealtThenCutFromHand"
          : fromWall
            ? incoming.tile === discarded
              ? "drawAndCut"
              : "drawThenCutFromHand"
            : "claimThenCutFromHand";

      out.push({
        index: i,
        seq: e.seq,
        handIndex: e.handIndex,
        seat,
        turn: ++turn,
        hand: before,
        melds,
        flowers: s.flowers.slice(),
        incoming,
        discarded,
        state,
        distanceBefore: distanceToReady(counts(before), setCount),
        distanceAfter: distanceToReady(counts(after), setCount),
        live: liveTiles(counts(after), setCount, visible),
        visible,
      });
      incoming = { kind: "deal", tile: null, from: null };
      continue;
    }

    apply(f, e);
  }
  return out;
}

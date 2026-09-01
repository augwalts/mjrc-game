/**
 * Distance to a winning shape, and the tiles that close it.
 *
 * 上聽 soeng ting — "away from ready". -1 complete, 0 ready (聽牌), 1+ away.
 * See ../../TERMINOLOGY.md: this file deliberately avoids the Japanese term.
 *
 * The decomposition is UNPRUNED. The Python reference's branch-and-bound prune
 * treats a subtree's worst case as an optimistic bound and prunes winners —
 * measured wrong on ~6.1% of 13-tile and ~10.1% of 14-tile hands
 * (ENGINE-AUDIT §3). Do not reintroduce it. Measured cost here is ~7µs/call,
 * against the pruned Python's 9.1µs, so there is nothing to buy.
 *
 * Seven pairs is an OPT-IN branch: off unless the caller says the house plays
 * it, so a table that does not price 七對子 measures exactly as it always did.
 */
import { SCORING_KINDS, type Distance, type LiveTiles, type TileId } from "./types.js";
import { isSuited, rankOf } from "./tiles.js";

/**
 * Minimum distance over every decomposition, computed AT THE LEAVES.
 *
 * The classic formulation maximizes the proxy 2·sets+parts and feeds one argmax
 * into the formula — but the 4-slot cap breaks the proxy's monotonicity: 3 sets
 * + 2 partials and 2 sets + 4 partials tie at 8, yet after capping they are
 * distance 1 and 2. Keeping a single proxy-argmax silently returns the wrong
 * one on ~1 in 800 real mid-hand positions (caught by the port-diff exhaustive
 * reference, 2026-08-26). So the real quantity is computed per decomposition
 * and minimized — same recursion, no proxy.
 */
function minDist(c: number[], i: number, sets: number, parts: number, melds: number, pair: boolean): Distance {
  while (i < SCORING_KINDS && c[i] === 0) i++;
  if (i >= SCORING_KINDS) {
    const total = sets + melds;
    const capped = total + parts > 4 ? Math.max(0, 4 - total) : parts;
    return 8 - 2 * total - capped - (pair ? 1 : 0);
  }
  let best: Distance = 99;
  if (c[i]! >= 3) { c[i]! -= 3; best = Math.min(best, minDist(c, i, sets + 1, parts, melds, pair)); c[i]! += 3; }
  if (isSuited(i) && rankOf(i) <= 6 && c[i + 1]! > 0 && c[i + 2]! > 0) {
    c[i]!--; c[i + 1]!--; c[i + 2]!--;
    best = Math.min(best, minDist(c, i, sets + 1, parts, melds, pair));
    c[i]!++; c[i + 1]!++; c[i + 2]!++;
  }
  if (c[i]! >= 2) { c[i]! -= 2; best = Math.min(best, minDist(c, i, sets, parts + 1, melds, pair)); c[i]! += 2; }
  if (isSuited(i) && rankOf(i) <= 7 && c[i + 1]! > 0) {
    c[i]!--; c[i + 1]!--; best = Math.min(best, minDist(c, i, sets, parts + 1, melds, pair)); c[i]!++; c[i + 1]!++;
  }
  if (isSuited(i) && rankOf(i) <= 6 && c[i + 2]! > 0) {
    c[i]!--; c[i + 2]!--; best = Math.min(best, minDist(c, i, sets, parts + 1, melds, pair)); c[i]!++; c[i + 2]!++;
  }
  c[i]!--; best = Math.min(best, minDist(c, i, sets, parts, melds, pair)); c[i]!++;   // leave it isolated
  return best;
}

const score = (c: number[], melds: number, hasPair: boolean): Distance =>
  minDist(c, 0, 0, 0, melds, hasPair);

/** The formula proper. Calibrated for a 3n+1 shape (13 concealed-equivalent). */
function rawDistance(c: readonly number[], melds: number): Distance {
  const w = c.slice();
  let best = score(w, melds, false);
  for (let i = 0; i < SCORING_KINDS; i++) {
    if (w[i]! >= 2) {
      w[i]! -= 2;
      best = Math.min(best, score(w, melds, true));
      w[i]! += 2;
    }
  }
  return best;
}

/**
 * @param c      counts over the 34 scoring kinds, concealed tiles only
 * @param melds  number of exposed or concealed melds already set aside
 *
 * Handles BOTH shapes:
 *   3n+1 (13 tiles) — a waiting hand; the formula applies directly.
 *   3n+2 (14 tiles) — a hand that has just drawn. The formula's constant
 *     assumes 13, so applying it to 14 tiles OVER-REPORTS the distance on some
 *     hands: the extra tile has to be discarded before the shape is meaningful.
 *     Correct answer is the best result over every possible discard.
 *
 * This was a real bug, caught by an independent exhaustive reference disagreeing
 * on 12 of 800 sampled hands (always 14-tile shapes, always by exactly 1). The
 * original tests only covered 13-tile hands and *complete* 14-tile hands, so
 * the whole 3n+2 non-winning case went unexercised.
 */
export function referenceDistanceToReady(c: readonly number[], melds = 0): Distance {
  let total = melds * 3;
  for (let i = 0; i < SCORING_KINDS; i++) total += c[i]!;

  if (total % 3 !== 2) return rawDistance(c, melds);

  // A completed hand is -1 and must be reported before any discard is considered.
  const raw = rawDistance(c, melds);
  if (raw < 0) return -1;

  const w = c.slice();
  let best = raw;
  for (let i = 0; i < SCORING_KINDS; i++) {
    if (w[i]! > 0) {
      w[i]!--;
      best = Math.min(best, rawDistance(w, melds));
      w[i]!++;
    }
  }
  return best;
}


/* ── fast path: per-suit decomposition tables + a tiny cross-group DP ──────
 *
 * The exhaustive recursion above re-derives, for every call, facts that only
 * depend on one suit's nine counts: which (sets, partials, eyes) combos that
 * suit can yield. Those facts are computed once per distinct suit vector and
 * memoized (key = counts packed base-5, ≤ 5^9 keys, thousands in practice).
 * A 4-group × 50-state boolean DP then combines suits + honours, and the
 * distance formula is evaluated over reachable states — the exact same
 * quantity the reference minimizes, decomposed instead of re-searched.
 *
 * Equivalence is enforced, not assumed: referenceDistanceToReady stays in
 * this file as the oracle for the fuzz differential in the test suite.
 */

/** (s ≤ 4, p ≤ 4, e ≤ 1) packed as s*10 + p*2 + e — 50 possible flags. */
type ComboFlags = Uint8Array;

const suitMemo = new Map<number, ComboFlags>();
const honourMemo = new Map<number, ComboFlags>();

function segmentCombos(v: number[], suited: boolean, memo: Map<number, ComboFlags>): ComboFlags {
  let key = 0;
  for (let i = 0; i < v.length; i++) key = key * 5 + v[i]!;
  const hit = memo.get(key);
  if (hit) return hit;
  const flags: ComboFlags = new Uint8Array(50);
  const n = v.length;
  const rec = (i: number, s: number, p: number, e: number): void => {
    while (i < n && v[i] === 0) i++;
    if (i >= n) { flags[s * 10 + p * 2 + e] = 1; return; }
    if (s < 4 && v[i]! >= 3) { v[i]! -= 3; rec(i, s + 1, p, e); v[i]! += 3; }
    if (s < 4 && suited && i <= 6 && v[i + 1]! > 0 && v[i + 2]! > 0) {
      v[i]!--; v[i + 1]!--; v[i + 2]!--; rec(i, s + 1, p, e); v[i]!++; v[i + 1]!++; v[i + 2]!++;
    }
    if (v[i]! >= 2) {
      if (p < 4) { v[i]! -= 2; rec(i, s, p + 1, e); v[i]! += 2; }
      if (e === 0) { v[i]! -= 2; rec(i, s, p, 1); v[i]! += 2; }   // the eyes
    }
    if (p < 4 && suited && i <= 7 && v[i + 1]! > 0) { v[i]!--; v[i + 1]!--; rec(i, s, p + 1, e); v[i]!++; v[i + 1]!++; }
    if (p < 4 && suited && i <= 6 && v[i + 2]! > 0) { v[i]!--; v[i + 2]!--; rec(i, s, p + 1, e); v[i]!++; v[i + 2]!++; }
    v[i]!--; rec(i, s, p, e); v[i]!++;                             // leave it isolated
  };
  rec(0, 0, 0, 0);
  // Pareto prune: the distance formula is monotone in s, p and e, so a combo
  // dominated on all three can never produce the minimum. Pruning on e is safe
  // despite the one-eyes-per-hand constraint: taking eyes spends two tiles
  // that could equally be dropped, so every (s,p,1) combo has an (s,p,0) twin
  // in the same group — any cross-group solution blocked by an e-dominance
  // prune has an equivalent mirror that swaps which group supplies the eyes.
  const pruned = new Uint8Array(50);
  for (let a = 0; a < 50; a++) {
    if (!flags[a]) continue;
    const s0 = (a / 10) | 0, r0 = a % 10, p0 = (r0 / 2) | 0, e0 = r0 % 2;
    let dominated = false;
    for (let b = 0; b < 50 && !dominated; b++) {
      if (!flags[b] || b === a) continue;
      const s1 = (b / 10) | 0, r1 = b % 10, p1 = (r1 / 2) | 0, e1 = r1 % 2;
      if (s1 >= s0 && p1 >= p0 && e1 >= e0 && (s1 > s0 || p1 > p0 || e1 > e0)) dominated = true;
    }
    if (!dominated) pruned[a] = 1;
  }
  memo.set(key, pruned);
  return pruned;
}

const seg = new Array<number>(9);
function groupCombos(c: readonly number[], g: number): ComboFlags {
  if (g < 3) {
    for (let r = 0; r < 9; r++) seg[r] = c[g * 9 + r]!;
    return segmentCombos(seg, true, suitMemo);
  }
  const h = new Array<number>(7);
  for (let r = 0; r < 7; r++) h[r] = c[27 + r]!;
  return segmentCombos(h, false, honourMemo);
}

/** Exact same minimum as the reference, via reachable-state combination. */
function fastRawDistance(c: readonly number[], melds: number): Distance {
  let reach = new Uint8Array(50);
  reach[0] = 1;
  for (let g = 0; g < 4; g++) {
    const combos = groupCombos(c, g);
    const next = new Uint8Array(50);
    for (let st = 0; st < 50; st++) {
      if (!reach[st]) continue;
      const s0 = (st / 10) | 0, rem = st % 10, p0 = (rem / 2) | 0, e0 = rem % 2;
      for (let cb = 0; cb < 50; cb++) {
        if (!combos[cb]) continue;
        const s1 = (cb / 10) | 0, rem1 = cb % 10, p1 = (rem1 / 2) | 0, e1 = rem1 % 2;
        if (e0 + e1 > 1) continue;
        const s = Math.min(4, s0 + s1), pp = Math.min(4, p0 + p1);
        next[s * 10 + pp * 2 + (e0 + e1)] = 1;
      }
    }
    reach = next;
  }
  let best: Distance = 99;
  for (let st = 0; st < 50; st++) {
    if (!reach[st]) continue;
    const s = (st / 10) | 0, rem = st % 10, p = (rem / 2) | 0, e = rem % 2;
    const total = s + melds;
    const capped = total + p > 4 ? Math.max(0, 4 - total) : p;
    const d = 8 - 2 * total - capped - e;
    if (d < best) best = d;
  }
  return best;
}

/**
 * 七對子 distance, on the same scale: -1 complete, 0 ready, >0 tiles away.
 *
 *   6 - pairs + max(0, 7 - kinds)
 *
 * The second term is what stops four-of-a-kind counting as two pairs: a quad
 * raises `pairs` once but not `kinds`, so the hand is short a distinct type and
 * the shortfall is charged back. Seven pairs must be seven DIFFERENT pairs
 * (decompose.ts `isSevenPairsShape` enforces the same rule at the win).
 *
 * Seven pairs is concealed by definition, so a melded hand never reaches here.
 */
function sevenPairsDistance(c: readonly number[]): Distance {
  let pairs = 0, kinds = 0;
  for (let i = 0; i < SCORING_KINDS; i++) {
    const n = c[i]!;
    if (n === 0) continue;
    kinds++;
    if (n >= 2) pairs++;
  }
  return (6 - pairs + Math.max(0, 7 - kinds)) as Distance;
}

/**
 * @param sevenPairs does this house play 七對子? Off by default, so every
 *        existing caller and every ruleset that does not price it are unchanged.
 */
export function distanceToReady(c: readonly number[], melds = 0, sevenPairs = false): Distance {
  let total = melds * 3;
  for (let i = 0; i < SCORING_KINDS; i++) total += c[i]!;

  const seven = sevenPairs && melds === 0 ? sevenPairsDistance(c) : (99 as Distance);

  if (total % 3 !== 2) return Math.min(fastRawDistance(c, melds), seven) as Distance;

  const raw = fastRawDistance(c, melds);
  if (raw < 0) return -1;
  if (seven < 0) return -1;

  const w = c.slice();
  let best = raw;
  for (let i = 0; i < SCORING_KINDS; i++) {
    if (w[i]! > 0) {
      w[i]!--;
      const d = fastRawDistance(w, melds);
      if (d < best) best = d;
      w[i]!++;
    }
  }
  // The hand is as close as its BEST reading, and seven pairs is a reading the
  // four-sets search structurally cannot find.
  if (sevenPairs && melds === 0) best = Math.min(best, sevenPairsDistance(c)) as Distance;
  return best;
}

export const isReady = (c: readonly number[], melds = 0, sevenPairs = false): boolean =>
  distanceToReady(c, melds, sevenPairs) <= 0;
export const isComplete = (c: readonly number[], melds = 0, sevenPairs = false): boolean =>
  distanceToReady(c, melds, sevenPairs) < 0;

/**
 * Tiles that reduce the distance, with copies not yet visible anywhere.
 * @param visible counts of every tile this seat can account for: own hand,
 *                all discards, all melds, all revealed flowers.
 */
export function liveTiles(c: readonly number[], melds = 0, visible?: readonly number[],
                          sevenPairs = false): LiveTiles {
  const w = c.slice();
  const base = distanceToReady(w, melds, sevenPairs);
  const tiles: LiveTiles["tiles"] = [];
  let total = 0;
  for (let i = 0; i < SCORING_KINDS; i++) {
    if (w[i]! >= 4) continue;
    w[i]!++;
    const d = distanceToReady(w, melds, sevenPairs);
    w[i]!--;
    if (d < base) {
      const unseen = 4 - Math.min(4, visible?.[i] ?? 0);
      if (unseen > 0) { tiles.push({ tile: i as TileId, unseen }); total += unseen; }
    }
  }
  return { distance: base, tiles, total };
}

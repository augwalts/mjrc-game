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
 * No seven-pairs branch: not a hand in classic HKOS.
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
export function distanceToReady(c: readonly number[], melds = 0): Distance {
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

export const isReady = (c: readonly number[], melds = 0): boolean => distanceToReady(c, melds) <= 0;
export const isComplete = (c: readonly number[], melds = 0): boolean => distanceToReady(c, melds) < 0;

/**
 * Tiles that reduce the distance, with copies not yet visible anywhere.
 * @param visible counts of every tile this seat can account for: own hand,
 *                all discards, all melds, all revealed flowers.
 */
export function liveTiles(c: readonly number[], melds = 0, visible?: readonly number[]): LiveTiles {
  const w = c.slice();
  const base = distanceToReady(w, melds);
  const tiles: LiveTiles["tiles"] = [];
  let total = 0;
  for (let i = 0; i < SCORING_KINDS; i++) {
    if (w[i]! >= 4) continue;
    w[i]!++;
    const d = distanceToReady(w, melds);
    w[i]!--;
    if (d < base) {
      const unseen = 4 - Math.min(4, visible?.[i] ?? 0);
      if (unseen > 0) { tiles.push({ tile: i as TileId, unseen }); total += unseen; }
    }
  }
  return { distance: base, tiles, total };
}

/**
 * Provisional per-device rating. Implements DESIGN.md §3 — "provisional
 * per-device Elo, visible on the results screen, labelled unofficial and
 * resettable" — which §3 restores to P0 because deferring it to P1 and then
 * gating P1 on retention was circular: the thesis is that rating PRODUCES
 * retention. §2 makes the delta the first thing the results screen shows.
 * Terminology: ../../TERMINOLOGY.md.
 *
 * The unit a rating attaches to is one match — by default one wind round 圈
 * (§4). The inputs are exactly what the log already carries at match end:
 * `placements` (1-4) and `standings` (chips). Nothing new has to be recorded.
 *
 * ── Why this is not chess Elo ────────────────────────────────────────────
 *
 * Four players, not two, so a match yields a full placement ordering rather
 * than a win or a loss. The model here is the standard placement reading of
 * Elo: a four-player match is six simultaneous pairwise contests, and seat i
 * "beats" seat j when i places above j.
 *
 *   p(i above j) = 1 / (1 + 10^((Rj - Ri) / spread))
 *   transfer(i,j) = k(i,j) · (score(i,j) - p(i above j))     [j pays i]
 *
 * With one shared k this is algebraically identical to updating on the
 * placement difference, which is the property that makes it trustworthy:
 *
 *   Σ_j (beat(i,j) - p(i above j)) = expectedPlacement(i) - placement(i)
 *
 * because Σ_j beat(i,j) = n - placement(i) and Σ_j p(i above j) = n -
 * expectedPlacement(i). So `expectedPlacement` is not a separate heuristic
 * bolted on beside the update; it is the same quantity, exported so the
 * results screen and the bots can read the table's shape before the match
 * ends.
 *
 * ── Chip margin: it counts, it does not decide ───────────────────────────
 *
 * Placement is the outcome; margin is texture. Finishing 4th a hundred chips
 * back is not the same game as finishing 4th five thousand back, and a rating
 * that cannot tell them apart throws away most of what a match measured. But
 * a limit hand 爆棚 on the last deal must not swamp a whole match of good
 * play, so margin is capped twice over:
 *
 *   1. SATURATION — the pairwise margin is (chips_i - chips_j) / chipScale
 *      clamped to [-1, 1]. Past chipScale, a bigger blowout buys nothing.
 *   2. WEIGHT — margin contributes at most `chipWeight` of each pairwise
 *      score, placement the remaining (1 - chipWeight).
 *
 * At the defaults a first-place delta against an even field spans 24-30
 * points: chips move it by a quarter, and never past the next placement.
 * Because the clamp is monotone and odd, a seat that placed above another
 * never takes a worse margin term than it — so at equal ratings the delta is
 * strictly decreasing in placement no matter how the chips fell. That is the
 * formal statement of "counts, does not decide", and rating.test.ts asserts
 * it over random configurations rather than on one worked example.
 *
 * One consequence is deliberate and worth stating rather than discovering: a
 * seat expected to crush the table that instead wins by a hair can shed a few
 * points. At an 800-point edge over every opponent the model expects you above
 * them 99 times in 100, and placing first on a thin margin is short of that.
 * The loss is bounded by chipWeight — six points at the defaults, against the
 * sixty that placing last would have cost — and it cannot happen at an even
 * field, where first place always gains. Pinned by test rather than left to
 * chance. Removing it would mean scoring margin against an EXPECTED margin,
 * which needs a model of chip distributions that P0 has no data to build.
 *
 * ── Provisional K, and what it costs ─────────────────────────────────────
 *
 * A new device starts at INITIAL_RATING with a high K so it converges in a
 * handful of matches instead of fifty, decaying linearly to the stable K over
 * `provisionalMatches`. The pair rate is the MEAN of the two seats' K, which
 * is the only honest way to have both fast convergence and conservation:
 * in a zero-sum system a newcomer's fast movement is paid for by the seats
 * across the table, so a stable player takes some of a provisional player's
 * volatility. That spill is real and is a reason — not the only one — to
 * move to a per-player-deviation system at P1 (see the seam below). Using
 * max() instead would triple the newcomer's speed and roughly double the
 * spill; using min() would conserve perfectly and never converge.
 *
 * ── Conservation ─────────────────────────────────────────────────────────
 *
 * Deltas across the seats sum to EXACTLY zero. Each pairwise transfer is
 * computed once and applied with opposite signs, and the scores satisfy
 * score(i,j) + score(j,i) = 1 by construction (the clamp is odd), so nothing
 * is created at the table. Deltas are then rounded to whole points by largest
 * remainder, which preserves the exact sum and cannot flip a sign. There is
 * deliberately NO rating floor or ceiling: a clamp at, say, 100 would mint
 * points out of nothing and the ladder would inflate. If a floor is ever
 * wanted it belongs in presentation, not here.
 *
 * ── Determinism ──────────────────────────────────────────────────────────
 *
 * Pure function of its arguments. No Math.random, no Date.now, no iteration
 * over unordered object keys — config is read field by field by name, and the
 * one sort carries an index tiebreak so it is a total order. Note that rating
 * is NOT game state: §5 puts identity and rating outside any table, and replay
 * re-executes the hand, never the rating. The logistic goes through Math.pow,
 * whose last ULP is implementation-defined, so a client-side preview of a
 * delta can in principle differ from the server's by one point at an exact
 * rounding boundary. The server's value is authoritative; clients display it
 * rather than recomputing it.
 *
 * ── P1 SEAM: Glicko-2 family, HKMA-aligned (§1, §3) ──────────────────────
 *
 * P1 replaces this with a Glicko-2-family system aligned with HKMA's emerging
 * official HK standard, and §1 says to make contact BEFORE designing it. Do
 * not build that here. What this file does to stay out of its way:
 *
 *   - The update is a pure function of (ratings, placements, chips) and the
 *     inputs are all in the append-only log. So P1 ratings are not migrated
 *     from P0 numbers — they are RECOMPUTED from the match history by a
 *     different function over the same records. Rating is derived data, never
 *     canonical. Nothing here needs to be reversible.
 *   - RATING_SYSTEM_ID is stamped alongside any stored rating so a Glicko-2
 *     number can never be silently compared against, or updated from, an Elo
 *     one. Two systems will coexist during the changeover; this is the field
 *     that keeps them apart.
 *   - `matchesPlayed` is the poor man's rating deviation — the one scalar
 *     that says "we do not know this player yet". Under Glicko-2 it becomes a
 *     real RD carried per player, so callers should already be passing a
 *     per-seat state object shape (rating + matchesPlayed), not a bare number,
 *     wherever they persist it.
 *   - The pairwise-transfer shape is Glicko-2's shape too: it also aggregates
 *     a term per opponent. What changes is that the terms stop being a
 *     conserved transfer — Glicko-2 is NOT zero-sum, and the conservation
 *     asserted in the tests here is a property of THIS system only, not an
 *     invariant of the ladder. Do not write callers that depend on it.
 */

/** Stamp this next to any persisted rating. P1's Glicko-2 numbers get their own id. */
export const RATING_SYSTEM_ID = "elo-placement-v1";

/** Where an unrated device starts. Resettable at P0 by construction (§3). */
export const INITIAL_RATING = 1500;

export interface RatingConfig {
  /** Rating difference worth 10:1 odds. 400 is the Elo convention. */
  spread: number;
  /** K for a device with no matches played. */
  kProvisional: number;
  /** K a settled player converges to. */
  kStable: number;
  /** Matches over which K decays from provisional to stable. */
  provisionalMatches: number;
  /** Share of each pairwise score that chip margin may claim, in [0, 1). */
  chipWeight: number;
  /** Chip difference at which the margin term saturates. See chipScaleFor. */
  chipScale: number;
}

/**
 * Tuned for a four-seat wind round 圈. A stable player swings at most ±30 a
 * match, chess-like; a brand-new device swings up to ±90 against other new
 * devices and lands near its level inside ten matches.
 *
 * chipScale is the one value that is ruleset-dependent — it is in chips, and
 * the HKOS doubling ladder and the LIU bracket table are not on the same
 * scale. 1500 is chipScaleFor(768), two limit-hand discard wins at
 * hkos-doubling. A table on another payment table must set its own.
 */
export const DEFAULT_RATING_CONFIG: RatingConfig = {
  spread: 400,
  kProvisional: 60,
  kStable: 20,
  provisionalMatches: 10,
  chipWeight: 0.2,
  chipScale: 1500,
};

export interface RatingUpdateOptions {
  /** Matches each seat had already played BEFORE this one. Defaults to all zero. */
  matchesPlayed?: readonly number[];
  /**
   * Final chip standings per seat. Must agree with `placements` — a seat that
   * placed above another cannot hold fewer chips. Omit to score on placement
   * alone, which drops the margin term entirely rather than scaling it away.
   */
  chips?: readonly number[];
  config?: Partial<RatingConfig>;
}

/**
 * Saturate the margin at two limit hands. Pass the chips a limit-hand win
 * costs the payer under the table's payment table, e.g. 2 x 384 = 768 for
 * hkos-doubling. Kept here rather than in the ruleset package because the
 * engine must not depend on rulesets — the dependency runs the other way.
 */
export function chipScaleFor(limitHandValue: number): number {
  if (!Number.isFinite(limitHandValue) || limitHandValue <= 0)
    throw new Error(`limitHandValue must be a positive finite number, got ${limitHandValue}`);
  return 2 * limitHandValue;
}

/* ── configuration ─────────────────────────────────────────────────────── */

/** Field-by-field by name — never a key iteration, so the merge is order-free. */
function resolveConfig(o?: Partial<RatingConfig>): RatingConfig {
  const d = DEFAULT_RATING_CONFIG;
  const c: RatingConfig = {
    spread: o?.spread ?? d.spread,
    kProvisional: o?.kProvisional ?? d.kProvisional,
    kStable: o?.kStable ?? d.kStable,
    provisionalMatches: o?.provisionalMatches ?? d.provisionalMatches,
    chipWeight: o?.chipWeight ?? d.chipWeight,
    chipScale: o?.chipScale ?? d.chipScale,
  };
  if (!Number.isFinite(c.spread) || c.spread <= 0)
    throw new Error(`spread must be positive, got ${c.spread}`);
  if (!Number.isFinite(c.kStable) || c.kStable < 0)
    throw new Error(`kStable must be non-negative, got ${c.kStable}`);
  if (!Number.isFinite(c.kProvisional) || c.kProvisional < c.kStable)
    throw new Error(`kProvisional must be at least kStable, got ${c.kProvisional}`);
  if (!Number.isInteger(c.provisionalMatches) || c.provisionalMatches < 0)
    throw new Error(`provisionalMatches must be a non-negative integer, got ${c.provisionalMatches}`);
  // 1 is excluded: at chipWeight 1 placement stops counting and the system is
  // no longer a rating of who won, which is not a knob anyone should turn to.
  if (!Number.isFinite(c.chipWeight) || c.chipWeight < 0 || c.chipWeight >= 1)
    throw new Error(`chipWeight must be in [0, 1), got ${c.chipWeight}`);
  if (!Number.isFinite(c.chipScale) || c.chipScale <= 0)
    throw new Error(`chipScale must be positive, got ${c.chipScale}`);
  return c;
}

/* ── expectation ───────────────────────────────────────────────────────── */

/** Probability that a seat rated `a` finishes above one rated `b`. */
export function winProbability(a: number, b: number, spread: number = DEFAULT_RATING_CONFIG.spread): number {
  return 1 / (1 + Math.pow(10, (b - a) / spread));
}

/**
 * Expected finishing position of each seat, 1 = best. One plus the expected
 * number of opponents finishing above you. Always sums to n(n+1)/2 — 10 at a
 * four-seat table — so it is directly comparable to the actual placements.
 */
export function expectedPlacement(
  ratings: readonly number[],
  config?: Partial<RatingConfig>,
): number[] {
  const c = resolveConfig(config);
  assertRatings(ratings);
  const n = ratings.length;
  const above = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const p = winProbability(ratings[i], ratings[j], c.spread);
      above[i] += 1 - p;
      above[j] += p;
    }
  }
  return above.map((x) => 1 + x);
}

/* ── the provisional period ────────────────────────────────────────────── */

/**
 * K for a seat, decaying linearly from kProvisional to kStable across the
 * first `provisionalMatches` matches and flat thereafter.
 */
export function provisionalK(matchesPlayed: number, config?: Partial<RatingConfig>): number {
  const c = resolveConfig(config);
  assertMatchCount(matchesPlayed);
  if (c.provisionalMatches === 0) return c.kStable;
  const remaining = Math.max(0, 1 - matchesPlayed / c.provisionalMatches);
  return c.kStable + (c.kProvisional - c.kStable) * remaining;
}

/** True while the rating is still labelled unofficial on the results screen (§3). */
export function isProvisional(matchesPlayed: number, config?: Partial<RatingConfig>): boolean {
  const c = resolveConfig(config);
  assertMatchCount(matchesPlayed);
  return matchesPlayed < c.provisionalMatches;
}

/* ── the update ────────────────────────────────────────────────────────── */

/**
 * Whole-point rating change for each seat. Sums to exactly zero.
 *
 * `placements` is 1-4 with 1 best, a permutation — the same field the match
 * end record carries, where a chip tie is already broken by seat order.
 */
export function ratingDeltas(
  before: readonly number[],
  placements: readonly number[],
  opts: RatingUpdateOptions = {},
): number[] {
  const c = resolveConfig(opts.config);
  const n = before.length;
  assertRatings(before);
  assertPlacements(placements, n);

  const chips = opts.chips;
  if (chips !== undefined) assertChips(chips, placements, n);
  // Absent chips means no margin information, not a margin of zero: fold the
  // weight back into placement so an update without standings is not silently
  // a fifth smaller than one with them.
  const w = chips === undefined ? 0 : c.chipWeight;

  const played = opts.matchesPlayed;
  if (played !== undefined) assertMatchesPlayed(played, n);

  const k = new Array<number>(n);
  for (let i = 0; i < n; i++) k[i] = provisionalK(played === undefined ? 0 : played[i], c);

  const raw = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const expected = winProbability(before[i], before[j], c.spread);
      const above = placements[i] < placements[j] ? 1 : 0;
      // Odd in (i, j), so score(i,j) + score(j,i) === 1 and the pair conserves.
      const margin = chips === undefined ? 0 : clampUnit((chips[i] - chips[j]) / c.chipScale);
      const score = (1 - w) * above + w * (0.5 + margin / 2);
      const rate = (k[i] + k[j]) / 2;
      const transfer = rate * (score - expected);
      raw[i] += transfer;
      raw[j] -= transfer;
    }
  }
  return roundConserving(raw);
}

/**
 * Ratings after the match, in seat order. `before` is not mutated.
 * Ratings move by whole points, so a rating that starts integral stays one.
 */
export function updateRatings(
  before: readonly number[],
  placements: readonly number[],
  opts: RatingUpdateOptions = {},
): number[] {
  const deltas = ratingDeltas(before, placements, opts);
  const after = new Array<number>(before.length);
  for (let i = 0; i < before.length; i++) after[i] = before[i] + deltas[i];
  return after;
}

/* ── helpers ───────────────────────────────────────────────────────────── */

const clampUnit = (x: number): number => (x < -1 ? -1 : x > 1 ? 1 : x);

/** Grid the rounding remainders are compared on. See roundConserving. */
const REMAINDER_GRID = 1e6;

/** Kill negative zero so a delta of nothing compares equal to 0. */
const unsigned = (x: number): number => (x === 0 ? 0 : x);

/**
 * Round float deltas to whole points while keeping the sum exactly zero:
 * floor everything, then hand the shortfall to the largest remainders, ties
 * to the lower seat index. Each result is within one point of its input and
 * on the same side of zero, so rounding can shrink a delta to nothing but
 * never reverse it.
 */
function roundConserving(raw: readonly number[]): number[] {
  const n = raw.length;
  const out = new Array<number>(n);
  const remainder = new Array<number>(n);
  let floorSum = 0;
  for (let i = 0; i < n; i++) {
    const f = Math.floor(raw[i]);
    out[i] = f;
    remainder[i] = raw[i] - f;
    floorSum += f;
  }
  // raw sums to zero by construction, so the shortfall is a whole number of
  // points and cannot exceed the number of seats holding a remainder.
  const shortfall = -floorSum;
  if (!Number.isInteger(shortfall) || shortfall < 0 || shortfall > n)
    throw new Error(`deltas did not conserve: shortfall ${shortfall}`);
  // Remainders are compared on a fixed grid, not as raw floats: a 1-ULP
  // difference deciding who gets the odd point is deterministic but needlessly
  // brittle. Rounding to a grid keeps the comparator a total order, which a
  // tolerance-based one would not be.
  const key = new Array<number>(n);
  for (let i = 0; i < n; i++) key[i] = Math.round(remainder[i] * REMAINDER_GRID);
  const order = new Array<number>(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => key[b] - key[a] || a - b);
  for (let i = 0; i < shortfall; i++) out[order[i]] += 1;
  for (let i = 0; i < n; i++) out[i] = unsigned(out[i]);
  return out;
}

/* ── validation — a bad call is a bug, not a clamp ─────────────────────── */

function assertRatings(ratings: readonly number[]): void {
  if (ratings.length < 2) throw new Error(`need at least two seats, got ${ratings.length}`);
  for (let i = 0; i < ratings.length; i++)
    if (!Number.isFinite(ratings[i])) throw new Error(`rating at seat ${i} is not finite: ${ratings[i]}`);
}

function assertMatchCount(matchesPlayed: number): void {
  if (!Number.isInteger(matchesPlayed) || matchesPlayed < 0)
    throw new Error(`matchesPlayed must be a non-negative integer, got ${matchesPlayed}`);
}

function assertMatchesPlayed(played: readonly number[], n: number): void {
  if (played.length !== n)
    throw new Error(`matchesPlayed has ${played.length} entries, expected ${n}`);
  for (const m of played) assertMatchCount(m);
}

/** Placements must be a permutation of 1..n: one seat per position, no ties. */
function assertPlacements(placements: readonly number[], n: number): void {
  if (placements.length !== n)
    throw new Error(`placements has ${placements.length} entries, expected ${n}`);
  const seen = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const p = placements[i];
    if (!Number.isInteger(p) || p < 1 || p > n)
      throw new Error(`placement at seat ${i} must be an integer in 1..${n}, got ${p}`);
    if (seen[p - 1]) throw new Error(`placement ${p} appears more than once`);
    seen[p - 1] = true;
  }
}

/**
 * Chips have to tell the same story the placements do. The match end record
 * derives one from the other, so a disagreement here is a caller bug, and
 * letting it through would quietly break the guarantee that placing higher
 * never earns less.
 */
function assertChips(chips: readonly number[], placements: readonly number[], n: number): void {
  if (chips.length !== n) throw new Error(`chips has ${chips.length} entries, expected ${n}`);
  for (let i = 0; i < n; i++)
    if (!Number.isFinite(chips[i])) throw new Error(`chips at seat ${i} is not finite: ${chips[i]}`);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (placements[i] < placements[j] && chips[i] < chips[j])
        throw new Error(
          `seat ${i} placed ${placements[i]} with ${chips[i]} chips but seat ${j} placed ` +
            `${placements[j]} with ${chips[j]} — placements and chips disagree`,
        );
}

/**
 * Tests for the provisional rating system (DESIGN.md §3).
 *
 * The three properties worth defending, in order:
 *   1. Conservation — the four deltas sum to exactly zero, always.
 *   2. Placement rules — at an even field the delta is strictly decreasing in
 *      placement whatever the chips did.
 *   3. Margin counts but does not decide — the chip term moves a first-place
 *      delta by a quarter of its placement value and never past the next seat.
 *
 * Randomised cases go through prng(seed) from wall.ts, never Math.random, so a
 * failure is reproducible from the seed printed in the case name.
 */
import { describe, expect, it } from "vitest";
import { prng } from "../src/wall.js";
import {
  DEFAULT_RATING_CONFIG,
  INITIAL_RATING,
  RATING_SYSTEM_ID,
  chipScaleFor,
  expectedPlacement,
  isProvisional,
  provisionalK,
  ratingDeltas,
  updateRatings,
  winProbability,
} from "../src/rating.js";

const SEATS = 4;
const STABLE = [10, 10, 10, 10];
const EVEN = [1500, 1500, 1500, 1500];
const IN_ORDER = [1, 2, 3, 4];

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Deterministic permutation of 1..n — placements as the match end record has them. */
function randomPlacements(rnd: () => number, n = SEATS): number[] {
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const placements = new Array<number>(n);
  for (let pos = 0; pos < n; pos++) placements[order[pos]] = pos + 1;
  return placements;
}

/** Whole chips that agree with the placements and settle to exactly zero. */
function randomChips(rnd: () => number, placements: readonly number[], spread = 4000): number[] {
  const n = placements.length;
  const draws: number[] = [];
  for (let i = 0; i < n - 1; i++) draws.push(Math.round((rnd() - 0.5) * spread));
  draws.push(-sum(draws));
  draws.sort((a, b) => b - a);
  const chips = new Array<number>(n);
  for (let i = 0; i < n; i++) chips[i] = draws[placements[i] - 1];
  return chips;
}

function randomRatings(rnd: () => number, n = SEATS, spread = 900): number[] {
  const ratings: number[] = [];
  for (let i = 0; i < n; i++) ratings.push(Math.round(INITIAL_RATING + (rnd() - 0.5) * spread));
  return ratings;
}

function randomMatchesPlayed(rnd: () => number, n = SEATS): number[] {
  const played: number[] = [];
  for (let i = 0; i < n; i++) played.push(Math.floor(rnd() * 30));
  return played;
}

/* ── expectation ───────────────────────────────────────────────────────── */

describe("winProbability", () => {
  it("is even money between equal ratings", () => {
    expect(winProbability(1500, 1500)).toBe(0.5);
  });
  it("is complementary", () => {
    const rnd = prng(11);
    for (let i = 0; i < 200; i++) {
      const a = 1000 + rnd() * 1500;
      const b = 1000 + rnd() * 1500;
      expect(winProbability(a, b) + winProbability(b, a)).toBeCloseTo(1, 12);
    }
  });
  it("puts one spread at 10:1", () => {
    expect(winProbability(1900, 1500)).toBeCloseTo(10 / 11, 12);
    expect(winProbability(1700, 1500)).toBeCloseTo(0.7597, 4);
  });
  it("rises with the rating edge", () => {
    let last = 0;
    for (let edge = -800; edge <= 800; edge += 50) {
      const p = winProbability(1500 + edge, 1500);
      expect(p).toBeGreaterThan(last);
      last = p;
    }
  });
});

describe("expectedPlacement", () => {
  it("puts an even field at the middle of the table", () => {
    expect(expectedPlacement(EVEN)).toEqual([2.5, 2.5, 2.5, 2.5]);
  });
  it("always sums to the sum of the actual placements", () => {
    const rnd = prng(23);
    for (let i = 0; i < 500; i++) {
      expect(sum(expectedPlacement(randomRatings(rnd)))).toBeCloseTo(10, 9);
    }
  });
  it("ranks the seats by rating", () => {
    const e = expectedPlacement([1800, 1600, 1400, 1200]);
    expect(e[0]).toBeLessThan(e[1]);
    expect(e[1]).toBeLessThan(e[2]);
    expect(e[2]).toBeLessThan(e[3]);
  });
  it("stays inside 1..n", () => {
    const rnd = prng(37);
    for (let i = 0; i < 500; i++) {
      for (const e of expectedPlacement(randomRatings(rnd, SEATS, 3000))) {
        expect(e).toBeGreaterThanOrEqual(1);
        expect(e).toBeLessThanOrEqual(SEATS);
      }
    }
  });
  it("expects a dominant seat to win the table", () => {
    const e = expectedPlacement([2400, 1200, 1200, 1200]);
    expect(e[0]).toBeLessThan(1.1);
    // The other three split the remaining places evenly, one rung down.
    expect(e[1]).toBeCloseTo(3, 2);
    expect(e[1]).toBe(e[3]);
  });
  it("generalises past four seats", () => {
    expect(sum(expectedPlacement([1500, 1500, 1500]))).toBeCloseTo(6, 9);
    expect(expectedPlacement([1500, 1500, 1500])).toEqual([2, 2, 2]);
  });
  it("rejects a table of one", () => {
    expect(() => expectedPlacement([1500])).toThrow(/at least two seats/);
  });
});

/* ── the provisional period ────────────────────────────────────────────── */

describe("provisionalK", () => {
  const c = DEFAULT_RATING_CONFIG;
  it("starts at the provisional rate and settles at the stable one", () => {
    expect(provisionalK(0)).toBe(c.kProvisional);
    expect(provisionalK(c.provisionalMatches)).toBe(c.kStable);
    expect(provisionalK(c.provisionalMatches * 5)).toBe(c.kStable);
  });
  it("decays linearly through the provisional period", () => {
    expect(provisionalK(5)).toBe((c.kProvisional + c.kStable) / 2);
  });
  it("never rises and never drops below the stable rate", () => {
    let last = Infinity;
    for (let m = 0; m <= 40; m++) {
      const k = provisionalK(m);
      expect(k).toBeLessThanOrEqual(last);
      expect(k).toBeGreaterThanOrEqual(c.kStable);
      last = k;
    }
  });
  it("labels a device unofficial until the period is over", () => {
    expect(isProvisional(0)).toBe(true);
    expect(isProvisional(c.provisionalMatches - 1)).toBe(true);
    expect(isProvisional(c.provisionalMatches)).toBe(false);
  });
  it("rejects a nonsense match count", () => {
    expect(() => provisionalK(-1)).toThrow(/non-negative integer/);
    expect(() => provisionalK(1.5)).toThrow(/non-negative integer/);
  });
});

/* ── conservation ──────────────────────────────────────────────────────── */

describe("conservation", () => {
  it("sums to exactly zero across 2000 random configurations", () => {
    const rnd = prng(101);
    for (let i = 0; i < 2000; i++) {
      const before = randomRatings(rnd);
      const placements = randomPlacements(rnd);
      const deltas = ratingDeltas(before, placements, {
        chips: randomChips(rnd, placements),
        matchesPlayed: randomMatchesPlayed(rnd),
      });
      expect(sum(deltas)).toBe(0);
    }
  });
  it("sums to exactly zero without chips or match counts", () => {
    const rnd = prng(202);
    for (let i = 0; i < 500; i++) {
      expect(sum(ratingDeltas(randomRatings(rnd), randomPlacements(rnd)))).toBe(0);
    }
  });
  it("sums to exactly zero at other table sizes", () => {
    const rnd = prng(303);
    for (const n of [2, 3, 5]) {
      for (let i = 0; i < 200; i++) {
        const placements = randomPlacements(rnd, n);
        const deltas = ratingDeltas(randomRatings(rnd, n), placements, {
          chips: randomChips(rnd, placements),
        });
        expect(deltas.length).toBe(n);
        expect(sum(deltas)).toBe(0);
      }
    }
  });
  it("moves ratings by whole points only", () => {
    const rnd = prng(404);
    for (let i = 0; i < 500; i++) {
      const placements = randomPlacements(rnd);
      for (const d of ratingDeltas(randomRatings(rnd), placements, {
        chips: randomChips(rnd, placements),
        matchesPlayed: randomMatchesPlayed(rnd),
      })) {
        expect(Number.isInteger(d)).toBe(true);
      }
    }
  });
  it("rounding never flips a delta across zero", () => {
    // On placement alone every pairwise transfer to the seat that placed first
    // is positive and every one from the seat that placed last is negative, at
    // any rating spread. Rounding may shrink a delta to nothing; it must never
    // turn a gain into a loss.
    const rnd = prng(505);
    for (let i = 0; i < 1000; i++) {
      const before = randomRatings(rnd, SEATS, 2400);
      const placements = randomPlacements(rnd);
      const deltas = ratingDeltas(before, placements, { matchesPlayed: randomMatchesPlayed(rnd) });
      expect(deltas[placements.indexOf(1)]).toBeGreaterThanOrEqual(0);
      expect(deltas[placements.indexOf(SEATS)]).toBeLessThanOrEqual(0);
    }
  });
});

/* ── the update itself ─────────────────────────────────────────────────── */

describe("ratingDeltas", () => {
  it("splits an even field by placement alone", () => {
    // Stable K 20, even ratings: every pair is a coin flip, so each of the
    // three pairs moves 20 x 0.5 = 10 points to the seat that placed above.
    expect(ratingDeltas(EVEN, IN_ORDER, { matchesPlayed: STABLE })).toEqual([30, 10, -10, -30]);
  });
  it("moves brand-new devices three times as far", () => {
    expect(ratingDeltas(EVEN, IN_ORDER)).toEqual([90, 30, -30, -90]);
  });
  it("prices a blowout on an even field", () => {
    // Margins saturate against every opponent, so each pair pays the full
    // 20 x (0.98 - 0.5); the odd points land by largest remainder.
    const chips = [900, -300, -300, -300];
    expect(ratingDeltas(EVEN, IN_ORDER, { matchesPlayed: STABLE, chips })).toEqual([29, 7, -10, -26]);
  });
  it("is a pure function of its arguments", () => {
    const before = [1500, 1600, 1400, 1550];
    const placements = [2, 1, 4, 3];
    const chips = [100, 400, -400, -100];
    const played = [0, 4, 12, 30];
    const frozen = JSON.stringify({ before, placements, chips, played });
    const a = ratingDeltas(before, placements, { chips, matchesPlayed: played });
    const b = ratingDeltas(before, placements, { chips, matchesPlayed: played });
    expect(a).toEqual(b);
    expect(JSON.stringify({ before, placements, chips, played })).toBe(frozen);
  });
  it("adds the deltas to the ratings and leaves the input alone", () => {
    const before = [1500, 1600, 1400, 1550];
    const placements = [1, 3, 2, 4];
    const after = updateRatings(before, placements, { matchesPlayed: STABLE });
    const deltas = ratingDeltas(before, placements, { matchesPlayed: STABLE });
    expect(after).toEqual(before.map((r, i) => r + deltas[i]));
    expect(before).toEqual([1500, 1600, 1400, 1550]);
  });
  it("pays more for beating a stronger field", () => {
    const strong = ratingDeltas([1500, 1900, 1900, 1900], IN_ORDER, { matchesPlayed: STABLE });
    const weak = ratingDeltas([1500, 1100, 1100, 1100], IN_ORDER, { matchesPlayed: STABLE });
    expect(strong[0]).toBeGreaterThan(weak[0]);
    expect(weak[0]).toBeGreaterThan(0);
  });
  it("converges a provisional device faster than its stable opponents", () => {
    // Seat 0 is a brand-new device at a table of settled players. Every pair it
    // is in runs at the mean rate (60 + 20) / 2 = 40 instead of 20, so its win
    // is worth twice what the same win is worth to a settled player.
    const mixed = ratingDeltas(EVEN, IN_ORDER, { matchesPlayed: [0, 10, 10, 10] });
    const allStable = ratingDeltas(EVEN, IN_ORDER, { matchesPlayed: STABLE });
    expect(mixed).toEqual([60, 0, -20, -40]);
    expect(allStable).toEqual([30, 10, -10, -30]);
    expect(mixed[0]).toBe(2 * allStable[0]);
    // ...and the cost of that speed, stated rather than hidden. The system
    // conserves, so the extra 30 points came off the three seats across the
    // table — each of them ends 10 worse than the same match would have paid
    // with no newcomer in it. That spill is the price of exact conservation
    // and is one of the reasons P1 moves to a per-player-deviation system.
    for (const seat of [1, 2, 3]) expect(mixed[seat]).toBe(allStable[seat] - 10);
  });
  it("applies no floor — a rating may go negative", () => {
    const after = updateRatings([10, 10, 10, 10], IN_ORDER, { matchesPlayed: STABLE });
    expect(after).toEqual([40, 20, 0, -20]);
  });
});

/* ── placement rules the table ─────────────────────────────────────────── */

describe("placement dominates margin", () => {
  it("orders the deltas by placement at an even field, whatever the chips did", () => {
    const rnd = prng(606);
    for (let i = 0; i < 1000; i++) {
      const placements = randomPlacements(rnd);
      const deltas = ratingDeltas(EVEN, placements, {
        chips: randomChips(rnd, placements, 12000),
        matchesPlayed: randomMatchesPlayed(rnd),
      });
      const bySeat = [0, 1, 2, 3].sort((a, b) => placements[a] - placements[b]);
      for (let p = 0; p + 1 < SEATS; p++) {
        expect(deltas[bySeat[p]]).toBeGreaterThan(deltas[bySeat[p + 1]]);
      }
      expect(deltas[bySeat[0]]).toBeGreaterThan(0);
      expect(deltas[bySeat[SEATS - 1]]).toBeLessThan(0);
    }
  });

  it("keeps a first-place delta inside a quarter of its placement value", () => {
    // Placement alone is worth kStable x (n-1) x 0.5 = 30 at an even field.
    // Chips may claim chipWeight of that and no more: 24 at worst, 30 at best.
    const c = DEFAULT_RATING_CONFIG;
    const ceiling = c.kStable * (SEATS - 1) * 0.5;
    const floor = (1 - c.chipWeight) * ceiling;
    const rnd = prng(707);
    for (let i = 0; i < 1000; i++) {
      const placements = randomPlacements(rnd);
      const deltas = ratingDeltas(EVEN, placements, {
        chips: randomChips(rnd, placements, 20000),
        matchesPlayed: STABLE,
      });
      const first = placements.indexOf(1);
      expect(deltas[first]).toBeGreaterThanOrEqual(Math.floor(floor));
      expect(deltas[first]).toBeLessThanOrEqual(Math.ceil(ceiling));
    }
  });

  it("does not let a limit hand on the last deal swamp the match", () => {
    // Seat 0 leads all match. Seat 1 takes a limit hand 爆棚 on the last deal
    // and closes to within a hair — but still finishes second.
    const commanding = [1200, -400, -400, -400];
    const stolenBack = [100, 50, -50, -100];
    const wire = ratingDeltas(EVEN, IN_ORDER, { matchesPlayed: STABLE, chips: stolenBack });
    const romp = ratingDeltas(EVEN, IN_ORDER, { matchesPlayed: STABLE, chips: commanding });
    // The match of good play is still worth nearly all of what the romp was.
    expect(wire[0]).toBeGreaterThan(0.75 * romp[0]);
    // And the limit hand does not buy second place a better result than first.
    expect(wire[0]).toBeGreaterThan(wire[1]);
    expect(wire[1]).toBeGreaterThan(0);
  });

  it("still reads the margin — a wire and a romp are not the same result", () => {
    const wire = ratingDeltas(EVEN, IN_ORDER, {
      matchesPlayed: STABLE,
      chips: [30, 10, -10, -30],
    });
    const romp = ratingDeltas(EVEN, IN_ORDER, {
      matchesPlayed: STABLE,
      chips: [3000, 1000, -1000, -3000],
    });
    expect(romp[0]).toBeGreaterThan(wire[0]);
  });

  it("saturates: past chipScale a bigger blowout buys nothing", () => {
    // Every pair is already more than chipScale apart in `big`.
    const big = [3000, 1000, -1000, -3000];
    const absurd = [300000, 100000, -100000, -300000];
    const opts = { matchesPlayed: STABLE };
    expect(ratingDeltas(EVEN, IN_ORDER, { ...opts, chips: absurd })).toEqual(
      ratingDeltas(EVEN, IN_ORDER, { ...opts, chips: big }),
    );
  });

  it("charges a heavy favourite for a thin win, but only a little", () => {
    // The documented cost of counting margin: a seat expected to crush the
    // table that instead edges it can shed a couple of points. Bounded by the
    // chip weight, and never near what placing lower would have cost.
    const heavy = [2400, 1200, 1200, 1200];
    const thin = ratingDeltas(heavy, IN_ORDER, {
      matchesPlayed: STABLE,
      chips: [30, 10, -10, -30],
    });
    const lost = ratingDeltas(heavy, [4, 1, 2, 3], {
      matchesPlayed: STABLE,
      chips: [-3000, 2000, 500, 500],
    });
    expect(thin[0]).toBeLessThan(0);
    expect(thin[0]).toBeGreaterThan(-8);
    expect(thin[0]).toBeGreaterThan(lost[0] + 40);
  });

  it("ignores margin entirely when no chips are supplied", () => {
    // Dropping the standings must not silently shrink the update by a fifth.
    const withoutChips = ratingDeltas(EVEN, IN_ORDER, { matchesPlayed: STABLE });
    expect(withoutChips).toEqual([30, 10, -10, -30]);
    expect(ratingDeltas(EVEN, IN_ORDER, { matchesPlayed: STABLE, config: { chipWeight: 0 } })).toEqual(
      withoutChips,
    );
  });
});

/* ── configuration and validation ──────────────────────────────────────── */

describe("configuration", () => {
  it("scales the margin to two limit hands", () => {
    expect(chipScaleFor(768)).toBe(1536);
    expect(() => chipScaleFor(0)).toThrow(/positive finite/);
  });
  it("honours an overridden config", () => {
    const doubled = ratingDeltas(EVEN, IN_ORDER, {
      matchesPlayed: STABLE,
      config: { kStable: 40 },
    });
    expect(doubled).toEqual([60, 20, -20, -60]);
  });
  it("names the system it produced, so P1 numbers can never be mixed in", () => {
    expect(RATING_SYSTEM_ID).toBe("elo-placement-v1");
    expect(INITIAL_RATING).toBe(1500);
  });
  it("rejects a config that would erase placement or invert the rates", () => {
    const opts = { matchesPlayed: STABLE };
    expect(() => ratingDeltas(EVEN, IN_ORDER, { ...opts, config: { chipWeight: 1 } })).toThrow(
      /chipWeight/,
    );
    expect(() => ratingDeltas(EVEN, IN_ORDER, { ...opts, config: { chipWeight: -0.1 } })).toThrow(
      /chipWeight/,
    );
    expect(() => ratingDeltas(EVEN, IN_ORDER, { ...opts, config: { chipScale: 0 } })).toThrow(
      /chipScale/,
    );
    expect(() => ratingDeltas(EVEN, IN_ORDER, { ...opts, config: { spread: 0 } })).toThrow(/spread/);
    expect(() =>
      ratingDeltas(EVEN, IN_ORDER, { ...opts, config: { kProvisional: 5, kStable: 20 } }),
    ).toThrow(/kProvisional/);
    expect(() =>
      ratingDeltas(EVEN, IN_ORDER, { ...opts, config: { provisionalMatches: 2.5 } }),
    ).toThrow(/provisionalMatches/);
  });
});

describe("validation", () => {
  it("rejects placements that are not a permutation", () => {
    expect(() => ratingDeltas(EVEN, [1, 1, 3, 4])).toThrow(/more than once/);
    expect(() => ratingDeltas(EVEN, [0, 1, 2, 3])).toThrow(/integer in 1\.\.4/);
    expect(() => ratingDeltas(EVEN, [1, 2, 3, 5])).toThrow(/integer in 1\.\.4/);
    expect(() => ratingDeltas(EVEN, [1, 2, 3])).toThrow(/expected 4/);
  });
  it("rejects ratings that are not finite", () => {
    expect(() => ratingDeltas([1500, NaN, 1500, 1500], IN_ORDER)).toThrow(/not finite/);
    expect(() => ratingDeltas([1500, Infinity, 1500, 1500], IN_ORDER)).toThrow(/not finite/);
  });
  it("rejects chips that disagree with the placements", () => {
    // Seat 0 placed first holding fewer chips than seat 1: one of the two is
    // wrong, and guessing which would break the ordering guarantee.
    expect(() => ratingDeltas(EVEN, IN_ORDER, { chips: [0, 500, -200, -300] })).toThrow(/disagree/);
    expect(() => ratingDeltas(EVEN, IN_ORDER, { chips: [100, 0, 0] })).toThrow(/expected 4/);
  });
  it("accepts chips that tie where the placements were broken by seat order", () => {
    expect(sum(ratingDeltas(EVEN, IN_ORDER, { chips: [500, 0, 0, -500] }))).toBe(0);
  });
  it("rejects a match count that is not a whole number of matches", () => {
    expect(() => ratingDeltas(EVEN, IN_ORDER, { matchesPlayed: [0, 0, 0, -1] })).toThrow(
      /non-negative integer/,
    );
    expect(() => ratingDeltas(EVEN, IN_ORDER, { matchesPlayed: [0, 0, 0] })).toThrow(/expected 4/);
  });
});

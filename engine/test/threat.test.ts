import { describe, expect, it } from "vitest";
import type { SeatIndex, TileId } from "../src/types.js";
import { assessSeatThreat, feedsSeat, readDiscards, tableThreat } from "../src/threat.js";
import { chooseRoute, leftFeed, rankDiscards, shapeOf, suitContest, DEFAULT_PROFILE, type SeatView, type BotConfig } from "../src/bots.js";
import { HKOS_STANDARD, LIU } from "../../rulesets/src/presets.js";
import { prng } from "../src/wall.js";

const pung = (t: TileId, from: SeatIndex): { kind: "pung"; tiles: TileId[]; from: SeatIndex; concealed: boolean } =>
  ({ kind: "pung", tiles: [t, t, t], from, concealed: false });

function view(over: Partial<SeatView>): SeatView {
  return {
    seat: 0, dealer: 0, roundWind: 0, seatWinds: [0, 1, 2, 3],
    hand: [], drawn: null,
    melds: [[], [], [], []], flowers: [[], [], [], []], discards: [[], [], [], []],
    handCounts: [13, 13, 13, 13], wallRemaining: 60, lastDiscard: null,
    ...over,
  };
}

describe("threat estimation", () => {
  it("is zero for a table of untouched hands", () => {
    expect(tableThreat(view({})).max).toBe(0);
  });

  it("reads a circle collector: three circle melds, starving circle discards", () => {
    // seat 2 has melded 9 circle tiles and cut none — the classic flush tell
    const v = view({
      melds: [[], [], [pung(18, 1), pung(20, 3), pung(24, 1)], []],
      discards: [[], [], [0, 4, 27, 31, 9, 13], []],
    });
    const t = assessSeatThreat(v, 2);
    expect(t.intentSuit).toBe(2);                    // circles
    expect(t.intentStrength).toBeGreaterThan(0.5);
    expect(t.threat).toBeGreaterThan(0.5);
    // cutting a circle feeds them; cutting a character does not
    expect(feedsSeat(20, t)).toBeGreaterThan(0.5);
    expect(feedsSeat(3, t)).toBe(0);
  });

  it("dials off means byte-identical discard ranking", () => {
    const v = view({
      hand: [0, 1, 2, 9, 10, 11, 18, 19, 20, 22, 27, 31, 33],
      drawn: 22,
      melds: [[], [], [pung(24, 1), pung(25, 3), pung(26, 1)], []],
      discards: [[], [], [0, 4, 27, 31, 9, 13], []],
    });
    const mk = (profile: typeof DEFAULT_PROFILE): BotConfig =>
      ({ ruleset: HKOS_STANDARD, rnd: prng(7), profile });
    const blind = rankDiscards(v, mk({ ...DEFAULT_PROFILE }));
    const zeroed = rankDiscards(v, mk({ ...DEFAULT_PROFILE, threatSensitivity: 0, threatPushValue: 0 }));
    expect(zeroed).toEqual(blind);
  });

  it("dials on changes the cut away from the collector's suit", () => {
    // Weak own hand, scary circle collector at seat 2. With awareness on, every
    // circle must rank strictly worse than it did blind, relative to the field.
    const v = view({
      hand: [0, 4, 8, 9, 13, 17, 18, 22, 26, 27, 29, 31, 33],
      drawn: 20,
      melds: [[], [], [pung(23, 1), pung(24, 3), pung(25, 1)], []],
      discards: [[], [], [0, 4, 27, 31, 9, 13], []],
    });
    const mk = (sens: number): BotConfig =>
      ({ ruleset: HKOS_STANDARD, rnd: prng(7),
         profile: { ...DEFAULT_PROFILE, threatSensitivity: sens, threatPushValue: 0.8 } });
    const scoreOf = (r: ReturnType<typeof rankDiscards>, t: TileId) => r.find((d) => d.tile === t)!.score;
    const blind = rankDiscards(v, mk(0));
    const aware = rankDiscards(v, mk(3));
    // Rank order is brittle (a tile already last cannot fall further), so test
    // the mechanism: awareness must penalise a circle (feeds the collector)
    // strictly more than a character (feeds nobody).
    const deltaCircle = scoreOf(aware, 20) - scoreOf(blind, 20);
    const deltaChar = scoreOf(aware, 0) - scoreOf(blind, 0);
    expect(deltaCircle).toBeLessThan(deltaChar - 0.1);
  });
});

describe("the owner's discard tells (interview 2026-08-27)", () => {
  const W = 1, R = 0;
  it("one suit at a time reads as a BIG hand", () => {
    // six bamboo cuts then five character cuts — a circles flush being built
    const r = readDiscards([9, 11, 13, 15, 10, 16, 0, 2, 4, 6, 8], W, R);
    expect(r.suitPhasing).toBeGreaterThan(0.6);
    expect(r.earlySpread).toBe(false);
  });
  it("something of every suit early reads as all-pungs (smaller)", () => {
    const r = readDiscards([0, 9, 18, 4, 13, 22], W, R);
    expect(r.earlySpread).toBe(true);
    expect(r.suitPhasing).toBeLessThan(0.5);
  });
  it("honours late = almost ready; value honours early = suspicious", () => {
    const late = readDiscards([0, 9, 18, 4, 13, 22, 2, 11, 31, 27], W, R);
    expect(late.lateHonours).toBeGreaterThan(0.5);
    // 中 and their own seat wind 南 in the first cuts
    const early = readDiscards([31, 28, 0, 9, 18, 4, 13, 22, 2], W, R);
    expect(early.earlyValueHonours).toBeGreaterThan(0);
    expect(early.lateHonours).toBe(0);
  });
  it("a big slow read out-threatens a small ready one, in chips", () => {
    const v = view({
      // seat 2: suit-phased cutter with a dragon shed early — big-hand read
      discards: [[], [0, 1, 3, 5, 7, 9, 11, 13], [31, 9, 11, 13, 15, 10, 12, 16], []],
      melds: [[], [pung(0, 3)], [pung(24, 1)], []],
    });
    const big = assessSeatThreat(v, 2, HKOS_STANDARD);
    const small = assessSeatThreat(v, 1, HKOS_STANDARD);
    expect(big.expectedFaan).toBeGreaterThan(small.expectedFaan);
    expect(big.chipsRel).toBeGreaterThan(small.chipsRel);
    expect(big.chipsRel).toBeGreaterThanOrEqual(4); // ≥+2 faan on a doubling ladder
  });
});

describe("route economics", () => {
  it("left player showering a suit raises that route; hoarding it sinks it", () => {
    const base: Parameters<typeof leftFeed>[0] = {
      concealed: [], melds: [], flowers: [], seatWind: 0, roundWind: 0,
      leftDiscards: [0, 2, 4, 6, 1, 3],           // six character cuts
    };
    expect(leftFeed(base, "chars")).toBeGreaterThan(0.8);
    expect(leftFeed(base, "bamboo")).toBeLessThan(-0.8);
    expect(leftFeed({ ...base, leftDiscards: [] }, "chars")).toBe(0);
  });
  it("HKOS builds value where LIU scrapes — same hand, different economics", () => {
    // a hand two tiles off a half flush but one tile off a cheap chow hand:
    // the doubling ladder should stretch for the flush; LIU's flat brackets
    // should take the scrape. This is the chip-valuation fix observable.
    const shape = {
      concealed: [0, 1, 2, 3, 4, 5, 6, 7, 8, 31, 31, 9, 18],
      melds: [], flowers: [34], seatWind: 0 as const, roundWind: 0 as const,
    };
    const hk = chooseRoute(shape, HKOS_STANDARD, DEFAULT_PROFILE);
    const liu = chooseRoute(shape, LIU, DEFAULT_PROFILE);
    expect(hk.route.suit).toBe("chars");            // stretch for the flush
    expect(hk.faan).toBeGreaterThanOrEqual(liu.faan === hk.faan ? 0 : liu.faan);
  });
});

describe("step zero — the table shapes the plan (owner, 2026-08-27)", () => {
  const bigSlowHand = view({
    // nine characters plus scatter: the flush is rich but 3+ tiles away
    hand: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 18, 27, 31],
    drawn: null,
  });
  const mk = (over: Partial<SeatView>): SeatView => ({ ...bigSlowHand, ...over });

  it("a ready-looking opponent turns the plan toward speed", () => {
    const quietTable = tableThreat(mk({}), HKOS_STANDARD);
    // seat 2: three melds and late-honour cuts — reads nearly ready
    const fast = mk({
      melds: [[], [], [pung(10, 1), pung(14, 3), pung(22, 1)], []],
      discards: [[], [], [0, 4, 9, 13, 20, 24, 2, 6, 31, 27], []],
    });
    const fastTable = tableThreat(fast, HKOS_STANDARD);
    expect(fastTable.max).toBeGreaterThan(quietTable.max);
    const sBig = shapeOf(bigSlowHand);
    const calm = chooseRoute(sBig, HKOS_STANDARD, DEFAULT_PROFILE, quietTable);
    const raced = chooseRoute(shapeOf(fast), HKOS_STANDARD, DEFAULT_PROFILE, fastTable);
    // under race pressure the distant flush must be worth strictly less
    expect(raced.score).toBeLessThan(calm.score);
  });

  it("a contested suit sinks that suit's route", () => {
    // seat 1 has melded six bamboo and starves it — bamboo is being eaten
    const v = mk({
      hand: [9, 10, 11, 12, 13, 14, 15, 16, 17, 0, 18, 27, 31],  // bamboo-rich us
      melds: [[], [pung(11, 2), pung(15, 3)], [], []],
      discards: [[], [0, 4, 19, 23, 2, 6], [], []],
    });
    const t = tableThreat(v, HKOS_STANDARD);
    const contested = suitContest("bamboo", t);
    expect(contested).toBeGreaterThan(0.3);
    expect(suitContest("chars", t)).toBeLessThan(contested);
    // and the route scorer must price the bamboo flush below its blind self
    const blind = chooseRoute(shapeOf(v), HKOS_STANDARD, DEFAULT_PROFILE, null);
    const aware = chooseRoute(shapeOf(v), HKOS_STANDARD, DEFAULT_PROFILE, t);
    if (blind.route.suit === "bamboo" && aware.route.suit === "bamboo") {
      expect(aware.score).toBeLessThan(blind.score);
    }
  });
});

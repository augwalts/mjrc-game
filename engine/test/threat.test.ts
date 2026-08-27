import { describe, expect, it } from "vitest";
import type { SeatIndex, TileId } from "../src/types.js";
import { assessSeatThreat, feedsSeat, tableThreat } from "../src/threat.js";
import { rankDiscards, DEFAULT_PROFILE, type SeatView, type BotConfig } from "../src/bots.js";
import { HKOS_STANDARD } from "../../rulesets/src/presets.js";
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

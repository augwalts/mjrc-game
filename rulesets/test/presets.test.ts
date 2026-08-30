/**
 * Guards on the ruleset DATA (DESIGN.md §4). Nothing here tests scoring logic —
 * it tests that the catalogue and the tables are internally coherent, because
 * a typo in data is silent where a typo in code is not.
 */
import { describe, expect, it } from "vitest";
import {
  PATTERNS,
  PATTERN_IDS,
  applySubsumption,
  isPattern,
  pattern,
  subsumptionClosure,
} from "../src/patterns.js";
import {
  HKOS_BASE_CHIPS,
  HKOS_DOUBLING_PER_PLAYER,
  HKOS_DOUBLING_TOTAL,
  LIU_BRACKETS,
  LIU_BRACKET_PER_PLAYER,
  LIU_BRACKET_TOTAL,
  PAYMENT_TABLES,
  winnerCollects,
} from "../src/payment.js";
import { HKOS_STANDARD,
  MJRC_STANDARD, LIU, RULESETS, assertRulesetSound, enabledPatterns, ruleset } from "../src/presets.js";

describe("pattern catalogue", () => {
  it("gives every pattern a unique id", () => {
    expect(new Set(PATTERN_IDS).size).toBe(PATTERNS.length);
  });

  it("points every subsumption at a pattern that exists", () => {
    for (const p of PATTERNS) {
      for (const target of p.subsumes) {
        expect(isPattern(target), `${p.id} subsumes unknown "${target}"`).toBe(true);
      }
    }
  });

  it("never lets a pattern subsume itself, directly or through a cycle", () => {
    for (const p of PATTERNS) {
      expect(subsumptionClosure(p.id).has(p.id), `${p.id} subsumes itself`).toBe(false);
    }
  });

  it("fills in characters, jyutping and a label for every entry", () => {
    for (const p of PATTERNS) {
      expect(p.characters.length, p.id).toBeGreaterThan(0);
      expect(p.jyutping.length, p.id).toBeGreaterThan(0);
      expect(p.label.length, p.id).toBeGreaterThan(0);
    }
  });

  it("keeps banned terminology out of the catalogue", () => {
    // TERMINOLOGY.md — these leak a different game's rules into ours.
    const banned = /shanten|tenpai|ukeire|tsumogiri|\bron\b|riichi|furiten|\bdora\b|\byaku\b|kanchan|ankan|minkan/i;
    for (const p of PATTERNS) {
      const text = [p.id, p.label, p.note ?? "", ...(p.aka ?? [])].join(" ");
      expect(banned.test(text), `${p.id}: ${text}`).toBe(false);
    }
  });

  it("throws on an unknown id rather than returning undefined", () => {
    expect(() => pattern("bigFiveWinds")).toThrow(/unknown pattern/);
  });
});

describe("subsumption", () => {
  it("closes transitively — 大三元 swallows what 小三元 swallows", () => {
    const closure = subsumptionClosure("bigThreeDragons");
    expect(closure.has("smallThreeDragons")).toBe(true);
    expect(closure.has("dragonPung")).toBe(true);
  });

  it("resolves the big-over-small cases", () => {
    expect(subsumptionClosure("bigThreeDragons").has("smallThreeDragons")).toBe(true);
    expect(subsumptionClosure("bigFourWinds").has("smallFourWinds")).toBe(true);
  });

  it("drops the swallowed patterns and keeps the rest", () => {
    const kept = applySubsumption(["bigThreeDragons", "dragonPung", "halfFlush"]);
    expect(kept.sort()).toEqual(["bigThreeDragons", "halfFlush"]);
  });

  it("folds 門風/圈風 into a Four Winds hand — owner ruling 2026-08-26", () => {
    // "Wind faan do not stack on Four Winds." The pungs ARE the pattern, so no
    // wind inside it is also paid positionally.
    for (const id of ["smallFourWinds", "bigFourWinds"]) {
      expect(subsumptionClosure(id).has("seatWind"), id).toBe(true);
      expect(subsumptionClosure(id).has("roundWind"), id).toBe(true);
    }
  });

  it("folds 對對糊 into 字一色, 清么九 and 十八羅漢 — owner ruling 2026-08-26", () => {
    // A shape that is all pungs BY DEFINITION carries 對對糊 inside it: "both
    // should be very very large hands" priced as wholes, not as stacks.
    expect(subsumptionClosure("allHonours").has("allPungs")).toBe(true);
    expect(subsumptionClosure("allTerminals").has("allPungs")).toBe(true);
    expect(subsumptionClosure("allKongs").has("allPungs")).toBe(true);
  });

  it("keeps three dragon pungs worth three, not one", () => {
    // 三元牌 is one id awarded once per set. Deduplicating here would quietly
    // turn 3 faan into 1.
    expect(applySubsumption(["dragonPung", "dragonPung", "dragonPung", "allPungs"]))
      .toEqual(["dragonPung", "dragonPung", "dragonPung", "allPungs"]);
    // ...and 大三元 takes all three away at once.
    expect(applySubsumption(["bigThreeDragons", "dragonPung", "dragonPung", "dragonPung"]))
      .toEqual(["bigThreeDragons"]);
  });

  it("keeps the order the detector produced", () => {
    expect(applySubsumption(["noFlowers", "allPungs", "halfFlush", "seatWind"]))
      .toEqual(["noFlowers", "allPungs", "halfFlush", "seatWind"]);
  });

  it("keeps 十八羅漢 and 四暗刻 independent — houses split on the overlap", () => {
    expect(subsumptionClosure("allKongs").has("fourConcealedPungs")).toBe(false);
    expect(subsumptionClosure("fourConcealedPungs").has("allKongs")).toBe(false);
  });

  it("does not let 混么九 eat 對對糊 — every system stacks them", () => {
    expect(applySubsumption(["mixedTerminals", "allPungs"]).sort()).toEqual(["allPungs", "mixedTerminals"]);
  });

  it("does not let a pattern the ruleset does not play suppress one it does", () => {
    // hkos-standard has no 綠一色 entry. Without the guard the green hand would
    // score zero: jadeDragon eats the flush and the pungs and is worth nothing.
    const enabled = enabledPatterns(HKOS_STANDARD);
    expect(enabled.has("jadeDragon")).toBe(false);
    const kept = applySubsumption(["jadeDragon", "halfFlush", "allPungs", "dragonPung"], enabled);
    expect(kept).toContain("halfFlush");
    expect(kept).toContain("allPungs");
    expect(kept).toContain("dragonPung");
  });

  it("still applies subsumption from patterns the ruleset does play", () => {
    const kept = applySubsumption(["bigThreeDragons", "dragonPung"], enabledPatterns(HKOS_STANDARD));
    expect(kept).toEqual(["bigThreeDragons"]);
  });

  it("marks every hand that cannot hold an exposed meld", () => {
    for (const id of ["sevenPairs", "thirteenOrphans", "nineGates", "fourConcealedPungs",
                      "heavenlyHand", "earthlyHand"]) {
      expect(pattern(id).concealedOnly, id).toBe(true);
    }
  });

  it("swallows 門前清 only where doing so changes a total", () => {
    // hk-scoring.ts says a hand concealed by definition should not also collect
    // 門前清. That is kept where it moves the number — 七對子 is 4 faan and 四暗刻
    // is checked against a discard rule — and left additive on the flat limit
    // hands, where the golden fixtures pay it and the cap hides the difference.
    for (const id of ["sevenPairs", "fourConcealedPungs"]) {
      expect(subsumptionClosure(id).has("concealedHand"), id).toBe(true);
    }
    for (const id of ["thirteenOrphans", "nineGates", "heavenlyHand", "earthlyHand"]) {
      expect(subsumptionClosure(id).has("concealedHand"), id).toBe(false);
    }
  });

  it("swallows 清一色 into 九蓮寶燈, matching the flat-limit price", () => {
    expect(subsumptionClosure("nineGates").has("fullFlush")).toBe(true);
    expect(subsumptionClosure("nineGates").has("halfFlush")).toBe(true); // via fullFlush
  });
});

describe("payment tables", () => {
  it("gives every payment table a unique id naming its settlement", () => {
    const ids = PAYMENT_TABLES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of PAYMENT_TABLES) expect(t.id.endsWith(t.selfDraw)).toBe(true);
  });

  it("ships both self-draw settlements", () => {
    expect(new Set(PAYMENT_TABLES.map((t) => t.selfDraw))).toEqual(new Set(["perPlayer", "total"]));
  });

  it("is monotonic in faan — more faan never pays less", () => {
    for (const t of PAYMENT_TABLES) {
      for (let faan = 0; faan < 20; faan++) {
        expect(t.onDiscard(faan + 1), `${t.id} discard at ${faan}`).toBeGreaterThanOrEqual(t.onDiscard(faan));
        expect(t.onSelfDraw(faan + 1), `${t.id} self-draw at ${faan}`).toBeGreaterThanOrEqual(t.onSelfDraw(faan));
      }
    }
  });

  it("actually rises across the scoring range rather than sitting flat", () => {
    for (const t of PAYMENT_TABLES) {
      expect(t.onDiscard(13), t.id).toBeGreaterThan(t.onDiscard(3));
      expect(t.onSelfDraw(13), t.id).toBeGreaterThan(t.onSelfDraw(3));
    }
  });

  it("clamps at the limit instead of running away past 13 faan", () => {
    for (const t of PAYMENT_TABLES) {
      expect(t.onDiscard(99)).toBe(t.onDiscard(13));
      expect(t.onSelfDraw(99)).toBe(t.onSelfDraw(13));
    }
  });

  it("reproduces the published HKOS ladder", () => {
    expect(HKOS_BASE_CHIPS).toEqual([1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384]);
    // Discarder pays twice the table value; each loser pays it once on a self-draw.
    expect(HKOS_DOUBLING_PER_PLAYER.onDiscard(3)).toBe(16);
    expect(HKOS_DOUBLING_PER_PLAYER.onSelfDraw(3)).toBe(8);
    expect(HKOS_DOUBLING_PER_PLAYER.onDiscard(13)).toBe(768);
  });

  it("reproduces the LIU bracket table 92/108 · 124/156 · 188/252 · 316/444", () => {
    const printed = LIU_BRACKETS.filter((b) => b.maxFaan >= 3);
    expect(printed.map((b) => [b.onDiscard, b.selfDrawFigure])).toEqual([
      [92, 108], [124, 156], [188, 252], [316, 444],
    ]);
    expect([3, 4, 7, 10].map((f) => LIU_BRACKET_TOTAL.onDiscard(f))).toEqual([92, 124, 188, 316]);
    expect([3, 6, 9, 13].map((f) => LIU_BRACKET_TOTAL.onDiscard(f))).toEqual([92, 124, 188, 316]);
  });

  it("splits LIU's self-draw column three ways with nothing left over", () => {
    // The evidence that LIU's printed column is a pot, not a per-player figure.
    for (const b of LIU_BRACKETS) expect(b.selfDrawFigure % 3, `${b.maxFaan}`).toBe(0);
    expect([3, 4, 7, 10].map((f) => LIU_BRACKET_TOTAL.onSelfDraw(f))).toEqual([36, 52, 84, 148]);
  });

  it("makes the two readings of the same column differ by exactly three", () => {
    for (let faan = 3; faan <= 13; faan++) {
      expect(LIU_BRACKET_PER_PLAYER.onSelfDraw(faan)).toBe(3 * LIU_BRACKET_TOTAL.onSelfDraw(faan));
      expect(LIU_BRACKET_PER_PLAYER.onDiscard(faan)).toBe(LIU_BRACKET_TOTAL.onDiscard(faan));
    }
  });

  it("collects three shares on a self-draw and one payment on a discard", () => {
    expect(winnerCollects(HKOS_DOUBLING_PER_PLAYER, 3, true)).toBe(24);
    expect(winnerCollects(HKOS_DOUBLING_PER_PLAYER, 3, false)).toBe(16);
    expect(winnerCollects(LIU_BRACKET_TOTAL, 3, true)).toBe(108);
    expect(winnerCollects(HKOS_DOUBLING_TOTAL, 3, true)).toBe(3 * Math.ceil(8 / 3));
  });
});

describe("ruleset presets", () => {
  it("ships hkos-standard, mjrc-standard and liu, with unique ids", () => {
    expect(RULESETS.map((r) => r.id).sort()).toEqual(["hkos-standard", "liu", "mjrc-standard", "tvb-2026"]);
    expect(ruleset("hkos-standard")).toBe(HKOS_STANDARD);
    expect(ruleset("mjrc-standard")).toBe(MJRC_STANDARD);
    expect(ruleset("liu")).toBe(LIU);
    expect(ruleset("nope")).toBeUndefined();
  });

  it("prices only patterns that exist in the catalogue", () => {
    for (const r of RULESETS) expect(() => assertRulesetSound(r)).not.toThrow();
  });

  it("holds the HK Old Style facts from DESIGN.md §4", () => {
    expect(HKOS_STANDARD.minimumFaan).toBe(3);
    expect(HKOS_STANDARD.limitFaan).toBe(13);
    expect(HKOS_STANDARD.useFlowers).toBe(true);
    expect(HKOS_STANDARD.payment.selfDraw).toBe("perPlayer");
    // Seat and round wind faan are the reason match structure exists at all.
    expect(HKOS_STANDARD.faanTable.seatWind).toBe(1);
    expect(HKOS_STANDARD.faanTable.roundWind).toBe(1);
    // 13 is the cap, not a value every limit hand carries: several reach it
    // only once their additive components are counted.
    expect(HKOS_STANDARD.faanTable.allHonours).toBe(10);
    expect(HKOS_STANDARD.faanTable.allHonours + HKOS_STANDARD.faanTable.allPungs).toBe(13);
  });

  it("carries the LIU values the Python engine scores with", () => {
    // Every pattern PATTERN_FAN in scoring.py prices, at the value it prices it.
    expect(LIU.payment.selfDraw).toBe("total");
    const python: Record<string, number> = {
      allChows: 1, allPungs: 3, sevenPairs: 4, halfFlush: 3, fullFlush: 7,
      mixedTerminals: 1, dragonPung: 1, smallThreeDragons: 4, bigThreeDragons: 6,
      smallFourWinds: 10, bigFourWinds: 13, allHonours: 13, allTerminals: 13,
      nineGates: 13, thirteenOrphans: 13, selfDraw: 1,
    };
    for (const [id, faan] of Object.entries(python)) expect(LIU.faanTable[id], id).toBe(faan);
  });

  it("diverges from canonical HK exactly where ENGINE-AUDIT §1 says it does", () => {
    expect(LIU.faanTable.bigThreeDragons).toBe(6); // canonical pays 8
    expect(LIU.faanTable.smallFourWinds).toBe(10); // canonical pays 6
    expect(LIU.faanTable.fullFlush).toBe(7); // canonical pays 6
    expect(HKOS_STANDARD.faanTable.sevenPairs).toBeUndefined();
    expect(LIU.faanTable.sevenPairs).toBe(4);
  });

  it("prices no pattern the LIU column of the reference leaves blank", () => {
    for (const id of ["winByDoubleKong", "jadeDragon", "rubyDragon", "pearlDragon"]) {
      expect(LIU.faanTable[id], id).toBeUndefined();
    }
  });

  it("never prices a flower on a table that plays without them", () => {
    for (const r of RULESETS) {
      if (r.useFlowers) continue;
      for (const id of Object.keys(r.faanTable)) {
        expect(pattern(id).family, `${r.id}: ${id}`).not.toBe("bonusTile");
      }
    }
  });

  it("keeps every faan value inside the ruleset's own limit", () => {
    for (const r of RULESETS) {
      for (const [id, faan] of Object.entries(r.faanTable)) {
        expect(faan, `${r.id}: ${id}`).toBeLessThanOrEqual(r.limitFaan);
      }
    }
  });

  /**
   * Award lists transcribed from engine/test/golden — the P0 exit gate
   * (DESIGN.md §8). The fixtures live in another package and cannot be
   * imported from here, so these are copies: if a faan value below drifts, the
   * scoring engine fails the golden suite, and this test says so first.
   */
  it("reproduces the golden suite's arithmetic", () => {
    const score = (r: typeof HKOS_STANDARD, awards: string[]): number =>
      Math.min(awards.reduce((n, id) => n + r.faanTable[id]!, 0), r.limitFaan);

    // hkos-standard
    expect(score(HKOS_STANDARD, ["smallThreeDragons", "noFlowers"])).toBe(6);
    expect(score(HKOS_STANDARD, ["bigThreeDragons", "ownFlower"])).toBe(9);
    expect(score(HKOS_STANDARD, ["smallFourWinds", "halfFlush", "noFlowers"])).toBe(10);
    expect(score(HKOS_STANDARD, ["bigFourWinds", "allPungs", "halfFlush", "noFlowers"])).toBe(13);
    expect(score(HKOS_STANDARD, ["allHonours", "allPungs", "dragonPung", "concealedHand"])).toBe(13);
    // 清么九 at the column's 7 — an OUTLIER value, and the one place the golden
    // families contradict each other. See presets.ts.
    expect(score(HKOS_STANDARD, ["allTerminals", "concealedHand"])).toBe(8);
    expect(score(HKOS_STANDARD, ["nineGates", "concealedHand", "selfDraw"])).toBe(13);
    expect(score(HKOS_STANDARD, ["allPungs", "halfFlush", "seatWind", "winOnLastDiscard"])).toBe(8);
    expect(score(HKOS_STANDARD, ["fourConcealedPungs", "noFlowers"])).toBe(13);
    expect(score(HKOS_STANDARD, ["winByDoubleKong", "selfDraw", "noFlowers"])).toBe(10);

    // liu
    expect(score(LIU, ["fullFlush", "allChows", "selfDraw"])).toBe(9);
    expect(score(LIU, ["smallThreeDragons", "selfDraw"])).toBe(5);
    expect(score(LIU, ["seatWind", "concealedHand", "selfDraw", "noFlowers"])).toBe(4);
  });

  it("lets every hand that only just reaches the minimum still be paid", () => {
    for (const r of RULESETS) {
      expect(r.payment.onDiscard(r.minimumFaan), r.id).toBeGreaterThan(0);
      expect(r.payment.onSelfDraw(r.minimumFaan), r.id).toBeGreaterThan(0);
    }
  });
});

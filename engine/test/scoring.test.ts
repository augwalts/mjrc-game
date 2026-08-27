/**
 * The scoring engine against every authored golden hand. DESIGN.md §8 makes the
 * golden suite the P0 exit gate; §4 says wrong scoring "destroys credibility
 * instantly with the exact audience we want", so this file asserts the three
 * things a player can see — the faan paid, the breakdown that explains it, and
 * whether the win may be taken at all — for all five families at once.
 *
 * Nothing here is softened to make the engine look good. Where a fixture and
 * the shipped ruleset data disagree, the case is listed in KNOWN_CONFLICTS with
 * the reason, still executed, and still asserted: a conflicting case fails
 * loudly and a human adjudicates. The list exists so the failure report groups
 * by root cause instead of reading as fourteen unrelated bugs.
 *
 * Terminology: ../../TERMINOLOGY.md. HK Old Style only.
 */
import { describe, expect, it } from "vitest";
import { ruleset as rulesetById } from "@mjrc/rulesets";
import { score, type WinSituation } from "../src/scoring.js";
import type { Ruleset, SeatIndex } from "../src/types.js";
import type { GoldenCase } from "./golden/case.js";
import { cases as basicCases } from "./golden/basic.js";
import { cases as flushCases } from "./golden/flush.js";
import { cases as honoursCases } from "./golden/honours.js";
import { cases as kongsCases } from "./golden/kongs.js";
import { cases as limitCases, type LimitCase } from "./golden/limit.js";

interface Family {
  name: string;
  cases: GoldenCase[];
}

const FAMILIES: Family[] = [
  { name: "basic", cases: basicCases },
  { name: "flush", cases: flushCases },
  { name: "honours", cases: honoursCases },
  { name: "kongs", cases: kongsCases },
  { name: "limit", cases: limitCases },
];

const ALL: GoldenCase[] = FAMILIES.flatMap((f) => f.cases);

const isLimitCase = (c: GoldenCase): c is LimitCase =>
  typeof (c as LimitCase).rawFaan === "number";

function rulesetFor(c: GoldenCase): Ruleset {
  const r = rulesetById(c.ruleset);
  if (!r) throw new Error(`${c.id}: unknown ruleset "${c.ruleset}"`);
  return r;
}

/**
 * The fixtures carry the winner's seat implicitly: every family states that the
 * winner's SEAT INDEX equals their seatWind, which is what makes Meld.from
 * meaningful. The discarder is only ever used to decide that the win was not a
 * self-draw, so any other seat serves; 上家 is chosen for readability.
 */
function contextFor(c: GoldenCase): WinSituation {
  const seat = c.seatWind as SeatIndex;
  const ctx: WinSituation = {
    seat,
    selfDraw: c.selfDraw,
    from: c.selfDraw ? null : (((seat + 3) % 4) as SeatIndex),
    winningTile: c.winningTile,
    roundWind: c.roundWind,
    seatWind: c.seatWind,
    isDealer: c.isDealer,
    robbedKong: c.robbedKong,
    onKongReplacement: c.onKongReplacement,
    onLastTile: c.onLastTile,
  };
  if (isLimitCase(c)) {
    if (c.opening === "heavenly") ctx.heavenly = true;
    if (c.opening === "earthly") ctx.earthly = true;
    if (c.onLastDiscard) ctx.onLastDiscard = true;
  }
  return ctx;
}

const run = (c: GoldenCase) =>
  score(c.concealed, c.melds, c.flowers, c.winningTile, contextFor(c), rulesetFor(c));

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

/**
 * Cases where the golden fixture and the shipped ruleset data (patterns.ts /
 * presets.ts) give different answers. These are NOT excused — every one is
 * still asserted below and will fail until a human settles it. Grouped by the
 * single decision that fixes each group.
 */
const KNOWN_CONFLICTS: Record<string, string> = {
  // patterns.ts: 字一色 and 清么九 subsume 混一色/混么九 but NOT 對對糊, and its
  // note says the golden fixtures award both. limit.ts does; flush.ts and
  // honours.ts do not. One ruling, four fixtures on the losing side.
  "flush-all-honours-concealed": "allPungs under 字一色",
  "flush-all-honours-melded-reaches-limit": "allPungs under 字一色",
  "flush-all-terminals-concealed": "allPungs under 清么九",
  "flush-all-terminals-melded-self-draw": "allPungs under 清么九",
  "honours-big-three-dragons-all-honours-capped": "allPungs under 字一色",
  "honours-small-four-winds-all-honours": "allPungs under 字一色",

  // patterns.ts: 小四喜/大四喜 do NOT subsume 門風/圈風, citing honours.ts —
  // which rules the opposite way, in its header and in its own test.
  "honours-small-four-winds-half-flush": "門風/圈風 under 小四喜",
  "honours-big-four-winds-subsumes-small": "門風/圈風 under 大四喜",

  // patterns.ts prices 正花 and 正花(季) as separate ids; four golden families
  // emit "ownFlower" for both. Identical faan, different breakdown.
  "basic-own-flowers-lift-over-floor": "ownSeason vs ownFlower",
  "honours-dragon-pung-own-flower-and-season": "ownSeason vs ownFlower",
  "honours-dealer-scores-no-extra-faan": "ownSeason vs ownFlower",
  "honours-all-four-seasons-with-dragon-pung": "ownSeason vs ownFlower",
  "honours-all-eight-bonus-tiles": "ownSeason vs ownFlower",
  "honours-big-three-dragons-added-kong": "ownSeason vs ownFlower",

  // The shipped LIU preset plays bonus tiles and 門前清; these two fixtures
  // assume it plays neither. kongs-liu-concealed-kong-only assumes it does.
  "basic-full-flush-liu-seven": "LIU 門前清 / 無花",
  "honours-liu-concealed-small-three-dragons": "LIU 門前清 / 無花",

  // Fixtures that miss a pattern their own tiles satisfy. Not a house split —
  // the engine finds a real award the author did not write down.
  "flush-full-chars-concealed": "the hand is 九蓮寶燈, not a plain 清一色",
  "limit-big-three-dragons-caps": "the hand is also 混么九",

  // GoldenCase has no field for 槓上槓, and it is not derivable from the tiles.
  "kongs-double-kong-replacement": "槓上槓 not expressible in the fixture",
};

describe("score() — the golden suite", () => {
  it("loads all five families with unique ids", () => {
    expect(ALL.length).toBeGreaterThanOrEqual(100);
    expect(new Set(ALL.map((c) => c.id)).size).toBe(ALL.length);
    for (const f of FAMILIES) expect(f.cases.length).toBeGreaterThan(0);
  });

  for (const family of FAMILIES) {
    describe(`${family.name} family`, () => {
      for (const c of family.cases) {
        const label = KNOWN_CONFLICTS[c.id] ? `${c.id} [conflict: ${KNOWN_CONFLICTS[c.id]}]` : c.id;
        it(label, () => {
          const got = run(c);
          expect({
            faan: got.faan,
            awards: sorted(got.awards.map((a) => a.id)),
            legal: got.legal,
          }).toEqual({
            faan: c.expected.faan,
            awards: sorted(c.expected.awards),
            legal: c.expected.legal,
          });
        });
      }
    });
  }
});

describe("score() — the cap is reported, not hidden", () => {
  it("sums the breakdown to rawFaan on every golden hand", () => {
    // ENGINE-AUDIT §1: a display bug summed the breakdown uncapped while the
    // total was capped. The breakdown must explain rawFaan exactly.
    const bad = ALL.filter((c) => {
      const got = run(c);
      return got.awards.reduce((n, a) => n + a.faan, 0) !== got.rawFaan;
    });
    expect(bad.map((c) => c.id)).toEqual([]);
  });

  it("clamps to limitFaan and flags exactly when the clamp bit", () => {
    const bad = ALL.filter((c) => {
      const r = rulesetFor(c);
      const got = run(c);
      return (
        got.faan !== Math.min(got.rawFaan, r.limitFaan) ||
        got.capped !== got.rawFaan > r.limitFaan
      );
    });
    expect(bad.map((c) => c.id)).toEqual([]);
  });

  it("matches the limit family's own rawFaan and capped columns", () => {
    const bad = limitCases.filter((c) => {
      const got = run(c);
      return got.rawFaan !== c.rawFaan || got.capped !== c.capped;
    });
    expect(bad.map((c) => `${c.id}: raw ${run(c).rawFaan} vs ${c.rawFaan}`)).toEqual([]);
  });

  it("refuses every hand below the ruleset minimum and no others", () => {
    const bad = ALL.filter((c) => run(c).legal !== (run(c).faan >= rulesetFor(c).minimumFaan));
    expect(bad.map((c) => c.id)).toEqual([]);
  });
});

describe("score() — determinism and tie-breaking", () => {
  it("returns byte-identical results for repeated calls", () => {
    // DESIGN.md §5.5: replay is re-execution. A scorer that picked among equal
    // readings by hash order would pass once and fail on the replay.
    for (const c of ALL) {
      const a = run(c);
      const b = run(c);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  it("is unaffected by the order melds are supplied in", () => {
    // Reversing the melds changes decompositionKey's inputs but not the hand,
    // so the paid faan must not move. (The breakdown order may.)
    const bad = ALL.filter((c) => {
      if (c.melds.length < 2) return false;
      const flipped = { ...c, melds: [...c.melds].reverse() };
      const got = run(flipped);
      const base = run(c);
      return got.faan !== base.faan || sorted(got.awards.map((a) => a.id)).join() !==
        sorted(base.awards.map((a) => a.id)).join();
    });
    expect(bad.map((c) => c.id)).toEqual([]);
  });

  it("takes the best-scoring reading, not the first one found", () => {
    // 1筒 pung melded over 222 333 444 筒 and 5筒 eyes reads either as three
    // 234筒 runs (清一色 alone) or as three pungs (清一色 + 對對糊). Only the
    // second is correct, and only a scorer that scores every reading finds it.
    const c = flushCases.find((x) => x.id === "flush-full-parse-maximisation")!;
    const got = run(c);
    expect(sorted(got.awards.map((a) => a.id))).toEqual(["allPungs", "fullFlush"]);
    expect(got.faan).toBe(9);
  });
});

describe("score() — subsumption never pays twice for the same tiles", () => {
  it("never books a pattern alongside one that swallows it", () => {
    const bad: string[] = [];
    for (const c of ALL) {
      const ids = run(c).awards.map((a) => a.id);
      for (const a of run(c).awards) {
        for (const s of a.subsumes ?? []) {
          if (ids.includes(s)) bad.push(`${c.id}: ${a.id} and ${s} both booked`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("never books 大三元 with 小三元, or 大四喜 with 小四喜", () => {
    const bad = ALL.filter((c) => {
      const ids = run(c).awards.map((a) => a.id);
      return (
        (ids.includes("bigThreeDragons") && ids.includes("smallThreeDragons")) ||
        (ids.includes("bigFourWinds") && ids.includes("smallFourWinds"))
      );
    });
    expect(bad.map((c) => c.id)).toEqual([]);
  });

  it("prices nothing the ruleset does not play", () => {
    const bad: string[] = [];
    for (const c of ALL) {
      const r = rulesetFor(c);
      for (const a of run(c).awards) {
        if (r.faanTable[a.id] === undefined) bad.push(`${c.id}: ${a.id} is not in ${r.id}`);
        else if (r.faanTable[a.id] !== a.faan) bad.push(`${c.id}: ${a.id} priced ${a.faan}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

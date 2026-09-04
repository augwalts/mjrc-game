/**
 * Structural guard over the contested golden hands (DESIGN.md §8). Like its
 * siblings it does NOT score anything — half of these fixtures are wrong for
 * the shipped presets ON PURPOSE, so running them through score() would be
 * meaningless. What it checks instead is that both sides of every ruling are
 * actually written down, that each side is a physically legal hand, and that
 * the arithmetic each side claims adds up under its own faan values.
 *
 * The strongest check here is the last one: every case id a Ruling cites has to
 * resolve, including the ones pointing into basic/flush/honours/kongs/limit. A
 * ruling that names a fixture nobody wrote, or that lost its fixture to a
 * rename, is a ruling that has quietly become "the rule" again — which is the
 * exact failure ./CONTESTED.md exists to prevent.
 *
 * Terminology: ../../../TERMINOLOGY.md. HK Old Style only.
 */
import { describe, expect, it } from "vitest";
import { counts, flowerSeat, isFlower } from "../../src/tiles.js";
import { isComplete } from "../../src/ready.js";
import { SCORING_KINDS } from "../../src/types.js";
import { assertWellFormed, type GoldenCase } from "./case.js";
import {
  CONFIG_GAPS,
  HKOS,
  LIU,
  RULINGS,
  SHIPPED_CASES,
  UNCATALOGUED,
  cases,
} from "./contested.js";
import { cases as basicCases } from "./basic.js";
import { cases as flushCases } from "./flush.js";
import { cases as honoursCases } from "./honours.js";
import { cases as kongsCases } from "./kongs.js";
import { cases as limitCases } from "./limit.js";

/** 十三么 — one of every terminal and honour. */
const ORPHAN_KINDS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

/** Every case id the suite knows about, so a cited fixture can be resolved. */
const SUITE_IDS: ReadonlySet<string> = new Set(
  ([] as GoldenCase[])
    .concat(basicCases, flushCases, honoursCases, kongsCases, limitCases, cases)
    .map((c) => c.id),
);

describe("golden hands — contested rulings", () => {
  it("keeps a case on both sides of every ruling that can have one", () => {
    expect(RULINGS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(RULINGS.map((r) => r.id)).size).toBe(RULINGS.length);
    for (const r of RULINGS) {
      const cited = [...r.covers.shipped, ...r.covers.variant];
      if (cited.length === 0) {
        // Only a ruling that CANNOT have a fixture may have none, and it has to say why.
        expect(r.whyNoFixture, `${r.id} cites nothing and explains nothing`).toBeTruthy();
        continue;
      }
      expect(r.covers.shipped.length, `${r.id} has no shipped-side case`).toBeGreaterThan(0);
      expect(r.covers.variant.length, `${r.id} has no variant-side case`).toBeGreaterThan(0);
    }
  });

  it("cites only fixtures that exist, here or in a sibling family", () => {
    for (const r of RULINGS) {
      for (const id of [...r.covers.shipped, ...r.covers.variant]) {
        expect(SUITE_IDS.has(id), `${r.id} cites "${id}", which no family defines`).toBe(true);
      }
    }
  });

  it("states an impact, a recommendation and a status for every ruling", () => {
    for (const r of RULINGS) {
      expect(r.options.length, `${r.id}`).toBeGreaterThanOrEqual(2);
      expect(r.question).toMatch(/\?$/);
      expect(r.impact.length).toBeGreaterThan(40);
      expect(r.recommendation.length).toBeGreaterThan(40);
      expect(["decided", "accident", "open"]).toContain(r.status);
      expect(r.characters.length).toBeGreaterThan(0);
    }
  });

  it("has unique, family-prefixed ids and belongs to a real ruling", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(c.id).toMatch(/^contested-[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(RULINGS.some((r) => r.id === c.ruling), `${c.id} has no ruling`).toBe(true);
      expect(c.provisional).toBe(true); // §8 — nothing ships unvalidated
      expect(["hkos-standard", "liu"]).toContain(c.ruleset);
      if (c.ruleset === "liu") expect(c.description).toMatch(/LIU/);
      expect(c.reading.length).toBeGreaterThan(20);
      expect(c.contested, `${c.id} is in the contested family and says nothing`).toBeTruthy();
    }
  });

  it("keeps the shipped subset separable from the variants", () => {
    expect(SHIPPED_CASES.every((c) => c.side === "shipped")).toBe(true);
    expect(SHIPPED_CASES.length).toBeGreaterThan(0);
    expect(cases.some((c) => c.side === "variant")).toBe(true);
    // A shipped case never needs the preset changed — that is what makes it shipped.
    for (const c of SHIPPED_CASES) expect(Object.keys(c.values).length, c.id).toBe(0);
  });

  it("names the file that would have to change for every inexpressible variant", () => {
    for (const c of cases) {
      if (c.configurable) continue;
      expect(c.gap, `${c.id} is inexpressible and does not say what is missing`).toBeTruthy();
      expect(c.gap!.length).toBeGreaterThan(40);
    }
    // The headline of ./CONTESTED.md: most of the map is NOT config today.
    expect(CONFIG_GAPS.length).toBeGreaterThan(RULINGS.length / 3);
  });

  it("gives every uncatalogued award id a reason it is not in patterns.ts", () => {
    const used = new Set(cases.flatMap((c) => c.expected.awards));
    for (const id of Object.keys(UNCATALOGUED)) {
      expect(used.has(id), `${id} is documented as missing but no case uses it`).toBe(true);
      expect(UNCATALOGUED[id]!.length).toBeGreaterThan(60);
    }
  });

  for (const c of cases) {
    describe(c.id, () => {
      it("is well formed", () => {
        expect(() => assertWellFormed(c)).not.toThrow();
      });

      it("holds only real tile ids, with flowers kept apart and sorted tiles", () => {
        const all = [...c.concealed, c.winningTile, ...c.melds.flatMap((m) => m.tiles)];
        for (const t of all) {
          expect(t).toBeGreaterThanOrEqual(0);
          expect(t).toBeLessThan(SCORING_KINDS);
        }
        expect(all.every((t) => !isFlower(t))).toBe(true);
        expect(c.flowers.every(isFlower)).toBe(true);
        expect(new Set(c.flowers).size).toBe(c.flowers.length); // flowers are singletons
        expect(c.concealed).toEqual([...c.concealed].sort((a, b) => a - b));
        const n = counts(all);
        for (let i = 0; i < SCORING_KINDS; i++) expect(n[i]!).toBeLessThanOrEqual(4);
      });

      it("has the winning shape it claims", () => {
        const hand = counts([...c.concealed, c.winningTile]);
        if (c.shape === "sevenPairs") {
          // The whole ruling: seven pairs is NOT four sets and a pair, which is
          // why pricing it is not enough to make it a hand.
          expect(isComplete(hand, c.melds.length)).toBe(false);
          expect(hand.filter((k) => k === 2).length).toBe(7);
        } else if (c.shape === "thirteenOrphans") {
          expect(ORPHAN_KINDS.every((k) => hand[k]! >= 1)).toBe(true);
          expect(hand.reduce((a, b) => a + b, 0)).toBe(14);
        } else {
          expect(isComplete(hand, c.melds.length)).toBe(true);
        }
      });

      it("has legal melds", () => {
        for (const m of c.melds) {
          expect(m.tiles.length).toBe(m.kind === "kong" ? 4 : 3);
          expect(m.tiles).toEqual([...m.tiles].sort((a, b) => a - b));
          if (m.kind === "chow") {
            expect(m.tiles[1]).toBe(m.tiles[0]! + 1);
            expect(m.tiles[2]).toBe(m.tiles[0]! + 2);
            expect(m.from).toBe((c.seatWind + 3) % 4); // 上家 only
          } else {
            expect(new Set(m.tiles).size).toBe(1);
          }
          // 暗槓 is drawn complete, so its source seat is the owner's own (types.ts).
          if (m.concealed) {
            expect(m.kind).toBe("kong");
            expect(m.from).toBe(c.seatWind);
          } else {
            expect(m.from).not.toBe(c.seatWind);
          }
        }
      });

      it("adds up under its own reading's faan values", () => {
        const table = c.ruleset === "liu" ? LIU : HKOS;
        let raw = 0;
        for (const a of c.expected.awards) {
          const faan = c.values[a] ?? table[a];
          expect(faan, `${a} has no faan under this reading`).not.toBeUndefined();
          if (!(a in table)) expect(a in UNCATALOGUED, `${a} is not in patterns.ts`).toBe(true);
          raw += faan ?? 0;
        }
        expect(raw).toBe(c.rawFaan);
        expect(c.capped).toBe(c.rawFaan > 13); // 爆棚
        expect(c.expected.faan).toBe(Math.min(c.rawFaan, 13));
        expect(c.expected.legal).toBe(c.expected.faan >= 3); // the 3-faan floor
      });

      it("books the bonus-tile awards its flowers actually justify", () => {
        // 花糊 pays for the bonus tiles as a single event, so the ordinary
        // bookkeeping does not apply to it — that is the ruling.
        if (!c.expected.legal || c.expected.awards.includes("allEightBonusTiles")) return;
        expect(c.expected.awards.includes("noFlowers")).toBe(c.flowers.length === 0);
        const own = c.flowers.filter((f) => flowerSeat(f) === c.seatWind).length;
        const booked = c.expected.awards.filter((a) => a === "ownFlower" || a === "ownSeason");
        expect(booked.length).toBe(own);
      });

      it("agrees with itself about how it was won", () => {
        expect(c.isDealer).toBe(c.seatWind === 0); // seat index equals wind index
        if (c.robbedKong) expect(c.selfDraw).toBe(false); // 搶槓 is a discard win
        if (c.onKongReplacement) expect(c.selfDraw).toBe(true);
        if (c.unreachable) expect(c.expected.legal).toBe(false);
      });
    });
  }

  it("covers the rulings the audit and the design docs actually asked about", () => {
    const ids = new Set(RULINGS.map((r) => r.id));
    for (const id of [
      "seven-pairs",                    // ENGINE-AUDIT §1
      "four-concealed-pungs-on-discard", // hk-scoring.ts long note
      "concealed-kong-concealment",
      "rob-concealed-kong",
      "small-three-dragons-value",
      "small-four-winds-value",
      "all-eight-flowers",
      "self-draw-settlement",           // DESIGN.md §4, "settle before scoring ships"
    ]) {
      expect(ids.has(id), `no ruling for ${id}`).toBe(true);
    }
    // Both sides of the split, everywhere: no ruling may be single-sided.
    const bySide = new Map<string, Set<string>>();
    for (const c of cases) {
      if (!bySide.has(c.ruling)) bySide.set(c.ruling, new Set());
      bySide.get(c.ruling)!.add(c.side);
    }
    expect(bySide.size).toBeGreaterThanOrEqual(10);
  });
});

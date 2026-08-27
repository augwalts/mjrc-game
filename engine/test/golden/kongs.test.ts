/**
 * Structural guard over the kong golden hands (DESIGN.md §8). These do NOT
 * check faan — no scoring engine exists yet. They check that every fixture is
 * a physically legal 14-tile winning hand, so a miscounted case fails loudly
 * the moment it is written rather than silently teaching the scorer nonsense.
 */
import { describe, expect, it } from "vitest";
import { assertWellFormed } from "./case.js";
import { cases } from "./kongs.js";
import { counts, flowerSeat } from "../../src/tiles.js";
import { isComplete } from "../../src/ready.js";
import { FLOWERS_START, SCORING_KINDS } from "../../src/types.js";

describe("golden hands — kongs", () => {
  it("has the agreed number of cases, all provisional", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(25);
    for (const c of cases) expect(c.provisional).toBe(true);
  });

  it("uses unique, family-prefixed, kebab-case ids", () => {
    const seen = new Set<string>();
    for (const c of cases) {
      expect(c.id).toMatch(/^kongs-[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(seen.has(c.id)).toBe(false);
      seen.add(c.id);
    }
  });

  it("names a ruleset preset on every case", () => {
    for (const c of cases) expect(["hkos-standard", "liu"]).toContain(c.ruleset);
  });

  for (const c of cases) {
    describe(c.id, () => {
      it("is well formed", () => {
        expect(() => assertWellFormed(c)).not.toThrow();
      });

      it("holds only real tile ids, with flowers kept apart", () => {
        for (const t of [...c.concealed, c.winningTile]) {
          expect(t).toBeGreaterThanOrEqual(0);
          expect(t).toBeLessThan(SCORING_KINDS);
        }
        for (const f of c.flowers) {
          expect(f).toBeGreaterThanOrEqual(FLOWERS_START);
          expect(f).toBeLessThan(FLOWERS_START + 8);
        }
        // Flowers are singletons — the same bonus tile cannot be held twice.
        expect(new Set(c.flowers).size).toBe(c.flowers.length);
      });

      it("keeps the concealed tiles sorted", () => {
        expect(c.concealed).toEqual([...c.concealed].sort((a, b) => a - b));
      });

      it("has melds of the right size and shape", () => {
        for (const m of c.melds) {
          expect(m.tiles.length).toBe(m.kind === "kong" ? 4 : 3);
          expect(m.tiles).toEqual([...m.tiles].sort((a, b) => a - b));
          if (m.kind === "chow") {
            expect(m.tiles[1]).toBe(m.tiles[0]! + 1);
            expect(m.tiles[2]).toBe(m.tiles[0]! + 2);
          } else {
            expect(new Set(m.tiles).size).toBe(1);
          }
          // 暗槓 concealed is only ever true for a kong; 加槓 only for a kong
          // claimed from a discard (you cannot add onto a concealed pung).
          if (m.kind !== "kong") expect(m.concealed).toBe(false);
          if (m.addedToPung) {
            expect(m.kind).toBe("kong");
            expect(m.concealed).toBe(false);
          }
        }
      });

      it("never uses more than four copies of a tile", () => {
        const all = [...c.concealed, c.winningTile, ...c.melds.flatMap((m) => m.tiles)];
        const n = counts(all);
        for (let i = 0; i < SCORING_KINDS; i++) expect(n[i]!).toBeLessThanOrEqual(4);
      });

      it("decomposes into four sets and a pair", () => {
        expect(isComplete(counts([...c.concealed, c.winningTile]), c.melds.length)).toBe(true);
      });

      it("agrees with itself about how it was won", () => {
        // 搶槓 is only ever a win from a discard, and only off an added kong.
        if (c.robbedKong) expect(c.selfDraw).toBe(false);
        // A kong replacement comes off the wall, so it is always a self-draw.
        if (c.onKongReplacement) expect(c.selfDraw).toBe(true);
        // Seat index equals wind index in these fixtures: 東 deals.
        expect(c.isDealer).toBe(c.seatWind === 0);
      });

      it("books the bonus-tile awards its flowers actually justify", () => {
        // 無花 fires exactly when no bonus tile was drawn all hand.
        expect(c.expected.awards.includes("noFlowers")).toBe(c.flowers.length === 0);
        // 正花 fires exactly when a held flower matches the seat wind.
        const own = c.flowers.filter((f) => flowerSeat(f) === c.seatWind).length;
        expect(c.expected.awards.filter((a) => a === "ownFlower").length).toBe(own);
      });

      it("scores at or above the minimum exactly when it is marked legal", () => {
        expect(c.expected.legal).toBe(c.expected.faan >= 3);
        expect(c.expected.awards.length).toBe(new Set(c.expected.awards).size);
        for (const a of c.expected.awards) expect(a).toMatch(/^[a-z][A-Za-z0-9]*$/);
      });
    });
  }

  it("covers all three kong forms and both kong-specific situational wins", () => {
    const melds = cases.flatMap((c) => c.melds).filter((m) => m.kind === "kong");
    expect(melds.some((m) => !m.concealed && !m.addedToPung)).toBe(true); // 明槓
    expect(melds.some((m) => m.concealed)).toBe(true); // 暗槓
    expect(melds.some((m) => m.addedToPung)).toBe(true); // 加槓
    expect(cases.some((c) => c.robbedKong)).toBe(true); // 搶槓
    expect(cases.some((c) => c.onKongReplacement)).toBe(true); // 槓上開花
  });
});

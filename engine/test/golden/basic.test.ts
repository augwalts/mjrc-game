/**
 * Structural checks over the basic golden-hand family. These do NOT score
 * anything — the scoring engine does not exist yet. They exist so a malformed
 * fixture fails loudly the moment it is written rather than silently teaching
 * the future scorer the wrong answer (DESIGN.md §8).
 *
 * The strongest check here is completeness: every case's concealed tiles plus
 * the winning tile, counted against the meld total, must decompose to four
 * sets and a pair. That reuses the already-validated distanceToReady, so a
 * miscounted hand cannot survive.
 */
import { describe, expect, it } from "vitest";
import { SCORING_KINDS, type TileId } from "../../src/types.js";
import { counts, isFlower, isRun } from "../../src/tiles.js";
import { isComplete } from "../../src/ready.js";
import { assertWellFormed } from "./case.js";
import { cases } from "./basic.js";

/** Every tile the winner can account for: hand, winning tile, melds. */
const allTiles = (c: (typeof cases)[number]): TileId[] => [
  ...c.concealed,
  c.winningTile,
  ...c.melds.flatMap((meld) => meld.tiles),
];

describe("basic golden cases", () => {
  it("has a properly sized family with unique, prefixed ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(25);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) expect(c.id).toMatch(/^basic-[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s is well formed", (_id, c) => {
    expect(() => assertWellFormed(c)).not.toThrow();
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s is a complete 14-tile hand", (_id, c) => {
    // Kongs would need care here (four tiles, one meld); this family has none.
    expect(c.melds.every((meld) => meld.kind !== "kong")).toBe(true);
    expect(isComplete(counts([...c.concealed, c.winningTile]), c.melds.length)).toBe(true);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s uses at most four of any tile", (_id, c) => {
    const seen = counts(allTiles(c));
    for (let i = 0; i < SCORING_KINDS; i++) expect(seen[i]).toBeLessThanOrEqual(4);
    const flowers = c.flowers;
    expect(flowers.every(isFlower)).toBe(true);
    expect(new Set(flowers).size).toBe(flowers.length); // flowers are singletons
    expect(allTiles(c).every((t) => !isFlower(t))).toBe(true);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s has legal melds", (_id, c) => {
    for (const meld of c.melds) {
      if (meld.kind === "chow") {
        const [a, b, d] = meld.tiles as [TileId, TileId, TileId];
        expect(isRun(a, b, d)).toBe(true);
        // 上家 only: a chow comes from the seat immediately before you.
        expect(meld.from).toBe((c.seatWind + 3) % 4);
      } else {
        expect(new Set(meld.tiles).size).toBe(1);
        expect(meld.tiles.length).toBe(3);
      }
      expect(meld.concealed).toBe(false);
      expect(meld.from).not.toBe(c.seatWind); // a claimed meld came from someone else
    }
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s states its context honestly", (_id, c) => {
    expect(c.provisional).toBe(true); // §8 — nothing ships unvalidated
    expect(c.ruleset === "hkos-standard" || c.ruleset === "liu").toBe(true);
    if (c.ruleset === "liu") expect(c.description).toMatch(/LIU/);
    // The winner's seat index and seat wind are the same thing in these
    // fixtures, so the dealer is exactly the seat holding 東.
    expect(c.isDealer).toBe(c.seatWind === 0);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s respects the 3-faan floor", (_id, c) => {
    // Both presets carry a 3-faan minimum (DESIGN.md §4, ENGINE-AUDIT §1).
    expect(c.expected.legal).toBe(c.expected.faan >= 3);
    expect(c.expected.faan).toBeGreaterThanOrEqual(0);
    expect(c.expected.faan).toBeLessThanOrEqual(13); // 爆棚 limit
  });

  it("covers the family: chicken hands, both floors and both flush levels", () => {
    const refused = cases.filter((c) => !c.expected.legal);
    expect(refused.length).toBeGreaterThanOrEqual(6);
    expect(refused.some((c) => c.expected.faan === 0)).toBe(true); // true 雞糊
    expect(cases.filter((c) => c.expected.faan === 3).length).toBeGreaterThanOrEqual(4);
    const awarded = new Set(cases.flatMap((c) => c.expected.awards));
    for (const id of ["allChows", "allPungs", "halfFlush", "fullFlush", "concealedHand",
                      "selfDraw", "seatWind", "roundWind", "dragonPung", "mixedTerminals",
                      "ownFlower", "noFlowers"]) {
      expect(awarded.has(id)).toBe(true);
    }
  });

  it("flags the contested rulings instead of hiding them", () => {
    const contested = cases.filter((c) => c.contested);
    expect(contested.length).toBeGreaterThanOrEqual(5);
    for (const c of contested) expect(c.contested!.length).toBeGreaterThan(20);
  });
});

/**
 * Structural checks over the flush golden-hand family. Nothing here scores a
 * hand — the scoring engine does not exist yet. These exist so a malformed
 * fixture fails the moment it is written instead of quietly teaching the future
 * scorer the wrong answer (DESIGN.md §8).
 *
 * The load-bearing check is completeness: concealed tiles plus the winning
 * tile, counted against the meld total, must decompose into four sets and a
 * pair. That runs through the already-validated distanceToReady, so miscounted
 * tile arithmetic cannot survive. Unlike basic.ts, this family carries kongs,
 * so meld validation has to handle four-tile melds and all three kong forms.
 */
import { describe, expect, it } from "vitest";
import { SCORING_KINDS, type TileId } from "../../src/types.js";
import { counts, isFlower, isHonour, isRun, isSuited, isTerminalOrHonour, suitOf } from "../../src/tiles.js";
import { isComplete } from "../../src/ready.js";
import { assertWellFormed } from "./case.js";
import { cases } from "./flush.js";

type Case = (typeof cases)[number];

/** Every tile the winner can account for: hand, winning tile, melds. */
const allTiles = (c: Case): TileId[] => [
  ...c.concealed,
  c.winningTile,
  ...c.melds.flatMap((meld) => meld.tiles),
];

/** The suits actually present, honours excluded — a flush is about SUITS. */
const suitsIn = (c: Case): Set<string> =>
  new Set(allTiles(c).filter(isSuited).map(suitOf));

describe("flush golden cases", () => {
  it("has a properly sized family with unique, prefixed ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(25);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) expect(c.id).toMatch(/^flush-[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s is well formed", (_id, c) => {
    expect(() => assertWellFormed(c)).not.toThrow();
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s is a complete 14-tile hand", (_id, c) => {
    // A kong is one set holding four tiles; the fourth sits outside the 14, so
    // the concealed side plus the winning tile still decomposes against
    // melds.length whatever the meld kinds are.
    expect(isComplete(counts([...c.concealed, c.winningTile]), c.melds.length)).toBe(true);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s uses at most four of any tile", (_id, c) => {
    const seen = counts(allTiles(c));
    for (let i = 0; i < SCORING_KINDS; i++) expect(seen[i]).toBeLessThanOrEqual(4);
    expect(c.flowers.every(isFlower)).toBe(true);
    expect(new Set(c.flowers).size).toBe(c.flowers.length); // flowers are singletons
    expect(allTiles(c).every((t) => !isFlower(t))).toBe(true);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s has legal melds", (_id, c) => {
    for (const meld of c.melds) {
      if (meld.kind === "chow") {
        const [a, b, d] = meld.tiles as [TileId, TileId, TileId];
        expect(isRun(a, b, d)).toBe(true);
        // 上家 only: a chow may be claimed from the seat immediately before you.
        expect(meld.from).toBe((c.seatWind + 3) % 4);
        expect(meld.concealed).toBe(false);
      } else {
        expect(new Set(meld.tiles).size).toBe(1);
        expect(meld.tiles.length).toBe(meld.kind === "kong" ? 4 : 3);
      }
      if (meld.concealed) {
        // Only a kong is ever concealed, and 暗槓 comes from four already held,
        // so its source seat is the owner.
        expect(meld.kind).toBe("kong");
        expect(meld.from).toBe(c.seatWind);
      } else {
        expect(meld.from).not.toBe(c.seatWind); // claimed from someone else
      }
      // 加槓 only ever upgrades an exposed pung, so it is never concealed.
      if (meld.addedToPung) {
        expect(meld.kind).toBe("kong");
        expect(meld.concealed).toBe(false);
      }
    }
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s states its context honestly", (_id, c) => {
    expect(c.provisional).toBe(true); // §8 — nothing ships unvalidated
    expect(c.ruleset === "hkos-standard" || c.ruleset === "liu").toBe(true);
    expect(c.isDealer).toBe(c.seatWind === 0); // seat index equals wind index here
    // A flower matching the winner's own seat is 正花 and pays 1 faan, so any
    // case holding one must say so. These fixtures deliberately hold other
    // seats' flowers to keep the arithmetic about flushes.
    for (const f of c.flowers) expect((f - 34) % 4).not.toBe(c.seatWind);
    expect(c.expected.awards).not.toContain("ownFlower");
    // ...and by the same token, no flowers at all would be 無花, also 1 faan.
    if (c.flowers.length === 0) expect(c.expected.awards).toContain("noFlowers");
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s respects the floor and the limit", (_id, c) => {
    expect(c.expected.legal).toBe(c.expected.faan >= 3); // 3-faan minimum, §4
    expect(c.expected.faan).toBeGreaterThanOrEqual(0);
    expect(c.expected.faan).toBeLessThanOrEqual(13); // 爆棚
  });

  /* ── the family's own invariants: an award must match the tiles ─────────── */

  it.each(cases.map((c) => [c.id, c] as const))("%s awards flushes consistently", (_id, c) => {
    const tiles = allTiles(c);
    const suits = suitsIn(c);
    const hasHonour = tiles.some(isHonour);
    const { awards } = c.expected;

    if (awards.includes("fullFlush")) {
      expect(suits.size).toBe(1);
      expect(hasHonour).toBe(false);
      expect(awards).not.toContain("halfFlush");
    }
    if (awards.includes("halfFlush")) {
      expect(suits.size).toBe(1);
      expect(hasHonour).toBe(true);
    }
    // The converse, which is what actually catches a mis-scored fixture: a hand
    // confined to one suit must claim the flush it earned — unless a limit hand
    // that subsumes the flush claims it instead (audit D1: 九蓮寶燈 ⊃ 清一色).
    if (suits.size === 1) {
      const subsumers = ["nineGates", "fourConcealedPungs"];
      const covered = awards.some((a) => subsumers.includes(a));
      expect(covered || awards.includes(hasHonour ? "halfFlush" : "fullFlush")).toBe(true);
    }
    if (suits.size > 1) {
      expect(awards).not.toContain("halfFlush");
      expect(awards).not.toContain("fullFlush");
    }
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s awards the purity hands consistently", (_id, c) => {
    const tiles = allTiles(c);
    const { awards } = c.expected;

    // 字一色 — honours only, so no suited tile anywhere.
    expect(awards.includes("allHonours")).toBe(tiles.every(isHonour));
    // 清么九 — terminals only. 混么九 allows honours; 清么九 does not.
    const allTerminalOrHonour = tiles.every(isTerminalOrHonour);
    expect(awards.includes("allTerminals")).toBe(allTerminalOrHonour && tiles.every(isSuited));
    if (awards.includes("mixedTerminals")) {
      expect(allTerminalOrHonour).toBe(true);
      expect(tiles.some(isHonour)).toBe(true); // otherwise it is 清么九
    }
    // Subsumption, per rulesets/src/patterns.ts: a subsumed pattern is not
    // listed at all. Both purity hands are all-pungs by construction and must
    // NOT be paid for it a second time; 字一色 swallows 混一色 the same way.
    if (awards.includes("allHonours")) {
      expect(awards).not.toContain("allPungs");
      expect(awards).not.toContain("halfFlush");
      expect(awards).not.toContain("fullFlush");
      expect(awards).not.toContain("mixedTerminals");
    }
    if (awards.includes("allTerminals")) {
      expect(awards).not.toContain("allPungs");
      expect(awards).not.toContain("mixedTerminals");
    }
  });

  it("covers the family properly", () => {
    const awarded = cases.flatMap((c) => c.expected.awards);
    for (const id of ["halfFlush", "fullFlush", "allHonours", "allTerminals", "mixedTerminals",
                      "allPungs", "allChows", "concealedHand", "selfDraw", "seatWind",
                      "roundWind", "dragonPung", "robbingKong", "winOnLastTile"]) {
      expect(awarded).toContain(id);
    }
    // Both flushes in all three suits, concealed and melded.
    for (const flush of ["halfFlush", "fullFlush"] as const) {
      const inFlush = cases.filter((c) => c.expected.awards.includes(flush));
      expect(new Set(inFlush.flatMap((c) => [...suitsIn(c)])).size).toBe(3);
      expect(inFlush.some((c) => c.melds.length === 0)).toBe(true);
      expect(inFlush.some((c) => c.melds.length > 0)).toBe(true);
    }
    // All three kong forms appear over a flush.
    const melds = cases.flatMap((c) => c.melds);
    expect(melds.some((k) => k.kind === "kong" && k.concealed)).toBe(true);
    expect(melds.some((k) => k.kind === "kong" && !k.concealed && !k.addedToPung)).toBe(true);
    expect(melds.some((k) => k.addedToPung)).toBe(true);
    // The refused hand: one suit short of a flush and under the floor.
    expect(cases.some((c) => !c.expected.legal)).toBe(true);
    // The pair that isolates the winning tile's effect on which flush applies.
    const half = cases.find((c) => c.id === "flush-pair-decides-half")!;
    const full = cases.find((c) => c.id === "flush-pair-decides-full")!;
    expect(half.melds).toEqual(full.melds);
    expect(full.expected.faan - half.expected.faan).toBe(3);
  });

  it("flags the contested rulings instead of hiding them", () => {
    const contested = cases.filter((c) => c.contested);
    expect(contested.length).toBeGreaterThanOrEqual(5);
    for (const c of contested) expect(c.contested!.length).toBeGreaterThan(20);
    // Every 清一色 case must carry the 6-vs-7 split; it is not settled.
    for (const c of cases.filter((x) => x.expected.awards.includes("fullFlush"))) {
      expect(c.contested).toBeTruthy();
    }
  });
});

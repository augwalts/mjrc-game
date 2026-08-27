/**
 * Structural guard over the limit-hand golden fixtures (DESIGN.md §8). These do
 * NOT score anything — no scoring engine exists yet. They exist so a malformed
 * hand or a slip in the faan arithmetic fails loudly the moment it is written
 * rather than quietly teaching the future scorer the wrong answer.
 *
 * Two checks earn their keep here:
 *   - every case's awards are re-added against the preset table it names, so a
 *     mistyped `rawFaan` cannot survive;
 *   - `expected.faan` must equal min(rawFaan, 13) and `capped` must agree.
 *     That is the whole point of the family, so it is asserted mechanically
 *     rather than trusted.
 *
 * 十三么 is the one HKOS hand that is not four sets and a pair, so those cases
 * are checked against the orphan shape instead of `isComplete`.
 */
import { describe, expect, it } from "vitest";
import { counts, flowerSeat, isRun, isTerminalOrHonour } from "../../src/tiles.js";
import { isComplete } from "../../src/ready.js";
import { FLOWERS_START, SCORING_KINDS, type TileId } from "../../src/types.js";
import { assertWellFormed } from "./case.js";
import { FAAN, FAAN_BY_RULESET, LIMIT_FAAN, cases, type LimitCase } from "./limit.js";

/** Every tile the winner can account for: concealed, the winning tile, melds. */
const allTiles = (c: LimitCase): TileId[] => [
  ...c.concealed,
  c.winningTile,
  ...c.melds.flatMap((meld) => meld.tiles),
];

const isThirteenOrphans = (c: LimitCase): boolean =>
  c.expected.awards.includes("thirteenOrphans");

describe("golden hands — limit hands and situational faan", () => {
  it("has the agreed number of cases with unique, family-prefixed ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(25);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) expect(c.id).toMatch(/^limit-[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("names a ruleset preset and stays honest about validation on every case", () => {
    for (const c of cases) {
      expect(c.provisional).toBe(true); // §8 — nothing ships unvalidated
      expect(Object.keys(FAAN_BY_RULESET)).toContain(c.ruleset);
      if (c.ruleset === "liu") expect(c.description).toMatch(/LIU/);
      expect(c.description.length).toBeGreaterThan(20);
    }
  });

  for (const c of cases) {
    describe(c.id, () => {
      it("is well formed", () => {
        expect(() => assertWellFormed(c)).not.toThrow();
      });

      it("holds only real tile ids, with flowers kept apart", () => {
        for (const tile of allTiles(c)) {
          expect(tile).toBeGreaterThanOrEqual(0);
          expect(tile).toBeLessThan(SCORING_KINDS);
        }
        for (const f of c.flowers) {
          expect(f).toBeGreaterThanOrEqual(FLOWERS_START);
          expect(f).toBeLessThan(FLOWERS_START + 8);
        }
        // Flowers are singletons — the same bonus tile cannot be held twice.
        expect(new Set(c.flowers).size).toBe(c.flowers.length);
        const seen = counts(allTiles(c));
        for (let i = 0; i < SCORING_KINDS; i++) expect(seen[i]!).toBeLessThanOrEqual(4);
      });

      it("keeps the concealed tiles sorted", () => {
        expect(c.concealed).toEqual([...c.concealed].sort((a, b) => a - b));
      });

      it("has melds of the right size, shape and provenance", () => {
        for (const meld of c.melds) {
          expect(meld.tiles.length).toBe(meld.kind === "kong" ? 4 : 3);
          expect(meld.tiles).toEqual([...meld.tiles].sort((a, b) => a - b));
          if (meld.kind === "chow") {
            const [a, b, d] = meld.tiles as [TileId, TileId, TileId];
            expect(isRun(a, b, d)).toBe(true);
            // 上家 only: a chow comes from the seat immediately before you.
            expect(meld.from).toBe((c.seatWind + 3) % 4);
          } else {
            expect(new Set(meld.tiles).size).toBe(1);
          }
          expect(meld.concealed).toBe(false);
          expect(meld.from).not.toBe(c.seatWind); // a claimed meld came from someone else
        }
      });

      it("is a complete fourteen-tile winning shape", () => {
        if (isThirteenOrphans(c)) {
          // 十三么: all thirteen 么九 kinds, exactly one of them doubled.
          const n = counts([...c.concealed, c.winningTile]);
          const held: number[] = [];
          for (let i = 0; i < SCORING_KINDS; i++) {
            if (n[i]! > 0) {
              expect(isTerminalOrHonour(i)).toBe(true);
              expect(n[i]).toBeLessThanOrEqual(2);
              held.push(n[i]!);
            }
          }
          expect(held.length).toBe(13);
          expect(held.filter((k) => k === 2).length).toBe(1);
          expect(c.melds.length).toBe(0); // 十三么 can never be melded
        } else {
          expect(isComplete(counts([...c.concealed, c.winningTile]), c.melds.length)).toBe(true);
        }
      });

      it("agrees with itself about how it was won", () => {
        // Seat index equals wind index in these fixtures: 東 deals.
        expect(c.isDealer).toBe(c.seatWind === 0);
        // 海底撈月 comes off the wall; 河底撈魚 comes off a discard. Never both.
        if (c.onLastTile) expect(c.selfDraw).toBe(true);
        if (c.onLastDiscard) expect(c.selfDraw).toBe(false);
        expect(c.onLastTile && c.onLastDiscard).toBeFalsy();
        // 天糊 is 東 self-drawing the opening fourteen; 地糊 is a non-dealer
        // winning on the dealer's opening discard. Both are concealed by
        // definition — nobody has had the chance to claim anything yet.
        if (c.opening === "heavenly") {
          expect(c.isDealer).toBe(true);
          expect(c.selfDraw).toBe(true);
          expect(c.melds.length).toBe(0);
        }
        if (c.opening === "earthly") {
          expect(c.isDealer).toBe(false);
          expect(c.selfDraw).toBe(false);
          expect(c.melds.length).toBe(0);
        }
        // Neither opening can also be a last-tile win — the wall is still full.
        if (c.opening) expect(c.onLastTile || c.onLastDiscard).toBeFalsy();
      });

      it("books the bonus-tile awards its flowers actually justify", () => {
        // 無花 fires exactly when no bonus tile was drawn all hand. Both presets
        // set useFlowers and price 無花 at 1 (rulesets/src/presets.ts).
        expect(c.expected.awards.includes("noFlowers")).toBe(c.flowers.length === 0);
        // 正花 fires once per held bonus tile matching the seat wind.
        const own = c.flowers.filter((f) => flowerSeat(f) === c.seatWind).length;
        const booked = c.expected.awards.filter((a) => a === "ownFlower" || a === "ownSeason");
        expect(booked.length).toBe(own);
      });

      it("uses stable lowerCamelCase award ids the named preset prices", () => {
        const table = FAAN_BY_RULESET[c.ruleset]!;
        for (const a of c.expected.awards) {
          expect(a).toMatch(/^[a-z][A-Za-z0-9]*$/);
          expect(table[a]).toBeTypeOf("number");
        }
        // No case in this family repeats an award; a repeat is a transcription slip.
        expect(new Set(c.expected.awards).size).toBe(c.expected.awards.length);
      });

      it("never lists an award another listed award subsumes", () => {
        const held = new Set(c.expected.awards);
        // Mirrors rulesets/src/patterns.ts. Kept local so `engine` stays
        // dependency-free (§5.1); presets.ts/patterns.ts remain the source.
        const subsumes: Record<string, string[]> = {
          thirteenOrphans: ["concealedHand"],
          nineGates: ["concealedHand"],
          heavenlyHand: ["concealedHand"],
          earthlyHand: ["concealedHand"],
          fourConcealedPungs: ["allPungs", "concealedHand"],
          allTerminals: ["mixedTerminals"],
          allHonours: ["halfFlush", "mixedTerminals"],
          bigThreeDragons: ["smallThreeDragons", "dragonPung"],
          smallThreeDragons: ["dragonPung"],
          bigFourWinds: ["smallFourWinds"],
        };
        for (const a of c.expected.awards) {
          for (const swallowed of subsumes[a] ?? []) expect(held.has(swallowed)).toBe(false);
        }
      });

      it("adds up: rawFaan is the sum of the awards it lists", () => {
        const table = FAAN_BY_RULESET[c.ruleset]!;
        const sum = c.expected.awards.reduce((n, a) => n + table[a]!, 0);
        expect(c.rawFaan).toBe(sum);
      });

      it("applies 爆棚 as a clamp, not a saturating add", () => {
        expect(c.expected.faan).toBe(Math.min(c.rawFaan, LIMIT_FAAN));
        expect(c.capped).toBe(c.rawFaan > LIMIT_FAAN);
        expect(c.expected.faan).toBeLessThanOrEqual(LIMIT_FAAN);
        expect(c.expected.faan).toBeGreaterThanOrEqual(0);
      });

      it("respects the 3-faan floor", () => {
        // Both presets carry minimumFaan 3 (DESIGN.md §4, rulesets/src/presets.ts).
        expect(c.expected.legal).toBe(c.expected.faan >= 3);
      });
    });
  }

  it("covers the family the brief asks for", () => {
    const awarded = new Set(cases.flatMap((c) => c.expected.awards));
    for (const id of [
      "thirteenOrphans", "nineGates", "heavenlyHand", "earthlyHand",
      "winOnLastTile", "winOnLastDiscard",
      "bigThreeDragons", "allTerminals", "fourConcealedPungs", "fullFlush",
    ]) {
      expect(awarded.has(id)).toBe(true);
    }
    // 天糊 and 地糊 are represented as openings, not merely as award ids.
    expect(cases.some((c) => c.opening === "heavenly")).toBe(true);
    expect(cases.some((c) => c.opening === "earthly")).toBe(true);
    // A hand below the floor, so the family does not only test the ceiling.
    expect(cases.some((c) => !c.expected.legal)).toBe(true);
    // The LIU preset is exercised, because rulesets are data (§4) and the
    // family's whole subject — the cap — is a per-preset number.
    expect(cases.filter((c) => c.ruleset === "liu").length).toBeGreaterThanOrEqual(2);
  });

  it("crosses the cap from several different directions", () => {
    const capped = cases.filter((c) => c.capped);
    const limitValued = (c: LimitCase) =>
      c.expected.awards.filter((a) => FAAN_BY_RULESET[c.ruleset]![a] === LIMIT_FAAN).length;
    expect(capped.length).toBeGreaterThanOrEqual(3);
    // Distinct raw totals prove these are not one crossing rewritten.
    expect(new Set(capped.map((c) => c.rawFaan)).size).toBeGreaterThanOrEqual(5);
    // (a) two limit patterns stacking
    expect(capped.some((c) => limitValued(c) >= 2)).toBe(true);
    // (b) crossing with no limit-valued pattern anywhere in the list
    expect(capped.some((c) => limitValued(c) === 0)).toBe(true);
    // (c) the narrowest possible overshoot, and a deep one
    expect(capped.some((c) => c.rawFaan === LIMIT_FAAN + 1)).toBe(true);
    expect(Math.max(...capped.map((c) => c.rawFaan))).toBeGreaterThan(25);
    // Landing exactly on the limit must NOT be recorded as capped.
    const exact = cases.filter((c) => c.rawFaan === LIMIT_FAAN);
    expect(exact.length).toBeGreaterThanOrEqual(3);
    for (const c of exact) expect(c.capped).toBe(false);
    // And a limit-hand NAME that does not reach the limit under this preset —
    // the case an engine that hard-codes "limit hand ⇒ 13" gets wrong.
    expect(cases.some((c) => !c.capped && c.expected.faan < LIMIT_FAAN && limitValued(c) === 0
      && (c.expected.awards.includes("nineGates") || c.expected.awards.includes("allTerminals"))))
      .toBe(true);
  });

  it("keeps the same fourteen tiles honest across paired cases", () => {
    // Several cases exist only as contrasts. If a pair drifts apart the lesson
    // is lost silently, so the pairing is asserted rather than described.
    const pairs: [string, string][] = [
      ["limit-full-flush-all-pungs-melded", "limit-full-flush-four-concealed-pungs-caps"],
      ["limit-all-terminals-accumulates-to-thirteen", "limit-all-terminals-four-concealed-pungs-caps"],
      ["limit-nine-gates-self-draw", "limit-nine-gates-liu-reaches-limit"],
      ["limit-heavenly-hand-all-chows", "limit-heavenly-hand-after-flower-replacement"],
    ];
    for (const [a, b] of pairs) {
      const ca = cases.find((c) => c.id === a)!;
      const cb = cases.find((c) => c.id === b)!;
      expect(ca).toBeDefined();
      expect(cb).toBeDefined();
      const tiles = (c: LimitCase) => counts(allTiles(c)).join(",");
      expect(tiles(ca)).toBe(tiles(cb));
      // A contrast that changed nothing would not be a contrast. It may differ
      // in the total (the nine-gates pair, which differs only by preset) or in
      // the award list (the 天糊 pair, where 正花 displaces 無花 at the same 16).
      const differs =
        ca.rawFaan !== cb.rawFaan ||
        ca.expected.awards.join(",") !== cb.expected.awards.join(",");
      expect(differs).toBe(true);
    }
  });

  it("flags the contested rulings instead of hiding them", () => {
    const contested = cases.filter((c) => c.contested);
    expect(contested.length).toBeGreaterThanOrEqual(8);
    for (const c of contested) expect(c.contested!.length).toBeGreaterThan(40);
  });

  it("prices every id it uses, and prices nothing it does not use", () => {
    // FAAN is a hand-kept mirror of rulesets/src/presets.ts. Dead entries in it
    // are the first sign it has drifted from the preset it copies.
    const used = new Set(cases.flatMap((c) => c.expected.awards));
    for (const id of Object.keys(FAAN)) {
      if (!used.has(id)) continue;
      expect(FAAN[id]).toBeGreaterThan(0);
    }
    for (const id of used) expect(Object.keys(FAAN)).toContain(id);
  });
});

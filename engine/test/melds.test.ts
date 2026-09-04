import { describe, expect, it } from "vitest";
import {
  MELD_LABELS, allMeldTiles, canAddedKong, canConcealedKong, canExposedKong, canPung,
  chowOptions, findExposedPung, isConcealedSet, isLegalMeld, isTripletLike, leftOf,
  makeAddedKong, makeChow, makeConcealedKong, makeExposedKong, makePung, meldBaseTile,
  meldContains, meldError, meldForm, meldShapeError, meldTileCount, opensRobKongWindow,
  sourceSeat, upgradePungToKong,
} from "../src/melds.js";
import type { Meld } from "../src/types.js";

// Tile ids (types.ts): 萬 0-8, 索 9-17, 筒 18-26, 東南西北 27-30, 中發白 31-33, 花 34+.
const M = (n: number) => n - 1;        // n萬
const S = (n: number) => 8 + n;        // n索
const EAST = 27, RED = 31, PLUM = 34;

describe("seat geometry", () => {
  it("puts 上家 one seat back in the turn order", () => {
    // Turn order is 東 → 南 → 西 → 北, so seat 1 chows only from seat 0.
    expect(leftOf(0)).toBe(3);
    expect(leftOf(1)).toBe(0);
    expect(leftOf(2)).toBe(1);
    expect(leftOf(3)).toBe(2);
  });
});

describe("chow 上", () => {
  it("builds from 上家 and sorts its tiles", () => {
    const m = makeChow([M(3), M(1), M(2)], 1, 0);
    expect(m.tiles).toEqual([M(1), M(2), M(3)]);
    expect(m.concealed).toBe(false);
    expect(meldForm(m)).toBe("chow");
    expect(MELD_LABELS[meldForm(m)]).toBe("上");
  });
  it("refuses a claim from any seat but 上家", () => {
    // The single hardest claim rule to get wrong quietly (DESIGN.md §4).
    expect(() => makeChow([M(1), M(2), M(3)], 1, 2)).toThrow(/上家/);
    expect(() => makeChow([M(1), M(2), M(3)], 1, 3)).toThrow(/上家/);
  });
  it("refuses tiles that are not a run", () => {
    expect(() => makeChow([M(1), M(2), M(4)], 1, 0)).toThrow(/not a run/);
    expect(() => makeChow([M(8), M(9), S(1)], 1, 0)).toThrow(/not a run/); // across a suit edge
    expect(() => makeChow([EAST, EAST + 1, EAST + 2], 1, 0)).toThrow(/not a run/);
  });
  it("is never concealed", () => {
    const bad: Meld = { kind: "chow", tiles: [M(1), M(2), M(3)], from: 0, concealed: true };
    expect(meldShapeError(bad)).toMatch(/never concealed/);
  });
});

describe("pung 碰", () => {
  it("builds from any seat's discard", () => {
    for (const from of [0, 2, 3] as const) {
      const m = makePung(RED, 1, from);
      expect(m.tiles).toEqual([RED, RED, RED]);
      expect(sourceSeat(m)).toBe(from);
    }
  });
  it("refuses to name the owner as the source", () => {
    expect(() => makePung(RED, 1, 1)).toThrow(/came from/);
  });
  it("is not a meld when it is only a triplet in hand", () => {
    const bad: Meld = { kind: "pung", tiles: [RED, RED, RED], from: 1, concealed: true };
    expect(meldShapeError(bad)).toMatch(/暗槓/);
  });
});

describe("kong 槓 — all three forms", () => {
  const exposed = makeExposedKong(RED, 2, 0);
  const concealed = makeConcealedKong(RED, 2);
  const added = makeAddedKong(makePung(RED, 2, 3), 2);

  it("distinguishes 明槓 暗槓 加槓", () => {
    expect(meldForm(exposed)).toBe("exposedKong");
    expect(meldForm(concealed)).toBe("concealedKong");
    expect(meldForm(added)).toBe("addedKong");
    expect(MELD_LABELS[meldForm(added)]).toBe("加槓");
  });
  it("holds four tiles but fills one set slot", () => {
    expect(meldTileCount(exposed)).toBe(4);
    expect(meldTileCount(makePung(RED, 2, 0))).toBe(3);
    expect(meldTileCount(makeChow([M(1), M(2), M(3)], 1, 0))).toBe(3);
    expect(concealed.tiles).toHaveLength(4);
  });
  it("only 暗槓 counts as a concealed set", () => {
    expect(isConcealedSet(concealed)).toBe(true);
    expect(isConcealedSet(exposed)).toBe(false);
    expect(isConcealedSet(added)).toBe(false);   // inherits the pung's exposure
    expect(isConcealedSet(makePung(RED, 2, 0))).toBe(false);
  });
  it("reports the source seat, and none for 暗槓", () => {
    expect(sourceSeat(exposed)).toBe(0);
    expect(sourceSeat(concealed)).toBeNull();
    expect(sourceSeat(added)).toBe(3);           // the original pung's discarder
  });
  it("opens the 搶槓 window only for 加槓", () => {
    expect(opensRobKongWindow(added)).toBe(true);
    expect(opensRobKongWindow(exposed)).toBe(false);
    expect(opensRobKongWindow(concealed)).toBe(false);
  });
  it("refuses a 暗槓 that names another seat, and a kong that is both forms", () => {
    const wrongSource: Meld = { kind: "kong", tiles: [RED, RED, RED, RED], from: 0, concealed: true };
    expect(meldError(wrongSource, 2)).toMatch(/claims nothing/);
    const both: Meld = {
      kind: "kong", tiles: [RED, RED, RED, RED], from: 2, concealed: true, addedToPung: true,
    };
    expect(meldShapeError(both)).toMatch(/never both/);
  });
  it("refuses 加槓 on anything but a pung", () => {
    expect(() => makeAddedKong(makeChow([M(1), M(2), M(3)], 1, 0), 1)).toThrow(/碰/);
  });
});

describe("meld inspection", () => {
  const chow = makeChow([M(4), M(5), M(6)], 1, 0);
  const pung = makePung(EAST, 1, 3);
  it("reports base tile, membership and triplet-likeness", () => {
    expect(meldBaseTile(chow)).toBe(M(4));
    expect(meldBaseTile(pung)).toBe(EAST);
    expect(meldContains(chow, M(5))).toBe(true);
    expect(meldContains(chow, M(7))).toBe(false);
    expect(isTripletLike(pung)).toBe(true);
    expect(isTripletLike(chow)).toBe(false);
  });
  it("flattens meld tiles for visibility counting", () => {
    expect(allMeldTiles([chow, pung])).toEqual([M(4), M(5), M(6), EAST, EAST, EAST]);
  });
  it("refuses flowers 花 in a meld", () => {
    const bad: Meld = { kind: "pung", tiles: [PLUM, PLUM, PLUM], from: 0, concealed: false };
    expect(meldShapeError(bad)).toMatch(/flowers/);
  });
  it("isLegalMeld agrees with meldError", () => {
    expect(isLegalMeld(chow, 1)).toBe(true);
    expect(isLegalMeld(chow, 2)).toBe(false);
    expect(meldError(chow, 1)).toBeNull();
  });
});

describe("legality against a hand", () => {
  it("needs the fourth copy for a kong", () => {
    const three = [RED, RED, RED, M(1)];
    expect(canPung(three, RED)).toBe(true);
    expect(canExposedKong(three, RED)).toBe(true);      // discard supplies the fourth
    expect(canConcealedKong(three, RED)).toBe(false);   // 暗槓 needs all four in hand
    expect(canConcealedKong([RED, RED, RED, RED], RED)).toBe(true);
    expect(canExposedKong([RED, RED, M(1)], RED)).toBe(false);
    expect(canPung([RED, M(1)], RED)).toBe(false);
  });
  it("needs the matching exposed pung for 加槓", () => {
    const melds = [makePung(RED, 1, 0), makeChow([M(1), M(2), M(3)], 1, 0)];
    expect(canAddedKong([RED, M(9)], melds, RED)).toBe(true);
    expect(canAddedKong([M(9)], melds, RED)).toBe(false);          // fourth copy missing
    expect(canAddedKong([EAST], melds, EAST)).toBe(false);         // no pung to add to
    expect(findExposedPung(melds, RED)?.kind).toBe("pung");
    expect(findExposedPung(melds, EAST)).toBeUndefined();
  });
  it("upgrades an exposed pung in place, keeping the original source seat", () => {
    const melds = [makeChow([M(1), M(2), M(3)], 1, 0), makePung(RED, 1, 3)];
    const after = upgradePungToKong(melds, RED, 1);
    expect(after).toHaveLength(2);
    expect(meldForm(after[1]!)).toBe("addedKong");
    expect(after[1]!.from).toBe(3);
    expect(melds[1]!.kind).toBe("pung");   // input untouched
    expect(() => upgradePungToKong(melds, EAST, 1)).toThrow(/加槓/);
  });
});

describe("chowOptions", () => {
  it("offers every way the discard fits, low middle and high", () => {
    // Hand 1萬2萬4萬5萬, 上家 discards 3萬.
    const hand = [M(1), M(2), M(4), M(5)];
    const opts = chowOptions(hand, M(3), 1, 0);
    expect(opts).toHaveLength(3);
    expect(opts).toContainEqual([M(4), M(5)]);
    expect(opts).toContainEqual([M(2), M(4)]);
    expect(opts).toContainEqual([M(1), M(2)]);
  });
  it("offers nothing when the discarder is not 上家", () => {
    const hand = [M(1), M(2), M(4), M(5)];
    expect(chowOptions(hand, M(3), 1, 2)).toEqual([]);
    expect(chowOptions(hand, M(3), 1, 3)).toEqual([]);
  });
  it("never runs a chow across a suit boundary or over honours", () => {
    expect(chowOptions([S(1), S(2)], M(9), 1, 0)).toEqual([]);
    expect(chowOptions([EAST + 1, EAST + 2], EAST, 1, 0)).toEqual([]);
  });
});

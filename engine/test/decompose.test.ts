import { describe, expect, it } from "vitest";
import {
  concealedTripletCount, decomposeWin, decompositionKey, decompositionTileCount, hasWinningShape,
  type Decomposition,
} from "../src/decompose.js";
import { makeChow, makeConcealedKong, makePung } from "../src/melds.js";

// Tile ids (types.ts): 萬 0-8, 索 9-17, 筒 18-26, 東南西北 27-30, 中發白 31-33, 花 34+.
const M = (n: number) => n - 1;        // n萬
const S = (n: number) => 8 + n;        // n索
const C = (n: number) => 17 + n;       // n筒
const EAST = 27, RED = 31, WHITE = 33, PLUM = 34;

/** Every set, pair last, keyed for order-independent comparison. */
const shapes = (d: Decomposition) =>
  d.sets.map((s) => `${s.kind}:${s.tiles.join(",")}`).sort();
const pairTile = (d: Decomposition) => d.pair.tiles[0];
const winner = (d: Decomposition) =>
  [...d.sets, d.pair].find((s) => s.hasWinningTile);

describe("decomposeWin with exposed melds", () => {
  it("reads a hand with two exposed chows", () => {
    // 上 1-3萬, 上 1-3索, concealed 1筒2筒 + 東東東 + 中中, winning 3筒.
    const melds = [makeChow([M(1), M(2), M(3)], 1, 0), makeChow([S(1), S(2), S(3)], 1, 0)];
    const ds = decomposeWin([C(1), C(2), EAST, EAST, EAST, RED, RED], melds, C(3));
    expect(ds).toHaveLength(1);
    const d = ds[0]!;
    expect(d.sets).toHaveLength(4);
    expect(pairTile(d)).toBe(RED);
    expect(shapes(d)).toEqual(
      [
        `chow:${M(1)},${M(2)},${M(3)}`,
        `chow:${S(1)},${S(2)},${S(3)}`,
        `chow:${C(1)},${C(2)},${C(3)}`,
        `pung:${EAST},${EAST},${EAST}`,
      ].sort(),
    );
    // The two claimed chows are fixed and exposed; what was read out of the
    // hand stays concealed.
    const claimed = d.sets.filter((s) => s.meld);
    expect(claimed).toHaveLength(2);
    expect(claimed.every((s) => s.concealed === false)).toBe(true);
    expect(d.sets.filter((s) => !s.meld).every((s) => s.concealed)).toBe(true);
    expect(d.fullyConcealed).toBe(false);
    expect(winner(d)!.tiles).toEqual([C(1), C(2), C(3)]);
    expect(decompositionTileCount(d)).toBe(14);
  });

  it("reads a concealed kong plus two pungs", () => {
    // 暗槓 東, 碰 中, 碰 5筒, concealed 1萬2萬 + 9筒9筒, winning 3萬.
    const melds = [makeConcealedKong(EAST, 2), makePung(RED, 2, 0), makePung(C(5), 2, 1)];
    const ds = decomposeWin([M(1), M(2), C(9), C(9)], melds, M(3));
    expect(ds).toHaveLength(1);
    const d = ds[0]!;
    expect(d.sets).toHaveLength(4);
    expect(pairTile(d)).toBe(C(9));

    const kong = d.sets.find((s) => s.kind === "kong")!;
    expect(kong.tiles).toEqual([EAST, EAST, EAST, EAST]);
    expect(kong.concealed).toBe(true);              // 暗槓 keeps its concealment
    // Four tiles on the table, one set slot: 14 by the golden-case count, 15 physical.
    expect(decompositionTileCount(d)).toBe(15);
    expect(d.sets.filter((s) => s.kind === "pung").every((s) => !s.concealed)).toBe(true);
    expect(d.fullyConcealed).toBe(false);           // the two claimed pungs opened it
  });

  it("keeps a hand of nothing but 暗槓 fully concealed", () => {
    const melds = [makeConcealedKong(EAST, 0)];
    const ds = decomposeWin(
      [M(1), M(2), M(3), S(1), S(2), S(3), C(1), C(2), C(3), RED], melds, RED,
    );
    expect(ds).toHaveLength(1);
    expect(ds[0]!.fullyConcealed).toBe(true);
  });

  it("fixes melds rather than re-reading them", () => {
    // 1-3萬 sits both in a claimed chow and in the concealed part. The claimed
    // one must stay exactly as declared — it cannot be re-cut into the hand.
    const melds = [makeChow([M(1), M(2), M(3)], 1, 0)];
    const ds = decomposeWin([M(1), M(2), M(3), S(1), S(2), S(3), C(1), C(2), RED, RED], melds, C(3));
    expect(ds).toHaveLength(1);
    const fixedSet = ds[0]!.sets.find((s) => s.meld)!;
    expect(fixedSet.tiles).toEqual([M(1), M(2), M(3)]);
    expect(fixedSet.hasWinningTile).toBe(false);
  });
});

describe("multiple readings", () => {
  it("returns every reading of a hand that reads two ways", () => {
    // 111 222 333萬 is three pungs OR three runs. Both are legal; they score
    // very differently (對對糊 against 平糊), so the scorer needs both.
    const ds = decomposeWin(
      [M(1), M(1), M(1), M(2), M(2), M(2), M(3), M(3), M(3), S(1), S(2), S(3), RED],
      [],
      RED,
    );
    expect(ds).toHaveLength(2);
    expect(ds.every((d) => pairTile(d) === RED)).toBe(true);
    expect(ds.every((d) => d.fullyConcealed)).toBe(true);

    const allPungs = ds.find((d) => d.sets.filter((s) => s.kind === "pung").length === 3);
    const allChows = ds.find((d) => d.sets.every((s) => s.kind === "chow"));
    expect(allPungs).toBeDefined();
    expect(allChows).toBeDefined();
    expect(new Set(ds.map(decompositionKey)).size).toBe(2);   // no duplicate search paths
  });

  it("splits the pair-vs-pung ambiguity", () => {
    // Concealed 1萬1萬1萬 2萬 4萬4萬4萬, winning 3萬, behind two claimed chows.
    //   A: 碰 1萬 + 上 2-4萬 + eyes 4萬
    //   B: eyes 1萬 + 上 1-3萬 + 碰 4萬
    const melds = [makeChow([S(1), S(2), S(3)], 0, 3), makeChow([C(4), C(5), C(6)], 0, 3)];
    const ds = decomposeWin([M(1), M(1), M(1), M(2), M(4), M(4), M(4)], melds, M(3));
    expect(ds).toHaveLength(2);

    const a = ds.find((d) => pairTile(d) === M(4))!;
    const b = ds.find((d) => pairTile(d) === M(1))!;
    expect(shapes(a)).toContain(`pung:${M(1)},${M(1)},${M(1)}`);
    expect(shapes(a)).toContain(`chow:${M(2)},${M(3)},${M(4)}`);
    expect(shapes(b)).toContain(`pung:${M(4)},${M(4)},${M(4)}`);
    expect(shapes(b)).toContain(`chow:${M(1)},${M(2)},${M(3)}`);
    // The winning tile lands in a different set in each reading.
    expect(winner(a)!.tiles).toEqual([M(2), M(3), M(4)]);
    expect(winner(b)!.tiles).toEqual([M(1), M(2), M(3)]);
  });

  it("separates readings that differ only in where the winning tile landed", () => {
    // Same two shapes as above, but the win is 1萬 — which sits in the pair AND
    // in the run of reading B. Three readings, not two: a discard-completed set
    // is not concealed, so the attribution changes the score.
    const melds = [makeChow([S(1), S(2), S(3)], 0, 3), makeChow([C(4), C(5), C(6)], 0, 3)];
    const ds = decomposeWin([M(1), M(1), M(2), M(3), M(4), M(4), M(4)], melds, M(1));
    expect(ds).toHaveLength(3);
    expect(new Set(ds.map(decompositionKey)).size).toBe(3);
    expect(ds.filter((d) => d.pair.hasWinningTile)).toHaveLength(1);
  });
});

describe("concealed triplets", () => {
  it("does not count a triplet the discarder completed", () => {
    // 暗槓 東 + 碰-shaped 1萬 1索 1筒 read from hand, eyes 中, winning 1筒.
    const melds = [makeConcealedKong(EAST, 0)];
    const ds = decomposeWin(
      [M(1), M(1), M(1), S(1), S(1), S(1), C(1), C(1), RED, RED], melds, C(1),
    );
    expect(ds).toHaveLength(1);
    const d = ds[0]!;
    expect(concealedTripletCount(d, false)).toBe(4);   // self-drawn: 四暗刻
    expect(concealedTripletCount(d, true)).toBe(3);    // off a discard: only three
  });
});

describe("rejections", () => {
  it("returns no reading when the tiles do not win", () => {
    const ds = decomposeWin(
      [M(1), M(1), M(1), M(2), M(2), M(2), M(3), M(3), M(3), S(1), S(2), S(3), RED],
      [],
      WHITE,
    );
    expect(ds).toEqual([]);
    expect(hasWinningShape([M(1), M(2), M(3), S(1), S(2), S(3), C(1), C(2), C(3), RED, RED, RED, EAST], [], EAST)).toBe(true);
  });
  it("throws when the tile count cannot be a hand", () => {
    expect(() => decomposeWin([M(1), M(2)], [], M(3))).toThrow(/cannot make a/);
    const melds = [makeChow([M(1), M(2), M(3)], 1, 0)];
    expect(() => decomposeWin([S(1), S(2), S(3)], melds, RED)).toThrow(/expected 10/);
  });
  it("throws on a flower in hand", () => {
    // 花 are revealed and replaced, never held (DESIGN.md §4).
    expect(() =>
      decomposeWin([PLUM, M(1), M(1), M(2), M(2), M(3), M(3), S(1), S(2), S(3), RED, RED, RED], [], M(1)),
    ).toThrow(/flowers/);
  });
  it("throws when a tile appears five times across hand and melds", () => {
    const melds = [makePung(RED, 1, 0)];
    expect(() =>
      decomposeWin([RED, RED, RED, M(1), M(2), M(3), S(1), S(2), S(3), C(1)], melds, C(1)),
    ).toThrow(/only four exist/);
  });
  it("throws when a hand carries more than four melds", () => {
    const chow = makeChow([S(1), S(2), S(3)], 1, 0);
    expect(() => decomposeWin([RED], [chow, chow, chow, chow, chow], RED)).toThrow(/at most four/);
  });
  it("handles a hand that is all melds plus the eyes", () => {
    const melds = [
      makeConcealedKong(EAST, 0),
      makePung(RED, 0, 1),
      makeChow([S(1), S(2), S(3)], 0, 3),
      makeChow([C(1), C(2), C(3)], 0, 3),
    ];
    const ds = decomposeWin([WHITE], melds, WHITE);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.sets).toHaveLength(4);
    expect(ds[0]!.pair.hasWinningTile).toBe(true);
    expect(ds[0]!.sets.every((s) => s.meld !== undefined)).toBe(true);
  });
});

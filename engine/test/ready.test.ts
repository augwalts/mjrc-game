import { describe, expect, it } from "vitest";
import { counts } from "../src/tiles.js";
import { distanceToReady, isReady, liveTiles } from "../src/ready.js";
import { assertWallIntact, buildWall, prng } from "../src/wall.js";

const d = (t: number[], melds = 0) => distanceToReady(counts(t), melds);

describe("distanceToReady", () => {
  it("recognises a complete hand", () => {
    expect(d([0, 0, 0, 1, 2, 3, 9, 9, 9, 20, 20, 20, 31, 31])).toBe(-1);
  });
  it("recognises ready", () => {
    expect(d([0, 0, 0, 1, 2, 3, 9, 9, 9, 20, 20, 20, 31])).toBe(0);
  });
  it("counts one away", () => {
    expect(d([0, 0, 0, 1, 2, 3, 9, 9, 9, 20, 21, 31, 33])).toBe(1);
  });
  it("treats a closed wait 坎張 as ready", () => {
    // 6萬 + 8萬 waits on 7萬
    expect(d([0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 27, 5, 7])).toBe(0);
  });
  it("accounts for exposed melds", () => {
    // 2 melds + 8 concealed = 14 tiles: two sets and a pair completes the hand
    expect(d([0, 0, 0, 9, 9, 9, 31, 31], 2)).toBe(-1);
    // 2 melds + 7 concealed = 13 tiles: ready at best, never complete
    expect(d([0, 0, 0, 9, 9, 9, 31], 2)).toBe(0);
  });
  it("never returns less than -1", () => {
    for (let s = 0; s < 300; s++) {
      const w = buildWall(s).filter((t) => t < 34).slice(0, 13);
      expect(d(w)).toBeGreaterThanOrEqual(-1);
    }
  });
});

describe("liveTiles", () => {
  it("finds the waits of a ready hand", () => {
    const r = liveTiles(counts([0, 0, 0, 1, 2, 3, 9, 9, 9, 20, 20, 20, 31]));
    expect(r.distance).toBe(0);
    expect(r.tiles.map((x) => x.tile)).toContain(31);
    expect(r.total).toBeGreaterThan(0);
  });
  it("subtracts copies already visible", () => {
    const vis = new Array(34).fill(0);
    vis[31] = 3;
    const r = liveTiles(counts([0, 0, 0, 1, 2, 3, 9, 9, 9, 20, 20, 20, 31]), 0, vis);
    const dragon = r.tiles.find((x) => x.tile === 31);
    expect(dragon?.unseen).toBe(1);
  });
});

describe("wall", () => {
  it("is 144 tiles with correct multiplicities", () => {
    for (let s = 0; s < 50; s++) assertWallIntact(buildWall(s));
  });
  it("is deterministic for a seed", () => {
    expect(buildWall(42)).toEqual(buildWall(42));
    expect(buildWall(42)).not.toEqual(buildWall(43));
  });
  it("prng is stable", () => {
    const a = prng(7), b = prng(7);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });
});

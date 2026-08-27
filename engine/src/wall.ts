/** Deterministic wall. Every hand is reproducible from its seed (DESIGN.md §5.1). */
import { FLOWERS_START, SCORING_KINDS, WALL_SIZE, type TileId } from "./types.js";

/** mulberry32 — small, fast, and seedable. Never use Math.random in the engine. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 144 tiles: four of each scoring kind, one of each flower. */
export function buildWall(seed: number): TileId[] {
  const w: TileId[] = [];
  for (let i = 0; i < SCORING_KINDS; i++) for (let k = 0; k < 4; k++) w.push(i);
  for (let i = FLOWERS_START; i < FLOWERS_START + 8; i++) w.push(i);
  const rnd = prng(seed);
  for (let i = w.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [w[i], w[j]] = [w[j]!, w[i]!];
  }
  return w;
}

export function assertWallIntact(w: readonly TileId[]): void {
  if (w.length !== WALL_SIZE) throw new Error(`wall has ${w.length} tiles, expected ${WALL_SIZE}`);
  const c = new Map<TileId, number>();
  for (const t of w) c.set(t, (c.get(t) ?? 0) + 1);
  for (let i = 0; i < SCORING_KINDS; i++)
    if (c.get(i) !== 4) throw new Error(`tile ${i} appears ${c.get(i) ?? 0} times, expected 4`);
  for (let i = FLOWERS_START; i < FLOWERS_START + 8; i++)
    if (c.get(i) !== 1) throw new Error(`flower ${i} appears ${c.get(i) ?? 0} times, expected 1`);
}

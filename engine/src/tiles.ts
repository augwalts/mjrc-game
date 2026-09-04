/** Tile identity and classification. HK Old Style — see ../../TERMINOLOGY.md. */
import {
  BAMBOO_START, CIRCLES_START, DRAGONS_START, FLOWERS_START,
  SCORING_KINDS, WINDS_START, type Suit, type TileId,
} from "./types.js";

export const TILE_NAMES: readonly string[] = (() => {
  const n: string[] = [];
  for (let i = 1; i <= 9; i++) n.push(`${i}萬`);
  for (let i = 1; i <= 9; i++) n.push(`${i}索`);
  for (let i = 1; i <= 9; i++) n.push(`${i}筒`);
  n.push("東", "南", "西", "北", "中", "發", "白");
  n.push("梅", "蘭", "菊", "竹", "春", "夏", "秋", "冬");
  return n;
})();

export const WIND_NAMES = ["東", "南", "西", "北"] as const;

export const isFlower = (t: TileId): boolean => t >= FLOWERS_START;
export const isHonour = (t: TileId): boolean => t >= WINDS_START && t < FLOWERS_START;
export const isWind = (t: TileId): boolean => t >= WINDS_START && t < DRAGONS_START;
export const isDragon = (t: TileId): boolean => t >= DRAGONS_START && t < FLOWERS_START;
export const isSuited = (t: TileId): boolean => t < WINDS_START;
/** 么九 — terminals and honours. */
export const isTerminalOrHonour = (t: TileId): boolean =>
  isHonour(t) || (isSuited(t) && (t % 9 === 0 || t % 9 === 8));

export function suitOf(t: TileId): Suit {
  if (t < BAMBOO_START) return "chars";
  if (t < CIRCLES_START) return "bamboo";
  if (t < WINDS_START) return "circles";
  return "honours";
}

/** Rank 0-8 within a suit, or -1 for honours and flowers. */
export const rankOf = (t: TileId): number => (isSuited(t) ? t % 9 : -1);

/** True when a, b, c form a run in one suit. Assumes ascending order. */
export function isRun(a: TileId, b: TileId, c: TileId): boolean {
  return isSuited(a) && suitOf(a) === suitOf(c) && b === a + 1 && c === a + 2 && rankOf(a) <= 6;
}

/** A flower belongs to the seat whose wind index matches it. */
export const flowerSeat = (t: TileId): number => (t - FLOWERS_START) % 4;

/** Count array over the 34 scoring kinds. Flowers are ignored. */
export function counts(tiles: readonly TileId[]): number[] {
  const c = new Array<number>(SCORING_KINDS).fill(0);
  for (const t of tiles) if (t < SCORING_KINDS) c[t]!++;
  return c;
}

/**
 * Opponent threat estimation — from PUBLIC signals only (STRATEGY.md §3/§5).
 *
 * The owner's read of a table, made computable: how exposed is each seat, what
 * suit are they collecting, and do their recent discards look like a player
 * cutting fresh draws (the classic tell that a hand is ready — someone still
 * building keeps what they draw; someone ready throws it straight back).
 *
 * Everything here is derived from SeatView, so a bot using it sees exactly
 * what a human in that chair could see. No engine internals, no peeking.
 */
import type { SeatIndex, TileId } from "./types.js";
import { isHonour, isSuited, rankOf, suitOf } from "./tiles.js";
import type { SeatView } from "./bots.js";

export interface SeatThreat {
  seat: SeatIndex;
  /** melds/4 — how much of the hand is already on the table. */
  exposure: number;
  /** Suit this seat appears to be collecting, or null. 0 萬 1 索 2 筒. */
  intentSuit: number | null;
  /** 0-1 confidence in intentSuit. */
  intentStrength: number;
  /** 0-1 — do their recent discards look like a ready player cutting draws? */
  readyProxy: number;
  /** 0-1 composite. */
  threat: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Middle suited tiles (3-7) are what fresh draws look like; a building player
 * keeps them, a ready player throws them back. */
const isMiddle = (t: TileId): boolean => isSuited(t) && rankOf(t) >= 2 && rankOf(t) <= 6;

export function assessSeatThreat(v: SeatView, seat: SeatIndex): SeatThreat {
  const melds = v.melds[seat]!;
  const discards = v.discards[seat]!;
  const exposure = melds.length / 4;

  // Intent: which suit dominates their melds, weighted by how much they are
  // STARVING it in discards (collecting a suit means not cutting it).
  const meldedPerSuit = [0, 0, 0];
  let meldedHonours = 0;
  for (const m of melds) {
    for (const t of m.tiles) {
      if (isHonour(t)) meldedHonours++;
      else if (isSuited(t)) meldedPerSuit[suitOf(t) === "chars" ? 0 : suitOf(t) === "bamboo" ? 1 : 2]!++;
    }
  }
  const cutsPerSuit = [0, 0, 0];
  for (const t of discards) {
    if (isSuited(t)) cutsPerSuit[suitOf(t) === "chars" ? 0 : suitOf(t) === "bamboo" ? 1 : 2]!++;
  }
  let intentSuit: number | null = null;
  let intentStrength = 0;
  const topMelded = Math.max(...meldedPerSuit);
  if (topMelded >= 3) {
    const s = meldedPerSuit.indexOf(topMelded);
    // starving = few cuts of that suit relative to their total cuts
    const starving = discards.length >= 4 ? 1 - clamp01((cutsPerSuit[s]! / discards.length) * 3) : 0.5;
    intentSuit = s;
    intentStrength = clamp01((topMelded / 9) + starving * 0.5);
  }

  // Ready proxy: middle-tile share of the LAST six discards, minus the same
  // share over the first six — the SHIFT is the tell, not the level.
  let readyProxy = 0;
  if (discards.length >= 6) {
    const late = discards.slice(-6);
    const early = discards.slice(0, 6);
    const share = (a: readonly TileId[]) => a.filter(isMiddle).length / a.length;
    readyProxy = clamp01((share(late) - share(early)) * 1.5 + exposure * 0.3);
  } else {
    readyProxy = exposure * 0.3;
  }

  const threat = clamp01(exposure * 0.55 + readyProxy * 0.35 + intentStrength * 0.25);
  return { seat, exposure, intentSuit, intentStrength, readyProxy, threat };
}

export interface TableThreat {
  seats: SeatThreat[];
  max: number;
}

export function tableThreat(v: SeatView): TableThreat {
  const seats: SeatThreat[] = [];
  for (let s = 0 as SeatIndex; s < 4; s = (s + 1) as SeatIndex) {
    if (s === v.seat) continue;
    seats.push(assessSeatThreat(v, s));
  }
  return { seats, max: Math.max(0, ...seats.map((t) => t.threat)) };
}

/**
 * How much cutting `tile` feeds a specific opponent: 1 for their intent suit,
 * scaled by confidence; honours feed any heavily-exposed seat (pungs claim
 * from anywhere, and an exposed hand wants exactly the tiles nobody else does).
 */
export function feedsSeat(tile: TileId, t: SeatThreat): number {
  if (isHonour(tile)) return t.exposure >= 0.5 ? 0.6 : 0.2;
  if (t.intentSuit === null) return 0;
  const s = suitOf(tile) === "chars" ? 0 : suitOf(tile) === "bamboo" ? 1 : 2;
  return s === t.intentSuit ? t.intentStrength : 0;
}

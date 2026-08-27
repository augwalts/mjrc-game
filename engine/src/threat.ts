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
import type { Ruleset, SeatIndex, TileId } from "./types.js";
import { isHonour, isSuited, rankOf, suitOf } from "./tiles.js";
import type { SeatView } from "./bots.js";

/**
 * The owner's table reads, made computable (interview 2026-08-27):
 *   "discarding really random stuff → maybe a small hand"
 *   "one suit at a time → often a much larger hand"
 *   "something of every suit early → usually all pungs, generally smaller"
 *   "honours late → almost ready to win"
 *   "value honours early → suspicious" (big-hand prep, hiding a flush)
 */
export interface DiscardRead {
  /** 0-1 — discards grouped one suit at a time. High = flush-builder, BIG hand. */
  suitPhasing: number;
  /** First six discards cover all three suits → all-pungs lean, smaller hand. */
  earlySpread: boolean;
  /** 0-1 — honour cuts concentrated in the LATE third → nearly ready. */
  lateHonours: number;
  /** 0-1 — dragons / their own wind / round wind shed in the EARLY third. */
  earlyValueHonours: number;
}

const suitIx = (t: TileId): number => (t < 9 ? 0 : t < 18 ? 1 : 2);

export function readDiscards(
  discards: readonly TileId[],
  theirWind: number,
  roundWind: number,
): DiscardRead {
  const n = discards.length;
  const suited = discards.filter(isSuited);

  // one suit at a time: each half of the suited cuts dominated by ONE suit,
  // and a single-suit stream throughout counts fully.
  let suitPhasing = 0;
  if (suited.length >= 4) {
    const share = (a: readonly TileId[]): number => {
      const c = [0, 0, 0];
      for (const t of a) c[suitIx(t)]!++;
      return Math.max(...c) / a.length;
    };
    const half = Math.floor(suited.length / 2);
    suitPhasing = clamp01((share(suited.slice(0, half)) + share(suited.slice(half))) / 2 * 1.25 - 0.45);
  }

  const firstSix = discards.slice(0, 6);
  const suitsSeen = new Set(firstSix.filter(isSuited).map(suitIx));
  const earlySpread = suitsSeen.size === 3;

  const honourIdx = discards.map((t, i) => (isHonour(t) ? i : -1)).filter((i) => i >= 0);
  let lateHonours = 0;
  if (n >= 6 && honourIdx.length > 0) {
    lateHonours = clamp01(honourIdx.filter((i) => i >= (n * 2) / 3).length / honourIdx.length);
  }

  const valueHonour = (t: TileId): boolean =>
    t >= 31 || t === 27 + theirWind || t === 27 + roundWind;
  let earlyValueHonours = 0;
  if (n >= 3) {
    const early = discards.slice(0, Math.max(3, Math.floor(n / 3)));
    earlyValueHonours = clamp01(early.filter((t) => isHonour(t) && valueHonour(t)).length / 2);
  }

  return { suitPhasing, earlySpread, lateHonours, earlyValueHonours };
}

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
  /** The discard tells behind the numbers. */
  read: DiscardRead;
  /** Expected size of their hand if it wins, in faan. */
  expectedFaan: number;
  /** Their expected payout relative to a floor hand — the CHIP threat. ≥1. */
  chipsRel: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Middle suited tiles (3-7) are what fresh draws look like; a building player
 * keeps them, a ready player throws them back. */
const isMiddle = (t: TileId): boolean => isSuited(t) && rankOf(t) >= 2 && rankOf(t) <= 6;

export function assessSeatThreat(v: SeatView, seat: SeatIndex, rules?: Ruleset): SeatThreat {
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

  const read = readDiscards(discards, v.seatWinds[seat]!, v.roundWind);

  // Size first, readiness second — a big hand building slowly can out-threaten
  // a small hand at ready, because the PAYOUT is exponential in faan.
  const floor = rules?.minimumFaan ?? 3;
  let expectedFaan = floor;
  if (read.suitPhasing > 0.55) expectedFaan += 2;          // flush trajectory
  if (read.earlyValueHonours > 0) expectedFaan += 2;       // hiding something big
  if (intentSuit !== null && intentStrength > 0.6) expectedFaan += 1;
  if (read.earlySpread) expectedFaan = Math.max(floor, expectedFaan - 1); // all-pungs lean
  expectedFaan = Math.min(expectedFaan, rules?.limitFaan ?? 13);

  const chipsRel = rules
    ? Math.max(1, rules.payment.onDiscard(expectedFaan) / Math.max(1, rules.payment.onDiscard(floor)))
    : Math.pow(2, expectedFaan - floor);

  const readiness = clamp01(
    exposure * 0.5 + readyProxy * 0.3 + read.lateHonours * 0.3 + intentStrength * 0.15,
  );
  const threat = clamp01(readiness);
  return { seat, exposure, intentSuit, intentStrength, readyProxy, threat, read, expectedFaan, chipsRel };
}

export interface TableThreat {
  seats: SeatThreat[];
  max: number;
  /** Visible suited copies per suit (all discards + all melds), of 36 each —
   * the table-wide supply picture a suit route must be priced against. */
  suitDepletion: [number, number, number];
}

export function tableThreat(v: SeatView, rules?: Ruleset): TableThreat {
  const seats: SeatThreat[] = [];
  for (let s = 0 as SeatIndex; s < 4; s = (s + 1) as SeatIndex) {
    if (s === v.seat) continue;
    seats.push(assessSeatThreat(v, s, rules));
  }
  const suitDepletion: [number, number, number] = [0, 0, 0];
  for (let s = 0; s < 4; s++) {
    for (const t of v.discards[s]!) if (isSuited(t)) suitDepletion[suitIx(t)]!++;
    for (const m of v.melds[s]!) for (const t of m.tiles) if (isSuited(t)) suitDepletion[suitIx(t)]!++;
  }
  return { seats, max: Math.max(0, ...seats.map((t) => t.threat)), suitDepletion };
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

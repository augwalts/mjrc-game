/**
 * Shared evaluation core — one implementation used by BOTH the in-process
 * (serial) path and the spawned worker, so the two can never drift.
 * evaluate(): candidate in one rotating seat vs three incumbents over a seed
 * set, scored in placement points, activity tallied.
 */
import { prng } from "../../engine/src/wall.js";
import { decideAction, type BotProfile, type BotConfig } from "../../engine/src/bots.js";
import { MJRC_STANDARD, ruleset as rulesetById } from "../../rulesets/src/presets.js";
import type { Ruleset } from "../../engine/src/types.js";

/** The ruleset every evaluation plays. Default mjrc-standard; the TVB lab
 * (owner request 2026-08-29) switches it per process via setSimRuleset. */
let RULES: Ruleset = MJRC_STANDARD;
export function setSimRuleset(id: string): Ruleset {
  const r = rulesetById(id);
  if (!r) throw new Error(`unknown ruleset ${id}`);
  RULES = r;
  return r;
}
export const simRuleset = (): Ruleset => RULES;
import { playMatch, SEATS, type Decide } from "./driver.js";

export function mkDecide(profile: BotProfile, seed: number): Decide {
  const cfgs: BotConfig[] = SEATS.map((s) => ({
    ruleset: RULES, profile,
    rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  return (view, legal, seat) => decideAction(view, legal, cfgs[seat]!);
}

export interface EvalResult {
  /** Mean placement points/match: 1st +3, 2nd +1, 3rd −1, 4th −3 (ties averaged).
   * Chips have heavy tails — one limit hand swings ±100 and drowns the signal —
   * so selection runs on placement; chips are still recorded for the panel. */
  pointsPerMatch: number;
  chipsPerMatch: number;
  /** Chips gained on wins / bled on losses per match — the owner's objective
   * split: maximize the first, minimize the second. won + lost = chips. */
  chipsWonPerMatch: number;
  chipsLostPerMatch: number;
  /** The loss, attributed: deal-ins (your discard fed the win) vs self-draw
   * tax. dealIns = count per match; the gap between lost and these two is
   * liability/edge cases. */
  dealInLossPerMatch: number;
  dealInsPerMatch: number;
  taxLossPerMatch: number;
  /** chipsWon / |chipsLost| — how humans compare players. >1 = net winner. */
  winLossRatio: number; drawRate: number; refusedPerHand: number;
  meanFaan: number; claimsPerHand: number;
  /** Share of wins where an opponent read had flagged the winner (>0.3). */
  threatDetection: number;
  /** Per-hand activity mix and the winning-pattern census for this eval. */
  activity: { chows: number; pungs: number; kongs: number;
              winsOnDiscard: number; selfDraws: number; hands: number;
              patterns: Record<string, number>;
              /** Wins by final faan value, index = faan (3..13). */
              faanHist: number[] };
}

const PLACEMENT = [3, 1, -1, -3];
export function placementPoints(chips: readonly number[], seat: number): number {
  const mine = chips[seat]!;
  const better = chips.filter((c) => c > mine).length;
  const equal = chips.filter((c) => c === mine).length;
  // average the points over the tied placement span
  let sum = 0;
  for (let k = 0; k < equal; k++) sum += PLACEMENT[better + k]!;
  return sum / equal;
}

/** One control match in full: browsable per-hand detail for the panel. */
export interface SampleMatch {
  seed: number;
  /** The evaluated profile's seat; the other three seats use the opponent. */
  candidateSeat: number;
  /** Final chips per seat. */
  chips: number[];
  hands: number;
  handRecords: HandRecord[];
}

/** candidate in one rotating seat vs three incumbents, over the seed set.
 * `sample` (control eval only): collect per-match hand detail for the panel. */
export function evaluate(
  candidate: BotProfile, incumbent: BotProfile, seeds: number[],
  sample?: SampleMatch[],
  opts?: { allSeats?: boolean },
): EvalResult {
  // allSeats: play every wall four times with the candidate in each chair.
  // Chips are zero-sum across seats, so a mirror scores EXACTLY 0 — this kills
  // the constant wall-luck bias a fixed (seed, seat) pairing bakes into a
  // fixed-seed benchmark (the "+62 in a mirror" finding, 2026-08-27).
  const plays = opts?.allSeats
    ? seeds.flatMap((seed) => ([0, 1, 2, 3] as const).map((seat) => ({ seed, seat })))
    : seeds.map((seed, i) => ({ seed, seat: (i % 4) as 0 | 1 | 2 | 3 }));
  let chips = 0, won = 0, lost = 0, dealInLoss = 0, dealIns = 0, taxLoss = 0,
      points = 0, hands = 0, draws = 0, refused = 0, claims = 0;
  let chows = 0, pungs = 0, kongs = 0, wod = 0, sd = 0, tWins = 0, tFlagged = 0;
  const patterns: Record<string, number> = {};
  const faans: number[] = [];
  plays.forEach(({ seed, seat: mySeat }) => {
    const decideC = mkDecide(candidate, seed);
    const decideI = mkDecide(incumbent, seed);
    const perSeat: Decide[] = SEATS.map((s) =>
      s === mySeat
        ? (v, l, st) => decideC(v, l, st)
        : (v, l, st) => decideI(v, l, st));
    const r = playMatch(
      { seed, ruleset: RULES, matchLength: "oneWindRound" }, perSeat,
      { recordHands: sample !== undefined },
    );
    if (sample) {
      sample.push({ seed, candidateSeat: mySeat, chips: r.chips.slice(), hands: r.hands, handRecords: r.handRecords ?? [] });
    }
    chips += r.chips[mySeat]!;
    won += r.seatWon[mySeat]!;
    lost += r.seatLost[mySeat]!;
    dealInLoss += r.seatDealInLoss[mySeat]!;
    dealIns += r.seatDealInCount[mySeat]!;
    taxLoss += r.seatTaxLoss[mySeat]!;
    points += placementPoints(r.chips, mySeat);
    hands += r.hands; draws += r.draws; refused += r.refusedWins; claims += r.claims;
    chows += r.chows; pungs += r.pungs; kongs += r.kongs;
    wod += r.winsOnDiscard; sd += r.selfDraws; tWins += r.threatWins; tFlagged += r.threatFlagged;
    for (const [k, n] of Object.entries(r.patterns)) patterns[k] = (patterns[k] ?? 0) + n;
    faans.push(...r.faans);
  });
  const faanHist = new Array(14).fill(0);
  for (const f of faans) faanHist[Math.max(0, Math.min(13, Math.round(f)))]++;
  return {
    pointsPerMatch: +(points / plays.length).toFixed(2),
    chipsPerMatch: +(chips / plays.length).toFixed(1),
    chipsWonPerMatch: +(won / plays.length).toFixed(1),
    chipsLostPerMatch: +(lost / plays.length).toFixed(1),
    winLossRatio: +(won / Math.max(1, Math.abs(lost))).toFixed(2),
    dealInLossPerMatch: +(dealInLoss / plays.length).toFixed(1),
    dealInsPerMatch: +(dealIns / plays.length).toFixed(2),
    taxLossPerMatch: +(taxLoss / plays.length).toFixed(1),
    drawRate: +(draws / hands).toFixed(3),
    refusedPerHand: +(refused / hands).toFixed(2),
    meanFaan: +(faans.reduce((a, b) => a + b, 0) / Math.max(1, faans.length)).toFixed(2),
    claimsPerHand: +(claims / hands).toFixed(2),
    threatDetection: +(tFlagged / Math.max(1, tWins)).toFixed(2),
    activity: { chows, pungs, kongs, winsOnDiscard: wod, selfDraws: sd, hands, patterns, faanHist },
  };
}

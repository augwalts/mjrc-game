/**
 * Held-out evaluation: an evolved profile vs DEFAULT_PROFILE on FRESH seeds
 * neither run ever saw. One seat rotates the challenger; margin is chips/match.
 * This is the honest scoreboard — evolution's per-generation numbers re-baseline
 * every generation and cannot show net progress.
 */
import { readFileSync } from "node:fs";
import { prng } from "../../engine/src/wall.js";
import { decideAction, DEFAULT_PROFILE, type BotProfile, type BotConfig } from "../../engine/src/bots.js";
import { MJRC_STANDARD, ruleset as rulesetById } from "../../rulesets/src/presets.js";
import { playMatch, SEATS, type Decide } from "./driver.js";

const profile: BotProfile = { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(process.argv[2]!, "utf8")) };
const N = Number(process.argv[3] ?? 100);
const SEED_BASE = Number(process.argv[4] ?? 700_000);
/** Optional 5th arg: profile file for the TABLE side. Defaults to the current
 * DEFAULT_PROFILE — but a benchmark must name its enemy: the overnight
 * harness passes baseline-v0 so admission and bench face the SAME opponent. */
const RULES = process.argv[6] ? (rulesetById(process.argv[6]!) ?? MJRC_STANDARD) : MJRC_STANDARD;
const tableProfile: BotProfile = process.argv[5]
  ? { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(process.argv[5], "utf8")) }
  : DEFAULT_PROFILE;

function mk(p: BotProfile, seed: number): Decide {
  const cfgs: BotConfig[] = SEATS.map((s) => ({
    ruleset: RULES, profile: p, rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  return (v, l, seat) => decideAction(v, l, cfgs[seat]!);
}

let chips = 0, chipsSq = 0, hands = 0, draws = 0, refused = 0, tWins = 0, tFlagged = 0;
// Cycle-texture tallies (2026-08-28): table-wide claim/win mix, plus the
// challenger's own chip decomposition — pure counters, no decision changes.
let claims = 0, chows = 0, pungs = 0, kongs = 0, selfDraws = 0, winsOnDiscard = 0;
let meWon = 0, meLost = 0, meDealInLoss = 0, meDealIns = 0, meTaxLoss = 0;
let meWins = 0, meSelfDraws = 0, meFaanSum = 0;
let meChows = 0, mePungs = 0, meKongs = 0;
const patterns: Record<string, number> = {};      // table-wide winning-pattern census
const mePatterns: Record<string, number> = {};    // challenger wins only
const faans: number[] = [];
for (let i = 0; i < N; i++) {
  // All-seats (2026-08-27): the same wall is played from every chair before
  // moving to the next seed, so seat-luck cancels exactly — a bot benched
  // against ITSELF scores 0, and "0 = par" is literal. N games = N/4 walls.
  const seed = SEED_BASE + Math.floor(i / 4) * 7919;
  const mySeat = (i % 4) as 0 | 1 | 2 | 3;
  const dc = mk(profile, seed), di = mk(tableProfile, seed);
  const perSeat: Decide[] = SEATS.map((s) => (s === mySeat ? dc : di));
  const r = playMatch({ seed, ruleset: RULES, matchLength: "oneWindRound" }, perSeat,
    { recordHands: true });
  chips += r.chips[mySeat]!;
  chipsSq += r.chips[mySeat]! * r.chips[mySeat]!;
  hands += r.hands; draws += r.draws; refused += r.refusedWins;
  tWins += r.threatWins; tFlagged += r.threatFlagged;
  faans.push(...r.faans);
  claims += r.claims; chows += r.chows; pungs += r.pungs; kongs += r.kongs;
  selfDraws += r.selfDraws; winsOnDiscard += r.winsOnDiscard;
  meWon += r.seatWon[mySeat]!; meLost += r.seatLost[mySeat]!;
  meDealInLoss += r.seatDealInLoss[mySeat]!; meDealIns += r.seatDealInCount[mySeat]!;
  meTaxLoss += r.seatTaxLoss[mySeat]!;
  meChows += r.seatChows[mySeat]!; mePungs += r.seatPungs[mySeat]!; meKongs += r.seatKongs[mySeat]!;
  for (const [k, n] of Object.entries(r.patterns)) patterns[k] = (patterns[k] ?? 0) + n;
  for (const h of r.handRecords ?? []) {
    if (h.winner !== mySeat) continue;
    meWins++; meFaanSum += h.faan ?? 0;
    if (h.outcome === "selfDraw") meSelfDraws++;
    for (const a of h.winningHand?.awards ?? []) mePatterns[a.id] = (mePatterns[a.id] ?? 0) + 1;
  }
}
const nameOf = (i: number, fallback: string) =>
  process.argv[i] ? process.argv[i]!.split("/").pop()!.replace(".json", "") : fallback;
console.log(`${N} held-out matches (all seats): ${nameOf(2, "profile")} vs 3x ${nameOf(5, "shipping default")}:`);
console.log(`  chips/match     ${(chips / N).toFixed(1)}  (0 = par with that enemy)`);
console.log(`  draw rate       ${(draws / hands * 100).toFixed(0)}%`);
console.log(`  refused/hand    ${(refused / hands).toFixed(2)}`);
console.log(`  mean win faan   ${(faans.reduce((a, b) => a + b, 0) / Math.max(1, faans.length)).toFixed(2)}`);
const totF = faans.length || 1;
const faanShares = [3, 4, 5, 6, 7, 8, 9].map((f) => faans.filter((x) => Math.round(x) === f).length / totF)
  .concat([faans.filter((x) => Math.round(x) >= 10).length / totF]);
const wins = faans.length;
const mean = chips / N;
console.log("STATS " + JSON.stringify({
  chips: +(chips / N).toFixed(1), drawRate: +(draws / Math.max(1, hands)).toFixed(3),
  refusedPerHand: +(refused / Math.max(1, hands)).toFixed(2),
  meanFaan: +(faans.reduce((a, b) => a + b, 0) / totF).toFixed(2),
  faanShares: faanShares.map((x) => +x.toFixed(3)),
  threatDetection: +(tFlagged / Math.max(1, tWins)).toFixed(2),
  // Cycle-texture block (2026-08-28) — raw counts included so the panel can
  // draw honest ±2SE bands instead of guessing sample sizes.
  matches: N, hands, wins,
  chipsSD: +Math.sqrt(Math.max(0, chipsSq / N - mean * mean)).toFixed(1),
  selfDrawShare: +(selfDraws / Math.max(1, wins)).toFixed(3),
  claimsPerHand: +(claims / Math.max(1, hands)).toFixed(2),
  chowShare: +(chows / Math.max(1, claims)).toFixed(3),
  pungShare: +(pungs / Math.max(1, claims)).toFixed(3),
  kongShare: +(kongs / Math.max(1, claims)).toFixed(3),
  // Winning-pattern census as SHARE OF WINS (a win can carry several patterns).
  patternShares: Object.fromEntries(Object.entries(patterns)
    .map(([k, n]) => [k, +(n / Math.max(1, wins)).toFixed(3)])
    .filter(([, v]) => (v as number) >= 0.005)),
  me: {
    wonPerMatch: +(meWon / N).toFixed(1), lostPerMatch: +(meLost / N).toFixed(1),
    dealInLossPerMatch: +(meDealInLoss / N).toFixed(1), dealInsPerMatch: +(meDealIns / N).toFixed(2),
    taxLossPerMatch: +(meTaxLoss / N).toFixed(1),
    wins: meWins, winShare: +(meWins / Math.max(1, wins)).toFixed(3),
    meanFaan: +(meFaanSum / Math.max(1, meWins)).toFixed(2),
    selfDrawShare: +(meSelfDraws / Math.max(1, meWins)).toFixed(3),
    claims: { chows: meChows, pungs: mePungs, kongs: meKongs },
    patternShares: Object.fromEntries(Object.entries(mePatterns)
      .map(([k, n]) => [k, +(n / Math.max(1, meWins)).toFixed(3)])
      .filter(([, v]) => (v as number) >= 0.01)),
  },
}));

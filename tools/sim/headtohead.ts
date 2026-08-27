/**
 * Held-out evaluation: an evolved profile vs DEFAULT_PROFILE on FRESH seeds
 * neither run ever saw. One seat rotates the challenger; margin is chips/match.
 * This is the honest scoreboard — evolution's per-generation numbers re-baseline
 * every generation and cannot show net progress.
 */
import { readFileSync } from "node:fs";
import { prng } from "../../engine/src/wall.js";
import { decideAction, DEFAULT_PROFILE, type BotProfile, type BotConfig } from "../../engine/src/bots.js";
import { HKOS_STANDARD } from "../../rulesets/src/presets.js";
import { playMatch, SEATS, type Decide } from "./driver.js";

const profile: BotProfile = { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(process.argv[2]!, "utf8")) };
const N = Number(process.argv[3] ?? 100);
const SEED_BASE = Number(process.argv[4] ?? 700_000);
/** Optional 5th arg: profile file for the TABLE side. Defaults to the current
 * DEFAULT_PROFILE — but a benchmark must name its enemy: the overnight
 * harness passes baseline-v0 so admission and bench face the SAME opponent. */
const tableProfile: BotProfile = process.argv[5]
  ? { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(process.argv[5], "utf8")) }
  : DEFAULT_PROFILE;

function mk(p: BotProfile, seed: number): Decide {
  const cfgs: BotConfig[] = SEATS.map((s) => ({
    ruleset: HKOS_STANDARD, profile: p, rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  return (v, l, seat) => decideAction(v, l, cfgs[seat]!);
}

let chips = 0, hands = 0, draws = 0, refused = 0;
const faans: number[] = [];
for (let i = 0; i < N; i++) {
  const seed = SEED_BASE + i * 7919;              // prime-spaced, block selectable
  const mySeat = (i % 4) as 0 | 1 | 2 | 3;
  const dc = mk(profile, seed), di = mk(tableProfile, seed);
  const perSeat: Decide[] = SEATS.map((s) => (s === mySeat ? dc : di));
  const r = playMatch({ seed, ruleset: HKOS_STANDARD, matchLength: "oneWindRound" }, perSeat);
  chips += r.chips[mySeat]!;
  hands += r.hands; draws += r.draws; refused += r.refusedWins;
  faans.push(...r.faans);
}
console.log(`${N} held-out matches, evolved seat vs 3x default:`);
console.log(`  chips/match     ${(chips / N).toFixed(1)}  (0 = no better than default)`);
console.log(`  draw rate       ${(draws / hands * 100).toFixed(0)}%`);
console.log(`  refused/hand    ${(refused / hands).toFixed(2)}`);
console.log(`  mean win faan   ${(faans.reduce((a, b) => a + b, 0) / Math.max(1, faans.length)).toFixed(2)}`);

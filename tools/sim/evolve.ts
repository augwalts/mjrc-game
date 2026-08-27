/**
 * Self-play weight evolution — the first ML loop on the engine.
 *
 *   node tools/sim/evolve.mjs --gens 20 --out tools/sim
 *
 * Method: (1+6) evolution with common random numbers. Each generation, six
 * challengers are mutated from the incumbent BotProfile (log-normal jitter per
 * weight). Every candidate sits ONE seat (rotating) against three incumbents,
 * on the SAME 24 match seeds, so wall luck cancels between candidates. The
 * incumbent also plays itself on those seeds as the control. A challenger is
 * promoted only if its mean chip take beats the control's by a margin.
 *
 * Chips are the fitness. Nothing else is optimised directly — draw rate,
 * refused wins and faan are RECORDED so we can watch whether chip pressure
 * alone fixes the texture, which is itself the first research question.
 *
 * Deterministic end to end: same --gens and seeds → identical history.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prng } from "../../engine/src/wall.js";
import { decideAction, DEFAULT_PROFILE, type BotProfile, type BotConfig } from "../../engine/src/bots.js";
import { HKOS_STANDARD } from "../../rulesets/src/presets.js";
import { playMatch, SEATS, type Decide, type HandRecord } from "./driver.js";

const args = process.argv.slice(2);
const flag = (n: string, d: string): string => {
  const i = args.indexOf(n);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const GENS = Number(flag("--gens", "20"));
const OUT = flag("--out", "tools/sim");
const CANDIDATES = 6;
const MATCHES = Number(flag("--matches", "48"));
// Placement points/match are bounded by ±3, so SE at 48 matches ≈ 0.43.
// Selection on set A takes max-of-6 (winner's curse); promotion additionally
// requires beating the control on a FRESH set B — the runs 1–2 lesson, where
// 25 single-stage promotions produced zero held-out improvement.
const PROMOTE_MARGIN = 0.5;

const KEYS = Object.keys(DEFAULT_PROFILE) as (keyof BotProfile)[];

/** Log-normal multiplicative jitter, Box–Muller over the seeded stream. */
function mutate(base: BotProfile, rnd: () => number, sigma: number): BotProfile {
  const out = { ...base };
  for (const k of KEYS) {
    const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[k] = +(base[k] * Math.exp(gauss * sigma)).toFixed(4);
  }
  return out;
}

function mkDecide(profile: BotProfile, seed: number): Decide {
  const cfgs: BotConfig[] = SEATS.map((s) => ({
    ruleset: HKOS_STANDARD, profile,
    rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  return (view, legal, seat) => decideAction(view, legal, cfgs[seat]!);
}

interface EvalResult {
  /** Mean placement points/match: 1st +3, 2nd +1, 3rd −1, 4th −3 (ties averaged).
   * Chips have heavy tails — one limit hand swings ±100 and drowns the signal —
   * so selection runs on placement; chips are still recorded for the panel. */
  pointsPerMatch: number;
  chipsPerMatch: number; drawRate: number; refusedPerHand: number;
  meanFaan: number; claimsPerHand: number;
  /** Per-hand activity mix and the winning-pattern census for this eval. */
  activity: { chows: number; pungs: number; kongs: number;
              winsOnDiscard: number; selfDraws: number; hands: number;
              patterns: Record<string, number>;
              /** Wins by final faan value, index = faan (3..13). */
              faanHist: number[] };
}

const PLACEMENT = [3, 1, -1, -3];
function placementPoints(chips: readonly number[], seat: number): number {
  const mine = chips[seat]!;
  const better = chips.filter((c) => c > mine).length;
  const equal = chips.filter((c) => c === mine).length;
  // average the points over the tied placement span
  let sum = 0;
  for (let k = 0; k < equal; k++) sum += PLACEMENT[better + k]!;
  return sum / equal;
}

/** One control match in full: browsable per-hand detail for the panel. */
interface SampleMatch {
  seed: number;
  /** Final chips per seat. */
  chips: number[];
  hands: number;
  handRecords: HandRecord[];
}

/** candidate in one rotating seat vs three incumbents, over the seed set.
 * `sample` (control eval only): collect per-match hand detail for the panel. */
function evaluate(
  candidate: BotProfile, incumbent: BotProfile, seeds: number[],
  sample?: SampleMatch[],
): EvalResult {
  let chips = 0, points = 0, hands = 0, draws = 0, refused = 0, claims = 0;
  let chows = 0, pungs = 0, kongs = 0, wod = 0, sd = 0;
  const patterns: Record<string, number> = {};
  const faans: number[] = [];
  seeds.forEach((seed, i) => {
    const mySeat = (i % 4) as 0 | 1 | 2 | 3;
    const decideC = mkDecide(candidate, seed);
    const decideI = mkDecide(incumbent, seed);
    const perSeat: Decide[] = SEATS.map((s) =>
      s === mySeat
        ? (v, l, st) => decideC(v, l, st)
        : (v, l, st) => decideI(v, l, st));
    const r = playMatch(
      { seed, ruleset: HKOS_STANDARD, matchLength: "oneWindRound" }, perSeat,
      { recordHands: sample !== undefined },
    );
    if (sample) {
      sample.push({ seed, chips: r.chips.slice(), hands: r.hands, handRecords: r.handRecords ?? [] });
    }
    chips += r.chips[mySeat]!;
    points += placementPoints(r.chips, mySeat);
    hands += r.hands; draws += r.draws; refused += r.refusedWins; claims += r.claims;
    chows += r.chows; pungs += r.pungs; kongs += r.kongs;
    wod += r.winsOnDiscard; sd += r.selfDraws;
    for (const [k, n] of Object.entries(r.patterns)) patterns[k] = (patterns[k] ?? 0) + n;
    faans.push(...r.faans);
  });
  const faanHist = new Array(14).fill(0);
  for (const f of faans) faanHist[Math.max(0, Math.min(13, Math.round(f)))]++;
  return {
    pointsPerMatch: +(points / seeds.length).toFixed(2),
    chipsPerMatch: +(chips / seeds.length).toFixed(1),
    drawRate: +(draws / hands).toFixed(3),
    refusedPerHand: +(refused / hands).toFixed(2),
    meanFaan: +(faans.reduce((a, b) => a + b, 0) / Math.max(1, faans.length)).toFixed(2),
    claimsPerHand: +(claims / hands).toFixed(2),
    activity: { chows, pungs, kongs, winsOnDiscard: wod, selfDraws: sd, hands, patterns, faanHist },
  };
}

interface GenRecord {
  gen: number; seeds: [number, number]; control: EvalResult;
  /** Set-B result for the selected candidate; null when selection failed set A. */
  confirm: EvalResult | null;
  candidates: { id: number; result: EvalResult; profile: BotProfile }[];
  promoted: number | null; incumbentAfter: BotProfile; ms: number;
}

const history: GenRecord[] = [];
import { readFileSync, existsSync } from "node:fs";
const startFrom = flag("--start", "");
let incumbent: BotProfile = startFrom && existsSync(startFrom)
  ? { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(startFrom, "utf8")) }
  : { ...DEFAULT_PROFILE };
if (startFrom) console.log(`starting from ${startFrom}`);

/** Latest generation's control matches in full — replaced every gen so
 * data.js stays small (~48 matches ≈ a few hundred KB). */
let sampleMatches: SampleMatch[] = [];

function flush(status: string): void {
  const payload = {
    status, updated: new Date().toISOString(),
    defaults: DEFAULT_PROFILE, keys: KEYS, history, sampleMatches,
  };
  writeFileSync(join(OUT, "data.js"), "window.SIM_DATA = " + JSON.stringify(payload) + ";\n");
  writeFileSync(join(OUT, "best-profile.json"), JSON.stringify(incumbent, null, 2) + "\n");
}

flush("starting");
for (let gen = 0; gen < GENS; gen++) {
  const t0 = Date.now();
  const seedBase = 500_000 + gen * 1000;
  // spaced by a prime — adjacent seeds replay each other's walls (transcriber finding 2026-08-27)
  const seeds = Array.from({ length: MATCHES }, (_, i) => seedBase + i * 7919);
  const mrnd = prng(0xabc0 + gen);
  // anneal: broad early, fine late
  const sigma = 0.3 * Math.pow(0.93, gen);

  const controlSample: SampleMatch[] = [];
  const control = evaluate(incumbent, incumbent, seeds, controlSample);
  sampleMatches = controlSample;
  const candidates = Array.from({ length: CANDIDATES }, (_, id) => {
    const profile = mutate(incumbent, mrnd, sigma);
    return { id, profile, result: evaluate(profile, incumbent, seeds) };
  });

  let promoted: number | null = null;
  let confirm: EvalResult | null = null;
  const best = [...candidates].sort((a, b) => b.result.pointsPerMatch - a.result.pointsPerMatch)[0]!;
  if (best.result.pointsPerMatch > control.pointsPerMatch + PROMOTE_MARGIN) {
    const confirmSeeds = Array.from({ length: MATCHES }, (_, i) => seedBase + 104729 + i * 7919);
    confirm = evaluate(best.profile, incumbent, confirmSeeds);
    const controlB = evaluate(incumbent, incumbent, confirmSeeds);
    if (confirm.pointsPerMatch > controlB.pointsPerMatch + PROMOTE_MARGIN) {
      incumbent = best.profile;
      promoted = best.id;
    }
  }

  history.push({
    gen, seeds: [seeds[0]!, seeds[seeds.length - 1]!], control, confirm,
    candidates: candidates.map((c) => ({ id: c.id, result: c.result, profile: c.profile })),
    promoted, incumbentAfter: incumbent, ms: Date.now() - t0,
  });
  flush("running");
  console.log(
    `gen ${gen}: control ${control.pointsPerMatch}pt · best ${best.result.pointsPerMatch}pt` +
    (confirm ? ` · confirm ${confirm.pointsPerMatch}pt` : "") +
    ` · ${promoted === null ? "kept" : `PROMOTED #${promoted}`}` +
    ` · refused/hand ${best.result.refusedPerHand} · draw ${(best.result.drawRate * 100).toFixed(0)}% · ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}
flush("done");
console.log("final profile written to best-profile.json");

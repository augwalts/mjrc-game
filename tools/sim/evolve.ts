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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join as pjoin } from "node:path";
import { join } from "node:path";
import { prng } from "../../engine/src/wall.js";
import { decideAction, DEFAULT_PROFILE, type BotProfile, type BotConfig } from "../../engine/src/bots.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import { SEATS, type Decide, type HandRecord } from "./driver.js";
import { evaluate, type EvalResult, type SampleMatch } from "./evalcore.js";

const args = process.argv.slice(2);
const flag = (n: string, d: string): string => {
  const i = args.indexOf(n);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const GENS = Number(flag("--gens", "20"));
const SERIAL = args.includes("--serial");
/** Who candidates play against. "mirror" = the incumbent (classic self-play);
 * "baseline" = the frozen season-start bot — run 8's lesson: 16 generations of
 * mirror promotions found nothing while the bench sat at -18, because a slow
 * mirror table never rewards the speed that beats the fast baseline. Train
 * against the enemy you are scored against. */
const OPPONENT = flag("--opponent", "mirror");
/** Offset for the mutation stream so a retry explores DIFFERENT mutants —
 * without it, identical seeds replay the identical run. */
const MUTSEED = Number(flag("--mutseed", "0"));
import { readFileSync as rfs, existsSync as exs } from "node:fs";
/** The frozen season-start bot (linear faan, no table reading). Every
 * generation the CURRENT incumbent plays 3× this on a FIXED held-out seed set,
 * so "are we actually getting better" is a line that can only move for real
 * reasons — mirror self-play is zero-sum and can never show absolute progress. */
const BASELINE_PATH = flag("--baseline", "tools/sim/baseline-v0.json");
const BASELINE: BotProfile = {
  ...DEFAULT_PROFILE,
  ...(exs(BASELINE_PATH) ? JSON.parse(rfs(BASELINE_PATH, "utf8")) : {}),
};
const BENCH_SEEDS = Array.from({ length: 48 }, (_, i) => 880_000 + i * 7919);
const OUT = flag("--out", "tools/sim");
const CANDIDATES = 6;
const MATCHES = Number(flag("--matches", "48"));
// Placement points/match are bounded by ±3, so SE at 48 matches ≈ 0.43.
// Selection on set A takes max-of-6 (winner's curse); promotion additionally
// requires beating the control on a FRESH set B — the runs 1–2 lesson, where
// 25 single-stage promotions produced zero held-out improvement.
const PROMOTE_MARGIN = 0.5;

const KEYS = Object.keys(DEFAULT_PROFILE) as (keyof BotProfile)[];

const WORKER = pjoin(dirname(fileURLToPath(import.meta.url)), "evalworker.mjs");

/** evaluate() in a child process — the profile says minDist is 89% of CPU and
 * the seven evaluations of a generation are fully independent, so the wall
 * clock of a generation collapses to the wall clock of ONE evaluation. */
function evaluateRemote(
  candidate: BotProfile, incumbent: BotProfile, seeds: number[], collect: boolean, allSeats?: boolean,
): Promise<{ result: EvalResult; sample?: SampleMatch[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`evalworker exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify({ candidate, incumbent, seeds, collect, allSeats }));
  });
}

async function runEval(
  c: BotProfile, i: BotProfile, seeds: number[], sample?: SampleMatch[], allSeats?: boolean,
): Promise<EvalResult> {
  if (SERIAL) return evaluate(c, i, seeds, sample, { allSeats });
  const { result, sample: got } = await evaluateRemote(c, i, seeds, sample !== undefined, allSeats);
  if (sample && got) sample.push(...got);
  return result;
}

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
    ruleset: MJRC_STANDARD, profile,
    rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  return (view, legal, seat) => decideAction(view, legal, cfgs[seat]!);
}

interface GenRecord {
  gen: number; seeds: [number, number]; control: EvalResult;
  /** Incumbent-after-this-gen vs the frozen baseline on fixed held-out seeds. */
  bench: EvalResult;
  /** Same, vs the profile this run started from — the past champion. */
  benchPrev: EvalResult;
  /** Exact workload this generation. */
  work: { matches: number; hands: number };
  /** Set-B result for the selected candidate; null when selection failed set A. */
  confirm: EvalResult | null;
  candidates: { id: number; result: EvalResult; profile: BotProfile }[];
  promoted: number | null; incumbentAfter: BotProfile; ms: number;
  /** Dials the promoted mutant moved, from -> to. Null when nothing promoted. */
  changed: Record<string, { from: number; to: number }> | null;
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
    baseline: BASELINE_PATH, ruleset: MJRC_STANDARD.id,
  };
  writeFileSync(join(OUT, "data.js"), "window.SIM_DATA = " + JSON.stringify(payload) + ";\n");
  writeFileSync(join(OUT, "best-profile.json"), JSON.stringify(incumbent, null, 2) + "\n");
}

/** The profile this run STARTED from — the past champion. benchPrev measures
 * the run's own marginal progress, where the baseline bench saturates. */
const START_PROFILE: BotProfile = { ...incumbent };
flush("starting");
for (let gen = 0; gen < GENS; gen++) {
  const t0 = Date.now();
  const incumbentBefore = incumbent;
  const seedBase = 500_000 + gen * 1000;
  // spaced by a prime — adjacent seeds replay each other's walls (transcriber finding 2026-08-27)
  const seeds = Array.from({ length: MATCHES }, (_, i) => seedBase + i * 7919);
  const mrnd = prng((0xabc0 + gen + MUTSEED) >>> 0);
  // anneal: broad early, fine late
  const sigma = 0.3 * Math.pow(0.93, gen);

  const controlSample: SampleMatch[] = [];
  const opp = OPPONENT === "baseline" ? BASELINE : incumbent;
  const mutants = Array.from({ length: CANDIDATES }, (_, id) => ({ id, profile: mutate(incumbent, mrnd, sigma) }));
  const [control, ...results] = await Promise.all([
    runEval(incumbent, opp, seeds, controlSample),
    ...mutants.map((m) => runEval(m.profile, opp, seeds)),
  ]);
  sampleMatches = controlSample;
  const candidates = mutants.map((m, i) => ({ ...m, result: results[i]! }));

  let promoted: number | null = null;
  let confirm: EvalResult | null = null;
  const best = [...candidates].sort((a, b) => b.result.pointsPerMatch - a.result.pointsPerMatch)[0]!;
  if (best.result.pointsPerMatch > control.pointsPerMatch + PROMOTE_MARGIN) {
    const confirmSeeds = Array.from({ length: MATCHES }, (_, i) => seedBase + 104729 + i * 7919);
    const [cf, controlB] = await Promise.all([
      runEval(best.profile, opp, confirmSeeds),
      runEval(incumbent, opp, confirmSeeds),
    ]);
    confirm = cf;
    if (confirm.pointsPerMatch > controlB.pointsPerMatch + PROMOTE_MARGIN) {
      incumbent = best.profile;
      promoted = best.id;
    }
  }

  // all-seats: every bench wall is played from all four chairs, so a mirror
  // is exactly 0 and "vs baseline-v1 = par" means what it says.
  const [bench, benchPrev] = await Promise.all([
    runEval(incumbent, BASELINE, BENCH_SEEDS, undefined, true),
    runEval(incumbent, START_PROFILE, BENCH_SEEDS, undefined, true),
  ]);
  const evalHands = (r: EvalResult) => r.activity.hands;
  const work = {
    matches: MATCHES * (7 + (confirm ? 2 : 0) + 1),
    hands: evalHands(control) + candidates.reduce((n, c) => n + evalHands(c.result), 0) +
           (confirm ? evalHands(confirm) * 2 : 0) + evalHands(bench),
  };
  const changed = promoted === null ? null : Object.fromEntries(
    (Object.keys(incumbent) as (keyof BotProfile)[])
      .filter((k) => Math.abs(incumbent[k] - incumbentBefore[k]) > 1e-9)
      .map((k) => [k, { from: +incumbentBefore[k].toFixed(4), to: +incumbent[k].toFixed(4) }]),
  );
  history.push({
    gen, seeds: [seeds[0]!, seeds[seeds.length - 1]!], control, confirm, bench, benchPrev, work, changed,
    candidates: candidates.map((c) => ({ id: c.id, result: c.result, profile: c.profile })),
    promoted, incumbentAfter: incumbent, ms: Date.now() - t0,
  });
  flush("running");
  console.log(
    `gen ${gen}: control ${control.pointsPerMatch}pt · best ${best.result.pointsPerMatch}pt` +
    (confirm ? ` · confirm ${confirm.pointsPerMatch}pt` : "") +
    ` · ${promoted === null ? "kept" : `PROMOTED #${promoted}`}` +
    ` · vs baseline ${bench.chipsPerMatch > 0 ? "+" : ""}${bench.chipsPerMatch} · vs past champ ${benchPrev.chipsPerMatch > 0 ? "+" : ""}${benchPrev.chipsPerMatch} chips` +
    ` · ${work.matches}m/${work.hands}h · ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
}
flush("done");
console.log("final profile written to best-profile.json");

/**
 * CMA-ES over the bot dials — the era-4 optimizer (owner-approved 2026-08-28).
 *
 * Hansen's (mu/mu_w, lambda) CMA-ES, hand-rolled to keep the zero-dependency
 * stack: rank-based weights, cumulative step-size adaptation (CSA), rank-1 +
 * rank-mu covariance update, Jacobi eigendecomposition for sampling. Searches
 * in LOG space: every dial is positive and multiplicative, so log-space makes
 * the search scale-free and positivity automatic.
 *
 * Fitness: chips/match vs the frozen enemy (all-seats, common random numbers
 * per generation — fresh seed block each generation so nothing memorises
 * walls). Deterministic per --mutseed.
 *
 *   node tools/sim/cmaes.mjs --gens 30 --pop 14 --matches 48 \
 *     --start tools/sim/era3-start.json --enemy tools/sim/baseline-v2.json \
 *     --out tools/sim --mutseed 1 [--serial]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { prng } from "../../engine/src/wall.js";
import { DEFAULT_PROFILE, type BotProfile } from "../../engine/src/bots.js";
import { evaluate, setSimRuleset, type EvalResult } from "./evalcore.js";

const flag = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const GENS = Number(flag("--gens", "30"));
const LAMBDA = Number(flag("--pop", "14"));
const MATCHES = Number(flag("--matches", "48"));
const OUT = flag("--out", "tools/sim");
const MUTSEED = Number(flag("--mutseed", "1"));
const SERIAL = process.argv.includes("--serial");
const START_PATH = flag("--start", "tools/sim/era3-start.json");
const RULESET_ID = flag("--ruleset", "mjrc-standard");
setSimRuleset(RULESET_ID);
const ENEMY_PATH = flag("--enemy", "tools/sim/baseline-v2.json");

const load = (p: string): BotProfile => ({ ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(p, "utf8")) });
const START = load(START_PATH);
const ENEMY = load(ENEMY_PATH);
const KEYS = (Object.keys(DEFAULT_PROFILE) as (keyof BotProfile)[])
  // a 0-valued dial has no log; CMA can only steer dials the start profile turned on
  .filter((k) => START[k] > 0);
const N = KEYS.length;

/* ── strategy parameters (Hansen's defaults) ─────────────────────────── */
const MU = Math.floor(LAMBDA / 2);
const wRaw = Array.from({ length: MU }, (_, i) => Math.log(MU + 0.5) - Math.log(i + 1));
const wSum = wRaw.reduce((a, b) => a + b, 0);
const W = wRaw.map((w) => w / wSum);
const MU_EFF = 1 / W.reduce((a, w) => a + w * w, 0);
const C_SIGMA = (MU_EFF + 2) / (N + MU_EFF + 5);
const D_SIGMA = 1 + 2 * Math.max(0, Math.sqrt((MU_EFF - 1) / (N + 1)) - 1) + C_SIGMA;
const C_C = (4 + MU_EFF / N) / (N + 4 + 2 * MU_EFF / N);
const C_1 = 2 / ((N + 1.3) ** 2 + MU_EFF);
const C_MU = Math.min(1 - C_1, 2 * (MU_EFF - 2 + 1 / MU_EFF) / ((N + 2) ** 2 + MU_EFF));
const CHI_N = Math.sqrt(N) * (1 - 1 / (4 * N) + 1 / (21 * N * N));

/* ── tiny dense linear algebra ───────────────────────────────────────── */
type Mat = number[][];
const eye = (): Mat => Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? 1 : 0)));

/** Jacobi eigendecomposition of a symmetric matrix: A = V diag(d) V^T. */
function jacobiEig(A: Mat): { d: number[]; V: Mat } {
  const a = A.map((r) => r.slice());
  const V = eye();
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) off += a[i]![j]! * a[i]![j]!;
    if (off < 1e-14) break;
    for (let p = 0; p < N; p++) for (let q = p + 1; q < N; q++) {
      if (Math.abs(a[p]![q]!) < 1e-15) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
      const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < N; k++) {
        const akp = a[k]![p]!, akq = a[k]![q]!;
        a[k]![p] = c * akp - s * akq; a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < N; k++) {
        const apk = a[p]![k]!, aqk = a[q]![k]!;
        a[p]![k] = c * apk - s * aqk; a[q]![k] = s * apk + c * aqk;
      }
      for (let k = 0; k < N; k++) {
        const vkp = V[k]![p]!, vkq = V[k]![q]!;
        V[k]![p] = c * vkp - s * vkq; V[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  return { d: Array.from({ length: N }, (_, i) => Math.max(a[i]![i]!, 1e-20)), V };
}

/* ── seeded gaussians ────────────────────────────────────────────────── */
const rnd = prng((0xc3a0 + MUTSEED) >>> 0);
function gauss(): number {
  const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/* ── profile <-> log-vector ──────────────────────────────────────────── */
const toVec = (p: BotProfile): number[] => KEYS.map((k) => Math.log(p[k]));
const toProfile = (x: number[]): BotProfile => {
  const p = { ...START };
  KEYS.forEach((k, i) => { p[k] = +Math.exp(x[i]!).toFixed(4); });
  return p;
};

/* ── fitness: chips/match vs the frozen enemy, all-seats, fresh block ── */
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "evalworker.mjs");
function evalRemote(candidate: BotProfile, seeds: number[]): Promise<EvalResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`evalworker exited ${code}`));
      resolve(JSON.parse(out).result as EvalResult);
    });
    child.stdin.end(JSON.stringify({ candidate, incumbent: ENEMY, seeds, allSeats: true, rulesetId: RULESET_ID }));
  });
}
const POOL = Math.max(2, Math.min(16, cpus().length - 2));
async function fitnessAll(profiles: BotProfile[], seeds: number[]): Promise<number[]> {
  if (SERIAL) return profiles.map((p) => evaluate(p, ENEMY, seeds, undefined, { allSeats: true }).chipsPerMatch);
  const out: number[] = new Array(profiles.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(POOL, profiles.length) }, async () => {
    while (next < profiles.length) {
      const i = next++;
      out[i] = (await evalRemote(profiles[i]!, seeds)).chipsPerMatch;
    }
  }));
  return out;
}

/* ── the loop ────────────────────────────────────────────────────────── */
let m = toVec(START);
let sigma = 0.3;
let C: Mat = eye();
let pSigma = new Array(N).fill(0);
let pC = new Array(N).fill(0);
const history: { gen: number; best: number; mean: number; sigma: number; bestProfile: BotProfile }[] = [];

for (let gen = 0; gen < GENS; gen++) {
  const t0 = Date.now();
  const { d, V } = jacobiEig(C);
  const sqrtD = d.map(Math.sqrt);
  // sample lambda candidates: x = m + sigma * V * diag(sqrtD) * z
  const zs: number[][] = [], ys: number[][] = [], xs: number[][] = [];
  for (let k = 0; k < LAMBDA; k++) {
    const z = Array.from({ length: N }, gauss);
    const y = Array.from({ length: N }, (_, i) =>
      V[i]!.reduce((a, vij, j) => a + vij * sqrtD[j]! * z[j]!, 0));
    zs.push(z); ys.push(y);
    xs.push(y.map((yi, i) => m[i]! + sigma * yi));
  }
  const seeds = Array.from({ length: MATCHES }, (_, i) => 9_000_000 + gen * 400_000 + i * 7919);
  const fits = await fitnessAll(xs.map(toProfile), seeds);
  const order = Array.from({ length: LAMBDA }, (_, i) => i).sort((a, b) => fits[b]! - fits[a]!);

  // recombination
  const yW = new Array(N).fill(0);
  for (let r = 0; r < MU; r++) {
    const y = ys[order[r]!]!;
    for (let i = 0; i < N; i++) yW[i] += W[r]! * y[i]!;
  }
  m = m.map((mi, i) => mi + sigma * yW[i]!);

  // CSA path (whitened): C^{-1/2} y = V diag(1/sqrtD) V^T y
  const whiten = (v: number[]): number[] => {
    const t = Array.from({ length: N }, (_, j) => V.reduce((a, row, i) => a + row[j]! * v[i]!, 0) / sqrtD[j]!);
    return Array.from({ length: N }, (_, i) => V[i]!.reduce((a, vij, j) => a + vij * t[j]!, 0));
  };
  const wy = whiten(yW);
  const csaK = Math.sqrt(C_SIGMA * (2 - C_SIGMA) * MU_EFF);
  pSigma = pSigma.map((p, i) => (1 - C_SIGMA) * p + csaK * wy[i]!);
  const psNorm = Math.sqrt(pSigma.reduce((a, p) => a + p * p, 0));
  sigma *= Math.exp((C_SIGMA / D_SIGMA) * (psNorm / CHI_N - 1));

  // covariance paths
  const hSig = psNorm / Math.sqrt(1 - (1 - C_SIGMA) ** (2 * (gen + 1))) / CHI_N < 1.4 + 2 / (N + 1) ? 1 : 0;
  const ccK = Math.sqrt(C_C * (2 - C_C) * MU_EFF);
  pC = pC.map((p, i) => (1 - C_C) * p + hSig * ccK * yW[i]!);
  const c1a = C_1 * (1 - (1 - hSig) * C_C * (2 - C_C));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    let rankMu = 0;
    for (let r = 0; r < MU; r++) rankMu += W[r]! * ys[order[r]!]![i]! * ys[order[r]!]![j]!;
    C[i]![j] = (1 - c1a - C_MU) * C[i]![j]! + C_1 * pC[i]! * pC[j]! + C_MU * rankMu;
  }

  const best = fits[order[0]!]!;
  const mean = +(fits.reduce((a, b) => a + b, 0) / LAMBDA).toFixed(1);
  const bestProfile = toProfile(xs[order[0]!]!);
  history.push({ gen, best, mean, sigma: +sigma.toFixed(4), bestProfile });
  writeFileSync(join(OUT, "cma-best.json"), JSON.stringify(toProfile(m), null, 2) + "\n");
  writeFileSync(join(OUT, "cma-log.json"), JSON.stringify(history.map(({ bestProfile, ...r }) => r)) + "\n");
  console.log(`gen ${gen}: best ${best > 0 ? "+" : ""}${best} · pop mean ${mean > 0 ? "+" : ""}${mean} · sigma ${sigma.toFixed(3)} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log(`done — distribution mean written to ${join(OUT, "cma-best.json")}`);

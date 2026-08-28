/**
 * Unattended training series. Zero tokens — pure local CPU.
 *
 *   nohup caffeinate -is node tools/sim/overnight.mjs --hours 20 > tools/sim/overnight.out 2>&1 &
 *
 * Each cycle: run evolution with a VARIED config (opponent alternates
 * baseline/mirror, fresh mutation stream, alternating sample depth), then
 * score the resulting profile against the frozen baseline on FRESH held-out
 * seeds this cycle has never touched. Keep a hall of fame; every cycle chains
 * from the best-so-far, with periodic restarts from the seed profile so one
 * bad lineage cannot eat the night. Everything is logged to overnight-log.jsonl
 * and summarised in overnight-status.txt; the panel keeps showing the live run.
 */
import { execFileSync, spawnSync, spawn } from "node:child_process";
const runChild = (cmd, args, timeoutMs) => new Promise((resolve) => {
  const c = spawn(cmd, args, { stdio: "ignore" });
  const t = setTimeout(() => { c.kill("SIGKILL"); }, timeoutMs);
  c.on("close", (code) => { clearTimeout(t); resolve({ status: code }); });
  c.on("error", () => { clearTimeout(t); resolve({ status: -1 }); });
});
import { readFileSync, writeFileSync, appendFileSync, copyFileSync, existsSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { updateSeriesHistory } from "./build-series-history.js";
// CWD-PROOF: every path derives from this file's own location. A launch from
// the wrong directory silently orphaned the hall-of-fame chain once (bench
// -18 instead of +3.3) — never again.
process.chdir(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const HOURS = Number(argOf("--hours", "20"));
// Era parameters — defaults reproduce the era-2 series exactly, so a bare
// restart is unchanged. Era 3: --era 3 --enemy tools/sim/baseline-v1.json
//   --seed-profile tools/sim/era3-start.json --fitness chips
const ERA = Number(argOf("--era", "2"));
const FITNESS = argOf("--fitness", "points");
// Owner 2026-08-28: promotions land early in a cycle; gens 9-16 mostly
// re-confirm stability. Fewer gens per cycle = more fresh mutation streams
// and more held-out exams per night — breadth beats depth once the dial
// space is near-saturated.
const GENS = argOf("--gens", "16");
const DIR = "tools/sim";
const deadline = Date.now() + HOURS * 3600_000;
const log = (o) => appendFileSync(`${DIR}/overnight-log.jsonl`, JSON.stringify(o) + "\n");
const startedAt = Date.now();
const cyclesSoFar = [];
/** The panel reads this via <script src="overnight.js"> — file:// cannot fetch,
 * so the series state ships as JS, same trick as data.js. */
function flushPanel(statusLine) {
  writeFileSync(`${DIR}/overnight.js`, "window.OVERNIGHT = " + JSON.stringify({
    startedAt, deadline, now: Date.now(), hofScore, statusLine, cycles: cyclesSoFar,
  }) + ";\n");
  // Full multi-era cycle history for the panel's "all experiments" table.
  try {
    const lines = readFileSync(`${DIR}/overnight-log.jsonl`, "utf8").trim().split("\n")
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    writeFileSync(`${DIR}/log.js`, "window.SERIES_LOG = " + JSON.stringify(lines) + ";\n");
  } catch {}
}

// ERA 2 (2026-08-27): the enemy and the seed are both the frozen era-1
// champion — king-of-the-hill. baseline-v0 stays as a continuity yardstick.
const ENEMY = argOf("--enemy", `${DIR}/baseline-v1.json`);
const V0 = `${DIR}/baseline-v0.json`;
const SEED_PROFILE = argOf("--seed-profile", `${DIR}/baseline-v1.json`);
const HOF = `${DIR}/hall-of-fame.json`;         // best profile ever, by held-out score
let hofScore = -Infinity;
if (existsSync(`${DIR}/hall-of-fame-score.txt`)) hofScore = Number(readFileSync(`${DIR}/hall-of-fame-score.txt`, "utf8"));
flushPanel("series starting — cycle 1 evolving");

/** Live remote freshness: while a cycle grinds, push the per-generation
 * data.js every few minutes so the hosted panel tracks generations, not just
 * cycle boundaries. Guarded by a busy flag so it never overlaps cycle-end
 * pushes; failures (offline) are silent and harmless. */
let gitBusy = false;
import { statSync } from "node:fs";
let lastDataPush = 0;
setInterval(() => {
  if (gitBusy) return;
  try {
    const m = statSync(`${DIR}/data.js`).mtimeMs;
    if (m <= lastDataPush) return;
    gitBusy = true;
    flushPanel(cyclesSoFar.length ? `cycle ${cyclesSoFar.length + 1} evolving` : "cycle 1 evolving");
    for (const args of [["add", "-f", `${DIR}/data.js`, `${DIR}/overnight.js`, `${DIR}/log.js`],
                        ["commit", "-q", "-m", "live: mid-cycle data tick"],
                        ["push", "-q"]]) {
      const g = spawnSync("git", args, { stdio: "ignore", timeout: 90_000 });
      if (g.status !== 0 && args[0] === "push") break;
    }
    lastDataPush = m;
  } catch {} finally { gitBusy = false; }
}, 4 * 60_000).unref();

function headtohead(profilePath, seedBlock, tablePath = ENEMY) {
  // fresh 160-match held-out evaluation — same enemy for admission and bench;
  // admission and scoreboard must never face different opponents
  const out = execFileSync("node", [`${DIR}/headtohead.mjs`, profilePath, "160", String(seedBlock), tablePath],
    { encoding: "utf8", timeout: 30 * 60_000 });
  const m = out.match(/chips\/match\s+(-?[\d.]+)/);
  const sm = out.match(/^STATS (.+)$/m);
  let stats = null; try { if (sm) stats = JSON.parse(sm[1]); } catch {}
  return { chips: m ? Number(m[1]) : NaN, stats, raw: out.trim() };
}

let cycle = 0;
while (Date.now() < deadline) {
  cycle++;
  const opponent = cycle % 3 === 0 ? "mirror" : "baseline";   // mostly the enemy, mirror as a check
  const matches = cycle % 2 === 0 ? "96" : "48";              // alternate breadth and depth
  const restart = cycle % 5 === 0;                             // periodic fresh start
  const start = restart || !existsSync(HOF) ? SEED_PROFILE : HOF;
  const t0 = Date.now();
  const args = [`${DIR}/evolve.mjs`, "--gens", GENS, "--matches", matches, "--out", DIR,
                "--start", start, "--opponent", opponent, "--baseline", ENEMY, "--fitness", FITNESS,
                "--mutseed", String(9000 + cycle * 137)];
  const run = await runChild("node", args, 4 * 3600_000);
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  if (run.status !== 0) {
    log({ cycle, error: `evolve exited ${run.status}`, mins });
    cyclesSoFar.push({ cycle, enemy: ENEMY.split("/").pop().replace(".json", ""), stats: null, opponent, matches: Number(matches), generations: 0, mins: Number(mins), heldOutChips: null, improved: false });
    flushPanel(`cycle ${cycle} FAILED · cycle ${cycle + 1} evolving`);
    continue;                                                  // a bad cycle must not end the night
  }
  // Preserve the cycle's full per-generation history before anything else
  // touches data.js — the panel's generation table resets every cycle, this is
  // where the detail survives (owner, 2026-08-28).
  try {
    if (!existsSync(`${DIR}/runs`)) (await import("node:fs")).mkdirSync(`${DIR}/runs`);
    copyFileSync(`${DIR}/data.js`, `${DIR}/runs/era${ERA}-cycle-${String(cycle).padStart(3, "0")}.js`);
    updateSeriesHistory({ dataPath: `${DIR}/data.js`, outPath: `${DIR}/series-history.js`, era: 2, cycle,
      completedAt: new Date().toISOString(), opponent });
  } catch {}
  // FAIR ADMISSION (the +3.3 mirage lesson): candidate and the reigning
  // hall-of-famer are BOTH measured on the SAME fresh block — never compare
  // scores from different blocks, that is how variance gets crowned.
  const block = ERA * 2_500_000 + cycle * 50_000;   // per-era virgin seed blocks
  let verdict = { chips: NaN, raw: "headtohead failed" };
  let reigning = { chips: -Infinity };
  let vsV0 = { chips: NaN };
  try {
    verdict = headtohead(`${DIR}/best-profile.json`, block);
    if (existsSync(HOF)) reigning = headtohead(HOF, block);
    vsV0 = headtohead(`${DIR}/best-profile.json`, block, V0);   // continuity axis
  } catch {}
  const MARGIN = 4;
  const improved = Number.isFinite(verdict.chips) &&
    (!existsSync(HOF) ? verdict.chips > MARGIN
                      : verdict.chips > (reigning.chips ?? -Infinity) + MARGIN);
  if (improved) {
    copyFileSync(`${DIR}/best-profile.json`, HOF);
    writeFileSync(`${DIR}/hall-of-fame-score.txt`, String(verdict.chips));
    hofScore = verdict.chips;
  }
  log({ era: ERA, enemy: ENEMY.split("/").pop().replace(".json", ""), fitness: FITNESS, ts: new Date().toISOString(), stats: verdict.stats, cycle, opponent, matches: Number(matches), generations: 16, start, mins, heldOutChips: verdict.chips,
        reigningOnSameBlock: reigning.chips, vsV0: vsV0.chips, improved, hofScore });
  cyclesSoFar.push({ cycle, enemy: ENEMY.split("/").pop().replace(".json", ""), stats: verdict.stats, opponent, matches: Number(matches), generations: 16, mins: Number(mins), heldOutChips: verdict.chips,
                    reigningOnSameBlock: reigning.chips, admissionMargin: MARGIN, vsV0: vsV0.chips, improved });
  flushPanel(`cycle ${cycle} done · cycle ${cycle + 1} evolving`);
  // ── mobile monitoring: STATUS.md pushed to GitHub every cycle ──
  while (gitBusy) await new Promise((r) => setTimeout(r, 2000));
  gitBusy = true;
  try {
    const rows = cyclesSoFar.map((c) =>
      `| ${c.cycle} | ${c.opponent} | ${c.matches} | ${c.heldOutChips ?? "FAIL"} | ${c.vsV0 ?? ""} | ${c.improved ? "**NEW BEST**" : ""} | ${c.mins}m |`).join("\n");
    writeFileSync(`${DIR}/STATUS.md`, [
      `# Training series — era ${ERA} (vs ${ENEMY.split("/").pop()}, fitness: ${FITNESS})`,
      ``,
      `Updated ${new Date().toISOString()} · ${((deadline - Date.now()) / 3600_000).toFixed(1)}h remaining · ruleset mjrc-standard (3-10 faan)`,
      ``,
      `**Hall of fame vs ${ENEMY.split("/").pop().replace(".json", "")}: ${hofScore === -Infinity ? "none yet — the enemy IS the reigning champion, so 0 is par" : hofScore + " chips/match"}**`,
      ``,
      `Units: chips are the HK payment ladder (a 3-faan discard win moves 16 chips; the 10-faan cap moves 256).`,
      `All chip numbers here are AVERAGES per one-wind-round match over 160-match blocks — a single great match can swing +400 by itself.`,
      `"vs v0" is the same candidate scored against the OLD defenseless baseline, for continuity with era 1 (champion sat ~+30-70 there).`,
      ``,
      `| cycle | opponent | matches | vs v1 (chips/match) | vs v0 | | mins |`,
      `|---|---|---|---|---|---|---|`,
      rows,
      ``,
      `Files: hall-of-fame.json (best weights) · overnight-log.jsonl · runs/cycle-NNN.js (full histories)`,
    ].join("\n") + "\n");
    for (const args of [["add", `${DIR}/STATUS.md`, `${DIR}/overnight-log.jsonl`, `${DIR}/hall-of-fame.json`, `${DIR}/hall-of-fame-score.txt`,
                          `${DIR}/data.js`, `${DIR}/overnight.js`, `${DIR}/log.js`, `${DIR}/series-history.js`, `${DIR}/experiments.js`, `${DIR}/baselines.js`, `${DIR}/threat-audit.js`, `${DIR}/panel.html`, "-f"],
                        ["commit", "-q", "-m", `era2: cycle ${cycle} — ${verdict.chips} vs v1, ${vsV0.chips} vs v0`],
                        ["push", "-q"]]) {
      const g = spawnSync("git", args, { stdio: "ignore", timeout: 120_000 });
      if (g.status !== 0 && args[0] !== "commit") break;   // offline push must not kill the night
    }
  } catch {} finally { gitBusy = false; }
  const status = [
    `era-${ERA} training — cycle ${cycle} done (${mins} min) · ${((deadline - Date.now()) / 3600_000).toFixed(1)}h remaining`,
    `latest cycle: opponent=${opponent} matches/eval=${matches} start=${start}`,
    `held-out vs ${ENEMY.split("/").pop().replace(".json", "")}: ${verdict.chips} chips/match ${improved ? "— NEW HALL OF FAME" : ""} · vs v0: ${vsV0.chips}`,
    `hall of fame: ${hofScore === -Infinity ? "none yet (0 = par vs the champion)" : hofScore + " chips/match"} (${HOF})`,
  ].join("\n");
  writeFileSync(`${DIR}/overnight-status.txt`, status + "\n");
  console.log(status.split("\n")[0] + ` · held-out ${verdict.chips}`);
}
console.log("overnight budget spent — done");

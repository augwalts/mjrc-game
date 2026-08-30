/**
 * Dial trajectories: how every weight moved across the whole training history.
 * Scans the per-cycle archives in runs/ (each stores the full 27-dial profile
 * at every generation) and emits one point per CYCLE ENDPOINT — the profile
 * that cycle finished with — tagged by era and whether it was admitted.
 *
 *   node tools/sim/build-dials-history.js
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const runs = readdirSync(join(DIR, "runs")).filter((f) => f.endsWith(".js")).sort();

// admissions + ruleset, from the harness log
const admitted = new Map();
for (const line of readFileSync(join(DIR, "overnight-log.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line);
    admitted.set(`${r.era}-${r.cycle}`, { improved: !!r.improved, chips: r.heldOutChips, ruleset: r.rulesetId ?? "mjrc-standard" });
  } catch { /* skip */ }
}

let keys = null;
const points = [];
for (const f of runs) {
  const m = /era(\d+)-cycle-(\d+)\.js$/.exec(f);
  if (!m) continue;
  const era = Number(m[1]), cycle = Number(m[2]);
  let j;
  try {
    const raw = readFileSync(join(DIR, "runs", f), "utf8");
    j = JSON.parse(raw.slice(raw.indexOf("=") + 1).trim().replace(/;$/, ""));
  } catch { continue; }
  const hist = j.history ?? [];
  if (!hist.length) continue;
  keys ??= j.keys ?? Object.keys(hist[0].incumbentAfter);
  const end = hist[hist.length - 1].incumbentAfter;
  const meta = admitted.get(`${era}-${cycle}`) ?? {};
  points.push({
    era, cycle,
    ruleset: j.ruleset ?? meta.ruleset ?? "mjrc-standard",
    promotions: hist.filter((g) => g.promoted !== null).length,
    admitted: !!meta.improved,
    chips: meta.chips ?? null,
    v: keys.map((k) => +Number(end[k] ?? 0).toFixed(4)),
  });
}
points.sort((a, b) => a.era - b.era || a.cycle - b.cycle);

// frozen reference bots, so the eras have anchors even where archives predate runs/
const refs = [];
for (const [name, file] of [["default", null], ["v0", "baseline-v0.json"], ["v1", "baseline-v1.json"],
                           ["v2", "baseline-v2.json"], ["v3", "baseline-v3.json"], ["v4", "baseline-v4.json"]]) {
  if (!file) continue;
  try {
    const p = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    refs.push({ name, v: keys.map((k) => (p[k] === undefined ? null : +Number(p[k]).toFixed(4))) });
  } catch { /* missing is fine */ }
}

writeFileSync(join(DIR, "dials-history.js"),
  "window.DIALS_HISTORY = " + JSON.stringify({ keys, points, refs, generated: new Date().toISOString().slice(0, 10) }) + ";\n");
console.log(`dials-history.js: ${points.length} cycle endpoints, ${keys.length} dials, eras ${[...new Set(points.map((p) => p.era))].join(",")}`);

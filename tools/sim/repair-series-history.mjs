/**
 * Repair the longitudinal archive after the era-label bug (2026-08-28).
 *
 * overnight.mjs hardcoded `era: 2` when archiving cycle histories, so every
 * era-3 cycle (benched vs baseline-v2) landed in series-history.js labeled
 * era 2 — and, because the archive dedups by era:cycle:gen, each one CLOBBERED
 * the real era-2 cycle of the same number. The source is fixed (era: ERA), but
 * the era-3 process launched before the fix keeps writing mislabeled points
 * until it exits.
 *
 * This script is IDEMPOTENT — run it any time, and once more after the era-3
 * series ends:
 *   1. any point labeled era 2 whose bench baseline is baseline-v2 → era 3
 *   2. restore the true era-2 points (cycles 1-15) from
 *      era2-archive-snapshot.json (extracted from git 1c08cd1, pre-era-3)
 *
 *   node tools/sim/repair-series-history.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, "series-history.js");

const text = readFileSync(OUT, "utf8");
const prefix = "window.SERIES_HISTORY = ";
const data = JSON.parse(text.slice(text.indexOf(prefix) + prefix.length).replace(/;\s*$/, ""));
const snapshot = JSON.parse(readFileSync(join(DIR, "era2-archive-snapshot.json"), "utf8"));

let relabeled = 0;
for (const p of data.points) {
  if (p.era === 2 && typeof p.baseline === "string" && p.baseline.includes("baseline-v2")) {
    p.era = 3;
    relabeled++;
  }
}
const unique = new Map();
for (const p of data.points) unique.set(`${p.era}:${p.cycle}:${p.gen}`, p);
let restored = 0;
for (const p of snapshot) {
  const key = `2:${p.cycle}:${p.gen}`;
  if (!unique.has(key)) { unique.set(key, p); restored++; }
}
const ordered = [...unique.values()].sort((a, b) => a.era - b.era || a.cycle - b.cycle || a.gen - b.gen);
writeFileSync(OUT, `window.SERIES_HISTORY = ${JSON.stringify({ version: 1, generated: new Date().toISOString(), points: ordered })};\n`);
console.log(`relabeled ${relabeled} era-3 points, restored ${restored} era-2 points, total ${ordered.length}`);

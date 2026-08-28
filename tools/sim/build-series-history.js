/**
 * Build the panel's compact longitudinal generation history.
 *
 * Backfill every archived cycle from Git's committed data.js snapshots:
 *   node tools/sim/build-series-history.js --backfill
 *
 * The overnight harness also calls updateSeriesHistory() after each cycle so
 * future charts do not depend on reconstructing Git history.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_DATA = "tools/sim/data.js";
const DEFAULT_OUT = "tools/sim/series-history.js";

function parseWindowAssignment(text, globalName) {
  const prefix = `window.${globalName} = `;
  const start = text.indexOf(prefix);
  if (start < 0) throw new Error(`missing ${prefix}`);
  return JSON.parse(text.slice(start + prefix.length).replace(/;\s*$/, ""));
}

function readSeries(path) {
  if (!existsSync(path)) return { version: 1, generated: null, points: [] };
  try {
    return parseWindowAssignment(readFileSync(path, "utf8"), "SERIES_HISTORY");
  } catch {
    return { version: 1, generated: null, points: [] };
  }
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function cyclePoints(data, meta) {
  return (data.history || []).map((record) => {
    const bench = record.bench ?? record.control;
    const activity = bench?.activity;
    const activityHands = activity?.hands || 0;
    const claimTotal = (activity?.chows || 0) + (activity?.pungs || 0) + (activity?.kongs || 0);
    return {
      era: meta.era,
      cycle: meta.cycle,
      gen: record.gen,
      completedAt: meta.completedAt ?? data.updated ?? null,
      sourceCommit: meta.sourceCommit ?? null,
      baseline: data.baseline ?? null,
      opponent: data.trainingOpponent ?? meta.opponent ?? null,
      promoted: record.promoted !== null,
      chipsPerMatch: finite(bench?.chipsPerMatch),
      refusedPerHand: finite(bench?.refusedPerHand),
      drawRate: finite(bench?.drawRate),
      meanFaan: finite(bench?.meanFaan),
      threatDetection: finite(bench?.threatDetection),
      claimsPerHand: finite(bench?.claimsPerHand),
      chowsPerHand: activityHands ? finite(activity.chows / activityHands) : null,
      pungsPerHand: activityHands ? finite(activity.pungs / activityHands) : null,
      kongsPerHand: activityHands ? finite(activity.kongs / activityHands) : null,
      chowClaimShare: claimTotal ? finite(activity.chows / claimTotal) : null,
      pungClaimShare: claimTotal ? finite(activity.pungs / claimTotal) : null,
      kongClaimShare: claimTotal ? finite(activity.kongs / claimTotal) : null,
      discardWinsPerHand: activityHands ? finite(activity.winsOnDiscard / activityHands) : null,
      selfDrawsPerHand: activityHands ? finite(activity.selfDraws / activityHands) : null,
    };
  });
}

function writeSeries(path, points) {
  const unique = new Map();
  for (const point of points) unique.set(`${point.era}:${point.cycle}:${point.gen}`, point);
  const ordered = [...unique.values()].sort((a, b) =>
    a.era - b.era || a.cycle - b.cycle || a.gen - b.gen);
  const payload = { version: 1, generated: new Date().toISOString(), points: ordered };
  writeFileSync(path, `window.SERIES_HISTORY = ${JSON.stringify(payload)};\n`);
  return payload;
}

export function updateSeriesHistory({
  dataPath = DEFAULT_DATA,
  outPath = DEFAULT_OUT,
  era,
  cycle,
  completedAt = null,
  opponent = null,
}) {
  const current = readSeries(outPath);
  const data = parseWindowAssignment(readFileSync(dataPath, "utf8"), "SIM_DATA");
  const withoutCycle = current.points.filter((p) => p.era !== era || p.cycle !== cycle);
  return writeSeries(outPath, withoutCycle.concat(cyclePoints(data, { era, cycle, completedAt, opponent })));
}

export function backfillSeriesHistory({ outPath = DEFAULT_OUT } = {}) {
  const lines = execFileSync("git", ["log", "--reverse", "--format=%H%x09%cI%x09%s", "--", DEFAULT_DATA], {
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  const points = [];
  for (const line of lines) {
    const [hash, committedAt, ...subjectParts] = line.split("\t");
    const subject = subjectParts.join("\t");
    const match = subject.match(/^(era2: cycle|overnight: cycle)\s+(\d+)\b/);
    if (!match) continue;
    const era = match[1].startsWith("era2") ? 2 : 1;
    const cycle = Number(match[2]);
    try {
      const source = execFileSync("git", ["show", `${hash}:${DEFAULT_DATA}`], { encoding: "utf8" });
      const data = parseWindowAssignment(source, "SIM_DATA");
      points.push(...cyclePoints(data, { era, cycle, completedAt: committedAt, sourceCommit: hash }));
    } catch (error) {
      console.warn(`skip ${hash.slice(0, 8)} era ${era} cycle ${cycle}: ${error.message}`);
    }
  }
  return writeSeries(outPath, points);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const payload = backfillSeriesHistory();
  const eras = [...new Set(payload.points.map((p) => p.era))];
  console.log(`series-history.js: ${payload.points.length} generations across eras ${eras.join(", ")}`);
}

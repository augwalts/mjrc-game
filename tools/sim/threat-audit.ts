/**
 * Does the table read actually work? Play matches; at every win, ask what the
 * three opponents' threat reads said about the WINNER just before the win —
 * detection rate, false alarms, and hand-size calibration (estimated faan vs
 * the faan actually paid). Writes threat-audit.js for the panel.
 *
 *   node tools/sim/threat-audit.mjs [matches=30]
 */
import { writeFileSync } from "node:fs";
import { prng } from "../../engine/src/wall.js";
import { decideAction, DEFAULT_PROFILE, type BotConfig } from "../../engine/src/bots.js";
import { assessSeatThreat } from "../../engine/src/threat.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import { startMatch, startNextHand, applyAction, legalActions } from "../../engine/src/reducer.js";
import { viewFor, SEATS } from "./driver.js";

const N = Number(process.argv[2] ?? 30);
let wins = 0, detected = 0, flags = 0, falseFlags = 0, matchCount = 0;
const errs: number[] = [];

for (let m = 0; m < N; m++) {
  matchCount++;
  const seed = 950_000 + m * 7919;
  const cfgs: BotConfig[] = SEATS.map((s) => ({
    ruleset: MJRC_STANDARD, rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  let { state, events } = startMatch({ seed, ruleset: MJRC_STANDARD, matchLength: "oneWindRound" } as any);
  // reads of each seat BY an opponent, refreshed as the hand runs
  let reads: (ReturnType<typeof assessSeatThreat> | null)[] = [null, null, null, null];
  for (let guard = 0; guard < 200_000; guard++) {
    for (const e of events) {
      if (e.type === "winOnDiscard" || e.type === "selfDraw") {
        wins++;
        const w = (e.payload as { context: { seat: number } }).context.seat;
        const faan = (e.payload as { score: { faan: number } }).score.faan;
        const r = reads[w];
        if (r && r.threat > 0.3) detected++;
        if (r) errs.push(r.expectedFaan - faan);
        // false alarms: strongly-flagged seats that did NOT win this hand
        for (const s of SEATS) if (s !== w && reads[s] && reads[s]!.threat > 0.5) { falseFlags++; }
        for (const s of SEATS) if (reads[s] && reads[s]!.threat > 0.5) flags++;
      }
      if (e.type === "handEnd") reads = [null, null, null, null];
    }
    if (state.phase === "matchEnd") break;
    if (state.phase === "handEnd") { ({ state, events } = startNextHand(state)); continue; }
    let acted = false;
    for (const seat of SEATS) {
      const options = legalActions(state, seat);
      if (options.length === 0) continue;
      const v = viewFor(state, seat);
      // refresh this seat's read of every OTHER seat (cheap; reuse the view)
      for (const s of SEATS) if (s !== seat) reads[s] = assessSeatThreat(v, s as 0 | 1 | 2 | 3, MJRC_STANDARD);
      ({ state, events } = applyAction(state, decideAction(v, options, cfgs[seat]!)));
      acted = true;
      break;
    }
    if (!acted) throw new Error("stuck");
  }
}
const bias = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length);
const mae = errs.reduce((a, b) => a + Math.abs(b), 0) / Math.max(1, errs.length);
const out = {
  matches: matchCount, wins,
  detectionRate: detected / Math.max(1, wins),
  falseAlarmRate: falseFlags / Math.max(1, flags),
  faanBias: +bias.toFixed(2), faanMAE: +mae.toFixed(2),
  generated: new Date().toISOString().slice(0, 16).replace("T", " "),
};
writeFileSync("tools/sim/threat-audit.js", "window.THREAT_AUDIT = " + JSON.stringify(out) + ";\n");
console.log(out);

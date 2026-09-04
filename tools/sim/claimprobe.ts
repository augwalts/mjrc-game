/** Why are claims refused? Tally assessClaim reasons over live matches. */
import { prng } from "../../engine/src/wall.js";
import { decideAction, assessClaim, shapeOf, chooseRoute, DEFAULT_PROFILE, type BotConfig } from "../../engine/src/bots.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import { startMatch, startNextHand, applyAction, legalActions, type MatchState } from "../../engine/src/reducer.js";
import { viewFor, SEATS } from "./driver.js";

const reasons: Record<string, number> = {};
let taken = 0, offers = 0;

for (let m = 0; m < 30; m++) {
  const seed = 910_000 + m * 7919;
  const cfgs: BotConfig[] = SEATS.map((s) => ({
    ruleset: MJRC_STANDARD, rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  let { state } = startMatch({ seed, ruleset: MJRC_STANDARD, matchLength: "oneWindRound" } as any);
  for (let guard = 0; guard < 100_000; guard++) {
    if (state.phase === "matchEnd") break;
    if (state.phase === "handEnd") { state = startNextHand(state).state; continue; }
    let acted = false;
    for (const seat of SEATS) {
      const legal = legalActions(state, seat);
      if (legal.length === 0) continue;
      const v = viewFor(state, seat);
      for (const a of legal) {
        if (a.type === "claim" && a.option.kind !== "win") {
          offers++;
          const verdict: any = assessClaim(v, a.option as any, cfgs[seat]!, undefined as any);
          const key = verdict?.take ? "TAKEN" : (verdict?.reason ?? "unknown");
          reasons[key] = (reasons[key] ?? 0) + 1;
          if (verdict?.take) taken++;
        }
      }
      state = applyAction(state, decideAction(v, legal, cfgs[seat]!)).state;
      acted = true;
      break;
    }
    if (!acted) throw new Error("stuck");
  }
}
console.log("claim offers (non-win):", offers, "| would take:", taken);
console.log(Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join("\n"));

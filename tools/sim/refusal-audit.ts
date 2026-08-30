/**
 * Why are hands refused? Plays matches under any ruleset and dissects every
 * refusedWin: the faan it held, whether the seat was concealed, and what
 * (if anything) it would have scored. Also reports how often a hand that ends
 * in 流局 had at least one refusal in it — the "unpayable shapes deadlock"
 * hypothesis (owner question 2026-08-29).
 *
 *   node tools/sim/refusal-audit.mjs [matches=40] [rulesetId] [profile.json]
 */
import { readFileSync } from "node:fs";
import { prng } from "../../engine/src/wall.js";
import { decideAction, DEFAULT_PROFILE, type BotConfig, type BotProfile } from "../../engine/src/bots.js";
import { ruleset as rulesetById, MJRC_STANDARD } from "../../rulesets/src/presets.js";
import { startMatch, startNextHand, applyAction, legalActions } from "../../engine/src/reducer.js";
import { viewFor, SEATS } from "./driver.js";

const N = Number(process.argv[2] ?? 40);
const RULES = rulesetById(process.argv[3] ?? "") ?? MJRC_STANDARD;
const PROFILE: BotProfile = process.argv[4]
  ? { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(process.argv[4], "utf8")) }
  : DEFAULT_PROFILE;

let hands = 0, draws = 0, refusals = 0, drawsWithRefusal = 0, handsWithRefusal = 0;
let concealedRefusals = 0, zeroFaan = 0;
const byFaan = new Map<number, number>();
const byShape = new Map<string, number>();

for (let m = 0; m < N; m++) {
  const seed = 31_000_000 + m * 7919;
  const cfgs: BotConfig[] = SEATS.map((s) => ({
    ruleset: RULES, profile: PROFILE, rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  let { state, events } = startMatch({ seed, ruleset: RULES, matchLength: "oneWindRound" } as never);
  let refusedThisHand = 0;
  for (let guard = 0; guard < 200_000; guard++) {
    for (const e of events as never[]) {
      const ev = e as { type: string; payload: Record<string, unknown> };
      if (ev.type === "refusedWin") {
        refusals++; refusedThisHand++;
        const score = ev.payload.score as { faan: number; awards: { id: string }[] };
        const melds = (ev.payload.melds ?? []) as { kind: string }[];
        byFaan.set(score.faan, (byFaan.get(score.faan) ?? 0) + 1);
        if (score.faan === 0) zeroFaan++;
        if (melds.length === 0) concealedRefusals++;
        const shape = melds.length === 0 ? "concealed"
          : melds.every((x) => x.kind === "chow") ? `${melds.length} chow meld(s)`
          : "has pung/kong meld";
        byShape.set(shape, (byShape.get(shape) ?? 0) + 1);
      }
      if (ev.type === "exhaustiveDraw") { draws++; if (refusedThisHand > 0) drawsWithRefusal++; }
      if (ev.type === "handEnd") {
        hands++; if (refusedThisHand > 0) handsWithRefusal++;
        refusedThisHand = 0;
      }
    }
    if (state.phase === "matchEnd") break;
    if (state.phase === "handEnd") { ({ state, events } = startNextHand(state)); continue; }
    let acted = false;
    for (const seat of SEATS) {
      const options = legalActions(state, seat);
      if (options.length === 0) continue;
      ({ state, events } = applyAction(state, decideAction(viewFor(state, seat), options, cfgs[seat]!)));
      acted = true; break;
    }
    if (!acted) break;
  }
}
const pct = (a: number, b: number) => `${(100 * a / Math.max(1, b)).toFixed(0)}%`;
console.log(`ruleset ${RULES.id} (floor ${RULES.minimumFaan} faan) · ${N} matches · ${hands} hands`);
console.log(`refusals ${refusals} (${(refusals / hands).toFixed(2)}/hand) · hands containing one: ${pct(handsWithRefusal, hands)}`);
console.log(`  by faan held: ${[...byFaan.entries()].sort((a, b) => a[0] - b[0]).map(([f, n]) => `${f}f:${n} (${pct(n, refusals)})`).join(" · ")}`);
console.log(`  zero-faan (no scoring pattern at all): ${pct(zeroFaan, refusals)} · fully concealed seat: ${pct(concealedRefusals, refusals)}`);
console.log(`  shape: ${[...byShape.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${pct(n, refusals)}`).join(" · ")}`);
console.log(`draws ${draws} (${pct(draws, hands)} of hands) · of those, ${pct(drawsWithRefusal, draws)} had a refusal in them`);

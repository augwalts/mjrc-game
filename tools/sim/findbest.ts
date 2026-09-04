/** Find the hero's best match: champion (East) vs 3× baseline over N seeds. */
import { readFileSync } from "node:fs";
import { prng } from "../../engine/src/wall.js";
import { decideAction, DEFAULT_PROFILE, type BotConfig } from "../../engine/src/bots.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import { playMatch, SEATS, type Decide } from "./driver.js";

const hero = { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(process.argv[2]!, "utf8")) };
const table = { ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(process.argv[3]!, "utf8")) };
const oneIx = process.argv.indexOf("--one");
const only = oneIx >= 0 ? Number(process.argv[oneIx + 1]) : null;
let best = { seed: 0, chips: -Infinity };
for (let i = 0; i < (only !== null ? 1 : 40); i++) {
  const seed = only !== null ? only : 3_500_000 + i * 7919;
  const cfgs: BotConfig[] = SEATS.map((s) => ({
    ruleset: MJRC_STANDARD, profile: s === 0 ? hero : table,
    rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  const decides: Decide[] = SEATS.map((s) => (v, l) => decideAction(v, l, cfgs[s]!));
  const r = playMatch({ seed, ruleset: MJRC_STANDARD, matchLength: "oneWindRound" } as any, decides);
  if (r.chips[0]! > best.chips) best = { seed, chips: r.chips[0]! };
}
console.log(JSON.stringify(best));

/**
 * The bots, as the table sees them: a `BotBrain` (worker/src/table.ts §2) over
 * the engine's `decideAction`. The table hands a bot the SAME redacted view a
 * human socket gets and a list of what is legal; nothing here can reach the
 * wall or another seat's tiles, and the type of the `view` parameter is what
 * makes that a compile error rather than a code-review catch.
 *
 * The two adapters between wire and engine live in protocol/src/seatview.ts,
 * shared with the client's coach. Which bot sits where is a lineup by seat, so
 * a table's bots are stable across hibernation without the brain needing any
 * state of its own. The header's displayName for a bot seat comes from the
 * same lineup (index.ts).
 */
import type { SeatIndex } from "../../engine/src/types.js";
import { DEFAULT_PROFILE, decideAction, type BotProfile } from "../../engine/src/bots.js";
import { ruleset } from "../../rulesets/src/presets.js";
import { actionsOf, seatViewOf } from "../../protocol/src/seatview.js";
import type { BotBrain } from "../../worker/src/table.js";
import PROFILES from "./bot-profiles.json" with { type: "json" };

export interface BotSeatSpec {
  /** Key into bot-profiles.json (the training programme's frozen champions). */
  profile: string;
  displayName: string;
}

/** Solo's "champion + friends" table, the most human-feeling lineup, plus a
 *  fourth for all-bot tables. Indexed by seat. */
export const BOT_LINEUP: readonly BotSeatSpec[] = [
  { profile: "v1", displayName: "Kwan" },
  { profile: "v4", displayName: "Sifu" },
  { profile: "persona", displayName: "Ming" },
  { profile: "v2", displayName: "Ling" },
];

const profileFor = (seat: SeatIndex): BotProfile => {
  const key = BOT_LINEUP[seat]?.profile ?? "v4";
  const dials = (PROFILES as Record<string, Partial<BotProfile>>)[key] ?? {};
  return { ...DEFAULT_PROFILE, ...dials };
};

export const bots: BotBrain = {
  decide(view, legal, rand) {
    const actions = actionsOf(view.seat, legal);
    if (actions.length === 0) return null;
    const R = ruleset(view.rulesetId);
    if (R === undefined) {
      throw new Error(`bot at seat ${view.seat}: unknown ruleset ${view.rulesetId}`);
    }
    return decideAction(seatViewOf(view), actions, {
      ruleset: R,
      rnd: rand,
      profile: profileFor(view.seat),
    });
  },
  /** Think time inside the window; the table clamps it to its own bounds. */
  paceMs(_legal, rand) {
    return 700 + Math.floor(rand() * 1800);
  },
};

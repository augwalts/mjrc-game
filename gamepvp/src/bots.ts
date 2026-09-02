/**
 * The bots, as the table sees them: a `BotBrain` (worker/src/table.ts §2) over
 * the engine's `decideAction`. The table hands a bot the SAME redacted view a
 * human socket gets and a list of what is legal; nothing here can reach the
 * wall or another seat's tiles, and the type of the `view` parameter is what
 * makes that a compile error rather than a code-review catch.
 *
 * The two adapters between wire and engine live in protocol/src/seatview.ts,
 * shared with the client's coach. `BOT_CATALOGUE` is the full set of profiles
 * a table's creator can pick from (gamepvp/src/index.ts's `GET /api/bots`
 * and `POST /api/tables` `bots`); `BOT_LINEUP` is only the DEFAULT pick when
 * no picks are given. Which profile a seat actually runs is carried on the
 * header's `PlayerRef.playerId` (`bot:<key>`), so a table's bots are stable
 * across hibernation without the brain needing any state of its own.
 */
import type { SeatIndex } from "../../engine/src/types.js";
import { DEFAULT_PROFILE, decideAction, type BotProfile } from "../../engine/src/bots.js";
import { ruleset } from "../../rulesets/src/presets.js";
import { actionsOf, seatViewOf } from "../../protocol/src/seatview.js";
import type { PlayerRef } from "../../protocol/src/events.js";
import type { BotBrain } from "../../worker/src/table.js";
import PROFILES from "./bot-profiles.json" with { type: "json" };

export interface BotSeatSpec {
  /** Key into bot-profiles.json (the training programme's frozen champions). */
  profile: string;
  displayName: string;
}

/** Solo's "champion + friends" table, the most human-feeling lineup, plus a
 *  fourth for all-bot tables. Indexed by seat. Also the default when a table
 *  is created with no `bots` picks. */
export const BOT_LINEUP: readonly BotSeatSpec[] = [
  { profile: "v1", displayName: "Kwan" },
  { profile: "v4", displayName: "Sifu" },
  { profile: "persona", displayName: "Ming" },
  { profile: "v2", displayName: "Ling" },
];

/** One row per profile in bot-profiles.json — the picker's menu. `strength` is
 *  a rough 1-5 read on how hard the profile plays, for sorting/display only;
 *  it is not consulted by the engine. */
export interface BotCatalogueEntry {
  readonly key: string;
  readonly displayName: string;
  readonly blurb: string;
  readonly strength: number;
}

export const BOT_CATALOGUE: readonly BotCatalogueEntry[] = [
  { key: "v0", displayName: "Bo", blurb: "never defends, a beginner", strength: 1 },
  { key: "v1", displayName: "Kwan", blurb: "loose claimer", strength: 2 },
  { key: "v2", displayName: "Ling", blurb: "disciplined", strength: 3 },
  { key: "v3", displayName: "Fai", blurb: "protects a lead, folds fast", strength: 4 },
  { key: "v4", displayName: "Sifu", blurb: "the champion, defends hard", strength: 5 },
  { key: "persona", displayName: "Ming", blurb: "an action player", strength: 4 },
];

const CATALOGUE_BY_KEY = new Map(BOT_CATALOGUE.map((e) => [e.key, e]));

/** Used by `POST /api/tables` (worker/src/index.ts's `Platform.isBotKey`) to
 *  reject an unknown pick with 400 before any table is opened. */
export const isBotCatalogueKey = (key: string): boolean => CATALOGUE_BY_KEY.has(key);

export const catalogueEntry = (key: string): BotCatalogueEntry | undefined => CATALOGUE_BY_KEY.get(key);

/** `bot:<key>` → `<key>`, or null if `playerId` is not a bot ref at all. */
const keyOfPlayerId = (playerId: string): string | null =>
  playerId.startsWith("bot:") ? playerId.slice("bot:".length) : null;

/** The profile a seat's `PlayerRef` names, falling back to the seat's spot in
 *  `BOT_LINEUP` when the ref is missing or its key was never a real profile
 *  (a defensive fallback — `POST /api/tables` already rejects unknown keys). */
const profileFor = (seat: SeatIndex, player: PlayerRef | undefined): BotProfile => {
  const key = (player && keyOfPlayerId(player.playerId)) ?? BOT_LINEUP[seat]?.profile ?? "v4";
  const dials = (PROFILES as Record<string, Partial<BotProfile>>)[key] ?? {};
  return { ...DEFAULT_PROFILE, ...dials };
};

export const bots: BotBrain = {
  decide(view, legal, rand, player) {
    const actions = actionsOf(view.seat, legal);
    if (actions.length === 0) return null;
    const R = ruleset(view.rulesetId);
    if (R === undefined) {
      throw new Error(`bot at seat ${view.seat}: unknown ruleset ${view.rulesetId}`);
    }
    return decideAction(seatViewOf(view), actions, {
      ruleset: R,
      rnd: rand,
      profile: profileFor(view.seat, player),
    });
  },
  /** Think time inside the window; the table clamps it to its own bounds. */
  paceMs(_legal, rand) {
    return 700 + Math.floor(rand() * 1800);
  },
};

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
import type { ClaimOption, SeatIndex } from "../../engine/src/types.js";
import {
  DEFAULT_PROFILE, claimDecision, decideAction, rankDiscards, shouldKong,
  type BotConfig, type BotProfile,
} from "../../engine/src/bots.js";
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

/**
 * The default lineup pick for seat `seat` — used in two places that both mean
 * "a bot seat with no key of its own": `tableInitOf` (worker/src/index.ts's
 * `TableSpec.seatPlan` entry `{ kind: 'bot' }`, no `bot`) and the table
 * object's `/fill` (worker/src/table.ts `TableDeps.defaultBotFor`, installed
 * via `installTableRules` in ./index.ts). One function so the two paths can
 * never pick different defaults for the same seat.
 */
export const defaultBotFor = (seat: SeatIndex): { key: string; displayName: string } => {
  const spec = BOT_LINEUP[seat]!;
  return { key: spec.profile, displayName: spec.displayName };
};

/** `bot:<key>` → `<key>`, or null if `playerId` is not a bot ref at all.
 *  Strips a trailing `#2`, `#3`, ... first — worker/src/table.ts's
 *  `botPlayerId` appends one when two seats at the same table pick the same
 *  catalogue key, to keep `match_players` rows unique, and that suffix must
 *  never reach a profile-dial lookup: seat 2's "Sifu" plays exactly like
 *  seat 1's, not a profile nobody configured. */
const keyOfPlayerId = (playerId: string): string | null => {
  if (!playerId.startsWith("bot:")) return null;
  const rest = playerId.slice("bot:".length);
  const hash = rest.indexOf("#");
  return hash === -1 ? rest : rest.slice(0, hash);
};

/** The profile a seat's `PlayerRef` names, falling back to the seat's spot in
 *  `BOT_LINEUP` when the ref is missing or its key was never a real profile
 *  (a defensive fallback — `POST /api/tables` already rejects unknown keys). */
const profileFor = (seat: SeatIndex, player: PlayerRef | undefined): BotProfile => {
  const key = (player && keyOfPlayerId(player.playerId)) ?? BOT_LINEUP[seat]?.profile ?? "v4";
  const dials = (PROFILES as Record<string, Partial<BotProfile>>)[key] ?? {};
  return { ...DEFAULT_PROFILE, ...dials };
};

/** The champion's dials, for GRADING only — a human's play is always measured
 *  against v4, never against whichever profile happens to be seated across
 *  from them (a table of easy bots must not read as "you're playing well").
 *  Same shape as `profileFor`, just pinned to one key. */
const CHAMPION_PROFILE: BotProfile = {
  ...DEFAULT_PROFILE,
  ...((PROFILES as Record<string, Partial<BotProfile>>)["v4"] ?? {}),
};

const sameClaimOption = (a: ClaimOption, b: ClaimOption): boolean =>
  a.kind === b.kind && (a.with ?? []).join() === (b.with ?? []).join();

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
  /**
   * Think time inside the window; the table clamps it to its own bounds
   * (`TableConfig.botMinPaceMs`/`botMaxPaceMs`, 250-900ms by default — §8a
   * rule 1, "turns against three bots felt 1-4s each"). Kept inside that
   * band here too, not just left to the clamp, so a table running a
   * different config still sees the same spread this was tuned for.
   */
  paceMs(_legal, rand) {
    return 250 + Math.floor(rand() * 650);
  },
  /**
   * The record behind "played like the engine" (client/gamepvp desktop-only
   * scoreboard). Discards use `rankDiscards`; claims/passes use
   * `claimDecision`; kongs use `shouldKong` — the same functions Solo's
   * client-side coach (client/game/game.ts gradeMyDiscard/gradeMyClaim) reads,
   * just run here instead of trusted from a client. A win is never graded:
   * `decideAction` takes any legal win before assessing anything else, so
   * there is no alternative to compare it against.
   */
  grade(view, legal, action, rand) {
    const R = ruleset(view.rulesetId);
    if (R === undefined) return null;
    const v = seatViewOf(view);
    const cfg: BotConfig = { ruleset: R, rnd: rand, profile: CHAMPION_PROFILE };

    if (action.type === "discard") {
      const ranked = rankDiscards(v, cfg);
      if (ranked.length === 0) return null;
      let best = ranked[0]!;
      for (const d of ranked) if (d.score > best.score) best = d;
      const mine = ranked.find((d) => d.tile === action.tile);
      if (!mine) return null;
      return { matched: mine.tile === best.tile, gap: Math.max(0, best.score - mine.score) };
    }

    if (action.type === "concealedKong" || action.type === "addedKong") {
      const form = action.type === "concealedKong" ? "concealed" : "added";
      const yes = shouldKong(v, action.tile, form, cfg);
      return { matched: yes, gap: yes ? 0 : 1 };
    }

    if (action.type === "claim" || action.type === "pass") {
      // A win is never a decision to grade against.
      if (action.type === "claim" && action.option.kind === "win") return null;
      const options: ClaimOption[] = legal.claims?.options ?? [];
      if (options.length === 0) return null; // nothing was on offer (incl. a 搶槓 window)
      const want = claimDecision(v, options, cfg);
      const took: ClaimOption | null = action.type === "claim" ? action.option : null;
      // A claim's "gap" is coarser than a discard's — assessClaim scores
      // options, it does not rank every alternative on one scale — so it is
      // 0 for a match and 1 otherwise, same convention Solo's coach used.
      const matched = took === null ? want === null : want !== null && sameClaimOption(took, want);
      return { matched, gap: matched ? 0 : 1 };
    }

    return null; // declareWin — a win is never a decision
  },
};

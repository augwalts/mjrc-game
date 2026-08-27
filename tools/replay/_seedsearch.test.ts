import { describe, expect, it } from "vitest";
import {
  FLOWERS_START,
  WALL_SIZE,
  counts,
  distanceToReady,
  prng,
  type Action,
  type SeatIndex,
} from "@mjrc/engine";
import {
  EVENT_SCHEMA_VERSION,
  isOwnSeatView,
  type FourSeats,
  type GameEvent,
  type MatchLogHeader,
} from "@mjrc/protocol";
import { DEFAULT_RULESET_ID } from "@mjrc/rulesets";
import {
  ENGINE_VERSION,
  applyAction,
  legalActions,
  startMatch,
  startNextHand,
  type MatchConfig,
  type MatchState,
} from "../../engine/src/reducer.js";
import {
  checkFoldInvariants,
  concealedCount,
  foldAt,
  foldEvent,
  foldStates,
  handSlots,
  initialFoldState,
  liveWallCount,
  parseMatchLog,
  seatSnapshotOf,
  visibleTileCounts,
  type FoldedState,
} from "./fold.js";
import { bufferHost, parseArgs, recoverMatchSeed, runCli, verifyLog } from "./cli.js";
import { it } from "vitest";
function pick(state: MatchState, seat: SeatIndex, legal: readonly Action[], rnd: () => number): Action {
  for (const a of legal) if (a.type === "declareWin") return a;
  for (const a of legal) if (a.type === "claim" && a.option.kind === "win") return a;
  const roll = rnd();

  const claims = legal.filter((a) => a.type === "claim");
  if (claims.length > 0) {
    if (roll < 0.3) return claims[0];
    const pass = legal.find((a) => a.type === "pass");
    if (pass) return pass;
  }
  // 暗槓 and 加槓 — the second opens a 搶槓 window, which nothing else does.
  const kongs = legal.filter((a) => a.type === "concealedKong" || a.type === "addedKong");
  if (kongs.length > 0 && roll < 0.6) return kongs[0];

  return closestToReady(state, seat, legal);
}

/**
 * Cut the tile that leaves the lowest distance to ready 聽牌. Ties go to the
 * first candidate, which `legalActions` emits in ascending tile order, so the
 * choice is pinned by the code and not by an object's key order (§5.5).
 *
 * The count array is built once and stepped down and back up per candidate:
 * this runs tens of thousands of times per corpus and rebuilding it each time
 * was most of the suite's runtime.
 */
function closestToReady(state: MatchState, seat: SeatIndex, legal: readonly Action[]): Action {
  const st = state.seats[seat];
  const discards = legal.filter(
    (a): a is Extract<Action, { type: "discard" }> => a.type === "discard",
  );
  if (discards.length === 0) return legal[0];
  const c = counts(st.drawn === null ? st.hand : [...st.hand, st.drawn]);
  let best = discards[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const d of discards) {
    c[d.tile]--;
    const distance = distanceToReady(c, st.melds.length);
    c[d.tile]++;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = d;
    }
  }
  return best;
}

/** Drive the real reducer to 圈 completion. No Math.random, no clock (§5.5). */
function playMatch(seed: number): GeneratedMatch {
  const config: MatchConfig = {
    matchId: `m-${seed}`,
    seed,
    rulesetId: DEFAULT_RULESET_ID,
    dealer: 0,
    matchLength: "oneWindRound",
    startingChips: 0,
    startedAt: 0,
  };
  const opening = startMatch(config);
  let state = opening.state;
  const events: GameEvent[] = [...opening.events];
  const rnd = prng((seed ^ 0x5bf03635) >>> 0);

  for (let step = 0; step < 100000; step++) {
    if (state.phase === "matchEnd") break;
    if (state.phase === "handEnd") {
      const a = startNextHand(state);
      state = a.state;
      events.push(...a.events);
      continue;
    }
    const open = state.claim?.offers.find((o) => o.answer === null) ?? null;
    const seat: SeatIndex = open ? open.seat : state.turn;
    const legal = legalActions(state, seat);
    if (legal.length === 0) throw new Error(`seat ${seat} has no legal action in ${state.phase}`);
    const applied = applyAction(state, pick(state, seat, legal, rnd));
    state = applied.state;
    events.push(...applied.events);
  }
  if (state.phase !== "matchEnd") throw new Error(`match ${seed} did not finish`);
  const header = headerFor(config.matchId);
  return { seed, header, events, final: state, states: foldStates(header, events) };
}

it("seed search for 搶槓 under the current policy", () => {
  let firstWindow = -1, firstRob = -1;
    // handSeedFor correlates ADJACENT match seeds (transcriber finding, 2026-08-27):
  // sequential seeds replay each other's walls. Space the search by a prime so
  // every probe is a genuinely fresh wall set.
  for (let i = 1; i <= 3000 && (firstWindow < 0 || firstRob < 0); i++) {
    const seed = i * 7919;
    let m;
    try { m = playMatch(seed); } catch { continue; }
    const window = m.events.some((e) => e.type === "robKongWindow");
    const rob = m.events.some((e) =>
      e.type === "winOnDiscard" && (e.payload as any).context?.robbedKong === true);
    if (window && firstWindow < 0) firstWindow = seed;
    if (rob && firstRob < 0) firstRob = seed;
  }
  console.log("FIRST robKongWindow seed:", firstWindow, "| FIRST landed 搶槓 seed:", firstRob);
}, 300000);

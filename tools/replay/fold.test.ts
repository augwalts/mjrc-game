/**
 * The fold is only worth having if it is right at EVERY index, so this suite
 * folds generated logs to every one of them and checks the same physical facts
 * a table checks: 144 tiles exist, they are all somewhere, nobody holds more
 * than fourteen, no tile has five copies, and the wall only ever shrinks.
 *
 * Implements DESIGN.md §8 (tools/) and §5.5 (replay is re-execution).
 * Terminology: ../../TERMINOLOGY.md — Hong Kong Old Style only.
 *
 * THE LOGS ARE GENERATED, NOT FIXTURES. A hand-written fixture only ever
 * exercises the paths its author thought of; driving the real reducer with a
 * seeded policy produces claims, all three kong forms, 花 replacement chains,
 * refused wins, 流局 and multi-hand 連莊 sequences without anyone having to
 * anticipate them. The policy is seeded from `prng` and takes a win whenever
 * one is legal, so the corpus is byte-identical on every run (§5.5) — a test
 * that is only sometimes green is not a test.
 */

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

/* ── the corpus ────────────────────────────────────────────────────────── */

interface GeneratedMatch {
  seed: number;
  header: MatchLogHeader;
  events: GameEvent[];
  final: MatchState;
  /** Folded once; every sweep below reads this rather than re-folding. */
  states: FoldedState[];
}

function headerFor(matchId: string): MatchLogHeader {
  const players = [0, 1, 2, 3].map((i) => ({
    playerId: `p${i}`,
    displayName: `seat ${i}`,
    seat: i as SeatIndex,
    bot: true,
  })) as FourSeats<MatchLogHeader["players"][number]>;
  return {
    v: EVENT_SCHEMA_VERSION,
    matchId,
    engineVersion: ENGINE_VERSION,
    rulesetId: DEFAULT_RULESET_ID,
    startedAt: 0,
    players,
    matchLength: "oneWindRound",
    startingChips: [0, 0, 0, 0],
  };
}

/**
 * The policy driving the corpus. Deliberately NOT bots.ts: this suite is about
 * the fold, and a policy that changes when someone tunes a bot weight would
 * change the corpus underneath it. What it needs is coverage and determinism,
 * so it takes a legal win always, claims and kongs some of the time, and
 * otherwise cuts the tile that leaves the hand closest to ready 聽牌.
 *
 * `rnd` is consumed EXACTLY ONCE per decision — the same discipline bots.ts
 * keeps — so the stream position depends on how many decisions were taken and
 * never on what the hands held.
 *
 * A purely uniform policy was tried first and does not work: it draws 流局 in
 * most hands, the dealer repeats 連莊 forever, and a wind round never
 * completes. That is ENGINE-AUDIT's "69% dead draws" reproducing itself, and
 * it is why the discard here steers toward ready.
 */
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

/**
 * Five of these are arbitrary. 197975 is not, and it is pinned rather than
 * hoped for: it produces a LANDED 搶槓 under this exact policy. Nothing else in
 * the policy's reach exercises `revertAddedKong` — 搶槓 needs a seat one tile
 * from a win at the exact moment another seat upgrades a 碰 — and a branch
 * reached by luck is a branch that is one refactor from never running again.
 *
 * They are tied to the policy AND to the engine's decision math: the 2026-08-27
 * distanceToReady fix silently retired the previous pins (47/133). If this
 * assertion fails after touching either, redo the search (prime-spaced seeds —
 * adjacent match seeds share walls via handSeedFor).
 */
const SEEDS = [1, 2, 3, 5, 8, 197975];
const CORPUS: GeneratedMatch[] = SEEDS.map(playMatch);


/* ── the one tolerated gap, and why it is tolerated ────────────────────── */

/**
 * A REPORTED BUG IN THE REDUCER, NOT A HOLE IN THE FOLD.
 *
 * `replaceDrawnFlowers` in engine/src/reducer.ts, on the path where the wall
 * runs out mid-replacement, does `st.drawn = null; return false` — the 花 is
 * dropped on the floor and NO event is emitted. That is a silent transition of
 * exactly the kind protocol/src/events.ts §1 forbids, and the tile is simply
 * gone: the log cannot say where it went, so no fold can put it anywhere. The
 * count of 143 that follows is the fold telling the truth about a broken log.
 *
 * So this suite tolerates that ONE shape — a missing 花, with the wall already
 * spent — and nothing else. Anything wider fails. When the reducer is fixed
 * this exemption simply stops being reachable.
 */
function knownFlowerLoss(s: FoldedState): boolean {
  if (liveWallCount(s) !== 0) return false;
  const c = visibleTileCounts(s);
  for (let t = 0; t < c.length; t++) {
    const want = t >= FLOWERS_START ? 1 : 4;
    if (c[t] === want) continue;
    if (t >= FLOWERS_START && c[t] === 0) continue;
    return false;
  }
  return true;
}

/** Violations this suite is not willing to explain away. */
function unexplained(s: FoldedState): string[] {
  const bad = checkFoldInvariants(s);
  if (bad.length === 0) return [];
  return knownFlowerLoss(s) ? [] : bad;
}

/**
 * Assertions are batched: an `expect` per state per seat would be six figures
 * of them and minutes of runtime, so each sweep collects sentences and asserts
 * once. A failure still names the match, the event index and the fact.
 */
function expectNoFailures(failures: readonly string[]): void {
  expect(failures.slice(0, 8)).toEqual([]);
  expect(failures).toHaveLength(0);
}

/* ── the corpus is worth folding ───────────────────────────────────────── */

describe("the generated corpus", () => {
  it("produces multi-hand matches with real event volume", () => {
    const failures: string[] = [];
    for (const m of CORPUS) {
      if (m.events.length < 500) failures.push(`${m.header.matchId}: only ${m.events.length} events`);
      if (m.final.handsPlayed < 4) failures.push(`${m.header.matchId}: only ${m.final.handsPlayed} hands`);
    }
    expectNoFailures(failures);
  });

  it("is deterministic — the same seed replays byte for byte", () => {
    // One match is enough: an unseeded decision anywhere in the reducer or the
    // policy diverges within a few hundred events, and this compares thousands.
    const first = CORPUS[CORPUS.length - 1];
    const again = playMatch(first.seed);
    expect(again.events).toHaveLength(first.events.length);
    expect(JSON.stringify(again.events)).toBe(JSON.stringify(first.events));
  });

  it("exercises the paths a hand-written fixture would have missed", () => {
    const seen = new Set<string>();
    for (const m of CORPUS) for (const e of m.events) seen.add(e.type);
    const missing = [
      "deal",
      "flowerReplacement",
      "draw",
      "discard",
      "claimOffered",
      "claimDeclined",
      "claimed",
      "kongReplacement",
      "concealedKong",
      "addedKong",
      "robKongWindow",
      "handEnd",
      "matchEnd",
    ].filter((t) => !seen.has(t));
    expectNoFailures(missing.map((t) => `no ${t} anywhere in the corpus`));

    // All three §5.2 hand outcomes, and every kong form.
    const outcomes = new Set<string>();
    for (const m of CORPUS) for (const h of m.states[m.states.length - 1].hands) outcomes.add(h.outcome);
    expect([...outcomes].sort()).toEqual(["exhaustiveDraw", "selfDraw", "winOnDiscard"]);
  });
});

/* ── the invariant sweep ───────────────────────────────────────────────── */

describe("folding to every index", () => {
  it("holds every physical invariant at every step of every log", () => {
    const failures: string[] = [];
    for (const m of CORPUS) {
      expect(m.states).toHaveLength(m.events.length + 1);
      for (const s of m.states) {
        const bad = unexplained(s);
        if (bad.length > 0) failures.push(`${m.header.matchId} @${s.eventIndex}: ${bad.join("; ")}`);
      }
    }
    expectNoFailures(failures);
  });

  it("conserves 144 tiles at every step", () => {
    const failures: string[] = [];
    for (const m of CORPUS) {
      for (const s of m.states) {
        if (s.eventIndex === 0) continue;
        let held = 0;
        for (const n of visibleTileCounts(s)) held += n;
        const total = held + liveWallCount(s);
        if (total !== WALL_SIZE && !knownFlowerLoss(s)) {
          failures.push(`${m.header.matchId} @${s.eventIndex}: ${total} tiles, expected ${WALL_SIZE}`);
        }
      }
    }
    expectNoFailures(failures);
  });

  it("never lets a seat hold more than fourteen tiles", () => {
    const failures: string[] = [];
    for (const m of CORPUS) {
      for (const s of m.states) {
        if (s.eventIndex === 0) continue;
        for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) {
          const st = s.seats[i];
          if (concealedCount(st) > 14) {
            failures.push(`${m.header.matchId} @${s.eventIndex} seat ${i}: ${concealedCount(st)} concealed`);
          }
          // A declared set is three slots whatever its tile count, so a 槓 is
          // four tiles in three slots and the total still reads 13 or 14.
          const slots = handSlots(st);
          if (slots !== 13 && slots !== 14) {
            failures.push(`${m.header.matchId} @${s.eventIndex} seat ${i}: ${slots} hand slots`);
          }
        }
      }
    }
    expectNoFailures(failures);
  });

  it("never shows a fifth copy of a tile, or a second copy of a 花", () => {
    const failures: string[] = [];
    for (const m of CORPUS) {
      for (const s of m.states) {
        const c = visibleTileCounts(s);
        for (let t = 0; t < c.length; t++) {
          const max = t >= FLOWERS_START ? 1 : 4;
          if (c[t] > max) {
            failures.push(`${m.header.matchId} @${s.eventIndex}: tile ${t} ×${c[t]}, max ${max}`);
          }
        }
      }
    }
    expectNoFailures(failures);
  });

  it("only ever shrinks the wall inside a hand, and refills it on the deal", () => {
    const failures: string[] = [];
    for (const m of CORPUS) {
      let previous = -1;
      for (const s of m.states) {
        if (s.eventIndex === 0) continue;
        const live = liveWallCount(s);
        if (s.lastEventType === "deal") {
          if (live <= 0) failures.push(`${m.header.matchId} @${s.eventIndex}: deal left ${live} live`);
        } else if (live > previous) {
          failures.push(`${m.header.matchId} @${s.eventIndex}: wall grew ${previous} → ${live}`);
        }
        previous = live;
      }
    }
    expectNoFailures(failures);
  });

  it("agrees with itself: foldAt(n) is foldStates()[n]", () => {
    for (const m of CORPUS.slice(0, 3)) {
      for (const n of [0, 1, 7, 40, 123, m.events.length - 1, m.events.length]) {
        if (n < 0 || n > m.events.length) continue;
        expect(summary(foldAt(m.header, m.events, n))).toEqual(summary(m.states[n]));
      }
    }
  });

  it("clamps an out-of-range index instead of throwing", () => {
    const m = CORPUS[0];
    expect(foldAt(m.header, m.events, -5).eventIndex).toBe(0);
    expect(foldAt(m.header, m.events, m.events.length + 99).eventIndex).toBe(m.events.length);
  });

  it("never mutates the state it was handed", () => {
    const m = CORPUS[0];
    let s = initialFoldState(m.header);
    for (let i = 0; i < 80; i++) {
      const before = JSON.stringify(summary(s));
      const next = foldEvent(s, m.events[i]);
      expect(JSON.stringify(summary(s))).toBe(before);
      expect(next).not.toBe(s);
      s = next;
    }
  });
});

/** A structural digest — enough to catch drift, cheap enough to compare often. */
function summary(s: FoldedState): unknown {
  return {
    phase: s.phase,
    seq: s.seq,
    ts: s.ts,
    eventIndex: s.eventIndex,
    handIndex: s.handIndex,
    dealer: s.dealer,
    turn: s.turn,
    roundWind: s.roundWind,
    wall: [s.wallIndex, s.wallEnd],
    seats: s.seats.map((st) => [st.hand, st.drawn, st.melds, st.flowers, st.discards, st.chips]),
    hands: s.hands.length,
  };
}

/* ── the log's own account of itself ───────────────────────────────────── */

describe("the folded state matches what the log says about itself", () => {
  it("lands on the standings and placements the match end recorded", () => {
    for (const m of CORPUS) {
      const s = m.states[m.states.length - 1];
      const end = m.events[m.events.length - 1];
      expect(end.type).toBe("matchEnd");
      if (end.type !== "matchEnd") continue;
      expect(s.seats.map((st) => st.chips)).toEqual([...end.payload.standings]);
      expect(s.placements).toEqual([...end.payload.placements]);
      expect(s.hands).toHaveLength(end.payload.handsPlayed);
      expect(s.matchOver).toBe(true);
      expect(s.phase).toBe("matchEnd");
    }
  });

  it("chips move only by the deltas the hand ends recorded, and they sum to zero", () => {
    for (const m of CORPUS) {
      const s = m.states[m.states.length - 1];
      const running = [0, 0, 0, 0];
      for (const h of s.hands) {
        expect(h.chipDeltas.reduce((a, b) => a + b, 0)).toBe(0);
        for (let i = 0; i < 4; i++) running[i] += h.chipDeltas[i];
        expect(running).toEqual([...h.standings]);
      }
      expect(s.seats.map((st) => st.chips)).toEqual(running);
    }
  });

  it("summarises every hand with an outcome, and a faan figure exactly when won", () => {
    const failures: string[] = [];
    for (const m of CORPUS) {
      for (const h of m.states[m.states.length - 1].hands) {
        const where = `${m.header.matchId} hand ${h.handIndex}`;
        if (h.outcome === "exhaustiveDraw") {
          if (h.winner !== null || h.faan !== null || h.winningTile !== null) {
            failures.push(`${where}: 流局 with a winner or a faan figure`);
          }
        } else {
          if (h.winner === null || h.faan === null || h.winningTile === null) {
            failures.push(`${where}: a win with no winner, faan or winning tile`);
          }
          // 3 faan minimum (§4) — a hand under it is refused, never paid.
          if ((h.faan ?? 0) < 3) failures.push(`${where}: paid out ${h.faan} faan`);
          if (h.selfDraw !== (h.outcome === "selfDraw")) failures.push(`${where}: 自摸 flag disagrees`);
        }
        if (h.events <= 0) failures.push(`${where}: ${h.events} events`);
      }
    }
    expectNoFailures(failures);
  });

  it("caps at the 13-faan limit 爆棚 and records the uncapped total behind it", () => {
    const failures: string[] = [];
    let capped = 0;
    for (const m of CORPUS) {
      for (const h of m.states[m.states.length - 1].hands) {
        if (h.faan === null) continue;
        if (h.faan > 13) failures.push(`${m.header.matchId} hand ${h.handIndex}: ${h.faan} faan paid`);
        if (h.capped) {
          capped++;
          if ((h.rawFaan ?? 0) <= 13) {
            failures.push(`${m.header.matchId} hand ${h.handIndex}: capped but raw ${h.rawFaan}`);
          }
        }
      }
    }
    expectNoFailures(failures);
    void capped;
  });

  it("puts a robbed 加槓 back to the 碰 it grew from, and hands the tile over", () => {
    let robbed = 0;
    const failures: string[] = [];
    for (const m of CORPUS) {
      for (let i = 0; i < m.events.length; i++) {
        const e = m.events[i];
        if (e.type !== "winOnDiscard" || e.payload.context.robbedKong !== true) continue;
        robbed++;
        const where = `${m.header.matchId} @${i}`;
        const declarer = e.payload.context.from;
        const winner = e.payload.context.seat;
        const tile = e.payload.context.winningTile;

        const was = m.states[i].seats[declarer].melds.find(
          (x) => x.kind === "kong" && x.addedToPung === true && x.tiles[0] === tile,
        );
        if (!was) failures.push(`${where}: there was no 加槓 of ${tile} to rob`);

        const now = m.states[i + 1].seats[declarer].melds.find(
          (x) => (x.kind === "pung" || x.kind === "kong") && x.tiles[0] === tile,
        );
        if (!now || now.kind !== "pung" || now.tiles.length !== 3) {
          failures.push(`${where}: the 加槓 did not revert to a 碰`);
        }
        // The fourth copy is the winning tile now, held apart by the winner.
        if (m.states[i + 1].seats[winner].drawn !== tile) {
          failures.push(`${where}: the robbed tile did not reach the winner`);
        }
      }
    }
    expectNoFailures(failures);
    // 搶槓 is the only path through `revertAddedKong`. Losing it would leave
    // that branch untested, so its absence is a failure, not a shrug.
    expect(robbed, "the corpus produced no 搶槓").toBeGreaterThan(0);
  });

  it("counts refused wins without moving a tile for them", () => {
    let refusals = 0;
    const failures: string[] = [];
    for (const m of CORPUS) {
      for (let i = 0; i < m.events.length; i++) {
        if (m.events[i].type !== "refusedWin") continue;
        refusals++;
        const before = m.states[i];
        const after = m.states[i + 1];
        const where = `${m.header.matchId} @${i}`;
        if (JSON.stringify(before.seats) !== JSON.stringify(after.seats)) {
          failures.push(`${where}: a refused win moved tiles`);
        }
        if (after.refusals.length !== before.refusals.length + 1) {
          failures.push(`${where}: the refusal was not recorded`);
        }
        const r = after.refusals[after.refusals.length - 1];
        if (r.faan >= r.minimumFaan) failures.push(`${where}: ${r.faan} faan is not below ${r.minimumFaan}`);
      }
    }
    expectNoFailures(failures);
    // A below-minimum declaration is the whole reason `refusedWin` exists
    // (§5.2). If the corpus stopped producing them this suite would be quietly
    // weaker, so the absence of one is itself a failure.
    expect(refusals).toBeGreaterThan(0);
  });
});

/* ── the per-seat view ─────────────────────────────────────────────────── */

describe("the per-seat redacted view", () => {
  it("gives a seat its own tiles and nobody else's, at every index", () => {
    const failures: string[] = [];
    for (const m of CORPUS.slice(0, 3)) {
      for (let i = 0; i <= m.events.length; i += 7) {
        const truth = m.states[i];
        for (let seat = 0 as SeatIndex; seat < 4; seat = (seat + 1) as SeatIndex) {
          const snap = seatSnapshotOf(seat, truth);
          const where = `${m.header.matchId} @${i} seen by ${seat}`;
          for (const v of snap.seats) {
            if (v.seat === seat) {
              if (!isOwnSeatView(v)) {
                failures.push(`${where}: own seat came back redacted`);
                continue;
              }
              if (JSON.stringify(v.hand) !== JSON.stringify(truth.seats[seat].hand)) {
                failures.push(`${where}: own hand was altered`);
              }
              if (v.drawn !== truth.seats[seat].drawn) failures.push(`${where}: own drawn tile was altered`);
            } else {
              if (isOwnSeatView(v)) {
                failures.push(`${where}: seat ${v.seat}'s tiles leaked`);
                continue;
              }
              if (Object.prototype.hasOwnProperty.call(v, "hand")) {
                failures.push(`${where}: seat ${v.seat} carries a hand field`);
              }
              if (v.handCount !== truth.seats[v.seat].hand.length) {
                failures.push(`${where}: seat ${v.seat} tile count is wrong`);
              }
              if (v.holdingDrawn !== (truth.seats[v.seat].drawn !== null)) {
                failures.push(`${where}: seat ${v.seat} drawn flag is wrong`);
              }
            }
          }
        }
      }
    }
    expectNoFailures(failures);
  });

  it("keeps another seat's 暗槓 face down and shows the owner their own", () => {
    let checked = 0;
    const failures: string[] = [];
    for (const m of CORPUS) {
      for (let i = 0; i < m.events.length; i++) {
        const e = m.events[i];
        if (e.type !== "concealedKong") continue;
        checked++;
        const tile = e.payload.tile;
        const owner = e.payload.seat;
        const other = ((owner + 1) % 4) as SeatIndex;
        const after = m.states[i + 1];
        const where = `${m.header.matchId} @${i} 暗槓 ${tile}`;

        const ownView = seatSnapshotOf(owner, after).seats[owner];
        if (!isOwnSeatView(ownView)) {
          failures.push(`${where}: the owner's own seat came back redacted`);
          continue;
        }
        const own = ownView.melds.find((x) => x.kind === "kong" && x.concealed && x.tiles[0] === tile);
        if (!own || own.tiles.length !== 4) failures.push(`${where}: the owner cannot see their own 槓`);

        const theirs = seatSnapshotOf(other, after).seats[owner];
        const hidden = theirs.melds.filter((x) => x.kind === "kong" && x.concealed);
        if (hidden.length === 0) failures.push(`${where}: the 槓 vanished for seat ${other}`);
        for (const h of hidden) {
          if (h.tiles !== null) failures.push(`${where}: seat ${other} can read a face-down 槓`);
        }
      }
    }
    expectNoFailures(failures);
    expect(checked, "the corpus produced no 暗槓 to redact").toBeGreaterThan(0);
  });

  it("reports live tiles, never the wall's order", () => {
    const m = CORPUS[0];
    for (let i = 0; i <= m.events.length; i += 37) {
      const truth = m.states[i];
      const snap = seatSnapshotOf(1, truth);
      expect(snap.wallRemaining).toBe(liveWallCount(truth));
      expect(JSON.stringify(snap)).not.toContain("\"wall\"");
    }
  });
});

/* ── gate 2 ────────────────────────────────────────────────────────────── */

describe("--verify — gate 2 from DESIGN.md §3", () => {
  it("recovers the match seed the log never recorded", () => {
    for (const m of CORPUS) expect(recoverMatchSeed(m.events)).toBe(m.seed >>> 0);
  });

  it("returns null rather than a wrong seed when the deal seeds do not fit", () => {
    const m = CORPUS[0];
    const tampered = m.events.map((e) =>
      e.type === "deal" && e.handIndex === 1
        ? { ...e, payload: { ...e.payload, seed: (e.payload.seed ^ 0x55) >>> 0 } }
        : e,
    ) as GameEvent[];
    expect(recoverMatchSeed(tampered)).toBeNull();
  });

  it("re-executes every log in the corpus back to the state the log describes", () => {
    const failures: string[] = [];
    for (const m of CORPUS) {
      const r = verifyLog(m.header, m.events);
      for (const p of r.problems) failures.push(`${m.header.matchId}: ${p}`);
      if (r.matchSeed !== (m.seed >>> 0)) failures.push(`${m.header.matchId}: wrong seed ${r.matchSeed}`);
      if (r.events !== m.events.length) failures.push(`${m.header.matchId}: wrong event count`);
    }
    expectNoFailures(failures);
  });

  it("reports a mismatch instead of passing when the log has been edited", () => {
    const m = CORPUS[0];
    const last = m.events[m.events.length - 1];
    if (last.type !== "matchEnd") throw new Error("expected the log to end on matchEnd");
    const tampered = m.events.slice(0, -1).concat({
      ...last,
      payload: { ...last.payload, standings: [999, 0, 0, 0] as FourSeats<number> },
    });
    const r = verifyLog(m.header, tampered as GameEvent[]);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("chips");
  });

  it("says so plainly when the seed cannot be found", () => {
    const m = CORPUS[0];
    const r = verifyLog(m.header, m.events.filter((e) => e.type !== "deal"));
    expect(r.ok).toBe(false);
    expect(r.matchSeed).toBeNull();
    expect(r.problems[0]).toContain("--seed");
  });

  it("reports an unfoldable log as a sentence, not a stack trace", () => {
    const m = CORPUS[0];
    // Drop the flower replacements and the fold loses track of the hands.
    const broken = m.events.filter((e) => e.type !== "flowerReplacement");
    const r = verifyLog(m.header, broken, { seed: m.seed });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/does not fold|re-execution threw|MISMATCH|:/);
  });
});

/* ── log files ─────────────────────────────────────────────────────────── */

describe("reading a log file", () => {
  const m = CORPUS[0];
  const asJson = JSON.stringify({ header: m.header, events: m.events });
  const asPrettyJson = JSON.stringify({ header: m.header, events: m.events }, null, 2);
  const asLines = [JSON.stringify(m.header), ...m.events.map((e) => JSON.stringify(e))].join("\n");

  it("reads JSON, pretty JSON and JSONL to the same log", () => {
    for (const text of [asJson, asPrettyJson, asLines]) {
      const parsed = parseMatchLog(text);
      expect(parsed.events).toHaveLength(m.events.length);
      expect(parsed.header.matchId).toBe(m.header.matchId);
      expect(foldAt(parsed.header, parsed.events).seats.map((s) => s.chips)).toEqual(
        m.final.seats.map((s) => s.chips),
      );
    }
  });

  it("refuses an empty file, a non-log JSON blob, and a gap in seq", () => {
    expect(() => parseMatchLog("   ")).toThrow(/empty/);
    expect(() => parseMatchLog("{\"hello\":1}")).toThrow(/header, events/);
    const gapped = m.events.filter((_, i) => i !== 5);
    expect(() => parseMatchLog(JSON.stringify({ header: m.header, events: gapped }))).toThrow(/seq/);
  });
});

/* ── the CLI ───────────────────────────────────────────────────────────── */

describe("the replay CLI", () => {
  const m = CORPUS[0];
  const path = "/logs/match.json";
  const files = { [path]: JSON.stringify({ header: m.header, events: m.events }) };

  it("parses argv by hand, in both --flag N and --flag=N forms", () => {
    expect(parseArgs([path, "--at", "12", "--seat", "2"])).toMatchObject({
      file: path,
      mode: "at",
      at: 12,
      seat: 2,
      errors: [],
    });
    expect(parseArgs([path, "--at=12", "--seat=2"])).toMatchObject({
      file: path,
      mode: "at",
      at: 12,
      seat: 2,
      errors: [],
    });
    expect(parseArgs([path, "--seat", "9"]).errors[0]).toContain("--seat");
    expect(parseArgs([path, "--nope"]).errors[0]).toContain("unknown option");
    expect(parseArgs([path, "--at", "nope"]).errors[0]).toContain("--at");
  });

  it("--verify exits 0 and says gate 2 held", () => {
    const host = bufferHost(files);
    expect(runCli([path, "--verify"], host)).toBe(0);
    expect(host.out).toContain("OK");
    expect(host.out).toContain(`match seed ${m.seed}`);
  });

  it("--stats prints one row per hand and the standings", () => {
    const host = bufferHost(files);
    expect(runCli([path, "--stats"], host)).toBe(0);
    const s = m.states[m.states.length - 1];
    expect(host.out).toContain(`${s.hands.length} hands`);
    expect(host.out).toContain("standings");
    for (const h of s.hands) expect(host.out).toContain(h.outcome);
  });

  it("--at renders tiles as characters, and --seat hides the other hands", () => {
    const at = Math.min(80, m.events.length);
    const omniscient = bufferHost(files);
    expect(runCli([path, "--at", String(at)], omniscient)).toBe(0);
    expect(omniscient.out).toMatch(/[萬索筒東南西北中發白]/);

    const perSeat = bufferHost(files);
    expect(runCli([path, "--at", String(at), "--seat", "0"], perSeat)).toBe(0);
    expect(perSeat.out).toContain("(you)");
    expect(perSeat.out).toContain("▯ ×");
  });

  it("steps through one hand and shows the board at its boundaries", () => {
    const host = bufferHost(files);
    expect(runCli([path, "--hand", "0"], host)).toBe(0);
    expect(host.out).toContain("hand 0 ·");
    expect(host.out).not.toContain("hand 1 ·");
  });

  it("exits 2 on a missing file, a bad index and no arguments at all", () => {
    expect(runCli(["/nope.json"], bufferHost(files))).toBe(2);
    expect(runCli([path, "--at", "99999"], bufferHost(files))).toBe(2);
    expect(runCli([], bufferHost(files))).toBe(2);
    expect(runCli([path, "--hand", "999"], bufferHost(files))).toBe(2);
    const help = bufferHost(files);
    expect(runCli(["--help"], help)).toBe(0);
    expect(help.out).toContain("usage:");
  });

  it("exits 1, not 0, when a log fails to reconstruct", () => {
    const last = m.events[m.events.length - 1];
    if (last.type !== "matchEnd") throw new Error("expected the log to end on matchEnd");
    const tampered = m.events.slice(0, -1).concat({
      ...last,
      payload: { ...last.payload, standings: [-777, 0, 0, 0] as FourSeats<number> },
    });
    const host = bufferHost({ [path]: JSON.stringify({ header: m.header, events: tampered }) });
    expect(runCli([path, "--verify"], host)).toBe(1);
    expect(host.out).toContain("MISMATCH");
  });
});

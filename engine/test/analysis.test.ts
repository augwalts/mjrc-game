/**
 * Rule-derived hand analysis — the contract in ../src/analysis.ts, which
 * implements sketches/ANALYSIS.md §4 and the P0 half of DESIGN.md §7.
 *
 * Three things this suite is really for:
 *
 *  1. NO COUNT EVER EXCEEDS 4. `visibilityCounts` is where the prototype
 *     double-counted a claimed discard — once in the pile it was cut onto and
 *     again in the meld that claimed it — and printed the impossible "5 of 4
 *     visible". The bound is asserted at EVERY prefix of many simulated hands,
 *     and backed by an independent conservation check: face up + still in the
 *     four hands + still in the wall must come to exactly 4 for every tile.
 *
 *  2. THE WORDING ON A WIDELY-SEEN DISCARD. Two copies face up rule out 碰 and
 *     槓 and nothing else. HK plays 上 and the claim comes from the left, so
 *     such a discard is NOT safe. The suite asserts the sentence says so.
 *
 *  3. NO JUDGEMENT LEAKS IN. Nothing here asserts that a move was good or bad,
 *     because nothing in analysis.ts can know that — see the "not here" list at
 *     the top of that file.
 *
 * The fixtures build event logs by hand where a specific shape is the point,
 * and simulate them from a real seeded wall where volume is the point. Both are
 * deterministic: DESIGN.md §5.5, and the prototype bug where unseeded bot
 * decisions made identical wall seeds diverge.
 */
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  assertEventStreamWellFormed,
  type Actor,
  type FourSeats,
  type GameEvent,
  type MatchLogHeader,
} from "@mjrc/protocol";
import { HKOS_STANDARD } from "@mjrc/rulesets";
import {
  faanCeiling,
  handTimeline,
  keyMoments,
  visibilityCounts,
  type Moment,
  type Turn,
} from "../src/analysis.js";
import {
  SCORING_KINDS,
  type Meld,
  type Ruleset,
  type ScoreResult,
  type SeatIndex,
  type TileId,
  type WinContext,
  type WindIndex,
} from "../src/types.js";
import { counts, isFlower } from "../src/tiles.js";
import { assertWallIntact, buildWall, prng } from "../src/wall.js";
import {
  canExposedKong,
  canPung,
  chowOptions,
  makeAddedKong,
  makeChow,
  makeConcealedKong,
  makeExposedKong,
  makePung,
} from "../src/melds.js";
import { distanceToReady } from "../src/ready.js";

/* ── tile shorthand ────────────────────────────────────────────────────── */

const M = (r: number): TileId => r - 1; // 萬 1-9
const S = (r: number): TileId => 8 + r; // 索 1-9
const P = (r: number): TileId => 17 + r; // 筒 1-9
const EAST = 27, SOUTH = 28, WEST = 29, NORTH = 30;
const RED = 31, GREEN = 32, WHITE = 33;

const MATCH = "match-analysis-fixture";
const TS0 = 1_700_000_000_000;
const asc = (a: number, b: number): number => a - b;

/* ── log builder ───────────────────────────────────────────────────────── */

type EventOf<T extends GameEvent["type"]> = Extract<GameEvent, { type: T }>;

interface LogBuilder {
  events: GameEvent[];
  handIndex: number;
  add<T extends GameEvent["type"]>(type: T, actor: Actor, payload: EventOf<T>["payload"]): void;
}

function logBuilder(): LogBuilder {
  let seq = 0;
  const b: LogBuilder = {
    events: [],
    handIndex: 0,
    add(type, actor, payload) {
      // The envelope is uniform across the union; TypeScript cannot correlate
      // the literal `type` with its payload inside an object literal, so the
      // cast lives here once rather than at every call site.
      b.events.push({
        v: EVENT_SCHEMA_VERSION,
        matchId: MATCH,
        handIndex: b.handIndex,
        seq: seq++,
        ts: TS0 + seq * 1000,
        actor,
        type,
        payload,
      } as GameEvent);
    },
  };
  return b;
}

const four = <T>(a: T, b: T, c: T, d: T): FourSeats<T> => [a, b, c, d];

function seatWindsFor(dealer: SeatIndex): FourSeats<WindIndex> {
  const w = (s: number): WindIndex => (((s - dealer + 4) % 4) as WindIndex);
  return four(w(0), w(1), w(2), w(3));
}

function deal(b: LogBuilder, hands: FourSeats<TileId[]>, dealer: SeatIndex = 0): void {
  b.add("deal", "server", {
    seed: 1,
    dealer,
    roundWind: 0,
    seatWinds: seatWindsFor(dealer),
    hands,
    wallIndex: 53,
    wallRemaining: 91,
  });
}

const score = (faan: number, capped = false, legal = true): ScoreResult => ({
  faan,
  rawFaan: faan,
  capped,
  awards: [],
  legal,
});

function winCtx(seat: SeatIndex, from: SeatIndex | null, tile: TileId, extra: Partial<WinContext> = {}): WinContext {
  return {
    seat,
    selfDraw: from === null,
    from,
    winningTile: tile,
    roundWind: 0,
    seatWind: seat as WindIndex,
    isDealer: seat === 0,
    ...extra,
  };
}

const HEADER: MatchLogHeader = {
  v: EVENT_SCHEMA_VERSION,
  matchId: MATCH,
  engineVersion: "engine-analysis-test",
  rulesetId: HKOS_STANDARD.id,
  startedAt: TS0,
  players: four(
    { playerId: "p0", displayName: "East", seat: 0 as SeatIndex, bot: false },
    { playerId: "p1", displayName: "South", seat: 1 as SeatIndex, bot: true },
    { playerId: "p2", displayName: "West", seat: 2 as SeatIndex, bot: true },
    { playerId: "p3", displayName: "North", seat: 3 as SeatIndex, bot: true },
  ),
  matchLength: "oneWindRound",
  startingChips: four(100, 100, 100, 100),
};

const maxCount = (c: readonly number[]): number => c.reduce((m, n) => (n > m ? n : m), 0);

/* ── the simulator ─────────────────────────────────────────────────────── */

/**
 * A deterministic hand played from a real seeded wall. Not the state machine —
 * it exists to produce event logs with realistic claim, kong and 花 traffic so
 * `visibilityCounts` is stressed on the paths that broke the prototype.
 *
 * EVERY decision goes through `prng(seed)`. Nothing calls Math.random, so two
 * runs of the same seed produce byte-identical logs, which is asserted below.
 */
interface SimResult {
  events: GameEvent[];
  /** Concealed tiles per seat at the end. */
  hands: TileId[][];
  /** Tiles never drawn. */
  wallRest: TileId[];
}

/**
 * Index of the tile to cut: the least connected one, with seeded jitter.
 *
 * A uniformly random cut produces a corpus with almost no 碰 and no 槓 at all,
 * because hands never cluster — measured zero exposed and zero concealed kongs
 * across 24 hands. Keeping copies and neighbours together is enough to make
 * claims routine, which is what `visibilityCounts` needs to be stressed on.
 * This is a fixture policy, not a bot: DESIGN.md §6 owns that, and nothing here
 * asserts anything about play quality.
 */
function pickDiscard(h: readonly TileId[], rnd: () => number): number {
  const c = counts(h);
  let bestIndex = 0;
  let bestKeep = Infinity;
  for (let i = 0; i < h.length; i++) {
    const t = h[i];
    let keep = c[t] * 3;
    if (t < 27) {
      const r = t % 9;
      if (r > 0) keep += c[t - 1];
      if (r < 8) keep += c[t + 1];
      if (r > 1 && c[t - 2] > 0) keep += 1;
      if (r < 7 && c[t + 2] > 0) keep += 1;
    }
    const jittered = keep + rnd() * 2;
    if (jittered < bestKeep) { bestKeep = jittered; bestIndex = i; }
  }
  return bestIndex;
}

function simulateHand(b: LogBuilder, seed: number, handIndex: number): SimResult {
  const wall = buildWall(seed);
  assertWallIntact(wall);
  const rnd = prng((seed * 2654435761) >>> 0);
  let wi = 0;

  const dealer = (handIndex % 4) as SeatIndex;
  const hands: TileId[][] = [[], [], [], []];
  const melds: Meld[][] = [[], [], [], []];
  const lastIn: (TileId | null)[] = [null, null, null, null];

  for (let s = 0; s < 4; s++) for (let k = 0; k < 13; k++) hands[s].push(wall[wi++]);
  hands[dealer].push(wall[wi++]);
  for (const h of hands) h.sort(asc);

  b.handIndex = handIndex;
  b.add("deal", "server", {
    seed,
    dealer,
    roundWind: 0,
    seatWinds: seatWindsFor(dealer),
    hands: four(hands[0].slice(), hands[1].slice(), hands[2].slice(), hands[3].slice()),
    wallIndex: wi,
    wallRemaining: wall.length - wi,
  });

  const left = (): number => wall.length - wi;
  const drop = (h: TileId[], t: TileId): void => {
    const i = h.indexOf(t);
    if (i >= 0) h.splice(i, 1);
  };

  // Deal-time 花: strict seat order, recursive, one event per reveal (§5.2).
  for (let s = 0; s < 4; s++) {
    for (;;) {
      const fi = hands[s].findIndex(isFlower);
      if (fi < 0) break;
      const flower = hands[s][fi];
      hands[s].splice(fi, 1);
      const rep = wall[wi++];
      hands[s].push(rep);
      hands[s].sort(asc);
      b.add("flowerReplacement", "server", {
        seat: s as SeatIndex,
        flower,
        replacement: rep,
        wallIndex: wi,
        wallRemaining: left(),
      });
    }
  }

  /**
   * Take one live tile off the wall for `seat`, revealing any 花 on the way.
   * A 花 chain delivers the tile through `flowerReplacement`, so the plain
   * draw event is emitted only when no flower turned up — the tile must reach
   * the hand exactly once.
   */
  function take(seat: SeatIndex, kind: "draw" | "kongReplacement", kongKind: "exposed" | "concealed" | "added" = "exposed"): TileId {
    let t = wall[wi++];
    if (!isFlower(t)) {
      if (kind === "draw") {
        b.add("draw", seat, { seat, tile: t, wallIndex: wi, wallRemaining: left() });
      } else {
        b.add("kongReplacement", seat, { seat, tile: t, kongKind, wallIndex: wi, wallRemaining: left() });
      }
    } else {
      while (isFlower(t)) {
        const rep = wall[wi++];
        b.add("flowerReplacement", seat, {
          seat,
          flower: t,
          replacement: rep,
          wallIndex: wi,
          wallRemaining: left(),
        });
        t = rep;
      }
    }
    hands[seat].push(t);
    hands[seat].sort(asc);
    return t;
  }

  let current = dealer;
  let guard = 0;
  while (left() > 16 && guard++ < 220) {
    const h = hands[current];

    // 暗槓 — declared on your own turn, from four copies held.
    const quad = h.find((t, i) => i + 3 < h.length && h[i + 3] === t);
    if (quad !== undefined && melds[current].length < 4 && rnd() < 0.35 && left() > 20) {
      const meld = makeConcealedKong(quad, current);
      for (let k = 0; k < 4; k++) drop(h, quad);
      melds[current].push(meld);
      b.add("concealedKong", current, { seat: current, tile: quad, meld });
      lastIn[current] = take(current, "kongReplacement", "concealed");
    }

    // 加槓 — the fourth copy onto an exposed 碰, with its rob window.
    const pung = melds[current].find((m) => m.kind === "pung" && h.includes(m.tiles[0]));
    if (pung && rnd() < 0.5 && left() > 20) {
      const meld = makeAddedKong(pung, current);
      drop(h, meld.tiles[0]);
      melds[current] = melds[current].map((m) => (m === pung ? meld : m));
      b.add("addedKong", current, { seat: current, tile: meld.tiles[0], meld });
      b.add("robKongWindow", "server", {
        seat: current,
        tile: meld.tiles[0],
        offeredTo: [],
        deadlineTs: TS0,
      });
      lastIn[current] = take(current, "kongReplacement", "added");
    }

    const pick = pickDiscard(h, rnd);
    const tile = h[pick];
    h.splice(pick, 1);
    b.add("discard", current, { seat: current, tile, drawAndCut: tile === lastIn[current] });
    lastIn[current] = null;

    // Claims, walked clockwise from the discarder — which is also the tie-break.
    let taken: { seat: SeatIndex; kind: "chow" | "pung" | "kong"; meld: Meld } | null = null;
    for (let off = 1; off <= 3 && !taken; off++) {
      const cand = ((current + off) % 4) as SeatIndex;
      if (melds[cand].length >= 4) continue;
      const ch = hands[cand];
      // 明槓 is always taken when legal: holding three copies of a tile someone
      // else cuts is rare enough that a coin flip on top of it leaves the
      // corpus without one, and the claimed-tile-into-a-4-tile-meld path is
      // exactly what needs exercising here.
      if (canExposedKong(ch, tile) && left() > 20) {
        taken = { seat: cand, kind: "kong", meld: makeExposedKong(tile, cand, current) };
      } else if (canPung(ch, tile) && rnd() < 0.5) {
        taken = { seat: cand, kind: "pung", meld: makePung(tile, cand, current) };
      } else if (off === 1) {
        const opts = chowOptions(ch, tile, cand, current);
        if (opts.length > 0 && rnd() < 0.45) {
          taken = { seat: cand, kind: "chow", meld: makeChow([tile, ...opts[0]], cand, current) };
        }
      }
    }

    if (taken) {
      const ch = hands[taken.seat];
      let usedClaimed = false;
      for (const t of taken.meld.tiles) {
        if (!usedClaimed && t === tile) { usedClaimed = true; continue; }
        drop(ch, t);
      }
      melds[taken.seat].push(taken.meld);
      b.add("claimed", taken.seat, {
        seat: taken.seat,
        kind: taken.kind,
        tile,
        from: current,
        meld: taken.meld,
      });
      if (taken.kind === "kong") lastIn[taken.seat] = take(taken.seat, "kongReplacement", "exposed");
      current = taken.seat;
      continue;
    }

    current = ((current + 1) % 4) as SeatIndex;
    lastIn[current] = take(current, "draw");
  }

  b.add("exhaustiveDraw", "server", {
    wallRemaining: left(),
    hands: four(hands[0].slice(), hands[1].slice(), hands[2].slice(), hands[3].slice()),
    distanceToReady: four(
      distanceToReady(counts(hands[0]), melds[0].length),
      distanceToReady(counts(hands[1]), melds[1].length),
      distanceToReady(counts(hands[2]), melds[2].length),
      distanceToReady(counts(hands[3]), melds[3].length),
    ),
  });
  b.add("handEnd", "server", {
    outcome: "exhaustiveDraw",
    winner: null,
    loser: null,
    faan: null,
    chipDeltas: four(0, 0, 0, 0),
    standings: four(100, 100, 100, 100),
    dealerRepeats: true,
    nextDealer: dealer,
    nextRoundWind: 0,
  });

  return { events: b.events, hands, wallRest: wall.slice(wi) };
}

function simulateOne(seed: number, handIndex = 0): SimResult {
  const b = logBuilder();
  return simulateHand(b, seed, handIndex);
}

/* ── visibilityCounts ──────────────────────────────────────────────────── */

describe("visibilityCounts — copies face up to the whole table", () => {
  it("counts a claimed discard ONCE, not twice", () => {
    // The prototype bug in one fixture: 5筒 is cut, then 碰'd. Three copies are
    // now face up — the two that came out of hand and the one off the table.
    // Counting the discard and the meld separately gives four, and one more
    // claim of the same kind gives the impossible five.
    const b = logBuilder();
    deal(b, four(
      [P(5), M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(9), S(1), S(2), S(3), EAST],
      [P(5), P(5), S(4), S(5), S(6), S(7), S(8), S(9), M(1), M(2), M(3), RED, RED],
      [WEST, WEST, WEST, S(1), S(2), S(3), P(1), P(2), P(3), M(5), M(6), M(7), GREEN],
      [NORTH, NORTH, P(7), P(8), P(9), M(1), M(2), M(3), S(5), S(6), S(7), WHITE, WHITE],
    ));
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false });
    expect(visibilityCounts(b.events)[P(5)]).toBe(1);

    const meld = makePung(P(5), 1, 0);
    b.add("claimed", 1, { seat: 1, kind: "pung", tile: P(5), from: 0, meld });
    expect(visibilityCounts(b.events)[P(5)]).toBe(3);
    expect(maxCount(visibilityCounts(b.events))).toBeLessThanOrEqual(4);
  });

  it("counts an 明槓 as four, not five", () => {
    const b = logBuilder();
    deal(b, four(
      [P(5), M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(9), S(1), S(2), S(3), EAST],
      [P(5), P(5), P(5), S(4), S(5), S(6), S(7), S(8), S(9), M(1), M(2), M(3), RED],
      [WEST, WEST, WEST, S(1), S(2), S(3), P(1), P(2), P(3), M(5), M(6), M(7), GREEN],
      [NORTH, NORTH, P(7), P(8), P(9), M(1), M(2), M(3), S(5), S(6), S(7), WHITE, WHITE],
    ));
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false });
    b.add("claimed", 1, { seat: 1, kind: "kong", tile: P(5), from: 0, meld: makeExposedKong(P(5), 1, 0) });
    expect(visibilityCounts(b.events)[P(5)]).toBe(4);
  });

  it("counts a 加槓 as four — the pung it grew from is replaced, not kept", () => {
    const b = logBuilder();
    deal(b, four(
      [P(5), M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(9), S(1), S(2), S(3), EAST],
      [P(5), P(5), P(5), S(4), S(5), S(6), S(7), S(8), S(9), M(1), M(2), M(3), RED],
      [WEST, WEST, WEST, S(1), S(2), S(3), P(1), P(2), P(3), M(5), M(6), M(7), GREEN],
      [NORTH, NORTH, P(7), P(8), P(9), M(1), M(2), M(3), S(5), S(6), S(7), WHITE, WHITE],
    ));
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false });
    const pung = makePung(P(5), 1, 0);
    b.add("claimed", 1, { seat: 1, kind: "pung", tile: P(5), from: 0, meld: pung });
    expect(visibilityCounts(b.events)[P(5)]).toBe(3);

    b.add("addedKong", 1, { seat: 1, tile: P(5), meld: makeAddedKong(pung, 1) });
    // 3 (pung) + 4 (kong) would be seven. The kong REPLACES the pung.
    expect(visibilityCounts(b.events)[P(5)]).toBe(4);
  });

  it("counts an 暗槓 as four", () => {
    const b = logBuilder();
    deal(b, four(
      [WEST, WEST, WEST, WEST, M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(9), EAST],
      [P(5), P(5), S(4), S(5), S(6), S(7), S(8), S(9), M(1), M(2), M(3), RED, RED],
      [S(1), S(2), S(3), P(1), P(2), P(3), M(5), M(6), M(7), GREEN, GREEN, NORTH, NORTH],
      [P(7), P(8), P(9), M(1), M(2), M(3), S(5), S(6), S(7), WHITE, WHITE, SOUTH, SOUTH],
    ));
    b.add("concealedKong", 0, { seat: 0, tile: WEST, meld: makeConcealedKong(WEST, 0) });
    expect(visibilityCounts(b.events)[WEST]).toBe(4);
  });

  it("resets on every deal — visibility is a per-hand fact", () => {
    const b = logBuilder();
    deal(b, four([P(5)], [], [], []));
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false });
    b.add("handEnd", "server", {
      outcome: "exhaustiveDraw", winner: null, loser: null, faan: null,
      chipDeltas: four(0, 0, 0, 0), standings: four(100, 100, 100, 100),
      dealerRepeats: true, nextDealer: 0, nextRoundWind: 0,
    });
    expect(visibilityCounts(b.events)[P(5)]).toBe(1);

    b.handIndex = 1;
    deal(b, four([P(5)], [], [], []));
    expect(visibilityCounts(b.events)[P(5)]).toBe(0);
  });

  it("honours `upTo` as a log INDEX, exclusive, and clamps out of range", () => {
    const b = logBuilder();
    deal(b, four([P(5), P(5)], [], [], []));
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false });
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false });
    expect(visibilityCounts(b.events, 0)[P(5)]).toBe(0);
    expect(visibilityCounts(b.events, 2)[P(5)]).toBe(1);
    expect(visibilityCounts(b.events, 3)[P(5)]).toBe(2);
    expect(visibilityCounts(b.events, 999)[P(5)]).toBe(2);
    expect(visibilityCounts(b.events, -5)[P(5)]).toBe(0);
  });

  it("returns one slot per scoring kind and ignores 花", () => {
    const c = visibilityCounts(simulateOne(7).events);
    expect(c).toHaveLength(SCORING_KINDS);
  });

  it("NEVER exceeds 4, at every prefix of many simulated hands", () => {
    const traffic: Record<string, number> = {};
    let sawAFullFour = false;
    for (let seed = 1; seed <= 24; seed++) {
      const { events } = simulateOne(seed, seed % 4);
      for (const e of events) {
        const k = e.type === "claimed" ? `claim:${e.payload.kind}` : e.type;
        traffic[k] = (traffic[k] ?? 0) + 1;
      }
      for (let upTo = 0; upTo <= events.length; upTo++) {
        const c = visibilityCounts(events, upTo);
        const worst = maxCount(c);
        if (worst === 4) sawAFullFour = true;
        expect(worst, `seed ${seed} at prefix ${upTo}`).toBeLessThanOrEqual(4);
      }
    }
    // Guards against a vacuous pass. The bound is only interesting if the
    // corpus actually walks the paths that broke the prototype: a claimed
    // discard folded into a meld, all three 槓 forms, and 花 replacement.
    expect(sawAFullFour).toBe(true);
    expect(traffic["claim:chow"] ?? 0).toBeGreaterThan(0);
    expect(traffic["claim:pung"] ?? 0).toBeGreaterThan(0);
    expect(traffic["claim:kong"] ?? 0).toBeGreaterThan(0);
    expect(traffic["concealedKong"] ?? 0).toBeGreaterThan(0);
    expect(traffic["addedKong"] ?? 0).toBeGreaterThan(0);
    expect(traffic["flowerReplacement"] ?? 0).toBeGreaterThan(0);
  });

  it("conserves every tile: face up + still held + still in the wall = 4", () => {
    // An INDEPENDENT check on the same bug. A double count would push the sum
    // to five for the tile involved; a lost tile would drop it to three.
    for (let seed = 30; seed <= 45; seed++) {
      const { events, hands, wallRest } = simulateOne(seed, seed % 4);
      const visible = visibilityCounts(events);
      const held = counts(hands.flat());
      const unseen = counts(wallRest);
      for (let t = 0; t < SCORING_KINDS; t++) {
        expect(visible[t] + held[t] + unseen[t], `seed ${seed}, tile ${t}`).toBe(4);
      }
    }
  });

  it("produces logs the protocol's own integrity check accepts", () => {
    const b = logBuilder();
    for (let h = 0; h < 4; h++) simulateHand(b, 100 + h, h);
    expect(() => assertEventStreamWellFormed(HEADER, b.events)).not.toThrow();
    for (let upTo = 0; upTo <= b.events.length; upTo += 7) {
      expect(maxCount(visibilityCounts(b.events, upTo))).toBeLessThanOrEqual(4);
    }
  });
});

/* ── keyMoments ────────────────────────────────────────────────────────── */

const of = <K extends Moment["kind"]>(ms: Moment[], k: K): Extract<Moment, { kind: K }>[] =>
  ms.filter((m): m is Extract<Moment, { kind: K }> => m.kind === k);

describe("keyMoments — dealt into a win", () => {
  function dealInLog(opts: { robbedKong?: boolean } = {}): GameEvent[] {
    const b = logBuilder();
    deal(b, four(
      [P(5), M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(9), S(1), S(2), S(3), EAST],
      [P(4), P(6), S(4), S(5), S(6), S(7), S(8), S(9), M(1), M(2), M(3), RED, RED],
      [WEST, WEST, WEST, S(1), S(2), S(3), P(1), P(2), P(3), M(5), M(6), M(7), GREEN],
      [NORTH, NORTH, P(7), P(8), P(9), M(1), M(2), M(3), S(5), S(6), S(7), WHITE, WHITE],
    ));
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: true });
    b.add("winOnDiscard", 1, {
      context: winCtx(1, 0, P(5), opts) as WinContext & { selfDraw: false; from: SeatIndex },
      concealed: [P(4), P(6), S(4), S(5), S(6), S(7), S(8), S(9), M(1), M(2), M(3), RED, RED],
      melds: [],
      flowers: [],
      score: score(6),
    });
    return b.events;
  }

  it("names the tile, the winner and the faan it paid", () => {
    const m = of(keyMoments(dealInLog(), 0), "dealtIntoWin");
    expect(m).toHaveLength(1);
    expect(m[0].tile).toBe(P(5));
    expect(m[0].winner).toBe(1);
    expect(m[0].faan).toBe(6);
    expect(m[0].capped).toBe(false);
    expect(m[0].text).toContain("6 faan");
    expect(m[0].text).toContain("食糊");
  });

  it("reports nothing for the seats that did not feed it", () => {
    for (const seat of [1, 2, 3] as SeatIndex[]) {
      expect(of(keyMoments(dealInLog(), seat), "dealtIntoWin")).toHaveLength(0);
    }
  });

  it("does NOT call a robbed 加槓 a deal-in — a kong is not a discard", () => {
    // 搶槓 carries `from`, but that seat never cut the tile: it laid it onto a
    // 碰. Attributing it as a discard would be a confident wrong annotation.
    const b = logBuilder();
    deal(b, four([M(1)], [], [], []));
    const pung = makePung(P(5), 0, 3);
    b.add("claimed", 0, { seat: 0, kind: "pung", tile: P(5), from: 3, meld: pung });
    b.add("addedKong", 0, { seat: 0, tile: P(5), meld: makeAddedKong(pung, 0) });
    b.add("robKongWindow", "server", { seat: 0, tile: P(5), offeredTo: [1], deadlineTs: TS0 });
    b.add("winOnDiscard", 1, {
      context: winCtx(1, 0, P(5), { robbedKong: true }) as WinContext & { selfDraw: false; from: SeatIndex },
      concealed: [],
      melds: [],
      flowers: [],
      score: score(5),
    });
    expect(of(keyMoments(b.events, 0), "dealtIntoWin")).toHaveLength(0);
  });

  it("marks a 爆棚 win as capped", () => {
    const b = logBuilder();
    deal(b, four([P(5)], [], [], []));
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false });
    b.add("winOnDiscard", 2, {
      context: winCtx(2, 0, P(5)) as WinContext & { selfDraw: false; from: SeatIndex },
      concealed: [], melds: [], flowers: [], score: score(13, true),
    });
    const m = of(keyMoments(b.events, 0), "dealtIntoWin");
    expect(m[0].capped).toBe(true);
    expect(m[0].text).toContain("爆棚");
  });
});

describe("keyMoments — passed a legal winning claim", () => {
  function offerLog(reason: "pass" | "timeout" | "outranked", withWin = true): GameEvent[] {
    const b = logBuilder();
    deal(b, four([M(1)], [P(4), P(6)], [], []));
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false });
    b.add("claimOffered", "server", {
      seat: 1,
      tile: P(5),
      from: 0,
      options: withWin ? [{ kind: "win" }, { kind: "chow", with: [P(4), P(6)] }] : [{ kind: "chow", with: [P(4), P(6)] }],
      deadlineTs: TS0 + 3000,
    });
    b.add("claimDeclined", reason === "outranked" ? "server" : 1, {
      seat: 1, tile: P(5), from: 0, reason,
    });
    return b.events;
  }

  it("fires on a declined win offer", () => {
    const m = of(keyMoments(offerLog("pass"), 1), "passedWinningClaim");
    expect(m).toHaveLength(1);
    expect(m[0].tile).toBe(P(5));
    expect(m[0].from).toBe(0);
    expect(m[0].reason).toBe("pass");
    expect(m[0].robbingKong).toBe(false);
    expect(m[0].text).toContain("食糊");
  });

  it("fires on a timeout, and says the window ran out", () => {
    const m = of(keyMoments(offerLog("timeout"), 1), "passedWinningClaim");
    expect(m).toHaveLength(1);
    expect(m[0].reason).toBe("timeout");
    expect(m[0].text).toContain("window ran out");
  });

  it("does NOT fire when the seat was outranked — that is not a decision", () => {
    expect(of(keyMoments(offerLog("outranked"), 1), "passedWinningClaim")).toHaveLength(0);
  });

  it("does NOT fire when the offer held no winning option", () => {
    expect(of(keyMoments(offerLog("pass", false), 1), "passedWinningClaim")).toHaveLength(0);
  });

  it("fires on a passed 搶槓", () => {
    const b = logBuilder();
    deal(b, four([M(1)], [], [], []));
    const pung = makePung(P(5), 0, 3);
    b.add("claimed", 0, { seat: 0, kind: "pung", tile: P(5), from: 3, meld: pung });
    b.add("addedKong", 0, { seat: 0, tile: P(5), meld: makeAddedKong(pung, 0) });
    b.add("robKongWindow", "server", { seat: 0, tile: P(5), offeredTo: [1, 2], deadlineTs: TS0 });
    b.add("claimDeclined", 1, { seat: 1, tile: P(5), from: 0, reason: "pass" });
    const m = of(keyMoments(b.events, 1), "passedWinningClaim");
    expect(m).toHaveLength(1);
    expect(m[0].robbingKong).toBe(true);
    expect(m[0].text).toContain("搶槓");
    // Seat 3 was never offered it.
    expect(of(keyMoments(b.events, 3), "passedWinningClaim")).toHaveLength(0);
  });
});

describe("keyMoments — melded below the floor", () => {
  it("fires on the engine's own refusal, carrying both numbers", () => {
    const b = logBuilder();
    deal(b, four([M(1)], [], [], []));
    const chow = makeChow([M(1), M(2), M(3)], 0, 3);
    b.add("claimed", 0, { seat: 0, kind: "chow", tile: M(1), from: 3, meld: chow });
    b.add("refusedWin", 0, {
      context: winCtx(0, 2, S(5)),
      concealed: [S(4), S(6), P(1), P(2), P(3), M(5), M(6), M(7), EAST, EAST],
      melds: [chow],
      flowers: [],
      score: score(2, false, false),
      minimumFaan: 3,
      reason: "belowMinimum",
    });
    const m = of(keyMoments(b.events, 0), "meldedBelowFloor");
    expect(m).toHaveLength(1);
    expect(m[0].ground).toBe("refusedWin");
    expect(m[0].faan).toBe(2);
    expect(m[0].minimumFaan).toBe(3);
    expect(m[0].text).toContain("2 faan");
    expect(m[0].text).toContain("3-faan minimum");
    expect(of(keyMoments(b.events, 1), "meldedBelowFloor")).toHaveLength(0);
  });

  it("stays silent about the floor when no ruleset is supplied", () => {
    // Without a ruleset the minimum is unknown, and the module never assumes
    // one. Log facts still report; the derived ground does not.
    const b = logBuilder();
    deal(b, four([M(1)], [], [], []));
    b.add("claimed", 0, {
      seat: 0, kind: "chow", tile: M(1), from: 3, meld: makeChow([M(1), M(2), M(3)], 0, 3),
    });
    b.add("claimed", 0, {
      seat: 0, kind: "chow", tile: S(4), from: 3, meld: makeChow([S(4), S(5), S(6)], 0, 3),
    });
    b.add("claimed", 0, {
      seat: 0, kind: "chow", tile: P(7), from: 3, meld: makeChow([P(7), P(8), P(9)], 0, 3),
    });
    expect(of(keyMoments(b.events, 0), "meldedBelowFloor")).toHaveLength(0);
  });
});

/* ── faanCeiling ───────────────────────────────────────────────────────── */

/**
 * A deliberately lean house table. Rulesets are DATA (DESIGN.md §4), and a
 * table without 花 or situational faan is exactly the case where the ceiling
 * bites. It is a fixture, not a proposal.
 */
const LEAN: Ruleset = {
  id: "test-lean-fixture",
  label: "lean fixture table",
  minimumFaan: 3,
  limitFaan: 13,
  useFlowers: false,
  payment: HKOS_STANDARD.payment,
  faanTable: { allChows: 1, allPungs: 3, halfFlush: 3, fullFlush: 6, dragonPung: 1 },
};

const CHOWS_THREE_SUITS = (owner: SeatIndex, from: SeatIndex): Meld[] => [
  makeChow([M(1), M(2), M(3)], owner, from),
  makeChow([S(4), S(5), S(6)], owner, from),
  makeChow([P(7), P(8), P(9)], owner, from),
];

describe("faanCeiling — a sound upper bound, never an estimate", () => {
  it("forecloses what a 上 definitionally cannot be part of", () => {
    const c = faanCeiling(CHOWS_THREE_SUITS(0, 3), [], LEAN);
    expect(c.foreclosed).toContain("allPungs");
    expect(c.foreclosed).toContain("fullFlush");
    expect(c.foreclosed).toContain("halfFlush");
    expect(c.foreclosed).toContain("concealedHand");
    expect(c.foreclosed).not.toContain("allChows");
  });

  it("runs out of set slots: four melds leave nothing for a 三元牌", () => {
    const melds = [...CHOWS_THREE_SUITS(0, 3), makeChow([M(4), M(5), M(6)], 0, 3)];
    const c = faanCeiling(melds, [], LEAN);
    expect(c.foreclosed).toContain("dragonPung");
    expect(c.ceiling).toBe(1); // 平糊 and nothing else is left on this table
  });

  it("keeps a dragon reachable while a slot remains, and repeats the award", () => {
    const one = faanCeiling(CHOWS_THREE_SUITS(0, 3), [], LEAN);
    expect(one.foreclosed).not.toContain("dragonPung");
    expect(one.ceiling).toBe(2); // 平糊 1 + at most one 三元牌 1
    const none = faanCeiling([], [], LEAN);
    expect(none.ceiling).toBeGreaterThanOrEqual(1 + 3 * 1);
  });

  it("never exceeds the limit 爆棚", () => {
    expect(faanCeiling([], [], HKOS_STANDARD).ceiling).toBe(HKOS_STANDARD.limitFaan);
  });

  it("kills 無花 once a flower is revealed", () => {
    expect(faanCeiling([], [34], HKOS_STANDARD).foreclosed).toContain("noFlowers");
    expect(faanCeiling([], [], HKOS_STANDARD).foreclosed).not.toContain("noFlowers");
  });

  it("leaves an unknown house pattern reachable — drift can only raise the bound", () => {
    const house: Ruleset = {
      ...LEAN,
      faanTable: { ...LEAN.faanTable, jadeDragon: 8 },
    };
    const c = faanCeiling(CHOWS_THREE_SUITS(0, 3), [], house);
    expect(c.foreclosed).not.toContain("jadeDragon");
    expect(c.ceiling).toBeGreaterThan(faanCeiling(CHOWS_THREE_SUITS(0, 3), [], LEAN).ceiling);
  });

  it("does not sink below the floor under HKOS_STANDARD on three 上", () => {
    // Not a shortcoming. HK Old Style pays 花, 自摸 and 海底撈月 on top of the
    // hand, so three faan stays nominally reachable and the honest answer is
    // "not provably dead". Asserted so a future tightening is a deliberate act.
    const c = faanCeiling(CHOWS_THREE_SUITS(0, 3), [], HKOS_STANDARD);
    expect(c.ceiling).toBeGreaterThanOrEqual(HKOS_STANDARD.minimumFaan);
  });

  it("is order-independent of the faan table's key order", () => {
    const shuffled: Ruleset = {
      ...LEAN,
      faanTable: Object.fromEntries(Object.entries(LEAN.faanTable).reverse()),
    };
    expect(faanCeiling(CHOWS_THREE_SUITS(0, 3), [], shuffled)).toEqual(
      faanCeiling(CHOWS_THREE_SUITS(0, 3), [], LEAN),
    );
  });
});

describe("keyMoments — the derived floor ground", () => {
  function threeChowLog(): GameEvent[] {
    const b = logBuilder();
    deal(b, four([M(1)], [], [], []));
    for (const meld of CHOWS_THREE_SUITS(0, 3)) {
      b.add("claimed", 0, { seat: 0, kind: "chow", tile: meld.tiles[0], from: 3, meld });
    }
    return b.events;
  }

  it("fires once, anchored on the meld that crossed the line", () => {
    const m = of(keyMoments(threeChowLog(), 0, { ruleset: LEAN }), "meldedBelowFloor");
    expect(m).toHaveLength(1);
    expect(m[0].ground).toBe("noPathToMinimum");
    expect(m[0].faan).toBe(2);
    expect(m[0].minimumFaan).toBe(3);
    expect(m[0].melds).toHaveLength(3);
    expect(m[0].text).toContain("no path to 3 faan");
  });

  it("does not fire under HKOS_STANDARD on the same melds", () => {
    expect(
      of(keyMoments(threeChowLog(), 0, { ruleset: HKOS_STANDARD }), "meldedBelowFloor"),
    ).toHaveLength(0);
  });

  it("reports at most one floor moment per hand, and resets on the next deal", () => {
    const b = logBuilder();
    deal(b, four([M(1)], [], [], []));
    for (const meld of CHOWS_THREE_SUITS(0, 3)) {
      b.add("claimed", 0, { seat: 0, kind: "chow", tile: meld.tiles[0], from: 3, meld });
    }
    b.add("handEnd", "server", {
      outcome: "exhaustiveDraw", winner: null, loser: null, faan: null,
      chipDeltas: four(0, 0, 0, 0), standings: four(100, 100, 100, 100),
      dealerRepeats: true, nextDealer: 0, nextRoundWind: 0,
    });
    b.handIndex = 1;
    deal(b, four([M(1)], [], [], []));
    for (const meld of CHOWS_THREE_SUITS(0, 3)) {
      b.add("claimed", 0, { seat: 0, kind: "chow", tile: meld.tiles[0], from: 3, meld });
    }
    const m = of(keyMoments(b.events, 0, { ruleset: LEAN }), "meldedBelowFloor");
    expect(m).toHaveLength(2);
    expect(m.map((x) => x.handIndex)).toEqual([0, 1]);
  });
});

/* ── keyMoments — a widely seen discard ────────────────────────────────── */

describe("keyMoments — discarded a tile already face up", () => {
  /** Two copies of `tile` face up, then this seat cuts a third. */
  function seenTwice(tile: TileId): GameEvent[] {
    const b = logBuilder();
    deal(b, four([tile], [tile], [tile], [tile]));
    b.add("discard", 1, { seat: 1, tile, drawAndCut: false });
    b.add("discard", 2, { seat: 2, tile, drawAndCut: false });
    b.add("discard", 0, { seat: 0, tile, drawAndCut: false });
    return b.events;
  }

  it("says a 上 is still possible on a suited tile, and never says safe", () => {
    const m = of(keyMoments(seenTwice(P(5)), 0), "discardedVisibleTile");
    expect(m).toHaveLength(1);
    expect(m[0].tile).toBe(P(5));
    expect(m[0].visible).toBe(2);
    expect(m[0].chowStillPossible).toBe(true);
    expect(m[0].text).toContain("2 of 4");
    expect(m[0].text).toContain("碰 and 槓 are impossible");
    expect(m[0].text).toContain("上 is not");
    // 上 comes from 上家, so the one seat that can still take it is 下家 —
    // seat 1 here, which is 南 in an 東 round dealt from seat 0.
    expect(m[0].text).toContain("下家 南");
    expect(m[0].text.toLowerCase()).not.toContain("safe");
  });

  it("says an honour cannot be claimed at all — honours never form runs", () => {
    const m = of(keyMoments(seenTwice(RED), 0), "discardedVisibleTile");
    expect(m).toHaveLength(1);
    expect(m[0].chowStillPossible).toBe(false);
    expect(m[0].text).toContain("cannot be claimed at all");
    expect(m[0].text.toLowerCase()).not.toContain("safe");
  });

  it("counts copies face up BEFORE the cut, not including it", () => {
    const b = logBuilder();
    deal(b, four([P(5), P(5)], [P(5)], [], []));
    b.add("discard", 1, { seat: 1, tile: P(5), drawAndCut: false });
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false }); // only 1 seen
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false }); // now 2 seen
    const m = of(keyMoments(b.events, 0), "discardedVisibleTile");
    expect(m).toHaveLength(1);
    expect(m[0].visible).toBe(2);
  });

  it("stays quiet below two copies — one face up rules nothing out", () => {
    const b = logBuilder();
    deal(b, four([P(5)], [P(5)], [], []));
    b.add("discard", 1, { seat: 1, tile: P(5), drawAndCut: false });
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false });
    expect(of(keyMoments(b.events, 0), "discardedVisibleTile")).toHaveLength(0);
  });

  it("counts meld tiles as face up, not just the piles", () => {
    const b = logBuilder();
    deal(b, four([P(5)], [P(5), P(5)], [P(5)], []));
    b.add("discard", 2, { seat: 2, tile: P(5), drawAndCut: false });
    b.add("claimed", 1, { seat: 1, kind: "pung", tile: P(5), from: 2, meld: makePung(P(5), 1, 2) });
    b.add("discard", 0, { seat: 0, tile: P(5), drawAndCut: false });
    const m = of(keyMoments(b.events, 0), "discardedVisibleTile");
    expect(m).toHaveLength(1);
    expect(m[0].visible).toBe(3);
  });

  it("never claims more than three copies were face up before a cut", () => {
    // A fourth copy face up means this seat could not still be holding one.
    for (let seed = 60; seed <= 75; seed++) {
      const { events } = simulateOne(seed, seed % 4);
      for (const seat of [0, 1, 2, 3] as SeatIndex[]) {
        for (const m of of(keyMoments(events, seat), "discardedVisibleTile")) {
          expect(m.visible, `seed ${seed}`).toBeGreaterThanOrEqual(2);
          expect(m.visible, `seed ${seed}`).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});

describe("keyMoments — what it refuses to say", () => {
  it("emits only the four rule-derived kinds, and nothing judgemental", () => {
    const allowed = new Set([
      "dealtIntoWin", "meldedBelowFloor", "passedWinningClaim", "discardedVisibleTile",
    ]);
    const banned = /\b(safe|blunder|mistake|inaccuracy|should have|best move|accuracy|probability|chance of)\b/i;
    for (let seed = 80; seed <= 95; seed++) {
      const { events } = simulateOne(seed, seed % 4);
      for (const seat of [0, 1, 2, 3] as SeatIndex[]) {
        for (const m of keyMoments(events, seat, { ruleset: HKOS_STANDARD })) {
          expect(allowed.has(m.kind)).toBe(true);
          expect(m.seat).toBe(seat);
          expect(m.text, `seed ${seed}`).not.toMatch(banned);
          expect(events[m.index].seq).toBe(m.seq);
        }
      }
    }
  });

  it("returns moments in log order", () => {
    for (let seed = 96; seed <= 104; seed++) {
      const { events } = simulateOne(seed, seed % 4);
      const idx = keyMoments(events, 0, { ruleset: HKOS_STANDARD }).map((m) => m.index);
      expect(idx).toEqual([...idx].sort(asc));
    }
  });
});

/* ── handTimeline ──────────────────────────────────────────────────────── */

describe("handTimeline — one row per cut, for one seat", () => {
  /** Seat 0 is dealer with a ready 14 and cuts from it, then plays two turns. */
  function timelineLog(): GameEvent[] {
    const b = logBuilder();
    deal(b, four(
      [M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(9), S(1), S(2), S(3), EAST, WHITE],
      [P(4), P(6), S(4), S(5), S(6), S(7), S(8), S(9), M(1), M(2), M(3), RED, RED],
      [WEST, WEST, WEST, S(1), S(2), S(3), P(1), P(2), P(3), M(5), M(6), M(7), GREEN],
      [NORTH, NORTH, P(7), P(8), P(9), M(1), M(2), M(3), S(5), S(6), S(7), GREEN, GREEN],
    ), 0);
    // Turn 1 — dealer's opening cut, nothing came in.
    b.add("discard", 0, { seat: 0, tile: WHITE, drawAndCut: false });
    b.add("draw", 1, { seat: 1, tile: P(5), wallIndex: 54, wallRemaining: 90 });
    b.add("discard", 1, { seat: 1, tile: RED, drawAndCut: false });
    b.add("draw", 2, { seat: 2, tile: P(4), wallIndex: 55, wallRemaining: 89 });
    b.add("discard", 2, { seat: 2, tile: GREEN, drawAndCut: false });
    b.add("draw", 3, { seat: 3, tile: P(5), wallIndex: 56, wallRemaining: 88 });
    b.add("discard", 3, { seat: 3, tile: NORTH, drawAndCut: false });
    // Turn 2 — drew 北 and cut it straight back. 摸切.
    b.add("draw", 0, { seat: 0, tile: SOUTH, wallIndex: 57, wallRemaining: 87 });
    b.add("discard", 0, { seat: 0, tile: SOUTH, drawAndCut: true });
    b.add("draw", 1, { seat: 1, tile: WEST, wallIndex: 58, wallRemaining: 86 });
    b.add("discard", 1, { seat: 1, tile: WEST, drawAndCut: true });
    b.add("draw", 2, { seat: 2, tile: SOUTH, wallIndex: 59, wallRemaining: 85 });
    b.add("discard", 2, { seat: 2, tile: SOUTH, drawAndCut: true });
    b.add("draw", 3, { seat: 3, tile: WHITE, wallIndex: 60, wallRemaining: 84 });
    b.add("discard", 3, { seat: 3, tile: WHITE, drawAndCut: true });
    // Turn 3 — drew 白 and cut 東 instead. The draw was kept.
    b.add("draw", 0, { seat: 0, tile: WHITE, wallIndex: 61, wallRemaining: 83 });
    b.add("discard", 0, { seat: 0, tile: EAST, drawAndCut: false });
    return b.events;
  }

  it("reads only the requested seat, numbered from one", () => {
    const t = handTimeline(timelineLog(), 0);
    expect(t.map((x) => x.turn)).toEqual([1, 2, 3]);
    expect(t.every((x) => x.seat === 0)).toBe(true);
    expect(handTimeline(timelineLog(), 1)).toHaveLength(2);
  });

  it("marks 摸切 as its own state, distinct from keeping the draw", () => {
    const t = handTimeline(timelineLog(), 0);
    expect(t[0].state).toBe("dealtThenCutFromHand");
    expect(t[0].incoming).toEqual({ kind: "deal", tile: null, from: null });
    expect(t[1].state).toBe("drawAndCut");
    expect(t[1].incoming.tile).toBe(SOUTH);
    expect(t[1].discarded).toBe(SOUTH);
    expect(t[2].state).toBe("drawThenCutFromHand");
    expect(t[2].incoming.tile).toBe(WHITE);
    expect(t[2].discarded).toBe(EAST);
  });

  it("agrees with the log's own 摸切 flag on every turn", () => {
    for (let seed = 110; seed <= 117; seed++) {
      const { events } = simulateOne(seed, seed % 4);
      const flagged = new Map<number, boolean>();
      events.forEach((e, i) => {
        if (e.type === "discard") flagged.set(i, e.payload.drawAndCut);
      });
      for (const seat of [0, 1, 2, 3] as SeatIndex[]) {
        for (const turn of handTimeline(events, seat)) {
          expect(turn.state === "drawAndCut", `seed ${seed} index ${turn.index}`)
            .toBe(flagged.get(turn.index));
        }
      }
    }
  });

  it("records what came in from a claim, and who it came from", () => {
    const b = logBuilder();
    deal(b, four(
      [M(1), M(2), M(3), M(4), M(5), M(6), M(7), M(8), M(9), S(1), S(2), S(3), EAST, WHITE],
      [P(4), P(6), S(4), S(5), S(6), S(7), S(8), S(9), M(1), M(2), M(3), RED, RED],
      [WEST, WEST, WEST, S(1), S(2), S(3), P(1), P(2), P(3), M(5), M(6), M(7), GREEN],
      [NORTH, NORTH, P(7), P(8), P(9), M(1), M(2), M(3), S(5), S(6), S(7), GREEN, GREEN],
    ));
    b.add("discard", 0, { seat: 0, tile: WHITE, drawAndCut: false });
    b.add("discard", 3, { seat: 3, tile: P(5), drawAndCut: false });
    b.add("claimed", 0, { seat: 0, kind: "chow", tile: P(5), from: 3, meld: makeChow([P(4), P(5), P(6)], 0, 3) });
    b.add("discard", 0, { seat: 0, tile: EAST, drawAndCut: false });
    const t = handTimeline(b.events, 0);
    expect(t[1].state).toBe("claimThenCutFromHand");
    expect(t[1].incoming).toEqual({ kind: "chow", tile: P(5), from: 3 });
    expect(t[1].melds).toHaveLength(1);
  });

  it("holds the hand at the moment of the cut, incoming included", () => {
    const t = handTimeline(timelineLog(), 0);
    expect(t[0].hand).toHaveLength(14);
    expect(t[0].hand).toEqual([...t[0].hand].sort(asc));
    expect(t[1].hand).toContain(SOUTH);
    expect(t[1].hand).toHaveLength(14);
  });

  it("computes 上聽 before and after the cut, exactly", () => {
    const t = handTimeline(timelineLog(), 0);
    for (const turn of t) {
      const after = turn.hand.slice();
      after.splice(after.indexOf(turn.discarded), 1);
      expect(turn.distanceBefore).toBe(distanceToReady(counts(turn.hand), turn.melds.length));
      expect(turn.distanceAfter).toBe(distanceToReady(counts(after), turn.melds.length));
    }
    // 一二三萬 四五六萬 七八九萬 一二三索 + 東 白: cutting 白 leaves a 東 wait.
    expect(t[0].distanceAfter).toBe(0);
    expect(t[0].live.distance).toBe(0);
    expect(t[0].live.tiles.map((x) => x.tile)).toEqual([EAST]);
  });

  it("counts live tiles against what was accountable, never against four blindly", () => {
    const t = handTimeline(timelineLog(), 0);
    // Seat 0 holds one 東; three copies are unaccounted for.
    expect(t[0].live.tiles[0].unseen).toBe(3);
    expect(t[0].live.total).toBe(3);
  });

  it("keeps `visible` consistent: public tiles plus this seat's own hand, capped at 4", () => {
    for (let seed = 140; seed <= 145; seed++) {
      const { events } = simulateOne(seed, seed % 4);
      for (const seat of [0, 1, 2, 3] as SeatIndex[]) {
        for (const turn of handTimeline(events, seat)) {
          expect(turn.visible).toHaveLength(SCORING_KINDS);
          expect(maxCount(turn.visible), `seed ${seed} seat ${seat}`).toBeLessThanOrEqual(4);
          // Exactly the public count after the cut, plus what this seat still
          // holds. The cut tile has moved from the second term to the first,
          // so the sum stays put — that is the no-double-count rule seen from
          // the other side.
          const held = turn.hand.slice();
          held.splice(held.indexOf(turn.discarded), 1);
          const expected = visibilityCounts(events, turn.index + 1);
          const own = counts(held);
          for (let i = 0; i < SCORING_KINDS; i++) {
            expect(turn.visible[i], `seed ${seed} seat ${seat} tile ${i}`)
              .toBe(expected[i] + own[i]);
          }
        }
      }
    }
  });

  it("resets turn numbering on every deal", () => {
    const b = logBuilder();
    simulateHand(b, 200, 0);
    simulateHand(b, 201, 1);
    const t = handTimeline(b.events, 0);
    const firstOfHandOne = t.find((x) => x.handIndex === 1);
    expect(firstOfHandOne).toBeDefined();
    expect(firstOfHandOne!.turn).toBe(1);
  });

  it("never reports a hand size or set count that cannot exist", () => {
    for (let seed = 160; seed <= 167; seed++) {
      const { events } = simulateOne(seed, seed % 4);
      for (const seat of [0, 1, 2, 3] as SeatIndex[]) {
        for (const turn of handTimeline(events, seat)) {
          expect(turn.melds.length, `seed ${seed}`).toBeLessThanOrEqual(4);
          // 14 concealed tiles minus three per declared set, 花 excluded.
          const scoring = turn.hand.filter((t) => t < SCORING_KINDS).length;
          expect(scoring, `seed ${seed} seat ${seat} index ${turn.index}`)
            .toBe(14 - 3 * turn.melds.length);
          expect(turn.distanceBefore).toBeGreaterThanOrEqual(-1);
          expect(turn.distanceAfter).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

/* ── determinism (DESIGN.md §5.5) ──────────────────────────────────────── */

describe("determinism — replay is re-execution", () => {
  it("produces identical logs and identical analysis from the same seed", () => {
    // The prototype's unseeded bot decisions made one wall seed diverge. Both
    // the simulator's choices and everything analysis.ts derives from them go
    // through prng(seed) or nothing at all.
    for (const seed of [11, 222, 3333]) {
      const a = simulateOne(seed, 1);
      const b = simulateOne(seed, 1);
      expect(b.events).toEqual(a.events);
      expect(keyMoments(b.events, 0, { ruleset: HKOS_STANDARD }))
        .toEqual(keyMoments(a.events, 0, { ruleset: HKOS_STANDARD }));
      expect(handTimeline(b.events, 2)).toEqual(handTimeline(a.events, 2));
      expect(visibilityCounts(b.events)).toEqual(visibilityCounts(a.events));
    }
  });

  it("is a pure read: analysing a log twice gives the same answer", () => {
    const { events } = simulateOne(999, 2);
    const snapshot = JSON.stringify(events);
    const first: Turn[] = handTimeline(events, 1);
    const moments: Moment[] = keyMoments(events, 1, { ruleset: HKOS_STANDARD });
    expect(handTimeline(events, 1)).toEqual(first);
    expect(keyMoments(events, 1, { ruleset: HKOS_STANDARD })).toEqual(moments);
    expect(JSON.stringify(events)).toBe(snapshot); // nothing was mutated
  });

  it("does not hand out references into its own fold", () => {
    const { events } = simulateOne(1234, 0);
    const t = handTimeline(events, 0);
    expect(t.length).toBeGreaterThan(0);
    const before = t[0].hand.slice();
    t[0].hand.push(999);
    t[0].melds.push(makePung(EAST, 0, 1));
    expect(handTimeline(events, 0)[0].hand).toEqual(before);
  });
});

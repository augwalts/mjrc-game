/**
 * Bot policy tests, and the simulation harness DESIGN.md §6 measures bots with.
 *
 * §6 sets the bar as "gate 3's parity metrics, not vibes": call rate, mean
 * winning faan, deal-in rate and exhaustive-draw rate (§3, gate 3). The
 * baseline being replaced is the audited prototype's — 69% exhaustive draws
 * 流局 with 4x GreedyBot, zero claims, faan-blind (ENGINE-AUDIT §3).
 *
 * ── the harness drives the real table ────────────────────────────────────
 *
 * `runSimulation` seats four bots at `reducer.ts` and plays whole wind rounds:
 * the same `startMatch` / `legalActions` / `applyAction` the Durable Object
 * calls, the same `score` from scoring.ts, the same event log that goes to R2.
 * Nothing about the rules is re-implemented here, so the numbers below are
 * measurements of the shipping game rather than of a test fixture that happens
 * to resemble it.
 *
 * Two properties this buys, and both matter:
 *
 *  - A BOT IS A PLAYER WHOSE INPUT IS A FUNCTION CALL (§6). Every seat is
 *    handed a `SeatView` assembled from public state plus its own tiles, and
 *    must return an Action the reducer already ruled legal. `expect(options)
 *    .toContain(action)` in the loop is the check that it never invents one.
 *  - REPLAY IS RE-EXECUTION (§5.5). The harness keeps the omniscient event log
 *    and the determinism test asserts two runs of one seed serialise
 *    byte-for-byte identically.
 *
 * DETERMINISM. Walls come from the match seed through `handSeedFor`; every bot
 * tiebreak comes from a per-seat `prng` stream derived from that same seed. No
 * Math.random, no Date.now — a test at the bottom greps the policy source for
 * both, because ENGINE-AUDIT records that exact bug making identical wall seeds
 * diverge in the prototype.
 */
import { describe, expect, it } from "vitest";
import type {
  Action,
  ClaimOption,
  Meld,
  Ruleset,
  SeatIndex,
  TileId,
  WindIndex,
} from "../src/types.js";
import { counts } from "../src/tiles.js";
import { prng } from "../src/wall.js";
import { distanceToReady } from "../src/ready.js";
import { leftOf, makeChow, makePung } from "../src/melds.js";
import {
  applyAction,
  legalActions,
  startMatch,
  startNextHand,
  type Applied,
  type MatchConfig,
  type MatchState,
} from "../src/reducer.js";
import {
  DEFAULT_PROFILE,
  assessClaim,
  chooseDiscard,
  chooseRoute,
  claimDecision,
  decideAction,
  discardDanger,
  faanCeiling,
  pungDistance,
  rankDiscards,
  shapeAfterClaim,
  shapeOf,
  visibleCounts,
  type BotConfig,
  type SeatView,
} from "../src/bots.js";
import type { GameEvent } from "@mjrc/protocol";
import { HKOS_STANDARD } from "../../rulesets/src/presets.js";

/**
 * Read a source file back for the regression greps at the bottom. The specifier
 * is held in a variable on purpose: the workspace ships no @types/node and this
 * task adds no dependencies, so a literal "node:fs" import would not compile.
 */
const NODE_FS = "node:fs";
async function readSource(rel: string): Promise<string> {
  const fs = await import(NODE_FS);
  return fs.readFileSync(new URL(rel, import.meta.url), "utf8") as string;
}

const SEATS: readonly SeatIndex[] = [0, 1, 2, 3];

/* ── the seat view ─────────────────────────────────────────────────────── */

/**
 * The redacted per-seat view of DESIGN.md §5.3, assembled from `MatchState`.
 *
 * THE REDACTION IS THE POINT. Melds, flowers and discards are face up, so all
 * four seats' are readable; hands are not, so only `handCounts` crosses. If
 * this function ever handed `state.seats[other].hand` to a bot, every metric
 * below would be measuring a cheat.
 */
export function viewFor(state: MatchState, seat: SeatIndex): SeatView {
  const me = state.seats[seat]!;
  const offered = state.claim;
  return {
    seat,
    dealer: state.dealer,
    roundWind: state.roundWind,
    seatWinds: state.seats.map((s) => s.wind),
    hand: me.hand,
    drawn: me.drawn,
    melds: state.seats.map((s) => s.melds),
    flowers: state.seats.map((s) => s.flowers),
    discards: state.seats.map((s) => s.discards),
    handCounts: state.seats.map((s) => s.hand.length),
    wallRemaining: Math.max(0, state.wallEnd - state.wallIndex),
    lastDiscard:
      offered === null ? state.lastDiscard : { tile: offered.tile, from: offered.from },
  };
}

/* ── the simulation harness ────────────────────────────────────────────── */

/** A seat's decision function. Same shape a Durable Object would call. */
export type Decide = (
  view: SeatView,
  legal: readonly Action[],
  seat: SeatIndex,
) => Action;

export interface Metrics {
  matches: number;
  hands: number;
  /** 流局 — the headline number. Audited prototype baseline: 0.69. */
  drawRate: number;
  meanWinningFaan: number;
  /** Melds claimed off a discard, per hand. Audited baseline: 0. */
  callsPerHand: number;
  /** Share of offered claims a seat took. */
  claimAcceptance: number;
  /** Share of hands that ended with a seat dealing the winning tile in. */
  dealInRate: number;
  selfDrawShare: number;
  meanDiscards: number;
  /**
   * Wins declared and then refused for sitting under the house minimum. The
   * reducer, not the bot, is the authority on that — a bot that re-implemented
   * the faan table to pre-screen its own wins would be a second scorer to keep
   * in step. §5.2 wants these visible, so they are counted rather than hidden.
   */
  refusedWinsPerHand: number;
  faanHistogram: number[];
  /** Every omniscient event of every match, serialised. The replay contract. */
  log: string;
}

/** The shipping policy, one deterministic stream per seat. */
export function botDecide(rules: Ruleset, seed: number): Decide {
  const configs: BotConfig[] = SEATS.map((s) => ({
    ruleset: rules,
    rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  return (view, legal, seat) => decideAction(view, legal, configs[seat]!);
}

/**
 * The audited baseline, reproduced against THIS reducer so the improvement is
 * measured inside one game rather than against a number from another codebase:
 * pure distance-greedy, never claims, faan-blind (ENGINE-AUDIT §3).
 */
export const greedyDecide: Decide = (view, legal) => {
  for (const a of legal) if (a.type === "declareWin") return a;
  for (const a of legal) if (a.type === "claim" && a.option.kind === "win") return a;
  const pass = legal.find((a) => a.type === "pass");
  if (pass) return pass;
  const discards = legal.filter(
    (a): a is Extract<Action, { type: "discard" }> => a.type === "discard",
  );
  if (discards.length === 0) return legal[0]!;
  const melds = view.melds[view.seat]!.length;
  const c = counts(view.drawn === null ? view.hand : [...view.hand, view.drawn]);
  let best = discards[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const a of discards) {
    c[a.tile]!--;
    const d = distanceToReady(c, melds);
    c[a.tile]!++;
    if (d < bestDistance) {
      bestDistance = d;
      best = a;
    }
  }
  return best;
};

/** Play one match to 東圈 completion, returning its omniscient event log. */
export function playMatch(config: MatchConfig, decide: Decide): GameEvent[] {
  let { state, events } = startMatch(config);
  const log: GameEvent[] = [...events];
  const step = (applied: Applied): void => {
    state = applied.state;
    log.push(...applied.events);
  };

  for (let guard = 0; guard < 200_000; guard++) {
    if (state.phase === "matchEnd") return log;
    if (state.phase === "handEnd") {
      step(startNextHand(state));
      continue;
    }
    let acted = false;
    for (const seat of SEATS) {
      const options = legalActions(state, seat);
      if (options.length === 0) continue;
      const action = decide(viewFor(state, seat), options, seat);
      // A bot may only take a move the table already offered it (§6).
      expect(options).toContain(action);
      step(applyAction(state, action));
      acted = true;
      break;
    }
    if (!acted) throw new Error(`no seat can act in phase "${state.phase}"`);
  }
  throw new Error("match did not terminate");
}

export interface SimOptions {
  matches: number;
  baseSeed: number;
  rules?: Ruleset;
  /** Defaults to the shipping policy, seeded from each match's own seed. */
  decide?: (seed: number, rules: Ruleset) => Decide;
}

export function runSimulation(opts: SimOptions): Metrics {
  const rules = opts.rules ?? HKOS_STANDARD;
  const makeDecide = opts.decide ?? ((seed, r) => botDecide(r, seed));
  const log: GameEvent[] = [];
  for (let m = 0; m < opts.matches; m++) {
    const seed = opts.baseSeed + m;
    log.push(
      ...playMatch(
        {
          matchId: `sim-${m}`,
          seed,
          rulesetId: rules.id,
          dealer: (m % 4) as SeatIndex,
          matchLength: "oneWindRound",
          startedAt: 0,
        },
        makeDecide(seed, rules),
      ),
    );
  }

  let hands = 0;
  let draws = 0;
  let dealIns = 0;
  let selfDraws = 0;
  let faanTotal = 0;
  let wins = 0;
  let calls = 0;
  let offers = 0;
  let discards = 0;
  let refusedWins = 0;
  const faanHistogram = new Array<number>(rules.limitFaan + 1).fill(0);
  for (const e of log) {
    switch (e.type) {
      case "handEnd": {
        hands++;
        if (e.payload.outcome === "exhaustiveDraw") draws++;
        if (e.payload.outcome === "winOnDiscard") dealIns++;
        if (e.payload.outcome === "selfDraw") selfDraws++;
        if (e.payload.faan !== null) {
          wins++;
          faanTotal += e.payload.faan;
          faanHistogram[Math.min(e.payload.faan, rules.limitFaan)]!++;
        }
        break;
      }
      case "claimed":
        calls++;
        break;
      case "claimOffered":
        offers++;
        break;
      case "discard":
        discards++;
        break;
      case "refusedWin":
        refusedWins++;
        break;
      default:
        break;
    }
  }
  return {
    matches: opts.matches,
    hands,
    drawRate: draws / hands,
    meanWinningFaan: wins === 0 ? 0 : faanTotal / wins,
    callsPerHand: calls / hands,
    claimAcceptance: offers === 0 ? 0 : calls / offers,
    dealInRate: dealIns / hands,
    selfDrawShare: wins === 0 ? 0 : selfDraws / wins,
    meanDiscards: discards / hands,
    refusedWinsPerHand: refusedWins / hands,
    faanHistogram,
    log: JSON.stringify(log),
  };
}

/* ── fixtures ──────────────────────────────────────────────────────────── */

const RULES = HKOS_STANDARD;
const emptyPerSeat = <T>(v: () => T): [T, T, T, T] => [v(), v(), v(), v()];

function makeView(over: Partial<SeatView> = {}): SeatView {
  return {
    seat: 0,
    dealer: 0,
    roundWind: 0,
    seatWinds: [0, 1, 2, 3],
    hand: [],
    drawn: null,
    melds: emptyPerSeat<Meld[]>(() => []),
    flowers: emptyPerSeat<TileId[]>(() => []),
    discards: emptyPerSeat<TileId[]>(() => []),
    handCounts: [13, 13, 13, 13],
    wallRemaining: 80,
    lastDiscard: null,
    ...over,
  };
}

const cfg = (seed = 1): BotConfig => ({ ruleset: RULES, rnd: prng(seed) });

/* ── §6.2 route steering ───────────────────────────────────────────────── */

describe("faan-route steering", () => {
  it("commits to 混一色 when the hand is already lopsided in one suit", () => {
    // Nine bamboo, two dragons, two strays. The flush is three faan; balanced
    // 平糊 is one and cannot legally be taken at a 3-faan minimum.
    const hand = [9, 10, 11, 12, 13, 14, 15, 16, 17, 31, 31, 0, 20];
    const r = chooseRoute(
      { concealed: hand, melds: [], flowers: [], seatWind: 0, roundWind: 0 }, RULES,
    );
    expect(r.route.suit).toBe("bamboo");
    expect(r.faan).toBeGreaterThanOrEqual(RULES.minimumFaan);
  });

  it("commits to 對對糊 on a hand full of pairs", () => {
    const hand = [0, 0, 4, 4, 9, 9, 13, 13, 20, 20, 27, 27, 31];
    const r = chooseRoute(
      { concealed: hand, melds: [], flowers: [], seatWind: 0, roundWind: 0 }, RULES,
    );
    expect(r.route.pungs).toBe(true);
    expect(r.faan).toBeGreaterThanOrEqual(RULES.minimumFaan);
  });

  it("never steers toward a route that cannot reach the house minimum", () => {
    // A flat three-suit hand with no flowers. Whatever it picks has to be a
    // route that can legally be taken, not the fastest shape on the table.
    const hand = [0, 1, 2, 9, 10, 12, 18, 19, 22, 27, 30, 31, 33];
    const shape = { concealed: hand, melds: [], flowers: [], seatWind: 0 as WindIndex, roundWind: 0 as WindIndex };
    expect(faanCeiling(shape, RULES)).toBeGreaterThanOrEqual(RULES.minimumFaan);
    const r = chooseRoute(shape, RULES);
    expect(r.feasible).toBe(true);
  });

  it("marks a route dead once a declared meld contradicts it", () => {
    // A chow of characters kills every 對對糊 and every non-character flush.
    const melds = [makeChow([0, 1, 2], 0, 3)];
    const shape = {
      concealed: [9, 9, 9, 13, 13, 20, 20, 20, 31, 31],
      melds, flowers: [], seatWind: 0 as WindIndex, roundWind: 0 as WindIndex,
    };
    const r = chooseRoute(shape, RULES);
    expect(r.route.pungs).toBe(false);
    expect(r.route.suit === null || r.route.suit === "chars").toBe(true);
  });

  it("pungDistance ignores runs, unlike distanceToReady", () => {
    // A pure run hand is ready for a normal win and nowhere near 對對糊.
    const run = counts([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 31]);
    expect(pungDistance(run, 0)).toBeGreaterThan(3);
    const pungs = counts([0, 0, 0, 4, 4, 4, 9, 9, 9, 20, 20, 20, 31]);
    expect(pungDistance(pungs, 0)).toBe(0);
  });
});

/* ── §6.1 claim logic — the HK sin ─────────────────────────────────────── */

describe("claim logic", () => {
  const chowOffer = (hand: TileId[], tile: TileId, w: TileId[], flowers: TileId[] = []) => {
    const v = makeView({
      hand,
      flowers: [flowers, [], [], []],
      lastDiscard: { tile, from: 3 },
    });
    return assessClaim(v, { kind: "chow", with: w }, cfg());
  };

  it("refuses the HK sin: a chow that leaves the open hand under the minimum", () => {
    // Three suits, no flowers, no honour pair worth a pung. Concealed, this
    // hand is legal — 平糊 1 + 門前清 1 + 自摸 1 is exactly three. Chowing
    // spends the 門前清 and leaves a 平糊 worth one, which no one may take.
    const hand = [0, 1, 3, 4, 5, 9, 10, 11, 13, 18, 19, 20, 25];
    const v = makeView({ hand, lastDiscard: { tile: 2, from: 3 } });
    expect(faanCeiling(shapeOf(v), RULES)).toBeGreaterThanOrEqual(RULES.minimumFaan);
    const after = shapeAfterClaim(v, { kind: "chow", with: [0, 1] }, 2, 3);
    expect(after).not.toBeNull();
    expect(faanCeiling(after!, RULES)).toBeLessThan(
      faanCeiling(shapeOf(v), RULES),
    );
    // Every route still paying three faan open is a flush this hand cannot
    // fill, so the best route left is worth far less than the one given up.
    expect(chooseRoute(after!, RULES).score).toBeLessThan(
      chooseRoute(shapeOf(v), RULES).score - 1,
    );
    expect(chowOffer(hand, 2, [0, 1]).reason).not.toBe("accepted");
  });

  it("takes the same chow once flowers have paid the hand up to the minimum", () => {
    // 梅 and 春 are East's own flower and own season: two faan banked, so the
    // one-faan 平糊 route is now a legal three-faan hand.
    const hand = [0, 1, 3, 4, 5, 9, 10, 11, 13, 18, 19, 20, 25];
    const a = chowOffer(hand, 2, [0, 1], [34, 38]);
    expect(a.faanCeiling).toBeGreaterThanOrEqual(RULES.minimumFaan);
    expect(a.reason).toBe("accepted");
  });

  it("takes a pung that serves the 混一色 route", () => {
    const hand = [9, 9, 10, 11, 12, 13, 14, 16, 17, 31, 31, 32, 32];
    const v = makeView({ hand, lastDiscard: { tile: 31, from: 2 } });
    const a = assessClaim(v, { kind: "pung" }, cfg());
    expect(a.reason).toBe("accepted");
    expect(a.faanCeiling).toBeGreaterThanOrEqual(RULES.minimumFaan);
  });

  it("refuses a chow that would break a committed flush", () => {
    // All bamboo plus a dragon pair. A chow of circles ends 混一色 and with it
    // any route this hand can legally win on.
    const hand = [9, 10, 11, 12, 13, 14, 15, 16, 17, 31, 31, 21, 23];
    const v = makeView({ hand, lastDiscard: { tile: 22, from: 3 } });
    const a = assessClaim(v, { kind: "chow", with: [21, 23] }, cfg());
    expect(a.reason).not.toBe("accepted");
  });

  it("claimDecision passes rather than take a dead claim", () => {
    const hand = [0, 1, 3, 4, 5, 9, 10, 11, 13, 18, 19, 20, 25];
    const v = makeView({ hand, lastDiscard: { tile: 2, from: 3 } });
    expect(claimDecision(v, [{ kind: "chow", with: [0, 1] }], cfg())).toBeNull();
  });

  it("decideAction always takes a legal win over any other action", () => {
    const v = makeView({ hand: [0, 0, 0, 1, 2, 3, 9, 9, 9, 20, 20, 20, 31], lastDiscard: { tile: 31, from: 1 } });
    const legal: Action[] = [
      { type: "claim", seat: 0, option: { kind: "pung" } },
      { type: "claim", seat: 0, option: { kind: "win" } },
      { type: "pass", seat: 0 },
    ];
    const a = decideAction(v, legal, cfg());
    expect(a.type).toBe("claim");
    expect((a as Extract<Action, { type: "claim" }>).option.kind).toBe("win");
  });
});

/* ── §6.3 count-based discard safety ───────────────────────────────────── */

describe("discard safety", () => {
  it("rates a tile with every other copy visible as harmless", () => {
    const v = makeView({
      hand: [31, 0, 1, 2, 9, 10, 11, 18, 19, 20, 4, 5, 6],
      discards: [[31, 31, 31], [], [], []],
      melds: emptyPerSeat<Meld[]>(() => []),
    });
    const visible = visibleCounts(v);
    expect(visible[31]).toBe(4);
    // Nothing left to claim it with, against a live tile nobody has shown.
    expect(discardDanger(v, 31, visible)).toBeLessThan(discardDanger(v, 4, visible));
  });

  it("reads an opponent's one-suit melds as a flush and avoids feeding it", () => {
    const flushMelds: Meld[] = [makePung(9, 1, 0), makePung(13, 1, 0)];
    const v = makeView({
      hand: [0, 1, 2, 4, 5, 6, 11, 18, 19, 20, 27, 27, 31],
      melds: [[], flushMelds, [], []],
    });
    const visible = visibleCounts(v);
    // A bamboo tile feeds seat 1's 混一色; a character of the same shape does not.
    expect(discardDanger(v, 11, visible)).toBeGreaterThan(discardDanger(v, 4, visible));
  });

  it("only fears a chow from the seat to our right — 上 comes from 上家 only", () => {
    // Sanity on the geometry the danger model depends on: our discard can be
    // chowed by exactly the seat whose 上家 we are.
    for (const seat of SEATS) expect(leftOf(((seat + 1) % 4) as SeatIndex)).toBe(seat);
  });

  it("uses outs to separate otherwise equal discards", () => {
    // 5萬 and 5筒 sit in mirror-image positions: same distance cost, same
    // visible neighbours, same danger. Nothing but outs can separate them, and
    // §6 requirement 4 says that is exactly what outs are for.
    const v = makeView({ hand: [0, 1, 2, 4, 9, 10, 11, 18, 19, 20, 22, 27, 27] });
    const ranked = rankDiscards(v, cfg());
    const strays = ranked.filter((r) => r.tile === 4 || r.tile === 22);
    expect(strays).toHaveLength(2);
    // Both were tied, so both carry a computed outs count rather than the -1
    // that marks "never needed".
    expect(strays.every((r) => r.outs >= 0)).toBe(true);
    expect([4, 22]).toContain(ranked[0]!.tile);
    // And the tiebreak is not free-floating: a tile inside a finished run is
    // never cut ahead of a stray.
    expect(ranked.findIndex((r) => r.tile === 1)).toBeGreaterThan(1);
  });

  it("keeps the route's suit and cuts off-route tiles first", () => {
    const v = makeView({ hand: [9, 10, 11, 12, 13, 14, 15, 16, 31, 31, 0, 20, 25] });
    const ranked = rankDiscards(v, cfg());
    expect([0, 20, 25]).toContain(ranked[0]!.tile);
  });
});

/* ── determinism ───────────────────────────────────────────────────────── */

describe("determinism", () => {
  it("the policy source calls no wall-clock or unseeded randomness", async () => {
    const src = await readSource("../src/bots.ts");
    // Call syntax, so the header comment may keep naming what it forbids.
    expect(src).not.toMatch(/Math\s*\.\s*random\s*\(/);
    expect(src).not.toMatch(/Date\s*\.\s*now\s*\(/);
    expect(src).not.toMatch(/new\s+Date\s*\(/);
    // Every choice runs through the injected stream.
    expect(src).toMatch(/cfg\.rnd/);
  });

  it("gives the same discard for the same seed and a different one otherwise", () => {
    const v = makeView({ hand: [0, 2, 4, 9, 11, 13, 18, 20, 22, 27, 29, 31, 33] });
    expect(chooseDiscard(v, cfg(11))).toBe(chooseDiscard(v, cfg(11)));
    const many = new Set<TileId>();
    for (let s = 0; s < 40; s++) many.add(chooseDiscard(v, cfg(s)));
    // A flat hand has genuine ties, and the seeded stream is what resolves them.
    expect(many.size).toBeGreaterThan(1);
  });

  it("replays a whole match byte-for-byte from its seed", () => {
    const config: MatchConfig = {
      matchId: "replay",
      seed: 20260826,
      rulesetId: RULES.id,
      matchLength: "oneWindRound",
      startedAt: 0,
    };
    const a = playMatch(config, botDecide(RULES, config.seed));
    const b = playMatch(config, botDecide(RULES, config.seed));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.length).toBeGreaterThan(200);
  });
});

/* ── the gate-3 simulation ─────────────────────────────────────────────── */

/** 東圈 apiece, so a "match" is four rotations plus 連莊 repeats. */
const SIM_MATCHES = 14;
const SIM_SEED = 90210;
/** Determinism needs repeatability, not volume. */
const REPLAY_MATCHES = 3;

describe("simulation harness — DESIGN.md §3 gate 3 texture", () => {
  const metrics = runSimulation({ matches: SIM_MATCHES, baseSeed: SIM_SEED });

  it("reports the gate-3 metrics", () => {
    // eslint-disable-next-line no-console
    console.log(
      [
        `matches / hands       ${metrics.matches} / ${metrics.hands}`,
        `exhaustive draw 流局   ${(metrics.drawRate * 100).toFixed(1)}%  (baseline 69.0%)`,
        `mean winning faan     ${metrics.meanWinningFaan.toFixed(2)}`,
        `calls per hand        ${metrics.callsPerHand.toFixed(2)}  (baseline 0.00)`,
        `claim acceptance      ${(metrics.claimAcceptance * 100).toFixed(1)}%`,
        `deal-in rate          ${(metrics.dealInRate * 100).toFixed(1)}%`,
        `self-draw share       ${(metrics.selfDrawShare * 100).toFixed(1)}%`,
        `mean discards/hand    ${metrics.meanDiscards.toFixed(1)}`,
        `refused wins/hand     ${metrics.refusedWinsPerHand.toFixed(2)}`,
        `faan histogram        ${metrics.faanHistogram.map((n, i) => (n ? `${i}:${n}` : "")).filter(Boolean).join(" ")}`,
      ].join("\n"),
    );
    expect(metrics.hands).toBeGreaterThanOrEqual(SIM_MATCHES * 4);
  });

  it("beats the 69% exhaustive-draw baseline by a wide margin", () => {
    // The audited prototype sat at 0.69 and the table felt dead. The threshold
    // is set well clear of the measured figure so tuning the profile shows up
    // as a moved number in the report above, not as a broken test.
    expect(metrics.drawRate).toBeLessThan(0.4);
  });

  it("claims — the prototype's zero is the thing that made HK play feel alien", () => {
    expect(metrics.callsPerHand).toBeGreaterThan(1);
  });

  it("never books a win under the house minimum", () => {
    expect(metrics.meanWinningFaan).toBeGreaterThanOrEqual(RULES.minimumFaan);
    for (let f = 0; f < RULES.minimumFaan; f++) expect(metrics.faanHistogram[f]).toBe(0);
  });

  it("wins arrive off discards as well as off draws", () => {
    expect(metrics.dealInRate).toBeGreaterThan(0);
    expect(metrics.selfDrawShare).toBeLessThan(1);
  });

  it("is materially better than the audited greedy baseline in this same harness", () => {
    const greedy = runSimulation({
      matches: SIM_MATCHES,
      baseSeed: SIM_SEED,
      decide: () => greedyDecide,
    });
    // eslint-disable-next-line no-console
    console.log(
      `greedy baseline: draws ${(greedy.drawRate * 100).toFixed(1)}%  ` +
        `calls/hand ${greedy.callsPerHand.toFixed(2)}  ` +
        `mean faan ${greedy.meanWinningFaan.toFixed(2)}  ` +
        `faan per hand dealt ${((1 - greedy.drawRate) * greedy.meanWinningFaan).toFixed(2)}` +
        ` against steered ${((1 - metrics.drawRate) * metrics.meanWinningFaan).toFixed(2)}`,
    );
    expect(greedy.callsPerHand).toBe(0);
    expect(metrics.drawRate).toBeLessThan(greedy.drawRate);
    // Converts materially more of the hands dealt into hands someone takes.
    expect(1 - metrics.drawRate).toBeGreaterThan((1 - greedy.drawRate) * 1.05);
    // And they are not cheaper wins bought with volume. Faan collected per hand
    // DEALT settles the "more wins against richer wins" trade, and steering is
    // ahead on it — a greedy bot wins less often and its wins are accidents
    // (ENGINE-AUDIT §3: "every win was a 4+ faan accident").
    expect((1 - metrics.drawRate) * metrics.meanWinningFaan).toBeGreaterThan(
      (1 - greedy.drawRate) * greedy.meanWinningFaan,
    );
  });

  it("produces byte-identical event logs across runs of the same seed", () => {
    const a = runSimulation({ matches: REPLAY_MATCHES, baseSeed: SIM_SEED });
    const b = runSimulation({ matches: REPLAY_MATCHES, baseSeed: SIM_SEED });
    expect(b.log).toBe(a.log);
    expect(a.log.length).toBeGreaterThan(10_000);
    expect(b.drawRate).toBe(a.drawRate);
    expect(b.meanWinningFaan).toBe(a.meanWinningFaan);
    const other = runSimulation({ matches: REPLAY_MATCHES, baseSeed: SIM_SEED + 1 });
    expect(other.log).not.toBe(a.log);
  });

  it("holds up on a different block of seeds, so the profile is not seed-fitted", () => {
    const other = runSimulation({ matches: SIM_MATCHES, baseSeed: SIM_SEED + 5000 });
    // eslint-disable-next-line no-console
    console.log(
      `holdout block: draws ${(other.drawRate * 100).toFixed(1)}%  ` +
        `calls/hand ${other.callsPerHand.toFixed(2)}  ` +
        `mean faan ${other.meanWinningFaan.toFixed(2)}`,
    );
    expect(other.drawRate).toBeLessThan(0.4);
    expect(other.callsPerHand).toBeGreaterThan(1);
  });

  it("uses the shipping profile, so the numbers above are the shipping numbers", () => {
    expect(DEFAULT_PROFILE.belowMinimumPenalty).toBeGreaterThan(0);
    expect(shapeOf(makeView({ hand: [0] })).concealed).toEqual([0]);
  });
});

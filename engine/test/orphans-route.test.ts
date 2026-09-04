/**
 * Thirteen Orphans 十三么 as a bot route — STRATEGY.md §2's desperation play.
 *
 * The owner: "if I have 7-8 of the 13 orphans in an otherwise fragmented deal
 * I sometimes just go for it… if things get bad, pivot into all pungs or
 * terminals or just not losing." Four contracts fall out of that and each has
 * a test here:
 *
 *  1. ELIGIBILITY. Hard-gated under six distinct 么九 kinds; scored at six and
 *     over, where the distance tax keeps it losing until the deal reaches the
 *     owner's 7-8, fragmented shape.
 *  2. CONCEALMENT. The route never chows, pungs or kongs — one meld and there
 *     is no orphans hand left to make. The winning claim is the exception.
 *  3. BAIL. `chooseRoute` runs every turn, so the pivot is scoring, not a
 *     rule: a stalled hunt piles up 么九 pairs, and those same tiles read
 *     better and better as 對對糊 until it overtakes — the owner's bail path.
 *  4. COMPLETION. The reducer must OFFER the win at all. `decomposeWin` has no
 *     reading for 十三么 (no four-sets-and-a-pair), so `hasWinningShape` tests
 *     the shape directly — without that the route could never finish a hand.
 *
 * The simulation at the bottom reuses the bots.test.ts harness pattern against
 * the real reducer. Completions are counted and logged, not thresholded: only
 * ~2% of deals hold 7+ orphan kinds, so a fixed count would be seed-trivia.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Action, Meld, SeatIndex, TileId, WindIndex } from "../src/types.js";
import { counts, isTerminalOrHonour } from "../src/tiles.js";
import { prng } from "../src/wall.js";
import { hasWinningShape, isThirteenOrphansShape } from "../src/decompose.js";
import {
  assessClaim,
  assessRoutes,
  chooseRoute,
  claimDecision,
  decideAction,
  orphansDistance,
  rankDiscards,
  shapeOf,
  shouldKong,
  type BotConfig,
  type SeatView,
} from "../src/bots.js";
import {
  applyAction,
  legalActions,
  startMatch,
  startNextHand,
  type MatchState,
} from "../src/reducer.js";
import type { GameEvent } from "@mjrc/protocol";
import { HKOS_STANDARD } from "../../rulesets/src/presets.js";

const RULES = HKOS_STANDARD;
const SEATS: readonly SeatIndex[] = [0, 1, 2, 3];
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

const shape = (hand: TileId[]) =>
  ({ concealed: hand, melds: [], flowers: [], seatWind: 0 as WindIndex, roundWind: 0 as WindIndex });

/* Tile-id cheat sheet: 0=1萬 8=9萬 9=1索 17=9索 18=1筒 26=9筒
 * 27東 28南 29西 30北 31中 32發 33白. */

/** 8 orphan kinds, 東 paired, and four fragmented middles — the owner's deal. */
const EIGHT_KIND_JUNK: TileId[] = [0, 8, 9, 17, 18, 26, 27, 27, 28, 3, 5, 21, 23];

/* ── distance formula ──────────────────────────────────────────────────── */

describe("orphansDistance", () => {
  it("anchors to distanceToReady's scale: -1 complete, 0 ready", () => {
    // Complete 14: all thirteen kinds, 白 paired.
    expect(orphansDistance(counts([0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33, 33]))).toBe(-1);
    // The thirteen-sided wait: all kinds bare, no pair yet.
    expect(orphansDistance(counts([0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]))).toBe(0);
    // Twelve kinds plus a pair: waiting on the last kind.
    expect(orphansDistance(counts([0, 0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32]))).toBe(0);
    // The owner's deal: 8 kinds, one paired.
    expect(orphansDistance(counts(EIGHT_KIND_JUNK))).toBe(4);
  });
});

/* ── route selection ───────────────────────────────────────────────────── */

describe("route selection", () => {
  it("chooses 十三么 on an 8-kind fragmented deal — the owner's 'just go for it'", () => {
    const chosen = chooseRoute(shape(EIGHT_KIND_JUNK), RULES);
    expect(chosen.route.id).toBe("orphans");
    expect(chosen.faan).toBe(RULES.faanTable["thirteenOrphans"]);
    expect(chosen.distance).toBe(4);
    // Orphan-rich junk carries no surplus for this route: the strays it must
    // shed fit inside the discards the distance already owes.
    expect(chosen.surplus).toBe(0);
  });

  it("never chooses it on a normal deal, and hard-gates it under six kinds", () => {
    // Two runs, a run start, a pair — a perfectly ordinary hand, 3 orphan kinds.
    const normal: TileId[] = [0, 1, 2, 4, 5, 6, 9, 10, 11, 13, 14, 26, 31];
    const chosen = chooseRoute(shape(normal), RULES);
    expect(chosen.route.id).not.toBe("orphans");
    const orphans = assessRoutes(shape(normal), RULES).find((a) => a.route.orphans)!;
    expect(orphans.feasible).toBe(false); // 3 kinds < 6: the gate, not the score
    expect(orphans.score).toBe(Number.NEGATIVE_INFINITY);
  });

  it("at six kinds the gate opens and SCORING keeps it out — the 7-8 rule", () => {
    // Six bare kinds, no pair, junk everywhere: eligible but hopeless.
    const sixKinds: TileId[] = [0, 8, 9, 17, 27, 31, 3, 5, 13, 15, 21, 23, 22];
    const all = assessRoutes(shape(sixKinds), RULES);
    const orphans = all.find((a) => a.route.orphans)!;
    expect(orphans.feasible).toBe(true); // 6 kinds: past the hard gate
    const chosen = chooseRoute(shape(sixKinds), RULES);
    expect(chosen.route.id).not.toBe("orphans"); // but the score says no
    expect(orphans.score).toBeLessThan(chosen.score);
  });

  it("a declared meld kills the route outright", () => {
    const melds: Meld[] = [
      { kind: "pung", tiles: [27, 27, 27], from: 2, concealed: false },
    ];
    const orphans = assessRoutes(
      { concealed: [0, 8, 9, 17, 18, 26, 28, 29, 30, 31], melds, flowers: [], seatWind: 0, roundWind: 0 },
      RULES,
    ).find((a) => a.route.orphans)!;
    expect(orphans.feasible).toBe(false);
  });

  it("steers discards: junk is cut first, 么九 kinds are kept", () => {
    const ranked = rankDiscards(makeView({ hand: EIGHT_KIND_JUNK }), cfg());
    expect([3, 5, 21, 23]).toContain(ranked[0]!.tile);
    // Every junk middle outranks every orphan tile, pair included.
    const worstJunk = Math.max(...[3, 5, 21, 23].map((t) => ranked.findIndex((r) => r.tile === t)));
    const bestOrphan = Math.min(
      ...[0, 8, 9, 17, 18, 26, 27, 28].map((t) => ranked.findIndex((r) => r.tile === t)),
    );
    expect(worstJunk).toBeLessThan(bestOrphan);
  });

  it("keeps ONE duplicate as the pair and sheds further duplicates before singles", () => {
    // A third 1萬 helps this hand no more than junk does. (A terminal triple
    // on purpose: an honour triple would fairly tip the score toward 字一色.)
    const hand: TileId[] = [0, 0, 0, 8, 9, 17, 18, 26, 27, 28, 3, 5, 21];
    expect(chooseRoute(shape(hand), RULES).route.id).toBe("orphans");
    const ranked = rankDiscards(makeView({ hand }), cfg());
    const pos = (t: TileId): number => ranked.findIndex((r) => r.tile === t);
    // Junk first, then the surplus third 1萬, and the bare kinds last.
    expect([3, 5, 21]).toContain(ranked[0]!.tile);
    expect(pos(0)).toBeLessThan(pos(8));
    expect(pos(0)).toBeLessThan(pos(28));
  });
});

/* ── concealment: claims and kongs ─────────────────────────────────────── */

describe("claims while hunting 十三么", () => {
  it("refuses a pung of its own pair tile — the route dies with any meld", () => {
    const v = makeView({ hand: EIGHT_KIND_JUNK, lastDiscard: { tile: 27, from: 2 } });
    expect(chooseRoute(shapeOf(v), RULES).route.id).toBe("orphans");
    const a = assessClaim(v, { kind: "pung" }, cfg());
    expect(a.reason).toBe("concealedRoute");
    expect(claimDecision(v, [{ kind: "pung" }], cfg())).toBeNull();
  });

  it("refuses a chow the same way", () => {
    const v = makeView({ hand: EIGHT_KIND_JUNK, lastDiscard: { tile: 4, from: 3 } });
    const a = assessClaim(v, { kind: "chow", with: [3, 5] }, cfg());
    expect(a.reason).toBe("concealedRoute");
  });

  it("refuses its own concealed kong — a 暗槓 still opens a meld slot", () => {
    // Nine kinds and the fourth 1萬 just drawn: 1萬 is `onRoute` for the
    // orphans plan, so without the route check the kong would be waved in.
    const v = makeView({ hand: [0, 0, 0, 8, 9, 17, 18, 26, 27, 28, 31, 3, 5], drawn: 0 });
    expect(chooseRoute(shapeOf(v), RULES).route.id).toBe("orphans");
    expect(shouldKong(v, 0, "concealed", cfg())).toBe(false);
  });

  it("takes the winning claim — the one exception to the meld ban", () => {
    // Twelve kinds with 1萬 paired, waiting on 白.
    const hand: TileId[] = [0, 0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32];
    const v = makeView({ hand, lastDiscard: { tile: 33, from: 1 } });
    const legal: Action[] = [
      { type: "claim", seat: 0, option: { kind: "win" } },
      { type: "pass", seat: 0 },
    ];
    const a = decideAction(v, legal, cfg());
    expect(a.type).toBe("claim");
    expect((a as Extract<Action, { type: "claim" }>).option.kind).toBe("win");
  });
});

/* ── the reducer can offer the win at all ──────────────────────────────── */

describe("winning shape", () => {
  it("hasWinningShape recognises 十三么 — decomposeWin alone never could", () => {
    const waiting: TileId[] = [0, 0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32];
    expect(hasWinningShape(waiting, [], 33)).toBe(true);
    // The thirteen-sided wait completes on ANY 么九 kind…
    const thirteenWait: TileId[] = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
    expect(hasWinningShape(thirteenWait, [], 27)).toBe(true);
    // …and on nothing else.
    expect(hasWinningShape(thirteenWait, [], 22)).toBe(false);
    expect(isThirteenOrphansShape(waiting, [], 33)).toBe(true);
    expect(isThirteenOrphansShape(waiting, [], 31)).toBe(false); // 中中中 is not a pair
  });
});

/* ── end-to-end: the reducer offers the win and the scorer pays it ─────── */

describe("end-to-end completion against the reducer", () => {
  it("offers the win claim on the wait, and the booked score awards 十三么", () => {
    // Completions are too rare to demand from a seeded sim, so the pipeline is
    // proven directly: plant the wait (tests own their state, as reducer.test
    // does), cut the winning tile, and watch offer → claim → award.
    const started = startMatch({
      matchId: "orphans-e2e",
      seed: 4242,
      rulesetId: RULES.id,
      matchLength: "oneWindRound",
      startedAt: 0,
    });
    let s: MatchState = started.state;
    const dealer = s.dealer;
    const waiter = ((dealer + 1) % 4) as SeatIndex;
    // Twelve kinds with 1萬 paired, waiting on 白.
    const w = s.seats[waiter]!;
    w.hand = [0, 0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32];
    w.melds = [];
    w.flowers = [];
    // Hand the dealer the 白 and have them cut it.
    s.seats[dealer]!.drawn = 33;
    const log: GameEvent[] = [];
    const step = (a: { state: MatchState; events: GameEvent[] }): void => {
      s = a.state;
      log.push(...a.events);
    };
    step(applyAction(s, { type: "discard", seat: dealer, tile: 33 }));
    // The window must offer the waiter the win — decomposeWin has no reading
    // for 十三么, so this is `hasWinningShape`'s direct shape test at work.
    const offered = legalActions(s, waiter);
    expect(offered.some((o) => o.type === "claim" && o.option.kind === "win")).toBe(true);
    // Every prompted seat answers through the shipping policy; the waiter's
    // own bot takes the win itself.
    for (let guard = 0; guard < 8 && s.phase === "claimWindow"; guard++) {
      let acted = false;
      for (const seat of SEATS) {
        const options = legalActions(s, seat);
        if (options.length === 0) continue;
        step(applyAction(s, decideAction(viewFor(s, seat), options, cfg(seat + 99))));
        acted = true;
        break;
      }
      if (!acted) break;
    }
    const win = log.find(
      (e): e is Extract<GameEvent, { type: "winOnDiscard" }> => e.type === "winOnDiscard",
    );
    expect(win).toBeDefined();
    expect(win!.payload.context.seat).toBe(waiter);
    expect(win!.payload.score.awards.some((a) => a.id === "thirteenOrphans")).toBe(true);
    expect(win!.payload.score.faan).toBe(RULES.limitFaan);
    expect(win!.payload.score.legal).toBe(true);
  });
});

/* ── bailing: the pivot is scoring, re-run every turn ──────────────────── */

describe("bailing out", () => {
  it("a stalled hunt full of 么九 pairs pivots into 對對糊 — the owner's bail path", () => {
    // Started orphan-rich, then the draws brought duplicates, not new kinds:
    // six pairs (terminals and both dragons) and a lone 1筒. Still 7 kinds —
    // past the gate, and the route was live on this hand's earlier shape —
    // but the same tiles now read as an all-pungs hand three sets from ready.
    const stalled: TileId[] = [0, 0, 8, 8, 9, 9, 17, 17, 31, 31, 32, 32, 18];
    const all = assessRoutes(shape(stalled), RULES);
    const orphans = all.find((a) => a.route.orphans)!;
    expect(orphans.feasible).toBe(true); // the gate did NOT do this
    const chosen = chooseRoute(shape(stalled), RULES);
    // Claim-supply credit (2026-08-27) re-ranks WITHIN the pung family, so pin
    // the family, not one member: the bail path is "some pung road", exactly
    // as the owner described it.
    expect(chosen.route.pungs || chosen.route.honoursOnly).toBe(true);
    expect(orphans.score).toBeLessThan(chosen.score);
  });

  it("the same tiles one stage earlier still favour the hunt — decay, not a cliff", () => {
    // 8 kinds, one pair, fragments: orphans wins here (first test above), and
    // loses on the stalled shape — chooseRoute runs every turn, so that IS the
    // bail: no dedicated rule, just the score crossing over.
    const early = chooseRoute(shape(EIGHT_KIND_JUNK), RULES);
    expect(early.route.id).toBe("orphans");
  });
});

/* ── the seeded simulation, on the real reducer ────────────────────────── */

/** Copied from bots.test.ts (importing it would re-register its suites). */
function viewFor(state: MatchState, seat: SeatIndex): SeatView {
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

interface OrphansSim {
  hands: number;
  draws: number;
  wins: number;
  /** Hand-seat pairs that steered 十三么 on at least one of their turns. */
  orphanRouteHandSeats: number;
  /** Wins whose awards include thirteenOrphans — completions of the route. */
  orphanWins: number;
}

function runOrphansSim(matches: number, baseSeed: number): OrphansSim {
  let hands = 0;
  let draws = 0;
  let wins = 0;
  let orphanWins = 0;
  const orphanKeys = new Set<string>();

  for (let m = 0; m < matches; m++) {
    const seed = baseSeed + m;
    const configs: BotConfig[] = SEATS.map((s) => ({
      ruleset: RULES,
      rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
    }));
    const consume = (events: readonly GameEvent[]): void => {
      for (const e of events) {
        if (e.type === "handEnd") {
          hands++;
          if (e.payload.outcome === "exhaustiveDraw") draws++;
          else wins++;
        }
        if (
          (e.type === "winOnDiscard" || e.type === "selfDraw") &&
          e.payload.score.awards.some((a) => a.id === "thirteenOrphans")
        ) {
          orphanWins++;
        }
      }
    };

    const started = startMatch({
      matchId: `orphans-sim-${m}`,
      seed,
      rulesetId: RULES.id,
      dealer: (m % 4) as SeatIndex,
      matchLength: "oneWindRound",
      startedAt: 0,
    });
    let state = started.state;
    consume(started.events);

    let terminated = false;
    for (let guard = 0; guard < 200_000; guard++) {
      if (state.phase === "matchEnd") {
        terminated = true;
        break;
      }
      if (state.phase === "handEnd") {
        const applied = startNextHand(state);
        state = applied.state;
        consume(applied.events);
        continue;
      }
      let acted = false;
      for (const seat of SEATS) {
        const options = legalActions(state, seat);
        if (options.length === 0) continue;
        const view = viewFor(state, seat);
        // Instrumentation only: chooseRoute is pure and consumes no rnd, so
        // the match stays byte-deterministic with or without this probe. The
        // kind pre-count skips the route search on the ~90% of turns the hard
        // gate would refuse anyway.
        if (view.drawn !== null) {
          const seen = new Set<TileId>();
          for (const t of view.hand) if (isTerminalOrHonour(t)) seen.add(t);
          if (isTerminalOrHonour(view.drawn)) seen.add(view.drawn);
          if (seen.size >= 6 && chooseRoute(shapeOf(view), RULES).route.orphans) {
            orphanKeys.add(`${m}:${state.handsPlayed}:${seat}`);
          }
        }
        const action = decideAction(view, options, configs[seat]!);
        expect(options).toContain(action); // never an invented move (§6)
        const applied = applyAction(state, action);
        state = applied.state;
        consume(applied.events);
        acted = true;
        break;
      }
      if (!acted) throw new Error(`no seat can act in phase "${state.phase}"`);
    }
    if (!terminated) throw new Error(`match ${m} did not terminate`);
  }
  return { hands, draws, wins, orphanWins, orphanRouteHandSeats: orphanKeys.size };
}

const SIM_MATCHES = 45;
const SIM_SEED = 1313;

describe("seeded simulation — the route in live play", () => {
  // In a beforeAll rather than the describe body so a filtered run of the
  // cheap tests above does not pay for ~250 hands of self-play at collection.
  let sim: OrphansSim;
  beforeAll(() => {
    sim = runOrphansSim(SIM_MATCHES, SIM_SEED);
  }, 600_000);

  it("plays 200+ hands against the real reducer without a crash", () => {
    // eslint-disable-next-line no-console
    console.log(
      [
        `orphans sim: ${SIM_MATCHES} matches / ${sim.hands} hands`,
        `draw rate            ${((sim.draws / sim.hands) * 100).toFixed(1)}%`,
        `hand-seats on 十三么  ${sim.orphanRouteHandSeats}`,
        `十三么 completions    ${sim.orphanWins}`,
      ].join("\n"),
    );
    expect(sim.hands).toBeGreaterThanOrEqual(200);
    expect(sim.wins + sim.draws).toBe(sim.hands);
  });

  it("the route sees real table time on desperation deals", () => {
    // ~2% of deals hold 7+ orphan kinds, and mid-hand adoption adds more, so
    // across 200+ hands x 4 seats the route must actually get picked.
    expect(sim.orphanRouteHandSeats).toBeGreaterThan(0);
  });

  it("completions are counted, logged, and never negative — not thresholded", () => {
    // A completed hunt is rare by nature (the owner's own open question in
    // STRATEGY.md §7 is exactly how often it completes). The award id is the
    // proof the pipeline can pay it; the log above reports how often it did.
    expect(sim.orphanWins).toBeGreaterThanOrEqual(0);
  });
});

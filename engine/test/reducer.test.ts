/**
 * The match state machine, path by path — DESIGN.md §5.2.
 *
 * Fixtures are planted directly onto a dealt MatchState rather than fished out
 * of a seed. A claim contest needs three specific hands facing one specific
 * discard, and searching seeds for that is both slow and silently fragile: a
 * change to the deal order would move which seed produces which contest and the
 * test would still pass while testing something else. Planted hands are checked
 * for tile-copy plausibility by hand and noted where they strain it.
 *
 * Terminology: ../../TERMINOLOGY.md. HK Old Style only.
 */
import { describe, expect, it } from "vitest";
import type { GameEvent } from "@mjrc/protocol";
import {
  CLAIM_WINDOW_MS,
  applyAction,
  handSeedFor,
  legalActions,
  replayMatch,
  startMatch,
  startNextHand,
  type Applied,
  type MatchConfig,
  type MatchState,
} from "../src/reducer.js";
import { makeChow, makePung } from "../src/melds.js";
import { isFlower } from "../src/tiles.js";
import { prng } from "../src/wall.js";
import type { Action, Meld, SeatIndex, TileId } from "../src/types.js";

/* ── fixtures ──────────────────────────────────────────────────────────── */

/* Tile ids: 1萬=0..9萬=8, 1索=9..9索=17, 1筒=18..9筒=26, 東=27..北=30,
   中=31 發=32 白=33, 花 34-41. */
const B = (n: number): TileId => 8 + n; // n索
const C = (n: number): TileId => n - 1; // n萬
const D = (n: number): TileId => 17 + n; // n筒
const EAST = 27;
const RED = 31;

/**
 * 清一色 in 索, thirteen tiles, waiting on 9索: 1索碰 · 2-3-4索 · 6-7-8索 ·
 * 5索眼 · two 9索. Six faan for the flush before the situational faan, so it
 * clears the 3-faan floor by a margin on every path — and deliberately is NOT
 * 九蓮寶燈, which would peg every settlement in this file at the limit.
 */
const FLUSH_ON_9B: TileId[] = [B(1), B(1), B(1), B(2), B(3), B(4), B(5), B(5), B(6), B(7), B(8), B(9), B(9)];

/** Thirteen scattered singletons: wins nothing, claims nothing, ever. */
const JUNK: TileId[] = [EAST, 28, 29, 30, RED, 32, 33, C(1), C(4), C(7), D(1), D(4), D(7)];

/** A second junk hand, disjoint from JUNK, for tables that need two. */
const JUNK2: TileId[] = [C(2), C(5), C(8), D(2), D(5), D(8), B(2), B(5), 28, 29, 30, 32, 33];

/* ── harness ───────────────────────────────────────────────────────────── */

const cfg = (over: Partial<MatchConfig> = {}): MatchConfig => ({
  matchId: "test-match",
  seed: 12345,
  ...over,
});

/** Plant a hand. Tests own their state; the reducer never mutates its input. */
function plant(
  s: MatchState,
  seat: SeatIndex,
  hand: TileId[],
  opts: { melds?: Meld[]; flowers?: TileId[]; drawn?: TileId | null } = {},
): void {
  const st = s.seats[seat];
  st.hand = [...hand].sort((a, b) => a - b);
  st.melds = opts.melds ?? [];
  st.flowers = opts.flowers ?? [];
  if (opts.drawn !== undefined) st.drawn = opts.drawn;
}

const types = (events: readonly GameEvent[]): string[] => events.map((e) => e.type);
const ofType = <T extends GameEvent["type"]>(events: readonly GameEvent[], t: T) =>
  events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === t);

/** Play the seeded pseudo-bot until `stop` says otherwise. Fully deterministic. */
function playOut(
  config: MatchConfig,
  stop: (s: MatchState) => boolean,
  policy: "random" | "discardOnly" = "random",
): { state: MatchState; log: GameEvent[] } {
  let { state, events } = startMatch(config);
  const log: GameEvent[] = [...events];
  const rnd = prng(config.seed ^ 0x5f3759df);
  let guard = 0;

  const step = (a: Applied): void => {
    state = a.state;
    log.push(...a.events);
  };

  while (!stop(state) && state.phase !== "matchEnd" && guard++ < 100000) {
    if (state.phase === "handEnd") {
      step(startNextHand(state));
      continue;
    }
    let acted = false;
    for (let seat = 0 as SeatIndex; seat < 4; seat = (seat + 1) as SeatIndex) {
      const options = legalActions(state, seat);
      if (options.length === 0) continue;
      let choice: Action;
      if (policy === "discardOnly") {
        choice =
          options.find((o) => o.type === "pass") ??
          options.find((o) => o.type === "discard") ??
          options[0];
      } else {
        const win = options.find(
          (o) => o.type === "declareWin" || (o.type === "claim" && o.option.kind === "win"),
        );
        choice = win ?? options[Math.floor(rnd() * options.length)];
      }
      step(applyAction(state, choice));
      acted = true;
      break;
    }
    if (!acted) throw new Error(`no seat can act in phase "${state.phase}"`);
  }
  return { state, log };
}

/* ── DEAL and 花 replacement ───────────────────────────────────────────── */

describe("deal and flower replacement 花", () => {
  it("rests at AWAIT_DISCARD(dealer) with a drawn tile and no flower in any hand", () => {
    const { state, events } = startMatch(cfg());
    expect(state.phase).toBe("awaitDiscard");
    expect(state.turn).toBe(state.dealer);
    expect(state.seats[state.dealer].drawn).not.toBeNull();
    expect(types(events)[0]).toBe("deal");
    for (const st of state.seats) {
      expect(st.hand.length).toBe(13);
      expect(st.hand.some(isFlower)).toBe(false);
      expect(st.flowers.every(isFlower)).toBe(true);
    }
    expect(isFlower(state.seats[state.dealer].drawn as TileId)).toBe(false);
  });

  it("is byte-identical on the same seed and different on another", () => {
    const a = startMatch(cfg({ seed: 777 }));
    const b = startMatch(cfg({ seed: 777 }));
    expect(b.state).toEqual(a.state);
    expect(b.events).toEqual(a.events);
    const c = startMatch(cfg({ seed: 778 }));
    expect(c.state.seats[0].hand).not.toEqual(a.state.seats[0].hand);
  });

  it("replaces in strict seat order from the dealer, and recursively", () => {
    // Seat order is the ONLY thing that makes the wall consumption reproducible
    // (§5.2), so it is asserted across a spread of seeds rather than one.
    let sawRecursion = false;
    for (let seed = 1; seed <= 60; seed++) {
      for (const dealer of [0, 2] as SeatIndex[]) {
        const { state, events } = startMatch(cfg({ seed, dealer }));
        const order = [0, 1, 2, 3].map((n) => ((dealer + n) % 4) as SeatIndex);
        // Replacements for the dealt hands come before the dealer's own draw.
        const drawAt = types(events).indexOf("draw");
        const dealt = ofType(events.slice(0, drawAt), "flowerReplacement");
        let cursor = 0;
        for (const e of dealt) {
          const at = order.indexOf(e.payload.seat);
          expect(at).toBeGreaterThanOrEqual(cursor);
          cursor = at;
        }
        // A replacement that is itself a flower is replaced in turn, and the
        // recursion shows in the log rather than being collapsed into one event.
        for (let i = 1; i < dealt.length; i++) {
          if (dealt[i - 1].payload.replacement === dealt[i].payload.flower) sawRecursion = true;
        }
        // The wall paid for exactly one tile per replacement, off the tail.
        const replacements = ofType(events, "flowerReplacement").length;
        const kongDraws = 0;
        expect(state.wallEnd).toBe(144 - replacements - kongDraws);
        const flowersHeld = state.seats.reduce((n, s) => n + s.flowers.length, 0);
        expect(flowersHeld).toBe(replacements);
      }
    }
    expect(sawRecursion).toBe(true);
  });

  it("derives every wall from the match seed alone", () => {
    const { state } = startMatch(cfg({ seed: 42 }));
    expect(state.handSeed).toBe(handSeedFor(42, 0));
  });
});

/* ── claim priority ────────────────────────────────────────────────────── */

/** Dealer 0 holds 4索 as its drawn tile and cuts it. */
function contestOn4B(plantSeats: (s: MatchState) => void): { state: MatchState; log: GameEvent[] } {
  const { state } = startMatch(cfg());
  plantSeats(state);
  plant(state, 0, JUNK, { drawn: B(4) });
  const r = applyAction(state, { type: "discard", seat: 0, tile: B(4) });
  return { state: r.state, log: [...r.events] };
}

describe("CLAIM_WINDOW priority", () => {
  it("prompts only seats holding a legal claim, per seat, with a fixed deadline", () => {
    // seat 1 上 (it is 上家 to nobody else), seat 2 碰, seat 3 食糊.
    const { state, log } = contestOn4B((s) => {
      plant(s, 1, [B(2), B(3), EAST, EAST, 28, 28, 29, 29, 30, 30, RED, RED, 33]);
      plant(s, 2, [B(4), B(4), C(1), C(1), C(3), C(3), C(5), C(5), C(7), C(7), C(9), C(9), D(3)]);
      plant(s, 3, [B(1), B(1), B(1), B(2), B(3), B(5), B(6), B(7), B(8), B(8), B(9), B(9), B(9)]);
    });
    expect(state.phase).toBe("claimWindow");
    const offers = ofType(log, "claimOffered");
    // Clockwise from the discarder — which is also the tie-break order (§5.2).
    expect(offers.map((e) => e.payload.seat)).toEqual([1, 2, 3]);
    expect(offers[0].payload.options.map((o) => o.kind)).toEqual(["chow"]);
    expect(offers[1].payload.options.map((o) => o.kind)).toEqual(["pung"]);
    expect(offers[2].payload.options.map((o) => o.kind)).toEqual(["win"]);
    // One deadline for the whole window, fixed at the moment the discard
    // landed: the window runs its minimum however fast the answers come, so a
    // fast answer never says "this seat was holding something" (§5.2).
    const cut = log[0];
    for (const e of offers) expect(e.payload.deadlineTs).toBe(cut.ts + CLAIM_WINDOW_MS);
  });

  it("resolves 食糊 over 碰 over 上, and logs the losers as outranked", () => {
    let { state } = contestOn4B((s) => {
      plant(s, 1, [B(2), B(3), EAST, EAST, 28, 28, 29, 29, 30, 30, RED, RED, 33]);
      plant(s, 2, [B(4), B(4), C(1), C(1), C(3), C(3), C(5), C(5), C(7), C(7), C(9), C(9), D(3)]);
      plant(s, 3, [B(1), B(1), B(1), B(2), B(3), B(5), B(6), B(7), B(8), B(8), B(9), B(9), B(9)]);
    });
    const log: GameEvent[] = [];
    const lodged: string[] = [];
    for (const seat of [1, 2, 3] as SeatIndex[]) {
      const option = legalActions(state, seat).find((a) => a.type === "claim") as Extract<
        Action,
        { type: "claim" }
      >;
      expect(option).toBeDefined();
      lodged.push(option.option.kind);
      const r = applyAction(state, option);
      state = r.state;
      log.push(...r.events);
    }
    expect(lodged).toEqual(["chow", "pung", "win"]);
    const won = ofType(log, "winOnDiscard");
    expect(won).toHaveLength(1);
    expect(won[0].payload.context.seat).toBe(3);
    expect(won[0].payload.context.from).toBe(0);
    expect(won[0].payload.context.selfDraw).toBe(false);
    const declined = ofType(log, "claimDeclined");
    expect(declined.map((e) => [e.payload.seat, e.payload.reason])).toEqual([
      [1, "outranked"],
      [2, "outranked"],
    ]);
    expect(state.phase).toBe("handEnd");
  });

  it("gives 碰 the tile when the winner passes, and the turn jumps with NO draw", () => {
    let { state } = contestOn4B((s) => {
      plant(s, 1, [B(2), B(3), EAST, EAST, 28, 28, 29, 29, 30, 30, RED, RED, 33]);
      plant(s, 2, [B(4), B(4), C(1), C(1), C(3), C(3), C(5), C(5), C(7), C(7), C(9), C(9), D(3)]);
      plant(s, 3, [B(1), B(1), B(1), B(2), B(3), B(5), B(6), B(7), B(8), B(8), B(9), B(9), B(9)]);
    });
    const wallBefore = { head: state.wallIndex, tail: state.wallEnd };
    const log: GameEvent[] = [];
    const answer = (a: Action) => {
      const r = applyAction(state, a);
      state = r.state;
      log.push(...r.events);
    };
    answer({ type: "claim", seat: 1, option: { kind: "chow", with: [B(2), B(3)] } });
    answer({ type: "claim", seat: 2, option: { kind: "pung" } });
    answer({ type: "pass", seat: 3 });

    const claimed = ofType(log, "claimed");
    expect(claimed).toHaveLength(1);
    expect(claimed[0].payload.seat).toBe(2);
    expect(claimed[0].payload.kind).toBe("pung");
    // 碰 and 上 take the turn without a draw (§5.2): the claimed tile is the 14th.
    expect(types(log)).not.toContain("draw");
    expect(types(log)).not.toContain("kongReplacement");
    expect(state.wallIndex).toBe(wallBefore.head);
    expect(state.wallEnd).toBe(wallBefore.tail);
    expect(state.turn).toBe(2);
    expect(state.phase).toBe("awaitDiscard");
    expect(state.seats[2].drawn).toBeNull();
    expect(state.seats[2].hand.length + 3 * state.seats[2].melds.length).toBe(14);
    // The claimed tile left the discarder's pile — it is on the table now.
    expect(state.seats[0].discards).not.toContain(B(4));
    expect(state.lastDiscard).toBeNull();
  });

  it("breaks a two-way 食糊 tie to the nearest seat clockwise from the discarder", () => {
    let { state } = contestOn4B((s) => {
      // seat 1 waits on 4索 with a 索 flush; seat 3 waits on it with 對對糊.
      plant(s, 1, [B(1), B(1), B(2), B(3), B(4), B(5), B(5), B(6), B(6), B(7), B(7), B(8), B(9)]);
      plant(s, 3, [B(4), B(4), C(1), C(1), C(1), EAST, EAST, EAST, RED, RED, RED, D(3), D(3)]);
      plant(s, 2, JUNK2);
    });
    // Both really hold a win on this tile — otherwise the tie-break below
    // would be asserting nothing. Each seat's options come back in
    // CLAIM_PRIORITY order, so 食糊 leads both lists.
    for (const seat of [1, 3] as SeatIndex[]) {
      const kinds = legalActions(state, seat)
        .filter((a) => a.type === "claim")
        .map((a) => (a as Extract<Action, { type: "claim" }>).option.kind);
      expect(kinds[0]).toBe("win");
    }
    const log: GameEvent[] = [];
    for (const seat of [1, 3] as SeatIndex[]) {
      const r = applyAction(state, { type: "claim", seat, option: { kind: "win" } });
      state = r.state;
      log.push(...r.events);
    }
    const won = ofType(log, "winOnDiscard");
    expect(won).toHaveLength(1);
    expect(won[0].payload.context.seat).toBe(1);
    expect(ofType(log, "claimDeclined").map((e) => e.payload.seat)).toEqual([3]);
  });

  it("passes the turn on when every prompted seat declines", () => {
    let { state } = contestOn4B((s) => {
      plant(s, 1, [B(2), B(3), EAST, EAST, 28, 28, 29, 29, 30, 30, RED, RED, 33]);
      plant(s, 2, JUNK2);
      plant(s, 3, JUNK2);
    });
    const r = applyAction(state, { type: "pass", seat: 1 });
    state = r.state;
    expect(ofType(r.events, "claimDeclined")[0].payload.reason).toBe("pass");
    expect(types(r.events)).toContain("draw");
    expect(state.turn).toBe(1);
    expect(state.seats[1].drawn).not.toBeNull();
    expect(state.phase).toBe("awaitDiscard");
  });
});

/* ── 槓 — all three forms ──────────────────────────────────────────────── */

describe("槓 in all three forms", () => {
  it("暗槓 concealed: declared on your own turn, replaced from the tail, turn unchanged", () => {
    const { state } = startMatch(cfg());
    plant(state, 0, [C(1), C(1), C(1), C(1), B(1), B(2), B(3), B(5), B(6), B(7), D(1), D(2), D(3)], {
      drawn: EAST,
    });
    const tail = state.wallEnd;
    const r = applyAction(state, { type: "concealedKong", seat: 0, tile: C(1) });

    expect(types(r.events)).toEqual(["concealedKong", "kongReplacement"]);
    const meld = r.state.seats[0].melds[0];
    expect(meld.kind).toBe("kong");
    expect(meld.concealed).toBe(true);
    expect(meld.from).toBe(0);
    expect(meld.addedToPung).toBeUndefined();
    expect(ofType(r.events, "kongReplacement")[0].payload.kongKind).toBe("concealed");
    expect(r.state.wallEnd).toBe(tail - 1);
    expect(r.state.turn).toBe(0);
    expect(r.state.phase).toBe("awaitDiscard");
    expect(r.state.seats[0].drawn).not.toBeNull();
    expect(r.state.onKongReplacement).toBe(true);
    // 暗槓 is laid down complete and opens no 搶槓 window in HK Old Style.
    expect(types(r.events)).not.toContain("robKongWindow");
  });

  it("明槓 exposed: claimed off a discard, then replaced from the tail", () => {
    let { state } = contestOn4B((s) => {
      plant(s, 2, [B(4), B(4), B(4), C(1), C(1), C(3), C(3), C(5), C(5), C(7), C(7), C(9), D(3)]);
      plant(s, 1, JUNK2);
      plant(s, 3, JUNK2);
    });
    expect(legalActions(state, 2).map((a) => (a.type === "claim" ? a.option.kind : a.type))).toEqual(
      ["kong", "pung", "pass"],
    );
    const tail = state.wallEnd;
    const r = applyAction(state, { type: "claim", seat: 2, option: { kind: "kong" } });
    state = r.state;

    const meld = state.seats[2].melds[0];
    expect(meld.kind).toBe("kong");
    expect(meld.concealed).toBe(false);
    expect(meld.from).toBe(0);
    expect(ofType(r.events, "kongReplacement")[0].payload.kongKind).toBe("exposed");
    expect(state.wallEnd).toBe(tail - 1);
    expect(state.turn).toBe(2);
    expect(state.seats[2].drawn).not.toBeNull();
  });

  it("加槓 added: grows an exposed 碰, opens a 搶槓 window, and stands when nobody robs", () => {
    const { state } = startMatch(cfg());
    plant(state, 0, [C(1), B(1), B(2), B(3), B(5), B(6), B(7), D(1), D(2), D(3)], {
      melds: [makePung(C(1), 0, 1)],
      drawn: EAST,
    });
    plant(state, 1, JUNK2);
    plant(state, 2, JUNK2);
    plant(state, 3, JUNK);
    const tail = state.wallEnd;
    const r = applyAction(state, { type: "addedKong", seat: 0, tile: C(1) });

    expect(types(r.events)).toEqual(["addedKong", "kongReplacement"]);
    const meld = r.state.seats[0].melds[0];
    expect(meld.kind).toBe("kong");
    expect(meld.addedToPung).toBe(true);
    expect(meld.concealed).toBe(false);
    // `from` is carried over from the 碰 it grew from.
    expect(meld.from).toBe(1);
    expect(ofType(r.events, "kongReplacement")[0].payload.kongKind).toBe("added");
    expect(r.state.wallEnd).toBe(tail - 1);
    expect(r.state.turn).toBe(0);
  });
});

/* ── 搶槓 ──────────────────────────────────────────────────────────────── */

describe("搶槓 robbing the kong", () => {
  /** Seat 0 grows a 碰 of 1萬 into a 加槓; seat 2 is waiting on 1萬. */
  const setup = (): MatchState => {
    const { state } = startMatch(cfg());
    plant(state, 0, [C(1), B(1), B(2), B(3), B(5), B(6), B(7), D(1), D(2), D(3)], {
      melds: [makePung(C(1), 0, 1)],
      drawn: EAST,
    });
    // 清一色 in 萬 on an edge wait for 1萬 — and it holds no copy of 1萬, which
    // is what makes the fixture physical: seat 0 has all four.
    plant(state, 2, [C(2), C(3), C(4), C(5), C(6), C(4), C(5), C(6), C(7), C(8), C(9), C(9), C(9)]);
    plant(state, 1, JUNK2);
    plant(state, 3, JUNK);
    return state;
  };

  it("offers the fourth tile win-only, and only to seats that can take it", () => {
    const state = setup();
    const r = applyAction(state, { type: "addedKong", seat: 0, tile: C(1) });
    expect(r.state.phase).toBe("robKongWindow");
    const w = ofType(r.events, "robKongWindow");
    expect(w).toHaveLength(1);
    expect(w[0].payload.seat).toBe(0);
    expect(w[0].payload.tile).toBe(C(1));
    expect(w[0].payload.offeredTo).toEqual([2]);
    expect(legalActions(r.state, 2).map((a) => a.type)).toEqual(["claim", "pass"]);
    expect(legalActions(r.state, 1)).toEqual([]);
    // No replacement is drawn while the window is open.
    expect(types(r.events)).not.toContain("kongReplacement");
  });

  it("robbed: the win is flagged 搶槓 and the 加槓 reverts to the 碰 it grew from", () => {
    let state = setup();
    const log: GameEvent[] = [];
    let r = applyAction(state, { type: "addedKong", seat: 0, tile: C(1) });
    state = r.state;
    log.push(...r.events);
    r = applyAction(state, { type: "claim", seat: 2, option: { kind: "win" } });
    state = r.state;
    log.push(...r.events);

    const won = ofType(log, "winOnDiscard");
    expect(won).toHaveLength(1);
    expect(won[0].payload.context.seat).toBe(2);
    expect(won[0].payload.context.robbedKong).toBe(true);
    expect(won[0].payload.context.from).toBe(0);
    const meld = state.seats[0].melds[0];
    expect(meld.kind).toBe("pung");
    expect(meld.tiles).toEqual([C(1), C(1), C(1)]);
    expect(state.phase).toBe("handEnd");
    expect(state.result?.outcome).toBe("winOnDiscard");
    expect(state.result?.loser).toBe(0);
    expect(types(log)).not.toContain("kongReplacement");
  });

  it("declined: the 加槓 stands and the replacement is drawn", () => {
    let state = setup();
    const log: GameEvent[] = [];
    let r = applyAction(state, { type: "addedKong", seat: 0, tile: C(1) });
    state = r.state;
    log.push(...r.events);
    const tail = state.wallEnd;
    r = applyAction(state, { type: "pass", seat: 2 });
    state = r.state;
    log.push(...r.events);

    expect(ofType(log, "kongReplacement")[0].payload.kongKind).toBe("added");
    expect(state.seats[0].melds[0].kind).toBe("kong");
    expect(state.wallEnd).toBe(tail - 1);
    expect(state.turn).toBe(0);
    expect(state.phase).toBe("awaitDiscard");
  });
});

/* ── refused wins ──────────────────────────────────────────────────────── */

describe("a win under the minimum is refused VISIBLY", () => {
  it("on a 自摸 declaration: the event carries the whole breakdown and play continues", () => {
    const { state } = startMatch(cfg());
    // 1萬 碰 + three unrelated chows + a 6筒 pair. No flush, no honours, not
    // all chows, not all pungs: 自摸 1 + 門前清 1 = 2, under the 3-faan floor.
    // The single foreign 花 is there to switch 無花 off, which would otherwise
    // hand the hand exactly the third faan it must not have.
    plant(
      state,
      0,
      [C(1), C(1), C(1), C(4), C(5), B(2), B(3), B(4), D(2), D(3), D(4), D(6), D(6)],
      { flowers: [35], drawn: C(6) },
    );
    const r = applyAction(state, { type: "declareWin", seat: 0, selfDraw: true });

    const refused = ofType(r.events, "refusedWin");
    expect(refused).toHaveLength(1);
    expect(refused[0].payload.reason).toBe("belowMinimum");
    expect(refused[0].payload.minimumFaan).toBe(3);
    expect(refused[0].payload.score.legal).toBe(false);
    // 自摸 1 + 門前清 1, and nothing else in the hand pays. Two, not three.
    expect(refused[0].payload.score.faan).toBe(2);
    expect(refused[0].payload.score.awards.map((a) => a.id).sort()).toEqual([
      "concealedHand",
      "selfDraw",
    ]);
    expect(refused[0].payload.context.selfDraw).toBe(true);
    expect(refused[0].payload.concealed.length).toBe(13);
    // Not a rollback: no hand end, the seat still owes a discard.
    expect(types(r.events)).not.toContain("handEnd");
    expect(types(r.events)).not.toContain("selfDraw");
    expect(r.state.phase).toBe("awaitDiscard");
    expect(r.state.turn).toBe(0);
    expect(r.state.seats[0].drawn).toBe(C(6));
    expect(r.state.seats[0].chips).toBe(0);
    // Offered once, then not again on the same tile — the teaching moment is a
    // moment, not a loop a bot can spin in.
    expect(legalActions(r.state, 0).some((a) => a.type === "declareWin")).toBe(false);
    expect(legalActions(state, 0).some((a) => a.type === "declareWin")).toBe(true);
  });

  it("in a claim window: the refusal does not swallow another seat's 碰", () => {
    let { state } = contestOn4B((s) => {
      // Seat 3 can complete a bare 平糊 with an exposed 上 — one faan, refused.
      plant(s, 3, [C(4), C(5), C(6), C(7), C(8), C(9), B(2), B(3), D(6), D(6)], {
        melds: [makeChow([C(1), C(2), C(3)], 3, 2)],
        flowers: [35],
      });
      plant(s, 2, [B(4), B(4), C(1), C(1), C(3), C(3), C(5), C(5), C(7), C(7), C(9), C(9), D(3)]);
      plant(s, 1, JUNK2);
    });
    const log: GameEvent[] = [];
    for (const a of [
      { type: "claim", seat: 3, option: { kind: "win" } },
      { type: "claim", seat: 2, option: { kind: "pung" } },
    ] as Action[]) {
      const r = applyAction(state, a);
      state = r.state;
      log.push(...r.events);
    }
    expect(ofType(log, "refusedWin")).toHaveLength(1);
    expect(ofType(log, "refusedWin")[0].payload.context.seat).toBe(3);
    expect(ofType(log, "refusedWin")[0].payload.score.faan).toBe(1);
    expect(ofType(log, "refusedWin")[0].payload.score.legal).toBe(false);
    // 食糊 outranked the 碰 and was then refused, so the 碰 takes the tile.
    const claimed = ofType(log, "claimed");
    expect(claimed).toHaveLength(1);
    expect(claimed[0].payload.seat).toBe(2);
    expect(state.turn).toBe(2);
    expect(state.phase).toBe("awaitDiscard");
    // A refused winner is not ALSO logged as declined: refusedWin is the record.
    expect(ofType(log, "claimDeclined").map((e) => e.payload.seat)).not.toContain(3);
  });
});

/* ── HAND_END: settlement, 連莊 and the wind round ─────────────────────── */

/** Plant a 清一色 self-draw for the seat on turn and take it. */
function takeSelfDraw(state: MatchState, seat: SeatIndex): Applied {
  plant(state, seat, FLUSH_ON_9B, { drawn: B(9) });
  return applyAction(state, { type: "declareWin", seat, selfDraw: true });
}

/** Dealer cuts 9索; `winner` takes it. Everyone else holds unclaimable junk. */
function takeWinOnDiscard(state: MatchState, winner: SeatIndex): Applied {
  const dealer = state.dealer;
  plant(state, winner, FLUSH_ON_9B);
  for (let s = 0 as SeatIndex; s < 4; s = (s + 1) as SeatIndex) {
    if (s !== winner && s !== dealer) plant(state, s, JUNK2);
  }
  plant(state, dealer, JUNK, { drawn: B(9) });
  const cut = applyAction(state, { type: "discard", seat: dealer, tile: B(9) });
  const claim = applyAction(cut.state, { type: "claim", seat: winner, option: { kind: "win" } });
  return { state: claim.state, events: [...cut.events, ...claim.events] };
}

describe("HAND_END, settlement and 連莊", () => {
  it("settles a 自摸 three ways, sums to zero, and repeats the deal on a dealer win", () => {
    const { state } = startMatch(cfg());
    const r = takeSelfDraw(state, 0);
    const end = ofType(r.events, "handEnd")[0].payload;

    expect(ofType(r.events, "selfDraw")).toHaveLength(1);
    expect(end.outcome).toBe("selfDraw");
    expect(end.winner).toBe(0);
    expect(end.loser).toBeNull();
    expect(end.chipDeltas.reduce((a, b) => a + b, 0)).toBe(0);
    // hkos-standard settles 自摸 perPlayer: three losers pay the same figure.
    expect(end.chipDeltas[1]).toBe(end.chipDeltas[2]);
    expect(end.chipDeltas[2]).toBe(end.chipDeltas[3]);
    expect(end.chipDeltas[0]).toBe(-3 * end.chipDeltas[1]);
    expect(end.standings).toEqual(r.state.seats.map((s) => s.chips));
    // 連莊 — the dealer repeats on a dealer win (§4).
    expect(end.dealerRepeats).toBe(true);
    expect(end.nextDealer).toBe(0);
    expect(end.nextRoundWind).toBe(0);
    expect(r.state.phase).toBe("handEnd");
    expect(r.state.dealerStreak).toBe(1);
  });

  it("rotates the deal when a non-dealer wins, and the discarder pays alone 全銃", () => {
    const { state } = startMatch(cfg());
    const r = takeWinOnDiscard(state, 2);
    const end = ofType(r.events, "handEnd")[0].payload;

    expect(end.outcome).toBe("winOnDiscard");
    expect(end.winner).toBe(2);
    expect(end.loser).toBe(0);
    expect(end.chipDeltas[1]).toBe(0);
    expect(end.chipDeltas[3]).toBe(0);
    expect(end.chipDeltas[0]).toBe(-end.chipDeltas[2]);
    expect(end.dealerRepeats).toBe(false);
    expect(end.nextDealer).toBe(1);
    expect(r.state.dealerStreak).toBe(0);
  });

  it("advances the prevailing wind 圈 when the deal passes East's seat a full cycle", () => {
    let state = startMatch(cfg({ matchLength: "fourWindRounds" })).state;
    const seen: number[] = [];
    for (let hand = 0; hand < 4; hand++) {
      const dealer = state.dealer;
      seen.push(dealer);
      expect(state.roundWind).toBe(0);
      // Seat winds follow the deal: the dealer is always 東.
      expect(state.seats[dealer].wind).toBe(0);
      const winner = ((dealer + 1) % 4) as SeatIndex;
      const r = takeWinOnDiscard(state, winner);
      state = startNextHand(r.state).state;
    }
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(state.roundWind).toBe(1);
    expect(state.dealer).toBe(0);
    expect(state.roundsCompleted).toBe(1);
    expect(state.phase).toBe("awaitDiscard");
  });

  it("ends the match after one wind round 東圈, with placements by chips", () => {
    let state = startMatch(cfg()).state;
    for (let hand = 0; hand < 4; hand++) {
      const winner = ((state.dealer + 1) % 4) as SeatIndex;
      const r = takeWinOnDiscard(state, winner);
      state = r.state;
      if (hand < 3) state = startNextHand(state).state;
    }
    expect(state.matchOver).toBe(true);
    const done = startNextHand(state);
    expect(done.state.phase).toBe("matchEnd");
    const end = ofType(done.events, "matchEnd")[0].payload;
    expect(end.reason).toBe("windRoundComplete");
    expect(end.handsPlayed).toBe(4);
    expect(new Set(end.placements)).toEqual(new Set([1, 2, 3, 4]));
    expect(end.standings.reduce((a, b) => a + b, 0)).toBe(0);
    // Every seat won exactly one hand off the dealer, so the placement order is
    // decided by chips alone and the winner of the biggest hand places first.
    const best = end.standings.indexOf(Math.max(...end.standings));
    expect(end.placements[best]).toBe(1);
  });
});

/* ── 流局 ──────────────────────────────────────────────────────────────── */

describe("流局 exhaustive draw", () => {
  it("ends the hand with no winner, no chips moved, and the dealer repeating", () => {
    const { state, log } = playOut(cfg({ seed: 99 }), (s) => s.phase === "handEnd", "discardOnly");
    expect(state.phase).toBe("handEnd");
    const drawn = ofType(log, "exhaustiveDraw");
    expect(drawn).toHaveLength(1);
    expect(drawn[0].payload.wallRemaining).toBe(0);
    expect(drawn[0].payload.hands.every((h) => h.length >= 1)).toBe(true);
    expect(drawn[0].payload.distanceToReady).toHaveLength(4);

    const end = ofType(log, "handEnd")[0].payload;
    expect(end.outcome).toBe("exhaustiveDraw");
    expect(end.winner).toBeNull();
    expect(end.faan).toBeNull();
    expect(end.chipDeltas).toEqual([0, 0, 0, 0]);
    // 流局 repeats the deal, exactly like a dealer win (§4).
    expect(end.dealerRepeats).toBe(true);
    expect(end.nextDealer).toBe(state.dealer);
    expect(end.nextRoundWind).toBe(0);
    expect(state.wallEnd - state.wallIndex).toBe(0);
    // No tile is left held apart once the hand is over.
    expect(state.seats.every((s) => s.drawn === null)).toBe(true);
  });
});

/* ── legalActions ──────────────────────────────────────────────────────── */

describe("legalActions", () => {
  it("speaks only to the seat that may act", () => {
    const { state } = startMatch(cfg());
    expect(legalActions(state, 0).length).toBeGreaterThan(0);
    for (const seat of [1, 2, 3] as SeatIndex[]) expect(legalActions(state, seat)).toEqual([]);
    expect(legalActions(state, 0).every((a) => a.seat === 0)).toBe(true);
  });

  it("offers every distinct tile once, ascending, and nothing that is not held", () => {
    const { state } = startMatch(cfg());
    const st = state.seats[0];
    const held = [...st.hand, st.drawn as TileId];
    const discards = legalActions(state, 0)
      .filter((a) => a.type === "discard")
      .map((a) => (a as Extract<Action, { type: "discard" }>).tile);
    expect(discards).toEqual([...new Set(held)].sort((a, b) => a - b));
    for (const t of discards) expect(held).toContain(t);
  });

  it("rejects an action nobody was offered", () => {
    const { state } = startMatch(cfg());
    expect(() => applyAction(state, { type: "discard", seat: 1, tile: state.seats[1].hand[0] })).toThrow();
    expect(() => applyAction(state, { type: "pass", seat: 0 })).toThrow();
    expect(() => applyAction(state, { type: "declareWin", seat: 0, selfDraw: false })).toThrow();
    expect(() => applyAction(state, { type: "discard", seat: 0, tile: 41 })).toThrow();
  });

  it("never mutates the state it was given", () => {
    const { state } = startMatch(cfg());
    const before = JSON.stringify(state);
    applyAction(state, { type: "discard", seat: 0, tile: state.seats[0].drawn as TileId });
    expect(JSON.stringify(state)).toBe(before);
  });
});

/* ── the property: replay is re-execution (§5.5) ───────────────────────── */

describe("replay is re-execution", () => {
  const HANDS = 200;

  it(`folds ${HANDS} seeded hands back through the reducer to the identical state`, () => {
    const tally: Record<string, number> = {};
    for (let seed = 1; seed <= HANDS; seed++) {
      const config = cfg({ matchId: `m${seed}`, seed, dealer: (seed % 4) as SeatIndex });
      const { state, log } = playOut(config, (s) => s.handsPlayed >= 1);
      expect(state.phase).toBe("handEnd");

      const replayed = replayMatch(config, log);
      expect(replayed).toEqual(state);

      for (const e of log) tally[e.type] = (tally[e.type] ?? 0) + 1;
    }
    // The corpus is only worth folding if it exercised the machine. These
    // floors are what 200 hands of seeded pseudo-random play reliably produce;
    // a drop below them means the harness stopped reaching those paths, not
    // that the property got easier.
    expect(tally.deal).toBe(HANDS);
    expect(tally.handEnd).toBe(HANDS);
    expect(tally.claimOffered ?? 0).toBeGreaterThan(500);
    expect(tally.claimed ?? 0).toBeGreaterThan(200);
    expect(tally.flowerReplacement ?? 0).toBeGreaterThan(200);
    expect(tally.kongReplacement ?? 0).toBeGreaterThan(0);
    expect(tally.refusedWin ?? 0).toBeGreaterThan(0);
  });

  it("is bit-identical run to run — nothing here reads a clock or an RNG", () => {
    for (const seed of [3, 17, 250]) {
      const config = cfg({ matchId: `d${seed}`, seed });
      const a = playOut(config, (s) => s.handsPlayed >= 2);
      const b = playOut(config, (s) => s.handsPlayed >= 2);
      expect(b.state).toEqual(a.state);
      expect(b.log).toEqual(a.log);
      // The logical clock and the sequence advance together, one per event.
      expect(a.state.seq).toBe(a.log.length);
      expect(a.log.map((e) => e.seq)).toEqual(a.log.map((_, i) => i));
    }
  });

  it("carries the match id, hand index and pinned engine version on every record", () => {
    const config = cfg({ matchId: "pinned", seed: 5 });
    const { state, log } = playOut(config, (s) => s.handsPlayed >= 2);
    expect(state.engineVersion).toBe(startMatch(config).state.engineVersion);
    for (const e of log) {
      expect(e.matchId).toBe("pinned");
      expect(e.v).toBe(1);
      expect(e.handIndex).toBeGreaterThanOrEqual(0);
      expect(e.handIndex).toBeLessThan(2);
    }
  });
});

/**
 * The table Durable Object — DESIGN.md §5.3.
 *
 * The Cloudflare runtime is stubbed with plain objects: no wrangler, no
 * miniflare, no new dependency. Everything the DO touches (`storage`, sockets,
 * the alarm) is an interface in table.ts precisely so this file can drive it.
 *
 * What these tests are actually defending, in priority order:
 *   1. The redacted view. Another seat's concealed tiles must never appear in
 *      anything that reaches a socket — the anti-pattern this object exists to kill.
 *   2. The deadline multiplexer. A DO has ONE alarm; a claim window must not
 *      erase a disconnect grace, and one `alarm()` must fire every due entry.
 *   3. The outbox. Events survive a failing sink and are forgotten only once
 *      BOTH R2 and D1 have confirmed.
 *   4. Bots answer through `botPace` and never synchronously — a fast reply is
 *      a timing oracle for a held claim.
 */
import { describe, expect, it } from "vitest";
import type {
  Action,
  GameState,
  Phase,
  SeatIndex,
  SeatState,
  TileId,
  WindIndex,
} from "@mjrc/engine";
import type {
  FourSeats,
  GameEvent,
  LegalRequests,
  MatchEndPayload,
  MatchLogHeader,
  OmniscientMatchLog,
  OtherSeatView,
  SeatSnapshot,
  SeatVisible,
  ServerToSeat,
} from "@mjrc/protocol";
import * as engine from "../../engine/src/reducer.js";
import { DEFAULT_TABLE_CONFIG, TableCore, bindingArchive } from "../src/table.js";
import type {
  Applied,
  Archive,
  BotBrain,
  D1Like,
  D1PreparedLike,
  EventDraft,
  HandResultRow,
  MatchSpec,
  MatchSummaryRow,
  SeatSocket,
  TableConfig,
  TableCtx,
  TableEnv,
  TableRules,
  TableInit,
  TableStorage,
} from "../src/table.js";

/* ── stubbed runtime ───────────────────────────────────────────────────── */

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

class StubSocket implements SeatSocket {
  sent: ServerToSeat[] = [];
  attachment: unknown = null;
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    this.sent.push(JSON.parse(data) as ServerToSeat);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown): void {
    this.attachment = clone(value);
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  msgs<T extends ServerToSeat["type"]>(type: T): Extract<ServerToSeat, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerToSeat, { type: T }> => m.type === type);
  }
}

/** Values round-trip through JSON, so anything unserializable fails loudly here. */
class StubStorage implements TableStorage {
  map = new Map<string, string>();
  alarm: number | null = null;
  setAlarmCalls = 0;
  /** Every key ever handed to `put`, in call order — this is what Cloudflare
   *  bills as "rows written" (one row per key per `put`, regardless of
   *  whether the value actually changed). The row-budget instrumentation
   *  below (`describe("row-write budget")`) reduces this list to a count. */
  putKeyLog: string[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.map.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async put(entries: Record<string, unknown>): Promise<void> {
    for (const key of Object.keys(entries).sort()) {
      const value = entries[key];
      this.putKeyLog.push(key);
      if (value === undefined) this.map.delete(key);
      else this.map.set(key, JSON.stringify(value));
    }
  }
  async delete(keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) if (this.map.delete(key)) n += 1;
    return n;
  }
  async list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const key of [...this.map.keys()].sort()) {
      if (!key.startsWith(options.prefix)) continue;
      out.set(key, JSON.parse(this.map.get(key) as string) as T);
      if (options.limit && out.size >= options.limit) break;
    }
    return out;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(when: number): Promise<void> {
    this.setAlarmCalls += 1;
    this.alarm = when;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
  keysWithPrefix(prefix: string): string[] {
    return [...this.map.keys()].sort().filter((k) => k.startsWith(prefix));
  }
}

class StubCtx implements TableCtx {
  storage = new StubStorage();
  sockets: StubSocket[] = [];
  acceptWebSocket(ws: SeatSocket): void {
    this.sockets.push(ws as StubSocket);
  }
  getWebSockets(): SeatSocket[] {
    return this.sockets.filter((s) => !s.closed);
  }
}

/** `env.DB` for the lobby's fire-and-forget writes (item 6: `lobby_status`,
 *  `current_hand`, `match_players.connected`, and `/fill`'s
 *  `ensureBotPlayerRow`). Records every statement so a test can assert one
 *  landed, without parsing SQL — same doctrine as db.test.ts's fake D1. */
class StubD1 implements D1Like {
  ran: { sql: string; args: unknown[] }[] = [];
  fail = false;

  prepare(sql: string): D1PreparedLike {
    const self = this;
    let bound: unknown[] = [];
    const stmt: D1PreparedLike = {
      bind(...values: unknown[]) {
        bound = values;
        return stmt;
      },
      async run(): Promise<unknown> {
        if (self.fail) throw new Error("D1 unavailable");
        self.ran.push({ sql, args: bound });
        return { success: true };
      },
      // Unused by TableCore's own lobby writes (all fire-and-forget `run()`
      // calls) — present only so this class satisfies `D1PreparedLike`, which
      // `bindingArchive`'s ranked settlement (worker/src/table.ts
      // `settleRatedMatch`) also reads through. See `FakeRatingDB` below for
      // the fake that actually exercises those reads.
      async first<T>(): Promise<T | null> {
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: [] };
      },
    };
    return stmt;
  }
}

class StubArchive implements Archive {
  handLogs: { key: string; log: OmniscientMatchLog }[] = [];
  results: HandResultRow[] = [];
  finished: MatchSummaryRow[] = [];
  failLogTimes = 0;
  failResultTimes = 0;

  async putHandLog(key: string, log: OmniscientMatchLog): Promise<void> {
    if (this.failLogTimes > 0) {
      this.failLogTimes -= 1;
      throw new Error("R2 unavailable");
    }
    this.handLogs.push({ key, log: clone(log) });
  }
  async putHandResult(row: HandResultRow): Promise<void> {
    if (this.failResultTimes > 0) {
      this.failResultTimes -= 1;
      throw new Error("D1 unavailable");
    }
    this.results.push(clone(row));
  }
  async finishMatch(summary: MatchSummaryRow): Promise<void> {
    this.finished.push(clone(summary));
  }
}

/* ── a toy reducer ─────────────────────────────────────────────────────── *
 *
 * NOT a mahjong engine. It is the smallest thing that exercises every seam the
 * DO depends on: a deal, a discard that opens a claim window offered to two
 * seats, an answer protocol that resolves on the last answer, and a win that
 * ends the hand. Tile ids are chosen so no seat's concealed tiles can be
 * confused with a count, a chip total or a wind — that is what makes the
 * redaction assertion below airtight rather than suggestive.
 */

const HANDS: FourSeats<TileId[]> = [
  [0, 1, 2],
  [20, 21, 22],
  [23, 24, 25],
  [26, 27, 28],
];
/** Every tile that seats 1-3 hold concealed and seat 0 must never learn. */
const OTHERS_TILES = [20, 21, 22, 23, 24, 25, 26, 27, 28];
const DEALER_DRAWN = 30;

function mkSeat(seat: SeatIndex, hand: TileId[], chips: number): SeatState {
  return {
    seat,
    wind: seat as WindIndex,
    hand: hand.slice(),
    drawn: null,
    melds: [],
    flowers: [],
    discards: [],
    chips,
    connected: false,
  };
}

interface HandSetup {
  handIndex: number;
  dealer: SeatIndex;
  roundWind: WindIndex;
  chips: FourSeats<number>;
}

/** The stub's own wall seed. Deliberately its own formula: the DO must not care. */
const stubHandSeed = (matchSeed: number, handIndex: number): number =>
  (matchSeed + handIndex * 7919) >>> 0;

function mkState(phase: Phase, setup: HandSetup, hands: FourSeats<TileId[]>): GameState {
  return {
    phase,
    seats: [
      mkSeat(0, hands[0], setup.chips[0]),
      mkSeat(1, hands[1], setup.chips[1]),
      mkSeat(2, hands[2], setup.chips[2]),
      mkSeat(3, hands[3], setup.chips[3]),
    ],
    roundWind: setup.roundWind,
    dealer: setup.dealer,
    turn: setup.dealer,
    handIndex: setup.handIndex,
    wall: new Array<TileId>(144).fill(0),
    wallIndex: 44,
    lastDiscard: null,
    rulesetId: "hkos-standard",
    engineVersion: "engine-test-1",
  };
}

const illegal = (code: string, msg: string): Error =>
  Object.assign(new Error(msg), { code });

class StubRules {
  /** Every action the DO handed over, in order. The core assertion surface. */
  calls: Action[] = [];
  offered: SeatIndex[] = [];
  answers = new Map<SeatIndex, Action>();
  handsEnded = 0;
  matchOverAfterHands = 99;
  matchSeed = 0;

  startMatch(spec: MatchSpec): Applied {
    this.matchSeed = spec.seed;
    const chips = spec.startingChips ?? 0;
    return this.deal({
      handIndex: 0,
      dealer: spec.dealer ?? 0,
      roundWind: 0,
      chips: [chips, chips, chips, chips],
    });
  }

  /** Deals the next hand, or ends the match — exactly the reducer's contract. */
  startNextHand(state: GameState): Applied {
    if (this.handsEnded >= this.matchOverAfterHands) {
      const next = clone(state);
      next.phase = "matchEnd";
      const standings = [0, 1, 2, 3].map(
        (s) => state.seats[s as SeatIndex].chips,
      ) as FourSeats<number>;
      return {
        state: next,
        events: [
          {
            handIndex: state.handIndex,
            actor: "server",
            type: "matchEnd",
            payload: {
              reason: "windRoundComplete",
              standings,
              placements: [1, 2, 3, 4],
              handsPlayed: this.handsEnded,
            },
          },
        ],
      };
    }
    return this.deal({
      handIndex: state.handIndex + 1,
      dealer: ((state.dealer + 1) % 4) as SeatIndex,
      roundWind: state.roundWind,
      chips: [0, 1, 2, 3].map((s) => state.seats[s as SeatIndex].chips) as FourSeats<number>,
    });
  }

  private deal(setup: HandSetup): Applied {
    const hands = clone(HANDS);
    const state = mkState("awaitDiscard", setup, hands);
    state.seats[setup.dealer].drawn = DEALER_DRAWN;
    this.offered = [];
    this.answers.clear();
    const events: EventDraft[] = [
      {
        handIndex: setup.handIndex,
        actor: "server",
        type: "deal",
        payload: {
          seed: stubHandSeed(this.matchSeed, setup.handIndex),
          dealer: setup.dealer,
          roundWind: setup.roundWind,
          seatWinds: [0, 1, 2, 3],
          hands: clone(hands),
          wallIndex: 44,
          wallRemaining: 100,
        },
      },
    ];
    return { state, events };
  }

  applyAction(state: GameState, action: Action): Applied {
    this.calls.push(clone(action));
    const next = clone(state);
    const hi = state.handIndex;
    const events: EventDraft[] = [];

    if (action.type === "discard") {
      if (state.phase !== "awaitDiscard") throw illegal("windowClosed", "not awaiting a discard");
      if (state.turn !== action.seat) throw illegal("notYourTurn", "not your turn");
      const seat = next.seats[action.seat];
      if (seat.drawn === action.tile) {
        seat.drawn = null;
      } else {
        const at = seat.hand.indexOf(action.tile);
        if (at < 0) throw illegal("tileNotHeld", "tile not held");
        seat.hand.splice(at, 1);
        if (seat.drawn !== null) {
          seat.hand.push(seat.drawn);
          seat.drawn = null;
          seat.hand.sort((a, b) => a - b);
        }
      }
      seat.discards.push(action.tile);
      next.lastDiscard = { tile: action.tile, from: action.seat };
      next.phase = "claimWindow";
      events.push({
        handIndex: hi,
        actor: action.seat,
        type: "discard",
        payload: { seat: action.seat, tile: action.tile, drawAndCut: false },
      });
      this.offered = [((action.seat + 1) % 4) as SeatIndex, ((action.seat + 2) % 4) as SeatIndex];
      this.answers.clear();
      for (const s of this.offered) {
        events.push({
          handIndex: hi,
          actor: "server",
          type: "claimOffered",
          payload: {
            seat: s,
            tile: action.tile,
            from: action.seat,
            options: [{ kind: "pung" }],
            deadlineTs: 0,
          },
        });
      }
      return { state: next, events };
    }

    if (action.type === "pass" || action.type === "claim") {
      if (state.phase !== "claimWindow") throw illegal("windowClosed", "no window open");
      if (!this.offered.includes(action.seat)) throw illegal("notALegalMove", "not offered");
      this.answers.set(action.seat, clone(action));
      // Priority resolves only once EVERY offered seat has answered — the DO
      // guarantees that by holding answers to the deadline and submitting them
      // in seat order.
      if (this.answers.size < this.offered.length) return { state: next, events };

      const last = state.lastDiscard;
      if (!last) throw illegal("notALegalMove", "no discard to claim");
      const claimer = this.offered.find((s) => this.answers.get(s)?.type === "claim") ?? null;
      for (const s of this.offered) {
        if (s === claimer) continue;
        const answered = this.answers.get(s);
        events.push({
          handIndex: hi,
          actor: answered?.type === "pass" ? s : "server",
          type: "claimDeclined",
          payload: {
            seat: s,
            tile: last.tile,
            from: last.from,
            reason: answered?.type === "pass" ? "pass" : "outranked",
          },
        });
      }
      next.phase = "awaitDiscard";
      if (claimer !== null) {
        next.turn = claimer;
        const meld = { kind: "pung" as const, tiles: [last.tile, last.tile, last.tile], from: last.from, concealed: false };
        next.seats[claimer].melds.push(meld);
        events.push({
          handIndex: hi,
          actor: claimer,
          type: "claimed",
          payload: { seat: claimer, kind: "pung", tile: last.tile, from: last.from, meld },
        });
      } else {
        const drawer = ((last.from + 1) % 4) as SeatIndex;
        next.turn = drawer;
        next.wallIndex += 1;
        next.seats[drawer].drawn = 31;
        events.push({
          handIndex: hi,
          actor: "server",
          type: "draw",
          payload: { seat: drawer, tile: 31, wallIndex: next.wallIndex, wallRemaining: 99 },
        });
      }
      this.offered = [];
      this.answers.clear();
      return { state: next, events };
    }

    if (action.type === "declareWin" && action.selfDraw) {
      const seat = action.seat;
      const deltas: FourSeats<number> = [-1, -1, -1, -1];
      deltas[seat] = 3;
      for (const s of [0, 1, 2, 3] as SeatIndex[]) next.seats[s].chips += deltas[s];
      next.phase = "handEnd";
      events.push({
        handIndex: hi,
        actor: seat,
        type: "selfDraw",
        payload: {
          context: {
            seat,
            selfDraw: true,
            from: null,
            winningTile: DEALER_DRAWN,
            roundWind: state.roundWind,
            seatWind: state.seats[seat].wind,
            isDealer: state.dealer === seat,
          },
          concealed: clone(state.seats[seat].hand),
          melds: [],
          flowers: [],
          score: { faan: 4, rawFaan: 4, capped: false, awards: [{ id: "allInTriplets", faan: 3 }], legal: true },
        },
      });
      this.handsEnded += 1;
      events.push({
        handIndex: hi,
        actor: "server",
        type: "handEnd",
        payload: {
          outcome: "selfDraw",
          winner: seat,
          loser: null,
          faan: 4,
          chipDeltas: deltas,
          standings: [0, 1, 2, 3].map((s) => next.seats[s as SeatIndex].chips) as FourSeats<number>,
          dealerRepeats: state.dealer === seat,
          nextDealer: state.dealer === seat ? state.dealer : (((state.dealer + 1) % 4) as SeatIndex),
          nextRoundWind: state.roundWind,
        },
      });
      return { state: next, events };
    }

    throw illegal("notALegalMove", `stub cannot apply ${action.type}`);
  }

  legalActions(state: GameState, seat: SeatIndex): Action[] {
    if (state.phase === "awaitDiscard" && state.turn === seat) {
      const s = state.seats[seat];
      const out: Action[] = [...s.hand, ...(s.drawn !== null ? [s.drawn] : [])].map((tile) => ({
        type: "discard" as const,
        seat,
        tile,
      }));
      if (s.drawn !== null) out.push({ type: "declareWin", seat, selfDraw: true });
      return out;
    }
    if (state.phase === "claimWindow" && this.offered.includes(seat) && state.lastDiscard) {
      return [
        { type: "claim", seat, option: { kind: "pung" } },
        { type: "pass", seat },
      ];
    }
    return [];
  }
}

class StubBots implements BotBrain {
  decideCalls: { seat: SeatIndex; sawTiles: TileId[] }[] = [];
  gradeCalls: { seat: SeatIndex; action: Action }[] = [];
  pace = 1_000;

  decide(view: SeatVisible<SeatSnapshot>, legal: LegalRequests): Action | null {
    const own = view.seats[view.seat];
    this.decideCalls.push({
      seat: view.seat,
      sawTiles: collectNumbers(view),
    });
    void own;
    if (legal.claims) return { type: "pass", seat: view.seat };
    if (legal.discard.length > 0) return { type: "discard", seat: view.seat, tile: legal.discard[0] };
    return null;
  }
  paceMs(): number {
    return this.pace;
  }
  /** Records every call — §8's teeth. A real `grade` also never sees a
   *  bot-controlled seat; that guarantee lives in the DO, not here, so the
   *  test asserts on this log rather than on the returned verdict. */
  grade(
    _view: SeatVisible<SeatSnapshot>,
    _legal: LegalRequests,
    action: Action,
  ): { matched: boolean; gap: number } | null {
    this.gradeCalls.push({ seat: action.seat, action: clone(action) });
    return { matched: true, gap: 0 };
  }
}

/* ── harness ───────────────────────────────────────────────────────────── */

const TOKENS: FourSeats<string> = ["tok-aaaa", "tok-bbbb", "tok-cccc", "tok-dddd"];
const MATCH_ID = "match-0001";

function makeHeader(botSeats: readonly number[]): MatchLogHeader {
  return {
    v: 1,
    matchId: MATCH_ID,
    engineVersion: "engine-test-1",
    rulesetId: "hkos-standard",
    startedAt: 0,
    players: [0, 1, 2, 3].map((seat) => ({
      playerId: `p${seat}`,
      displayName: `Player ${seat}`,
      seat: seat as SeatIndex,
      bot: botSeats.includes(seat),
    })) as MatchLogHeader["players"],
    matchLength: "oneWindRound",
    startingChips: [1000, 1000, 1000, 1000],
  };
}

interface Harness {
  ctx: StubCtx;
  core: TableCore;
  rules: StubRules;
  bots: StubBots;
  archive: StubArchive;
  db: StubD1;
  clock: { now: number };
  sockets: (StubSocket | null)[];
}

async function makeTable(opts: {
  botSeats?: number[];
  config?: Partial<TableConfig>;
  matchOverAfterHands?: number;
  rand?: () => number;
  defaultBotFor?: (seat: SeatIndex) => { key: string; displayName: string };
  randomizeSeats?: boolean;
} = {}): Promise<Harness> {
  const ctx = new StubCtx();
  const rules = new StubRules();
  const bots = new StubBots();
  const archive = new StubArchive();
  const db = new StubD1();
  const clock = { now: 1_700_000_000_000 };
  if (opts.matchOverAfterHands) rules.matchOverAfterHands = opts.matchOverAfterHands;
  const core = new TableCore(ctx, { DB: db }, {
    rules,
    bots,
    archive,
    clock: () => clock.now,
    config: opts.config,
    rand: opts.rand,
    defaultBotFor: opts.defaultBotFor,
  });
  const init: TableInit = {
    matchId: MATCH_ID,
    header: makeHeader(opts.botSeats ?? []),
    seed: 20260826,
    seatTokens: TOKENS,
    randomizeSeats: opts.randomizeSeats,
  };
  const res = await core.fetch(
    new Request("https://table.invalid/table/init", {
      method: "POST",
      body: JSON.stringify(init),
    }),
  );
  expect(res.status).toBe(200);
  return { ctx, core, rules, bots, archive, db, clock, sockets: [null, null, null, null] };
}

let requestCounter = 0;

async function join(t: Harness, seat: SeatIndex, token = TOKENS[seat]): Promise<StubSocket> {
  const ws = new StubSocket();
  t.ctx.acceptWebSocket(ws);
  await t.core.webSocketMessage(
    ws,
    JSON.stringify({
      p: 1,
      requestId: `join-${seat}-${requestCounter++}`,
      type: "join",
      payload: { matchId: MATCH_ID, seatToken: token },
    }),
  );
  t.sockets[seat] = ws;
  return ws;
}

async function request(
  t: Harness,
  seat: SeatIndex,
  type: string,
  payload: unknown,
): Promise<void> {
  const ws = t.sockets[seat];
  if (!ws) throw new Error(`seat ${seat} has no socket`);
  await t.core.webSocketMessage(
    ws,
    JSON.stringify({ p: 1, requestId: `req-${requestCounter++}`, type, payload }),
  );
}

/** Every seat joined; with bots present the match deals as soon as the humans are in. */
async function seated(opts: Parameters<typeof makeTable>[0] = {}): Promise<Harness> {
  const t = await makeTable(opts);
  const bots = opts.botSeats ?? [];
  for (const seat of [0, 1, 2, 3] as SeatIndex[]) {
    if (bots.includes(seat)) continue;
    await join(t, seat);
  }
  return t;
}

/** Every number anywhere in a structure — the redaction assertion's teeth. */
function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectNumbers(v, out);
  else if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      collectNumbers((value as Record<string, unknown>)[key], out);
    }
  }
  return out;
}

function storedEvents(t: Harness): GameEvent[] {
  return t.ctx.storage
    .keysWithPrefix("ev:")
    .map((k) => JSON.parse(t.ctx.storage.map.get(k) as string) as GameEvent);
}

function offerSeqFor(ws: StubSocket): number {
  const prompt = ws.msgs("prompt").at(-1);
  if (!prompt?.payload.legal.claims) throw new Error("no open claim offer on this socket");
  return prompt.payload.legal.claims.offerSeq;
}

/* ── 1. redaction ──────────────────────────────────────────────────────── */

describe("per-seat redacted views", () => {
  it("never carries another seat's concealed tiles", async () => {
    const t = await seated();
    for (const seat of [0, 1, 2, 3] as SeatIndex[]) {
      const view = t.core.viewFor(seat);
      const numbers = new Set(collectNumbers(view));
      const mine = new Set(HANDS[seat]);
      for (const tile of OTHERS_TILES) {
        if (mine.has(tile)) continue;
        expect(numbers.has(tile), `seat ${seat} saw tile ${tile}`).toBe(false);
      }
      for (const tile of HANDS[seat]) expect(numbers.has(tile)).toBe(true);
    }
  });

  it("gives other seats a count and no field that could hold a tile", async () => {
    const t = await seated();
    const view = t.core.viewFor(0);
    const other = view.seats[2] as OtherSeatView;
    expect(other).not.toHaveProperty("hand");
    expect(other).not.toHaveProperty("drawn");
    expect(other.handCount).toBe(3);
    expect(view.wallRemaining).toBe(100);
    // The wall ORDER is omniscient state and has no representation here at all.
    expect(view).not.toHaveProperty("wall");
  });

  it("redacts the deal event on the wire, not only the snapshot", async () => {
    const t = await seated();
    const ws = t.sockets[0] as StubSocket;
    // Hand 0 is dealt at init, before anyone connects, so a joiner meets the
    // deal on the resync path — which must redact exactly like the live one.
    await request(t, 0, "resync", { sinceSeq: -1 });
    const deal = ws.msgs("restore")[0]?.payload.events.find((e) => e.type === "deal");
    expect(deal).toBeDefined();
    if (!deal || deal.type !== "deal") throw new Error("no deal event");
    expect(deal.payload.hands[0]).toEqual(HANDS[0]);
    expect(deal.payload.hands[1]).toBeNull();
    expect(deal.payload.hands[2]).toBeNull();
    expect(deal.payload.hands[3]).toBeNull();
    expect(deal.payload.handCounts).toEqual([3, 3, 3, 3]);
    // The seed IS the wall (§5.5) — it must not survive redaction.
    expect(deal.payload).not.toHaveProperty("seed");
  });

  it("never puts another seat's claim prompt on the wire", async () => {
    const t = await seated();
    await request(t, 0, "requestDiscard", { tile: 0 });
    // Seats 1 and 2 were offered. Seat 3 must not learn that, and neither may
    // the discarder: an offer is a statement that the seat holds a claim.
    for (const seat of [0, 3] as SeatIndex[]) {
      const ws = t.sockets[seat] as StubSocket;
      const seen = ws.msgs("events").flatMap((m) => m.payload.events);
      expect(seen.some((e) => e.type === "claimOffered")).toBe(false);
    }
    const one = t.sockets[1] as StubSocket;
    const offers = one.msgs("events").flatMap((m) => m.payload.events).filter((e) => e.type === "claimOffered");
    expect(offers).toHaveLength(1);
  });
});

/* ── 2. the deadline multiplexer ───────────────────────────────────────── */

describe("deadline multiplexer", () => {
  it("keeps a disconnect grace when a claim window is armed on top of it", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    const three = t.sockets[3] as StubSocket;
    three.close();
    await t.core.webSocketClose(three);

    const graceAt = start + DEFAULT_TABLE_CONFIG.disconnectGraceMs;
    expect(t.core.deadlineSnapshot()).toContainEqual({ name: "disconnectGrace:3", at: graceAt });

    // The naive `setAlarm()` would overwrite the grace here and the seat would
    // never be taken over — the table hangs, silently, forever.
    await request(t, 0, "requestDiscard", { tile: 0 });
    const names = t.core.deadlineSnapshot().map((d) => d.name);
    expect(names).toContain("disconnectGrace:3");
    expect(names).toContain("claimWindow");
    expect(t.ctx.storage.alarm).toBe(start + DEFAULT_TABLE_CONFIG.claimWindowMs);

    t.clock.now = start + DEFAULT_TABLE_CONFIG.claimWindowMs + 1;
    await t.core.alarm();
    expect(t.rules.calls.map((a) => a.type)).toContain("pass");
    // …and the grace is still there, untouched, re-armed as the next alarm.
    expect(t.core.deadlineSnapshot()).toContainEqual({ name: "disconnectGrace:3", at: graceAt });
    expect(t.ctx.storage.alarm).toBe(graceAt);
    expect(t.ctx.storage.alarm).toBe(Math.min(...t.core.deadlineSnapshot().map((d) => d.at)));

    t.clock.now = graceAt + 1;
    await t.core.alarm();
    const presence = (t.sockets[0] as StubSocket).msgs("presence");
    expect(presence.some((m) => m.payload.seat === 3 && m.payload.botActing)).toBe(true);
  });

  it("dispatches every due entry in one alarm and loses none", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    for (const seat of [1, 2] as SeatIndex[]) {
      const ws = t.sockets[seat] as StubSocket;
      ws.close();
      await t.core.webSocketClose(ws);
    }
    await request(t, 0, "requestDiscard", { tile: 0 });

    const armed = t.core.deadlineSnapshot().map((d) => d.name).sort();
    expect(armed).toEqual(["claimWindow", "disconnectGrace:1", "disconnectGrace:2"]);
    expect(t.ctx.storage.alarm).toBe(Math.min(...t.core.deadlineSnapshot().map((d) => d.at)));

    // Jump past all three at once. A handler that only served the entry the
    // alarm was set for would drop two of them.
    t.clock.now = start + DEFAULT_TABLE_CONFIG.disconnectGraceMs + 1;
    await t.core.alarm();

    const presence = (t.sockets[0] as StubSocket).msgs("presence");
    const takenOver = presence.filter((m) => m.payload.botActing).map((m) => m.payload.seat);
    expect([...new Set(takenOver)].sort()).toEqual([1, 2]);
    expect(t.rules.calls.filter((a) => a.type === "pass")).toHaveLength(2);
    expect(t.core.deadlineSnapshot().map((d) => d.name)).not.toContain("claimWindow");
  });

  it("honours a deadline armed by another deadline's dispatch", async () => {
    // Grace expiry makes a seat bot-controlled, which must arm its pace; if the
    // re-arm at the end of alarm() were skipped the table would stop dead.
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    const zero = t.sockets[0] as StubSocket;
    zero.close();
    await t.core.webSocketClose(zero);
    t.clock.now = start + DEFAULT_TABLE_CONFIG.disconnectGraceMs + 1;
    await t.core.alarm();

    const paced = t.core.deadlineSnapshot().find((d) => d.name === "botPace:0");
    expect(paced).toBeDefined();
    expect(t.ctx.storage.alarm).toBe(paced?.at);

    t.clock.now = (paced?.at ?? 0) + 1;
    await t.core.alarm();
    expect(t.rules.calls.map((a) => a.type)).toContain("discard");
  });

  it("re-arms to the minimum, never to the last thing set", async () => {
    const t = await seated();
    const start = t.clock.now;
    const one = t.sockets[1] as StubSocket;
    one.close();
    await t.core.webSocketClose(one);
    // grace (start + 30s) was set AFTER the turn clock (start + 20s).
    expect(t.ctx.storage.alarm).toBe(start + DEFAULT_TABLE_CONFIG.turnMs);
  });

  it("does not push the turn clock out on a commit that leaves the turn alone", async () => {
    const t = await seated();
    const start = t.clock.now;
    const armedAt = t.core.deadlineSnapshot().find((d) => d.name === "turnClock")?.at;
    expect(armedAt).toBe(start + DEFAULT_TABLE_CONFIG.turnMs);
    t.clock.now = start + 3_000;
    await request(t, 0, "requestDiscard", { tile: 99 }); // rejected: tile not held
    t.clock.now = start + 6_000;
    await request(t, 1, "heartbeat", {});
    // A rejected move commits nothing, so the seat's clock keeps running down.
    expect(t.core.deadlineSnapshot().find((d) => d.name === "turnClock")?.at).toBe(armedAt);
  });
});

/* ── 3. claim windows and bot pacing ───────────────────────────────────── */

describe("claim windows", () => {
  it("never answers for a bot synchronously", async () => {
    const t = await seated({ botSeats: [1, 2, 3] });
    await request(t, 0, "requestDiscard", { tile: 0 });

    // The reducer has seen the discard and NOTHING else: a synchronous bot
    // reply would resolve the window instantly whenever no bot held a claim,
    // and slowly whenever one did — a timing oracle (§5.2).
    expect(t.rules.calls.map((a) => a.type)).toEqual(["discard"]);
    expect(t.bots.decideCalls).toHaveLength(0);
    const names = t.core.deadlineSnapshot().map((d) => d.name);
    expect(names).toContain("botPace:1");
    expect(names).toContain("botPace:2");
    expect(names).toContain("claimWindow");
  });

  it("holds a bot's answer until the window's fixed minimum has run", async () => {
    const t = await seated({ botSeats: [1, 2, 3], config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    await request(t, 0, "requestDiscard", { tile: 0 });

    t.clock.now = start + t.bots.pace + 1;
    await t.core.alarm();
    expect(t.bots.decideCalls.map((c) => c.seat).sort()).toEqual([1, 2]);
    // Decided — but still not applied. The window owns the clock.
    expect(t.rules.calls.map((a) => a.type)).toEqual(["discard"]);

    t.clock.now = start + DEFAULT_TABLE_CONFIG.claimWindowMs + 1;
    await t.core.alarm();
    expect(t.rules.calls.slice(1).map((a) => `${a.type}:${a.seat}`)).toEqual(["pass:1", "pass:2"]);
  });

  it("does not shorten the window when a human answers early", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    await request(t, 0, "requestDiscard", { tile: 0 });
    const closesAt = t.core.deadlineSnapshot().find((d) => d.name === "claimWindow")?.at;
    expect(closesAt).toBe(start + DEFAULT_TABLE_CONFIG.claimWindowMs);

    t.clock.now = start + 40;
    await request(t, 1, "requestPass", { offerSeq: offerSeqFor(t.sockets[1] as StubSocket) });
    t.clock.now = start + 80;
    await request(t, 2, "requestPass", { offerSeq: offerSeqFor(t.sockets[2] as StubSocket) });

    // Both answers are in and the window still has not moved or resolved.
    expect(t.rules.calls.map((a) => a.type)).toEqual(["discard"]);
    expect(t.core.deadlineSnapshot().find((d) => d.name === "claimWindow")?.at).toBe(closesAt);
    const acks = (t.sockets[1] as StubSocket).msgs("accepted");
    expect(acks.length).toBeGreaterThan(0);

    t.clock.now = (closesAt ?? 0) + 1;
    await t.core.alarm();
    expect(t.rules.calls.slice(1).map((a) => `${a.type}:${a.seat}`)).toEqual(["pass:1", "pass:2"]);
  });

  it("applies answers in seat order regardless of arrival order", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    await request(t, 0, "requestDiscard", { tile: 0 });
    // Seat 2 answers first; seat 1 second. Resolution order must not follow the network.
    await request(t, 2, "requestClaim", {
      offerSeq: offerSeqFor(t.sockets[2] as StubSocket),
      option: { kind: "pung" },
    });
    await request(t, 1, "requestPass", { offerSeq: offerSeqFor(t.sockets[1] as StubSocket) });
    t.clock.now = start + DEFAULT_TABLE_CONFIG.claimWindowMs + 1;
    await t.core.alarm();
    expect(t.rules.calls.slice(1).map((a) => `${a.type}:${a.seat}`)).toEqual(["pass:1", "claim:2"]);
  });

  it("refuses a click on an offer that is no longer open", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    await request(t, 0, "requestDiscard", { tile: 0 });
    await request(t, 1, "requestPass", { offerSeq: 9_999 });
    const rejects = (t.sockets[1] as StubSocket).msgs("rejected");
    expect(rejects.at(-1)?.payload.code).toBe("staleOffer");
  });

  it("refuses a seat that was never offered the window", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    await request(t, 0, "requestDiscard", { tile: 0 });
    await request(t, 3, "requestDiscard", { tile: 26 });
    const rejects = (t.sockets[3] as StubSocket).msgs("rejected");
    expect(rejects.at(-1)?.payload.code).toBe("windowClosed");
  });
});

/* ── 3b. pause / resume ────────────────────────────────────────────────── */

describe("pause / resume", () => {
  it("stops a turn clock from expiring across the fake clock", async () => {
    // Default turnMs (20s) and pauseMaxMs (10min): the jump below clears the
    // turn clock's original deadline by a wide margin while staying well
    // inside the pause's own auto-resume window.
    const t = await seated();
    const start = t.clock.now;
    await request(t, 0, "requestPause", {});
    const accepts = (t.sockets[0] as StubSocket).msgs("accepted");
    expect(accepts.length).toBeGreaterThan(0);

    const paused = (t.sockets[0] as StubSocket).msgs("paused").at(-1);
    expect(paused?.payload).toMatchObject({ on: true, bySeat: 0, displayName: "Player 0" });

    const pauseTimeout = t.core.deadlineSnapshot().find((d) => d.name === "pauseTimeout");
    expect(pauseTimeout?.at).toBe(start + DEFAULT_TABLE_CONFIG.pauseMaxMs);
    expect(t.ctx.storage.alarm).toBe(pauseTimeout?.at);

    // Jump WAY past where the turn clock would have fired unpaused. Nothing
    // may dispatch except pauseTimeout itself, which has not come due yet.
    t.clock.now = start + DEFAULT_TABLE_CONFIG.turnMs + 1_000;
    await t.core.alarm();
    expect(t.rules.calls).toHaveLength(0);
    expect(t.core.deadlineSnapshot()).toContainEqual({ name: "turnClock", at: start + DEFAULT_TABLE_CONFIG.turnMs });
  });

  it("restores the remaining time exactly across a pause", async () => {
    const t = await seated({ config: { turnMs: 10_000 } });
    const start = t.clock.now;
    t.clock.now = start + 3_000; // 7s left on the turn clock
    await request(t, 0, "requestPause", {});

    t.clock.now = start + 3_000 + 30_000; // a 30s pause
    // Any human may resume — not only the one who paused.
    await request(t, 1, "requestResume", {});

    const resumed = (t.sockets[1] as StubSocket).msgs("paused").at(-1);
    expect(resumed?.payload.on).toBe(false);

    const turnClock = t.core.deadlineSnapshot().find((d) => d.name === "turnClock");
    expect(turnClock?.at).toBe(t.clock.now + 7_000);
    expect(t.core.deadlineSnapshot().map((d) => d.name)).not.toContain("pauseTimeout");
  });

  it("shifts an open claim window's close time across a pause", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    await request(t, 0, "requestDiscard", { tile: 0 });
    const before = t.core.deadlineSnapshot().find((d) => d.name === "claimWindow")?.at;
    expect(before).toBe(start + DEFAULT_TABLE_CONFIG.claimWindowMs);

    t.clock.now = start + 100;
    await request(t, 1, "requestPause", {});
    t.clock.now = start + 100 + 5_000; // a 5s pause
    await request(t, 1, "requestResume", {});

    const after = t.core.deadlineSnapshot().find((d) => d.name === "claimWindow")?.at;
    expect(after).toBe((before ?? 0) + 5_000);

    // The window still resolves normally once resumed.
    t.clock.now = (after ?? 0) + 1;
    await t.core.alarm();
    expect(t.rules.calls.slice(1).map((a) => a.type)).toContain("pass");
  });

  it("rejects a game request while paused", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    await request(t, 0, "requestPause", {});
    await request(t, 0, "requestDiscard", { tile: 0 });
    const rejects = (t.sockets[0] as StubSocket).msgs("rejected");
    expect(rejects.at(-1)?.payload.code).toBe("paused");
    expect(t.rules.calls).toHaveLength(0);
  });

  it("refuses a pause or a resume from a bot seat", async () => {
    const t = await makeTable({ botSeats: [1, 2, 3] });
    await join(t, 0); // fills the table: seats 1-3 are bots
    // A socket bound to a bot-labelled seat, for exercising the guard only —
    // production bots never open a socket.
    const botSocket = await join(t, 1);
    await request(t, 1, "requestPause", {});
    expect(botSocket.msgs("rejected").at(-1)?.payload.code).toBe("pauseRefused");

    await request(t, 0, "requestPause", {});
    await request(t, 1, "requestResume", {});
    expect(botSocket.msgs("rejected").at(-1)?.payload.code).toBe("pauseRefused");
  });

  it("refuses pausing twice, and resuming when not paused", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    await request(t, 0, "requestResume", {});
    expect((t.sockets[0] as StubSocket).msgs("rejected").at(-1)?.payload.code).toBe("pauseRefused");

    await request(t, 0, "requestPause", {});
    await request(t, 1, "requestPause", {});
    expect((t.sockets[1] as StubSocket).msgs("rejected").at(-1)?.payload.code).toBe("pauseRefused");
  });

  it("auto-resumes once pauseMaxMs elapses with nobody resuming", async () => {
    const t = await seated({ config: { turnMs: 10_000_000, pauseMaxMs: 5_000 } });
    const start = t.clock.now;
    await request(t, 0, "requestPause", {});

    t.clock.now = start + 5_000 + 1;
    await t.core.alarm();

    const msgs = (t.sockets[0] as StubSocket).msgs("paused");
    const last = msgs.at(-1);
    expect(last?.payload).toMatchObject({ on: false, bySeat: 0, displayName: "Player 0" });
    expect(t.core.deadlineSnapshot().map((d) => d.name)).not.toContain("pauseTimeout");
    // A discard now goes through — the table is live again.
    await request(t, 0, "requestDiscard", { tile: 0 });
    expect(t.rules.calls.map((a) => a.type)).toEqual(["discard"]);
  });

  it("carries the paused state on welcome and restore", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    await request(t, 0, "requestPause", {});

    const three = t.sockets[3] as StubSocket;
    three.close();
    await t.core.webSocketClose(three);
    const back = await join(t, 3);
    expect(back.msgs("welcome").at(-1)?.payload.paused).toMatchObject({ bySeat: 0, displayName: "Player 0" });

    await request(t, 3, "resync", { sinceSeq: -1 });
    expect(back.msgs("restore").at(-1)?.payload.paused).toMatchObject({ bySeat: 0, displayName: "Player 0" });
  });
});

/* ── 3c. the hand-end intermission ─────────────────────────────────────── */

describe("hand-end intermission", () => {
  it("holds the next deal and stamps nextHandTs when a human is connected", async () => {
    const t = await seated({ config: { turnMs: 10_000_000, handEndIntermissionMs: 5_000 } });
    const start = t.clock.now;
    await request(t, 0, "requestWinOnSelfDraw", {});

    // handEnd landed but the next hand has NOT been dealt yet.
    expect(t.core.viewFor(0).handIndex).toBe(0);

    const zero = t.sockets[0] as StubSocket;
    const handEnd = zero
      .msgs("events")
      .flatMap((m) => m.payload.events)
      .find((e) => e.type === "handEnd");
    expect(handEnd).toBeDefined();
    if (!handEnd || handEnd.type !== "handEnd") throw new Error("no handEnd");
    expect(handEnd.payload.nextHandTs).toBe(start + 5_000);
    expect(t.core.deadlineSnapshot()).toContainEqual({ name: "nextHand", at: start + 5_000 });

    t.clock.now = start + 5_000 + 1;
    await t.core.alarm();
    expect(t.core.viewFor(0).handIndex).toBe(1);
  });

  it("advances at once when no human seat is connected", async () => {
    const t = await seated({
      botSeats: [1, 2, 3],
      config: { turnMs: 10_000_000, handEndIntermissionMs: 5_000 },
    });
    const zero = t.sockets[0] as StubSocket;
    zero.close();
    await t.core.webSocketClose(zero);

    await request(t, 0, "requestWinOnSelfDraw", {});
    expect(t.core.viewFor(0).handIndex).toBe(1);
  });

  it("ends the intermission early once every connected human has requested the next hand", async () => {
    const t = await seated({ config: { turnMs: 10_000_000, handEndIntermissionMs: 60_000 } });
    await request(t, 0, "requestWinOnSelfDraw", {});
    expect(t.core.viewFor(0).handIndex).toBe(0);

    for (const seat of [0, 1, 2] as SeatIndex[]) {
      await request(t, seat, "requestNextHand", {});
      expect(t.core.viewFor(0).handIndex).toBe(0); // still waiting on seat 3
    }
    await request(t, 3, "requestNextHand", {});
    expect(t.core.viewFor(0).handIndex).toBe(1);
  });

  it("seals the outgoing hand into the archive only after the intermission's deal", async () => {
    const t = await seated({ config: { turnMs: 10_000_000, handEndIntermissionMs: 5_000 } });
    const start = t.clock.now;
    await request(t, 0, "requestWinOnSelfDraw", {});
    expect(t.archive.results).toHaveLength(0);

    t.clock.now = start + 5_000 + 1;
    await t.core.alarm(); // nextHand -> advance + sealHand -> outboxFlush, all in one alarm
    expect(t.archive.results).toHaveLength(1);
    expect(t.archive.results[0].handIndex).toBe(0);
  });

  it("still ends the match after the last hand's intermission", async () => {
    const t = await seated({
      config: { turnMs: 10_000_000, handEndIntermissionMs: 5_000 },
      matchOverAfterHands: 1,
    });
    const start = t.clock.now;
    await request(t, 0, "requestWinOnSelfDraw", {});

    t.clock.now = start + 5_000 + 1;
    await t.core.alarm();

    const zero = t.sockets[0] as StubSocket;
    const matchEnd = zero
      .msgs("events")
      .flatMap((m) => m.payload.events)
      .find((e) => e.type === "matchEnd");
    expect(matchEnd).toBeDefined();
  });

  it("shifts the nextHand deadline across a pause during the intermission", async () => {
    const t = await seated({ config: { turnMs: 10_000_000, handEndIntermissionMs: 5_000 } });
    const start = t.clock.now;
    await request(t, 0, "requestWinOnSelfDraw", {});
    const before = t.core.deadlineSnapshot().find((d) => d.name === "nextHand")?.at;
    expect(before).toBe(start + 5_000);

    await request(t, 1, "requestPause", {});
    t.clock.now = start + 3_000; // a 3s pause
    await request(t, 1, "requestResume", {});

    const after = t.core.deadlineSnapshot().find((d) => d.name === "nextHand")?.at;
    expect(after).toBe((before ?? 0) + 3_000);
  });
});

/* ── 3d. auto-play ──────────────────────────────────────────────────────── */

describe("auto-play", () => {
  it("plays a seat's turn via the bot brain while auto is on", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    await request(t, 0, "requestAuto", { on: true });
    expect((t.sockets[0] as StubSocket).msgs("accepted").length).toBeGreaterThan(0);

    const presence = (t.sockets[1] as StubSocket).msgs("presence");
    expect(presence.some((m) => m.payload.seat === 0 && m.payload.auto === true)).toBe(true);
    expect(t.core.deadlineSnapshot().map((d) => d.name)).toContain("botPace:0");
    expect(t.bots.decideCalls).toHaveLength(0); // never synchronous

    t.clock.now = start + t.bots.pace + 1;
    await t.core.alarm();
    expect(t.bots.decideCalls.some((c) => c.seat === 0)).toBe(true);
    expect(t.rules.calls.map((a) => a.type)).toContain("discard");
  });

  it("turns auto off when the seat sends a game request itself, and applies the move", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    await request(t, 0, "requestAuto", { on: true });
    await request(t, 0, "requestDiscard", { tile: 0 });

    expect(t.rules.calls.map((a) => a.type)).toEqual(["discard"]);
    const presence = (t.sockets[1] as StubSocket).msgs("presence");
    expect(presence.some((m) => m.payload.seat === 0 && m.payload.auto === false)).toBe(true);
    expect(t.core.deadlineSnapshot().map((d) => d.name)).not.toContain("botPace:0");
  });

  it("survives a reconnect, unlike a disconnect takeover", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    await request(t, 0, "requestAuto", { on: true });

    const zero = t.sockets[0] as StubSocket;
    zero.close();
    await t.core.webSocketClose(zero);
    const back = await join(t, 0);

    const welcome = back.msgs("welcome").at(-1);
    expect(welcome?.payload.directory[0]).toMatchObject({ auto: true, connected: true, bot: false });
  });

  it("refuses requestAuto before the table is full", async () => {
    // botSeats: [] — every seat is human, so joining only seat 0 leaves the
    // table short and the clocks unstarted.
    const t = await makeTable({ botSeats: [] });
    const zero = await join(t, 0);
    await request(t, 0, "requestAuto", { on: true });
    expect(zero.msgs("rejected").at(-1)?.payload.code).toBe("autoRefused");
  });

  it("refuses requestAuto from a bot seat", async () => {
    const t = await makeTable({ botSeats: [1, 2, 3] });
    await join(t, 0); // fills the table: seats 1-3 are bots
    const botSocket = await join(t, 1);
    await request(t, 1, "requestAuto", { on: true });
    expect(botSocket.msgs("rejected").at(-1)?.payload.code).toBe("autoRefused");
  });
});

/* ── 4. the outbox ─────────────────────────────────────────────────────── */

describe("outbox", () => {
  it("keeps a hand's events until BOTH sinks confirm, and retries the failing one", async () => {
    // handEndIntermissionMs: 0 — this suite is about the outbox, not the
    // hand-end intermission (its own describe block above); disabling it
    // keeps a win advancing and sealing at once, same as before that feature
    // existed.
    const t = await seated({ config: { turnMs: 10_000_000, handEndIntermissionMs: 0 } });
    t.archive.failLogTimes = 2;
    await request(t, 0, "requestWinOnSelfDraw", {});

    const handZero = () => t.ctx.storage.keysWithPrefix("ev:0000:");
    const emitted = handZero().length;
    expect(emitted).toBeGreaterThan(0);

    t.clock.now += 1;
    await t.core.alarm(); // attempt 1 — D1 lands, R2 fails
    expect(t.archive.results).toHaveLength(1);
    expect(t.archive.handLogs).toHaveLength(0);
    expect(handZero()).toHaveLength(emitted);

    t.clock.now += 60_000;
    await t.core.alarm(); // attempt 2 — R2 fails again
    expect(t.archive.handLogs).toHaveLength(0);
    expect(handZero()).toHaveLength(emitted);

    t.clock.now += 60_000;
    await t.core.alarm(); // attempt 3 — R2 lands
    expect(t.archive.handLogs).toHaveLength(1);
    // The sink that already succeeded is NOT re-run by the retry.
    expect(t.archive.results).toHaveLength(1);
    // Only now may the DO forget the hand.
    expect(handZero()).toHaveLength(0);
    expect(t.ctx.storage.keysWithPrefix("ob:0000")).toHaveLength(0);
  });

  it("archives the whole hand, contiguous and in order", async () => {
    const t = await seated({ config: { turnMs: 10_000_000, handEndIntermissionMs: 0 } });
    await request(t, 0, "requestDiscard", { tile: 0 });
    t.clock.now += DEFAULT_TABLE_CONFIG.claimWindowMs + 1;
    await t.core.alarm();
    await request(t, 1, "requestWinOnSelfDraw", {});
    t.clock.now += 1;
    await t.core.alarm();

    expect(t.archive.handLogs).toHaveLength(1);
    const events = t.archive.handLogs[0].log.events;
    expect(events[0].type).toBe("deal");
    expect(events.at(-1)?.type).toBe("handEnd");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.every((e) => e.matchId === MATCH_ID)).toBe(true);
    // The archive is the OMNISCIENT serializer: it keeps what the sockets never saw.
    const deal = events.find((e) => e.type === "deal");
    if (!deal || deal.type !== "deal") throw new Error("no deal");
    expect(deal.payload.seed).toBe(stubHandSeed(20260826, 0));
    expect(deal.payload.hands[2]).toEqual(HANDS[2]);
  });

  it("never drops an event when a sink fails forever", async () => {
    const t = await seated({ config: { turnMs: 10_000_000, handEndIntermissionMs: 0 } });
    t.archive.failLogTimes = 50;
    t.archive.failResultTimes = 50;
    await request(t, 0, "requestWinOnSelfDraw", {});
    const before = t.ctx.storage.keysWithPrefix("ev:0000:").length;
    for (let i = 0; i < 8; i++) {
      t.clock.now += 120_000;
      await t.core.alarm();
    }
    expect(t.archive.handLogs).toHaveLength(0);
    expect(t.archive.results).toHaveLength(0);
    expect(t.ctx.storage.keysWithPrefix("ev:0000:")).toHaveLength(before);
    // Still queued, still retrying — the DO has not given itself permission to forget.
    expect(t.ctx.storage.keysWithPrefix("ob:0000")).toHaveLength(1);
    expect(t.core.deadlineSnapshot().map((d) => d.name)).toContain("outboxFlush");
  });

  it("is disposable at MATCH_END, and not before", async () => {
    const t = await seated({
      config: { turnMs: 10_000_000, handEndIntermissionMs: 0 },
      matchOverAfterHands: 1,
    });
    t.archive.failLogTimes = 1;
    await request(t, 0, "requestWinOnSelfDraw", {});

    t.clock.now += 1;
    await t.core.alarm(); // R2 fails: the match is over but the object is not disposable
    expect(t.archive.finished).toHaveLength(0);
    expect(t.ctx.storage.map.has("meta")).toBe(true);

    t.clock.now += 120_000;
    await t.core.alarm();
    expect(t.archive.finished).toHaveLength(1);
    expect(t.archive.finished[0].reason).toBe("windRoundComplete");
    expect(t.archive.finished[0].handLogKeys).toEqual([`matches/${MATCH_ID}/hands/0000.json`]);
    // Everything is in R2 and D1; all that is left is the tombstone.
    expect([...t.ctx.storage.map.keys()]).toEqual(["tombstone"]);
    expect(t.ctx.storage.alarm).toBeNull();
    expect((t.sockets[0] as StubSocket).closed).not.toBeNull();
  });

  it("summarises the hand into the D1 row from the events, not from a guess", async () => {
    const t = await seated({ config: { turnMs: 10_000_000, handEndIntermissionMs: 0 } });
    await request(t, 0, "requestWinOnSelfDraw", {});
    t.clock.now += 1;
    await t.core.alarm();
    const row = t.archive.results[0];
    expect(row.matchId).toBe(MATCH_ID);
    expect(row.handIndex).toBe(0);
    expect(row.outcome).toBe("win");
    expect(row.winnerSeat).toBe(0);
    expect(row.winnerPlayerId).toBe("p0");
    expect(row.selfDraw).toBe(true);
    expect(row.faan).toBe(4);
    expect(row.seed).toBe(stubHandSeed(20260826, 0));
    expect(row.chipDeltas.reduce((a, b) => a + b, 0)).toBe(0);
    expect(row.logSeqStart).toBe(0);
  });
});

/* ── 5. presence, reconnect and seat reclaim ───────────────────────────── */

describe("reconnect", () => {
  it("answers a resync with a snapshot plus the actions since, not a replay", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const first = t.sockets[0] as StubSocket;
    const openedAt = first.msgs("welcome")[0].payload.snapshot.seq;
    await request(t, 0, "requestDiscard", { tile: 0 });

    first.close();
    await t.core.webSocketClose(first);
    const back = await join(t, 0);
    expect(back.msgs("welcome")).toHaveLength(1);

    await request(t, 0, "resync", { sinceSeq: openedAt });
    const restore = back.msgs("restore")[0];
    expect(restore).toBeDefined();
    // The snapshot is the CURRENT fold; the events only cover the gap.
    expect(restore.payload.snapshot.seq).toBeGreaterThan(openedAt);
    expect(restore.payload.events.every((e) => e.seq > openedAt)).toBe(true);
    expect(restore.payload.events.some((e) => e.type === "deal")).toBe(false);
    expect(restore.payload.events.some((e) => e.type === "discard")).toBe(true);
    // Redaction applies on this path too: seat 0 was not offered its own discard.
    expect(restore.payload.events.some((e) => e.type === "claimOffered")).toBe(false);
  });

  it("marks presence, arms a grace, then lets a bot take the seat", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    const one = t.sockets[1] as StubSocket;
    one.close();
    await t.core.webSocketClose(one);

    const zero = t.sockets[0] as StubSocket;
    expect(zero.msgs("presence").at(-1)?.payload).toMatchObject({
      seat: 1,
      connected: false,
      botActing: false,
    });
    t.clock.now = start + DEFAULT_TABLE_CONFIG.disconnectGraceMs + 1;
    await t.core.alarm();
    expect(zero.msgs("presence").at(-1)?.payload).toMatchObject({
      seat: 1,
      connected: false,
      botActing: true,
    });
  });

  it("lets the player reclaim the seat from the bot with the issued credential", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    const one = t.sockets[1] as StubSocket;
    one.close();
    await t.core.webSocketClose(one);
    t.clock.now = start + DEFAULT_TABLE_CONFIG.disconnectGraceMs + 1;
    await t.core.alarm();

    const back = await join(t, 1);
    expect(back.msgs("welcome")).toHaveLength(1);
    expect(back.msgs("welcome")[0].payload.seat).toBe(1);
    const zero = t.sockets[0] as StubSocket;
    expect(zero.msgs("presence").at(-1)?.payload).toMatchObject({
      seat: 1,
      connected: true,
      botActing: false,
    });
    expect(t.core.deadlineSnapshot().map((d) => d.name)).not.toContain("disconnectGrace:1");
  });

  it("refuses a socket presenting a token for no seat", async () => {
    const t = await makeTable();
    const ws = new StubSocket();
    t.ctx.acceptWebSocket(ws);
    await t.core.webSocketMessage(
      ws,
      JSON.stringify({
        p: 1,
        requestId: "x",
        type: "join",
        payload: { matchId: MATCH_ID, seatToken: "tok-wrong" },
      }),
    );
    expect(ws.msgs("welcome")).toHaveLength(0);
    expect(ws.msgs("rejected")[0]?.payload.code).toBe("unauthenticated");
  });

  it("closes the older socket when a seat is reclaimed while still connected", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const first = t.sockets[2] as StubSocket;
    const second = await join(t, 2);
    expect(first.closed?.code).toBe(4000);
    expect(second.msgs("welcome")).toHaveLength(1);
  });

  it("refuses a request from a socket that never joined", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const stranger = new StubSocket();
    t.ctx.acceptWebSocket(stranger);
    await t.core.webSocketMessage(
      stranger,
      JSON.stringify({ p: 1, requestId: "y", type: "requestDiscard", payload: { tile: 0 } }),
    );
    expect(stranger.msgs("protocolFault")[0]?.payload.code).toBe("notJoined");
  });

  it("refuses a protocol version it does not speak", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const ws = t.sockets[0] as StubSocket;
    await t.core.webSocketMessage(ws, JSON.stringify({ p: 99, requestId: "z", type: "heartbeat", payload: {} }));
    expect(ws.msgs("protocolFault").at(-1)?.payload.code).toBe("unsupportedProtocolVersion");
  });

  it("reconciles presence from the live sockets on a cold wake", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    // A fresh instance over the same storage, with no sockets: hibernation can
    // evict without a close event, so a persisted `connected: true` is a lie.
    const ctx = new StubCtx();
    ctx.storage.map = t.ctx.storage.map;
    const revived = new TableCore(ctx, {}, {
      rules: new StubRules(),
      bots: new StubBots(),
      archive: new StubArchive(),
      clock: () => t.clock.now,
    });
    await revived.alarm();
    const view = revived.viewFor(0);
    expect(view.seats.every((s) => s.connected === false)).toBe(true);
  });
});

/* ── 5b. the lobby: /fill and /leave ───────────────────────────────────── */

/** A `MatchLogHeader` with a caller-supplied `players` array, so a test can
 *  put an ACTUALLY UNCLAIMED human seat on the table — `makeHeader` above
 *  always gives every seat a non-empty `playerId`, which is exactly the state
 *  `/fill` is supposed to find and convert, so these tests build their own. */
function customHeader(players: MatchLogHeader["players"]): MatchLogHeader {
  return {
    v: 1,
    matchId: MATCH_ID,
    engineVersion: "engine-test-1",
    rulesetId: "hkos-standard",
    startedAt: 0,
    players,
    matchLength: "oneWindRound",
    startingChips: [1000, 1000, 1000, 1000],
  };
}

const unclaimed = (seat: SeatIndex): MatchLogHeader["players"][number] => ({
  playerId: "",
  displayName: "",
  seat,
  bot: false,
});

async function makeFillableTable(opts: {
  players: MatchLogHeader["players"];
  rand?: () => number;
  defaultBotFor?: (seat: SeatIndex) => { key: string; displayName: string };
  randomizeSeats?: boolean;
}): Promise<Harness> {
  const ctx = new StubCtx();
  const rules = new StubRules();
  const bots = new StubBots();
  const archive = new StubArchive();
  const db = new StubD1();
  const clock = { now: 1_700_000_000_000 };
  const core = new TableCore(ctx, { DB: db }, {
    rules,
    bots,
    archive,
    clock: () => clock.now,
    rand: opts.rand,
    defaultBotFor: opts.defaultBotFor,
  });
  const init: TableInit = {
    matchId: MATCH_ID,
    header: customHeader(opts.players),
    seed: 20260826,
    seatTokens: TOKENS,
    randomizeSeats: opts.randomizeSeats,
  };
  const res = await core.fetch(
    new Request("https://table.invalid/table/init", { method: "POST", body: JSON.stringify(init) }),
  );
  expect(res.status).toBe(200);
  return { ctx, core, rules, bots, archive, db, clock, sockets: [null, null, null, null] };
}

const fill = (t: Harness): Promise<Response> =>
  t.core.fetch(new Request("https://table.invalid/table/fill", { method: "POST", body: JSON.stringify({}) }));

const leave = (t: Harness, playerId: string): Promise<Response> =>
  t.core.fetch(
    new Request("https://table.invalid/table/leave", { method: "POST", body: JSON.stringify({ playerId }) }),
  );

describe("/fill — the creator's start-now bot-fill", () => {
  it("converts every unclaimed human seat to the default lineup and starts the clocks", async () => {
    const players = ([0, 1, 2, 3] as SeatIndex[]).map((seat) =>
      seat === 0 ? { playerId: "p0", displayName: "Human0", seat, bot: false } : unclaimed(seat),
    ) as MatchLogHeader["players"];
    const t = await makeFillableTable({
      players,
      defaultBotFor: (seat) => ({ key: `k${seat}`, displayName: `Bot${seat}` }),
    });
    await join(t, 0);
    // Not full yet — three seats are still unclaimed — so no clock is running.
    expect(t.core.deadlineSnapshot().map((d) => d.name)).not.toContain("turnClock");

    const res = await fill(t);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The table is full now (three new bots + the connected human) and the
    // dealer (seat 0, human) is on turn — the clock is running.
    expect(t.core.deadlineSnapshot().map((d) => d.name)).toContain("turnClock");

    // The lobby write fired (item 6): `lobby_status` flips to 'playing'.
    expect(
      t.db.ran.some((r) => r.sql.includes("SET lobby_status = ?") && r.args[0] === "playing"),
    ).toBe(true);
    // Each new bot got a `players` row before it could be referenced by a hand.
    for (const seat of [1, 2, 3]) {
      expect(
        t.db.ran.some(
          (r) => r.sql.includes("INSERT OR IGNORE INTO players") && r.args[0] === `bot:k${seat}`,
        ),
        `seat ${seat}'s bot row`,
      ).toBe(true);
    }
    // ...and a `match_players` row, so its standings show up in match detail
    // and the lobby's recent-results strip (item 1 of the ranked-settlement
    // brief) instead of vanishing the way an /init-time bot seat's used to.
    for (const seat of [1, 2, 3]) {
      expect(
        t.db.ran.some(
          (r) =>
            r.sql.includes("INSERT OR IGNORE INTO match_players") &&
            r.args[0] === MATCH_ID && r.args[1] === seat && r.args[2] === `bot:k${seat}`,
        ),
        `seat ${seat}'s match_players row`,
      ).toBe(true);
    }

    // The directory (sent on the next welcome) shows the new bots by name.
    const back = await join(t, 0);
    const directory = back.msgs("welcome")[0]!.payload.directory;
    expect(directory[0]).toMatchObject({ playerId: "p0", bot: false });
    expect(directory[1]).toMatchObject({ playerId: "bot:k1", displayName: "Bot1", bot: true });
    expect(directory[2]).toMatchObject({ playerId: "bot:k2", displayName: "Bot2", bot: true });
    expect(directory[3]).toMatchObject({ playerId: "bot:k3", displayName: "Bot3", bot: true });
  });

  it("leaves a seat a human already claimed but has not connected to alone", async () => {
    const players = ([0, 1, 2, 3] as SeatIndex[]).map((seat) => {
      if (seat === 0) return { playerId: "p0", displayName: "Human0", seat, bot: false };
      if (seat === 1) return { playerId: "p1", displayName: "Human1", seat, bot: false }; // claimed, offline
      return unclaimed(seat);
    }) as MatchLogHeader["players"];
    const t = await makeFillableTable({
      players,
      defaultBotFor: (seat) => ({ key: `k${seat}`, displayName: `Bot${seat}` }),
    });
    await join(t, 0);

    await fill(t);
    const back = await join(t, 0);
    const directory = back.msgs("welcome")[0]!.payload.directory;
    // Seat 1 is untouched — still human, still not connected — so the table
    // is not full and the clocks have not started.
    expect(directory[1]).toMatchObject({ playerId: "p1", bot: false });
    expect(t.core.deadlineSnapshot().map((d) => d.name)).not.toContain("turnClock");
  });

  it("is idempotent once the table has started", async () => {
    const players = ([0, 1, 2, 3] as SeatIndex[]).map(unclaimed) as MatchLogHeader["players"];
    const p0 = { playerId: "p0", displayName: "Human0", seat: 0 as SeatIndex, bot: false };
    players[0] = p0;
    const t = await makeFillableTable({
      players,
      defaultBotFor: (seat) => ({ key: `k${seat}`, displayName: `Bot${seat}` }),
    });
    await join(t, 0);
    await fill(t);
    const writesAfterFirstFill = t.db.ran.length;

    const second = await fill(t);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
    // No new lobby-fill side effects on the second call.
    expect(t.db.ran.length).toBe(writesAfterFirstFill);
  });

  it("shuffles the seat mapping deterministically under a seeded rand, then starts", async () => {
    // Fisher-Yates draws j = floor(rand() * (i+1)) for i = 3, 2, 1. A constant
    // rand()=0 always picks j=0, which works out to order = [1, 2, 3, 0]
    // (order[newSeat] = oldSeat): old seat 1 -> new seat 0, old seat 2 -> new
    // seat 1, old seat 3 -> new seat 2, old seat 0 -> new seat 3.
    const players = ([0, 1, 2, 3] as SeatIndex[]).map((seat) => {
      if (seat === 0) return { playerId: "pA", displayName: "Human A", seat, bot: false };
      if (seat === 1) return { playerId: "pB", displayName: "Human B", seat, bot: false };
      return unclaimed(seat);
    }) as MatchLogHeader["players"];
    const t = await makeFillableTable({
      players,
      randomizeSeats: true,
      rand: () => 0,
      defaultBotFor: (seat) => ({ key: `k${seat}`, displayName: `Bot${seat}` }),
    });
    const socketA = await join(t, 0); // Human A, old seat 0
    const socketB = await join(t, 1); // Human B, old seat 1

    const res = await fill(t);
    expect(res.status).toBe(200);

    // Human A's ORIGINAL token now resolves to new seat 3 — the token moved
    // with the player, which is the whole point (a client only ever knows its
    // token, never a seat index).
    const backA = await join(t, 3, TOKENS[0]);
    expect(backA.msgs("welcome")[0]!.payload.seat).toBe(3);

    // Human B ends up at new seat 0 — the dealer's seat — and her ALREADY-OPEN
    // socket (never reconnected) is rewritten in place to match: a discard
    // sent through the very same socket object lands as seat 0, not seat 1.
    await t.core.webSocketMessage(
      socketB,
      JSON.stringify({ p: 1, requestId: "shuffled-discard", type: "requestDiscard", payload: { tile: DEALER_DRAWN } }),
    );
    expect(t.rules.calls).toContainEqual({ type: "discard", seat: 0, tile: DEALER_DRAWN });
    // The reducer accepted it — proof this landed as the DEALER's move
    // (`StubRules.applyAction` throws `notYourTurn` for anyone else), not
    // merely that the seat number 0 appears somewhere in the call log.
    expect(socketB.msgs("rejected")).toHaveLength(0);
    expect(socketB.msgs("accepted").length).toBeGreaterThan(0);
    void socketA; // reclaimed and closed by `backA`'s join above — nothing more to assert on it
  });

  it("suffixes a repeated bot pick's playerId so match_players stays UNIQUE", async () => {
    // Seat 1 opened as a bot at /init time under key "kdup". Seats 2 and 3 are
    // unclaimed, and `defaultBotFor` (deliberately, for this test) hands out
    // that SAME key for every seat it is asked about — the collision
    // `botPlayerId` exists to resolve (worker/src/table.ts doc comment).
    const players = ([0, 1, 2, 3] as SeatIndex[]).map((seat) => {
      if (seat === 0) return { playerId: "p0", displayName: "Human0", seat, bot: false };
      if (seat === 1) return { playerId: "bot:kdup", displayName: "Dup", seat, bot: true };
      return unclaimed(seat);
    }) as MatchLogHeader["players"];
    const t = await makeFillableTable({
      players,
      defaultBotFor: () => ({ key: "kdup", displayName: "Dup" }),
    });
    await join(t, 0);

    const res = await fill(t);
    expect(res.status).toBe(200);

    const back = await join(t, 0);
    const directory = back.msgs("welcome")[0]!.payload.directory;
    // Seat 1 keeps its original, unsuffixed id; seats 2 and 3 — filled in
    // seat order — pick up #2 and #3 rather than colliding with it or with
    // each other.
    expect(directory[1]).toMatchObject({ playerId: "bot:kdup", bot: true });
    expect(directory[2]).toMatchObject({ playerId: "bot:kdup#2", bot: true });
    expect(directory[3]).toMatchObject({ playerId: "bot:kdup#3", bot: true });

    // Each suffixed id got its OWN `players` row and its OWN `match_players`
    // row — the two inserts `UNIQUE (match_id, player_id)` would otherwise
    // have refused the second and third of.
    for (const [seat, playerId] of [[2, "bot:kdup#2"], [3, "bot:kdup#3"]] as const) {
      expect(
        t.db.ran.some((r) => r.sql.includes("INSERT OR IGNORE INTO players") && r.args[0] === playerId),
        `${playerId}'s players row`,
      ).toBe(true);
      expect(
        t.db.ran.some(
          (r) =>
            r.sql.includes("INSERT OR IGNORE INTO match_players") &&
            r.args[0] === MATCH_ID && r.args[1] === seat && r.args[2] === playerId,
        ),
        `${playerId}'s match_players row`,
      ).toBe(true);
    }
  });
});

describe("/leave — a participant's explicit leave", () => {
  it("marks the seat bot-acting, closes its socket, and keeps the token valid for reclaim", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const one = t.sockets[1] as StubSocket;

    const res = await leave(t, "p1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(one.closed?.code).toBe(4001);

    const zero = t.sockets[0] as StubSocket;
    expect(zero.msgs("presence").at(-1)?.payload).toMatchObject({ seat: 1, connected: false, botActing: true });

    // Idempotent: a second call changes nothing further.
    const again = await leave(t, "p1");
    expect(again.status).toBe(200);

    // Reclaim: the seat token issued at `join` still resolves to this seat.
    const back = await join(t, 1);
    expect(back.msgs("welcome")).toHaveLength(1);
    expect(back.msgs("welcome")[0]!.payload.seat).toBe(1);
    expect(back.msgs("welcome")[0]!.payload.directory[1]).toMatchObject({ bot: false, connected: true });
  });

  it("refuses an unseated playerId and no-ops for a seat that is already a bot", async () => {
    const t = await seated({ botSeats: [3] });

    const missing = await leave(t, "nobody-here");
    expect(missing.status).toBe(404);

    const botSeat = await leave(t, "p3"); // makeHeader's bot seats still carry a playerId
    expect(botSeat.status).toBe(200);
    expect(await botSeat.json()).toEqual({ ok: true });
  });
});

/* ── chat (PVP-LOBBY-PROPOSAL-2026-09-02.md §8) ───────────────────────────── */

const chat = (t: Harness, seat: SeatIndex, payload: unknown): Promise<void> =>
  request(t, seat, "chat", payload);

describe("chat", () => {
  it("reaches every socket and accepts the sender, with text stamped and trimmed", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    await chat(t, 0, { text: "  食糊!  " });

    for (const seat of [0, 1, 2, 3] as SeatIndex[]) {
      const ws = t.sockets[seat] as StubSocket;
      const seen = ws.msgs("chat");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.payload).toEqual({ seat: 0, displayName: "Player 0", text: "食糊!", ts: t.clock.now });
    }
    // The sender also gets an `accepted` for the chat request itself (one
    // more than the `join`'s own `accepted`, already on this socket).
    const sender = t.sockets[0] as StubSocket;
    expect(sender.msgs("accepted")).toHaveLength(2);
    expect(sender.msgs("rejected")).toHaveLength(0);
  });

  it("broadcasts a quick phrase with phrase set and text absent", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    await chat(t, 2, { phrase: "hurry" });
    const ws = t.sockets[1] as StubSocket;
    const seen = ws.msgs("chat");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload).toEqual({ seat: 2, displayName: "Player 2", phrase: "hurry", ts: t.clock.now });
  });

  it("refuses a message with neither or both of text and phrase, and an over-length text", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const ws = t.sockets[0] as StubSocket;

    await chat(t, 0, {});
    await chat(t, 0, { text: "hi", phrase: "nice" });
    await chat(t, 0, { text: "  " }); // trims to empty — same as absent
    await chat(t, 0, { text: "x".repeat(201) });

    expect(ws.msgs("rejected").every((m) => m.payload.code === "chatRefused")).toBe(true);
    expect(ws.msgs("rejected")).toHaveLength(4);
    expect(ws.msgs("chat")).toHaveLength(0);

    // Exactly 200 is fine.
    await chat(t, 0, { text: "y".repeat(200) });
    expect(ws.msgs("chat")).toHaveLength(1);
  });

  it("a bot-marked seat cannot chat even if a socket is attached to it", async () => {
    const t = await seated({ botSeats: [3], config: { turnMs: 10_000_000 } });
    // A socket attached to the bot seat, same shape /leave's own test uses
    // ("makeHeader's bot seats still carry a playerId" — and a token).
    const botWs = await join(t, 3);
    await chat(t, 3, { text: "hello" });

    expect(botWs.msgs("rejected")).toHaveLength(1);
    expect(botWs.msgs("rejected")[0]!.payload.code).toBe("chatRefused");
    const other = t.sockets[0] as StubSocket;
    expect(other.msgs("chat")).toHaveLength(0);
  });

  it("enforces a 1-message-per-second-per-seat cadence on top of the general limiter", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    const ws = t.sockets[1] as StubSocket;

    await chat(t, 1, { text: "one" });
    await chat(t, 1, { text: "two" }); // same tick — too soon
    expect(ws.msgs("chat")).toHaveLength(1);
    expect(ws.msgs("rejected")).toHaveLength(1);
    expect(ws.msgs("rejected")[0]!.payload.code).toBe("chatRefused");

    t.clock.now += 999;
    await chat(t, 1, { text: "still too soon" });
    expect(ws.msgs("chat")).toHaveLength(1);

    t.clock.now += 1;
    await chat(t, 1, { text: "now" }); // exactly 1000ms later is fine
    expect(ws.msgs("chat")).toHaveLength(2);

    // A DIFFERENT seat's cadence is untouched by seat 1's limiter.
    await chat(t, 2, { text: "seat 2 speaks" });
    expect((t.sockets[2] as StubSocket).msgs("chat")).toHaveLength(3); // its own + seat1's two
  });

  it("gives a joiner and a reconnecting seat the last 50 messages, oldest first", async () => {
    const t = await makeTable({ config: { turnMs: 10_000_000 } });
    await join(t, 0);
    await join(t, 1);
    await join(t, 2);
    await chat(t, 0, { text: "first" });
    t.clock.now += 1_100;
    await chat(t, 1, { text: "second" });

    // A fresh joiner meets the conversation already in progress.
    const ws3 = await join(t, 3);
    expect(ws3.msgs("welcome")).toHaveLength(1);
    expect(ws3.msgs("welcome")[0]!.payload.chat.map((m) => m.text)).toEqual(["first", "second"]);

    // Reconnect (same seat, same token) — the welcome carries the same history.
    const rejoined = await join(t, 1);
    expect(rejoined.msgs("welcome")[0]!.payload.chat.map((m) => m.text)).toEqual(["first", "second"]);

    // resync's `restore` carries it too.
    await request(t, 2, "resync", { sinceSeq: -1 });
    const restore = (t.sockets[2] as StubSocket).msgs("restore").at(-1);
    expect(restore?.payload.chat.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("keeps only the last 50 messages", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    for (let i = 0; i < 55; i += 1) {
      await chat(t, 0, { text: `m${i}` });
      t.clock.now += 1_100;
    }
    const rejoined = await join(t, 0);
    const texts = rejoined.msgs("welcome")[0]!.payload.chat.map((m) => m.text);
    expect(texts).toHaveLength(50);
    expect(texts[0]).toBe("m5");
    expect(texts[49]).toBe("m54");
  });
});

/* ── 6. determinism ────────────────────────────────────────────────────── */

describe("determinism", () => {
  it("passes the match seed to the reducer and derives no wall seed of its own", async () => {
    // The wall seed belongs to the reducer (`handSeedFor`). A second formula in
    // the DO for the same number is how a replay quietly stops reproducing its
    // match, so the DO hands over the match seed and copies back what it gets.
    const t = await seated({ config: { turnMs: 10_000_000 } });
    expect(t.rules.matchSeed).toBe(20260826);
    const deal = storedEvents(t).find((e) => e.type === "deal");
    if (!deal || deal.type !== "deal") throw new Error("no deal event");
    expect(deal.payload.seed).toBe(stubHandSeed(20260826, 0));
  });

  it("produces byte-identical event streams from identical inputs", async () => {
    const run = async (): Promise<GameEvent[]> => {
      const t = await seated({ botSeats: [1, 2, 3], config: { turnMs: 10_000_000 } });
      const start = t.clock.now;
      await request(t, 0, "requestDiscard", { tile: 0 });
      for (const step of [1_100, 5_100, 6_500, 12_000]) {
        t.clock.now = start + step;
        await t.core.alarm();
      }
      return storedEvents(t);
    };
    const a = await run();
    const b = await run();
    expect(a.length).toBeGreaterThan(3);
    expect(a).toEqual(b);
  });

  it("hands the bot the redacted view and nothing more", async () => {
    const t = await seated({ botSeats: [1, 2, 3], config: { turnMs: 10_000_000 } });
    const start = t.clock.now;
    await request(t, 0, "requestDiscard", { tile: 0 });
    t.clock.now = start + t.bots.pace + 1;
    await t.core.alarm();
    expect(t.bots.decideCalls.length).toBeGreaterThan(0);
    for (const call of t.bots.decideCalls) {
      const forbidden = OTHERS_TILES.filter((tile) => !HANDS[call.seat].includes(tile));
      for (const tile of forbidden) {
        expect(call.sawTiles.includes(tile), `bot at seat ${call.seat} saw tile ${tile}`).toBe(false);
      }
    }
  });
});

/* ── 7. the real reducer ───────────────────────────────────────────────── *
 *
 * Everything above drives a toy reducer, which proves the DO's coordination in
 * isolation. This block proves the seam itself: that `TableRules` is the shape
 * engine/src/reducer.ts already exports, and that a whole hand of real Hong
 * Kong mahjong runs through the object and lands in the archive.
 */

describe("binding to engine/src/reducer.ts", () => {
  it("satisfies the rules port with no adapter", () => {
    // The assignment IS the test: if the reducer's exports drift from the port
    // this file stops compiling, which is a far better failure than a runtime
    // one in production. Method-syntax members make the parameter bivariance
    // that lets `MatchState` stand in for `GameState` explicit and intended.
    const bound: TableRules = engine;
    expect(typeof bound.startMatch).toBe("function");
    expect(typeof bound.startNextHand).toBe("function");
    expect(typeof bound.applyAction).toBe("function");
    expect(typeof bound.legalActions).toBe("function");
  });

  it("plays a whole hand through the object and archives it", async () => {
    const ctx = new StubCtx();
    const archive = new StubArchive();
    const clock = { now: 1_700_000_000_000 };
    const core = new TableCore(ctx, {}, {
      rules: engine,
      bots: new StubBots(),
      archive,
      clock: () => clock.now,
    });
    const init: TableInit = {
      matchId: MATCH_ID,
      header: makeHeader([0, 1, 2, 3]),
      seed: 20260826,
      seatTokens: TOKENS,
    };
    const res = await core.fetch(
      new Request("https://table.invalid/table/init", {
        method: "POST",
        body: JSON.stringify(init),
      }),
    );
    expect(res.status).toBe(200);

    // Four bots and no humans: the table starts itself and runs on the alarm.
    for (let tick = 0; tick < 4_000 && archive.handLogs.length === 0; tick++) {
      const at = ctx.storage.alarm;
      if (at === null) break;
      clock.now = Math.max(clock.now + 1, at);
      await core.alarm();
    }

    expect(archive.handLogs).toHaveLength(1);
    const log = archive.handLogs[0].log;
    expect(log.header.engineVersion).toBe(engine.ENGINE_VERSION);
    expect(log.events[0].type).toBe("deal");
    expect(log.events.at(-1)?.type).toBe("handEnd");
    // Contiguous seq is the DO's stamp, not the reducer's — a gap is corruption.
    expect(log.events.map((e) => e.seq)).toEqual(log.events.map((_, i) => i));
    expect(log.events.every((e) => e.matchId === MATCH_ID)).toBe(true);
    expect(log.events.every((e) => e.handIndex === 0)).toBe(true);

    const row = archive.results[0];
    expect(row.handIndex).toBe(0);
    expect(["win", "exhaustive_draw"]).toContain(row.outcome);
    expect(row.chipDeltas.reduce((a, b) => a + b, 0)).toBe(0);
    expect(row.eventCount).toBe(log.events.length);
    // The hand is forgotten only because both sinks confirmed.
    expect(ctx.storage.keysWithPrefix("ev:0000:")).toHaveLength(0);
    expect(ctx.storage.keysWithPrefix("ob:0000")).toHaveLength(0);
  });

  /**
   * Cloudflare's Durable Object row-write quota (Workers Free: 100k/day) is
   * charged one row per KEY per `storage.put` call — `StubStorage.putKeyLog`
   * (above) mirrors that exactly. Before `persistCore`/`commit` diffed
   * against `lastWritten`, `persistCore` wrote all seven core keys on every
   * commit AND again, unconditionally, at the end of `afterCommit`, plus
   * again before every alarm dispatch — measured directly against this SAME
   * driver (same seed, same bots), that cost 2,962 rows for a 231-event
   * hand, so the number below is measured here, not asserted from memory.
   */
  it("writes fewer than half the storage rows for a whole hand than before persistCore diffed", async () => {
    const ctx = new StubCtx();
    const archive = new StubArchive();
    const clock = { now: 1_700_000_000_000 };
    const core = new TableCore(ctx, {}, {
      rules: engine,
      bots: new StubBots(),
      archive,
      clock: () => clock.now,
    });
    const init: TableInit = {
      matchId: MATCH_ID,
      header: makeHeader([0, 1, 2, 3]),
      seed: 20260826,
      seatTokens: TOKENS,
    };
    const res = await core.fetch(
      new Request("https://table.invalid/table/init", {
        method: "POST",
        body: JSON.stringify(init),
      }),
    );
    expect(res.status).toBe(200);

    for (let tick = 0; tick < 4_000 && archive.handLogs.length === 0; tick++) {
      const at = ctx.storage.alarm;
      if (at === null) break;
      clock.now = Math.max(clock.now + 1, at);
      await core.alarm();
    }
    expect(archive.handLogs).toHaveLength(1);

    const rowsWritten = ctx.storage.putKeyLog.length;
    const eventCount = archive.results[0]!.eventCount;
    // Measured baseline BEFORE persistCore diffed (commit `c46c9dc`'s
    // table.ts, before this change): this exact driver, same seed, wrote
    // 2,962 rows for a 231-event hand. Half of that, rounded down, is the
    // bar the diffed implementation must clear.
    const BASELINE_ROWS_BEFORE_DIFFING = 2_962;
    console.log(
      `[row-write budget] one hand: ${eventCount} events, ${rowsWritten} storage rows written ` +
        `(baseline before diffing: ${BASELINE_ROWS_BEFORE_DIFFING}, ` +
        `${((rowsWritten / BASELINE_ROWS_BEFORE_DIFFING) * 100).toFixed(1)}% of baseline)`,
    );
    expect(rowsWritten).toBeLessThanOrEqual(Math.floor(BASELINE_ROWS_BEFORE_DIFFING / 2));
  });

  it("keeps the omniscient wall out of every seat view of a real hand", async () => {
    const ctx = new StubCtx();
    const clock = { now: 1_700_000_000_000 };
    const core = new TableCore(ctx, {}, {
      rules: engine,
      bots: new StubBots(),
      archive: new StubArchive(),
      clock: () => clock.now,
    });
    await core.fetch(
      new Request("https://table.invalid/table/init", {
        method: "POST",
        body: JSON.stringify({
          matchId: MATCH_ID,
          header: makeHeader([1, 2, 3]),
          seed: 4242,
          seatTokens: TOKENS,
        } satisfies TableInit),
      }),
    );

    const omniscient = JSON.parse(ctx.storage.map.get("state") as string) as GameState;
    const view = core.viewFor(0);
    expect(view).not.toHaveProperty("wall");
    expect(view.wallRemaining).toBeLessThan(144);

    // Every tile seats 1-3 hold and seat 0 cannot account for from its own hand
    // must be absent from the view. Counting copies is what makes this exact:
    // a tile id seat 0 legitimately holds may also sit in someone else's hand.
    const seen = new Map<number, number>();
    for (const n of collectNumbers(view)) seen.set(n, (seen.get(n) ?? 0) + 1);
    const own = new Map<number, number>();
    const ownSeat = omniscient.seats[0];
    for (const t of [...ownSeat.hand, ...ownSeat.flowers, ...(ownSeat.drawn === null ? [] : [ownSeat.drawn])]) {
      own.set(t, (own.get(t) ?? 0) + 1);
    }
    for (const other of [1, 2, 3] as SeatIndex[]) {
      for (const tile of omniscient.seats[other].hand) {
        if (own.has(tile)) continue;
        // Flowers are laid face up, so they are public by the rules of the game.
        if (tile >= 34) continue;
        expect(seen.has(tile), `seat 0 saw seat ${other}'s tile ${tile}`).toBe(false);
      }
    }
    for (const seat of [1, 2, 3] as SeatIndex[]) {
      expect(view.seats[seat]).not.toHaveProperty("hand");
      expect((view.seats[seat] as OtherSeatView).handCount).toBeGreaterThan(0);
    }
  });
});

/* ── 8. move grading ────────────────────────────────────────────────────── */

describe("move grading", () => {
  it("grades a human's discard, and never a bot's", async () => {
    const t = await seated({ botSeats: [1, 2, 3], config: { turnMs: 10_000_000 } });
    const start = t.clock.now;

    // Seat 0 is the only human at this table. Its discard is submitted
    // through `submit()` on the no-window path — `tallyGrade` must fire
    // before `commit()`, against the PRE-action view.
    await request(t, 0, "requestDiscard", { tile: 0 });
    expect(t.bots.gradeCalls).toEqual([{ seat: 0, action: { type: "discard", seat: 0, tile: 0 } }]);

    // Run the claim window to its close and let the seat that draws next —
    // seat 1, a bot — take its turn. Same clock steps as the determinism
    // test above, which is already proven to carry the match this far.
    for (const step of [1_100, 5_100, 6_500, 12_000]) {
      t.clock.now = start + step;
      await t.core.alarm();
    }
    // The bot did discard (the toy reducer recorded it)…
    expect(t.rules.calls.some((a) => a.type === "discard" && a.seat === 1)).toBe(true);
    // …but nothing about it, or about either bot's claim-window pass, ever
    // reached `grade`. The tally stays exactly the one human decision.
    expect(t.bots.gradeCalls).toHaveLength(1);
    expect(t.bots.gradeCalls[0]!.seat).toBe(0);
  });

  it("never lets a throwing grade reach the game flow", async () => {
    const t = await seated({ config: { turnMs: 10_000_000 } });
    // Shadow the prototype method on this one instance — `submit()` must
    // catch this and keep applying the action regardless.
    t.bots.grade = (): { matched: boolean; gap: number } | null => {
      throw new Error("boom");
    };
    await expect(request(t, 0, "requestDiscard", { tile: 0 })).resolves.toBeUndefined();
    expect(t.rules.calls.some((a) => a.type === "discard" && a.seat === 0)).toBe(true);
  });
});

/* ── 9. bindingArchive — ranked settlement ─────────────────────────────── *
 *
 * `settleRatedMatch` (worker/src/table.ts, called from `bindingArchive`'s
 * `finishMatch`) is the production wiring the rest of this file deliberately
 * never exercises — every other test drives `TableCore` against `StubArchive`
 * so the outbox tests stay decoupled from D1's actual shape. These three
 * tests are the one place `bindingArchive` itself runs, against a small
 * in-memory D1 that actually holds `matches` / `players` / `match_players` /
 * `rating_history` rows.
 */

interface FakeMatchRow { id: string; rated: number }
interface FakePlayerRow { id: string; kind: string; rating: number | null; rating_games: number; rating_season: string | null }
interface FakeMatchPlayerRow {
  match_id: string; seat: number; player_id: string;
  final_chips: number; place: number | null;
  rating_before: number | null; rating_after: number | null;
}
interface FakeRatingHistoryRow {
  id: number; player_id: string; match_id: string | null; kind: string; system: string; season: string;
  rating_before: number; rating_after: number; games_played_before: number; k_factor: number;
  place: number | null; chip_delta: number | null; created_at: string;
}

/**
 * Recognises statements by a distinctive substring rather than parsing SQL —
 * same doctrine as `StubD1` above and db.test.ts's fake D1 — scoped to the
 * handful of statements `bindingArchive.finishMatch` actually issues. An
 * unrecognised statement throws rather than silently no-opping, so a new read
 * or write added to `finishMatch` without teaching this fake fails the test
 * that exercises it instead of passing on a stale fake.
 */
class FakeRatingDB implements D1Like {
  matches: FakeMatchRow[] = [];
  players: FakePlayerRow[] = [];
  matchPlayers: FakeMatchPlayerRow[] = [];
  ratingHistory: FakeRatingHistoryRow[] = [];
  private nextHistoryId = 1;

  prepare(sql: string): D1PreparedLike {
    const self = this;
    let bound: unknown[] = [];
    const stmt: D1PreparedLike = {
      bind(...values: unknown[]) {
        bound = values;
        return stmt;
      },
      async run(): Promise<unknown> {
        self.exec(sql, bound);
        return { success: true };
      },
      async first<T>(): Promise<T | null> {
        const r = self.query(sql, bound);
        return (r[0] as T) ?? null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: self.query(sql, bound) as T[] };
      },
    };
    return stmt;
  }

  private query(sql: string, args: unknown[]): Record<string, unknown>[] {
    if (sql.includes("SELECT rated FROM matches")) {
      const m = this.matches.find((r) => r.id === args[0]);
      return m ? [{ rated: m.rated }] : [];
    }
    if (sql.includes("SELECT id FROM rating_history WHERE match_id")) {
      return this.ratingHistory.filter((r) => r.match_id === args[0]).map((r) => ({ id: r.id }));
    }
    if (sql.includes("FROM match_players mp") && sql.includes("JOIN players p")) {
      return this.matchPlayers
        .filter((mp) => mp.match_id === args[0])
        .sort((a, b) => a.seat - b.seat)
        .map((mp) => {
          const p = this.players.find((pl) => pl.id === mp.player_id);
          return {
            seat: mp.seat,
            player_id: mp.player_id,
            kind: p?.kind ?? "human",
            rating: p?.rating ?? null,
            rating_games: p?.rating_games ?? 0,
          };
        });
    }
    throw new Error(`FakeRatingDB: unrecognised read: ${sql}`);
  }

  private exec(sql: string, args: unknown[]): void {
    if (sql.includes("UPDATE matches") && sql.includes("SET status")) return; // the close-out's own write
    if (sql.includes("SET final_chips")) {
      const [final_chips, place, , , , , , match_id, seat] = args;
      const mp = this.matchPlayers.find((r) => r.match_id === match_id && r.seat === seat);
      if (mp) {
        mp.final_chips = final_chips as number;
        mp.place = place as number | null;
      }
      return;
    }
    if (sql.startsWith("INSERT INTO rating_history")) {
      // `kind` is an inline SQL literal ('match'), not a bound value — see
      // the statement in worker/src/table.ts. 11 bound args, not 12.
      const [
        player_id, match_id, system, season, rating_before, rating_after,
        games_played_before, k_factor, place, chip_delta, created_at,
      ] = args;
      this.ratingHistory.push({
        id: this.nextHistoryId++,
        player_id: player_id as string,
        match_id: match_id as string,
        kind: "match",
        system: system as string,
        season: season as string,
        rating_before: rating_before as number,
        rating_after: rating_after as number,
        games_played_before: games_played_before as number,
        k_factor: k_factor as number,
        place: place as number | null,
        chip_delta: chip_delta as number | null,
        created_at: created_at as string,
      });
      return;
    }
    if (sql.startsWith("UPDATE players SET rating")) {
      const [rating, rating_games, rating_season, id] = args;
      const p = this.players.find((r) => r.id === id);
      if (p) {
        p.rating = rating as number;
        p.rating_games = rating_games as number;
        p.rating_season = rating_season as string;
      }
      return;
    }
    if (sql.startsWith("UPDATE match_players SET rating_before")) {
      const [rating_before, rating_after, match_id, seat] = args;
      const mp = this.matchPlayers.find((r) => r.match_id === match_id && r.seat === seat);
      if (mp) {
        mp.rating_before = rating_before as number;
        mp.rating_after = rating_after as number;
      }
      return;
    }
    throw new Error(`FakeRatingDB: unrecognised write: ${sql}`);
  }
}

class FakeLogsBucket {
  puts: { key: string; value: string }[] = [];
  async put(key: string, value: string): Promise<unknown> {
    this.puts.push({ key, value });
    return undefined;
  }
}

function fakeSummary(matchId: string, overrides: Partial<MatchSummaryRow> = {}): MatchSummaryRow {
  return {
    matchId,
    reason: "windRoundComplete",
    handsPlayed: 8,
    standings: [1200, 1100, 900, 800],
    placements: [1, 2, 3, 4],
    botTakeoverHands: [0, 0, 0, 0],
    movesGraded: [0, 0, 0, 0],
    movesMatched: [0, 0, 0, 0],
    gapSum: [0, 0, 0, 0],
    handLogKeys: [],
    clients: [null, null, null, null],
    endedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Four human seats, all unrated, seeded into `db` for `matchId`. */
function seedRatedMatchPlayers(db: FakeRatingDB, matchId: string): void {
  for (let seat = 0; seat < 4; seat += 1) {
    const playerId = `p${seat}`;
    db.players.push({ id: playerId, kind: "human", rating: null, rating_games: 0, rating_season: null });
    db.matchPlayers.push({
      match_id: matchId, seat, player_id: playerId,
      final_chips: 0, place: null, rating_before: null, rating_after: null,
    });
  }
}

describe("bindingArchive — ranked settlement", () => {
  it("settles a rated match: rating_history, players.rating and match_players.rating_after", async () => {
    const db = new FakeRatingDB();
    const matchId = "rated-match-1";
    db.matches.push({ id: matchId, rated: 1 });
    seedRatedMatchPlayers(db, matchId);
    const env: TableEnv = { DB: db, LOGS: new FakeLogsBucket() };

    await bindingArchive(env).finishMatch(fakeSummary(matchId));

    expect(db.ratingHistory).toHaveLength(4);
    for (const row of db.ratingHistory) {
      expect(row.match_id).toBe(matchId);
      expect(row.kind).toBe("match");
      expect(row.season).toBe("p0-provisional");
      // A brand-new player's before-rating is the engine's INITIAL_RATING —
      // asserted indirectly: after minus before must be a real delta, and the
      // deltas across all four seats conserve to zero (engine/src/rating.ts).
    }
    const deltaSum = db.ratingHistory.reduce((s, r) => s + (r.rating_after - r.rating_before), 0);
    expect(deltaSum).toBe(0);
    // First place gained, last place lost — the ordering `rating.ts` guarantees.
    const byPlace = new Map(db.ratingHistory.map((r) => [r.place, r.rating_after - r.rating_before]));
    expect(byPlace.get(1)!).toBeGreaterThan(0);
    expect(byPlace.get(4)!).toBeLessThan(0);

    for (const mp of db.matchPlayers) {
      expect(mp.rating_before).not.toBeNull();
      expect(mp.rating_after).not.toBeNull();
    }
    for (const p of db.players) {
      expect(p.rating).not.toBeNull();
      expect(p.rating_games).toBe(1);
      expect(p.rating_season).toBe("p0-provisional");
    }
  });

  it("writes nothing for a casual (unrated) match", async () => {
    const db = new FakeRatingDB();
    const matchId = "casual-match-1";
    db.matches.push({ id: matchId, rated: 0 });
    seedRatedMatchPlayers(db, matchId);
    const env: TableEnv = { DB: db, LOGS: new FakeLogsBucket() };

    await bindingArchive(env).finishMatch(fakeSummary(matchId));

    expect(db.ratingHistory).toHaveLength(0);
    for (const p of db.players) {
      expect(p.rating).toBeNull();
      expect(p.rating_games).toBe(0);
    }
    for (const mp of db.matchPlayers) {
      expect(mp.rating_before).toBeNull();
      expect(mp.rating_after).toBeNull();
    }
  });

  it("is idempotent: a second finishMatch call settles nothing further", async () => {
    const db = new FakeRatingDB();
    const matchId = "rated-match-2";
    db.matches.push({ id: matchId, rated: 1 });
    seedRatedMatchPlayers(db, matchId);
    const env: TableEnv = { DB: db, LOGS: new FakeLogsBucket() };

    await bindingArchive(env).finishMatch(fakeSummary(matchId));
    const afterFirst = db.ratingHistory.map((r) => ({ ...r }));
    const ratingsAfterFirst = db.players.map((p) => p.rating);

    await bindingArchive(env).finishMatch(fakeSummary(matchId));

    expect(db.ratingHistory).toHaveLength(4);
    expect(db.ratingHistory).toEqual(afterFirst);
    expect(db.players.map((p) => p.rating)).toEqual(ratingsAfterFirst);
    // rating_games did not tick a second time — the read at the top of
    // `settleRatedMatch` found existing history and skipped everything after.
    for (const p of db.players) expect(p.rating_games).toBe(1);
  });
});

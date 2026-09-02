/**
 * The redaction contract (DESIGN.md §5.3, §5.5).
 *
 * The load-bearing assertion: a seat socket never carries a tile that is still
 * concealed in another seat's hand. mj-queue broadcast its tokens to everyone
 * (ENGINE-AUDIT §4) — this suite exists to keep that from happening again.
 *
 * The fixture gives each seat a DISJOINT set of concealed tiles, so any tile
 * appearing in a stream is attributable to exactly one seat. Public tiles come
 * from a fourth, non-overlapping pool. It is a schema fixture, not a legal
 * hand: hand sizes and claim legality are the engine's tests, not these.
 */
import { describe, expect, it } from "vitest";
import type { GameState, SeatIndex, SeatState, TileId } from "@mjrc/engine";
import {
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  assertEventStreamWellFormed,
  isOwnSeatView,
  omniscientMatchLog,
  redactEventFor,
  redactEventsFor,
  snapshotFor,
  type Actor,
  type EventType,
  type FourSeats,
  type GameEvent,
  type MatchLogHeader,
  type SeatSnapshot,
} from "../src/events.js";
import {
  PROTOCOL_VERSION,
  eventsMessage,
  type SeatDirectoryEntry,
  type ServerToSeat,
  type WelcomePayload,
} from "../src/messages.js";

const MATCH = "match-redaction-fixture";
const TS0 = 1_700_000_000_000;
const SEATS: SeatIndex[] = [0, 1, 2, 3];

/** Concealed tiles, one disjoint block per seat. */
const SECRET: Record<SeatIndex, TileId[]> = {
  0: [0, 1, 2, 3, 4, 5],       // 1-6 萬
  1: [9, 10, 11, 12, 13, 14],  // 1-6 索
  2: [18, 19, 20, 21, 22, 23], // 1-6 筒
  3: [27, 28, 29, 30, 31, 32], // 東南西北 中 發
};
const isSecretOf = (seat: SeatIndex, t: number) => SECRET[seat].includes(t);

type Head = {
  v: typeof EVENT_SCHEMA_VERSION;
  matchId: string;
  handIndex: number;
  seq: number;
  ts: number;
  actor: Actor;
};

let nextSeq = 0;
function head(handIndex: number, actor: Actor): Head {
  const seq = nextSeq++;
  return { v: EVENT_SCHEMA_VERSION, matchId: MATCH, handIndex, seq, ts: TS0 + seq * 1000, actor };
}

const HEADER: MatchLogHeader = {
  v: EVENT_SCHEMA_VERSION,
  matchId: MATCH,
  engineVersion: "engine-test-0",
  rulesetId: "hkos-classic",
  startedAt: TS0,
  players: [
    { playerId: "p0", displayName: "East", seat: 0, bot: false },
    { playerId: "p1", displayName: "South", seat: 1, bot: false },
    { playerId: "p2", displayName: "West", seat: 2, bot: true },
    { playerId: "p3", displayName: "North", seat: 3, bot: true },
  ],
  matchLength: "oneWindRound",
  startingChips: [100, 100, 100, 100],
};

/** Every event type in EVENT_TYPES appears here — the coverage test enforces it. */
const LOG: GameEvent[] = [
  /* ── hand 0: claims, all three kong forms, a refused win, 食糊 ────────── */
  {
    ...head(0, "server"),
    type: "deal",
    payload: {
      seed: 987654321,
      dealer: 0,
      roundWind: 0,
      seatWinds: [0, 1, 2, 3],
      hands: [[0, 1, 2, 34], [9, 10, 11], [18, 19, 20], [27, 28, 29]],
      wallIndex: 52,
      wallRemaining: 92,
    },
  },
  {
    ...head(0, 0),
    type: "flowerReplacement",
    payload: { seat: 0, flower: 34, replacement: 3, wallIndex: 143, wallRemaining: 91 },
  },
  { ...head(0, 1), type: "draw", payload: { seat: 1, tile: 12, wallIndex: 52, wallRemaining: 90 } },
  { ...head(0, 1), type: "discard", payload: { seat: 1, tile: 6, drawAndCut: false } },
  {
    ...head(0, "server"),
    type: "claimOffered",
    payload: { seat: 2, tile: 6, from: 1, options: [{ kind: "pung" }], deadlineTs: TS0 + 5000 },
  },
  {
    ...head(0, 2),
    type: "claimDeclined",
    payload: { seat: 2, tile: 6, from: 1, reason: "pass" },
  },
  { ...head(0, 2), type: "draw", payload: { seat: 2, tile: 21, wallIndex: 53, wallRemaining: 89 } },
  {
    ...head(0, 2),
    type: "concealedKong",
    payload: {
      seat: 2,
      tile: 22,
      meld: { kind: "kong", tiles: [22, 22, 22, 22], from: 2, concealed: true },
    },
  },
  {
    ...head(0, 2),
    type: "kongReplacement",
    payload: { seat: 2, tile: 23, kongKind: "concealed", wallIndex: 142, wallRemaining: 88 },
  },
  { ...head(0, 2), type: "discard", payload: { seat: 2, tile: 7, drawAndCut: true } },
  {
    ...head(0, "server"),
    type: "claimOffered",
    payload: { seat: 3, tile: 7, from: 2, options: [{ kind: "pung" }], deadlineTs: TS0 + 12000 },
  },
  {
    ...head(0, 3),
    type: "claimed",
    payload: {
      seat: 3,
      kind: "pung",
      tile: 7,
      from: 2,
      meld: { kind: "pung", tiles: [7, 7, 7], from: 2, concealed: false },
    },
  },
  {
    ...head(0, 3),
    type: "addedKong",
    payload: {
      seat: 3,
      tile: 7,
      meld: { kind: "kong", tiles: [7, 7, 7, 7], from: 2, concealed: false, addedToPung: true },
    },
  },
  {
    ...head(0, "server"),
    type: "robKongWindow",
    payload: { seat: 3, tile: 7, offeredTo: [0], deadlineTs: TS0 + 15000 },
  },
  {
    ...head(0, "server"),
    type: "claimDeclined",
    payload: { seat: 0, tile: 7, from: 3, reason: "timeout" },
  },
  {
    ...head(0, 3),
    type: "kongReplacement",
    payload: { seat: 3, tile: 30, kongKind: "added", wallIndex: 141, wallRemaining: 87 },
  },
  { ...head(0, 3), type: "discard", payload: { seat: 3, tile: 8, drawAndCut: false } },
  {
    ...head(0, "server"),
    type: "claimOffered",
    payload: { seat: 0, tile: 8, from: 3, options: [{ kind: "win" }], deadlineTs: TS0 + 20000 },
  },
  {
    // Under the 3-faan floor: visible, logged, and NOT a rollback (§5.2).
    ...head(0, 0),
    type: "refusedWin",
    payload: {
      context: {
        seat: 0,
        selfDraw: false,
        from: 3,
        winningTile: 8,
        roundWind: 0,
        seatWind: 0,
        isDealer: true,
      },
      concealed: [0, 1, 2, 3],
      melds: [],
      flowers: [34],
      score: {
        faan: 1,
        rawFaan: 1,
        capped: false,
        awards: [{ id: "allSequences", faan: 1 }],
        legal: false,
      },
      minimumFaan: 3,
      reason: "belowMinimum",
    },
  },
  {
    ...head(0, "server"),
    type: "claimOffered",
    payload: { seat: 1, tile: 8, from: 3, options: [{ kind: "win" }], deadlineTs: TS0 + 20000 },
  },
  {
    ...head(0, 1),
    type: "winOnDiscard",
    payload: {
      context: {
        seat: 1,
        selfDraw: false,
        from: 3,
        winningTile: 8,
        roundWind: 0,
        seatWind: 1,
        isDealer: false,
      },
      concealed: [9, 10, 11, 12, 13, 14],
      melds: [],
      flowers: [],
      score: { faan: 3, rawFaan: 3, capped: false, awards: [{ id: "allSequences", faan: 3 }], legal: true },
    },
  },
  {
    ...head(0, "server"),
    type: "handEnd",
    payload: {
      outcome: "winOnDiscard",
      winner: 1,
      loser: 3,
      faan: 3,
      chipDeltas: [0, 8, 0, -8],
      standings: [100, 108, 100, 92],
      dealerRepeats: false,
      nextDealer: 1,
      nextRoundWind: 0,
    },
  },

  /* ── hand 1: 自摸 ─────────────────────────────────────────────────────── */
  {
    ...head(1, "server"),
    type: "deal",
    payload: {
      seed: 123456789,
      dealer: 1,
      roundWind: 0,
      seatWinds: [3, 0, 1, 2],
      hands: [[0, 1, 2], [9, 10, 11], [18, 19, 20], [27, 28, 29]],
      wallIndex: 52,
      wallRemaining: 92,
    },
  },
  { ...head(1, 0), type: "draw", payload: { seat: 0, tile: 5, wallIndex: 52, wallRemaining: 91 } },
  {
    ...head(1, 0),
    type: "selfDraw",
    payload: {
      context: {
        seat: 0,
        selfDraw: true,
        from: null,
        winningTile: 5,
        roundWind: 0,
        seatWind: 3,
        isDealer: false,
      },
      concealed: [0, 1, 2, 3, 4],
      melds: [],
      flowers: [],
      score: { faan: 4, rawFaan: 4, capped: false, awards: [{ id: "allInTriplets", faan: 4 }], legal: true },
    },
  },
  {
    ...head(1, "server"),
    type: "handEnd",
    payload: {
      outcome: "selfDraw",
      winner: 0,
      loser: null,
      faan: 4,
      chipDeltas: [48, -16, -16, -16],
      standings: [148, 92, 84, 76],
      dealerRepeats: false,
      nextDealer: 2,
      nextRoundWind: 0,
    },
  },

  /* ── hand 2: 流局, then the match closes ─────────────────────────────── */
  {
    ...head(2, "server"),
    type: "deal",
    payload: {
      seed: 555,
      dealer: 2,
      roundWind: 0,
      seatWinds: [2, 3, 0, 1],
      hands: [[0, 1, 2], [9, 10, 11], [18, 19, 20], [27, 28, 29]],
      wallIndex: 52,
      wallRemaining: 92,
    },
  },
  {
    ...head(2, "server"),
    type: "exhaustiveDraw",
    payload: {
      wallRemaining: 0,
      hands: [[0, 1, 2], [9, 10, 11], [18, 19, 20], [27, 28, 29]],
      distanceToReady: [1, 0, 2, 3],
    },
  },
  {
    ...head(2, "server"),
    type: "handEnd",
    payload: {
      outcome: "exhaustiveDraw",
      winner: null,
      loser: null,
      faan: null,
      chipDeltas: [0, 0, 0, 0],
      standings: [148, 92, 84, 76],
      // 流局 repeats the dealer (§4).
      dealerRepeats: true,
      nextDealer: 2,
      nextRoundWind: 0,
    },
  },
  {
    ...head(2, "server"),
    type: "matchEnd",
    payload: {
      reason: "windRoundComplete",
      standings: [148, 92, 84, 76],
      placements: [1, 2, 3, 4],
      handsPlayed: 3,
    },
  },
];

/* ── the leak scanner ──────────────────────────────────────────────────── */

/**
 * Keys whose values are tile ids, anywhere in the tree. Once inside one, every
 * number below it counts — so a tile smuggled into a nested shape is still
 * caught. Numbers outside these keys (seq, ts, seat indices, chips) are
 * deliberately ignored: they collide with the 0-41 tile space.
 */
const TILE_KEYS = new Set([
  "tile", "tiles", "hand", "hands", "flower", "flowers", "discards",
  "replacement", "winningTile", "concealed", "drawn", "with",
]);

function tilesIn(node: unknown, underTileKey = false, out: number[] = []): number[] {
  if (node === null || node === undefined) return out;
  if (typeof node === "number") {
    if (underTileKey) out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const v of node) tilesIn(v, underTileKey, out);
    return out;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      tilesIn(v, underTileKey || TILE_KEYS.has(k), out);
    }
  }
  return out;
}

/** Foreign tiles a redacted event carries, grouped by the seat they belong to. */
function foreignSecrets(viewer: SeatIndex, redacted: unknown): Record<number, number[]> {
  const found: Record<number, number[]> = {};
  for (const t of tilesIn(redacted)) {
    for (const owner of SEATS) {
      if (owner !== viewer && isSecretOf(owner, t)) (found[owner] ??= []).push(t);
    }
  }
  return found;
}

/** The only events allowed to publish another seat's tiles, and whose. */
const REVEAL_TYPES = new Set<EventType>(["winOnDiscard", "selfDraw"]);

/* ── tests ─────────────────────────────────────────────────────────────── */

describe("fixture", () => {
  it("exercises every event type, so the leak scan covers the whole schema", () => {
    const seen = new Set(LOG.map((e) => e.type));
    expect([...EVENT_TYPES].filter((t) => !seen.has(t))).toEqual([]);
  });

  it("is a well-formed stream: no gaps, no silent hand transitions", () => {
    expect(() => assertEventStreamWellFormed(HEADER, LOG, { complete: true })).not.toThrow();
  });

  it("gives each seat a disjoint block of concealed tiles", () => {
    const all = SEATS.flatMap((s) => SECRET[s]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("redacted serializer — the no-leak contract", () => {
  it("never carries a tile still concealed in another seat's hand", () => {
    for (const viewer of SEATS) {
      for (const e of LOG) {
        if (REVEAL_TYPES.has(e.type)) continue; // covered by the reveal test below
        const r = redactEventFor(viewer, e);
        if (r === null) continue;
        const leaked = foreignSecrets(viewer, r);
        expect(
          leaked,
          `seat ${viewer} saw another seat's concealed tiles in ${e.type} (seq ${e.seq})`,
        ).toEqual({});
      }
    }
  });

  it("reveals only the winner's hand when a hand is won", () => {
    const reveals = LOG.filter((e) => REVEAL_TYPES.has(e.type));
    expect(reveals).toHaveLength(2);
    for (const e of reveals) {
      // The winner is in the payload's scoring context, not the envelope alone.
      const winner = (e.payload as { context: { seat: SeatIndex } }).context.seat;
      for (const viewer of SEATS) {
        const r = redactEventFor(viewer, e);
        expect(r).not.toBeNull();
        const leaked = foreignSecrets(viewer, r);
        // Losing hands are never published — a win reveals exactly one hand.
        expect(Object.keys(leaked).map(Number).filter((s) => s !== winner)).toEqual([]);
      }
      // And the reveal really does happen: the winner's tiles reach the table.
      const other = SEATS.find((s) => s !== winner)!;
      expect(tilesIn(redactEventFor(other, e)).some((t) => isSecretOf(winner, t))).toBe(true);
    }
  });

  it("never carries the wall seed — the seed IS the wall", () => {
    const deal = LOG.find((e) => e.type === "deal")!;
    for (const viewer of SEATS) {
      const r = redactEventFor(viewer, deal)!;
      expect(JSON.stringify(r)).not.toContain("seed");
      expect(JSON.stringify(r)).not.toContain("987654321");
    }
  });

  it("still delivers a seat its OWN concealed data", () => {
    // Guards the degenerate pass: a redactor that nulls everything leaks nothing.
    const deal = redactEventFor(0, LOG[0]!)!;
    expect(deal.type).toBe("deal");
    if (deal.type !== "deal") throw new Error("narrowing");
    expect(deal.payload.hands[0]).toEqual([0, 1, 2, 34]);
    expect(deal.payload.hands[1]).toBeNull();
    expect(deal.payload.handCounts).toEqual([4, 3, 3, 3]);

    const draw = redactEventFor(1, LOG[2]!)!;
    if (draw.type !== "draw") throw new Error("narrowing");
    expect(draw.payload.tile).toBe(12);
    expect(redactEventFor(0, LOG[2]!)).toMatchObject({ payload: { tile: null } });
  });

  it("hides a concealed kong 暗槓 from everyone but its owner", () => {
    const kong = LOG.find((e) => e.type === "concealedKong")!;
    const own = redactEventFor(2, kong)!;
    if (own.type !== "concealedKong") throw new Error("narrowing");
    expect(own.payload.tile).toBe(22);
    expect(own.payload.meld.tiles).toEqual([22, 22, 22, 22]);

    const other = redactEventFor(0, kong)!;
    if (other.type !== "concealedKong") throw new Error("narrowing");
    expect(other.payload.tile).toBeNull();
    expect(other.payload.meld.tiles).toBeNull();
    expect(other.payload.meld.concealed).toBe(true);
  });

  it("keeps a flower public but its replacement draw private", () => {
    const fr = LOG.find((e) => e.type === "flowerReplacement")!;
    const other = redactEventFor(3, fr)!;
    if (other.type !== "flowerReplacement") throw new Error("narrowing");
    expect(other.payload.flower).toBe(34);
    expect(other.payload.replacement).toBeNull();
  });

  it("drops claim prompts and their answers for every seat but the one asked", () => {
    // The mere existence of an offer to seat 2 says seat 2 could claim (§5.2).
    const offer = LOG.find((e) => e.type === "claimOffered")!;
    expect(redactEventFor(2, offer)).not.toBeNull();
    expect(redactEventFor(0, offer)).toBeNull();
    expect(redactEventFor(1, offer)).toBeNull();
    expect(redactEventFor(3, offer)).toBeNull();

    const declined = LOG.find((e) => e.type === "claimDeclined")!;
    expect(redactEventFor(2, declined)).not.toBeNull();
    expect(redactEventFor(1, declined)).toBeNull();
  });

  it("tells a seat about its own rob-kong offer and nobody else's", () => {
    const win = LOG.find((e) => e.type === "robKongWindow")!;
    const offered = redactEventFor(0, win)!;
    if (offered.type !== "robKongWindow") throw new Error("narrowing");
    expect(offered.payload.offeredToYou).toBe(true);
    expect(offered.payload).not.toHaveProperty("offeredTo");

    const bystander = redactEventFor(1, win)!;
    if (bystander.type !== "robKongWindow") throw new Error("narrowing");
    expect(bystander.payload.offeredToYou).toBe(false);
  });

  it("gives the refused-win breakdown only to the seat being taught", () => {
    const refused = LOG.find((e) => e.type === "refusedWin")!;
    const own = redactEventFor(0, refused)!;
    if (own.type !== "refusedWin") throw new Error("narrowing");
    expect(own.payload.score?.faan).toBe(1);
    expect(own.payload.score?.legal).toBe(false);
    expect(own.payload.concealed).toEqual([0, 1, 2, 3]);
    expect(own.payload.minimumFaan).toBe(3);

    const other = redactEventFor(2, refused)!;
    if (other.type !== "refusedWin") throw new Error("narrowing");
    // Everyone still learns the refusal happened — it is never a silent rollback.
    expect(other.payload.reason).toBe("belowMinimum");
    expect(other.payload.seat).toBe(0);
    expect(other.payload.score).toBeNull();
    expect(other.payload.concealed).toBeNull();
  });

  it("does not publish the losers' hands on an exhaustive draw 流局", () => {
    const draw = LOG.find((e) => e.type === "exhaustiveDraw")!;
    const r = redactEventFor(1, draw)!;
    if (r.type !== "exhaustiveDraw") throw new Error("narrowing");
    expect(r.payload.hands).toEqual([null, [9, 10, 11], null, null]);
    expect(r.payload.distanceToReady).toEqual([null, 0, null, null]);
  });

  it("drops nothing a seat needs to follow the hand", () => {
    // Public events survive for every seat; only claim traffic is dropped.
    for (const viewer of SEATS) {
      const kept = redactEventsFor(viewer, LOG);
      const dropped = LOG.length - kept.length;
      const claimTraffic = LOG.filter(
        (e) =>
          (e.type === "claimOffered" || e.type === "claimDeclined") && e.payload.seat !== viewer,
      ).length;
      expect(dropped).toBe(claimTraffic);
    }
  });
});

/* ── the redacted snapshot (reconnect) ─────────────────────────────────── */

function seatState(seat: SeatIndex, over: Partial<SeatState> = {}): SeatState {
  return {
    seat,
    wind: seat,
    hand: SECRET[seat].slice(0, 4),
    drawn: null,
    melds: [],
    flowers: [34 + seat],
    discards: [6],
    chips: 100 + seat,
    connected: true,
    ...over,
  };
}

const STATE: GameState = {
  phase: "awaitDiscard",
  seats: [
    seatState(0, { drawn: 5 }),
    seatState(1),
    seatState(2, {
      melds: [{ kind: "kong", tiles: [22, 22, 22, 22], from: 2, concealed: true }],
    }),
    seatState(3, {
      melds: [{ kind: "pung", tiles: [7, 7, 7], from: 2, concealed: false }],
    }),
  ],
  roundWind: 0,
  dealer: 0,
  turn: 0,
  handIndex: 0,
  wall: new Array<TileId>(144).fill(0),
  wallIndex: 52,
  lastDiscard: { tile: 6, from: 3 },
  rulesetId: "hkos-classic",
  engineVersion: "engine-test-0",
};

describe("snapshotFor — own hand, counts for everyone else", () => {
  const snap = snapshotFor(0, STATE, { matchId: MATCH, seq: 41 });

  it("gives the viewer its own tiles", () => {
    const own = snap.seats[0];
    expect(isOwnSeatView(own)).toBe(true);
    if (!isOwnSeatView(own)) throw new Error("narrowing");
    expect(own.hand).toEqual([0, 1, 2, 3]);
    expect(own.drawn).toBe(5);
  });

  it("gives other seats a COUNT and no tile field at all", () => {
    for (const other of [1, 2, 3] as SeatIndex[]) {
      const v = snap.seats[other];
      expect(isOwnSeatView(v)).toBe(false);
      expect(v).not.toHaveProperty("hand");
      expect(v).not.toHaveProperty("drawn");
      expect(v.handCount).toBe(4);
      expect(v.holdingDrawn).toBe(false);
    }
  });

  it("turns another seat's 暗槓 face down but leaves exposed melds alone", () => {
    expect(snap.seats[2].melds[0]!.tiles).toBeNull();
    expect(snap.seats[3].melds[0]!.tiles).toEqual([7, 7, 7]);
  });

  it("publishes the wall COUNT and never the wall order", () => {
    expect(snap.wallRemaining).toBe(92);
    expect(snap).not.toHaveProperty("wall");
    expect(snap.seq).toBe(41);
  });

  it("carries no concealed tile from another seat", () => {
    for (const viewer of SEATS) {
      const s = snapshotFor(viewer, STATE, { matchId: MATCH, seq: 41 });
      expect(foreignSecrets(viewer, s)).toEqual({});
    }
  });
});

/* ── the type-level guard ──────────────────────────────────────────────── */

describe("omniscient data cannot reach a seat socket", () => {
  it("refuses omniscient and unbranded events at compile time", () => {
    const archive = omniscientMatchLog(HEADER, LOG);
    expect(archive.events).toHaveLength(LOG.length);

    // @ts-expect-error omniscient events are archive-only and must never be sent to a seat
    eventsMessage(archive.events);
    // @ts-expect-error raw engine events have not been through redactEventFor
    eventsMessage(LOG);

    // The supported path compiles and is the only one that does.
    const ok: ServerToSeat = eventsMessage(redactEventsFor(0, LOG));
    expect(ok.p).toBe(PROTOCOL_VERSION);
    expect(ok.type).toBe("events");
  });

  it("refuses an unredacted snapshot on a welcome message", () => {
    const directory: FourSeats<SeatDirectoryEntry> = [
      { ...HEADER.players[0], connected: true, auto: false },
      { ...HEADER.players[1], connected: true, auto: false },
      { ...HEADER.players[2], connected: true, auto: false },
      { ...HEADER.players[3], connected: false, auto: false },
    ];
    // Annotating away the brand is the realistic mistake — a helper that types
    // its parameter as the plain snapshot and passes it straight through.
    const stripped: SeatSnapshot = snapshotFor(0, STATE, { matchId: MATCH, seq: 0 });
    const bad: WelcomePayload = {
      matchId: MATCH,
      seat: 0,
      engineVersion: "engine-test-0",
      rulesetId: "hkos-classic",
      directory,
      // @ts-expect-error a snapshot must carry the seat brand from snapshotFor
      snapshot: stripped,
      chat: [],
      paused: null,
    };
    expect(bad.seat).toBe(0);

    const good: WelcomePayload = {
      matchId: MATCH,
      seat: 0,
      engineVersion: "engine-test-0",
      rulesetId: "hkos-classic",
      directory,
      snapshot: snapshotFor(0, STATE, { matchId: MATCH, seq: 0 }),
      chat: [],
      paused: null,
    };
    expect(good.snapshot.seat).toBe(0);
  });
});

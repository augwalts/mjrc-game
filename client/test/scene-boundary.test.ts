/**
 * The renderer boundary, asserted.
 * Spec: sketches/RENDERING.md §7; redaction rules from DESIGN.md §5.3/§5.5 as
 * implemented in protocol/src/events.ts. Terminology: ../../TERMINOLOGY.md.
 *
 * THE PROPERTY: a scene never receives another seat's concealed tiles.
 *
 * It is asserted end to end — omniscient events go in one side, through the
 * real `redactEventFor`, into a real `MatchScene`, and every tile that came out
 * the other side is checked against tiles that were never anyone's business but
 * their owner's. Asserting the redactor alone would not do: the leak this
 * guards against is a renderer being handed something it was never meant to
 * draw, and that is a property of the whole path.
 *
 * The fixture partitions the tile space by seat so a leak is unmissable:
 *   seat 0 (the viewer) — 萬 characters and 索 bamboo 1-4
 *   seat 1 SECRET       — 索 bamboo 5-9
 *   seat 2 SECRET       — 筒 circles 2-9
 *   seat 3 SECRET       — winds and dragons
 * Anything public in the fixture (the discard, the claimed pung, the 加槓, the
 * 花) is drawn from OUTSIDE every secret set, so a secret id appearing anywhere
 * downstream can only have got there by leaking.
 */
import { describe, expect, it } from "vitest";
import type {
  GameState,
  Meld,
  ScoreResult,
  SeatIndex,
  SeatState,
  TileId,
  WinContext,
} from "@mjrc/engine";
import {
  EVENT_SCHEMA_VERSION,
  isOwnSeatView,
  redactEventFor,
  snapshotFor,
} from "@mjrc/protocol";
import type { FourSeats, GameEvent } from "@mjrc/protocol";
import { NullScene, tilesIn } from "../src/scene/MatchScene.js";
import type { SceneEvent, SceneOpts, SeatView } from "../src/scene/types.js";

/* ── fixture ───────────────────────────────────────────────────────────── */

const VIEWER: SeatIndex = 0;

/** 萬 1-9 plus 索 1-4. The only hand the viewer is entitled to. */
const OWN_HAND: TileId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** 索 5-9. Stays concealed for the whole fixture. */
const SEAT1_SECRET: TileId[] = [13, 14, 15, 16, 17];
/** 筒 2-9. 筒1 (18) is deliberately excluded — seat 2 kongs it in public. */
const SEAT2_SECRET: TileId[] = [19, 20, 21, 22, 23, 24, 25, 26];
/** Winds and dragons. */
const SEAT3_SECRET: TileId[] = [27, 28, 29, 30, 31, 32, 33];

const ALL_SECRETS = new Set<TileId>([...SEAT1_SECRET, ...SEAT2_SECRET, ...SEAT3_SECRET]);

/** 萬3 — the viewer's own discard, and what seat 1 pungs. Public by definition. */
const PUBLIC_DISCARD: TileId = 2;
/** 筒1 — seat 2's exposed pung, then its 加槓. Public by necessity: it can be robbed. */
const PUBLIC_KONG_TILE: TileId = 18;
/** 梅 — 花 is laid face up in front of the seat. */
const PUBLIC_FLOWER: TileId = 34;

const HANDS: FourSeats<TileId[]> = [
  OWN_HAND,
  [PUBLIC_DISCARD, PUBLIC_DISCARD, 13, 14, 15, 16, 17, 13, 14, 15, 16, 17, 13],
  [PUBLIC_KONG_TILE, PUBLIC_KONG_TILE, PUBLIC_KONG_TILE, 19, 20, 21, 22, 23, 24, 25, 26, 19, 20],
  [27, 28, 29, 30, 31, 31, 31, 31, 32, 33, 27, 28, 29],
];

const meld = (kind: Meld["kind"], tiles: TileId[], from: SeatIndex, concealed = false): Meld => ({
  kind,
  tiles,
  from,
  concealed,
});

const SCORE: ScoreResult = { faan: 2, rawFaan: 2, capped: false, awards: [], legal: false };

const ctx = (seat: SeatIndex, over: Partial<WinContext> = {}): WinContext => ({
  seat,
  selfDraw: false,
  from: 0,
  winningTile: 33,
  roundWind: 0,
  seatWind: seat,
  isDealer: seat === 0,
  ...over,
});

let seq = 0;
/** Envelope boilerplate. `ts` is fixed — a test must not depend on wall time. */
const ev = <T extends GameEvent["type"]>(
  type: T,
  actor: SeatIndex | "server",
  payload: unknown,
): GameEvent =>
  ({
    v: EVENT_SCHEMA_VERSION,
    matchId: "m-boundary",
    handIndex: 0,
    seq: seq++,
    ts: 1_700_000_000_000 + seq,
    actor,
    type,
    payload,
  }) as GameEvent;

/**
 * A hand that exercises every redaction branch: a deal, another seat's 花
 * replacement, another seat's draw, a claim offered to somebody else, a 暗槓,
 * a 加槓 and its replacement draw, a 搶槓 window, a refused win, and 流局.
 */
function scriptedHand(): GameEvent[] {
  seq = 0;
  return [
    ev("deal", "server", {
      seed: 20260826,
      dealer: 0,
      roundWind: 0,
      seatWinds: [0, 1, 2, 3],
      hands: HANDS,
      wallIndex: 52,
      wallRemaining: 92,
    }),
    // 花 replacement for seat 3: the flower is public, the replacement is not.
    ev("flowerReplacement", "server", {
      seat: 3,
      flower: PUBLIC_FLOWER,
      replacement: 30,
      wallIndex: 53,
      wallRemaining: 91,
    }),
    ev("draw", "server", { seat: 1, tile: 13, wallIndex: 54, wallRemaining: 90 }),
    ev("discard", 0, { seat: 0, tile: PUBLIC_DISCARD, drawAndCut: false }),
    // Offered to seat 2, not to the viewer. Must be dropped ENTIRELY.
    ev("claimOffered", "server", {
      seat: 2,
      tile: PUBLIC_DISCARD,
      from: 0,
      options: [{ kind: "pung" }],
      deadlineTs: 1_700_000_005_000,
    }),
    ev("claimDeclined", 2, { seat: 2, tile: PUBLIC_DISCARD, from: 0, reason: "outranked" }),
    ev("claimed", 1, {
      seat: 1,
      kind: "pung",
      tile: PUBLIC_DISCARD,
      from: 0,
      meld: meld("pung", [PUBLIC_DISCARD, PUBLIC_DISCARD, PUBLIC_DISCARD], 0),
    }),
    // 暗槓 lies face down. Its identity is seat 3's alone until the hand ends.
    ev("concealedKong", 3, {
      seat: 3,
      tile: 31,
      meld: meld("kong", [31, 31, 31, 31], 3, true),
    }),
    ev("addedKong", 2, {
      seat: 2,
      tile: PUBLIC_KONG_TILE,
      meld: {
        ...meld("kong", [PUBLIC_KONG_TILE, PUBLIC_KONG_TILE, PUBLIC_KONG_TILE, PUBLIC_KONG_TILE], 1),
        addedToPung: true,
      },
    }),
    ev("robKongWindow", "server", {
      seat: 2,
      tile: PUBLIC_KONG_TILE,
      offeredTo: [0],
      deadlineTs: 1_700_000_010_000,
    }),
    ev("kongReplacement", "server", {
      seat: 2,
      tile: 19,
      kongKind: "added",
      wallIndex: 55,
      wallRemaining: 89,
    }),
    // A win under the 3-faan floor, declared on the viewer's discard. The
    // breakdown is seat 3's teaching moment and goes only to seat 3.
    ev("refusedWin", 3, {
      context: ctx(3, { winningTile: PUBLIC_DISCARD, from: 0 }),
      concealed: SEAT3_SECRET,
      melds: [meld("kong", [31, 31, 31, 31], 3, true)],
      flowers: [PUBLIC_FLOWER],
      score: SCORE,
      minimumFaan: 3,
      reason: "belowMinimum",
    }),
    // 流局 does not license publishing the losers' hands.
    ev("exhaustiveDraw", "server", {
      wallRemaining: 0,
      hands: HANDS,
      distanceToReady: [1, 2, 0, 3],
    }),
    ev("handEnd", "server", {
      outcome: "exhaustiveDraw",
      winner: null,
      loser: null,
      faan: null,
      chipDeltas: [0, 0, 0, 0],
      standings: [100, 100, 100, 100],
      dealerRepeats: true,
      nextDealer: 0,
      nextRoundWind: 0,
    }),
  ];
}

const OPTS: SceneOpts = { seat: VIEWER, scatterSeed: 4242, timeScale: 0 };

/** Feed a scripted hand through the real redactor into a real scene. */
function runInto(scene: NullScene, events: GameEvent[]): number {
  const el = { nodeName: "DIV" } as unknown as HTMLElement;
  scene.mount(el, OPTS);
  let dropped = 0;
  for (const e of events) {
    const r = redactEventFor(VIEWER, e);
    if (r === null) {
      dropped++;
      continue;
    }
    scene.applyEvent(r satisfies SceneEvent);
  }
  return dropped;
}

/* ── tile harvesting ───────────────────────────────────────────────────── */

/**
 * Every field name anywhere in the protocol that can hold a tile id. The walk
 * is by KEY rather than by type so it keeps working when a payload grows a new
 * tile-bearing field — a new field named for tiles is caught automatically, and
 * one named something else is caught by the descriptor check below.
 */
const TILE_KEYS = new Set([
  "tile",
  "tiles",
  "hand",
  "hands",
  "concealed",
  "discards",
  "flower",
  "flowers",
  "replacement",
  "winningTile",
  "with",
]);

/** Deep-harvest every tile id reachable through a tile-named field. */
function harvestTiles(x: unknown, underTileKey = false, out: TileId[] = []): TileId[] {
  if (typeof x === "number") {
    if (underTileKey) out.push(x);
    return out;
  }
  if (Array.isArray(x)) {
    for (const v of x) harvestTiles(v, underTileKey, out);
    return out;
  }
  if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x)) harvestTiles(v, underTileKey || TILE_KEYS.has(k), out);
  }
  return out;
}

const leaked = (tiles: readonly TileId[]): TileId[] => [
  ...new Set(tiles.filter((t) => ALL_SECRETS.has(t))),
];

/* ── table state fixture ───────────────────────────────────────────────── */

const seatState = (i: SeatIndex, hand: TileId[], melds: Meld[] = []): SeatState => ({
  seat: i,
  wind: i,
  hand,
  drawn: null,
  melds,
  flowers: i === 3 ? [PUBLIC_FLOWER] : [],
  discards: i === 0 ? [PUBLIC_DISCARD] : [],
  chips: 100,
  connected: true,
});

/** Mid-hand, seat 3 sitting on a 暗槓. 52 tiles dealt, so 92 live. */
const tableState = (): GameState => ({
  phase: "awaitDiscard",
  seats: [
    seatState(0, OWN_HAND),
    seatState(1, HANDS[1]),
    seatState(2, HANDS[2]),
    seatState(3, HANDS[3], [meld("kong", [31, 31, 31, 31], 3, true)]),
  ],
  roundWind: 0,
  dealer: 0,
  turn: 0,
  handIndex: 0,
  wall: new Array<TileId>(144).fill(0),
  wallIndex: 52,
  lastDiscard: { tile: PUBLIC_DISCARD, from: 0 },
  rulesetId: "hkos-standard",
  engineVersion: "test",
});

/* ── the tests ─────────────────────────────────────────────────────────── */

describe("scene boundary: no seat ever sees another seat's concealed tiles", () => {
  it("harvests nothing secret from what the scene was handed", () => {
    const events = scriptedHand();

    // The canary first: the OMNISCIENT stream is full of secrets. If this ever
    // comes back empty the harvester has stopped looking and every assertion
    // below it is vacuous — a green test that checks nothing is worse than a
    // red one.
    expect(leaked(harvestTiles(events)).length).toBeGreaterThanOrEqual(
      SEAT1_SECRET.length + SEAT2_SECRET.length + SEAT3_SECRET.length,
    );

    const scene = new NullScene();
    runInto(scene, events);

    expect(scene.received.events.length).toBeGreaterThan(0);
    expect(leaked(harvestTiles(scene.received.events))).toEqual([]);
  });

  it("harvests nothing secret from the animation descriptors it queued", () => {
    const scene = new NullScene();
    runInto(scene, scriptedHand());

    const drawn = scene.received.queued.flatMap((q) => tilesIn(q.anim));
    expect(drawn.length).toBeGreaterThan(0);
    expect(leaked(drawn)).toEqual([]);
    // The public tiles DID reach the scene — otherwise the assertion above
    // would pass on an empty renderer and prove nothing.
    expect(drawn).toContain(PUBLIC_DISCARD);
    expect(drawn).toContain(PUBLIC_KONG_TILE);
    expect(drawn).toContain(PUBLIC_FLOWER);
    expect(drawn).toContain(OWN_HAND[5]);
  });

  it("drops another seat's claim window entirely, rather than hiding it", () => {
    const scene = new NullScene();
    const dropped = runInto(scene, scriptedHand());

    // claimOffered and claimDeclined, both addressed to seat 2. A seat that
    // merely SEES that seat 2 was offered a claim has been told seat 2 held
    // one — the exact tell the fixed minimum window exists to prevent.
    expect(dropped).toBe(2);
    expect(scene.received.events.some((e) => e.type === "claimOffered")).toBe(false);
    expect(scene.received.events.some((e) => e.type === "claimDeclined")).toBe(false);
  });

  it("draws a face-down tile for another seat's draw, 花 replacement and 暗槓", () => {
    const scene = new NullScene();
    runInto(scene, scriptedHand());

    const byKind = <K extends string>(k: K) =>
      scene.received.queued.map((q) => q.anim).filter((a) => a.kind === k);

    const draw = byKind("draw")[0];
    expect(draw && draw.kind === "draw" && draw.tile).toBe(null);

    const flower = byKind("flowerReplacement")[0];
    expect(flower && flower.kind === "flowerReplacement" && flower.replacement).toBe(null);
    // The 花 itself is public — it is face up in front of the seat.
    expect(flower && flower.kind === "flowerReplacement" && flower.flower).toBe(PUBLIC_FLOWER);

    const kong = byKind("concealedKong")[0];
    expect(kong && kong.kind === "concealedKong" && kong.tile).toBe(null);
    // The absence is structural: a hidden kong has no slot for a tile at all.
    expect(kong && kong.kind === "concealedKong" && kong.meld.tiles).toBe(null);
  });

  it("keeps a refused win's breakdown to the seat that declared it", () => {
    const scene = new NullScene();
    runInto(scene, scriptedHand());

    const refused = scene.received.queued
      .map((q) => q.anim)
      .find((a) => a.kind === "refusedWin");
    expect(refused).toBeDefined();
    if (refused?.kind !== "refusedWin") throw new Error("wrong descriptor");
    expect(refused.seat).toBe(3);
    expect(refused.concealed).toBe(null);
    expect(refused.score).toBe(null);
    // Everyone still learns THAT a win was refused, and why.
    expect(refused.minimumFaan).toBe(3);
    expect(refused.reason).toBe("belowMinimum");
    // And WHICH tile was declared on. `RedactedRefusedWinPayload.winningTile`
    // is published to every seat unconditionally (protocol/src/events.ts). On a
    // win off a discard, as here, that costs nothing — the tile is already face
    // up in the pile. On a refused 自摸 it discloses one tile that was
    // concealed a moment earlier; the declaration is what exposed it, but the
    // scene must not treat a declared tile as evidence about the rest of the
    // hand. Pinned here so a change to that rule fails loudly.
    expect(refused.winningTile).toBe(PUBLIC_DISCARD);
  });

  it("publishes only the winner's concealed tiles when a hand is won", () => {
    // The one legitimate exception, and it must stay legitimate: the hand is
    // over and the winner's tiles are face up on the table to be scored. The
    // losers' hands are never published, on any path.
    seq = 0;
    const win = ev("selfDraw", 1, {
      context: ctx(1, { selfDraw: true, from: null, winningTile: 13 }),
      concealed: SEAT1_SECRET,
      melds: [meld("pung", [PUBLIC_DISCARD, PUBLIC_DISCARD, PUBLIC_DISCARD], 0)],
      flowers: [],
      score: { ...SCORE, faan: 4, rawFaan: 4, legal: true },
    });

    const scene = new NullScene();
    runInto(scene, [win]);

    const drawn = scene.received.queued.flatMap((q) => tilesIn(q.anim));
    for (const t of SEAT1_SECRET) expect(drawn).toContain(t);
    // ...and nobody else's.
    expect(leaked(drawn).sort((a, b) => a - b)).toEqual([...SEAT1_SECRET]);
  });
});

describe("scene boundary: the authoritative snapshot", () => {
  const view: SeatView = snapshotFor(VIEWER, tableState(), { matchId: "m-boundary", seq: 99 });

  it("gives the viewer its own hand and nobody else's", () => {
    const own = view.seats[VIEWER];
    expect(isOwnSeatView(own)).toBe(true);
    if (!isOwnSeatView(own)) throw new Error("own seat is not an OwnSeatView");
    expect(own.hand).toEqual(OWN_HAND);

    for (const i of [1, 2, 3] as const) {
      const other = view.seats[i];
      expect(isOwnSeatView(other)).toBe(false);
      // Not "null-valued" — absent. There is no field that could hold a tile.
      expect("hand" in other).toBe(false);
      expect("drawn" in other).toBe(false);
      expect(other.handCount).toBe(13);
    }
  });

  it("harvests nothing secret from the other seats' rows", () => {
    expect(leaked(harvestTiles([view.seats[1], view.seats[2], view.seats[3]]))).toEqual([]);
  });

  it("turns another seat's 暗槓 face down in the snapshot", () => {
    const three = view.seats[3];
    expect(isOwnSeatView(three)).toBe(false);
    expect(three.melds[0]?.tiles).toBe(null);
  });

  it("never carries the wall order, only the count", () => {
    expect(view.wallRemaining).toBe(144 - 52);
    expect("wall" in view).toBe(false);
  });
});

describe("scene boundary: the interface refuses omniscient data at compile time", () => {
  it("only accepts events that went through redactEventFor", () => {
    const scene = new NullScene();
    scene.mount({ nodeName: "DIV" } as unknown as HTMLElement, OPTS);

    const raw = scriptedHand()[0]!;
    // A raw GameEvent carries the wall seed and every seat's dealt hand. It has
    // no `__view` brand, so this is a type error — the boundary is enforced by
    // the compiler, not by review. If this line ever stops erroring, tsc fails
    // on the unused directive and this test's whole point has been lost.
    // @ts-expect-error omniscient GameEvent is not SeatVisible<RedactedGameEvent>
    scene.applyEvent(raw);

    // The redacted form is accepted, and the seed did not survive it.
    const redacted = redactEventFor(VIEWER, raw)!;
    scene.applyEvent(redacted);
    expect("seed" in redacted.payload).toBe(false);
    expect(scene.received.queued.at(-1)?.anim.kind).toBe("deal");
  });

  it("flush drops the queue without touching the authoritative view", () => {
    const scene = new NullScene();
    runInto(scene, scriptedHand());
    scene.setView(snapshotFor(VIEWER, tableState(), { matchId: "m-boundary", seq: 99 }));

    expect(scene.received.queued.length).toBeGreaterThan(0);
    scene.flush();
    expect(scene.received.queued).toEqual([]);
    expect(scene.received.views.length).toBe(1);
    expect(scene.received.flushes).toBe(1);
  });

  it("produces the same variant for the same event every time", () => {
    // Hard rule 2's cousin: a resync must not repaint the table differently.
    const a = new NullScene();
    const b = new NullScene();
    runInto(a, scriptedHand());
    runInto(b, scriptedHand());
    expect(a.received.queued.map((q) => q.variant)).toEqual(
      b.received.queued.map((q) => q.variant),
    );
  });
});

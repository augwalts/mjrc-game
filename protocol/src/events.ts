/**
 * Append-only game event schema, v1 — the wire and archive format.
 * Implements DESIGN.md §5.5. State-machine paths come from §5.2, ruleset facts
 * from §4 (HK Old Style). Terminology: ../../TERMINOLOGY.md.
 *
 * Three things this file exists to enforce:
 *
 *  1. NO SILENT TRANSITIONS. Every move the state machine makes emits an event,
 *     including the ones the audited Python log dropped: exercised claim events,
 *     flower and kong replacement draws, an explicit hand end on every path, and
 *     `refusedWin` — a win under the 3-faan minimum is REFUSED VISIBLY, never
 *     rolled back in silence (§5.2 calls it a teaching moment).
 *
 *  2. THE HEADER PINS THE ENGINE. Replay is re-execution, so a scoring bugfix
 *     must never rewrite a hand that was already played: an old hand replays
 *     through the `engineVersion` and `rulesetId` recorded in its own header.
 *
 *  3. TWO SERIALIZERS, NEVER MIXED. `omniscientEvent` (R2 archive, server only)
 *     and `redactEventFor(seat, …)` (live seat sockets) return differently
 *     branded types, so the compiler refuses to let omniscient data reach a
 *     seat socket. Structural typing alone would NOT catch this — an omniscient
 *     payload is a supertype of its redacted form and would assign happily —
 *     so the brand is load-bearing, not decoration.
 */
import type {
  ClaimOption,
  GameState,
  Meld,
  Phase,
  ScoreResult,
  SeatIndex,
  TileId,
  WindIndex,
  WinContext,
} from "@mjrc/engine";

/** Bump only for a breaking change. Readers reject a `v` they do not know. */
export const EVENT_SCHEMA_VERSION = 1;
export type EventSchemaVersion = typeof EVENT_SCHEMA_VERSION;

/** Fixed-length per-seat tuple, indexed by SeatIndex. */
export type FourSeats<T> = [T, T, T, T];

/**
 * Who caused the event: a seat for a voluntary act, "server" for anything the
 * rules or the clock forced. `claimDeclined` is the one that varies — a pass is
 * the seat's, a timeout or a lost priority contest is the server's.
 */
export type Actor = SeatIndex | "server";

/* ── match header ──────────────────────────────────────────────────────── */

export interface PlayerRef {
  playerId: string;
  displayName: string;
  seat: SeatIndex;
  /** Bots are players whose input is a function call (§6). Logged as such. */
  bot: boolean;
}

/**
 * Written once per match, ahead of the events. Everything needed to replay the
 * match by re-execution lives here or in the `deal` events.
 */
export interface MatchLogHeader {
  v: EventSchemaVersion;
  matchId: string;
  /**
   * Pinned build of the rules engine. Old hands replay through the build that
   * produced them; a later bugfix does not silently restate history (§5.5).
   */
  engineVersion: string;
  /** Rulesets are DATA (§4). The id resolves faan table and payment table. */
  rulesetId: string;
  startedAt: number;
  players: FourSeats<PlayerRef>;
  /** Default ranked unit is one wind round 東圈 (§4). */
  matchLength: "oneWindRound" | "fourWindRounds";
  /** Starting chips per seat, so standings are auditable from the log alone. */
  startingChips: FourSeats<number>;
}

/* ── envelope ──────────────────────────────────────────────────────────── */

/** `{ v, matchId, handIndex, seq, ts, actor, type, payload }` — §5.5. */
export interface EventEnvelope<T extends string, P> {
  v: EventSchemaVersion;
  /** On every record, not just the header — the log survives being un-streamed. */
  matchId: string;
  /** 0-based hand within the match. */
  handIndex: number;
  /** Strictly +1 per event across the whole match. A gap is corruption. */
  seq: number;
  /** Unix ms. Per-event, so pacing and claim-window behaviour are analysable. */
  ts: number;
  actor: Actor;
  type: T;
  payload: P;
}

/* ── payloads ──────────────────────────────────────────────────────────── */

export interface DealPayload {
  /**
   * The wall is deterministic from this seed (§5.1), so the archive stores the
   * seed rather than 144 tile ids. NEVER redacted onto a seat socket: it is the
   * entire wall.
   */
  seed: number;
  dealer: SeatIndex;
  /** 圈 prevailing wind. */
  roundWind: WindIndex;
  seatWinds: FourSeats<WindIndex>;
  /**
   * Dealt tiles per seat, flowers included — they have not been replaced yet;
   * the `flowerReplacement` events that follow do that, in strict seat order so
   * re-execution is deterministic (§5.2).
   */
  hands: FourSeats<TileId[]>;
  /** Wall position of the next tile to be taken. */
  wallIndex: number;
  /** Live tiles left after the deal. */
  wallRemaining: number;
}

export interface FlowerReplacementPayload {
  seat: SeatIndex;
  /** 花 — laid face up in front of the seat, so it is public. */
  flower: TileId;
  /**
   * The tile drawn to replace it — concealed, and may itself be a flower, in
   * which case another `flowerReplacement` follows. Recursion is explicit in
   * the log rather than collapsed, so replay never has to guess the order.
   */
  replacement: TileId;
  wallIndex: number;
  wallRemaining: number;
}

export interface DrawPayload {
  seat: SeatIndex;
  tile: TileId;
  wallIndex: number;
  wallRemaining: number;
}

export interface DiscardPayload {
  seat: SeatIndex;
  tile: TileId;
  /** 摸切 drawAndCut — the discard is the tile just drawn, not one from hand. */
  drawAndCut: boolean;
}

export interface ClaimOfferedPayload {
  /** The single seat this offer was sent to. One event per offered seat. */
  seat: SeatIndex;
  tile: TileId;
  from: SeatIndex;
  /** Chow is only ever offered to the seat on the discarder's left (§4). */
  options: ClaimOption[];
  /**
   * The window runs for a fixed minimum however fast the answer comes, so
   * timing never leaks a held claim (§5.2).
   */
  deadlineTs: number;
}

export interface ClaimDeclinedPayload {
  seat: SeatIndex;
  tile: TileId;
  from: SeatIndex;
  /**
   * "outranked" is a real, logged path, not a non-event: the seat had a legal
   * claim and lost the priority contest (win > kong/pung > chow, ties to the
   * nearest seat clockwise from the discarder).
   */
  reason: "pass" | "timeout" | "outranked";
}

export interface ClaimedPayload {
  seat: SeatIndex;
  /** A winning claim resolves to `winOnDiscard`, never to `claimed`. */
  kind: "chow" | "pung" | "kong";
  tile: TileId;
  from: SeatIndex;
  /** 明槓 when kind is "kong" — a kong claimed off a discard is always exposed. */
  meld: Meld;
}

export interface KongReplacementPayload {
  seat: SeatIndex;
  tile: TileId;
  /** Which of the three kong forms triggered this draw. */
  kongKind: "exposed" | "concealed" | "added";
  wallIndex: number;
  wallRemaining: number;
}

export interface ConcealedKongPayload {
  seat: SeatIndex;
  /**
   * 暗槓 lies face down until the hand ends, so the identity is NOT public and
   * the redacted serializer nulls it for every other seat. Some houses turn it
   * face up; that is a ruleset flag, not a change to this schema.
   */
  tile: TileId;
  meld: Meld;
}

export interface AddedKongPayload {
  seat: SeatIndex;
  /**
   * 加槓 is public by necessity: it is the only kong form that can be robbed
   * 搶槓, and the seats that could rob it have to see the tile.
   */
  tile: TileId;
  meld: Meld;
}

export interface RobKongWindowPayload {
  /** The seat declaring the 加槓. */
  seat: SeatIndex;
  tile: TileId;
  /**
   * Win-only claims. Which OTHER seats were offered is the strongest possible
   * tell — it says they are one tile from a win — so it is server-side data.
   */
  offeredTo: SeatIndex[];
  deadlineTs: number;
}

export interface RefusedWinPayload {
  /**
   * The exact scorer input, so the refusal is reproducible under the pinned
   * engine version rather than re-derived by a later reader.
   */
  context: WinContext;
  /** Concealed tiles at the declaration, excluding `context.winningTile`. */
  concealed: TileId[];
  melds: Meld[];
  flowers: TileId[];
  /** `legal` is false here by definition. Kept whole: it is the teaching. */
  score: ScoreResult;
  /** From the ruleset — 3 in canonical HK Old Style (§4). */
  minimumFaan: number;
  /**
   * A malformed declaration (no winning shape, tile not held) is a REJECTED
   * message, not an event — see messages.ts. Only a real, shape-complete hand
   * that falls under the faan floor reaches the log.
   */
  reason: "belowMinimum";
}

export interface WinPayload {
  /** `context.seat` is the winner; the envelope's `actor` mirrors it. */
  context: WinContext;
  /** Concealed tiles at the win, excluding `context.winningTile`. Revealed. */
  concealed: TileId[];
  /** Includes any 暗槓, whose tiles are turned up to be scored. */
  melds: Meld[];
  flowers: TileId[];
  /** What the pinned engineVersion scored. Re-scoring must reproduce it. */
  score: ScoreResult;
}

/** 食糊 — won on another seat's discard, or on a robbed 加槓. */
export interface WinOnDiscardPayload extends WinPayload {
  context: WinContext & { selfDraw: false; from: SeatIndex };
}

/** 自摸 — won on your own draw. Cantonese, not borrowed (TERMINOLOGY.md). */
export interface SelfDrawPayload extends WinPayload {
  context: WinContext & { selfDraw: true; from: null };
}

export interface ExhaustiveDrawPayload {
  /**
   * 流局 — the wall ran out with no winner. 0 under the standard rule; a house
   * ruleset that reserves tiles ends earlier, hence a number, not a literal.
   */
  wallRemaining: number;
  /** Every seat's concealed tiles, for the archive and the replay viewer. */
  hands: FourSeats<TileId[]>;
  /** How far each seat was from ready 聽牌. Research material, derived. */
  distanceToReady: FourSeats<number>;
}

export type HandOutcome = "winOnDiscard" | "selfDraw" | "exhaustiveDraw";

export interface HandEndPayload {
  /** Emitted on EVERY path, including 流局 — the audited log dropped this one. */
  outcome: HandOutcome;
  winner: SeatIndex | null;
  /** Who paid on a win from a discard; 包 liability also resolves to a seat. */
  loser: SeatIndex | null;
  faan: number | null;
  /** Signed chips moved this hand. Sums to zero. */
  chipDeltas: FourSeats<number>;
  /** Cumulative chips after settlement — standings in every footer (§5.5). */
  standings: FourSeats<number>;
  /** 連莊 — the dealer repeats on a dealer win and on 流局 (§4). */
  dealerRepeats: boolean;
  nextDealer: SeatIndex;
  /** Advances when the deal passes East's seat a full cycle (§4). */
  nextRoundWind: WindIndex;
}

export interface MatchEndPayload {
  reason: "windRoundComplete" | "allRoundsComplete" | "abandoned" | "hostEnded";
  standings: FourSeats<number>;
  /** 1-4 by chips; ties break by seat order from the starting dealer. */
  placements: FourSeats<1 | 2 | 3 | 4>;
  handsPlayed: number;
}

/* ── the omniscient event union ────────────────────────────────────────── */

export type DealEvent = EventEnvelope<"deal", DealPayload>;
export type FlowerReplacementEvent = EventEnvelope<"flowerReplacement", FlowerReplacementPayload>;
export type DrawEvent = EventEnvelope<"draw", DrawPayload>;
export type DiscardEvent = EventEnvelope<"discard", DiscardPayload>;
export type ClaimOfferedEvent = EventEnvelope<"claimOffered", ClaimOfferedPayload>;
export type ClaimDeclinedEvent = EventEnvelope<"claimDeclined", ClaimDeclinedPayload>;
export type ClaimedEvent = EventEnvelope<"claimed", ClaimedPayload>;
export type KongReplacementEvent = EventEnvelope<"kongReplacement", KongReplacementPayload>;
export type ConcealedKongEvent = EventEnvelope<"concealedKong", ConcealedKongPayload>;
export type AddedKongEvent = EventEnvelope<"addedKong", AddedKongPayload>;
export type RobKongWindowEvent = EventEnvelope<"robKongWindow", RobKongWindowPayload>;
export type RefusedWinEvent = EventEnvelope<"refusedWin", RefusedWinPayload>;
export type WinOnDiscardEvent = EventEnvelope<"winOnDiscard", WinOnDiscardPayload>;
export type SelfDrawEvent = EventEnvelope<"selfDraw", SelfDrawPayload>;
export type ExhaustiveDrawEvent = EventEnvelope<"exhaustiveDraw", ExhaustiveDrawPayload>;
export type HandEndEvent = EventEnvelope<"handEnd", HandEndPayload>;
export type MatchEndEvent = EventEnvelope<"matchEnd", MatchEndPayload>;

/** Every path the §5.2 state machine can take. Narrow on `type`. */
export type GameEvent =
  | DealEvent
  | FlowerReplacementEvent
  | DrawEvent
  | DiscardEvent
  | ClaimOfferedEvent
  | ClaimDeclinedEvent
  | ClaimedEvent
  | KongReplacementEvent
  | ConcealedKongEvent
  | AddedKongEvent
  | RobKongWindowEvent
  | RefusedWinEvent
  | WinOnDiscardEvent
  | SelfDrawEvent
  | ExhaustiveDrawEvent
  | HandEndEvent
  | MatchEndEvent;

export type EventType = GameEvent["type"];

/** Runtime list, in state-machine order. Kept in step with the union below. */
export const EVENT_TYPES = [
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
  "refusedWin",
  "winOnDiscard",
  "selfDraw",
  "exhaustiveDraw",
  "handEnd",
  "matchEnd",
] as const satisfies readonly EventType[];

type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time proof that EVENT_TYPES lists the whole union, and nothing else. */
const _eventTypesAreComplete: SameKeys<(typeof EVENT_TYPES)[number], EventType> = true;
void _eventTypesAreComplete;

/* ── the seat-visible (redacted) event union ───────────────────────────── */

/**
 * A meld as ANOTHER seat may see it. 暗槓 lies face down, so its tiles are
 * `null` — the absence is structural, not a convention, so a redacted meld
 * simply has no place to put a concealed tile.
 */
export interface HiddenKongView {
  kind: "kong";
  tiles: null;
  from: SeatIndex;
  concealed: true;
}
export type SeatVisibleMeld = Meld | HiddenKongView;

export interface RedactedDealPayload {
  dealer: SeatIndex;
  roundWind: WindIndex;
  seatWinds: FourSeats<WindIndex>;
  /** Own dealt tiles. `null` for every other seat. */
  hands: FourSeats<TileId[] | null>;
  /** What a seat is allowed to know about the others: how many, not which. */
  handCounts: FourSeats<number>;
  wallRemaining: number;
  /* `seed` and `wallIndex` are absent by construction: the seed IS the wall. */
}

export interface RedactedFlowerReplacementPayload {
  seat: SeatIndex;
  flower: TileId;
  /** `null` unless this is your own replacement draw. */
  replacement: TileId | null;
  wallRemaining: number;
}

export interface RedactedDrawPayload {
  seat: SeatIndex;
  tile: TileId | null;
  wallRemaining: number;
}

export interface RedactedKongReplacementPayload {
  seat: SeatIndex;
  tile: TileId | null;
  kongKind: "exposed" | "concealed" | "added";
  wallRemaining: number;
}

export interface RedactedConcealedKongPayload {
  seat: SeatIndex;
  tile: TileId | null;
  meld: SeatVisibleMeld;
}

export interface RedactedRobKongWindowPayload {
  seat: SeatIndex;
  tile: TileId;
  /** Replaces `offeredTo`: you learn about your own offer and nobody else's. */
  offeredToYou: boolean;
  deadlineTs: number;
}

export interface RedactedRefusedWinPayload {
  seat: SeatIndex;
  winningTile: TileId;
  selfDraw: boolean;
  from: SeatIndex | null;
  minimumFaan: number;
  reason: "belowMinimum";
  /** Exposed melds are already on the table; a 暗槓 in them stays face down. */
  melds: SeatVisibleMeld[];
  flowers: TileId[];
  /**
   * The breakdown is the declaring seat's teaching moment and goes only to
   * them; the others see THAT a win was refused, not what the hand held. That
   * is a deliberate departure from table practice, where a short declaration
   * exposes the hand — see the open question in the build report.
   */
  score: ScoreResult | null;
  concealed: TileId[] | null;
}

export interface RedactedExhaustiveDrawPayload {
  wallRemaining: number;
  /** Own tiles only. 流局 does not license publishing the losers' hands. */
  hands: FourSeats<TileId[] | null>;
  distanceToReady: FourSeats<number | null>;
}

export type RedactedGameEvent =
  | EventEnvelope<"deal", RedactedDealPayload>
  | EventEnvelope<"flowerReplacement", RedactedFlowerReplacementPayload>
  | EventEnvelope<"draw", RedactedDrawPayload>
  | DiscardEvent
  | ClaimOfferedEvent
  | ClaimDeclinedEvent
  | ClaimedEvent
  | EventEnvelope<"kongReplacement", RedactedKongReplacementPayload>
  | EventEnvelope<"concealedKong", RedactedConcealedKongPayload>
  | AddedKongEvent
  | EventEnvelope<"robKongWindow", RedactedRobKongWindowPayload>
  | EventEnvelope<"refusedWin", RedactedRefusedWinPayload>
  | WinOnDiscardEvent
  | SelfDrawEvent
  | EventEnvelope<"exhaustiveDraw", RedactedExhaustiveDrawPayload>
  | HandEndEvent
  | MatchEndEvent;

/* ── the view brands ───────────────────────────────────────────────────── */

/**
 * Omniscient data: R2 archive and server-side replay ONLY.
 * The second brand member exists purely so the compiler's error message names
 * the mistake when someone tries to put this on a seat socket.
 */
export type Omniscient<T> = T & {
  readonly __view: "omniscient";
  readonly __neverSendToASeatSocket: true;
};

/** Data that has been through `redactEventFor` / `snapshotFor` for one seat. */
export type SeatVisible<T> = T & { readonly __view: "seat" };

/**
 * The ONLY way to brand seat-visible data. Private on purpose: everything that
 * reaches a seat socket comes out of the redactors below, never out of a cast
 * somewhere else in the codebase.
 */
const asSeatVisible = <T>(x: T): SeatVisible<T> => x as SeatVisible<T>;

/* ── omniscient serializer ─────────────────────────────────────────────── */

/** Identity plus the brand. Server-side and archive only. */
export const omniscientEvent = (e: GameEvent): Omniscient<GameEvent> =>
  e as Omniscient<GameEvent>;

export interface OmniscientMatchLog {
  header: MatchLogHeader;
  events: Omniscient<GameEvent>[];
}

/** The R2 blob shape. Never hand this, or any part of it, to a seat socket. */
export function omniscientMatchLog(
  header: MatchLogHeader,
  events: readonly GameEvent[],
): OmniscientMatchLog {
  return { header, events: events.map(omniscientEvent) };
}

/* ── redacted per-seat serializer ──────────────────────────────────────── */

type EventHead = Pick<GameEvent, "v" | "matchId" | "handIndex" | "seq" | "ts" | "actor">;

const head = (e: GameEvent): EventHead => ({
  v: e.v,
  matchId: e.matchId,
  handIndex: e.handIndex,
  seq: e.seq,
  ts: e.ts,
  actor: e.actor,
});

/** Tuple-preserving map, so per-seat data never degrades to a bare array. */
function four<T, U>(x: FourSeats<T>, f: (v: T, i: SeatIndex) => U): FourSeats<U> {
  return [f(x[0], 0), f(x[1], 1), f(x[2], 2), f(x[3], 3)];
}

/** Turn another seat's 暗槓 face down. Their exposed melds pass through. */
export function hideConcealedKongs(melds: readonly Meld[]): SeatVisibleMeld[] {
  return melds.map((m) =>
    m.kind === "kong" && m.concealed
      ? ({ kind: "kong", tiles: null, from: m.from, concealed: true } satisfies HiddenKongView)
      : m,
  );
}

/**
 * The live-stream serializer. Returns `null` when the seat must not see the
 * event AT ALL — claim prompts and their answers are per-socket, because the
 * mere existence of an offer to seat 2 says seat 2 can claim (§5.2).
 */
export function redactEventFor(
  seat: SeatIndex,
  e: GameEvent,
): SeatVisible<RedactedGameEvent> | null {
  const h = head(e);
  switch (e.type) {
    case "deal": {
      const p = e.payload;
      return asSeatVisible({
        ...h,
        type: "deal",
        payload: {
          dealer: p.dealer,
          roundWind: p.roundWind,
          seatWinds: p.seatWinds,
          hands: four(p.hands, (hand, i) => (i === seat ? hand.slice() : null)),
          handCounts: four(p.hands, (hand) => hand.length),
          wallRemaining: p.wallRemaining,
        },
      });
    }
    case "flowerReplacement": {
      const p = e.payload;
      return asSeatVisible({
        ...h,
        type: "flowerReplacement",
        payload: {
          seat: p.seat,
          flower: p.flower,
          replacement: p.seat === seat ? p.replacement : null,
          wallRemaining: p.wallRemaining,
        },
      });
    }
    case "draw": {
      const p = e.payload;
      return asSeatVisible({
        ...h,
        type: "draw",
        payload: {
          seat: p.seat,
          tile: p.seat === seat ? p.tile : null,
          wallRemaining: p.wallRemaining,
        },
      });
    }
    case "kongReplacement": {
      const p = e.payload;
      return asSeatVisible({
        ...h,
        type: "kongReplacement",
        payload: {
          seat: p.seat,
          tile: p.seat === seat ? p.tile : null,
          kongKind: p.kongKind,
          wallRemaining: p.wallRemaining,
        },
      });
    }
    case "concealedKong": {
      const p = e.payload;
      const own = p.seat === seat;
      return asSeatVisible({
        ...h,
        type: "concealedKong",
        payload: {
          seat: p.seat,
          tile: own ? p.tile : null,
          meld: own ? p.meld : hideConcealedKongs([p.meld])[0],
        },
      });
    }
    case "robKongWindow": {
      const p = e.payload;
      return asSeatVisible({
        ...h,
        type: "robKongWindow",
        payload: {
          seat: p.seat,
          tile: p.tile,
          offeredToYou: p.offeredTo.includes(seat),
          deadlineTs: p.deadlineTs,
        },
      });
    }
    case "refusedWin": {
      const p = e.payload;
      const own = p.context.seat === seat;
      return asSeatVisible({
        ...h,
        type: "refusedWin",
        payload: {
          seat: p.context.seat,
          winningTile: p.context.winningTile,
          selfDraw: p.context.selfDraw,
          from: p.context.from,
          minimumFaan: p.minimumFaan,
          reason: p.reason,
          melds: own ? p.melds.slice() : hideConcealedKongs(p.melds),
          flowers: p.flowers.slice(),
          score: own ? p.score : null,
          concealed: own ? p.concealed.slice() : null,
        },
      });
    }
    case "exhaustiveDraw": {
      const p = e.payload;
      return asSeatVisible({
        ...h,
        type: "exhaustiveDraw",
        payload: {
          wallRemaining: p.wallRemaining,
          hands: four(p.hands, (hand, i) => (i === seat ? hand.slice() : null)),
          distanceToReady: four(p.distanceToReady, (d, i) => (i === seat ? d : null)),
        },
      });
    }
    case "claimOffered":
    case "claimDeclined":
      // Per-socket and private. A seat that sees "seat 2 was offered a claim",
      // or "seat 2 passed", has been told seat 2 held a claim — the exact leak
      // the fixed minimum window in §5.2 exists to prevent.
      return e.payload.seat === seat ? asSeatVisible(e) : null;

    case "winOnDiscard":
    case "selfDraw":
      // The ONLY events that publish another seat's concealed tiles, and they
      // publish exactly the winner's: the hand is over and those tiles are face
      // up on the table to be scored. The losers' hands are never published.
      return asSeatVisible(e);

    case "discard":
    case "claimed":
    case "addedKong":
    case "handEnd":
    case "matchEnd":
      // Wholly public: melds face up, discards face up, standings shared.
      return asSeatVisible(e);
  }
  return assertNever(e, "event type");
}

/** Redact a run of events for one seat, dropping the ones it must not see. */
export function redactEventsFor(
  seat: SeatIndex,
  events: readonly GameEvent[],
): SeatVisible<RedactedGameEvent>[] {
  const out: SeatVisible<RedactedGameEvent>[] = [];
  for (const e of events) {
    const r = redactEventFor(seat, e);
    if (r) out.push(r);
  }
  return out;
}

/* ── redacted snapshot (reconnect) ─────────────────────────────────────── */

/** What one seat may know about another: counts, not tiles (§5.3). */
export interface OtherSeatView {
  seat: SeatIndex;
  wind: WindIndex;
  /** Concealed tile COUNT. There is no field here that could hold a tile. */
  handCount: number;
  /** True while this seat is holding a drawn tile. */
  holdingDrawn: boolean;
  melds: SeatVisibleMeld[];
  flowers: TileId[];
  discards: TileId[];
  chips: number;
  connected: boolean;
}

export interface OwnSeatView extends Omit<OtherSeatView, "melds"> {
  hand: TileId[];
  drawn: TileId | null;
  melds: Meld[];
}

export type AnySeatView = OwnSeatView | OtherSeatView;

/** `own` is a type guard, not a flag to be trusted by eye. */
export const isOwnSeatView = (v: AnySeatView): v is OwnSeatView => "hand" in v;

/**
 * The reconnect payload: fold of everything up to `seq`, redacted. Reconnect is
 * this plus the events since (§5.3, the snapshot + actions-since shape).
 */
export interface SeatSnapshot {
  v: EventSchemaVersion;
  matchId: string;
  engineVersion: string;
  rulesetId: string;
  handIndex: number;
  /** The last event folded in. Ask for events after this one to catch up. */
  seq: number;
  phase: Phase;
  /** The seat this snapshot was built for. */
  seat: SeatIndex;
  roundWind: WindIndex;
  dealer: SeatIndex;
  turn: SeatIndex;
  /** Live tiles left. The wall ORDER never leaves the server. */
  wallRemaining: number;
  lastDiscard: { tile: TileId; from: SeatIndex } | null;
  seats: FourSeats<AnySeatView>;
  standings: FourSeats<number>;
}

/**
 * The other half of the redacted serializer: own hand, all discards, melds and
 * flowers, the wall COUNT, and only the tile counts of other seats (§5.3).
 */
export function snapshotFor(
  seat: SeatIndex,
  state: GameState,
  meta: { matchId: string; seq: number },
): SeatVisible<SeatSnapshot> {
  const view = (s: GameState["seats"][number]): AnySeatView => {
    const base = {
      seat: s.seat,
      wind: s.wind,
      handCount: s.hand.length,
      holdingDrawn: s.drawn !== null,
      flowers: s.flowers.slice(),
      discards: s.discards.slice(),
      chips: s.chips,
      connected: s.connected,
    };
    return s.seat === seat
      ? { ...base, hand: s.hand.slice(), drawn: s.drawn, melds: s.melds.slice() }
      : { ...base, melds: hideConcealedKongs(s.melds) };
  };
  return asSeatVisible({
    v: EVENT_SCHEMA_VERSION,
    matchId: meta.matchId,
    engineVersion: state.engineVersion,
    rulesetId: state.rulesetId,
    handIndex: state.handIndex,
    seq: meta.seq,
    phase: state.phase,
    seat,
    roundWind: state.roundWind,
    dealer: state.dealer,
    turn: state.turn,
    wallRemaining: state.wall.length - state.wallIndex,
    lastDiscard: state.lastDiscard ? { ...state.lastDiscard } : null,
    seats: four(state.seats, (s) => view(s)),
    standings: four(state.seats, (s) => s.chips),
  });
}

/* ── log integrity ─────────────────────────────────────────────────────── */

/**
 * Cheap structural checks the archive writer runs before an R2 put. This is the
 * "no silent transitions" rule made enforceable: a hand that changes index
 * without a `handEnd` behind it is a bug in the state machine, not a log style.
 */
export function assertEventStreamWellFormed(
  header: MatchLogHeader,
  events: readonly GameEvent[],
  opts: { complete?: boolean } = {},
): void {
  if (header.v !== EVENT_SCHEMA_VERSION) {
    throw new Error(`header schema v${header.v}, this reader speaks v${EVENT_SCHEMA_VERSION}`);
  }
  if (!header.engineVersion || !header.rulesetId) {
    throw new Error("header must pin engineVersion and rulesetId — replay is re-execution");
  }
  if (events.length === 0) throw new Error(`${header.matchId}: empty event stream`);
  let prev: GameEvent | null = null;
  for (const e of events) {
    if (e.v !== EVENT_SCHEMA_VERSION) throw new Error(`seq ${e.seq}: schema v${e.v}`);
    if (e.matchId !== header.matchId) {
      throw new Error(`seq ${e.seq}: matchId ${e.matchId} does not match header`);
    }
    if (prev) {
      if (e.seq !== prev.seq + 1) throw new Error(`seq jumped ${prev.seq} -> ${e.seq}`);
      if (e.handIndex < prev.handIndex) throw new Error(`seq ${e.seq}: handIndex went backwards`);
      if (e.handIndex !== prev.handIndex && prev.type !== "handEnd") {
        throw new Error(`seq ${e.seq}: hand ${prev.handIndex} ended on ${prev.type}, not handEnd`);
      }
      if (e.handIndex !== prev.handIndex && e.type !== "deal") {
        throw new Error(`seq ${e.seq}: hand ${e.handIndex} opens on ${e.type}, not deal`);
      }
    } else if (e.type !== "deal") {
      throw new Error(`seq ${e.seq}: a match opens on deal, not ${e.type}`);
    }
    prev = e;
  }
  if (opts.complete && prev && prev.type !== "matchEnd") {
    throw new Error(`${header.matchId}: complete log ends on ${prev.type}, not matchEnd`);
  }
}

/* ── narrowing ─────────────────────────────────────────────────────────── */

/**
 * Exhaustiveness guard. Adding an event type without handling it here becomes a
 * compile error at every switch, which is the point.
 */
export function assertNever(x: never, what = "value"): never {
  throw new Error(`unhandled ${what}: ${JSON.stringify(x)}`);
}

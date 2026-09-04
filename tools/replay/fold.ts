/**
 * THE fold over an event log. Implements the tools/ half of DESIGN.md §8
 * ("log analysis, replay CLI, bot eval") against the §5.5 event schema.
 * Terminology: ../../TERMINOLOGY.md — Hong Kong Old Style only.
 *
 * ── why there is exactly one of these ─────────────────────────────────────
 *
 * The replay viewer, observer mode, the review screens and every analysis
 * pass are the same operation: run the log forward to an index and read the
 * state. If each folds the log its own way they disagree, and they disagree
 * QUIETLY — a viewer that puts a claimed tile in the wrong pile is not a
 * crash, it is a lie about a hand somebody played. So the fold lives here
 * once and every caller takes `foldAt`.
 *
 * ── fold vs. re-execution: both are needed, and they are not the same ─────
 *
 * `replayMatch` in engine/src/reducer.ts re-executes: it feeds actions back
 * through the state machine and REGENERATES the events. That is the authority
 * (§5.5, "replay is re-execution") and it is what `cli.ts --verify` checks
 * against. But it needs the match seed, it needs the match from hand 0, and it
 * only ever lands on the final state.
 *
 * This fold reads the log and nothing else, which buys three things
 * re-execution cannot give:
 *   · a state at EVERY index, cheaply — what a scrubber needs;
 *   · a state from a PARTIAL log — a hand still in flight, a live stream;
 *   · a state from a log whose match seed was never recorded.
 * The two are cross-checked: `cli.ts --verify` asserts the fold and the
 * re-execution agree, which is gate 2 from §3 made testable.
 *
 * ── omniscient and per-seat, from one fold ───────────────────────────────
 *
 * `foldAt` produces the omniscient state. A per-seat view is that state put
 * through `snapshotFor` from protocol/src/events.ts — the SAME redactor the
 * table serves a live socket, so a replay perspective can never be more
 * generous than the game was. Redaction is not reimplemented here.
 *
 * ── determinism (§5.5) ───────────────────────────────────────────────────
 * No Math.random, no Date.now, no iteration over unordered object keys. Seats
 * are visited through fixed arrays and every number comes off the log.
 */

import {
  FLOWERS_START,
  TILE_KINDS,
  WALL_SIZE,
  buildWall,
  type ClaimOption,
  type GameState,
  type Meld,
  type SeatIndex,
  type SeatState,
  type TileId,
  type WindIndex,
} from "@mjrc/engine";
import {
  assertEventStreamWellFormed,
  snapshotFor,
  type FourSeats,
  type GameEvent,
  type HandOutcome,
  type MatchLogHeader,
  type SeatSnapshot,
  type SeatVisible,
} from "@mjrc/protocol";

/* ── the folded state ──────────────────────────────────────────────────── */

/** A log that cannot be folded is corrupt, and says so loudly. */
export class FoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoldError";
  }
}

/** One prompted seat inside a window, and what the LOG says it answered. */
export interface FoldedClaimOffer {
  seat: SeatIndex;
  /** For a 搶槓 window the only claim on offer is a win. */
  options: ClaimOption[];
  /**
   * null while the window is open. "outranked" is a real answer, not a
   * non-answer: the seat held a claim and lost the priority contest.
   */
  answer: "claimed" | "won" | "pass" | "timeout" | "outranked" | "refused" | null;
}

export interface FoldedClaimWindow {
  tile: TileId;
  /** Discarder, or the seat declaring the 加槓. */
  from: SeatIndex;
  /** 搶槓 windows take win claims only. */
  robKong: boolean;
  deadlineTs: number;
  offers: FoldedClaimOffer[];
}

/** A win the faan floor refused (§5.2). Kept: it is the teaching moment. */
export interface FoldedRefusal {
  seq: number;
  seat: SeatIndex;
  winningTile: TileId;
  selfDraw: boolean;
  faan: number;
  minimumFaan: number;
}

/**
 * Scoring detail for a win in flight. `handEnd` carries `faan` but not the
 * breakdown, so the breakdown is carried forward from the win event — which
 * the fold has already applied by then, since the reducer emits the win first.
 */
export interface FoldedWin {
  seat: SeatIndex;
  rawFaan: number;
  capped: boolean;
  awardIds: string[];
  winningTile: TileId;
  /** 搶槓. */
  robbedKong: boolean;
}

/** Everything `--stats` prints for one hand. */
export interface HandSummary {
  handIndex: number;
  outcome: HandOutcome;
  winner: SeatIndex | null;
  loser: SeatIndex | null;
  faan: number | null;
  /** Uncapped total, when a win was taken. */
  rawFaan: number | null;
  /** 爆棚 — the limit applied. */
  capped: boolean;
  awardIds: string[];
  winningTile: TileId | null;
  selfDraw: boolean;
  robbedKong: boolean;
  chipDeltas: FourSeats<number>;
  standings: FourSeats<number>;
  /** 連莊. */
  dealerRepeats: boolean;
  /** Events this hand occupied, deal through handEnd. */
  events: number;
  refusals: number;
}

/**
 * A GameState by construction, plus what a GameState alone cannot carry: the
 * wall's tail pointer, the open window, and the results the log has already
 * delivered. Anything that reads a GameState reads a FoldedState.
 */
export interface FoldedState extends GameState {
  matchId: string;
  /** `seq` of the last event folded, or -1 before the first. */
  seq: number;
  /** Logical clock of the last event folded. */
  ts: number;
  /** Events folded. `foldAt(h, log, n).eventIndex === n`. */
  eventIndex: number;
  /** Events folded since the current hand's deal, that deal included. */
  handEvents: number;
  /** Seed of the hand in play — `buildWall(handSeed)` IS `wall`. */
  handSeed: number;
  /**
   * One past the last live tile. Normal draws come off `wallIndex`, 花 and 槓
   * replacements off `wallEnd` 執尾, so live tiles left is `wallEnd - wallIndex`
   * and NOT `wall.length - wallIndex`.
   */
  wallEnd: number;
  claim: FoldedClaimWindow | null;
  /** True while the tile in `seats[turn].drawn` came off a 槓 replacement. */
  onKongReplacement: boolean;
  lastEventType: GameEvent["type"] | null;
  /** The win this hand, once declared and taken. */
  win: FoldedWin | null;
  /** Refusals in the hand in flight. Cleared by the next deal. */
  refusals: FoldedRefusal[];
  /** Completed hands, in order. */
  hands: HandSummary[];
  /** 1-4, once the match has ended. */
  placements: FourSeats<1 | 2 | 3 | 4> | null;
  matchOver: boolean;
}

/** Live tiles left 牌墻. */
export const liveWallCount = (s: FoldedState): number => s.wallEnd - s.wallIndex;

/* ── small helpers ─────────────────────────────────────────────────────── */

const asc = (a: number, b: number): number => a - b;

function four<T>(f: (i: SeatIndex) => T): FourSeats<T> {
  return [f(0), f(1), f(2), f(3)];
}

function insertSorted(hand: TileId[], tile: TileId): void {
  let i = 0;
  while (i < hand.length && hand[i] <= tile) i++;
  hand.splice(i, 0, tile);
}

function removeOne(hand: TileId[], tile: TileId, where: string): void {
  const i = hand.indexOf(tile);
  if (i < 0) throw new FoldError(`${where}: tile ${tile} is not in the hand to remove`);
  hand.splice(i, 1);
}

const cloneMeld = (m: Meld): Meld => ({
  kind: m.kind,
  tiles: m.tiles.slice(),
  from: m.from,
  concealed: m.concealed,
  ...(m.addedToPung === undefined ? {} : { addedToPung: m.addedToPung }),
});

const cloneSeat = (s: SeatState): SeatState => ({
  seat: s.seat,
  wind: s.wind,
  hand: s.hand.slice(),
  drawn: s.drawn,
  melds: s.melds.map(cloneMeld),
  flowers: s.flowers.slice(),
  discards: s.discards.slice(),
  chips: s.chips,
  connected: s.connected,
});

const cloneOption = (x: ClaimOption): ClaimOption => ({
  kind: x.kind,
  ...(x.with ? { with: x.with.slice() } : {}),
});

const cloneOffer = (o: FoldedClaimOffer): FoldedClaimOffer => ({
  seat: o.seat,
  options: o.options.map(cloneOption),
  answer: o.answer,
});

const cloneSummary = (h: HandSummary): HandSummary => ({
  ...h,
  awardIds: h.awardIds.slice(),
  chipDeltas: [...h.chipDeltas] as FourSeats<number>,
  standings: [...h.standings] as FourSeats<number>,
});

export function cloneFolded(s: FoldedState): FoldedState {
  return {
    ...s,
    seats: [
      cloneSeat(s.seats[0]),
      cloneSeat(s.seats[1]),
      cloneSeat(s.seats[2]),
      cloneSeat(s.seats[3]),
    ],
    // Written once per deal and never mutated, so sharing it by reference is
    // safe and keeps a per-index fold off 144 copies per event.
    wall: s.wall,
    lastDiscard: s.lastDiscard === null ? null : { ...s.lastDiscard },
    claim: s.claim === null ? null : { ...s.claim, offers: s.claim.offers.map(cloneOffer) },
    win: s.win === null ? null : { ...s.win, awardIds: s.win.awardIds.slice() },
    refusals: s.refusals.map((r) => ({ ...r })),
    hands: s.hands.map(cloneSummary),
    placements: s.placements === null ? null : ([...s.placements] as FourSeats<1 | 2 | 3 | 4>),
  };
}

/* ── the seed state ────────────────────────────────────────────────────── */

/**
 * The state before event 0. Seats are empty — nothing has been dealt, and the
 * header is all the fold knows.
 *
 * `connected` is true for every seat because the event schema does not record
 * connection state, and a fold must not invent a fact the log does not carry.
 */
export function initialFoldState(header: MatchLogHeader): FoldedState {
  return {
    phase: "deal",
    seats: four((i) => ({
      seat: i,
      wind: i as WindIndex,
      hand: [],
      drawn: null,
      melds: [],
      flowers: [],
      discards: [],
      chips: header.startingChips[i],
      connected: true,
    })) as FoldedState["seats"],
    roundWind: 0,
    dealer: 0,
    turn: 0,
    handIndex: 0,
    wall: [],
    wallIndex: 0,
    lastDiscard: null,
    rulesetId: header.rulesetId,
    engineVersion: header.engineVersion,

    matchId: header.matchId,
    seq: -1,
    ts: header.startedAt,
    eventIndex: 0,
    handEvents: 0,
    handSeed: 0,
    wallEnd: 0,
    claim: null,
    onKongReplacement: false,
    lastEventType: null,
    win: null,
    refusals: [],
    hands: [],
    placements: null,
    matchOver: false,
  };
}

/* ── one step ──────────────────────────────────────────────────────────── */

/** Fold `drawn` back into the hand so the tiles are one sorted array. */
function absorbDrawn(st: SeatState): void {
  if (st.drawn === null) return;
  insertSorted(st.hand, st.drawn);
  st.drawn = null;
}

/** Every wall-touching payload carries both numbers, so the tail is derivable. */
function setWall(s: FoldedState, wallIndex: number, wallRemaining: number): void {
  s.wallIndex = wallIndex;
  s.wallEnd = wallIndex + wallRemaining;
}

function answerOffer(s: FoldedState, seat: SeatIndex, answer: FoldedClaimOffer["answer"]): void {
  if (!s.claim) return;
  for (const o of s.claim.offers) if (o.seat === seat) o.answer = answer;
}

/**
 * 搶槓 succeeded: the fourth tile comes back off the 加槓, which reverts to the
 * 碰 it grew from. Mirrors `revertAddedKong` in the reducer, because the archive
 * has to show melds as they truly stood, not as they briefly appeared.
 */
function revertAddedKong(s: FoldedState, seat: SeatIndex, tile: TileId): void {
  const st = s.seats[seat];
  const i = st.melds.findIndex(
    (m) => m.kind === "kong" && m.addedToPung === true && m.tiles[0] === tile,
  );
  if (i < 0) throw new FoldError(`seq ${s.seq}: no 加槓 of tile ${tile} to rob at seat ${seat}`);
  st.melds[i] = { kind: "pung", tiles: [tile, tile, tile], from: st.melds[i].from, concealed: false };
}

/** Take a claimed tile off the discarder's pile — it is on the table now. */
function consumeDiscard(s: FoldedState, from: SeatIndex, tile: TileId): void {
  const pile = s.seats[from].discards;
  const i = pile.lastIndexOf(tile);
  if (i >= 0) pile.splice(i, 1);
  s.lastDiscard = null;
}

/**
 * The winner's tiles as the win event publishes them. `payload.concealed`
 * EXCLUDES the winning tile on both paths, so the winning tile goes into
 * `drawn` — the slot that means "the fourteenth tile, held apart". That is
 * exactly what it is, and it is why 144 still balances after a 食糊: the tile
 * left the discarder's pile and has to land somewhere.
 */
function revealWinner(
  s: FoldedState,
  seat: SeatIndex,
  concealed: readonly TileId[],
  melds: readonly Meld[],
  flowers: readonly TileId[],
  winningTile: TileId,
): void {
  const st = s.seats[seat];
  st.hand = concealed.slice().sort(asc);
  st.melds = melds.map(cloneMeld);
  st.flowers = flowers.slice();
  st.drawn = winningTile;
}

/**
 * Fold one event. Pure: `state` is not mutated and a fresh state is returned.
 *
 * PHASE, precisely. A left fold over a prefix knows only what the log has
 * already said, and after a `discard` the log has NOT yet said whether a window
 * opened. So a discard leaves the phase at "awaitDiscard" with `turn` still on
 * the discarder and `lastDiscard` set — "the tile is on the table, nothing has
 * been announced about it" — and a following `claimOffered` moves it to
 * "claimWindow". Guessing either way would show a phase the machine was never
 * in.
 */
export function foldEvent(state: FoldedState, e: GameEvent): FoldedState {
  const s = cloneFolded(state);
  s.seq = e.seq;
  s.ts = e.ts;
  s.eventIndex = state.eventIndex + 1;
  s.handEvents = state.handEvents + 1;
  s.lastEventType = e.type;
  s.handIndex = e.handIndex;

  switch (e.type) {
    case "deal": {
      const p = e.payload;
      s.handSeed = p.seed;
      s.wall = buildWall(p.seed);
      s.dealer = p.dealer;
      s.roundWind = p.roundWind;
      s.turn = p.dealer;
      s.lastDiscard = null;
      s.claim = null;
      s.onKongReplacement = false;
      s.win = null;
      s.refusals = [];
      s.handEvents = 1;
      for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) {
        const st = s.seats[i];
        st.wind = p.seatWinds[i];
        st.hand = p.hands[i].slice().sort(asc);
        st.drawn = null;
        st.melds = [];
        st.flowers = [];
        st.discards = [];
      }
      setWall(s, p.wallIndex, p.wallRemaining);
      // The reducer replaces 花 immediately after dealing, in seat order.
      s.phase = "flowerReplacement";
      return s;
    }

    case "flowerReplacement": {
      const p = e.payload;
      const st = s.seats[p.seat];
      // At the deal the 花 sits in the hand; mid-hand it sits in `drawn`.
      if (st.drawn === p.flower) {
        st.drawn = p.replacement;
      } else {
        removeOne(st.hand, p.flower, `seq ${e.seq} flowerReplacement`);
        insertSorted(st.hand, p.replacement);
      }
      st.flowers.push(p.flower);
      setWall(s, p.wallIndex, p.wallRemaining);
      return s;
    }

    case "draw": {
      const p = e.payload;
      s.claim = null;
      s.turn = p.seat;
      s.seats[p.seat].drawn = p.tile;
      s.onKongReplacement = false;
      setWall(s, p.wallIndex, p.wallRemaining);
      s.phase = "awaitDiscard";
      return s;
    }

    case "discard": {
      const p = e.payload;
      const st = s.seats[p.seat];
      // 摸切 — the discard is the tile just drawn, not one from the hand.
      if (p.drawAndCut) {
        if (st.drawn !== p.tile) {
          throw new FoldError(`seq ${e.seq}: drawAndCut of ${p.tile} but drawn is ${st.drawn}`);
        }
        st.drawn = null;
      } else {
        absorbDrawn(st);
        removeOne(st.hand, p.tile, `seq ${e.seq} discard`);
      }
      st.discards.push(p.tile);
      s.lastDiscard = { tile: p.tile, from: p.seat };
      s.turn = p.seat;
      s.claim = null;
      s.onKongReplacement = false;
      s.phase = "awaitDiscard";
      return s;
    }

    case "claimOffered": {
      const p = e.payload;
      const offer: FoldedClaimOffer = {
        seat: p.seat,
        options: p.options.map(cloneOption),
        answer: null,
      };
      // One event per prompted seat, all on the same tile — collect them.
      if (s.claim && s.claim.tile === p.tile && s.claim.from === p.from && !s.claim.robKong) {
        s.claim.offers.push(offer);
      } else {
        s.claim = { tile: p.tile, from: p.from, robKong: false, deadlineTs: p.deadlineTs, offers: [offer] };
      }
      s.phase = "claimWindow";
      return s;
    }

    case "claimDeclined": {
      answerOffer(s, e.payload.seat, e.payload.reason);
      return s;
    }

    case "claimed": {
      const p = e.payload;
      answerOffer(s, p.seat, "claimed");
      consumeDiscard(s, p.from, p.tile);
      const st = s.seats[p.seat];
      absorbDrawn(st);
      // The claimed tile is one copy of the meld; the rest came out of hand.
      const fromHand = p.meld.tiles.slice();
      const at = fromHand.indexOf(p.tile);
      if (at < 0) throw new FoldError(`seq ${e.seq}: claimed tile ${p.tile} is not in the meld`);
      fromHand.splice(at, 1);
      for (const t of fromHand) removeOne(st.hand, t, `seq ${e.seq} claimed`);
      st.melds.push(cloneMeld(p.meld));
      st.drawn = null;
      s.claim = null;
      s.turn = p.seat;
      s.onKongReplacement = false;
      // 碰 and 上 take the turn with NO draw: the claimed tile is the 14th.
      s.phase = "awaitDiscard";
      return s;
    }

    case "kongReplacement": {
      const p = e.payload;
      s.claim = null;
      s.turn = p.seat;
      s.seats[p.seat].drawn = p.tile;
      s.onKongReplacement = true;
      setWall(s, p.wallIndex, p.wallRemaining);
      s.phase = "awaitDiscard";
      return s;
    }

    case "concealedKong": {
      const p = e.payload;
      const st = s.seats[p.seat];
      absorbDrawn(st);
      for (let n = 0; n < 4; n++) removeOne(st.hand, p.tile, `seq ${e.seq} 暗槓`);
      st.melds.push(cloneMeld(p.meld));
      s.turn = p.seat;
      s.phase = "awaitDiscard";
      return s;
    }

    case "addedKong": {
      const p = e.payload;
      const st = s.seats[p.seat];
      absorbDrawn(st);
      removeOne(st.hand, p.tile, `seq ${e.seq} 加槓`);
      const i = st.melds.findIndex((m) => m.kind === "pung" && m.tiles[0] === p.tile);
      if (i < 0) {
        throw new FoldError(`seq ${e.seq}: no 碰 of tile ${p.tile} to upgrade at seat ${p.seat}`);
      }
      st.melds[i] = cloneMeld(p.meld);
      s.turn = p.seat;
      s.phase = "awaitDiscard";
      return s;
    }

    case "robKongWindow": {
      const p = e.payload;
      s.claim = {
        tile: p.tile,
        from: p.seat,
        robKong: true,
        deadlineTs: p.deadlineTs,
        offers: p.offeredTo.map((seat) => ({
          seat,
          options: [{ kind: "win" } as ClaimOption],
          answer: null,
        })),
      };
      s.phase = "robKongWindow";
      return s;
    }

    case "refusedWin": {
      const p = e.payload;
      answerOffer(s, p.context.seat, "refused");
      s.refusals.push({
        seq: e.seq,
        seat: p.context.seat,
        winningTile: p.context.winningTile,
        selfDraw: p.context.selfDraw,
        faan: p.score.faan,
        minimumFaan: p.minimumFaan,
      });
      // No tiles move: the seat keeps its hand and still owes a discard (§5.2).
      return s;
    }

    case "winOnDiscard": {
      const p = e.payload;
      answerOffer(s, p.context.seat, "won");
      if (p.context.robbedKong) revertAddedKong(s, p.context.from, p.context.winningTile);
      else consumeDiscard(s, p.context.from, p.context.winningTile);
      revealWinner(s, p.context.seat, p.concealed, p.melds, p.flowers, p.context.winningTile);
      s.win = winDetail(p.context.seat, e);
      s.claim = null;
      s.lastDiscard = null;
      s.turn = p.context.seat;
      return s;
    }

    case "selfDraw": {
      const p = e.payload;
      revealWinner(s, p.context.seat, p.concealed, p.melds, p.flowers, p.context.winningTile);
      s.win = winDetail(p.context.seat, e);
      s.claim = null;
      s.turn = p.context.seat;
      return s;
    }

    case "exhaustiveDraw": {
      const p = e.payload;
      for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) {
        const st = s.seats[i];
        st.hand = p.hands[i].slice().sort(asc);
        st.drawn = null;
      }
      s.claim = null;
      return s;
    }

    case "handEnd": {
      const p = e.payload;
      const w = s.win;
      for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) s.seats[i].chips = p.standings[i];
      s.hands.push({
        handIndex: e.handIndex,
        outcome: p.outcome,
        winner: p.winner,
        loser: p.loser,
        faan: p.faan,
        rawFaan: w === null ? null : w.rawFaan,
        capped: w !== null && w.capped,
        awardIds: w === null ? [] : w.awardIds.slice(),
        winningTile: w === null ? null : w.winningTile,
        selfDraw: p.outcome === "selfDraw",
        robbedKong: w !== null && w.robbedKong,
        chipDeltas: [...p.chipDeltas] as FourSeats<number>,
        standings: [...p.standings] as FourSeats<number>,
        dealerRepeats: p.dealerRepeats,
        events: s.handEvents,
        refusals: s.refusals.length,
      });
      s.claim = null;
      s.phase = "handEnd";
      return s;
    }

    case "matchEnd": {
      const p = e.payload;
      for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) s.seats[i].chips = p.standings[i];
      s.placements = [...p.placements] as FourSeats<1 | 2 | 3 | 4>;
      s.matchOver = true;
      s.phase = "matchEnd";
      return s;
    }
  }

  throw new FoldError(`unhandled event type: ${JSON.stringify(e)}`);
}

function winDetail(
  seat: SeatIndex,
  e: Extract<GameEvent, { type: "winOnDiscard" | "selfDraw" }>,
): FoldedWin {
  return {
    seat,
    rawFaan: e.payload.score.rawFaan,
    capped: e.payload.score.capped,
    awardIds: e.payload.score.awards.map((a) => a.id),
    winningTile: e.payload.context.winningTile,
    robbedKong: e.payload.context.robbedKong === true,
  };
}

/* ── folding a run ─────────────────────────────────────────────────────── */

/**
 * State after the first `upTo` events. `upTo` is clamped to the log, so
 * `foldAt(h, log)` is the final state and `foldAt(h, log, 0)` is the seed.
 */
export function foldAt(
  header: MatchLogHeader,
  events: readonly GameEvent[],
  upTo: number = events.length,
): FoldedState {
  const n = Math.max(0, Math.min(upTo, events.length));
  let s = initialFoldState(header);
  for (let i = 0; i < n; i++) s = foldEvent(s, events[i]);
  return s;
}

/**
 * Every state the log passes through: index 0 is before any event, index n is
 * after event n-1, so the array is `events.length + 1` long. This is the
 * scrubber's backing array and what the invariant sweep in fold.test.ts walks.
 * One pass, because `foldEvent` returns a fresh state and never mutates.
 */
export function foldStates(
  header: MatchLogHeader,
  events: readonly GameEvent[],
): FoldedState[] {
  const out: FoldedState[] = [initialFoldState(header)];
  let s = out[0];
  for (const e of events) {
    s = foldEvent(s, e);
    out.push(s);
  }
  return out;
}

/* ── the per-seat view ─────────────────────────────────────────────────── */

/**
 * What ONE seat may see at `upTo`. The redaction is `snapshotFor` from
 * protocol/src/events.ts — the same function the table serves a live socket —
 * so a replay perspective is exactly as generous as the game was and no more.
 */
export function seatSnapshotAt(
  seat: SeatIndex,
  header: MatchLogHeader,
  events: readonly GameEvent[],
  upTo: number = events.length,
): SeatVisible<SeatSnapshot> {
  return seatSnapshotOf(seat, foldAt(header, events, upTo));
}

/**
 * `snapshotFor` reports live tiles as `wall.length - wallIndex`, so the wall it
 * is handed is trimmed to `wallEnd`: tiles past that pointer were taken as 花
 * and 槓 replacements 執尾 and are not live.
 */
export function seatSnapshotOf(seat: SeatIndex, s: FoldedState): SeatVisible<SeatSnapshot> {
  const view: GameState = { ...s, wall: s.wall.slice(0, s.wallEnd) };
  return snapshotFor(seat, view, { matchId: s.matchId, seq: s.seq });
}

/* ── invariants ────────────────────────────────────────────────────────── */

/** Concealed tiles a seat is holding, the drawn tile included. */
export const concealedCount = (st: SeatState): number =>
  st.hand.length + (st.drawn === null ? 0 : 1);

/**
 * Hand SLOTS. A declared set occupies three slots whatever its size, so a kong
 * is four tiles in three slots — which is why a seat holding four kongs still
 * shows 13, and why counting tiles instead of slots gets this wrong.
 */
export const handSlots = (st: SeatState): number => concealedCount(st) + 3 * st.melds.length;

/** Every tile a seat holds or has put on the table. */
export function seatTiles(st: SeatState): TileId[] {
  const out: TileId[] = st.hand.slice();
  if (st.drawn !== null) out.push(st.drawn);
  for (const m of st.melds) for (const t of m.tiles) out.push(t);
  for (const t of st.flowers) out.push(t);
  for (const t of st.discards) out.push(t);
  return out;
}

/** Copies of every tile id across the four seats. Flowers included. */
export function visibleTileCounts(s: FoldedState): number[] {
  const c = new Array<number>(TILE_KINDS).fill(0);
  for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) {
    for (const t of seatTiles(s.seats[i])) c[t]++;
  }
  return c;
}

/** How many copies of `tile` a 144-tile wall holds: 4, or 1 for a 花. */
const copiesOf = (tile: TileId): number => (tile >= FLOWERS_START ? 1 : 4);

/**
 * Every way a folded state can be wrong, as a list of sentences. Empty means
 * the state is consistent with 144 tiles and with the §4 hand shape.
 *
 * The strong one is the reconstitution: the seats' tiles plus the LIVE wall
 * segment must rebuild the wall exactly — four of each scoring kind and one of
 * each 花. A tile can only be in a hand, on the table, or still in the wall, so
 * drift shows up here as a wrong count rather than as a plausible-looking
 * replay.
 */
export function checkFoldInvariants(s: FoldedState): string[] {
  const bad: string[] = [];

  if (s.wallIndex < 0 || s.wallEnd > WALL_SIZE || s.wallIndex > s.wallEnd) {
    bad.push(`wall pointers out of range: [${s.wallIndex}, ${s.wallEnd})`);
  }
  // Nothing has been dealt yet; there is nothing to be consistent with.
  if (s.eventIndex === 0) return bad;

  const c = visibleTileCounts(s);
  let total = 0;
  for (let i = 0; i < c.length; i++) {
    total += c[i];
    if (c[i] > copiesOf(i)) {
      bad.push(`tile ${i} appears ${c[i]} times across the seats, max ${copiesOf(i)}`);
    }
  }

  const live = liveWallCount(s);
  if (live < 0) bad.push(`live wall count is ${live}`);
  if (total + live !== WALL_SIZE) {
    bad.push(`${total} tiles at the seats + ${live} live = ${total + live}, expected ${WALL_SIZE}`);
  }

  if (s.wall.length === WALL_SIZE) {
    const full = c.slice();
    for (let i = s.wallIndex; i < s.wallEnd; i++) full[s.wall[i]]++;
    for (let i = 0; i < full.length; i++) {
      if (full[i] !== copiesOf(i)) {
        bad.push(`tile ${i} reconstitutes to ${full[i]} copies, expected ${copiesOf(i)}`);
      }
    }
  }

  for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) {
    const st = s.seats[i];
    const held = concealedCount(st);
    if (held > 14) bad.push(`seat ${i} holds ${held} concealed tiles, max 14`);
    const slots = handSlots(st);
    if (slots !== 13 && slots !== 14) {
      bad.push(`seat ${i} occupies ${slots} hand slots, expected 13 or 14`);
    }
    if (st.melds.length > 4) bad.push(`seat ${i} has ${st.melds.length} declared sets, max 4`);
  }
  return bad;
}

export function assertFoldInvariants(s: FoldedState): void {
  const bad = checkFoldInvariants(s);
  if (bad.length > 0) {
    throw new FoldError(
      `event ${s.eventIndex} (seq ${s.seq}, after ${s.lastEventType}): ${bad.join("; ")}`,
    );
  }
}

/* ── log files ─────────────────────────────────────────────────────────── */

/** The archive blob, as `omniscientMatchLog` writes it (§5.5). */
export interface MatchLogFile {
  header: MatchLogHeader;
  events: GameEvent[];
}

/**
 * Read a log from JSON `{ header, events }` or from JSONL — header on the
 * first line, one event per line after it. Structure goes through
 * `assertEventStreamWellFormed`, so a gap in `seq`, or a hand that changed
 * index without a `handEnd` behind it, is caught here rather than surfacing
 * later as a puzzling fold error.
 */
export function parseMatchLog(text: string): MatchLogFile {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new FoldError("log file is empty");

  const blob = tryParse(trimmed) as Partial<MatchLogFile> | null;
  let header: MatchLogHeader;
  let events: GameEvent[];

  if (blob !== null) {
    if (!blob.header || !Array.isArray(blob.events)) {
      throw new FoldError("log JSON must be { header, events }");
    }
    header = blob.header;
    events = blob.events;
  } else {
    const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 2) throw new FoldError("log file is neither JSON nor JSONL");
    header = JSON.parse(lines[0]) as MatchLogHeader;
    events = lines.slice(1).map((l) => JSON.parse(l) as GameEvent);
  }

  assertEventStreamWellFormed(header, events);
  return { header, events };
}

/** null when the text is not one JSON value — i.e. when it is JSONL. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

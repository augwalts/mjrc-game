/**
 * Headless match driver shared by the sim tools (watch, evolve). No vitest,
 * no I/O — plays one seeded match with per-seat decision functions and hands
 * back the tallied result.
 */
import type { Action, SeatIndex } from "../../engine/src/types.js";
import {
  startMatch, startNextHand, applyAction, legalActions,
  type MatchState, type Applied, type MatchConfig,
} from "../../engine/src/reducer.js";
import type { SeatView } from "../../engine/src/bots.js";
import { assessSeatThreat } from "../../engine/src/threat.js";

export const SEATS: SeatIndex[] = [0, 1, 2, 3];

export type Decide = (view: SeatView, legal: readonly Action[], seat: SeatIndex) => Action;

export function viewFor(state: MatchState, seat: SeatIndex): SeatView {
  const me = state.seats[seat]!;
  const offered = state.claim;
  return {
    seat, dealer: state.dealer, roundWind: state.roundWind,
    seatWinds: state.seats.map((s) => s.wind),
    hand: me.hand, drawn: me.drawn,
    melds: state.seats.map((s) => s.melds),
    flowers: state.seats.map((s) => s.flowers),
    discards: state.seats.map((s) => s.discards),
    handCounts: state.seats.map((s) => s.hand.length),
    standings: state.seats.map((s) => s.chips),
    dealershipsDone: Math.max(0, state.seats.findIndex((s) => s.wind === 0)),
    wallRemaining: Math.max(0, state.wallEnd - state.wallIndex),
    lastDiscard: offered === null ? state.lastDiscard : { tile: offered.tile, from: offered.from },
  };
}

/** The winner's hand laid face up, as the win event published it. */
export interface WinningHandRecord {
  /** Concealed tiles at the win, excluding the winning tile. */
  concealed: number[];
  melds: { kind: string; tiles: number[] }[];
  winningTile: number;
  awards: { id: string; faan: number }[];
}

/** One hand of a match: how it ended, who won, and the winning hand itself. */
export interface HandRecord {
  outcome: "winOnDiscard" | "selfDraw" | "exhaustiveDraw";
  winner: number | null;
  faan: number | null;
  /** Signed chips moved this hand. Sums to zero. */
  chipDeltas: number[];
  /** Absent on an exhaustive draw 流局. */
  winningHand?: WinningHandRecord;
}

export interface MatchResult {
  /** Final chips per seat. Zero-sum. */
  chips: number[];
  hands: number;
  draws: number;
  wins: number;
  refusedWins: number;
  claims: number;
  faans: number[];
  /** What actually happened: claims by kind, wins by kind, and every scoring
   * pattern that appeared in a winning hand (award id → count). */
  chows: number;
  pungs: number;
  kongs: number;
  winsOnDiscard: number;
  selfDraws: number;
  /** Threat-model scoreboard: of the hands somebody won, how many winners had
   * been flagged (threat > 0.3) by at least one opponent's table read at the
   * moment of the win. Owner priority 2026-08-28. */
  threatWins: number;
  threatFlagged: number;
  patterns: Record<string, number>;
  /** Chips gained on winning hands / bled on losing ones, per seat — the two
   * halves of "maximize chip wins, minimize chip losses". Sum = chips. */
  seatWon: number[];
  seatLost: number[];
  /** Loss attribution: chips paid because THIS seat discarded the winner. */
  seatDealInLoss: number[];
  seatDealInCount: number[];
  /** Chips paid on opponents' self-draws — the tax you cannot dodge by
   * discard discipline alone, only by winning first. */
  seatTaxLoss: number[];
  /** Per-hand detail, only when playMatch is called with recordHands. */
  handRecords?: HandRecord[];
}

export function playMatch(
  config: MatchConfig,
  decide: readonly Decide[],
  opts: { recordHands?: boolean } = {},
): MatchResult {
  let { state, events } = startMatch(config);
  const r: MatchResult = { chips: [0, 0, 0, 0], hands: 0, draws: 0, wins: 0, refusedWins: 0, claims: 0, faans: [],
    chows: 0, pungs: 0, kongs: 0, winsOnDiscard: 0, selfDraws: 0, threatWins: 0, threatFlagged: 0, patterns: {},
    seatWon: [0, 0, 0, 0], seatLost: [0, 0, 0, 0],
    seatDealInLoss: [0, 0, 0, 0], seatDealInCount: [0, 0, 0, 0], seatTaxLoss: [0, 0, 0, 0] };
  if (opts.recordHands) r.handRecords = [];
  /** Win-event detail held until the handEnd that settles it (same batch). */
  let pendingWin: WinningHandRecord | null = null;
  const step = (a: Applied): void => { state = a.state; events = a.events; };

  for (let guard = 0; guard < 200_000; guard++) {
    for (const e of events) {
      if (e.type === "handEnd") {
        r.hands++;
        const p = e.payload as {
          outcome: string; winner?: number | null; faan?: number | null;
          chipDeltas?: number[];
        };
        if (p.outcome === "exhaustiveDraw") r.draws++;
        else { r.wins++; if (typeof p.faan === "number") r.faans.push(p.faan); }
        if (p.chipDeltas) for (const st of SEATS) {
          const d = p.chipDeltas[st] ?? 0;
          if (d > 0) { r.seatWon[st]! += d; continue; }
          r.seatLost[st]! += d;
          if (d < 0) {
            const pay = p as { outcome?: string; loser?: number | null };
            if (pay.outcome === "winOnDiscard" && pay.loser === st) {
              r.seatDealInLoss[st]! += d;
              r.seatDealInCount[st]! += 1;
            } else if (pay.outcome === "selfDraw") {
              r.seatTaxLoss[st]! += d;
            }
          }
        }
        if (r.handRecords) {
          const rec: HandRecord = {
            outcome: p.outcome as HandRecord["outcome"],
            winner: p.winner ?? null,
            faan: p.faan ?? null,
            chipDeltas: (p.chipDeltas ?? [0, 0, 0, 0]).slice(),
          };
          if (pendingWin) rec.winningHand = pendingWin;
          r.handRecords.push(rec);
        }
        pendingWin = null;
      }
      if (e.type === "refusedWin") r.refusedWins++;
      if (e.type === "claimed") {
        r.claims++;
        const kind = (e.payload as { kind?: string }).kind;
        if (kind === "chow") r.chows++;
        else if (kind === "pung") r.pungs++;
        else if (kind === "kong") r.kongs++;
      }
      if (e.type === "concealedKong" || e.type === "addedKong") r.kongs++;
      if (e.type === "winOnDiscard" || e.type === "selfDraw") {
        if (e.type === "selfDraw") r.selfDraws++; else r.winsOnDiscard++;
        const winSeat = (e.payload as { context?: { seat?: number } }).context?.seat;
        if (winSeat !== undefined) {
          r.threatWins++;
          for (const s of SEATS) {
            if (s === winSeat) continue;
            const read = assessSeatThreat(viewFor(state, s), winSeat as SeatIndex, config.ruleset);
            if (read.threat > 0.3) { r.threatFlagged++; break; }
          }
        }
        const p = e.payload as {
          context?: { winningTile?: number };
          concealed?: number[];
          melds?: { kind: string; tiles: number[] }[];
          score?: { awards?: { id: string; faan: number }[] };
        };
        for (const a of p.score?.awards ?? []) r.patterns[a.id] = (r.patterns[a.id] ?? 0) + 1;
        if (r.handRecords) {
          pendingWin = {
            concealed: (p.concealed ?? []).slice(),
            melds: (p.melds ?? []).map((m) => ({ kind: m.kind, tiles: m.tiles.slice() })),
            winningTile: p.context?.winningTile ?? -1,
            awards: (p.score?.awards ?? []).map((a) => ({ id: a.id, faan: a.faan })),
          };
        }
      }
    }
    if (state.phase === "matchEnd") {
      for (const s of SEATS) r.chips[s] = state.seats[s]!.chips;
      return r;
    }
    if (state.phase === "handEnd") { step(startNextHand(state)); continue; }
    let acted = false;
    for (const seat of SEATS) {
      const options = legalActions(state, seat);
      if (options.length === 0) continue;
      step(applyAction(state, decide[seat]!(viewFor(state, seat), options, seat)));
      acted = true;
      break;
    }
    if (!acted) throw new Error(`stuck in phase ${state.phase}`);
  }
  throw new Error("match did not terminate");
}

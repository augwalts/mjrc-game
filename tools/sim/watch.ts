/**
 * Terminal spectator — watch the shipping bots play, hand by hand, to diagnose
 * game texture (the §3 gate-3 numbers) by EYE instead of only by metric.
 *
 *   node tools/sim/watch.mjs --seed 42          one match, full play-by-play
 *   node tools/sim/watch.mjs --seeds 100 -q     100 matches, autopsies + summary
 *
 * The autopsy on every exhaustive draw (流局 lau guk) is the point: all four
 * hands face up, each seat's distance to ready, what it was waiting on, and
 * whether its route could still legally reach the 3-faan floor.
 */
import type { Action, SeatIndex, TileId } from "../../engine/src/types.js";
import { counts, TILE_NAMES, WIND_NAMES, isFlower } from "../../engine/src/tiles.js";
import { prng } from "../../engine/src/wall.js";
import { distanceToReady, liveTiles } from "../../engine/src/ready.js";
import {
  startMatch, startNextHand, applyAction, legalActions, cloneState,
  type MatchState, type Applied, type MatchConfig,
} from "../../engine/src/reducer.js";
import { decideAction, type SeatView, type BotConfig } from "../../engine/src/bots.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import { score } from "../../engine/src/scoring.js";

const SEATS: SeatIndex[] = [0, 1, 2, 3];
const NAMES = ["East-seat", "Ah Ming", "Kai", "Suki"];

const args = process.argv.slice(2);
const flag = (n: string): string | null => {
  const i = args.indexOf(n);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const SEED = Number(flag("--seed") ?? 42);
const RUNS = Number(flag("--seeds") ?? 1);
const QUIET = args.includes("-q") || RUNS > 1;

const glyph = (t: TileId): string => TILE_NAMES[t] ?? `?${t}`;
const row = (ts: readonly TileId[]): string => [...ts].sort((a, b) => a - b).map(glyph).join(" ");

function viewFor(state: MatchState, seat: SeatIndex): SeatView {
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
    wallRemaining: Math.max(0, state.wallEnd - state.wallIndex),
    lastDiscard: offered === null ? state.lastDiscard : { tile: offered.tile, from: offered.from },
  };
}

function autopsy(state: MatchState): void {
  console.log("  ── autopsy 流局 — why nobody won ──");
  for (const s of SEATS) {
    const seat = state.seats[s]!;
    const all = seat.drawn === null ? seat.hand : [...seat.hand, seat.drawn];
    const c = counts(all);
    const lt = liveTiles(c, seat.melds.length);
    const vis = new Array(34).fill(0);
    for (const st of state.seats) {
      for (const t of st.discards) if (t < 34) vis[t]++;
      for (const m of st.melds) for (const t of m.tiles) if (t < 34) vis[t]++;
    }
    const waits = lt.tiles
      .map((w) => `${glyph(w.tile)}×${Math.max(0, 4 - Math.min(4, vis[w.tile] + (c[w.tile] ?? 0)))}`)
      .join(" ");
    const melds = seat.melds.map((m) => `[${m.tiles.map(glyph).join("")}${m.concealed ? "·concealed" : ""}]`).join(" ");
    console.log(
      `  ${WIND_NAMES[seat.wind]} ${NAMES[s]!.padEnd(9)} ${lt.distance < 0 ? "COMPLETE?!" : lt.distance === 0 ? "READY" : lt.distance + " away"}` +
      `  hand: ${row(all)} ${melds}` +
      (lt.distance === 0 ? `  waiting: ${waits || "(dead wait — every winning tile already visible)"}` : ""),
    );
  }
}

interface Tally {
  hands: number; draws: number; wins: number; selfDraws: number;
  refused: number; claims: number; deadWaitDraws: number; readyAtDraw: number;
  faans: number[];
}

function playMatch(seed: number, tally: Tally): void {
  const config: MatchConfig = { seed, ruleset: MJRC_STANDARD, matchLength: "oneWindRound" };
  const configs: BotConfig[] = SEATS.map((s) => ({
    ruleset: MJRC_STANDARD, rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));
  let { state, events } = startMatch(config);
  const log = (a: Applied): void => { state = a.state; events = a.events; };

  for (let guard = 0; guard < 200_000; guard++) {
    for (const e of events) {
      if (e.type === "handEnd") {
        tally.hands++;
        const p: any = e.payload;
        if (p.outcome === "exhaustiveDraw") {
          tally.draws++;
          if (!QUIET) console.log(`\nhand ${state.handIndex}: EXHAUSTIVE DRAW 流局`);
          let anyReady = false, allDead = true;
          for (const s of SEATS) {
            const seat = state.seats[s]!;
            const all = seat.drawn === null ? seat.hand : [...seat.hand, seat.drawn];
            const lt = liveTiles(counts(all), seat.melds.length);
            if (lt.distance === 0) { anyReady = true; if (lt.total > 0) allDead = false; }
          }
          if (anyReady) tally.readyAtDraw++;
          if (anyReady && allDead) tally.deadWaitDraws++;
          if (!QUIET) autopsy(state);
        } else {
          tally.wins++;
          if (p.outcome === "selfDraw") tally.selfDraws++;
          if (typeof p.faan === "number") tally.faans.push(p.faan);
          if (!QUIET) console.log(`\nhand ${state.handIndex}: WIN by ${NAMES[p.winner] ?? p.winner} — ${p.faan} faan (${p.outcome})`);
        }
      }
      if (e.type === "refusedWin") { tally.refused++; if (!QUIET) console.log(`  !! refused win (under the 3-faan floor) seat ${e.actor}`); }
      if (e.type === "claimed") { tally.claims++; if (!QUIET) console.log(`  claim: seat ${e.actor} ${String((e.payload as any).kind ?? "")} ${glyph((e.payload as any).tile ?? -1)}`); }
      if (!QUIET && e.type === "discard") {
        const p: any = e.payload;
        process.stdout.write(`${glyph(p.tile)} `);
      }
    }
    if (state.phase === "matchEnd") return;
    if (state.phase === "handEnd") { log(startNextHand(state)); continue; }
    let acted = false;
    for (const seat of SEATS) {
      const options = legalActions(state, seat);
      if (options.length === 0) continue;
      const action = decideAction(viewFor(state, seat), options, configs[seat]!);
      log(applyAction(state, action));
      acted = true;
      break;
    }
    if (!acted) throw new Error(`stuck in phase ${state.phase}`);
  }
  throw new Error("match did not terminate");
}

const tally: Tally = { hands: 0, draws: 0, wins: 0, selfDraws: 0, refused: 0, claims: 0, deadWaitDraws: 0, readyAtDraw: 0, faans: [] };
const t0 = Date.now();
for (let i = 0; i < RUNS; i++) playMatch(SEED + i, tally);
const ms = Date.now() - t0;

console.log(`\n══ ${RUNS} match(es), ${tally.hands} hands in ${ms}ms — ${(tally.hands / (ms / 1000)).toFixed(1)} hands/sec ══`);
console.log(`draw rate        ${(tally.draws / tally.hands * 100).toFixed(0)}%   (prototype baseline 69%)`);
console.log(`  ready at draw  ${tally.readyAtDraw}/${tally.draws} draws had someone READY`);
console.log(`  dead waits     ${tally.deadWaitDraws}/${tally.draws} draws where every waiting tile was already visible`);
console.log(`mean winning faan ${(tally.faans.reduce((a, b) => a + b, 0) / Math.max(1, tally.faans.length)).toFixed(1)}`);
console.log(`claims/hand      ${(tally.claims / tally.hands).toFixed(2)}`);
console.log(`refused wins     ${(tally.refused / tally.hands).toFixed(2)}/hand  (hit a winning shape under the floor)`);
console.log(`self-draw share  ${(tally.selfDraws / Math.max(1, tally.wins) * 100).toFixed(0)}% of wins`);

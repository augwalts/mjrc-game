/**
 * Rollout worker for the game's win-odds — one Monte Carlo sample per job,
 * off the main thread. Jobs: {state, blind, rseed, king} → winner seat (-1 draw).
 */
import { startMatch, startNextHand, applyAction, legalActions } from "../../engine/src/reducer.js";
import type { MatchState } from "../../engine/src/reducer.js";
import { decideAction, DEFAULT_PROFILE, type BotConfig, type BotProfile } from "../../engine/src/bots.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import { prng } from "../../engine/src/wall.js";
import { isFlower } from "../../engine/src/tiles.js";
import { viewFor } from "./driver.js";
import type { SeatIndex } from "../../engine/src/types.js";

let KING: BotProfile = DEFAULT_PROFILE;

function shuffleInPlace(a: number[], rnd: () => number): void {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]!; a[i] = a[j]!; a[j] = t; }
}
function rollout(base: MatchState, blind: boolean, rseed: number): number {
  const rnd = prng(rseed >>> 0);
  const st0 = structuredClone(base) as MatchState;
  // The LIVE wall only: [wallIndex, wallEnd). Tiles beyond wallEnd were
  // already consumed as flower/kong replacements — the pointer moved, the
  // array kept them. Pooling those duplicated tiles already in hands (the
  // "5 copies of 1萬" crash).
  const span: number[] = [];
  for (let i = st0.wallIndex; i < st0.wallEnd; i++) span.push(st0.wall[i]!);
  if (blind) {
    const pool = [...span];
    for (const o of [1, 2, 3] as SeatIndex[]) {
      pool.push(...st0.seats[o]!.hand);
      if (st0.seats[o]!.drawn !== null) pool.push(st0.seats[o]!.drawn!);
    }
    // Flowers can never sit in a concealed hand (they are revealed on draw),
    // so hands are dealt from the plain tiles; flowers go back into the wall.
    const plain = pool.filter((t) => !isFlower(t));
    const flowers = pool.filter(isFlower);
    shuffleInPlace(plain, rnd);
    for (const o of [1, 2, 3] as SeatIndex[]) {
      const n = st0.seats[o]!.hand.length;
      st0.seats[o]!.hand = plain.splice(0, n).sort((a, b) => a - b);
      if (st0.seats[o]!.drawn !== null) st0.seats[o]!.drawn = plain.splice(0, 1)[0]!;
    }
    span.length = 0; span.push(...plain, ...flowers);
    shuffleInPlace(span, rnd);
  } else shuffleInPlace(span, rnd);
  for (let i = 0; i < span.length; i++) st0.wall[st0.wallIndex + i] = span[i]!;
  const cfgs: BotConfig[] = [0, 1, 2, 3].map((i) => ({
    ruleset: MJRC_STANDARD, profile: KING, rnd: prng(((rseed + 7) ^ ((i + 1) * 0x9e3779b1)) >>> 0),
  }));
  let st = st0;
  for (let guard = 0; guard < 2500; guard++) {
    if (st.phase === "handEnd" || st.phase === "matchEnd") break;
    let acted = false;
    for (const seat of [0, 1, 2, 3] as SeatIndex[]) {
      const opts = legalActions(st, seat);
      if (opts.length === 0) continue;
      st = applyAction(st, decideAction(viewFor(st, seat), opts, cfgs[seat]!)).state;
      acted = true; break;
    }
    if (!acted) break;
  }
  let w = -1, bestD = 0;
  for (const i of [0, 1, 2, 3] as SeatIndex[]) {
    const d = st.seats[i]!.chips - base.seats[i]!.chips;
    if (d > bestD) { bestD = d; w = i; }
  }
  return w;
}

self.onmessage = (e: MessageEvent): void => {
  const { state, blind, rseed, king, job } = e.data as { state: MatchState; blind: boolean; rseed: number; king?: Partial<BotProfile>; job: number };
  if (king) KING = { ...DEFAULT_PROFILE, ...king };
  const w = rollout(state, blind, rseed);
  (self as unknown as Worker).postMessage({ job, blind, winner: w });
};
// keep the unused imports honest for the bundler
void startMatch; void startNextHand;

/**
 * Seeded generators for the property suite — DESIGN.md §8 (validation
 * harnesses) and §5.1 (deterministic wall from a seedable PRNG; Math.random
 * never touches game state).
 *
 * The golden-hand suite pins rulings a human signed off on. These generators
 * cover the other half: the invariants that must hold for hands nobody will
 * ever author by hand. Every generator is a pure function of its seed — same
 * seed, same output, on any machine and in any order — so a failing property
 * reports a seed that reproduces it exactly.
 *
 * What "legal" means here: tile multiplicities hold against a real 144-tile
 * wall, meld shapes pass melds.ts, and a chow only ever comes from 上家. These
 * are STRUCTURALLY legal positions, not positions proved reachable by play —
 * the reducer suite owns reachability.
 *
 * Terminology: ../../TERMINOLOGY.md.
 */
import {
  FLOWERS_START,
  SCORING_KINDS,
  WINDS_START,
  type Meld,
  type SeatIndex,
  type TileId,
  type WindIndex,
} from "../src/types.js";
import { counts, isFlower, isSuited, rankOf } from "../src/tiles.js";
import { buildWall, prng } from "../src/wall.js";
import {
  allMeldTiles,
  leftOf,
  makeAddedKong,
  makeChow,
  makeConcealedKong,
  makeExposedKong,
  makePung,
} from "../src/melds.js";

/* ── seeded primitives ─────────────────────────────────────────────────── */

type Rnd = () => number;

/** Uniform integer in [0, n). Never Math.random — see the header. */
const int = (rnd: Rnd, n: number): number =>
  n <= 0 ? 0 : Math.min(n - 1, Math.floor(rnd() * n));

const pick = <T>(rnd: Rnd, xs: readonly T[]): T => xs[int(rnd, xs.length)];

function shuffle<T>(rnd: Rnd, xs: readonly T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = int(rnd, i + 1);
    const swap = a[i];
    a[i] = a[j];
    a[j] = swap;
  }
  return a;
}

const ascending = (ts: readonly TileId[]): TileId[] => [...ts].sort((a, b) => a - b);

const SEATS: SeatIndex[] = [0, 1, 2, 3];

/** Any seat but this one — the source of an exposed claim. */
const otherSeat = (rnd: Rnd, seat: SeatIndex): SeatIndex =>
  pick(rnd, SEATS.filter((s) => s !== seat));

/* ── set selection ─────────────────────────────────────────────────────── */

/** An undeclared set: three tiles that could be melded or held in hand. */
interface RawSet {
  kind: "chow" | "pung";
  tiles: TileId[];
  /** A fourth copy is already reserved, so this pung can become a kong 槓. */
  kongReady: boolean;
}

interface KindFilter {
  /** Kinds this hand may draw on at all — narrowed for a flush 清一色. */
  allowed: (t: TileId) => boolean;
  /** Kinds to lean towards while any are still available. */
  preferred?: (t: TileId) => boolean;
  /** Suppress chows, so the set is guaranteed kong-able. */
  pungOnly?: boolean;
}

const ALL_KINDS: KindFilter = { allowed: () => true };

function setOptions(avail: readonly number[], f: KindFilter): RawSet[] {
  const out: RawSet[] = [];
  for (let t = 0; t < SCORING_KINDS; t++) {
    if (f.allowed(t) && avail[t] >= 3) out.push({ kind: "pung", tiles: [t, t, t], kongReady: false });
  }
  if (f.pungOnly) return out;
  for (let t = 0; t < SCORING_KINDS; t++) {
    // rankOf(t) <= 6 keeps t+1 and t+2 inside t's own suit.
    if (!isSuited(t) || rankOf(t) > 6) continue;
    if (!f.allowed(t) || !f.allowed(t + 1) || !f.allowed(t + 2)) continue;
    if (avail[t] > 0 && avail[t + 1] > 0 && avail[t + 2] > 0)
      out.push({ kind: "chow", tiles: [t, t + 1, t + 2], kongReady: false });
  }
  return out;
}

/** Takes the set's tiles out of `avail`. Throws only if the tiles genuinely ran out. */
function chooseSet(rnd: Rnd, avail: number[], f: KindFilter): RawSet {
  const all = setOptions(avail, f);
  if (all.length === 0) throw new Error("no set can be built from the remaining tiles");
  const liked = f.preferred ? all.filter((s) => f.preferred!(s.tiles[0])) : [];
  const from = liked.length > 0 && rnd() < 0.85 ? liked : all;
  const s = pick(rnd, from);
  for (const t of s.tiles) avail[t] -= 1;
  return s;
}

function choosePair(rnd: Rnd, avail: number[], f: KindFilter): TileId {
  const all: TileId[] = [];
  for (let t = 0; t < SCORING_KINDS; t++) if (f.allowed(t) && avail[t] >= 2) all.push(t);
  if (all.length === 0) throw new Error("no pair 眼 can be built from the remaining tiles");
  const liked = f.preferred ? all.filter((t) => f.preferred!(t)) : [];
  const tile = liked.length > 0 && rnd() < 0.85 ? pick(rnd, liked) : pick(rnd, all);
  avail[tile] -= 2;
  return tile;
}

/* ── declaring ─────────────────────────────────────────────────────────── */

type KongForm = "exposedKong" | "concealedKong" | "addedKong";
const KONG_FORMS: KongForm[] = ["exposedKong", "concealedKong", "addedKong"];

/**
 * Turn a raw set into a declared meld. A pung may be laid down as any of the
 * three kong forms when a fourth copy is free; 暗槓 is the only one that keeps
 * the hand 門前清, which is why `concealedOnly` pins it.
 */
function declareSet(
  rnd: Rnd,
  s: RawSet,
  seat: SeatIndex,
  avail: number[],
  kong: "none" | "maybe" | "force",
  concealedOnly: boolean,
): Meld {
  if (s.kind === "chow") return makeChow(s.tiles, seat, leftOf(seat));
  const base = s.tiles[0];
  const canKong = s.kongReady || avail[base] > 0;
  const asKong = canKong && (kong === "force" || (kong === "maybe" && rnd() < 0.3));
  if (!asKong) return makePung(base, seat, otherSeat(rnd, seat));
  if (!s.kongReady) avail[base] -= 1;
  const form: KongForm = concealedOnly ? "concealedKong" : pick(rnd, KONG_FORMS);
  if (form === "concealedKong") return makeConcealedKong(base, seat);
  const from = otherSeat(rnd, seat);
  if (form === "exposedKong") return makeExposedKong(base, seat, from);
  return makeAddedKong(makePung(base, seat, from), seat);
}

/* ── randomLegalMeldSet ────────────────────────────────────────────────── */

/**
 * Melds this seat could actually have formed: shapes that pass melds.ts, tile
 * counts inside the four-copy budget, and every chow 上 sourced from 上家.
 *
 * @param count exact number of melds, 0-4. Seeded 0-3 when absent.
 */
export function randomLegalMeldSet(seat: SeatIndex, seed: number, count?: number): Meld[] {
  const rnd = prng(seed);
  const avail = new Array<number>(SCORING_KINDS).fill(4);
  const n = Math.max(0, Math.min(4, count ?? int(rnd, 4)));
  return meldsFrom(rnd, seat, avail, n);
}

/** Shared by randomLegalMeldSet and randomHandState; mutates `avail`. */
function meldsFrom(rnd: Rnd, seat: SeatIndex, avail: number[], count: number): Meld[] {
  const out: Meld[] = [];
  for (let i = 0; i < count; i++) {
    const s = chooseSet(rnd, avail, ALL_KINDS);
    out.push(declareSet(rnd, s, seat, avail, "maybe", false));
  }
  return out;
}

/* ── randomWinningHand ─────────────────────────────────────────────────── */

export interface WinningHandOpts {
  seat?: SeatIndex;
  /** Exact number of declared melds, 0-4. Seeded 0-4 when absent. */
  meldCount?: number;
  /**
   * Nothing claimed from another seat. Forces meldCount to 0, or to a lone
   * 暗槓 when `withKong` is also set — the one declaration that keeps 門前清.
   */
  concealedOnly?: boolean;
  /** At least one declared kong 槓. */
  withKong?: boolean;
  /** Every tile from a single suit — 清一色. Overrides `honoursHeavy`. */
  flush?: boolean;
  /** Lean hard on winds and dragons. */
  honoursHeavy?: boolean;
  /** Exact flower 花 count, 0-8. Seeded 0-2 when absent. */
  flowerCount?: number;
}

export interface WinningHand {
  seed: number;
  seat: SeatIndex;
  /** Concealed tiles EXCLUDING the winning tile — decompose.ts's convention. */
  concealed: TileId[];
  melds: Meld[];
  flowers: TileId[];
  winningTile: TileId;
  /** Every physical tile held: 14, plus one more per kong, plus flowers. */
  allTiles: TileId[];
}

/**
 * A legal complete hand: four sets and a pair 眼, with any subset of the sets
 * declared as melds. The workhorse for differential and fuzz testing.
 */
export function randomWinningHand(seed: number, opts: WinningHandOpts = {}): WinningHand {
  const rnd = prng(seed);
  const seat = opts.seat ?? (int(rnd, 4) as SeatIndex);
  const avail = new Array<number>(SCORING_KINDS).fill(4);

  const suitBase = opts.flush ? [0, 9, 18][int(rnd, 3)] : -1;
  const filter: KindFilter = {
    allowed: opts.flush ? (t) => t >= suitBase && t < suitBase + 9 : () => true,
    preferred: opts.flush || !opts.honoursHeavy ? undefined : (t) => t >= WINDS_START,
  };

  const pairTile = choosePair(rnd, avail, filter);

  const wantKong = opts.withKong === true;
  const sets: RawSet[] = [];
  let kongIndex = -1;
  if (wantKong) {
    // Reserve all four copies up front so the declaration can never be starved.
    const cands: TileId[] = [];
    for (let t = 0; t < SCORING_KINDS; t++) if (filter.allowed(t) && avail[t] >= 4) cands.push(t);
    if (cands.length > 0) {
      const t = pick(rnd, cands);
      avail[t] -= 4;
      sets.push({ kind: "pung", tiles: [t, t, t], kongReady: true });
      kongIndex = 0;
    }
  }
  while (sets.length < 4) sets.push(chooseSet(rnd, avail, filter));

  let meldCount: number;
  if (opts.concealedOnly) meldCount = kongIndex >= 0 ? 1 : 0;
  else meldCount = Math.max(0, Math.min(4, opts.meldCount ?? int(rnd, 5)));
  if (kongIndex >= 0 && meldCount < 1) meldCount = 1;

  // The reserved kong set must be among the declared ones, or the kong is lost.
  const order = shuffle(rnd, [0, 1, 2, 3]).filter((i) => i !== kongIndex);
  if (kongIndex >= 0) order.unshift(kongIndex);
  const declared = new Set(order.slice(0, meldCount));

  const melds: Meld[] = [];
  const handSets: RawSet[] = [];
  for (let i = 0; i < 4; i++) {
    if (!declared.has(i)) {
      handSets.push(sets[i]);
      continue;
    }
    const kong = i === kongIndex ? "force" : opts.concealedOnly ? "none" : "maybe";
    melds.push(declareSet(rnd, sets[i], seat, avail, kong, opts.concealedOnly === true));
  }

  const held: TileId[] = [pairTile, pairTile];
  for (const s of handSets) held.push(...s.tiles);
  held.sort((a, b) => a - b);
  const winAt = int(rnd, held.length);
  const winningTile = held[winAt];
  const concealed = held.slice();
  concealed.splice(winAt, 1);

  const flowerCount = Math.max(0, Math.min(8, opts.flowerCount ?? int(rnd, 3)));
  const flowerIds: TileId[] = [];
  for (let t = FLOWERS_START; t < FLOWERS_START + 8; t++) flowerIds.push(t);
  const flowers = ascending(shuffle(rnd, flowerIds).slice(0, flowerCount));

  return {
    seed,
    seat,
    concealed,
    melds,
    flowers,
    winningTile,
    allTiles: [...concealed, winningTile, ...allMeldTiles(melds), ...flowers],
  };
}

/* ── randomHandState ───────────────────────────────────────────────────── */

export interface SeatSnapshot {
  seat: SeatIndex;
  wind: WindIndex;
  /** Sorted, excluding `drawn`. */
  concealed: TileId[];
  drawn: TileId | null;
  melds: Meld[];
  /** 花 already revealed and replaced. */
  flowers: TileId[];
  discards: TileId[];
}

export interface HandStateSample {
  seed: number;
  roundWind: WindIndex;
  dealer: SeatIndex;
  turn: SeatIndex;
  seats: SeatSnapshot[];
  /** Still face down. Unrevealed flowers live here too. */
  wall: TileId[];
}

/**
 * A plausible mid-hand table: melds, hands, revealed flowers, discards and the
 * remaining wall, carved out of ONE shuffled 144-tile wall. Because it is a
 * partition of that wall rather than four independent draws, tile conservation
 * holds by construction and the properties can test it as a real invariant.
 */
export function randomHandState(seed: number): HandStateSample {
  const rnd = prng(seed);
  const pool = buildWall(seed);
  const avail = new Array<number>(SCORING_KINDS).fill(4);

  const takeTile = (tile: TileId): void => {
    const i = pool.indexOf(tile);
    if (i < 0) throw new Error(`tile ${tile} is not in the wall`);
    pool.splice(i, 1);
  };
  /** Flowers are revealed and replaced, never held or cut, so skip them here. */
  const drawScoringTile = (): TileId => {
    const i = pool.findIndex((t) => t < SCORING_KINDS);
    if (i < 0) throw new Error("the wall holds no scoring tiles");
    const t = pool[i];
    pool.splice(i, 1);
    avail[t] -= 1;
    return t;
  };

  const dealer = int(rnd, 4) as SeatIndex;
  const roundWind = int(rnd, 4) as WindIndex;
  const turn = int(rnd, 4) as SeatIndex;

  // Melds first: they need whole sets, so they get first call on the tiles.
  const melds: Meld[][] = [];
  for (const seat of SEATS) {
    const r = rnd();
    const n = r < 0.45 ? 0 : r < 0.75 ? 1 : r < 0.92 ? 2 : r < 0.99 ? 3 : 4;
    const ms = meldsFrom(rnd, seat, avail, n);
    for (const t of allMeldTiles(ms)) takeTile(t);
    melds.push(ms);
  }

  const spare = shuffle(rnd, pool.filter(isFlower));
  let flowerAt = 0;
  const flowers: TileId[][] = [];
  for (let s = 0; s < 4; s++) {
    const n = Math.min(int(rnd, 3), spare.length - flowerAt);
    const got = spare.slice(flowerAt, flowerAt + n);
    flowerAt += n;
    for (const t of got) takeTile(t);
    flowers.push(ascending(got));
  }

  const concealed: TileId[][] = [];
  for (let s = 0; s < 4; s++) {
    // A kong fills one set slot, so a melded seat holds 13 - 3n either way.
    const n = 13 - 3 * melds[s].length;
    const h: TileId[] = [];
    for (let k = 0; k < n; k++) h.push(drawScoringTile());
    concealed.push(ascending(h));
  }

  const drawn = rnd() < 0.5 ? drawScoringTile() : null;

  // Leave the wall genuinely live: never cut it below 16 scoring tiles.
  const live = pool.reduce((n, t) => (t < SCORING_KINDS ? n + 1 : n), 0);
  const perSeat = Math.max(0, Math.floor((live - 16) / 4));
  const base = int(rnd, perSeat + 1);
  const extra = int(rnd, 4);
  const discards: TileId[][] = [];
  for (let s = 0; s < 4; s++) {
    const n = base + (s < extra ? 1 : 0);
    const d: TileId[] = [];
    for (let k = 0; k < n; k++) d.push(drawScoringTile());
    discards.push(d);
  }

  const seats: SeatSnapshot[] = SEATS.map((seat) => ({
    seat,
    wind: (((seat - dealer + 4) % 4) as WindIndex),
    concealed: concealed[seat],
    drawn: seat === turn ? drawn : null,
    melds: melds[seat],
    flowers: flowers[seat],
    discards: discards[seat],
  }));

  return { seed, roundWind, dealer, turn, seats, wall: pool };
}

/* ── census helpers ────────────────────────────────────────────────────── */

/** Every tile in the sample. Must always be exactly the 144 of one wall. */
export function handStateTiles(st: HandStateSample): TileId[] {
  const out: TileId[] = [];
  for (const s of st.seats) {
    out.push(...s.concealed, ...allMeldTiles(s.melds), ...s.flowers, ...s.discards);
    if (s.drawn !== null) out.push(s.drawn);
  }
  out.push(...st.wall);
  return out;
}

/**
 * Counts over the 34 scoring kinds that `seat` can honestly account for: its
 * own tiles, every meld on the table, and every discard. This is exactly what
 * `liveTiles` wants for its `visible` argument.
 */
export function visibleTo(st: HandStateSample, seat: SeatIndex): number[] {
  const seen: TileId[] = [];
  for (const s of st.seats) {
    seen.push(...allMeldTiles(s.melds), ...s.discards, ...s.flowers);
    if (s.seat === seat) {
      seen.push(...s.concealed);
      if (s.drawn !== null) seen.push(s.drawn);
    }
  }
  return counts(seen);
}

/** The complement of `visibleTo`: wall plus every other seat's concealed tiles. */
export function hiddenFrom(st: HandStateSample, seat: SeatIndex): number[] {
  const unseen: TileId[] = [...st.wall];
  for (const s of st.seats) {
    if (s.seat === seat) continue;
    unseen.push(...s.concealed);
    if (s.drawn !== null) unseen.push(s.drawn);
  }
  return counts(unseen);
}

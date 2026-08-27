/**
 * 拆牌 — reading a winning hand as four sets plus a pair, with the already
 * declared melds fixed in place.
 *
 * This is the piece DESIGN.md §5.1 calls out by name: "exposed-meld scoring
 * decomposition (scoring.py's DFS assumes a concealed 14-tile hand — fixed
 * melds change the algorithm, not just the faan table)". ENGINE-AUDIT §1
 * confirms there is no reference implementation to port.
 *
 * EVERY valid reading is returned, not the first or the "best" one. A hand can
 * genuinely read several ways (三三三 as three pungs or three runs; a triplet as
 * a pung or as the pair plus a run tile) and the readings score differently, so
 * picking among them is the scorer's job, not this file's — ENGINE-AUDIT §1
 * lists "equal-faan decomposition ties resolved arbitrarily" as a defect of the
 * Python engine and this is where that gets fixed.
 *
 * Two rules decisions are baked in here:
 *  1. A concealed quad is never read as a kong. A kong exists only when it was
 *     DECLARED (melds.ts); four copies sitting in hand are a triplet plus a
 *     spare tile that must belong to another set.
 *  2. No seven-pairs branch. Not a hand in classic HK Old Style (DESIGN.md §4);
 *     the Python engine scores it because it implements the LIU house variant.
 *
 * Terminology: ../../TERMINOLOGY.md.
 */
import { SCORING_KINDS, type Meld, type MeldKind, type TileId } from "./types.js";
import { TILE_NAMES, counts, isSuited, isTerminalOrHonour, rankOf } from "./tiles.js";
import { isConcealedSet, meldShapeError, meldTileCount } from "./melds.js";

/** A decomposition slot: one of the four sets, or the pair 眼. */
export type SetKind = MeldKind | "pair";

export interface DecomposedSet {
  kind: SetKind;
  /** Ascending. A kong carries four tiles and still fills one set slot. */
  tiles: TileId[];
  /**
   * Concealed for faan purposes: read out of the hand, or a 暗槓. A set the
   * winning tile completed is still flagged concealed here — whether a discard
   * spoils it (four concealed pungs) depends on how the win came in, which this
   * file is not told. See `concealedTripletCount`.
   */
  concealed: boolean;
  /** The declared meld this slot was fixed from; absent when read from hand. */
  meld?: Meld;
  /** True on the single slot the winning tile completed in THIS reading. */
  hasWinningTile: boolean;
}

export interface Decomposition {
  /** Exactly four. Declared melds first, in the order given, then hand sets. */
  sets: DecomposedSet[];
  /** 眼 — the eyes. */
  pair: DecomposedSet;
  /**
   * 門前清 by shape: nothing was claimed from another seat, so every declared
   * meld (if any) is a 暗槓. Whether the winning tile came off a discard is a
   * separate question the scorer answers from `WinContext`.
   */
  fullyConcealed: boolean;
  winningTile: TileId;
}

const setKey = (s: DecomposedSet): string =>
  `${s.kind}:${s.tiles.join(",")}:${s.concealed ? "c" : "o"}${s.hasWinningTile ? "*" : ""}`;

/** Stable identity of a reading — used to collapse duplicate search paths. */
export const decompositionKey = (d: Decomposition): string =>
  `${d.sets.map(setKey).sort().join("|")}//${setKey(d.pair)}`;

/* ── the search ────────────────────────────────────────────────────────── */

interface RawSet {
  kind: "chow" | "pung";
  tiles: TileId[];
}

/**
 * Partition the concealed counts into exactly `need` sets. Always works on the
 * lowest remaining tile, so the same partition can only be reached by choosing
 * between pung and chow AT that tile — which still lets one multiset arrive by
 * two orders (pung 111 then chow 123, or the reverse), hence the dedupe above.
 */
function enumerateSets(c: number[], need: number, acc: RawSet[], out: RawSet[][]): void {
  if (need === 0) {
    for (let i = 0; i < SCORING_KINDS; i++) if (c[i]! > 0) return; // tiles left over
    out.push(acc.map((s) => ({ kind: s.kind, tiles: s.tiles.slice() })));
    return;
  }
  let i = 0;
  while (i < SCORING_KINDS && c[i] === 0) i++;
  if (i >= SCORING_KINDS) return; // sets still wanted, no tiles left
  if (c[i]! >= 3) {
    c[i]! -= 3;
    acc.push({ kind: "pung", tiles: [i, i, i] });
    enumerateSets(c, need - 1, acc, out);
    acc.pop();
    c[i]! += 3;
  }
  if (isSuited(i) && rankOf(i) <= 6 && c[i + 1]! > 0 && c[i + 2]! > 0) {
    c[i]!--; c[i + 1]!--; c[i + 2]!--;
    acc.push({ kind: "chow", tiles: [i, i + 1, i + 2] });
    enumerateSets(c, need - 1, acc, out);
    acc.pop();
    c[i]!++; c[i + 1]!++; c[i + 2]!++;
  }
}

const name = (t: TileId): string => TILE_NAMES[t] ?? `tile ${t}`;

function assertScoringTile(t: TileId): void {
  if (!Number.isInteger(t) || t < 0 || t >= SCORING_KINDS)
    throw new Error(`tile ${t} is not a scoring tile — flowers 花 are held apart from the hand`);
}

/**
 * Every valid reading of a winning hand.
 *
 * @param concealed   tiles still in hand, EXCLUDING the winning tile — the same
 *                    convention as the golden-hand fixtures (test/golden/case.ts)
 * @param melds       declared melds, which are fixed and never re-read
 * @param winningTile the tile that completed the hand, drawn or claimed
 * @returns every distinct reading; empty when the tiles do not form a win
 * @throws when the input cannot be a hand at all (wrong tile count, five copies
 *         of a tile, a flower in hand, a malformed meld) — those are bugs in the
 *         caller or typos in a fixture, not losing hands.
 */
export function decomposeWin(
  concealed: readonly TileId[],
  melds: readonly Meld[],
  winningTile: TileId,
): Decomposition[] {
  if (melds.length > 4)
    throw new Error(`a hand holds at most four sets, got ${melds.length} melds`);
  for (const m of melds) {
    const e = meldShapeError(m);
    if (e) throw new Error(`illegal meld: ${e}`);
  }
  assertScoringTile(winningTile);
  for (const t of concealed) assertScoringTile(t);

  const needSets = 4 - melds.length;
  // Kongs count as three here: four tiles, one set slot (melds.ts/meldTileCount).
  if (concealed.length !== needSets * 3 + 1)
    throw new Error(
      `${concealed.length} concealed tiles alongside ${melds.length} meld(s) cannot make a ` +
        `winning hand; expected ${needSets * 3 + 1} (the winning tile is passed separately)`,
    );

  const c = counts([...concealed, winningTile]);
  const seenCopies = c.slice();
  for (const m of melds) for (const t of m.tiles) seenCopies[t]!++;
  for (let i = 0; i < SCORING_KINDS; i++)
    if (seenCopies[i]! > 4) throw new Error(`${seenCopies[i]} copies of ${name(i)}; only four exist`);

  const fixed: DecomposedSet[] = melds.map((m) => ({
    kind: m.kind,
    tiles: m.tiles.slice(),
    concealed: isConcealedSet(m),
    meld: m,
    hasWinningTile: false,
  }));
  // 門前清 by shape: a 暗槓 keeps the hand concealed, every other meld opens it.
  const fullyConcealed = melds.every(isConcealedSet);

  const out: Decomposition[] = [];
  const seen = new Set<string>();

  for (let p = 0; p < SCORING_KINDS; p++) {
    if (c[p]! < 2) continue;
    c[p]! -= 2;
    const partitions: RawSet[][] = [];
    enumerateSets(c, needSets, [], partitions);
    c[p]! += 2;

    for (const parts of partitions) {
      const handSets: DecomposedSet[] = parts
        .map((s) => ({
          kind: s.kind as SetKind,
          tiles: s.tiles,
          concealed: true,
          hasWinningTile: false,
        }))
        .sort((a, b) => a.tiles[0]! - b.tiles[0]! || a.kind.localeCompare(b.kind));

      // The winning tile completed exactly one slot, but several slots may hold
      // a copy of it and the choice changes the score (a discard-completed pung
      // is not concealed). Emit one reading per distinct attribution.
      const slots: number[] = [];
      if (p === winningTile) slots.push(-1); // -1 marks the pair
      handSets.forEach((s, i) => {
        if (s.tiles.includes(winningTile)) slots.push(i);
      });

      for (const slot of slots) {
        const pair: DecomposedSet = {
          kind: "pair",
          tiles: [p, p],
          concealed: true,
          hasWinningTile: slot === -1,
        };
        const sets = [
          ...fixed.map((s) => ({ ...s, tiles: s.tiles.slice() })),
          ...handSets.map((s, i) => ({ ...s, tiles: s.tiles.slice(), hasWinningTile: i === slot })),
        ];
        const d: Decomposition = { sets, pair, fullyConcealed, winningTile };
        const key = decompositionKey(d);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(d);
      }
    }
  }
  return out;
}

/**
 * Thirteen Orphans 十三么 — one of each of the thirteen terminal-and-honour
 * kinds with exactly one of them paired, held fully concealed. The ONE winning
 * hand with no four-sets-and-a-pair reading, so `decomposeWin` correctly
 * returns nothing for it and the shape is tested directly. Checking the
 * thirteen kinds at 1-2 copies with exactly one pair accounts for all 14
 * tiles, so no separate "nothing else in hand" test is needed. The scorer
 * (scoring.ts) runs this same predicate before consulting any decomposition;
 * keeping it here keeps the reducer's win offer and the scorer's award from
 * ever drifting apart.
 */
export function isThirteenOrphansShape(
  concealed: readonly TileId[],
  melds: readonly Meld[],
  winningTile: TileId,
): boolean {
  if (melds.length > 0 || concealed.length !== 13) return false;
  const c = counts([...concealed, winningTile]);
  let paired = 0;
  for (let t = 0; t < SCORING_KINDS; t++) {
    if (!isTerminalOrHonour(t)) continue;
    if (c[t] === 2) paired++;
    else if (c[t] !== 1) return false;
  }
  return paired === 1;
}

/** True when these tiles can be read as a win at all — 十三么 included. */
export const hasWinningShape = (
  concealed: readonly TileId[],
  melds: readonly Meld[],
  winningTile: TileId,
): boolean =>
  isThirteenOrphansShape(concealed, melds, winningTile) ||
  decomposeWin(concealed, melds, winningTile).length > 0;

/** Physical tiles on the table and in hand for this reading — 14, plus one per kong. */
export const decompositionTileCount = (d: Decomposition): number =>
  d.pair.tiles.length + d.sets.reduce((n, s) => n + (s.meld ? meldTileCount(s.meld) : 3), 0);

/**
 * Concealed triplets, for 三暗刻 / 四暗刻.
 *
 * A triplet completed by someone else's discard is NOT concealed, even though
 * two of its tiles never left the hand — the standard HK ruling, and the reason
 * this needs to know how the win arrived. A 暗槓 always counts; it was declared
 * from four tiles the player already held.
 *
 * @param winFromDiscard true when the winning tile came off another seat's
 *                       discard (including a robbed kong 搶槓)
 */
export function concealedTripletCount(d: Decomposition, winFromDiscard: boolean): number {
  return d.sets.filter(
    (s) =>
      (s.kind === "pung" || s.kind === "kong") &&
      s.concealed &&
      !(winFromDiscard && s.hasWinningTile),
  ).length;
}

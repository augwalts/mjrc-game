/**
 * 牌組 — the meld model: 上 chow, 碰 pung, and all three 槓 kong forms
 * (明槓 exposed, 暗槓 concealed, 加槓 added onto an exposed pung).
 *
 * Implements DESIGN.md §4 (canonical HK Old Style claims) and the §5.1 line
 * "KONG melds in all three forms, exposed/concealed distinction". ENGINE-AUDIT
 * §1 records that the Python engine has none of this — no kong meld type, no
 * exposed/concealed distinction, a quad raises ValueError — so nothing in this
 * file is a port. Terminology: ../../TERMINOLOGY.md.
 *
 * A Meld is only ever a DECLARED set: claimed from a discard, or laid down on
 * your own turn. A triplet sitting quietly in a concealed hand is not a meld,
 * it is just tiles; decompose.ts reads it as a set at win time. That is why
 * `concealed` is only ever true for a kong (types.ts) — 暗槓 is the one set a
 * player declares without claiming anything.
 */
import { SCORING_KINDS, type Meld, type SeatIndex, type TileId } from "./types.js";
import { TILE_NAMES, isRun, isSuited, rankOf } from "./tiles.js";

/** The five shapes a declared meld can take. `MeldKind` alone cannot tell kongs apart. */
export type MeldForm = "chow" | "pung" | "exposedKong" | "concealedKong" | "addedKong";

/** UI leads with the Cantonese term (DESIGN.md §7, terminology-first). */
export const MELD_LABELS: Record<MeldForm, string> = {
  chow: "上",
  pung: "碰",
  exposedKong: "明槓",
  concealedKong: "暗槓",
  addedKong: "加槓",
};

/* ── seat geometry ─────────────────────────────────────────────────────── */

const isSeat = (s: number): s is SeatIndex => Number.isInteger(s) && s >= 0 && s <= 3;

/**
 * 上家 — the seat that plays immediately before yours. Turn order runs
 * 東 → 南 → 西 → 北 (seat + 1), so your 上家 is seat + 3. Its discards are the
 * ONLY ones you may chow; pung and kong may be claimed from any seat.
 */
export const leftOf = (seat: SeatIndex): SeatIndex => ((seat + 3) % 4) as SeatIndex;

/* ── inspection ────────────────────────────────────────────────────────── */

export function meldForm(m: Meld): MeldForm {
  if (m.kind !== "kong") return m.kind;
  if (m.concealed) return "concealedKong";
  return m.addedToPung ? "addedKong" : "exposedKong";
}

/**
 * Physical tiles held by the meld. A kong is four tiles but still fills exactly
 * ONE of a hand's four set slots — which is why a winning hand counts to 14
 * with kongs counted as three (test/golden/case.ts uses the same convention).
 */
export const meldTileCount = (m: Meld): number => (m.kind === "kong" ? 4 : 3);

/** The repeated tile of a pung/kong, or the lowest tile of a chow. */
export const meldBaseTile = (m: Meld): TileId => m.tiles[0]!;

export const meldContains = (m: Meld, tile: TileId): boolean => m.tiles.includes(tile);

/**
 * True when the meld still counts as concealed for 門前清 and for counting
 * concealed triplets. Only 暗槓 qualifies: every other declared meld took a
 * tile off the table, and 加槓 inherits the exposure of the pung it grew from.
 */
export const isConcealedSet = (m: Meld): boolean => m.kind === "kong" && m.concealed;

/** Pung or kong — the shapes that count towards 對對糊 and concealed-triplet faan. */
export const isTripletLike = (m: Meld): boolean => m.kind === "pung" || m.kind === "kong";

/**
 * The seat that supplied the claimed tile, or null for 暗槓, which claims
 * nothing. For 加槓 this is the discarder of the original pung: the fourth tile
 * came from the owner's own hand, but the meld is still exposed because of that
 * first claim.
 */
export const sourceSeat = (m: Meld): SeatIndex | null => (m.concealed ? null : m.from);

/**
 * 搶槓 — only an added kong opens the rob-the-kong window. The fourth tile is
 * offered to the table as it goes onto an existing pung, so a player waiting on
 * it may take it. 暗槓 is laid down complete and is never robbable in HK Old
 * Style; 明槓 was claimed off a discard that already had its own claim window.
 */
export const opensRobKongWindow = (m: Meld): boolean => m.kind === "kong" && m.addedToPung === true;

/** Every tile shown by these melds — feed this to `liveTiles`' visible counts. */
export function allMeldTiles(melds: readonly Meld[]): TileId[] {
  const out: TileId[] = [];
  for (const m of melds) out.push(...m.tiles);
  return out;
}

/* ── validation ────────────────────────────────────────────────────────── */

const name = (t: TileId): string => TILE_NAMES[t] ?? `tile ${t}`;
const names = (ts: readonly TileId[]): string => ts.map(name).join("");

function tileError(tiles: readonly TileId[]): string | null {
  for (const t of tiles) {
    if (!Number.isInteger(t) || t < 0 || t >= SCORING_KINDS)
      return `tile ${t} cannot be melded — flowers 花 are set aside, never melded`;
  }
  for (let i = 1; i < tiles.length; i++)
    if (tiles[i]! < tiles[i - 1]!) return `meld tiles must be ascending, got ${names(tiles)}`;
  return null;
}

/**
 * Shape-only check: kind against tiles and flags, with no seat context. Used by
 * decompose.ts, which is handed melds without knowing whose hand they sit in.
 * Returns null when the meld is well formed, otherwise the reason it is not.
 */
export function meldShapeError(m: Meld): string | null {
  const t = m.tiles;
  const bad = tileError(t);
  if (bad) return bad;
  if (t.length !== meldTileCount(m))
    return `a ${m.kind} holds ${meldTileCount(m)} tiles, got ${t.length}`;
  switch (m.kind) {
    case "chow":
      if (!isRun(t[0]!, t[1]!, t[2]!)) return `${names(t)} is not a run`;
      if (m.concealed) return "a chow 上 is always claimed from a discard, so it is never concealed";
      if (m.addedToPung) return "addedToPung 加槓 only applies to a kong";
      return null;
    case "pung":
      if (t[0] !== t[1] || t[1] !== t[2]) return `${names(t)} is not three of a kind`;
      if (m.concealed)
        return "a pung 碰 is always claimed; a triplet held in hand is not a meld until it is declared as a 暗槓";
      if (m.addedToPung) return "addedToPung 加槓 only applies to a kong";
      return null;
    case "kong":
      if (t[0] !== t[1] || t[1] !== t[2] || t[2] !== t[3])
        return `${names(t)} is not four of a kind`;
      if (m.concealed && m.addedToPung) return "a kong is either 暗槓 or 加槓, never both";
      return null;
  }
  return null;
}

/**
 * Full check, including the seat rules: a chow may only come from 上家, and an
 * exposed meld must name a seat other than the owner's.
 * @param owner the seat holding the meld
 */
export function meldError(m: Meld, owner: SeatIndex): string | null {
  const shape = meldShapeError(m);
  if (shape) return shape;
  if (!isSeat(owner)) return `owner seat ${owner} is not a seat`;
  if (!isSeat(m.from)) return `source seat ${m.from} is not a seat`;
  if (m.kind === "chow" && m.from !== leftOf(owner))
    return `a chow 上 may only be claimed from 上家 (seat ${leftOf(owner)}), not seat ${m.from}`;
  if (m.concealed && m.from !== owner)
    return "a concealed kong 暗槓 claims nothing, so `from` must be the owner's own seat";
  if (!m.concealed && m.from === owner)
    return `an exposed ${m.kind} must name the seat the claimed tile came from`;
  return null;
}

export const isLegalMeld = (m: Meld, owner: SeatIndex): boolean => meldError(m, owner) === null;

export function validateMeld(m: Meld, owner: SeatIndex): void {
  const e = meldError(m, owner);
  if (e) throw new Error(`illegal ${meldForm(m)}: ${e}`);
}

/* ── construction ──────────────────────────────────────────────────────── */

/** 上 — a run claimed from 上家. `tiles` may be given in any order. */
export function makeChow(tiles: readonly TileId[], owner: SeatIndex, from: SeatIndex): Meld {
  const m: Meld = { kind: "chow", tiles: [...tiles].sort((a, b) => a - b), from, concealed: false };
  validateMeld(m, owner);
  return m;
}

/** 碰 — a triplet claimed from any seat's discard. */
export function makePung(tile: TileId, owner: SeatIndex, from: SeatIndex): Meld {
  const m: Meld = { kind: "pung", tiles: [tile, tile, tile], from, concealed: false };
  validateMeld(m, owner);
  return m;
}

/** 明槓 — the fourth copy claimed off a discard, three already in hand. */
export function makeExposedKong(tile: TileId, owner: SeatIndex, from: SeatIndex): Meld {
  const m: Meld = { kind: "kong", tiles: [tile, tile, tile, tile], from, concealed: false };
  validateMeld(m, owner);
  return m;
}

/** 暗槓 — all four copies held, declared on your own turn. Stays concealed. */
export function makeConcealedKong(tile: TileId, owner: SeatIndex): Meld {
  const m: Meld = { kind: "kong", tiles: [tile, tile, tile, tile], from: owner, concealed: true };
  validateMeld(m, owner);
  return m;
}

/**
 * 加槓 — the fourth copy added onto an existing exposed pung. `from` is carried
 * over from that pung: the meld stays exposed, and it is the only kong form
 * that can be robbed (see `opensRobKongWindow`).
 */
export function makeAddedKong(pung: Meld, owner: SeatIndex): Meld {
  if (pung.kind !== "pung")
    throw new Error(`加槓 must be added to a pung 碰, not a ${pung.kind}`);
  validateMeld(pung, owner);
  const t = pung.tiles[0]!;
  const m: Meld = {
    kind: "kong",
    tiles: [t, t, t, t],
    from: pung.from,
    concealed: false,
    addedToPung: true,
  };
  validateMeld(m, owner);
  return m;
}

/* ── legality against a hand ───────────────────────────────────────────── */

const copies = (hand: readonly TileId[], tile: TileId): number =>
  hand.reduce((n, t) => (t === tile ? n + 1 : n), 0);

/** 碰 needs two in hand; the discard supplies the third. */
export const canPung = (hand: readonly TileId[], tile: TileId): boolean => copies(hand, tile) >= 2;

/** 明槓 needs three in hand; the discard supplies the fourth. */
export const canExposedKong = (hand: readonly TileId[], tile: TileId): boolean =>
  copies(hand, tile) >= 3;

/** 暗槓 needs all four copies in hand. */
export const canConcealedKong = (hand: readonly TileId[], tile: TileId): boolean =>
  copies(hand, tile) >= 4;

/** The exposed pung this tile could be added to, if any. */
export const findExposedPung = (melds: readonly Meld[], tile: TileId): Meld | undefined =>
  melds.find((m) => m.kind === "pung" && m.tiles[0] === tile);

/** 加槓 needs the fourth copy in hand AND the matching exposed pung on the table. */
export const canAddedKong = (
  hand: readonly TileId[],
  melds: readonly Meld[],
  tile: TileId,
): boolean => copies(hand, tile) >= 1 && findExposedPung(melds, tile) !== undefined;

/**
 * The pairs of hand tiles that could chow this discard, as `ClaimOption.with`.
 * Empty unless the discarder is 上家 — that restriction lives here so no caller
 * can forget it.
 */
export function chowOptions(
  hand: readonly TileId[],
  tile: TileId,
  owner: SeatIndex,
  from: SeatIndex,
): TileId[][] {
  if (from !== leftOf(owner) || !isSuited(tile)) return [];
  const r = rankOf(tile);
  const has = (t: TileId) => hand.includes(t);
  const out: TileId[][] = [];
  // Rank bounds keep every candidate inside the discard's own suit.
  if (r <= 6 && has(tile + 1) && has(tile + 2)) out.push([tile + 1, tile + 2]);
  if (r >= 1 && r <= 7 && has(tile - 1) && has(tile + 1)) out.push([tile - 1, tile + 1]);
  if (r >= 2 && has(tile - 2) && has(tile - 1)) out.push([tile - 2, tile - 1]);
  return out;
}

/**
 * Replace an exposed pung with the 加槓 it becomes. Returns a new array; the
 * caller still owes the table a rob-the-kong window before the replacement draw
 * (DESIGN.md §5.2).
 */
export function upgradePungToKong(
  melds: readonly Meld[],
  tile: TileId,
  owner: SeatIndex,
): Meld[] {
  const i = melds.findIndex((m) => m.kind === "pung" && m.tiles[0] === tile);
  if (i < 0) throw new Error(`加槓 needs an exposed pung 碰 of ${name(tile)}; there is none`);
  const out = melds.slice();
  out[i] = makeAddedKong(melds[i]!, owner);
  return out;
}

/**
 * Shared vocabulary for the MJRC engine. Hong Kong Old Style only.
 * Terminology rules: ../../TERMINOLOGY.md — Japanese terms are banned.
 *
 * Tile ids are a flat 0-41 space:
 *   0-8    萬 characters 1-9
 *   9-17   索 bamboo 1-9
 *   18-26  筒 circles 1-9
 *   27-30  winds 東南西北
 *   31-33  dragons 中發白
 *   34-41  flowers 梅蘭菊竹 + seasons 春夏秋冬
 */

export type TileId = number;

export const CHARS_START = 0;
export const BAMBOO_START = 9;
export const CIRCLES_START = 18;
export const WINDS_START = 27;
export const DRAGONS_START = 31;
export const FLOWERS_START = 34;
export const TILE_KINDS = 42;
/** Suited + honour tiles only (four copies each). Flowers are singletons. */
export const SCORING_KINDS = 34;
export const WALL_SIZE = 144;

export type Suit = "chars" | "bamboo" | "circles" | "honours";

/** Seat wind index: 0 東, 1 南, 2 西, 3 北. */
export type WindIndex = 0 | 1 | 2 | 3;
export type SeatIndex = 0 | 1 | 2 | 3;

export type MeldKind = "chow" | "pung" | "kong";

export interface Meld {
  kind: MeldKind;
  /** Sorted tile ids forming the meld. A kong carries four. */
  tiles: TileId[];
  /** Seat the claimed tile came from; equals the owner for a concealed kong. */
  from: SeatIndex;
  /** 暗槓 concealed kong. Only ever true for kongs. */
  concealed: boolean;
  /** 加槓 — a kong added onto an existing exposed pung. */
  addedToPung?: boolean;
}

export interface SeatState {
  seat: SeatIndex;
  wind: WindIndex;
  /** Concealed tiles, sorted, excluding `drawn`. */
  hand: TileId[];
  /** The tile just drawn, held apart from the hand. Null when not this seat's turn. */
  drawn: TileId | null;
  melds: Meld[];
  /** 花 revealed bonus tiles. */
  flowers: TileId[];
  discards: TileId[];
  chips: number;
  connected: boolean;
}

export type Phase =
  | "deal"
  | "flowerReplacement"
  | "awaitDiscard"
  | "claimWindow"
  | "robKongWindow"
  | "handEnd"
  | "matchEnd";

export interface GameState {
  phase: Phase;
  seats: [SeatState, SeatState, SeatState, SeatState];
  /** Prevailing wind 圈. */
  roundWind: WindIndex;
  dealer: SeatIndex;
  turn: SeatIndex;
  handIndex: number;
  wall: TileId[];
  wallIndex: number;
  lastDiscard: { tile: TileId; from: SeatIndex } | null;
  rulesetId: string;
  engineVersion: string;
}

/* ── claims ────────────────────────────────────────────────────────────── */

export type ClaimKind = "win" | "kong" | "pung" | "chow";

export interface ClaimOption {
  kind: ClaimKind;
  /** For a chow, the two tiles taken from hand. */
  with?: TileId[];
}

/** Resolution order. Ties break to the seat nearest the discarder, clockwise. */
export const CLAIM_PRIORITY: ClaimKind[] = ["win", "kong", "pung", "chow"];

/* ── actions ───────────────────────────────────────────────────────────── */

export type Action =
  | { type: "discard"; seat: SeatIndex; tile: TileId }
  | { type: "claim"; seat: SeatIndex; option: ClaimOption }
  | { type: "pass"; seat: SeatIndex }
  | { type: "concealedKong"; seat: SeatIndex; tile: TileId }
  | { type: "addedKong"; seat: SeatIndex; tile: TileId }
  | { type: "declareWin"; seat: SeatIndex; selfDraw: boolean };

/* ── readiness ─────────────────────────────────────────────────────────── */

/**
 * Distance to a winning shape. -1 means the hand is already complete,
 * 0 means ready (聽牌), 1 means one tile away, and so on.
 */
export type Distance = number;

export interface LiveTiles {
  distance: Distance;
  /** Tiles that reduce the distance, with copies not yet visible. */
  tiles: { tile: TileId; unseen: number }[];
  /** Total unseen copies across all improving tiles. */
  total: number;
}

/* ── scoring ───────────────────────────────────────────────────────────── */

export interface FaanAward {
  /** Stable identifier, e.g. "fullFlush". Never a display string. */
  id: string;
  faan: number;
  /** Ids this award subsumes, e.g. bigThreeDragons subsumes smallThreeDragons. */
  subsumes?: string[];
}

export interface ScoreResult {
  faan: number;
  /** Uncapped total before the limit is applied. */
  rawFaan: number;
  capped: boolean;
  awards: FaanAward[];
  /** False when below the minimum — the win may not be taken. */
  legal: boolean;
}

export interface WinContext {
  seat: SeatIndex;
  selfDraw: boolean;
  /** Seat that discarded the winning tile; null on a self-draw. */
  from: SeatIndex | null;
  winningTile: TileId;
  roundWind: WindIndex;
  seatWind: WindIndex;
  isDealer: boolean;
  /** 搶槓 won by robbing a kong. */
  robbedKong?: boolean;
  /** 槓上開花 won on a kong replacement tile. */
  onKongReplacement?: boolean;
  /** Won on the very last tile drawn from the wall. */
  onLastTile?: boolean;
  wallEmpty?: boolean;
}

/* ── payment ───────────────────────────────────────────────────────────── */

/**
 * How a self-draw settles. Both are real house rules and BOTH ship as presets;
 * a table picks one. Every golden-hand case must state which it assumes.
 *   perPlayer — each of the three losers pays the full amount.
 *   total     — the amount is split three ways.
 */
export type SelfDrawSettlement = "perPlayer" | "total";

export interface PaymentTable {
  id: string;
  selfDraw: SelfDrawSettlement;
  /** Chips the discarder pays on a win from a discard. */
  onDiscard(faan: number): number;
  /** Chips each loser pays on a self-draw, after the settlement rule. */
  onSelfDraw(faan: number): number;
  /** 包 — discarder pays for everyone in defined circumstances. */
  liabilityRules?: string[];
}

export interface Ruleset {
  id: string;
  label: string;
  minimumFaan: number;
  limitFaan: number;
  useFlowers: boolean;
  payment: PaymentTable;
  /** Enabled pattern ids and their faan values. */
  faanTable: Record<string, number>;
}

/**
 * Golden hands — limit hands 爆棚 and situational faan. DESIGN.md §4 (canonical
 * HK Old Style, 13-faan limit, rulesets-as-data) and §8 (this suite is the ONLY
 * validation source for the canonical extensions — 天糊, 地糊 and last-tile
 * wins are exactly that).
 *
 * Every case here is PROVISIONAL until a strong HK player signs it off (§8).
 *
 * ── what this family is for ─────────────────────────────────────────────────
 * The cap is the point. A scorer that only sums awards looks correct until a
 * hand sums past 13, so every case records the UNCAPPED total alongside the
 * paid total, and the crossings are deliberately varied:
 *   - two limit patterns stacking (天糊 that is also 十三么, raw 28)
 *   - a limit pattern from one family plus one from another (四暗刻 + 清么九, raw 22)
 *   - a mid-value special plus ordinary faan, no 13-pattern anywhere (大三元 + 對對糊 + 混一色, raw 14)
 *   - a limit pattern plus nothing but situational faan (地糊 + 平糊, raw 14)
 *   - the SAME fourteen tiles under two presets, where only one of them caps
 *     (清么九 is 7 in hkos-standard and 13 in LIU)
 * Three cases land EXACTLY on 13 and are NOT capped, which is the case an
 * off-by-one in the cap check gets wrong in the direction nobody notices. And
 * one hand carries a limit-hand NAME while paying only 10, because hkos-standard
 * prices 清么九 additively rather than at a flat 13 — an engine that hard-codes
 * "limit hand ⇒ 13" fails that case and nothing else here.
 *
 * ── where the numbers come from ─────────────────────────────────────────────
 * Faan values and subsumption are taken from the shipping presets, NOT invented
 * here: rulesets/src/presets.ts (HKOS_STANDARD, LIU) and rulesets/src/patterns.ts.
 * They are restated below as FAAN / FAAN_LIU only so the sibling test can re-add
 * every case; `engine` deliberately takes no dependency on `rulesets` (§5.1 —
 * the engine is pure and dependency-free), so the two copies must be kept in
 * step by hand. The test will catch a case that drifts; nothing catches the
 * table itself drifting, so treat presets.ts as the source of truth.
 *
 * Subsumption respected here, from patterns.ts:
 *   thirteenOrphans / nineGates / heavenlyHand / earthlyHand ⊃ concealedHand
 *   nineGates ⊃ fullFlush as well — the hand is one suit by definition, and
 *     both presets pay it a flat limit rather than the additive 4 + 6 reading
 *   fourConcealedPungs ⊃ allPungs, concealedHand
 *   allTerminals ⊃ mixedTerminals; 對對糊 is still paid on top
 *   bigThreeDragons ⊃ smallThreeDragons, dragonPung
 * `expected.awards` lists only what is PAID, and `rawFaan` is the sum of exactly
 * that list, so a subsumed id never appears.
 *
 * ── conventions inherited from ./basic.ts, ./kongs.ts and ./honours.ts ───────
 * Award ids are stable lowerCamelCase. Seat index equals wind index, so seat 0
 * 東 is the dealer and a chow's `from` is (seat + 3) % 4 — the upper house 上家.
 * A hand with no bonus tile scores 無花 noFlowers, so `flowers: []` is never
 * neutral: cases not about bonus tiles hold one flower belonging to ANOTHER
 * seat, which pays nothing.
 *
 * Tile ids (../../src/types.ts): 0-8 萬 · 9-17 索 · 18-26 筒 ·
 * 27-30 東南西北 · 31-33 中發白 · 34-41 花 (梅蘭菊竹春夏秋冬).
 *
 * Terminology: ../../../TERMINOLOGY.md. HK only.
 */
import type { Meld, SeatIndex, TileId } from "../../src/types.js";
import type { GoldenCase } from "./case.js";

/**
 * GoldenCase cannot express three things this family needs. Rather than edit
 * the shared contract, they live here and are reported as gaps:
 *   - the uncapped total. ScoreResult HAS `rawFaan`/`capped`; GoldenCase.expected
 *     does not, so a cap test written against GoldenCase alone is untestable.
 *   - which opening a hand won on. 天糊 and 地糊 are otherwise indistinguishable
 *     from an ordinary concealed win, and GoldenCase carries no discarder seat,
 *     so "the DEALER's first discard" cannot be stated at all.
 *   - 河底撈魚, a win on the last DISCARD. GoldenCase has `onLastTile` only, and
 *     overloading it with `selfDraw: false` would make the fixture lie about
 *     which tile ended the hand.
 */
export interface LimitCase extends GoldenCase {
  /** Uncapped sum of `expected.awards`, before 爆棚. */
  rawFaan: number;
  /** True when the limit actually bit, i.e. rawFaan > the preset's limitFaan. */
  capped: boolean;
  /** 天糊 dealer's opening 14 · 地糊 won on the dealer's opening discard. */
  opening?: "heavenly" | "earthly";
  /** 河底撈魚 — won on the very last discard of the hand. */
  onLastDiscard?: boolean;
}

/* ── tile ids, written the way the MJRC scoring pages write them ────────────
 * m = 萬 characters (0-8) · s = 索 bamboo (9-17) · t = 筒 circles (18-26).   */
const m = (rank: number): TileId => rank - 1;
const s = (rank: number): TileId => 8 + rank;
const t = (rank: number): TileId => 17 + rank;

const EAST = 27, SOUTH = 28, WEST = 29, NORTH = 30;
const RED_DRAGON = 31, GREEN_DRAGON = 32, WHITE_DRAGON = 33;
const PLUM = 34, ORCHID = 35;

/** 爆棚. Both shipping presets set limitFaan to 13 (rulesets/src/presets.ts). */
export const LIMIT_FAAN = 13;

/** hkos-standard faan values, mirrored from rulesets/src/presets.ts HKOS_STANDARD. */
export const FAAN: Readonly<Record<string, number>> = {
  dragonPung: 1,
  seatWind: 1,
  roundWind: 1,
  ownFlower: 1,
  ownSeason: 1,
  noFlowers: 1,
  selfDraw: 1,
  concealedHand: 1,
  winOnLastTile: 1,
  allChows: 1,
  allPungs: 3,
  halfFlush: 3,
  fullFlush: 6,
  mixedTerminals: 1,
  smallThreeDragons: 5,
  bigThreeDragons: 8,
  smallFourWinds: 6,
  bigFourWinds: 10,
  fourConcealedPungs: 13,
  allHonours: 10,
  allTerminals: 7,
  nineGates: 13,
  thirteenOrphans: 13,
  heavenlyHand: 13,
  earthlyHand: 13,
  /**
   * 河底撈魚 — the twin of 海底撈月, not the same award: 海底 is the wall's
   * final DRAW, 河底 the final DISCARD, and patterns.ts records that no hand
   * can ever earn both. Priced level with it at 1.
   */
  winOnLastDiscard: 1,
};

/** LIU variant values, mirrored from rulesets/src/presets.ts LIU. Only what this family uses. */
export const FAAN_LIU: Readonly<Record<string, number>> = {
  ...FAAN,
  fullFlush: 7,
  allTerminals: 13,
  allHonours: 13,
  smallThreeDragons: 4,
  bigThreeDragons: 6,
  smallFourWinds: 10,
  bigFourWinds: 13,
};

export const FAAN_BY_RULESET: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "hkos-standard": FAAN,
  liu: FAAN_LIU,
};

/** A chow may only be claimed from 上家, the seat that plays immediately before you. */
const chow = (seat: SeatIndex, low: TileId): Meld => ({
  kind: "chow",
  tiles: [low, low + 1, low + 2],
  from: ((seat + 3) % 4) as SeatIndex,
  concealed: false,
});

/** A pung may be claimed from any seat, so the discarder is given explicitly. */
const pung = (from: SeatIndex, tile: TileId): Meld => ({
  kind: "pung",
  tiles: [tile, tile, tile],
  from,
  concealed: false,
});

const SRC = "rulesets/src/presets.ts + patterns.ts, over mjrc-admin/reference/hk-scoring-calculator.xlsx";

const base = { ruleset: "hkos-standard", provisional: true, source: SRC } as const;

/** The thirteen 么九 kinds in tile-id order. 十三么 holds all of them plus one duplicate. */
const ORPHANS: TileId[] = [
  m(1), m(9), s(1), s(9), t(1), t(9),
  EAST, SOUTH, WEST, NORTH, RED_DRAGON, GREEN_DRAGON, WHITE_DRAGON,
];

/** 1112345678999 in one suit — the 九蓮寶燈 wait, which any tile of the suit completes. */
const nineGatesHand = (one: TileId): TileId[] => [
  one, one, one,
  one + 1, one + 2, one + 3, one + 4, one + 5, one + 6, one + 7,
  one + 8, one + 8, one + 8,
];

export const cases: LimitCase[] = [
  /* ── 十三么 Thirteen Orphans ───────────────────────────────────────────── */

  {
    ...base,
    id: "limit-thirteen-orphans-single-wait-discard",
    description:
      "Twelve orphan kinds plus a 中 pair, waiting only on 白, won from a discard. 十三么 subsumes 門前清, so it pays exactly 13 and is NOT capped.",
    concealed: [m(1), m(9), s(1), s(9), t(1), t(9), EAST, SOUTH, WEST, NORTH, RED_DRAGON, RED_DRAGON, GREEN_DRAGON],
    melds: [],
    flowers: [PLUM], // 梅 is 東's flower; this seat is 南, so it pays nothing and keeps 無花 off.
    winningTile: WHITE_DRAGON,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 13,
    capped: false,
    expected: { faan: 13, awards: ["thirteenOrphans"], legal: true },
    contested:
      "patterns.ts has 十三么 subsume 門前清 on the grounds that the hand cannot be melded at all. Houses that stack them instead score a raw 14 and pay the same 13 — identical payout, different award list, and the event log stores the list.",
  },
  {
    ...base,
    id: "limit-thirteen-orphans-thirteen-wait-self-draw",
    description:
      "All thirteen orphan kinds held, self-drawing 白 to pair it — the thirteen-sided wait. 自摸 and 無花 ride on top for a raw 15.",
    concealed: ORPHANS,
    melds: [],
    flowers: [],
    winningTile: WHITE_DRAGON,
    selfDraw: true,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    rawFaan: 15,
    capped: true,
    expected: { faan: 13, awards: ["thirteenOrphans", "selfDraw", "noFlowers"], legal: true },
    contested:
      "Houses that price the thirteen-sided wait 純正十三么 above the single wait cannot express it under a 13 cap — both forms pay 13. Recorded because a preset with a higher limit would have to split the award id, and nothing in the catalogue does today.",
  },
  {
    ...base,
    id: "limit-thirteen-orphans-liu-variant",
    ruleset: "liu",
    description:
      "LIU variant, deliberately: the same 十三么 self-drawn. LIU prices it at the limit too, so only 自摸 stacks — raw 14, capped at LIU's own limitFaan of 13.",
    concealed: ORPHANS,
    melds: [],
    flowers: [PLUM], // 東's flower held by 南 — deliberately scores nothing under either preset.
    winningTile: NORTH,
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 14,
    capped: true,
    expected: { faan: 13, awards: ["thirteenOrphans", "selfDraw"], legal: true },
    contested:
      "The two sources for LIU disagree about bonus tiles: basic-full-flush-liu-seven states LIU has no flowers and no 門前清, while rulesets/src/presets.ts LIU sets useFlowers true and prices ownFlower, noFlowers and concealedHand. This case is built to be immune — it holds another seat's flower, so neither reading changes the answer. The disagreement itself still needs settling.",
  },

  /* ── 九蓮寶燈 Nine Gates ───────────────────────────────────────────────── */

  {
    ...base,
    id: "limit-nine-gates-self-draw",
    description:
      "1112345678999筒 self-drawing 5筒. 九蓮寶燈 subsumes both 門前清 and 清一色, so only 自摸 stacks — raw 14, the narrowest crossing a named limit hand can make.",
    concealed: nineGatesHand(t(1)),
    melds: [],
    flowers: [ORCHID], // 蘭 is 南's flower and this seat is 東 — pays nothing.
    winningTile: t(5),
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    rawFaan: 14,
    capped: true,
    expected: { faan: 13, awards: ["nineGates", "selfDraw"], legal: true },
    contested:
      "Both presets pay 九蓮寶燈 a flat limit and let it swallow 清一色. Wikipedia alone prices it 4 + the flush's 6 for 10 effective, under which this hand is an uncapped 11 rather than a capped 13 — a house preset taking that reading changes the payout, not just the award list.",
  },
  {
    ...base,
    id: "limit-nine-gates-on-last-tile",
    description:
      "The same shape in 索, completed by the very last tile off the wall: 九蓮寶燈 13 + 自摸 + 海底撈月 + 無花 = raw 16.",
    concealed: nineGatesHand(s(1)),
    melds: [],
    flowers: [],
    winningTile: s(5),
    selfDraw: true,
    seatWind: 3,
    roundWind: 2,
    isDealer: false,
    onLastTile: true,
    rawFaan: 16,
    capped: true,
    expected: {
      faan: 13,
      awards: ["nineGates", "selfDraw", "winOnLastTile", "noFlowers"],
      legal: true,
    },
  },
  {
    ...base,
    id: "limit-nine-gates-near-miss-full-flush",
    description:
      "Guard: 111222345678 99筒 is a concealed 清一色 but NOT 九蓮寶燈 — the multiset is wrong (2筒 tripled, 9筒 only paired). 6 + 1 = 7, nowhere near the limit.",
    concealed: [t(1), t(1), t(1), t(2), t(2), t(2), t(3), t(4), t(5), t(6), t(7), t(8), t(9)],
    melds: [],
    flowers: [PLUM],
    winningTile: t(9),
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 7,
    capped: false,
    expected: { faan: 7, awards: ["fullFlush", "concealedHand"], legal: true },
  },

  /* ── 天糊 Heavenly Hand ────────────────────────────────────────────────── */

  {
    ...base,
    id: "limit-heavenly-hand-all-chows",
    description:
      "東 is dealt a complete hand — 123萬 567萬 123索 123筒 with 5筒 eyes — and wins before anyone discards. 天糊 13 over an otherwise ordinary 平糊: raw 16.",
    concealed: [m(1), m(2), m(3), m(5), m(6), m(7), s(1), s(2), s(3), t(1), t(2), t(3), t(5)],
    melds: [],
    flowers: [],
    winningTile: t(5),
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    opening: "heavenly",
    rawFaan: 16,
    capped: true,
    expected: {
      faan: 13,
      awards: ["heavenlyHand", "allChows", "selfDraw", "noFlowers"],
      legal: true,
    },
  },
  {
    ...base,
    id: "limit-heavenly-hand-after-flower-replacement",
    description:
      "The same dealt hand, except 東 opened with 梅 and the replacement draw is what completed it. 正花 replaces 無花; whether it is still 天糊 is the whole point of the case.",
    concealed: [m(1), m(2), m(3), m(5), m(6), m(7), s(1), s(2), s(3), t(1), t(2), t(3), t(5)],
    melds: [],
    flowers: [PLUM], // 梅 IS 東's own flower here, so 正花 fires.
    winningTile: t(5),
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    opening: "heavenly",
    rawFaan: 16,
    capped: true,
    expected: {
      faan: 13,
      awards: ["heavenlyHand", "allChows", "selfDraw", "ownFlower"],
      legal: true,
    },
    contested:
      "Houses split on whether a hand completed by a flower REPLACEMENT still counts as 天糊: strict tables require the untouched opening fourteen and score this 3 (平糊 1 + 自摸 1 + 正花 1), which is barely legal. 13 versus 3 is the largest disagreement anywhere in this family.",
  },
  {
    ...base,
    id: "limit-heavenly-hand-is-thirteen-orphans",
    description:
      "Two limit patterns at once: 東's opening fourteen is 十三么, pairing 東 itself. Raw 28 — the deepest crossing here, and the case that proves the cap is a clamp and not a saturating add.",
    concealed: ORPHANS,
    melds: [],
    flowers: [],
    winningTile: EAST,
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    opening: "heavenly",
    rawFaan: 28,
    capped: true,
    expected: {
      faan: 13,
      awards: ["heavenlyHand", "thirteenOrphans", "selfDraw", "noFlowers"],
      legal: true,
    },
    contested:
      "Some houses treat limit hands as exclusive — you name ONE, it pays the limit, and 天糊 and 十三么 never appear on a sheet together. The payout is 13 either way; the award list is not, and the replay viewer renders the list.",
  },
  {
    ...base,
    id: "limit-heavenly-hand-non-dealer-guard",
    description:
      "Guard: 南 self-draws a complete concealed hand on its very first draw. That is NOT 天糊 — 天糊 belongs to 東 alone — so it is a plain 4-faan win.",
    concealed: [m(1), m(2), m(3), m(5), m(6), m(7), m(9), s(4), s(5), s(6), t(4), t(5), t(6)],
    melds: [],
    flowers: [],
    winningTile: m(9),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 4,
    capped: false,
    expected: {
      faan: 4,
      awards: ["allChows", "concealedHand", "selfDraw", "noFlowers"],
      legal: true,
    },
    contested:
      "A few houses award a non-dealer's first-draw win as 人和. It is not canonical HKOS and neither preset implements it; recorded so the omission reads as a decision rather than an oversight.",
  },

  /* ── 地糊 Earthly Hand ─────────────────────────────────────────────────── */

  {
    ...base,
    id: "limit-earthly-hand-dealer-first-discard",
    description:
      "西 wins on 東's opening discard with a fully concealed 平糊. 地糊 13 subsumes 門前清, so only 平糊 stacks: raw 14, the narrowest crossing in the family.",
    concealed: [m(2), m(3), m(4), m(6), m(6), s(3), s(4), s(5), s(7), s(8), t(6), t(7), t(8)],
    melds: [],
    flowers: [PLUM],
    winningTile: s(9),
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    opening: "earthly",
    rawFaan: 14,
    capped: true,
    expected: { faan: 13, awards: ["earthlyHand", "allChows"], legal: true },
    contested:
      "Two splits at once. (a) 地糊 is a limit hand in most HK houses but scored well below 天糊 in some. (b) Houses disagree whether it must be the DEALER's first discard or any discard before the winner's first draw. GoldenCase carries no discarder seat, so the intent lives in `opening` and in this note — it is not checkable from the fixture alone.",
  },
  {
    ...base,
    id: "limit-earthly-hand-half-flush-contested-value",
    description:
      "北 wins on 東's opening discard holding 123 456 789索, a concealed 東 pung and 中 eyes: 地糊 13 + 混一色 3 + 圈風 1 = raw 17. Under a house that drops 地糊 it is a legal 5.",
    concealed: [s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9), EAST, EAST, EAST, RED_DRAGON],
    melds: [],
    flowers: [PLUM],
    winningTile: RED_DRAGON,
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    opening: "earthly",
    rawFaan: 17,
    capped: true,
    expected: { faan: 13, awards: ["earthlyHand", "halfFlush", "roundWind"], legal: true },
    contested:
      "The pair is 中 rather than a pung, so no 三元牌 faan, and the 東 pung pays 圈風 only because this seat is 北 — deliberately, so the wind arithmetic under the limit pattern is visible. A house that does not award 地糊 scores this 5 (混一色 3 + 圈風 1 + 門前清 1), which is why the case carries real faan underneath rather than being padded to the cap by 地糊 alone.",
  },

  /* ── 海底撈月 last tile · 河底撈魚 last discard ────────────────────────── */

  {
    ...base,
    id: "limit-last-tile-half-flush-self-draw",
    description:
      "南 self-draws the final wall tile to pair 中, holding a melded 索 chow and pung plus a concealed 南 pung: 混一色 3 + 門風 1 + 自摸 1 + 海底撈月 1 = 6, well under the cap.",
    concealed: [s(7), s(8), s(9), SOUTH, SOUTH, SOUTH, RED_DRAGON],
    melds: [chow(1, s(1)), pung(2, s(5))],
    flowers: [PLUM],
    winningTile: RED_DRAGON,
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    onLastTile: true,
    rawFaan: 6,
    capped: false,
    expected: {
      faan: 6,
      awards: ["halfFlush", "seatWind", "selfDraw", "winOnLastTile"],
      legal: true,
    },
  },
  {
    ...base,
    id: "limit-last-tile-lifts-over-floor",
    description:
      "A melded 平糊 that would be refused at 2: the last tile off the wall supplies the third faan. 平糊 1 + 自摸 1 + 海底撈月 1 = exactly the floor.",
    concealed: [m(5), s(2), s(3), s(4), s(6), s(7), s(8)],
    melds: [chow(1, m(1)), chow(1, t(4))],
    flowers: [PLUM],
    winningTile: m(5),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    onLastTile: true,
    rawFaan: 3,
    capped: false,
    expected: { faan: 3, awards: ["allChows", "selfDraw", "winOnLastTile"], legal: true },
    contested:
      "Two of the six compared systems do not list 海底撈月 at all. There this hand is 2 faan and MAY NOT BE TAKEN — legality, not just value, turns on a situational award.",
  },
  {
    ...base,
    id: "limit-last-discard-all-pungs-half-flush",
    description:
      "西 wins on the very last discard of the hand — 河底撈魚 — with 對對糊 in 筒 and honours plus a 西 pung: 3 + 3 + 1 + 1 = 8.",
    concealed: [t(9), t(9), t(9), WHITE_DRAGON],
    melds: [pung(0, t(2)), pung(1, t(6)), pung(3, WEST)],
    flowers: [PLUM],
    winningTile: WHITE_DRAGON,
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    onLastDiscard: true,
    rawFaan: 8,
    capped: false,
    expected: {
      faan: 8,
      awards: ["allPungs", "halfFlush", "seatWind", "winOnLastDiscard"],
      legal: true,
    },
    contested:
      "河底撈魚 has no id in rulesets/src/patterns.ts today, so this case names one and prices it 1. Many HK houses fold it into 海底撈月 and emit a single id for both; a minority award the last-discard win nothing, scoring this 7. The reducer reaches a distinguishable state either way (§5.2), so merging them is a ruleset config choice, not a modelling one.",
  },
  {
    ...base,
    id: "limit-last-discard-below-floor-refused",
    description:
      "北 wins on the last discard with a melded 平糊 and 9萬 eyes: 1 + 1 = 2. Refused — 河底撈魚 is not a free pass over the 3-faan floor.",
    concealed: [m(9), t(1), t(2), t(3), t(5), t(6), t(7)],
    melds: [chow(3, m(1)), chow(3, s(4))],
    flowers: [PLUM],
    winningTile: m(9),
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    onLastDiscard: true,
    rawFaan: 2,
    capped: false,
    expected: { faan: 2, awards: ["allChows", "winOnLastDiscard"], legal: false },
  },

  /* ── crossing the cap without a 13-faan pattern ────────────────────────── */

  {
    ...base,
    id: "limit-big-three-dragons-caps",
    description:
      "大三元 — pungs of 中 發 白 melded, a concealed 1索 pung and 北 eyes. 8 + 對對糊 3 + 混一色 3 = raw 14 with no 13-faan pattern anywhere in the list.",
    // The 北 PAIR pays nothing: only a pung or kong of the seat wind scores 門風.
    concealed: [s(1), s(1), s(1), NORTH],
    melds: [pung(0, RED_DRAGON), pung(1, GREEN_DRAGON), pung(2, WHITE_DRAGON)],
    flowers: [PLUM],
    winningTile: NORTH,
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    rawFaan: 15,
    capped: true,
    expected: { faan: 13, awards: ["mixedTerminals", "bigThreeDragons", "allPungs", "halfFlush"], legal: true },
    contested:
      "大三元 is 8 in this column and a flat limit in other houses. Both land on 13 here, but only because 對對糊 and 混一色 are unavoidable in the shape — the engine must not infer the two readings are equivalent. 小三元 and the three 三元牌 pungs are subsumed per patterns.ts; some sheets list them.",
  },

  /* ── 清么九 and 四暗刻 — limit NAMES that need help to reach the limit ─── */

  {
    ...base,
    id: "limit-all-terminals-accumulates-to-thirteen",
    description:
      "清么九 with two pungs melded, self-drawn on the last wall tile. Owner ruling 2026-08-26: the shape implies all pungs, so 對對糊 is subsumed — 7 + 自摸 1 + 海底撈月 1 + 無花 1 = 10.",
    concealed: [s(1), s(1), s(1), t(1), t(1), t(1), t(9)],
    melds: [pung(0, m(1)), pung(2, s(9))],
    flowers: [],
    winningTile: t(9),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    onLastTile: true,
    rawFaan: 10,
    capped: false,
    expected: {
      faan: 10,
      awards: ["allTerminals", "selfDraw", "winOnLastTile", "noFlowers"],
      legal: true,
    },
    contested:
      "清么九 is 7 in this column and a flat limit in other houses, including LIU. At a flat 13 this hand caps instead of landing on 13 — same payout, different `capped` flag, and the flag is what a higher-limit house preset would key off. 混么九 is subsumed either way.",
  },
  {
    ...base,
    id: "limit-all-terminals-four-concealed-pungs-caps",
    description:
      "The same tiles held fully concealed and self-drawn: 四暗刻 13 (which subsumes 對對糊 and 門前清) stacks on 清么九 7 for a raw 22. Two limit hands from different pattern families in one shape.",
    concealed: [m(1), m(1), m(1), s(1), s(1), s(1), s(9), s(9), s(9), t(1), t(1), t(1), t(9)],
    melds: [],
    flowers: [],
    winningTile: t(9),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 22,
    capped: true,
    expected: {
      faan: 13,
      awards: ["fourConcealedPungs", "allTerminals", "selfDraw", "noFlowers"],
      legal: true,
    },
    contested:
      "patterns.ts notes that houses conflict on whether 四暗刻 can be won on a discard at all. This case self-draws, so it is the uncontested form — but it pairs with limit-all-terminals-accumulates-to-thirteen, where melding two pungs drops the same fourteen tiles from a raw 22 to a raw 13.",
  },

  /* ── the cap reached with no special pattern whatsoever ────────────────── */

  {
    ...base,
    id: "limit-full-flush-all-pungs-melded",
    description:
      "清一色 對對糊 in 筒 with two pungs melded, won from a discard and no bonus tile all hand: 6 + 3 + 無花 1 = 10. The baseline for the case below.",
    concealed: [t(5), t(5), t(5), t(7), t(7), t(7), t(9)],
    melds: [pung(1, t(1)), pung(2, t(3))],
    flowers: [],
    winningTile: t(9),
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    rawFaan: 10,
    capped: false,
    expected: { faan: 10, awards: ["fullFlush", "allPungs", "noFlowers"], legal: true },
  },
  {
    ...base,
    id: "limit-full-flush-four-concealed-pungs-caps",
    description:
      "The SAME fourteen tiles, nothing melded, self-drawn: 四暗刻 13 + 清一色 6 + 自摸 1 + 無花 1 = raw 21. Exposure alone moves the hand from an uncapped 10 to a capped 13.",
    concealed: [t(1), t(1), t(1), t(3), t(3), t(3), t(5), t(5), t(5), t(7), t(7), t(7), t(9)],
    melds: [],
    flowers: [],
    winningTile: t(9),
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    rawFaan: 21,
    capped: true,
    expected: {
      faan: 13,
      awards: ["fourConcealedPungs", "fullFlush", "selfDraw", "noFlowers"],
      legal: true,
    },
  },

  /* ── authored 2026-08-26 to complete the family's own 25-case spec ─────── */

  {
    ...base,
    id: "limit-nine-gates-liu-reaches-limit",
    description:
      "The nine-gates pair partner: the SAME 14 tiles as limit-nine-gates-self-draw under LIU, won on a discard instead. 九蓮寶燈 is 13 flat in both presets, so without 自摸 the hand REACHES the limit exactly and is not capped — the partner crosses it by one.",
    ruleset: "liu",
    concealed: nineGatesHand(t(1)),
    melds: [],
    flowers: [ORCHID], // matched to the partner so the tile multiset is identical
    winningTile: t(5),
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    rawFaan: 13,
    capped: false,
    expected: { faan: 13, awards: ["nineGates"], legal: true },
  },

  {
    ...base,
    id: "limit-small-three-dragons-lands-exactly",
    description:
      "小三元 5 + 混一色 3 + 對對糊 3 + 自摸 1 + 無花 1 = exactly 13, uncapped. Landing on the limit is not crossing it — capped stays false.",
    concealed: [s(2), s(2), s(2), s(7), s(7), WHITE_DRAGON, WHITE_DRAGON],
    melds: [pung(2, RED_DRAGON), pung(3, GREEN_DRAGON)],
    flowers: [],
    winningTile: s(7),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 13,
    capped: false,
    expected: {
      faan: 13,
      awards: ["smallThreeDragons", "halfFlush", "allPungs", "selfDraw", "noFlowers"],
      legal: true,
    },
  },

  {
    ...base,
    id: "limit-big-three-dragons-lands-exactly",
    description:
      "大三元 8 + 混一色 3 + 河底撈魚 1 + 無花 1 = exactly 13 with a chow keeping 對對糊 out. A second exact landing by a different route, so the boundary is not one lucky sum.",
    concealed: [s(3), s(4), s(9), s(9)],
    melds: [pung(2, RED_DRAGON), pung(3, GREEN_DRAGON), pung(0, WHITE_DRAGON)],
    flowers: [],
    winningTile: s(5),
    selfDraw: false,
    onLastDiscard: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 13,
    capped: false,
    expected: {
      faan: 13,
      awards: ["bigThreeDragons", "halfFlush", "winOnLastDiscard", "noFlowers"],
      legal: true,
    },
  },
];

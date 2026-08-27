/**
 * Golden hands — basic patterns and the 3-faan floor. DESIGN.md §4 (canonical
 * HK Old Style, 3-faan minimum, rulesets-as-data) and §8 (this suite is the
 * only validation source for exposed melds, winds and dealer context).
 *
 * The family covers 平糊 All Chows, 對對糊 All Pungs, the flush pair 混一色 /
 * 清一色, 門前清 concealed hands, and — the point of the family — 雞糊 chicken
 * hands: complete 14-tile shapes that score under 3 faan and therefore MAY NOT
 * BE TAKEN. Several pairs of cases are the SAME fourteen tiles won in different
 * ways, so an engine that ignores exposure or self-draw fails them loudly.
 *
 * Faan values follow the faan table cited by DESIGN.md §4 (content-strategy 05,
 * itself sourced from mjrc-admin/reference/hk-scoring-calculator.xlsx). Where
 * the six compared house systems in that sheet disagree, the case carries a
 * `contested` note instead of quietly picking a winner.
 *
 * Two conventions this file assumes, because GoldenCase does not carry them:
 *   - The winner's SEAT INDEX equals their seatWind. Meld.from is a seat index,
 *     so without that identity "claimed from the left" is unexpressible.
 *   - A hand with no bonus tiles scores 無花 noFlowers. That is 1 faan in all
 *     six systems, so `flowers: []` is never a neutral choice — cases that do
 *     not mean to test it hold one flower belonging to ANOTHER seat, which
 *     scores nothing.
 *
 * Terminology: ../../../TERMINOLOGY.md. HK only.
 */
import type { Meld, SeatIndex, TileId } from "../../src/types.js";
import type { GoldenCase } from "./case.js";

/* ── tile ids, written the way the MJRC scoring pages write them ────────────
 * m = 萬 characters (0-8) · s = 索 bamboo (9-17) · t = 筒 circles (18-26).
 * Ranks are 1-9, so m(1) is 1萬 = id 0. Honours and flowers are named.        */
const m = (rank: number): TileId => rank - 1;
const s = (rank: number): TileId => 8 + rank;
const t = (rank: number): TileId => 17 + rank;

const EAST = 27, SOUTH = 28, WEST = 29, NORTH = 30;
const RED_DRAGON = 31, GREEN_DRAGON = 32, WHITE_DRAGON = 33;
const PLUM = 34, ORCHID = 35, CHRYSANTHEMUM = 36, BAMBOO_FLOWER = 37;
const SPRING = 38;

const SOURCE = "content-strategy/05 faan table (mjrc-admin/reference/hk-scoring-calculator.xlsx)";

/**
 * A chow may only be claimed from the upper house 上家 — the seat to your left,
 * which plays immediately before you. With turn order 東→南→西→北 that is
 * (seat + 3) % 4, so the helper derives `from` rather than trusting a literal.
 */
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

/** Every case in this file is unvalidated (§8) and scored under the same base rules. */
const base = { ruleset: "hkos-standard", provisional: true, source: SOURCE } as const;

export const cases: GoldenCase[] = [
  /* ── 平糊 All Chows ─────────────────────────────────────────────────────── */

  {
    ...base,
    id: "basic-all-chows-melded-chicken",
    description:
      "123萬 / 456索 melded, 789筒 234筒 and a pair of 8索 in hand — 平糊 alone is 1 faan, refused.",
    concealed: [t(7), t(8), t(9), t(2), t(3), t(4), s(8)],
    melds: [chow(0, m(1)), chow(0, s(4))],
    flowers: [ORCHID],
    winningTile: s(8),
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: { faan: 1, awards: ["allChows"], legal: false },
  },
  {
    ...base,
    id: "basic-all-chows-concealed-discard-short",
    description:
      "Fully concealed all-chows won on a discard: 平糊 + 門前清 is 2 faan, one short of the floor.",
    concealed: [m(1), m(2), m(3), m(4), m(5), m(6), s(2), s(3), s(4), t(6), t(7), t(8), t(5)],
    melds: [],
    flowers: [PLUM],
    winningTile: t(5),
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 2, awards: ["allChows", "concealedHand"], legal: false },
    contested:
      "One of the six compared systems (MJ Time) does not award 門前清 at all; there the hand is 1 faan. The refusal stands either way.",
  },
  {
    ...base,
    id: "basic-all-chows-concealed-selfdraw-floor",
    description:
      "The same concealed all-chows hand self-drawn instead: 平糊 + 門前清 + 自摸 reaches exactly 3 and may be taken.",
    concealed: [m(1), m(2), m(3), m(4), m(5), m(6), s(2), s(3), s(4), t(6), t(7), t(8), t(5)],
    melds: [],
    flowers: [PLUM],
    winningTile: t(5),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 3, awards: ["allChows", "concealedHand", "selfDraw"], legal: true },
    contested:
      "Legality turns entirely on 門前清. A house that does not award it scores 2 and must refuse this win.",
  },
  {
    ...base,
    id: "basic-all-chows-honour-eyes-contested",
    description:
      "Concealed self-drawn all-chows whose eyes are a pair of 白 — legal only if 平糊 permits honour eyes.",
    concealed: [m(1), m(2), m(3), m(4), m(5), m(6), s(2), s(3), s(4), t(2), t(3), t(4), WHITE_DRAGON],
    melds: [],
    flowers: [PLUM],
    winningTile: WHITE_DRAGON,
    selfDraw: true,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    expected: { faan: 3, awards: ["allChows", "concealedHand", "selfDraw"], legal: true },
    contested:
      "Some houses require 平糊's eyes to be a suited tile; there this scores 2 (門前清 + 自摸) and is refused. A pair of dragons never scores on its own either way.",
  },
  {
    ...base,
    id: "basic-all-chows-selfdraw-melded-short",
    description:
      "Melded all-chows, self-drawn: 平糊 + 自摸 is 2 faan. 自摸 does not rescue a chicken hand.",
    concealed: [t(1), t(2), t(3), t(4), t(5), t(6), s(5)],
    melds: [chow(3, m(1)), chow(3, m(4))],
    flowers: [PLUM],
    winningTile: s(5),
    selfDraw: true,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 2, awards: ["allChows", "selfDraw"], legal: false },
  },

  /* ── 對對糊 All Pungs ───────────────────────────────────────────────────── */

  {
    ...base,
    id: "basic-all-pungs-melded-floor",
    description:
      "Three melded pungs, a concealed 北 pung and 9萬 eyes — 對對糊 alone is exactly the 3-faan floor.",
    concealed: [NORTH, NORTH, NORTH, m(9)],
    melds: [pung(2, m(5)), pung(3, t(5)), pung(0, s(5))],
    flowers: [PLUM],
    winningTile: m(9),
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 3, awards: ["allPungs"], legal: true },
  },
  {
    ...base,
    id: "basic-all-pungs-seat-wind",
    description:
      "對對糊 with a melded 南 pung taken by the South seat in the East round — 3 + 座位風 1.",
    concealed: [t(5), t(5), t(5), t(8)],
    melds: [pung(2, SOUTH), pung(3, m(1)), pung(0, s(9))],
    flowers: [PLUM],
    winningTile: t(8),
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 4, awards: ["allPungs", "seatWind"], legal: true },
  },
  {
    ...base,
    id: "basic-all-pungs-double-east-dealer",
    description:
      "Dealer in the East round pungs 東 — the wind pays twice, once as seat and once as round: 對對糊 3 + 1 + 1.",
    concealed: [m(7), m(7), m(7), s(6)],
    melds: [pung(1, EAST), pung(2, s(2)), pung(3, t(3))],
    flowers: [ORCHID],
    winningTile: s(6),
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: { faan: 5, awards: ["allPungs", "seatWind", "roundWind"], legal: true },
  },
  {
    ...base,
    id: "basic-all-pungs-round-wind-only",
    description:
      "West seat pungs 東 in the East round: the round wind pays, the seat wind does not — 對對糊 3 + 圈風 1.",
    concealed: [s(8), s(8), s(8), s(3)],
    melds: [pung(3, EAST), pung(0, m(9)), pung(1, t(4))],
    flowers: [ORCHID],
    winningTile: s(3),
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 4, awards: ["allPungs", "roundWind"], legal: true },
  },
  {
    ...base,
    id: "basic-all-pungs-concealed-discard",
    description:
      "Concealed 對對糊 where the discard completes the fourth pung — three concealed pungs only, so no limit hand.",
    concealed: [m(1), m(1), m(1), s(5), s(5), s(5), t(5), t(5), t(5), NORTH, NORTH, m(7), m(7)],
    melds: [],
    flowers: [PLUM],
    winningTile: m(7),
    selfDraw: false,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    expected: { faan: 4, awards: ["allPungs", "concealedHand"], legal: true },
    contested:
      "門前清 again: a house that omits it scores 3, still legal. A discard-completed pung is not concealed, so 四暗刻 is correctly not awarded here.",
  },

  /* ── 雞糊 chicken hands — complete shapes that may not be taken ─────────── */

  {
    ...base,
    id: "basic-mixed-chicken-zero",
    description:
      "Three chows, a pung of 5索 and 5萬 eyes: nothing scores. The textbook 雞糊 at 0 faan.",
    concealed: [t(2), t(3), t(4), t(6), t(7), t(8), m(5)],
    melds: [chow(0, m(1)), pung(1, s(5))],
    flowers: [CHRYSANTHEMUM],
    winningTile: m(5),
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: { faan: 0, awards: [], legal: false },
  },
  {
    ...base,
    id: "basic-mixed-chicken-wrong-wind-pung",
    description:
      "East seat in the East round melds a 西 pung — a wind that is neither seat nor round scores nothing, and the hand dies at 0.",
    concealed: [t(1), t(2), t(3), t(5), t(6), t(7), m(4)],
    melds: [pung(1, WEST), chow(0, s(2))],
    flowers: [ORCHID],
    winningTile: m(4),
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: { faan: 0, awards: [], legal: false },
  },
  {
    ...base,
    id: "basic-mixed-chicken-no-flowers-one",
    description:
      "The same mistake with not a single bonus tile all hand: 無花 pays 1 and the hand is still refused.",
    concealed: [m(4), m(5), m(6), s(6), s(7), s(8), t(6)],
    melds: [pung(0, WEST), chow(3, t(1))],
    flowers: [],
    winningTile: t(6),
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 1, awards: ["noFlowers"], legal: false },
  },
  {
    ...base,
    id: "basic-mixed-concealed-selfdraw-short",
    description:
      "Concealed, self-drawn, and still refused: a mixed hand with 西 eyes scores only 門前清 + 自摸 = 2.",
    concealed: [m(1), m(2), m(3), m(4), m(5), m(6), t(3), t(3), t(3), s(7), s(8), s(9), WEST],
    melds: [],
    flowers: [BAMBOO_FLOWER],
    winningTile: WEST,
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: { faan: 2, awards: ["concealedHand", "selfDraw"], legal: false },
    contested:
      "A house that omits 門前清 scores 1. Refused either way — the point of the case is that concealment plus 自摸 is not enough.",
  },
  {
    ...base,
    id: "basic-mixed-dragon-pung-melded-short",
    description:
      "A melded 中 pung with two melded chows: one dragon pung is 1 faan and the hand may not be taken.",
    concealed: [t(6), t(7), t(8), m(6)],
    melds: [pung(3, RED_DRAGON), chow(2, m(1)), chow(2, s(2))],
    flowers: [PLUM],
    winningTile: m(6),
    selfDraw: false,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    expected: { faan: 1, awards: ["dragonPung"], legal: false },
  },
  {
    ...base,
    id: "basic-mixed-dragon-pung-concealed-selfdraw-floor",
    description:
      "The identical fourteen tiles kept concealed and self-drawn: 中刻 + 門前清 + 自摸 = 3 and the win is legal.",
    concealed: [RED_DRAGON, RED_DRAGON, RED_DRAGON, m(1), m(2), m(3), s(2), s(3), s(4), t(6), t(7), t(8), m(6)],
    melds: [],
    flowers: [PLUM],
    winningTile: m(6),
    selfDraw: true,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    expected: { faan: 3, awards: ["dragonPung", "concealedHand", "selfDraw"], legal: true },
    contested:
      "Legality turns on 門前清. Without it the hand is 2 faan and refused, which is exactly the pairing with basic-mixed-dragon-pung-melded-short.",
  },

  /* ── 混一色 / 清一色 flushes ────────────────────────────────────────────── */

  {
    ...base,
    id: "basic-half-flush-melded-floor",
    description:
      "Characters plus a 東 pung and 白 eyes — 混一色 is 3 faan on its own, so the pattern alone clears the floor.",
    concealed: [m(4), m(5), m(6), m(7), m(8), m(9), WHITE_DRAGON],
    melds: [chow(2, m(1)), pung(3, EAST)],
    flowers: [PLUM],
    winningTile: WHITE_DRAGON,
    selfDraw: false,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    expected: { faan: 3, awards: ["halfFlush"], legal: true },
  },
  {
    ...base,
    id: "basic-half-flush-all-chows-honour-eyes",
    description:
      "Four character chows with 發 eyes: 混一色 3 stacks with 平糊 1 for 4 faan.",
    concealed: [m(3), m(4), m(5), m(6), m(7), m(8), GREEN_DRAGON],
    melds: [chow(1, m(1)), chow(1, m(4))],
    flowers: [PLUM],
    winningTile: GREEN_DRAGON,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 4, awards: ["halfFlush", "allChows"], legal: true },
    contested:
      "Houses that require suited eyes for 平糊 drop that 1 faan and score 3. Legal either way — 混一色 carries the hand.",
  },
  {
    ...base,
    id: "basic-full-flush-melded",
    description:
      "Every tile a 筒: 清一色 at 6 faan even with a melded chow and pung.",
    concealed: [t(3), t(4), t(5), t(6), t(7), t(8), t(1)],
    melds: [chow(0, t(1)), pung(1, t(9))],
    flowers: [ORCHID],
    winningTile: t(1),
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: { faan: 6, awards: ["fullFlush"], legal: true },
    contested:
      "清一色 is 6 in four of the six compared systems and 7 in LIU and L2. See basic-full-flush-liu-seven for the 7-faan reading.",
  },
  {
    ...base,
    id: "basic-full-flush-liu-seven",
    ruleset: "liu",
    description:
      "LIU variant, deliberately: 清一色 is 7 there, and LIU has no 門前清, no wind faan and no flowers at all (ENGINE-AUDIT §1), so a concealed self-drawn full flush of chows is 7 + 1 + 1 = 9.",
    concealed: [t(1), t(2), t(3), t(4), t(5), t(6), t(7), t(8), t(9), t(2), t(3), t(4), t(6)],
    melds: [],
    flowers: [],
    winningTile: t(6),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 11, awards: ["concealedHand", "noFlowers", "fullFlush", "allChows", "selfDraw"], legal: true },
  },
  {
    ...base,
    id: "basic-full-flush-all-chows",
    description:
      "清一色 6 plus 平糊 1 — four 筒 chows and 8筒 eyes, one chow melded so 門前清 does not apply.",
    concealed: [t(4), t(5), t(6), t(7), t(8), t(9), t(2), t(3), t(4), t(8)],
    melds: [chow(3, t(1))],
    flowers: [PLUM],
    winningTile: t(8),
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 7, awards: ["fullFlush", "allChows"], legal: true },
  },
  {
    ...base,
    id: "basic-full-flush-all-pungs-selfdraw",
    description:
      "清一色 6 + 對對糊 3 + 自摸 1 in 索. The exposed 1索 pung keeps it out of both 門前清 and the four-concealed-pungs limit hand.",
    concealed: [s(4), s(4), s(4), s(7), s(7), s(7), s(9), s(9), s(9), s(3)],
    melds: [pung(0, s(1))],
    flowers: [PLUM],
    winningTile: s(3),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 10, awards: ["fullFlush", "allPungs", "selfDraw"], legal: true },
  },

  /* ── 混么九 and the single-faan margin ──────────────────────────────────── */

  {
    ...base,
    id: "basic-mixed-terminals-all-pungs",
    description:
      "Pungs of 1萬 9筒 1索 and 北 with 白 eyes — 混么九 1 stacks on 對對糊 3. The 白 pair scores nothing.",
    concealed: [NORTH, NORTH, NORTH, WHITE_DRAGON],
    melds: [pung(1, m(1)), pung(2, t(9)), pung(3, s(1))],
    flowers: [ORCHID],
    winningTile: WHITE_DRAGON,
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: { faan: 4, awards: ["allPungs", "mixedTerminals"], legal: true },
    contested:
      "Two of the six compared systems (MJ Time, MJB) do not list 混么九 at all and score this 3 as a plain 對對糊. Legal either way.",
  },
  {
    ...base,
    id: "basic-own-flowers-lift-over-floor",
    description:
      "East seat holding 梅 and 春 — both its own — turns a 1-faan 平糊 into a legal 3. Legal purely on bonus tiles.",
    concealed: [t(1), t(2), t(3), t(5), t(6), t(7), m(5)],
    melds: [chow(0, m(1)), chow(0, s(1))],
    flowers: [PLUM, SPRING],
    winningTile: m(5),
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: { faan: 3, awards: ["allChows", "ownFlower", "ownSeason"], legal: true },
  },
  {
    ...base,
    id: "basic-no-flowers-lift-over-floor",
    description:
      "Melded all-chows, self-drawn, and not one bonus tile all hand: 平糊 + 自摸 + 無花 is exactly 3.",
    concealed: [s(4), s(5), s(6), s(7), s(8), s(9), m(8)],
    melds: [chow(1, m(1)), chow(1, t(1))],
    flowers: [],
    winningTile: m(8),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 3, awards: ["allChows", "selfDraw", "noFlowers"], legal: true },
    contested:
      "Legality rests on 無花. Every compared system scores it 1, but tables that ignore bonus tiles entirely score 2 and must refuse this win.",
  },
];

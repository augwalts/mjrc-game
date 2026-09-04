/**
 * Golden hands — honours, winds, dealer and bonus tiles. DESIGN.md §4 (canonical
 * HK Old Style: seat and round wind faan, dealer, 8 flowers, 3-faan minimum,
 * 13-faan limit) and §8 (this suite is the ONLY validation source for wind
 * context, dealer context and flowers — the Python reference has none of them).
 *
 * Every case here is PROVISIONAL until a strong HK player signs it off (§8).
 *
 * ── what the family is for ───────────────────────────────────────────────────
 * 門風 seat wind and 圈風 round wind, including the doubled wind where a seat
 * sits in its own round; 三元牌 dragon pungs and the 小三元/大三元 pair;
 * 小四喜/大四喜; the SUBSUMPTION between them; 莊 dealer context; and 花 bonus
 * tiles — own flower, other seats' flowers, a full set of four, and 無花.
 *
 * ── conventions (shared with the other golden families) ─────────────────────
 * Award ids are lowerCamelCase and stable. One id per pattern regardless of set
 * size: a kong of dragons scores exactly what a pung of dragons scores, so both
 * emit "dragonPung", and "seatWind" / "roundWind" likewise cover pung and kong.
 * A REPEATED id means a repeated award — ["dragonPung", "dragonPung"] is two
 * separate 1-faan awards, and ["ownFlower", "ownFlower"] is a seat holding both
 * its flower and its season.
 * KNOWN COLLISION: rulesets/src/patterns.ts catalogues the same patterns under
 * longer ids — dragonPungRed/Green/White, seatWindPung, roundWindPung, and a
 * separate ownSeason. All four golden families use the short ids above. One
 * side has to rename before the scorer is wired up; the values below are the
 * catalogue's either way.
 *
 * `expected.faan` is the FINAL figure after the 13-faan limit 爆棚, not the raw
 * sum. Several hands below sum well past 13; GoldenCase carries no `capped`
 * flag, so the description says so instead.
 *
 * The winner's SEAT INDEX is assumed equal to their seatWind (seat 0 東 is the
 * dealer). Meld.from is a seat index, so without that identity "claimed from
 * the seat on your left" cannot be expressed at all.
 *
 * ── faan values and subsumption ─────────────────────────────────────────────
 * Read off the shipped presets, not invented here: rulesets/src/presets.ts
 * (HKOS_STANDARD / LIU) for the numbers and rulesets/src/patterns.ts for what
 * subsumes what. Rulesets are data (§4), so a case that names a preset and
 * disagrees with its table is simply a wrong case.
 *   hkos-standard:  seatWind 1 · roundWind 1 · dragonPung 1 · ownFlower 1 ·
 *                   noFlowers 1 · allFlowers 2 · allSeasons 2 · selfDraw 1 ·
 *                   concealedHand 1 · allPungs 3 · halfFlush 3 ·
 *                   smallThreeDragons 5 · bigThreeDragons 8 ·
 *                   smallFourWinds 6 · bigFourWinds 10 · allHonours 10
 *   liu:            no bonus tiles, no wind faan, no 門前清 at all —
 *                   smallThreeDragons 4 · selfDraw 1
 * Where the six surveyed house systems disagree with the preset's column, the
 * case carries a `contested` note with the alternative arithmetic spelled out.
 *
 * Subsumption, per patterns.ts, and the reason each is not double-counted:
 *   小三元 takes the two dragon pungs it is built from; 大三元 takes 小三元 and
 *   all three dragon pungs — the reference sheet states outright that the
 *   小三元 value already includes the pungs.
 *   小四喜 takes 門風 and 圈風, and 大四喜 takes 小四喜 as well. A four-winds
 *   hand always contains the seat and round wind, so the pattern's price is
 *   the price of those pungs.
 *   字一色 takes 對對糊 (and 混一色): an all-honour hand cannot hold a run, so
 *   the pungs are the pattern rather than an extra award.
 *
 * 無花 is awarded on every hand that drew no bonus tile at all, so `flowers: []`
 * is never neutral. Cases that do not mean to test bonus tiles hold a flower
 * belonging to another seat, which scores nothing on its own.
 *
 * Tile ids (../../src/types.ts): 0-8 萬 · 9-17 索 · 18-26 筒 ·
 * 27-30 東南西北 · 31-33 中發白 · 34-37 梅蘭菊竹 · 38-41 春夏秋冬.
 * A bonus tile belongs to the seat whose wind index it matches: 梅 and 春 are
 * 東's, 蘭 and 夏 are 南's, and so on.
 *
 * Terminology: ../../../TERMINOLOGY.md. HK only.
 */
import type { Meld, SeatIndex, TileId } from "../../src/types.js";
import type { GoldenCase } from "./case.js";

/* ── tile ids, written the way the MJRC scoring pages write them ────────────
 * m = 萬 characters (0-8) · s = 索 bamboo (9-17) · t = 筒 circles (18-26).
 * Ranks are 1-9, so m(1) is 1萬 = id 0.                                       */
const m = (rank: number): TileId => rank - 1;
const s = (rank: number): TileId => 8 + rank;
const t = (rank: number): TileId => 17 + rank;

const EAST = 27, SOUTH = 28, WEST = 29, NORTH = 30;
const RED = 31, GREEN = 32, WHITE = 33;
/** 梅蘭菊竹 — the flowers, in seat order 東南西北. */
const PLUM = 34, ORCHID = 35, CHRYSANTHEMUM = 36, BAMBOO_FLOWER = 37;
/** 春夏秋冬 — the seasons, in the same seat order. */
const SPRING = 38, SUMMER = 39, AUTUMN = 40, WINTER = 41;

const SOURCE = "mjrc-admin/reference/hk-scoring-calculator.xlsx (FanSlang sheet)";

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

/** 明槓 — claimed from a discard. */
const exposedKong = (from: SeatIndex, tile: TileId): Meld => ({
  kind: "kong",
  tiles: [tile, tile, tile, tile],
  from,
  concealed: false,
});

/** 暗槓 — drawn complete, so the source seat is the owner's own. */
const concealedKong = (seat: SeatIndex, tile: TileId): Meld => ({
  kind: "kong",
  tiles: [tile, tile, tile, tile],
  from: seat,
  concealed: true,
});

/** 加槓 — the fourth tile added onto an exposed pung claimed from `from`. */
const addedKong = (from: SeatIndex, tile: TileId): Meld => ({
  kind: "kong",
  tiles: [tile, tile, tile, tile],
  from,
  concealed: false,
  addedToPung: true,
});

/** Every case in this file is unvalidated (§8) and, bar the LIU one, same rules. */
const base = { ruleset: "hkos-standard", provisional: true, source: SOURCE } as const;

export const cases: GoldenCase[] = [
  /* ── 門風 seat wind and 圈風 round wind ─────────────────────────────────── */

  {
    ...base,
    id: "honours-seat-wind-pung-below-minimum",
    description:
      "East seat pungs 東 in the 南 round: 門風 1 + 無花 1 is 2, so the win is refused.",
    concealed: [m(5)],
    melds: [pung(1, EAST), chow(0, m(1)), chow(0, s(4)), chow(0, t(7))],
    flowers: [],
    winningTile: m(5),
    selfDraw: false,
    seatWind: 0,
    roundWind: 1,
    isDealer: true,
    expected: { faan: 2, awards: ["seatWind", "noFlowers"], legal: false },
  },
  {
    ...base,
    id: "honours-round-wind-pung-below-minimum",
    description:
      "West seat pungs 南 in the 南 round: 圈風 1 + 無花 1 is 2 — a wind that is not yours still pays, but not enough.",
    concealed: [m(9)],
    melds: [pung(3, SOUTH), chow(2, m(1)), chow(2, s(1)), chow(2, t(1))],
    flowers: [],
    winningTile: m(9),
    selfDraw: false,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    expected: { faan: 2, awards: ["roundWind", "noFlowers"], legal: false },
  },
  {
    ...base,
    id: "honours-double-east-dealer-exactly-three",
    description:
      "東 pung by the East seat in the East round — the pung pays twice, as 門風 and as 圈風, and 無花 carries it to exactly 3.",
    concealed: [t(2)],
    melds: [pung(3, EAST), chow(0, m(4)), chow(0, s(7)), chow(0, t(4))],
    flowers: [],
    winningTile: t(2),
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: { faan: 3, awards: ["seatWind", "roundWind", "noFlowers"], legal: true },
  },
  {
    ...base,
    id: "honours-double-west-not-dealer",
    description:
      "西 pung by the West seat in the 西 round — the doubled wind is a seat-and-round coincidence, not a dealer privilege.",
    concealed: [s(5)],
    melds: [pung(1, WEST), chow(2, m(7)), chow(2, s(1)), chow(2, t(7))],
    flowers: [CHRYSANTHEMUM],
    winningTile: s(5),
    selfDraw: false,
    seatWind: 2,
    roundWind: 2,
    isDealer: false,
    expected: { faan: 3, awards: ["seatWind", "roundWind", "ownFlower"], legal: true },
  },
  {
    ...base,
    id: "honours-guest-wind-pung-scores-nothing",
    description:
      "South seat pungs 西 in the East round: a wind that is neither yours nor the round's is worth exactly nothing, leaving 無花 alone at 1.",
    concealed: [t(8)],
    melds: [pung(2, WEST), chow(1, m(1)), chow(1, s(4)), chow(1, t(1))],
    flowers: [],
    winningTile: t(8),
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 1, awards: ["noFlowers"], legal: false },
  },
  {
    ...base,
    id: "honours-round-wind-kong-scores-as-pung",
    description:
      "明槓 of 西 in the 西 round scores the same 1 faan a pung would; with a dragon pung and 竹 (North's own flower) that is exactly 3.",
    concealed: [t(9)],
    melds: [exposedKong(0, WEST), pung(1, RED), chow(3, m(1)), chow(3, s(4))],
    flowers: [BAMBOO_FLOWER],
    winningTile: t(9),
    selfDraw: false,
    seatWind: 3,
    roundWind: 2,
    isDealer: false,
    expected: { faan: 3, awards: ["roundWind", "dragonPung", "ownFlower"], legal: true },
  },
  {
    ...base,
    id: "honours-seat-wind-concealed-kong-two-dragon-pungs",
    description:
      "暗槓 of 西 by the West seat plus 中 and 發 pungs — two dragon pungs with no pair of the third are NOT 小三元, so this is four separate 1-faan awards.",
    concealed: [m(6)],
    melds: [concealedKong(2, WEST), pung(3, RED), pung(0, GREEN), chow(2, t(1))],
    flowers: [],
    winningTile: m(6),
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 4,
      awards: ["seatWind", "dragonPung", "dragonPung", "noFlowers"],
      legal: true,
    },
  },

  /* ── 三元牌 dragons ─────────────────────────────────────────────────────── */

  {
    ...base,
    id: "honours-dragon-pung-own-flower-and-season",
    description:
      "South seat holding both 蘭 and 夏 — its flower AND its season, 1 faan each — lifts a lone 中 pung to a legal 3.",
    concealed: [t(7)],
    melds: [pung(2, RED), chow(1, m(4)), chow(1, s(1)), chow(1, t(1))],
    flowers: [ORCHID, SUMMER],
    winningTile: t(7),
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 3,
      awards: ["dragonPung", "ownFlower", "ownSeason"],
      legal: true,
    },
    contested:
      "Legality rests entirely on bonus tiles. Tables that require the 3-faan minimum from the hand itself (花唔計番) score the hand at 1 and refuse the win; the compared systems all count 正花 toward the total.",
  },

  /* ── 小三元 / 大三元 ────────────────────────────────────────────────────── */

  {
    ...base,
    id: "honours-small-three-dragons",
    description:
      "中 and 發 pungs with a 白 pair — 小三元. The two dragon pungs are inside the pattern's value and are not awarded again.",
    concealed: [WHITE],
    melds: [pung(0, RED), pung(2, GREEN), chow(1, m(4)), chow(1, s(7))],
    flowers: [],
    winningTile: WHITE,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 6, awards: ["smallThreeDragons", "noFlowers"], legal: true },
    contested:
      "The preset prices 小三元 at 5, but three of the six surveyed systems say 4, and a minority of houses add the two dragon pungs on top instead of treating them as included — anywhere from 4 to 7 before 無花.",
  },
  {
    ...base,
    id: "honours-small-three-dragons-double-wind-half-flush",
    description:
      "小三元 with a 東 pung by the dealer in the East round; the only suited set is 筒, so the hand is 混一色 as well.",
    concealed: [WHITE],
    melds: [pung(1, RED), pung(2, GREEN), pung(3, EAST), chow(0, t(1))],
    flowers: [],
    winningTile: WHITE,
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: {
      faan: 11,
      awards: ["smallThreeDragons", "seatWind", "roundWind", "halfFlush", "noFlowers"],
      legal: true,
    },
    contested:
      "Carries the 小三元 5-vs-4 split (see honours-small-three-dragons): 11 here, 10 under the 4-faan reading. 門風/圈風 are untouched — only the FOUR-winds patterns absorb them.",
  },
  {
    ...base,
    id: "honours-small-three-dragons-won-on-third-dragon",
    description:
      "The win completes the 中 PUNG while 白白 already sat in hand — 小三元 does not care which of its parts the winning tile finished.",
    concealed: [RED, RED, WHITE, WHITE],
    melds: [pung(1, GREEN), chow(3, m(1)), chow(3, s(4))],
    flowers: [BAMBOO_FLOWER],
    winningTile: RED,
    selfDraw: false,
    seatWind: 3,
    roundWind: 2,
    isDealer: false,
    expected: { faan: 6, awards: ["smallThreeDragons", "ownFlower"], legal: true },
    contested:
      "Carries the 小三元 5-vs-4 split (see honours-small-three-dragons): 6 here, 5 under the 4-faan reading.",
  },
  {
    ...base,
    id: "honours-big-three-dragons-subsumes-small",
    description:
      "中發白 all pungs — 大三元. The award list must NOT also carry 小三元 or any dragonPung: the big hand swallows both.",
    concealed: [s(8)],
    melds: [pung(0, RED), pung(2, GREEN), pung(3, WHITE), chow(1, m(4))],
    flowers: [],
    winningTile: s(8),
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 9, awards: ["bigThreeDragons", "noFlowers"], legal: true },
    contested:
      "The preset prices 大三元 at 8; three of the surveyed systems say 6 and two make it a flat limit hand (13). The subsumption is not contested — only the number.",
  },
  {
    ...base,
    id: "honours-big-three-dragons-added-kong",
    description:
      "白 upgraded to a kong by 加槓 — the kong form changes nothing: 大三元 still stands and the dragon awards stay subsumed.",
    concealed: [s(3)],
    melds: [pung(3, RED), pung(0, GREEN), addedKong(1, WHITE), chow(2, t(7))],
    flowers: [AUTUMN],
    winningTile: s(3),
    selfDraw: false,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    expected: { faan: 9, awards: ["bigThreeDragons", "ownSeason"], legal: true },
    contested:
      "Carries the 大三元 8/6/limit split (see honours-big-three-dragons-subsumes-small).",
  },
  {
    ...base,
    id: "honours-big-three-dragons-all-honours-capped",
    description:
      "大三元 plus a 東 pung by the dealer in the East round and a 南 pair — every tile an honour. 字一色 absorbs 對對糊; the raw sum is still 21 and the 13-faan limit 爆棚 is what pays.",
    concealed: [SOUTH],
    melds: [pung(1, RED), pung(2, GREEN), pung(3, WHITE), pung(2, EAST)],
    flowers: [],
    winningTile: SOUTH,
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: {
      faan: 13,
      awards: ["bigThreeDragons", "allHonours", "seatWind", "roundWind", "noFlowers"],
      legal: true,
    },
    contested:
      "Houses that pay 對對糊 alongside 字一色 reach 24 rather than 21, and 字一色 is a flat limit hand in four of the surveyed systems against the preset's 10. Both disputes are moot here — every reading is over the cap.",
  },

  /* ── 小四喜 / 大四喜 ────────────────────────────────────────────────────── */

  {
    ...base,
    id: "honours-small-four-winds-half-flush",
    description:
      "東南西 pungs with a 北 pair, held by the North seat: 小四喜. The seat's own wind is only the PAIR, which pays no 門風 anyway; the round's 東 pung is inside the pattern, which prices it.",
    concealed: [NORTH],
    melds: [pung(0, EAST), pung(1, SOUTH), pung(2, WEST), chow(3, m(1))],
    flowers: [],
    winningTile: NORTH,
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 10,
      awards: ["smallFourWinds", "halfFlush", "noFlowers"],
      legal: true,
    },
    contested:
      "Two splits. The preset prices 小四喜 at 6, but four of the six surveyed systems make it a flat limit hand — 13 here. And the preset has the pattern subsume 圈風; houses that pay the round wind on top score 11.",
  },
  {
    ...base,
    id: "honours-small-four-winds-all-honours",
    description:
      "東南西 pungs, a 中 pung and a 北 pair: 小四喜 and 字一色 together. 門風 西 and 圈風 南 are both on the table but both sit inside 小四喜, and 對對糊 sits inside 字一色. Raw sum 18, paid at the limit.",
    concealed: [NORTH],
    melds: [pung(0, EAST), pung(3, SOUTH), pung(1, WEST), pung(0, RED)],
    flowers: [],
    winningTile: NORTH,
    selfDraw: false,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    expected: {
      faan: 13,
      awards: ["smallFourWinds", "dragonPung", "allHonours", "noFlowers"],
      legal: true,
    },
    contested:
      "Same 小四喜 6-vs-limit split as honours-small-four-winds-half-flush, plus the 字一色/對對糊 overlap and the absorbed wind faan. Every reading still lands at or over 13 here.",
  },
  {
    ...base,
    id: "honours-big-four-winds-subsumes-small",
    description:
      "東南西北 all pungs with a 5萬 pair — 大四喜, which must NOT also award 小四喜. The suited pair keeps it short of 字一色 but 萬 is still the hand's only suit, so 混一色 stands. Raw sum 22, paid at the limit.",
    concealed: [m(5)],
    melds: [pung(0, EAST), pung(2, SOUTH), pung(3, WEST), pung(0, NORTH)],
    flowers: [],
    winningTile: m(5),
    selfDraw: false,
    seatWind: 1,
    roundWind: 2,
    isDealer: false,
    expected: {
      faan: 13,
      awards: ["bigFourWinds", "allPungs", "halfFlush", "noFlowers"],
      legal: true,
    },
    contested:
      "大四喜 is 10 in the preset's column, a flat limit hand in four surveyed systems and 6 in Dragon Society's — raw 17, 13 and 13. Every reading pays 13, which is exactly why the absorbed 門風/圈風 (a 大四喜 hand always holds both) cannot be settled by this case.",
  },

  /* ── 莊 the dealer ──────────────────────────────────────────────────────── */

  {
    ...base,
    id: "honours-dealer-scores-no-extra-faan",
    description:
      "Dealer wins a plain 白 pung hand holding 梅 and 春. 莊 doubles the PAYMENT, not the faan — no dealer award appears anywhere.",
    concealed: [t(5)],
    melds: [pung(1, WHITE), chow(0, m(1)), chow(0, s(4)), chow(0, t(7))],
    flowers: [PLUM, SPRING],
    winningTile: t(5),
    selfDraw: false,
    seatWind: 0,
    roundWind: 1,
    isDealer: true,
    expected: {
      faan: 3,
      awards: ["dragonPung", "ownFlower", "ownSeason"],
      legal: true,
    },
  },
  {
    ...base,
    id: "honours-dealer-self-draw-double-east",
    description:
      "Dealer 自摸 on a doubled 東 pung: 門風 1 + 圈風 1 + 自摸 1 + 無花 1. Still no faan for being 莊.",
    concealed: [t(8)],
    melds: [pung(2, EAST), chow(0, m(7)), chow(0, s(1)), chow(0, t(4))],
    flowers: [],
    winningTile: t(8),
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: {
      faan: 4,
      awards: ["seatWind", "roundWind", "selfDraw", "noFlowers"],
      legal: true,
    },
  },

  /* ── 花 bonus tiles ─────────────────────────────────────────────────────── */

  {
    ...base,
    id: "honours-others-flowers-score-nothing",
    description:
      "Dealer holds 蘭, 菊 and 竹 — all three belong to other seats, so they pay nothing AND deny 無花. 2 faan, refused: 莊 gets no dispensation from the floor.",
    concealed: [m(8)],
    melds: [pung(2, EAST), pung(1, RED), chow(0, s(1)), chow(0, t(4))],
    flowers: [ORCHID, CHRYSANTHEMUM, BAMBOO_FLOWER],
    winningTile: m(8),
    selfDraw: false,
    seatWind: 0,
    roundWind: 1,
    isDealer: true,
    expected: { faan: 2, awards: ["seatWind", "dragonPung"], legal: false },
  },
  {
    ...base,
    id: "honours-all-four-flowers",
    description:
      "East seat holding 梅蘭菊竹 — a complete 一台花 2 faan, with 梅 still paying its own 正花 1. The 北 pung and the three chows are worth nothing at all.",
    concealed: [t(3)],
    melds: [pung(3, NORTH), chow(0, m(1)), chow(0, s(4)), chow(0, t(7))],
    flowers: [PLUM, ORCHID, CHRYSANTHEMUM, BAMBOO_FLOWER],
    winningTile: t(3),
    selfDraw: false,
    seatWind: 0,
    roundWind: 1,
    isDealer: true,
    expected: { faan: 3, awards: ["ownFlower", "allFlowers"], legal: true },
    contested:
      "Two splits, both of which decide the win. Some houses score 一台花 as a flat 2 with no 正花 on top; others require the 3-faan minimum from the hand itself, and this hand has no faan at all outside its bonus tiles.",
  },
  {
    ...base,
    id: "honours-all-four-seasons-with-dragon-pung",
    description:
      "West seat holding 春夏秋冬 — 一台花 2 plus 秋 as its own 正花 1, on top of a 發 pung. Legal without leaning on the bonus tiles alone.",
    concealed: [m(5)],
    melds: [pung(1, GREEN), chow(2, m(1)), chow(2, s(7)), chow(2, t(1))],
    flowers: [SPRING, SUMMER, AUTUMN, WINTER],
    winningTile: m(5),
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 4, awards: ["dragonPung", "ownSeason", "allSeasons"], legal: true },
    contested:
      "3 rather than 4 at houses that score a complete set as a flat 2 with no 正花 on top. Legal under either reading.",
  },
  {
    ...base,
    id: "honours-all-eight-bonus-tiles",
    description:
      "All eight bonus tiles held by the North seat: 竹 and 冬 as 正花 1 each, plus 一台花 twice over.",
    concealed: [t(7)],
    melds: [pung(0, WHITE), chow(3, m(4)), chow(3, s(1)), chow(3, t(4))],
    flowers: [PLUM, ORCHID, CHRYSANTHEMUM, BAMBOO_FLOWER, SPRING, SUMMER, AUTUMN, WINTER],
    winningTile: t(7),
    selfDraw: false,
    seatWind: 3,
    roundWind: 1,
    isDealer: false,
    expected: {
      faan: 7,
      awards: ["dragonPung", "ownFlower", "ownSeason", "allFlowers", "allSeasons"],
      legal: true,
    },
    contested:
      "Many houses end the hand the moment the eighth bonus tile is revealed — 花糊, an instant limit win, no ordinary hand required. Encoded here as plain additive faan; if the state machine implements 花糊 this case becomes unreachable rather than wrong.",
  },
  {
    ...base,
    id: "honours-no-flowers-reaches-minimum",
    description:
      "南 pung by the South seat, a 中 pung, and not one bonus tile all hand: 門風 1 + 三元牌 1 + 無花 1 is exactly the floor.",
    concealed: [s(8)],
    melds: [pung(2, SOUTH), pung(3, RED), chow(1, m(1)), chow(1, t(4))],
    flowers: [],
    winningTile: s(8),
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 3,
      awards: ["seatWind", "dragonPung", "noFlowers"],
      legal: true,
    },
    contested:
      "Legality rests on 無花. All six compared systems score it 1, but tables that ignore bonus tiles entirely score this 2 and must refuse the win.",
  },

  /* ── LIU preset ─────────────────────────────────────────────────────────── */

  {
    id: "honours-liu-concealed-small-three-dragons",
    description:
      "LIU variant: the closed-hand preset allows no claims, so 小三元 can only ever be built concealed — and its LIU value is 4, one lower than the HK table many houses use.",
    ruleset: "liu",
    concealed: [m(4), m(5), m(6), s(7), s(8), RED, RED, RED, GREEN, GREEN, GREEN, WHITE, WHITE],
    melds: [],
    flowers: [],
    winningTile: s(9),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 7,
      awards: ["concealedHand", "noFlowers", "smallThreeDragons", "selfDraw"],
      legal: true,
    },
    provisional: true,
    source: SOURCE,
    contested:
      "Scored strictly against the shipped LIU table (rulesets/src/presets.ts): useFlowers is false and the variant has no 無花 and no 門前清 detector at all, so a hand that is concealed by construction earns nothing for being concealed. A LIU house that plays bonus tiles would read this 7.",
  },
];

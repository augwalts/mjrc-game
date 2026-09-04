/**
 * Golden hands — the flush family. DESIGN.md §4 (canonical HK Old Style, 3-faan
 * minimum, 13-faan limit 爆棚, rulesets-as-data) and §8 (this suite is the only
 * validation source for exposed melds, kongs, winds and dealer context).
 *
 * Covered: 混一色 half flush and 清一色 full flush in all three suits, concealed
 * and melded; the two suit-purity limit hands 字一色 All Honours and 清么九 All
 * Terminals; and the boundaries that decide between them —
 *   - one honour tile away from a full flush (a 3-faan swing on a single tile),
 *   - the same four melds where only the eyes decide half vs full flush,
 *   - a flush shape that is ALSO 混么九, so two patterns claim the same tiles,
 *   - a hand that looks like a flush but spans two suits and is refused,
 *   - a hand whose best decomposition is not its obvious one.
 *
 * ── conventions, inherited from basic.ts and kongs.ts ────────────────────────
 * Award ids are lowerCamelCase and stable. One id per pattern regardless of set
 * size: a kong of dragons scores as a pung of dragons does, so both emit
 * "dragonPung". Repeated awards repeat in the array (two dragon pungs → two
 * entries), matching how basic.ts lists two "ownFlower"s.
 *
 * `expected.faan` is the FINAL figure after the 13-faan limit, not the raw sum.
 * The four limit hands below sum well past 13 before the cap bites.
 *
 * The winner's SEAT INDEX equals their seatWind, so seat 0 東 is the dealer and
 * a chow's `from` is (seat + 3) % 4 — the upper house 上家 to your left, the
 * only seat a chow may be claimed from. A concealed kong's `from` is the winner.
 *
 * `flowers: []` is NOT neutral: 無花 noFlowers is 1 faan in all six compared
 * systems. Cases that are not about bonus tiles therefore hold one flower
 * belonging to ANOTHER seat, which scores nothing and keeps the faan arithmetic
 * about flushes.
 *
 * Assumed "hkos-standard" values (mjrc-admin/reference/hk-scoring-calculator.xlsx
 * via mjrc-app hk-scoring.ts):
 *   halfFlush 混一色 3 · fullFlush 清一色 6 · allPungs 對對糊 3 · allChows 平糊 1
 *   mixedTerminals 混么九 1 · dragonPung 1 · seatWind 1 · roundWind 1
 *   selfDraw 自摸 1 · concealedHand 門前清 1 · winOnLastTile 海底撈月 1
 *   robbingKong 搶槓 1 · allHonours 字一色 10 · allTerminals 清么九 7
 * The last two are taken from rulesets/src/presets.ts, which is the data the
 * scorer actually loads. Neither is a flat limit under hkos-standard — see
 * PURITY_SPLIT. That file also fixes the subsumption these cases obey:
 * allHonours subsumes allPungs, halfFlush and mixedTerminals; allTerminals
 * subsumes allPungs and mixedTerminals; fullFlush subsumes halfFlush. A
 * subsumed pattern is NOT listed in `awards`.
 * fullFlush at 6 follows basic.ts, which took the value four of the six systems
 * agree on; LIU and L2 read it as 7. That split is real and pervasive across
 * this family, so every 清一色 case carries it as `contested` rather than
 * pretending the number is settled.
 *
 * Terminology: ../../../TERMINOLOGY.md. HK only.
 */
import type { Meld, SeatIndex, TileId } from "../../src/types.js";
import type { GoldenCase } from "./case.js";

/* ── tile ids ───────────────────────────────────────────────────────────────
 * m = 萬 characters (0-8) · s = 索 bamboo (9-17) · t = 筒 circles (18-26).
 * Ranks are 1-9, so m(1) is 1萬 = id 0.                                       */
const m = (rank: number): TileId => rank - 1;
const s = (rank: number): TileId => 8 + rank;
const t = (rank: number): TileId => 17 + rank;

const EAST = 27, SOUTH = 28, WEST = 29;
const RED_DRAGON = 31, GREEN_DRAGON = 32, WHITE_DRAGON = 33;
const PLUM = 34, ORCHID = 35;

const SOURCE = "content-strategy/05 faan table (mjrc-admin/reference/hk-scoring-calculator.xlsx)";

/**
 * The 6-vs-7 split on 清一色. Attached to every full-flush case: the
 * disagreement is about the value, never about whether the pattern applies, so
 * it shifts each of these totals by exactly one faan and none of them across
 * the 3-faan floor.
 */
const FULL_FLUSH_SPLIT =
  "清一色 is 6 faan in MJ Time, MJB, Dragon Society and Wikipedia, and 7 in LIU and L2. " +
  "Every full-flush total in this family moves by 1 under the 7-faan reading; none of them changes legality.";

/**
 * 字一色 and 清么九 are the two cases in this family whose TOTAL actually moves
 * with the house, because hkos-standard does not price either as a flat limit.
 * Both sit below 13 and climb only through their additive components, so unlike
 * every other limit hand the cap does not hide the disagreement.
 */
const PURITY_SPLIT =
  "hkos-standard prices this from the Wikipedia column (字一色 10, 清么九 7), the only column " +
  "with a value for every classic pattern. Four of the six compared systems make both flat " +
  "limit hands instead, which scores this 13 — so the house choice is worth real chips here, " +
  "not just a different awards list.";

const chow = (seat: SeatIndex, low: TileId): Meld => ({
  kind: "chow",
  tiles: [low, low + 1, low + 2],
  from: ((seat + 3) % 4) as SeatIndex,
  concealed: false,
});

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

/** 暗槓 — declared from four in hand, so `from` is the owner and it stays concealed. */
const concealedKong = (seat: SeatIndex, tile: TileId): Meld => ({
  kind: "kong",
  tiles: [tile, tile, tile, tile],
  from: seat,
  concealed: true,
});

/** 加槓 — the fourth tile added to an already-exposed pung; `from` is that pung's discarder. */
const addedKong = (from: SeatIndex, tile: TileId): Meld => ({
  kind: "kong",
  tiles: [tile, tile, tile, tile],
  from,
  concealed: false,
  addedToPung: true,
});

/** Nothing in this family has been signed off yet (§8). */
const base = { ruleset: "hkos-standard", provisional: true, source: SOURCE } as const;

export const cases: GoldenCase[] = [
  /* ── 混一色 half flush, one suit plus honours, all three suits ───────────── */

  {
    ...base,
    id: "flush-half-chars-concealed",
    description:
      "萬 throughout with a 發 pung and 東 eyes, never melded: 混一色 3 + 三元牌 1 + 門前清 1.",
    concealed: [m(1), m(1), m(1), m(4), m(5), m(6), m(7), m(8), m(9),
                GREEN_DRAGON, GREEN_DRAGON, GREEN_DRAGON, EAST],
    melds: [],
    flowers: [PLUM],
    winningTile: EAST,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    // The 東 eyes sit in the round wind, and a PAIR of a scoring wind is worth
    // nothing in HK — only a pung or kong pays. That is the trap this case sets.
    expected: { faan: 5, awards: ["halfFlush", "dragonPung", "concealedHand"], legal: true },
  },
  {
    ...base,
    id: "flush-half-bamboo-melded",
    description:
      "索 plus a melded 白 pung, won on 8索 closing 6-7-8索: 混一色 survives exposure at 3 + 1.",
    concealed: [s(9), s(9), s(9), s(6), s(7), s(1), s(1)],
    melds: [chow(2, s(2)), pung(3, WHITE_DRAGON)],
    flowers: [PLUM],
    winningTile: s(8),
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 4, awards: ["halfFlush", "dragonPung"], legal: true },
  },
  {
    ...base,
    id: "flush-half-circles-self-draw-all-pungs",
    description:
      "筒 pungs behind a melded 南 pung, self-drawn in South seat: 混一色 3 + 對對糊 3 + 門風 1 + 自摸 1.",
    concealed: [t(2), t(2), t(2), t(5), t(5), t(5), t(8), t(8), t(8), t(1)],
    melds: [pung(0, SOUTH)],
    flowers: [PLUM],
    winningTile: t(1),
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    // The 南 pung is melded deliberately. Concealed it would give four concealed
    // pungs on a self-draw — 四暗刻, a limit hand — and swallow the whole case.
    expected: { faan: 8, awards: ["halfFlush", "allPungs", "seatWind", "selfDraw"], legal: true },
  },

  /* ── 清一色 full flush, all three suits ─────────────────────────────────── */

  {
    ...base,
    id: "flush-full-chars-concealed",
    description:
      "Pure 萬 concealed — 1萬 pung, three runs and 9萬 eyes: 清一色 6 + 門前清 1.",
    concealed: [m(1), m(1), m(1), m(2), m(3), m(4), m(5), m(6), m(7), m(7), m(8), m(9), m(9)],
    melds: [],
    flowers: [PLUM],
    winningTile: m(9),
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    // No 平糊 here: the 1萬 pung blocks it, and no rearrangement of these tiles
    // yields four runs, so the engine cannot buy the extra faan by re-parsing.
    // audit D1: 1112345677999萬 is 九蓮寶燈 Nine Gates — a limit hand, not a plain full flush
    expected: { faan: 13, awards: ["nineGates"], legal: true },
    contested: FULL_FLUSH_SPLIT,
  },
  {
    ...base,
    id: "flush-full-bamboo-melded-all-pungs",
    description:
      "Dealer's 索 pungs and an exposed 8索 kong with 9索 eyes: 清一色 6 + 對對糊 3, exposure costing nothing.",
    concealed: [s(1), s(1), s(1), s(9)],
    melds: [pung(1, s(2)), pung(2, s(5)), exposedKong(3, s(8))],
    flowers: [ORCHID],
    winningTile: s(9),
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    // A plain kong pays no faan of its own in HK — it is the fourth tile of a
    // pung, not a fifth pattern. 對對糊 counts it as one of the four sets.
    expected: { faan: 9, awards: ["fullFlush", "allPungs"], legal: true },
    contested: FULL_FLUSH_SPLIT,
  },
  {
    ...base,
    id: "flush-full-circles-concealed-kong",
    description:
      "Pure 筒 with a 暗槓 of 3筒, self-drawn: 清一色 6 + 自摸 1 + 門前清 1 — the concealed kong does not break 門前清.",
    concealed: [t(1), t(1), t(1), t(4), t(5), t(6), t(7), t(8), t(9), t(9)],
    melds: [concealedKong(2, t(3))],
    flowers: [PLUM],
    winningTile: t(9),
    selfDraw: true,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    // 暗槓 is declared from four tiles already in hand. Nothing was claimed from
    // a discard, so the hand is still 門前清. Compare flush-full-two-kong-forms.
    expected: { faan: 8, awards: ["fullFlush", "selfDraw", "concealedHand"], legal: true },
    contested: FULL_FLUSH_SPLIT,
  },

  /* ── the one-tile boundary between 混一色 and 清一色 ────────────────────── */

  {
    ...base,
    id: "flush-full-one-honour-short",
    description:
      "1筒 and 2筒 pungs, two 筒 runs, and 白 eyes — a single honour pair holds this to 混一色 3 + 門前清 1.",
    concealed: [t(1), t(1), t(1), t(2), t(2), t(2), t(4), t(5), t(6), t(7), t(8), t(9),
                WHITE_DRAGON],
    melds: [],
    flowers: [PLUM],
    winningTile: WHITE_DRAGON,
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    // Pair with flush-full-one-honour-discarded: identical shape, 筒 eyes
    // instead of 白, and the hand is worth three more faan.
    expected: { faan: 4, awards: ["halfFlush", "concealedHand"], legal: true },
  },
  {
    ...base,
    id: "flush-full-one-honour-discarded",
    description:
      "flush-full-one-honour-short after cutting 白 and pairing 3筒 instead: the same shape reaches 清一色 6 + 門前清 1.",
    concealed: [t(1), t(1), t(1), t(2), t(2), t(2), t(3), t(4), t(5), t(6), t(7), t(8), t(9)],
    melds: [],
    flowers: [PLUM],
    winningTile: t(3),
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 7, awards: ["fullFlush", "concealedHand"], legal: true },
    contested: FULL_FLUSH_SPLIT,
  },
  {
    ...base,
    id: "flush-pair-decides-half",
    description:
      "Four melded 筒 sets with 中 eyes: the eyes alone drop the hand to 混一色, landing exactly on the 3-faan floor.",
    concealed: [RED_DRAGON],
    melds: [pung(2, t(1)), pung(3, t(2)), chow(1, t(4)), chow(1, t(7))],
    flowers: [PLUM],
    winningTile: RED_DRAGON,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    // A single concealed tile means a lone-tile wait on the eyes, which is the
    // only place a hand this exposed can still choose its flush.
    expected: { faan: 3, awards: ["halfFlush"], legal: true },
  },
  {
    ...base,
    id: "flush-pair-decides-full",
    description:
      "The melds of flush-pair-decides-half with 3筒 eyes instead of 中: the same twelve melded tiles now score 清一色 6.",
    concealed: [t(3)],
    melds: [pung(2, t(1)), pung(3, t(2)), chow(1, t(4)), chow(1, t(7))],
    flowers: [PLUM],
    winningTile: t(3),
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 6, awards: ["fullFlush"], legal: true },
    contested: FULL_FLUSH_SPLIT,
  },
  {
    ...base,
    id: "flush-none-two-suits-below-minimum",
    description:
      "One run in each suit plus a 中 pung: three suits is no flush at all, so 2 faan and the win is refused.",
    concealed: [m(1), m(2), m(3), s(4), s(5), s(6), t(7), t(8), t(9),
                RED_DRAGON, RED_DRAGON, RED_DRAGON, EAST],
    melds: [],
    flowers: [PLUM],
    winningTile: EAST,
    selfDraw: false,
    seatWind: 1,
    roundWind: 2,
    isDealer: false,
    // The negative control for the family. Honours are free in 混一色; a second
    // SUIT is not, and one stray run is enough to cost 3 faan and the hand.
    expected: { faan: 2, awards: ["dragonPung", "concealedHand"], legal: false },
  },
  {
    ...base,
    id: "flush-half-honour-melds",
    description:
      "East dealer in East round: melded 東 and 南 pungs and a 中 kong over one 萬 run — 混一色 3 + 門風 1 + 圈風 1 + 三元牌 1.",
    concealed: [m(3), m(4), m(5), m(7)],
    melds: [pung(1, EAST), pung(2, SOUTH), exposedKong(3, RED_DRAGON)],
    flowers: [ORCHID],
    winningTile: m(7),
    selfDraw: false,
    seatWind: 0,
    roundWind: 1,
    isDealer: true,
    // Three of the four sets are honours, but one suited run keeps this 混一色
    // rather than 字一色. The boundary is a single group, not a tile count.
    expected: {
      faan: 6,
      awards: ["halfFlush", "seatWind", "roundWind", "dragonPung"],
      legal: true,
    },
  },

  /* ── 字一色 All Honours — the flush with no suit at all ─────────────────── */

  {
    ...base,
    id: "flush-all-honours-concealed",
    description:
      "東 南 西 and 中 pungs with 白 eyes, concealed, won on the 西 that completes a pung: 字一色 10 + 三元牌 1 + 門前清 1.",
    concealed: [EAST, EAST, EAST, SOUTH, SOUTH, SOUTH, WEST, WEST,
                RED_DRAGON, RED_DRAGON, RED_DRAGON, WHITE_DRAGON, WHITE_DRAGON],
    melds: [],
    flowers: [PLUM],
    winningTile: WEST,
    selfDraw: false,
    seatWind: 3,
    roundWind: 3,
    isDealer: false,
    // North seat in North round on purpose: 北 appears nowhere, so no wind faan
    // muddies 字一色's own value. The discard completes the 西 pung rather
    // than the eyes, which keeps this clear of 四暗刻 — only three pungs were
    // ever concealed. 白 eyes with a single dragon pung is likewise short of
    // 小三元, which needs two dragon pungs.
    // 對對糊 is real here — honours cannot run, so the hand is all pungs by
    // construction — but 字一色 subsumes it, and 混一色 with it. Only the dragon
    // pung and 門前清 stack.
    expected: {
      faan: 12,
      awards: ["allHonours", "dragonPung", "concealedHand"],
      legal: true,
    },
    contested:
      PURITY_SPLIT +
      " Under the flat-limit reading this scores 13 rather than 12.",
  },
  {
    ...base,
    id: "flush-all-honours-melded-reaches-limit",
    description:
      "字一色 melded by East dealer in South round: 10 + 三元牌 1 + 門風 1 + 圈風 1 lands exactly on the 13-faan limit without being cut.",
    concealed: [WEST, WEST, WEST, WHITE_DRAGON],
    melds: [pung(3, EAST), pung(1, SOUTH), exposedKong(2, RED_DRAGON)],
    flowers: [ORCHID],
    winningTile: WHITE_DRAGON,
    selfDraw: false,
    seatWind: 0,
    roundWind: 1,
    isDealer: true,
    // The positional faan are what carry this to the limit, which is the point:
    // 門風 and 圈風 are not subsumed by any hand pattern — they depend on who you
    // are and which round it is, not on the shape. Paired with
    // flush-all-honours-concealed, the two cases pin 字一色's value from below
    // and from exactly on the cap.
    expected: {
      faan: 13,
      awards: ["allHonours", "dragonPung", "seatWind", "roundWind"],
      legal: true,
    },
    contested: PURITY_SPLIT + " The flat-limit reading agrees at 13 here, by coincidence.",
  },

  /* ── 清么九 All Terminals ───────────────────────────────────────────────── */

  {
    ...base,
    id: "flush-all-terminals-concealed",
    description:
      "1萬 9萬 1索 and 9筒 pungs with 1筒 eyes, concealed, won on the 1索: 清么九 7 + 門前清 1.",
    concealed: [m(1), m(1), m(1), m(9), m(9), m(9), s(1), s(1),
                t(1), t(1), t(9), t(9), t(9)],
    melds: [],
    flowers: [PLUM],
    winningTile: s(1),
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    // Terminals only, no honours — that is what separates 清么九 from 混么九.
    // The discard completes a pung, not the eyes, so this is not 四暗刻 either.
    expected: {
      faan: 8,
      awards: ["allTerminals", "concealedHand"],
      legal: true,
    },
    contested:
      PURITY_SPLIT +
      " Under the flat-limit reading this scores 13 rather than 8 — the widest house-to-house " +
      "gap anywhere in this family.",
  },
  {
    ...base,
    id: "flush-all-terminals-melded-self-draw",
    description:
      "清么九 with two melded pungs and an exposed 1筒 kong, self-drawn on 9萬 eyes: 7 + 自摸 1.",
    concealed: [t(9), t(9), t(9), m(9)],
    melds: [pung(0, m(1)), pung(2, s(9)), exposedKong(3, t(1))],
    flowers: [PLUM],
    winningTile: m(9),
    selfDraw: true,
    seatWind: 1,
    roundWind: 1,
    isDealer: false,
    // 清么九 does not care about exposure, unlike 四暗刻. Three melds and the
    // hand is still the same limit hand.
    expected: {
      faan: 8,
      awards: ["allTerminals", "selfDraw"],
      legal: true,
    },
    contested: PURITY_SPLIT + " Under the flat-limit reading this scores 13 rather than 8.",
  },
  {
    ...base,
    id: "flush-half-mixed-terminals-overlap",
    description:
      "1筒 9筒 東 and 中 pungs with 白 eyes: one suit plus honours AND terminals-or-honours throughout, so 混一色 3 + 對對糊 3 + 混么九 1 + 三元牌 1 + 門前清 1.",
    concealed: [t(1), t(1), t(1), t(9), t(9), t(9), EAST, EAST,
                RED_DRAGON, RED_DRAGON, RED_DRAGON, WHITE_DRAGON, WHITE_DRAGON],
    melds: [],
    flowers: [PLUM],
    winningTile: EAST,
    selfDraw: false,
    seatWind: 2,
    roundWind: 3,
    isDealer: false,
    // The genuine overlap case: restrict a 混么九 hand to ONE suit and it is a
    // 混一色 as well. Adding a third suit's terminals would keep 混么九 and kill
    // the flush — see basic-mixed-terminals-all-pungs for that shape.
    expected: {
      faan: 9,
      awards: ["halfFlush", "allPungs", "mixedTerminals", "dragonPung", "concealedHand"],
      legal: true,
    },
    contested:
      "MJ Time and MJB do not list 混么九 at all and would score this 8. Houses that do list it " +
      "generally stack it with 混一色, but a minority treat the flush as already paying for the shape.",
  },

  /* ── decomposition, kongs, and situational faan over a flush ────────────── */

  {
    ...base,
    id: "flush-full-parse-maximisation",
    description:
      "Melded 1筒 pung over 2筒 3筒 4筒 pungs and 5筒 eyes — readable as three 234筒 runs, but only the all-pungs reading scores 清一色 6 + 對對糊 3.",
    concealed: [t(2), t(2), t(2), t(3), t(3), t(3), t(4), t(4), t(4), t(5)],
    melds: [pung(0, t(1))],
    flowers: [PLUM],
    winningTile: t(5),
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    // The rival decomposition — 234筒 three times, the melded pung, 5筒 eyes —
    // is a legal win worth only 6. A scorer that takes the first decomposition
    // it finds, rather than the best-scoring one, fails exactly here.
    expected: { faan: 9, awards: ["fullFlush", "allPungs"], legal: true },
    contested: FULL_FLUSH_SPLIT,
  },
  {
    ...base,
    id: "flush-full-all-chows-concealed",
    description:
      "Four overlapping 萬 runs with 5萬 eyes, concealed: 清一色 6 + 平糊 1 + 門前清 1.",
    concealed: [m(1), m(2), m(2), m(3), m(3), m(4), m(5), m(5), m(5), m(6), m(7), m(7), m(8)],
    melds: [],
    flowers: [PLUM],
    winningTile: m(9),
    selfDraw: false,
    seatWind: 1,
    roundWind: 2,
    isDealer: false,
    // Suited eyes, so the house rule that bars honour eyes from 平糊 cannot bite
    // here — unlike flush-half-all-chows-honour-eyes below.
    expected: { faan: 8, awards: ["fullFlush", "allChows", "concealedHand"], legal: true },
    contested: FULL_FLUSH_SPLIT,
  },
  {
    ...base,
    id: "flush-half-all-chows-honour-eyes",
    description:
      "Four concealed 索 runs with 中 eyes: 混一色 3 + 平糊 1 + 門前清 1, and the eyes are the contested part.",
    concealed: [s(1), s(2), s(2), s(3), s(3), s(4), s(5), s(6), s(7), s(7), s(8), s(9),
                RED_DRAGON],
    melds: [],
    flowers: [ORCHID],
    winningTile: RED_DRAGON,
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    // A half flush wants honours; 平糊 at some tables wants suited eyes. The two
    // patterns pull in opposite directions on the same pair, which is why the
    // concealed 索 version is worth having alongside basic.ts's melded 萬 one.
    expected: { faan: 5, awards: ["halfFlush", "allChows", "concealedHand"], legal: true },
    contested:
      "Tables that require suited eyes for 平糊 score this 4. 混一色 carries the hand either way, " +
      "so legality never turns on it — but the faan does, and dealer payment with it.",
  },
  {
    ...base,
    id: "flush-full-two-kong-forms",
    description:
      "清一色 in 筒 carrying a 暗槓 of 5筒 and a 加槓 of 9筒: 6 faan, and the added kong is why 門前清 does not apply.",
    concealed: [t(1), t(1), t(1), t(2), t(3), t(4), t(7)],
    melds: [concealedKong(2, t(5)), addedKong(1, t(9))],
    flowers: [PLUM],
    winningTile: t(7),
    selfDraw: false,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    // 加槓 upgrades a pung that was claimed from a discard, so the hand was
    // never concealed. Two kongs pay nothing extra on their own in HK — three
    // would start a different pattern, which is the kongs family's problem.
    expected: { faan: 6, awards: ["fullFlush"], legal: true },
    contested: FULL_FLUSH_SPLIT,
  },
  {
    ...base,
    id: "flush-half-robbing-kong",
    description:
      "混一色 in 萬 with a 發 pung and 7萬 eyes, won by robbing the 3萬 added to another seat's pung: 3 + 1 + 搶槓 1.",
    concealed: [m(1), m(2), m(7), m(7), GREEN_DRAGON, GREEN_DRAGON, GREEN_DRAGON],
    melds: [pung(1, m(9)), chow(3, m(4))],
    flowers: [PLUM],
    winningTile: m(3),
    selfDraw: false,
    robbedKong: true,
    seatWind: 3,
    roundWind: 2,
    isDealer: false,
    // The robbed tile must be one this hand holds NO copies of: the robbed seat
    // already owns three in the pung plus the fourth being added. That rules out
    // robbing into a pung or eyes here, so the 3萬 closes a run.
    expected: { faan: 5, awards: ["halfFlush", "dragonPung", "robbingKong"], legal: true },
  },
  {
    ...base,
    id: "flush-full-last-tile",
    description:
      "Pure 索 with a melded run and 6索 pung, self-drawn on the wall's final tile: 清一色 6 + 海底撈月 1 + 自摸 1.",
    concealed: [s(1), s(1), s(4), s(5), s(7), s(8), s(9)],
    melds: [chow(1, s(1)), pung(3, s(6))],
    flowers: [PLUM],
    winningTile: s(6),
    selfDraw: true,
    onLastTile: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    // The winning 6索 is the fourth copy: three sit in the melded pung. Legal,
    // and worth stating, because it is the kind of arithmetic a fixture gets
    // wrong silently.
    expected: { faan: 8, awards: ["fullFlush", "winOnLastTile", "selfDraw"], legal: true },
    contested: FULL_FLUSH_SPLIT,
  },
  {
    ...base,
    id: "flush-half-dealer-self-draw-all-pungs",
    description:
      "East dealer in East round, melded 東 pung over concealed 筒 and 中 pungs, self-drawn: 混一色 3 + 對對糊 3 + 門風 1 + 圈風 1 + 三元牌 1 + 自摸 1.",
    concealed: [t(3), t(3), t(3), t(6), t(6), t(6), t(9), t(9), RED_DRAGON, RED_DRAGON],
    melds: [pung(2, EAST)],
    flowers: [ORCHID],
    winningTile: RED_DRAGON,
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    // 東 pays twice for the dealer in the East round — 門風 and 圈風 are separate
    // faan, not one doubled. The melded 東 pung also keeps the concealed pung
    // count at three, clear of 四暗刻.
    expected: {
      faan: 10,
      awards: ["halfFlush", "allPungs", "seatWind", "roundWind", "dragonPung", "selfDraw"],
      legal: true,
    },
  },
  {
    ...base,
    id: "flush-full-melded-all-chows",
    description:
      "Two melded 筒 runs and two concealed ones with 5筒 eyes: 清一色 6 + 平糊 1, no 門前清.",
    concealed: [t(1), t(2), t(5), t(5), t(7), t(8), t(9)],
    melds: [chow(2, t(1)), chow(2, t(4))],
    flowers: [PLUM],
    winningTile: t(3),
    selfDraw: false,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    // 平糊 survives melding in HK — the pattern is four runs and a pair, not a
    // concealment condition. Only 門前清 is lost.
    expected: { faan: 7, awards: ["fullFlush", "allChows"], legal: true },
    contested: FULL_FLUSH_SPLIT,
  },
];

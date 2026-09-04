/**
 * Golden hands — kongs 槓 and replacement draws. DESIGN.md §4 (canonical HK Old
 * Style, all three kong forms) and §8 (this suite is the ONLY validation source
 * for everything the Python engine cannot generate — kongs are exactly that).
 *
 * Every case here is PROVISIONAL until a strong HK player signs it off (§8).
 *
 * ── conventions this file establishes ────────────────────────────────────────
 * Award ids are lowerCamelCase and stable. One id per pattern regardless of set
 * size: a kong of dragons scores identically to a pung of dragons in HK, so both
 * emit "dragonPung"; likewise "seatWind" / "roundWind" cover pung and kong.
 * Splitting them would double the id space for zero scoring difference.
 *
 * `expected.faan` is the FINAL figure after the 13-faan limit 爆棚, not the raw
 * sum — several limit hands below sum past 13 before the cap.
 *
 * Assumed "hkos-standard" values, taken from the house reference
 * (mjrc-admin/reference/hk-scoring-calculator.xlsx via mjrc-app hk-scoring.ts,
 * using the value all six compared systems agree on wherever they agree):
 *   seatWind 1 · roundWind 1 · dragonPung 1 · ownFlower 1 · noFlowers 1
 *   selfDraw 1 · concealedHand 門前清 1 · winOnLastTile 海底撈月 1
 *   robbingKong 搶槓 1 · winOnKongReplacement 槓上開花 1
 *   winByDoubleKong 槓上槓 8 (contested — see the case) · allPungs 3
 *   halfFlush 3 · allKongs limit 13 · fourConcealedPungs limit 13
 * Full flush is deliberately absent: the reference systems split 6 vs 7 and this
 * family does not need it. Half flush (unanimously 3) carries the flush case.
 *
 * 無花 noFlowers is awarded on EVERY hand whose `flowers` array is empty — all
 * six reference systems price it at 1, and `flowers: []` means no bonus tile was
 * drawn all hand. Cases that are not about flowers therefore carry one flower
 * belonging to ANOTHER seat: it pays nothing on its own and it keeps 無花 off
 * the sheet, so the total reflects the kong mechanics being tested. This
 * matches the convention in ./basic.ts.
 *
 * Seat index is assumed equal to wind index (seat 0 東 is the dealer), so a
 * concealed kong's `from` equals the winner's own seat and a chow's `from` is
 * (seat + 3) % 4 — the player to the left.
 *
 * Tile ids (../../src/types.ts): 0-8 萬 · 9-17 索 · 18-26 筒 ·
 * 27-30 東南西北 · 31-33 中發白 · 34-41 flowers.
 */
import type { GoldenCase } from "./case.js";

const SRC = "mjrc-admin/reference/hk-scoring-calculator.xlsx (FanSlang sheet)";

export const cases: GoldenCase[] = [
  /* ── 明槓 exposed kong ──────────────────────────────────────────────────── */
  {
    id: "kongs-exposed-kong-all-pungs-self-draw",
    description:
      "Exposed kong of 2筒 sits in an all-pungs hand; the kong counts as a pung for 對對糊.",
    ruleset: "hkos-standard",
    // 8索 pung + 中 pair concealed; the win completes the pair.
    concealed: [16, 16, 16, 31],
    melds: [
      { kind: "kong", tiles: [19, 19, 19, 19], from: 0, concealed: false },
      { kind: "pung", tiles: [4, 4, 4], from: 2, concealed: false },
      { kind: "pung", tiles: [28, 28, 28], from: 3, concealed: false },
    ],
    flowers: [],
    winningTile: 31,
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 6,
      awards: ["allPungs", "seatWind", "selfDraw", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-exposed-kong-below-minimum",
    description:
      "A kong is worth nothing on its own, and 梅 is not the 西 seat's flower — a 雞糊 at 0 faan that may not be taken.",
    ruleset: "hkos-standard",
    // Three chows, one kong, a 2萬 pair. Not 平糊, because a kong is not a chow.
    concealed: [1, 15, 16, 17],
    melds: [
      { kind: "kong", tiles: [11, 11, 11, 11], from: 1, concealed: false },
      { kind: "chow", tiles: [0, 1, 2], from: 1, concealed: false },
      { kind: "chow", tiles: [21, 22, 23], from: 1, concealed: false },
    ],
    // 梅 belongs to the 東 seat, so it pays nothing here — and it kills 無花.
    flowers: [34],
    winningTile: 1,
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 0, awards: [], legal: false },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-exposed-kong-of-round-wind",
    description:
      "Exposed kong of 南 in the 南 round scores the wind once — a kong pays the same as a pung.",
    ruleset: "hkos-standard",
    concealed: [5, 6, 7, 25],
    melds: [
      { kind: "kong", tiles: [28, 28, 28, 28], from: 0, concealed: false },
      { kind: "chow", tiles: [9, 10, 11], from: 2, concealed: false },
      { kind: "pung", tiles: [33, 33, 33], from: 1, concealed: false },
    ],
    flowers: [],
    winningTile: 25,
    selfDraw: true,
    seatWind: 3,
    roundWind: 1,
    isDealer: false,
    expected: {
      faan: 4,
      awards: ["roundWind", "dragonPung", "selfDraw", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-exposed-kong-double-wind-dealer",
    description:
      "Dealer's exposed kong of 東 in the 東 round scores seat and round wind — exactly the 3-faan floor.",
    ruleset: "hkos-standard",
    concealed: [3, 12, 13, 14],
    melds: [
      { kind: "kong", tiles: [27, 27, 27, 27], from: 2, concealed: false },
      { kind: "pung", tiles: [26, 26, 26], from: 1, concealed: false },
      { kind: "chow", tiles: [18, 19, 20], from: 3, concealed: false },
    ],
    flowers: [],
    winningTile: 3,
    selfDraw: false,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: {
      faan: 3,
      awards: ["seatWind", "roundWind", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },

  /* ── 暗槓 concealed kong ────────────────────────────────────────────────── */
  {
    id: "kongs-concealed-kong-keeps-hand-concealed",
    description:
      "A concealed kong does NOT break 門前清 — nothing was claimed from a discard, so the hand still scores it.",
    ruleset: "hkos-standard",
    concealed: [4, 9, 10, 11, 21, 22, 23, 28, 28, 28],
    melds: [{ kind: "kong", tiles: [6, 6, 6, 6], from: 1, concealed: true }],
    flowers: [],
    // Won from a discard: 門前清 asks about claimed melds, not about the last tile.
    winningTile: 4,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 3,
      awards: ["seatWind", "concealedHand", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-concealed-kong-dragon-self-draw",
    description:
      "Concealed kong of 發 pays the dragon faan; the 西 PAIR pays nothing even though it is the seat wind.",
    ruleset: "hkos-standard",
    concealed: [1, 2, 3, 17, 17, 17, 22, 23, 24, 29],
    melds: [{ kind: "kong", tiles: [32, 32, 32, 32], from: 2, concealed: true }],
    flowers: [34],
    winningTile: 29,
    selfDraw: true,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 3,
      awards: ["dragonPung", "concealedHand", "selfDraw"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-two-concealed-kongs-score-nothing-extra",
    description:
      "Two concealed kongs of plain tiles add zero faan — HKOS pays for what the tiles ARE, not for kong count.",
    ruleset: "hkos-standard",
    concealed: [5, 11, 12, 13, 31, 31, 31],
    melds: [
      { kind: "kong", tiles: [0, 0, 0, 0], from: 0, concealed: true },
      { kind: "kong", tiles: [26, 26, 26, 26], from: 0, concealed: true },
    ],
    flowers: [],
    winningTile: 5,
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: {
      faan: 4,
      awards: ["dragonPung", "concealedHand", "selfDraw", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
    contested:
      "The house reference table has no per-kong faan, so this scores 4. Some HK tables pay a flat bonus per kong (commonly 1 each, sometimes only for 暗槓), which would make this 6. Ruleset flag, not engine logic.",
  },

  /* ── 加槓 added kong ────────────────────────────────────────────────────── */
  {
    id: "kongs-added-kong-replacement-wins",
    description:
      "Added kong 加槓 onto an exposed pung of 5索; the replacement draw completes the 8筒 pair — 槓上開花.",
    ruleset: "hkos-standard",
    concealed: [25, 30, 30, 30],
    melds: [
      { kind: "kong", tiles: [13, 13, 13, 13], from: 2, concealed: false, addedToPung: true },
      { kind: "pung", tiles: [31, 31, 31], from: 0, concealed: false },
      { kind: "chow", tiles: [0, 1, 2], from: 2, concealed: false },
    ],
    flowers: [],
    winningTile: 25,
    // The replacement comes off the wall, so 自摸 is collected as well.
    selfDraw: true,
    onKongReplacement: true,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 5,
      awards: ["dragonPung", "seatWind", "winOnKongReplacement", "selfDraw", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-concealed-kong-replacement-wins",
    description:
      "Concealed kong of 南 by the 南 seat in the 南 round, and its replacement wins — double wind plus 門前清 plus 槓上開花.",
    ruleset: "hkos-standard",
    concealed: [6, 7, 8, 12, 12, 12, 18, 19, 20, 31],
    melds: [{ kind: "kong", tiles: [28, 28, 28, 28], from: 1, concealed: true }],
    flowers: [],
    winningTile: 31,
    selfDraw: true,
    onKongReplacement: true,
    seatWind: 1,
    roundWind: 1,
    isDealer: false,
    expected: {
      faan: 6,
      awards: [
        "seatWind",
        "roundWind",
        "concealedHand",
        "winOnKongReplacement",
        "selfDraw",
        "noFlowers",
      ],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-exposed-kong-replacement-completes-run",
    description:
      "Replacement after an exposed kong completes a run rather than a pair — 槓上開花 does not care what shape it finishes.",
    ruleset: "hkos-standard",
    concealed: [2, 3, 29, 29],
    melds: [
      { kind: "kong", tiles: [10, 10, 10, 10], from: 1, concealed: false },
      { kind: "pung", tiles: [33, 33, 33], from: 0, concealed: false },
      { kind: "pung", tiles: [23, 23, 23], from: 3, concealed: false },
    ],
    flowers: [35],
    winningTile: 4,
    selfDraw: true,
    onKongReplacement: true,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 3,
      awards: ["dragonPung", "winOnKongReplacement", "selfDraw"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },

  /* ── 搶槓 robbing a kong ────────────────────────────────────────────────── */
  {
    id: "kongs-robbing-added-kong-dealer",
    description:
      "Dealer robs the 4th 6索 as it is added to another seat's pung; the robbed tile finishes a run — it never can finish anything else.",
    ruleset: "hkos-standard",
    // Structural fact worth stating: the robbed tile is by definition the 4th
    // copy, so the winner holds none of it. A pair or pung wait would need a
    // 5th copy. 搶槓 in HKOS therefore ALWAYS completes a run.
    concealed: [12, 13, 26, 26, 26, 31, 31],
    melds: [
      { kind: "chow", tiles: [9, 10, 11], from: 3, concealed: false },
      { kind: "pung", tiles: [27, 27, 27], from: 1, concealed: false },
    ],
    flowers: [],
    winningTile: 14,
    selfDraw: false,
    robbedKong: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: {
      faan: 4,
      awards: ["seatWind", "roundWind", "robbingKong", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-robbing-kong-closed-wait",
    description:
      "Robbed 5筒 fills a closed wait 坎張 between 4筒 and 6筒, in a hand that already holds an exposed kong of its own.",
    ruleset: "hkos-standard",
    concealed: [21, 23, 29, 29],
    melds: [
      { kind: "pung", tiles: [33, 33, 33], from: 1, concealed: false },
      { kind: "chow", tiles: [0, 1, 2], from: 1, concealed: false },
      { kind: "kong", tiles: [16, 16, 16, 16], from: 3, concealed: false },
    ],
    flowers: [],
    winningTile: 22,
    selfDraw: false,
    robbedKong: true,
    seatWind: 2,
    roundWind: 1,
    isDealer: false,
    expected: {
      faan: 3,
      awards: ["dragonPung", "robbingKong", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-robbing-kong-below-minimum",
    description:
      "搶槓 alone does not clear the 3-faan floor — 1 faan, so the claim must be refused.",
    ruleset: "hkos-standard",
    // Deliberately not four chows: a 4筒 pung keeps 平糊 off the sheet, which
    // would otherwise have dragged this over the floor.
    concealed: [12, 13, 23, 23],
    melds: [
      { kind: "pung", tiles: [21, 21, 21], from: 1, concealed: false },
      { kind: "chow", tiles: [9, 10, 11], from: 2, concealed: false },
      { kind: "chow", tiles: [0, 1, 2], from: 2, concealed: false },
    ],
    flowers: [34],
    winningTile: 14,
    selfDraw: false,
    robbedKong: true,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    expected: { faan: 1, awards: ["robbingKong"], legal: false },
    provisional: true,
    source: SRC,
  },

  /* ── 槓上槓 kong on kong ────────────────────────────────────────────────── */
  {
    id: "kongs-double-kong-replacement",
    description:
      "Two kongs, the second replacement winning. WinContext cannot say WHICH replacement (槓上槓 kong-on-kong needs a count, not a boolean), so this case scores the expressible single 槓上開花 reading — the kong-on-kong premium is an open ruling in CONTESTED.md, revisit if the context ever grows a counter.",
    ruleset: "hkos-standard",
    concealed: [1, 2, 3, 8, 8, 13, 14],
    melds: [
      { kind: "kong", tiles: [9, 9, 9, 9], from: 0, concealed: true },
      { kind: "kong", tiles: [24, 24, 24, 24], from: 2, concealed: false, addedToPung: true },
    ],
    flowers: [],
    winningTile: 15,
    selfDraw: true,
    onKongReplacement: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: {
      // hkos-standard follows the majority of the six-system reference: 槓上槓
      // is not priced, so the hand is plain 槓上開花 (see contested note).
      faan: 3,
      awards: ["winOnKongReplacement", "selfDraw", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
    contested:
      "Only the Wikipedia table in the house reference prices 槓上槓, at 8 faan. MJ Time, MJB, Dragon Society, LIU and L2 do not list it at all — under those the hand is plain 槓上開花 and scores 3 (winOnKongReplacement + selfDraw + noFlowers). Pick per ruleset preset; do not hardcode.",
  },

  /* ── multiple kongs ────────────────────────────────────────────────────── */
  {
    id: "kongs-three-kongs-all-pungs",
    description:
      "All three kong forms in one hand — exposed 3筒, concealed 中, added 南 — plus a 9萬 pung, scored as 對對糊.",
    ruleset: "hkos-standard",
    concealed: [8, 8, 8, 10],
    melds: [
      { kind: "kong", tiles: [20, 20, 20, 20], from: 0, concealed: false },
      { kind: "kong", tiles: [31, 31, 31, 31], from: 1, concealed: true },
      { kind: "kong", tiles: [28, 28, 28, 28], from: 2, concealed: false, addedToPung: true },
    ],
    flowers: [36],
    winningTile: 10,
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    // Two kongs were claimed from discards, so 門前清 is gone.
    expected: {
      faan: 6,
      awards: ["allPungs", "dragonPung", "seatWind", "selfDraw"],
      legal: true,
    },
    provisional: true,
    source: SRC,
    contested:
      "The house reference has no 三槓子 row, so three kongs earn nothing beyond the tiles. Many HK tables do pay for three kongs (commonly a few faan, occasionally limit). Ruleset flag.",
  },
  {
    id: "kongs-four-kongs-limit",
    description:
      "十八羅漢 — four kongs and a pair, an 18-tile hand. Limit; the kong replacement that finished the 5筒 pair is swallowed by the cap.",
    ruleset: "hkos-standard",
    concealed: [22],
    melds: [
      { kind: "kong", tiles: [0, 0, 0, 0], from: 1, concealed: false },
      { kind: "kong", tiles: [27, 27, 27, 27], from: 2, concealed: true },
      { kind: "kong", tiles: [17, 17, 17, 17], from: 0, concealed: false, addedToPung: true },
      { kind: "kong", tiles: [33, 33, 33, 33], from: 3, concealed: false },
    ],
    flowers: [],
    winningTile: 22,
    selfDraw: true,
    onKongReplacement: true,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    // allKongs subsumes allPungs — the engine must not pay both.
    expected: {
      faan: 13,
      awards: [
        "allKongs",
        "dragonPung",
        "roundWind",
        "winOnKongReplacement",
        "selfDraw",
        "noFlowers",
      ],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-four-concealed-kongs",
    description:
      "Four CONCEALED kongs and a 中 pair — limit either way, but whether it also books 四暗刻 is a house question.",
    ruleset: "hkos-standard",
    concealed: [31],
    melds: [
      { kind: "kong", tiles: [1, 1, 1, 1], from: 0, concealed: true },
      { kind: "kong", tiles: [14, 14, 14, 14], from: 0, concealed: true },
      { kind: "kong", tiles: [21, 21, 21, 21], from: 0, concealed: true },
      { kind: "kong", tiles: [30, 30, 30, 30], from: 0, concealed: true },
    ],
    flowers: [],
    winningTile: 31,
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: {
      faan: 13,
      awards: ["allKongs", "fourConcealedPungs", "selfDraw", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
    contested:
      "Houses split on whether a concealed KONG counts toward 四暗刻 when all four sets are kongs — some award both patterns, some only 十八羅漢, some only 四暗刻. Every reading caps at 13 here, so the total is safe; the AWARD LIST is what differs, and replay/teaching surfaces show it.",
  },

  /* ── 四暗刻 four concealed pungs ────────────────────────────────────────── */
  {
    id: "kongs-four-concealed-pungs-self-draw",
    description:
      "四暗刻 in its uncontested form — four concealed pungs and a 中 pair, won by self-draw. Limit.",
    ruleset: "hkos-standard",
    concealed: [2, 2, 2, 10, 10, 10, 23, 23, 23, 29, 29, 29, 31],
    melds: [],
    flowers: [],
    winningTile: 31,
    selfDraw: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    // Concealed by definition, so no 門前清 on top. 四暗刻 subsumes 對對糊.
    expected: {
      faan: 13,
      awards: ["fourConcealedPungs", "selfDraw", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-four-concealed-pungs-discard-completes-pair",
    description:
      "四暗刻 won from a DISCARD where all four pungs were already complete and the discard only filled the pair.",
    ruleset: "hkos-standard",
    concealed: [2, 2, 2, 10, 10, 10, 23, 23, 23, 29, 29, 29, 31],
    melds: [],
    flowers: [],
    winningTile: 31,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 13,
      awards: ["fourConcealedPungs", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
    contested:
      "The strict form requires self-draw and pays nothing extra here; the common HK allowance is exactly this shape — four pungs already complete, discard fills the pair only. Under the strict reading the hand scores 5 (allPungs 3 + concealedHand 1 + noFlowers 1). This is THE contested case of the family.",
  },
  {
    id: "kongs-four-concealed-pungs-discard-completes-pung",
    description:
      "Same tiles, but the discard completes the FOURTH PUNG — that pung is no longer concealed, so no 四暗刻.",
    ruleset: "hkos-standard",
    concealed: [2, 2, 2, 10, 10, 10, 23, 23, 23, 29, 29, 31, 31],
    melds: [],
    flowers: [34],
    winningTile: 29,
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    // Nothing was claimed, so 門前清 still applies even though 四暗刻 does not.
    expected: {
      faan: 5,
      awards: ["allPungs", "seatWind", "concealedHand"],
      legal: true,
    },
    provisional: true,
    source: SRC,
    contested:
      "Majority ruling is the one encoded: a pung completed by someone else's discard is not concealed, so this is 對對糊, not 四暗刻. A minority of houses read 'concealed' as 'never melded' and would pay limit 13.",
  },
  {
    id: "kongs-four-concealed-pungs-with-concealed-kong",
    description:
      "四暗刻 where one of the four concealed sets is a concealed kong of 北 — a 暗槓 counts as a concealed pung.",
    ruleset: "hkos-standard",
    concealed: [4, 4, 4, 15, 15, 15, 18, 18, 18, 32],
    melds: [{ kind: "kong", tiles: [30, 30, 30, 30], from: 3, concealed: true }],
    flowers: [],
    winningTile: 32,
    selfDraw: true,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 13,
      awards: ["fourConcealedPungs", "seatWind", "selfDraw", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },

  /* ── combinations and edges ────────────────────────────────────────────── */
  {
    id: "kongs-added-kong-half-flush-replacement",
    description:
      "混一色 in 索 and honours, finished by the replacement after an added kong of 3索 — five separate awards stack.",
    ruleset: "hkos-standard",
    concealed: [13, 14, 15, 16, 33, 33, 33],
    melds: [
      { kind: "kong", tiles: [11, 11, 11, 11], from: 2, concealed: false, addedToPung: true },
      { kind: "pung", tiles: [27, 27, 27], from: 1, concealed: false },
    ],
    flowers: [],
    winningTile: 13,
    selfDraw: true,
    onKongReplacement: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: {
      faan: 9,
      awards: [
        "halfFlush",
        "seatWind",
        "roundWind",
        "dragonPung",
        "winOnKongReplacement",
        "selfDraw",
        "noFlowers",
      ],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-replacement-on-last-tile",
    description:
      "The kong's replacement draw is the last tile available — 槓上開花 and 海底撈月 claimed together.",
    ruleset: "hkos-standard",
    concealed: [12, 28, 28, 28],
    melds: [
      { kind: "kong", tiles: [24, 24, 24, 24], from: 0, concealed: false },
      { kind: "pung", tiles: [32, 32, 32], from: 3, concealed: false },
      { kind: "chow", tiles: [0, 1, 2], from: 0, concealed: false },
    ],
    flowers: [],
    winningTile: 12,
    selfDraw: true,
    onKongReplacement: true,
    onLastTile: true,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 6,
      awards: [
        "dragonPung",
        "seatWind",
        "winOnKongReplacement",
        "winOnLastTile",
        "selfDraw",
        "noFlowers",
      ],
      legal: true,
    },
    provisional: true,
    source: SRC,
    contested:
      "Two splits at once. (a) Many houses forbid declaring a kong once the live wall is down to the reserved replacement tiles, which makes this position unreachable. (b) Where the kong is allowed, houses differ on whether the replacement counts as 海底 — some pay both, some pay only 槓上開花 (5 faan). The state machine must settle (a) before scoring settles (b).",
  },
  {
    id: "kongs-exposed-kong-own-flower",
    description:
      "Kong hand with a bonus tile — 梅 is the 東 seat's own flower, so 正花 replaces 無花 rather than adding to it.",
    ruleset: "hkos-standard",
    concealed: [11, 27, 27, 27],
    melds: [
      { kind: "kong", tiles: [31, 31, 31, 31], from: 2, concealed: false },
      { kind: "pung", tiles: [22, 22, 22], from: 1, concealed: false },
      { kind: "chow", tiles: [6, 7, 8], from: 3, concealed: false },
    ],
    flowers: [34],
    winningTile: 11,
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    expected: {
      faan: 5,
      awards: ["dragonPung", "seatWind", "roundWind", "ownFlower", "selfDraw"],
      legal: true,
    },
    provisional: true,
    source: SRC,
  },
  {
    id: "kongs-liu-concealed-kong-only",
    description:
      "LIU preset: the closed-hand variant allows no claims from discards, so 暗槓 is the only kong form that can occur and 搶槓 can never happen.",
    ruleset: "liu",
    concealed: [12, 13, 14, 18, 19, 20, 29, 29, 29, 31],
    melds: [{ kind: "kong", tiles: [7, 7, 7, 7], from: 2, concealed: true }],
    flowers: [],
    winningTile: 31,
    selfDraw: true,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    expected: {
      faan: 4,
      awards: ["seatWind", "concealedHand", "selfDraw", "noFlowers"],
      legal: true,
    },
    provisional: true,
    source: SRC,
    contested:
      "Under LIU every hand is concealed by construction, so 門前清 is a constant +1 on every win. Either drop it from the LIU faan table and raise the minimum by one, or keep it and accept that it carries no information. Encoded here as awarded, matching the reference sheet's LIU column.",
  },
];

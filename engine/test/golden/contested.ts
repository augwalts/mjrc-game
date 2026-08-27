/**
 * Golden hands — the CONTESTED rulings. DESIGN.md §4 ("rulesets are data, not
 * code: house-rule presets, not a fork") and §8 (the golden suite is the only
 * validation source for the canonical extensions).
 *
 * §4's promise only holds if we know where the variation actually is. This
 * family is that map, in fixture form: for every ruling where Hong Kong houses
 * genuinely disagree, BOTH readings are written down as a scored hand, so
 * neither one silently becomes "the rule" by being the only one anybody typed.
 * The prose version — question, options, who says what, recommendation — is
 * ./CONTESTED.md, and RULINGS below is its machine-readable half.
 *
 * ── READ THIS BEFORE WIRING THIS FAMILY INTO A SCORING TEST ────────────────
 *
 * Half of these cases are DELIBERATELY WRONG for the shipped presets. A case
 * tagged `side: "variant"` encodes what a DIFFERENT house pays; feeding it to
 * score() under hkos-standard fails by design. Only `SHIPPED_CASES` is safe to
 * score against the presets as they stand today — engine/test/scoring.test.ts
 * loads five families and must keep loading five.
 *
 * Each variant carries `values` — what that house pays — and `configurable`:
 * true when applying `values` to the preset's faanTable IS the whole change.
 * The falses are the finding. Eight of the fourteen rulings here cannot be
 * configured at all today: they need a new Ruleset field, a new pattern id, or
 * a branch in the engine, so for those eight §4's "presets, not forks" is
 * currently false. `Ruling.expressible` says which kind of gap each one is and
 * `ContestedCase.gap` names the file that would have to change.
 *
 * ── conventions inherited from the sibling families ────────────────────────
 * Award ids are stable lowerCamelCase from rulesets/src/patterns.ts. Seat index
 * equals wind index, so seat 0 東 is the dealer and a chow's `from` is
 * (seat + 3) % 4 — the upper house 上家. A concealed kong's `from` is the owner's
 * own seat (types.ts). A hand with no bonus tile scores 無花, so `flowers: []`
 * is never neutral: cases not about bonus tiles hold one flower belonging to
 * ANOTHER seat, which pays nothing.
 *
 * Faan values are imported from ./limit.js rather than copied a third time;
 * that file mirrors rulesets/src/presets.ts and says so. Only ids limit.ts does
 * not price are added here, in EXTRA / EXTRA_LIU.
 *
 * Tile ids (../../src/types.ts): 0-8 萬 · 9-17 索 · 18-26 筒 ·
 * 27-30 東南西北 · 31-33 中發白 · 34-41 花 (梅蘭菊竹春夏秋冬).
 *
 * Terminology: ../../../TERMINOLOGY.md. HK Old Style only.
 */
import type { Meld, SeatIndex, TileId } from "../../src/types.js";
import type { GoldenCase } from "./case.js";
import { FAAN, FAAN_LIU, LIMIT_FAAN } from "./limit.js";

/* ── what a contested case has to say that GoldenCase cannot ─────────────── */

/** Which reading of a split a fixture encodes. */
export type Side = "shipped" | "variant";

/**
 * How far down the stack a house's disagreement reaches. The first two are
 * config; the last four are not, and each names the file that would have to
 * change. DESIGN.md §4 assumes every row is one of the first two.
 */
export type Expressible =
  /** A value or an entry in Ruleset.faanTable. Pure config. */
  | "faanTable"
  /** A different PaymentTable. Pure config. */
  | "paymentTable"
  /** Needs a NEW field on Ruleset — the config schema cannot say it. */
  | "rulesetFlag"
  /** Needs a NEW id in rulesets/src/patterns.ts — the catalogue has no name for it. */
  | "patternId"
  /** Needs engine/src/scoring.ts to branch on the reading. */
  | "detector"
  /** Needs engine/src/reducer.ts to branch — the hand ends differently. */
  | "stateMachine";

/**
 * Whether anyone has actually DECIDED this, as opposed to it falling out of
 * something else. The distinction is the point of the document: an accident
 * that survives review becomes a decision, but it has to be looked at first.
 */
export type Status =
  /** Chosen on stated grounds, and the grounds are written down. */
  | "decided"
  /** The shipped answer is a side effect of a column choice or a fixture. */
  | "accident"
  /** Nobody has picked; the code currently guesses. */
  | "open";

export interface ContestedCase extends GoldenCase {
  /** Ruling.id this case argues one side of. */
  ruling: string;
  side: Side;
  /** The reading in one line, from the point of view of the house that plays it. */
  reading: string;
  /** Uncapped sum of `expected.awards` under this reading's values. */
  rawFaan: number;
  /** True when 爆棚 actually bit — rawFaan above the preset's limit. */
  capped: boolean;
  /**
   * What this reading pays for award ids the named preset prices differently or
   * does not price at all. `{}` on the shipped side. A 0 means the house does
   * not play the pattern — in faanTable terms, deletes the row.
   */
  values: Readonly<Record<string, number>>;
  /**
   * True when `values` IS the whole difference, i.e. applying it to the preset's
   * faanTable reaches this reading. False when the disagreement lives somewhere
   * config cannot reach — those are the gaps in DESIGN.md §4's promise.
   */
  configurable: boolean;
  /** Required when `configurable` is false: what would have to change, and where. */
  gap?: string;
  /** The position cannot legally arise under this reading; the fixture records the ruling, not a payout. */
  unreachable?: boolean;
  /** Winning shapes that are not four sets and a pair. Absent means the ordinary shape. */
  shape?: "sevenPairs" | "thirteenOrphans";
}

export interface Ruling {
  /** Stable, kebab-case. Matches the section anchor in ./CONTESTED.md. */
  id: string;
  characters: string;
  jyutping: string;
  /** The decision, stated as a question a table can answer yes or no to. */
  question: string;
  /** Every reading in circulation, most common first. */
  options: readonly string[];
  /** Who says what, with the values from mjrc-app/web/src/data/hk-scoring.ts. */
  systems: string;
  /** What hkos-standard does today, and where that came from. */
  shipped: string;
  status: Status;
  expressible: Expressible;
  /** Frequency × swing. Frequencies are REASONED ESTIMATES — see CONTESTED.md §0. */
  impact: string;
  /** One reading, recommended, with the reason. */
  recommendation: string;
  /** Fixtures covering each side. Ids may point into a sibling golden family. */
  covers: { shipped: readonly string[]; variant: readonly string[] };
  /** Required when either side of `covers` is empty: why no fixture can exist. */
  whyNoFixture?: string;
}

/* ── tile ids, written the way the MJRC scoring pages write them ──────────── */
const m = (rank: number): TileId => rank - 1;
const s = (rank: number): TileId => 8 + rank;
const t = (rank: number): TileId => 17 + rank;

const EAST = 27, SOUTH = 28, WEST = 29, NORTH = 30;
const RED_DRAGON = 31, GREEN_DRAGON = 32, WHITE_DRAGON = 33;
const PLUM = 34, ORCHID = 35, CHRYSANTHEMUM = 36, BAMBOO_FLOWER = 37;
const SPRING = 38, SUMMER = 39, AUTUMN = 40, WINTER = 41;

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

/** 暗槓 — drawn complete, so the source seat is the owner's own (types.ts). */
const concealedKong = (seat: SeatIndex, tile: TileId): Meld => ({
  kind: "kong",
  tiles: [tile, tile, tile, tile],
  from: seat,
  concealed: true,
});

const SOURCE =
  "mjrc-app/web/src/data/hk-scoring.ts (six systems) · mjrc-admin/docs/house-rules-and-metas.md · rulesets/src/presets.ts";

/* ── faan values ──────────────────────────────────────────────────────────
 * FAAN / FAAN_LIU come from ./limit.js, which mirrors rulesets/src/presets.ts.
 * These are the ids this family needs and that file does not price. */

/** hkos-standard values missing from limit.ts's mirror. */
export const EXTRA: Readonly<Record<string, number>> = {
  robbingKong: 1,
  allFlowers: 2,
  allSeasons: 2,
  ownSeason: 1,
};

/** LIU values missing from limit.ts's mirror. 七對子 is the whole reason LIU has a column. */
export const EXTRA_LIU: Readonly<Record<string, number>> = {
  ...EXTRA,
  sevenPairs: 4,
};

export const HKOS: Readonly<Record<string, number>> = { ...FAAN, ...EXTRA };
export const LIU: Readonly<Record<string, number>> = { ...FAAN_LIU, ...EXTRA_LIU };

/**
 * Award ids used by a variant case that rulesets/src/patterns.ts DOES NOT
 * DEFINE. Each one is a house rule the pattern catalogue has no name for, so
 * no faanTable can price it — this is the `expressible: "patternId"` list, and
 * it is checked against the catalogue by the sibling test.
 */
export const UNCATALOGUED: Readonly<Record<string, string>> = {
  kongBonus:
    "A flat faan per 槓, paid by many HK tables (commonly 1 each, sometimes only for 暗槓). " +
    "patterns.ts deliberately gives kongs no id of their own — 'the kong shape earns a " +
    "replacement draw, not extra faan' — so a house that pays for kongs cannot be a preset.",
  allEightBonusTiles:
    "花糊 — the hand ends the moment the eighth bonus tile is revealed, at the limit, with no " +
    "ordinary winning shape required. Neither the catalogue nor GoldenCase can express a win " +
    "with no hand behind it.",
};

const base = { provisional: true, source: SOURCE } as const;
const hkos = { ...base, ruleset: "hkos-standard" } as const;

/* ══ the fixtures ═════════════════════════════════════════════════════════ */

export const cases: ContestedCase[] = [
  /* ── R02 門前清 — does the house pay for a concealed hand at all? ─────────
     Same fourteen tiles, one faan apart. Chosen so BOTH readings stay legal:
     the legality flip this rule also causes is already covered by
     basic-all-chows-concealed-discard-short and its neighbours. */
  {
    ...hkos,
    id: "contested-concealed-hand-paid",
    ruling: "concealed-hand-faan",
    side: "shipped",
    reading: "門前清 is worth 1 faan whenever no meld was claimed, however the last tile arrived.",
    description:
      "Concealed 混一色 of 萬 with a 南 pung, won on a discard by the South seat — 混一色 3 + 門風 1 + 門前清 1 + 無花 1.",
    concealed: [m(1), m(1), m(1), m(4), m(5), m(6), m(7), m(8), m(9), SOUTH, SOUTH, SOUTH, RED_DRAGON],
    melds: [],
    flowers: [],
    winningTile: RED_DRAGON,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 6,
    capped: false,
    values: {},
    configurable: true,
    expected: {
      faan: 6,
      awards: ["halfFlush", "seatWind", "concealedHand", "noFlowers"],
      legal: true,
    },
    contested:
      "MJ Time's column has no 門前清 row at all, and the TVB championship list does not award it either. Two of the eight references surveyed do not pay for concealment.",
  },
  {
    ...hkos,
    id: "contested-concealed-hand-unpaid",
    ruling: "concealed-hand-faan",
    side: "variant",
    reading: "Concealment pays nothing on its own; 自摸 is the only reward for closing a hand.",
    description:
      "The same fourteen tiles at a house that does not play 門前清 — 5 faan, not 6. Still legal; the swing is one doubling step.",
    concealed: [m(1), m(1), m(1), m(4), m(5), m(6), m(7), m(8), m(9), SOUTH, SOUTH, SOUTH, RED_DRAGON],
    melds: [],
    flowers: [],
    winningTile: RED_DRAGON,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 5,
    capped: false,
    // faanTable is both price list and enable list (presets.ts), so dropping the
    // key IS the config change; 0 is how this file writes "delete the row".
    values: { concealedHand: 0 },
    configurable: true,
    expected: { faan: 5, awards: ["halfFlush", "seatWind", "noFlowers"], legal: true },
    contested:
      "The same split, from the other side. At the 3-faan floor this decides whether cheap concealed hands may be taken at all.",
  },

  /* ── R03 花唔計番 — do bonus-tile faan count toward the 3-faan minimum? ─── */
  {
    ...hkos,
    id: "contested-flowers-lift-to-minimum",
    ruling: "flowers-toward-minimum",
    side: "shipped",
    reading: "Bonus faan are faan. 中 pung 1 + 正花 1 + 正花(季) 1 reaches the floor and the win stands.",
    description:
      "A melded hand worth 1 faan from its tiles, lifted to exactly 3 by the West seat's own flower and own season.",
    concealed: [t(5), t(6), t(7), t(8)],
    melds: [pung(1, RED_DRAGON), chow(2, m(1)), chow(2, s(4))],
    flowers: [CHRYSANTHEMUM, AUTUMN],
    winningTile: t(5),
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    rawFaan: 3,
    capped: false,
    values: {},
    configurable: true,
    expected: { faan: 3, awards: ["dragonPung", "ownFlower", "ownSeason"], legal: true },
    contested:
      "Houses that play 花唔計番 require the minimum from the HAND and score this 1 — the win is refused and the flowers pay nothing. honours-dealer-scores-no-extra-faan carries the same split.",
  },
  {
    ...hkos,
    id: "contested-flowers-excluded-from-minimum",
    ruling: "flowers-toward-minimum",
    side: "variant",
    reading: "花唔計番 — bonus tiles pay only once the hand has cleared the floor on its own.",
    description:
      "The same fourteen tiles and the same two bonus tiles at a 花唔計番 house: the hand is worth 1, so the win may not be taken and nothing is paid.",
    concealed: [t(5), t(6), t(7), t(8)],
    melds: [pung(1, RED_DRAGON), chow(2, m(1)), chow(2, s(4))],
    flowers: [CHRYSANTHEMUM, AUTUMN],
    winningTile: t(5),
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    rawFaan: 1,
    capped: false,
    values: {},
    configurable: false,
    gap:
      "Ruleset carries minimumFaan but no way to say WHICH awards may reach it. " +
      "Needs a new field — the bonus-tile family excluded from the floor test.",
    expected: { faan: 1, awards: ["dragonPung"], legal: false },
    contested:
      "The awards list is the hand's own faan only. Whether the flowers would still pay on a hand that DID clear the floor is a separate question every 花唔計番 table answers yes to.",
  },

  /* ── R05 平糊 — may the eyes be an honour pair? ──────────────────────────── */
  {
    ...hkos,
    id: "contested-all-chows-honour-eyes-paid",
    ruling: "all-chows-honour-eyes",
    side: "shipped",
    reading: "平糊 asks only that the four SETS are chows. The eyes may be anything.",
    description:
      "Four chows with a 白 pair, concealed, won on a discard by the North seat holding 竹 — exactly 3 faan.",
    concealed: [m(1), m(2), m(3), s(4), s(5), s(6), s(7), s(8), s(9), t(2), t(3), t(4), WHITE_DRAGON],
    melds: [],
    flowers: [BAMBOO_FLOWER],
    winningTile: WHITE_DRAGON,
    selfDraw: false,
    seatWind: 3,
    roundWind: 1,
    isDealer: false,
    rawFaan: 3,
    capped: false,
    values: {},
    configurable: true,
    expected: { faan: 3, awards: ["allChows", "concealedHand", "ownFlower"], legal: true },
    contested:
      "A minority of tables require suited eyes for 平糊. hk-scoring.ts records the rule as real but rare; patterns.ts declines to model it.",
  },
  {
    ...hkos,
    id: "contested-all-chows-honour-eyes-refused",
    ruling: "all-chows-honour-eyes",
    side: "variant",
    reading: "An honour pair disqualifies 平糊 — the hand is four chows and two loose honours.",
    description:
      "The same fourteen tiles at a suited-eyes house: 2 faan, one short of the floor, and the win may not be taken.",
    concealed: [m(1), m(2), m(3), s(4), s(5), s(6), s(7), s(8), s(9), t(2), t(3), t(4), WHITE_DRAGON],
    melds: [],
    flowers: [BAMBOO_FLOWER],
    winningTile: WHITE_DRAGON,
    selfDraw: false,
    seatWind: 3,
    roundWind: 1,
    isDealer: false,
    rawFaan: 2,
    capped: false,
    values: {},
    configurable: false,
    gap:
      "Not a value but a condition on the 平糊 detector. Needs a Ruleset flag, " +
      "e.g. suitedEyesRequired, that scoring.ts reads before awarding allChows.",
    expected: { faan: 2, awards: ["concealedHand", "ownFlower"], legal: false },
    contested:
      "The commonest hand shape in the game meeting the lowest scoring floor: this is the rule that turns into an argument most often, and it decides the win outright rather than moving it a faan.",
  },

  /* ── R06 小三元 — 5 or 4? (shipped side: honours-small-three-dragons) ────── */
  {
    ...hkos,
    id: "contested-small-three-dragons-four",
    ruling: "small-three-dragons-value",
    side: "variant",
    reading: "小三元 is 4 faan, still swallowing the two dragon pungs it names.",
    description:
      "honours-small-three-dragons's fourteen tiles priced at 4 rather than 5 — the value three of the four systems that list the hand actually print.",
    concealed: [WHITE_DRAGON],
    melds: [pung(0, RED_DRAGON), pung(2, GREEN_DRAGON), chow(1, m(4)), chow(1, s(7))],
    flowers: [],
    winningTile: WHITE_DRAGON,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 5,
    capped: false,
    values: { smallThreeDragons: 4 },
    configurable: true,
    expected: { faan: 5, awards: ["smallThreeDragons", "noFlowers"], legal: true },
    contested:
      "Dragon Society, LIU and L2 all print 4; only the Wikipedia column — the one hkos-standard takes whole — prints 5. A third reading adds the two dragon pungs on top instead of treating them as included, reaching 6 or 7.",
  },

  /* ── R07 per-kong faan (shipped side: kongs-two-concealed-kongs-score-nothing-extra) ── */
  {
    ...hkos,
    id: "contested-per-kong-faan-paid",
    ruling: "per-kong-faan",
    side: "variant",
    reading: "Every 槓 is worth a flat faan of its own, on top of whatever the tiles score.",
    description:
      "kongs-two-concealed-kongs-score-nothing-extra's tiles at a house that pays 1 per kong: 4 becomes 6, and the award id it needs does not exist.",
    concealed: [m(6), s(3), s(4), s(5), RED_DRAGON, RED_DRAGON, RED_DRAGON],
    melds: [concealedKong(0, m(1)), concealedKong(0, t(9))],
    flowers: [],
    winningTile: m(6),
    selfDraw: true,
    seatWind: 0,
    roundWind: 0,
    isDealer: true,
    rawFaan: 6,
    capped: false,
    values: { kongBonus: 1 },
    configurable: false,
    gap:
      "patterns.ts gives kongs no id at all, by an explicit decision, so there is " +
      "no faanTable key to price. Needs a new catalogue entry — see UNCATALOGUED.",
    expected: {
      faan: 6,
      awards: ["dragonPung", "concealedHand", "selfDraw", "noFlowers", "kongBonus", "kongBonus"],
      legal: true,
    },
    contested:
      "Some of these houses pay only for 暗槓, which would make this hand 6 as well but a hand with two 明槓 only 4. The catalogue cannot express either.",
  },

  /* ── R08 暗槓 and 門前清 (shipped side: kongs-concealed-kong-keeps-hand-concealed) ── */
  {
    ...hkos,
    id: "contested-concealed-kong-breaks-concealment",
    ruling: "concealed-kong-concealment",
    side: "variant",
    reading: "Any declared kong is face-up on the table, so the hand is no longer 門前清.",
    description:
      "kongs-concealed-kong-keeps-hand-concealed's tiles read the other way: 2 faan, below the floor, and the win is refused.",
    concealed: [m(5), s(1), s(2), s(3), t(4), t(5), t(6), SOUTH, SOUTH, SOUTH],
    melds: [concealedKong(1, m(7))],
    flowers: [],
    winningTile: m(5),
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 2,
    capped: false,
    values: {},
    configurable: false,
    gap:
      "Concealment is computed from the meld list inside scoring.ts, not read from " +
      "config. Needs a Ruleset flag, e.g. concealedKongBreaksConcealment.",
    expected: { faan: 2, awards: ["seatWind", "noFlowers"], legal: false },
    contested:
      "The majority HK reading is the shipped one — nothing was claimed from a discard, so the hand stays concealed. The minority reading costs the win outright here, which is why it is worth settling in writing rather than at the table.",
  },

  /* ── R09 清么九 — 7 additive, or a flat limit? ───────────────────────────── */
  {
    ...hkos,
    id: "contested-all-terminals-additive",
    ruling: "all-terminals-value",
    side: "shipped",
    reading: "清么九 is 7 faan and stacks with 對對糊 like any other pattern.",
    description:
      "Melded 清么九 — 1萬 and 9萬 pungs claimed, 9索 and 1筒 pungs in hand, 9筒 eyes. 7 + 3 + 1 = 11, well under the cap.",
    concealed: [s(9), s(9), s(9), t(1), t(1), t(1), t(9)],
    melds: [pung(1, m(1)), pung(3, m(9))],
    flowers: [],
    winningTile: t(9),
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    rawFaan: 11,
    capped: false,
    values: {},
    configurable: true,
    expected: { faan: 11, awards: ["allTerminals", "allPungs", "noFlowers"], legal: true },
    contested:
      "Two axes at once. (a) 7 is the Wikipedia column's value and an outlier — four of the six systems star 清么九 as a limit hand. (b) whether 對對糊 stacks: limit.ts pays it, flush.ts does not, and scoring.test.ts carries the conflict.",
  },
  {
    ...hkos,
    id: "contested-all-terminals-flat-limit",
    ruling: "all-terminals-value",
    side: "variant",
    reading: "清么九 is a limit hand. Name it and it pays 13, whatever else is in the hand.",
    description:
      "The same melded 清么九 at a flat-limit house: raw 17, paid 13, and the cap actually bites — the `capped` flag differs even where the payout would not.",
    concealed: [s(9), s(9), s(9), t(1), t(1), t(1), t(9)],
    melds: [pung(1, m(1)), pung(3, m(9))],
    flowers: [],
    winningTile: t(9),
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    rawFaan: 17,
    capped: true,
    values: { allTerminals: LIMIT_FAAN },
    configurable: true,
    expected: { faan: 13, awards: ["allTerminals", "allPungs", "noFlowers"], legal: true },
    contested:
      "LIU and L2 both price it 13; MJ Time and MJB star it as a limit hand. The melded form is chosen deliberately — a concealed 清么九 reaches 13 under both readings and hides the disagreement.",
  },

  /* ── R10 小四喜 (shipped side: honours-small-four-winds-half-flush) ─────── */
  {
    ...hkos,
    id: "contested-small-four-winds-limit",
    ruling: "small-four-winds-value",
    side: "variant",
    reading: "小四喜 is a limit hand — three wind pungs and the fourth wind paired is worth the cap.",
    description:
      "honours-small-four-winds-half-flush's tiles at a limit house: raw 18 against the preset's 11, both capped to 13 — the value gap is 7 faan and only the cap hides it.",
    concealed: [NORTH],
    melds: [pung(0, EAST), pung(1, SOUTH), pung(2, WEST), chow(3, m(1))],
    flowers: [],
    winningTile: NORTH,
    selfDraw: false,
    seatWind: 3,
    roundWind: 0,
    isDealer: false,
    rawFaan: 18,
    capped: true,
    values: { smallFourWinds: LIMIT_FAAN },
    configurable: true,
    // 圈風 is awarded because patterns.ts gives smallFourWinds an empty subsumes
    // list. AUDIT.md D3 rules the catalogue authoritative and records the paired
    // fixture as owing the same correction (10 -> 11); this case is written on
    // the corrected side rather than bug-compatible with its pair.
    expected: {
      faan: 13,
      awards: ["smallFourWinds", "roundWind", "halfFlush", "noFlowers"],
      legal: true,
    },
    contested:
      "Four of the six systems star it as a limit hand and LIU prices it 10; only the Wikipedia column says 6. The TVB tournament list goes the other way entirely and pays 5. The 門風/圈風 subsumption is a second, independent axis — see AUDIT.md D3.",
  },

  /* ── R11 四暗刻 won on a discard (shipped side: kongs-four-concealed-pungs-discard-completes-pair) ── */
  {
    ...hkos,
    id: "contested-four-concealed-pungs-strict-discard",
    ruling: "four-concealed-pungs-on-discard",
    side: "variant",
    reading: "四暗刻 is a self-draw hand. Won on a discard it is 對對糊 and nothing more.",
    description:
      "kongs-four-concealed-pungs-discard-completes-pair's tiles under the strict reading: 5 faan instead of 13, on a hand nobody at the table disputes the shape of.",
    concealed: [m(3), m(3), m(3), s(2), s(2), s(2), t(6), t(6), t(6), WEST, WEST, WEST, RED_DRAGON],
    melds: [],
    flowers: [],
    winningTile: RED_DRAGON,
    selfDraw: false,
    seatWind: 1,
    roundWind: 0,
    isDealer: false,
    rawFaan: 5,
    capped: false,
    values: {},
    configurable: false,
    gap:
      "The reading is a condition on WinContext.selfDraw inside the 四暗刻 detector. " +
      "Needs a Ruleset flag, e.g. fourConcealedPungsSelfDrawOnly.",
    expected: { faan: 5, awards: ["allPungs", "concealedHand", "noFlowers"], legal: true },
    contested:
      "The widest faan gap in the whole map: 13 against 5 on identical tiles. hk-scoring.ts states the conflict outright — 'rules conflict across houses here, verify yours'.",
  },

  /* ── R12 搶槓 off a 暗槓 ──────────────────────────────────────────────────── */
  {
    ...hkos,
    id: "contested-rob-concealed-kong-refused",
    ruling: "rob-concealed-kong",
    side: "shipped",
    reading: "Only 加槓 opens a 搶槓 window. A concealed kong is complete in one action and cannot be robbed.",
    description:
      "Thirteen orphans waiting on 東 while the seat above declares a concealed kong of 東: under the shipped reading no claim window opens and this win never happens.",
    concealed: [m(1), m(9), s(1), s(9), t(1), t(9), EAST, SOUTH, WEST, NORTH, RED_DRAGON, GREEN_DRAGON, WHITE_DRAGON],
    melds: [],
    flowers: [],
    winningTile: EAST,
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    robbedKong: true,
    unreachable: true,
    shape: "thirteenOrphans",
    rawFaan: 0,
    capped: false,
    values: {},
    configurable: true,
    expected: { faan: 0, awards: [], legal: false },
    contested:
      "The TVB 2026 rules say 'a concealed kong cannot be used to win' — most naturally read as forbidding exactly this, but the sentence is ambiguous and the PDF has not been checked against the Chinese text.",
  },
  {
    ...hkos,
    id: "contested-rob-concealed-kong-allowed",
    ruling: "rob-concealed-kong",
    side: "variant",
    reading: "十三么 alone may rob a 暗槓 — the one hand for which a concealed kong is not safe.",
    description:
      "The same thirteen orphans at a house that allows the rob: 十三么 13 + 搶槓 1 + 無花 1, raw 15, capped to 13.",
    concealed: [m(1), m(9), s(1), s(9), t(1), t(9), EAST, SOUTH, WEST, NORTH, RED_DRAGON, GREEN_DRAGON, WHITE_DRAGON],
    melds: [],
    flowers: [],
    winningTile: EAST,
    selfDraw: false,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    robbedKong: true,
    shape: "thirteenOrphans",
    rawFaan: 15,
    capped: true,
    values: {},
    configurable: false,
    gap:
      "The 搶槓 window is opened by reducer.ts when a 加槓 is declared. Robbing a " +
      "暗槓 is a different transition, not a faan value.",
    expected: { faan: 13, awards: ["thirteenOrphans", "robbingKong", "noFlowers"], legal: true },
    contested:
      "門前清 is left off to match limit-thirteen-orphans-single-wait-discard; patterns.ts's own note leaves it additive, which would make this raw 16. Same payout, different breakdown.",
  },

  /* ── R13 花糊 all eight bonus tiles (shipped side: honours-all-eight-bonus-tiles) ── */
  {
    ...hkos,
    id: "contested-all-eight-flowers-instant-win",
    ruling: "all-eight-flowers",
    side: "variant",
    reading: "花糊 — the eighth bonus tile ends the hand there and then, at the limit.",
    description:
      "honours-all-eight-bonus-tiles's tiles at a 花糊 house. The tiles are recorded only because a fixture needs fourteen of them: under this reading the hand need not be complete at all.",
    concealed: [t(7)],
    melds: [pung(0, WHITE_DRAGON), chow(3, m(4)), chow(3, s(1)), chow(3, t(4))],
    flowers: [PLUM, ORCHID, CHRYSANTHEMUM, BAMBOO_FLOWER, SPRING, SUMMER, AUTUMN, WINTER],
    winningTile: t(7),
    selfDraw: false,
    seatWind: 3,
    roundWind: 1,
    isDealer: false,
    rawFaan: 13,
    capped: false,
    values: { allEightBonusTiles: LIMIT_FAAN },
    configurable: false,
    gap:
      "Needs a pattern id AND a reducer branch: the hand ends on the eighth bonus " +
      "tile, with no winning shape required. See UNCATALOGUED.",
    expected: { faan: 13, awards: ["allEightBonusTiles"], legal: true },
    contested:
      "The shipped side pays 7 additively. The gap is 6 faan, but the real cost is that a 花糊 table ends the hand on a state the reducer has no path to — and the winner may hold no winning shape whatsoever.",
  },

  /* ── R14 七對子 — does HK Old Style play it at all? ──────────────────────── */
  {
    ...hkos,
    id: "contested-seven-pairs-not-a-hand",
    ruling: "seven-pairs",
    side: "shipped",
    reading: "七對子 is not a Hong Kong hand. Seven pairs is not four sets and a pair, so it is not a win.",
    description:
      "hk-scoring.ts's own seven-pairs illustration under hkos-standard: the shape never decomposes, so the hand is not complete and cannot be declared at any price.",
    concealed: [m(2), m(2), m(5), m(5), s(3), s(3), s(6), s(6), t(8), t(8), WEST, WEST, RED_DRAGON],
    melds: [],
    flowers: [],
    winningTile: RED_DRAGON,
    selfDraw: true,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    shape: "sevenPairs",
    rawFaan: 0,
    capped: false,
    values: {},
    configurable: true,
    expected: { faan: 0, awards: [], legal: false },
    contested:
      "All six systems in hk-scoring.ts print 4 for 七對子, but the TVB tournament list does not recognise it and ENGINE-AUDIT §1 calls it 'not in classic HKOS at all'. hkos-standard omits it on the audit's authority, against its own source column.",
  },
  {
    ...base,
    ruleset: "liu",
    id: "contested-seven-pairs-liu-four",
    ruling: "seven-pairs",
    side: "variant",
    reading: "七對子 is a real hand worth 4 faan, concealed by definition.",
    description:
      "LIU variant, deliberately: the same seven pairs self-drawn scores 七對子 4 + 自摸 1 + 無花 1 = 6. 七對子 subsumes 門前清 (patterns.ts).",
    concealed: [m(2), m(2), m(5), m(5), s(3), s(3), s(6), s(6), t(8), t(8), WEST, WEST, RED_DRAGON],
    melds: [],
    flowers: [],
    winningTile: RED_DRAGON,
    selfDraw: true,
    seatWind: 2,
    roundWind: 0,
    isDealer: false,
    shape: "sevenPairs",
    rawFaan: 6,
    capped: false,
    values: {},
    configurable: false,
    gap:
      "Pricing it is config — the LIU faanTable already does. RECOGNISING it is not: " +
      "ready.ts and decompose.ts only ever look for four sets and a pair, so LIU " +
      "currently prices a hand the engine cannot complete.",
    expected: { faan: 6, awards: ["sevenPairs", "selfDraw", "noFlowers"], legal: true },
    contested:
      "The pairs must be seven DIFFERENT tiles at most tables — four identical tiles are not two pairs — and some houses bar kongs from the hand as well. Both sub-rules are unmodelled.",
  },
];

/**
 * The subset a scoring test may safely run against the shipped presets. The
 * variants are wrong for hkos-standard ON PURPOSE and must not be handed to
 * score() without their `values` applied — and most of them need more than that.
 */
export const SHIPPED_CASES: readonly ContestedCase[] = cases.filter((c) => c.side === "shipped");

/* ══ the rulings ══════════════════════════════════════════════════════════
 * Ordered by impact — frequency × swing — not by how interesting they are.
 * The prose is ./CONTESTED.md; this is the same content in a shape a tool can
 * read. Frequencies are reasoned estimates, not measurements: nothing in this
 * repo has ever counted a real HK hand (CONTESTED.md §0). */

export const RULINGS: readonly Ruling[] = [
  {
    id: "self-draw-settlement",
    characters: "自摸找數",
    jyutping: "zi6 mo1 zaau2 sou3",
    question: "Is the figure printed in the 自摸 column what EACH loser pays, or the winner's whole collection?",
    options: [
      "perPlayer — each of the three losers pays the printed figure; the winner collects 3×.",
      "total — the printed figure is the pot and the three losers split it.",
    ],
    systems:
      "hk-scoring.ts does not carry payments at all. house-rules-and-metas.md §3.3 prints both as named schemes; TVB pays the winner 15×faan and each loser 5×faan, which is the `total` shape at a 1.5 premium.",
    shipped:
      "hkos-standard pairs the doubling ladder with perPlayer; LIU pairs its brackets with total. payment.ts argues LIU from the arithmetic — all four printed figures divide by three exactly, and perPlayer would make a 3-faan self-draw pay 3.5× a discard win.",
    status: "open",
    expressible: "paymentTable",
    impact:
      "Highest of anything here. Self-draws are an estimated 20-30% of wins, and the reading is a flat 3× on the whole settlement — not one faan, the entire hand.",
    recommendation:
      "Keep both tables and DECIDE PER PRESET, which is what DESIGN.md §4 already asks: verify LIU against mjrc-admin/reference/hk-scoring-calculator.xlsx before scoring ships. The arithmetic argument in payment.ts is good but it is inference, not the sheet.",
    covers: { shipped: [], variant: [] },
    whyNoFixture:
      "GoldenCase records faan and awards, never chips. A settlement fixture would have to assert a PaymentTable, which belongs beside rulesets/src/payment.ts, not in this family.",
  },
  {
    id: "flowers-toward-minimum",
    characters: "花唔計番",
    jyutping: "faa1 m4 gai3 faan1",
    question: "May bonus-tile faan carry a hand over the 3-faan minimum, or must the hand clear the floor unaided?",
    options: [
      "Flowers count — every faan is a faan, wherever it came from.",
      "花唔計番 — the hand must reach 3 on its tiles; bonus faan are added afterwards.",
    ],
    systems:
      "All six systems in hk-scoring.ts price the bonus tiles (正花 1, 一台花 2, 無花 1) but none of them says anything about the floor. The floor rule is table lore, not table data.",
    shipped: "hkos-standard counts them. Nothing states the choice — it falls out of summing the award list.",
    status: "accident",
    expressible: "rulesetFlag",
    impact:
      "Very high by frequency. An estimated ~88% of hands hold at least one bonus tile and ~40% hold an own flower, so this decides legality on a large share of cheap hands — the exact hands the 3-faan floor exists to filter.",
    recommendation:
      "Count them, as shipped — but say so in Ruleset with an explicit flag, because the opposite rule is common enough that a preset needs to be able to express it. This is the cheapest of the seven config gaps to close.",
    covers: {
      shipped: ["contested-flowers-lift-to-minimum", "honours-dealer-scores-no-extra-faan"],
      variant: ["contested-flowers-excluded-from-minimum"],
    },
  },
  {
    id: "concealed-hand-faan",
    characters: "門前清",
    jyutping: "mun4 cin4 cing1",
    question: "Does a hand with no claimed meld score a faan for being concealed?",
    options: [
      "Yes, 1 faan, whether the winning tile was drawn or discarded.",
      "No — 自摸 is the only reward for a closed hand.",
    ],
    systems:
      "MJ Time's column reads '—'; the other five pay 1. The TVB 2026 tournament list does not award it either.",
    shipped: "hkos-standard pays 1, taking the Wikipedia column.",
    status: "decided",
    expressible: "faanTable",
    impact:
      "High. Concealed wins are an estimated 15-25% of hands, and at the floor the faan decides legality outright — six golden cases in basic.ts already turn on it.",
    recommendation:
      "Keep it at 1. Five of six systems pay it, it is what HK club play expects, and dropping it would make several existing golden hands unwinnable. Note that TVB drops it because tournament play also drops flowers and the dealer repeat — do not import one dial from that sheet alone.",
    covers: {
      shipped: ["contested-concealed-hand-paid", "basic-all-chows-concealed-discard-short"],
      variant: ["contested-concealed-hand-unpaid"],
    },
  },
  {
    id: "all-chows-honour-eyes",
    characters: "平糊",
    jyutping: "ping4 wu4",
    question: "Does an honour pair as the eyes disqualify a hand from 平糊?",
    options: [
      "No — 平糊 constrains the four sets, not the pair.",
      "Yes — the eyes must be a suited pair.",
    ],
    systems:
      "All six price 平糊 at 1 and none of them qualifies the eyes. hk-scoring.ts records the restriction as a real house wrinkle: 'rare, but it comes up'.",
    shipped: "hkos-standard allows honour eyes. patterns.ts states the house rule and declines to model it.",
    status: "decided",
    expressible: "rulesetFlag",
    impact:
      "High by frequency, small by faan. All-chows is the commonest winning shape and the 1 faan is often the difference between a legal win and a refused one — three golden cases already carry the note.",
    recommendation:
      "Allow honour eyes, as shipped. If a preset ever needs the restriction it is a boolean on Ruleset, not a faan value — and the flag is worth adding at the same time as the 花唔計番 flag, since both are floor-adjacent detector conditions.",
    covers: {
      shipped: ["contested-all-chows-honour-eyes-paid", "flush-half-all-chows-honour-eyes"],
      variant: ["contested-all-chows-honour-eyes-refused"],
    },
  },
  {
    id: "full-flush-value",
    characters: "清一色",
    jyutping: "cing1 jat1 sik1",
    question: "Is a full flush worth 6 faan or 7?",
    options: ["6 — MJ Time, MJB, Dragon Society, Wikipedia.", "7 — LIU and L2."],
    systems: "hk-scoring.ts prints 6·6·6·7·6·7 and labels the row '6-7' on its face.",
    shipped: "hkos-standard 6 (Wikipedia column); LIU 7. Both readings already ship as presets.",
    status: "decided",
    expressible: "faanTable",
    impact:
      "Moderate-high. Full flush is an estimated 1-3% of wins, and 1 faan is a full doubling step on the HKOS ladder — 96 chips against 64 at the 9-faan step.",
    recommendation:
      "Nothing to settle. This is the model working: two presets, two columns, no argument. Cite it as the example when someone asks what 'rulesets are data' buys.",
    covers: {
      shipped: ["basic-full-flush-all-chows"],
      variant: ["basic-full-flush-liu-seven"],
    },
  },
  {
    id: "per-kong-faan",
    characters: "槓",
    jyutping: "gong3",
    question: "Does declaring a kong pay faan of its own?",
    options: [
      "No — a kong is worth what the tiles are worth; the reward is the replacement draw.",
      "1 faan per kong, any form.",
      "1 faan for 暗槓 only.",
    ],
    systems:
      "No system in hk-scoring.ts has a per-kong row; every kong row prices the same as the matching pung. The rule is common at real tables anyway, and the fun/party meta in house-rules-and-metas.md doubles the hand per kong.",
    shipped: "hkos-standard pays nothing. patterns.ts gives kongs no id at all, deliberately.",
    status: "decided",
    expressible: "patternId",
    impact:
      "Moderate. A kong appears in an estimated 15-25% of hands, so a 1-2 faan bonus would move a meaningful share of settlements — and near the floor it changes legality.",
    recommendation:
      "Keep paying nothing, and ADD the id anyway. `kongBonus` costs nothing when a preset prices it 0, and without it no house that pays for kongs can be a preset at all — which is the case DESIGN.md §4 says must never require a fork.",
    covers: {
      shipped: ["kongs-two-concealed-kongs-score-nothing-extra"],
      variant: ["contested-per-kong-faan-paid"],
    },
  },
  {
    id: "concealed-kong-concealment",
    characters: "暗槓",
    jyutping: "am3 gong3",
    question: "Does declaring a concealed kong cost the hand its 門前清?",
    options: [
      "No — nothing was claimed from a discard, so the hand is still concealed.",
      "Yes — the kong is face-up on the table, so the hand is exposed.",
    ],
    systems:
      "No system addresses it directly. hk-scoring.ts defines 門前清 as 'no melds claimed from discards', which reads for the shipped answer; the TVB list bans winning off a concealed kong without saying anything about concealment.",
    shipped:
      "hkos-standard keeps the hand concealed — kongs-concealed-kong-keeps-hand-concealed states the reasoning in its description.",
    status: "decided",
    expressible: "rulesetFlag",
    impact:
      "Low-moderate. Concealed kongs are uncommon, but the 1 faan lands on hands that are already near the floor, and here it refuses the win outright.",
    recommendation:
      "Keep it concealed. It follows from the definition every source gives, and the minority reading punishes a player for a declaration the rules require them to make face-up.",
    covers: {
      shipped: ["kongs-concealed-kong-keeps-hand-concealed"],
      variant: ["contested-concealed-kong-breaks-concealment"],
    },
  },
  {
    id: "small-three-dragons-value",
    characters: "小三元",
    jyutping: "siu2 saam1 jyun4",
    question: "Is 小三元 worth 5 faan or 4 — and are the two dragon pungs inside that value or on top of it?",
    options: [
      "5, dragon pungs included (the Wikipedia column).",
      "4, dragon pungs included (Dragon Society, LIU, L2).",
      "4 or 5 with the two dragon pungs paid on top — 6 or 7 effective.",
    ],
    systems: "hk-scoring.ts prints —·—·4·4·5·4 and labels the row '4-5'.",
    shipped:
      "hkos-standard 5, with the dragon pungs subsumed. The 5 is not a judgement — it is whatever the Wikipedia column said, because the preset takes that column whole.",
    status: "accident",
    expressible: "faanTable",
    impact:
      "Moderate. 小三元 is an estimated 0.3-1% of wins; 1 faan is one doubling step, and the additive reading is worth 2-3.",
    recommendation:
      "Move to 4. Three of the four systems that price the hand say 4, and the column-whole rule that produced the 5 was adopted to avoid cherry-picking, not because Wikipedia is the better source. Keep the subsumption — hk-scoring.ts states outright that the value already includes the pungs.",
    covers: {
      shipped: ["honours-small-three-dragons"],
      variant: ["contested-small-three-dragons-four"],
    },
  },
  {
    id: "all-terminals-value",
    characters: "清么九",
    jyutping: "cing1 jiu1 gau2",
    question: "Is 清么九 a 7-faan pattern that stacks, or a flat limit hand?",
    options: ["7, additive (Wikipedia).", "13, flat limit (LIU, L2).", "10, starred limit (MJ Time, MJB)."],
    systems: "hk-scoring.ts prints 10*·10*·—·13*·7·13*. The Wikipedia 7 is the outlier and every other system treats the hand as a limit.",
    shipped:
      "hkos-standard 7. presets.ts says so in as many words: kept because the golden flush family pins it at 7 while the limit family declares 10, and the suite cannot be satisfied both ways. 'Open question, not a decision.'",
    status: "accident",
    expressible: "faanTable",
    impact:
      "Low by frequency — 清么九 is rarer than 1 in 1,000 wins — but the swing is 6 faan on a melded hand, and the fixtures currently disagree with each other, which costs more than the ruling does.",
    recommendation:
      "Move to 13 and fix the fixtures that pinned the 7. Five of six systems treat it as a limit hand; the 7 exists only because two golden families were authored against different assumptions. Settle the 對對糊-stacking axis in the same pass — scoring.test.ts already lists six cases blocked on it.",
    covers: {
      shipped: ["contested-all-terminals-additive", "flush-all-terminals-concealed"],
      variant: ["contested-all-terminals-flat-limit"],
    },
  },
  {
    id: "small-four-winds-value",
    characters: "小四喜",
    jyutping: "siu2 sei3 hei2",
    question: "Is 小四喜 worth 6 faan, 10, or the limit — and does it swallow 門風 and 圈風?",
    options: [
      "6 (Wikipedia), winds subsumed.",
      "10 (LIU) or a flat limit (MJ Time, MJB, L2).",
      "5 (TVB tournament list).",
      "Any of the above with 門風/圈風 paid on top.",
    ],
    systems: "hk-scoring.ts prints 10*·10*·—·10*·6·10*. Only the column hkos-standard takes says 6.",
    shipped:
      "hkos-standard 6, winds subsumed by the fixtures. The subsumption is disputed inside this repo: patterns.ts says the four-winds patterns do NOT swallow the positional wind faan and honours.ts rules that they do, each citing the other. AUDIT.md D3 settles it for the catalogue and lists three fixtures owing a correction.",
    status: "open",
    expressible: "faanTable",
    impact:
      "Low by frequency (an estimated 0.05-0.2% of wins), large by swing — 6 against 13 is the difference between a good hand and a hand that ends the round.",
    recommendation:
      "Move to 10, matching four of the five systems that price it. Settle the subsumption the other way from honours.ts — 門風/圈風 are positional faan and a house paying them on top is paying for a different thing, which is what patterns.ts already says and what AUDIT.md D3 confirms. Do the subsumption FIRST: it blocks three fixtures today and only one of them shows a payout change, which is why it went unnoticed.",
    covers: {
      shipped: ["honours-small-four-winds-half-flush"],
      variant: ["contested-small-four-winds-limit"],
    },
  },
  {
    id: "four-concealed-pungs-on-discard",
    characters: "四暗刻",
    jyutping: "sei3 am3 hak1",
    question: "May 四暗刻 be won on a discard, and if so on what?",
    options: [
      "Yes, provided all four pungs are already complete and the discard only fills the pair.",
      "No — 四暗刻 is a self-draw hand; on a discard it is 對對糊.",
      "Yes, and the discard may complete the fourth pung too (a minority).",
    ],
    systems:
      "hk-scoring.ts's own long note says the classic form is self-drawn, sets out the pair-only allowance for a discard, and ends 'rules conflict across houses here — verify yours'. The values also split: 10*·10*·—·13*·10·13*.",
    shipped:
      "hkos-standard allows the pair-only discard and pays 13. The value 13 is one of the two departures presets.ts names explicitly; the discard allowance is stated only in a fixture description.",
    status: "decided",
    expressible: "detector",
    impact:
      "Rare — an estimated 0.1-0.3% of wins, of which perhaps a third arrive on a discard — but 13 against 5 is the widest faan gap in the map, and it is the ruling most likely to stop a game while people argue.",
    recommendation:
      "Keep the pair-only allowance. It is the common HK reading, it is what hk-scoring.ts describes as the mainstream, and it draws the line where the concealment argument actually is: a pung finished by someone else's tile was never concealed, a pair finished by one still leaves four concealed pungs. Put it in Ruleset as a flag rather than leaving it implicit in the detector.",
    covers: {
      shipped: ["kongs-four-concealed-pungs-discard-completes-pair"],
      variant: ["contested-four-concealed-pungs-strict-discard"],
    },
  },
  {
    id: "seven-pairs",
    characters: "七對子",
    jyutping: "cat1 deoi3 zi2",
    question: "Does Hong Kong Old Style recognise seven pairs as a winning shape at all?",
    options: [
      "No — HKOS wins are four sets and a pair. Seven pairs is not a hand.",
      "Yes, 4 faan, concealed by definition.",
    ],
    systems:
      "All six columns in hk-scoring.ts print 4, which is the strongest apparent consensus anywhere in the sheet. Against that: the TVB tournament list does not recognise it, house-rules-and-metas.md marks it '— (not recognized)' for TVB, and ENGINE-AUDIT §1 calls it 'not in classic HKOS at all'.",
    shipped:
      "hkos-standard omits it; LIU prices it 4. presets.ts lists it under 'absent on purpose' — a departure from the source column that is NOT counted among the two departures the file names.",
    status: "decided",
    expressible: "detector",
    impact:
      "Nil where it is omitted and structural where it is not. A payable 七對子 changes what players PURSUE: a broken hand that would be abandoned becomes a live target, which shifts discard behaviour across the whole game, not just the settlement.",
    recommendation:
      "Keep it out of hkos-standard and keep it in LIU, as shipped — but record the reasoning where the omission is, because the six-column consensus points the other way and the next reader will assume a transcription slip. Note that pricing it is not enough to enable it: ready.ts and decompose.ts only ever look for four sets and a pair, so the LIU preset currently prices a hand the engine cannot recognise.",
    covers: {
      shipped: ["contested-seven-pairs-not-a-hand"],
      variant: ["contested-seven-pairs-liu-four"],
    },
  },
  {
    id: "rob-concealed-kong",
    characters: "搶暗槓",
    jyutping: "coeng2 am3 gong3",
    question: "May a concealed kong be robbed, and if so by which hands?",
    options: [
      "No — only 加槓 opens a 搶槓 window.",
      "Yes, but only by 十三么.",
      "Yes, by any hand.",
    ],
    systems:
      "Every system prices 搶槓 at 1 and none of them says which kong forms open the window. TVB adds 'a concealed kong cannot be used to win', which most naturally means it cannot be robbed — but the sentence is ambiguous and nobody has checked it against the Chinese original.",
    shipped:
      "hkos-standard allows robbing only 加槓. types.ts documents the rob window as belonging to the added kong, and the reducer follows.",
    status: "decided",
    expressible: "stateMachine",
    impact:
      "Negligible in play — an estimated worse than 1 in 100,000 hands — and total when it happens: the win either exists or it does not.",
    recommendation:
      "Keep it forbidden, and resolve the TVB sentence before quoting that sheet anywhere else. The rule matters less for its frequency than for what it says about concealed kongs generally: under the shipped reading a 暗槓 is completely safe, which is a real strategic property worth stating in the rules page.",
    covers: {
      shipped: ["contested-rob-concealed-kong-refused"],
      variant: ["contested-rob-concealed-kong-allowed"],
    },
  },
  {
    id: "all-eight-flowers",
    characters: "花糊",
    jyutping: "faa1 wu4",
    question: "Does holding all eight bonus tiles win the hand outright?",
    options: [
      "No — they score additively like any other bonus tiles (1 + 1 + 2 + 2 here).",
      "花糊 — the eighth bonus tile ends the hand immediately at the limit.",
      "Seven of eight is its own event: extra faan, or the right to rob the eighth.",
    ],
    systems:
      "Every column reads '—'. hk-scoring.ts marks the row 'Win*' and says 'instant win under some rules'; the Classical meta in house-rules-and-metas.md turns it on.",
    shipped: "hkos-standard scores them additively — honours-all-eight-bonus-tiles pays 7.",
    status: "open",
    expressible: "stateMachine",
    impact:
      "Roughly 1 in 25,000-50,000 hands by the tile arithmetic, and rarer in practice because most hands end long before the wall runs out. The scoring gap is 6 faan; the real problem is that the hand ends on a state the reducer cannot reach.",
    recommendation:
      "Leave it off for hkos-standard and treat it as a Classical/party preset feature. If it is ever turned on it needs a reducer branch and a pattern id, so decide before either is written rather than after — and settle the seven-tile rule at the same time, since houses that play one usually play both.",
    covers: {
      shipped: ["honours-all-eight-bonus-tiles"],
      variant: ["contested-all-eight-flowers-instant-win"],
    },
  },
];

export const RULING_IDS: readonly string[] = RULINGS.map((r) => r.id);

/** Rulings whose variant reading cannot be expressed as configuration today. */
export const CONFIG_GAPS: readonly Ruling[] = RULINGS.filter(
  (r) => r.expressible !== "faanTable" && r.expressible !== "paymentTable",
);

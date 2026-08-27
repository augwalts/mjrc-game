/**
 * Golden hands — CHIP SETTLEMENT 銃碼. DESIGN.md §4 ("rulesets are data": the
 * payment table is config, and the self-draw settlement is the thing §4 and §9
 * both flag as unsettled) and §8 (this suite is the only validation source for
 * the canonical extensions, and it names the dealer double as one of them).
 *
 * The other 124 golden cases answer "how many faan?". Not one of them answers
 * "who hands over how many chips?", which is the number a player actually sees.
 * This family answers only the second question, so every case here is built so
 * that its FAAN is uncontroversial and its CHIPS are the whole lesson.
 *
 * ── the invariant ────────────────────────────────────────────────────────
 * Chips are conserved. Four seats, deltas summing to zero, every hand, every
 * settlement, always. The sibling test asserts it on every case and it is the
 * single check that catches most settlement bugs: a per-player figure paid as a
 * total, a discard win charged to three seats, a dealer double credited to the
 * winner but not debited from the payer — all of them break the sum.
 *
 * ── why every case names a payment table, not just a ruleset ──────────────
 * rulesets/src/payment.ts ships FOUR tables, because two independent choices
 * are open and both readings of each are really played:
 *
 *   the schedule    hkos-doubling — the published ladder, doubling every 2 faan
 *                   liu-brackets — the flat four-row table (92/108 · 124/156 ·
 *                   188/252 · 316/444) the family house prints
 *   the settlement  perPlayer — each of the three losers pays the printed
 *                   self-draw figure, so the winner collects three times it
 *                   total — the printed figure IS the winner's collection and
 *                   the three losers split it, rounded up
 *
 * A preset pairs one of each (hkos-standard takes hkos-doubling-perPlayer, liu
 * takes liu-brackets-total), but a house may pair them any way it likes, so a
 * case that names only its ruleset has not said enough to be checked. Cases
 * below deliberately cross the pairings — the same fourteen tiles under
 * hkos-doubling-perPlayer AND hkos-doubling-total — because that is the only
 * way to make the settlement difference visible rather than argued about.
 *
 * ── every award this family uses is priced IDENTICALLY in both presets ────
 * 混一色 3, 對對糊 3, 平糊 1, 正花 1, 自摸 1, 四暗刻 13 — HKOS_STANDARD and LIU
 * agree on all six (rulesets/src/presets.ts). That is deliberate: it means a
 * chip difference between two cases here can only have come from the SCHEDULE
 * or the SETTLEMENT, never from the faan table. A family that varied both at
 * once would prove nothing.
 *
 * ── the dealer double, and the contract gap it sits in ───────────────────
 * DESIGN.md §4 lists the dealer double in what P0 ships and §8 lists it in what
 * the golden suite must validate. It is NOT implemented and it CANNOT be:
 * PaymentTable (engine/src/types.ts) exposes `onDiscard(faan)` and
 * `onSelfDraw(faan)` and neither is told who is paying, so the table has no
 * hook for 莊. engine/src/reducer.ts `settle` accordingly pays the dealer flat.
 * Rather than pretend, this family carries the rule as `dealerRule` data and
 * ships BOTH readings, exactly as payment.ts ships both settlements:
 *
 *   flat    the dealer pays and collects like anyone else. This is what the
 *           shipped tables and the shipped reducer do TODAY.
 *   double  any payment the dealer makes or receives doubles. So a dealer win
 *           doubles all three payments; a dealer who feeds the winner pays
 *           twice; a hand with no dealer on either side is unchanged.
 *
 * The doubling is applied to the per-payer figure AFTER the schedule is read,
 * which is why `expectedPayment.base` records the undoubled figure separately —
 * a scorer that doubles the faan instead of the chips lands somewhere else
 * entirely on the doubling ladder and this family catches it.
 *
 * ── the cap 爆棚 is applied to the FAAN, before the schedule is read ──────
 * `expected.faan` is min(rawFaan, 13) and the chips are looked up at that
 * capped value. Be warned that the shipped schedules also clamp their own
 * argument to [0, 13], so a scorer that passed rawFaan straight through would
 * land on the same chips and this family would not catch it. That defensive
 * clamp is load-bearing rather than redundant: HKOS_BASE_CHIPS has fourteen
 * entries, so an uncapped 14 would index `undefined` without it. The intended
 * ORDER is pinned here regardless of whether chips can currently observe it.
 *
 * ── conventions inherited from ./basic.ts, ./limit.ts and ./kongs.ts ──────
 * Seat index equals wind index, so 東 is seat 0 and 東 is the dealer; a chow's
 * `from` is (seat + 3) % 4, the upper house 上家. Award ids are stable
 * lowerCamelCase and `expected.awards` lists only what is PAID, so a subsumed
 * id never appears. A hand holding no bonus tile scores 無花, so `flowers: []`
 * is never neutral — every case here holds exactly one bonus tile, and the ones
 * not testing 正花 hold one belonging to ANOTHER seat, which pays nothing.
 *
 * Tile ids (../../src/types.ts): 0-8 萬 · 9-17 索 · 18-26 筒 ·
 * 27-30 東南西北 · 31-33 中發白 · 34-41 花 (梅蘭菊竹春夏秋冬).
 *
 * Every case is provisional (§8). Nothing ships until a strong HK player has
 * signed off on the chip figures, and the dealer-double cases need that most.
 *
 * Terminology: ../../../TERMINOLOGY.md. HK only.
 */
import type { Meld, SeatIndex, SelfDrawSettlement, TileId } from "../../src/types.js";
import type { GoldenCase } from "./case.js";

/**
 * 莊 handling. Not a PaymentTable field — the contract has no hook for it (see
 * header), so it is fixture data and both readings ship.
 */
export type DealerRule = "flat" | "double";

/** Chip movement, indexed by seat. Must sum to zero. */
export type Deltas = [number, number, number, number];

/**
 * GoldenCase cannot express what a settlement case needs. Rather than edit the
 * shared contract these live here, and the gaps are reported:
 *   - the discarder's seat. GoldenCase carries `selfDraw` but no `from`, so
 *     "seat 2 won on the DEALER's discard" — the whole dealer-loses case — is
 *     unsayable. WinContext HAS `from`; GoldenCase does not.
 *   - which seat is dealing. `isDealer` says only whether the WINNER is dealer,
 *     which settles nothing when the dealer is one of the three payers.
 *   - the payment table. GoldenCase names a ruleset, and a ruleset pins one
 *     pairing of schedule and settlement; this family has to cross them.
 *   - the uncapped total, same gap ./limit.ts records.
 */
export interface PaymentCase extends GoldenCase {
  /** Seat that discarded the winning tile; null on a self-draw. */
  from: SeatIndex | null;
  /** 莊's seat. Always 0 here — seat index equals wind index, so 東 deals. */
  dealer: SeatIndex;
  /** PaymentTable id from rulesets/src/payment.ts, e.g. "liu-brackets-total". */
  paymentTable: string;
  /** Restated from the id so a case reads without a lookup. */
  settlement: SelfDrawSettlement;
  /** Which 莊 reading this house plays. See header. */
  dealerRule: DealerRule;
  /** Uncapped sum of `expected.awards`, before 爆棚. */
  rawFaan: number;
  /** True when the limit actually bit, i.e. rawFaan > limitFaan. */
  capped: boolean;
  expectedPayment: {
    /**
     * What ONE payer owes before any dealer double: onDiscard(faan) for a
     * discard win, onSelfDraw(faan) for a self-draw. Quoted even when the hand
     * is refused, so the refusal is visibly a refusal and not a zero price.
     */
    base: number;
    /** Chip movement by seat. Sums to zero, always. */
    deltas: Deltas;
    /** What the winner takes in — equals deltas[seat]. Zero on a refusal. */
    collects: number;
  };
}

/* ── tile ids, written the way the MJRC scoring pages write them ────────────
 * m = 萬 characters (0-8) · s = 索 bamboo (9-17) · t = 筒 circles (18-26).   */
const m = (rank: number): TileId => rank - 1;
const s = (rank: number): TileId => 8 + rank;
const t = (rank: number): TileId => 17 + rank;

const NORTH = 30;
const PLUM = 34, ORCHID = 35;

/** 爆棚. Both shipping presets set limitFaan to 13 (rulesets/src/presets.ts). */
export const LIMIT_FAAN = 13;

/** Both presets carry minimumFaan 3 (DESIGN.md §4). */
export const MINIMUM_FAAN = 3;

/**
 * The six award values this family uses, mirrored from rulesets/src/presets.ts.
 * HKOS_STANDARD and LIU price all six the same, which is why one table serves
 * both rulesets here — and why any chip difference below is attributable to the
 * payment table alone. presets.ts stays the source of truth; the sibling test
 * re-adds every case against this mirror so a drifted copy fails loudly.
 */
export const FAAN: Readonly<Record<string, number>> = {
  allChows: 1,
  allPungs: 3,
  halfFlush: 3,
  ownFlower: 1,
  selfDraw: 1,
  fourConcealedPungs: 13,
  /** Never awarded below — every case holds a bonus tile — but the guard needs it priced. */
  noFlowers: 1,
};

/** A chow may only be claimed from 上家, the seat that plays immediately before you. */
const chow = (seat: SeatIndex, low: TileId): Meld => ({
  kind: "chow",
  tiles: [low, low + 1, low + 2],
  from: ((seat + 3) % 4) as SeatIndex,
  concealed: false,
});

/** A pung may be claimed from any seat; these take one that is not the winner's. */
const pung = (seat: SeatIndex, tile: TileId, offset: 1 | 2 | 3): Meld => ({
  kind: "pung",
  tiles: [tile, tile, tile],
  from: ((seat + offset) % 4) as SeatIndex,
  concealed: false,
});

/* ── the five hands, each reused across the cases that contrast on chips ────
 *
 * Reuse is the point. A settlement difference is only legible when the hand is
 * held still, so these five shapes carry all 24 cases between them and the
 * sibling test asserts that cases sharing a shape really do hold the same
 * fourteen tiles AND the same exposure.
 *
 * Two of the five are the same fourteen tiles on purpose: `allPungsMixed` claims
 * two of its pungs off discards and `fourConcealedPungs` claims none. Identical
 * counts, 4 faan against 13, and 48 chips against 1152. An engine that scores
 * from tile counts and ignores the meld list looks correct across most of this
 * suite and is out by 24x on that pair.
 */

/**
 * 混一色 exactly 3 faan — the floor, and nothing else. Bamboo plus a 北 pung, a
 * chow and a pung melded so neither 平糊 nor 對對糊 nor 門前清 can fire, and 北
 * is nobody's seat wind in the cases that use it. Won on a discard, so no 自摸.
 */
const halfFlushFloor = (seat: SeatIndex) => ({
  concealed: [s(4), s(5), s(6), s(7), s(7), s(7), s(9)],
  melds: [chow(seat, s(1)), pung(seat, NORTH, 1)],
  winningTile: s(9),
});

/**
 * 對對糊 across three suits with no honour anywhere, two pungs melded. 3 faan on
 * a discard, 4 self-drawn. The workhorse for the settlement pairs: 4 faan is
 * HKOS_BASE_CHIPS[4] = 16, which does NOT divide by three, so the `total`
 * reading has to round.
 */
const allPungsMixed = (seat: SeatIndex) => ({
  concealed: [m(7), m(7), m(7), t(3), t(3), t(8), t(8)],
  melds: [pung(seat, m(2), 1), pung(seat, s(5), 2)],
  winningTile: t(8),
});

/** 混一色對對糊 self-drawn — 7 faan, where HKOS pays 48 and 48 divides by three exactly. */
const halfFlushAllPungs = (seat: SeatIndex) => ({
  concealed: [s(5), s(5), s(5), s(8), s(8), s(9), s(9)],
  melds: [pung(seat, s(2), 1), pung(seat, NORTH, 2)],
  winningTile: s(8),
});

/**
 * 四暗刻 — four concealed pungs across three suits, the winning tile completing
 * the PAIR. Worth the limit in both presets, so it is the one hand that reaches
 * the top row of both schedules without the faan tables disagreeing.
 */
const fourConcealedPungs = () => ({
  concealed: [m(2), m(2), m(2), m(7), m(7), m(7), s(5), s(5), s(5), t(3), t(8), t(8), t(8)],
  melds: [] as Meld[],
  winningTile: t(3),
});

/**
 * 平糊 with the seat's own 蘭 — 2 faan on a discard, which is BELOW the floor and
 * may not be taken, and 3 self-drawn, which is exactly the floor. The same
 * fourteen tiles on either side of the minimum.
 */
const allChowsOwnFlower = (seat: SeatIndex) => ({
  concealed: [m(5), m(5), s(4), s(5), s(6), t(3), t(4), t(7), t(8), t(9)],
  melds: [chow(seat, m(1))],
  winningTile: t(2),
});

const SOURCE =
  "rulesets/src/payment.ts (HKOS_BASE_CHIPS, LIU_BRACKETS, paymentTable) over rulesets/src/presets.ts";

/** §8: nothing ships unvalidated, and chip figures least of all. */
const base = { provisional: true, source: SOURCE, dealer: 0 as SeatIndex, roundWind: 0 } as const;

const HKOS_PER_PLAYER = {
  ...base,
  ruleset: "hkos-standard",
  paymentTable: "hkos-doubling-perPlayer",
  settlement: "perPlayer" as SelfDrawSettlement,
} as const;

const HKOS_TOTAL = {
  ...base,
  ruleset: "hkos-standard",
  paymentTable: "hkos-doubling-total",
  settlement: "total" as SelfDrawSettlement,
} as const;

const LIU_TOTAL = {
  ...base,
  ruleset: "liu",
  paymentTable: "liu-brackets-total",
  settlement: "total" as SelfDrawSettlement,
} as const;

const LIU_PER_PLAYER = {
  ...base,
  ruleset: "liu",
  paymentTable: "liu-brackets-perPlayer",
  settlement: "perPlayer" as SelfDrawSettlement,
} as const;

export const cases: PaymentCase[] = [
  /* ── A. 全銃 — a win from a discard: the discarder pays, alone ───────────
   * Three cases on ONE hand. The settlement column is irrelevant to a discard
   * win (PaymentTable.onDiscard ignores it entirely), so the first two prove
   * that by moving identical chips under opposite settlements; the third
   * changes the SCHEDULE and moves 5.75x as many.
   */

  {
    ...HKOS_PER_PLAYER,
    id: "payments-discard-half-flush-floor-hkos",
    description:
      "混一色 at exactly the 3-faan floor, 西 winning on 南's discard. The doubling ladder prices 3 faan at 8, and a discard costs twice that — 16 chips, out of one seat and into one seat.",
    ...halfFlushFloor(2),
    flowers: [PLUM], // 梅 belongs to 東; this seat is 西, so it pays nothing either way.
    selfDraw: false,
    from: 1,
    seatWind: 2,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 3,
    capped: false,
    expected: { faan: 3, awards: ["halfFlush"], legal: true },
    expectedPayment: { base: 16, deltas: [0, -16, 16, 0], collects: 16 },
  },
  {
    ...HKOS_TOTAL,
    id: "payments-discard-half-flush-floor-hkos-total",
    description:
      "The SAME fourteen tiles and the same discard, settled by a house that reads its 自摸 column as a total. Identical chips: the settlement only ever describes a self-draw, and an engine that branched on it here would be wrong.",
    ...halfFlushFloor(2),
    flowers: [PLUM],
    selfDraw: false,
    from: 1,
    seatWind: 2,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 3,
    capped: false,
    expected: { faan: 3, awards: ["halfFlush"], legal: true },
    expectedPayment: { base: 16, deltas: [0, -16, 16, 0], collects: 16 },
  },
  {
    ...LIU_TOTAL,
    id: "payments-discard-half-flush-floor-liu",
    description:
      "LIU variant: the same fourteen tiles, the same 3 faan — 混一色 is 3 in both columns — settled off the flat bracket table instead of the ladder. 92 chips against 16. Same hand, same faan, 5.75x the chips.",
    ...halfFlushFloor(2),
    flowers: [PLUM],
    selfDraw: false,
    from: 1,
    seatWind: 2,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 3,
    capped: false,
    expected: { faan: 3, awards: ["halfFlush"], legal: true },
    expectedPayment: { base: 92, deltas: [0, -92, 92, 0], collects: 92 },
    contested:
      "The two schedules are not on one scale — LIU's brackets are quoted in chips a table actually stacks, the ladder in abstract units. Comparing 92 against 16 says nothing about which house pays more; it says a chip figure is meaningless without its schedule, which is why every case names one.",
  },

  /* ── B. 自摸 — the settlement pair, which is the point of the family ─────
   * One hand, four tables. perPlayer collects three times what total collects,
   * off the same printed figure. This is the 3x that ENGINE-AUDIT §1 flags as
   * undocumented in the source table.
   */

  {
    ...HKOS_PER_PLAYER,
    id: "payments-self-draw-all-pungs-hkos-per-player",
    description:
      "對對糊 self-drawn by 西 for 4 faan, two pungs claimed off discards. perPlayer: the printed figure 16 is what EACH loser hands over, so three seats pay 16 and the winner collects 48. These are the same fourteen tiles as the 四暗刻 cases below, claimed rather than drawn.",
    ...allPungsMixed(2),
    flowers: [PLUM],
    selfDraw: true,
    from: null,
    seatWind: 2,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 4,
    capped: false,
    expected: { faan: 4, awards: ["allPungs", "selfDraw"], legal: true },
    expectedPayment: { base: 16, deltas: [-16, -16, 48, -16], collects: 48 },
  },
  {
    ...HKOS_TOTAL,
    id: "payments-self-draw-all-pungs-hkos-total",
    description:
      "The SAME hand read the other way: 16 is the winner's whole collection, split three ways. 16/3 does not divide, and payment.ts rounds UP to keep the winner whole — 6 each, so the winner takes 18 rather than the printed 16.",
    ...allPungsMixed(2),
    flowers: [PLUM],
    selfDraw: true,
    from: null,
    seatWind: 2,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 4,
    capped: false,
    expected: { faan: 4, awards: ["allPungs", "selfDraw"], legal: true },
    expectedPayment: { base: 6, deltas: [-6, -6, 18, -6], collects: 18 },
    contested:
      "Rounding up overpays the winner by 2 against the printed 16, and rounding down would underpay by 1. payment.ts chose up on the grounds that a short-changed winner is what starts arguments; a house that rounds down, or that makes one named seat carry the remainder, settles this hand at 15 or at 16 and needs its own table.",
  },
  {
    ...LIU_TOTAL,
    id: "payments-self-draw-all-pungs-liu-total",
    description:
      "LIU variant, same fourteen tiles, same 4 faan. The 4-6 faan bracket prints 156 for a self-draw and 156 divides by three exactly, so the total reading needs no rounding at all: 52 each, winner takes 156 — the printed figure, undistorted.",
    ...allPungsMixed(2),
    flowers: [PLUM],
    selfDraw: true,
    from: null,
    seatWind: 2,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 4,
    capped: false,
    expected: { faan: 4, awards: ["allPungs", "selfDraw"], legal: true },
    expectedPayment: { base: 52, deltas: [-52, -52, 156, -52], collects: 156 },
    source:
      "All four LIU self-draw figures divide by three exactly (108/156/252/444), which payment.ts records as the evidence for reading the column as a total.",
  },
  {
    ...LIU_PER_PLAYER,
    id: "payments-self-draw-all-pungs-liu-per-player",
    description:
      "LIU variant read the other way: the bracket's 156 is what EACH loser pays, so the winner collects 468 against 124 for the same 4 faan won on a discard — 3.77x. payment.ts argues no table plays a self-draw at nearly four times a discard win; it ships the reading anyway, because some houses quote their column that way.",
    ...allPungsMixed(2),
    flowers: [PLUM],
    selfDraw: true,
    from: null,
    seatWind: 2,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 4,
    capped: false,
    expected: { faan: 4, awards: ["allPungs", "selfDraw"], legal: true },
    expectedPayment: { base: 156, deltas: [-156, -156, 468, -156], collects: 468 },
    contested:
      "This is the ambiguity DESIGN.md §9 lists as an open action and ENGINE-AUDIT §1 traces to an undocumented column. The same fourteen tiles settle at 156 or at 468 depending only on how a house reads its own printed table, and nothing in the table itself decides it.",
  },
  {
    ...HKOS_PER_PLAYER,
    id: "payments-self-draw-half-flush-pungs-hkos-per-player",
    description:
      "混一色對對糊 self-drawn by 南 — 3 + 3 + 1 = 7 faan, the same total in both columns. perPlayer at 7 faan is 48 from each of three seats, 144 collected.",
    ...halfFlushAllPungs(1),
    flowers: [PLUM],
    selfDraw: true,
    from: null,
    seatWind: 1,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 7,
    capped: false,
    expected: { faan: 7, awards: ["allPungs", "halfFlush", "selfDraw"], legal: true },
    expectedPayment: { base: 48, deltas: [-48, 144, -48, -48], collects: 144 },
  },
  {
    ...HKOS_TOTAL,
    id: "payments-self-draw-half-flush-pungs-hkos-total",
    description:
      "The SAME hand as a total. 48 divides by three, so here the winner collects exactly the printed 48 and no rounding happens — the contrast against the 4-faan pair, where the same reading handed the winner 18 for a printed 16.",
    ...halfFlushAllPungs(1),
    flowers: [PLUM],
    selfDraw: true,
    from: null,
    seatWind: 1,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 7,
    capped: false,
    expected: { faan: 7, awards: ["allPungs", "halfFlush", "selfDraw"], legal: true },
    expectedPayment: { base: 16, deltas: [-16, 48, -16, -16], collects: 48 },
  },

  /* ── C. 莊 — the dealer double, in both readings ─────────────────────────
   * Paired flat/double cases on held-still hands. The control case matters as
   * much as the doubled ones: a hand with no dealer on either side must move
   * exactly the same chips under both rules, and an engine that doubles by
   * round wind or by seat wind rather than by dealership fails it.
   */

  {
    ...HKOS_PER_PLAYER,
    id: "payments-discard-dealer-wins-flat",
    description:
      "The dealer 東 takes the same 混一色 off 西's discard, at a house that plays 莊 flat. 16 chips, exactly what a non-dealer would collect — this is what the shipped PaymentTable and reducer do today.",
    ...halfFlushFloor(0),
    flowers: [ORCHID], // 蘭 belongs to 南; this seat is 東, so no 正花.
    selfDraw: false,
    from: 2,
    seatWind: 0,
    isDealer: true,
    dealerRule: "flat",
    rawFaan: 3,
    capped: false,
    expected: { faan: 3, awards: ["halfFlush"], legal: true },
    expectedPayment: { base: 16, deltas: [16, 0, -16, 0], collects: 16 },
  },
  {
    ...HKOS_PER_PLAYER,
    id: "payments-discard-dealer-wins-double",
    description:
      "The SAME hand and the same discard at a house that doubles 莊. The dealer is the winner, so the one payment doubles: 32 out of 西 and 32 into 東. The faan is untouched at 3 — the double is on the chips, not the faan.",
    ...halfFlushFloor(0),
    flowers: [ORCHID],
    selfDraw: false,
    from: 2,
    seatWind: 0,
    isDealer: true,
    dealerRule: "double",
    rawFaan: 3,
    capped: false,
    expected: { faan: 3, awards: ["halfFlush"], legal: true },
    expectedPayment: { base: 16, deltas: [32, 0, -32, 0], collects: 32 },
    contested:
      "Doubling the CHIPS and doubling the FAAN are different rules and this case cannot tell them apart at 3 faan by accident — 2x16 is 32, while 6 faan on the ladder is 2x32 = 64. Houses that play the dealer double as +1 faan or as a faan doubling land on 64 here. The chip reading is what DESIGN.md §4 means by 'dealer double' and is what this family fixes.",
  },
  {
    ...HKOS_PER_PLAYER,
    id: "payments-discard-dealer-pays-double",
    description:
      "The mirror: 西 takes the hand off the DEALER's discard, doubling house. Now it is the payer who is 莊, so the dealer alone pays 32 and the winner collects 32 — the dealer's double cuts both ways, which is the half an engine that only doubles dealer WINS gets wrong.",
    ...halfFlushFloor(2),
    flowers: [PLUM],
    selfDraw: false,
    from: 0,
    seatWind: 2,
    isDealer: false,
    dealerRule: "double",
    rawFaan: 3,
    capped: false,
    expected: { faan: 3, awards: ["halfFlush"], legal: true },
    expectedPayment: { base: 16, deltas: [-32, 0, 32, 0], collects: 32 },
  },
  {
    ...HKOS_PER_PLAYER,
    id: "payments-discard-no-dealer-party-double",
    description:
      "The control. Same hand, doubling house, but 西 wins off 南 and 東 is a spectator — so nothing doubles and the chips match the flat case exactly. An engine keying the double off the round wind, or off seat 0 being at the table at all, fails here and nowhere else.",
    ...halfFlushFloor(2),
    flowers: [PLUM],
    selfDraw: false,
    from: 1,
    seatWind: 2,
    isDealer: false,
    dealerRule: "double",
    rawFaan: 3,
    capped: false,
    expected: { faan: 3, awards: ["halfFlush"], legal: true },
    expectedPayment: { base: 16, deltas: [0, -16, 16, 0], collects: 16 },
  },
  {
    ...HKOS_PER_PLAYER,
    id: "payments-self-draw-dealer-wins-double",
    description:
      "東 self-draws 對對糊 for 4 faan at a doubling house. The winner is 莊, so ALL THREE payments double: 32 each, 96 collected, against 48 flat.",
    ...allPungsMixed(0),
    flowers: [ORCHID],
    selfDraw: true,
    from: null,
    seatWind: 0,
    isDealer: true,
    dealerRule: "double",
    rawFaan: 4,
    capped: false,
    expected: { faan: 4, awards: ["allPungs", "selfDraw"], legal: true },
    expectedPayment: { base: 16, deltas: [96, -32, -32, -32], collects: 96 },
  },
  {
    ...HKOS_PER_PLAYER,
    id: "payments-self-draw-dealer-pays-double",
    description:
      "西 self-draws the same 對對糊 at the same doubling house. Only the dealer's share doubles: 東 pays 32, 南 and 北 pay 16 each, winner collects 64. The three payers are NOT equal, which is the case that breaks an engine multiplying one figure by three.",
    ...allPungsMixed(2),
    flowers: [PLUM],
    selfDraw: true,
    from: null,
    seatWind: 2,
    isDealer: false,
    dealerRule: "double",
    rawFaan: 4,
    capped: false,
    expected: { faan: 4, awards: ["allPungs", "selfDraw"], legal: true },
    expectedPayment: { base: 16, deltas: [-32, -16, 64, -16], collects: 64 },
    contested:
      "`winnerCollects` in rulesets/src/payment.ts computes a self-draw as 3 * onSelfDraw(faan) — a closed form that is exactly right under the flat rule and wrong under this one. It is the shape of helper the double quietly invalidates.",
  },
  {
    ...HKOS_TOTAL,
    id: "payments-self-draw-dealer-pays-double-total",
    description:
      "The unequal-payers case again, this time on the total reading, where the base is the rounded-up 6. 東 pays 12, the others 6, winner collects 24. The double is applied AFTER the three-way split, not before — splitting a doubled 32 would give 11/11/11 and a different answer.",
    ...allPungsMixed(2),
    flowers: [PLUM],
    selfDraw: true,
    from: null,
    seatWind: 2,
    isDealer: false,
    dealerRule: "double",
    rawFaan: 4,
    capped: false,
    expected: { faan: 4, awards: ["allPungs", "selfDraw"], legal: true },
    expectedPayment: { base: 6, deltas: [-12, -6, 24, -6], collects: 24 },
    contested:
      "Order of operations, and genuinely open: split-then-double gives 12/6/6 = 24, double-then-split gives ceil(32/3) = 11 for the dealer against 6 for the others = 23, and a house that doubles the whole pot before splitting gives 11/11/11 = 33. This family fixes split-then-double because the printed column prices the HAND and the double prices the SEAT, but no source was found that says so.",
  },

  /* ── D. 爆棚 — the cap, applied to the faan before the schedule is read ──
   * 四暗刻 is 13 in both columns, so this hand reaches the top row of both
   * schedules with the faan tables in agreement. Won on the pair it is a clean
   * 13; self-drawn it is a raw 14 that the cap pulls back to 13, and the chips
   * must not move between those two.
   */

  {
    ...HKOS_PER_PLAYER,
    id: "payments-limit-four-concealed-pungs-self-draw-hkos",
    description:
      "四暗刻 self-drawn by 南 — 13 + 自摸 1 = raw 14, capped to 13. The ladder's top row is 384 per player, so three seats pay 384 and 1152 is collected. The 自摸 faan is real and still buys nothing: the cap ate it. The SAME fourteen tiles as the 4-faan 對對糊 cases, with nothing claimed — 24x the chips for the same tiles.",
    ...fourConcealedPungs(),
    flowers: [PLUM],
    selfDraw: true,
    from: null,
    seatWind: 1,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 14,
    capped: true,
    expected: { faan: 13, awards: ["fourConcealedPungs", "selfDraw"], legal: true },
    expectedPayment: { base: 384, deltas: [-384, 1152, -384, -384], collects: 1152 },
    contested:
      "四暗刻 self-drawn while already complete on the pair is a scoring question, not a payment one: some houses require the fourth pung to be the self-drawn tile. Both readings reach 13 here, so the chips are unaffected — noted because the AWARD list is what the event log stores.",
  },
  {
    ...LIU_TOTAL,
    id: "payments-limit-four-concealed-pungs-self-draw-liu",
    description:
      "LIU variant, the same fourteen tiles and the same capped 13 — 四暗刻 is 13 in both columns. The bracket table's top row prints 444, split three ways to 148 each with no rounding. Against the ladder's 1152, on the same hand at the same faan.",
    ...fourConcealedPungs(),
    flowers: [PLUM],
    selfDraw: true,
    from: null,
    seatWind: 1,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 14,
    capped: true,
    expected: { faan: 13, awards: ["fourConcealedPungs", "selfDraw"], legal: true },
    expectedPayment: { base: 148, deltas: [-148, 444, -148, -148], collects: 444 },
  },
  {
    ...HKOS_PER_PLAYER,
    id: "payments-limit-four-concealed-pungs-discard-hkos",
    description:
      "The SAME fourteen tiles won on 北's discard of the pair tile, so all four pungs stay concealed and 自摸 never fires: raw 13, landing exactly ON the limit and NOT capped. The chips are the ladder's top row doubled for a discard — 768 out of one seat.",
    ...fourConcealedPungs(),
    flowers: [PLUM],
    selfDraw: false,
    from: 3,
    seatWind: 1,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 13,
    capped: false,
    expected: { faan: 13, awards: ["fourConcealedPungs"], legal: true },
    expectedPayment: { base: 768, deltas: [0, 768, 0, -768], collects: 768 },
    contested:
      "The pair against the self-draw case is the cap test the chips CANNOT see: raw 14 and raw 13 both settle at 13 faan, and even an engine that skipped the cap entirely would land on the same chips, because both shipped schedules clamp their own argument to [0,13]. That clamp is load-bearing rather than defensive — HKOS_BASE_CHIPS has fourteen entries, so an uncapped 14 would index undefined. The order is pinned here for the engine, not because a player could tell.",
  },
  {
    ...LIU_TOTAL,
    id: "payments-limit-four-concealed-pungs-dealer-pays-liu",
    description:
      "LIU variant at a doubling house: the same 四暗刻 taken off the DEALER's discard. The bracket's 316 doubles to 632 out of 東 alone, and the winner collects 632. The largest single transfer in the family, and it comes from the dealer double rather than from the faan.",
    ...fourConcealedPungs(),
    flowers: [PLUM],
    selfDraw: false,
    from: 0,
    seatWind: 1,
    isDealer: false,
    dealerRule: "double",
    rawFaan: 13,
    capped: false,
    expected: { faan: 13, awards: ["fourConcealedPungs"], legal: true },
    expectedPayment: { base: 316, deltas: [-632, 632, 0, 0], collects: 632 },
    contested:
      "Feeding a limit hand is where 包 liability would land in the houses that play it (payment.ts lists LIU's 9- and 12-tile penalties as text the engine reads none of). Under 包 the discarder would carry a self-draw settlement for all three seats rather than a doubled discard. This case is the NON-包 reading; a 包 family is a separate golden family and does not exist yet.",
  },

  /* ── E. the 3-faan floor, from both sides ────────────────────────────────
   * The same fourteen tiles: refused on a discard at 2 faan, taken on a
   * self-draw at exactly 3. Nothing moves on the refusal — not a small amount,
   * not the winner's share, nothing — and the four deltas must be zero rather
   * than merely summing to zero.
   */

  {
    ...HKOS_PER_PLAYER,
    id: "payments-below-floor-all-chows-refused-hkos",
    description:
      "平糊 with 南's own 蘭 — 1 + 1 = 2 faan on 東's discard, below the 3-faan floor, so the win MAY NOT BE TAKEN. The ladder still quotes a price at 2 faan (4 doubled to 8) and not one chip of it changes hands.",
    ...allChowsOwnFlower(1),
    flowers: [ORCHID], // 蘭 is 南's own bonus tile: 正花, 1 faan.
    selfDraw: false,
    from: 0,
    seatWind: 1,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 2,
    capped: false,
    expected: { faan: 2, awards: ["allChows", "ownFlower"], legal: false },
    expectedPayment: { base: 8, deltas: [0, 0, 0, 0], collects: 0 },
  },
  {
    ...LIU_TOTAL,
    id: "payments-below-floor-all-chows-refused-liu",
    description:
      "LIU variant, same fourteen tiles, same 2 faan. LIU's table prints an explicit sub-minimum row at 0 chips, so the two schedules disagree about what a refused hand is worth (8 against 0) and agree completely about what moves: nothing. The printed row is unreachable through a legal win.",
    ...allChowsOwnFlower(1),
    flowers: [ORCHID],
    selfDraw: false,
    from: 0,
    seatWind: 1,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 2,
    capped: false,
    expected: { faan: 2, awards: ["allChows", "ownFlower"], legal: false },
    expectedPayment: { base: 0, deltas: [0, 0, 0, 0], collects: 0 },
  },
  {
    ...HKOS_PER_PLAYER,
    id: "payments-floor-all-chows-self-draw-hkos-per-player",
    description:
      "The SAME fourteen tiles self-drawn instead: 自摸 adds the third faan and the hand is exactly at the floor and legal. One faan is the difference between 0 chips and 24 — the steepest step anywhere in the schedule.",
    ...allChowsOwnFlower(1),
    flowers: [ORCHID],
    selfDraw: true,
    from: null,
    seatWind: 1,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 3,
    capped: false,
    expected: { faan: 3, awards: ["allChows", "ownFlower", "selfDraw"], legal: true },
    expectedPayment: { base: 8, deltas: [-8, 24, -8, -8], collects: 24 },
  },
  {
    ...HKOS_TOTAL,
    id: "payments-floor-all-chows-self-draw-hkos-total",
    description:
      "The floor hand on the total reading: 8 split three ways rounds up to 3 each, so the winner collects 9 against a printed 8. Rounding up can only ever add 1 or 2 chips, so its bite is largest where the figure is smallest — 12.5% here at the floor, 12.5% at 4 faan, and nothing at all at 7 where 48 divides.",
    ...allChowsOwnFlower(1),
    flowers: [ORCHID],
    selfDraw: true,
    from: null,
    seatWind: 1,
    isDealer: false,
    dealerRule: "flat",
    rawFaan: 3,
    capped: false,
    expected: { faan: 3, awards: ["allChows", "ownFlower", "selfDraw"], legal: true },
    expectedPayment: { base: 3, deltas: [-3, 9, -3, -3], collects: 9 },
    contested:
      "Nine chips for a hand the printed table prices at eight. Small in absolute terms and structural: on the total reading the winner is over-paid on every rung of the ladder whose figure is not a multiple of three. A house that cares would round two payers up and the third down, so the pot lands on the printed figure exactly; payment.ts takes the simpler rule and over-collects instead.",
  },
];

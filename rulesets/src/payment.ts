/**
 * Payment tables 銃碼. DESIGN.md §4 — "rulesets are data, not code": the chip
 * schedule is config, and DESIGN.md §4 also flags the self-draw settlement as
 * the thing to settle before scoring ships.
 *
 * Two schedules ship:
 *   HKOS_DOUBLING  — the published Hong Kong Old Style conversion, doubling
 *                    every 2 faan with the odd step interpolated.
 *   LIU_BRACKETS   — the flat four-bracket chip table the Python engine at
 *                    mjrc-admin/research/probability/core/ruleset.py implements
 *                    (92/108 · 124/156 · 188/252 · 316/444).
 *
 * ── The self-draw settlement, and why both readings ship ─────────────────
 *
 * A house table prints one figure in its 自摸 column and does not say what it
 * means (ENGINE-AUDIT §1 flags exactly this for LIU). Two readings are in
 * circulation and both are played:
 *
 *   perPlayer — each of the three losers hands over the printed figure, so the
 *               winner collects three times it. This is the canonical HK
 *               reading: 自摸每家 X.
 *   total     — the printed figure is the winner's whole collection and the
 *               three losers split it.
 *
 * SelfDrawSettlement in engine/src/types.ts names them; every PaymentTable here
 * fixes one, and every golden-hand case has to state which preset it assumes
 * because the answers differ by 3x.
 *
 * Evidence for LIU being `total`: all four printed self-draw figures divide by
 * three exactly (108/156/252/444 -> 36/52/84/148), and the perPlayer reading
 * would make a 3-faan self-draw pay 324 against a 92 discard win — 3.5x, which
 * no table plays. The perPlayer variant still ships for houses that read their
 * own column the other way.
 *
 * Discarder-pays-all 全銃 is the only settlement the PaymentTable contract can
 * express (`onDiscard` returns what the DISCARDER pays and there is no hook for
 * the other two seats). That is the HK default and it is what LIU plays, but a
 * spread / 半銃 table cannot be built here — noted as a contract gap.
 */

import type { PaymentTable, SelfDrawSettlement } from "@mjrc/engine";

/**
 * The published HKOS conversion, indexed by faan 0-13. Doubles every 2 faan
 * and interpolates the odd step at 1.5x, so every faan changes the payout.
 * Source: mahjong.wikidot.com HKOS scoring, cross-checked against the curve
 * registry in mjrc-app/web/src/data/rulesets.ts ("doubling_2fan_smooth").
 */
export const HKOS_BASE_CHIPS: readonly number[] =
  [1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384];

/**
 * A discard win costs the discarder twice the table value; a self-draw costs
 * each of the three losers the table value once. Discard total 2x, self-draw
 * total 3x — the 1.5 ratio the mjrc-app curve registry encodes as its
 * validated 4-units-vs-6-units settlement, at half its unit scale.
 */
export const DISCARD_MULTIPLE = 2;

/** A bracket row: applies when `maxFaan` is the first bound the faan fits under. */
export interface ChipBracket {
  maxFaan: number;
  onDiscard: number;
  /** The 自摸 column exactly as the house prints it. Uninterpreted — see header. */
  selfDrawFigure: number;
}

/**
 * LIU's four brackets, transcribed from LIU_FAN_BRACKETS in
 * mjrc-admin/research/probability/core/ruleset.py. The sub-minimum row is kept
 * so the shape of the printed table survives; it is never reached through a
 * legal win.
 */
export const LIU_BRACKETS: readonly ChipBracket[] = [
  { maxFaan: 2, onDiscard: 0, selfDrawFigure: 0 },
  { maxFaan: 3, onDiscard: 92, selfDrawFigure: 108 },
  { maxFaan: 6, onDiscard: 124, selfDrawFigure: 156 },
  { maxFaan: 9, onDiscard: 188, selfDrawFigure: 252 },
  { maxFaan: 13, onDiscard: 316, selfDrawFigure: 444 },
];

/**
 * A chip schedule is the printed table, before anyone decides what the
 * self-draw column means. `paymentTable` turns one into a PaymentTable by
 * fixing that reading.
 */
export interface ChipSchedule {
  id: string;
  label: string;
  /** Where the numbers came from. Kept in the data so it travels with it. */
  source: string;
  /** Faan range the schedule prices. Outside it the values are clamped. */
  domain: [number, number];
  onDiscard(faan: number): number;
  selfDrawFigure(faan: number): number;
}

const clamp = (faan: number, [lo, hi]: [number, number]): number =>
  faan < lo ? lo : faan > hi ? hi : faan;

/**
 * Chips are physical objects and do not divide, so the `total` reading rounds.
 * Rounding up keeps the winner whole — being short-changed by rounding is the
 * complaint that starts arguments at a real table.
 */
const splitThreeWays = (figure: number): number => Math.ceil(figure / 3);

export const HKOS_DOUBLING: ChipSchedule = {
  id: "hkos-doubling",
  label: "HK Old Style doubling ladder",
  source: "mahjong.wikidot.com HKOS scoring table, faan 0-13",
  domain: [0, 13],
  onDiscard: (faan) => DISCARD_MULTIPLE * HKOS_BASE_CHIPS[clamp(Math.trunc(faan), [0, 13])]!,
  // The published column IS the per-player 自摸 figure, which is why
  // hkos-standard pairs this schedule with the perPlayer settlement.
  selfDrawFigure: (faan) => HKOS_BASE_CHIPS[clamp(Math.trunc(faan), [0, 13])]!,
};

const bracketFor = (faan: number): ChipBracket => {
  const capped = clamp(Math.trunc(faan), [0, 13]);
  for (const row of LIU_BRACKETS) if (capped <= row.maxFaan) return row;
  return LIU_BRACKETS[LIU_BRACKETS.length - 1]!;
};

export const LIU_BRACKET_SCHEDULE: ChipSchedule = {
  id: "liu-brackets",
  label: "LIU flat bracket table",
  source: "mjrc-admin/research/probability/core/ruleset.py LIU_FAN_BRACKETS",
  domain: [3, 13],
  onDiscard: (faan) => bracketFor(faan).onDiscard,
  selfDrawFigure: (faan) => bracketFor(faan).selfDrawFigure,
};

/**
 * TVB Championship 2026 (owner request 2026-08-29; spec from
 * mjrc-app/web/src/data/rulesets.ts "tvb_2026" and the scoring utility's
 * comment: "winner +10×fan on discard, +15×fan self-draw"). LINEAR economy:
 * a 10-faan hand pays exactly 10× a 1-faan hand — the polar opposite of the
 * HK doubling ladder. Chips here are 4× the show's base-2.5 points so every
 * figure is an integer.
 */
export const TVB_LINEAR: ChipSchedule = {
  id: "tvb-linear",
  label: "TVB Championship linear",
  source: "mjrc-app rulesets.ts tvb_2026 / tvb-championship-2026 Appendix I",
  domain: [1, 10],
  onDiscard: (faan) => 10 * clamp(Math.trunc(faan), [1, 10]),
  selfDrawFigure: (faan) => 5 * clamp(Math.trunc(faan), [1, 10]),
};

export const TVB_LINEAR_PER_PLAYER: PaymentTable = paymentTable(TVB_LINEAR, "perPlayer");

export const SCHEDULES: readonly ChipSchedule[] = [HKOS_DOUBLING, LIU_BRACKET_SCHEDULE, TVB_LINEAR];

/** 包 — the documented cases where one seat carries the whole hand. Text only; the engine reads none of it yet. */
const HK_LIABILITY: readonly string[] = [
  "Feeding the third dragon to a hand already showing two dragon pungs (大三元包).",
  "Feeding the fourth wind to a hand already showing three wind pungs (大四喜包).",
  "Discarding into a hand whose exposed melds are already all one suit (清一色包).",
];

const LIU_LIABILITY: readonly string[] = [
  "9-tile and 12-tile 包 penalties, per the family house rules.",
];

/**
 * Fix a reading of the self-draw column and get a PaymentTable.
 * `id` is `<schedule>-<settlement>` so a golden case names the settlement it
 * assumes just by naming the payment table.
 */
export function paymentTable(
  schedule: ChipSchedule,
  selfDraw: SelfDrawSettlement,
  liabilityRules?: readonly string[],
): PaymentTable {
  return {
    id: `${schedule.id}-${selfDraw}`,
    selfDraw,
    onDiscard: (faan) => schedule.onDiscard(faan),
    onSelfDraw: (faan) =>
      selfDraw === "perPlayer"
        ? schedule.selfDrawFigure(faan)
        : splitThreeWays(schedule.selfDrawFigure(faan)),
    ...(liabilityRules ? { liabilityRules: [...liabilityRules] } : {}),
  };
}

/** Canonical HK: the published figure is what EACH loser pays. Winner collects 3x. */
export const HKOS_DOUBLING_PER_PLAYER: PaymentTable =
  paymentTable(HKOS_DOUBLING, "perPlayer", HK_LIABILITY);

/** The same ladder read as a pot to be split three ways. Ships for houses that play it. */
export const HKOS_DOUBLING_TOTAL: PaymentTable =
  paymentTable(HKOS_DOUBLING, "total", HK_LIABILITY);

/** LIU as the evidence reads it — the printed figure is the pot (see header). */
export const LIU_BRACKET_TOTAL: PaymentTable =
  paymentTable(LIU_BRACKET_SCHEDULE, "total", LIU_LIABILITY);

/** LIU read the other way, for a table that quotes its 自摸 column per player. */
export const LIU_BRACKET_PER_PLAYER: PaymentTable =
  paymentTable(LIU_BRACKET_SCHEDULE, "perPlayer", LIU_LIABILITY);

export const PAYMENT_TABLES: readonly PaymentTable[] = [
  HKOS_DOUBLING_PER_PLAYER,
  HKOS_DOUBLING_TOTAL,
  LIU_BRACKET_TOTAL,
  LIU_BRACKET_PER_PLAYER,
];

export const paymentTableById = (id: string): PaymentTable | undefined =>
  PAYMENT_TABLES.find((t) => t.id === id);

/** What the winner collects in total — the number a scoreboard shows. */
export const winnerCollects = (t: PaymentTable, faan: number, selfDraw: boolean): number =>
  selfDraw ? 3 * t.onSelfDraw(faan) : t.onDiscard(faan);

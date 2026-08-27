/**
 * Assembled Ruleset presets. DESIGN.md §4: P0 ships canonical HK Old Style,
 * and "the implemented LIU closed-hand variant is a different game — it
 * survives as a config preset for private tables". Both live here as data.
 *
 * A faanTable is BOTH the price list and the enable list: a pattern absent
 * from it is a pattern this house does not play, and patterns.ts refuses to
 * let an absent pattern subsume a present one.
 *
 * ── provenance, column by column ─────────────────────────────────────────
 *
 * hk-scoring.ts (mjrc-app, owned by another team — read, never imported)
 * carries the same faan table across six systems with the conflicts recorded.
 * Each preset here takes ONE of those columns whole rather than picking a
 * favourite value per row, because a table assembled from six sources is a
 * table no house plays:
 *
 *   hkos-standard  the "Wikipedia" column — the only column with a value for
 *                  every classic pattern. Where it reads "—" the pattern is
 *                  left out rather than filled in from a neighbour. It has
 *                  exactly ONE named departure, 四暗刻, marked at its line.
 *   liu            the "LIU" column, cross-checked row by row against
 *                  PATTERN_FAN in mjrc-admin/research/probability/core/
 *                  scoring.py. The two agree on every one of the sixteen
 *                  patterns the Python engine implements, which is what makes
 *                  the column safe to use for the patterns it does not.
 *
 * Award ids follow the convention engine/test/golden/kongs.ts establishes:
 * one id per pattern regardless of set size, so a kong of dragons and a pung
 * of dragons both emit "dragonPung".
 */

import type { Ruleset } from "@mjrc/engine";
import { isPattern, pattern } from "./patterns.js";
import { HKOS_DOUBLING_PER_PLAYER, LIU_BRACKET_TOTAL } from "./payment.js";

/**
 * Canonical HK Old Style. 3-faan minimum, 13-faan limit 爆棚, flowers with
 * replacement draws, seat and round wind faan, all three kong forms.
 *
 * Several limit hands sit below 13 in this column and only reach the cap once
 * their additive components are counted — 字一色 at 10 plus 對對糊's 3 is
 * exactly 13. That is the column working as designed, not a transcription slip.
 */
export const HKOS_STANDARD: Ruleset = {
  id: "hkos-standard",
  label: "香港舊章 Hong Kong Old Style",
  minimumFaan: 3,
  limitFaan: 13,
  useFlowers: true,
  payment: HKOS_DOUBLING_PER_PLAYER,
  faanTable: {
    // honour melds — a kong of the same honour is worth what the pung is worth
    dragonPung: 1,
    seatWind: 1,
    roundWind: 1,

    // bonus tiles 花
    ownFlower: 1,
    ownSeason: 1,
    allFlowers: 2,
    allSeasons: 2,
    noFlowers: 1,

    // winning conditions
    selfDraw: 1,
    concealedHand: 1,
    winOnLastTile: 1,
    winOnLastDiscard: 1,
    robbingKong: 1,
    winOnKongReplacement: 1,
    winByDoubleKong: 8,

    // hand patterns
    allChows: 1,
    allPungs: 3,
    halfFlush: 3,
    fullFlush: 6,
    mixedTerminals: 1,
    smallThreeDragons: 5,
    bigThreeDragons: 8,
    smallFourWinds: 6,
    bigFourWinds: 10,

    // limit hands 爆棚
    // The one departure from the column, which renders this 10. Four of the six
    // surveyed systems star 四暗刻 as a limit hand rather than pricing it, and
    // the golden suite fixes it at the limit (engine/test/golden/kongs.ts calls
    // its two cases uncontested at 13, where a 10 would land on 11 and 12).
    // 十八羅漢 below stays at 10: that one the systems genuinely split on,
    // 7 · 7 · 10 · limit, so the column's answer stands.
    fourConcealedPungs: 13,
    allHonours: 10,
    // 7 is the column's own value and it is an OUTLIER — four of the six systems
    // star 清么九 as a limit hand. Kept because the golden flush family pins it
    // at 7 (its two cases total 8) while the limit family declares 10, and the
    // suite cannot be satisfied both ways. Open question, not a decision.
    allTerminals: 7,
    // Second named departure. The column prices 九蓮寶燈 4 and adds 清一色's 6
    // on top for 10 effective; the other four systems pay a flat limit, and the
    // golden limit family needs 13 (a 4 would land its cases on 6 and 8).
    // patterns.ts subsumes 清一色 to match the flat reading.
    nineGates: 13,
    thirteenOrphans: 13,
    allKongs: 10,
    heavenlyHand: 13,
    earthlyHand: 13,

    // Absent on purpose:
    //   sevenPairs 七對子 — not classic HK Old Style.
    //   jadeDragon / rubyDragon / pearlDragon — the column reads "—". MJ Time
    //     and MJB pay them as limit hands, so a house that plays them should
    //     add them rather than have a value invented here.
  },
};

/**
 * The LIU family variant. DESIGN.md §4 keeps it as a config preset for private
 * tables; ENGINE-AUDIT §1 records that its faan values are genuinely
 * non-standard — 大三元 6 where canonical pays 8, 小四喜 10, and 七對子 scored
 * at all, which classic HK Old Style does not do.
 *
 * Flowers are ON here even though ruleset.py sets `use_flowers = False`. That
 * flag sits under a comment reading "Tile features (off by default in MJRC
 * v0)" — it records what the Python engine had implemented, not how the LIU
 * family plays, and the LIU column of hk-scoring.ts prices every bonus tile.
 */
export const LIU: Ruleset = {
  id: "liu",
  label: "LIU 家法 house variant",
  minimumFaan: 3,
  limitFaan: 13,
  useFlowers: true,
  payment: LIU_BRACKET_TOTAL,
  faanTable: {
    dragonPung: 1,
    seatWind: 1,
    roundWind: 1,

    ownFlower: 1,
    ownSeason: 1,
    allFlowers: 2,
    allSeasons: 2,
    noFlowers: 1,

    selfDraw: 1,
    concealedHand: 1,
    winOnLastTile: 1,
    winOnLastDiscard: 1,
    robbingKong: 1,
    winOnKongReplacement: 1,

    allChows: 1,
    allPungs: 3,
    halfFlush: 3,
    fullFlush: 7,
    mixedTerminals: 1,
    sevenPairs: 4,
    smallThreeDragons: 4,
    bigThreeDragons: 6,
    smallFourWinds: 10,
    bigFourWinds: 13,

    fourConcealedPungs: 13,
    allHonours: 13,
    allTerminals: 13,
    nineGates: 13,
    thirteenOrphans: 13,
    allKongs: 7,
    heavenlyHand: 13,
    earthlyHand: 13,

    // Absent because the LIU column reads "—": winByDoubleKong 槓上槓 and the
    // three suit-dragon hands.
  },
};

export const RULESETS: readonly Ruleset[] = [HKOS_STANDARD, LIU];

export const DEFAULT_RULESET_ID = HKOS_STANDARD.id;

export const ruleset = (id: string): Ruleset | undefined =>
  RULESETS.find((r) => r.id === id);

/** Ids this ruleset plays. patterns.ts needs this to stop a disabled pattern subsuming an enabled one. */
export const enabledPatterns = (r: Ruleset): ReadonlySet<string> =>
  new Set(Object.keys(r.faanTable));

/**
 * Every faanTable key has to be a real pattern id — a typo would silently
 * price nothing at all. Called by the test suite; cheap enough to call at
 * startup if a future preset ever loads from disk.
 */
export function assertRulesetSound(r: Ruleset): void {
  for (const id of Object.keys(r.faanTable)) {
    if (!isPattern(id)) throw new Error(`${r.id}: "${id}" is not in the pattern catalogue`);
    const faan = r.faanTable[id]!;
    if (!Number.isInteger(faan) || faan < 0) {
      throw new Error(`${r.id}: ${id} has a bad faan value ${faan}`);
    }
    if (!r.useFlowers && pattern(id).family === "bonusTile") {
      throw new Error(`${r.id}: prices ${id} but plays without flowers`);
    }
  }
  if (r.minimumFaan < 0 || r.minimumFaan > r.limitFaan) {
    throw new Error(`${r.id}: minimumFaan ${r.minimumFaan} does not fit under limitFaan ${r.limitFaan}`);
  }
}

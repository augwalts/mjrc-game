/**
 * 計番 — scoring a completed hand. DESIGN.md §4 (canonical HK Old Style:
 * 3-faan minimum, 13-faan limit 爆棚, seat and round wind faan, bonus tiles,
 * rulesets-as-data) and §5.1, which names the hard part outright: "exposed-meld
 * scoring decomposition (scoring.py's DFS assumes a concealed 14-tile hand —
 * fixed melds change the algorithm, not just the faan table)".
 *
 * The algorithm, in four steps:
 *
 *  1. decompose.ts hands back EVERY valid reading of the hand, melds fixed in
 *     place. Patterns that depend on the SHAPE are detected once per reading.
 *  2. Patterns that do not depend on the shape — situational faan from the win
 *     context, bonus tiles, 十三么 and 九蓮寶燈 — are detected once and merged
 *     into every reading.
 *  3. Each merged list goes through `applySubsumption` (rulesets/src/patterns.ts)
 *     so a hand never pays twice for the same tiles, then through the ruleset's
 *     faanTable, which is both the price list and the enable list.
 *  4. The best-paying reading wins. Ties break DETERMINISTICALLY on
 *     `decompositionKey`. ENGINE-AUDIT §1 flags the Python engine for resolving
 *     equal-faan ties arbitrarily; this is where that defect is fixed.
 *
 * BOTH totals are reported. ENGINE-AUDIT §1 records a display bug where the
 * breakdown summed uncapped while the total was capped, so `rawFaan` is the sum
 * of `awards` exactly, `faan` is that clamped to `ruleset.limitFaan`, and
 * `capped` says which of the two the player is being paid.
 *
 * Determinism: no Math.random, no Date.now, no iteration over unordered object
 * keys. Every loop here walks an array in a fixed order (DESIGN.md §5.5 —
 * replay is re-execution).
 *
 * Terminology: ../../TERMINOLOGY.md. HK Old Style only.
 */
import { applySubsumption, pattern } from "@mjrc/rulesets";
import {
  concealedTripletCount,
  decomposeWin,
  decompositionKey,
  isThirteenOrphansShape,
  type DecomposedSet,
  type Decomposition,
} from "./decompose.js";
import { isConcealedSet } from "./melds.js";
import {
  counts,
  flowerSeat,
  isDragon,
  isHonour,
  isSuited,
  isTerminalOrHonour,
  isWind,
  suitOf,
} from "./tiles.js";
import {
  FLOWERS_START,
  WINDS_START,
  type FaanAward,
  type Meld,
  type Ruleset,
  type ScoreResult,
  type TileId,
  type WinContext,
} from "./types.js";

/**
 * `WinContext` (types.ts, the frozen contract) cannot express four things the
 * faan table prices, so they are carried as optional extensions here rather
 * than by editing the contract. A plain `WinContext` is assignable to this, so
 * the published signature still holds for every caller.
 *
 *   heavenly       天糊 — the dealer's dealt fourteen were already complete
 *   earthly        地糊 — a non-dealer won on the dealer's opening discard
 *   onLastDiscard  河底撈魚 — won on the hand's very last DISCARD, the twin of
 *                  海底撈月 (`onLastTile`, the last DRAW). No hand earns both.
 *   doubleKong     槓上槓 — a kong replacement made a second kong and THAT
 *                  replacement won
 *
 * Each is a fact only the state machine knows; none is derivable from tiles.
 */
export interface WinSituation extends WinContext {
  /** 天糊 — dealer's opening fourteen already complete. */
  heavenly?: boolean;
  /** 地糊 — non-dealer wins on the dealer's opening discard. */
  earthly?: boolean;
  /** 河底撈魚 — won on the hand's final discard. */
  onLastDiscard?: boolean;
  /** 槓上槓 — the replacement for a kong made another kong, whose replacement won. */
  doubleKong?: boolean;
}

/** 春夏秋冬 begin four past 梅蘭菊竹 in the flat tile space. */
const SEASONS_START = FLOWERS_START + 4;
const FLOWER_SET: readonly TileId[] = [FLOWERS_START, FLOWERS_START + 1, FLOWERS_START + 2, FLOWERS_START + 3];
const SEASON_SET: readonly TileId[] = [SEASONS_START, SEASONS_START + 1, SEASONS_START + 2, SEASONS_START + 3];

const isTripletSet = (s: DecomposedSet): boolean => s.kind === "pung" || s.kind === "kong";

/** Every tile this reading puts on the table, kongs at their true four. */
const readingTiles = (d: Decomposition): TileId[] => [
  ...d.pair.tiles,
  ...d.sets.flatMap((s) => s.tiles),
];

/* ── shape-dependent patterns ──────────────────────────────────────────────
 * Detected once per reading, because the reading is what decides them: the
 * same fourteen tiles can be 對對糊 under one parse and 平糊 under another. */

function readingPatterns(d: Decomposition, ctx: WinSituation): string[] {
  const ids: string[] = [];
  const tiles = readingTiles(d);
  const triplets = d.sets.filter(isTripletSet);
  const chows = d.sets.filter((s) => s.kind === "chow");
  const suits = new Set(tiles.filter(isSuited).map(suitOf));
  const anyHonour = tiles.some(isHonour);
  const pairTile = d.pair.tiles[0]!;

  // 三元牌 / 門風 / 圈風 — one award per set, multiplicity preserved. A kong of
  // an honour is worth exactly what the pung is worth, so both emit the same id.
  for (const s of triplets) {
    const t = s.tiles[0]!;
    if (isDragon(t)) ids.push("dragonPung");
    else if (isWind(t)) {
      const wind = t - WINDS_START;
      if (wind === ctx.seatWind) ids.push("seatWind");
      if (wind === ctx.roundWind) ids.push("roundWind");
    }
  }

  // 小三元 / 大三元 · 小四喜 / 大四喜. The "small" forms want the pair to be the
  // missing honour; subsumption (patterns.ts) settles what each swallows.
  const dragonSets = triplets.filter((s) => isDragon(s.tiles[0]!)).length;
  if (dragonSets === 3) ids.push("bigThreeDragons");
  else if (dragonSets === 2 && isDragon(pairTile)) ids.push("smallThreeDragons");

  const windSets = triplets.filter((s) => isWind(s.tiles[0]!)).length;
  if (windSets === 4) ids.push("bigFourWinds");
  else if (windSets === 3 && isWind(pairTile)) ids.push("smallFourWinds");

  // 平糊 / 對對糊 / 十八羅漢. 平糊 survives melding — it is a shape, not a
  // concealment condition.
  if (chows.length === 4) ids.push("allChows");
  if (triplets.length === 4) ids.push("allPungs");
  if (d.sets.length === 4 && d.sets.every((s) => s.kind === "kong")) ids.push("allKongs");

  // 四暗刻. A triplet the winning DISCARD completed is not concealed, which is
  // the whole reason concealedTripletCount needs to know how the win arrived.
  if (concealedTripletCount(d, !ctx.selfDraw) === 4) ids.push("fourConcealedPungs");

  // 清一色 / 混一色 / 字一色 — one suit, one suit plus honours, or no suit at all.
  if (suits.size === 0) ids.push("allHonours");
  else if (suits.size === 1) ids.push(anyHonour ? "halfFlush" : "fullFlush");

  // 混么九 / 清么九 — every set a triplet of terminals or honours. The two are
  // exclusive by construction: 混么九 needs an honour, 清么九 forbids one.
  if (triplets.length === 4 && tiles.every(isTerminalOrHonour) && suits.size > 0) {
    ids.push(anyHonour ? "mixedTerminals" : "allTerminals");
  }

  return ids;
}

/* ── shape-independent patterns ────────────────────────────────────────────
 * The win context, the bonus tiles, and the two limit hands that have no
 * four-sets-and-a-pair reading at all. */

/**
 * 十三么 — all thirteen 么九 kinds, one of them paired, nothing melded. The
 * predicate lives in decompose.ts beside `hasWinningShape`, which needs the
 * same test to OFFER the win, so the offer and the award cannot drift.
 */
const isThirteenOrphans = isThirteenOrphansShape;

/**
 * 九蓮寶燈 — 1112345678999 of one suit plus any tile of that suit, held
 * concealed. Checked on the tiles rather than on a reading, because the
 * pattern is the multiset and not the parse.
 */
function isNineGates(concealed: readonly TileId[], melds: readonly Meld[], winningTile: TileId): boolean {
  if (melds.length > 0 || concealed.length !== 13) return false;
  const tiles = [...concealed, winningTile];
  if (!tiles.every(isSuited)) return false;
  if (new Set(tiles.map(suitOf)).size !== 1) return false;
  const base = Math.floor(tiles[0]! / 9) * 9;
  const c = counts(tiles);
  if (c[base]! < 3 || c[base + 8]! < 3) return false;
  for (let r = 1; r <= 7; r++) if (c[base + r]! < 1) return false;
  return true;
}

function situationalPatterns(ctx: WinSituation, melds: readonly Meld[]): string[] {
  const ids: string[] = [];
  if (ctx.selfDraw) ids.push("selfDraw");
  // 門前清 asks whether anything was CLAIMED, not how the last tile arrived: a
  // 暗槓 keeps the hand concealed, winning on a discard does not spoil it.
  if (melds.every(isConcealedSet)) ids.push("concealedHand");
  if (ctx.robbedKong) ids.push("robbingKong");
  if (ctx.doubleKong) ids.push("winByDoubleKong");
  else if (ctx.onKongReplacement) ids.push("winOnKongReplacement");
  // 海底撈月 is the last DRAW, 河底撈魚 the last DISCARD. Never both.
  if (ctx.onLastTile) ids.push("winOnLastTile");
  else if (ctx.onLastDiscard) ids.push("winOnLastDiscard");
  // 天糊 belongs to 莊 alone; 地糊 is a discard, so never a self-draw.
  if (ctx.heavenly && ctx.isDealer) ids.push("heavenlyHand");
  if (ctx.earthly && !ctx.isDealer && !ctx.selfDraw) ids.push("earthlyHand");
  return ids;
}

/**
 * 花 bonus tiles. Only the seat's OWN flower and OWN season pay; another
 * seat's bonus tile is worth nothing and still denies 無花. A complete set of
 * four pays 一台花 on top of the own tile inside it — patterns.ts is explicit
 * that allFlowers does not subsume ownFlower, because 1 + 2 = 3 is the total
 * HK tables quote.
 */
function bonusPatterns(flowers: readonly TileId[], ctx: WinSituation, ruleset: Ruleset): string[] {
  if (!ruleset.useFlowers) return [];
  const ids: string[] = [];
  if (flowers.length === 0) return ["noFlowers"];
  for (const f of flowers) {
    if (flowerSeat(f) !== ctx.seatWind) continue;
    ids.push(f < SEASONS_START ? "ownFlower" : "ownSeason");
  }
  if (FLOWER_SET.every((f) => flowers.includes(f))) ids.push("allFlowers");
  if (SEASON_SET.every((f) => flowers.includes(f))) ids.push("allSeasons");
  return ids;
}

/* ── pricing ───────────────────────────────────────────────────────────────*/

interface Priced {
  awards: FaanAward[];
  rawFaan: number;
}

/**
 * Turn a detected id list into a priced breakdown.
 *
 * Order of operations matters and is not interchangeable:
 *   a. 門前清 is dropped when the hand holds a pattern that is concealed BY
 *      DEFINITION. patterns.ts marks those `concealedOnly` and records the
 *      sourced ruling (hk-scoring.ts) that such a hand must not also collect
 *      the faan; it declines to encode it as subsumption only so that a house
 *      which does not play the limit hand keeps paying 門前清, which is exactly
 *      what gating on `enabled` preserves here.
 *   b. subsumption, restricted to patterns this house plays — a pattern the
 *      ruleset does not price must never suppress one it does.
 *   c. pricing. Ids with no entry in the faanTable are patterns this house does
 *      not play, so they leave the breakdown entirely rather than showing as 0.
 */
function price(ids: readonly string[], ruleset: Ruleset): Priced {
  const enabled = new Set(Object.keys(ruleset.faanTable));
  const concealedByDefinition = ids.some((id) => enabled.has(id) && pattern(id).concealedOnly === true);
  const kept = concealedByDefinition ? ids.filter((id) => id !== "concealedHand") : [...ids];

  const awards: FaanAward[] = [];
  let rawFaan = 0;
  for (const id of applySubsumption(kept, enabled)) {
    const faan = ruleset.faanTable[id];
    if (faan === undefined) continue;
    const subsumes = pattern(id).subsumes;
    awards.push(subsumes.length > 0 ? { id, faan, subsumes: [...subsumes] } : { id, faan });
    rawFaan += faan;
  }
  return { awards, rawFaan };
}

const settle = (p: Priced, ruleset: Ruleset): ScoreResult => {
  const faan = Math.min(p.rawFaan, ruleset.limitFaan);
  return {
    faan,
    rawFaan: p.rawFaan,
    capped: p.rawFaan > ruleset.limitFaan,
    awards: p.awards,
    legal: faan >= ruleset.minimumFaan,
  };
};

/* ── the entry point ───────────────────────────────────────────────────────*/

/**
 * Score a completed hand.
 *
 * @param concealed   tiles still in hand, EXCLUDING the winning tile
 * @param melds       declared melds, fixed and never re-read
 * @param flowers     revealed bonus tiles 花
 * @param winningTile the tile that completed the hand
 * @param ctx         how the win arrived; a plain WinContext is accepted
 * @param ruleset     the house's price list, which is also its enable list
 * @throws when the input cannot be a hand at all — see decomposeWin
 */
export function score(
  concealed: TileId[],
  melds: Meld[],
  flowers: TileId[],
  winningTile: TileId,
  ctx: WinSituation,
  ruleset: Ruleset,
): ScoreResult {
  const shared = [
    ...situationalPatterns(ctx, melds),
    ...bonusPatterns(flowers, ctx, ruleset),
  ];

  // 十三么 has no four-sets-and-a-pair reading, so it never reaches the loop
  // below — decomposeWin correctly returns nothing for it.
  if (isThirteenOrphans(concealed, melds, winningTile)) {
    return settle(price(["thirteenOrphans", ...shared], ruleset), ruleset);
  }

  const special = isNineGates(concealed, melds, winningTile) ? ["nineGates"] : [];
  const readings = decomposeWin(concealed, melds, winningTile);
  if (readings.length === 0) {
    return { faan: 0, rawFaan: 0, capped: false, awards: [], legal: false };
  }

  // Score every reading, then take the best. Ties break on decompositionKey so
  // the same hand always produces the same breakdown, run after run and machine
  // after machine — ENGINE-AUDIT §1's "equal-faan ties resolved arbitrarily".
  let bestResult: ScoreResult | null = null;
  let bestKey = "";
  for (const d of readings) {
    const result = settle(price([...readingPatterns(d, ctx), ...special, ...shared], ruleset), ruleset);
    const key = decompositionKey(d);
    if (
      bestResult === null ||
      result.faan > bestResult.faan ||
      (result.faan === bestResult.faan && result.rawFaan > bestResult.rawFaan) ||
      (result.faan === bestResult.faan && result.rawFaan === bestResult.rawFaan && key < bestKey)
    ) {
      bestResult = result;
      bestKey = key;
    }
  }
  return bestResult!;
}

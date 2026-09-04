/**
 * 計番 — an INDEPENDENT second implementation of Hong Kong Old Style scoring,
 * written only to be differentially tested against engine/src/scoring.ts.
 *
 * DESIGN.md §4 says the canonical faan table is the part that "destroys
 * credibility instantly" if it is wrong, and §8 makes the golden-hand suite the
 * P0 exit requirement. A single scorer checked against fixtures its own authors
 * wrote is weakly verified: the same misreading of a rule lands in both. Two
 * implementations that agree is real evidence; where they disagree exactly one
 * of them is broken and the disagreement is the finding.
 *
 * So this file deliberately shares NOTHING with the production scorer except
 * the rules themselves and the pattern catalogue's published faan values:
 *
 *   - it does not call decomposeWin. It enumerates every partition of the
 *     concealed tiles into sets and a pair from scratch (`enumerateSets`).
 *   - it does not call applySubsumption. Subsumption is a hand-written table
 *     of explicit cases at SUBSUMES below, transcribed from the `subsumes`
 *     fields in rulesets/src/patterns.ts, which is DATA, not an algorithm.
 *   - it does not import tiles.ts. The handful of one-line tile classifiers it
 *     needs are rewritten here so a reader can check the whole thing without
 *     leaving the file.
 *
 * It is slow — every partition, times every place the winning tile could have
 * landed, times every pattern check written out longhand. That is the trade
 * being made on purpose. Readability over cleverness, everywhere.
 *
 * WHAT IT REPORTS. Because a hand can read several ways, `optimalAwards` holds
 * every distinct award list that reaches the best-paying total, not just one.
 * The production scorer breaks such ties on its own decomposition key; a
 * differential test that demanded the same tie-break would report noise rather
 * than defects, so the contract is "the engine's award list must be one of the
 * optimal ones" while faan and legality are compared exactly.
 *
 * Terminology: ../../TERMINOLOGY.md. Hong Kong Old Style only.
 */
import type { Meld, Ruleset, TileId, WindIndex } from "../src/types.js";
import type { WinSituation } from "../src/scoring.js";

/* ── tile space, restated from types.ts so this file stands alone ─────────
 * 0-8 萬 · 9-17 索 · 18-26 筒 · 27-30 東南西北 · 31-33 中發白
 * 34-37 梅蘭菊竹 · 38-41 春夏秋冬                                          */
const KINDS = 34;
const WINDS_FROM = 27;
const DRAGONS_FROM = 31;
const FLOWERS_FROM = 34;
const SEASONS_FROM = 38;

const isSuited = (t: TileId): boolean => t >= 0 && t < WINDS_FROM;
const isWind = (t: TileId): boolean => t >= WINDS_FROM && t < DRAGONS_FROM;
const isDragon = (t: TileId): boolean => t >= DRAGONS_FROM && t < FLOWERS_FROM;
const isHonour = (t: TileId): boolean => isWind(t) || isDragon(t);
/** Rank 0-8 inside a suit; -1 for anything that has no rank. */
const rank = (t: TileId): number => (isSuited(t) ? t % 9 : -1);
/** 么九 in the narrow sense: a 1 or a 9 of a suit, honours excluded. */
const isSuitedTerminal = (t: TileId): boolean => isSuited(t) && (rank(t) === 0 || rank(t) === 8);
/** 么九 in the wide sense: terminals and honours together. */
const isTerminalOrHonour = (t: TileId): boolean => isHonour(t) || isSuitedTerminal(t);
/** Which of 萬索筒 a tile belongs to, or -1 for an honour. */
const suitIndex = (t: TileId): number => (isSuited(t) ? Math.floor(t / 9) : -1);
/** 梅 and 春 belong to 東, 蘭 and 夏 to 南, and so on round the table. */
const bonusTileSeat = (t: TileId): number => (t - FLOWERS_FROM) % 4;

/* ── the reading of a hand ─────────────────────────────────────────────── */

/** One of the four sets, or the eyes 眼. Kongs still fill exactly one set slot. */
interface Group {
  shape: "chow" | "pung" | "kong" | "pair";
  /** The repeated tile, or the lowest tile of a run. */
  base: TileId;
  /** Every physical tile in the group — four for a kong. */
  tiles: TileId[];
  /**
   * Nobody else's tile is in this group. A declared meld qualifies only when it
   * is a 暗槓; a group read out of hand qualifies unless the winning tile
   * completed it AND that tile came off a discard.
   */
  concealed: boolean;
}

/** Four sets and the eyes — one complete way of reading the fourteen tiles. */
interface Reading {
  sets: Group[];
  pair: Group;
}

/* ── partition enumeration, from scratch ───────────────────────────────── */

const countsOf = (tiles: readonly TileId[]): number[] => {
  const c = new Array<number>(KINDS).fill(0);
  for (const t of tiles) if (t >= 0 && t < KINDS) c[t] += 1;
  return c;
};

/**
 * Every way of emptying `c` into exactly `need` sets, each a triplet or a run.
 *
 * The whole argument for completeness is one sentence: the LOWEST tile still
 * unassigned has to be in some set, and inside that set it is either the
 * triplet's tile or the bottom of the run — nothing below it survives to make
 * it the middle or the top. So branching on those two possibilities at the
 * lowest tile, and recursing, reaches every partition exactly once.
 */
function enumerateSets(c: number[], need: number): TileId[][][] {
  let low = -1;
  for (let i = 0; i < KINDS; i += 1) {
    if (c[i] > 0) {
      low = i;
      break;
    }
  }
  if (need === 0) return low < 0 ? [[]] : [];
  if (low < 0) return [];

  const out: TileId[][][] = [];

  // (a) the lowest tile is a triplet 刻子.
  if (c[low] >= 3) {
    c[low] -= 3;
    for (const rest of enumerateSets(c, need - 1)) out.push([[low, low, low], ...rest]);
    c[low] += 3;
  }

  // (b) the lowest tile is the bottom of a run 順子. Honours never run, and a
  //     run may not cross a suit boundary, so the rank has to leave room.
  if (isSuited(low) && rank(low) <= 6 && c[low + 1] > 0 && c[low + 2] > 0) {
    c[low] -= 1;
    c[low + 1] -= 1;
    c[low + 2] -= 1;
    for (const rest of enumerateSets(c, need - 1)) out.push([[low, low + 1, low + 2], ...rest]);
    c[low] += 1;
    c[low + 1] += 1;
    c[low + 2] += 1;
  }

  return out;
}

/** Every way of reading `tiles` as `need` sets plus one pair. */
function enumeratePartitions(
  tiles: readonly TileId[],
  need: number,
): { sets: TileId[][]; pair: TileId }[] {
  const c = countsOf(tiles);
  const out: { sets: TileId[][]; pair: TileId }[] = [];
  for (let p = 0; p < KINDS; p += 1) {
    if (c[p] < 2) continue;
    c[p] -= 2;
    for (const sets of enumerateSets(c, need)) out.push({ sets, pair: p });
    c[p] += 2;
  }
  return out;
}

/* ── the pattern catalogue's faan-neutral facts ────────────────────────────
 * Values live in the Ruleset (rulesets/src/presets.ts). Subsumption is the
 * `subsumes` field of rulesets/src/patterns.ts, transcribed by hand rather
 * than imported, and applied by hand at `dropSubsumed`. Only DIRECT edges are
 * listed, exactly as the catalogue lists them; the walk below takes the
 * closure itself.                                                           */
const SUBSUMES: Readonly<Record<string, readonly string[]>> = {
  fullFlush: ["halfFlush"],
  sevenPairs: ["concealedHand"],
  smallThreeDragons: ["dragonPung"],
  bigThreeDragons: ["smallThreeDragons", "dragonPung"],
  // Owner rulings 2026-08-26, mirrored from patterns.ts:
  //   wind faan never stack on a Four Winds hand;
  //   a shape that is all pungs BY DEFINITION (字一色, 清么九) has 對對糊 inside it.
  smallFourWinds: ["seatWind", "roundWind"],
  bigFourWinds: ["smallFourWinds", "seatWind", "roundWind"],
  winByDoubleKong: ["winOnKongReplacement"],
  fourConcealedPungs: ["allPungs", "concealedHand"],
  allHonours: ["halfFlush", "mixedTerminals", "allPungs"],
  allTerminals: ["mixedTerminals", "allPungs"],
  nineGates: ["fullFlush"],
  allKongs: ["allPungs"],
  // Absent on purpose, and each absence is a transcription of the catalogue,
  // not an omission:
  //   allChows · halfFlush · mixedTerminals · thirteenOrphans · heavenlyHand ·
  //   earthlyHand — patterns.ts gives them `subsumes: []`.
  //     (小四喜 was in this list until the 2026-08-26 ruling settled it: wind
  //     faan never stack on a Four Winds hand, so it now subsumes above.)
  //   jadeDragon · rubyDragon · pearlDragon — the catalogue gives them real
  //     subsumption, but neither shipping preset prices them, so this file has
  //     no detector for them and an absent detector cannot subsume anything.
};

/**
 * Drop every id a SURVIVING, ENABLED pattern already pays for.
 *
 * Two things this must not get wrong, both of them from the catalogue header:
 *   - multiplicity survives. Three dragon pungs are three awards, so this
 *     filters the list rather than deduplicating it.
 *   - only a pattern the house actually PLAYS may subsume. A table with no
 *     綠一色 row must not have 綠一色 eat the flush on its way to being worth
 *     nothing, so an id absent from the faan table cannot suppress anything.
 */
function dropSubsumed(ids: readonly string[], ruleset: Ruleset): string[] {
  const eaten = new Set<string>();
  const queue: string[] = [];
  for (const id of ids) {
    if (Object.prototype.hasOwnProperty.call(ruleset.faanTable, id)) queue.push(id);
  }
  while (queue.length > 0) {
    const next = queue.pop()!;
    for (const child of SUBSUMES[next] ?? []) {
      if (eaten.has(child)) continue;
      eaten.add(child);
      queue.push(child);
    }
  }
  // A pattern never eats itself: 大三元 lists dragonPung, and 大三元 stays.
  const out: string[] = [];
  for (const id of ids) {
    if (eaten.has(id)) continue;
    out.push(id);
  }
  return out;
}

/* ── pattern detection, longhand ───────────────────────────────────────── */

const isTripletLike = (g: Group): boolean => g.shape === "pung" || g.shape === "kong";

/**
 * Patterns that depend on HOW the fourteen tiles are read — which groups are
 * sets, which tile is the pair, which sets stayed concealed. Everything here is
 * checked against the reading it is handed and nothing else.
 */
function shapePatterns(r: Reading, seatWind: WindIndex, roundWind: WindIndex): string[] {
  const out: string[] = [];
  const sets = r.sets;

  // 三元牌 — a pung or kong of 中, 發 or 白 is 1 faan, once per dragon. Honours
  // never form runs, so a triplet is the only shape a dragon can score in.
  for (const g of sets) if (isTripletLike(g) && isDragon(g.base)) out.push("dragonPung");

  // 門風 seat wind and 圈風 round wind are SEPARATE awards that happen to
  // attach to the same tile when a seat sits in its own round, so East in the
  // East round collects both off one 東 pung. A PAIR of a scoring wind pays
  // nothing — only a set does.
  for (const g of sets) {
    if (!isTripletLike(g) || !isWind(g.base)) continue;
    if (g.base === WINDS_FROM + seatWind) out.push("seatWind");
    if (g.base === WINDS_FROM + roundWind) out.push("roundWind");
  }

  // 平糊 — four runs. The eyes may be anything, including an honour pair: the
  // house rule that bars honour eyes is not modelled (patterns.ts).
  if (sets.every((g) => g.shape === "chow")) out.push("allChows");

  // 對對糊 — four triplets. A kong counts as one of them; it is the fourth tile
  // of a triplet, not a fifth kind of set.
  if (sets.every(isTripletLike)) out.push("allPungs");

  // 十八羅漢 — all four sets declared as kongs, eighteen tiles on the table.
  if (sets.every((g) => g.shape === "kong")) out.push("allKongs");

  // 四暗刻 — four triplets that nobody else contributed a tile to. A 暗槓
  // counts; a triplet the winning DISCARD completed does not, which is why
  // `concealed` is decided per group before this runs.
  if (sets.every((g) => isTripletLike(g) && g.concealed)) out.push("fourConcealedPungs");

  // 小三元 / 大三元 — the three dragons, either all three as sets, or two sets
  // and the eyes as the third.
  const dragonSets = sets.filter((g) => isTripletLike(g) && isDragon(g.base)).length;
  if (dragonSets === 3) out.push("bigThreeDragons");
  else if (dragonSets === 2 && isDragon(r.pair.base)) out.push("smallThreeDragons");

  // 小四喜 / 大四喜 — the same arithmetic over 東南西北.
  const windSets = sets.filter((g) => isTripletLike(g) && isWind(g.base)).length;
  if (windSets === 4) out.push("bigFourWinds");
  else if (windSets === 3 && isWind(r.pair.base)) out.push("smallFourWinds");

  // 混么九 — every tile a terminal or an honour, in TRIPLETS. The shape matters:
  // patterns.ts settles it at 十三么's entry ("Not 混么九: that pattern wants
  // pungs of terminals and honours, and this hand has none"), and 混么九 implies
  // 對對糊 without subsuming it. Written loosely on the honour: an all-terminal
  // or all-honour hand satisfies it too, and both of those subsume it.
  const everyTile = [...sets.flatMap((g) => g.tiles), ...r.pair.tiles];
  if (sets.every(isTripletLike) && everyTile.every(isTerminalOrHonour)) {
    out.push("mixedTerminals");
  }

  return out;
}

/**
 * Patterns that depend only on WHICH tiles are held, so they read the same
 * under every partition. Kept apart from `shapePatterns` for exactly that
 * reason — a bug that lets a re-parse buy a flush is impossible here.
 */
function tilePatterns(all: readonly TileId[]): string[] {
  const out: string[] = [];
  const suits = new Set<number>();
  for (const t of all) if (isSuited(t)) suits.add(suitIndex(t));
  const anyHonour = all.some(isHonour);

  // 混一色 — at most one suit, plus honours. Written loosely on purpose: it
  // also fires on a full flush and on an all-honour hand, and the catalogue has
  // both of those subsume it for precisely that reason.
  if (suits.size <= 1) out.push("halfFlush");

  // 清一色 — one suit and not a single honour.
  if (suits.size === 1 && !anyHonour) out.push("fullFlush");

  // 字一色 — 東南西北中發白 and nothing else.
  if (all.every(isHonour)) out.push("allHonours");

  // 清么九 — 1s and 9s of the suits, no honours at all. That absence is the
  // whole difference between 清么九 and 混么九.
  if (all.every(isSuitedTerminal)) out.push("allTerminals");

  return out;
}

/** 十三么 — one of each of the thirteen 么九 kinds, with one of them doubled. */
function isThirteenOrphans(all: readonly TileId[], melds: readonly Meld[]): boolean {
  if (melds.length > 0) return false; // nothing in this hand can ever be claimed
  if (all.length !== 14) return false;
  const c = countsOf(all);
  let doubled = 0;
  for (let t = 0; t < KINDS; t += 1) {
    if (isTerminalOrHonour(t)) {
      if (c[t] === 1) continue;
      if (c[t] === 2) {
        doubled += 1;
        continue;
      }
      return false;
    }
    if (c[t] !== 0) return false;
  }
  return doubled === 1;
}

/**
 * 九蓮寶燈 — 1112345678999 of one suit with any fourteenth tile of that suit
 * added. Concealed by definition: it holds four sets' worth of tiles that were
 * never claimable as melds.
 */
function isNineGates(all: readonly TileId[], melds: readonly Meld[]): boolean {
  if (melds.length > 0) return false;
  if (all.length !== 14) return false;
  if (!all.every(isSuited)) return false;
  const suit = suitIndex(all[0]!);
  if (!all.every((t) => suitIndex(t) === suit)) return false;
  const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
  const c = countsOf(all);
  let spare = 0;
  for (let r = 0; r < 9; r += 1) {
    const extra = c[suit * 9 + r]! - need[r]!;
    if (extra < 0) return false;
    spare += extra;
  }
  return spare === 1;
}

/**
 * 七對子 — seven distinct pairs, nothing claimed. NOT classic HK Old Style:
 * only the LIU preset prices it (patterns.ts marks it `houseRule`). The strict
 * reading is taken — four copies of one kind are one quad, not two pairs — and
 * that choice is reported rather than assumed correct.
 */
function isSevenPairs(all: readonly TileId[], melds: readonly Meld[]): boolean {
  if (melds.length > 0) return false;
  if (all.length !== 14) return false;
  const c = countsOf(all);
  let pairs = 0;
  for (let t = 0; t < KINDS; t += 1) {
    if (c[t] === 0) continue;
    if (c[t] !== 2) return false;
    pairs += 1;
  }
  return pairs === 7;
}

/**
 * Faan that comes from how the win ARRIVED rather than from the tiles. Every
 * one of these is a fact only the match state machine knows.
 */
function situationPatterns(ctx: WinSituation, melds: readonly Meld[]): string[] {
  const out: string[] = [];

  // 自摸 — won on your own draw. A kong replacement is a wall draw too, so the
  // two stack rather than replacing each other (patterns.ts).
  if (ctx.selfDraw) out.push("selfDraw");

  // 門前清 — nothing was ever claimed from another seat. A 暗槓 is declared
  // from four tiles already held, so it does not spoil concealment; every other
  // declared meld does. The winning tile itself may still be a discard.
  if (melds.every((m) => m.kind === "kong" && m.concealed)) out.push("concealedHand");

  // 海底撈月 the wall's last DRAW and 河底撈魚 the last DISCARD. Twins, priced
  // level, and no hand can earn both because a win is one or the other.
  if (ctx.onLastTile) out.push("winOnLastTile");
  if (ctx.onLastDiscard) out.push("winOnLastDiscard");

  // 搶槓 — won on the tile another seat was adding to an exposed pung.
  if (ctx.robbedKong) out.push("robbingKong");

  // 槓上開花, and 槓上槓 when the replacement itself made a second kong.
  if (ctx.onKongReplacement) out.push("winOnKongReplacement");
  if (ctx.doubleKong) out.push("winByDoubleKong");

  // 天糊 the dealer's dealt fourteen; 地糊 a non-dealer on the dealer's first
  // discard. Both are limit hands and neither is derivable from tiles.
  if (ctx.heavenly) out.push("heavenlyHand");
  if (ctx.earthly) out.push("earthlyHand");

  return out;
}

/**
 * 花 — the bonus tiles, which are set aside and never part of a set. No
 * `useFlowers` check is needed: assertRulesetSound forbids a table from
 * pricing a bonus-tile pattern while playing without flowers, so `price` drops
 * every id here on such a ruleset anyway.
 */
function bonusPatterns(flowers: readonly TileId[], seatWind: WindIndex): string[] {
  const out: string[] = [];

  // 無花 — not one bonus tile all hand. Mutually exclusive with everything else
  // here, so it needs no subsumption.
  if (flowers.length === 0) {
    out.push("noFlowers");
    return out;
  }

  // 正花 — the flower, and separately the season, matching your own seat.
  for (const f of flowers) {
    if (bonusTileSeat(f) !== seatWind) continue;
    out.push(f < SEASONS_FROM ? "ownFlower" : "ownSeason");
  }

  // 一台花 — a complete set of four. Deliberately does NOT swallow the 正花
  // inside it: holding all four means holding your own, and 1 + 2 = 3 is the
  // total HK tables quote.
  const held = new Set(flowers);
  let allFour = true;
  for (let i = 0; i < 4; i += 1) if (!held.has(FLOWERS_FROM + i)) allFour = false;
  if (allFour) out.push("allFlowers");
  let allSeasons = true;
  for (let i = 0; i < 4; i += 1) if (!held.has(SEASONS_FROM + i)) allSeasons = false;
  if (allSeasons) out.push("allSeasons");

  return out;
}

/* ── pricing ───────────────────────────────────────────────────────────── */

interface Priced {
  awards: string[];
  rawFaan: number;
  faan: number;
  capped: boolean;
  legal: boolean;
}

/**
 * The faan table is BOTH the price list and the enable list, so an id the house
 * does not carry is simply not scored and does not appear in the breakdown.
 * 爆棚 is a clamp on the total, never a clamp on the parts: `rawFaan` is the
 * honest sum and `faan` is what is actually paid.
 */
function price(ids: readonly string[], ruleset: Ruleset): Priced {
  const awards: string[] = [];
  let rawFaan = 0;
  for (const id of ids) {
    const faan = ruleset.faanTable[id];
    if (faan === undefined) continue;
    awards.push(id);
    rawFaan += faan;
  }
  const faan = Math.min(rawFaan, ruleset.limitFaan);
  return {
    awards,
    rawFaan,
    faan,
    capped: rawFaan > ruleset.limitFaan,
    legal: faan >= ruleset.minimumFaan,
  };
}

/* ── the scorer ────────────────────────────────────────────────────────── */

export interface ReferenceScore {
  faan: number;
  rawFaan: number;
  capped: boolean;
  legal: boolean;
  /** The first reading that reaches `faan`, in detection order. */
  awards: string[];
  /**
   * EVERY distinct award list that reaches `faan`, each sorted. A hand that
   * genuinely reads two ways for the same money has two right answers and the
   * differential test must not call the tie a defect.
   */
  optimalAwards: string[][];
  /** How many complete readings were considered. Useful when a case surprises. */
  readings: number;
}

const sortedKey = (ids: readonly string[]): string => [...ids].sort().join("+");

/**
 * Score a completed hand. Signature mirrors engine/src/scoring.ts `score` so a
 * differential test can hand both the same arguments.
 *
 * @param concealed   tiles still in hand, NOT including the winning tile
 * @param melds       declared sets, in the order they were laid down
 * @param flowers     revealed bonus tiles 花
 * @param winningTile the tile that completed the hand
 * @param ctx         how the win arrived
 * @param ruleset     the house's price list, which is also its enable list
 * @throws when the fourteen tiles cannot be read as a winning hand at all
 */
export function referenceScore(
  concealed: readonly TileId[],
  melds: readonly Meld[],
  flowers: readonly TileId[],
  winningTile: TileId,
  ctx: WinSituation,
  ruleset: Ruleset,
): ReferenceScore {
  const handTiles = [...concealed, winningTile];
  const meldTiles: TileId[] = [];
  for (const m of melds) meldTiles.push(...m.tiles);
  const allTiles = [...handTiles, ...meldTiles];

  const setsFromHand = 4 - melds.length;
  if (setsFromHand < 0) throw new Error("more than four melds — that is not a hand");

  // Facts that hold whatever the partition turns out to be.
  const shared = [
    ...situationPatterns(ctx, melds),
    ...bonusPatterns(flowers, ctx.seatWind),
    ...tilePatterns(allTiles),
  ];

  const candidates: string[][] = [];

  // 十三么 has no four-sets-and-a-pair reading at all, so it is its own reading.
  if (isThirteenOrphans(handTiles, melds)) candidates.push(["thirteenOrphans", ...shared]);

  // 七對子 likewise: seven pairs is not four sets and a pair.
  if (isSevenPairs(handTiles, melds)) candidates.push(["sevenPairs", ...shared]);

  // 九蓮寶燈 DOES decompose, so it rides along on top of every ordinary reading
  // of the same tiles rather than replacing them.
  const nineGates = isNineGates(handTiles, melds) ? ["nineGates"] : [];

  // The declared melds are fixed. Only their concealment matters to scoring:
  // a 暗槓 was never claimed, everything else took a tile off the table.
  const meldGroups: Group[] = melds.map((m) => ({
    shape: m.kind === "kong" ? "kong" : m.kind === "pung" ? "pung" : "chow",
    base: m.tiles[0]!,
    tiles: [...m.tiles],
    concealed: m.kind === "kong" && m.concealed,
  }));

  for (const part of enumeratePartitions(handTiles, setsFromHand)) {
    const handGroups: Group[] = part.sets.map((tiles) => ({
      shape: tiles[0] === tiles[2] ? "pung" : "chow",
      base: tiles[0]!,
      tiles: [...tiles],
      concealed: true,
    }));
    const pair: Group = {
      shape: "pair",
      base: part.pair,
      tiles: [part.pair, part.pair],
      concealed: true,
    };

    // Where did the winning tile land? On a self-draw it makes no difference —
    // nothing was contributed by another seat. On a discard it does: the group
    // the tile completed is no longer concealed, which is what stops a hand
    // whose fourth triplet was fed to it from booking 四暗刻. When several
    // groups hold that kind the winner may read it into whichever helps, the
    // same way any other decomposition tie is settled.
    const landings: number[] = [];
    if (ctx.selfDraw) landings.push(-1);
    else {
      for (let i = 0; i < handGroups.length; i += 1) {
        if (handGroups[i]!.tiles.includes(winningTile)) landings.push(i);
      }
      if (pair.base === winningTile) landings.push(-1);
      if (landings.length === 0) landings.push(-1);
    }

    for (const landing of landings) {
      const sets = [
        ...meldGroups,
        ...handGroups.map((g, i) => (i === landing ? { ...g, concealed: false } : g)),
      ];
      candidates.push([
        ...shapePatterns({ sets, pair }, ctx.seatWind, ctx.roundWind),
        ...nineGates,
        ...shared,
      ]);
    }
  }

  if (candidates.length === 0) {
    throw new Error("these fourteen tiles are not a winning hand");
  }

  let best: Priced | null = null;
  const optimal = new Map<string, string[]>();
  for (const ids of candidates) {
    const scored = price(dropSubsumed(ids, ruleset), ruleset);
    if (best === null || scored.faan > best.faan) {
      best = scored;
      optimal.clear();
      optimal.set(sortedKey(scored.awards), [...scored.awards].sort());
    } else if (scored.faan === best.faan) {
      optimal.set(sortedKey(scored.awards), [...scored.awards].sort());
    }
  }

  const won = best!;
  return {
    faan: won.faan,
    rawFaan: won.rawFaan,
    capped: won.capped,
    legal: won.legal,
    awards: won.awards,
    optimalAwards: [...optimal.values()],
    readings: candidates.length,
  };
}

/* ── readable output, for when the two implementations disagree ─────────── */

const TILE_NAME: readonly string[] = (() => {
  const n: string[] = [];
  for (const suit of ["萬", "索", "筒"]) for (let i = 1; i <= 9; i += 1) n.push(`${i}${suit}`);
  n.push("東", "南", "西", "北", "中", "發", "白");
  n.push("梅", "蘭", "菊", "竹", "春", "夏", "秋", "冬");
  return n;
})();

const nameOf = (t: TileId): string => TILE_NAME[t] ?? `#${t}`;
const namesOf = (ts: readonly TileId[]): string => ts.map(nameOf).join(" ");

const meldLabel = (m: Meld): string => {
  if (m.kind === "chow") return `上 ${namesOf(m.tiles)}`;
  if (m.kind === "pung") return `碰 ${namesOf(m.tiles)}`;
  if (m.concealed) return `暗槓 ${namesOf(m.tiles)}`;
  return `${m.addedToPung ? "加槓" : "明槓"} ${namesOf(m.tiles)}`;
};

const WIND_NAME = ["東", "南", "西", "北"] as const;

/** One block of plain text describing a hand exactly enough to re-key it by hand. */
export function describeHand(
  concealed: readonly TileId[],
  melds: readonly Meld[],
  flowers: readonly TileId[],
  winningTile: TileId,
  ctx: WinSituation,
  ruleset: Ruleset,
): string {
  const situation = [
    ctx.selfDraw ? "自摸" : "won on a discard",
    ctx.robbedKong ? "搶槓" : "",
    ctx.onKongReplacement ? "槓上開花" : "",
    ctx.doubleKong ? "槓上槓" : "",
    ctx.onLastTile ? "海底撈月" : "",
    ctx.onLastDiscard ? "河底撈魚" : "",
    ctx.heavenly ? "天糊" : "",
    ctx.earthly ? "地糊" : "",
    ctx.isDealer ? "dealer 莊" : "",
  ].filter((s) => s !== "");
  return [
    `ruleset   ${ruleset.id}`,
    `hand      ${namesOf(concealed)}`,
    `melds     ${melds.length === 0 ? "(none)" : melds.map(meldLabel).join(" | ")}`,
    `flowers   ${flowers.length === 0 ? "(none)" : namesOf(flowers)}`,
    `winning   ${nameOf(winningTile)}`,
    `seat 門風 ${WIND_NAME[ctx.seatWind]}   round 圈風 ${WIND_NAME[ctx.roundWind]}`,
    `situation ${situation.join(", ")}`,
    `raw ids   [${concealed.join(",")}] + ${winningTile}`,
  ].join("\n");
}

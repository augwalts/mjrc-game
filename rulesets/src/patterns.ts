/**
 * The canonical pattern catalogue 牌型. DESIGN.md §4 — rulesets are DATA, so
 * this file names every pattern the engine can ever award and says how the
 * patterns relate; a Ruleset then picks which of them it plays and what each
 * is worth. Nothing here carries a faan value: values live in presets.ts
 * because they are the part houses disagree about.
 *
 * Values, characters and romanization transcribed from
 * mjrc-app/web/src/data/hk-scoring.ts (owned by another team — read, never
 * imported) and mjrc-admin/research/probability/core/scoring.py.
 * Terminology rules: ../../TERMINOLOGY.md.
 *
 * ── Subsumption, the part that is easy to get wrong ──────────────────────
 *
 * `subsumes` lists patterns whose faan is ALREADY INSIDE this pattern's
 * value, so awarding both would pay twice for the same tiles. The rule used
 * here, applied consistently:
 *
 *   A pattern subsumes another when the other is part of THIS pattern's
 *   definition — the tiles it names, not merely tiles it happens to contain.
 *
 * So 大三元 (pungs of all three dragons) subsumes the three dragon pungs it
 * names, and hk-scoring.ts confirms it: "the 4-5 fan shown typically already
 * INCLUDES the fan for the two dragon pungs". But 字一色 (winds and dragons
 * only) names no particular honour set, so it does NOT swallow the dragon or
 * wind pung faan — houses add those on top, and the 13-faan limit absorbs the
 * difference anyway.
 *
 * Subsumption is DIRECT here, never transitive: 大三元 lists 小三元, and the
 * closure walks on to the dragon pungs 小三元 swallows. Use
 * `subsumptionClosure` / `applySubsumption` rather than reading `subsumes`
 * straight.
 *
 * `concealedOnly` marks a hand that cannot hold an exposed meld. It is NOT the
 * same as subsuming 門前清: hk-scoring.ts says such a hand should not also
 * collect that faan, but the golden suite pays it on 十三么, 九蓮寶燈, 天糊 and
 * 地糊, where the limit swallows the difference either way. The sourced ruling
 * is kept only where it changes a total — 七對子 at 4 faan and 四暗刻 — and the
 * disagreement is reported rather than resolved here.
 *
 * A pattern the ruleset does not play must never subsume one it does — a
 * ruleset with no 綠一色 entry would otherwise score a green hand as zero.
 * `applySubsumption` takes the enabled set for exactly this reason.
 */

/** Grouping for display and for the scoring engine's search order. */
export type PatternFamily =
  | "honourMeld"
  | "bonusTile"
  | "winCondition"
  | "handPattern"
  | "limitHand";

export interface PatternDef {
  /** Stable id. Matches FaanAward.id in engine/src/types.ts. Never displayed. */
  id: string;
  /** Cantonese characters. Leads every user-facing label (DESIGN.md §7). */
  characters: string;
  /** Jyutping romanization, standardised per TERMINOLOGY.md. */
  jyutping: string;
  /** English label, sits under the characters. */
  label: string;
  aka?: readonly string[];
  family: PatternFamily;
  /** Direct subsumption only — see the header. */
  subsumes: readonly string[];
  /**
   * The hand cannot exist with an exposed meld. Informational: whether that
   * also suppresses 門前清 is a separate `subsumes` decision — see the header.
   */
  concealedOnly?: boolean;
  /** Not classic HK Old Style. A table has to opt in by pricing it. */
  houseRule?: boolean;
  /** WHY this entry looks the way it does, where that is not obvious. */
  note?: string;
}

export const PATTERNS: readonly PatternDef[] = [
  /* ── honour melds 番子 · 1 faan apiece ────────────────────────────────
     A kong of the same honour is worth exactly what the pung is worth in all
     six systems, so kongs get no ids of their own. The kong shape earns a
     replacement draw, not extra faan. */
  {
    id: "dragonPung",
    characters: "三元牌",
    jyutping: "saam1 jyun4 paai2",
    label: "Pung of Dragons",
    family: "honourMeld",
    subsumes: [],
    note:
      "One id covers all three dragons and both set sizes — a kong of dragons is " +
      "worth exactly what the pung is worth in all six surveyed systems, and each " +
      "dragon scores separately, so the award simply repeats. Honours never form " +
      "runs: 中發白 in a row is three loose tiles.",
  },
  {
    id: "seatWind",
    characters: "門風",
    jyutping: "mun4 fung1",
    label: "Pung of Seat Wind",
    family: "honourMeld",
    subsumes: [],
    note: "Seat wind and round wind are separate awards; East in East round scores both.",
  },
  {
    id: "roundWind",
    characters: "圈風",
    jyutping: "hyun1 fung1",
    label: "Pung of Round Wind",
    family: "honourMeld",
    subsumes: [],
  },

  /* ── bonus tiles 花 ──────────────────────────────────────────────────── */
  {
    id: "ownFlower",
    characters: "正花",
    jyutping: "zing3 faa1",
    label: "Own Flower",
    family: "bonusTile",
    subsumes: [],
    note: "The flower matching the seat wind. A flower that is not yours scores nothing alone.",
  },
  {
    id: "ownSeason",
    characters: "正花",
    jyutping: "zing3 faa1",
    label: "Own Season",
    family: "bonusTile",
    subsumes: [],
  },
  {
    id: "allFlowers",
    characters: "一台花",
    jyutping: "jat1 toi4 faa1",
    label: "All Four Flowers",
    family: "bonusTile",
    subsumes: [],
    note:
      "Deliberately does NOT subsume ownFlower. Holding all four means holding " +
      "your own, so 1 + 2 = 3 — which is the 一台花 total HK tables actually quote.",
  },
  {
    id: "allSeasons",
    characters: "一台花",
    jyutping: "jat1 toi4 faa1",
    label: "All Four Seasons",
    family: "bonusTile",
    subsumes: [],
    note: "Same arithmetic as allFlowers.",
  },
  {
    id: "noFlowers",
    characters: "無花",
    jyutping: "mou4 faa1",
    label: "No Flowers or Seasons",
    family: "bonusTile",
    subsumes: [],
    note: "Mutually exclusive with every other bonus-tile award, so no subsumption is needed.",
  },

  /* ── winning conditions ──────────────────────────────────────────────── */
  {
    id: "selfDraw",
    characters: "自摸",
    jyutping: "zi6 mo1",
    label: "Self-Draw",
    family: "winCondition",
    subsumes: [],
    note: "Cantonese, not borrowed — kept per TERMINOLOGY.md.",
  },
  {
    id: "concealedHand",
    characters: "門前清",
    jyutping: "mun4 cin4 cing1",
    label: "Fully Concealed",
    family: "winCondition",
    subsumes: [],
    note:
      "No meld claimed from a discard; the winning tile itself may still be a " +
      "discard. Hands that are concealed by definition subsume this instead of stacking with it.",
  },
  {
    id: "winOnLastTile",
    characters: "海底撈月",
    jyutping: "hoi2 dai2 lau4 jyut6",
    label: "Out on the Last Tile",
    family: "winCondition",
    subsumes: [],
  },
  {
    id: "winOnLastDiscard",
    characters: "河底撈魚",
    jyutping: "ho4 dai2 lau4 jyu4",
    label: "Out on the Last Discard",
    family: "winCondition",
    subsumes: [],
    note:
      "The twin of 海底撈月, not the same award: 海底 is the wall's final DRAW, " +
      "河底 the final DISCARD. Every surveyed system prices the pair as one row " +
      "worth 1, so both ids carry 1 and no hand can ever earn both.",
  },
  {
    id: "robbingKong",
    characters: "搶槓",
    jyutping: "coeng2 gong3",
    label: "Rob a Kong",
    family: "winCondition",
    subsumes: [],
    note: "Won on the tile that would have turned an exposed pung into a 加槓.",
  },
  {
    id: "winOnKongReplacement",
    characters: "槓上開花",
    jyutping: "gong3 soeng5 hoi1 faa1",
    label: "Win on a Replacement Tile",
    family: "winCondition",
    subsumes: [],
    note:
      "The replacement is a wall draw, so selfDraw is collected on top — the two " +
      "are additive, not alternatives.",
  },
  {
    id: "winByDoubleKong",
    characters: "槓上槓",
    jyutping: "gong3 soeng5 gong3",
    label: "Win by Double Kong",
    family: "winCondition",
    subsumes: ["winOnKongReplacement"],
    note: "The replacement made a second kong and THAT replacement won. Only Wikipedia's table prices it.",
  },

  /* ── hand patterns ───────────────────────────────────────────────────── */
  {
    id: "allChows",
    characters: "平糊",
    jyutping: "ping4 wu4",
    label: "All Chows",
    aka: ["Common Hand", "Chow Hand"],
    family: "handPattern",
    subsumes: [],
    note: "A minority of houses disqualify an honour pair as the eyes. Not modelled — house rule.",
  },
  {
    id: "allPungs",
    characters: "對對糊",
    jyutping: "deoi3 deoi3 wu4",
    label: "All Pungs",
    family: "handPattern",
    subsumes: [],
  },
  {
    id: "halfFlush",
    characters: "混一色",
    jyutping: "wan6 jat1 sik1",
    label: "Half Flush",
    family: "handPattern",
    subsumes: [],
  },
  {
    id: "fullFlush",
    characters: "清一色",
    jyutping: "cing1 jat1 sik1",
    label: "Full Flush",
    aka: ["Pure Hand"],
    family: "handPattern",
    subsumes: ["halfFlush"],
    note:
      "A full flush holds no honours so it is not literally a half flush, but a " +
      "detector written as 'one suit plus honours' fires on both. Subsumed for safety.",
  },
  {
    id: "mixedTerminals",
    characters: "混么九",
    jyutping: "wan6 jiu1 gau2",
    label: "Mixed Terminals",
    aka: ["Mixed Orphans"],
    family: "handPattern",
    subsumes: [],
    note:
      "Does NOT subsume allPungs even though it implies it — every surveyed system " +
      "prices 混么九 at 1 as a bonus stacked on 對對糊's 3.",
  },
  {
    id: "sevenPairs",
    characters: "七對子",
    jyutping: "cat1 deoi3 zi2",
    label: "Seven Pairs",
    aka: ["Seven Sisters"],
    family: "handPattern",
    concealedOnly: true,
    houseRule: true,
    subsumes: ["concealedHand"],
    note:
      "NOT classic HK Old Style — it arrives from other rule families. Present " +
      "only because the LIU preset the Python engine implements scores it at 4. " +
      "hkos-standard leaves it out.",
  },
  {
    id: "smallThreeDragons",
    characters: "小三元",
    jyutping: "siu2 saam1 jyun4",
    label: "Small Three Dragons",
    family: "handPattern",
    subsumes: ["dragonPung"],
    note:
      "Two dragon pungs plus a pair of the third. Its value already includes the " +
      "two pungs — hk-scoring.ts states this outright — so every loose dragonPung " +
      "award is dropped.",
  },
  {
    id: "bigThreeDragons",
    characters: "大三元",
    jyutping: "daai6 saam1 jyun4",
    label: "Big Three Dragons",
    aka: ["Three Great Scholars"],
    family: "handPattern",
    subsumes: ["smallThreeDragons", "dragonPung"],
  },
  {
    id: "smallFourWinds",
    characters: "小四喜",
    jyutping: "siu2 sei3 hei2",
    label: "Small Four Winds",
    family: "handPattern",
    // Owner ruling 2026-08-26: wind faan never stack on a Four Winds hand.
    subsumes: ["seatWind", "roundWind"],
    note:
      "Does NOT swallow 門風/圈風, unlike the way 小三元 swallows its dragon pungs. " +
      "Those are POSITIONAL faan — they depend on who you are and which round it " +
      "is, not on the shape — whereas a dragon pung's faan is the shape itself. " +
      "Ruling taken from engine/test/golden/honours.ts, which fixes it for the " +
      "whole suite; every four-winds hand caps at 13 either way.",
  },
  {
    id: "bigFourWinds",
    characters: "大四喜",
    jyutping: "daai6 sei3 hei2",
    label: "Big Four Winds",
    family: "handPattern",
    subsumes: ["smallFourWinds", "seatWind", "roundWind"],
  },

  /* ── limit hands 爆棚 ─────────────────────────────────────────────────── */
  {
    id: "fourConcealedPungs",
    characters: "四暗刻",
    jyutping: "sei3 am3 hak1",
    label: "Four Concealed Pungs",
    aka: ["Hidden Treasure", "坎坎糊"],
    family: "limitHand",
    concealedOnly: true,
    subsumes: ["allPungs", "concealedHand"],
    note:
      "Classic form wins by self-draw. Winning on a discard requires all four pungs " +
      "already complete, the discard finishing only the pair — houses conflict; the " +
      "detector, not this catalogue, has to pick.",
  },
  {
    id: "allHonours",
    characters: "字一色",
    jyutping: "zi6 jat1 sik1",
    label: "All Honours",
    family: "limitHand",
    // Owner ruling 2026-08-26: an all-honours hand is all pungs by definition,
    // so 對對糊 is inside the pattern, not on top of it.
    subsumes: ["halfFlush", "mixedTerminals", "allPungs"],
    note:
      "Honours cannot run, so the hand is all pungs by construction — but 對對糊 " +
      "is still paid on top, because 字一色 is a pattern about the CLASS of tile " +
      "and takes no credit for the shape (the golden fixtures award both). It " +
      "names no particular honour set either, so the dragon and wind faan survive " +
      "too. Contrast 十八羅漢, which IS the four-pung shape and does swallow it. " +
      "The flush and 混么九 entries are detector safety: an honours-only hand " +
      "satisfies both definitions read loosely, and neither is meant to fire.",
  },
  {
    id: "allTerminals",
    characters: "么九",
    jyutping: "jiu1 gau2",
    label: "All Terminals",
    family: "limitHand",
    // Owner ruling 2026-08-26: same logic as 字一色 — the shape implies all pungs.
    subsumes: ["mixedTerminals", "allPungs"],
    note:
      "Pungs of 1s and 9s only — no honours, so no honour-meld faan can arise, and " +
      "混么九 (which needs an honour) cannot legitimately fire; it is listed as " +
      "detector safety. 對對糊 is paid on top, same reasoning as 字一色.",
  },
  {
    id: "nineGates",
    characters: "九蓮寶燈",
    jyutping: "gau2 lin4 bou2 dang1",
    label: "Nine Gates",
    aka: ["九子連環"],
    family: "limitHand",
    concealedOnly: true,
    subsumes: ["fullFlush"],
    note:
      "The hand is one suit by definition, so it swallows 清一色. That pairs with " +
      "pricing it as a flat limit hand: Wikipedia alone splits it 4 + the flush's " +
      "6 for 10 effective, and under that reading the flush would be additive " +
      "instead. See presets.ts for which reading each table takes.",
  },
  {
    id: "thirteenOrphans",
    characters: "十三么",
    jyutping: "sap6 saam1 jiu1",
    label: "Thirteen Orphans",
    family: "limitHand",
    concealedOnly: true,
    subsumes: [],
    note:
      "Not 混么九: that pattern wants pungs of terminals and honours, and this hand " +
      "has none. 門前清 is left additive — hk-scoring.ts says a hand concealed by " +
      "definition should not also collect it, but the golden fixtures pay it and " +
      "the limit absorbs the difference. Flagged, not silently resolved.",
  },
  {
    id: "allKongs",
    characters: "十八羅漢",
    jyutping: "sap6 baat3 lo4 hon3",
    label: "All Kongs",
    aka: ["Four Kongs"],
    family: "limitHand",
    subsumes: ["allPungs"],
    note:
      "Four kongs plus a pair — 18 tiles on the table, four sets in the shape. It " +
      "IS the 對對糊 shape, so it swallows it (engine/test/golden/kongs.ts fixes " +
      "this). Does NOT swallow 四暗刻: houses split on whether concealed kongs " +
      "count toward it, and the golden suite records a hand awarding both.",
  },
  {
    id: "jadeDragon",
    characters: "綠一色",
    jyutping: "luk6 jat1 sik1",
    label: "Jade Dragon",
    aka: ["All Green"],
    family: "limitHand",
    subsumes: ["halfFlush", "allPungs", "dragonPung"],
    note:
      "Bamboo pungs or kongs plus the green dragon pung — the suit and the dragon " +
      "are both named in the definition, so both are inside the value. Some houses " +
      "also play a small version worth a few faan; not modelled.",
  },
  {
    id: "rubyDragon",
    characters: "紅一色",
    jyutping: "hung4 jat1 sik1",
    label: "Ruby Dragon",
    aka: ["All Red"],
    family: "limitHand",
    subsumes: ["halfFlush", "allPungs", "dragonPung"],
  },
  {
    id: "pearlDragon",
    characters: "白一色",
    jyutping: "baak6 jat1 sik1",
    label: "Pearl Dragon",
    aka: ["All White"],
    family: "limitHand",
    subsumes: ["halfFlush", "allPungs", "dragonPung"],
  },
  {
    id: "heavenlyHand",
    characters: "天糊",
    jyutping: "tin1 wu4",
    label: "Heavenly Hand",
    family: "limitHand",
    concealedOnly: true,
    subsumes: [],
    note:
      "The dealer's dealt hand is already complete. Nothing is subsumed: at the " +
      "limit 自摸 and 門前清 cost nothing to add, and the golden fixtures pay both.",
  },
  {
    id: "earthlyHand",
    characters: "地糊",
    jyutping: "dei6 wu4",
    label: "Earthly Hand",
    family: "limitHand",
    concealedOnly: true,
    subsumes: [],
    note:
      "A non-dealer wins on the dealer's very first discard — a discard, so never " +
      "a self-draw. 門前清 left additive, as for 天糊.",
  },
];

export const PATTERN_IDS: readonly string[] = PATTERNS.map((p) => p.id);

const BY_ID: ReadonlyMap<string, PatternDef> = new Map(PATTERNS.map((p) => [p.id, p]));

/** Look a pattern up. Throws rather than returning undefined — an unknown id is a bug. */
export function pattern(id: string): PatternDef {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown pattern id "${id}"`);
  return found;
}

export const isPattern = (id: string): boolean => BY_ID.has(id);

export const patternsOf = (family: PatternFamily): readonly PatternDef[] =>
  PATTERNS.filter((p) => p.family === family);

/**
 * Every id `id` swallows, following subsumption through as many hops as it
 * takes. `bigThreeDragons` lists `smallThreeDragons`, which lists the dragon
 * pungs; the closure returns all four.
 */
export function subsumptionClosure(id: string): ReadonlySet<string> {
  const out = new Set<string>();
  const queue = [...pattern(id).subsumes];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (out.has(next)) continue;
    out.add(next);
    queue.push(...pattern(next).subsumes);
  }
  return out;
}

/**
 * Drop every pattern that a surviving pattern already pays for.
 *
 * MULTIPLICITY IS PRESERVED. Three dragon pungs are three "dragonPung" awards
 * worth 3 faan, so this filters the list rather than deduplicating it — the
 * scoring engine relies on the count. Order is preserved too, so a breakdown
 * shown to a player comes out in the order the detector found things.
 *
 * `enabled` is the ruleset's faan table keys, and only patterns in it may
 * subsume. A pattern the ruleset does not play must not suppress one it does:
 * a table with no 綠一色 entry would otherwise score a green hand at zero,
 * because jadeDragon would have eaten the flush and the pungs on its way to
 * being worth nothing itself. Patterns the ruleset does not play are still
 * returned — pricing them against the faan table is the caller's job.
 */
export function applySubsumption(
  ids: Iterable<string>,
  enabled?: ReadonlySet<string>,
): string[] {
  const present = [...ids];
  const active = new Set(present.filter((id) => !enabled || enabled.has(id)));
  const eaten = new Set<string>();
  for (const id of active) for (const s of subsumptionClosure(id)) eaten.add(s);
  return present.filter((id) => !eaten.has(id));
}

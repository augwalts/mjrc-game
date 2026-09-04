/**
 * 枱面話 — the table-talk catalogue. See ../../../EXPRESSIONS.md for the
 * argument; this file is the data.
 *
 * THREE RULES THIS FILE EXISTS TO ENFORCE
 *
 *  1. ZERO ENGINE IMPORTS, ZERO PROTOCOL IMPORTS. Expressions are
 *     presentation. DESIGN.md §5 makes the client disposable by design
 *     precisely because it holds no game logic, and an expression that knew
 *     what a `TileId` was would be the first crack in that. Nothing here
 *     imports anything at all.
 *
 *  2. EXPRESSIONS NEVER ENTER THE EVENT LOG. The log is a versioned research
 *     corpus (§5.5) and chatter is speech, not history. An id from this file
 *     must never appear in a `GameEvent` payload, an R2 archive blob, or a
 *     D1 result row. It rides an ephemeral side-channel and is dropped on
 *     reconnect. EXPRESSIONS.md §9 has the full argument.
 *
 *  3. SOFTEN, NEVER DELETE. A receiver whose tier is below what was sent
 *     sees a tamer phrase, not silence — `softenTo` walks down until the
 *     phrase fits. A table that goes quiet for one player looks broken to
 *     that player, and the social beat is the whole feature.
 *
 * Romanization is Jyutping, standardised per ../../../TERMINOLOGY.md. That
 * file is a HARD RULE: Hong Kong Old Style vocabulary only.
 *
 * VALIDATION STATUS: authored from HK usage, NOT yet reviewed by a native
 * speaker. Tone and register are the risky part, not the characters — every
 * entry marked `needsReview` is one where the author is unsure the phrase
 * lands the way the `english` field claims. Do not ship without a pass by
 * two HK players from the LA scene (EXPRESSIONS.md §12, open decision 1).
 */

/* ── vocabulary this layer teaches (DESIGN.md §7, terminology-first) ────── */

/**
 * The play vocabulary an expression can carry. Deliberately NOT the pattern
 * names — those live in `@mjrc/rulesets` `patterns.ts` and are taught by the
 * scoring breakdown. These are the words shouted across a table.
 */
export const TERM_GLOSSARY = {
  winOnDiscard: { characters: "食糊", jyutping: "sik6 wu2", english: "win off a discard" },
  selfDraw: { characters: "自摸", jyutping: "zi6 mo1", english: "win on your own draw" },
  dealIn: { characters: "出銃", jyutping: "ceot1 cung3", english: "fire the shot that lets someone win" },
  ready: { characters: "聽牌", jyutping: "ting1 paai2", english: "one tile from winning" },
  oneAway: { characters: "上聽", jyutping: "soeng5 ting1", english: "one step from ready" },
  drawAndCut: { characters: "摸切", jyutping: "mo1 cit3", english: "draw it, throw it straight back" },
  limit: { characters: "爆棚", jyutping: "baau3 paang4", english: "the 13-faan ceiling" },
  exhaustiveDraw: { characters: "流局", jyutping: "lau4 guk6", english: "wall exhausted, nobody wins" },
  cutTheWin: { characters: "截糊", jyutping: "zit6 wu2", english: "take the tile the next player was waiting on" },
  falseWin: { characters: "詐糊", jyutping: "zaa3 wu2", english: "declare a win you do not have" },
  handWind: { characters: "手風", jyutping: "sau2 fung1", english: "how your luck is running tonight" },
  deadTile: { characters: "死牌", jyutping: "sei2 paai2", english: "a tile whose four copies are all visible" },
  cheating: { characters: "出千", jyutping: "ceot1 cin1", english: "cheat" },
  threeShortOne: { characters: "三缺一", jyutping: "saam1 kyut3 jat1", english: "three of us, need a fourth" },
} as const;

export type TermId = keyof typeof TERM_GLOSSARY;

/* ── the axes ──────────────────────────────────────────────────────────── */

/**
 * How coarse the LANGUAGE is. Orthogonal to `edge` — 犀利喎 is spotless
 * language and a sneer; 屌 aimed at your own draw is filthy language and
 * hurts nobody. Conflating the two is why most chat filters feel stupid.
 */
export type IntensityTier = "clean" | "salty" | "coarse";

export const TIERS = {
  clean: { characters: "斯文", jyutping: "si1 man4", english: "polite", rank: 0 },
  salty: { characters: "有火", jyutping: "jau5 fo2", english: "fired up", rank: 1 },
  coarse: { characters: "粗口", jyutping: "cou1 hau2", english: "coarse mouth", rank: 2 },
} as const;

export const TIER_ORDER: readonly IntensityTier[] = ["clean", "salty", "coarse"];

export const tierRank = (t: IntensityTier): number => TIERS[t].rank;

/**
 * Who it is pointed at. This, not `tier`, is where the harassment risk lives:
 * a repeated `seat`-aimed barb is bullying at any tier, and a `luck`-aimed
 * obscenity is just mahjong. The send rules key off this (EXPRESSIONS.md §8).
 */
export type ExpressionAim =
  /** At yourself. Always permitted. */
  | "self"
  /** At the tiles, the wall, the wind, fate. Always permitted. */
  | "luck"
  /** To the room, nobody in particular. Always permitted. */
  | "table"
  /** At one named seat. Licensed only in the windows §8 defines. */
  | "seat";

/** How aggressive the ACT is, independent of the words. */
export type SocialEdge = "warm" | "neutral" | "barbed";

/** The beat in the hand this belongs to. Drives the wheel's context page. */
export type ExpressionMoment =
  | "win"
  | "dealIn"
  | "nearMiss"
  | "longWait"
  | "othersLuck"
  | "impatience"
  | "congratulation"
  | "sarcasm"
  | "resignation"
  | "accusation"
  | "lobby";

/**
 * How a player comes to own an expression. DESIGN.md §1: cosmetics are
 * earned by playing, never a randomised paid pull. Every milestone here is
 * deterministic and published — a player can read the list and go get it.
 * Evaluating milestones is a PLATFORM concern reading match summaries; the
 * engine never sees these strings.
 */
export type UnlockRule =
  | { kind: "starter" }
  | { kind: "milestone"; id: string; describe: string };

export interface ExpressionDef {
  /** Stable, never displayed. What crosses the wire. */
  id: string;
  /** Cantonese characters. Leads the bubble, per DESIGN.md §7. */
  characters: string;
  jyutping: string;
  /** Word for word, however daft it sounds. Half the comedy is here. */
  literal: string;
  /** What it actually does socially. This is the subtitle a learner reads. */
  english: string;
  tier: IntensityTier;
  moment: ExpressionMoment;
  alsoFits?: readonly ExpressionMoment[];
  aim: ExpressionAim;
  edge: SocialEdge;
  /** Vocabulary this drills by firing at the moment the word applies. */
  teaches?: readonly TermId[];
  /**
   * What a receiver below this tier sees instead. REQUIRED on every salty
   * and coarse entry; the chain must terminate in a clean entry.
   * `assertSoftenChainsTerminate()` proves it at dev time.
   */
  softenTo?: string;
  unlock: UnlockRule;
  /** Line is in scope for recorded VO (P1). Text bubble ships regardless. */
  voice: boolean;
  /** Per-expression floor on repeats, on top of the shared token bucket. */
  cooldownMs?: number;
  /** Register, provenance, or why this entry is shaped oddly. */
  note?: string;
  /** Author is unsure of tone or register. Blocks ship until reviewed. */
  needsReview?: boolean;
}

/* ── the catalogue ─────────────────────────────────────────────────────── */

export const EXPRESSIONS: readonly ExpressionDef[] = [
  /* ── winning 食糊 ─────────────────────────────────────────────────────
     The win CALL itself (食糊 / 自摸) is not here. A call is an engine event
     rendered by the client; it fires whether or not the player owns any
     expressions and cannot be sent falsely. What lives here is what you say
     AFTER, while collecting. See EXPRESSIONS.md §4. */
  {
    id: "thanksAndPay",
    characters: "多謝夾承惠",
    jyutping: "do1 ze6 gaap3 sing4 wai6",
    literal: "thank you, and that will be — ",
    english: "shopkeeper voice, palm out, while you take their chips",
    tier: "clean",
    moment: "win",
    aim: "table",
    edge: "warm",
    teaches: ["winOnDiscard"],
    unlock: { kind: "starter" },
    voice: true,
    note:
      "承惠 is what a HK shop says when ringing you up. Using it at a mahjong " +
      "table is the joke: your loss is a transaction and I am the cashier. " +
      "The single most requestable line in the set — make it the best VO take.",
  },
  {
    id: "soSorry",
    characters: "唔好意思",
    jyutping: "m4 hou2 ji3 si1",
    literal: "not good meaning",
    english: "\"so sorry about that\" — said by the person least sorry at the table",
    tier: "clean",
    moment: "win",
    alsoFits: ["sarcasm"],
    aim: "table",
    edge: "barbed",
    unlock: { kind: "starter" },
    voice: true,
    note: "Clean language, barbed edge. The clearest case for keeping the two axes apart.",
  },
  {
    id: "slaughterAllThree",
    characters: "大殺三方",
    jyutping: "daai6 saat3 saam1 fong1",
    literal: "great slaughter of three directions",
    english: "everyone pays. Everyone.",
    tier: "clean",
    moment: "win",
    aim: "table",
    edge: "neutral",
    teaches: ["selfDraw"],
    unlock: { kind: "milestone", id: "firstSelfDraw", describe: "Win once on your own draw 自摸" },
    voice: true,
  },
  {
    id: "limitHand",
    characters: "爆棚呀!",
    jyutping: "baau3 paang4 aa3",
    literal: "burst the shelf!",
    english: "limit hand. The ceiling. Pay up.",
    tier: "clean",
    moment: "win",
    aim: "table",
    edge: "neutral",
    teaches: ["limit"],
    unlock: { kind: "milestone", id: "firstLimit", describe: "Win a 13-faan limit hand 爆棚" },
    voice: true,
    note: "Unlocking this on your first limit hand means the word arrives with the feeling.",
  },
  {
    id: "foundTreasure",
    characters: "執到寶",
    jyutping: "zap1 dou2 bou2",
    literal: "picked up a treasure",
    english: "the tile I needed was just lying there",
    tier: "clean",
    moment: "win",
    alsoFits: ["othersLuck"],
    aim: "luck",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: false,
  },
  {
    id: "fedRightToMe",
    characters: "餵到我口",
    jyutping: "wai3 dou3 ngo5 hau2",
    literal: "fed right into my mouth",
    english: "you didn't lose that hand, you catered it",
    tier: "salty",
    moment: "win",
    alsoFits: ["sarcasm"],
    aim: "seat",
    edge: "barbed",
    teaches: ["dealIn"],
    softenTo: "thanksAndPay",
    unlock: { kind: "milestone", id: "winOffDiscardTen", describe: "Win off a discard 食糊 ten times" },
    voice: true,
    cooldownMs: 20000,
  },

  /* ── dealing in 出銃 ─────────────────────────────────────────────────── */
  {
    id: "iDealtIn",
    characters: "出銃",
    jyutping: "ceot1 cung3",
    literal: "fire the gun",
    english: "that was me. I handed it over.",
    tier: "clean",
    moment: "dealIn",
    aim: "self",
    edge: "neutral",
    teaches: ["dealIn"],
    unlock: { kind: "starter" },
    voice: true,
    note:
      "THE most important teaching entry in the file. It is on the starter " +
      "wheel and the client offers it first in the beat after you deal in, " +
      "so the word and the chip loss arrive together. Nobody learns 出銃 " +
      "from a glossary; everybody learns it from the table saying it at them.",
  },
  {
    id: "imDead",
    characters: "死喇",
    jyutping: "sei2 laa3",
    literal: "dead already",
    english: "well, I'm finished",
    tier: "clean",
    moment: "dealIn",
    alsoFits: ["resignation"],
    aim: "self",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "servesMeRight",
    characters: "抵死",
    jyutping: "dai2 sei2",
    literal: "deserve to die",
    english: "serves me right, I knew better",
    tier: "clean",
    moment: "dealIn",
    aim: "self",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: false,
    note: "Self-aimed it is rueful. Aimed at a seat it is gloating — hence aim is fixed to self.",
  },
  {
    id: "threwTheWrongOne",
    characters: "打錯咗",
    jyutping: "daa2 co3 zo2",
    literal: "hit the wrong one",
    english: "I had the safe tile in my hand and threw the other one",
    tier: "clean",
    moment: "dealIn",
    aim: "self",
    edge: "neutral",
    teaches: ["drawAndCut"],
    unlock: { kind: "starter" },
    voice: false,
  },
  {
    id: "drinksOnMe",
    characters: "我請客",
    jyutping: "ngo5 ceng2 haak3",
    literal: "I'm treating",
    english: "apparently tonight is on me",
    tier: "clean",
    moment: "dealIn",
    alsoFits: ["resignation"],
    aim: "table",
    edge: "warm",
    unlock: { kind: "milestone", id: "dealInTwenty", describe: "Deal in 出銃 twenty times. You've earned it." },
    voice: true,
  },
  {
    id: "damnIt",
    characters: "弊喇",
    jyutping: "bai6 laa3",
    literal: "it has gone bad",
    english: "oh hell",
    tier: "salty",
    moment: "dealIn",
    alsoFits: ["nearMiss"],
    aim: "self",
    edge: "neutral",
    softenTo: "aiya",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "ding",
    characters: "頂!",
    jyutping: "ding2",
    literal: "prop / push",
    english: "the one-syllable one you say when the tile lands. Minced 屌.",
    tier: "salty",
    moment: "dealIn",
    alsoFits: ["nearMiss", "longWait"],
    aim: "self",
    edge: "neutral",
    softenTo: "aiya",
    unlock: { kind: "starter" },
    voice: true,
    note: "The polite substitution for 屌 and the softening target for it. Load-bearing in the chain.",
  },
  {
    id: "dingYourLung",
    characters: "頂你個肺",
    jyutping: "ding2 nei5 go3 fai3",
    literal: "prop your lung",
    english: "the famous non-swear swear. Everyone knows what it stands in for.",
    tier: "salty",
    moment: "dealIn",
    alsoFits: ["othersLuck"],
    aim: "seat",
    edge: "barbed",
    softenTo: "aiya",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 20000,
    note:
      "A whole HK generation's compromise: keeps the shape and cadence of the " +
      "obscenity, swaps the object for a lung. Belongs in the salty tier for " +
      "exactly that reason, and it is why the salty tier is the receive default.",
  },
  {
    id: "diu",
    characters: "屌",
    jyutping: "diu2",
    literal: "the verb",
    english: "one syllable, all of it",
    tier: "coarse",
    moment: "dealIn",
    alsoFits: ["nearMiss", "longWait", "othersLuck"],
    aim: "luck",
    edge: "neutral",
    softenTo: "ding",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 8000,
    note:
      "Aim is pinned to luck, never seat. Curse the tiles, not the person — " +
      "see EXPRESSIONS.md §8. Softens to 頂, which is literally what a HK " +
      "player does when their mother walks in.",
  },
  {
    id: "youreKiddingMe",
    characters: "唔係哇屌",
    jyutping: "m4 hai6 waa3 diu2",
    literal: "it isn't so — [expletive]",
    english: "you have got to be kidding me",
    tier: "coarse",
    moment: "dealIn",
    alsoFits: ["othersLuck", "nearMiss"],
    aim: "luck",
    edge: "neutral",
    softenTo: "ding",
    unlock: { kind: "starter" },
    voice: true,
  },

  /* ── near miss ───────────────────────────────────────────────────────── */
  {
    id: "oneTileShort",
    characters: "爭一隻",
    jyutping: "zaang1 jat1 zek3",
    literal: "short by one piece",
    english: "one tile. ONE.",
    tier: "clean",
    moment: "nearMiss",
    aim: "luck",
    edge: "neutral",
    teaches: ["ready"],
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "iWasReady",
    characters: "我聽咗好耐",
    jyutping: "ngo5 ting1 zo2 hou2 noi6",
    literal: "I have been listening a long time",
    english: "I've been ready for six turns, thank you for asking",
    tier: "clean",
    moment: "nearMiss",
    alsoFits: ["longWait"],
    aim: "table",
    edge: "neutral",
    teaches: ["ready"],
    unlock: { kind: "starter" },
    voice: true,
    note:
      "聽 in mahjong is 'listening' for your tile. The literal gloss is the " +
      "whole reason the word is memorable; keep it in the bubble's long-press.",
  },
  {
    id: "youCutMyWin",
    characters: "截糊",
    jyutping: "zit6 wu2",
    literal: "intercept the pot",
    english: "that was MY tile and you knew it",
    tier: "clean",
    moment: "nearMiss",
    alsoFits: ["accusation"],
    aim: "seat",
    edge: "barbed",
    teaches: ["cutTheWin"],
    unlock: { kind: "milestone", id: "beatenToAWin", describe: "Have a win taken off you by an earlier seat" },
    voice: true,
    cooldownMs: 15000,
  },
  {
    id: "lookedRightPastIt",
    characters: "眼大睇過龍",
    jyutping: "ngaan5 daai6 tai2 gwo3 lung4",
    literal: "big eyes looked clean over the dragon",
    english: "it was sitting there and I stared straight through it",
    tier: "clean",
    moment: "nearMiss",
    alsoFits: ["sarcasm"],
    aim: "self",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: false,
  },
  {
    id: "aiya",
    characters: "哎吔",
    jyutping: "aai1 jaa4",
    literal: "— (it is a noise)",
    english: "the all-purpose Cantonese sigh of dismay",
    tier: "clean",
    moment: "nearMiss",
    alsoFits: ["dealIn", "longWait", "resignation"],
    aim: "self",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: true,
    note:
      "The bottom of every soften chain. It has to be, because it fits any " +
      "moment and offends nobody — which is also why it is the first thing " +
      "anyone learns to say in Cantonese.",
  },

  /* ── the long wait ───────────────────────────────────────────────────── */
  {
    id: "neckGrewLong",
    characters: "等到頸都長",
    jyutping: "dang2 dou3 geng2 dou1 coeng4",
    literal: "waited until even my neck got long",
    english: "I have been waiting so long I've evolved",
    tier: "clean",
    moment: "longWait",
    alsoFits: ["impatience"],
    aim: "luck",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "daughterInLaw",
    characters: "做人心抱甚艱難",
    jyutping: "zou6 jan4 sam1 pou5 sam6 gaan1 naan4",
    literal: "being someone's daughter-in-law is terribly hard",
    english: "the operatic sigh of a person enduring. Nobody at this table has it worse than me.",
    tier: "clean",
    moment: "longWait",
    alsoFits: ["resignation"],
    aim: "table",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: true,
    needsReview: true,
    note:
      "Cantonese-opera register, deployed with maximum self-pity. Flagged for " +
      "review: confirm the line reads as comic long-suffering rather than " +
      "actually complaining, and confirm the reading of 心抱 vs 新抱.",
  },
  {
    id: "allJunk",
    characters: "摸極都係廢牌",
    jyutping: "mo1 gik6 dou1 hai6 fai3 paai2",
    literal: "draw to the utmost, still scrap tiles",
    english: "fourteen turns of absolute garbage",
    tier: "clean",
    moment: "longWait",
    aim: "luck",
    edge: "neutral",
    teaches: ["drawAndCut"],
    unlock: { kind: "starter" },
    voice: false,
  },
  {
    id: "myTileIsDead",
    characters: "隻牌死晒",
    jyutping: "zek3 paai2 sei2 saai3",
    literal: "the tile is entirely dead",
    english: "all four are on the table. I'm waiting on a ghost.",
    tier: "clean",
    moment: "longWait",
    alsoFits: ["resignation"],
    aim: "luck",
    edge: "neutral",
    teaches: ["deadTile", "ready"],
    unlock: { kind: "milestone", id: "waitedOnDeadTile", describe: "Be ready 聽牌 on a tile with all four copies visible" },
    voice: true,
    note:
      "Counting discards is the core HK skill (RENDERING.md §4a). This " +
      "expression is the moment a player discovers the skill exists.",
  },
  {
    id: "cantBearToLook",
    characters: "冇眼睇",
    jyutping: "mou5 ngaan5 tai2",
    literal: "have no eyes to watch",
    english: "I can't watch this",
    tier: "clean",
    moment: "longWait",
    alsoFits: ["resignation", "sarcasm"],
    aim: "table",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "handWindIsRotten",
    characters: "手風唔順",
    jyutping: "sau2 fung1 m4 seon6",
    literal: "the hand-wind is not smooth",
    english: "my luck is running against me tonight",
    tier: "clean",
    moment: "longWait",
    alsoFits: ["resignation"],
    aim: "luck",
    edge: "neutral",
    teaches: ["handWind"],
    unlock: { kind: "starter" },
    voice: false,
  },

  /* ── someone else's luck ─────────────────────────────────────────────── */
  {
    id: "youAgain",
    characters: "又係你?!",
    jyutping: "jau6 hai6 nei5",
    literal: "again it is you?!",
    english: "third hand running. THIRD.",
    tier: "clean",
    moment: "othersLuck",
    aim: "seat",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 12000,
  },
  {
    id: "handWindIsHot",
    characters: "手風好順喎",
    jyutping: "sau2 fung1 hou2 seon6 wo3",
    literal: "the hand-wind is running very smooth, huh",
    english: "someone's on a heater and we've all noticed",
    tier: "clean",
    moment: "othersLuck",
    alsoFits: ["congratulation", "sarcasm"],
    aim: "seat",
    edge: "neutral",
    teaches: ["handWind"],
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "immortalsHand",
    characters: "神仙牌",
    jyutping: "san4 sin1 paai2",
    literal: "an immortal's hand",
    english: "no mortal draws like that",
    tier: "clean",
    moment: "othersLuck",
    alsoFits: ["congratulation"],
    aim: "seat",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: false,
  },
  {
    id: "areYouCheating",
    characters: "你出千呀?",
    jyutping: "nei5 ceot1 cin1 aa4",
    literal: "are you working a thousand?",
    english: "the joke accusation. Ninety percent joke.",
    tier: "clean",
    moment: "accusation",
    alsoFits: ["othersLuck"],
    aim: "seat",
    edge: "barbed",
    teaches: ["cheating"],
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 30000,
    note:
      "Long cooldown on purpose. Once is banter; four times in a match is an " +
      "accusation, and the server-authoritative wall makes it a false one.",
  },
  {
    id: "howLucky",
    characters: "好彩",
    jyutping: "hou2 coi2",
    literal: "good colour",
    english: "lucky. Said flat, it means the opposite.",
    tier: "clean",
    moment: "othersLuck",
    alsoFits: ["win", "sarcasm"],
    aim: "table",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: true,
    note: "The softening target for 好撚彩 — the infix comes out and the phrase is intact.",
  },
  {
    id: "veryLuckyIndeed",
    characters: "好撚彩",
    jyutping: "hou2 lan2 coi2",
    literal: "good [expletive infix] colour",
    english: "extremely lucky, expressed with feeling",
    tier: "coarse",
    moment: "othersLuck",
    alsoFits: ["sarcasm"],
    aim: "luck",
    edge: "neutral",
    softenTo: "howLucky",
    unlock: { kind: "starter" },
    voice: true,
    note:
      "The best entry in the file for the teaching argument. Cantonese swears " +
      "by INFIXING into an existing phrase, so 好彩 → 好撚彩 and the softening " +
      "is literally the infix being removed. A player who receives both forms " +
      "over a few sessions learns the mechanic without being taught it.",
  },
  {
    id: "whichIdiotThrewThat",
    characters: "邊個柒頭打呢隻",
    jyutping: "bin1 go3 cat6 tau4 daa2 ni1 zek3",
    literal: "which [expletive]-head threw this one",
    english: "the tile that just cost everyone, and a demand to know whose it was",
    tier: "coarse",
    moment: "othersLuck",
    alsoFits: ["dealIn"],
    aim: "table",
    edge: "barbed",
    softenTo: "whoThrewThat",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 20000,
    note: "Aim is table, not seat — the whole point is the rhetorical question.",
  },
  {
    id: "whoThrewThat",
    characters: "邊個打呢隻?",
    jyutping: "bin1 go3 daa2 ni1 zek3",
    literal: "who threw this one?",
    english: "who did that",
    tier: "clean",
    moment: "othersLuck",
    aim: "table",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: false,
  },

  /* ── impatience ──────────────────────────────────────────────────────── */
  {
    id: "hurryUp",
    characters: "快啲啦",
    jyutping: "faai3 di1 laa1",
    literal: "faster a bit, come on",
    english: "hurry up",
    tier: "clean",
    moment: "impatience",
    aim: "seat",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 15000,
  },
  {
    id: "throwATileBoss",
    characters: "打牌啦大佬",
    jyutping: "daa2 paai2 laa1 daai6 lou2",
    literal: "hit a tile, big brother",
    english: "some time this evening, boss",
    tier: "clean",
    moment: "impatience",
    aim: "seat",
    edge: "barbed",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 15000,
  },
  {
    id: "didYouFallAsleep",
    characters: "瞓着咗呀?",
    jyutping: "fan3 zoek6 zo2 aa4",
    literal: "have you fallen asleep?",
    english: "you still with us",
    tier: "clean",
    moment: "impatience",
    aim: "seat",
    edge: "barbed",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 20000,
  },
  {
    id: "notHomework",
    characters: "打牌唔係做功課",
    jyutping: "daa2 paai2 m4 hai6 zou6 gung1 fo3",
    literal: "playing tiles is not doing homework",
    english: "it's mahjong, not an exam",
    tier: "salty",
    moment: "impatience",
    alsoFits: ["sarcasm"],
    aim: "seat",
    edge: "barbed",
    softenTo: "hurryUp",
    unlock: { kind: "milestone", id: "playedTwentyMatches", describe: "Finish twenty matches" },
    voice: true,
    cooldownMs: 25000,
    note:
      "Salty by edge rather than by vocabulary — the words are spotless and it " +
      "is squarely an insult about someone's pace. Tiering it clean would have " +
      "been technically right and socially wrong.",
    needsReview: true,
  },

  /* ── congratulation ──────────────────────────────────────────────────── */
  {
    id: "wellPlayed",
    characters: "打得好",
    jyutping: "daa2 dak1 hou2",
    literal: "hit it well",
    english: "well played",
    tier: "clean",
    moment: "congratulation",
    aim: "seat",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "cleverOne",
    characters: "叻仔",
    jyutping: "lek1 zai2",
    literal: "clever lad",
    english: "clever boy — warm from a friend, patronising from a rival",
    tier: "clean",
    moment: "congratulation",
    alsoFits: ["sarcasm"],
    aim: "seat",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: true,
    note: "Genuinely ambiguous in real use. Ships as warm; the sarcasm is the sender's problem.",
  },
  {
    id: "iConcede",
    characters: "服咗你",
    jyutping: "fuk6 zo2 nei5",
    literal: "submitted to you",
    english: "alright, you got me",
    tier: "clean",
    moment: "congratulation",
    aim: "seat",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "beautifulHand",
    characters: "靚牌",
    jyutping: "leng3 paai2",
    literal: "pretty tiles",
    english: "that's a lovely hand",
    tier: "clean",
    moment: "congratulation",
    aim: "seat",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: false,
  },
  {
    id: "congratsAndProsper",
    characters: "恭喜發財",
    jyutping: "gung1 hei2 faat3 coi4",
    literal: "congratulations, get rich",
    english: "the New Year greeting, aimed at the person who just took your money",
    tier: "clean",
    moment: "congratulation",
    alsoFits: ["sarcasm"],
    aim: "seat",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: true,
  },

  /* ── sarcasm ─────────────────────────────────────────────────────────── */
  {
    id: "impressive",
    characters: "犀利喎",
    jyutping: "sai1 lei6 wo3",
    literal: "sharp, huh",
    english: "impressive. Delivered flat enough to sting.",
    tier: "clean",
    moment: "sarcasm",
    alsoFits: ["congratulation", "othersLuck"],
    aim: "seat",
    edge: "barbed",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 15000,
  },
  {
    id: "thatsAllowed",
    characters: "咁都得?",
    jyutping: "gam2 dou1 dak1",
    literal: "even that works?",
    english: "that WORKED?",
    tier: "clean",
    moment: "sarcasm",
    alsoFits: ["othersLuck"],
    aim: "table",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "evenThatWorks",
    characters: "咁撚都得?",
    jyutping: "gam2 lan2 dou1 dak1",
    literal: "even [expletive infix] that works?",
    english: "that worked?! Are you SERIOUS?",
    tier: "coarse",
    moment: "sarcasm",
    alsoFits: ["othersLuck"],
    aim: "luck",
    edge: "neutral",
    softenTo: "thatsAllowed",
    unlock: { kind: "starter" },
    voice: true,
    note: "Second infix pair, same mechanic as 好彩 / 好撚彩. Two examples make the pattern visible.",
  },
  {
    id: "teachMeMaster",
    characters: "教吓我啦師傅",
    jyutping: "gaau3 haa5 ngo5 laa1 si1 fu2",
    literal: "give me a lesson, master",
    english: "please, sensei, share your wisdom",
    tier: "clean",
    moment: "sarcasm",
    aim: "seat",
    edge: "barbed",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 25000,
  },
  {
    id: "tsk",
    characters: "唓",
    jyutping: "ce1",
    literal: "— (it is a noise)",
    english: "a single dismissive syllable. Extremely rude for its size.",
    tier: "clean",
    moment: "sarcasm",
    alsoFits: ["othersLuck"],
    aim: "table",
    edge: "barbed",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 12000,
  },
  {
    id: "crossedWires",
    characters: "黐線",
    jyutping: "ci1 sin3",
    literal: "the wires are stuck together",
    english: "that's insane",
    tier: "salty",
    moment: "sarcasm",
    alsoFits: ["othersLuck", "dealIn"],
    aim: "table",
    edge: "neutral",
    softenTo: "thatsAllowed",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "totallyCrossedWires",
    characters: "痴撚線",
    jyutping: "ci1 lan2 sin3",
    literal: "the wires are [expletive infix] stuck together",
    english: "that is absolutely mental",
    tier: "coarse",
    moment: "sarcasm",
    alsoFits: ["othersLuck", "dealIn"],
    aim: "luck",
    edge: "neutral",
    softenTo: "crossedWires",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "eyesOnTheBackOfYourHead",
    characters: "你隻眼生喺後尾枕",
    jyutping: "nei5 zek3 ngaan5 saang1 hai2 hau6 mei1 zam2",
    literal: "your eye grew on the back of your skull",
    english: "are you blind, or facing the wrong way",
    tier: "salty",
    moment: "sarcasm",
    alsoFits: ["accusation"],
    aim: "seat",
    edge: "barbed",
    softenTo: "whoThrewThat",
    unlock: { kind: "milestone", id: "dealtIntoTwice", describe: "Be dealt into twice in one match" },
    voice: true,
    cooldownMs: 25000,
    note: "The finest insult in the set. Long, specific, and impossible to type in a hurry — which is the case for canned.",
  },
  {
    id: "mental",
    characters: "神經病",
    jyutping: "san4 ging1 beng6",
    literal: "nerve disease",
    english: "you're out of your mind",
    tier: "salty",
    moment: "sarcasm",
    aim: "seat",
    edge: "barbed",
    softenTo: "thatsAllowed",
    unlock: { kind: "starter" },
    voice: false,
    cooldownMs: 25000,
    needsReview: true,
    note: "Literal reading is a slur on mental illness. Flagged: decide whether it ships at all.",
  },
  {
    id: "pukGaai",
    characters: "仆街",
    jyutping: "puk1 gaai1",
    literal: "fall face-down in the street",
    english: "the workhorse. Half exclamation, half insult, depending entirely on delivery.",
    tier: "salty",
    moment: "dealIn",
    alsoFits: ["sarcasm", "nearMiss", "othersLuck"],
    aim: "luck",
    edge: "neutral",
    softenTo: "aiya",
    unlock: { kind: "starter" },
    voice: true,
    note:
      "Aim pinned to luck. Seat-aimed 仆街 is a straightforward insult and the " +
      "set does not need one — the barbed seat-aimed slots are already filled " +
      "by phrases that are funnier.",
  },
  {
    id: "hamGaaCaan",
    characters: "冚家鏟",
    jyutping: "ham6 gaa1 caan2",
    literal: "the whole household, shovelled",
    english: "GODDAMMIT. Everyone uses it, nobody means it literally.",
    tier: "coarse",
    moment: "dealIn",
    alsoFits: ["othersLuck", "resignation"],
    aim: "luck",
    edge: "neutral",
    softenTo: "pukGaai",
    unlock: { kind: "starter" },
    voice: true,
    cooldownMs: 20000,
    note:
      "The one entry in tension with the curse-your-luck-not-their-family rule: " +
      "read literally it wishes a family dead. It ships because in actual HK use " +
      "it is a general oath, and its aim is hard-pinned to luck so it can never " +
      "be pointed at a seat. If a reviewer disagrees, cut it — do not soften it.",
    needsReview: true,
  },

  /* ── resignation ─────────────────────────────────────────────────────── */
  {
    id: "forgetIt",
    characters: "算把啦",
    jyutping: "syun3 baa2 laa1",
    literal: "count it and be done",
    english: "forget it, whatever",
    tier: "clean",
    moment: "resignation",
    aim: "self",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "gatherFirewood",
    characters: "落雨收柴",
    jyutping: "lok6 jyu5 sau1 caai4",
    literal: "it's raining — bring the firewood in",
    english: "cut the losses, salvage what's left",
    tier: "clean",
    moment: "resignation",
    aim: "self",
    edge: "neutral",
    unlock: { kind: "milestone", id: "finishLast", describe: "Finish a match in last place" },
    voice: true,
    note: "A proverb about damage control that HK players use for exactly this. Worth teaching.",
  },
  {
    id: "leaveItToHeaven",
    characters: "聽天由命",
    jyutping: "ting1 tin1 jau4 ming6",
    literal: "listen to heaven, follow fate",
    english: "nothing left to decide. Draw and pray.",
    tier: "clean",
    moment: "resignation",
    aim: "luck",
    edge: "neutral",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "wallsDead",
    characters: "流咗局",
    jyutping: "lau4 zo2 guk6",
    literal: "the round has drained away",
    english: "wall's gone. Nobody wins. Deal again.",
    tier: "clean",
    moment: "resignation",
    aim: "table",
    edge: "neutral",
    teaches: ["exhaustiveDraw"],
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "pitiful",
    characters: "陰功囉",
    jyutping: "jam1 gung1 lo1",
    literal: "hidden merit, alas",
    english: "oh, the poor thing. Said about yourself, always.",
    tier: "clean",
    moment: "resignation",
    alsoFits: ["longWait"],
    aim: "self",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: true,
  },
  {
    id: "cantTakeIt",
    characters: "頂唔順",
    jyutping: "ding2 m4 seon6",
    literal: "cannot prop it up any longer",
    english: "I am done. Cooked.",
    tier: "salty",
    moment: "resignation",
    aim: "self",
    edge: "neutral",
    softenTo: "forgetIt",
    unlock: { kind: "starter" },
    voice: true,
  },

  /* ── lobby ───────────────────────────────────────────────────────────── */
  {
    id: "threeShortOne",
    characters: "三缺一",
    jyutping: "saam1 kyut3 jat1",
    literal: "three, missing one",
    english: "we have three. WE NEED A FOURTH.",
    tier: "clean",
    moment: "lobby",
    aim: "table",
    edge: "warm",
    teaches: ["threeShortOne"],
    unlock: { kind: "starter" },
    voice: true,
    note:
      "The oldest recruitment call in Cantonese. Belongs on the room screen, " +
      "not the match scene — and it is the phrase most likely to get shared " +
      "outside the app, which makes it worth having.",
  },
  {
    id: "openTheTable",
    characters: "開枱!",
    jyutping: "hoi1 toi2",
    literal: "open the table",
    english: "let's go",
    tier: "clean",
    moment: "lobby",
    aim: "table",
    edge: "warm",
    unlock: { kind: "starter" },
    voice: true,
  },
];

/* ── wheel and defaults ────────────────────────────────────────────────── */

/**
 * The eight a brand-new player has. Chosen so that every one of them is
 * usable in the first hand, and so that the set covers the whole emotional
 * range at the clean tier — a new player should never feel muzzled, only
 * polite. `iDealtIn` is on here deliberately: see its note.
 */
export const STARTER_WHEEL: readonly string[] = [
  "aiya",
  "iDealtIn",
  "oneTileShort",
  "hurryUp",
  "wellPlayed",
  "howLucky",
  "thanksAndPay",
  "forgetIt",
];

/** How many slots the wheel holds once a player has more than eight. */
export const WHEEL_SLOTS = 8;

/**
 * Shared token bucket, per player per match. Tuned so ordinary loud play is
 * never throttled and only deliberate spam is. `freeAfterHandEndMs` is the
 * reaction window: one send in the beat after a hand ends costs no token,
 * because that beat is when everyone talks at once and a limiter that eats
 * the actual moment has defeated the feature.
 */
export const CHATTER_LIMITS = {
  bucketSize: 4,
  refillMs: 6000,
  minGapMs: 1500,
  perHandCap: 10,
  freeAfterHandEndMs: 3000,
  /** Same id twice inside this window renders once, with a ×N badge. */
  repeatCollapseMs: 30000,
  /** Default per-expression cooldown when the entry does not set its own. */
  defaultCooldownMs: 6000,
} as const;

/** Default room cap. A family room drops it to clean; the LA room raises it. */
export const DEFAULT_ROOM_CAP: IntensityTier = "salty";

/** New-player defaults. The asymmetry is argued in EXPRESSIONS.md §6. */
export const DEFAULT_PLAYER_SETTINGS = {
  send: "clean" as IntensityTier,
  receive: "salty" as IntensityTier,
  /** Text bubbles are on by default; VO is not, because phones are muted. */
  voice: false,
} as const;

/* ── lookups ───────────────────────────────────────────────────────────── */

const BY_ID: ReadonlyMap<string, ExpressionDef> = new Map(
  EXPRESSIONS.map((e) => [e.id, e]),
);

export function expression(id: string): ExpressionDef {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`unknown expression id: ${id}`);
  return found;
}

export const hasExpression = (id: string): boolean => BY_ID.has(id);

/** Everything that fits a moment, primary or secondary. */
export function expressionsFor(moment: ExpressionMoment): readonly ExpressionDef[] {
  return EXPRESSIONS.filter(
    (e) => e.moment === moment || (e.alsoFits?.includes(moment) ?? false),
  );
}

export function atOrBelowTier(tier: IntensityTier): readonly ExpressionDef[] {
  return EXPRESSIONS.filter((e) => tierRank(e.tier) <= tierRank(tier));
}

/**
 * What a receiver actually sees. Walks `softenTo` until the phrase is within
 * the receiver's tier. Returns null only if a chain is broken, which
 * `assertSoftenChainsTerminate()` exists to make impossible — a null here is
 * a bug in this file, and the caller should render nothing rather than guess.
 *
 * NOTE the receiver's tier is applied on the SERVER before the message is put
 * on their socket, not here (EXPRESSIONS.md §8). This function is the shared
 * definition both sides use, so the client can preview what others will see.
 */
export function resolveForReceiver(
  id: string,
  receiveTier: IntensityTier,
): ExpressionDef | null {
  let current: ExpressionDef | undefined = BY_ID.get(id);
  const seen = new Set<string>();
  while (current) {
    if (tierRank(current.tier) <= tierRank(receiveTier)) return current;
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    current = current.softenTo ? BY_ID.get(current.softenTo) : undefined;
  }
  return null;
}

/**
 * The send-side gate. `aimWindowOpen` is the caller's answer to "is this
 * player socially licensed to point something at that seat right now" —
 * EXPRESSIONS.md §8 defines the windows (the seat that just dealt into you,
 * the seat that just won). Outside a window a seat-aimed expression is not
 * refused; the caller re-aims it at the table.
 */
export type SendVerdict = "ok" | "aboveSendTier" | "aboveRoomCap" | "notOwned";

export function checkSend(
  id: string,
  opts: {
    sendTier: IntensityTier;
    roomCap: IntensityTier;
    owned: ReadonlySet<string>;
  },
): SendVerdict {
  const e = expression(id);
  if (!opts.owned.has(id)) return "notOwned";
  if (tierRank(e.tier) > tierRank(opts.sendTier)) return "aboveSendTier";
  if (tierRank(e.tier) > tierRank(opts.roomCap)) return "aboveRoomCap";
  return "ok";
}

export const cooldownFor = (e: ExpressionDef): number =>
  e.cooldownMs ?? CHATTER_LIMITS.defaultCooldownMs;

export const isStarter = (e: ExpressionDef): boolean => e.unlock.kind === "starter";

/* ── authoring invariants ──────────────────────────────────────────────── */

/**
 * Run in a unit test. Everything here is an authoring mistake, not a runtime
 * condition — this file is data, so its correctness is checkable exhaustively.
 */
export function catalogueProblems(): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const e of EXPRESSIONS) {
    if (ids.has(e.id)) problems.push(`duplicate id: ${e.id}`);
    ids.add(e.id);

    if (e.tier !== "clean" && !e.softenTo) {
      problems.push(`${e.id} is ${e.tier} with no softenTo`);
    }
    if (e.softenTo && !BY_ID.has(e.softenTo)) {
      problems.push(`${e.id} softens to unknown id ${e.softenTo}`);
    }
    if (e.softenTo) {
      const target = BY_ID.get(e.softenTo);
      if (target && tierRank(target.tier) >= tierRank(e.tier)) {
        problems.push(`${e.id} softens to ${e.softenTo}, which is not milder`);
      }
    }
    /* The rule from EXPRESSIONS.md §8: obscenity may be aimed at your luck,
       yourself or the room, never at one person. Barbs at a seat are fine —
       in clean or salty language, where they read as needling. */
    if (e.tier === "coarse" && e.aim === "seat") {
      problems.push(`${e.id} is coarse AND seat-aimed — curse your luck, not the player`);
    }
    if (e.aim === "seat" && (e.cooldownMs ?? 0) < 10000 && e.edge === "barbed") {
      problems.push(`${e.id} is a barbed seat-aimed line with a short cooldown`);
    }
    if (resolveForReceiver(e.id, "clean") === null) {
      problems.push(`${e.id} has no path down to the clean tier`);
    }
  }

  for (const id of STARTER_WHEEL) {
    if (!BY_ID.has(id)) problems.push(`STARTER_WHEEL references unknown id ${id}`);
    else if (!isStarter(expression(id))) {
      problems.push(`STARTER_WHEEL contains ${id}, which is not unlock.kind "starter"`);
    }
  }
  if (STARTER_WHEEL.length !== WHEEL_SLOTS) {
    problems.push(`STARTER_WHEEL has ${STARTER_WHEEL.length} entries, WHEEL_SLOTS is ${WHEEL_SLOTS}`);
  }

  const milestones = new Set<string>();
  for (const e of EXPRESSIONS) {
    if (e.unlock.kind !== "milestone") continue;
    if (milestones.has(e.unlock.id)) {
      problems.push(`milestone ${e.unlock.id} unlocks more than one expression`);
    }
    milestones.add(e.unlock.id);
  }

  return problems;
}

/** Entries an HK speaker still has to sign off before launch. */
export const needsReview = (): readonly ExpressionDef[] =>
  EXPRESSIONS.filter((e) => e.needsReview === true);

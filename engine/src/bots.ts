/**
 * 電腦玩家 — the bot policy. Implements DESIGN.md §6 ("Bots — product blocker,
 * not polish") in the priority order that section sets out.
 *
 * The measured texture this file exists to kill: 69% exhaustive draws 流局,
 * zero claims, and "every win a 4+ faan accident" (ENGINE-AUDIT §3). A
 * faan-blind bot races to a ready hand it is not legally allowed to win with,
 * so it never wins and never claims, and the table goes dead.
 *
 *   1. CLAIM LOGIC SERVING A TARGET ROUTE (`claimDecision`). Not "claim more":
 *      claim when the claim serves a route that can still legally pay the
 *      house minimum, and never commit the HK sin of melding into a hand with
 *      no path to it. The faan floor is checked BEFORE speed, always.
 *   2. FAAN-ROUTE STEERING (`assessRoutes` / `chooseRoute`). Ten route
 *      templates — balanced, 對對糊, 混/清一色 in each of the three suits,
 *      字一色, and the desperation Thirteen Orphans 十三么 — scored on faan
 *      against distance. The chosen route biases every discard and every claim.
 *   3. COUNT-BASED DISCARD SAFETY (`discardDanger`). Prefer tiles with more
 *      copies already visible. HK does not bar a player from winning on a tile
 *      they cut earlier, so "they discarded it, it is safe against them" is a
 *      rule this game does not have and no term here encodes it. Danger is
 *      purely "how many copies are unaccounted for, and who at this table could
 *      claim it". The prototype's defence was borrowed from a different rule
 *      family (ENGINE-AUDIT §3) and none of it survives here.
 *   4. OUTS TIEBREAK (`rankDiscards`). `liveTiles` separates otherwise equal
 *      discards. ENGINE-AUDIT §3: the prototype computed outs and then never
 *      used them.
 *
 * NO PRIVILEGED INFORMATION. Every fact the policy reads arrives through
 * `SeatView`, which is the shape DESIGN.md §5.3's `viewFor(seat)` hands a seat
 * socket: own concealed tiles, every face-up meld, every discard, every
 * revealed flower, opponents' hand SIZES, and the wall count. There is no field
 * here a human at the table could not see, and the policy never takes an Action
 * the caller did not offer as legal.
 *
 * DETERMINISM IS NOT OPTIONAL (§5.5 — replay is re-execution). Every tiebreak
 * goes through `cfg.rnd`, which the caller threads from the match seed via
 * `prng` in wall.ts. No Math.random, no Date.now, and no iteration over
 * unordered object keys anywhere in this file: route templates, tile ids and
 * seat order are all fixed arrays. ENGINE-AUDIT records a real bug of exactly
 * this kind — unseeded bot decisions made identical wall seeds diverge — and
 * every decision entry point below calls `cfg.rnd` EXACTLY ONCE so the stream
 * position depends on the number of decisions taken, never on hand contents.
 */
import { feedsSeat, tableThreat, type TableThreat } from "./threat.js";
import {
  DRAGONS_START,
  FLOWERS_START,
  SCORING_KINDS,
  WINDS_START,
  type Action,
  type ClaimOption,
  type Meld,
  type Ruleset,
  type SeatIndex,
  type Suit,
  type TileId,
  type WindIndex,
} from "./types.js";
import {
  counts,
  isFlower,
  isHonour,
  isSuited,
  isTerminalOrHonour,
  flowerSeat,
  suitOf,
} from "./tiles.js";
import { distanceToReady, liveTiles } from "./ready.js";
import { makeChow, makeExposedKong, makePung } from "./melds.js";

/* ── what a bot is allowed to see ──────────────────────────────────────── */

/**
 * The redacted per-seat view (§5.3). Arrays indexed by SeatIndex are public
 * information — melds, flowers and discards are face up — and `handCounts`
 * gives sizes only. The omniscient state never reaches this type.
 */
export interface SeatView {
  seat: SeatIndex;
  dealer: SeatIndex;
  /** 圈 prevailing wind. */
  roundWind: WindIndex;
  /** Seat winds, by seat. Public: everyone can see who sits where. */
  seatWinds: readonly WindIndex[];
  /** Own concealed tiles, sorted, EXCLUDING `drawn`. */
  hand: readonly TileId[];
  /** The tile just drawn, or null when it is not this seat's turn to cut. */
  drawn: TileId | null;
  /** Declared melds by seat. Face up, so every seat's is readable. */
  melds: readonly (readonly Meld[])[];
  /** Revealed 花 by seat. */
  flowers: readonly (readonly TileId[])[];
  /** Discards by seat, in the order they were cut. */
  discards: readonly (readonly TileId[])[];
  /** Concealed tile COUNT per seat — never the tiles. */
  handCounts: readonly number[];
  /** Tiles left to draw. Drives late-hand urgency. */
  wallRemaining: number;
  lastDiscard: { tile: TileId; from: SeatIndex } | null;
}

/** The part of a view that route reasoning needs — real or hypothetical. */
export interface HandShape {
  /** Concealed tiles INCLUDING the drawn tile, if any. */
  concealed: readonly TileId[];
  melds: readonly Meld[];
  flowers: readonly TileId[];
  seatWind: WindIndex;
  roundWind: WindIndex;
  /**
   * 上家's discards — the seat BEFORE you, your only chow source and the
   * owner's route-picking read (2026-08-27): "if the opponent before you is
   * throwing characters, characters are good for you; if they're throwing
   * bamboo, they're GOING for characters and your character supply is cut."
   * Optional: absent (old tests, hypotheticals) degrades every term to 0.
   */
  leftDiscards?: readonly TileId[];
}

/* ── tuning ────────────────────────────────────────────────────────────── */

/**
 * Weights, in one struct so the simulation harness can sweep them without
 * touching the policy. The defaults are the values the harness in
 * test/bots.test.ts measures the reported gate-3 texture at; changing one
 * moves those numbers, which is the point of keeping them here.
 */
export interface BotProfile {
  /** Faan a route pays, per faan, against its distance cost. */
  faanWeight: number;
  /** Distance to a win along the route. The speed term. */
  routeDistanceWeight: number;
  /** Concealed tiles the route would have to throw away. */
  offRouteWeight: number;
  /** Charged to a route that cannot reach the house minimum. The anti-sin. */
  belowMinimumPenalty: number;
  discardDistanceWeight: number;
  discardRouteWeight: number;
  discardSafetyWeight: number;
  /** Deliberately small: outs are a TIEBREAK (§6), not a driver. */
  discardOutsWeight: number;
  /** Distance the hand must gain for a chow/pung to be worth the exposure. */
  claimSpeedGain: number;
  /** How much route value a claim may give up. Claiming always costs 門前清. */
  claimRouteTolerance: number;
  /** Scales claim willingness. 1 is the shipping table. */
  aggression: number;
  /**
   * Opponent awareness (engine/src/threat.ts). 0 = blind, the historical
   * behaviour — and NOTE: the evolve loop mutates multiplicatively, so a 0
   * stays 0; turning the feature on is a human decision, tuning it is not.
   */
  threatSensitivity: number;
  /** Own-strength discount: a big, nearly-ready hand pushes through threat
   * (the owner's rule — "6-10 points, I take more risk"). */
  threatPushValue: number;
  /**
   * 0 = value routes by LINEAR faan (the historical bug: 6 faan reads as 2× a
   * 3-faan hand when the payment table pays ~8×). 1 = value by EXPECTED CHIPS
   * through the ruleset's own payment table. The blend exists for A/B only.
   */
  chipValuation: number;
  /** P(the route completes) per remaining tile of distance — disciplines the
   * exponential payout so "slow huge" does not always beat "fast small". */
  routeDecay: number;
  /** Weight on 上家's feed when scoring a suit-restricted route. */
  leftFeedWeight: number;
  /**
   * THE RACE (owner, 2026-08-27): "if your opponents are moving fast you need
   * to move faster — unless your hand's EV is high enough." Scales how hard
   * table readiness discounts slow routes: effective decay shrinks as the most
   * threatening opponent looks closer to winning, so distant hands lose value
   * in a fast race while a huge nearly-done hand still justifies itself.
   */
  urgencyWeight: number;
  /**
   * SUIT SUPPLY, table-wide (owner): "if the opponent before you is going for
   * sticks you'll have a hard time going for sticks." Beyond the left seat's
   * chow feed: any collector plus visible depletion shrinks a suit's remaining
   * supply, and a suit route is priced down by how contested its suit is.
   */
  suitContestWeight: number;
}

export const DEFAULT_PROFILE: BotProfile = {
  faanWeight: 0.6,
  routeDistanceWeight: 1.0,
  offRouteWeight: 1.2,
  belowMinimumPenalty: 5,
  discardDistanceWeight: 3.0,
  discardRouteWeight: 1.15,
  discardSafetyWeight: 0.45,
  discardOutsWeight: 0.055,
  claimSpeedGain: 1,
  claimRouteTolerance: 1.6,
  aggression: 1,
  threatSensitivity: 0,
  threatPushValue: 0,
  chipValuation: 1,
  // 0.45, not 0.55: on the doubling ladder a claim costs 門前清 (÷2 payout), so
  // a tile of speed must be worth MORE than 2× (1/0.45 ≈ 2.2) or no bot ever
  // claims and the table goes alien-quiet — the texture gate caught exactly
  // that at 0.55. Evolution owns fine-tuning; the default must pass the gate.
  routeDecay: 0.45,
  leftFeedWeight: 0.8,
  urgencyWeight: 0.5,
  suitContestWeight: 0.8,
};

export interface BotConfig {
  ruleset: Ruleset;
  /**
   * Deterministic tiebreak source, threaded from the match seed. Give every
   * seat its own stream so the order seats are polled in cannot couple them.
   */
  rnd: () => number;
  profile?: BotProfile;
}

const profileOf = (cfg: BotConfig): BotProfile => cfg.profile ?? DEFAULT_PROFILE;

/** The table read, taken once per decision — null when every dial that could
 * consume it is off, so the blind configuration stays byte-identical. */
function tableRead(v: SeatView, cfg: BotConfig): TableThreat | null {
  const p = profileOf(cfg);
  return p.threatSensitivity > 0 || p.urgencyWeight > 0 || p.suitContestWeight > 0
    ? tableThreat(v, cfg.ruleset)
    : null;
}

/** Faan this house pays for a pattern, or 0 when it does not play it. */
const faanFor = (r: Ruleset, id: string): number => r.faanTable[id] ?? 0;

/**
 * The one place a choice is made at random. Always consumes exactly one value
 * from the stream, tie or no tie, so the stream position stays a function of
 * the number of decisions rather than of hand contents.
 */
function pickOne<T>(ties: readonly T[], rnd: () => number): T {
  const r = rnd();
  const i = Math.min(ties.length - 1, Math.floor(r * ties.length));
  return ties[i]!;
}

/* ── view helpers ──────────────────────────────────────────────────────── */

/** Own concealed tiles plus the drawn tile. */
export function ownTiles(v: SeatView): TileId[] {
  return v.drawn === null ? [...v.hand] : [...v.hand, v.drawn];
}

export const meldCountOf = (v: SeatView, seat: SeatIndex = v.seat): number =>
  v.melds[seat]!.length;

export function shapeOf(v: SeatView): HandShape {
  return {
    concealed: ownTiles(v),
    melds: v.melds[v.seat]!,
    flowers: v.flowers[v.seat]!,
    seatWind: v.seatWinds[v.seat]!,
    roundWind: v.roundWind,
    leftDiscards: v.discards[(v.seat + 3) % 4]!,
  };
}

/**
 * How well 上家 feeds a suit, in [-1, 1]: their discard share of it, centred on
 * the uniform third. +1 ≈ they shower you with it; -1 ≈ they cut everything
 * BUT it, i.e. they are collecting it themselves and your supply is gone.
 */
/** How contested a suit is, 0-1ish: the strongest declared collector plus the
 * visible depletion of its 36 copies. Sensitive by construction — both inputs
 * are 0 until real evidence (melds, discards) exists. */
export function suitContest(suit: Suit, table: TableThreat): number {
  const ix = suit === "chars" ? 0 : suit === "bamboo" ? 1 : 2;
  let collector = 0;
  for (const t of table.seats) {
    if (t.intentSuit === ix) collector = Math.max(collector, t.intentStrength);
  }
  const depletion = Math.min(1, table.suitDepletion[ix]! / 18);
  return collector * 0.7 + depletion * 0.5;
}

export function leftFeed(shape: HandShape, suit: Suit): number {
  const suited = (shape.leftDiscards ?? []).filter((t) => t < 27);
  if (suited.length < 3) return 0;
  const ix = suit === "chars" ? 0 : suit === "bamboo" ? 1 : 2;
  const share = suited.filter((t) => Math.floor(t / 9) === ix).length / suited.length;
  return Math.max(-1, Math.min(1, (share - 1 / 3) * 3));
}

/**
 * Copies of every scoring tile this seat can account for: own concealed tiles,
 * every discard on the table, and every tile in every declared meld. Feed it to
 * `liveTiles` and to `discardDanger` — it is the whole basis of count-based
 * safety, and it contains nothing hidden.
 */
export function visibleCounts(v: SeatView): number[] {
  const c = counts(ownTiles(v));
  for (let s = 0; s < 4; s++) {
    for (const t of v.discards[s]!) if (t < SCORING_KINDS) c[t]!++;
    for (const m of v.melds[s]!) for (const t of m.tiles) c[t]!++;
  }
  return c;
}

/* ── routes 路線 ───────────────────────────────────────────────────────── */

export type RouteId = "balanced" | "allPungs" | "flush" | "flushPungs" | "honours" | "orphans";

export interface Route {
  id: RouteId;
  /** The suit the hand collects, or null when it does not care. */
  suit: Suit | null;
  /** Targeting 對對糊 — no chow may be claimed and runs are worthless. */
  pungs: boolean;
  /** Targeting 字一色. */
  honoursOnly: boolean;
  /** Targeting Thirteen Orphans 十三么 — 么九 kinds only, fully concealed. */
  orphans: boolean;
}

const SUITS: readonly Suit[] = ["chars", "bamboo", "circles"];

/**
 * The route table, in fixed order (never derived from object keys). Ties break
 * to the earlier entry, so the cheap, fast routes sit first and a bot only
 * commits to a flush when the flush genuinely scores better. 十三么 sits last:
 * it is the desperation route (STRATEGY.md §2) and should never win a tie.
 */
export const ROUTES: readonly Route[] = [
  { id: "balanced", suit: null, pungs: false, honoursOnly: false, orphans: false },
  { id: "allPungs", suit: null, pungs: true, honoursOnly: false, orphans: false },
  ...SUITS.map((s): Route => ({ id: "flush", suit: s, pungs: false, honoursOnly: false, orphans: false })),
  ...SUITS.map((s): Route => ({ id: "flushPungs", suit: s, pungs: true, honoursOnly: false, orphans: false })),
  { id: "honours", suit: null, pungs: true, honoursOnly: true, orphans: false },
  { id: "orphans", suit: null, pungs: false, honoursOnly: false, orphans: true },
];

export const routeKey = (r: Route): string => (r.suit === null ? r.id : `${r.id}:${r.suit}`);

export interface RouteAssessment {
  route: Route;
  key: string;
  /**
   * False when the route is dead: a declared meld already contradicts it, or
   * — for 十三么 only — the hand sits under `ORPHANS_MIN_KINDS`.
   */
  feasible: boolean;
  /** Faan the route pays if it completes, including faan already banked. */
  faan: number;
  /** `faan` plus 自摸, which every route can always reach for. The legality test. */
  attainable: number;
  /** Concealed tiles the route would have to throw away. */
  offRoute: number;
  /**
   * Off-route tiles the hand cannot shed for free. A hand `distance` steps from
   * a win still has `distance` discards to make, and each one can be a stray,
   * so only the strays beyond that count against the route.
   */
  surplus: number;
  /** Distance to a win counting only route-conforming tiles. */
  distance: number;
  score: number;
}

/** 混一色 keeps honours; 清一色 does not; a suitless route keeps everything. */
export function onRoute(r: Route, t: TileId): boolean {
  if (isFlower(t)) return true; // 花 are set aside, never held in hand
  if (r.orphans) return isTerminalOrHonour(t); // 十三么 wants 么九 and nothing else
  if (r.honoursOnly) return isHonour(t);
  if (r.suit === null) return true;
  return isHonour(t) || suitOf(t) === r.suit;
}

/** A declared meld cannot be taken back, so one off-route meld kills a route. */
function meldsFit(r: Route, melds: readonly Meld[]): boolean {
  // 十三么 is concealed BY SHAPE: any declared meld — a 暗槓 included, since
  // four of one kind can never fit one-of-each — leaves no orphans hand to make.
  if (r.orphans && melds.length > 0) return false;
  for (const m of melds) {
    if (r.pungs && m.kind === "chow") return false;
    for (const t of m.tiles) if (!onRoute(r, t)) return false;
  }
  return true;
}

/**
 * Distance to a 對對糊 win: runs do not count, so this replaces
 * `distanceToReady` on the pung routes. Same arithmetic as ready.ts's inner
 * `score` — 8 minus two per set, one per partial, one for the eyes — with
 * triplets and pairs as the only blocks.
 */
export function pungDistance(c: readonly number[], melds = 0): number {
  let triplets = 0;
  let pairs = 0;
  for (let i = 0; i < SCORING_KINDS; i++) {
    const n = c[i]!;
    if (n >= 3) triplets++;
    else if (n === 2) pairs++;
  }
  let sets = melds + triplets;
  if (sets > 4) {
    pairs += sets - 4;
    sets = 4;
  }
  const hasPair = pairs > 0;
  const spare = hasPair ? pairs - 1 : 0;
  const parts = Math.max(0, Math.min(spare, 4 - sets));
  return 8 - 2 * sets - parts - (hasPair ? 1 : 0);
}

/** 么九 kinds in fixed tile-id order — the thirteen that 十三么 hunts. */
const ORPHAN_KINDS: readonly TileId[] = (() => {
  const out: TileId[] = [];
  for (let t = 0; t < SCORING_KINDS; t++) if (isTerminalOrHonour(t)) out.push(t);
  return out;
})();

/**
 * Distance to a Thirteen Orphans 十三么 win, on `distanceToReady`'s scale:
 * -1 complete, 0 ready. The winning 14 hold every 么九 kind once plus a
 * duplicate of one of them, so a hand with `kinds` distinct kinds still needs
 * `13 - kinds` new kinds plus, unless a duplicate is already held, the pair
 * tile: 13 - kinds - (pair ? 1 : 0). Anchors: 13 kinds + pair = -1 (complete);
 * 13 kinds bare = 0 (the famous thirteen-sided wait); 12 kinds + pair = 0.
 * Runs and triplets buy nothing here, which is why this replaces
 * `distanceToReady` on the orphans route the way `pungDistance` does on the
 * pung routes.
 */
export function orphansDistance(c: readonly number[]): number {
  let kinds = 0;
  let hasPair = false;
  for (const k of ORPHAN_KINDS) {
    const n = c[k]!;
    if (n > 0) kinds++;
    if (n >= 2) hasPair = true;
  }
  return 13 - kinds - (hasPair ? 1 : 0);
}

/** 花 faan already banked. Flowers are revealed, so this is never a guess. */
function bonusFaan(shape: HandShape, r: Ruleset): number {
  if (!r.useFlowers) return 0;
  let n = 0;
  let flowers = 0;
  let seasons = 0;
  for (const t of shape.flowers) {
    if (t < FLOWERS_START) continue;
    const season = t >= FLOWERS_START + 4;
    if (season) seasons++;
    else flowers++;
    if (flowerSeat(t) === shape.seatWind) n += faanFor(r, season ? "ownSeason" : "ownFlower");
  }
  if (flowers === 4) n += faanFor(r, "allFlowers");
  if (seasons === 4) n += faanFor(r, "allSeasons");
  // 無花 is deliberately NOT counted. It is real faan, but it is not something
  // a hand can be steered toward — it is a thing that happens to you — and
  // counting it makes every flowerless hand look a faan richer than it is,
  // which is precisely the arithmetic that lets a bot talk itself into the HK
  // sin. It shows up in the final score or not at all.
  return n;
}

/** Copies of a tile committed to a meld as a pung or kong. */
function meldedTriplet(melds: readonly Meld[], tile: TileId): boolean {
  for (const m of melds) if (m.kind !== "chow" && m.tiles[0] === tile) return true;
  return false;
}

/**
 * 門風 / 圈風 / 三元牌 — the positional and dragon faan a route can still
 * collect. A triplet already melded counts outright; two copies in hand count
 * because the third is a normal claim away. Seat wind and round wind are
 * separate awards, so East in the East round collects both off one pung.
 */
function honourMeldFaan(
  r: Route,
  shape: HandShape,
  rules: Ruleset,
  c: readonly number[],
): number {
  let n = 0;
  const reachable = (tile: TileId): boolean =>
    onRoute(r, tile) && (meldedTriplet(shape.melds, tile) || c[tile]! >= 2);
  const seatTile = WINDS_START + shape.seatWind;
  const roundTile = WINDS_START + shape.roundWind;
  if (reachable(seatTile)) n += faanFor(rules, "seatWind");
  if (reachable(roundTile)) n += faanFor(rules, "roundWind");
  for (let d = DRAGONS_START; d < FLOWERS_START; d++) {
    if (reachable(d)) n += faanFor(rules, "dragonPung");
  }
  return n;
}

/** Honour tiles held, melded or concealed — decides 混一色 against 清一色. */
function honoursHeld(shape: HandShape, c: readonly number[]): number {
  let n = 0;
  for (let i = WINDS_START; i < SCORING_KINDS; i++) n += c[i]!;
  for (const m of shape.melds) for (const t of m.tiles) if (isHonour(t)) n++;
  return n;
}

/** 門前清 — nothing claimed from another seat. A 暗槓 keeps the hand concealed. */
export const isConcealedHand = (melds: readonly Meld[]): boolean =>
  melds.every((m) => m.kind === "kong" && m.concealed);

/**
 * Faan the route pays if it completes, NOT counting 自摸 (see `attainableFaan`).
 *
 * 門前清 is in here and it is load-bearing. At a 3-faan minimum the cheapest
 * legal hand in HK is a fast concealed one — 門前清 1 + 自摸 1 + one 花 or a
 * wind pung — and a policy that cannot see that value has no reason to stay
 * concealed and every reason to claim its way into a hand it may not take. It
 * is also the term that makes the claim gate honest: the moment a chow or pung
 * is claimed this faan disappears, and the gate sees the hand get cheaper.
 */
/**
 * What a route is WORTH. chipValuation blends between linear faan (the
 * historical bug: 6 faan read as 2× a 3-faan hand while the doubling ladder
 * pays ~8×) and expected chips: relative payout × P(complete), with
 * P(complete) decaying per remaining tile of distance. Scaled so a floor hand
 * at distance 0 is worth its old linear self — existing weights keep meaning.
 */
function routeValue(
  faan: number, distance: number, rules: Ruleset, profile: BotProfile, urgency: number,
): number {
  const cv = profile.chipValuation;
  if (cv <= 0) return faan;
  const floor = rules.minimumFaan;
  const floorPay = Math.max(1, rules.payment.onDiscard(floor));
  const rel = Math.max(0, rules.payment.onDiscard(Math.min(faan, rules.limitFaan))) / floorPay;
  // THE RACE: the most-ready opponent shrinks the effective decay, so every
  // remaining tile of distance costs more when the table is fast. A huge hand
  // that is nearly done keeps its value; a huge hand far away does not — the
  // owner's "move faster, unless the EV is high enough" in one exponent.
  const decay = Math.max(0.15, profile.routeDecay * (1 - profile.urgencyWeight * urgency));
  const chipEV = floor * rel * Math.pow(decay, Math.max(0, distance));
  return (1 - cv) * faan + cv * chipEV;
}

function routeFaan(r: Route, shape: HandShape, rules: Ruleset, c: readonly number[]): number {
  // 十三么 is a limit hand: the ruleset's one price IS the score — the cap
  // makes flower and wind extras irrelevant — and a house that does not play
  // the pattern prices the route at 0, which kills it in scoring for free.
  if (r.orphans) return faanFor(rules, "thirteenOrphans");
  let n = bonusFaan(shape, rules) + honourMeldFaan(r, shape, rules, c);
  if (isConcealedHand(shape.melds)) n += faanFor(rules, "concealedHand");
  if (r.honoursOnly) {
    // Owner ruling 2026-08-26: 字一色 is all pungs BY DEFINITION and subsumes
    // 對對糊 (patterns.ts) — pricing it on top here over-valued the route by 3.
    return n + faanFor(rules, "allHonours");
  }
  if (r.suit !== null) {
    // One stray honour is a tile the hand can still cut, so read a nearly clean
    // hand as 清一色; anything more is 混一色. Understating here is safe —
    // 混一色 already clears a 3-faan minimum on its own.
    n += honoursHeld(shape, c) <= 1 ? faanFor(rules, "fullFlush") : faanFor(rules, "halfFlush");
  }
  if (r.pungs) n += faanFor(rules, "allPungs");
  else if (r.suit === null) n += faanFor(rules, "allChows");
  return n;
}

/**
 * Score every route against this hand. Melds are fixed, so an off-route meld
 * marks the route infeasible rather than expensive.
 */
export function assessRoutes(
  shape: HandShape,
  rules: Ruleset,
  profile: BotProfile = DEFAULT_PROFILE,
  table: TableThreat | null = null,
): RouteAssessment[] {
  const urgency = table?.max ?? 0;
  const c = counts(shape.concealed);
  const melds = shape.melds.length;
  const out: RouteAssessment[] = [];
  for (const route of ROUTES) {
    let feasible = meldsFit(route, shape.melds);
    let offRoute = 0;
    let keptTiles = 0;
    const kept = new Array<number>(SCORING_KINDS).fill(0);
    for (let i = 0; i < SCORING_KINDS; i++) {
      if (c[i] === 0) continue;
      if (onRoute(route, i)) {
        kept[i] = c[i]!;
        keptTiles += c[i]!;
      } else {
        offRoute += c[i]!;
      }
    }
    let distance: number;
    if (route.orphans) {
      // 十三么 keeps ONE duplicate — the first, the eventual pair — and every
      // further copy is a stray to shed like any off-route tile: a third 東
      // helps this hand no more than a 5筒 does.
      let kinds = 0;
      let orphanTiles = 0;
      for (const k of ORPHAN_KINDS) {
        if (c[k]! > 0) kinds++;
        orphanTiles += c[k]!;
      }
      offRoute += Math.max(0, orphanTiles - kinds - 1);
      distance = orphansDistance(c);
      // THE GATE — the owner's rule (STRATEGY.md §2): "7-8 of the 13 orphans
      // in an otherwise fragmented deal, sometimes just go for it". Under six
      // distinct kinds the route is never eligible, whatever the arithmetic
      // says; at six and over the scoring decides, and the distance tax below
      // holds the route under the other templates until the deal reaches the
      // owner's 7-8, fragmented shape.
      if (kinds < ORPHANS_MIN_KINDS) feasible = false;
    } else {
      // 8 is `distanceToReady`'s ceiling, so it is a sound upper bound and not a
      // guess. A route holding under `MIN_ROUTE_TILES` of the hand is one this
      // policy would never pick — every faan on the table times `faanWeight` is
      // still smaller than the distance it would be paying — and the search
      // behind an exact answer is the most expensive thing in the file.
      distance =
        route.pungs
          ? pungDistance(kept, melds)
          : keptTiles < MIN_ROUTE_TILES
            ? MAX_DISTANCE
            : distanceToReady(kept, melds);
    }
    // Charging every off-route tile double-counts: the restricted distance
    // already rose when those tiles were set aside, and a hand that still owes
    // `distance` draws also owes `distance` discards it can spend on strays.
    // What actually costs the route is the strays it cannot shed in the turns
    // it was going to take anyway.
    const surplus = Math.max(0, offRoute - Math.max(0, distance));
    const faan = routeFaan(route, shape, rules, c);
    const attainable = faan + faanFor(rules, "selfDraw");
    let score =
      routeValue(faan, distance, rules, profile, urgency) * profile.faanWeight -
      distance * profile.routeDistanceWeight * (route.orphans ? ORPHANS_DISTANCE_TAX : 1) -
      surplus * profile.offRouteWeight +
      // 上家 as supply line (owner, 2026-08-27): a suit route lives or dies on
      // whether the seat before you is feeding that suit or hoarding it.
      (route.suit !== null ? leftFeed(shape, route.suit) * profile.leftFeedWeight : 0) -
      // SUIT SUPPLY: a route into a suit the table is eating — a collector
      // declared on it, or a third of its copies already visible — is priced
      // down before any tile is thrown at it.
      (route.suit !== null && table !== null
        ? suitContest(route.suit, table) * profile.suitContestWeight
        : 0);
    // THE ANTI-SIN TERM. A route whose finished hand may not be taken is not a
    // fast route, it is a dead one — DESIGN.md §7's faan-floor applied as
    // steering rather than as a warning. `attainable` is the honest test: 自摸
    // is available to every hand, so a route that still falls short with it is
    // short for good.
    if (attainable < rules.minimumFaan) score -= profile.belowMinimumPenalty;
    if (!feasible) score = Number.NEGATIVE_INFINITY;
    out.push({
      route, key: routeKey(route), feasible, faan, attainable, offRoute, surplus, distance, score,
    });
  }
  return out;
}

/** The route the hand is steering toward. Ties break to the earlier template. */
export function chooseRoute(
  shape: HandShape,
  rules: Ruleset,
  profile: BotProfile = DEFAULT_PROFILE,
  table: TableThreat | null = null,
): RouteAssessment {
  const all = assessRoutes(shape, rules, profile, table);
  let best = all[0]!;
  for (const a of all) if (a.score > best.score) best = a;
  return best;
}

/**
 * The most faan this hand could still legally be worth — the rule-derived
 * faan-floor test of DESIGN.md §7 ("no legal path to N faan" is a fact, not a
 * heuristic). Self-draw is included because it is always available; a hand
 * whose ceiling sits under the minimum can never be taken, so no claim that
 * produces one is ever worth making.
 */
export function faanCeiling(shape: HandShape, rules: Ruleset): number {
  const c = counts(shape.concealed);
  let best = 0;
  for (const route of ROUTES) {
    // 十三么 is excluded: its limit faan are "attainable" from any concealed
    // hand the way a lottery ticket is, and counting them would price every
    // concealed hand at the limit and blunt the floor test this exists for.
    if (route.orphans) continue;
    if (!meldsFit(route, shape.melds)) continue;
    const f = routeFaan(route, shape, rules, c);
    if (f > best) best = f;
  }
  return best + faanFor(rules, "selfDraw");
}

/** True when this hand still has a legal path to the house minimum. */
export const hasFaanPath = (shape: HandShape, rules: Ruleset): boolean =>
  faanCeiling(shape, rules) >= rules.minimumFaan;

/* ── discard safety 出銃 ───────────────────────────────────────────────── */

/**
 * How close a seat looks to a win, from face-up evidence only. Melds on the
 * table are the honest signal; a seat sitting fully concealed is unreadable and
 * gets the base rate.
 */
function seatThreat(v: SeatView, s: SeatIndex): number {
  const melds = v.melds[s]!.length;
  const late = v.wallRemaining < 30 ? 0.2 : 0;
  return 0.35 + 0.45 * melds + late;
}

/**
 * The suit a seat's exposed melds all sit in — a 混一色 / 清一色 read. Null
 * unless there are at least two melds and they agree.
 */
export function flushSuitOf(v: SeatView, s: SeatIndex): Suit | null {
  const melds = v.melds[s]!;
  if (melds.length < 2) return null;
  let suit: Suit | null = null;
  for (const m of melds) {
    for (const t of m.tiles) {
      const st = suitOf(t);
      if (st === "honours") continue;
      if (suit === null) suit = st;
      else if (suit !== st) return null;
    }
  }
  return suit;
}

/** Unseen neighbours that could pair with this tile in a run. */
function chowExposure(t: TileId, visible: readonly number[]): number {
  if (!isSuited(t)) return 0;
  const rank = t % 9;
  let n = 0;
  for (let d = -2; d <= 2; d++) {
    if (d === 0) continue;
    const r = rank + d;
    if (r < 0 || r > 8) continue;
    n += Math.max(0, 4 - visible[t + d]!);
  }
  return n / 8;
}

/**
 * Count-based danger of cutting this tile (§6 requirement 3).
 *
 * The whole model is "how many copies are still unaccounted for, and who could
 * claim it" — more copies visible means fewer in opponents' hands means safer.
 * Nothing here treats an opponent's own earlier discard as safe against them:
 * HK Old Style has no rule locking a player out of a tile they once cut
 * (TERMINOLOGY.md), and the prototype's "defence", which was exactly that rule
 * borrowed from another family, is not reproduced.
 */
export function discardDanger(v: SeatView, t: TileId, visible: readonly number[]): number {
  if (isFlower(t)) return 0;
  // The copy about to be cut is already inside `visible` via our own hand.
  const unaccounted = Math.max(0, 4 - visible[t]!);
  let danger = 0;
  const rightHand = ((v.seat + 1) % 4) as SeatIndex;
  for (let i = 0; i < 4; i++) {
    const s = i as SeatIndex;
    if (s === v.seat) continue;
    const threat = seatThreat(v, s);
    // 碰 / 明槓 — any seat may claim, but only if two copies sit in one hand.
    if (unaccounted >= 2) danger += (unaccounted - 1) * 0.5 * threat;
    // 上 — a chow may only be claimed from 上家, so our discard is chowable by
    // exactly one seat: the one to our right, whose 上家 we are.
    if (s === rightHand && isSuited(t)) danger += chowExposure(t, visible) * 0.5 * threat;
    // A seat whose melds all sit in one suit is collecting that suit and the
    // honours that go with it.
    const fs = flushSuitOf(v, s);
    if (fs !== null && (suitOf(t) === fs || isHonour(t))) danger += 1.1 * threat;
  }
  // 么九 sit at the edge of fewer runs, so they feed fewer hands.
  if (isTerminalOrHonour(t)) danger *= 0.8;
  return danger;
}

/* ── discard choice ────────────────────────────────────────────────────── */

export interface DiscardScore {
  tile: TileId;
  /** Distance to a win with this tile gone. */
  distance: number;
  /** Unseen copies of every tile that would improve the hand. -1 = not computed. */
  outs: number;
  danger: number;
  onRoute: boolean;
  score: number;
}

const distinctAscending = (tiles: readonly TileId[]): TileId[] => {
  const seen = new Array<boolean>(SCORING_KINDS).fill(false);
  for (const t of tiles) if (t < SCORING_KINDS) seen[t] = true;
  const out: TileId[] = [];
  for (let i = 0; i < SCORING_KINDS; i++) if (seen[i]) out.push(i);
  return out;
};

/**
 * Rank every distinct tile in hand as a discard, best first.
 *
 * Two passes on purpose. `distanceToReady` is an unpruned DFS (ready.ts refuses
 * to prune it, and is right to) and `liveTiles` calls it 34 times, so the outs
 * term — a TIEBREAK by §6, not a driver — is only computed for the handful of
 * candidates that could still win the ranking.
 */
export function rankDiscards(v: SeatView, cfg: BotConfig): DiscardScore[] {
  const profile = profileOf(cfg);
  const shape = shapeOf(v);
  const threats = tableRead(v, cfg);
  const chosen = chooseRoute(shape, cfg.ruleset, profile, threats);
  const visible = visibleCounts(v);

  // Opponent awareness (threat.ts). foldFactor rises with the scariest seat
  // and falls with our own strength: a big nearly-ready hand pushes, a small
  // distant one folds — the owner's push/fold rule. Zero-cost when the dial
  // is off: the whole block collapses to 0 and the formula is the old one.
  let foldFactor = 0;
  if (profile.threatSensitivity > 0 && threats !== null) {
    const ownStrength = Math.max(0, 1 - chosen.distance / 4);
    foldFactor = Math.max(0, threats.max - ownStrength * profile.threatPushValue);
  }
  const melds = shape.melds.length;
  const c = counts(shape.concealed);
  const candidates = distinctAscending(shape.concealed);

  // The balanced route keeps every tile, so its route distance is the plain one
  // and there is nothing to compute twice.
  const restricts =
    chosen.route.suit !== null || chosen.route.pungs || chosen.route.honoursOnly ||
    chosen.route.orphans;
  // Cutting a tile the route was never going to use leaves the route's own
  // counts untouched, so every off-route candidate shares one answer. That is
  // usually half the hand, and the search behind it is not cheap.
  const offRouteDistance = restricts ? chosen.distance : 0;

  const scored: DiscardScore[] = candidates.map((tile) => {
    const fitsRoute = onRoute(chosen.route, tile);
    c[tile]!--;
    const distance = distanceToReady(c, melds);
    const routeDistance = !restricts
      ? distance
      : !fitsRoute
        ? offRouteDistance
        : chosen.route.orphans
          ? orphansDistance(c) // reads only 么九 kinds, so the full counts serve
          : chosen.route.pungs
            ? pungDistance(routeCounts(chosen.route, c), melds)
            : distanceToReady(routeCounts(chosen.route, c), melds);
    c[tile]!++;
    const fits = fitsRoute;
    const danger = discardDanger(v, tile, visible);
    let threatDanger = 0;
    if (threats !== null && foldFactor > 0) {
      // Feeding a seat is as bad as their hand is BIG: the payout against you
      // is exponential in their faan (owner: "you don't want to lose really
      // big"). chipsRel is capped so one scary read cannot zero a whole suit.
      for (const t of threats.seats) {
        threatDanger += t.threat * feedsSeat(tile, t) * (Math.min(t.chipsRel, 16) / 4);
      }
    }
    // The plain-hand distance steers the speed term on every route EXCEPT
    // 十三么. The orphans plan builds no sets, so four-sets-and-a-pair
    // distance is not speed for it — worse, it is ANTI-speed, prizing exactly
    // the pairs and partial runs the plan counts as surplus, and at this
    // term's weight it would cut a needed 么九 single to keep a junk pair. On
    // the orphans route the route distance is the speed. `distance` is still
    // reported honestly below.
    const speedDistance = chosen.route.orphans ? routeDistance : distance;
    const score =
      -speedDistance * profile.discardDistanceWeight -
      routeDistance * profile.discardRouteWeight * 0.5 +
      (restricts ? (fits ? -profile.discardRouteWeight : profile.discardRouteWeight) : 0) -
      danger * profile.discardSafetyWeight -
      threatDanger * foldFactor * profile.threatSensitivity;
    return { tile, distance, outs: -1, danger, onRoute: fits, score };
  });

  scored.sort((a, b) => b.score - a.score || a.tile - b.tile);

  // §6 requirement 4: outs break the tie between OTHERWISE EQUAL discards, and
  // only then. `liveTiles` runs the unpruned search 34 times over, so paying
  // for it on candidates that are not tied would be paying for nothing.
  const top = scored[0]!.score;
  const tied = scored.filter((d) => top - d.score < TIE_EPSILON);
  if (tied.length > 1) {
    for (const d of tied) {
      c[d.tile]!--;
      d.outs = liveTiles(c, melds, visible).total;
      c[d.tile]!++;
      d.score += d.outs * profile.discardOutsWeight;
    }
    scored.sort((a, b) => b.score - a.score || a.tile - b.tile);
  }
  return scored;
}

/** Scores this close are the same score; `rnd` or the outs count decides. */
const TIE_EPSILON = 1e-9;

/** `distanceToReady`'s ceiling: nothing in hand, nothing set aside. */
const MAX_DISTANCE = 8;

/**
 * On-route tiles below which a route is not worth an exact distance. Under a
 * third of a hand in the route's own tiles and the route has lost on faan
 * against distance whatever the exact figure turns out to be.
 */
const MIN_ROUTE_TILES = 7;

/**
 * Distinct 么九 kinds below which 十三么 is not assessed at all. The owner's
 * threshold (STRATEGY.md §2) is 7-8; the hard floor sits one under it at six
 * so the marginal cases are decided by SCORING rather than by the gate — in
 * practice `ORPHANS_DISTANCE_TAX` keeps a bare six-kind hand losing to 對對糊
 * on the same junk, and the route starts winning around 7-8 kinds on
 * fragmented deals, which is exactly the owner's rule.
 */
const ORPHANS_MIN_KINDS = 6;

/**
 * 十三么 pays its distance double. A normal route's next step is satisfied by
 * any of several tiles — either end of a run, any third of a pair — where an
 * orphans step is satisfied ONLY by one of the missing 么九 kinds, and the
 * hand banks no partial-set credit on the way. Untaxed, 13 faan at
 * `faanWeight` buys the route out of any distance the gate lets through
 * (13 × 0.6 ≈ 7.8 against a distance of 4-6) and it would win every deal it
 * is eligible on. Taxed, it wins where the owner plays it — orphan-rich AND
 * fragmented — and, because a stalled hunt piles up 么九 pairs, it loses the
 * re-evaluation to 對對糊 the moment those tiles read better as pungs: the
 * owner's own bail path ("pivot into all pungs or terminals").
 */
const ORPHANS_DISTANCE_TAX = 2;

/** Distance to a win along one named route, for the hand as it stands. */
export function routeDistanceOf(shape: HandShape, route: Route): number {
  const c = routeCounts(route, counts(shape.concealed));
  return route.orphans
    ? orphansDistance(c)
    : route.pungs
      ? pungDistance(c, shape.melds.length)
      : distanceToReady(c, shape.melds.length);
}

/** Counts restricted to the tiles a route keeps. */
function routeCounts(r: Route, c: readonly number[]): number[] {
  const kept = new Array<number>(SCORING_KINDS).fill(0);
  for (let i = 0; i < SCORING_KINDS; i++) if (c[i]! > 0 && onRoute(r, i)) kept[i] = c[i]!;
  return kept;
}

/** The tile to cut. Consumes exactly one value from `cfg.rnd`. */
export function chooseDiscard(v: SeatView, cfg: BotConfig): TileId {
  const ranked = rankDiscards(v, cfg);
  const top = ranked[0]!.score;
  const ties = ranked.filter((r) => top - r.score < TIE_EPSILON);
  return pickOne(ties, cfg.rnd).tile;
}

/* ── claims 食糊以外 ───────────────────────────────────────────────────── */

/** The hand a claim would leave behind, for scoring the claim before taking it. */
export function shapeAfterClaim(
  v: SeatView,
  option: ClaimOption,
  tile: TileId,
  from: SeatIndex,
): HandShape | null {
  const hand = [...v.hand];
  const take = (t: TileId): boolean => {
    const i = hand.indexOf(t);
    if (i < 0) return false;
    hand.splice(i, 1);
    return true;
  };
  let meld: Meld;
  try {
    switch (option.kind) {
      case "chow": {
        const withTiles = option.with ?? [];
        if (withTiles.length !== 2) return null;
        for (const t of withTiles) if (!take(t)) return null;
        meld = makeChow([tile, ...withTiles], v.seat, from);
        break;
      }
      case "pung": {
        if (!take(tile) || !take(tile)) return null;
        meld = makePung(tile, v.seat, from);
        break;
      }
      case "kong": {
        if (!take(tile) || !take(tile) || !take(tile)) return null;
        meld = makeExposedKong(tile, v.seat, from);
        break;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
  return {
    concealed: hand,
    melds: [...v.melds[v.seat]!, meld],
    flowers: v.flowers[v.seat]!,
    seatWind: v.seatWinds[v.seat]!,
    roundWind: v.roundWind,
  };
}

/**
 * Distance ALONG THE ROUTE once the claimant has cut a tile, which a chow or a
 * pung forces it to do immediately.
 *
 * Two things this has to get right, and each is a way a naive comparison talks
 * a bot into a bad claim:
 *
 *  - It must discard first. Otherwise the comparison is a 13-tile hand against
 *    a 14-tile one, and every claim on the table looks free.
 *  - It must count only route-conforming tiles, exactly as `RouteAssessment`
 *    does for the hand before the claim. Measured on plain distance, a chow of
 *    circles into a hand of characters reads as progress, because a plain count
 *    does not know the hand has just committed to a suit it cannot fill.
 */
export function bestDistanceAfterDiscard(shape: HandShape, route: Route): number {
  const full = counts(shape.concealed);
  const c = routeCounts(route, full);
  const melds = shape.melds.length;
  const measure = (): number =>
    route.orphans
      ? orphansDistance(c)
      : route.pungs
        ? pungDistance(c, melds)
        : distanceToReady(c, melds);
  // Cutting an off-route tile leaves the route's counts alone, so one
  // measurement covers all of them.
  let best = Number.POSITIVE_INFINITY;
  let offRouteDone = false;
  for (let t = 0; t < SCORING_KINDS; t++) {
    if (full[t]! === 0) continue;
    if (c[t]! === 0) {
      if (offRouteDone) continue;
      offRouteDone = true;
      const d = measure();
      if (d < best) best = d;
      continue;
    }
    c[t]!--;
    const d = measure();
    c[t]!++;
    if (d < best) best = d;
  }
  return best === Number.POSITIVE_INFINITY ? 8 : best;
}

export interface ClaimAssessment {
  option: ClaimOption;
  /**
   * Why a refusal was a refusal. Surfaces in the harness and in teaching UI.
   * `concealedRoute` — the chosen route (十三么) dies with ANY meld, so every
   * chow, pung and kong is refused outright while it is the plan.
   */
  reason: "faanFloor" | "offRoute" | "concealedRoute" | "tooSlow" | "accepted";
  /** Best faan the hand could still be worth once the claim is taken. */
  faanCeiling: number;
  distanceBefore: number;
  distanceAfter: number;
  score: number;
}

/**
 * The claimant's hand as it stands, shared across every option in one claim
 * window so the route search is not repeated per option.
 */
export interface ClaimContext {
  shape: HandShape;
  route: RouteAssessment;
  distance: number;
}

export function claimContext(v: SeatView, cfg: BotConfig): ClaimContext {
  const profile = profileOf(cfg);
  const shape = shapeOf(v);
  const route = chooseRoute(shape, cfg.ruleset, profile, tableRead(v, cfg));
  // The route's own distance, so before and after are measured the same way.
  return { shape, route, distance: route.distance };
}

/**
 * Score one claim. THE HK SIN LIVES HERE (§6 requirement 1): a claim that
 * leaves the hand with no legal path to the house minimum is refused outright,
 * however much speed it buys, because a hand that cannot be taken is not a
 * faster hand — it is a dead one.
 */
export function assessClaim(
  v: SeatView,
  option: ClaimOption,
  cfg: BotConfig,
  context?: ClaimContext,
): ClaimAssessment {
  const profile = profileOf(cfg);
  const last = v.lastDiscard;
  const before = context ?? claimContext(v, cfg);
  const distanceBefore = before.distance;
  const dead: ClaimAssessment = {
    option,
    reason: "faanFloor",
    faanCeiling: 0,
    distanceBefore,
    distanceAfter: distanceBefore,
    score: Number.NEGATIVE_INFINITY,
  };
  if (last === null) return dead;

  // ON THE 十三么 ROUTE, NEVER CHOW, NEVER PUNG, NEVER KONG. One meld and
  // there is no orphans hand left to make — the pattern demands a fully
  // concealed 13 + 1 — so no speed gain can ever pay for the claim. The one
  // exception is the WINNING claim, and that never reaches this function:
  // `decideAction` takes any offered win before claims are assessed. The kind
  // check keeps the exception honest for direct callers anyway.
  if (before.route.route.orphans && option.kind !== "win") {
    return { ...dead, reason: "concealedRoute" };
  }

  const after = shapeAfterClaim(v, option, last.tile, last.from);
  if (after === null) return dead;

  // THE FAAN FLOOR, CHECKED FIRST AND CHECKED CHEAPLY. Everything below this
  // line is about speed, and speed is worth nothing to a hand the table will
  // not let anyone take. Claiming costs 門前清, so this is where a chow into a
  // bare 平糊 dies.
  const ceiling = faanCeiling(after, cfg.ruleset);
  if (ceiling < cfg.ruleset.minimumFaan) return { ...dead, faanCeiling: ceiling };

  // THE COMMITMENT CHECK RUNS IN LINEAR-FAAN UNITS, DELIBERATELY. Chip
  // valuation owns route SELECTION; here the question is "does this claim wreck
  // the plan's SHAPE", and under chip units two things go wrong at once: score
  // magnitudes compress until the fixed tolerance vetoes everything, and the
  // hypothetical post-claim chooseRoute drifts to low-faan balanced routes that
  // then die at the minimum-open gate. Measured: 90% of 4,493 live claim offers
  // were dying here (claimprobe, 2026-08-27). Linear units restore the tuned
  // behaviour; the economics still rule via the floor and speed gates.
  const shapeProfile: BotProfile = { ...profile, chipValuation: 0 };
  const beforeRoute = chooseRoute(before.shape, cfg.ruleset, shapeProfile);
  const afterRoute = chooseRoute(after, cfg.ruleset, shapeProfile);
  // DO NOT OPEN A HAND THAT IS NOT WORTH THE MINIMUM OPEN. `faan` excludes 自摸
  // on purpose: a claim leaving a hand winnable only on its own draw has traded
  // 門前清 away for nothing, which is the HK sin wearing a disguise — and it is
  // exactly what an unguarded ceiling test lets through.
  if (!afterRoute.feasible || afterRoute.faan < cfg.ruleset.minimumFaan) {
    return { ...dead, reason: "offRoute", faanCeiling: ceiling };
  }
  // Claiming always costs 門前清, so a small drop in route value is the price of
  // admission. A large one means the claim is dragging the hand somewhere it
  // was never going.
  if (afterRoute.score < beforeRoute.score - profile.claimRouteTolerance) {
    return { ...dead, reason: "offRoute", faanCeiling: ceiling };
  }

  // Measure both sides along the route the claim commits to. Comparing a
  // balanced hand's distance against a flush hand's is comparing two different
  // games, and it makes every claim look like a step backwards.
  const onRouteBefore = routeDistanceOf(before.shape, afterRoute.route);
  const distanceAfter = bestDistanceAfterDiscard(after, afterRoute.route);
  const gain = onRouteBefore - distanceAfter;
  // A kong 槓 also buys a replacement draw, so it clears a lower bar.
  const bar = option.kind === "kong" ? 0 : profile.claimSpeedGain;
  if (gain < bar * (2 - profile.aggression)) {
    return {
      option,
      reason: "tooSlow",
      faanCeiling: ceiling,
      distanceBefore,
      distanceAfter,
      score: Number.NEGATIVE_INFINITY,
    };
  }
  const score =
    afterRoute.score -
    before.route.score +
    gain * 1.4 * profile.aggression +
    (option.kind === "kong" ? 0.6 : 0) +
    (afterRoute.attainable - cfg.ruleset.minimumFaan) * 0.15;
  return {
    option,
    reason: "accepted",
    faanCeiling: ceiling,
    distanceBefore: onRouteBefore,
    distanceAfter,
    score,
  };
}

/**
 * Pick a claim, or pass. A win is never routed through here — `decideAction`
 * takes a legal win before anything else. Consumes exactly one value from
 * `cfg.rnd`.
 */
export function claimDecision(
  v: SeatView,
  options: readonly ClaimOption[],
  cfg: BotConfig,
): ClaimOption | null {
  const context = claimContext(v, cfg);
  const assessed = options
    .filter((o) => o.kind !== "win")
    .map((o) => assessClaim(v, o, cfg, context))
    .filter((a) => a.reason === "accepted");
  if (assessed.length === 0) {
    cfg.rnd(); // keep the stream aligned with the number of decisions taken
    return null;
  }
  assessed.sort((a, b) => b.score - a.score || claimRank(a.option) - claimRank(b.option));
  const top = assessed[0]!.score;
  const ties = assessed.filter((a) => top - a.score < TIE_EPSILON);
  return pickOne(ties, cfg.rnd).option;
}

/** Deterministic ordering for equal-scoring claims: the bigger set first. */
const claimRank = (o: ClaimOption): number =>
  o.kind === "kong" ? 0 : o.kind === "pung" ? 1 : o.kind === "chow" ? 2 : 3;

/* ── own-turn kongs 槓 ─────────────────────────────────────────────────── */

/**
 * Whether to lay down a 暗槓 or a 加槓 on your own turn.
 *
 * A kong is not free: it fixes four copies into one set slot, and a 加槓 opens
 * a 搶槓 window on the tile (melds.ts `opensRobKongWindow`). Take it when the
 * shape does not get worse and the hand still has a faan path; skip the 加槓
 * when an opponent looks close enough to rob it.
 */
export function shouldKong(
  v: SeatView,
  tile: TileId,
  form: "concealed" | "added",
  cfg: BotConfig,
): boolean {
  const shape = shapeOf(v);
  if (!hasFaanPath(shape, cfg.ruleset)) return false;
  const route = chooseRoute(shape, cfg.ruleset, profileOf(cfg), tableRead(v, cfg));
  // A kong opens a meld slot and 十三么 dies with it — even a 暗槓, since four
  // of one kind can never fit one-of-each. Every 么九 tile is `onRoute` for
  // the orphans plan, so without this check the next test would wave it in.
  if (route.route.orphans) return false;
  if (!onRoute(route.route, tile)) return false;
  const melds = shape.melds.length;
  const c = counts(shape.concealed);
  const before = distanceToReady(c, melds);
  if (form === "concealed") {
    // The four copies leave the concealed hand and become one fixed set.
    c[tile]! -= 4;
    const after = distanceToReady(c, melds + 1);
    c[tile]! += 4;
    if (after > before) return false;
  } else {
    // 加槓 moves one tile out of hand onto a set that is already there, so the
    // shape can only improve or stay level — the cost is the rob window.
    const exposed = Math.max(...v.melds.map((m, s) => (s === v.seat ? 0 : m.length)));
    if (exposed >= 2 && v.wallRemaining < 60) return false;
  }
  return true;
}

/* ── the entry point ───────────────────────────────────────────────────── */

/**
 * Choose from the actions the caller has already ruled legal. A bot is a player
 * whose input is a function call (§6): same Action union, same legality checks,
 * no privileged information, and no way to invent a move the table did not
 * offer.
 *
 * @param legal every Action this seat may take right now, from the reducer
 * @throws when handed an empty list — that is a caller bug, not a pass
 */
export function decideAction(
  v: SeatView,
  legal: readonly Action[],
  cfg: BotConfig,
): Action {
  if (legal.length === 0) throw new Error(`seat ${v.seat} was asked to act with no legal action`);

  // 1. A legal win is always taken. Legality already carries the faan minimum,
  //    so anything offered here is a hand the table will pay out.
  for (const a of legal) if (a.type === "declareWin") return a;
  for (const a of legal) if (a.type === "claim" && a.option.kind === "win") return a;

  // 2. Claim window. Only reached when someone else's discard is on the table.
  const claims = legal.filter(
    (a): a is Extract<Action, { type: "claim" }> => a.type === "claim",
  );
  if (claims.length > 0) {
    const picked = claimDecision(v, claims.map((a) => a.option), cfg);
    if (picked !== null) {
      const match = claims.find(
        (a) => a.option.kind === picked.kind && sameWith(a.option, picked),
      );
      if (match) return match;
    }
    const pass = legal.find((a) => a.type === "pass");
    if (pass) return pass;
  }

  // 3. Own turn. Kongs first — a kong that survives `shouldKong` is strictly
  //    worth more than the discard it replaces, because of the replacement draw.
  for (const a of legal) {
    if (a.type === "concealedKong" && shouldKong(v, a.tile, "concealed", cfg)) return a;
  }
  for (const a of legal) {
    if (a.type === "addedKong" && shouldKong(v, a.tile, "added", cfg)) return a;
  }

  // 4. Cut a tile.
  const discards = legal.filter(
    (a): a is Extract<Action, { type: "discard" }> => a.type === "discard",
  );
  if (discards.length > 0) {
    const tile = chooseDiscard(v, cfg);
    const match = discards.find((a) => a.tile === tile);
    if (match) return match;
    return discards[0]!;
  }

  const pass = legal.find((a) => a.type === "pass");
  if (pass) return pass;
  return legal[0]!;
}

const sameWith = (a: ClaimOption, b: ClaimOption): boolean => {
  const x = a.with ?? [];
  const y = b.with ?? [];
  return x.length === y.length && x.every((t, i) => t === y[i]);
};

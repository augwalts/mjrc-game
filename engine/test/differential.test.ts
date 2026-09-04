/**
 * Differential test — engine/src/scoring.ts against ./reference-scorer.ts.
 *
 * DESIGN.md §8 gives the engine two validation harnesses, and names the gap
 * between them: the port-diff harness only reaches the closed-hand LIU subset,
 * and the golden-hand suite is 124 cases written by the same people who wrote
 * the scorer. §4 says the faan table is the part that "destroys credibility
 * instantly" if it is wrong. This is the third harness that closes the gap:
 * thousands of generated hands, scored twice by two implementations that share
 * no code, with every disagreement printed in full.
 *
 * WHAT IS COMPARED, and why not more:
 *   faan and legality       — exactly. There is one right answer.
 *   the award list          — must be one of the reference's OPTIMAL lists. A
 *                             hand can genuinely read several ways for the same
 *                             money; the two scorers break that tie on
 *                             different keys, and a tie is not a defect.
 *   rawFaan / capped        — as an internal invariant of each result (the raw
 *                             total is the sum of the printed breakdown, and
 *                             爆棚 is a clamp), not across implementations,
 *                             because the tie above can move the raw total.
 *
 * GENERATION is seeded from prng(seed) in ../src/wall.ts and therefore
 * reproducible: a failure prints the seed and the hand, and re-running the
 * suite reproduces it exactly. Uniformly random tiles almost never build a
 * flush or an honours hand, so the generator draws from weighted THEMES — one
 * suit, one suit plus honours, honours only, terminals, triplet-heavy,
 * 十三么, 九蓮寶燈 — which is what puts the expensive patterns under test at all.
 *
 * Terminology: ../../TERMINOLOGY.md. Hong Kong Old Style only.
 */
import { describe, expect, it } from "vitest";
import { HKOS_STANDARD, LIU } from "@mjrc/rulesets";
import { score, type WinSituation } from "../src/scoring.js";
import { isLegalMeld } from "../src/melds.js";
import { prng } from "../src/wall.js";
import type { Meld, Ruleset, SeatIndex, TileId, WindIndex } from "../src/types.js";
import { describeHand, referenceScore } from "./reference-scorer.js";

/* ── hand generation ───────────────────────────────────────────────────── */

interface Generated {
  concealed: TileId[];
  melds: Meld[];
  flowers: TileId[];
  winningTile: TileId;
  ctx: WinSituation;
}

const KINDS = 34;
const WINDS_FROM = 27;
const FLOWERS_FROM = 34;

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const chance = (rnd: () => number, p: number): boolean => rnd() < p;

const suitKinds = (suit: number): TileId[] =>
  [0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => suit * 9 + r);
const HONOUR_KINDS: TileId[] = [27, 28, 29, 30, 31, 32, 33];
const SUITED_TERMINALS: TileId[] = [0, 8, 9, 17, 18, 26];
const ALL_KINDS: TileId[] = Array.from({ length: KINDS }, (_, i) => i);
/** The thirteen 么九 kinds, in tile-id order — what 十三么 is built from. */
const ORPHAN_KINDS: TileId[] = [...SUITED_TERMINALS, ...HONOUR_KINDS].sort((a, b) => a - b);

/**
 * Themes exist because uniform random tiles produce a 混一色 roughly never. The
 * repeats are the weights; "any" stays the commonest so ordinary hands are not
 * crowded out by exotica.
 */
type Theme =
  | "any"
  | "oneSuit"
  | "oneSuitPlusHonours"
  | "honours"
  | "terminalsAndHonours"
  | "terminals"
  | "triplets"
  | "orphans"
  | "nineGates";

const THEMES: Theme[] = [
  "any", "any", "any", "any", "any",
  "oneSuit", "oneSuit",
  "oneSuitPlusHonours", "oneSuitPlusHonours",
  "honours",
  "terminalsAndHonours",
  "terminals",
  "triplets", "triplets",
  "orphans",
  "nineGates",
];

function poolFor(theme: Theme, rnd: () => number): { pool: TileId[]; pungBias: number } {
  switch (theme) {
    case "oneSuit":
      return { pool: suitKinds(Math.floor(rnd() * 3)), pungBias: 0.4 };
    case "oneSuitPlusHonours":
      return { pool: [...suitKinds(Math.floor(rnd() * 3)), ...HONOUR_KINDS], pungBias: 0.5 };
    case "honours":
      return { pool: [...HONOUR_KINDS], pungBias: 1 };
    case "terminalsAndHonours":
      return { pool: [...ORPHAN_KINDS], pungBias: 1 };
    case "terminals":
      return { pool: [...SUITED_TERMINALS], pungBias: 1 };
    case "triplets":
      return { pool: [...ALL_KINDS], pungBias: 0.95 };
    default:
      return { pool: [...ALL_KINDS], pungBias: 0.35 };
  }
}

/** One set drawn from the pool, or null when the pool has nothing left to give. */
function drawSet(
  rnd: () => number,
  pool: readonly TileId[],
  avail: number[],
  pungBias: number,
): { tiles: TileId[]; triplet: boolean } | null {
  const inPool = new Set(pool);
  const triplets = pool.filter((k) => avail[k]! >= 3);
  const runs = pool.filter(
    (k) =>
      k < WINDS_FROM &&
      k % 9 <= 6 &&
      inPool.has(k + 1) &&
      inPool.has(k + 2) &&
      avail[k]! >= 1 &&
      avail[k + 1]! >= 1 &&
      avail[k + 2]! >= 1,
  );
  const wantTriplet = chance(rnd, pungBias);
  const order = wantTriplet ? [triplets, runs] : [runs, triplets];
  for (const bucket of order) {
    if (bucket.length === 0) continue;
    const k = pick(rnd, bucket);
    if (bucket === triplets) {
      avail[k] -= 3;
      return { tiles: [k, k, k], triplet: true };
    }
    avail[k] -= 1;
    avail[k + 1] -= 1;
    avail[k + 2] -= 1;
    return { tiles: [k, k + 1, k + 2], triplet: false };
  }
  return null;
}

/** Random bonus tiles, biased towards the cases that actually score. */
function drawFlowers(rnd: () => number): TileId[] {
  if (chance(rnd, 0.35)) return []; // 無花
  if (chance(rnd, 0.12)) return [34, 35, 36, 37]; // 一台花
  if (chance(rnd, 0.12)) return [38, 39, 40, 41];
  const out: TileId[] = [];
  for (let f = FLOWERS_FROM; f < FLOWERS_FROM + 8; f += 1) if (chance(rnd, 0.25)) out.push(f);
  return out;
}

const otherSeat = (rnd: () => number, seat: SeatIndex): SeatIndex =>
  (((seat + 1 + Math.floor(rnd() * 3)) % 4) as SeatIndex);

/** 上家 — the only seat a chow may be claimed from. */
const leftSeat = (seat: SeatIndex): SeatIndex => (((seat + 3) % 4) as SeatIndex);

/**
 * A complete, legal winning hand. Returns null when the random walk paints
 * itself into a corner (a pool with no set left in it); the caller re-rolls.
 */
function generate(rnd: () => number): Generated | null {
  const seat = Math.floor(rnd() * 4) as SeatIndex;
  const seatWind = seat as WindIndex;
  const roundWind = Math.floor(rnd() * 4) as WindIndex;
  const isDealer = seat === 0;
  const theme = pick(rnd, THEMES);

  let all14: TileId[] | null = null;
  let melds: Meld[] = [];
  let handTiles: TileId[] = [];

  if (theme === "orphans") {
    // 十三么 — every 么九 kind once, one of them twice. Never melded.
    all14 = [...ORPHAN_KINDS, pick(rnd, ORPHAN_KINDS)].sort((a, b) => a - b);
    handTiles = all14;
  } else if (theme === "nineGates") {
    // 九蓮寶燈 — 1112345678999 of one suit plus any fourteenth tile of it.
    const base = Math.floor(rnd() * 3) * 9;
    const shape = [
      base, base, base,
      base + 1, base + 2, base + 3, base + 4, base + 5, base + 6, base + 7,
      base + 8, base + 8, base + 8,
    ];
    all14 = [...shape, base + Math.floor(rnd() * 9)].sort((a, b) => a - b);
    handTiles = all14;
  } else {
    const { pool, pungBias } = poolFor(theme, rnd);
    const avail = new Array<number>(KINDS).fill(4);
    const sets: { tiles: TileId[]; triplet: boolean }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const s = drawSet(rnd, pool, avail, pungBias);
      if (s === null) return null;
      sets.push(s);
    }
    const pairable = pool.filter((k) => avail[k]! >= 2);
    if (pairable.length === 0) return null;
    const pairTile = pick(rnd, pairable);
    avail[pairTile] -= 2;

    // How much of the hand was declared. A concealed hand is the commonest
    // shape worth testing, so 0 melds keeps a heavy weight.
    const meldCount = pick(rnd, [0, 0, 0, 1, 1, 2, 2, 3, 4]);
    for (let i = 0; i < meldCount; i += 1) {
      const s = sets[i]!;
      const k = s.tiles[0]!;
      if (!s.triplet) {
        melds.push({ kind: "chow", tiles: [...s.tiles], from: leftSeat(seat), concealed: false });
        continue;
      }
      const canKong = avail[k]! >= 1;
      const form = pick(rnd, canKong
        ? (["pung", "exposedKong", "concealedKong", "addedKong"] as const)
        : (["pung"] as const));
      if (form === "pung") {
        melds.push({ kind: "pung", tiles: [k, k, k], from: otherSeat(rnd, seat), concealed: false });
        continue;
      }
      avail[k] -= 1;
      if (form === "concealedKong") {
        melds.push({ kind: "kong", tiles: [k, k, k, k], from: seat, concealed: true });
      } else if (form === "addedKong") {
        melds.push({
          kind: "kong",
          tiles: [k, k, k, k],
          from: otherSeat(rnd, seat),
          concealed: false,
          addedToPung: true,
        });
      } else {
        melds.push({
          kind: "kong",
          tiles: [k, k, k, k],
          from: otherSeat(rnd, seat),
          concealed: false,
        });
      }
    }
    for (let i = meldCount; i < 4; i += 1) handTiles.push(...sets[i]!.tiles);
    handTiles.push(pairTile, pairTile);
    handTiles.sort((a, b) => a - b);
  }

  // The winning tile is one of the tiles that was still in hand.
  const winningTile = pick(rnd, handTiles);
  const concealed = [...handTiles];
  concealed.splice(concealed.indexOf(winningTile), 1);

  // Situational context, kept internally consistent: a draw and a discard are
  // exclusive, 搶槓 is a claimed tile, 天糊 belongs to the dealer's untouched
  // opening fourteen and 地糊 to a non-dealer on a discard.
  const selfDraw = chance(rnd, 0.5);
  const onKongReplacement = selfDraw && chance(rnd, 0.12);
  const ctx: WinSituation = {
    seat,
    selfDraw,
    from: selfDraw ? null : otherSeat(rnd, seat),
    winningTile,
    roundWind,
    seatWind,
    isDealer,
    robbedKong: !selfDraw && chance(rnd, 0.1),
    onKongReplacement,
    doubleKong: onKongReplacement && chance(rnd, 0.25),
    onLastTile: selfDraw && chance(rnd, 0.08),
    onLastDiscard: !selfDraw && chance(rnd, 0.08),
    heavenly: isDealer && selfDraw && melds.length === 0 && chance(rnd, 0.05),
    earthly: !isDealer && !selfDraw && melds.length === 0 && chance(rnd, 0.05),
  };

  return { concealed, melds, flowers: drawFlowers(rnd), winningTile, ctx };
}

/* ── the comparison ────────────────────────────────────────────────────── */

interface Divergence {
  index: number;
  /**
   * What KIND of disagreement this is — the ids each side awarded that the
   * other did not, plus any faan or legality gap. Thousands of hands hitting
   * one rule produce thousands of divergences with one signature, so the
   * failure message leads with a census of these rather than a wall of hands.
   */
  signature: string;
  report: string;
}

const sortedIds = (ids: readonly string[]): string => [...ids].sort().join(" ");

/** Multiset difference: what is in `a` that `b` does not also account for. */
function missing(a: readonly string[], b: readonly string[]): string[] {
  const left = [...b];
  const out: string[] = [];
  for (const id of a) {
    const at = left.indexOf(id);
    if (at < 0) out.push(id);
    else left.splice(at, 1);
  }
  return out.sort();
}

function compareOne(hand: Generated, ruleset: Ruleset): { signature: string; report: string } | null {
  const { concealed, melds, flowers, winningTile, ctx } = hand;
  const mine = referenceScore(concealed, melds, flowers, winningTile, ctx, ruleset);
  const theirs = score([...concealed], [...melds], [...flowers], winningTile, ctx, ruleset);

  const problems: string[] = [];
  if (theirs.faan !== mine.faan) problems.push(`faan: engine ${theirs.faan}, reference ${mine.faan}`);
  if (theirs.legal !== mine.legal) {
    problems.push(`legal: engine ${theirs.legal}, reference ${mine.legal}`);
  }

  const engineIds = theirs.awards.map((a) => a.id);
  const engineKey = sortedIds(engineIds);
  const matches = mine.optimalAwards.some((ids) => ids.join(" ") === engineKey);
  if (!matches) {
    problems.push(
      `awards: engine [${engineKey}]\n` +
        `        reference optimal readings:\n` +
        mine.optimalAwards.map((ids) => `          [${ids.join(" ")}]`).join("\n"),
    );
  }

  // Internal invariants of the engine's own result, which no tie can excuse.
  const summed = theirs.awards.reduce((n, a) => n + a.faan, 0);
  if (summed !== theirs.rawFaan) {
    problems.push(`engine rawFaan ${theirs.rawFaan} but its breakdown sums to ${summed}`);
  }
  if (theirs.faan !== Math.min(theirs.rawFaan, ruleset.limitFaan)) {
    problems.push(`engine faan ${theirs.faan} is not rawFaan ${theirs.rawFaan} clamped to ${ruleset.limitFaan}`);
  }
  if (theirs.capped !== theirs.rawFaan > ruleset.limitFaan) {
    problems.push(`engine capped flag ${theirs.capped} disagrees with rawFaan ${theirs.rawFaan}`);
  }

  if (problems.length === 0) return null;

  // Pick the reference reading closest to the engine's, so the signature names
  // the rule in dispute rather than an unrelated tie-break.
  let closest = mine.optimalAwards[0] ?? [];
  let distance = Number.POSITIVE_INFINITY;
  for (const ids of mine.optimalAwards) {
    const d = missing(engineIds, ids).length + missing(ids, engineIds).length;
    if (d < distance) {
      distance = d;
      closest = ids;
    }
  }
  const signature = [
    `engine-only [${missing(engineIds, closest).join(" ")}]`,
    `reference-only [${missing(closest, engineIds).join(" ")}]`,
    `faan ${theirs.faan - mine.faan >= 0 ? "+" : ""}${theirs.faan - mine.faan}`,
    theirs.legal === mine.legal ? "" : `legal ${theirs.legal} vs ${mine.legal}`,
  ].filter((s) => s !== "").join("  ");

  const report = [
    describeHand(concealed, melds, flowers, winningTile, ctx, ruleset),
    `engine    ${theirs.faan} faan (raw ${theirs.rawFaan}${theirs.capped ? ", 爆棚" : ""}), legal ${theirs.legal}`,
    `          [${engineKey}]`,
    `reference ${mine.faan} faan (raw ${mine.rawFaan}${mine.capped ? ", 爆棚" : ""}), legal ${mine.legal}`,
    `          [${sortedIds(mine.awards)}]  (${mine.readings} readings)`,
    ...problems.map((p) => `  ! ${p}`),
  ].join("\n");
  return { signature, report };
}

/** Score `count` generated hands both ways and collect everything that differs. */
function sweep(seed: number, count: number, ruleset: Ruleset): {
  scored: number;
  divergences: Divergence[];
} {
  const rnd = prng(seed);
  const divergences: Divergence[] = [];
  let scored = 0;
  let attempts = 0;
  while (scored < count && attempts < count * 20) {
    attempts += 1;
    const hand = generate(rnd);
    if (hand === null) continue;
    scored += 1;
    let found: { signature: string; report: string } | null;
    try {
      found = compareOne(hand, ruleset);
    } catch (e) {
      found = {
        signature: `threw: ${(e as Error).message}`,
        report: [
          describeHand(hand.concealed, hand.melds, hand.flowers, hand.winningTile, hand.ctx, ruleset),
          `  ! threw: ${(e as Error).message}`,
        ].join("\n"),
      };
    }
    if (found !== null) divergences.push({ index: scored, ...found });
  }
  return { scored, divergences };
}

/** The failure message: a census of the rules in dispute, then one hand each. */
function census(divergences: readonly Divergence[], scored: number, ruleset: Ruleset): string {
  const byKind = new Map<string, Divergence[]>();
  for (const d of divergences) {
    const bucket = byKind.get(d.signature);
    if (bucket) bucket.push(d);
    else byKind.set(d.signature, [d]);
  }
  const ranked = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length);
  return [
    `${divergences.length}/${scored} hands disagree under ${ruleset.id}, in ${ranked.length} distinct classes.`,
    "",
    ...ranked.map(([sig, hands]) => `  ${String(hands.length).padStart(5)} x  ${sig}`),
    "",
    ...ranked.slice(0, 6).map(
      ([sig, hands]) => `=== ${hands.length} x ${sig} ===\n${hands[0]!.report}`,
    ),
  ].join("\n");
}

/**
 * ── DISAGREEMENTS ALREADY ADJUDICATED ────────────────────────────────────
 *
 * Every class below is a REAL divergence between the two implementations,
 * found by this sweep and then argued out against the rules rather than
 * papered over by editing the reference to match. They are listed here, in
 * code, so that the sweep can stay green while the defects stay visible — and
 * so that anything NOT on this list fails the build loudly.
 *
 * `verdict` says which side is right. Fixing the engine-side ones means
 * editing engine/src/scoring.ts or rulesets/, both owned elsewhere; this file
 * deliberately does not.
 */
interface Adjudicated {
  /** Which preset the class shows up under; "*" for both. */
  ruleset: string;
  match: RegExp;
  verdict: string;
}

const ADJUDICATED: readonly Adjudicated[] = [
  {
    ruleset: "*",
    match: /^engine-only \[\]  reference-only \[concealedHand\]  faan \+0$/,
    verdict:
      "門前清 on a hand that is concealed BY DEFINITION (十三么, 九蓮寶燈, 天糊, 地糊). " +
      "scoring.ts drops it for every pattern patterns.ts marks `concealedOnly`; the " +
      "catalogue only declares that subsumption for 四暗刻 and 七對子, and its header " +
      "states the opposite ruling for the other four. THE ENGINE IS RIGHT ON THE RULE " +
      "(hk-scoring.ts and the golden limit family both refuse the extra faan) and " +
      "patterns.ts is the file that needs correcting. Payout is unaffected under both " +
      "shipped presets — every concealedOnly pattern is priced at exactly limitFaan, so " +
      "the cap absorbs the faan and only the breakdown differs.",
  },
  {
    ruleset: "liu",
    match:
      /^engine-only \[\]  reference-only \[(concealedHand )?winOnKongReplacement\]  faan (\+0|-1)(  legal false vs true)?$/,
    verdict:
      "槓上開花 is LOST, not subsumed, when a house does not price 槓上槓. " +
      "situationalPatterns writes `if (ctx.doubleKong) push(winByDoubleKong); else if " +
      "(ctx.onKongReplacement) push(winOnKongReplacement)`, so on a 槓上槓 win only the " +
      "double-kong id is ever emitted. LIU has no winByDoubleKong row, the id is dropped " +
      "at pricing, and the hand silently loses a faan it earned. THE REFERENCE IS RIGHT. " +
      "patterns.ts's header names this exact failure mode — 'a pattern the ruleset does " +
      "not play must never subsume one it does' — and gating applySubsumption on " +
      "`enabled` was supposed to prevent it, but the else-if short-circuits before " +
      "subsumption runs. Emit BOTH ids and let applySubsumption drop the replacement " +
      "award only where 槓上槓 is actually priced. This changes real chips: it costs a " +
      "faan, and on a 3-faan hand it turns a legal win into a refused one.",
  },
];

const adjudication = (signature: string, ruleset: Ruleset): string | null => {
  for (const a of ADJUDICATED) {
    if (a.ruleset !== "*" && a.ruleset !== ruleset.id) continue;
    if (a.match.test(signature)) return a.verdict;
  }
  return null;
};

const HANDS = 20000;

/**
 * Fail on anything not already argued out.
 *
 * The second check matters as much as the first: a regression that wiped out,
 * say, 門前清 everywhere would land inside an already-adjudicated class rather
 * than raising a new one, so the tolerated classes are also held to roughly the
 * share of hands they take today. Every class in the table is rare by
 * construction — each needs 十三么, 九蓮寶燈, an opening win, 槓上槓 under a
 * house that does not price it, or a seven-pair shape.
 */
const TOLERATED_SHARE = 0.25;

function assertOnlyAdjudicated(
  divergences: readonly Divergence[],
  scored: number,
  ruleset: Ruleset,
): void {
  const fresh = divergences.filter((d) => adjudication(d.signature, ruleset) === null);
  if (fresh.length > 0) throw new Error(census(fresh, scored, ruleset));
  const share = divergences.length / scored;
  if (share > TOLERATED_SHARE) {
    throw new Error(
      `${divergences.length}/${scored} hands (${(share * 100).toFixed(1)}%) fall into an ` +
        `already-adjudicated class under ${ruleset.id}. Each of those classes is supposed to ` +
        `be rare; a share this high means something new broke inside one of them.\n\n` +
        census(divergences, scored, ruleset),
    );
  }
}

/* ── does the reference itself hold up? ─────────────────────────────────────
 * Two implementations agreeing proves nothing if the second one is a stub, so
 * the reference is pinned against hand-checked cases lifted from the golden
 * families (DESIGN.md §8) BEFORE it is used to judge anything. Cases were
 * chosen to avoid the two places where the golden fixtures and
 * rulesets/src/patterns.ts contradict each other — 門前清 under a hand that is
 * concealed by definition, and whether 小四喜 swallows 門風/圈風 — because
 * those are open rulings, not settled answers to test against.
 */
interface SpotCheck {
  id: string;
  concealed: TileId[];
  melds: Meld[];
  flowers: TileId[];
  winningTile: TileId;
  ctx: WinSituation;
  faan: number;
  awards: string[];
  legal: boolean;
}

const at = (o: Partial<WinSituation> & { seat: SeatIndex; winningTile: TileId }): WinSituation => ({
  selfDraw: false,
  from: null,
  roundWind: 0,
  seatWind: o.seat as unknown as WindIndex,
  isDealer: o.seat === 0,
  ...o,
});

const SPOT_CHECKS: SpotCheck[] = [
  {
    // basic-all-pungs-double-east-dealer — 東 pays twice, once as 門風 and once
    // as 圈風. 蘭 belongs to 南, so it scores nothing and denies 無花.
    id: "double east wind pays twice",
    concealed: [6, 6, 6, 14],
    melds: [
      { kind: "pung", tiles: [27, 27, 27], from: 1, concealed: false },
      { kind: "pung", tiles: [10, 10, 10], from: 2, concealed: false },
      { kind: "pung", tiles: [20, 20, 20], from: 3, concealed: false },
    ],
    flowers: [35],
    winningTile: 14,
    ctx: at({ seat: 0, winningTile: 14 }),
    faan: 5,
    awards: ["allPungs", "seatWind", "roundWind"],
    legal: true,
  },
  {
    // flush-half-mixed-terminals-overlap — 混一色 and 混么九 over the same tiles.
    // The winning 東 completes a PUNG off a discard, so that set is not
    // concealed and 四暗刻 must not fire.
    id: "half flush that is also mixed terminals",
    concealed: [18, 18, 18, 26, 26, 26, 27, 27, 31, 31, 31, 33, 33],
    melds: [],
    flowers: [34],
    winningTile: 27,
    ctx: at({ seat: 2, winningTile: 27, roundWind: 3 }),
    faan: 9,
    awards: ["halfFlush", "allPungs", "mixedTerminals", "dragonPung", "concealedHand"],
    legal: true,
  },
  {
    // honours-big-three-dragons-subsumes-small — 大三元 swallows 小三元 and all
    // three 三元牌 awards.
    id: "big three dragons swallows the pungs it names",
    concealed: [16],
    melds: [
      { kind: "pung", tiles: [31, 31, 31], from: 0, concealed: false },
      { kind: "pung", tiles: [32, 32, 32], from: 2, concealed: false },
      { kind: "pung", tiles: [33, 33, 33], from: 3, concealed: false },
      { kind: "chow", tiles: [3, 4, 5], from: 0, concealed: false },
    ],
    flowers: [],
    winningTile: 16,
    ctx: at({ seat: 1, winningTile: 16 }),
    faan: 9,
    awards: ["bigThreeDragons", "noFlowers"],
    legal: true,
  },
  {
    // kongs-four-concealed-pungs-discard-completes-pung — the discard finishes
    // the fourth triplet, so it was never concealed and this is plain 對對糊.
    id: "a discard-completed triplet is not concealed",
    concealed: [2, 2, 2, 10, 10, 10, 23, 23, 23, 29, 29, 31, 31],
    melds: [],
    flowers: [34],
    winningTile: 29,
    ctx: at({ seat: 2, winningTile: 29 }),
    faan: 5,
    awards: ["allPungs", "seatWind", "concealedHand"],
    legal: true,
  },
  {
    // limit-all-terminals-four-concealed-pungs-caps — two limit hands from
    // different families in one shape, raw 22, paid at 爆棚.
    id: "four concealed triplets stacked on all terminals, capped",
    concealed: [0, 0, 0, 9, 9, 9, 17, 17, 17, 18, 18, 18, 26],
    melds: [],
    flowers: [],
    winningTile: 26,
    ctx: at({ seat: 1, winningTile: 26, selfDraw: true }),
    faan: 13,
    awards: ["fourConcealedPungs", "allTerminals", "selfDraw", "noFlowers"],
    legal: true,
  },
  {
    // flush-full-parse-maximisation — readable as three 234筒 runs for 6, or as
    // triplets for 9. A scorer that takes the first reading fails here.
    id: "the best reading wins, not the first",
    concealed: [19, 19, 19, 20, 20, 20, 21, 21, 21, 22],
    melds: [{ kind: "pung", tiles: [18, 18, 18], from: 0, concealed: false }],
    flowers: [34],
    winningTile: 22,
    ctx: at({ seat: 3, winningTile: 22 }),
    faan: 9,
    awards: ["fullFlush", "allPungs"],
    legal: true,
  },
  {
    // kongs-four-kongs-limit — 十八羅漢 in all three kong forms at once, and it
    // swallows 對對糊 without touching the positional wind faan.
    id: "four kongs, all three forms",
    concealed: [22],
    melds: [
      { kind: "kong", tiles: [0, 0, 0, 0], from: 1, concealed: false },
      { kind: "kong", tiles: [27, 27, 27, 27], from: 2, concealed: true },
      { kind: "kong", tiles: [17, 17, 17, 17], from: 0, concealed: false, addedToPung: true },
      { kind: "kong", tiles: [33, 33, 33, 33], from: 3, concealed: false },
    ],
    flowers: [],
    winningTile: 22,
    ctx: at({ seat: 2, winningTile: 22, selfDraw: true, onKongReplacement: true }),
    faan: 13,
    awards: ["allKongs", "dragonPung", "roundWind", "winOnKongReplacement", "selfDraw", "noFlowers"],
    legal: true,
  },
  {
    // basic-all-chows-melded-chicken — 雞糊. 平糊 alone is 1 and the win is
    // refused, which is the floor working.
    id: "a chicken hand may not be taken",
    concealed: [24, 25, 26, 19, 20, 21, 16],
    melds: [
      { kind: "chow", tiles: [0, 1, 2], from: 3, concealed: false },
      { kind: "chow", tiles: [12, 13, 14], from: 3, concealed: false },
    ],
    flowers: [35],
    winningTile: 16,
    ctx: at({ seat: 0, winningTile: 16 }),
    faan: 1,
    awards: ["allChows"],
    legal: false,
  },
  {
    // honours-all-four-seasons-with-dragon-pung — 一台花 2 plus the seat's own
    // 秋 for 1, on top of a 發 pung. NOTE the id: the catalogue gives a season
    // its own `ownSeason`, while all four golden families write "ownFlower" for
    // both. Same 1 faan either way; the collision is reported, not resolved.
    id: "a full set of seasons plus the seat's own",
    concealed: [4],
    melds: [
      { kind: "pung", tiles: [32, 32, 32], from: 1, concealed: false },
      { kind: "chow", tiles: [0, 1, 2], from: 1, concealed: false },
      { kind: "chow", tiles: [15, 16, 17], from: 1, concealed: false },
      { kind: "chow", tiles: [18, 19, 20], from: 1, concealed: false },
    ],
    flowers: [38, 39, 40, 41],
    winningTile: 4,
    ctx: at({ seat: 2, winningTile: 4 }),
    faan: 4,
    awards: ["dragonPung", "ownSeason", "allSeasons"],
    legal: true,
  },
];

describe("reference scorer — pinned against hand-checked cases", () => {
  it.each(SPOT_CHECKS.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = referenceScore(c.concealed, c.melds, c.flowers, c.winningTile, c.ctx, HKOS_STANDARD);
    expect(sortedIds(r.awards)).toBe(sortedIds(c.awards));
    expect(r.faan).toBe(c.faan);
    expect(r.legal).toBe(c.legal);
  });
});

describe("scoring — differential against an independent reference", () => {
  it("carries a written verdict for every disagreement it tolerates", () => {
    expect(ADJUDICATED.length).toBeGreaterThan(0);
    for (const a of ADJUDICATED) {
      expect(["*", HKOS_STANDARD.id, LIU.id]).toContain(a.ruleset);
      // A one-line shrug is not an adjudication. Say which side is right and why.
      expect(a.verdict.length, `${a.match} has no real verdict`).toBeGreaterThan(200);
    }
  });

  it("generates only legal, well-formed hands", () => {
    const rnd = prng(0x5eed);
    let checked = 0;
    for (let i = 0; i < 800; i += 1) {
      const hand = generate(rnd);
      if (hand === null) continue;
      checked += 1;
      const all = [...hand.concealed, hand.winningTile, ...hand.melds.flatMap((m) => m.tiles)];
      // Fourteen tiles with every kong counted as three, and never a fifth copy.
      const slots = hand.concealed.length + 1 + hand.melds.length * 3;
      expect(slots).toBe(14);
      const seen = new Array<number>(KINDS).fill(0);
      for (const t of all) seen[t] += 1;
      for (let k = 0; k < KINDS; k += 1) expect(seen[k]).toBeLessThanOrEqual(4);
      expect(new Set(hand.flowers).size).toBe(hand.flowers.length);
      expect(hand.flowers.every((f) => f >= FLOWERS_FROM && f < FLOWERS_FROM + 8)).toBe(true);
      for (const meld of hand.melds) expect(isLegalMeld(meld, hand.ctx.seat)).toBe(true);
      // A win is a draw or a claim, never both.
      expect(hand.ctx.selfDraw && hand.ctx.robbedKong === true).toBe(false);
    }
    expect(checked).toBeGreaterThan(700);
  });

  it("covers the patterns worth covering", () => {
    const rnd = prng(0xc0ffee);
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i += 1) {
      const hand = generate(rnd);
      if (hand === null) continue;
      const r = referenceScore(
        hand.concealed, hand.melds, hand.flowers, hand.winningTile, hand.ctx, HKOS_STANDARD,
      );
      for (const id of r.awards) seen.add(id);
    }
    // Every pattern the house plays has to actually turn up, or the sweep below
    // is quietly testing less than it claims. This is the guard against a
    // generator regression making the differential test vacuous.
    for (const id of Object.keys(HKOS_STANDARD.faanTable)) {
      expect(seen, `the theme generator never produced ${id}`).toContain(id);
    }
  });

  it(`agrees with the engine on ${HANDS} hands under hkos-standard`, () => {
    const { scored, divergences } = sweep(0x48_4b_4f_53, HANDS, HKOS_STANDARD);
    expect(scored).toBe(HANDS);
    assertOnlyAdjudicated(divergences, scored, HKOS_STANDARD);
  });

  it(`agrees with the engine on ${HANDS} hands under liu`, () => {
    const { scored, divergences } = sweep(0x4c_49_55_00, HANDS, LIU);
    expect(scored).toBe(HANDS);
    assertOnlyAdjudicated(divergences, scored, LIU);
  });
});

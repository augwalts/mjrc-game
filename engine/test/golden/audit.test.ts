/**
 * Adversarial audit of the golden-hand suite. DESIGN.md §8 makes these 121
 * fixtures the ONLY validation source for exposed melds, kongs, flowers,
 * winds and situational faan — which means a wrong fixture does not fail, it
 * teaches. Nothing had ever checked them.
 *
 * The per-family test files check that a case is a legal fourteen tiles. This
 * file checks the part that actually costs chips: that the expected AWARD LIST
 * and the expected FAAN agree with the shipped catalogue
 * (rulesets/src/patterns.ts) and the shipped price lists
 * (rulesets/src/presets.ts), and that one pattern carries one id everywhere.
 *
 * ── how the known defects are handled ────────────────────────────────────
 * AUDIT.md lists every case this audit found wrong. The fixtures are NOT
 * edited here — another workflow reads them, and a human applies corrections.
 * So each check compares its violation list against an explicit KNOWN_*
 * allowlist rather than against the empty set. That makes the test fail
 * loudly in BOTH directions: a new defect appears, or a listed defect is
 * fixed without striking it off. Emptying an allowlist is the last step of
 * applying a correction.
 *
 * Terminology: ../../../TERMINOLOGY.md. HK only.
 */
import { describe, expect, it } from "vitest";
import { PATTERN_IDS, applySubsumption, enabledPatterns, isPattern, pattern, ruleset } from "@mjrc/rulesets";
import { SCORING_KINDS, type Meld, type TileId } from "../../src/types.js";
import { counts, flowerSeat, isFlower, isRun } from "../../src/tiles.js";
import { leftOf, meldTileCount } from "../../src/melds.js";
import type { GoldenCase } from "./case.js";
import { cases as basic } from "./basic.js";
import { cases as flush } from "./flush.js";
import { cases as honours } from "./honours.js";
import { cases as kongs } from "./kongs.js";
import { cases as limit } from "./limit.js";

interface Entry {
  family: string;
  c: GoldenCase;
}

const FAMILIES: [string, readonly GoldenCase[]][] = [
  ["basic", basic],
  ["flush", flush],
  ["honours", honours],
  ["kongs", kongs],
  ["limit", limit],
];

const ALL: Entry[] = FAMILIES.flatMap(([family, cs]) => cs.map((c) => ({ family, c })));

/** Hand, winning tile and every melded tile — the winner's whole account. */
const allTiles = (c: GoldenCase): TileId[] => [
  ...c.concealed,
  c.winningTile,
  ...c.melds.flatMap((m) => m.tiles),
];

/* ── known defects, from AUDIT.md ────────────────────────────────────────
 * Strike an id off the moment its fixture is corrected; the test will tell
 * you if you forget, and it will tell you if a new one appears. */

/**
 * 正花 is one faan whether the tile is a flower 梅蘭菊竹 (34-37) or a season
 * 春夏秋冬 (38-41), but the catalogue carries TWO ids for it — ownFlower and
 * ownSeason — and the golden suite only ever emits ownFlower. `ownSeason` is
 * dead in patterns.ts as a result, and a scorer cannot satisfy both files.
 */
const KNOWN_SEASON_ID_DEFECTS = [
  "basic-own-flowers-lift-over-floor",
  "honours-dragon-pung-own-flower-and-season",
  "honours-big-three-dragons-added-kong",
  "honours-dealer-scores-no-extra-faan",
  "honours-all-four-seasons-with-dragon-pung",
  "honours-all-eight-bonus-tiles",
];

/**
 * Two LIU cases were written against a description of the LIU variant that the
 * shipped preset contradicts: LIU.useFlowers is true and LIU prices both
 * 無花 and 門前清. Both hold no bonus tile and are fully concealed.
 */
const KNOWN_LIU_BONUS_DEFECTS = [
  "basic-full-flush-liu-seven",
  "honours-liu-concealed-small-three-dragons",
];

/* ── identity ───────────────────────────────────────────────────────────── */

describe("golden audit — case identity", () => {
  it("holds the whole suite with unique, family-prefixed ids", () => {
    expect(ALL.length).toBe(124); // 121 + the three cases completing the limit family's own spec
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    const misfiled: string[] = [];
    for (const { family, c } of ALL) {
      if (seen.has(c.id)) collisions.push(`${c.id} in ${family} and ${seen.get(c.id)}`);
      seen.set(c.id, family);
      if (!c.id.startsWith(`${family}-`)) misfiled.push(`${c.id} is not prefixed "${family}-"`);
    }
    expect(collisions).toEqual([]);
    expect(misfiled).toEqual([]);
  });

  it("names a shipped ruleset preset on every case", () => {
    const unknown = ALL.filter(({ c }) => ruleset(c.ruleset) === undefined).map(({ c }) => c.id);
    expect(unknown).toEqual([]);
  });
});

/* ── award ids ──────────────────────────────────────────────────────────── */

describe("golden audit — award id consistency", () => {
  it("only ever names ids the catalogue defines", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      for (const a of c.expected.awards) if (!isPattern(a)) bad.push(`${c.id}: "${a}"`);
    }
    expect(bad).toEqual([]);
  });

  it("only ever names ids the case's own ruleset prices", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      const r = ruleset(c.ruleset)!;
      for (const a of c.expected.awards) {
        if (!(a in r.faanTable)) bad.push(`${c.id}: ${r.id} does not price "${a}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("uses ONE id per pattern — a season's 正花 is ownSeason, a flower's is ownFlower", () => {
    // A scorer cannot emit ownFlower for 春夏秋冬 to satisfy the fixtures AND
    // ownSeason to satisfy the catalogue. One of the two files has to move.
    const offenders: string[] = [];
    for (const { c } of ALL) {
      const ownFlowers = c.flowers.filter((f) => flowerSeat(f) === c.seatWind && f < 38).length;
      const ownSeasons = c.flowers.filter((f) => flowerSeat(f) === c.seatWind && f >= 38).length;
      const claimedFlower = c.expected.awards.filter((a) => a === "ownFlower").length;
      const claimedSeason = c.expected.awards.filter((a) => a === "ownSeason").length;
      if (claimedFlower !== ownFlowers || claimedSeason !== ownSeasons) offenders.push(c.id);
    }
    expect(offenders).toEqual([]); // D5 applied — seasons emit ownSeason now
  });

  it("leaves no catalogue id unreachable except the ones no preset in the suite plays", () => {
    // sevenPairs and the three suit-dragon hands are absent from BOTH presets
    // on purpose (presets.ts says so). ownSeason is not — it is priced by both
    // and reached by nothing, which is how the id defect above stays invisible.
    const used = new Set(ALL.flatMap(({ c }) => c.expected.awards));
    const unreachable = PATTERN_IDS.filter((id) => !used.has(id));
    // winByDoubleKong: only Wikipedia's table prices 槓上槓; neither shipping
    // preset does, so no fixture may reach it (see kongs.ts contested note).
    expect(unreachable).toEqual(["winByDoubleKong", "sevenPairs", "jadeDragon", "rubyDragon", "pearlDragon"]);
  });
});

/* ── arithmetic ─────────────────────────────────────────────────────────── */

describe("golden audit — faan arithmetic", () => {
  it("prices every award list to exactly the faan the case claims", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      const r = ruleset(c.ruleset)!;
      const raw = c.expected.awards.reduce((n, a) => n + (r.faanTable[a] ?? 0), 0);
      const capped = Math.min(raw, r.limitFaan);
      if (capped !== c.expected.faan) {
        bad.push(`${c.id}: awards price to raw ${raw} → ${capped}, case says ${c.expected.faan}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("applies the 13-faan limit 爆棚 as a clamp, never as a saturating add", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      const r = ruleset(c.ruleset)!;
      if (c.expected.faan > r.limitFaan) bad.push(`${c.id}: ${c.expected.faan} over ${r.limitFaan}`);
    }
    expect(bad).toEqual([]);
  });

  it("sets legal=false on exactly the hands under the minimum", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      const r = ruleset(c.ruleset)!;
      const legal = c.expected.faan >= r.minimumFaan;
      if (legal !== c.expected.legal) {
        bad.push(`${c.id}: ${c.expected.faan} faan vs minimum ${r.minimumFaan} → ${legal}, case says ${c.expected.legal}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/* ── subsumption ────────────────────────────────────────────────────────── */

describe("golden audit — subsumption", () => {
  it("never lists a pattern another listed pattern already pays for", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      const r = ruleset(c.ruleset)!;
      const kept = applySubsumption(c.expected.awards, enabledPatterns(r));
      if (kept.length !== c.expected.awards.length) {
        bad.push(`${c.id}: [${c.expected.awards.join(", ")}] reduces to [${kept.join(", ")}]`);
      }
    }
    expect(bad).toEqual([]);
  });

  it.each([
    ["bigThreeDragons", ["smallThreeDragons", "dragonPung"]],
    ["bigFourWinds", ["smallFourWinds"]],
    ["fullFlush", ["halfFlush"]],
    ["allKongs", ["allPungs"]],
    ["fourConcealedPungs", ["allPungs", "concealedHand"]],
    ["nineGates", ["fullFlush"]],
    ["allHonours", ["halfFlush", "mixedTerminals"]],
    ["allTerminals", ["mixedTerminals"]],
  ] as const)("%s never co-occurs with what it swallows", (big, swallowed) => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      if (!c.expected.awards.includes(big)) continue;
      for (const s of swallowed) {
        if (c.expected.awards.includes(s)) bad.push(`${c.id}: ${big} listed alongside ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps every subsumption claim inside the catalogue's own closure", () => {
    // A case may only omit an award because the catalogue says it is swallowed.
    // This catches a fixture that quietly invents a subsumption of its own.
    const bad: string[] = [];
    for (const id of PATTERN_IDS) {
      for (const s of pattern(id).subsumes) {
        if (!isPattern(s)) bad.push(`${id} subsumes unknown "${s}"`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/* ── bonus tiles 花 ─────────────────────────────────────────────────────── */

describe("golden audit — flowers", () => {
  it("holds only real bonus tiles in `flowers`", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      for (const f of c.flowers) if (!isFlower(f)) bad.push(`${c.id}: tile ${f} is not a bonus tile`);
      if (new Set(c.flowers).size !== c.flowers.length) bad.push(`${c.id}: duplicate bonus tile`);
    }
    expect(bad).toEqual([]);
  });

  it("pays 正花 exactly once per bonus tile matching the seat, and never for another seat's", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      const own = c.flowers.filter((f) => flowerSeat(f) === c.seatWind).length;
      const claimed = c.expected.awards.filter((a) => a === "ownFlower" || a === "ownSeason").length;
      if (own !== claimed) {
        bad.push(`${c.id}: holds ${own} tile(s) of seat ${c.seatWind}, claims ${claimed} 正花`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("pays 一台花 only on a complete set of four", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      const flowers = c.flowers.filter((f) => f < 38).length;
      const seasons = c.flowers.filter((f) => f >= 38).length;
      if (c.expected.awards.includes("allFlowers") !== (flowers === 4)) bad.push(`${c.id}: allFlowers`);
      if (c.expected.awards.includes("allSeasons") !== (seasons === 4)) bad.push(`${c.id}: allSeasons`);
    }
    expect(bad).toEqual([]);
  });

  it("pays 無花 on exactly the hands holding no bonus tile", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      if (c.expected.awards.includes("noFlowers") !== (c.flowers.length === 0)) bad.push(c.id);
    }
    expect(bad).toEqual([]); // D6 applied — both LIU cases now pay 無花
  });
});

/* ── winds ──────────────────────────────────────────────────────────────── */

describe("golden audit — 門風 and 圈風 score independently", () => {
  it("never collapses a doubled wind into one award", () => {
    // East seat in the East round pungs 東: that is TWO awards, not one.
    const doubled = ALL.filter(({ c }) => {
      if (c.seatWind !== c.roundWind) return false;
      const wind = 27 + c.seatWind;
      const inMeld = c.melds.some((m) => m.kind !== "chow" && m.tiles[0] === wind);
      const inHand = counts([...c.concealed, c.winningTile])[wind]! >= 3;
      return inMeld || inHand;
    });
    expect(doubled.length).toBeGreaterThanOrEqual(5);
    const bad: string[] = [];
    for (const { c } of doubled) {
      const hasBoth =
        c.expected.awards.includes("seatWind") && c.expected.awards.includes("roundWind");
      // 小四喜 / 大四喜 hands are the only place the suite ever suppresses them.
      const fourWinds =
        c.expected.awards.includes("smallFourWinds") || c.expected.awards.includes("bigFourWinds");
      if (!hasBoth && !fourWinds) bad.push(c.id);
    }
    expect(bad).toEqual([]);
  });

  it("never pays a wind that is neither the seat's nor the round's", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      const windSets = [
        ...c.melds.filter((m) => m.kind !== "chow" && m.tiles[0]! >= 27 && m.tiles[0]! < 31).map((m) => m.tiles[0]! - 27),
        ...[0, 1, 2, 3].filter((w) => counts([...c.concealed, c.winningTile])[27 + w]! >= 3),
      ];
      if (c.expected.awards.includes("seatWind") && !windSets.includes(c.seatWind)) {
        bad.push(`${c.id}: seatWind with no pung of 座位風`);
      }
      if (c.expected.awards.includes("roundWind") && !windSets.includes(c.roundWind)) {
        bad.push(`${c.id}: roundWind with no pung of 圈風`);
      }
    }
    expect(bad).toEqual([]);
  });
});

/* ── tile and meld legality ─────────────────────────────────────────────── */

function meldError(m: Meld, seat: number): string | null {
  if (m.kind === "kong" && m.tiles.length !== 4) return `kong holds ${m.tiles.length} tiles`;
  if (m.kind !== "kong" && m.tiles.length !== 3) return `${m.kind} holds ${m.tiles.length} tiles`;
  if (m.kind === "chow") {
    if (!isRun(m.tiles[0]!, m.tiles[1]!, m.tiles[2]!)) return "chow is not a run";
    // 上家 only: a chow may be claimed from the seat that plays before yours.
    if (m.from !== leftOf(seat as 0 | 1 | 2 | 3)) return `chow claimed from seat ${m.from}, not 上家 ${leftOf(seat as 0 | 1 | 2 | 3)}`;
  } else {
    if (!m.tiles.every((t) => t === m.tiles[0])) return `${m.kind} holds mixed tiles`;
  }
  if (m.concealed && m.kind !== "kong") return "only a 暗槓 is ever concealed";
  if (m.kind === "kong" && m.concealed && m.from !== seat) return `暗槓 from=${m.from}, owner is ${seat}`;
  if (!(m.kind === "kong" && m.concealed) && m.from === seat) return "claimed from own discard";
  if (m.addedToPung && !(m.kind === "kong" && !m.concealed)) return "addedToPung on a non-加槓";
  return null;
}

describe("golden audit — tile legality", () => {
  it("counts to fourteen with kongs filling one set slot", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      const slots = c.concealed.length + 1 + c.melds.length * 3;
      if (slots !== 14) bad.push(`${c.id}: ${slots} tiles by the 14-count`);
      const physical = c.concealed.length + 1 + c.melds.reduce((n, m) => n + meldTileCount(m), 0);
      const kongs = c.melds.filter((m) => m.kind === "kong").length;
      if (physical !== 14 + kongs) bad.push(`${c.id}: ${physical} physical tiles with ${kongs} kong(s)`);
    }
    expect(bad).toEqual([]);
  });

  it("never uses a fifth copy of any tile", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      const seen = counts(allTiles(c));
      for (let i = 0; i < SCORING_KINDS; i++) if (seen[i]! > 4) bad.push(`${c.id}: ${seen[i]} of tile ${i}`);
    }
    expect(bad).toEqual([]);
  });

  it("keeps 花 out of the hand and scoring tiles out of `flowers`", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      if (allTiles(c).some(isFlower)) bad.push(`${c.id}: a bonus tile is in the hand`);
    }
    expect(bad).toEqual([]);
  });

  it("declares only legal melds — chow from 上家 only, 暗槓 owned by the seat", () => {
    const bad: string[] = [];
    for (const { c } of ALL) {
      for (const m of c.melds) {
        const e = meldError(m, c.seatWind);
        if (e) bad.push(`${c.id}: ${e}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

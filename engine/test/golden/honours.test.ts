/**
 * Structural checks over the honours/winds/dealer/flowers golden family.
 *
 * These do NOT verify faan values — nobody has signed those off yet (§8, every
 * case is `provisional`). What they verify is that each fixture is a real hand
 * and that its award list is internally consistent with the tiles: a family of
 * hand-typed tile ids is exactly where a silent arithmetic slip hides, and a
 * miscounted hand is worse than no case at all.
 */
import { describe, expect, it } from "vitest";
import { counts } from "../../src/tiles.js";
import { isComplete } from "../../src/ready.js";
import {
  DRAGONS_START, FLOWERS_START, SCORING_KINDS, WINDS_START,
  type TileId,
} from "../../src/types.js";
import { assertWellFormed, type GoldenCase } from "./case.js";
import { cases } from "./honours.js";

/** 13-faan limit 爆棚 and 3-faan minimum, DESIGN.md §4. */
const LIMIT_FAAN = 13;
const MINIMUM_FAAN = 3;

/** Every tile in the hand except the kong's uncounted fourth: 14 of them. */
const handTiles = (c: GoldenCase): TileId[] => [
  ...c.concealed,
  c.winningTile,
  ...c.melds.flatMap((meld) => meld.tiles.slice(0, 3)),
];

/** Physical tiles on the table, kongs at their true four, for the 4-copy check. */
const allTiles = (c: GoldenCase): TileId[] => [
  ...c.concealed,
  c.winningTile,
  ...c.melds.flatMap((meld) => meld.tiles),
];

const copies = (c: GoldenCase, tile: TileId): number =>
  allTiles(c).filter((x) => x === tile).length;

/** A wind or dragon can never be a run, so three copies is always a pung or kong. */
const hasTriplet = (c: GoldenCase, tile: TileId): boolean => copies(c, tile) >= 3;
const hasPair = (c: GoldenCase, tile: TileId): boolean => copies(c, tile) === 2;

const tally = (list: readonly string[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const id of list) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
};

const has = (c: GoldenCase, id: string): boolean => c.expected.awards.includes(id);

/** Collects failures so one run reports every bad case, not just the first. */
function check(fn: (c: GoldenCase, fail: (why: string) => void) => void): string[] {
  const failures: string[] = [];
  for (const c of cases) fn(c, (why) => failures.push(`${c.id}: ${why}`));
  return failures;
}

describe("honours golden family — shape", () => {
  it("is 20-25 cases with unique, family-prefixed, kebab-case ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(25);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(check((c, fail) => {
      if (!/^honours-[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) fail("id is not kebab-case honours-*");
    })).toEqual([]);
  });

  it("declares a known ruleset and ships nothing as validated", () => {
    expect(check((c, fail) => {
      if (c.ruleset !== "hkos-standard" && c.ruleset !== "liu") fail(`unknown ruleset ${c.ruleset}`);
      if (!c.provisional) fail("not marked provisional — §8 forbids it");
      if (!c.description.trim()) fail("empty description");
    })).toEqual([]);
  });

  it("passes assertWellFormed — 14 tiles, kongs counting as 3", () => {
    for (const c of cases) assertWellFormed(c);
  });

  it("holds hands that actually complete: four sets and a pair", () => {
    expect(check((c, fail) => {
      if (!isComplete(counts([...c.concealed, c.winningTile]), c.melds.length)) {
        fail("concealed tiles + winning tile do not complete the hand");
      }
      if (handTiles(c).length !== 14) fail(`${handTiles(c).length} scoring tiles, expected 14`);
    })).toEqual([]);
  });

  it("builds legal melds and never a fifth copy of a tile", () => {
    expect(check((c, fail) => {
      for (const meld of c.melds) {
        const [a, b, d, e] = meld.tiles;
        if (meld.kind === "chow") {
          if (meld.tiles.length !== 3 || b !== a! + 1 || d !== a! + 2 || a! >= WINDS_START) {
            fail(`chow ${meld.tiles.join(",")} is not a suited run`);
          }
          if (meld.from !== ((c.seatWind + 3) % 4)) fail("chow claimed from other than 上家");
        }
        if (meld.kind === "pung" && (meld.tiles.length !== 3 || b !== a || d !== a)) {
          fail(`pung ${meld.tiles.join(",")} is not three of a kind`);
        }
        if (meld.kind === "kong" && (meld.tiles.length !== 4 || b !== a || d !== a || e !== a)) {
          fail(`kong ${meld.tiles.join(",")} is not four of a kind`);
        }
        if (meld.concealed && meld.kind !== "kong") fail("only a kong may be concealed");
        // 暗槓 is drawn complete, so its source seat is the owner's own.
        if (meld.concealed && meld.from !== c.seatWind) fail("暗槓 must be sourced from its owner");
        if (!meld.concealed && meld.from === c.seatWind) fail("cannot claim from yourself");
      }
      for (let tile = 0; tile < SCORING_KINDS; tile++) {
        if (copies(c, tile) > 4) fail(`${copies(c, tile)} copies of tile ${tile}`);
      }
    })).toEqual([]);
  });

  it("uses bonus tiles that exist, once each", () => {
    expect(check((c, fail) => {
      for (const f of c.flowers) if (f < FLOWERS_START || f > 41) fail(`${f} is not a bonus tile`);
      if (new Set(c.flowers).size !== c.flowers.length) fail("a bonus tile appears twice");
    })).toEqual([]);
  });

  it("keeps the dealer on the East seat", () => {
    // 莊 always sits 東 for the hand, so the two fields cannot disagree.
    expect(check((c, fail) => {
      if (c.isDealer !== (c.seatWind === 0)) fail("isDealer disagrees with the seat wind");
    })).toEqual([]);
  });
});

describe("honours golden family — awards match the tiles", () => {
  it("respects the 3-faan minimum and the 13-faan limit", () => {
    expect(check((c, fail) => {
      if (c.expected.faan > LIMIT_FAAN) fail(`${c.expected.faan} faan is over the limit`);
      if (c.expected.legal !== c.expected.faan >= MINIMUM_FAAN) fail("legality contradicts the faan");
      if (c.expected.faan > 0 && c.expected.awards.length === 0) fail("faan with no awards");
    })).toEqual([]);
  });

  it("awards 無花 exactly when no bonus tile was drawn", () => {
    expect(check((c, fail) => {
      // The LIU preset may not play bonus tiles at all — see that case's note.
      if (c.ruleset !== "hkos-standard") return;
      if (has(c, "noFlowers") !== (c.flowers.length === 0)) fail("無花 disagrees with the flowers");
    })).toEqual([]);
  });

  it("awards 正花 once per bonus tile belonging to the seat", () => {
    expect(check((c, fail) => {
      // D5 applied: 梅蘭菊竹 (34-37) pay ownFlower, 春夏秋冬 (38-41) pay ownSeason.
      const mine = c.flowers.filter((f) => (f - FLOWERS_START) % 4 === c.seatWind);
      const ownF = mine.filter((f) => f < 38).length;
      const ownS = mine.filter((f) => f >= 38).length;
      const gotF = tally(c.expected.awards).get("ownFlower") ?? 0;
      const gotS = tally(c.expected.awards).get("ownSeason") ?? 0;
      if (gotF !== ownF) fail(`${gotF} ownFlower awards for ${ownF} own flowers`);
      if (gotS !== ownS) fail(`${gotS} ownSeason awards for ${ownS} own seasons`);
      const set = (lo: number) => [0, 1, 2, 3].every((i) => c.flowers.includes(lo + i));
      if (has(c, "allFlowers") !== set(34)) fail("一台花 disagrees with 梅蘭菊竹");
      if (has(c, "allSeasons") !== set(38)) fail("一台花 disagrees with 春夏秋冬");
    })).toEqual([]);
  });

  it("awards 門風 and 圈風 only for a pung or kong of that wind", () => {
    expect(check((c, fail) => {
      // 小四喜 and 大四喜 price the seat and round wind pungs they are built
      // from (patterns.ts), so those awards must vanish inside them.
      const absorbed = has(c, "smallFourWinds") || has(c, "bigFourWinds");
      // A pair of your own wind pays nothing — only a set does.
      const seat = hasTriplet(c, WINDS_START + c.seatWind) && !absorbed;
      const round = hasTriplet(c, WINDS_START + c.roundWind) && !absorbed;
      if (has(c, "seatWind") !== seat) fail("門風 disagrees");
      if (has(c, "roundWind") !== round) fail("圈風 disagrees");
    })).toEqual([]);
  });

  it("resolves 小三元 / 大三元 subsumption", () => {
    expect(check((c, fail) => {
      const dragons = [DRAGONS_START, DRAGONS_START + 1, DRAGONS_START + 2];
      const triplets = dragons.filter((d) => hasTriplet(c, d)).length;
      const pairs = dragons.filter((d) => hasPair(c, d)).length;
      const big = triplets === 3;
      const small = triplets === 2 && pairs === 1;
      if (has(c, "bigThreeDragons") !== big) fail("大三元 disagrees with the tiles");
      if (has(c, "smallThreeDragons") !== small) fail("小三元 disagrees with the tiles");
      const loose = tally(c.expected.awards).get("dragonPung") ?? 0;
      // Both patterns price the dragon pungs they are made of; awarding them
      // again would double-count. Loose dragon pungs survive only outside them.
      if (big && (loose > 0 || has(c, "smallThreeDragons"))) fail("大三元 failed to subsume");
      if (small && loose > 0) fail("小三元 failed to subsume its two dragon pungs");
      if (!big && !small && loose !== triplets) fail(`${loose} dragonPung awards for ${triplets} pungs`);
    })).toEqual([]);
  });

  it("resolves 小四喜 / 大四喜 subsumption", () => {
    expect(check((c, fail) => {
      const winds = [0, 1, 2, 3].map((i) => WINDS_START + i);
      const triplets = winds.filter((w) => hasTriplet(c, w)).length;
      const pairs = winds.filter((w) => hasPair(c, w)).length;
      const big = triplets === 4;
      const small = triplets === 3 && pairs === 1;
      if (has(c, "bigFourWinds") !== big) fail("大四喜 disagrees with the tiles");
      if (has(c, "smallFourWinds") !== small) fail("小四喜 disagrees with the tiles");
      if (big && has(c, "smallFourWinds")) fail("大四喜 failed to subsume 小四喜");
    })).toEqual([]);
  });

  it("claims 字一色, 混一色 and 對對糊 only when the tiles say so", () => {
    expect(check((c, fail) => {
      const tiles = handTiles(c);
      const suits = new Set(tiles.filter((x) => x < WINDS_START).map((x) => Math.floor(x / 9)));
      const honours = tiles.some((x) => x >= WINDS_START);
      if (has(c, "allHonours") !== (suits.size === 0)) fail("字一色 disagrees with the tiles");
      // 清一色 would be one suit and NO honours; this family never builds one.
      if (has(c, "halfFlush") !== (suits.size === 1 && honours)) fail("混一色 disagrees with the tiles");
      const c14 = counts(tiles);
      const pungs = c14.filter((n) => n >= 3).length;
      const eyes = c14.filter((n) => n === 2).length;
      const noChow = c.melds.every((meld) => meld.kind !== "chow");
      // 字一色 subsumes 對對糊 — an all-honour hand cannot hold a run.
      const allPungs = noChow && pungs === 4 && eyes === 1 && !has(c, "allHonours");
      if (has(c, "allPungs") !== allPungs) fail("對對糊 disagrees");
    })).toEqual([]);
  });

  it("marks a self-draw win with 自摸 and nothing else with it", () => {
    expect(check((c, fail) => {
      if (has(c, "selfDraw") !== c.selfDraw) fail("自摸 disagrees with the win");
      const concealedMelds = c.melds.every((meld) => meld.concealed);
      if (has(c, "concealedHand") && !concealedMelds) fail("門前清 on a hand with a claimed meld");
    })).toEqual([]);
  });
});

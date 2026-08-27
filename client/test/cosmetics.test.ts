/**
 * The cosmetic layer makes three promises. This file checks all three, because
 * each one is the kind of promise that is quietly broken by a later edit:
 *
 *   1. `resolve()` is TOTAL — any input yields a full loadout, nothing throws.
 *   2. A missing cosmetic DEGRADES to the default; it never fails a match.
 *   3. Unlocks are DETERMINISTIC and carry no randomness.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AVATAR,
  DEFAULT_HAND_MODEL,
  DEFAULT_TABLE_SURFACE,
  DEFAULT_TILE_SET,
  TILE_FACE_ORDER,
  defaultScene,
  evaluateUnlock,
  faceKeyForTileId,
  normalizeTiming,
  resolve,
  unlockProgress,
} from "../src/cosmetics/registry.js";
import { HAND_POSES, avatarId, tileSetId } from "../src/cosmetics/types.js";
import type { PlayerRecord, PlayerStatKey } from "../src/cosmetics/types.js";

const emptyRecord: PlayerRecord = { stats: {} as Record<PlayerStatKey, number>, grants: [] };

describe("resolve is total", () => {
  it("fills every slot from nothing", () => {
    const r = resolve(null);
    expect(r.tileSet.id).toBe(DEFAULT_TILE_SET.id);
    expect(r.avatar.id).toBe(DEFAULT_AVATAR.id);
    expect(r.handModel.id).toBe(DEFAULT_HAND_MODEL.id);
    expect(r.tableSurface.id).toBe(DEFAULT_TABLE_SURFACE.id);
    expect(r.reactions.id).toBe(DEFAULT_AVATAR.reactionSetId);
    expect(r.fallbacks).toHaveLength(0);
  });

  it("degrades a retired-and-deleted cosmetic instead of throwing", () => {
    const r = resolve({ tileSetId: tileSetId("mjrc.tileset.gone"), avatarId: avatarId("mjrc.avatar.gone") });
    expect(r.tileSet.id).toBe(DEFAULT_TILE_SET.id);
    expect(r.avatar.id).toBe(DEFAULT_AVATAR.id);
    expect(r.fallbacks.map((f) => f.slot).sort()).toEqual(["avatar", "tileSet"]);
    expect(r.fallbacks.every((f) => f.reason === "missing")).toBe(true);
  });

  it("gives a stranger opening a shared replay a complete table", () => {
    const s = defaultScene();
    expect(s.seats).toHaveLength(4);
    expect(s.seats.every((seat) => seat.avatar && seat.handModel && seat.reactions)).toBe(true);
  });
});

describe("the tile id crossing", () => {
  it("maps all 42 engine ids and refuses anything else", () => {
    expect(TILE_FACE_ORDER).toHaveLength(42);
    expect(new Set(TILE_FACE_ORDER).size).toBe(42);
    for (let i = 0; i < 42; i++) expect(faceKeyForTileId(i)).toBe(TILE_FACE_ORDER[i]);
    for (const bad of [-1, 42, 1.5, NaN, Infinity]) expect(faceKeyForTileId(bad)).toBeNull();
  });
});

describe("timing cannot reach through the boundary", () => {
  it("clamps a hostile cosmetic into range rather than rejecting it", () => {
    const t = normalizeTiming({
      speed: 500,
      poseScale: Object.fromEntries(HAND_POSES.map((p) => [p, -3])) as Record<(typeof HAND_POSES)[number], number>,
      easing: "linear",
      tossArc: 99,
      settleWobble: NaN,
    });
    expect(t.speed).toBeLessThanOrEqual(2);
    expect(Object.values(t.poseScale).every((v) => v >= 0.5)).toBe(true);
    expect(t.tossArc).toBe(1);
    expect(Number.isFinite(t.settleWobble)).toBe(true);
  });
});

describe("unlocks", () => {
  it("is deterministic across repeated calls", () => {
    const rule = { kind: "stat", stat: "matchesFinished", atLeast: 25 } as const;
    const record: PlayerRecord = { stats: { matchesFinished: 24 } as Record<PlayerStatKey, number>, grants: [] };
    const answers = new Set(Array.from({ length: 50 }, () => evaluateUnlock(rule, record)));
    expect(answers).toEqual(new Set([false]));
  });

  it("fails closed on an empty `any` and open on an empty `all`", () => {
    expect(evaluateUnlock({ kind: "any", of: [] }, emptyRecord)).toBe(false);
    expect(evaluateUnlock({ kind: "all", of: [] }, emptyRecord)).toBe(true);
  });

  it("reports progress a collection screen can render", () => {
    const p = unlockProgress({ kind: "stat", stat: "handsPlayed", atLeast: 100 }, {
      stats: { handsPlayed: 42 } as Record<PlayerStatKey, number>,
      grants: [],
    });
    expect(p).toMatchObject({ kind: "stat", have: 42, atLeast: 100, met: false });
  });
});

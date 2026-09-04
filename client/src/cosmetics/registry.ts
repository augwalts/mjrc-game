/**
 * Cosmetic registry — lookup, guaranteed defaults, and resolution.
 *
 * Two jobs:
 *
 *   1. EVERY SLOT HAS A DEFAULT THAT CANNOT BE UNAVAILABLE. The default constants
 *      below are typed `AlwaysAvailable<T>`, which makes a default with a non-open
 *      unlock, or a retired default, fail to compile. So `resolve()` is total: it
 *      returns a fully-populated loadout for any input, including `null`, garbage
 *      ids, and ids that were valid last season. Nothing here throws.
 *
 *   2. IT IS THE ONLY PLACE ENGINE TILE IDS ARE TOUCHED. `faceKeyForTileId()` is
 *      ten lines, takes a plain `number`, and runs one way. There is no inverse and
 *      there must never be one — a face key travelling back toward a tile id is the
 *      first step to a face key travelling into the log.
 *
 * The catalogue below carries the DEFAULTS plus one worked example. The real roster
 * — names, palettes, characters, felt colours — belongs to ../../../PRESENTATION.md.
 * Art references in the defaults are PLACEHOLDER paths: RENDERING.md phase 1 draws
 * tiles procedurally and need not draw hands at all, so the default hand model is
 * carrying timing, not pixels, until the art lands.
 */
import {
  REACTION_BEATS,
  REACTION_HOLD_MAX_MS,
  HAND_POSES,
  TIMING_SPEED_MAX,
  TIMING_SPEED_MIN,
  UNLOCK_MAX_DEPTH,
  asset,
  avatarId,
  reactionSetId,
  generatorId,
  handModelId,
  tableSurfaceId,
  tileSetId,
} from "./types.js";
import type {
  AtlasFrame,
  Avatar,
  AvatarId,
  CosmeticFallback,
  CosmeticMeta,
  CosmeticSlot,
  CosmeticLoadout,
  ReactionFace,
  ReactionBeat,
  ReactionSet,
  ReactionSetId,
  FourSeats,
  HandModel,
  HandModelId,
  HandPose,
  HandPoseArt,
  HandTiming,
  OpenUnlock,
  PlayerRecord,
  ResolvedLoadout,
  SceneCosmetics,
  SeatCosmetics,
  StaticAssert,
  TableSurface,
  TableSurfaceId,
  TileArtKey,
  TileFaceKey,
  TileFrameTable,
  TileOrientation,
  TileSet,
  TileSetId,
  UnlockProgress,
  UnlockRule,
  ViewerPreferences,
} from "./types.js";

/* ═══════════════════════════════════════════════════════════════════════════
   1. SMALL HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Build an exhaustive record from the const tuple that DEFINES the key union, so
 * the result is provably complete without a cast. Used for pose and beat tables.
 */
function fromKeys<K extends string, V>(keys: readonly K[], make: (k: K) => V): Readonly<Record<K, V>> {
  const out = {} as Record<K, V>;
  for (const k of keys) out[k] = make(k);
  return Object.freeze(out);
}

function clamp(v: number, lo: number, hi: number, whenBroken: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return whenBroken;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * A default is unconditionally available, forever. Expressing that in the type
 * means "the default got retired" is a compile error rather than a black screen
 * three months from now.
 */
export type AlwaysAvailable<T extends CosmeticMeta> =
  Omit<T, "unlock" | "retired"> & { readonly unlock: OpenUnlock; readonly retired?: false };

const OPEN: OpenUnlock = Object.freeze({ kind: "open" });

/* ═══════════════════════════════════════════════════════════════════════════
   2. THE ONE CROSSING: ENGINE TILE ID → TILE ART KEY
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Index = engine tile id. 0-8 萬 · 9-17 索 · 18-26 筒 · 27-30 東南西北 ·
 * 31-33 中發白 · 34-41 花/季.
 *
 * This ordering is copied from `engine/src/types.ts`, not imported from it — see
 * README §10 for the one place the engine's naming and the current art disagree.
 */
export const TILE_FACE_ORDER = [
  "chars1", "chars2", "chars3", "chars4", "chars5", "chars6", "chars7", "chars8", "chars9",
  "bamboo1", "bamboo2", "bamboo3", "bamboo4", "bamboo5", "bamboo6", "bamboo7", "bamboo8", "bamboo9",
  "circles1", "circles2", "circles3", "circles4", "circles5", "circles6", "circles7", "circles8", "circles9",
  "windEast", "windSouth", "windWest", "windNorth",
  "dragonRed", "dragonGreen", "dragonWhite",
  "flowerPlum", "flowerOrchid", "flowerChrysanthemum", "flowerBamboo",
  "seasonSpring", "seasonSummer", "seasonAutumn", "seasonWinter",
] as const;

/* Proofs, not comments: 42 entries, every face key present, no strays. */
type _FaceCount = StaticAssert<(typeof TILE_FACE_ORDER)["length"] extends 42 ? true : false>;
type _FaceCovers = StaticAssert<[Exclude<TileFaceKey, (typeof TILE_FACE_ORDER)[number]>] extends [never] ? true : false>;
type _NoStrayFaces = StaticAssert<[Exclude<(typeof TILE_FACE_ORDER)[number], TileFaceKey>] extends [never] ? true : false>;

/** All 43 pieces of art a set supplies: 42 faces plus the back. */
export const TILE_ART_KEYS = [...TILE_FACE_ORDER, "back"] as const;

export const TILE_ORIENTATIONS = ["standing", "lying", "edge", "stacked"] as const;
type _OrientationsCover = StaticAssert<
  [Exclude<TileOrientation, (typeof TILE_ORIENTATIONS)[number]>] extends [never] ? true : false
>;

/**
 * The boundary crossing. One way. Returns `null` rather than throwing on a bad id,
 * because a client must never be able to fail a match over a drawing question.
 */
export function faceKeyForTileId(tileId: number): TileFaceKey | null {
  if (!Number.isInteger(tileId) || tileId < 0 || tileId >= TILE_FACE_ORDER.length) return null;
  return TILE_FACE_ORDER[tileId];
}

/**
 * Build the exhaustive 43 × 4 frame table from a generator. The atlas build step
 * (RENDERING.md §3) calls this; nobody hand-writes 172 frames.
 */
export function atlasFrameTable(
  make: (key: TileArtKey, orientation: TileOrientation) => AtlasFrame,
): TileFrameTable {
  return fromKeys(TILE_ART_KEYS, (k) => fromKeys(TILE_ORIENTATIONS, (o) => make(k, o)));
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. NORMALISERS — WHERE A COSMETIC IS PULLED BACK INSIDE ITS LIMITS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Timing is the one field a cosmetic could use to reach through the boundary and
 * touch play, so it is clamped on the way in. Idempotent; safe to re-run.
 * A cosmetic that asks for `speed: 40` becomes a slow cosmetic, not a hung match.
 */
export function normalizeTiming(t: HandTiming): HandTiming {
  return Object.freeze({
    speed: clamp(t.speed, TIMING_SPEED_MIN, TIMING_SPEED_MAX, 1),
    poseScale: fromKeys(HAND_POSES, (p) => clamp(t.poseScale?.[p] ?? 1, TIMING_SPEED_MIN, TIMING_SPEED_MAX, 1)),
    easing: t.easing,
    tossArc: clamp(t.tossArc, 0, 1, 0.5),
    settleWobble: clamp(t.settleWobble, 0, 1, 0.3),
  });
}

export function normalizeHandModel(m: HandModel): HandModel {
  return Object.freeze({ ...m, timing: normalizeTiming(m.timing) });
}

export function normalizeReactionSet(v: ReactionSet): ReactionSet {
  return Object.freeze({
    ...v,
    faces: fromKeys(REACTION_BEATS, (b): ReactionFace => {
      const e = v.faces[b];
      return Object.freeze({ ...e, holdMs: clamp(e.holdMs, 0, REACTION_HOLD_MAX_MS, 800) });
    }),
  });
}

export function normalizeTableSurface(s: TableSurface): TableSurface {
  if (s.texture.kind !== "tiled") return Object.freeze({ ...s });
  return Object.freeze({
    ...s,
    texture: Object.freeze({
      ...s.texture,
      scale: clamp(s.texture.scale, 0.05, 40, 1),
      opacity: clamp(s.texture.opacity, 0, 1, 0.5),
    }),
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. DEFAULTS — GUARANTEED PRESENT IN EVERY SLOT
   ═══════════════════════════════════════════════════════════════════════════ */

export const DEFAULT_TILE_SET_ID = tileSetId("mjrc.tileset.standard");
export const DEFAULT_HAND_MODEL_ID = handModelId("mjrc.hand.standard");
export const DEFAULT_REACTION_SET_ID = reactionSetId("mjrc.reactions.standard");
export const DEFAULT_AVATAR_ID = avatarId("mjrc.avatar.standard");
export const DEFAULT_TABLE_SURFACE_ID = tableSurfaceId("mjrc.table.standard");

/**
 * The procedural set that already exists: 42 SVG faces plus a back, produced by
 * `mjrc-app/web/src/features/tiles/render.ts` (the locked primitive-lab selections).
 * The palette values are that file's `PAL`, quoted rather than invented — the art
 * direction question lives in PRESENTATION.md and is a build-time input either way
 * (RENDERING.md §3: changing the palette re-runs the atlas).
 */
export const DEFAULT_TILE_SET: AlwaysAvailable<TileSet> = Object.freeze({
  id: DEFAULT_TILE_SET_ID,
  name: { en: "Standard", zhHant: "標準" },
  blurb: { en: "The house set. Clean, legible, no opinions.", zhHant: "館內用牌" },
  rev: 1,
  unlock: OPEN,
  source: {
    kind: "procedural" as const,
    generatorId: generatorId("mjrc.tiles.primitive-lab.v1"),
    palette: {
      face: "#FAFAF8",
      faceShade: "#EDEDEA",
      border: "#CCCCCC",
      edge: "#E2E2DE",
      ink: "#33333C",
      red: "#D42222",
      green: "#1A8B3A",
      blue: "#1845A5",
      back: "#2C7A52",
      backInk: "#4AA878",
    },
    // 100 × 140 canvas, rx 7 — verbatim from render.ts. `thickness` is a
    // PLACEHOLDER: RENDERING.md §9.3 says fix the camera angle first, and the
    // side face is baked against it.
    geometry: { width: 100, height: 140, cornerRadius: 7, thickness: 22 },
  },
} satisfies AlwaysAvailable<TileSet>);

/**
 * The default hand exists to carry NEUTRAL TIMING (every multiplier 1.0), which is
 * what makes "toss lazily" and "toss briskly" meaningful as deviations from it.
 * Its art paths are placeholders; a scene with no hand art draws the tile alone,
 * which is exactly what RENDERING.md phase 1 does.
 */
export const DEFAULT_HAND_MODEL: AlwaysAvailable<HandModel> = Object.freeze({
  id: DEFAULT_HAND_MODEL_ID,
  name: { en: "Steady", zhHant: "平手" },
  rev: 1,
  unlock: OPEN,
  handedness: "right",
  poses: fromKeys(
    HAND_POSES,
    (p: HandPose): HandPoseArt => ({
      image: asset(`cosmetics/hands/standard/${p}.png`),
      anchorX: 0.5,
      anchorY: 0.6,
      gripX: 0.5,
      gripY: 0.18,
      frames: 1,
    }),
  ),
  timing: normalizeTiming({
    speed: 1,
    poseScale: fromKeys(HAND_POSES, () => 1),
    easing: "easeOut",
    tossArc: 0.5,
    settleWobble: 0.3,
  }),
} satisfies AlwaysAvailable<HandModel>);

export const DEFAULT_REACTION_SET: AlwaysAvailable<ReactionSet> = Object.freeze({
  id: DEFAULT_REACTION_SET_ID,
  name: { en: "Even", zhHant: "平靜" },
  rev: 1,
  unlock: OPEN,
  faces: fromKeys(
    REACTION_BEATS,
    (b: ReactionBeat): ReactionFace => ({
      image: asset(`cosmetics/reactions/standard/${b}.png`),
      holdMs: b === "idle" ? 0 : 900,
      loop: b === "idle" || b === "thinking",
    }),
  ),
  // Cantonese call audio is table stakes (DESIGN.md §1) and is a platform asset,
  // not a cosmetic. A reaction set may add flavour on top; it can never take calls away.
  flavourAudioPackId: null,
} satisfies AlwaysAvailable<ReactionSet>);

export const DEFAULT_AVATAR: AlwaysAvailable<Avatar> = Object.freeze({
  id: DEFAULT_AVATAR_ID,
  name: { en: "House", zhHant: "街坊" },
  blurb: { en: "Plays every Tuesday. Has opinions about the air conditioning.", zhHant: "逢星期二上枱" },
  rev: 1,
  unlock: OPEN,
  portrait: asset("cosmetics/avatars/standard/portrait.png"),
  seatBadge: asset("cosmetics/avatars/standard/badge.png"),
  handModelId: DEFAULT_HAND_MODEL_ID,
  reactionSetId: DEFAULT_REACTION_SET_ID,
} satisfies AlwaysAvailable<Avatar>);

export const DEFAULT_TABLE_SURFACE: AlwaysAvailable<TableSurface> = Object.freeze({
  id: DEFAULT_TABLE_SURFACE_ID,
  name: { en: "House Green", zhHant: "綠檯" },
  rev: 1,
  unlock: OPEN,
  felt: "#2A6B4A",
  feltShade: "#1E5233",
  texture: { kind: "flat" as const },
  rail: "#3A2A1E",
} satisfies AlwaysAvailable<TableSurface>);

/** Nothing equipped. Every slot falls through to the defaults above. */
export const DEFAULT_LOADOUT: CosmeticLoadout = Object.freeze({
  tileSetId: null,
  avatarId: null,
  handModelId: null,
  tableSurfaceId: null,
} satisfies CosmeticLoadout);

/* ═══════════════════════════════════════════════════════════════════════════
   5. CATALOGUE
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * EXAMPLE ENTRY. It is here to exercise `UnlockRule` end to end — a thing you get
 * by finishing matches, statable in one sentence, with no currency and no roll.
 * PRESENTATION.md owns the real roster; delete this the moment it lands.
 */
const EXAMPLE_ROSEWOOD: TableSurface = {
  id: tableSurfaceId("mjrc.table.rosewood"),
  name: { en: "Rosewood", zhHant: "酸枝檯" },
  blurb: { en: "Your uncle's table. Slightly sticky.", zhHant: "阿叔嗰張" },
  rev: 1,
  unlock: { kind: "stat", stat: "matchesFinished", atLeast: 25 },
  felt: "#1F5C40",
  feltShade: "#153F2C",
  texture: { kind: "flat" },
  rail: "#5A2E22",
};

const index = <T extends { id: string }>(entries: readonly T[]): ReadonlyMap<string, T> =>
  new Map(entries.map((e) => [e.id, e]));

export const TILE_SETS: ReadonlyMap<string, TileSet> = index<TileSet>([DEFAULT_TILE_SET]);
export const HAND_MODELS: ReadonlyMap<string, HandModel> = index<HandModel>(
  [DEFAULT_HAND_MODEL].map(normalizeHandModel),
);
export const REACTION_SETS: ReadonlyMap<string, ReactionSet> = index<ReactionSet>(
  [DEFAULT_REACTION_SET].map(normalizeReactionSet),
);
export const AVATARS: ReadonlyMap<string, Avatar> = index<Avatar>([DEFAULT_AVATAR]);
export const TABLE_SURFACES: ReadonlyMap<string, TableSurface> = index<TableSurface>(
  [DEFAULT_TABLE_SURFACE, EXAMPLE_ROSEWOOD].map(normalizeTableSurface),
);

/** Never-throwing lookups. A missing id is a drawing question, not an error. */
export const getTileSet = (id: TileSetId | string | null | undefined): TileSet =>
  (id != null && TILE_SETS.get(id)) || DEFAULT_TILE_SET;
export const getHandModel = (id: HandModelId | string | null | undefined): HandModel =>
  (id != null && HAND_MODELS.get(id)) || DEFAULT_HAND_MODEL;
export const getReactionSet = (id: ReactionSetId | string | null | undefined): ReactionSet =>
  (id != null && REACTION_SETS.get(id)) || DEFAULT_REACTION_SET;
export const getAvatar = (id: AvatarId | string | null | undefined): Avatar =>
  (id != null && AVATARS.get(id)) || DEFAULT_AVATAR;
export const getTableSurface = (id: TableSurfaceId | string | null | undefined): TableSurface =>
  (id != null && TABLE_SURFACES.get(id)) || DEFAULT_TABLE_SURFACE;

/* ═══════════════════════════════════════════════════════════════════════════
   6. UNLOCKS — PURE, TOTAL, DETERMINISTIC
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * There is no source of randomness in this module. It imports nothing, so there is
 * nowhere for one to come from, and the signature has no seed, no clock, and no
 * RNG parameter: the same record always yields the same answer. That is the
 * property that makes a gacha unwriteable here rather than merely discouraged.
 *
 * Advisory only. The SERVER decides what a player may equip; this exists so the
 * collection screen can show progress without a round trip.
 */
export function unlockProgress(rule: UnlockRule, record: PlayerRecord, depth = 0): UnlockProgress {
  if (depth > UNLOCK_MAX_DEPTH) return { kind: "unreadable", met: false };
  switch (rule.kind) {
    case "open":
      return { kind: "open", met: true };
    case "stat": {
      const have = record.stats?.[rule.stat] ?? 0;
      return { kind: "stat", stat: rule.stat, atLeast: rule.atLeast, have, met: have >= rule.atLeast };
    }
    case "grant":
      return { kind: "grant", grant: rule.grant, met: (record.grants ?? []).includes(rule.grant) };
    case "all": {
      const of = rule.of.map((r) => unlockProgress(r, record, depth + 1));
      // `all` of nothing is true — an empty conjunction is vacuously satisfied.
      return { kind: "all", of, met: of.every((p) => p.met) };
    }
    case "any": {
      const of = rule.of.map((r) => unlockProgress(r, record, depth + 1));
      // `any` of nothing is FALSE. Fail closed: an accidentally-empty rule must not
      // unlock the thing it was supposed to gate.
      return { kind: "any", of, met: of.length > 0 && of.some((p) => p.met) };
    }
    default:
      return { kind: "unreadable", met: false };
  }
}

export const evaluateUnlock = (rule: UnlockRule, record: PlayerRecord): boolean =>
  unlockProgress(rule, record).met;

export const isUnlocked = (item: CosmeticMeta, record: PlayerRecord): boolean =>
  evaluateUnlock(item.unlock, record);

/**
 * What the picker shows for a slot: unlocked, plus locked-but-visible (so a player
 * can see what there is to play for), minus retired. Retired entries stay
 * resolvable — they are just no longer offered.
 */
export function catalogue(slot: "tileSet"): readonly TileSet[];
export function catalogue(slot: "avatar"): readonly Avatar[];
export function catalogue(slot: "handModel"): readonly HandModel[];
export function catalogue(slot: "tableSurface"): readonly TableSurface[];
export function catalogue(slot: CosmeticSlot): readonly CosmeticMeta[] {
  const table =
    slot === "tileSet" ? TILE_SETS
    : slot === "avatar" ? AVATARS
    : slot === "handModel" ? HAND_MODELS
    : TABLE_SURFACES;
  return [...table.values()].filter((e) => !e.retired);
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. RESOLUTION
   ═══════════════════════════════════════════════════════════════════════════ */

export interface ResolveOptions {
  /**
   * When supplied, an equipped-but-locked cosmetic degrades to the default and is
   * reported. Omit it to render exactly what the loadout asks for — which is what
   * a REPLAY should do, since the point is to reproduce the table as it was, and
   * the server already validated the equip at the time.
   */
  readonly record?: PlayerRecord;
}

function pick<T extends CosmeticMeta & { id: string }>(
  slot: CosmeticSlot | "reactionSet",
  table: ReadonlyMap<string, T>,
  requested: string | null | undefined,
  fallback: T,
  record: PlayerRecord | undefined,
  out: CosmeticFallback[],
): T {
  if (requested == null) return fallback; // nothing equipped — not a degradation
  const found = table.get(requested);
  if (!found) {
    out.push({ slot, requested, reason: "missing" });
    return fallback;
  }
  if (record && !isUnlocked(found, record)) {
    out.push({ slot, requested, reason: "locked" });
    return fallback;
  }
  return found;
}

/**
 * Turn a loadout into concrete cosmetics. Total: any input, including `null`,
 * yields a fully-populated result. Never throws, never returns a partial.
 *
 * Hand-model precedence: an explicit `handModelId` wins; otherwise the avatar's
 * bound model; otherwise the default. The VOICE is never in the loadout — it comes
 * from the avatar, because "which face does this character pull" is part of the
 * character, not a separate thing to mix and match.
 */
export function resolve(
  loadout: Partial<CosmeticLoadout> | null | undefined,
  opts: ResolveOptions = {},
): ResolvedLoadout {
  const l = loadout ?? DEFAULT_LOADOUT;
  const record = opts.record;
  const fallbacks: CosmeticFallback[] = [];

  const tileSet = pick("tileSet", TILE_SETS, l.tileSetId, DEFAULT_TILE_SET, record, fallbacks);
  const tableSurface = pick("tableSurface", TABLE_SURFACES, l.tableSurfaceId, DEFAULT_TABLE_SURFACE, record, fallbacks);
  const avatar = pick("avatar", AVATARS, l.avatarId, DEFAULT_AVATAR, record, fallbacks);

  const handModel = pick(
    "handModel",
    HAND_MODELS,
    l.handModelId ?? avatar.handModelId,
    DEFAULT_HAND_MODEL,
    record,
    fallbacks,
  );

  // Reactions ride with the avatar, so they are looked up rather than picked: a
  // locked set on an unlocked avatar would be an authoring bug, not a player one.
  const reactions = getReactionSet(avatar.reactionSetId);
  if (reactions.id !== avatar.reactionSetId)
    fallbacks.push({ slot: "reactionSet", requested: avatar.reactionSetId, reason: "missing" });

  return Object.freeze({ tileSet, avatar, handModel, reactions, tableSurface, fallbacks: Object.freeze(fallbacks) });
}

/**
 * Collapse one viewer plus four seats into the cosmetic half of `SceneOpts`
 * (RENDERING.md §7).
 *
 * This function IS the implementation of `COSMETIC_SLOT_SCOPE`: the tile set and table surface
 * come from the VIEWER and nobody else's are consulted — four players may each be
 * looking at a different set in the same match, and the rules, the protocol and the
 * log all remain unaware. The avatar and hand model come from each SEAT, delivered
 * by the lobby at join time over the HTTP plane, never on the match socket.
 *
 * `seats` is indexed by ABSOLUTE seat, 0 東 … 3 北 — the same indexing the log uses.
 * Rotating so the local player sits at the bottom is the scene's job.
 */
export function resolveScene(
  viewer: Partial<CosmeticLoadout> | null | undefined,
  seats: FourSeats<Partial<CosmeticLoadout> | null | undefined>,
  prefs: ViewerPreferences,
): SceneCosmetics {
  const v = resolve(viewer);
  const seat = (i: 0 | 1 | 2 | 3): SeatCosmetics => {
    const r = resolve(seats[i]);
    return Object.freeze({ avatar: r.avatar, handModel: r.handModel, reactions: r.reactions });
  };
  return Object.freeze({
    tileSet: v.tileSet,
    tableSurface: v.tableSurface,
    seats: Object.freeze([seat(0), seat(1), seat(2), seat(3)]) as FourSeats<SeatCosmetics>,
    reducedMotion: prefs.reducedMotion,
    labels: prefs.labels,
  });
}

/**
 * Every seat on the defaults, for the cases with no cosmetic input at all: a replay
 * of a hand logged before cosmetics existed, a shared replay opened by a stranger,
 * a bot table, a screenshot harness. Because the log carries no cosmetic ids, this
 * is not a degraded rendering — it is the correct one.
 */
export function defaultScene(prefs: ViewerPreferences = { reducedMotion: false, labels: false }): SceneCosmetics {
  return resolveScene(DEFAULT_LOADOUT, [null, null, null, null], prefs);
}

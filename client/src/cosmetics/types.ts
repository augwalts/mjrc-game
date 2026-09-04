/**
 * Cosmetic data model — the boundary between *what happened* and *what it looked like*.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * Cosmetics never touch the engine, the reducer, the protocol, or the event log.
 * The log records "tile 18 was cut by seat 2". It must never record which tile SET
 * tile 18 was wearing, whose hand model threw it, or what face the avatar pulled.
 *
 * Two things break the day that rule breaks:
 *
 *   1. THE CORPUS. DESIGN.md §1 leg 3 makes the log a research asset. A log that
 *      carries presentation is a log every future query has to filter, forever.
 *   2. REPLAY. DESIGN.md §5.5 pins `engineVersion` so a 2026 hand replays through
 *      the build that produced it. If a hand also referenced `tileSet:"jade"`, then
 *      retiring "jade" in 2028 either breaks that replay or forces us to keep every
 *      cosmetic alive forever. Because the log holds no cosmetic ids, a retired
 *      cosmetic degrades to the default and the replay is byte-identical.
 *
 * SO: this module imports NOTHING. Not @mjrc/engine, not @mjrc/protocol, not a
 * third-party package. Zero imports is the cheapest possible proof that the arrow
 * only ever points one way — the scene reads cosmetics; nothing reads the scene.
 * Where a shape must match an engine or protocol shape (`FourSeats`, seat indices,
 * tile ids) it is MIRRORED here on purpose. The duplication is the boundary.
 *
 * Companion documents: ./README.md (the boundary and the add-a-cosmetic checklist),
 * ../../../sketches/RENDERING.md §7 (the `MatchScene` interface these types feed),
 * ../../../PRESENTATION.md (the creative direction — owns the actual roster),
 * ../../../TERMINOLOGY.md (HK Old Style only; Japanese terms are banned in prose too).
 */

/* ═══════════════════════════════════════════════════════════════════════════
   0. BRANDS, AND THE COMPILE-TIME LEAK DETECTOR
   ═══════════════════════════════════════════════════════════════════════════ */

declare const COSMETIC_BRAND: unique symbol;

/**
 * Every cosmetic identifier and every asset reference carries this brand. The
 * brand is not decoration — it is what makes `HasCosmeticId` below able to find
 * a cosmetic that has been smuggled into a payload type.
 */
export interface CosmeticBrand<K extends string> {
  readonly [COSMETIC_BRAND]: K;
}

export type TileSetId = string & CosmeticBrand<"tileSet">;
export type HandModelId = string & CosmeticBrand<"handModel">;
export type AvatarId = string & CosmeticBrand<"avatar">;
export type ReactionSetId = string & CosmeticBrand<"reactionSet">;
export type TableSurfaceId = string & CosmeticBrand<"tableSurface">;
export type AudioPackId = string & CosmeticBrand<"audioPack">;
/** Id of a drawing routine the scene has registered. Cosmetics carry ids, never functions. */
export type ProceduralGeneratorId = string & CosmeticBrand<"generator">;
/** A path resolved against the scene's asset base. Branded so it trips the detector too. */
export type AssetRef = string & CosmeticBrand<"asset">;
/** Key for a manually granted entitlement (tournament prize, playtester thanks). */
export type GrantKey = string & CosmeticBrand<"grant">;

/** Constructors. Cheap casts, kept in one place so `as TileSetId` never spreads. */
export const tileSetId = (s: string): TileSetId => s as TileSetId;
export const handModelId = (s: string): HandModelId => s as HandModelId;
export const avatarId = (s: string): AvatarId => s as AvatarId;
export const reactionSetId = (s: string): ReactionSetId => s as ReactionSetId;
export const tableSurfaceId = (s: string): TableSurfaceId => s as TableSurfaceId;
export const audioPackId = (s: string): AudioPackId => s as AudioPackId;
export const generatorId = (s: string): ProceduralGeneratorId => s as ProceduralGeneratorId;
export const asset = (path: string): AssetRef => path as AssetRef;
export const grantKey = (s: string): GrantKey => s as GrantKey;

type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * True when a cosmetic brand appears anywhere in `T`, at any depth.
 *
 * Fails CLOSED: if the scan runs out of depth it answers `true`, so a pathological
 * type is reported as dirty rather than waved through.
 */
export type HasCosmeticId<T, D extends number = 9> =
  [D] extends [never] ? true
  : T extends CosmeticBrand<string> ? true
  : T extends readonly (infer U)[] ? HasCosmeticId<U, Prev[D]>
  : T extends object
    ? true extends { [K in keyof T]-?: HasCosmeticId<T[K], Prev[D]> }[keyof T] ? true : false
  : false;

export type IsLogSafe<T> = HasCosmeticId<T> extends true ? false : true;

/**
 * Compile-time assertion. Put one next to every payload type that reaches the log
 * or the wire — it costs one line and fails the build the moment someone adds a
 * cosmetic field:
 *
 *   import type { StaticAssert, IsLogSafe } from ".../cosmetics/types.js";
 *   type _CutIsClean = StaticAssert<IsLogSafe<CutPayload>>;
 *
 * Honest limit: this catches `tileSetId: TileSetId`. It does NOT catch someone
 * typing the same field `tileSetId: string`. The grep in README §5 catches that one.
 */
export type StaticAssert<T extends true> = T;

/* ═══════════════════════════════════════════════════════════════════════════
   1. SHARED VALUE TYPES
   ═══════════════════════════════════════════════════════════════════════════ */

export type Hex = `#${string}`;

/**
 * English + Traditional Chinese. DESIGN.md §1 makes bilingual a positioning leg
 * and §7 makes UI labels terminology-first, so a cosmetic without a Chinese name
 * is a half-finished cosmetic. `zhHant` is optional only so a work-in-progress
 * entry compiles; ship without it and the review checklist should stop you.
 */
export interface LocalizedText {
  readonly en: string;
  readonly zhHant?: string;
}

/**
 * A closed easing set. Deliberately closed: an open `cubic-bezier(...)` string
 * would let a cosmetic ship a curve that stalls for eight seconds, and timing is
 * the one place a cosmetic could reach through the boundary and affect play.
 */
export type EasingName = "linear" | "easeIn" | "easeOut" | "easeInOut" | "overshoot";

/** Absolute seat index, 0 東 · 1 南 · 2 西 · 3 北 — mirrored from the engine, not imported. */
export type SeatSlot = 0 | 1 | 2 | 3;

/** Mirrored from the protocol's `FourSeats`. Indexed by ABSOLUTE seat, never by display position. */
export type FourSeats<T> = readonly [T, T, T, T];

/** Shared metadata every cosmetic entry carries. */
export interface CosmeticMeta {
  readonly name: LocalizedText;
  /** One line of personality. A roster blurb, not lore. */
  readonly blurb?: LocalizedText;
  /** Artist attribution. Required in practice once anything is commissioned. */
  readonly credit?: string;
  readonly unlock: UnlockRule;
  /**
   * Withdrawn from the picker. A retired entry stays resolvable so a player who
   * had it equipped does not silently change appearance; deleting it entirely is
   * also safe, because the registry falls back to the default and the log never
   * referenced either one.
   */
  readonly retired?: boolean;
  /** Bump when the art changes materially, so an asset cache can be busted. Nothing in the log reads it. */
  readonly rev: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. TILE SET
   ═══════════════════════════════════════════════════════════════════════════ */

type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/** 萬 · 索 · 筒, nine ranks each = 27. */
export type SuitedFaceKey = `chars${Rank}` | `bamboo${Rank}` | `circles${Rank}`;
/** 東南西北 = 4. */
export type WindFaceKey = "windEast" | "windSouth" | "windWest" | "windNorth";
/** 中發白 = 3. */
export type DragonFaceKey = "dragonRed" | "dragonGreen" | "dragonWhite";
/** 梅蘭菊竹 + 春夏秋冬 = 8. Order follows the ENGINE's tile ids 34-41. See README §10. */
export type FlowerFaceKey =
  | "flowerPlum" | "flowerOrchid" | "flowerChrysanthemum" | "flowerBamboo"
  | "seasonSpring" | "seasonSummer" | "seasonAutumn" | "seasonWinter";

/** Exactly 42 faces. */
export type TileFaceKey = SuitedFaceKey | WindFaceKey | DragonFaceKey | FlowerFaceKey;
/** 42 faces plus the back = 43 pieces of art a set must supply. */
export type TileArtKey = TileFaceKey | "back";

/**
 * Keying tile art by NAME rather than by engine tile id is the boundary made
 * concrete. A cosmetic never sees a `TileId`. There is exactly one crossing —
 * `faceKeyForTileId()` in registry.ts — it is ten lines long, it takes a plain
 * `number`, and it runs one way only. Nothing converts a face key back to a tile id.
 */

/**
 * The camera never moves (RENDERING.md §1), so a tile has a small, enumerable set
 * of appearances. Four, not one per position.
 */
export type TileOrientation =
  /** Upright in a hand: face to camera, top edge visible. */
  | "standing"
  /** Flat on the table: foreshortened. Discards, melds, flower tray. */
  | "lying"
  /** Seen from the side: wall stacks, an opponent's concealed hand. */
  | "edge"
  /** Upper tile of a two-high wall stack — the lit variant of `lying`. */
  | "stacked";

export interface TileGeometry {
  /** Face width in tile units. The current art is a 100 × 140 canvas (5:7). */
  readonly width: number;
  readonly height: number;
  readonly cornerRadius: number;
  /**
   * Side-face depth, in the same units. Drives the `edge` sprite and the CSS-3D
   * side face in phase 1. PLACEHOLDER value in the default set — RENDERING.md §9.3
   * says fix the camera angle before baking, and thickness bakes with it.
   */
  readonly thickness: number;
}

/**
 * Colour roles, not colour names. `ink` is the calligraphy colour — blue-black in
 * the heritage direction, pure black in the modern one — so a set swaps direction
 * by changing values, not by changing the schema.
 */
export interface TilePalette {
  readonly face: Hex;
  readonly faceShade: Hex;
  readonly border: Hex;
  readonly edge: Hex;
  readonly ink: Hex;
  readonly red: Hex;
  readonly green: Hex;
  readonly blue: Hex;
  readonly back: Hex;
  readonly backInk: Hex;
}

/** One rasterisation tier. RENDERING.md §3 bakes 1× / 2× / 3× DPR. */
export interface AtlasTier {
  readonly dpr: 1 | 2 | 3;
  readonly image: AssetRef;
}

/** Frame rectangle in TIER-1 units. A tier multiplies by its own `dpr`. */
export interface AtlasFrame {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Where the tile's table-space origin sits inside the frame, 0-1 of w/h. */
  readonly anchorX: number;
  readonly anchorY: number;
}

/**
 * Exhaustive on purpose: 43 keys × 4 orientations. A set that forgets 5筒 does not
 * compile. The build step generates this — see `atlasFrameTable()` in registry.ts.
 */
export type TileFrameTable = Readonly<Record<TileArtKey, Readonly<Record<TileOrientation, AtlasFrame>>>>;

/**
 * Both sourcing modes exist because RENDERING.md §8 phases DOM then Pixi. Phase 1
 * draws procedurally from the SVG routines that already exist; phase 2 draws from
 * a baked atlas. Same `TileSet` type, same registry, same loadout — only the
 * renderer branches.
 */
export type TileFaceSource =
  | {
      readonly kind: "procedural";
      /**
       * Id of a drawing routine the scene registered at start-up. An ID, never a
       * function: cosmetics are DATA. A cosmetic that could carry code could carry
       * behaviour, and behaviour is exactly what must not vary by cosmetic.
       */
      readonly generatorId: ProceduralGeneratorId;
      readonly palette: TilePalette;
      readonly geometry: TileGeometry;
    }
  | {
      readonly kind: "atlas";
      readonly geometry: TileGeometry;
      readonly tiers: readonly AtlasTier[];
      readonly frames: TileFrameTable;
      /** Kept alongside so a UI swatch can be drawn without loading the atlas. */
      readonly palette: TilePalette;
    };

export interface TileSet extends CosmeticMeta {
  readonly id: TileSetId;
  readonly source: TileFaceSource;
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. HAND MODEL
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The six poses an animation needs. `toss` is the signature one: RENDERING.md §5
 * calls the thrown discard "the single most recognisable motion in Hong Kong
 * mahjong". `sweep` is the end-of-hand clear.
 */
export const HAND_POSES = ["reach", "grasp", "lift", "toss", "release", "sweep"] as const;
export type HandPose = (typeof HAND_POSES)[number];

export interface HandPoseArt {
  readonly image: AssetRef;
  /** Pivot inside the image, 0-1. The wrist, roughly. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Where a held tile sits relative to the image, 0-1. Ignored by poses that hold nothing. */
  readonly gripX: number;
  readonly gripY: number;
  /** Frames in the strip, left to right. 1 = a still. */
  readonly frames: number;
}

/**
 * MULTIPLIERS, NEVER DURATIONS — the single most important line in this file
 * after the no-cosmetics-in-the-log rule.
 *
 * The authoritative timings live in RENDERING.md §5 and belong to the animation
 * queue. A hand model scales them so one hand tosses lazily and another briskly.
 * It cannot set them. It therefore cannot lengthen a claim window, delay a prompt,
 * or move a deadline — RENDERING.md §4 rule 1 says animation never gates input,
 * and a cosmetic that could name its own milliseconds would be a way around that.
 *
 * `resolve()` clamps every field. An out-of-range cosmetic is pulled into range,
 * not rejected — a bad cosmetic must never be able to fail a match.
 */
export interface HandTiming {
  /** Global multiplier on every pose. Clamped to [TIMING_SPEED_MIN, TIMING_SPEED_MAX]. */
  readonly speed: number;
  /** Per-pose multiplier on top of `speed`. Same clamp. */
  readonly poseScale: Readonly<Record<HandPose, number>>;
  readonly easing: EasingName;
  /** Height of the discard arc, 0 = a slide, 1 = a lob. Clamped to [0, 1]. */
  readonly tossArc: number;
  /** How much the tile rocks on landing, 0-1. Clamped to [0, 1]. */
  readonly settleWobble: number;
}

export const TIMING_SPEED_MIN = 0.5;
export const TIMING_SPEED_MAX = 2.0;

export interface HandModel extends CosmeticMeta {
  readonly id: HandModelId;
  readonly handedness: "right" | "left";
  /** Exhaustive: a model missing `sweep` does not compile. */
  readonly poses: Readonly<Record<HandPose, HandPoseArt>>;
  readonly timing: HandTiming;
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. REACTION SET — the avatar's automatic faces
   ═══════════════════════════════════════════════════════════════════════════ */

/*
 * NAMING. The brief for this file calls this an avatar's "expression voice", and
 * that is what it is. It is named `ReactionSet` because `client/src/expressions/`
 * already owns the word "expression" for 枱面話 table talk — lines a player CHOOSES
 * to send. This is the opposite: faces the avatar pulls on its own, in response to
 * what just happened, that nobody selected. Two different things sharing one word
 * in one client would cost more than the rename does.
 *
 * Open: when a player sends a table-talk line, which face does the avatar pull?
 * Probably a `ReactionSet` hook keyed by expression id. Decide with whoever owns
 * EXPRESSIONS.md before either side hard-codes an answer.
 */

/**
 * A PRESENTATION vocabulary, deliberately NOT a subset of the protocol's event
 * types. The scene maps events to beats; the engine has never heard of a beat.
 * Keeping the two vocabularies separate is what stops "the avatar should look
 * smug here" from becoming a field in the log.
 *
 * Terminology per TERMINOLOGY.md: `wonSelfDraw` 自摸, `wonOnDiscard` 食糊,
 * `refusedWin` (a win under the 3-faan floor, surfaced not swallowed — DESIGN.md
 * §5.2 calls it a teaching moment), `exhaustiveDraw` 流局.
 */
export const REACTION_BEATS = [
  "idle",
  "thinking",
  "clockLow",
  "drewIntoReady",
  "cut",
  "claimOffered",
  "claimed",
  "refusedWin",
  "wonSelfDraw",
  "wonOnDiscard",
  "dealtIn",
  "exhaustiveDraw",
  "disconnected",
] as const;
export type ReactionBeat = (typeof REACTION_BEATS)[number];

export interface ReactionFace {
  readonly image: AssetRef;
  /** How long the face holds before returning to `idle`. Clamped to REACTION_HOLD_MAX_MS. */
  readonly holdMs: number;
  readonly loop: boolean;
}

export const REACTION_HOLD_MAX_MS = 4000;

export interface ReactionSet extends CosmeticMeta {
  readonly id: ReactionSetId;
  /** Exhaustive over the beats: a set with no `dealtIn` face does not compile. */
  readonly faces: Readonly<Record<ReactionBeat, ReactionFace>>;
  /**
   * Optional flavour audio LAYERED OVER the call audio, never replacing it.
   * DESIGN.md §1 calls Cantonese call audio table stakes, not a differentiator —
   * so calls are a platform asset every player always hears. `null` means this
   * set adds nothing of its own. A cosmetic must never be able to make the
   * table silent.
   */
  readonly flavourAudioPackId: AudioPackId | null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. AVATAR
   ═══════════════════════════════════════════════════════════════════════════ */

export interface Avatar extends CosmeticMeta {
  readonly id: AvatarId;
  /** Results screen and profile. Large. */
  readonly portrait: AssetRef;
  /** In-scene seat badge. Small, must read at ~48px. */
  readonly seatBadge: AssetRef;
  /** The hand this character plays with. A loadout may override it. */
  readonly handModelId: HandModelId;
  /** The face set this character wears by default. A loadout may NOT override it. */
  readonly reactionSetId: ReactionSetId;
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. TABLE SURFACE
   ═══════════════════════════════════════════════════════════════════════════ */

export type SurfaceTexture =
  | { readonly kind: "flat" }
  | {
      readonly kind: "tiled";
      readonly image: AssetRef;
      /** Repeat size in tile units. */
      readonly scale: number;
      /** 0-1 over the felt colour. Clamped. */
      readonly opacity: number;
    };

export interface TableSurface extends CosmeticMeta {
  readonly id: TableSurfaceId;
  readonly felt: Hex;
  /** The darker tone used for the perspective falloff toward the far edge. */
  readonly feltShade: Hex;
  readonly texture: SurfaceTexture;
  /** Table edge. `null` = no visible rail. */
  readonly rail: Hex | null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. UNLOCKS — AND WHY A GACHA CANNOT BE WRITTEN HERE
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Countable facts, all of them derivable from the event log by folding it. A
 * CLOSED union on purpose: adding a new unlock condition means editing this list,
 * which means a code review, which is the checkpoint.
 */
export const PLAYER_STATS = [
  "handsPlayed",
  "matchesPlayed",
  "matchesFinished",
  "matchesWon",
  "handsWon",
  "handsWonSelfDraw",
  "handsWonOnDiscard",
  "bestFaan",
  "limitHands",
  "kongsDeclared",
  "concealedKongsDeclared",
  "flowersRevealed",
  "distinctPatternsWon",
  "daysActive",
  "longestDayStreak",
  "peakRating",
  "handsReviewed",
  "replaysShared",
] as const;
export type PlayerStatKey = (typeof PLAYER_STATS)[number];

/** What `evaluateUnlock` is given. Platform data — it is not, and never becomes, log data. */
export interface PlayerRecord {
  readonly stats: Readonly<Record<PlayerStatKey, number>>;
  /** Manually issued entitlements: tournament prizes, playtester thanks, staff. */
  readonly grants: readonly GrantKey[];
}

export interface OpenUnlock {
  readonly kind: "open";
}

/**
 * The unlock condition, as DATA.
 *
 * WHAT IS DELIBERATELY ABSENT — this is the point of the type, not an oversight:
 *
 *   no `chance` / `weight` / `odds` / `pity`   — no randomness, anywhere
 *   no `price` / `currency` / `cost`           — nothing is bought
 *   no `pull` / `roll` / `box` / `crate`       — there is no container to open
 *   no `expiresAt` / `availableUntil`          — no manufactured scarcity
 *   no `bundle` / `duplicateCompensation`      — no economy to compensate within
 *
 * Every leaf is a comparison against a fact the player produced by playing, so a
 * player can always be told exactly what to do to get a thing, in one sentence.
 * That property is what "zero gacha" means operationally (DESIGN.md §1: real-money
 * anything is a hard no; PAGE-INVENTORY §2 cuts the mail/rewards screen for being
 * the gacha economy's plumbing).
 *
 * Cosmetics themselves are NOT ruled out and never were — Super Smash Bros is the
 * reference: a roster with personality, unlocked by playing. Riichi City and
 * Mahjong Soul are the anti-reference.
 */
export type UnlockRule =
  | OpenUnlock
  | { readonly kind: "stat"; readonly stat: PlayerStatKey; readonly atLeast: number }
  | { readonly kind: "grant"; readonly grant: GrantKey }
  | { readonly kind: "all"; readonly of: readonly UnlockRule[] }
  | { readonly kind: "any"; readonly of: readonly UnlockRule[] };

/** Nesting deeper than this is treated as unmet — fail closed. */
export const UNLOCK_MAX_DEPTH = 6;

/** A rule with progress attached, shaped for a collection screen. */
export type UnlockProgress =
  | { readonly kind: "open"; readonly met: true }
  | {
      readonly kind: "stat";
      readonly stat: PlayerStatKey;
      readonly atLeast: number;
      readonly have: number;
      readonly met: boolean;
    }
  | { readonly kind: "grant"; readonly grant: GrantKey; readonly met: boolean }
  | { readonly kind: "all" | "any"; readonly of: readonly UnlockProgress[]; readonly met: boolean }
  /** Emitted when the rule nests past UNLOCK_MAX_DEPTH or carries an unknown kind. */
  | { readonly kind: "unreadable"; readonly met: false };

/* ═══════════════════════════════════════════════════════════════════════════
   8. LOADOUT, SCOPE, AND WHAT THE SCENE ACTUALLY RECEIVES
   ═══════════════════════════════════════════════════════════════════════════ */

export const COSMETIC_SLOTS = ["tileSet", "avatar", "handModel", "tableSurface"] as const;
export type CosmeticSlot = (typeof COSMETIC_SLOTS)[number];

/**
 * Who a slot belongs to.
 *
 *   `viewer` — it is the viewer's whole screen, so the viewer's choice wins and
 *              nobody else's equipped set is consulted. Four players can each be
 *              looking at a different tile set in the same match, and neither the
 *              rules nor the log notice.
 *   `seat`   — it is a character occupying a chair, so the seat's owner chooses
 *              and the other three see it. Delivered by the LOBBY plane at join
 *              (DESIGN.md §2 — the two planes never share a channel), never on the
 *              match socket, and never in an event.
 */
export type CosmeticScope = "viewer" | "seat";

export const COSMETIC_SLOT_SCOPE: Readonly<Record<CosmeticSlot, CosmeticScope>> = {
  tileSet: "viewer",
  tableSurface: "viewer",
  avatar: "seat",
  handModel: "seat",
};

/** What one player has equipped. `null` in any slot means "use the default". */
export interface CosmeticLoadout {
  readonly tileSetId: TileSetId | null;
  readonly avatarId: AvatarId | null;
  /** `null` = inherit the avatar's bound hand model. */
  readonly handModelId: HandModelId | null;
  readonly tableSurfaceId: TableSurfaceId | null;
}

/**
 * Why a slot degraded. Report it; never throw.
 *
 * Retirement is deliberately NOT a reason. A retired cosmetic is withdrawn from
 * the picker but still resolves for a player who has it equipped, so nobody's
 * table changes appearance overnight. Only a cosmetic that has been deleted
 * outright degrades — and because the log never named it, the replay is unaffected
 * either way.
 */
export interface CosmeticFallback {
  readonly slot: CosmeticSlot | "reactionSet";
  readonly requested: string | null;
  readonly reason: "missing" | "locked";
}

/** Every slot filled with a concrete cosmetic. `resolve()` guarantees it. */
export interface ResolvedLoadout {
  readonly tileSet: TileSet;
  readonly avatar: Avatar;
  readonly handModel: HandModel;
  readonly reactions: ReactionSet;
  readonly tableSurface: TableSurface;
  /** Empty when everything requested was found. Worth a telemetry counter, not a modal. */
  readonly fallbacks: readonly CosmeticFallback[];
}

/** The seat-scoped half, for one chair. */
export interface SeatCosmetics {
  readonly avatar: Avatar;
  readonly handModel: HandModel;
  readonly reactions: ReactionSet;
}

/**
 * The whole cosmetic input to one match scene — the thing that rides in
 * `SceneOpts` (RENDERING.md §7) and nowhere else.
 *
 * `seats` is indexed by ABSOLUTE seat, 0 東 … 3 北, matching the log. The scene
 * rotates for display so the local player sits at the bottom; that rotation is a
 * scene concern and does not reindex this.
 */
export interface SceneCosmetics {
  readonly tileSet: TileSet;
  readonly tableSurface: TableSurface;
  readonly seats: FourSeats<SeatCosmetics>;
  /** Honour `prefers-reduced-motion` (RENDERING.md §5): cross-fade, keep the timings. */
  readonly reducedMotion: boolean;
  /** Latin helper labels on tile faces, for non-Chinese readers. An accessibility toggle, not a cosmetic. */
  readonly labels: boolean;
}

/** Viewer-scoped preferences that are settings rather than equipped items. */
export interface ViewerPreferences {
  readonly reducedMotion: boolean;
  readonly labels: boolean;
}

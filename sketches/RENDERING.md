# Gameplay renderer & animation — proposal

**Scope.** Menus, lobby, review, stats, settings stay flat DOM/CSS. That is settled and not
interesting. This document is about the match scene, which is a different kind of program.

**Position.** Sketch in flat HTML now. Ship P0 on DOM + CSS 3D. Build the real scene as a
**PixiJS sprite renderer with a hand-rolled fixed-camera projection** — not Three.js, not raw
CSS. Put the scene behind a narrow interface from day one so the swap never touches anything
but the renderer.

---

## 1. Why not a 3D engine

The camera in mahjong never moves. Riichi City and Mahjong Soul both fix it at roughly 30°
elevation looking at the table centre, for the whole match. That single fact removes almost
all of the reason to use a 3D engine:

- **No dynamic projection.** One camera, one projection matrix, computed once.
- **No mesh geometry.** Tiles are flat quads. A tile lying on the table is a foreshortened
  rectangle; a tile standing in your hand is an upright rectangle with a visible top edge.
  Both are sprites.
- **No dynamic lighting.** Shading is baked into the sprite. It never changes, because the
  light and the camera never change.
- **A small, enumerable orientation set.** Because the camera is fixed, a tile lying flat near
  the top of the table looks essentially like one near the bottom. You need roughly four
  rasterizations per tile, not one per position.

So: 42 tile faces × ~4 orientations, plus backs and edge strips. A few hundred sprites, one
atlas, a few hundred KB. That is a 2D sprite problem wearing a 3D costume, which is exactly
what Pixi is for.

Three.js becomes correct only if you want a moving camera, real lighting, or tiles that
physically tumble — a materially more expensive product than the one §1 describes.

## 2. Coordinate model

Two spaces, one transform between them.

- **Table space** — `(x, y, z)` in tile units, origin at table centre. `y` is depth (away from
  the local player), `z` is height above the surface (wall tiles stack 2 high).
- **Screen space** — pixels.

`project(x, y, z) → (sx, sy, scale)` is a fixed perspective transform. `scale` shrinks tiles
toward the far edge. Every visual is positioned in table space and projected; nothing is
positioned in pixels.

**Z-sorting is yours, and that is the point.** Draw back-to-front sorted by table-space `y`
(then `z`). This is the specific thing CSS cannot do correctly — browsers composite
3D-transformed elements with their own painter heuristics and will sort flat-lying and upright
tiles wrong at some angles, with no clean fix. Owning the sort removes a whole class of bug.

## 3. Asset pipeline

`mjrc-app/web/src/features/tiles/render.ts` already produces every tile as SVG. That stays the
source of truth.

Build step: rasterize each tile at each orientation, at 1×/2×/3× DPR, into a texture atlas.
Runtime never parses SVG. Tile thickness and the table shadow are baked into the sprite rather
than composed at runtime.

This also means the art direction question (heritage bone palette vs the current bright `PAL`)
is a build-time input, not a renderer concern. Changing the palette re-runs the atlas.

## 4. Animation architecture — the part that matters

**Presentation lags state; state never waits for presentation.**

```
engine reducer ──emits events──▶ animation queue ──drains──▶ scene
       │                                                       │
       └────────── authoritative state ────────────────────────┘
                    (input always binds here)
```

- The reducer's state is authoritative and updates instantly.
- The renderer keeps its own *presentation state* that trails behind.
- Each event pushes an animation onto a queue; the queue drains at its own pace.
- If the queue gets deep — reconnect, tab was backgrounded, replay scrubbing — **snap
  presentation to authoritative state and drop the queue.** Never play forty animations to
  catch up.

Three hard rules that follow:

1. **Animation never gates input.** The claim window's 5s timer starts server-side the moment
   the discard commits. If the client animates for 400ms and *then* shows call buttons, the
   player has silently lost 400ms of their window. Show the buttons immediately; animate
   underneath them.
2. **Resync snaps.** §5.3's reconnect is snapshot + actions-since. Apply it as a state
   replacement with no animation.
3. **Every ceremony is skippable.** Tap to finish. A player who has seen the win animation
   two hundred times must be able to dismiss it.

**The payoff:** the replay viewer becomes free. It is the same renderer fed the same events
from the log instead of a socket. Scrubbing is queue-drop plus snap. Nothing extra to build.

## 4a. Two table layouts — and why HK is the default

Ship both. **HK table is the default**; Riichi-style ordered is a setting.

| | **Old-school (default)** | **Diagram mode** |
|---|---|---|
| Discards | One jumbled pile in the centre, tiles at arbitrary angles, **never overlapping** | Six-wide ordered rows in front of each seat, in throw order |
| Melds | As they sit on the table | Squared up beside each seat |
| Wall | 144 = 4 walls of **18 stacks, 2 high** (36 each), laid out as a **diamond** so the corners point at the players | Same tiles, tidied |
| Dead wall | No flipped indicator — HK has no dora | Dora indicator face-up |
| Flowers | Face-up tray in front of each player | Does not exist |
| Centre | Nothing — a real HK table has no score box; scores live on the seat badges | Score box with all four points, round, tiles left |
| Sticks | None | 1000-point riichi sticks accumulate in the centre |

**Why Riichi's rows are ordered is a rules fact, not a style choice.** Furiten and formal
discard-reading make the order and ownership of every discard load-bearing, so the convention
(and automatic tables) enforce tidy rows. HK has no furiten, so nothing forces tidiness, and
in practice tiles get thrown into the middle. The messiness is downstream of the ruleset.

### The pile must never overlap

A tile thrown onto a table lands flat, at an angle, **next to** the others. It does not stack
on them. So the pile is messy but every tile stays individually visible and countable —
counting the discards is a core skill, and a pile you cannot count is worse than useless.

The guarantee is geometric, not eyeballed. Lay cells out on a staggered grid whose side is the
tile's **diagonal**: a rectangle rotated by *any* angle fits inside a square of its own
diagonal, so if centres are never closer than one diagonal, no two tiles can overlap at any
rotation. Staggering alternate rows by half a cell breaks the grid read; the nearest-centre
distance across a stagger is 1.047 × cell, so the guarantee survives it, and a jitter margin
is built into the cell size. Verified numerically at 10/30/60/80 tiles.

The in-plane guarantee also survives the perspective transform: projecting a plane is a
homography, and homographies map disjoint regions to disjoint regions.

### The trap in rendering the pile faithfully

A physical HK pile **destroys information**: after a few turns nobody can reconstruct who
discarded what, or in what order. That is fine at a real table because tiles cannot remember.

But the skills the product intends to teach depend on exactly that information — safety by
count, reading a player's discards, everything the hand-review screen annotates. Rendering a
faithful pile and stopping there would delete the data the teaching layer runs on.

**Digital does not have the physical constraint.** So: keep the HK look, keep the data.

- The event log already holds the true ordered sequence with attribution — the pile is
  rendered *from* that fold, not from a lossy per-seat array.
- Attribution is available on demand: a per-seat colour ring (toggle in the sketch), tap a
  tile to see who discarded it and on which turn, and the full ordered list in review.
- Default to the messy look with the data one interaction away.

That combination — the table feels like a Hong Kong table, but nothing is forgotten — is
something only a digital HK game can offer, and no competitor is positioned to want it.

### Rendering consequences

1. **Z-sorting stops being cosmetic.** A pile is dozens of overlapping quads at arbitrary
   rotations, all at z≈0. Draw order *is* the visual. This is the strongest argument in this
   document for owning the painter's algorithm rather than leaving it to CSS compositing.
2. **Scatter must be deterministic**, seeded from the event index. If it is random per frame
   the pile visibly reshuffles every tick, and replay scrubbing becomes nauseating. The sketch
   uses a hash of the tile's index.
3. **Sprite rotation is free in Pixi and nearly free in CSS** — a flat tile rotated about the
   vertical axis looks the same under a fixed light, so one baked sprite covers all angles.
4. **The pile grows.** Budget for ~60 loose tiles at the end of a long hand, plus melds and
   walls. Still trivially inside a sprite renderer's budget.
5. **The wall is an object, not a counter.** Four walls of 18 stacks, two high, as a diamond.
   It depletes contiguously from the break point, so roughly a third of it is already gone
   once the deal finishes — which is exactly what a real table looks like when play starts.

## 5. Animation inventory

Timings are opening proposals, tuned against a 5s claim window.

| Trigger event | Animation | Budget |
|---|---|---|
| `deal` | 13 tiles per seat, staggered, arcing from wall to hand | 700-900ms total, skippable |
| `flower_replace` | Flower lifts out to the flower tray, replacement slides in from the wall | 260ms |
| `draw` | Tile lifts off the wall to the hand's right edge, landing in the gap | 160ms |
| `discard` | HK: arc into the centre pile, land at a deterministic angle, small bounce. Riichi: to the next slot in the player's row | 180ms |
| `claim_offered` | Call buttons rise with the countdown ring already running | 90ms, **non-blocking** |
| `claimed` | Claimed tile flies from pool to claimant's meld area, meld rotates to show source seat | 320ms |
| `kong_replace` | As draw, from the dead-wall end | 180ms |
| `refused_win` | Tile pulses amber, floor message appears | 400ms |
| `ron` / `tsumo` | Hand reveals, faan bars stack in one at a time, total counts up | 1.6-2.2s, skippable |
| wall depletion | Continuous — stacks vanish as tiles are drawn | — |

**Flower replacement is the signature HK animation.** Riichi has no equivalent, so no
competitor has one. Worth making it feel good.

**The tile toss is the other one.** In HK the discard is thrown, not placed. A discard that
arcs and tumbles into a pile at a believable angle is the single most recognisable motion in
Hong Kong mahjong, and it is the thing that will make a Cantonese player say "that is our
game" within two hands.

Respect `prefers-reduced-motion`: fall back to cross-fades and keep the timings.

## 6. Budget and targets

- 60fps on an iPhone 12-class device during a deal; 30fps floor on low-end Android.
- Sprite count on screen: under ~200 typical, ~400 at deal peak. Trivial for Pixi.
- Time-to-first-interaction after match start: under 1s, atlas preloaded during matchmaking.
- Atlas: a few hundred KB per DPR tier, loaded once and cached.

## 7. The interface to fix now

Everything above is deferrable **provided** the scene stays behind a boundary and the rest of
the client never reaches into scene DOM:

```ts
interface MatchScene {
  mount(el: HTMLElement, opts: SceneOpts): void;
  setView(v: SeatView): void;      // authoritative snapshot — snaps, no animation
  applyEvent(e: GameEvent): void;  // enqueue one animation
  flush(): void;                   // drop the queue, snap to current view
  destroy(): void;
}
```

Two implementations over time: `DomScene` (P0) and `PixiScene` (later). Same interface, same
event stream, same log. §5's doctrine — the client is *disposable by design* because the
engine is a pure reducer holding all the logic — is what makes this a genuine swap rather
than a rewrite.

## 8. Phasing

| Phase | Renderer | When |
|---|---|---|
| 0 | Flat DOM sketch, no animation | now — settling screens |
| 1 | `DomScene`: CSS 3D transforms, the animation queue above, real timings | P0 |
| 2 | `PixiScene`: sprite atlas, owned z-sort, same queue | after the P0 gate |
| 3 | True 3D | probably never; needs a moving camera to justify |

Phase 1 already gets the queue, the timings, and the interface right. Phase 2 then replaces
only the drawing.

## 9. What to decide now

1. **Adopt the `MatchScene` interface before writing P0 scene code.** Cheap now, expensive later.
2. **Keep tile art rasterizable** — no runtime-only SVG tricks that can't bake into a sprite.
3. **Fix the camera angle early** (~28-32° elevation). Sprite orientations are baked against
   it, so changing it later means re-rasterizing.

Everything else can wait.

---

## Appendix — a correction about the current sketch

The sketch re-renders `innerHTML` on a 10fps interval. That is a shortcut for sketching speed,
**not** a demonstration of what DOM can do, and it would not survive contact with a real
device. It is also precisely the pattern §4 above exists to prevent: state and presentation
collapsed into one thing, redrawn wholesale. Do not read the sketch's rendering approach as a
proposal.

# MJRC Game — P0 screen sketches

Interactive sketches for the screens in `../DESIGN.md` §2, built to judge **flow and
feel**, not styling. Real tile art; everything else is deliberately plain.

```bash
open -a "Google Chrome" /Users/augustineliu/Local_Projects/mjrc/mjrc-game/sketches/mjrc-game-sketches.html
```

## Files

| File | What it is |
|---|---|
| `mjrc-game-sketches.html` | **The thing you open.** Single self-contained file, no server. |
| `index.html` | Source shell + stylesheet |
| `engine.js` | HK rules + the §5.2 state machine (source) |
| `ui.js` | Screens and interaction (source) |
| `tiles.gen.js` | Generated — `esbuild` bundle of `mjrc-app/web/src/features/tiles/render.ts` |
| `build.py` | Inlines the three scripts into the single file |
| `PAGE-INVENTORY.md` | The full screen brainstorm, tiered P0 / P1 / Later / No |
| `BACKEND.md` | What runs server-side, and where WebSockets fit |
| `ANALYSIS.md` | Review metrics (the eval-bar question) and observer mode |
| `RENDERING.md` | Gameplay renderer & animation proposal — DOM now, Pixi later, and the interface to fix today |

Edit the sources, then `python3 build.py`. To refresh the tile art after `render.ts` changes:

```bash
cd /Users/augustineliu/Local_Projects/mjrc/mjrc-app/web && ./node_modules/.bin/esbuild src/features/tiles/render.ts --bundle --format=iife --global-name=MJTiles --outfile=../../mjrc-game/sketches/tiles.gen.js
```

## What is actually real

The match scene is not a mockup — it runs the DESIGN.md §5.2 state machine:

- Claims with correct priority (`ron > kong/pong > chow`, ties to nearest seat), chow only
  from the left neighbour, pong/chow → claimant discards without drawing
- All three kong forms including own-turn concealed kong, with replacement draws
- Flowers auto-replace recursively in strict seat order
- **The 3-faan minimum**: wins below it are refused and emit a visible `refused_win`
  event rather than silently rolling back (§5.2's teaching moment)
- One named-deadline map dispatched from a single timer — mirrors the DO's one-alarm
  constraint (§5.3), so a claim window cannot clobber a turn clock
- Bots answer on a paced delay, never synchronously, so response timing never leaks
  who is holding a claim
- Every transition emits a §5.5-shaped event; **the replay viewer is a genuine fold over
  that log**, not a separate recording

Verified: hand-size invariant holds across 53,308 checks over 150 simulated hands.

## What is stubbed, and where the real work is

| Stubbed here | The real thing |
|---|---|
| `faanFor()` — a handful of patterns | Exposed-meld scoring decomposition, §5.1 — **2-3 weeks, the core of P0** |
| Bots — route steering only, no live tiles 有效牌 *jau haau paai*, no defence | §6, a product blocker not polish |
| Faan-floor warning — a rail toggle, not computed | Needs the same evaluator §7 defers |
| Ratings — flat ±18/−9 | Provisional Elo, §3 |
| Wall/distance-to-ready | Port the **unpruned** Python reference — the prune is wrong on 6-10% of hands |

The bot texture readout in the left rail simulates 120 hands live. It currently shows
~55-63% exhaustive draws and ~1 refused win per hand — the §6 problem made visible. Those
are the four numbers gate 3 measures against humans.

## Structure (revised 2026-08-26)

**Persistent header bar**, not a left nav rail — identity, rating, room context and settings
on every screen. Areas: Auth (landing / sign-in / handle) · Home (rating, three-number stats
strip, modes, updates feed) · Play (bots, players, create, join, rooms) · Match · **Review**
(match history → hand review → replay viewer, in that order of prominence) · Learn · Settings.

**Rooms are reused, not invented.** `mjrc-admin/docs/scoring-domain-model.md` already defines
a Room as "join code + pinned ruleset + player roster + N tables" with room-scoped identity.
The room detail screen shows online matches and offline Almanac sessions in one list under one
roster — the only context where comparing the two is defensible, because roster identity is
exact by construction (`ACCOUNTS-BUILD-SPEC` §8.2).

**Hand review annotations are rule-derived only.** `keyMoments()` reads facts out of the event
log: dealt in, melded below the 3-faan floor, passed a legal winning claim, discarded a tile
with 2+ of 4 already visible. Nothing that requires a route evaluator. Verified: the
visibility counter never exceeds 4 across 200 simulated hands, and the count annotation says
"no pung or kong wait possible — a chow wait still is" rather than "safe", because in HK it
isn't.

## Interaction grammar

Borrowed from Mahjong Soul / Riichi City, HK rules underneath: drawn tile separated by a
gap, call buttons bottom-right with a countdown ring, fixed claim window, auto-pass toggle,
per-seat discard pools arranged around the table, melds shown per seat.

## Deviations from DESIGN.md (decided 2026-08-26, spec not yet amended)

1. **Landscape, not portrait.** §2 says "portrait-first layout is the requirement" on the
   short-form→phone funnel argument. Sketches are landscape across phone / iPad / desktop.
   A portrait frame is kept for comparison.
2. **Desktop app (Mac/PC) is a target.** §1 says "no native apps at launch."
3. **Stats screen added** — offline (Almanac) vs online (game), side by side, never blended.
   The bridge is `ACCOUNTS-BUILD-SPEC.md` §8.2's trust-ranked `player_links`; the game is a
   new source at the top of that ranking. §8.3's principle governs: unverified linking turns
   *honestly fuzzy* stats into *confidently wrong* ones.

## Findings against the current specs

- **DESIGN.md §3 Track A is stale.** It puts "8 flower/season faces + tile back" on the P0
  critical path. `render.ts` already ships `tileFlower()` (0-3 梅蘭菊竹, 4-7 春夏秋冬),
  `tileBack()`, and `labelOverlay()` for non-Chinese readers. Only `art/draft-v2/` is still
  34 faces. That gate is cleared.
- **`tileDragon` renders 白 as a blank double frame**, but `art/design-txt/style_guide.txt`
  says 白 "has the character 白 written on it, not a blank frame." Both conventions exist on
  real sets — needs a decision, not urgent.
- **`render.ts` palette contradicts the positioning.** `PAL` is bright and modern
  (`#FAFAF8` face, `#1845A5` blue, `#D42222` red); the style guide specifies the heritage
  bone set (ivory `#EDE4CC`, indigo `#2C3352`, muted red `#B83A3A`). §1 makes craft
  aesthetic differentiation leg #1. Deferred by instruction — style comes later.

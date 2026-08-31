# The game client — spec of record

**What this document is:** the durable record of what the playable client *is*,
which decisions were taken, and where it deliberately departs from the plans.
Add notes freely — §7 is yours, and §8 is the log. Anything written here beats
inference from the code.

**What it is not:** a design plan. Those exist and remain authoritative:



//i will make comments. unsure if they should go in this document. some of my comments might be better in other documents. plan accordingly. 

| question                                                          | authority                        |
| ----------------------------------------------------------------- | -------------------------------- |
| Product shape, architecture, what the engine owns                 | `../../DESIGN.md`                |
| Full motion system — lanes, invariants, per-motion frame budgets  | `../../ANIMATION.md`             |
| Renderer choice, coordinate model, HK table layout, pile geometry | `../../sketches/RENDERING.md`    |
| Table talk, avatars, expression catalogue                         | `../../EXPRESSIONS.md`           |
| Terminology (Japanese terms are banned repo-wide)                 | `../../TERMINOLOGY.md`           |
| Rules, faan values, payment ladders                               | `../../RULES-HK.md`, `rulesets/` |
| Bot strength, what each opponent actually is                      | `../../tools/sim/experiments.js` |
| How to run and rebuild this client                                | `README.md`                      |

---

## 1. Scope of the current build

Single player, one wind round, three bots, entirely local. No server, no
accounts, no matchmaking. Opening `index.html` is the whole product.

This is deliberate: `DESIGN.md` §5 makes the client disposable because the
engine is a pure reducer holding all logic. Nothing here decides a rule, so
replacing this renderer later costs nothing but the renderer.

//I'm adding in some creature comfort design decisions just to make this feel a little bit more fun for like a random person But some of the design decisions I come up with we might want to move it into like a design or an animation document But yeah 

## 2. Settled decisions

| decision                                     | rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **DOM + CSS, not canvas or 3D**              | `RENDERING.md` §1. A DomScene is P0; a Pixi renderer replaces it mechanically behind `client/src/scene/MatchScene.ts` when sprite counts demand it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **The site's own SVG tile art**              | `tile-engine.js`, copied from `mjrc-app/web/public/tiles/`. One tile vocabulary across the game, the scoring pages and the studio. Re-copy after lab changes; the source of truth is `primitive-lab.html`. //You might have to regenerate the SVG tile art. I noticed that the tile art has dimensions written on the tiles. That was an artifact from the design process. In the final design we don't actually need all those measurements obviously.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Opponents are the frozen training ladder** | `v0`…`v4` plus `persona-action`, carried in `bots.js`. Difficulty is a *measured* quantity — every one of those bots has a chips/match number against the others. //I think it'd be good to be able to configure the bots in the settings. I think we base-lined our v4 bot because that one is the most capable. There might be couple of variations. One might be a slightly more defensive variation, one might be a very aggressive variation that goes for really big hands. Another one might be just like a very balanced one which is what I think the normal bot is. Yeah, they should all play defense. I think a bot that does not play defense is pretty worthless and it plays very weirdly so I would not do that.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **The pile never overlaps**                  | `RENDERING.md`: centres sit on a staggered grid whose cell is the tile's diagonal, so a tile at any rotation cannot touch a neighbour. Counting discards is a core skill. //I think the pile is sort of an interesting design decision we're kind of experimenting with. I think there's two modes for the pile. So one maybe three modes. So mode one is like let's use the default pile this is like classical Hong Kong. So when you have a classical Hong Kong style you have basically people like they throw tiles into the middle and then tiles just sort of accumulate around that tile. The tiles that are thrown don't move they stay in one place so you have to keep that in mind. There's a lot of different ways of doing this. One way is to kind of pre-plan that original pile and where they're going to get thrown or use a physics engine but either one I really just want to kind of see it look like an organic pile. The second mode is maybe a very organized mode which will be like you know tossing them in order I think Mahjong Time does this where they just like it just accumulates in rows and columns from left to right. And then the third mode might be Ritchie style which like each player basically puts their tiles in like a nice clean you know box. So we can let people select them I think the original classic one is like the most fun and the most authentic but we just have to make it look correct on with the physics engine or at least with like the tossing right so you would toss it and it would sort of like land in a particular orientation and that middle pile shouldn't move and shouldn't readjust so we have to kind of know how many tiles fit in the middle. |
| **One scale knob**                           | Every tile size derives from `--th` × `--tscale`. The settings slider moves one variable; nothing else needs to know. //Yes, also make sure that the wall tiles are kind of the same size. I think tiles in your hand can look bigger. That makes sense? Tiles that are exposed should be a certain size, and then tiles in the wall and tiles that are in the middle should probably be a very similar size, but both legible. Right?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Rules are switchable at runtime**          | MJRC standard (3–10), published HK (3–13), TVB 2026 (1-faan, linear, no flowers). The engine takes a `Ruleset`; the UI only picks one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Dev mode shows the bot's real reasoning**  | It calls the same `assessRoutes` / `rankDiscards` the bot calls. It is a window, never a narration — if it disagrees with play, the window is wrong.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 3. Deviations from the plans — read before "fixing" anything

- **Animation timings are the owner's, not `ANIMATION.md`'s.** That spec budgets
  a toss at **310 ms local / 380 ms remote** and a draw at 380 ms. This build
  runs **toss 1000 ms, draw 700 ms, wall build 1100 ms** — set by the owner on
  2026-08-29. The spec's numbers assume a motion system with wind-up, grasp and
  settle phases carrying the weight; this client has none of those, so the
  slower values are doing that work instead. When the full motion system lands,
  these come back down — do not treat the difference as a bug.
- **No lanes, no interruption policy.** `ANIMATION.md` §4 and §7 specify a lane
  system and a per-motion interruption policy. This build uses plain CSS
  keyframes with no scheduler. Acceptable only because everything is local and
  decorative; it must be replaced before online play.
- **Invariant I4 (transform/opacity only) is honoured for animated properties**
  but the pile positions tiles with `left`/`top` (static, never animated) and
  `.hot` uses `outline`/`box-shadow` (static). Re-check when the lint lands.
- **Invariant I1 (animation never gates input) holds by construction** — no
  code path awaits an animation. This must stay true when the server clock
  arrives: the claim window is server-side and animating before mounting the
  buttons silently spends the player's time.
- **The wall is decorative.** The engine's wall is a shuffled array. The ring on
  screen carries the count and erodes from the live end; it is not a model of
  which physical tile comes next. //I actually think it's worth trying to treat the wall as a as an actual wall. You know the logic isn't super required for testing the game but I think it gives a bit of a sense of what it's like so for example you would have you know all four walls built you would throw dice you would then count around the wall and then you would determine from there how to pull tiles from the wall and I think that's good logic to kind of like test into this early stage. The thing with the wall is that the wall is traditionally shaped like a diamond. It's not shaped like a box like you have here it's sort of like an overlapping diamond so you can look up photos online to see what it looks like but I think we should attempt to mimic that shape. Also note that when we when we have flowers we draw from you know the flower side of things 

## 4. Layout conventions

- Human is always **chair 0, bottom**. Seat +1 is to the **right** (turn order
  runs to the right), so 上家 — the only seat you may chow from — is on your
  **left**. This matches the engine's `discardDanger` comment and must not be
  mirrored casually.
- Seat winds, dealer mark 莊 and the dealer-repeat rule are engine state,
  rendered, never computed here.
- Tosses arc in **from the thrower's seat direction**, which is how a player
  reads who threw without looking at the log.

### Timing

| beat | ms | where |
| ---- | -- | ----- |
| wall build | 1450 | `buildWall()` + `assemble` keyframes (.82s a tile, staggered) |
| draw off the wall | 900 | `DRAW_MS` → `--drawms`, `botDraw` for the bots |
| toss | 1300 | `TOSS_MS` → `--tossms` |
| a call on screen | 2200 (3200 for a win) | `callIn` keyframes AND the timer in `announce()` — **change both** |
| hold after a claim | 750 | `CLAIM_HOLD_MS` — nothing else moves while a meld goes down |
| hold after a flower | 500 | `FLOWER_HOLD_MS` |

The call's entrance stays quick in absolute terms because the keyframe
percentages were moved with the duration; what got longer is the hold.

The hold is armed by `announce()`, not by the event switch, so it fires exactly
when a call was really made and shown — the flower gate included — and it is
spent in `advance()` before the next bot moves. It **never delays you**:
`advance()` drops the hold the moment you have a legal action, both because
MatchScene.ts rule 1 forbids an animation taking an affordance away, and
because if the call was yours you have already spent the beat making it.

### The discard heap

Three passes, in order, per discard — and only for the tile just thrown:

1. **Search.** Creep outward from the thrower's anchor in ~1 px rings, forty
   angles a ring, four candidate rotations an angle; take the first spot that
   touches nothing. Four rotations because a tile that will not fit at one tilt
   often fits at another.
2. **Gravity.** Walk the tile back toward its anchor in 0.5 px steps until a
   neighbour stops it.
3. **Basin-hop, 220 times.** Sidestep up to ±7 px and ±11°, then fall again;
   keep the result only if it ended nearer the anchor. Without this the tile
   parks against the first thing that blocks its radial line and leaves a gap
   beside it — the difference between 51 % and 60 % density.

Overlap is tested with a separating-axis check on the true rotated rectangle,
fed the tile's **measured** size (`offsetWidth/offsetHeight`, which ignores the
CSS rotation) plus 0.3 px. Never a hardcoded size: the settings slider scales
tiles, and a stale constant of 30 px against a rendered 36 px is exactly how
tiles came to overlap.

A placed tile **never moves again**, and its DOM node is keyed to a discard id,
never to a count — `render()` runs two or three times a turn and a claim lifts a
tile back off the pile, so anything count-based re-creates settled tiles and
restarts their toss animation.

## 5. Known gaps

Sound · replay viewer · avatars and expressions (`EXPRESSIONS.md`) · richer
claim/win ceremony · online play (`DESIGN.md` §5.3 specifies snapshot +
actions-since resync, which the renderer boundary already assumes) · no test
coverage on this client (the engine beneath it has ~1,980 tests).

## 6. Open questions

1. Difficulty presentation — do players pick a *table* (as now) or a single
   difficulty tier that composes the table for them?
2. Should dev mode ship to players as a "learn" mode, given the discard coach
   already exists in `tools/sim/play.html`? //no we're still teting
3. Table talk (`EXPRESSIONS.md`) is specced but unbuilt — is it P1 for feel? 
4. //I think it might be worth kind of like coming up with a schema for how to animate and declare certain things so for example when someone pongs something right now just silently grabs the tiles but I think we can like write on the screen pong and you know sorry when any time certain activities happen other things that we can do is like if someone gets two flowers of the same kind or crack flower we can kind of like put up the the Cantonese Chinese and English kind of version it just sort of like indicate to people oh something happened and that I think will keep the game exciting and like you know things kind of happening. Maybe propose a couple different things to actually say that are taken from the table talk page and propose some. 
5. 查叫 (not-ready pays ready at a draw) is still an open owner ruling; it would
   change both the rules config and the end-of-hand screen.

## 6a. Note triage — where each of your comments is tracked

Your comments stay where you wrote them (they are your voice, and the context
matters). This table says what happened to each and where it now lives.

| your note | status | home |
|---|---|---|
| Tile art shows measurement dimensions | **fixed** — the lab's `SHOW_MEASURE` flag was left `true`; the consumer now sets it `false`. Verified: zero numeric text nodes in rendered tiles. | here |
| Flowers hard to read | **fixed** — flowers render at a larger size than other melded tiles. | here |
| Tile sizes: hand big, exposed mid, wall ≈ pile, all legible | **fixed** — hand 78 px, melds 52, exposed 44, pile 38, wall stacks sized to match. | here |
| Walls jump around; wall should not move, just subtract | **fixed** — the wall is built once per hand and only erodes; consumed stacks hide in place, nothing reflows. | here |
| Pile must not readjust; tiles land and stay | **fixed** — each discard is assigned a slot ONCE from a centre-out spiral (step = tile diagonal, so no overlap at any rotation) and never moves again. | here |
| Draw a smaller box for the table | **fixed** — felt with a wooden rim, dark room around it. | here |
| Pung/chow happens silently and is jarring | **partly done** — canned calls now announce 碰 / 上 / 槓 / 食糊 / 自摸 with Cantonese leading. The *grab* animation (tile travelling from the pile into the meld) is still to do. | here + `ANIMATION.md` §6 |
| Visual timer, ~30 s, slow is fine | **done** — a bar under the table. It is a nudge: nothing expires, nothing is played for you. | here |
| Dev mode: two boxes, and the helper must persist | **done** — separate "what the bots are thinking" and "discard helper" boxes; the helper keeps a scrollable graded history of what you actually threw. | here |
| Mahjong makes a diamond; walls overlap at the corners | **partly done** — walls are pinwheeled (each runs past its neighbour) and the surface sits in perspective, two tiles high. A true diamond orientation with dice and a counted break is not built. | `sketches/RENDERING.md` — needs a wall section |
| Real wall: dice, count around, break point, flowers from the dead end | **not built** — proposed for the next pass. The dead wall is marked visually but is not yet where flowers actually come from. | `sketches/RENDERING.md` |
| Three pile modes: classic organic / rows-and-columns / Riichi boxes, selectable | **not built** — classic is what exists. Modes belong with the layout spec. | `sketches/RENDERING.md` §4a |
| Melds should sit in the owner's orientation, not the viewer's | **not built** | `sketches/RENDERING.md` |
| Bot variants in settings: defensive / aggressive / balanced, all defending | **not built** — and it changes the ladder presets: `v0` and `v1` do not defend, which you called worthless. Variants would be derived from `v4`. | here §2 + `tools/sim/` |
| Announce events with Cantonese/English (flowers, pairs of flowers, etc.) | **partly done** — claims and wins call out. Flower and other table-talk phrasing should come from the catalogue. | `EXPRESSIONS.md` |

## 7. Owner notes

_Add anything here — rulings, taste calls, things that felt wrong while playing.
Dated entries are easiest to act on later._

- _(2026-08-29) — first entry goes here._

## 8. Decision log

| date       | decision                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-08-29 | Client built: local single-player, DOM renderer, site tile art, ladder opponents.                             |
| 2026-08-29 | Owner: tiles were too small — hand tiles to 78 px, one `--tscale` knob, settings slider 80–200 %.             |
| 2026-08-29 | Owner: use the existing tile art rather than unicode glyphs.                                                  |
| 2026-08-29 | Owner: tiles must not overlap — implemented the diagonal-cell guarantee from `RENDERING.md`.                  |
| 2026-08-29 | Owner: settings panel for rules and display; dev mode for bot analysis.                                       |
| 2026-08-29 | Owner: animate the wall — build ≈1.1 s, draw 0.7 s, toss 1.0 s (overrides `ANIMATION.md` §6 budgets; see §3). |
| 2026-08-29 | Owner review round 2 — see §6a for the full triage. Fixed: measurement artefacts, flower legibility, tile-size hierarchy, immovable wall, immovable pile, table box, calls, turn clock, split dev boxes. |
| 2026-08-29 | Wall rebuilt to match the owner's photo: pinwheeled corners, two tiles high, 18 stacks a side, whole surface in perspective. |
| 2026-08-30 | Discard pile = the **organic heap** (`pile-lab.html` layout 8), chosen from ten sketches against the owner's photo of a real table. |
| 2026-08-30 | Owner: "as tight as possible without overlapping." Packer is now search → gravity → basin-hop (see §4). Density 60 %, footprint 295×291 for 55 tiles; the lab reads 30 k area against 69 k for the first cut. |
| 2026-08-30 | A discard lands on **its thrower's side** of the heap, as at a real table, not in the middle. |
| 2026-08-30 | Tiles are **named** by the mark printed on their face — `4●` circles, `4▮` bamboo, `4萬` characters — and honours/flowers in English. Most players do not read Chinese. Tile ART is unchanged. |
| 2026-08-30 | The toss is **one flight**, thrower's seat straight to the tile's slot. No waypoint, no overshoot in the easing. |
| 2026-08-30 | The helper grades in **colour** — green played it, amber close, red it cost you — with the grade as a chip, not a border stripe. |
| 2026-08-30 | The helper now covers **claims**: live TAKE/SKIP advice while the buttons are up, then a kept grade. It calls `assessClaim` / `claimDecision` / `shouldKong`, so the advice IS the bot's reasoning, not a story about it. |
| 2026-08-30 | Beats slowed ~30 %: toss 1.0 → 1.3 s, draw 0.7 → 0.9 s, wall build 1.1 → 1.45 s. Calls hold ~1.6 s legible (2.2 s run, 3.2 s for a win) against ~0.7 s before. |
| 2026-08-30 | A legitimate call **stops the table**: 750 ms after a pung/chow/kong, 500 ms after a flower, before anything else animates. Never applied to the human's own turn. |



//Other things I would prefer? I kind of prefer if like when all the players meld their tiles, I think they should meld. I'm trying to get this to look as much like a normal Hong Kong mahjong table as possible so when they meld it should be melded in their orientation not the players orientation so I think that would make things look a little bit more realistic. Other things I'm really struggling to read the flowers so we might need to work on making the flower number bigger so it's easier to kind of like read what what which flower we have. 

//I also noticed that the walls jump around a lot right now and I think there's a weird logic of like keeping the walls centered and what else is the logic doing? Yeah so I think the computer right now is trying to keep the wall centered and it's also trying to I guess they're just decorative so it keeps moving around that's not how people actually draw tiles. Like the wall should not move and you simply subtract tiles from that wall. Other interesting quirks. I think we need to animate certain actions, so for example, one thing that's very jarring when you pung or seurng is that it just sort of like flashes, and then you don't know what happened, whereas I think if someone pungs it, like there should be sort of a grabbing animation from moving the tile from the middle into the person's hand. Yeah, I think that would a little bit less jarring Yeah. 

//We should add a visual timer at the bottom. The timer can be slow. I think that's fine. Maybe like 30 seconds. I think most testers will be fine with that 

//Also when I turn on dev mode, I think we should have two different boxes. There's a box that says what the bots are thinking and we should also maybe have a box that says what the discard engine discard helper thinks. And they should be two different boxes. The discard helper, what happens is it proposes what it would do and the moment I move it like disappears and I don't read it. So, I think just having it stay on the page that I can scroll up and down, I think that'd be good and it telling me like hey, like that's a good discard or a bad discard I think be helpful. 

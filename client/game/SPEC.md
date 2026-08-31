# The game client — spec of record

**What this document is:** the durable record of what the playable client *is*,
which decisions were taken, and where it deliberately departs from the plans.
Add notes freely — §7 is yours, and §8 is the log. Anything written here beats
inference from the code.

**What it is not:** a design plan. Those exist and remain authoritative:

| question | authority |
|---|---|
| Product shape, architecture, what the engine owns | `../../DESIGN.md` |
| Full motion system — lanes, invariants, per-motion frame budgets | `../../ANIMATION.md` |
| Renderer choice, coordinate model, HK table layout, pile geometry | `../../sketches/RENDERING.md` |
| Table talk, avatars, expression catalogue | `../../EXPRESSIONS.md` |
| Terminology (Japanese terms are banned repo-wide) | `../../TERMINOLOGY.md` |
| Rules, faan values, payment ladders | `../../RULES-HK.md`, `rulesets/` |
| Bot strength, what each opponent actually is | `../../tools/sim/experiments.js` |
| How to run and rebuild this client | `README.md` |

---

## 1. Scope of the current build

Single player, one wind round, three bots, entirely local. No server, no
accounts, no matchmaking. Opening `index.html` is the whole product.

This is deliberate: `DESIGN.md` §5 makes the client disposable because the
engine is a pure reducer holding all logic. Nothing here decides a rule, so
replacing this renderer later costs nothing but the renderer.

## 2. Settled decisions

| decision | rationale |
|---|---|
| **DOM + CSS, not canvas or 3D** | `RENDERING.md` §1. A DomScene is P0; a Pixi renderer replaces it mechanically behind `client/src/scene/MatchScene.ts` when sprite counts demand it. |
| **The site's own SVG tile art** | `tile-engine.js`, copied from `mjrc-app/web/public/tiles/`. One tile vocabulary across the game, the scoring pages and the studio. Re-copy after lab changes; the source of truth is `primitive-lab.html`. |
| **Opponents are the frozen training ladder** | `v0`…`v4` plus `persona-action`, carried in `bots.js`. Difficulty is a *measured* quantity — every one of those bots has a chips/match number against the others. |
| **The pile never overlaps** | `RENDERING.md`: centres sit on a staggered grid whose cell is the tile's diagonal, so a tile at any rotation cannot touch a neighbour. Counting discards is a core skill. |
| **One scale knob** | Every tile size derives from `--th` × `--tscale`. The settings slider moves one variable; nothing else needs to know. |
| **Rules are switchable at runtime** | MJRC standard (3–10), published HK (3–13), TVB 2026 (1-faan, linear, no flowers). The engine takes a `Ruleset`; the UI only picks one. |
| **Dev mode shows the bot's real reasoning** | It calls the same `assessRoutes` / `rankDiscards` the bot calls. It is a window, never a narration — if it disagrees with play, the window is wrong. |

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
  which physical tile comes next.

## 4. Layout conventions

- Human is always **chair 0, bottom**. Seat +1 is to the **right** (turn order
  runs to the right), so 上家 — the only seat you may chow from — is on your
  **left**. This matches the engine's `discardDanger` comment and must not be
  mirrored casually.
- Seat winds, dealer mark 莊 and the dealer-repeat rule are engine state,
  rendered, never computed here.
- Tosses arc in **from the thrower's seat direction**, which is how a player
  reads who threw without looking at the log.

## 5. Known gaps

Sound · replay viewer · avatars and expressions (`EXPRESSIONS.md`) · richer
claim/win ceremony · online play (`DESIGN.md` §5.3 specifies snapshot +
actions-since resync, which the renderer boundary already assumes) · no test
coverage on this client (the engine beneath it has ~1,980 tests).

## 6. Open questions

1. Difficulty presentation — do players pick a *table* (as now) or a single
   difficulty tier that composes the table for them?
2. Should dev mode ship to players as a "learn" mode, given the discard coach
   already exists in `tools/sim/play.html`?
3. Table talk (`EXPRESSIONS.md`) is specced but unbuilt — is it P1 for feel?
4. 查叫 (not-ready pays ready at a draw) is still an open owner ruling; it would
   change both the rules config and the end-of-hand screen.

## 7. Owner notes

_Add anything here — rulings, taste calls, things that felt wrong while playing.
Dated entries are easiest to act on later._

- _(2026-08-29) — first entry goes here._

## 8. Decision log

| date | decision |
|---|---|
| 2026-08-29 | Client built: local single-player, DOM renderer, site tile art, ladder opponents. |
| 2026-08-29 | Owner: tiles were too small — hand tiles to 78 px, one `--tscale` knob, settings slider 80–200 %. |
| 2026-08-29 | Owner: use the existing tile art rather than unicode glyphs. |
| 2026-08-29 | Owner: tiles must not overlap — implemented the diagonal-cell guarantee from `RENDERING.md`. |
| 2026-08-29 | Owner: settings panel for rules and display; dev mode for bot analysis. |
| 2026-08-29 | Owner: animate the wall — build ≈1.1 s, draw 0.7 s, toss 1.0 s (overrides `ANIMATION.md` §6 budgets; see §3). |

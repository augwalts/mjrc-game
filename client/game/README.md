# The game

A playable HK Old Style match: you against three bots from the training
programme, over the real engine.

Open `index.html` (any static server) — no build step at runtime, no backend,
no accounts. State lives in memory; your record persists in `localStorage`.

    python3 -m http.server 8480 --directory client/game

## Settings (⚙ in the top bar)

- **Rules** — MJRC standard (3–10 faan), HK Old Style published (3–13), or TVB
  Championship 2026 (1-faan floor, linear payments, no flowers). Applies to the
  next match; the engine does the rest.
- **Tile size** — 80–200%. Everything scales off one CSS variable.
- **Bot speed** — 0 (instant) to 1.2s per move.
- **Dev mode** — shows what each bot is planning (its top routes, distance and
  who it fears) and how the champion would rank YOUR discards, using the same
  `assessRoutes` / `rankDiscards` calls the bot itself makes.

## What it is

- **The real engine.** `game.ts` renders `MatchState` and posts `Action`s back.
  It decides no rules: legality, scoring, payments and the 3-faan floor all come
  from `engine/` and `rulesets/`, exactly as the simulations use them.
- **Measured opponents.** `bots.js` carries the frozen ladder — `v0` (the
  original defenceless bot) through `v4` (the strongest bot the programme
  produced), plus `persona-action` (nearly as strong, far more watchable).
  Difficulty here is a measured quantity: see `tools/sim/experiments.js`.
- **The site's own tile art.** `tile-engine.js` is the SVG engine copied from
  `mjrc-app/web/public/tiles/` — the same faces the scoring pages draw, with
  real pip geometry. Flowers and seasons are keyed BY CHARACTER because the
  engine's array order (梅蘭竹菊) differs from the tile ids (梅蘭菊竹).
- **A pile that never overlaps.** Discards land on a staggered grid whose cell
  is the tile's DIAGONAL, so a tile rotated by any angle still cannot touch its
  neighbour (`sketches/RENDERING.md`). Counting the discards is a core skill; a
  pile you cannot count is worse than useless.
- **HK table conventions.** Chow is offered only from 上家; the seat and
  round winds, dealer mark 莊 and dealer repeats are all engine state.

## Rebuild after changing `game.ts`

    ../../../mjrc-app/web/node_modules/.bin/esbuild client/game/game.ts \
      --bundle --platform=browser --format=iife --outfile=client/game/game.js

Refresh the bot roster after a new champion is frozen:

    python3 -c "import json;d={k:json.load(open('tools/sim/%s.json'%f)) for k,f in \
      [('v0','baseline-v0'),('v1','baseline-v1'),('v2','baseline-v2'),('v3','baseline-v3'),\
       ('v4','baseline-v4'),('persona','persona-action')]}; \
      open('client/game/bots.js','w').write('window.BOTS = '+json.dumps(d)+';\n')"

## Not built yet

Animations beyond the toss and draw pops · sound · replay viewer · avatars and
expressions (`EXPRESSIONS.md`) · online play (`DESIGN.md` §5.3 specifies the
snapshot + actions-since resync the renderer boundary already assumes).

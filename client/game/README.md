# The game

A playable HK Old Style match: you against three bots from the training
programme, over the real engine.

Open `index.html` (any static server) — no build step at runtime, no backend,
no accounts. State lives in memory; your record persists in `localStorage`.

    python3 -m http.server 8480 --directory client/game

## What it is

- **The real engine.** `game.ts` renders `MatchState` and posts `Action`s back.
  It decides no rules: legality, scoring, payments and the 3-faan floor all come
  from `engine/` and `rulesets/`, exactly as the simulations use them.
- **Measured opponents.** `bots.js` carries the frozen ladder — `v0` (the
  original defenceless bot) through `v4` (the strongest bot the programme
  produced), plus `persona-action` (nearly as strong, far more watchable).
  Difficulty here is a measured quantity: see `tools/sim/experiments.js`.
- **HK table conventions.** Discards land in a loose central heap, not tidy
  rows (`sketches/RENDERING.md`); chow is offered only from 上家; the seat and
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

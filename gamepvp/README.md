# gamepvp — the PvP build's Worker

One Cloudflare Worker hosts the whole online game: the client as static
assets, the platform API, the WebSocket into each match's Table Durable Object,
and the invite-only gate in front of all three. Solo (the frozen demo, a Pages
project at the repo root) is untouched by anything here.

Plan and status: `../../PVP-MULTIPLAYER-PLAN-2026-09-01.md`.

```
gamepvp/
  wrangler.jsonc        the Worker: assets, TABLES (DO), DB (D1), LOGS (R2), vars
  src/index.ts          gate → /api (worker/src/index.ts) · /table/:id (DO socket) · assets
  src/bots.ts           BotBrain over engine decideAction; the seat lineup
  src/bot-profiles.json the frozen champion dials (from client/game/bots.js)
  build.sh              bundles ../client/gamepvp into assets/ (gitignored)
  test/smoke.mjs        headless match over real HTTP + WebSocket (see test/README.md)
  test/assemble-log.mjs stitches a local wrangler dev's per-hand R2 blobs into whole logs
  .dev.vars             local secrets and TABLE_CONFIG fast clocks (gitignored)
```

## Run it locally

```sh
# once: the game's tables into the local D1
cd gamepvp && npx wrangler d1 execute mjrc-scoring --local --file ../worker/schema.sql

# every time the client changes
./gamepvp/build.sh

# the server (port 8877 in .claude/launch.json; 8787 is often taken)
cd gamepvp && npx wrangler dev --port 8877
```

Open http://localhost:8877 — Basic Auth, any username, password from
`.dev.vars` (`GAME_PASSWORD=dev`). After the first prompt the browser holds an
`mjrc_gate` cookie and everything, socket included, goes through.

`.dev.vars` needs `GAME_PASSWORD`, `REPLAY_TOKEN_SECRET` (≥ 32 chars) and may
carry `TABLE_SECRET` and `TABLE_CONFIG`. **A `.dev.vars` change needs a server
restart**; source changes hot-reload (and drop live sockets).

## Prove a match end to end

```sh
# a full wind round, 1 human seat driven by a trivial policy + 3 bots (~2 min on fast clocks)
MJRC_BASE=http://127.0.0.1:8877 MJRC_GATE_PASSWORD=dev node gamepvp/test/smoke.mjs
MJRC_HUMANS=2 node gamepvp/test/smoke.mjs      # two seats joining by code

# gate 2: the archived log re-executes to itself
node gamepvp/test/assemble-log.mjs gamepvp/.wrangler/logs <matchId>
./node_modules/.bin/vite-node tools/replay/cli.ts -- gamepvp/.wrangler/logs/<matchId>.json --verify
```

## The two planes

- **Control plane, HTTP, stateless** — `POST /api/identity` (device token →
  player), `POST /api/tables` (create; the creator is seat 0), `POST
  /api/tables/:code/join` (lowest free human seat; calling again re-issues the
  seat token — the reconnect path), `GET /api/matches[/:id[/log]]`.
- **Match plane, one WebSocket per seat** — `/table/:matchId`, `join` with the
  seat token, then `prompt` / `events` (each batch carries the seat's post-batch
  `snapshot`) / `presence` / `accepted` / `rejected`. The client never computes
  legality and never folds events into state.

The lobby reaches the DO only through two control calls, `/init` (deal hand 0,
never re-run for the same match) and `/seat` (bind a player to a human seat,
rotate that seat's token). The Worker forwards nothing but WebSocket upgrades
to `/table/:matchId`, so those two are unreachable from outside.

Humans take the low seats in join order; bots fill from seat 3 down
(`src/bots.ts` `BOT_LINEUP`). Clocks start when every human seat is connected.

## Deploy — only with explicit approval

See the header of `wrangler.jsonc`. The first deploy creates the Worker and the
DO namespace; the R2 bucket and the secrets must exist first; the custom domain
line is commented out until approved. The D1 tables (`../worker/schema.sql`)
have to be applied to the remote `mjrc-scoring` database, numbered after the
accounts branch's migrations (plan §3 W1).

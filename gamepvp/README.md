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

# the lobby seat plan (§7.2): a bot at any seat, by profile key
MJRC_SEATS="human,bot:v4,human,bot:v2" node gamepvp/test/smoke.mjs
MJRC_SEATS="human,human,bot,bot" MJRC_MODE=ranked node gamepvp/test/smoke.mjs  # ranked_needs_humans if any seat is a bot

# host start with bot-fill (§7.2 /start): one human seat named in MJRC_SEATS
# is left unjoined, the creator calls /start, the match still completes
MJRC_SEATS="human,human,bot:v1,bot:v2" MJRC_START=1 node gamepvp/test/smoke.mjs

# gate 2: the archived log re-executes to itself
node gamepvp/test/assemble-log.mjs gamepvp/.wrangler/logs <matchId>
./node_modules/.bin/vite-node tools/replay/cli.ts -- gamepvp/.wrangler/logs/<matchId>.json --verify
```

## The two planes

- **Control plane, HTTP, stateless** — `POST /api/identity` (device token →
  player), `POST /api/tables` (create; the creator takes the first human seat
  in the plan — see "the lobby" below), `POST /api/tables/:code/join` (lowest
  free human seat; calling again re-issues the seat token — the reconnect
  path), `POST /api/tables/:id/start` (creator only: fill empty seats with
  bots and start), `POST /api/tables/:id/leave` (hand your seat to a bot for
  the rest of the match), `GET /api/lobby`, `POST /api/presence`, `GET
  /api/matches[/:id[/log]]`.
- **Match plane, one WebSocket per seat** — `/table/:matchId`, `join` with the
  seat token, then `prompt` / `events` (each batch carries the seat's post-batch
  `snapshot`) / `presence` / `accepted` / `rejected`. The client never computes
  legality and never folds events into state.

The lobby reaches the DO through four control calls: `/init` (deal hand 0,
never re-run for the same match), `/seat` (bind a player to a human seat,
rotate that seat's token), `/fill` (the creator's start-now bot-fill, §7.2
`/start`), and `/leave` (a participant's explicit leave). The Worker forwards
nothing but WebSocket upgrades to `/table/:matchId`, so all four are
unreachable from outside.

## The lobby

`PVP-LOBBY-PROPOSAL-2026-09-02.md` §7 is the contract. A table is created with
a **seat plan** — four seats, each `{ kind: 'human' }` or `{ kind: 'bot', bot?:
key }` — not a bot *count*: a bot may sit at any seat, not only the high ones.
The creator takes the first human seat in the plan. The legacy `botSeats` +
`bots` shape (bots fill from seat 3 down, `src/bots.ts` `BOT_LINEUP` is the
default lineup) still works — `postTable` converts it to the same plan shape,
humans in the low seats.

Clocks start once every human seat is connected, same as always, OR the
creator calls `POST /api/tables/:id/start`: every seat nobody ever claimed
becomes a bot (`defaultBotFor`, `src/bots.ts`), the player↔seat mapping
shuffles if the table was created with `randomizeSeats`, then the clocks
start. `GET /api/lobby` (poll every ~5s while the lobby screen is open) and
`POST /api/presence` (heartbeat every ~30s) are plain stateless reads/writes
over D1 — worker/src/db.ts's `presence`/lobby query helpers, worker/src/index.ts's
`getLobby`/`postPresence`.

## Deploy — only with explicit approval

See the header of `wrangler.jsonc`. The first deploy creates the Worker and the
DO namespace; the R2 bucket and the secrets must exist first; the custom domain
line is commented out until approved. The D1 tables (`../worker/schema.sql`)
have to be applied to the remote `mjrc-scoring` database, numbered after the
accounts branch's migrations (plan §3 W1).

## Schema changes not yet applied remotely

`../worker/schema.sql` picked up three `match_players` columns for server-side
move grading (`worker/src/table.ts` `BotBrain.grade`, 2026-09-01) after the
remote `mjrc-scoring` database was first created from that file, so the remote
copy is missing them. Applied to local D1 already (`npx wrangler d1 execute
mjrc-scoring --local --command "..."`, one per statement); someone with remote
access needs to run the same three against remote before a build that writes
these columns reaches production — `bindingArchive.finishMatch` will fail its
`UPDATE match_players` otherwise:

```sh
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE match_players ADD COLUMN moves_graded INTEGER NOT NULL DEFAULT 0"
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE match_players ADD COLUMN moves_matched INTEGER NOT NULL DEFAULT 0"
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE match_players ADD COLUMN gap_sum REAL NOT NULL DEFAULT 0"
```

The lobby (`PVP-LOBBY-PROPOSAL-2026-09-02.md` §7.1, 2026-09-02) added eight
`matches` columns, one `match_players` column and the new `presence` table.
Applied to local D1 already; someone with remote access needs to run the same
against remote before a build that reads/writes the lobby reaches production —
`GET /api/lobby`, `POST /api/presence`, `POST /api/tables/:id/start`, `POST
/api/tables/:id/leave`, and the table object's lobby writes in
`bindingArchive`/`maybeStartClocks`/`afterCommit` all depend on these:

```sh
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE matches ADD COLUMN access TEXT NOT NULL DEFAULT 'open'"
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE matches ADD COLUMN mode TEXT NOT NULL DEFAULT 'casual'"
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE matches ADD COLUMN lobby_status TEXT NOT NULL DEFAULT 'waiting'"
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE matches ADD COLUMN current_hand INTEGER NOT NULL DEFAULT 0"
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE matches ADD COLUMN hands_base INTEGER NOT NULL DEFAULT 4"
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE matches ADD COLUMN seat_plan TEXT NOT NULL DEFAULT '[]'"
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE matches ADD COLUMN randomize_seats INTEGER NOT NULL DEFAULT 0"
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE matches ADD COLUMN created_by TEXT"
npx wrangler d1 execute mjrc-scoring --remote --command "ALTER TABLE match_players ADD COLUMN connected INTEGER NOT NULL DEFAULT 0"
npx wrangler d1 execute mjrc-scoring --remote --command "CREATE TABLE presence (player_id TEXT PRIMARY KEY REFERENCES players(id), state TEXT NOT NULL, seen_at TEXT NOT NULL)"
npx wrangler d1 execute mjrc-scoring --remote --command "CREATE INDEX idx_presence_seen ON presence(seen_at)"
npx wrangler d1 execute mjrc-scoring --remote --command "CREATE INDEX idx_matches_lobby_open ON matches(lobby_status, started_at DESC) WHERE lobby_status IN ('waiting', 'playing')"
npx wrangler d1 execute mjrc-scoring --remote --command "CREATE INDEX idx_matches_lobby_done ON matches(lobby_status, ended_at DESC) WHERE lobby_status = 'done'"
```

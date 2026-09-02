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

`TABLE_CONFIG` (`worker/src/table.ts` `TableConfig`) also carries
`pauseMaxMs` (a pause auto-resumes after this long; default 10 minutes) and
`handEndIntermissionMs` (how long a `handEnd` is held, when a human seat is
connected, before the next hand is dealt; default 10s, `.dev.vars` sets it to
1s so the smoke test does not sit through it). `handEndIntermissionMs: 0`
disables the intermission — the table advances the instant a hand ends, same
as before the feature existed.

### Claim window and turn clock timing (§8a)

`claimWindowMs` scales with the decision instead of being one fixed number:
`{ pung, chow, win }` (default 6000/9000/15000ms; kong counts as pung). A
`TABLE_CONFIG` var may still set it to a single number — applied to all three,
same as before this existed — or the object, partial or complete (an omitted
kind keeps the default). `.dev.vars`' fast line uses the object form at a
tenth of the real scale.

A window's `closesAt` is the longest duration among the options offered to a
**human** seat in it. Once every human offered has answered, the window
closes at once — the duration is only how long it waits while one is still
pending. A window offered to no human at all (every seat in it bot, an
auto-played disconnect, or `requestAuto`) ignores `claimWindowMs` entirely and
resolves as soon as the last bot's answer lands; a bot still answers off its
own paced `botPace` deadline, never synchronously, so the window still runs
roughly one bot pace (`botMinPaceMs`-`botMaxPaceMs`, default 250-900ms) rather
than closing at zero. `botWindowMarginMs` (default 400ms, keeps a bot's
answer strictly inside a window a human might still be reading) does not
apply to a bot-only window for the same reason.

A table with exactly one human seat (by the header's `players`, not live
connection) never arms the turn clock — that seat's own turn waits
indefinitely; the disconnect grace and auto-play still cover an absent
player. A table with more than one human seat keeps `turnMs` as before.

### Speed presets (§8a-2)

"Beginners will really struggle with speed." A table has a `speed` —
`untimed | very-slow | normal | faster | insane` — fixed at creation and
applied as a `Partial<TableConfig>` layer, `worker/src/table.ts`
`SPEED_PRESETS`. The table's effective config resolves as **DEFAULT ← env
`TABLE_CONFIG` ← the speed preset ← `TableInit.config`** (`recomputeConfig`,
called on every hydration so a speed picked before hibernation survives it),
which is why `wrangler.jsonc`'s `TABLE_CONFIG` no longer sets `turnMs` or
`claimWindowMs` — a preset always wins over it now, so leaving them there
would only ever be silently overridden. `disconnectGraceMs` is the one field
no preset touches and stays the deployment's own call.

`POST /api/tables` accepts `speed`; when absent, `untimed` for a seat plan
with exactly one human, `normal` otherwise (`resolveSpeed`, `worker/src/
index.ts`). A room may fix it in `settings.game.speed`
(`POST /api/rooms`/`POST /api/rooms/:code/settings`'s own `speed` field) —
that wins over both the request and the human-count default for every table
created in the room, same as `rulesetId`/`matchFormat` already do. `matches.speed`
records it; the lobby's `tables[]` entries and `GET /api/matches/:id` both
include it.

`untimed` sets `turnMs: 0` and every `claimWindowMs` kind to `0`, meaning **no
deadline while a human is unanswered** — bots still pace themselves at
`botMinPaceMs`-`botMaxPaceMs` regardless, and a window/turn resolves only once
every human involved has actually answered (`windowReadyToClose`, unchanged;
`armDerived` simply arms no timeout at all when the duration is 0). `untimed`
also turns on `inactivityMs` (10 minutes): a human seat that has been
prompted — its turn, or an open window it has not answered — with no request
from it for that long is switched to auto-play (`book.auto`, the same
mechanism `requestAuto { on: true }` uses, with a `presence` broadcast); the
seat's own next request switches it off again, unchanged from how
`requestAuto` already worked. `inactivityMs` is a plain `TableConfig` field,
not `speed`-gated in code — every other preset simply leaves it at `0`
(disabled), because a table with a real clock already times a silent human
out through that instead.

**The start card.** When the table would start its clocks, it instead
persists `book.startingAt = now + startDelayMs` (default 8s; `0` skips the
hold — the fast dev config sets it to `0`, and a bot-only table always skips
it, there being nobody to show a card to), broadcasts `starting { startsAt,
settings }` to every open socket, and arms a `matchStart` deadline that
actually starts the clocks once it elapses. `welcome`/`restore` also carry
`starting: {...} | null` so a client that joins (or reconnects) while the
card is up sees it without a race. `settings` is `{ style: "hkos", rulesetId,
rulesetLabel, minimumFaan, limitFaan, useFlowers, paymentId, matchFormat,
speed, seats }` — the ruleset facts are resolved once in `gamepvp/src/
index.ts` (`tableInitOf`'s `matchSettingsOf`, via `@mjrc/rulesets`) and
carried through `TableInit.matchSettings`, so `worker/src/table.ts` stays
free of that import, same as it was before this feature. `requestNextHand`
from every connected human ends the hold early — the exact same message and
mechanism the hand-end intermission already reuses, since the two holds never
overlap in time.

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

# ranked settlement: all four seats human (the server refuses any bot in a
# ranked table); after matchEnd, GET /api/stats/me must show a real rating
MJRC_MODE=ranked MJRC_HUMANS=4 node gamepvp/test/smoke.mjs

# pause/resume: seat 0 pauses for 3s during hand 0, then resumes; the match
# still runs to completion
MJRC_PAUSE=1 node gamepvp/test/smoke.mjs

# speed presets (§8a-2): explicit speed overrides the human-count default;
# each seat answers `starting`/`handEnd` with requestNextHand, so the start
# card and the hand-end intermission never actually hold up the run
MJRC_SPEED=insane MJRC_HUMANS=2 node gamepvp/test/smoke.mjs

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
  /api/matches[/:id[/log]]`, `GET /api/stats/me`, `GET
  /api/players/:id/stats`, `GET /api/leaderboard?mode=ranked|casual`.
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
-- backfill for matches that predate lobby_status
UPDATE matches SET lobby_status='done' WHERE status IN ('complete','abandoned') AND lobby_status<>'done'
```

Chat (`PVP-LOBBY-PROPOSAL-2026-09-02.md` §8, 2026-09-02) added one table for
lobby chat; table chat needs no schema at all (`worker/src/table.ts`'s `K_CHAT`
ring lives entirely in the table's own DO storage). Applied to local D1
already; someone with remote access needs to run the same against remote
before a build that reads/writes lobby chat reaches production — `POST
/api/lobby/chat` and the `chat` field of `GET /api/lobby` depend on it.
Migration file: `migrations/remote-2026-09-02-chat.sql`.

```sh
npx wrangler d1 execute mjrc-scoring --remote --file migrations/remote-2026-09-02-chat.sql
```

## Rooms (§8b, 2026-09-02)

`PVP-LOBBY-PROPOSAL-2026-09-02.md` §8b is the contract; §9 is the why. A room
is the Almanac's, not the game's: `rooms` and `room_players` already exist in
the remote `mjrc-scoring` database, created by
`mjrc-app/web/migrations/0004_rooms.sql`, `0008_room_builder.sql` and
`0011_room_codes.sql`. The game reads `rooms.settings`/`admin_code_hash` and
writes only the `game` key of `settings`
(`{ "game": { "rulesetId", "matchFormat", "access" } }`,
`worker/src/db.ts` `roomGameSettingsOf`/`withRoomGameSettings`) and its own
`room_players` rows (the game's `players.id` as `player_id`, display name as
free-text `name`). It never touches `password_hash` or any other Almanac key.

**Routes** (all behind the same device-token `authenticate` as everything
else in `worker/src/index.ts`): `POST /api/rooms` (create + auto-join the
creator, `{ name, rulesetId?, matchFormat?, access?, adminCode }` →
`{ code }`, 6-char Crockford, retried on collision), `GET /api/rooms/:code`
(→ `{ code, name, game, memberCount, tables }`), `POST /api/rooms/:code/join`
(membership, idempotent), `GET /api/rooms/mine` (rooms the caller has
joined), `POST /api/rooms/:code/settings` (admin-only, changes `game`
only — see below), `POST /api/rooms/:code/tables/:matchId/close` (admin-only,
phase 2: abandons a still-waiting table; never touches the Table DO, since a
waiting table's clocks never started).

`POST /api/tables` accepts `roomCode`: the caller must already be a room
member (`not_room_member` 403 otherwise), `rulesetId`/`matchFormat` are taken
from the room's `settings.game` — the request's own values are ignored — and
`access` defaults from the room's `game.access` but an explicit `access` in
the request still overrides it. `matches.room_code` is set to the room's
code and the response echoes `roomCode`. `GET /r/:code` serves the app the
same way `GET /j/:code` does.

**The admin code, and why there is no master code on the game side.** A
room's `admin_code_hash` (0011) gates `POST /api/rooms/:code/settings` and
the table-close route via the `x-mjrc-admin-code` header, hashed and compared
exactly the way the Almanac's own `mjrc-app/web/functions/api/scoring/
room-admin/_middleware.ts` compares its own `x-room-code` header. That
middleware ALSO accepts a hardcoded master code (`8888`) on every route. This
Worker does not replicate it: that constant is scoped to the Almanac's own
`/api/scoring/room-admin/*` surface, is not passed to this Worker in any
config, and copying it here would let anyone who has read that file's source
administer every game room in every room in the database — a much bigger
blast radius than the Almanac ever accepted for its own surface. A room with
no `admin_code_hash` at all (impossible through `POST /api/rooms`, but
possible for an Almanac-created room nobody has configured) simply has no
admin on the game side until one is set.

**`GET /api/lobby?room=CODE`** scopes `here`, `tables`, `recent` and `chat`
to the room. `here` is presence rows for players who are ALSO a room member
(joined through `room_players`, since `presence` itself carries no room
column — same "keep the derived state out of the canonical table"
discipline `presence`'s own schema.sql comment states) or seated at the
room's own tables. Without `room`, the global lobby's `tables`/`recent`/`chat`
all exclude every room-scoped row (`room_code IS NULL`) — a room's traffic
does not leak into the general list — with ONE deliberate exception: the
global `here` still shows a member who is seated at a room's table, tagged
with `roomCode`, on the recorded call that hiding a friend entirely because
they wandered into a room is worse than a harmless tag. `POST
/api/lobby/chat` takes an optional `roomCode`; global if omitted.

**Local dev.** Local D1 never replays the Almanac's own migrations, so
`rooms`/`room_players` do not exist there unless created separately —
`migrations/local-almanac-rooms.sql` does that, **local only, never against
remote** (the Almanac's tables already exist there):

```sh
cd gamepvp && npx wrangler d1 execute mjrc-scoring --local --file migrations/local-almanac-rooms.sql
```

**Schema change not yet applied remotely.** `lobby_messages.room_code`
(nullable; `NULL` = the global lobby) is new — folded into
`../worker/schema.sql` and applied to local D1 already; someone with remote
access needs to run the same against remote before a build that reads/writes
room-scoped chat reaches production. Migration file:
`migrations/remote-2026-09-02-rooms.sql`.

```sh
npx wrangler d1 execute mjrc-scoring --remote --file migrations/remote-2026-09-02-rooms.sql
```

## Speed presets — schema change not yet applied remotely (§8a-2, 2026-09-02)

`matches.speed` (`TEXT NOT NULL DEFAULT 'normal'`) is new — folded into
`../worker/schema.sql` and applied to local D1 already; someone with remote
access needs to run the same against remote before a build that reads/writes
it reaches production — `postTable`'s insert, `GET /api/lobby`'s `tables[]`,
and `GET /api/matches/:id` all depend on it. Migration file:
`migrations/remote-2026-09-02-speed.sql`.

```sh
npx wrangler d1 execute mjrc-scoring --remote --file migrations/remote-2026-09-02-speed.sql
```

## The lobby shell's server side (§8, §8b, §10, §11, 2026-09-03)

`PVP-LOBBY-PROPOSAL-2026-09-02.md` §10 (the stats standard), §8 (DMs and the
inbox), §11 (build decisions) and §8b (rooms) implemented on the server —
`worker/src/index.ts`, `worker/src/db.ts`, `worker/src/table.ts`. The client
shell (real URL paths, the four-tab bottom bar) is a separate, concurrent
piece of work; this section is the API it talks to.

**Stats (§10).** Three datasets, one scope grammar, shared by every stats
surface and by the leaderboard:

- `GET /api/stats/record?scope` — Dataset A, one row per player
  (`{ playerId, displayName, games, hands, wins, winPct, ins, inPct, handsW,
  handsL, ptsW, ptsL, netPerHand, worthPerHand, selfDraws, avgWinFan,
  placements, rating, ratingGames, provisional, streakDays, bestStreak,
  movesGraded, agreement }`). `players=leaderboard` returns the same rows the
  leaderboard would, for the same scope.
- `GET /api/stats/histograms?scope` — Dataset B: `fan.byRuleset` (14 faan
  buckets, 13+ last), `fanByGame`, `handType`, `seatByRound`, `outcomes`,
  `ins` and `feeds` (per-opponent, §10's "who you win the most points off").
  Fan/handType/seatByRound are the CALLER's own wins in scope; `outcomes` is
  every hand in scope regardless of winner.
- `GET /api/stats/series?scope` — Dataset C: `progressionAvg` (cumulative
  chip total after each hand, one array per game plus the mean), `worthByGame`,
  `rating` (from `rating_history`), `activity` (densified, one row per day).

**Scope**, identical query params on all three plus `GET /api/leaderboard`:
`player` (default caller), `players=leaderboard`, `room`, `mode`
(`ranked`|`casual`), `rulesetId`, `style` (only `hk` exists; anything else is
400 `unknown_style`), `since`, `lastN`, `source` (`all`|`online`|`offline`;
every value queries the same online data today — `offline`/`all` add
`sourceNote: "almanac_link_missing"` until the Almanac account link exists,
per §10). `worthPerHand` is net chips per hand divided by that match's own
average winning-hand value, averaged over games — the ratio that makes
different rulesets' chip scales comparable.

`GET /api/leaderboard?mode=ranked|casual[&rulesetId=&room=&since=]` is now a
view over Dataset A: candidates need ≥5 completed matches in scope
(`SQL.leaderboardCandidates`), sorted by rating (`ranked`) or `worthPerHand`
(anything else), limit 50.

`GET /api/games/:id` is `GET /api/matches/:id` plus `progression` (each
seat's cumulative chip total after every hand) and `grading` (the caller's
own seat's move-grading numbers, pulled out of `seats[]`). `/api/matches/:id`
keeps working — same handler, two paths. `GET /api/games/:id/log` mirrors
`GET /api/matches/:id/log`.

**Friends (§11 build decision 1).** `GET /api/friends` — everyone the caller
has finished a match with (folded from `match_players`/`matches` at read
time, no table of its own), online first then starred then most games
together. `POST /api/friends/:id/star` / `.../unstar` — `friend_stars`, the
one real row this feature needs.

**Direct messages and the inbox (§8).** `GET /api/dm/:playerId` (last 100,
marks the thread read), `POST /api/dm/:playerId` (≤500 chars, 1 per 2s).
`GET /api/inbox` → `{ unread, items }`, merging real `inbox_items` rows
(`invite`, `room`, `result`) with DM thread summaries folded from
`dm_messages` at read time. `POST /api/tables/:matchId/invite { playerId }`
(participant-only) creates an `invite` item; `POST /api/inbox/:id/accept`
seats the invitee through the same seat-claim path `POST
/api/tables/:code/join` uses (factored out as `claimFreeHumanSeat`) and
returns the same handoff shape; `POST /api/inbox/:id/dismiss` clears any
kind. A `room` item fires for every OTHER member of a REAL room (never the
Open Hall — every player belongs to it, so that would notify everyone on
every table) when a table opens in it. A `result` item fires per human seat
when a match finishes (`worker/src/table.ts` `writeResultInboxItems`, called
from `bindingArchive.finishMatch` — casual and ranked alike, unlike rating
settlement). `room`/`result` ids are deterministic
(`room:<matchId>:<playerId>`, `result:<matchId>:<seat>`) and `INSERT OR
IGNORE`, so a retried write is a no-op rather than a duplicate notice.

**The Open Hall (§11.2, build decision 2).** A `rooms` row with code `OPEN`,
created lazily (`ensureOpenRoom`) the first time anything needs it — at the
latest, the caller's own `POST /api/identity`, which also joins them to it.
No `game` key in its `settings` at all ("no presets": any ruleset, any
length, any speed — `postTable` already treats a room with no `game` key
exactly like no room, which is the point) and no `admin_code_hash` (nobody
administers it). **`POST /api/tables` with no `roomCode` now defaults to
`OPEN`** rather than leaving `matches.room_code` null — every table lands
somewhere in the rooms system. `GET /api/rooms/mine` pins it first,
unconditionally. Room codes fold look-alikes the same way join codes do
(`normaliseCode`) EXCEPT the literal `OPEN`, checked before that fold —
otherwise `normaliseCode("OPEN")` would corrupt it to `"0PEN"` (Crockford
excludes `O`) and `/r/OPEN`, `/rooms/OPEN`, and a client-sent `roomCode:
"OPEN"` would all 404. `normaliseRoomCode` is the fix, and every room-code
call site uses it, not `normaliseCode` directly.

**`GET /api/rooms/:code`** gains `players[]` — members who are
online/waiting/playing right now (not the whole roster; `memberCount` is
that), built the same way `GET /api/lobby`'s room-scoped `here` is.

**Schema change not yet applied remotely.** `players.tz_offset_min`
(`INTEGER NOT NULL DEFAULT 0`, §11 build decision 5 — set from `POST
/api/identity`/`POST /api/presence` when the body carries `tzOffsetMin`;
streak days and "today" are counted in it), and three new tables
(`friend_stars`, `dm_messages`, `inbox_items`) — folded into
`../worker/schema.sql` and applied to local D1 already; someone with remote
access needs to run the same against remote before a build that reads/writes
any of stats/friends/DMs/inbox reaches production. Migration file:
`migrations/remote-2026-09-03-shell.sql`.

```sh
npx wrangler d1 execute mjrc-scoring --remote --file migrations/remote-2026-09-03-shell.sql
```

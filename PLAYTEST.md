# The playtest harness

A playability test you can leave running: two panes of the real gamepvp
client — a phone and a desktop — sitting at **one match**, playing themselves,
stepping through every screen in the app. Built to answer two questions
quickly: *does this behaviour work?* and *what size is this at both widths?*

Everything runs on this machine. `wrangler dev` is miniflare: the Worker, the
Table Durable Object, D1 and R2 are local files under
`gamepvp/.wrangler/state/`. No Cloudflare account is touched, nothing is
metered, and it is safe to loop for hours.

## Run it

```sh
cd /Users/augustineliu/Local_Projects/mjrc/mjrc-worktrees/playtest
./gamepvp/build.sh
cd gamepvp && npx wrangler dev --port 8878
```

Then open **http://localhost:8878/playtest** — Basic Auth, any username,
password `dev` (`gamepvp/.dev.vars`'s `GAME_PASSWORD`).

Or from the launch configs: **`gamepvp-playtest`** (port 8878). It is on its
own port and its own worktree on purpose — port 8877 and
`mjrc-worktrees/gamepvp` are the live PvP build's, and the two would share
Durable Object state.

Press **▶ run**. Nothing else is required of you.

## What the controls do

| | |
|---|---|
| **▶ run / ■ stop** | start or stop the reel |
| **↻ loop** | start over as soon as it finishes — this is the "leave it running" switch |
| **speed** | the table's speed preset, fixed at creation, exactly as the New table screen sets it |
| **length** | 東圈 one wind (about 4 hands) or 全莊 four winds |
| **think** | how long a pane stares at a prompt before answering. This is the dial that decides whether you are watching or waiting: 0.3s to get through a match, 2–4s to actually read the claim bar |
| **freeze on** | arm a trap. The next event of that kind pauses the table for real (the same `requestPause` the HUD button sends), so nothing advances and no clock runs out while you look |
| **peek** | a freeze puts the Paused screen over the board you froze to see; peek hides that one overlay. Purely cosmetic, and nothing in the app is patched to do it |
| **thaw** | resume, and re-arm the trap |
| **zoom** | `fit` scales both panes to the window. **One scale for both**, never one each — that is what keeps the two boxes an honest size comparison |

The log strip along the bottom carries every applied event, per pane, and
every click a pane made (`✋`).

## How it plays itself

Each pane answers prompts **by clicking the real DOM** — a tile in `#myhand`,
a button in `#actions`. It never sends a request of its own and never reads
the client's internal state. That is deliberate: the prompt UI, the claim bar,
the optimistic-discard toss and the turn clock all run exactly as they do
under a finger, so what you are watching is the real thing rather than a
simulation of it.

The discard policy is a beginner's heuristic over nothing but the tile ids on
screen — throw the most isolated single first, honours before suits, never
break a pair. It is not trying to play well: the two real bots at seats 2 and
3 do that, and a seat that played perfectly would be a *worse* test, because
half the UI worth watching (a claim you lost, a hand you never finished) would
stop happening.

## Adding a screen to the test

Edit the `REEL` array in `client/gamepvp/playtest.html`. **Nothing else.**

```js
{ name: "Rooms",     route: "/rooms",                  hold: 3500 },
{ name: "New table", route: "/", click: "#ctaPlay",    hold: 6000 },
```

| field | |
|---|---|
| `name` | what the log and status line call it |
| `route` | a shell path to walk both panes to |
| `click` | a CSS selector to press in both panes, once the page has painted |
| `then` | a second selector, pressed shortly after `click` |
| `hold` | how long to sit there, ms — a freeze suspends this |
| `do` | `"match"`, the one stop that plays a whole game |

A screen reachable by URL needs only `route`. One that opens from a button
needs `click` with that button's selector. Neither needs `playtest.ts` to
change — go there only when a pane needs to *do* something new (a new kind of
request, a new thing to watch for), not when it needs to *show* something new.

Then `./gamepvp/build.sh` and reload. (Only `playtest.html` is copied by the
build; `playtest.ts` is bundled into `game.js` with the rest of the client.)

## The pieces

| | |
|---|---|
| `client/gamepvp/playtest.html` | the harness: two iframes, the controls, and the reel |
| `client/gamepvp/playtest.ts` | the autopilot inside each pane — remote-controlled, reports what it sees |
| `client/gamepvp/game.ts` | one fork at boot: `?playtest=a\|b` hands over to the harness |
| `client/gamepvp/table.ts` | the playtest seam — three read hooks and the live socket, all null in a normal session |

The two panes are `Play A` (seat 0, creates the table) and `Play B` (seat 1,
joins by code), each with a fixed device token so a loop reuses the same two
player rows instead of filling D1 with a new player per run.

## Notes

- **The start card** only appears when `.dev.vars`'s `TABLE_CONFIG` has
  `startDelayMs` above 0. The current file sets it to 0 so the smoke test does
  not sit through it.
- **A `handEnd` or `matchEnd` trap** lands on top of the reveal/scoreboard, and
  pause replaces what was in the panel — peek cannot bring it back. For those
  two, watch the reel's own hold instead of arming a trap.
- **Local state grows** as you loop — a few hundred KB of Durable Object and R2
  per match. To reset: stop the server and
  `rm -rf gamepvp/.wrangler/state/v3/do gamepvp/.wrangler/state/v3/r2`, then
  re-apply the schema (`npx wrangler d1 execute mjrc-scoring --local --file
  ../worker/schema.sql`) if you clear D1 too.
- **Timers are throttled** in a background browser tab, to roughly one second.
  The reel holds against a deadline so it does not stretch, but a backgrounded
  playtest still plays slowly. Keep the tab visible.

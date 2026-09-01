# Putting the game on the website, behind a password

Status: **BUILT and verified locally. Not deployed — the secret is not set and
nothing is merged.** Kept as the record of why it is shaped this way.
Written 2026-08-31.

---

## 0. Done already

`playable-demo` is pushed to `augwalts/mjrc-game` at `19ac0d8` — 24 commits,
today's whole session. Nothing else has been touched.

---

## 1. The good news: the game is already a static folder

No build integration is needed. What ships is five files:

| file | size |
| --- | ---: |
| `game.js` | 180 KB |
| `tile-engine.js` | 57 KB |
| `index.html` | 31 KB |
| `bots.js` | 3 KB |
| **total** | **271 KB** |

(`pile-lab.html` and `call-lab.html` are development tools and should not ship.)

Astro passes `public/` through untouched — that is already how
`mahjongresearch.com/tiles/tile-engine.js` is served. So the game dropped into
`public/game/` is live at `/game` with **no Astro work at all**.

Worth noting: `tile-engine.js` in the game is a **copy of the app's own**
`public/tiles/tile-engine.js`. Deployed inside the app it should point at the
original instead — one less duplicate, 57 KB less to ship, and the tile art can
never drift between the game and the scoring pages.

## 2. The password gate already exists

`mjrc-app/web/functions/directory/_middleware.ts` is exactly this problem,
already solved and already in production for `/directory`:

- HTTP **Basic Auth**, one shared password, any username
- the password is a Pages secret, not in the repo
- constant-time comparison against SHA-256 digests
- **fails closed** — an unset secret returns 503 rather than publishing
- `.dev.vars` for local `wrangler pages dev`

**Copy it to `functions/game/_middleware.ts` with `GAME_PASSWORD` and change the
realm string.** That is the entire gate. It covers `/game` and everything under
it, including the assets, because Pages middleware applies to the whole subtree.

```
wrangler pages secret put GAME_PASSWORD --project-name mjrc
```

Do **not** reach for the console's 4-digit code pattern here. Its own comment
says it is "a tripwire against a leaked URL, not a credential system", and it
guards data that is already public elsewhere. A friends beta wants the real one.

## 3. The one open question: how the files get there

The two repos are separate, and that is the only genuine decision left.

### A — build the game into `mjrc-app/public/game/` from a sibling checkout
A script in `mjrc-app` that runs esbuild against `../mjrc-game`.
**Against:** the app's build then only works on a machine that has both repos
side by side. Cloudflare's build would not. Rules itself out.

### B — commit the built files into `mjrc-app` *(recommended for the beta)*
Copy the four files into `mjrc-app/web/public/game/` and commit them.
**For:** works today, no build coupling, 271 KB — and only ~214 KB once the
tile engine is de-duplicated. Deploys through the app's existing PR flow.
**Against:** a built artifact in source control, and a manual copy step each
time the game changes. Both are real, and both are acceptable for a beta whose
whole point is that the game changes fast and friends see it.

### C — its own Pages project on a subdomain
`game.mahjongresearch.com`, deployed straight from `mjrc-game`.
**For:** no copying, the game's repo owns its own deploy.
**Against:** a second Pages project, a second secret, a second deploy flow, and
the gate has to be written fresh rather than copied. Also a second place for
the tile art to drift.

### D — merge the repos
The monorepo question from `PLATFORM-PROPOSAL.md` §5, still deferred, still
real surgery, and still not forced by anything here.

**Recommendation: B.** It is the smallest thing that puts the game in front of
friends this week, it reuses the deploy flow and the gate that already exist,
and it does not spend the monorepo decision to get there. Revisit when the copy
step actually becomes annoying — which is a much better time to choose C or D
than now.

## 4. Where on the site

`mahjongresearch.com/game`. Short, obvious, and it does not collide with
`/almanac`, `/scoring`, `/studio` or `/directory`.

The lobby needs one addition either way: a way back to the rest of the site.
Right now the game is a closed loop with no link out.

## 5. What I would do, in order

1. De-duplicate the tile engine — point the game at `/tiles/tile-engine.js`.
   Do this first; it is the only change that touches the game's own code.
2. Add `mjrc-app/web/public/game/` with the four files.
3. Add `functions/game/_middleware.ts` — copy of the directory gate, `GAME_PASSWORD`.
4. `wrangler pages secret put GAME_PASSWORD --project-name mjrc`.
5. Verify locally on `wrangler pages dev`: the gate prompts, a wrong password
   fails, an unset secret 503s.
6. PR into `mjrc-app`, per the deploy flow.

## 6. What was actually built

Owner ruled: a sub URL, password protected, with intro copy, and **the data must
reach the server rather than sit on the device.**

| | |
| --- | --- |
| `mjrc-app/web/public/game/` | the four static files, 271 KB, via `tools/publish-demo.sh` |
| `functions/game/_middleware.ts` | the gate — a copy of the directory one, `GAME_PASSWORD` |
| `functions/game/api/match.ts` | one finished match, idempotent on the client's id |
| `functions/game/api/feedback.ts` | one note, with the game state attached |
| `migrations/0012_game.sql` | `game_match`, `game_move`, `game_feedback` |
| `client/game/sync.ts` | drains the local store to the server |
| the About panel | what this is, what we are testing, and that games are recorded |

**One reversal from §1.** I said the game should stop shipping its own
`tile-engine.js` and use the app's. It should not: they are byte-identical
today, but pointing at `/tiles/` couples the game to this one site's URL layout
and breaks both the standalone server and the labs. 57 KB is cheaper than that
coupling — and `publish-demo.sh` now fails loudly if the two ever diverge, which
was the risk that actually mattered.

**Why the API sits at `/game/api/` and not `/api/game/`**: one middleware then
covers the page, its assets and its uploads, and the browser attaches the
credentials it already holds for that path.

**Why the event log is not uploaded**: D1's maximum SQL statement is **100 KB**;
an event log is 187 KB for one wind and 754 KB for four. The action log goes up
gzipped instead — 28 KB of actions stored in 664 bytes, verified to decompress —
and replaying it through the pure reducer regenerates the events exactly.

### Verified against `wrangler pages dev` with real D1

- `/game` unauthenticated → **401** with the right realm; wrong password → 401
- assets and the API are behind it too (`game.js` and `POST match` both 401)
- correct password → 200, the game runs
- a game played in the browser **uploaded itself** — match row, 3 graded moves
  with real tile names and gaps, gzipped replay
- feedback landed linked to its match, context blob intact
- a re-send produced **one** row and **three** moves, not two and six

### Still to do before friends see it

1. `wrangler pages secret put GAME_PASSWORD --project-name mjrc`
2. Merge `game-demo` in `mjrc-app` through the usual PR flow
3. Decide whether the lobby needs a link back to the rest of the site

## 7. Two things still open

1. **A, B, C or D** — I recommend B.
2. **The path**: `/game`, or something else?

And one thing to know rather than decide: everything the game records lives in
**IndexedDB on the player's own device**. Nothing reaches you until there is a
server. Friends can play and their stats are theirs alone; you will not see a
leaderboard across testers, and their feedback sits on their machine. If seeing
that data is part of why this is going up, the upload endpoint is the next piece
of work and it is not small.

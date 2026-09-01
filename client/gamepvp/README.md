# gamepvp client

A thin view over a server-authoritative WebSocket mahjong table. Retrofit of
Solo's `client/game/game.ts` (byte-for-byte copy, then rebuilt) — same DOM
structure, CSS, tile art (`tile-engine.js`) and animations; the local turn
loop is gone, replaced by a wire protocol client.

**Doctrine, unchanged from Solo's and stated more strongly here**: the client
has zero game authority. It never computes legality, never predicts an
outcome, and never mutates the UI on a button press — only on the server's
reply. `snap` (a `SeatSnapshot`) is the server's redacted fold of the match
for *this seat only*; it is replaced whole, never patched.

## Files

- `net.ts` — the wire layer. Identity + lobby HTTP calls (`identify`,
  `createTable`, `joinTable`, `listMatches`, `matchDetail`), and
  `TableSocket`: connect, `join`, reconnect with backoff, `resync`, heartbeat
  echo, and a typed callback per server message. Holds no game state.
- `game.ts` — the client: DOM rendering, tile art, animations, screens, and
  the coach. Everything it knows about the match comes from `net.ts`'s
  callbacks.
- `index.html`, `tile-engine.js`, `bots.js` — unchanged from Solo except the
  `<title>` and two small HUD spans (`#netStatus`, `#hudNote`) for connection
  state and transient notes.
- `SPEC.md` — Solo's spec of record; still the authority on the animation
  system, layout conventions and known gaps that this retrofit inherited
  unchanged (the pile-packing algorithm, the wall's decorative erosion, the
  motion-queue rule, portrait-vs-landscape).

## Message flow

1. Boot: read a stored device token + display name from `localStorage`
   (`mjrc.gamepvp.deviceToken`/`displayName`); if present, call
   `identify()` to confirm/refresh; else show the name screen.
2. Lobby → **New table** (`POST /api/tables`) or **Join by code**
   (`POST /api/tables/:code/join`). Either way you get `{ matchUuid,
   joinCode, seat, seatToken }`, persisted to `sessionStorage` under
   `mjrc.gamepvp.activeMatch` so a reload re-joins the same match through the
   join-by-code endpoint (`resumeOrLobby()`).
3. `TableSocket.connect()` opens `wss://…/table/<matchUuid>`, sends `join`.
   `welcome` carries the seat, the directory and a full `SeatSnapshot` — the
   table renders immediately even before every human has connected (the
   server deals hand 0 at table-open time, `worker/src/table.ts`
   `handleInit`). A waiting-room veil sits over the table until every human
   seat in `directory` shows connected, or the first `prompt` arrives
   (whichever is proof the clocks started).
4. `events`/`restore` messages carry a batch of `RedactedGameEvent`s **and**
   the snapshot from after they landed. `applyBatch()` enforces the
   contract literally: `consume(events)` animates against the *old* `snap`
   (still in scope), then `snap` is replaced. This ordering matters for one
   thing specifically — a `claimed` event's landing-meld index has to be
   computed from the pre-claim meld count, not the post-claim one, since
   Solo's synchronous reducer loop used to update `state` before consuming
   events and this client deliberately does the opposite.
5. `prompt` is the only source of legality. `actionsOf(mySeat, legal)`
   (`protocol/src/seatview.ts`) turns it into the same `Action[]` shape the
   old `legalActions()` produced, so the render/click code barely changed.
   Clicking sends a `request*` with a fresh `requestId` and disables the
   button (`pending = null`) until `accepted` or `rejected` comes back; a
   rejection re-enables the prompt and shows a short note.
6. The turn/claim clock reads `prompt.deadlineTs` (Unix ms) and runs
   `requestAnimationFrame` **only** while a deadline is armed — cancelled the
   instant it passes or a new prompt/no-prompt state arrives. Solo's clock
   ran continuously from boot; this was the one item on the client
   performance budget called out by name (PVP-MULTIPLAYER-PLAN §2.2).
7. `matchEnd` shows a scoreboard from the event's own `standings`/
   `placements`, built up live from `sessionHands` (accumulated during play,
   not fetched back from the server) plus a local `coachTally` for "engine
   agreement". "Back to lobby" closes the socket and clears the session key.
8. Reconnect: on an unexpected socket close, `TableSocket` retries with
   capped exponential backoff and re-sends `join` with the same seat token
   (the server does not invalidate it on disconnect — the token *is* the
   reclaim credential, `table.ts` comment on `handleJoin`). If `join` itself
   is rejected `unauthenticated` (an expired/consumed token), the callback
   re-fetches one via `joinTable()` and retries over the same socket
   (`TableSocket.rejoin()`). After every successful `welcome`, and on
   `visibilitychange` back to `visible` (iOS suspends the socket in the
   background), the client also sends an explicit `resync(lastSeq)` as a
   race hedge — cheap since it is almost always an empty answer.

## What was removed from Solo, and why

- **The local turn loop.** `advance()`, the bot `setTimeout` chain, `act()`
  applying the reducer directly, and the `startMatch`/`startNextHand`/
  `applyAction`/`legalActions` imports are gone. The server is now the only
  thing that ever calls the reducer.
- **`state: MatchState` → `snap: SeatSnapshot`.** Every seat is read
  relative to `mySeat` (which can be 0-3, not always 0) via `rel()`
  (screen position: 0 = you/bottom, 1 = right, 2 = across, 3 = left) and
  `actualSeat()` (the inverse) — the anchor arrays, toss-origin arrays and
  `#call`/`#say` `.s0`-`.s3` classes all key off `rel()`, while
  `snap.seats[...]`/`directory[...]` lookups always use the real seat.
- **`TABLES`/`BOT_NAMES`.** Bot names and which seats are bots now come from
  the server's `directory`. The frozen four-table picker is gone; a "New
  table" screen instead lets the creator pick a ruleset and how many bot
  seats (0-3) to fill.
- **The local IndexedDB recorder (`store.ts`, `sync.ts`).** Deleted outright
  — the server is the record now (`GET /api/matches`), and there is nothing
  left in this directory that imports them. "Your games" reads that endpoint
  directly instead of a local match log; there is no local leaderboard
  (Solo's was explicitly "what this device has played," which stops meaning
  anything once matches live on the server).
- **The "what the bots are thinking" dev panel** (`noteBotThinking`,
  `assessRoutes`-over-every-seat, `tableThreat`). **Dropped, not ported** —
  it read every other seat's concealed hand from the local `MatchState`,
  which a seat socket is never given (`protocol/src/events.ts`: a redacted
  snapshot carries `handCount`, never another seat's tiles). There is no
  substitute; the discard/claim helper (`rankDiscards`, `claimDecision`,
  `assessClaim`, `shouldKong` — all analysis on the player's own
  `SeatView`) is unaffected and still runs, off `seatViewOf(snap)`.
- **The 30-second local turn clock.** Replaced by the server's
  `deadlineTs`; see point 6 above.
- **The local match-length/table picker (1-4 wind rounds, four fixed
  tables).** Replaced by `matchFormat: "east" | "full"` and a bot-seat count,
  matching what `POST /api/tables` actually accepts.
- **The feedback screen's POST.** There is no feedback endpoint in this
  service. The button now copies a small diagnostic JSON blob (match id,
  seat, last folded `seq`, last 8 feed lines, user agent) to the clipboard
  instead, with a toast telling the tester to paste it into wherever they
  are actually filing the report.
- **Settings: bot pace and the in-settings ruleset picker.** Bot pacing is
  server-side now (`DEFAULT_TABLE_CONFIG.botMinPaceMs`/`botMaxPaceMs`,
  `worker/src/table.ts`) and ruleset is a property of the table, chosen at
  creation, not a display setting. Tile size, dev mode and the three
  handicaps (count tiles / calling read / what-if) are unchanged.

## What still works

Every coach feature that only ever needed the player's own hand: the
calling-read bar, the what-if hover/long-press, the graded discard helper,
and live claim advice (TAKE/SKIP with the champion's reasoning), all reading
`seatViewOf(snap)`. The wall build, the discard-pile organic-heap packer, the
toss/draw/grab animations, the canned calls (碰/上/槓/食糊/自摸/搶槓/花),
the turn nameplates, flowers, melds, and the whole overlay/scoreboard
language are the same code paths as Solo, now animating off server events
instead of a local reducer.

Touch: the hover-only coach interactions (count-tiles glow, what-if) now also
fire on a ~260 ms long-press, per the "touch first" client rule
(PVP-MULTIPLAYER-PLAN §2.2) — Solo's version was mouse-only.

## Known gaps / protocol assumptions made beyond the brief

- **`events`/`restore` snapshot field.** The task brief said the server's
  `snapshot` field on `events`/`restore` payloads was landing at the same
  time as this client and to "code to it as always present." As of this
  write, `protocol/src/messages.ts`'s `EventsPayload` type does not carry it
  yet (only `worker/src/table.ts`'s *call site* does,
  `eventsMessage(redacted, this.viewFor(att.seat))` — two arguments against a
  one-argument constructor). `net.ts` reads the wire JSON through a local
  `EventsPayloadWire` interface rather than the (temporarily stale) type
  import, and treats a missing `snapshot` as "animate only, don't move
  `snap`" — never a thrown error — so it degrades rather than breaks if the
  server-side change lands with a different shape than expected. Once
  `messages.ts` is updated, `EventsPayloadWire` can be deleted in favour of
  the real type.
- **Reconnect after a discard-pile gap.** A cold `welcome`/`restore` gives
  per-seat discard *lists*, not their true cross-seat chronological
  interleave (that ordering never reaches a seat socket).
  `seedPileFromSnapshot()` groups by seat rather than reconstructing turn
  order — visually fine for the packer (it still produces a
  non-overlapping heap), but a reload mid-hand will show a brief burst of
  toss animations replaying for tiles that were already on the table,
  since the DOM nodes are new even though the discards are not. Cosmetic
  only.
- **No explicit "leave"/forfeit request.** `ClientRequest` has no leave/quit
  message type, so the "quit" button and "leave" from the waiting room just
  close the socket; the server's existing disconnect-grace + bot-takeover
  path is what actually removes the player from the seat's critical path.
  There is no way for the client to mark its own departure as a forfeit
  the way Solo's local recorder did.
- **Waiting-room "all connected" detection** is inferred client-side from
  `directory` + `presence` (every non-bot seat connected) rather than a
  dedicated server signal — the protocol has no explicit "match started"
  message, so this is the closest available proxy. It is also cleared the
  moment any `prompt` arrives, which is authoritative.
- **Match-detail drill-down.** `net.ts` exports `matchDetail()` (wraps
  `GET /api/matches/:id`) but the "Your games" screen only lists the summary
  row from `GET /api/matches`; a per-match hand-by-hand view from the server
  record was judged out of scope for this pass and was not wired into a
  screen.
- **`champProfile()`** merges `DEFAULT_PROFILE` with `window.BOTS["v4"]`
  exactly as Solo's `profileOf()` did — the coach always grades against the
  frozen champion bot, regardless of which ruleset or bot-seat count the
  actual table uses.

## Build

```
./gamepvp/build.sh
npx tsc --noEmit -p client/gamepvp
```

Both must pass clean. Bundle is ~136 KB (esbuild, bundled+iife), down from
Solo's ~189 KB — the local reducer, bot decision code and the `tools/sim`
view adapter are no longer part of the client.

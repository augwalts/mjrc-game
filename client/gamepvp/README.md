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
  `createTable`, `joinTable`, `listMatches`, `matchDetail`, `getLobby`,
  `postPresence`, `startTable`, `leaveTable`), and `TableSocket`: connect,
  `join`, reconnect with backoff, `resync`, heartbeat echo, and a typed
  callback per server message. Holds no game state.
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
   `identify()` to confirm/refresh; else show the name screen. Opening the
   app at `/j/<code>` (an invite link — see "Waiting room" below) is read
   once here, before anything else, and the URL is immediately rewritten to
   `/` with `history.replaceState`; after identity resolves this sends the
   player straight to `joinScreen(code)` (code pre-filled, not auto-submitted)
   instead of the lobby or a resumed session — a deep link is a deliberate
   act and wins over both.
2. **Lobby** (`lobbyScreen()`/`renderLobby()`) — three panels, stacked on a
   phone and side by side ≥900px (`.lobby3`/`.lobbygrid` in `index.html`):
   **Here now** (everyone seen in the last 90s, from `GET /api/lobby`'s
   `here[]`; tapping a name waiting at an *open* table sits down at it),
   **Open tables** (`tables[]`; a lock icon for private tables, a **Sit
   down** button only when open and waiting, seats as four small tiles),
   then **New table** / **Join by code** / **Your games**, and a **Recent
   results** strip (`recent[]`, last 5). Polled every 5s
   (`refreshLobby`/`lobbyPollTimer`) while this screen is up; every other
   screen function starts with `beforeScreen()`, which is what stops the
   poll — there is no separate "left the lobby" event. A failed poll (the
   backend not there yet, a network blip) is swallowed and the panels keep
   showing whatever they last had, never a fabricated row.
3. **New table** (`newTableScreen()`) — length, ruleset, **mode**
   (casual/ranked — ranked forces every seat human and greys the bot
   picker), **access** (open/private, with a one-line explanation),
   **randomize seats at start**, and a 2×2 seat grid in seat order 東南西北.
   Each seat is a card that cycles human↔bot; a bot seat shows the
   catalogue's chips inline underneath for picking which one. The creator's
   own seat is always the first human seat in the array and is labelled
   "you" — toggling the last remaining human seat to bot is a no-op (the
   creator needs a seat). `POST /api/tables` takes the new
   `{ rulesetId, matchFormat, mode, access, randomizeSeats, seats }` shape;
   `net.ts`'s `createTable()` no longer accepts the old `botSeats`/`bots`
   fields (the server still does, converted, for anything else that calls
   it).
4. **Join by code** (`joinScreen(prefill?)`) or **Sit down**/tapping a
   waiting entry in the lobby (`sitDownByCode()`, same
   `POST /api/tables/:code/join` under the hood). Either way you get
   `{ matchUuid, joinCode, seat, seatToken }`, persisted to `sessionStorage`
   under `mjrc.gamepvp.activeMatch` (now also carrying `creator: boolean`)
   so a reload re-joins the same match through the join-by-code endpoint
   (`resumeOrLobby()`) and a page reload of the creator's own tab still
   shows the waiting room's "Start now" button.
5. `TableSocket.connect()` opens `wss://…/table/<matchUuid>`, sends `join`.
   `welcome` carries the seat, the directory and a full `SeatSnapshot` — the
   table renders immediately even before every human has connected (the
   server deals hand 0 at table-open time, `worker/src/table.ts`
   `handleInit`). A waiting-room veil sits over the table until every human
   seat in `directory` shows connected, or the first `prompt` arrives
   (whichever is proof the clocks started).
6. **Waiting room** (`waitingRoomScreen()`) — the join code, a **Copy invite
   link** button (`${origin}/j/${code}`, `navigator.clipboard` with a
   select-and-`execCommand("copy")` fallback for browsers without it), seat
   cards live from `directory` + `presence`, and for the creator only
   (`isCreatorOfCurrentTable`) a **Start now — fill empty seats with bots**
   button (`POST /api/tables/:matchId/start`) — no local transition on
   success, the server's own `prompt`/`events` clear the veil once the
   clocks start. **Leave** calls `POST /api/tables/:matchId/leave`
   best-effort (`leaveTableAndReturn()`) and always returns to the lobby
   even if that call fails.
7. `events`/`restore` messages carry a batch of `RedactedGameEvent`s **and**
   the snapshot from after they landed. `applyBatch()` enforces the
   contract literally: `consume(events)` animates against the *old* `snap`
   (still in scope), then `snap` is replaced. This ordering matters for one
   thing specifically — a `claimed` event's landing-meld index has to be
   computed from the pre-claim meld count, not the post-claim one, since
   Solo's synchronous reducer loop used to update `state` before consuming
   events and this client deliberately does the opposite.
8. `prompt` is the only source of legality. `actionsOf(mySeat, legal)`
   (`protocol/src/seatview.ts`) turns it into the same `Action[]` shape the
   old `legalActions()` produced, so the render/click code barely changed.
   Clicking sends a `request*` with a fresh `requestId` and disables the
   button (`pending = null`) until `accepted` or `rejected` comes back; a
   rejection re-enables the prompt and shows a short note.
9. The turn/claim clock reads `prompt.deadlineTs` (Unix ms) and runs
   `requestAnimationFrame` **only** while a deadline is armed — cancelled the
   instant it passes or a new prompt/no-prompt state arrives. Solo's clock
   ran continuously from boot; this was the one item on the client
   performance budget called out by name (PVP-MULTIPLAYER-PLAN §2.2).
10. **In-game "Leave table"** — the quit-menu button (`#btnQuit`), while a
    match is live, asks to confirm ("a bot plays your seat for the rest of
    the match; you can come back") before calling the same
    `leaveTableAndReturn()` as the waiting room: `/leave`, then close the
    socket and go to the lobby. Outside a live match the same button is
    just "go to the lobby" (`leaveTable()`, no confirm, no server call).
11. `matchEnd` shows a scoreboard from the event's own `standings`/
    `placements`, built up live from `sessionHands` (accumulated during play,
    not fetched back from the server) plus a local `coachTally` for "engine
    agreement". "Back to lobby" closes the socket and clears the session key.
12. Reconnect: on an unexpected socket close, `TableSocket` retries with
    capped exponential backoff and re-sends `join` with the same seat token
    (the server does not invalidate it on disconnect — the token *is* the
    reclaim credential, `table.ts` comment on `handleJoin`). If `join` itself
    is rejected `unauthenticated` (an expired/consumed token), the callback
    re-fetches one via `joinTable()` and retries over the same socket
    (`TableSocket.rejoin()`). After every successful `welcome`, and on
    `visibilitychange` back to `visible` (iOS suspends the socket in the
    background), the client also sends an explicit `resync(lastSeq)` as a
    race hedge — cheap since it is almost always an empty answer.
13. **Presence heartbeat**, decoupled from any one screen
    (`ensurePresenceHeartbeat()`, started once identity exists): every 30s,
    and once more on `visibilitychange` back to `visible`, while
    `document.visibilityState === "visible"`, `POST /api/presence
    { state: "lobby" }`. That literal `"lobby"` means "this device is open",
    not "the lobby screen is showing" — `GET /api/lobby` derives the richer
    waiting/playing state server-side from match participation, which is
    why this keeps sending during a live match too.

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
  the server's `directory`. The frozen four-table picker is gone; "New
  table" is a 2×2 seat grid (東南西北) where each seat is independently
  human or a specific bot from the catalogue, plus mode (casual/ranked),
  access (open/private) and a randomize-seats-at-start toggle.
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
- **"Leave" is an HTTP call, not a socket request.** `ClientRequest` still has
  no leave/quit message type — §7.2's `/leave` is a plain
  `POST /api/tables/:matchId/leave`, called from the client before the socket
  is closed (`leaveTableAndReturn()`), not a `request*` the table object
  answers with `accepted`/`rejected`. If that POST fails (offline, the route
  not deployed yet), the client still closes the socket and returns to the
  lobby — the server's disconnect-grace + bot-takeover path is the fallback
  either way, so a failed leave call degrades to what this file used to do
  unconditionally, not to a stuck screen.
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

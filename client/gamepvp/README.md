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
  `postPresence`, `startTable`, `leaveTable`, `postLobbyChat`), and
  `TableSocket`: connect, `join`, reconnect with backoff, `resync`, heartbeat
  echo, `sendChat`, and a typed callback per server message (`onChat`/
  `onChatHistory` included). Holds no game state.
- `game.ts` — the client: DOM rendering, tile art, animations, screens, and
  the coach. Everything it knows about the match comes from `net.ts`'s
  callbacks.
- `index.html`, `tile-engine.js`, `bots.js` — unchanged from Solo except the
  `<title>` and two small HUD spans (`#netStatus`, `#hudNote`) for connection
  state and transient notes.
- `SPEC.md` — Solo's spec of record; still the authority on the animation
  system, layout conventions and known gaps that this retrofit inherited
  unchanged (the pile-packing algorithm, the wall's decorative erosion,
  portrait-vs-landscape). **Exception, 2026-09-02 (task brief item 4):** the
  discard toss and its motion-queue rule diverge from SPEC.md now — see
  message-flow item 19 below for the reworked keyframe/easing and the
  `queueBehindToss()` mechanism, which this client never actually had until
  this pass despite the CSS custom properties for it existing already.
- `discard-lab.html` — a standalone reference tool (not part of the build,
  not linked from `index.html`) the owner used to settle the toss's exact
  easing/duration live; kept here as the record of that decision, not to be
  modified as part of ordinary client work.

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
2. **Lobby** (`lobbyScreen()`/`renderLobby()`) — reworked 2026-09-02 (task
   brief item 3) into five tabs across the top, a horizontally scrollable
   row of pills on a phone (`.tabbar`/`.tabpill`, `#panel .tabpill` paired
   with the ID — see the CSS comment on that rule for why: the bare class
   used to lose to `.panel button`'s own background and every INACTIVE pill
   rendered as a bold gold button, caught live-testing this rework), a plain
   row ≥900px: **Play** (**Here now** — everyone seen in the last 90s, from
   `GET /api/lobby`'s `here[]`, tapping a name waiting at an *open* table
   sits down at it; **Open tables** — `tables[]`, a lock icon for private
   tables, a **Sit down** button only when open and waiting, seats as four
   small tiles; **New table** / **Join by code**), **Chat** (the lobby
   chat, unchanged — see item 14 for what "chat" means on the table itself),
   **Stats** (**Your stats** / **Leaderboard**, both still their own full
   screens — `yourStatsScreen()`/`leaderboardScreen()` — reached from a card
   here), **Games** (**Your games**, likewise its own screen —
   `statsScreen()` — plus the **Recent results** strip, `recent[]`, last 5,
   inline in this tab), **Rooms** (a placeholder — see below). The active
   tab is remembered in `sessionStorage` (`setLobbyTab`/`loadLobbyTab`,
   `mjrc.gamepvp.lobbyTab`) so a reload, or "back to lobby" from anywhere,
   returns to the same one. Each pane is built once with the rest of the
   shell and only ever hidden/shown (`.tabpane`/`.tabpane.on`) — a switch
   never rebuilds `#lobbyHere`/`#lobbyTables`/`#lobbyChat`/`#lobbyRecent`,
   so their own signature-diffed repaint discipline and pointer-hold guard
   (`LOBBY_PANELS`/`paintLobbyPanel`/`lobbyPanelState`) are untouched by
   tab-switching. Polled every 5s (`refreshLobby`/`lobbyPollTimer`) while
   this screen is up, but the poll now only *repaints* whichever panel(s)
   belong to the *visible* tab (`PANEL_TAB`) — the underlying `GET
   /api/lobby` fetch still runs every tick regardless (one call behind all
   four panels), so switching tabs always shows data at most 5s old via a
   forced catch-up repaint (`setLobbyTab`), never a stale one. Every other
   screen function starts with `beforeScreen()`, which is what stops the
   poll — there is no separate "left the lobby" event. A failed poll (the
   backend not there yet, a network blip) is swallowed and the panels keep
   showing whatever they last had, never a fabricated row.
   **Rooms** (task item 3; PVP-LOBBY-PROPOSAL-2026-09-02.md §8b) reads `GET
   /api/rooms/mine` — built by another agent in parallel, so a 404 there
   reads as "rooms are coming — not live on this server yet" rather than a
   real error (`refreshLobbyRooms`/`net.ts`'s `getMyRooms`), same framing an
   empty room list gets. Below that, always: a **join a room by code**
   input (`POST /api/rooms/:code/join`) and a **create a room** form
   (`POST /api/rooms { name, rulesetId, matchFormat, adminCode }` →
   `{ code }`, ruleset/format defaulted from `newTableDraft` rather than
   their own picker — a fuller form is follow-up work once rooms are
   actually live). Not part of the 5s lobby poll; fetched once each time the
   tab is opened.
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
    The scoreboard never jumps the line ahead of the last hand's own reveal
    (item 15) — `syncVeil()` checks `overlay` before `matchEndInfo`, so the
    reveal shows first and the scoreboard follows once it closes.
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
14. **Chat** (PVP-LOBBY-PROPOSAL §8) — two independent chats, one client-side
    mute list. *Table chat* rides `TableSocket.sendChat({text} | {phrase})`
    over the seat socket; `welcome`/`restore` hand their last-50 ring to
    `onChatHistory`, a live message arrives via `onChat`. **Reworked
    2026-09-02 (task brief item 1): "chat must not be a window."** The old
    phone bottom-sheet / desktop pinned-sidebar drawer is gone. One round
    button (`#chatBtn`, bottom-right of the felt, unread badge — unchanged,
    now shown on every breakpoint) toggles a fully TRANSPARENT overlay
    directly on the felt (`#chatOverlay`, a `position:absolute` child of
    `#felt` exactly like `#state`/`#say`/`#call` — never a panel background,
    never pushes `#mine`/`#table` around): the last ~6 messages as bare
    text-shadowed lines, the five quick-phrase buttons in one row (their
    English sub-label becomes a `title` tooltip inside the overlay
    specifically — `#chatOverlay .phrasebtn`, index.html — five two-line
    chips do not fit ~230px without wrapping), and a single-line input +
    send. Bottom-right above the button on a phone, top-left below `#state`
    on desktop (the same media query, but the button itself never moves).
    Tapping the button again, or the felt itself, closes it
    (`wireChatDrawer()`, `stopPropagation()` on the button/overlay is what
    stops that same click from also reaching the felt's own close handler).
    While closed, an incoming message — phrase or free text — fades in for
    4s near the button (`#chatPreview`/`showChatPreviewLine()`, no panel,
    same timed-class-swap technique as `sayDiscard`/`announce`) and bumps
    the badge; this is separate from the per-seat phrase bubble
    (`#chatbubble`, unchanged) below. Messages default to "this hand"
    (`handStartTs`, set from the last `deal` event's `ts`) with a "show all"
    toggle. *Lobby chat* is unchanged in behaviour, now living in the lobby's
    own **Chat** tab (see item 2/`lobbyScreen()`) rather than a fourth
    always-visible panel; still painted by the same signature-diffed
    `LOBBY_PANELS` rule as **Here now**/**Open tables**/**Recent results**;
    its send button disables for 2s after a send, and a 429 reads as "slow
    down". *Mute* (`mutedSet()`/`setMuted()`, `localStorage`, task item 4) is
    local-only and keys on `playerId` — table chat resolves one from
    `directory` at the moment a message arrives (the wire payload only
    carries a seat), lobby chat's rows already have one. Bots never chat
    (server-enforced), so there is no bot-chat affordance to build.
15. **Hand-end reveal.** A win/exhaustive-draw no longer snaps straight into
    the next deal. `handEnd`'s own case in `consume()` builds one overlay:
    the winner's hand face up (concealed tiles + melds, the winning tile
    ringed gold via `.win-tile`, captured off the preceding `winOnDiscard`/
    `selfDraw` event into `pendingWinDetail`), the faan awards by name
    (`AWARDS`), whether the total was capped, the chip deltas and standings
    per seat; on 流局 each seat's tile count, plus this seat's own ready
    state if the redacted `exhaustiveDraw` payload carried a distance (only
    ever your own — §5.3). A **next hand** button sends `requestNextHand`
    and then reads "waiting for others…"; when `handEnd.nextHandTs` is
    present a live countdown (a bounded 1Hz `setInterval`, not a rAF loop)
    closes the reveal at that deadline, otherwise a fixed 6s hold does the
    same, with a plain **continue** tap alongside it. Either way,
    `applyBatch()` refuses to animate or snap to a batch that opens a new
    hand (`fresh[0].type === "deal"`) while the reveal is still up — it
    closes the reveal first (the deal's arrival is itself proof the
    intermission is over) and only then applies the batch, so the table
    never shows next-hand tiles behind an open reveal.
16. **Pause/resume.** `requestPause`/`requestResume` (a Pause/Resume button
    in the HUD, toggling on `paused`); the server's `paused` broadcast (and
    the same field seeded on `welcome`/`restore`) drives a full-table veil —
    "Paused by NAME · tap Resume" — that `syncVeil()` checks before
    everything else, including the hand-end reveal. The veil itself blocks
    all pointer events to the table underneath, which is what "every game
    control is disabled" comes from; `act()` also short-circuits as a second
    line of defence. The turn clock freezes rather than resetting
    (`freezeClock()`/`thawClock()`, `clockTick()` pulled out of `startClock()`
    so both can drive it) — on resume it shifts `clockDeadline` forward by
    however long the freeze lasted, a best-effort guess that a fresh
    `prompt` (the more likely server behaviour) simply overwrites. A
    `rejected` with code `paused` reads as "the table is paused"
    (`REJECT_NOTES`).
17. **Auto-play.** `requestAuto({ on })` (an Auto toggle in the HUD); `myAuto`
    is authoritative from this seat's own `presence` row, but also flips off
    the instant `act()` sends any request of its own — a deliberate,
    UI-only exception to the no-optimism doctrine, mirroring what the server
    does anyway. While on, the hand and action bar go inert (`canDiscard`
    folds in `!myAuto`, the actions bar shows "auto is playing for you"
    instead of buttons) and this seat's own nameplate reads "· auto"; every
    other seat's nameplate reads the same off `directory[seat].auto`, kept
    current by `presence` the same way `bot`/`connected`/`displayName`
    already were.
18. **Claim bar, ported from the demo** (`mjrc-game/client/game`): the bar
    moved above the hand (table → buttons → tiles is the read order), each
    button tinted by its call (chow orange, pung blue, kong violet, win gold
    with a pulse and rays) and drawing the meld it would build —
    `claimStrip()` renders the tiles with the one in play (`snap.lastDiscard`)
    ringed gold, at 10px padding so four fit on one row at 375px. The WIN
    button carries no faan preview (the demo's `previewWin` has no
    server-authoritative equivalent here) — it is offered exactly when
    `pending` carries it, which was already the rule. Also ported: the
    flower index's `fidx` CSS hook and larger halo'd numeral
    (`tile-engine.js` `fIndexNum`) with the per-surface size fix that follows
    from it (a flower is sized like the tile beside it, `sm` in a `.meldrow`,
    unscaled in `#mymelds` — no more `.tile.fl` override); the mobile pile/
    hand sizing fix (`--th`, not hard-coded `width`/`height`, so `#pile`'s own
    scaling rule is not overridden and a 流局 hand's ~84 discards still fit);
    and opponents' melds turned to face their own seat on a phone (east/west
    columns, rotated tile faces) so the discard heap no longer buries them.
    Count-tiles is on by default now, with a one-time
    `mjrc.gamepvp.hcCountDefaulted` migration so an existing device's saved
    settings still get it once. Not ported: the demo's local
    leaderboard/stats board, the bot-thinking panel, and anything reading
    omniscient state — none of it has an equivalent over a redacted seat
    socket (see "What was removed from Solo, and why" below).
19. **The discard toss, reworked 2026-09-02 (task item 4)** — two live-demo
    bugs, fixed together: no motion queue at all (a discard's toss and the
    very next seat's draw could land in the same `events` batch and both
    animate from frame 0 together, competing for one pair of eyes) and a
    toss that visibly relocated a second time (the old `toss` keyframe was
    three phases — FLIGHT to an approximate spot, a CONTACT pause, then a
    SKID to the real slot — so a discard looked like it accelerated in,
    stopped short, then slid again). Both are gone: `lastTossAt`/
    `queueBehindToss()` (game.ts) delay a draw — this seat's own drawn tile
    and an opponent's backrow `.wtnew` indicator alike — behind the most
    recent toss's full duration; and `#pile .tile.fresh`'s `toss` keyframe
    (index.html) is now ONE motion from the discarder's edge straight to the
    tile's already-fixed slot (`d.pos`, decided once in the pile-placement
    loop and never recomputed — nodes are keyed to the discard's own id and
    a node is created exactly once). The curve itself —
    `cubic-bezier(.15,0,.85,.85)` over 380ms, "a short push off the finger,
    then constant speed, then a dead stop on the slot" — is the owner's own
    call after trying it live in a standalone tool, `discard-lab.html`
    (kept in this directory as a reference, not part of the build). Also
    fixed: the local player's own toss used to start from a hardcoded `[0,
    190]` origin tuned before the claim bar (`#actions`) moved between the
    table and the hand (task item 4a) — it now accounts for that bar's own
    always-present ~60px (`min-height:54px` + `margin-top:6px`, index.html),
    a deliberate constant rather than a measured one: `#surface`'s 3D tilt
    (`perspective(1500px) rotateX(17deg)`) means a plain viewport rect from
    outside that transformed subtree would not convert linearly into the
    untransformed local pixels the toss's own placement math uses.
20. **`deadlineTs === 0` reads as "no clock"** (task item 4's last bullet) —
    a prompt can carry this sentinel instead of a real Unix-ms deadline;
    `startClock()` now hides `#clockbar` outright for it instead of
    briefly showing an unfilled, `.low`-tinted track for a "deadline" that
    was actually already in the past.
21. **A resize or orientation change never clears the veil** (task item 2,
    2026-09-02 live demo: "win → resize → popup vanishes, player stuck").
    Audited every place `#veil`/`#panel`/`overlay`/`matchEndInfo`/`paused`
    is touched — `render()` never reads or writes any of them, and every
    screen/`syncVeil()` path already only closes one on an explicit action
    (a button's own `onclick`, never a passive listener). What was actually
    missing was the listener itself: `window.addEventListener("resize"/
    "orientationchange", …)` did not exist at all, so a phone rotation never
    re-ran `render()` to pick up new width-dependent layout (the pile's
    `--pileth`, from `pileEl.clientWidth`). It now does, debounced 120ms
    (iOS fires a burst of `resize` as the address bar hides/shows), mirroring
    the DESKTOP breakpoint listener's already-correct pattern: re-render the
    table under whatever is showing, THEN `syncVeil()` — never the reverse,
    and never a bare "hide the veil".
22. **Speed picker** (PVP-LOBBY-PROPOSAL-2026-09-02.md §8a-2, added
    2026-09-02) — New table gets a fifth section, five pills
    (`TABLE_SPEEDS`/`SPEED_INFO`, game.ts), one line of turn/claim seconds
    each from the proposal's own table. `newTableDraft.speed` follows
    `defaultSpeedFor(humanSeatCount())` (untimed for one human, normal for
    two or more — matches `worker/src/index.ts`'s now-landed
    `resolveSpeed` server default, verified live) on every re-render of the
    screen, which already fires on every seat toggle, until the creator
    taps a pill (`speedManual`), same "live default, sticky override" shape
    nothing else on this screen needed before. `POST /api/tables` always
    carries `speed` now; the fields it already sent are unaffected. The
    badge (`.badge.speed`) shows on lobby table rows (`tableRowHtml`, off
    `LobbyTable.speed`) and in the waiting room (off `currentSpeed`, seeded
    from the create/join request or the lobby's cached row for the table
    being joined, overwritten by the start card's own `settings.speed` the
    moment it arrives — same "seed then authoritative" shape `seatPlan`
    already used). A room's fixed speed (§8b, "show it as fixed") has no
    client surface yet — no room-scoped New table flow exists in this
    client at all (the Rooms tab is membership only, see item 2 above), so
    there is nowhere in the UI for "fixed" to apply until that lands.
23. **The start card** (§8a-2, added 2026-09-02) — a `starting {
    startsAt, settings }` push (live, `TableSocket.onStarting`) or an
    already-holding `welcome.starting`/`restore.starting` (both non-null)
    opens a veil state above the waiting room (`syncVeil()`,
    `showStartCard()`, game.ts): the ruleset label and its key numbers,
    length, the speed in words, all four seats from `settings.seats`, a
    live countdown to `startsAt`, and a ready button that sends
    `requestNextHand` — literally the same message the hand-end
    intermission's own "next hand" button sends, reused verbatim per the
    contract ("the hold ends early the same way"). Closes the instant a
    real `deal` (consume()'s own case) or `prompt` (`onPrompt`) arrives —
    either one is only ever sent once the server's hold is genuinely over,
    the same "arrival is proof" reasoning `applyBatch()` already uses to
    close the hand-end reveal — with a `setTimeout` at `startsAt`
    (+250ms slack) as the fallback in case neither ever does. `net.ts`
    declares `Speed`/`StartingPayload`/`StartingSettings` itself rather
    than importing them from `protocol/src/messages.ts`, even though that
    file has since landed the identical shape (`Speed`, `MatchStartSettings`,
    `StartingPayload`, verified field-for-field against the live
    worker/protocol code) — kept independent on purpose, per the task
    brief's "degrade gracefully where the server is not there yet":
    `TableSocket.handleMessage` reads `starting` off the raw parsed JSON
    before narrowing to the typed `ServerToSeat` union, so this client
    never hard-depends on a concurrently-changing file it was told not to
    edit.
24. **Optimistic discard** (§8a-2, added 2026-09-02) — the ONE place
    this client predicts anything, and even here only the ANIMATION runs
    ahead, never game state (§ top of this file's doctrine is otherwise
    untouched). Tapping a legal tile pushes a `pileTiles` entry for it
    immediately (`mySeat`, a fresh `pileSeq` id) and sets
    `pendingOptimisticDiscard` before calling `act()` — `act()`'s own
    synchronous `render()` right after is what actually runs the toss,
    through the EXACT SAME pile-placement loop every other discard's
    `.pos` is assigned by (the loop only ever assigns `.pos` once per
    entry, never recomputes it), so the slot chosen on tap is never moved
    once the real event lands. The tile is pulled out of the rendered hand
    the same render pass (`render()` checks `pendingOptimisticDiscard`
    against both `me.hand` and `me.drawn` — 摸切 discards the drawn
    tile, a different slot in the markup). When the server's own `discard`
    event for this seat and tile arrives (consume()'s "discard" case), it
    reconciles instead of pushing a second `pileTiles` entry — pushing a
    second one is what would make the pile loop's own "is this id already
    a DOM node" check treat it as new and re-toss it, exactly the bug this
    exists to avoid. A `rejected` (or a request timeout, or the socket
    closing mid-flight — `act()`'s catch already runs for all three)
    drops the pile entry and clears the flag, which is enough on its own:
    the pile loop's stale-node cleanup removes the DOM node and the hand
    filter stops excluding the tile, both on the very next `render()` the
    catch already calls. Guarded to one pending discard at a time
    (`pendingOptimisticDiscard` gates the tile `onclick`), though `act()`
    clearing `pending` synchronously already makes a second tap have no
    legal action to find regardless.
25. **The clock bar's empty states** (§8a-2, added 2026-09-02) —
    `#clockNote` sits where `#clockbar`'s own 3px track would be, for the
    two states with nothing running there. "no clock" (`noClock`, set
    purely by `startClock(0)`'s own sentinel — see item 20 — so this
    needs no separate knowledge of the table's `speed` and is correct even
    on a server that never sends one) is the plain case. When this seat's
    own `presence.auto` flips on WITHOUT this client having just asked for
    it (`myAutoRequestedOn`, set the instant the HUD's Auto button sends
    `requestAuto(true)` and cleared the moment `presence` confirms any auto
    state) it reads as the untimed idle timeout instead (`myAutoIdle`) —
    the wire has no separate "why" for the transition, so this is
    inferred, not authoritative, and documented as such in `myAutoIdle`'s
    own comment. The idle banner ("tap any tile to take back") is also the
    one case a `.locked` hand still answers a tap: it sends
    `requestAuto(false)` rather than a discard, handing the seat back
    without acting on whatever tile happened to be under the finger.

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

- **`events`/`restore` snapshot field — resolved.** This used to be a local
  `EventsPayloadWire` shim (`net.ts`) coded ahead of `protocol/src/
  messages.ts`'s `EventsPayload` carrying `snapshot`. The real type has since
  landed with the field, so the shim is gone — `net.ts` reads
  `EventsPayload`/`WelcomePayload`/`RestorePayload`/`PresencePayload` directly
  now. Left here as a note in case a future pass needs the same "code to the
  documented wire shape, degrade if it's missing" posture for something else
  still landing.
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

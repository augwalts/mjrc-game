# What happens on the back end — and where WebSockets fit

Short answer: **yes, WebSockets — but only for the match, never for the rest of the app.**
Most of `DESIGN.md` §5 already specifies this; this is the plain-language version.

---

## 1. The hard rule: two planes, two channels

§2 states it as a day-one rule: the lobby shell and the match scene **never share a channel**.

| Plane | Transport | Talks to |
|---|---|---|
| Lobby shell — play, profile, replays, review, stats, settings | **HTTP** | stateless Workers |
| Match scene — one live table | **WebSocket** | one Durable Object |

This is what Mahjong Soul does (a `Lobby` service with ~200 RPCs, separate from `FastTest`
for in-match traffic) and what the League client does (REST + a push socket). `mj-queue`
tunnels everything through one socket — **do not inherit that**; it is the pattern the split
exists to kill.

Practical consequence: the replay viewer, match history, stats and leaderboard are all plain
`GET`s. No socket anywhere near them.

## 2. The pieces

| Piece | What it is | Holds |
|---|---|---|
| **Worker (HTTP)** | Stateless request handling | nothing |
| **Table Durable Object** | One per live match — the coordination atom | authoritative game state |
| **Lobby Durable Object** | Hands out join codes at P0 | table registry |
| **D1** | Relational | `players`, `matches`, `match_players`, `rating_history` |
| **R2** | Blob storage | the append-only event log — the research corpus |

## 3. What actually happens on one turn

1. Client sends `{type:"discard", tile, seq}` over its socket. That is the *entire* client
   authority: a request, not a decision.
2. The DO calls the pure reducer — `applyAction(state, action) → {state', events[]}` — which
   decides legality. **The server never trusts the client** for legality or scoring.
3. The DO **persists the events to its own storage, then broadcasts.** Persist-then-broadcast,
   in that order, so a crash can never leave clients ahead of durable state.
4. Each seat receives a **redacted** view — `viewFor(seat)`: your hand, everyone's discards and
   melds, wall count, others' tile *counts*. The omniscient state never leaves the server.
5. The DO arms the claim-window deadline and waits.

## 4. Why a Durable Object rather than a normal game server

- **Single-threaded per object.** Four players acting at once cannot race; there is no locking
  to get wrong. For a game with simultaneous claim windows this is the whole ballgame.
- **Addressable by id.** The lobby issues `{table_id, seat_token, match_uuid}`; the client
  opens its own socket straight to that table. The lobby never proxies match traffic.
- **WebSocket hibernation.** Sockets survive while the object sleeps, so an idle table costs
  nothing — which matters a great deal for an invite-only alpha with thin traffic.
- It is **matchmaker → placement → ephemeral server → report → die**, the same shape as
  Agones or GameLift, with the fleet layer outsourced to Cloudflare.

## 5. The four things that are easy to get wrong

All flagged in §5.3, all worth repeating because each is a silent failure:

1. **A DO has exactly one alarm.** `setAlarm()` overwrites. A naive claim-window timer will
   clobber a disconnect-grace deadline and the table hangs forever. Keep a persisted map of
   named deadlines (`turnClock`, `claimWindow`, `disconnectGrace:seat`, `botPace`), always
   `setAlarm(min(...))`, dispatch everything due, re-arm. *The sketch's engine already models
   this — one timer, many named deadlines — because the shape matters more than the code.*
2. **Outbox, not fire-and-forget.** Hand events stay in DO storage until **both** the R2 blob
   write and the D1 row are confirmed. The DO is disposable at MATCH_END, not hand end. This
   is what makes gate 2's "100% of games reconstruct" achievable rather than aspirational.
3. **Per-seat redaction, or you have shipped a cheat.** Two serializers, never mixed:
   omniscient (R2, server-only) and redacted per-seat (live sockets).
4. **Reconnect is snapshot + actions-since**, not a replay from the top. Nearly free given
   event sourcing.

## 6. Bots are not a special case

A bot is a player whose input arrives from a function call instead of a socket. Same action
API, same legality checks, paced through a `botPace` deadline so it never answers instantly —
a synchronous bot reply leaks the fact that a claim was available. The sketch does this today.

## 7. The unifying point

**One event stream, three consumers.** The events the reducer emits are simultaneously:

- the messages broadcast over the socket,
- the animation queue that drives the match scene (`RENDERING.md` §4),
- and the append-only log that R2 stores, which the replay viewer and every analysis screen
  fold over (`ANALYSIS.md`).

That is why `engine_version` is pinned in the log header, and why the schema is versioned. Get
the event schema right and the transport, the animation system, the replay and the research
corpus all fall out of it. Get it wrong and you are rewriting four things.

## 8. Roughly what P0 needs

Nothing exotic. From §3's roll-up, the Table DO plus lobby DO plus D1/R2 platform work is
**1.5-2 FT weeks** — the smallest line item on the board. The engine (2-3 weeks) and the
client (3-4 weeks) are the real cost. The backend is the easy part; that is a consequence of
choosing an architecture whose hard problems are all in the reducer.

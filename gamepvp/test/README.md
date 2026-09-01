# smoke.mjs

Headless end-to-end smoke test for the mjrc-game Worker. It plays one full
match through the real HTTP + WebSocket API — no mocks, no test harness — and
exits 0 only if the match reaches `matchEnd` and the match detail can be read
back from D1 afterwards.

Plain Node (>=22), ESM, zero npm dependencies. Uses only `node:crypto` plus
the global `fetch` and `WebSocket`.

## Prerequisites

A local server must already be running that serves:

- the HTTP API from `worker/src/index.ts` (`/api/identity`, `/api/tables`,
  `/api/tables/:code/join`, `/api/matches/:id`), and
- the WebSocket upgrade for the Table Durable Object at `/table/:matchUuid`
  (`worker/src/table.ts`),

on the same origin, both gated by the `mjrc_gate` cookie (or, for the socket
upgrade, the equivalent `?gate=` query param) — see "The front-door gate"
below. How you start that server (`wrangler dev`, a local harness, etc.) is
outside this script's concern; point `MJRC_BASE` at wherever it's listening.

## Running it

```sh
node test/smoke.mjs
```

With everything at its default: one human seat (3 bots), an `east` format
match, the `mjrc-standard` ruleset, against `http://127.0.0.1:8787`, gated
with the password `dev`.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `MJRC_BASE` | `http://127.0.0.1:8787` | HTTP origin of the running server. The WebSocket origin is derived by swapping `http`→`ws` / `https`→`wss`. |
| `MJRC_GATE_PASSWORD` | `dev` | Front-door gate password. Hashed into the `mjrc_gate` cookie/query value — see below. |
| `MJRC_HUMANS` | `1` | How many human seats to create (1-4, clamped). The first creates the table with `botSeats = 4 - MJRC_HUMANS`; the rest join by code. Each human gets its own device token and its own socket, all running the same policy concurrently. |
| `MJRC_FORMAT` | `east` | `east` or `full` — passed as `matchFormat` on table creation. |
| `MJRC_RULESET` | `mjrc-standard` | `rulesetId` passed on table creation. |
| `MJRC_TIMEOUT_MS` | `180000` | Overall wall-clock budget from process start to `matchEnd`. The script exits 1 if this elapses first. |

Example — a 4-human match against a server on a different port:

```sh
MJRC_BASE=http://127.0.0.1:9000 MJRC_HUMANS=4 MJRC_FORMAT=full node test/smoke.mjs
```

## The front-door gate

Every HTTP request carries a cookie:

```
Cookie: mjrc_gate=<sha256("mjrc-gate:" + MJRC_GATE_PASSWORD) as lowercase hex>
```

Node's global `WebSocket` cannot set custom headers, so the socket carries the
same value as a query param instead:

```
ws://<host>/table/<matchUuid>?gate=<same hex>
```

If `MJRC_GATE_PASSWORD` doesn't match what the server expects, every request
will fail (typically as an early rejection or a refused upgrade) and the
script exits 1 well before any match traffic.

## What "playing" means

The script never tries to win optimally — it runs the simplest policy that
keeps a match moving, per seat, independently:

1. If a self-drawn win is legal, take it (`requestWinOnSelfDraw`).
2. Else if a claim window is open: take a win the instant one is offered
   (`requestWinOnDiscard`); otherwise pass (`requestPass`).
3. Else if a rob-kong window is open, take it (`requestRobKong`).
4. Else if it's this seat's turn to discard, discard the *last* tile in the
   server's `legal.discard` list.

It never declares a concealed or added kong, and never claims a chow/pung/kong
— those are skipped on purpose to keep the policy (and this script) small; the
match still runs to completion because bot seats and the server's own timeout
handling carry the rest.

Any bot seats (`botSeats = 4 - MJRC_HUMANS`) are played entirely server-side —
this script does nothing for them.

## Output

- One line per hand end (`outcome`, `winner`, `faan`, `standings`).
- One line when `matchEnd` arrives (`reason`, `handsPlayed`, `standings`,
  `placements`).
- A `rejected` from the server is logged as a warning and does not fail the
  run — a stale offer or a duplicate request is expected under concurrency.
- A final summary: hands played, an event-type tally (deduplicated by the
  event log's globally unique `seq`, so counts are correct even with multiple
  human sockets watching the same public events), elapsed time, and final
  standings.
- The `GET /api/matches/:matchUuid` response's `status` and `handCount` as a
  last sanity check that the match landed in D1.

## Exit codes

- `0` — a `matchEnd` event was observed and the match detail fetch afterwards
  succeeded.
- `1` — anything else: a bad HTTP response, a `protocolFault`, a socket that
  closed before `matchEnd`, or the `MJRC_TIMEOUT_MS` budget running out. The
  error is printed to stderr before exit.

#!/usr/bin/env node
/**
 * Headless end-to-end smoke test for the mjrc-game Worker.
 *
 * Flow:
 *   1. Mint one device token per human seat that will actually join (MJRC_SEATS'
 *      human count, minus one if MJRC_START=1) and POST /api/identity for each.
 *   2. The first human POSTs /api/tables — `seats` if MJRC_SEATS is set (§7.2),
 *      else the legacy `botSeats` (4 - MJRC_HUMANS) shape — the rest POST
 *      /api/tables/:joinCode/join; each gets back a seat + a one-time seatToken.
 *      If MJRC_START=1, the creator then POSTs /api/tables/:id/start, which
 *      bot-fills the human seat nobody joined as and starts the clocks.
 *   3. Each human opens its own WebSocket to /table/:matchUuid, sends `join`
 *      with its seatToken, sends one `chat` quick-phrase right after `welcome`
 *      (§8 — exercises chat end to end), and from then on reacts to whatever
 *      the server sends: it answers a `prompt` with the simplest legal move
 *      (see `respondToPrompt`), replies to a server `heartbeat`, tallies every
 *      `chat` it receives, and logs `rejected` without dying.
 *   4. Every seat-visible event that arrives (via `events` or `restore`) is
 *      deduped by its globally-unique `seq` and tallied by type. A `handEnd`
 *      prints one summary line; a `matchEnd` ends the wait.
 *   5. Once `matchEnd` is seen (or something goes wrong first), every socket
 *      is closed and GET /api/matches/:matchUuid is fetched as a final
 *      sanity check that the match landed in D1.
 *
 * Every HTTP call and the WebSocket upgrade carry the front-door gate cookie
 * `mjrc_gate=<sha256("mjrc-gate:" + MJRC_GATE_PASSWORD)>`. Node's global
 * WebSocket cannot set custom headers, so the gate is ALSO passed as a
 * `?gate=` query param on the socket URL — the server is expected to accept
 * either.
 *
 * Plain Node (>=22), ESM, zero npm dependencies — only node:crypto plus the
 * global `fetch` and `WebSocket`.
 *
 * Exit 0 only if a `matchEnd` event was observed AND the match detail fetch
 * succeeded afterwards. Exit 1 on anything else (config error, rejected
 * requests aside — those are non-fatal — socket faults, timeout).
 */

import { createHash, randomUUID } from "node:crypto";

/* ── config ────────────────────────────────────────────────────────────── */

const HTTP_BASE = (process.env.MJRC_BASE ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const WS_BASE = HTTP_BASE.replace(/^http/, "ws");
const GATE_PASSWORD = process.env.MJRC_GATE_PASSWORD ?? "dev";
const HUMANS = Math.min(4, Math.max(1, Number.parseInt(process.env.MJRC_HUMANS ?? "1", 10) || 1));
const MATCH_FORMAT = process.env.MJRC_FORMAT ?? "east";
const RULESET_ID = process.env.MJRC_RULESET ?? "mjrc-standard";
const TIMEOUT_MS = Number.parseInt(process.env.MJRC_TIMEOUT_MS ?? "180000", 10);
/** Comma-separated bot profile keys (gamepvp/src/bots.ts BOT_CATALOGUE), in
 *  seat order for the bot seats — exercises the LEGACY POST /api/tables
 *  `bots` pick path headless. Unset (the default) omits `bots` entirely and
 *  the server falls back to its own default lineup. Ignored when MJRC_SEATS
 *  is set — that path names bot keys inline instead (`bot:<key>`). */
const BOTS = (process.env.MJRC_BOTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");

/**
 * `POST /api/tables` `seats` (PVP-LOBBY-PROPOSAL-2026-09-02.md §7.2), as
 * "human,bot:v4,human,bot:v2" — exactly 4 comma-separated entries, each
 * "human", "bot" (the deployment's default lineup for that seat) or
 * "bot:<key>" (gamepvp/src/bots.ts BOT_CATALOGUE). Unset falls back to the
 * legacy `MJRC_HUMANS`/`MJRC_BOTS` shape (`botSeats` + `bots`, humans in the
 * low seats) so every existing invocation of this script keeps working.
 */
function parseSeatsEnv(raw) {
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 4) {
    throw new Error(`MJRC_SEATS must name exactly 4 seats, got ${parts.length}: "${raw}"`);
  }
  return parts.map((part) => {
    if (part === "human") return { kind: "human" };
    const m = /^bot(?::(.+))?$/.exec(part);
    if (!m) throw new Error(`MJRC_SEATS entry "${part}" is not "human", "bot" or "bot:<key>"`);
    return m[1] ? { kind: "bot", bot: m[1] } : { kind: "bot" };
  });
}
const SEATS = process.env.MJRC_SEATS ? parseSeatsEnv(process.env.MJRC_SEATS) : null;
/** casual (default) or ranked — POST /api/tables `mode`. */
const MODE = process.env.MJRC_MODE === "ranked" ? "ranked" : "casual";
/**
 * When set, the creator leaves the LAST human seat in `MJRC_SEATS` unfilled
 * (nobody identifies or joins as that seat) and calls `POST
 * /api/tables/:id/start` once everyone else is in — the §7.2 "start now, fill
 * the rest with bots" path. Needs at least 2 human seats in `MJRC_SEATS` (the
 * creator, plus the one left open) and is meaningless without it.
 */
const START = process.env.MJRC_START === "1";
/**
 * Pauses the table for 3s and resumes once, during hand 0 (right after every
 * socket has joined — hand 0 is dealt at table-creation time and the claim
 * window alone takes seconds on the fast local clocks, so there is no risk of
 * missing it). Exercises `requestPause`/`requestResume` end to end and checks
 * the match still completes afterwards.
 */
const PAUSE_TEST = process.env.MJRC_PAUSE === "1";
/**
 * §8a-2's clock speed — `untimed | very-slow | normal | faster | insane`.
 * Passed straight through as `POST /api/tables`' `speed`; unset (the
 * default) omits it entirely and lets the server's own default rule decide
 * (untimed for one human seat, normal otherwise) — same "absent means let
 * the server pick" doctrine `BOTS`/`MJRC_START` already follow.
 */
const SPEED = process.env.MJRC_SPEED || null;

const GATE_HEX = createHash("sha256").update(`mjrc-gate:${GATE_PASSWORD}`).digest("hex");
const GATE_COOKIE = `mjrc_gate=${GATE_HEX}`;

/* ── small helpers ─────────────────────────────────────────────────────── */

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function apiFetch(path, { method = "GET", token, body } = {}) {
  const headers = { Cookie: GATE_COOKIE };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${HTTP_BASE}${path}`, { method, headers, body: payload });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body / non-JSON body — data stays null */
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function mintDeviceToken(seat) {
  return `smoke-${randomUUID().replace(/-/g, "")}-seat${seat}`;
}

/* ── seat policy ───────────────────────────────────────────────────────── */

/** The simplest legal move for whatever the prompt offers. Never claims a
 *  chow/pung/kong, never declares a kong — only discard, pass, or take a win
 *  the instant one is on offer. That is enough to run a match start to end. */
function respondToPrompt(legal, send) {
  if (legal.winOnSelfDraw) return send("requestWinOnSelfDraw", {});
  if (legal.claims) {
    const winOption = legal.claims.options.find((o) => o.kind === "win");
    return winOption
      ? send("requestWinOnDiscard", { offerSeq: legal.claims.offerSeq })
      : send("requestPass", { offerSeq: legal.claims.offerSeq });
  }
  if (legal.robKong) return send("requestRobKong", { offerSeq: legal.robKong.offerSeq });
  if (legal.discard.length > 0) {
    return send("requestDiscard", { tile: legal.discard[legal.discard.length - 1] });
  }
  /* Nothing to do — e.g. only a kong is legal, which this policy skips. */
}

/* ── shared tallies across every seat socket ──────────────────────────── */

const shared = {
  seenSeqs: new Set(),
  eventCounts: {},
  handEndCount: 0,
  lastStandings: null,
  matchEndPayload: null,
  chatReceived: 0,
};
const matchEndDeferred = deferred();
const faultDeferred = deferred();

function handleEvents(events) {
  for (const e of events ?? []) {
    if (shared.seenSeqs.has(e.seq)) continue;
    shared.seenSeqs.add(e.seq);
    shared.eventCounts[e.type] = (shared.eventCounts[e.type] ?? 0) + 1;
    if (e.type === "handEnd") {
      shared.handEndCount += 1;
      shared.lastStandings = e.payload.standings;
      console.log(
        `[hand ${e.handIndex}] end outcome=${e.payload.outcome} winner=${e.payload.winner} ` +
          `faan=${e.payload.faan ?? "-"} standings=${JSON.stringify(e.payload.standings)}`,
      );
    }
    if (e.type === "matchEnd") {
      shared.matchEndPayload = e.payload;
      console.log(
        `[match] end reason=${e.payload.reason} handsPlayed=${e.payload.handsPlayed} ` +
          `standings=${JSON.stringify(e.payload.standings)} placements=${JSON.stringify(e.payload.placements)}`,
      );
      matchEndDeferred.resolve(e.payload);
    }
  }
}

/**
 * Ends the hand-end intermission early (worker/src/table.ts
 * `handleRequestNextHand`) instead of waiting the full `handEndIntermissionMs`
 * on every hand. PER-SOCKET, deliberately outside
 * `handleEvents`'s global `seenSeqs` dedup: every connected human's own
 * socket has to send its own `requestNextHand` for the server to count it,
 * so this must run once per socket, not once per unique `seq` across all of
 * them.
 */
function respondToHandEnd(events, send) {
  for (const e of events ?? []) {
    if (e.type === "handEnd") send("requestNextHand", {});
  }
}

/**
 * Ends the start card's hold early (§8a-2, `worker/src/table.ts`
 * `dispatchMatchStart`) the exact same way `respondToHandEnd` ends the
 * hand-end intermission early — `requestNextHand` is the one message that
 * skips either hold, and the table tells them apart itself. `starting` is
 * `null` on `welcome`/`restore` when no card is open, or the standalone
 * `starting` broadcast's own (always-present) payload.
 */
function respondToStarting(starting, send) {
  if (starting) send("requestNextHand", {});
}

/* ── one seat's socket ─────────────────────────────────────────────────── */

/** Resolves with the open WebSocket once `welcome` confirms the join. */
const MAX_RECONNECTS = 8;

function openSeatSocket(human, matchUuid, resume = null) {
  const label = `seat${human.seat}`;
  return new Promise((resolveConnected, rejectConnected) => {
    const ws = new WebSocket(`${WS_BASE}/table/${matchUuid}?gate=${GATE_HEX}`);
    let joined = false;
    const openedAt = Date.now();
    let lastSeq = resume?.lastSeq ?? -1;
    const trackSeq = (events) => {
      for (const e of events) if (typeof e.seq === "number" && e.seq > lastSeq) lastSeq = e.seq;
    };

    const send = (type, payload) => {
      ws.send(JSON.stringify({ p: 1, requestId: randomUUID(), type, payload }));
    };

    ws.addEventListener("open", () => {
      send("join", { matchId: matchUuid, seatToken: human.seatToken, client: { kind: "headless", version: "smoke" } });
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch {
        console.error(`${label}: unparseable message from server`);
        return;
      }
      switch (msg.type) {
        case "welcome":
          joined = true;
          if (resume) {
            console.log(`${label}: rejoined (reconnect #${resume.count}); resync since seq ${lastSeq}`);
            send("resync", { sinceSeq: lastSeq });
          } else {
            console.log(`${label}: joined match ${msg.payload.matchId} as seat ${msg.payload.seat}`);
            // §8: each human seat sends one quick-phrase chat after joining —
            // exercises `chat` end to end (protocol -> table -> every socket)
            // without slowing the match down.
            send("chat", { phrase: "nice" });
          }
          // §8a-2: this join may be the one that filled the table and opened
          // the start card — `welcome.payload.starting` says so directly.
          respondToStarting(msg.payload.starting, send);
          resolveConnected(ws);
          break;
        case "accepted":
          break;
        case "rejected":
          console.warn(
            `${label}: rejected ${msg.payload.code}${msg.payload.detail ? " - " + msg.payload.detail : ""}`,
          );
          break;
        case "chat":
          shared.chatReceived += 1;
          break;
        case "events":
          trackSeq(msg.payload.events);
          handleEvents(msg.payload.events);
          respondToHandEnd(msg.payload.events, send);
          break;
        case "restore":
          trackSeq(msg.payload.events);
          handleEvents(msg.payload.events);
          respondToHandEnd(msg.payload.events, send);
          respondToStarting(msg.payload.starting, send);
          break;
        case "prompt":
          respondToPrompt(msg.payload.legal, send);
          break;
        case "presence":
          break;
        case "starting":
          console.log(`${label}: start card open, starting at ${new Date(msg.payload.startsAt).toISOString()}`);
          respondToStarting(msg.payload, send);
          break;
        case "paused":
          console.log(
            `${label}: table ${msg.payload.on ? "paused" : "resumed"} by seat ${msg.payload.bySeat} (${msg.payload.displayName})`,
          );
          break;
        case "heartbeat":
          send("heartbeat", {});
          break;
        case "protocolFault":
          faultDeferred.reject(
            new Error(`${label}: protocolFault ${msg.payload.code} ${msg.payload.detail ?? ""}`),
          );
          break;
        default:
          console.warn(`${label}: unknown message type ${String(msg.type)}`);
      }
    });

    ws.addEventListener("close", (ev) => {
      if (shared.matchEndPayload) return;
      // The real client reconnects and resyncs; so does this one, and it
      // records when the drop happened so a platform-side pattern shows up.
      const count = (resume?.count ?? 0) + 1;
      const alive = ((Date.now() - openedAt) / 1000).toFixed(0);
      console.warn(`${label}: socket closed (code=${ev.code}, reason="${ev.reason}") after ${alive}s; reconnecting (#${count})`);
      if (count > MAX_RECONNECTS) {
        faultDeferred.reject(new Error(`${label}: gave up after ${MAX_RECONNECTS} reconnects`));
        return;
      }
      setTimeout(() => {
        openSeatSocket(human, matchUuid, { count, lastSeq }).catch((err) => faultDeferred.reject(err));
      }, 1000 * count);
    });

    ws.addEventListener("error", () => {
      if (!joined) rejectConnected(new Error(`${label}: websocket error before join completed`));
    });
  });
}

/* ── main ──────────────────────────────────────────────────────────────── */

async function main() {
  const start = Date.now();

  /* Two ways to describe the table: the new `seats` plan (MJRC_SEATS, a bot
   * may be at any seat) or the legacy botSeats/bots count (bots fill from the
   * top). `joiningHumanCount` is how many of the plan's human seats this run
   * actually mints an identity and joins for — every one of them, unless
   * MJRC_START leaves the last one open on purpose. */
  let tableBody;
  let joiningHumanCount;
  if (SEATS) {
    const humanSeats = SEATS.filter((s) => s.kind === "human").length;
    if (START && humanSeats < 2) {
      throw new Error("MJRC_START needs at least 2 human seats in MJRC_SEATS — one stays open for /start to fill");
    }
    joiningHumanCount = START ? humanSeats - 1 : humanSeats;
    if (joiningHumanCount < 1) throw new Error("MJRC_SEATS names no human seat for the creator to take");
    tableBody = {
      rulesetId: RULESET_ID,
      matchFormat: MATCH_FORMAT,
      mode: MODE,
      seats: SEATS,
      ...(SPEED ? { speed: SPEED } : {}),
    };
  } else {
    const botSeats = 4 - HUMANS;
    if (BOTS.length > 0 && BOTS.length !== botSeats) {
      throw new Error(`MJRC_BOTS has ${BOTS.length} keys but botSeats is ${botSeats} (4 - MJRC_HUMANS)`);
    }
    joiningHumanCount = HUMANS;
    tableBody = {
      rulesetId: RULESET_ID,
      matchFormat: MATCH_FORMAT,
      mode: MODE,
      botSeats,
      ...(BOTS.length > 0 ? { bots: BOTS } : {}),
      ...(SPEED ? { speed: SPEED } : {}),
    };
  }

  // Ranked needs every seat human (postTable's own `ranked_needs_humans`
  // 400) — checked here too so a misconfigured ranked run fails with a clear
  // message instead of a 400 from deep inside `/api/tables`.
  if (MODE === "ranked") {
    const allHuman = SEATS ? SEATS.every((s) => s.kind === "human") : HUMANS === 4;
    if (!allHuman) {
      throw new Error("MJRC_MODE=ranked needs MJRC_HUMANS=4 (or an all-human MJRC_SEATS) — the server refuses any bot seat in a ranked table");
    }
  }

  console.log(
    `mjrc smoke test — base=${HTTP_BASE} mode=${MODE} format=${MATCH_FORMAT} ruleset=${RULESET_ID} ` +
      (SEATS ? `seats=${process.env.MJRC_SEATS}` : `humans=${HUMANS}`) +
      (START ? " start=1" : "") +
      (BOTS.length > 0 ? ` bots=${BOTS.join(",")}` : "") +
      (SPEED ? ` speed=${SPEED}` : ""),
  );

  const humans = [];
  for (let i = 0; i < joiningHumanCount; i += 1) {
    const deviceToken = mintDeviceToken(i);
    const displayName = `Smoke${i}`;
    await apiFetch("/api/identity", { method: "POST", body: { deviceToken, displayName } });
    humans.push({ deviceToken, displayName });
    // Printed so the match can be queried afterwards as this player.
    console.log(`${displayName}: device token ${deviceToken}`);
  }

  const created = await apiFetch("/api/tables", {
    method: "POST",
    token: humans[0].deviceToken,
    body: tableBody,
  });
  const matchUuid = created.matchUuid;
  humans[0].seat = created.seat;
  humans[0].seatToken = created.seatToken;
  console.log(`created table ${created.tableId} match=${matchUuid} joinCode=${created.joinCode}`);

  for (let i = 1; i < humans.length; i += 1) {
    const joined = await apiFetch(`/api/tables/${created.joinCode}/join`, {
      method: "POST",
      token: humans[i].deviceToken,
    });
    humans[i].seat = joined.seat;
    humans[i].seatToken = joined.seatToken;
  }

  if (START) {
    // The remaining human seat has nobody — /start converts it to a bot
    // (default lineup) and starts the clocks, same as the lobby's "Start now".
    await apiFetch(`/api/tables/${matchUuid}/start`, { method: "POST", token: humans[0].deviceToken });
    console.log("creator started the table — the unfilled seat is now a bot");
  }

  const sockets = await Promise.all(humans.map((h) => openSeatSocket(h, matchUuid)));

  if (PAUSE_TEST) {
    const pauser = sockets[0];
    const send = (type, payload) => pauser.send(JSON.stringify({ p: 1, requestId: randomUUID(), type, payload }));
    console.log("MJRC_PAUSE=1: pausing the table for 3s during hand 0");
    send("requestPause", {});
    await new Promise((r) => setTimeout(r, 3000));
    console.log("MJRC_PAUSE=1: resuming");
    send("requestResume", {});
  }

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`overall timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
  );
  await Promise.race([matchEndDeferred.promise, faultDeferred.promise, timeout]);

  for (const ws of sockets) {
    try {
      ws.close(1000, "smoke test complete");
    } catch {
      /* already closing/closed */
    }
  }

  const detail = await apiFetch(`/api/matches/${matchUuid}`, { token: humans[0].deviceToken });

  // Ranked settlement (worker/src/table.ts `settleRatedMatch`, called from
  // `bindingArchive.finishMatch` at the same close-out that just wrote
  // `detail`) — GET /api/stats/me must show a real rating afterward, not the
  // unrated null every fresh identity starts with.
  let statsAfter = null;
  if (MODE === "ranked") {
    statsAfter = await apiFetch("/api/stats/me", { token: humans[0].deviceToken });
    if (statsAfter.player.rating === null || statsAfter.player.ratingGames < 1) {
      throw new Error(
        `ranked match settled but GET /api/stats/me shows no rating: ${JSON.stringify(statsAfter.player)}`,
      );
    }
  }

  const elapsedMs = Date.now() - start;
  console.log("--- summary ---");
  console.log(`hands played: ${shared.handEndCount}`);
  console.log(`events by type: ${JSON.stringify(shared.eventCounts)}`);
  console.log(`chat messages received: ${shared.chatReceived}`);
  console.log(`elapsed: ${elapsedMs}ms`);
  console.log(
    `final standings: ${JSON.stringify(shared.matchEndPayload?.standings ?? shared.lastStandings)}`,
  );
  console.log(`match detail: status=${detail.match.status} handCount=${detail.match.handCount}`);
  if (statsAfter) {
    console.log(
      `ranked settlement: rating=${statsAfter.player.rating} ratingGames=${statsAfter.player.ratingGames} ` +
        `provisional=${statsAfter.player.provisional}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("SMOKE TEST FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

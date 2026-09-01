#!/usr/bin/env node
/**
 * Headless end-to-end smoke test for the mjrc-game Worker.
 *
 * Flow:
 *   1. Mint one device token per human seat and POST /api/identity for each.
 *   2. The first human POSTs /api/tables (botSeats = 4 - MJRC_HUMANS), the
 *      rest POST /api/tables/:joinCode/join — each gets back a seat + a
 *      one-time seatToken.
 *   3. Each human opens its own WebSocket to /table/:matchUuid, sends `join`
 *      with its seatToken, and from then on reacts to whatever the server
 *      sends: it answers a `prompt` with the simplest legal move (see
 *      `respondToPrompt`), replies to a server `heartbeat`, and logs
 *      `rejected` without dying.
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

/* ── one seat's socket ─────────────────────────────────────────────────── */

/** Resolves with the open WebSocket once `welcome` confirms the join. */
function openSeatSocket(human, matchUuid) {
  const label = `seat${human.seat}`;
  return new Promise((resolveConnected, rejectConnected) => {
    const ws = new WebSocket(`${WS_BASE}/table/${matchUuid}?gate=${GATE_HEX}`);
    let joined = false;

    const send = (type, payload) => {
      ws.send(JSON.stringify({ p: 1, requestId: randomUUID(), type, payload }));
    };

    ws.addEventListener("open", () => {
      send("join", { matchId: matchUuid, seatToken: human.seatToken });
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
          console.log(`${label}: joined match ${msg.payload.matchId} as seat ${msg.payload.seat}`);
          resolveConnected(ws);
          break;
        case "accepted":
          break;
        case "rejected":
          console.warn(
            `${label}: rejected ${msg.payload.code}${msg.payload.detail ? " - " + msg.payload.detail : ""}`,
          );
          break;
        case "events":
          handleEvents(msg.payload.events);
          break;
        case "restore":
          handleEvents(msg.payload.events);
          break;
        case "prompt":
          respondToPrompt(msg.payload.legal, send);
          break;
        case "presence":
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
      if (!shared.matchEndPayload) {
        faultDeferred.reject(new Error(`${label}: socket closed unexpectedly (code=${ev.code})`));
      }
    });

    ws.addEventListener("error", () => {
      if (!joined) rejectConnected(new Error(`${label}: websocket error before join completed`));
    });
  });
}

/* ── main ──────────────────────────────────────────────────────────────── */

async function main() {
  const start = Date.now();
  console.log(
    `mjrc smoke test — base=${HTTP_BASE} humans=${HUMANS} format=${MATCH_FORMAT} ruleset=${RULESET_ID}`,
  );

  const humans = [];
  for (let seat = 0; seat < HUMANS; seat += 1) {
    const deviceToken = mintDeviceToken(seat);
    const displayName = `Smoke${seat}`;
    await apiFetch("/api/identity", { method: "POST", body: { deviceToken, displayName } });
    humans.push({ deviceToken, displayName });
  }

  const created = await apiFetch("/api/tables", {
    method: "POST",
    token: humans[0].deviceToken,
    body: { rulesetId: RULESET_ID, matchFormat: MATCH_FORMAT, botSeats: 4 - HUMANS },
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

  const sockets = await Promise.all(humans.map((h) => openSeatSocket(h, matchUuid)));

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

  const elapsedMs = Date.now() - start;
  console.log("--- summary ---");
  console.log(`hands played: ${shared.handEndCount}`);
  console.log(`events by type: ${JSON.stringify(shared.eventCounts)}`);
  console.log(`elapsed: ${elapsedMs}ms`);
  console.log(
    `final standings: ${JSON.stringify(shared.matchEndPayload?.standings ?? shared.lastStandings)}`,
  );
  console.log(`match detail: status=${detail.match.status} handCount=${detail.match.handCount}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("SMOKE TEST FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

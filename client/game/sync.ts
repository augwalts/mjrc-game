/**
 * Getting the data off the device.
 *
 * The owner's requirement: "I don't want the data local. I want the data to
 * feed into our server." IndexedDB stays, but only as a BUFFER — every record
 * is pushed up and marked, and anything unsent is retried on the next boot.
 *
 * Local-first rather than post-directly, deliberately: a friend on a phone with
 * a flaky connection must not lose the match they just played, and the server
 * being down must not stop the game. The store is the queue; this is the drain.
 *
 * ── what goes up, and what does not ──────────────────────────────────────
 * The event log does NOT. **D1's maximum SQL statement is 100 KB** and an
 * event log is 187 KB for one wind round and 754 KB for four, so it cannot go
 * up as one statement at any length.
 *
 * The ACTION log does, gzipped. It is the inputs rather than the outputs, and
 * replaying it through the reducer regenerates the events exactly — the reducer
 * is pure and every action is stored, bots' included. 23.5 KB for one wind and
 * 93 KB for four, which gzip takes to roughly 5-20 KB. So the server gets a
 * complete, replayable record inside the limit, and the fat cache stays on the
 * device where it costs nothing.
 */
import type { FeedbackRec, MatchRec, MoveRec } from "./store.js";

/**
 * Same-origin. The game is served from `/game/` and the API sits under it at
 * `/game/api/` ON PURPOSE: one Basic Auth middleware then covers the page, its
 * assets and its API, and the browser attaches the credentials it already has
 * for that path. An API at `/api/game/` would sit outside the gate's subtree
 * and need its own.
 */
const BASE = new URL("api/", new URL(".", location.href)).toString();

const POST_TIMEOUT_MS = 12_000;

export interface SyncResult {
  matches: number;
  feedback: number;
  failed: number;
  /** Null when everything worked; a short reason when it did not. */
  why: string | null;
}

/** gzip + base64. `CompressionStream` is native; no library ships for this. */
async function gzipB64(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const cs = new CompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function post(path: string, body: unknown): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
  try {
    return await fetch(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // the page is behind Basic Auth; send what the browser already holds
      credentials: "same-origin",
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * One match, as the server wants it. Summary fields are flat columns so the
 * stats can be queried without unpacking anything; the replay is one blob.
 */
async function matchPayload(m: MatchRec, moves: MoveRec[]): Promise<unknown> {
  return {
    id: m.id,
    playerId: m.playerId,
    playerName: m.playerName,
    rounds: m.rounds,
    rulesetId: m.rulesetId,
    tableId: m.tableId,
    seats: m.seats,
    seed: m.seed,
    recorded: m.recorded,
    abandoned: m.abandoned,
    startedAt: m.startedAt,
    finishedAt: m.finishedAt,
    chips: m.chips,
    hands: m.hands,
    won: m.won,
    selfDrawn: m.selfDrawn,
    fed: m.fed,
    drawnHands: m.drawnHands,
    seatWins: m.seatWins,
    matchRate: m.matchRate,
    meanGap: m.meanGap,
    movesGraded: m.movesGraded,
    client: { ua: navigator.userAgent, tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
    // the replay, gzipped — see the header for why it is actions and not events
    actionsGz: await gzipB64({ seed: m.seed, rulesetId: m.rulesetId, rounds: m.rounds, actions: m.actions }),
    moves: moves.map((v) => ({
      hand: v.hand, turn: v.turn, kind: v.kind, played: v.played,
      enginePick: v.enginePick, gap: v.gap, top1MinusTop2: v.top1MinusTop2, reason: v.reason,
    })),
  };
}

/**
 * Drain everything unsent. Safe to call at any time and from anywhere, and it
 * never throws into the game.
 */
let inflight: Promise<SyncResult> | null = null;
export function drain(store: typeof import("./store.js")): Promise<SyncResult> {
  // A second caller JOINS the run in flight rather than being turned away.
  // Refusing returned "already running", which the lobby then displayed as a
  // failure — while the drain it was waiting on was succeeding. Sharing the
  // promise means every caller sees the same true outcome.
  inflight ??= run(store).finally(() => { inflight = null; });
  return inflight;
}

async function run(store: typeof import("./store.js")): Promise<SyncResult> {
  const out: SyncResult = { matches: 0, feedback: 0, failed: 0, why: null };
  {
    // Only finished matches. A match still in progress is flushed to the store
    // at every hand end, and uploading a half-played record would have the
    // server hold rows that are about to be superseded.
    const matches = (await store.allMatches()).filter((m) => !m.uploadedAt && m.finishedAt !== null);
    for (const m of matches) {
      try {
        const moves = await store.movesFor(m.id);
        const r = await post("match", await matchPayload(m, moves));
        if (!r.ok) { out.failed++; out.why ??= `match ${r.status}`; continue; }
        await store.putMatch({ ...m, uploadedAt: Date.now() });
        out.matches++;
      } catch (e) { out.failed++; out.why ??= String(e).slice(0, 80); }
    }

    const fb = (await store.allFeedback()).filter((f) => !f.uploadedAt);
    for (const f of fb) {
      try {
        const r = await post("feedback", {
          id: f.id, matchId: f.matchId, hand: f.hand, text: f.text,
          createdAt: f.createdAt, context: f.context,
        });
        if (!r.ok) { out.failed++; out.why ??= `feedback ${r.status}`; continue; }
        await store.putFeedback({ ...f, uploadedAt: Date.now() });
        out.feedback++;
      } catch (e) { out.failed++; out.why ??= String(e).slice(0, 80); }
    }
  }
  return out;
}

/** How much is still sitting on this device. Shown to the player. */
export async function pending(store: typeof import("./store.js")): Promise<number> {
  const [m, f] = await Promise.all([store.allMatches(), store.allFeedback()]);
  return m.filter((x) => !x.uploadedAt && x.finishedAt !== null).length
    + f.filter((x) => !x.uploadedAt).length;
}

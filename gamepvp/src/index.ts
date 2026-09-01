/**
 * gamepvp — the Worker entry. One script hosts four things, in this order:
 *
 *   1. The front-door gate. Invite-only beta: a shared password, checked on
 *      EVERY request including the assets and the socket upgrade. Fails closed.
 *   2. Static assets (the client) — `ASSETS`, built by ./build.sh.
 *   3. The platform API (`/api/*`) — worker/src/index.ts, plain HTTP over D1.
 *   4. The match plane (`/table/:matchId`) — a WebSocket into one TableDO.
 *
 * The two planes never share a channel (sketches/BACKEND.md §1): the API is
 * stateless and hands out `{ matchUuid, seatToken }`; the socket is where the
 * match happens, and the seat token is the only thing that binds one to the
 * other.
 *
 * Doctrine: nothing in this file decides anything about the game. It routes,
 * gates and binds — the reducer is installed into the table at module load and
 * that is the last this file hears of mahjong.
 */
import { ENGINE_VERSION, applyAction, legalActions, startMatch, startNextHand } from "../../engine/src/reducer.js";
import { EVENT_SCHEMA_VERSION, type MatchLogHeader } from "../../protocol/src/index.js";
import {
  TableDO as BaseTableDO,
  installTableRules,
  type TableInit,
} from "../../worker/src/table.js";
import {
  handle,
  type Env as PlatformEnv,
  type Platform,
  type SeatClaim,
  type TableNamespace,
  type TableSpec,
} from "../../worker/src/index.js";
import { BOT_LINEUP, bots } from "./bots.js";

/* ── bind the engine into the table, once, at module load ─────────────── */

installTableRules({ startMatch, startNextHand, applyAction, legalActions }, bots);

/** The Durable Object binding target (wrangler.jsonc `class_name`). */
export class TableDO extends BaseTableDO {}

/* ── environment ───────────────────────────────────────────────────────── */

/** Structural, like worker/src/table.ts: no `cloudflare:workers` import, so
 *  the same file typechecks in the plain TS project. */
interface DurableObjectStubLike {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): DurableObjectStubLike;
}

export interface Env extends Omit<PlatformEnv, "TABLES"> {
  ASSETS: { fetch(request: Request): Promise<Response> };
  TABLES: DurableObjectNamespaceLike;
  /** The invite-only front door. Unset = nothing is served (fail closed). */
  GAME_PASSWORD?: string;
  /** Optional: guards the DO's init/seat endpoints. Set it in production. */
  TABLE_SECRET?: string;
}

/* ── 1. the gate ───────────────────────────────────────────────────────── */

const GATE_COOKIE = "mjrc_gate";

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The cookie value is a digest of the password, not a session: anyone who
 *  holds the password can compute it, which is exactly the set of people the
 *  gate admits. No server-side state, no expiry to manage. */
const gateDigest = (password: string): Promise<string> => sha256Hex(`mjrc-gate:${password}`);

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const challenge = (message: string, status = 401): Response =>
  new Response(message, {
    status,
    headers: {
      "WWW-Authenticate": 'Basic realm="MJRC gamepvp", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

type GateResult = { ok: true; setCookie: string | null } | { ok: false; response: Response };

/**
 * Admit if any ONE of these carries the password's digest:
 *   - the `mjrc_gate` cookie (the browser, after its first Basic Auth prompt);
 *   - `?gate=<digest>` on the URL (a WebSocket from a client that cannot set
 *     headers — the smoke test, and browsers on the socket upgrade);
 *   - HTTP Basic Auth with the password itself (the first visit; sets the cookie).
 * The `Authorization` header is otherwise the API's (`Bearer <deviceToken>`),
 * which is why the browser's cached Basic credential cannot be the API's gate.
 */
async function gate(request: Request, env: Env): Promise<GateResult> {
  const expected = env.GAME_PASSWORD;
  if (!expected) {
    return { ok: false, response: challenge("gamepvp is not configured on this deployment.", 503) };
  }
  const digest = await gateDigest(expected);

  const cookie = cookieValue(request, GATE_COOKIE);
  if (cookie !== null && constantTimeEqual(cookie, digest)) return { ok: true, setCookie: null };

  // Admitted by query: set the cookie too, so a page opened this way (a link
  // shared with the digest, or a browser that cannot answer a Basic Auth
  // prompt) carries the gate on every fetch and socket that follows.
  const query = new URL(request.url).searchParams.get("gate");
  if (query !== null && constantTimeEqual(query, digest)) {
    return { ok: true, setCookie: gateCookie(request, digest) };
  }

  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(auth.slice(6));
    } catch {
      return { ok: false, response: challenge("gamepvp is a private beta. Enter the password to continue.") };
    }
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (constantTimeEqual(await sha256Hex(password), await sha256Hex(expected))) {
      return { ok: true, setCookie: gateCookie(request, digest) };
    }
  }
  return { ok: false, response: challenge("gamepvp is a private beta. Enter the password to continue.") };
}

function gateCookie(request: Request, digest: string): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${GATE_COOKIE}=${digest}; Path=/; Max-Age=${60 * 60 * 24 * 90}; SameSite=Lax; HttpOnly${secure}`;
}

/* ── 3. the API's view of the match plane ──────────────────────────────── */

const SEAT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Implements the platform's `TableNamespace` port over the real DO binding.
 * `openTable` is the lobby→table handoff (§5.3): it decides who is a bot, mints
 * the match seed, and initialises the object. `issueSeatToken` binds a player
 * to a human seat and gets that seat's credential back.
 */
function tableNamespace(env: Env): TableNamespace {
  const secretHeaders = (): Record<string, string> =>
    env.TABLE_SECRET ? { "x-mjrc-table-secret": env.TABLE_SECRET } : {};

  const post = async (stub: DurableObjectStubLike, path: string, body: unknown): Promise<Response> =>
    stub.fetch(`https://table${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...secretHeaders() },
      body: JSON.stringify(body),
    });

  return {
    idFromName: (name) => env.TABLES.idFromName(name),
    get: (id) => {
      const stub = env.TABLES.get(id);
      return {
        async openTable(spec: TableSpec): Promise<void> {
          const init = tableInitOf(spec);
          await ensureBotPlayers(env, init, spec.startedAt);
          const res = await post(stub, "/init", init);
          if (!res.ok) throw new Error(`table init ${res.status}: ${await res.text()}`);
        },
        async issueSeatToken(claim: SeatClaim): Promise<{ seatToken: string; expiresAt: string }> {
          const res = await post(stub, "/seat", claim);
          if (!res.ok) throw new Error(`seat claim ${res.status}: ${await res.text()}`);
          return (await res.json()) as { seatToken: string; expiresAt: string };
        },
      };
    },
  };
}

/**
 * A bot is a player (worker/schema.sql `players.kind = 'bot'`), and `hands`
 * references `players` by id for winner and payer, so the rows must exist
 * before the first hand can be archived. Idempotent: one row per profile,
 * shared by every match that bot ever sits at.
 */
async function ensureBotPlayers(env: Env, init: TableInit, now: string): Promise<void> {
  for (const p of init.header.players) {
    if (!p.bot) continue;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO players (id, kind, display_name, created_at, updated_at, last_seen_at)
       VALUES (?, 'bot', ?, ?, ?, ?)`,
    )
      .bind(p.playerId, p.displayName, now, now, now)
      .run();
  }
}

/** Humans take the low seats, in join order; bots fill from the top. The seed
 *  and the placeholder tokens are coordination entropy, not game state. */
function tableInitOf(spec: TableSpec): TableInit {
  const botSeats = Math.max(0, Math.min(4, spec.botSeats));
  const firstBot = 4 - botSeats;
  const seatOf = (i: number) => i as 0 | 1 | 2 | 3;
  const players = [0, 1, 2, 3].map((i) => {
    const seat = seatOf(i);
    if (i >= firstBot) {
      const b = BOT_LINEUP[seat]!;
      return { playerId: `bot:${b.profile}`, displayName: b.displayName, seat, bot: true };
    }
    return { playerId: "", displayName: "", seat, bot: false };
  }) as MatchLogHeader["players"];
  const header: MatchLogHeader = {
    v: EVENT_SCHEMA_VERSION,
    matchId: spec.matchId,
    engineVersion: spec.engineVersion,
    rulesetId: spec.rulesetId,
    startedAt: Date.parse(spec.startedAt) || 0,
    players,
    matchLength: spec.matchFormat === "full" ? "fourWindRounds" : "oneWindRound",
    startingChips: [0, 0, 0, 0],
  };
  const words = crypto.getRandomValues(new Uint32Array(1));
  return {
    matchId: spec.matchId,
    header,
    seed: (words[0]! & 0x7fffffff) >>> 0,
    seatTokens: [placeholderToken(), placeholderToken(), placeholderToken(), placeholderToken()],
    rulesetHash: spec.rulesetHash,
  };
}

/** Never handed out: every human seat's token is rotated by `/seat` before a
 *  client sees it, and a bot seat never joins by socket. */
function placeholderToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function platformOf(env: Env): Platform {
  const configured = (env.ENGINE_VERSION ?? "").trim();
  if (configured !== "" && configured !== ENGINE_VERSION) {
    throw new Error(`ENGINE_VERSION var ${configured} disagrees with the engine build ${ENGINE_VERSION}`);
  }
  const replayTokenSecret = (env.REPLAY_TOKEN_SECRET ?? "").trim();
  if (replayTokenSecret.length < 32) throw new Error("REPLAY_TOKEN_SECRET is unset or too short");
  return {
    db: env.DB,
    logs: env.LOGS,
    tables: tableNamespace(env),
    now: () => new Date().toISOString(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    engineVersion: ENGINE_VERSION,
    replayTokenSecret,
  };
}

/* ── 4. the match plane ────────────────────────────────────────────────── */

const MATCH_ID_RE = /^[0-9A-Za-z]{8,64}$/;

/** `/table/:matchId` — a WebSocket upgrade, and nothing else, reaches the DO
 *  from outside. `/init` and `/seat` are the API's and are never routed here. */
function tableSocket(request: Request, env: Env, matchId: string): Promise<Response> | Response {
  if (!MATCH_ID_RE.test(matchId)) return new Response("not found", { status: 404 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const stub = env.TABLES.get(env.TABLES.idFromName(matchId));
  return stub.fetch(request);
}

/* ── the router ────────────────────────────────────────────────────────── */

const withCookie = (res: Response, setCookie: string | null): Response => {
  if (setCookie === null) return res;
  const out = new Response(res.body, res);
  out.headers.append("set-cookie", setCookie);
  return out;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const admitted = await gate(request, env);
    if (!admitted.ok) return admitted.response;

    const url = new URL(request.url);
    const seg = url.pathname.split("/").filter((s) => s !== "");

    if (seg[0] === "api") {
      let platform: Platform;
      try {
        platform = platformOf(env);
      } catch (e) {
        console.error("gamepvp misconfigured:", e);
        return new Response(JSON.stringify({ error: "server_misconfigured" }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return withCookie(await handle(request, platform), admitted.setCookie);
    }

    if (seg[0] === "table" && seg.length === 2) {
      return tableSocket(request, env, seg[1]!);
    }

    return withCookie(await env.ASSETS.fetch(request), admitted.setCookie);
  },
};

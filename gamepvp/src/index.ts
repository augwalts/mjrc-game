/**
 * gamepvp — the Worker entry. One script hosts four things, in this order:
 *
 *   1. The front-door gate. Invite-only beta: a shared password, checked on
 *      EVERY request including the assets and the socket upgrade. Fails closed.
 *   2. Static assets (the client) — `ASSETS`, built by ./build.sh. `/j/:code`
 *      also serves the client's index.html unchanged (the invite link,
 *      PVP-LOBBY-PROPOSAL-2026-09-02.md §3.2) — the client reads the path.
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
import { ruleset } from "@mjrc/rulesets";
import {
  TableDO as BaseTableDO,
  botPlayerId,
  installTableRules,
  type TableInit,
} from "../../worker/src/table.js";
import { handleAuth } from "../../worker/src/auth.js";
import {
  authFromEnv,
  handle,
  type Env as PlatformEnv,
  type Platform,
  type SeatClaim,
  type SeatSpec,
  type TableNamespace,
  type TableSpec,
} from "../../worker/src/index.js";
import { claimSeat } from "../../worker/src/db.js";
import type { SeatIndex } from "../../engine/src/types.js";
import { BOT_CATALOGUE, BOT_LINEUP, bots, catalogueEntry, defaultBotFor, isBotCatalogueKey } from "./bots.js";

/* ── bind the engine into the table, once, at module load ─────────────── */

installTableRules({ startMatch, startNextHand, applyAction, legalActions }, bots, defaultBotFor);

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
          await ensureBotSeatRows(env, init);
          const res = await post(stub, "/init", init);
          if (!res.ok) throw new Error(`table init ${res.status}: ${await res.text()}`);
        },
        async issueSeatToken(claim: SeatClaim): Promise<{ seatToken: string; expiresAt: string }> {
          const res = await post(stub, "/seat", claim);
          if (!res.ok) throw new Error(`seat claim ${res.status}: ${await res.text()}`);
          return (await res.json()) as { seatToken: string; expiresAt: string };
        },
        async fill(): Promise<void> {
          const res = await post(stub, "/fill", {});
          if (!res.ok) throw new Error(`table fill ${res.status}: ${await res.text()}`);
        },
        async leave(playerId: string): Promise<void> {
          const res = await post(stub, "/leave", { playerId });
          if (!res.ok) throw new Error(`table leave ${res.status}: ${await res.text()}`);
        },
        async observe(): Promise<Record<string, unknown>> {
          const res = await post(stub, "/observe", {});
          if (!res.ok) throw new Error(`table observe ${res.status}: ${await res.text()}`);
          return (await res.json()) as Record<string, unknown>;
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

/**
 * `match_players` row for every seat `tableInitOf` opened as a bot. Bot seats
 * never call `POST /api/tables/:code/join` — `claimSeat`'s only other
 * caller — so without this a bot's standings vanish from `GET
 * /api/matches/:id` and the lobby's recent-results strip (schema.sql
 * `match_players`, previously a row only for a human-claimed seat).
 * `claimSeat` (worker/src/db.ts) is reused rather than duplicated: same
 * `wind = seat` convention, same `INSERT OR IGNORE` on `UNIQUE (match_id,
 * player_id)` — which every `playerId` here is already safe against, because
 * `tableInitOf`/`playerRefFor` ran `botPlayerId`'s dedupe before this ever
 * sees them. Idempotent, so a retried `openTable` for an already-initialised
 * match changes nothing further.
 */
async function ensureBotSeatRows(env: Env, init: TableInit): Promise<void> {
  for (const p of init.header.players) {
    if (!p.bot) continue;
    await claimSeat(env.DB, init.matchId, p.seat as SeatIndex, p.playerId);
  }
}

/**
 * A seat's spec (worker/src/index.ts `TableSpec.seatPlan`, §7.2's `seats` or
 * the legacy `botSeats`/`bots` converted to the same shape by `postTable`)
 * becomes this seat's `PlayerRef`: an empty human seat waiting for `/seat` to
 * bind it, or a bot seat with `bot:<key>` naming the profile — falling back
 * to `BOT_LINEUP`'s default for that seat index when the plan named none
 * (`postTable` already validated any key it DID name, so `catalogueEntry`
 * missing here is defensive, not the primary check). A bot may now be at any
 * seat, not only the top ones (§6 decision 3 — the seat plan is the host's,
 * not derived from a count).
 */
function playerRefFor(
  seat: 0 | 1 | 2 | 3,
  spec: SeatSpec,
  used: ReadonlySet<string>,
): MatchLogHeader["players"][number] {
  if (spec.kind === "human") return { playerId: "", displayName: "", seat, bot: false };
  const entry = spec.bot !== undefined ? catalogueEntry(spec.bot) : undefined;
  const key = entry?.key ?? spec.bot ?? BOT_LINEUP[seat]!.profile;
  const displayName = entry?.displayName ?? BOT_LINEUP[seat]!.displayName;
  // A client may name the same bot for two seats (`parseSeatsBody`,
  // worker/src/index.ts, does not forbid it) — `botPlayerId` (worker/src/
  // table.ts) is the one dedupe rule this file and `/fill` both use.
  return { playerId: botPlayerId(key, used), displayName, seat, bot: true };
}

/**
 * The start card's ruleset facts (§8a-2), resolved here — the ONE place in
 * this build that reads `@mjrc/rulesets` for the table's benefit — rather
 * than in `worker/src/table.ts`, which stays free of that import (this
 * file's own header: "the reducer is installed ... and that is the last
 * this file hears of mahjong" is the same doctrine one layer up: the table
 * sequences and broadcasts, it does not know what a ruleset preset is).
 * `undefined` when `rulesetId` does not resolve — `postTable`
 * (`worker/src/index.ts`) already refused to create a match under an
 * unknown ruleset, so this is defensive, not a path a real table takes; the
 * table's own `startingPayload` falls back to generic values when
 * `matchSettings` is absent.
 */
function matchSettingsOf(spec: TableSpec): TableInit["matchSettings"] {
  const rules = ruleset(spec.rulesetId);
  if (rules === undefined) return undefined;
  return {
    rulesetLabel: rules.label,
    minimumFaan: rules.minimumFaan,
    limitFaan: rules.limitFaan,
    useFlowers: rules.useFlowers,
    paymentId: rules.payment.id,
    matchFormat: spec.matchFormat,
  };
}

/** The seed and the placeholder tokens are coordination entropy, not game
 *  state — see `placeholderToken`'s doc comment. */
function tableInitOf(spec: TableSpec): TableInit {
  const used = new Set<string>();
  const players = ([0, 1, 2, 3] as const).map((seat) => {
    const ref = playerRefFor(seat, spec.seatPlan[seat] ?? { kind: "human" }, used);
    if (ref.bot) used.add(ref.playerId);
    return ref;
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
    randomizeSeats: spec.randomizeSeats,
    speed: spec.speed,
    matchSettings: matchSettingsOf(spec),
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
    // Google sign-in (ACCOUNTS-GAME-SIGNIN-2026-09-04.md §2). `undefined` when
    // the secrets are not set, which is a working deployment with accounts off
    // rather than a broken one — see `authFromEnv`.
    auth: authFromEnv(env),
    isBotKey: isBotCatalogueKey,
    // A bot seat's lobby label (worker/src/index.ts `getLobby`'s `botSeatLabel`):
    // the catalogue entry's name if `key` names one, else the seat's default
    // lineup pick — the same fallback `playerRefFor` uses when opening the
    // table, so the lobby never shows a different name than the seat gets.
    botDisplayName: (key, seat) => (key !== undefined ? catalogueEntry(key)?.displayName : undefined)
      ?? BOT_LINEUP[seat]!.displayName,
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

/* ── the SPA's real URL paths (§11.3) ────────────────────────────────────── */

const SPA_ROUTE_PREFIXES = new Set(["rooms", "friends", "stats", "games", "players", "messages", "me", "signin", "signup"]);

/** A dotted final segment means a real file (`/game.js`, `/favicon.ico`) —
 *  the one cheap signal that distinguishes a page navigation from an asset
 *  fetch without a route table naming every asset the client ships. */
function looksLikeAssetPath(seg: readonly string[]): boolean {
  const last = seg[seg.length - 1] ?? "";
  return last.includes(".");
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

    /* /auth/* — Google sign-in, the dev bypass and sign-out
     * (worker/src/auth.ts). Routed here for the same reason `/api/*` is: the
     * platform owns the behaviour, this file owns the front door. Behind the
     * gate like everything else, and above the SPA fallbacks below so
     * `/auth/google` can never be answered with index.html. */
    if (seg[0] === "auth") {
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
      const res = await handleAuth(request, platform);
      if (res !== null) return withCookie(res, admitted.setCookie);
    }

    /* GET /api/bots — the catalogue for the New Table bot picker. Routed here,
     * ahead of the platform's own /api/* dispatch (worker/src/index.ts's
     * `handle`), because it is gamepvp-specific data (bot profiles are not a
     * platform concept) and needs no DB or auth — just the gate above. */
    if (seg[0] === "api" && seg[1] === "bots" && seg.length === 2) {
      if (request.method !== "GET") {
        return withCookie(
          new Response(JSON.stringify({ error: "method_not_allowed" }), {
            status: 405,
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
          admitted.setCookie,
        );
      }
      return withCookie(
        new Response(JSON.stringify({ bots: BOT_CATALOGUE }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        }),
        admitted.setCookie,
      );
    }

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

    /* GET /j/:code — the invite link (proposal §3.2). Serves the SPA's
     * index.html UNCHANGED: the client reads `location.pathname` itself and
     * prefills the join screen with the code. Fetching path "/" rather than
     * rewriting `request` in place matters — `env.ASSETS.fetch` resolves by
     * path, and `/j/<code>` has no asset of its own to find. */
    if (seg[0] === "j" && seg.length === 2) {
      const rootUrl = new URL(request.url);
      rootUrl.pathname = "/";
      return withCookie(
        await env.ASSETS.fetch(new Request(rootUrl.toString(), { headers: request.headers })),
        admitted.setCookie,
      );
    }

    /* GET /r/:code — the room link (PVP-LOBBY-PROPOSAL-2026-09-02.md §8b).
     * Same doctrine as `/j/:code` above, room code instead of join code: the
     * SPA reads `location.pathname` itself and opens straight into the room's
     * lobby. */
    if (seg[0] === "r" && seg.length === 2) {
      const rootUrl = new URL(request.url);
      rootUrl.pathname = "/";
      return withCookie(
        await env.ASSETS.fetch(new Request(rootUrl.toString(), { headers: request.headers })),
        admitted.setCookie,
      );
    }

    /* GET /rooms, /friends, /stats, /games, /players, /messages, /me and
     * anything nested under them — the new lobby shell's real URL paths
     * (PVP-LOBBY-PROPOSAL-2026-09-02.md §11 build decision 3: "every page is
     * shareable"). Same doctrine as `/j/:code` and `/r/:code` above: serve
     * the SPA's index.html unchanged and let the client render the right
     * screen from `location.pathname` itself, rather than adding a route per
     * screen to a Worker that has no idea what a screen is.
     *
     * Restricted to requests that look like page navigation — no dotted
     * extension on the final path segment, and an Accept header that offers
     * HTML — so a same-named asset (`/game.js`), `/api/*`, `/table/*` and
     * every real static file fall through to `ASSETS` untouched below. */
    if (
      request.method === "GET" &&
      seg.length >= 1 &&
      SPA_ROUTE_PREFIXES.has(seg[0]!) &&
      !looksLikeAssetPath(seg) &&
      (request.headers.get("accept") ?? "").includes("text/html")
    ) {
      const rootUrl = new URL(request.url);
      rootUrl.pathname = "/";
      return withCookie(
        await env.ASSETS.fetch(new Request(rootUrl.toString(), { headers: request.headers })),
        admitted.setCookie,
      );
    }

    return withCookie(await env.ASSETS.fetch(request), admitted.setCookie);
  },
};

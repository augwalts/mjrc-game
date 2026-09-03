/**
 * Platform-services tests — the routes of ../src/index.ts and the query helpers
 * of ../src/db.ts, driven end to end against the in-memory fakes in
 * ./harness.ts. DESIGN.md §5.4, §5.3, §2.
 *
 * What the route tests are actually for: the two properties that are security
 * properties rather than features — the public replay link works with no
 * credential at all, and every other match-scoped route refuses a caller who is
 * not in the match.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HKOS_STANDARD } from "@mjrc/rulesets";
import type { D1Like, R2Like, R2ObjectLike, SqlValue } from "../src/db.js";
import { SQL, canonicalJson, rulesetHash, sha256Hex } from "../src/db.js";
import type { Platform, TableSpec } from "../src/index.js";
import { ConfigError, OPEN_ROOM_CODE, handle, mintReplayToken, platformFromEnv, verifyReplayToken } from "../src/index.js";
import type { Harness, Row, Store } from "./harness.js";
import {
  FakeD1,
  FakeR2,
  FakeTables,
  SECRET,
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
  emailFor,
  emptyStore,
  get,
  harness,
  identify,
  post,
  seedMatch,
  signIn,
} from "./harness.js";

/* ── the SQL surface itself ───────────────────────────────────────────────── */

describe("the query surface", () => {
  it("is frozen and carries no interpolated values", () => {
    expect(Object.isFrozen(SQL)).toBe(true);
    /* The only single-quoted literals allowed anywhere in the statement set are
     * closed-vocabulary constants. A quoted value would mean something was
     * concatenated in, which is the thing db.ts exists to make impossible. */
    const allowed = new Set(["running", "waiting", "playing", "done", "abandoned", "complete", "ranked", "casual", "human"]);
    for (const [name, sql] of Object.entries(SQL)) {
      for (const [, literal] of sql.matchAll(/'([^']*)'/g)) {
        expect(allowed.has(literal), `${name} embeds '${literal}'`).toBe(true);
      }
      expect(sql, `${name} looks interpolated`).not.toContain("${");
    }
  });

  it("hashes a ruleset by content, not by identity", async () => {
    const a = await rulesetHash(HKOS_STANDARD);
    const b = await rulesetHash({ ...HKOS_STANDARD, label: "renamed" });
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  it("serializes canonically, so key order cannot change a hash", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });
});

/* ── identity ─────────────────────────────────────────────────────────────── */

describe("POST /api/identity", () => {
  let h: Harness;
  let cookie: string;
  beforeEach(async () => {
    h = harness();
    cookie = await signIn(h, "ahming@example.test", "Ah Ming");
  });

  it("creates a player and stores only the digest of the token", async () => {
    const res = await handle(
      post("/api/identity", { deviceToken: TOKEN_A, displayName: "Ah Ming" }, undefined, cookie),
      h.platform,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { playerId: string; created: boolean };
    expect(body.created).toBe(true);

    expect(h.store.players).toHaveLength(1);
    expect(h.store.player_credentials).toHaveLength(1);
    const stored = h.store.player_credentials[0];
    expect(stored.id).toBe(await sha256Hex(TOKEN_A));
    expect(JSON.stringify(h.store)).not.toContain(TOKEN_A);
    /* The player belongs to the account, not to the browser. */
    expect(h.store.players[0].almanac_user_id).toBe(h.store.users[0].id);
  });

  it("re-presenting the same token returns the same player, not a second one", async () => {
    const first = await identify(h, TOKEN_A, "Ah Ming");
    const res = await handle(
      post(
        "/api/identity",
        { deviceToken: TOKEN_A, displayName: "Ah Ming" },
        undefined,
        await signIn(h, emailFor(TOKEN_A)),
      ),
      h.platform,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playerId: string; created: boolean };
    expect(body.playerId).toBe(first);
    expect(body.created).toBe(false);
    expect(h.store.players).toHaveLength(1);
  });

  it("mints a token when the client supplies none, and returns it exactly once", async () => {
    const res = await handle(post("/api/identity", { displayName: "Ah Ming" }, undefined, cookie), h.platform);
    const body = (await res.json()) as { deviceToken: string };
    expect(body.deviceToken).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);

    const again = await handle(
      post("/api/identity", { deviceToken: body.deviceToken, displayName: "Ah Ming" }, undefined, cookie),
      h.platform,
    );
    expect((await again.json()) as Record<string, unknown>).not.toHaveProperty("deviceToken");
  });

  it("refuses a guessably short device token", async () => {
    const weak = await handle(
      post("/api/identity", { deviceToken: "short", displayName: "Ah Ming" }, undefined, cookie),
      h.platform,
    );
    expect(weak.status).toBe(400);
  });

  it("takes the account's display name when the body omits one", async () => {
    const res = await handle(post("/api/identity", { deviceToken: TOKEN_A }, undefined, cookie), h.platform);
    expect(res.status).toBe(201);
    expect((await res.json()) as { displayName: string }).toMatchObject({ displayName: "Ah Ming" });
  });
});

/* ── authentication boundary ──────────────────────────────────────────────── */

describe("authentication", () => {
  it("refuses every private route without a credential", async () => {
    const h = harness();
    const playerA = await identify(h, TOKEN_A, "Ah Ming");
    seedMatch(h, { id: "M1", seats: [playerA, "P2", "P3", "P4"] });

    for (const req of [
      get("/api/matches"),
      get("/api/matches/M1"),
      get("/api/matches/M1/log"),
      post("/api/tables", {}),
      post("/api/tables/ABCDEFGH/join", {}),
    ]) {
      const res = await handle(req, h.platform);
      expect(res.status, req.url).toBe(401);
    }
    expect(h.logs.gets).toEqual([]);
  });

  it("refuses a token that hashes to nothing stored", async () => {
    const h = harness();
    const res = await handle(get("/api/matches", TOKEN_B), h.platform);
    expect(res.status).toBe(401);
  });
});

/* ── match history and detail ─────────────────────────────────────────────── */

describe("match reads are scoped to the caller's own matches", () => {
  let h: Harness;
  let mine: string;
  let theirs: string;

  beforeEach(async () => {
    h = harness();
    mine = await identify(h, TOKEN_A, "Ah Ming");
    theirs = await identify(h, TOKEN_B, "Ah Fai");
    seedMatch(h, { id: "MINE", seats: [mine, "P2", "P3", "P4"], startedAt: "2026-08-21T10:00:00.000Z" });
    seedMatch(h, { id: "THEIRS", seats: [theirs, "P2", "P3", "P4"], startedAt: "2026-08-22T10:00:00.000Z" });
  });

  it("GET /api/matches lists only the caller's matches", async () => {
    const res = await handle(get("/api/matches", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: { matchId: string; seat: number }[] };
    expect(body.matches.map((m) => m.matchId)).toEqual(["MINE"]);
    expect(body.matches[0].seat).toBe(0);
  });

  it("GET /api/matches/:id serves a participant the seats and the hands", async () => {
    const res = await handle(get("/api/matches/MINE", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      match: { matchId: string; rated: boolean };
      viewerSeat: number;
      seats: unknown[];
      hands: { faan: number; awards: { id: string }[]; deltas: number[]; capped: boolean }[];
      replayToken: string;
    };
    expect(body.match.matchId).toBe("MINE");
    expect(body.match.rated).toBe(false);
    expect(body.viewerSeat).toBe(0);
    expect(body.seats).toHaveLength(4);
    expect(body.hands).toHaveLength(1);
    expect(body.hands[0].faan).toBe(4);
    expect(body.hands[0].capped).toBe(false);
    expect(body.hands[0].awards.map((a) => a.id)).toEqual(["allPungs", "seatWind"]);
    expect(body.hands[0].deltas.reduce((x, y) => x + y, 0)).toBe(0);
    expect(await verifyReplayToken(SECRET, body.replayToken)).toBe("MINE");
  });

  it("GET /api/matches/:id tells a non-participant nothing, not even that it exists", async () => {
    const res = await handle(get("/api/matches/THEIRS", TOKEN_A), h.platform);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "not_found" });
    /* Same answer for an id that was never issued — otherwise the status code
     * itself is an enumeration oracle over every match on the platform. */
    const absent = await handle(get("/api/matches/NOPE", TOKEN_A), h.platform);
    expect(absent.status).toBe(404);
    expect(await absent.text()).toBe(text);
  });

  it("GET /api/matches/:id/log serves a participant the blob", async () => {
    const res = await handle(get("/api/matches/MINE/log", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(await res.text())).toEqual({ header: { matchId: "MINE" }, events: [] });
  });

  it("GET /api/matches/:id/log refuses a non-participant without touching R2", async () => {
    const res = await handle(get("/api/matches/THEIRS/log", TOKEN_A), h.platform);
    expect(res.status).toBe(404);
    expect(h.logs.gets).toEqual([]);
  });

  it("refuses the omniscient log of a match that is still running", async () => {
    seedMatch(h, { id: "LIVE", seats: [mine, "P2", "P3", "P4"], status: "running", logKey: "logs/LIVE.json" });
    const res = await handle(get("/api/matches/LIVE/log", TOKEN_A), h.platform);
    expect(res.status).toBe(404);
    expect((await res.json()) as unknown).toEqual({ error: "log_not_ready" });
    expect(h.logs.gets).toEqual([]);
  });
});

/* ── the public replay link ───────────────────────────────────────────────── */

describe("GET /api/replay/:token", () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    const mine = await identify(h, TOKEN_A, "Ah Ming");
    seedMatch(h, { id: "SHARED", seats: [mine, "P2", "P3", "P4"] });
  });

  it("serves the blob with no credential of any kind", async () => {
    const token = await mintReplayToken(SECRET, "SHARED");
    const req = new Request(`https://game.mahjongresearch.com/api/replay/${token}`);
    expect(req.headers.get("authorization")).toBeNull();

    const res = await handle(req, h.platform);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(JSON.parse(await res.text())).toEqual({ header: { matchId: "SHARED" }, events: [] });
  });

  it("refuses a forged signature", async () => {
    const token = await mintReplayToken(SECRET, "SHARED");
    const forged = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    const res = await handle(get(`/api/replay/${forged}`), h.platform);
    expect(res.status).toBe(404);
    expect(h.logs.gets).toEqual([]);
  });

  it("refuses a token minted under a different secret", async () => {
    const token = await mintReplayToken("a-completely-different-secret-value", "SHARED");
    expect((await handle(get(`/api/replay/${token}`), h.platform)).status).toBe(404);
    expect(h.logs.gets).toEqual([]);
  });

  it("refuses a bare match id with no signature at all", async () => {
    expect((await handle(get("/api/replay/SHARED"), h.platform)).status).toBe(404);
    expect(h.logs.gets).toEqual([]);
  });

  it("never exposes a live match — a share link cannot leak four hands", async () => {
    seedMatch(h, { id: "LIVE", seats: ["P1", "P2", "P3", "P4"], status: "running" });
    const token = await mintReplayToken(SECRET, "LIVE");
    expect((await handle(get(`/api/replay/${token}`), h.platform)).status).toBe(404);
    expect(h.logs.gets).toEqual([]);
  });

  it("does not publish an abandoned match, which stays reviewable by its players", async () => {
    const mine = h.store.match_players[0].player_id as string;
    seedMatch(h, { id: "DEAD", seats: [mine, "P2", "P3", "P4"], status: "abandoned" });
    const token = await mintReplayToken(SECRET, "DEAD");
    expect((await handle(get(`/api/replay/${token}`), h.platform)).status).toBe(404);
    expect((await handle(get("/api/matches/DEAD/log", TOKEN_A), h.platform)).status).toBe(200);
  });

  it("refuses a match whose log blob never landed", async () => {
    seedMatch(h, { id: "LOST", seats: ["P1", "P2", "P3", "P4"], logKey: null });
    const token = await mintReplayToken(SECRET, "LOST");
    expect((await handle(get(`/api/replay/${token}`), h.platform)).status).toBe(404);
    expect(h.logs.gets).toEqual([]);
  });
});

/* ── the lobby handoff ────────────────────────────────────────────────────── */

describe("the §5.3 match handoff", () => {
  let h: Harness;
  let host: string;

  beforeEach(async () => {
    h = harness();
    host = await identify(h, TOKEN_A, "Ah Ming");
  });

  async function createTable(): Promise<{ joinCode: string; tableId: string; seatToken: string }> {
    const res = await handle(post("/api/tables", {}, TOKEN_A), h.platform);
    expect(res.status).toBe(201);
    return (await res.json()) as { joinCode: string; tableId: string; seatToken: string };
  }

  it("creates a table, archives the ruleset bytes, and seats the host", async () => {
    const body = await createTable();

    expect(h.store.matches).toHaveLength(1);
    const match = h.store.matches[0];
    expect(match.status).toBe("running");
    expect(match.engine_version).toBe("engine-0.1.0-test");
    expect(match.log_schema_version).toBe(1);
    expect(match.rated).toBe(0);
    expect(match.ruleset_id).toBe("hkos-standard");

    /* Rulesets are data: the row archives the bytes this match was played
     * under, and the match points at their hash (schema.sql, rulesets). */
    expect(h.store.rulesets).toHaveLength(1);
    const archived = h.store.rulesets[0];
    expect(archived.hash).toBe(match.ruleset_hash);
    expect(archived.minimum_faan).toBe(3);
    expect(archived.limit_faan).toBe(13);
    expect(archived.self_draw_settlement).toBe("per_player");

    expect(h.store.match_players).toHaveLength(1);
    expect(h.store.match_players[0].player_id).toBe(host);
    expect(h.store.match_players[0].seat).toBe(0);
    /* Seat 0's wind at the first deal is 東, and wind is not seat thereafter. */
    expect(h.store.match_players[0].wind).toBe(0);

    expect(body.joinCode).toHaveLength(8);
    expect(h.tables.opened).toHaveLength(1);
    expect(h.tables.opened[0].matchId).toBe(match.id);
    expect(body.tableId).toBe(`table-${match.id}`);
    expect(body.seatToken).toContain("seat-");
    /* The seat token is the DO's to mint and the DO's to hold — it must never
     * reach D1 (worker/README.md §5). */
    expect(JSON.stringify(h.store)).not.toContain(body.seatToken);
  });

  it("archives a second match under the same ruleset without a second row", async () => {
    await createTable();
    await createTable();
    expect(h.store.matches).toHaveLength(2);
    expect(h.store.rulesets).toHaveLength(1);
  });

  it("seats a second player by code and folds look-alike characters", async () => {
    const { joinCode } = await createTable();
    await identify(h, TOKEN_B, "Ah Fai");

    /* Typed off a screen: Crockford drops I/L/O, so a "1" read as "I" still
     * has to find the table. Inject the confusion the alphabet anticipates. */
    const typed = joinCode.replace(/1/g, "I").replace(/0/g, "O").toLowerCase();
    const res = await handle(post(`/api/tables/${typed}/join`, {}, TOKEN_B), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { seat: number; tableId: string; seatToken: string };
    expect(body.seat).toBe(1);
    expect(h.store.match_players).toHaveLength(2);
    expect(h.tables.seated).toHaveLength(2);
  });

  it("re-joining returns the same seat with a fresh token — the reconnect path", async () => {
    const { joinCode } = await createTable();
    await identify(h, TOKEN_B, "Ah Fai");

    const first = (await (
      await handle(post(`/api/tables/${joinCode}/join`, {}, TOKEN_B), h.platform)
    ).json()) as { seat: number; seatToken: string };
    const second = (await (
      await handle(post(`/api/tables/${joinCode}/join`, {}, TOKEN_B), h.platform)
    ).json()) as { seat: number; seatToken: string };

    expect(second.seat).toBe(first.seat);
    expect(second.seatToken).not.toBe(first.seatToken);
    expect(h.store.match_players).toHaveLength(2);
  });

  it("refuses a fifth player", async () => {
    const { joinCode } = await createTable();
    const match = h.store.matches[0];
    for (const seat of [1, 2, 3]) {
      h.store.match_players.push({
        match_id: match.id, seat, player_id: `BOT${seat}`, wind: seat, final_chips: 0,
        faan_won: 0, place: null, hands_won: 0, self_draws: 0, deal_ins: 0,
        bot_takeover_hands: 0, moves_graded: 0, moves_matched: 0, gap_sum: 0,
        rating_before: null, rating_after: null,
      });
    }
    await identify(h, TOKEN_B, "Ah Fai");
    const res = await handle(post(`/api/tables/${joinCode}/join`, {}, TOKEN_B), h.platform);
    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toEqual({ error: "table_full" });
  });

  it("accepts a percent-encoded code, because a typed code carries spaces", async () => {
    const { joinCode } = await createTable();
    await identify(h, TOKEN_B, "Ah Fai");
    const spaced = encodeURIComponent(`${joinCode.slice(0, 4)} ${joinCode.slice(4)}`);
    const res = await handle(post(`/api/tables/${spaced}/join`, {}, TOKEN_B), h.platform);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { seat: number }).seat).toBe(1);
  });

  it("refuses an unknown or too-short code", async () => {
    expect((await handle(post("/api/tables/ZZZZZZZZ/join", {}, TOKEN_A), h.platform)).status).toBe(404);
    expect((await handle(post("/api/tables/AB/join", {}, TOKEN_A), h.platform)).status).toBe(404);
  });

  it("refuses a ruleset the house does not ship", async () => {
    /* A real variant that is deliberately not a P0 preset (DESIGN.md §5.1
     * keeps the TW module for later), so this asserts the gate rather than a
     * typo. Unknown ruleset ids never reach the rulesets archive. */
    const res = await handle(post("/api/tables", { rulesetId: "taiwanese-16" }, TOKEN_A), h.platform);
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({ error: "unknown_ruleset" });
    expect(h.store.matches).toHaveLength(0);
  });

  it("reports the table as unavailable rather than handing out an unusable seat", async () => {
    h.tables.fail = true;
    /* Silenced, not removed: the handler logs because a 503 with no trace is a
     * 503 nobody can diagnose, and this asserts that it does. */
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handle(post("/api/tables", {}, TOKEN_A), h.platform);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
    expect(res.status).toBe(503);
    /* The match row survives as `running` with no table — idx_matches_running
     * is the ops query that reaps it. The reverse order would strand a live
     * table that nothing points at. */
    expect(h.store.matches).toHaveLength(1);
    expect(h.store.matches[0].status).toBe("running");
  });
});

/* ── the lobby (PVP-LOBBY-PROPOSAL-2026-09-02.md §7) ─────────────────────── */

describe("POST /api/tables — the seat plan", () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await identify(h, TOKEN_A, "Ah Ming");
  });

  it("seats the creator at the first human seat in an explicit plan", async () => {
    const res = await handle(
      post(
        "/api/tables",
        { seats: [{ kind: "bot", bot: "v1" }, { kind: "human" }, { kind: "bot", bot: "v2" }, { kind: "human" }] },
        TOKEN_A,
      ),
      h.platform,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { seat: number };
    expect(body.seat).toBe(1); // seat 0 is a bot in this plan
    expect(h.store.match_players).toHaveLength(1);
    expect(h.store.match_players[0].seat).toBe(1);

    const match = h.store.matches[0];
    expect(match.bot_seats).toBe(2);
    expect(match.created_by).toBe(h.store.match_players[0].player_id);
    expect(JSON.parse(String(match.seat_plan))).toEqual([
      { kind: "bot", bot: "v1" },
      { kind: "human" },
      { kind: "bot", bot: "v2" },
      { kind: "human" },
    ]);

    /* tableInitOf's raw material — the DO resolves it into PlayerRefs. */
    expect(h.tables.opened[0].seatPlan).toEqual([
      { kind: "bot", bot: "v1" },
      { kind: "human" },
      { kind: "bot", bot: "v2" },
      { kind: "human" },
    ]);
  });

  it("still accepts the legacy botSeats/bots shape, converted to a plan", async () => {
    const res = await handle(post("/api/tables", { botSeats: 2, bots: ["v3", "v4"] }, TOKEN_A), h.platform);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { seat: number };
    expect(body.seat).toBe(0); // humans still fill the low seats
    expect(JSON.parse(String(h.store.matches[0].seat_plan))).toEqual([
      { kind: "human" },
      { kind: "human" },
      { kind: "bot", bot: "v3" },
      { kind: "bot", bot: "v4" },
    ]);
  });

  it("defaults access to open, mode to casual, and sets hands_base from matchFormat", async () => {
    await handle(post("/api/tables", { matchFormat: "full" }, TOKEN_A), h.platform);
    const match = h.store.matches[0];
    expect(match.access).toBe("open");
    expect(match.mode).toBe("casual");
    expect(match.hands_base).toBe(16);
    expect(match.rated).toBe(0);
    expect(match.lobby_status).toBe("waiting");
  });

  it("rejects a ranked table with any bot seat, before writing a row", async () => {
    const res = await handle(
      post("/api/tables", { mode: "ranked", seats: [{ kind: "human" }, { kind: "human" }, { kind: "human" }, { kind: "bot" }] }, TOKEN_A),
      h.platform,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({ error: "ranked_needs_humans" });
    expect(h.store.matches).toHaveLength(0);
  });

  it("sets rated on a ranked table with every seat human", async () => {
    const res = await handle(
      post("/api/tables", { mode: "ranked", seats: [{ kind: "human" }, { kind: "human" }, { kind: "human" }, { kind: "human" }] }, TOKEN_A),
      h.platform,
    );
    expect(res.status).toBe(201);
    expect(h.store.matches[0].rated).toBe(1);
    expect(h.store.matches[0].mode).toBe("ranked");
  });

  it("rejects a plan with no human seat at all — nowhere for the creator to sit", async () => {
    const res = await handle(
      post("/api/tables", { seats: [{ kind: "bot" }, { kind: "bot" }, { kind: "bot" }, { kind: "bot" }] }, TOKEN_A),
      h.platform,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({ error: "bad_seats" });
    expect(h.store.matches).toHaveLength(0);
  });

  it("respects access: private — no join code is ever meant to be listed for it", async () => {
    await handle(post("/api/tables", { access: "private" }, TOKEN_A), h.platform);
    expect(h.store.matches[0].access).toBe("private");
  });
});

describe("POST /api/tables — speed default (§8a-2)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await identify(h, TOKEN_A, "Ah Ming");
  });

  it("defaults to untimed for a plan with exactly one human seat", async () => {
    const res = await handle(
      post("/api/tables", { seats: [{ kind: "human" }, { kind: "bot" }, { kind: "bot" }, { kind: "bot" }] }, TOKEN_A),
      h.platform,
    );
    expect((await res.json()) as { speed: string }).toMatchObject({ speed: "untimed" });
    expect(h.store.matches[0].speed).toBe("untimed");
    // The DO's TableInit got it too, not just the D1 row.
    expect(h.tables.opened[0].speed).toBe("untimed");
  });

  it("defaults to normal for a plan with two or more human seats", async () => {
    const res = await handle(
      post("/api/tables", { seats: [{ kind: "human" }, { kind: "human" }, { kind: "bot" }, { kind: "bot" }] }, TOKEN_A),
      h.platform,
    );
    expect((await res.json()) as { speed: string }).toMatchObject({ speed: "normal" });
    expect(h.store.matches[0].speed).toBe("normal");
  });

  it("honours an explicit speed in the request over the human-count default", async () => {
    const res = await handle(
      post("/api/tables", { seats: [{ kind: "human" }, { kind: "bot" }, { kind: "bot" }, { kind: "bot" }], speed: "insane" }, TOKEN_A),
      h.platform,
    );
    expect((await res.json()) as { speed: string }).toMatchObject({ speed: "insane" });
    expect(h.store.matches[0].speed).toBe("insane");
  });

  it("ignores an unrecognised speed and falls back to the default rule", async () => {
    const res = await handle(
      post("/api/tables", { seats: [{ kind: "human" }, { kind: "human" }, { kind: "human" }, { kind: "human" }], speed: "ludicrous" }, TOKEN_A),
      h.platform,
    );
    expect((await res.json()) as { speed: string }).toMatchObject({ speed: "normal" });
  });

  it("a room's fixed speed wins over both the request and the human-count default", async () => {
    const created = await handle(
      post("/api/rooms", { name: "Room", adminCode: "1234", speed: "very-slow" }, TOKEN_A),
      h.platform,
    );
    const { code } = (await created.json()) as { code: string };

    // One human seat would otherwise default to `untimed`, and the request
    // explicitly asks for `insane` — the room's `very-slow` beats both.
    const res = await handle(
      post(
        "/api/tables",
        { roomCode: code, speed: "insane", seats: [{ kind: "human" }, { kind: "bot" }, { kind: "bot" }, { kind: "bot" }] },
        TOKEN_A,
      ),
      h.platform,
    );
    expect((await res.json()) as { speed: string }).toMatchObject({ speed: "very-slow" });
    expect(h.store.matches[0].speed).toBe("very-slow");
  });

  it("a room with no fixed speed still lets postTable's own default rule decide", async () => {
    const created = await handle(post("/api/rooms", { name: "Room", adminCode: "1234" }, TOKEN_A), h.platform);
    const { code } = (await created.json()) as { code: string };

    const res = await handle(
      post("/api/tables", { roomCode: code, seats: [{ kind: "human" }, { kind: "bot" }, { kind: "bot" }, { kind: "bot" }] }, TOKEN_A),
      h.platform,
    );
    expect((await res.json()) as { speed: string }).toMatchObject({ speed: "untimed" });
  });

  it("POST /api/rooms/:code/settings sets, then keeps, the room's fixed speed", async () => {
    const created = await handle(post("/api/rooms", { name: "Room", adminCode: "1234" }, TOKEN_A), h.platform);
    const { code } = (await created.json()) as { code: string };

    const set = await handle(
      postAdmin(`/api/rooms/${code}/settings`, { speed: "faster" }, TOKEN_A, "1234"),
      h.platform,
    );
    expect((await set.json()) as { game: { speed?: string } }).toMatchObject({ game: { speed: "faster" } });

    // Unspecified on a later write keeps the current speed — same tolerance
    // `matchFormat`/`access` already have.
    const unrelated = await handle(
      postAdmin(`/api/rooms/${code}/settings`, { matchFormat: "full" }, TOKEN_A, "1234"),
      h.platform,
    );
    expect((await unrelated.json()) as { game: { speed?: string } }).toMatchObject({ game: { speed: "faster" } });
  });
});

describe("POST /api/tables/:code/join — a bot may be at any seat", () => {
  it("skips a bot seat in the middle of the plan and seats the next human slot", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Ah Ming");
    const created = await handle(
      post(
        "/api/tables",
        { seats: [{ kind: "human" }, { kind: "bot", bot: "v1" }, { kind: "human" }, { kind: "human" }] },
        TOKEN_A,
      ),
      h.platform,
    );
    const { joinCode } = (await created.json()) as { joinCode: string };

    await identify(h, TOKEN_B, "Ah Fai");
    const joined = await handle(post(`/api/tables/${joinCode}/join`, {}, TOKEN_B), h.platform);
    expect(joined.status).toBe(200);
    /* Seat 1 is a bot in this plan — the next human seat is 2, not 1. */
    expect(((await joined.json()) as { seat: number }).seat).toBe(2);
  });
});

describe("GET /api/lobby", () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
  });

  it("returns here (from presence and seated humans), open tables, and recent results", async () => {
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");

    // Alice is just browsing the lobby — a bare heartbeat, no table.
    await handle(post("/api/presence", {}, TOKEN_A), h.platform);

    // Bob is seated at an open, waiting table with one bot seat.
    seedMatch(h, {
      id: "M-WAITING",
      seats: [bob],
      status: "running",
      lobbyStatus: "waiting",
      access: "open",
      seatPlan: JSON.stringify([{ kind: "human" }, { kind: "bot", bot: "v1" }, { kind: "human" }, { kind: "human" }]),
      currentHand: 0,
      handsBase: 4,
    });
    h.store.matches.find((m) => m.id === "M-WAITING")!.join_code = "OPENCODE1";

    // A private table must never leak its join code into the lobby.
    seedMatch(h, {
      id: "M-PRIVATE",
      seats: [],
      status: "running",
      lobbyStatus: "waiting",
      access: "private",
    });
    h.store.matches.find((m) => m.id === "M-PRIVATE")!.join_code = "SECRETCOD";

    // A finished match — shows up in `recent`, not `tables`.
    seedMatch(h, { id: "M-DONE", seats: [alice, bob], status: "complete", lobbyStatus: "done" });
    h.store.match_players.find((r) => r.match_id === "M-DONE" && r.player_id === alice)!.final_chips = 1200;
    h.store.match_players.find((r) => r.match_id === "M-DONE" && r.player_id === alice)!.place = 1;

    const res = await handle(get("/api/lobby", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      here: { playerId: string; state: string; matchId?: string; joinCode?: string | null }[];
      tables: { matchId: string; joinCode: string | null; access: string; seats: unknown[] }[];
      recent: { matchId: string; standings: { displayName: string; chips: number; place: number | null }[] }[];
    };

    const aliceHere = body.here.find((e) => e.playerId === alice);
    expect(aliceHere?.state).toBe("lobby");

    const bobHere = body.here.find((e) => e.playerId === bob);
    expect(bobHere?.state).toBe("waiting");
    expect(bobHere?.matchId).toBe("M-WAITING");
    expect(bobHere?.joinCode).toBe("OPENCODE1");

    expect(body.tables.map((t) => t.matchId).sort()).toEqual(["M-PRIVATE", "M-WAITING"]);
    const openTable = body.tables.find((t) => t.matchId === "M-WAITING")!;
    expect(openTable.joinCode).toBe("OPENCODE1");
    expect(openTable.seats).toHaveLength(4);

    const privateTable = body.tables.find((t) => t.matchId === "M-PRIVATE")!;
    expect(privateTable.joinCode).toBeNull();

    expect(body.recent).toHaveLength(1);
    expect(body.recent[0].matchId).toBe("M-DONE");
    const aliceStanding = body.recent[0].standings.find((s) => s.displayName === "Alice");
    expect(aliceStanding).toEqual({ displayName: "Alice", chips: 1200, place: 1 });
  });

  it("carries each open table's speed (§8a-2)", async () => {
    await identify(h, TOKEN_A, "Alice");
    seedMatch(h, { id: "M-INSANE", seats: [], status: "running", lobbyStatus: "waiting", speed: "insane" });
    seedMatch(h, { id: "M-UNTIMED", seats: [], status: "running", lobbyStatus: "waiting", speed: "untimed" });

    const res = await handle(get("/api/lobby", TOKEN_A), h.platform);
    const body = (await res.json()) as { tables: { matchId: string; speed: string }[] };
    expect(body.tables.find((t) => t.matchId === "M-INSANE")?.speed).toBe("insane");
    expect(body.tables.find((t) => t.matchId === "M-UNTIMED")?.speed).toBe("untimed");
  });

  it("never lets a bot's own match_players row (item 1: bot standings) leak into a table's human seats", async () => {
    // Since ranked settlement (item 1 of the brief), a bot seat gets its own
    // match_players row too — humanSeatsOfMatch must still show ONLY the
    // human seat, or a bot would render as an extra "connected human" in the
    // lobby's open-table view (`getLobby`'s `spec.kind === 'bot'` branch
    // never looks at this query for a bot seat, but the query itself must
    // still hand back nothing for one — belt and braces).
    const bob = await identify(h, TOKEN_A, "Bob");
    h.store.players.push({
      id: "bot:v1", kind: "bot", display_name: "Kwan", bot_policy: "v1",
      rating: null, rating_games: 0, rating_season: null,
      almanac_user_id: null, almanac_link_source: null, almanac_linked_at: null,
      created_at: "x", updated_at: "x", last_seen_at: "x", deleted_at: null,
    });
    seedMatch(h, {
      id: "M-BOTROW",
      seats: [bob],
      status: "running",
      lobbyStatus: "waiting",
      access: "open",
      seatPlan: JSON.stringify([{ kind: "human" }, { kind: "bot", bot: "v1" }, { kind: "human" }, { kind: "human" }]),
    });
    // The bot seat's own match_players row, exactly as claimBotSeat/claimSeat
    // would insert it.
    h.store.match_players.push({
      match_id: "M-BOTROW", seat: 1, player_id: "bot:v1", wind: 1, final_chips: 0,
      faan_won: 0, place: null, hands_won: 0, self_draws: 0, deal_ins: 0,
      bot_takeover_hands: 0, moves_graded: 0, moves_matched: 0, gap_sum: 0,
      rating_before: null, rating_after: null, connected: 0,
    });

    const res = await handle(get("/api/lobby", TOKEN_A), h.platform);
    const body = (await res.json()) as {
      tables: { matchId: string; seats: { seat: number; kind: string; displayName?: string; connected: boolean }[] }[];
    };
    const table = body.tables.find((t) => t.matchId === "M-BOTROW")!;
    expect(table.seats[1]).toMatchObject({ seat: 1, kind: "bot", connected: false });
    expect(table.seats[1].displayName).not.toBe(""); // the seat_plan's bot label, not a blank human row
  });

  it("excludes a presence row older than the 90s window", async () => {
    const alice = await identify(h, TOKEN_A, "Alice");
    h.store.presence.push({ player_id: alice, state: "lobby", seen_at: "2020-01-01T00:00:00.000Z" });
    const res = await handle(get("/api/lobby", TOKEN_A), h.platform);
    const body = (await res.json()) as { here: unknown[] };
    expect(body.here).toHaveLength(0);
  });
});

describe("GET /api/lobby — chat (§8)", () => {
  it("returns the last 50 messages inside the lobby response, oldest first", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");
    h.store.lobby_messages.push(
      { id: 1, player_id: alice, display_name: "Alice", text: "hi all", created_at: "2026-09-02T00:00:01.000Z" },
      { id: 2, player_id: bob, display_name: "Bob", text: "hey", created_at: "2026-09-02T00:00:02.000Z" },
    );

    const res = await handle(get("/api/lobby", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chat: { id: number; playerId: string; displayName: string; text: string; at: string }[];
    };
    expect(body.chat).toEqual([
      { id: 1, playerId: alice, displayName: "Alice", text: "hi all", at: "2026-09-02T00:00:01.000Z" },
      { id: 2, playerId: bob, displayName: "Bob", text: "hey", at: "2026-09-02T00:00:02.000Z" },
    ]);
  });

  it("caps at the last 50, dropping the oldest", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    for (let i = 0; i < 55; i += 1) {
      h.store.lobby_messages.push({
        id: i + 1, player_id: alice, display_name: "Alice", text: `m${i}`,
        created_at: `2026-09-02T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }
    const res = await handle(get("/api/lobby", TOKEN_A), h.platform);
    const body = (await res.json()) as { chat: { text: string }[] };
    expect(body.chat).toHaveLength(50);
    expect(body.chat[0]!.text).toBe("m5");
    expect(body.chat[49]!.text).toBe("m54");
  });
});

describe("POST /api/lobby/chat", () => {
  it("appends a row, readable back through GET /api/lobby, and answers 204", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");

    const res = await handle(post("/api/lobby/chat", { text: "  hello lobby  " }, TOKEN_A), h.platform);
    expect(res.status).toBe(204);
    expect(h.store.lobby_messages).toHaveLength(1);
    expect(h.store.lobby_messages[0]).toMatchObject({
      player_id: alice, display_name: "Alice", text: "hello lobby",
    });

    const lobby = await handle(get("/api/lobby", TOKEN_A), h.platform);
    const body = (await lobby.json()) as { chat: { text: string; displayName: string }[] };
    expect(body.chat).toEqual([{ id: 1, playerId: alice, displayName: "Alice", text: "hello lobby", at: h.store.lobby_messages[0].created_at }]);
  });

  it("refuses empty text and text over 200 characters", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");

    const empty = await handle(post("/api/lobby/chat", { text: "   " }, TOKEN_A), h.platform);
    expect(empty.status).toBe(400);

    const tooLong = await handle(post("/api/lobby/chat", { text: "x".repeat(201) }, TOKEN_A), h.platform);
    expect(tooLong.status).toBe(400);

    const exactly200 = await handle(post("/api/lobby/chat", { text: "y".repeat(200) }, TOKEN_A), h.platform);
    expect(exactly200.status).toBe(204);
  });

  it("rate-limits to one message per 2 seconds per player, off the newest row's created_at", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");

    const first = await handle(post("/api/lobby/chat", { text: "one" }, TOKEN_A), h.platform);
    expect(first.status).toBe(204);

    const second = await handle(post("/api/lobby/chat", { text: "two" }, TOKEN_A), h.platform);
    expect(second.status).toBe(429);
    expect(h.store.lobby_messages).toHaveLength(1);

    // A message more than 2s after the first's own created_at is allowed —
    // simulate that by backdating the stored row rather than the harness
    // clock (postLobbyChat compares against the ROW's created_at, not now()).
    h.store.lobby_messages[0].created_at = "2020-01-01T00:00:00.000Z";
    const third = await handle(post("/api/lobby/chat", { text: "three" }, TOKEN_A), h.platform);
    expect(third.status).toBe(204);
    expect(h.store.lobby_messages).toHaveLength(2);
  });

  it("does not rate-limit across different players", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    await identify(h, TOKEN_B, "Bob");

    const a = await handle(post("/api/lobby/chat", { text: "alice speaks" }, TOKEN_A), h.platform);
    const b = await handle(post("/api/lobby/chat", { text: "bob speaks" }, TOKEN_B), h.platform);
    expect(a.status).toBe(204);
    expect(b.status).toBe(204);
    expect(h.store.lobby_messages).toHaveLength(2);
  });

  it("requires authentication", async () => {
    const h = harness();
    const res = await handle(post("/api/lobby/chat", { text: "hi" }), h.platform);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/presence", () => {
  it("upserts one row per player and answers 204", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");

    const first = await handle(post("/api/presence", { state: "lobby" }, TOKEN_A), h.platform);
    expect(first.status).toBe(204);
    expect(h.store.presence).toHaveLength(1);
    expect(h.store.presence[0].player_id).toBe(alice);
    expect(h.store.presence[0].state).toBe("lobby");

    const second = await handle(post("/api/presence", { state: "away" }, TOKEN_A), h.platform);
    expect(second.status).toBe(204);
    expect(h.store.presence).toHaveLength(1); // upsert, not a second row
    expect(h.store.presence[0].state).toBe("away");
  });
});

describe("POST /api/tables/:id/start and /leave", () => {
  let h: Harness;
  let hostToken: string;

  beforeEach(async () => {
    h = harness();
    hostToken = TOKEN_A;
    await identify(h, hostToken, "Ah Ming");
  });

  it("only the creator may start, and only while a match exists", async () => {
    const created = await handle(post("/api/tables", {}, hostToken), h.platform);
    const { matchUuid } = (await created.json()) as { matchUuid: string };

    await identify(h, TOKEN_B, "Ah Fai");
    const wrongCaller = await handle(post(`/api/tables/${matchUuid}/start`, {}, TOKEN_B), h.platform);
    expect(wrongCaller.status).toBe(404);

    const notFound = await handle(post("/api/tables/NOSUCHMATCH/start", {}, hostToken), h.platform);
    expect(notFound.status).toBe(404);

    const ok = await handle(post(`/api/tables/${matchUuid}/start`, {}, hostToken), h.platform);
    expect(ok.status).toBe(200);
    expect(h.tables.filled).toEqual([`table-${matchUuid}`]);
  });

  it("refuses a second start once lobby_status has moved past waiting", async () => {
    const created = await handle(post("/api/tables", {}, hostToken), h.platform);
    const { matchUuid } = (await created.json()) as { matchUuid: string };
    h.store.matches.find((m) => m.id === matchUuid)!.lobby_status = "playing";

    const res = await handle(post(`/api/tables/${matchUuid}/start`, {}, hostToken), h.platform);
    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toEqual({ error: "already_started" });
    expect(h.tables.filled).toHaveLength(0);
  });

  it("a participant may leave; a non-participant may not", async () => {
    const created = await handle(post("/api/tables", {}, hostToken), h.platform);
    const { matchUuid } = (await created.json()) as { matchUuid: string };

    await identify(h, TOKEN_B, "Stranger");
    const denied = await handle(post(`/api/tables/${matchUuid}/leave`, {}, TOKEN_B), h.platform);
    expect(denied.status).toBe(404);

    const ok = await handle(post(`/api/tables/${matchUuid}/leave`, {}, hostToken), h.platform);
    expect(ok.status).toBe(200);
    const hostId = h.store.match_players[0].player_id;
    expect(h.tables.left).toEqual([{ tableId: `table-${matchUuid}`, playerId: hostId }]);
  });
});

/* ── determinism and configuration ────────────────────────────────────────── */

describe("determinism", () => {
  /**
   * The prototype bug DESIGN.md §5.5 names — an unseeded call making identical
   * inputs diverge — is caught here rather than argued about: two runs of the
   * same request sequence against identically seeded harnesses must produce
   * byte-identical ids, join codes and timestamps. A stray `Date.now()` or
   * `Math.random()` anywhere under `handle` fails this and nothing else.
   */
  async function run(): Promise<string> {
    const h = harness();
    await identify(h, TOKEN_A, "Ah Ming");
    const created = await (await handle(post("/api/tables", {}, TOKEN_A), h.platform)).json();
    await identify(h, TOKEN_B, "Ah Fai");
    const code = (created as { joinCode: string }).joinCode;
    const joined = await (
      await handle(post(`/api/tables/${code}/join`, {}, TOKEN_B), h.platform)
    ).json();
    return JSON.stringify({ created, joined, store: h.store });
  }

  it("produces identical output for identical input", async () => {
    expect(await run()).toBe(await run());
  });
});

describe("platformFromEnv", () => {
  const bindings = {
    DB: new FakeD1(emptyStore()),
    LOGS: new FakeR2(),
    TABLES: new FakeTables(),
  };

  it("fails closed when the engine version is not pinned", () => {
    expect(() => platformFromEnv({ ...bindings, REPLAY_TOKEN_SECRET: SECRET })).toThrow(ConfigError);
  });

  it("fails closed on a weak replay secret", () => {
    expect(() =>
      platformFromEnv({ ...bindings, ENGINE_VERSION: "1.0.0", REPLAY_TOKEN_SECRET: "short" }),
    ).toThrow(ConfigError);
  });

  it("accepts a complete environment", () => {
    const p = platformFromEnv({ ...bindings, ENGINE_VERSION: "1.0.0", REPLAY_TOKEN_SECRET: SECRET });
    expect(p.engineVersion).toBe("1.0.0");
  });
});

describe("routing", () => {
  it("answers an unknown path and a wrong method distinctly", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Ah Ming");
    expect((await handle(get("/api/nope", TOKEN_A), h.platform)).status).toBe(404);
    expect((await handle(post("/api/matches", {}, TOKEN_A), h.platform)).status).toBe(405);
    expect((await handle(get("/api/identity", TOKEN_A), h.platform)).status).toBe(405);
  });
});

/* ── stats and leaderboards (PVP-LOBBY-PROPOSAL-2026-09-02.md §7.2's last two
 * bullets) ───────────────────────────────────────────────────────────────── */

describe("GET /api/stats/me and /api/players/:id/stats", () => {
  it("is all zero/null for a player with no matches, and reads provisional off rating_games", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Ah Ming");
    const res = await handle(get("/api/stats/me", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      player: { displayName: string; rating: number | null; ratingGames: number; provisional: boolean };
      totals: Record<string, unknown>;
      recent: unknown[];
      ratingHistory: unknown[];
    };
    expect(body.player.displayName).toBe("Ah Ming");
    expect(body.player.rating).toBeNull();
    expect(body.player.ratingGames).toBe(0);
    expect(body.player.provisional).toBe(true); // 0 games is under the engine's provisionalMatches
    expect(body.totals).toEqual({
      matches: 0, ranked: 0, casual: 0, wins: 0, places: [0, 0, 0, 0],
      handsWon: 0, selfDraws: 0, dealIns: 0, avgFaan: null, netChips: 0,
      movesGraded: 0, agreement: null,
    });
    expect(body.recent).toEqual([]);
    expect(body.ratingHistory).toEqual([]);
  });

  it("folds a finished match's match_players/hands rows into totals and recent", async () => {
    const h = harness();
    const me = await identify(h, TOKEN_A, "Ah Ming");
    const opp = await identify(h, TOKEN_B, "Opponent");
    seedMatch(h, { id: "m1", seats: [me, opp, "p2", "p3"], mode: "casual" });
    const mine = h.store.match_players.find((r) => r.match_id === "m1" && r.player_id === me)!;
    mine.place = 1;
    mine.final_chips = 400;
    mine.hands_won = 2;
    mine.self_draws = 1;
    mine.moves_graded = 10;
    mine.moves_matched = 8;

    const res = await handle(get("/api/stats/me", TOKEN_A), h.platform);
    const body = (await res.json()) as {
      totals: {
        matches: number; ranked: number; casual: number; wins: number; places: number[];
        handsWon: number; selfDraws: number; avgFaan: number | null; netChips: number;
        movesGraded: number; agreement: number | null;
      };
      recent: { matchId: string; place: number; chips: number; mode: string; ratingDelta: number | null }[];
    };
    expect(body.totals.matches).toBe(1);
    expect(body.totals.casual).toBe(1);
    expect(body.totals.ranked).toBe(0);
    expect(body.totals.wins).toBe(1);
    expect(body.totals.places).toEqual([1, 0, 0, 0]);
    expect(body.totals.handsWon).toBe(2);
    expect(body.totals.selfDraws).toBe(1);
    expect(body.totals.movesGraded).toBe(10);
    expect(body.totals.agreement).toBeCloseTo(0.8);
    // seedMatch's one hand is won by seats[1] (the opponent), so "me" never
    // won a hand in this match — avgFaan has nothing to average.
    expect(body.totals.avgFaan).toBeNull();
    // seedMatch's hand credits seat 1 and debits seat 2; seat 0 ("me") nets 0.
    expect(body.totals.netChips).toBe(0);
    expect(body.recent).toHaveLength(1);
    expect(body.recent[0]).toMatchObject({ matchId: "m1", place: 1, chips: 400, mode: "casual", ratingDelta: null });
  });

  it("reads someone else's stats by id, and 404s an id nobody holds", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Ah Ming");
    const opp = await identify(h, TOKEN_B, "Opponent");

    const res = await handle(get(`/api/players/${opp}/stats`, TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { player: { id: string } };
    expect(body.player.id).toBe(opp);

    const missing = await handle(get("/api/players/nobody-here/stats", TOKEN_A), h.platform);
    expect(missing.status).toBe(404);
  });

  it("surfaces rating history and a rating delta from a rated match", async () => {
    const h = harness();
    const me = await identify(h, TOKEN_A, "Ah Ming");
    seedMatch(h, { id: "m-ranked", seats: [me, "p1", "p2", "p3"], mode: "ranked" });
    const mine = h.store.match_players.find((r) => r.match_id === "m-ranked" && r.player_id === me)!;
    mine.place = 2;
    mine.rating_before = 1500;
    mine.rating_after = 1512;
    h.store.rating_history.push({
      id: 1, player_id: me, match_id: "m-ranked", kind: "match", system: "elo-placement-v1",
      season: "p0-provisional", rating_before: 1500, rating_after: 1512,
      games_played_before: 0, k_factor: 60, place: 2, chip_delta: 10,
      created_at: "2026-09-02T00:00:00.000Z",
    });
    const player = h.store.players.find((r) => r.id === me)!;
    player.rating = 1512;
    player.rating_games = 1;
    player.rating_season = "p0-provisional";

    const res = await handle(get("/api/stats/me", TOKEN_A), h.platform);
    const body = (await res.json()) as {
      player: { rating: number; ratingGames: number };
      recent: { matchId: string; place: number; ratingDelta: number | null }[];
      ratingHistory: { at: string; before: number; after: number; matchId: string | null }[];
    };
    expect(body.player.rating).toBe(1512);
    expect(body.player.ratingGames).toBe(1);
    expect(body.recent[0]).toMatchObject({ matchId: "m-ranked", place: 2, ratingDelta: 12 });
    expect(body.ratingHistory).toHaveLength(1);
    expect(body.ratingHistory[0]).toMatchObject({ before: 1500, after: 1512, matchId: "m-ranked" });
  });
});

describe("GET /api/leaderboard", () => {
  it("ranked: humans with at least 5 ranked matches in scope, ordered by rating desc — bots and under-5 players excluded", async () => {
    const h = harness();
    const a = await identify(h, TOKEN_A, "Ah Ming");
    const b = await identify(h, TOKEN_B, "Opponent");
    const c = await identify(h, TOKEN_C, "Too Few Games");
    // A bot never belongs on a human leaderboard, even seated in enough
    // matches and even with a rating.
    const botId = "bot:v4";
    h.store.players.push({
      id: botId, kind: "bot", display_name: "Sifu", bot_policy: "v4",
      rating: 1700, rating_games: 9, rating_season: "p0-provisional",
      almanac_user_id: null, almanac_link_source: null, almanac_linked_at: null,
      tz_offset_min: 0, created_at: "x", updated_at: "x", last_seen_at: "x", deleted_at: null,
    });

    for (let i = 0; i < 5; i += 1) {
      seedMatch(h, { id: `r${i}`, seats: [a, b, botId, "p3"], mode: "ranked", status: "complete" });
    }
    // c plays only two ranked matches with a — short of §10's 5-game minimum.
    seedMatch(h, { id: "r5", seats: [a, c, "p2", "p3"], mode: "ranked", status: "complete" });
    seedMatch(h, { id: "r6", seats: [a, c, "p2", "p3"], mode: "ranked", status: "complete" });

    const pa = h.store.players.find((r) => r.id === a)!;
    pa.rating = 1600; pa.rating_games = 5; pa.rating_season = "p0-provisional";
    const pb = h.store.players.find((r) => r.id === b)!;
    pb.rating = 1450; pb.rating_games = 5; pb.rating_season = "p0-provisional";

    const res = await handle(get("/api/leaderboard?mode=ranked", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      entries: { playerId: string; displayName: string; games: number; rating: number; ratingGames: number; provisional: boolean }[];
    };
    expect(body.mode).toBe("ranked");
    expect(body.entries.map((e) => e.playerId)).toEqual([a, b]);
    expect(body.entries[0]).toMatchObject({ displayName: "Ah Ming", games: 7, rating: 1600, ratingGames: 5, provisional: true });
  });

  it("casual: humans with at least 5 casual matches, over casual matches only", async () => {
    const h = harness();
    const a = await identify(h, TOKEN_A, "Ah Ming");
    const b = await identify(h, TOKEN_B, "Opponent");
    for (let i = 0; i < 5; i += 1) {
      seedMatch(h, { id: `c${i}`, seats: [a, b, "p2", "p3"], mode: "casual", status: "complete" });
      h.store.match_players.find((r) => r.match_id === `c${i}` && r.player_id === a)!.place = 1;
      h.store.match_players.find((r) => r.match_id === `c${i}` && r.player_id === b)!.place = 4;
    }

    const res = await handle(get("/api/leaderboard?mode=casual", TOKEN_A), h.platform);
    const body = (await res.json()) as {
      mode: string;
      entries: { playerId: string; games: number; placements: number[] }[];
    };
    expect(body.mode).toBe("casual");
    expect(body.entries.map((e) => e.playerId).sort()).toEqual([a, b].sort());
    expect(body.entries.find((e) => e.playerId === a)).toMatchObject({ games: 5, placements: [5, 0, 0, 0] });
    expect(body.entries.find((e) => e.playerId === b)).toMatchObject({ games: 5, placements: [0, 0, 0, 5] });
  });

  it("defaults to ranked when mode is omitted or unrecognised", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Ah Ming");
    const noMode = await handle(get("/api/leaderboard", TOKEN_A), h.platform);
    expect(((await noMode.json()) as { mode: string }).mode).toBe("ranked");
    const badMode = await handle(get("/api/leaderboard?mode=nonsense", TOKEN_A), h.platform);
    expect(((await badMode.json()) as { mode: string }).mode).toBe("ranked");
  });
});

/* ── rooms (PVP-LOBBY-PROPOSAL-2026-09-02.md §8b) ─────────────────────────── */

/** `post()` carries only a bearer token; the admin routes gate on a SEPARATE
 *  header (`x-mjrc-admin-code`), so those tests build the Request by hand. */
const postAdmin = (path: string, body: unknown, token: string, adminCode: string): Request =>
  new Request(`https://game.mahjongresearch.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-mjrc-admin-code": adminCode,
    },
    body: JSON.stringify(body),
  });

describe("POST /api/rooms", () => {
  it("creates a room, joins the creator, and returns a 6-char code — never storing the admin code in the clear", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");

    const res = await handle(
      post("/api/rooms", { name: "Tuesday Night", matchFormat: "full", adminCode: "1234" }, TOKEN_A),
      h.platform,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string };
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);

    /* Every player is also a member of the Open Hall (§11 build decision 2),
     * created lazily by `identify()` above — one extra room, unrelated to
     * this one, found by its own code rather than assumed at index 0. */
    expect(h.store.rooms).toHaveLength(2);
    const room = h.store.rooms.find((r) => r.code === body.code)!;
    expect(room.code).toBe(body.code);
    expect(JSON.parse(String(room.settings))).toEqual({
      game: { rulesetId: "hkos-standard", matchFormat: "full", access: "open" },
    });
    expect(JSON.stringify(h.store)).not.toContain("1234");

    expect(h.store.room_players.filter((r) => r.room_code === body.code)).toEqual([
      { room_code: body.code, player_id: alice, name: "Alice", seed_rating: null, archived_at: null },
    ]);
  });

  it("refuses an unknown ruleset and a missing admin code, before writing a row", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");

    const badRuleset = await handle(post("/api/rooms", { name: "Room", rulesetId: "nope", adminCode: "1234" }, TOKEN_A), h.platform);
    expect(badRuleset.status).toBe(400);

    const noAdminCode = await handle(post("/api/rooms", { name: "Room" }, TOKEN_A), h.platform);
    expect(noAdminCode.status).toBe(400);

    /* Only the Open Hall (§11 build decision 2), from `identify()` above. */
    expect(h.store.rooms).toHaveLength(1);
    expect(h.store.rooms[0]!.code).toBe(OPEN_ROOM_CODE);
  });
});

describe("POST /api/rooms/:code/join", () => {
  it("adds membership, idempotently", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const created = await handle(post("/api/rooms", { name: "Room", adminCode: "1234" }, TOKEN_A), h.platform);
    const { code } = (await created.json()) as { code: string };

    await identify(h, TOKEN_B, "Bob");
    const joined = await handle(post(`/api/rooms/${code}/join`, {}, TOKEN_B), h.platform);
    expect(joined.status).toBe(200);
    expect(h.store.room_players.filter((r) => r.room_code === code)).toHaveLength(2);

    // A repeat join is a no-op, not a second row or an error.
    const again = await handle(post(`/api/rooms/${code}/join`, {}, TOKEN_B), h.platform);
    expect(again.status).toBe(200);
    expect(h.store.room_players.filter((r) => r.room_code === code)).toHaveLength(2);
  });

  it("404s for an unknown room code", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const res = await handle(post("/api/rooms/ZZZZZZ/join", {}, TOKEN_A), h.platform);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/rooms/mine and GET /api/rooms/:code", () => {
  it("GET /api/rooms/mine lists only the caller's rooms", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const createdA = await handle(post("/api/rooms", { name: "Alice's Room", adminCode: "1111" }, TOKEN_A), h.platform);
    const { code: codeA } = (await createdA.json()) as { code: string };
    await identify(h, TOKEN_B, "Bob");
    await handle(post("/api/rooms", { name: "Bob's Room", adminCode: "2222" }, TOKEN_B), h.platform);

    const res = await handle(get("/api/rooms/mine", TOKEN_A), h.platform);
    const body = (await res.json()) as { rooms: { code: string; name: string }[] };
    /* The Open Hall (§11 build decision 2) is pinned first — every player
     * belongs to it, and it is not "Alice's Room" or "Bob's Room". */
    expect(body.rooms.map((r) => r.code)).toEqual([OPEN_ROOM_CODE, codeA]);
  });

  it("GET /api/rooms/:code returns the room's game settings, member count, and its open tables", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const created = await handle(
      post("/api/rooms", { name: "Room", matchFormat: "east", adminCode: "1234" }, TOKEN_A),
      h.platform,
    );
    const { code } = (await created.json()) as { code: string };
    await identify(h, TOKEN_B, "Bob");
    await handle(post(`/api/rooms/${code}/join`, {}, TOKEN_B), h.platform);

    seedMatch(h, {
      id: "M-ROOM", seats: [alice], status: "running", lobbyStatus: "waiting", access: "open", roomCode: code,
    });

    const res = await handle(get(`/api/rooms/${code}`, TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: string;
      name: string;
      game: { rulesetId: string; matchFormat: string; access: string };
      memberCount: number;
      tables: { matchId: string; roomCode: string | null }[];
    };
    expect(body.code).toBe(code);
    expect(body.game).toEqual({ rulesetId: "hkos-standard", matchFormat: "east", access: "open" });
    expect(body.memberCount).toBe(2); // Alice (creator) + Bob
    expect(body.tables.map((t) => t.matchId)).toEqual(["M-ROOM"]);
    expect(body.tables[0].roomCode).toBe(code);
  });

  it("404s for an unknown room code", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const res = await handle(get("/api/rooms/ZZZZZZ", TOKEN_A), h.platform);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/rooms/:code/settings", () => {
  it("needs the room's own admin code — wrong or missing both refuse, the right one applies", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const created = await handle(
      post("/api/rooms", { name: "Room", matchFormat: "east", adminCode: "8899" }, TOKEN_A),
      h.platform,
    );
    const { code } = (await created.json()) as { code: string };

    const noHeader = await handle(post(`/api/rooms/${code}/settings`, { matchFormat: "full" }, TOKEN_A), h.platform);
    expect(noHeader.status).toBe(401);

    const roomRow = () => h.store.rooms.find((r) => r.code === code)!;

    const wrongCode = await handle(postAdmin(`/api/rooms/${code}/settings`, { matchFormat: "full" }, TOKEN_A, "0000"), h.platform);
    expect(wrongCode.status).toBe(401);
    expect(JSON.parse(String(roomRow().settings)).game.matchFormat).toBe("east"); // unchanged

    const rightCode = await handle(postAdmin(`/api/rooms/${code}/settings`, { matchFormat: "full" }, TOKEN_A, "8899"), h.platform);
    expect(rightCode.status).toBe(200);
    const body = (await rightCode.json()) as { game: { matchFormat: string; rulesetId: string; access: string } };
    expect(body.game.matchFormat).toBe("full");
    // rulesetId/access, unspecified in this request, are carried over.
    expect(body.game.rulesetId).toBe("hkos-standard");
    expect(body.game.access).toBe("open");
    expect(JSON.parse(String(roomRow().settings)).game.matchFormat).toBe("full");
  });

  it("preserves the Almanac's own settings keys — the game touches only `game`", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const now = "2026-09-02T00:00:00.000Z";
    h.store.rooms.push({
      code: "PHYS9K", name: "Physical Room", password_hash: null, password_attempts: 0,
      password_locked_until: null,
      settings: JSON.stringify({ purpose: "friend night", notes: "bring snacks" }),
      admin_code_hash: await sha256Hex("5150"),
      created_at: now, updated_at: now,
    });

    const res = await handle(
      postAdmin("/api/rooms/PHYS9K/settings", { rulesetId: "hkos-standard", matchFormat: "east" }, TOKEN_A, "5150"),
      h.platform,
    );
    expect(res.status).toBe(200);
    const settings = JSON.parse(String(h.store.rooms.find((r) => r.code === "PHYS9K")!.settings));
    expect(settings.purpose).toBe("friend night");
    expect(settings.notes).toBe("bring snacks");
    expect(settings.game).toEqual({ rulesetId: "hkos-standard", matchFormat: "east", access: "open" });
  });
});

describe("POST /api/tables — rooms (§8b)", () => {
  it("takes rulesetId/matchFormat from the room, ignoring the request's, and lets an explicit access override the room's default", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const created = await handle(
      post("/api/rooms", { name: "Room", matchFormat: "full", access: "private", adminCode: "1234" }, TOKEN_A),
      h.platform,
    );
    const { code } = (await created.json()) as { code: string };

    const res = await handle(
      post("/api/tables", { roomCode: code, matchFormat: "east", access: "open" }, TOKEN_A),
      h.platform,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { matchFormat: string; access: string; roomCode: string | null };
    expect(body.matchFormat).toBe("full"); // the room's, not the request's "east"
    expect(body.roomCode).toBe(code);
    expect(body.access).toBe("open"); // explicit in the request, overriding the room's "private" default

    const match = h.store.matches[0];
    expect(match.room_code).toBe(code);
    expect(match.hands_base).toBe(16);
  });

  it("defaults access from the room when the request omits it", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const created = await handle(
      post("/api/rooms", { name: "Room", access: "private", adminCode: "1234" }, TOKEN_A),
      h.platform,
    );
    const { code } = (await created.json()) as { code: string };

    await handle(post("/api/tables", { roomCode: code }, TOKEN_A), h.platform);
    expect(h.store.matches[0].access).toBe("private");
  });

  it("refuses a caller who is not a room member, before writing a row", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const created = await handle(post("/api/rooms", { name: "Room", adminCode: "1234" }, TOKEN_A), h.platform);
    const { code } = (await created.json()) as { code: string };

    await identify(h, TOKEN_B, "Bob");
    const res = await handle(post("/api/tables", { roomCode: code }, TOKEN_B), h.platform);
    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toEqual({ error: "not_room_member" });
    expect(h.store.matches).toHaveLength(0);
  });

  it("404s for an unknown room code", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const res = await handle(post("/api/tables", { roomCode: "ZZZZZZ" }, TOKEN_A), h.platform);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/lobby — room scoping (§8b)", () => {
  it("?room=CODE scopes here, tables, recent, and chat to the room's own rows", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");
    await identify(h, TOKEN_C, "Carol");
    const created = await handle(post("/api/rooms", { name: "Room", adminCode: "1234" }, TOKEN_A), h.platform);
    const { code } = (await created.json()) as { code: string };
    await handle(post(`/api/rooms/${code}/join`, {}, TOKEN_B), h.platform);
    // Carol never joins — her heartbeat must not leak into the room's `here`.

    await handle(post("/api/presence", {}, TOKEN_A), h.platform);
    await handle(post("/api/presence", {}, TOKEN_B), h.platform);
    await handle(post("/api/presence", {}, TOKEN_C), h.platform);

    seedMatch(h, { id: "M-IN-ROOM", seats: [], status: "running", lobbyStatus: "waiting", access: "open", roomCode: code });
    seedMatch(h, { id: "M-GLOBAL", seats: [], status: "running", lobbyStatus: "waiting", access: "open" });
    seedMatch(h, { id: "M-DONE-ROOM", seats: [alice], status: "complete", lobbyStatus: "done", roomCode: code });
    seedMatch(h, { id: "M-DONE-GLOBAL", seats: [alice], status: "complete", lobbyStatus: "done" });

    await handle(post("/api/lobby/chat", { text: "room chat", roomCode: code }, TOKEN_A), h.platform);
    await handle(post("/api/lobby/chat", { text: "global chat" }, TOKEN_B), h.platform);

    const res = await handle(get(`/api/lobby?room=${code}`, TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      here: { playerId: string }[];
      tables: { matchId: string }[];
      recent: { matchId: string }[];
      chat: { text: string }[];
    };

    expect(body.here.map((e) => e.playerId).sort()).toEqual([alice, bob].sort());
    expect(body.tables.map((t) => t.matchId)).toEqual(["M-IN-ROOM"]);
    expect(body.recent.map((r) => r.matchId)).toEqual(["M-DONE-ROOM"]);
    expect(body.chat.map((c) => c.text)).toEqual(["room chat"]);
  });

  it("404s for an unknown room code", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const res = await handle(get("/api/lobby?room=ZZZZZZ", TOKEN_A), h.platform);
    expect(res.status).toBe(404);
  });

  it("without room, excludes room-scoped tables/recent/chat, but tags a room-seated player in the global here", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");
    const created = await handle(post("/api/rooms", { name: "Room", adminCode: "1234" }, TOKEN_A), h.platform);
    const { code } = (await created.json()) as { code: string };

    seedMatch(h, { id: "M-IN-ROOM", seats: [bob], status: "running", lobbyStatus: "waiting", access: "open", roomCode: code });
    seedMatch(h, { id: "M-GLOBAL", seats: [], status: "running", lobbyStatus: "waiting", access: "open" });
    seedMatch(h, { id: "M-DONE-ROOM", seats: [alice], status: "complete", lobbyStatus: "done", roomCode: code });

    await handle(post("/api/lobby/chat", { text: "room chat", roomCode: code }, TOKEN_A), h.platform);
    await handle(post("/api/lobby/chat", { text: "global chat" }, TOKEN_B), h.platform);

    const res = await handle(get("/api/lobby", TOKEN_A), h.platform);
    const body = (await res.json()) as {
      here: { playerId: string; matchId?: string; roomCode?: string }[];
      tables: { matchId: string }[];
      recent: { matchId: string }[];
      chat: { text: string }[];
    };

    expect(body.tables.map((t) => t.matchId)).toEqual(["M-GLOBAL"]);
    expect(body.recent.map((r) => r.matchId)).toEqual([]);
    expect(body.chat.map((c) => c.text)).toEqual(["global chat"]);

    const bobHere = body.here.find((e) => e.playerId === bob);
    expect(bobHere).toMatchObject({ matchId: "M-IN-ROOM", roomCode: code });
  });
});

describe("POST /api/rooms/:code/tables/:matchId/close", () => {
  it("admin-only: abandons a waiting table without touching the DO", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const created = await handle(post("/api/rooms", { name: "Room", adminCode: "1234" }, TOKEN_A), h.platform);
    const { code } = (await created.json()) as { code: string };
    seedMatch(h, {
      id: "M-WAITING", seats: [alice], status: "running", lobbyStatus: "waiting", access: "open", roomCode: code,
    });

    const noHeader = await handle(post(`/api/rooms/${code}/tables/M-WAITING/close`, {}, TOKEN_A), h.platform);
    expect(noHeader.status).toBe(401);

    const res = await handle(postAdmin(`/api/rooms/${code}/tables/M-WAITING/close`, {}, TOKEN_A, "1234"), h.platform);
    expect(res.status).toBe(200);
    const match = h.store.matches.find((m) => m.id === "M-WAITING")!;
    expect(match.status).toBe("abandoned");
    expect(match.lobby_status).toBe("done");
    expect(h.tables.filled).toEqual([]);
    expect(h.tables.left).toEqual([]);
  });

  it("refuses a table that already started or belongs to a different room", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const created = await handle(post("/api/rooms", { name: "Room", adminCode: "1234" }, TOKEN_A), h.platform);
    const { code } = (await created.json()) as { code: string };
    seedMatch(h, {
      id: "M-PLAYING", seats: [alice], status: "running", lobbyStatus: "playing", access: "open", roomCode: code,
    });
    seedMatch(h, {
      id: "M-OTHER-ROOM", seats: [alice], status: "running", lobbyStatus: "waiting", access: "open", roomCode: "OTHRRM",
    });

    const started = await handle(postAdmin(`/api/rooms/${code}/tables/M-PLAYING/close`, {}, TOKEN_A, "1234"), h.platform);
    expect(started.status).toBe(409);

    const wrongRoom = await handle(postAdmin(`/api/rooms/${code}/tables/M-OTHER-ROOM/close`, {}, TOKEN_A, "1234"), h.platform);
    expect(wrongRoom.status).toBe(404);
  });
});

/* ── §10: stats datasets ──────────────────────────────────────────────────── */

describe("stats scope parsing — shared by /api/stats/*", () => {
  it("rejects an unknown style, ruleset, since, lastN or source with 400", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const cases = [
      "/api/stats/record?style=tw",
      "/api/stats/record?rulesetId=nope",
      "/api/stats/record?since=not-a-date",
      "/api/stats/record?lastN=0",
      "/api/stats/record?lastN=abc",
      "/api/stats/record?source=weird",
    ];
    for (const path of cases) {
      const res = await handle(get(path, TOKEN_A), h.platform);
      expect(res.status, path).toBe(400);
    }
  });

  it("style=hk and an absent style both pass", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    expect((await handle(get("/api/stats/record?style=hk", TOKEN_A), h.platform)).status).toBe(200);
    expect((await handle(get("/api/stats/record", TOKEN_A), h.platform)).status).toBe(200);
  });

  it("source all/offline echo a sourceNote until the Almanac link exists; online does not", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const online = (await (await handle(get("/api/stats/record", TOKEN_A), h.platform)).json()) as Record<string, unknown>;
    expect(online.sourceNote).toBeUndefined();
    for (const source of ["all", "offline"]) {
      const body = (await (
        await handle(get(`/api/stats/record?source=${source}`, TOKEN_A), h.platform)
      ).json()) as Record<string, unknown>;
      expect(body.sourceNote).toBe("almanac_link_missing");
    }
  });
});

/**
 * One match, two hands, built by hand rather than through `seedMatch` (whose
 * single fixed hand cannot exercise worth/INS/feeds' need for two DIFFERENT
 * winners) — every number below is hand-computed in the comment next to the
 * assertion it feeds, so a change to the arithmetic has to be deliberate.
 *
 * Seats: 0 = alice (the caller throughout), 1 = bob, 2 = carol, 3 = dave.
 *   Hand 0: alice wins off bob's discard, 5 faan, awards allPungs(3) + seatWind(2).
 *           deltas [+30, -30, 0, 0]. round_wind 0.
 *   Hand 1: bob wins off alice's discard, 3 faan, award commonHand(3).
 *           deltas [-16, +16, 0, 0]. round_wind 0.
 */
function seedWorthFixture(h: Harness, matchId: string, seats: [string, string, string, string]): void {
  h.store.matches.push({
    id: matchId, status: "complete", match_format: "east", ruleset_hash: "hash-hkos",
    ruleset_id: "hkos-standard", engine_version: "engine-0.1.0-test", log_schema_version: 1,
    room_code: null, join_code: null, rated: 0, bot_seats: 0, hand_count: 2,
    log_key: null, log_bytes: null, log_sha256: null,
    started_at: "2026-08-20T10:00:00.000Z", ended_at: "2026-08-20T10:30:00.000Z",
    access: "open", mode: "casual", lobby_status: "done", current_hand: 2, hands_base: 4,
    seat_plan: JSON.stringify([{ kind: "human" }, { kind: "human" }, { kind: "human" }, { kind: "human" }]),
    randomize_seats: 0, created_by: seats[0], speed: "normal",
  });
  const winsBySeat = [1, 1, 0, 0];
  const dealInsBySeat = [1, 1, 0, 0];
  seats.forEach((playerId, seat) => {
    h.store.match_players.push({
      match_id: matchId, seat, player_id: playerId, wind: seat, final_chips: seat === 0 ? 14 : seat === 1 ? -14 : 0,
      faan_won: seat === 0 ? 5 : seat === 1 ? 3 : 0, place: seat === 0 ? 1 : seat === 1 ? 2 : seat === 2 ? 3 : 4,
      hands_won: winsBySeat[seat], self_draws: 0, deal_ins: dealInsBySeat[seat],
      bot_takeover_hands: 0, moves_graded: 0, moves_matched: 0, gap_sum: 0,
      rating_before: null, rating_after: null, connected: 0,
    });
  });
  h.store.hands.push({
    match_id: matchId, hand_index: 0, dealer_seat: 0, round_wind: 0, dealer_repeat: 0, seed: 1,
    outcome: "win", winner_seat: 0, winner_player_id: seats[0], win_from_seat: 1, win_from_player_id: seats[1],
    winning_tile: 5, self_draw: 0, robbed_kong: 0, on_kong_replacement: 0, faan: 5, raw_faan: 5, capped: 0,
    awards: JSON.stringify([{ id: "allPungs", faan: 3 }, { id: "seatWind", faan: 2 }]),
    delta_seat0: 30, delta_seat1: -30, delta_seat2: 0, delta_seat3: 0, refused_wins: 0,
    wall_remaining: 40, event_count: 60, log_seq_start: 0, log_seq_end: 59,
    started_at: "2026-08-20T10:00:00.000Z", ended_at: "2026-08-20T10:10:00.000Z",
  });
  h.store.hands.push({
    match_id: matchId, hand_index: 1, dealer_seat: 1, round_wind: 0, dealer_repeat: 0, seed: 2,
    outcome: "win", winner_seat: 1, winner_player_id: seats[1], win_from_seat: 0, win_from_player_id: seats[0],
    winning_tile: 9, self_draw: 0, robbed_kong: 0, on_kong_replacement: 0, faan: 3, raw_faan: 3, capped: 0,
    awards: JSON.stringify([{ id: "commonHand", faan: 3 }]),
    delta_seat0: -16, delta_seat1: 16, delta_seat2: 0, delta_seat3: 0, refused_wins: 0,
    wall_remaining: 20, event_count: 50, log_seq_start: 60, log_seq_end: 109,
    started_at: "2026-08-20T10:10:00.000Z", ended_at: "2026-08-20T10:20:00.000Z",
  });
}

describe("GET /api/stats/record — Dataset A arithmetic", () => {
  it("games, hands, wins, ins, pts, netPerHand, worthPerHand and avgWinFan match the hand-computed fixture", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");
    const carol = await identify(h, TOKEN_C, "Carol");
    seedWorthFixture(h, "M1", [alice, bob, carol, "DAVE0000000000P3"]);

    const res = await handle(get("/api/stats/record", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      players: {
        playerId: string; games: number; hands: number; wins: number; winPct: number;
        ins: number; inPct: number; handsW: number; handsL: number; ptsW: number; ptsL: number;
        netPerHand: number; worthPerHand: number; avgWinFan: number; placements: number[];
      }[];
    };
    expect(body.players).toHaveLength(1);
    const row = body.players[0]!;
    expect(row.playerId).toBe(alice);
    expect(row.games).toBe(1);
    expect(row.hands).toBe(2);
    expect(row.wins).toBe(1);
    expect(row.winPct).toBeCloseTo(0.5);
    expect(row.ins).toBe(1); // alice dealt into bob's hand 1
    expect(row.inPct).toBeCloseTo(0.5);
    expect(row.handsW).toBe(1);
    expect(row.handsL).toBe(1); // 2 hands with a winner, alice won 1
    expect(row.ptsW).toBe(30); // hand 0's +30
    expect(row.ptsL).toBe(16); // hand 1's -16, absolute
    expect(row.netPerHand).toBeCloseTo((30 - 16) / 2); // = 7
    // worth = (net/hands) / avg(winner's own delta across the match's wins)
    // avg winning value = (30 + 16) / 2 = 23; net/hands = 14/2 = 7
    expect(row.worthPerHand).toBeCloseTo(7 / 23, 10);
    expect(row.avgWinFan).toBe(5); // alice's one win was 5 faan
    expect(row.placements).toEqual([1, 0, 0, 0]);
  });

  it("players=leaderboard reuses the leaderboard candidate set and sort", async () => {
    const h = harness();
    const a = await identify(h, TOKEN_A, "Alice");
    const b = await identify(h, TOKEN_B, "Bob");
    for (let i = 0; i < 5; i += 1) {
      seedMatch(h, { id: `lb${i}`, seats: [a, b, "p2", "p3"], mode: "casual", status: "complete" });
    }
    const res = await handle(get("/api/stats/record?players=leaderboard&mode=casual", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { players: { playerId: string; games: number }[] };
    expect(body.players.map((r) => r.playerId).sort()).toEqual([a, b].sort());
    for (const r of body.players) expect(r.games).toBe(5);
  });

  it("scopes to a different player via ?player=, and 404s for one that does not exist", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");
    seedWorthFixture(h, "M1", [alice, bob, "carol0000000000", "dave000000000P3"]);

    const res = await handle(get(`/api/stats/record?player=${bob}`, TOKEN_A), h.platform);
    const body = (await res.json()) as { players: { playerId: string }[] };
    expect(body.players[0]!.playerId).toBe(bob);

    const missing = await handle(get("/api/stats/record?player=NOSUCHPLAYER0000", TOKEN_A), h.platform);
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/stats/histograms — Dataset B arithmetic", () => {
  it("fan histogram, handType, outcomes, per-opponent ins and feeds match the fixture", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");
    const carol = await identify(h, TOKEN_C, "Carol");
    const dave = await identify(h, "DAVE0000000000000000000000000000", "Dave");
    seedWorthFixture(h, "M1", [alice, bob, carol, dave]);

    const res = await handle(get("/api/stats/histograms", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fan: { byRuleset: Record<string, number[]> };
      fanByGame: number[][];
      handType: { id: string; count: number; avgFan: number; points: number }[];
      seatByRound: number[][];
      outcomes: { win: number; selfDraw: number; draw: number };
      ins: { playerId: string; ins: number; hands: number }[];
      feeds: { from: { playerId: string; points: number; hands: number }[]; to: { playerId: string; points: number; hands: number }[] };
    };

    // alice's only win (hand 0) was 5 faan — bucket index 5 of 14.
    expect(body.fan.byRuleset["hkos-standard"]![5]).toBe(1);
    expect(body.fan.byRuleset["hkos-standard"]!.reduce((a, b) => a + b, 0)).toBe(1);
    expect(body.fanByGame).toEqual([body.fan.byRuleset["hkos-standard"]]);

    const byId = new Map(body.handType.map((t) => [t.id, t]));
    expect(byId.get("allPungs")).toMatchObject({ count: 1, avgFan: 3, points: 30 });
    expect(byId.get("seatWind")).toMatchObject({ count: 1, avgFan: 2, points: 30 });
    expect(byId.has("commonHand")).toBe(false); // that award belongs to bob's win, not alice's

    // Both hands in the match had a winner; neither was a self-draw.
    expect(body.outcomes).toEqual({ win: 2, selfDraw: 0, draw: 0 });

    expect(body.seatByRound[0]).toEqual([1, 0, 0, 0]); // alice's seat 0, round wind 0, one win

    const insBob = body.ins.find((r) => r.playerId === bob)!;
    expect(insBob).toMatchObject({ ins: 1, hands: 2 }); // alice fed bob once, over 2 hands played together
    for (const other of [carol, dave]) {
      expect(body.ins.find((r) => r.playerId === other)).toMatchObject({ ins: 0, hands: 2 });
    }

    // alice won 30 off bob's discard (hand 0); alice paid bob 16 (hand 1).
    expect(body.feeds.from).toEqual([{ playerId: bob, displayName: "Bob", points: 30, hands: 1 }]);
    expect(body.feeds.to).toEqual([{ playerId: bob, displayName: "Bob", points: 16, hands: 1 }]);
  });
});

describe("GET /api/stats/series — Dataset C arithmetic", () => {
  it("progressionAvg and worthByGame fold the same fixture's two hands", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");
    seedWorthFixture(h, "M1", [alice, bob, "carol0000000000", "dave000000000P3"]);

    const res = await handle(get("/api/stats/series", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      progressionAvg: { hands: number[]; mean: number[]; games: number[][] };
      worthByGame: { matchId: string; at: string; worth: number }[];
      rating: unknown[];
      activity: { day: string; games: number }[];
    };

    expect(body.progressionAvg.games).toEqual([[30, 14]]); // cumulative after each hand
    expect(body.progressionAvg.hands).toEqual([0, 1]);
    expect(body.progressionAvg.mean).toEqual([30, 14]); // one game, so mean === it

    expect(body.worthByGame).toHaveLength(1);
    expect(body.worthByGame[0]!.matchId).toBe("M1");
    expect(body.worthByGame[0]!.worth).toBeCloseTo(7 / 23, 10);

    expect(body.rating).toEqual([]);
    expect(body.activity.reduce((sum, d) => sum + d.games, 0)).toBe(1);
    expect(body.activity.some((d) => d.day === "2026-08-20")).toBe(true);
  });
});

describe("GET /api/games/:id — progression, grading, and the /api/matches/:id alias", () => {
  it("adds per-seat cumulative progression and the caller's own grading", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");
    seedWorthFixture(h, "M1", [alice, bob, "carol0000000000", "dave000000000P3"]);
    h.store.match_players.find((r) => r.match_id === "M1" && r.player_id === alice)!.moves_graded = 4;
    h.store.match_players.find((r) => r.match_id === "M1" && r.player_id === alice)!.moves_matched = 3;

    const viaGames = await handle(get("/api/games/M1", TOKEN_A), h.platform);
    expect(viaGames.status).toBe(200);
    const body = (await viaGames.json()) as {
      progression: number[][];
      grading: { movesGraded: number; movesMatched: number; agreement: number } | null;
    };
    expect(body.progression[0]).toEqual([30, 14]); // alice, seat 0
    expect(body.progression[1]).toEqual([-30, -14]); // bob, seat 1
    expect(body.progression[2]).toEqual([0, 0]);
    expect(body.grading).toMatchObject({ movesGraded: 4, movesMatched: 3 });
    expect(body.grading!.agreement).toBeCloseTo(0.75);

    const viaMatches = await handle(get("/api/matches/M1", TOKEN_A), h.platform);
    expect(viaMatches.status).toBe(200);
    expect(await viaMatches.json()).toEqual(await (await handle(get("/api/games/M1", TOKEN_A), h.platform)).json());
  });
});

/* ── friends (§11 build decision 1) ──────────────────────────────────────── */

describe("GET /api/friends and star/unstar", () => {
  it("lists everyone the caller has finished a match with, online first, then starred", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");
    const carol = await identify(h, TOKEN_C, "Carol");
    seedMatch(h, { id: "M1", seats: [alice, bob, "p2", "p3"], status: "complete" });
    seedMatch(h, { id: "M2", seats: [alice, carol, "p2", "p3"], status: "complete" });
    // A running (not complete) match together does not make them friends yet.
    const dave = await identify(h, "DAVE0000000000000000000000000000", "Dave");
    seedMatch(h, { id: "M3", seats: [alice, dave, "p2", "p3"], status: "running" });

    const res1 = await handle(get("/api/friends", TOKEN_A), h.platform);
    const body1 = (await res1.json()) as { friends: { playerId: string; starred: boolean; state: string }[] };
    expect(body1.friends.map((f) => f.playerId).sort()).toEqual([bob, carol].sort());
    expect(body1.friends.every((f) => f.starred === false)).toBe(true);

    const star = await handle(post(`/api/friends/${carol}/star`, {}, TOKEN_A), h.platform);
    expect(star.status).toBe(204);
    const res2 = await handle(get("/api/friends", TOKEN_A), h.platform);
    const body2 = (await res2.json()) as { friends: { playerId: string; starred: boolean }[] };
    expect(body2.friends.find((f) => f.playerId === carol)!.starred).toBe(true);

    const unstar = await handle(post(`/api/friends/${carol}/unstar`, {}, TOKEN_A), h.platform);
    expect(unstar.status).toBe(204);
    const res3 = await handle(get("/api/friends", TOKEN_A), h.platform);
    const body3 = (await res3.json()) as { friends: { playerId: string; starred: boolean }[] };
    expect(body3.friends.find((f) => f.playerId === carol)!.starred).toBe(false);
  });
});

/* ── direct messages and the inbox (§8) ───────────────────────────────────── */

describe("GET/POST /api/dm/:playerId", () => {
  it("round-trips a thread, marks it read on GET, and rate-limits at 1 per 2s", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");

    const send1 = await handle(post(`/api/dm/${bob}`, { text: "gg" }, TOKEN_A), h.platform);
    expect(send1.status).toBe(204);
    const tooSoon = await handle(post(`/api/dm/${bob}`, { text: "again" }, TOKEN_A), h.platform);
    expect(tooSoon.status).toBe(429);

    const thread = await handle(get(`/api/dm/${alice}`, TOKEN_B), h.platform);
    expect(thread.status).toBe(200);
    const body = (await thread.json()) as { messages: { text: string; fromPlayerId: string; read: boolean }[] };
    expect(body.messages).toEqual([{ id: 1, fromPlayerId: alice, toPlayerId: bob, text: "gg", at: expect.any(String), read: true }]);

    const overLong = await handle(post(`/api/dm/${bob}`, { text: "x".repeat(501) }, TOKEN_A), h.platform);
    expect(overLong.status).toBe(400);

    const toUnknown = await handle(post("/api/dm/NOSUCHPLAYER0000", { text: "hi" }, TOKEN_A), h.platform);
    expect(toUnknown.status).toBe(404);
  });
});

describe("inbox: invite, room notice, result, and dismiss", () => {
  it("an invite is accepted through the normal join path and then disappears from the inbox", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");

    const created = await handle(post("/api/tables", { seats: [{ kind: "human" }, { kind: "human" }, { kind: "bot" }, { kind: "bot" }] }, TOKEN_A), h.platform);
    const { matchUuid } = (await created.json()) as { matchUuid: string };

    const invited = await handle(post(`/api/tables/${matchUuid}/invite`, { playerId: bob }, TOKEN_A), h.platform);
    expect(invited.status).toBe(201);
    const { id } = (await invited.json()) as { id: string };

    const inbox = await handle(get("/api/inbox", TOKEN_B), h.platform);
    const inboxBody = (await inbox.json()) as { unread: number; items: { id: string; kind: string }[] };
    expect(inboxBody.unread).toBeGreaterThanOrEqual(1);
    expect(inboxBody.items.some((it) => it.id === id && it.kind === "invite")).toBe(true);

    const accepted = await handle(post(`/api/inbox/${id}/accept`, {}, TOKEN_B), h.platform);
    expect(accepted.status).toBe(200);
    const handoff = (await accepted.json()) as { matchUuid: string; seat: number };
    expect(handoff.matchUuid).toBe(matchUuid);
    expect(h.store.match_players.some((r) => r.match_id === matchUuid && r.player_id === bob)).toBe(true);

    const after = await handle(get("/api/inbox", TOKEN_B), h.platform);
    const afterBody = (await after.json()) as { items: { id: string }[] };
    expect(afterBody.items.some((it) => it.id === id)).toBe(false);
  });

  it("a table opened in a real room notifies the room's other members, never the Open Hall", async () => {
    const h = harness();
    const alice = await identify(h, TOKEN_A, "Alice");
    const created = await handle(post("/api/rooms", { name: "Tuesday", adminCode: "1234" }, TOKEN_A), h.platform);
    const { code } = (await created.json()) as { code: string };
    const bob = await identify(h, TOKEN_B, "Bob");
    await handle(post(`/api/rooms/${code}/join`, {}, TOKEN_B), h.platform);

    await handle(post("/api/tables", { roomCode: code }, TOKEN_A), h.platform);

    const inbox = await handle(get("/api/inbox", TOKEN_B), h.platform);
    const body = (await inbox.json()) as { items: { kind: string; roomCode: string | null }[] };
    expect(body.items.some((it) => it.kind === "room" && it.roomCode === code)).toBe(true);

    // Alice is a member of the Open Hall too (every player is), but a
    // room-less table must never spam it.
    await handle(post("/api/tables", {}, TOKEN_B), h.platform);
    const aliceInbox = await handle(get("/api/inbox", TOKEN_A), h.platform);
    const aliceBody = (await aliceInbox.json()) as { items: { kind: string }[] };
    expect(aliceBody.items.some((it) => it.kind === "room")).toBe(false);
  });

  it("dismiss removes any kind of item and is idempotent", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const bob = await identify(h, TOKEN_B, "Bob");
    const created = await handle(post("/api/tables", { seats: [{ kind: "human" }, { kind: "human" }, { kind: "bot" }, { kind: "bot" }] }, TOKEN_A), h.platform);
    const { matchUuid } = (await created.json()) as { matchUuid: string };
    const invited = await handle(post(`/api/tables/${matchUuid}/invite`, { playerId: bob }, TOKEN_A), h.platform);
    const { id } = (await invited.json()) as { id: string };

    const first = await handle(post(`/api/inbox/${id}/dismiss`, {}, TOKEN_B), h.platform);
    expect(first.status).toBe(204);
    const second = await handle(post(`/api/inbox/${id}/dismiss`, {}, TOKEN_B), h.platform);
    expect(second.status).toBe(404);
  });
});

/* ── the Open Hall (§11.2) ────────────────────────────────────────────────── */

describe("the Open Hall", () => {
  it("a table created with no roomCode lands in OPEN, and 'open'/'OPEN' both resolve to it", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const res = await handle(post("/api/tables", {}, TOKEN_A), h.platform);
    const body = (await res.json()) as { roomCode: string | null };
    expect(body.roomCode).toBe(OPEN_ROOM_CODE);

    const viaLower = await handle(get("/api/rooms/open", TOKEN_A), h.platform);
    expect(viaLower.status).toBe(200);
    expect(((await viaLower.json()) as { code: string }).code).toBe(OPEN_ROOM_CODE);
  });

  it("GET /api/lobby?room=OPEN lists the room-less table", async () => {
    const h = harness();
    await identify(h, TOKEN_A, "Alice");
    const created = await handle(post("/api/tables", {}, TOKEN_A), h.platform);
    const { matchUuid } = (await created.json()) as { matchUuid: string };

    const res = await handle(get("/api/lobby?room=OPEN", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tables: { matchId: string }[] };
    expect(body.tables.map((t) => t.matchId)).toContain(matchUuid);
  });
});


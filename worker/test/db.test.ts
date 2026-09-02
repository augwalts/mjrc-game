/**
 * Platform-services tests — the routes of ../src/index.ts and the query helpers
 * of ../src/db.ts, driven end to end against an in-memory fake of the small D1
 * and R2 surface those files declare. DESIGN.md §5.4, §5.3, §2.
 *
 * The fake dispatches on the exported `SQL` constants rather than parsing SQL,
 * which buys two things a mock object would not:
 *
 *  - a NEW query cannot silently no-op. An unregistered statement throws, so
 *    adding a read to a handler without teaching the fake about it fails loudly
 *    instead of returning an empty result the assertions happen to tolerate.
 *  - every call checks that the number of bound values equals the number of `?`
 *    placeholders. A statement that grew a parameter and a call site that did
 *    not is the exact bug that string-concatenated SQL exists to hide.
 *
 * What the route tests are actually for: the two properties that are security
 * properties rather than features — the public replay link works with no
 * credential at all, and every other match-scoped route refuses a caller who is
 * not in the match.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HKOS_STANDARD } from "@mjrc/rulesets";
import type {
  D1AllResult,
  D1Like,
  D1RunResult,
  D1Statement,
  R2Like,
  R2ObjectLike,
  SqlValue,
} from "../src/db.js";
import { SQL, canonicalJson, rulesetHash, sha256Hex } from "../src/db.js";
import type { Platform, SeatClaim, TableId, TableNamespace, TableSpec, TableStub } from "../src/index.js";
import { ConfigError, handle, mintReplayToken, platformFromEnv, verifyReplayToken } from "../src/index.js";

/* ── in-memory D1 ─────────────────────────────────────────────────────────── */

type Row = Record<string, SqlValue>;

interface Store {
  players: Row[];
  player_credentials: Row[];
  rulesets: Row[];
  matches: Row[];
  match_players: Row[];
  hands: Row[];
  presence: Row[];
  lobby_messages: Row[];
  rating_history: Row[];
  rooms: Row[];
  room_players: Row[];
}

const emptyStore = (): Store => ({
  players: [],
  player_credentials: [],
  rulesets: [],
  matches: [],
  match_players: [],
  hands: [],
  presence: [],
  lobby_messages: [],
  rating_history: [],
  rooms: [],
  room_players: [],
});

type Handler = (s: Store, a: SqlValue[]) => { rows: Row[]; changes: number };

const rows = (r: Row[]): { rows: Row[]; changes: number } => ({ rows: r, changes: 0 });
const wrote = (n: number): { rows: Row[]; changes: number } => ({ rows: [], changes: n });

const pick = (r: Row, keys: readonly string[]): Row => {
  const out: Row = {};
  for (const k of keys) out[k] = r[k] ?? null;
  return out;
};

const MATCH_COLUMNS = [
  "id", "status", "match_format", "ruleset_hash", "ruleset_id", "engine_version",
  "log_schema_version", "room_code", "join_code", "rated", "bot_seats", "hand_count",
  "log_key", "log_bytes", "log_sha256", "started_at", "ended_at",
  "access", "mode", "lobby_status", "current_hand", "hands_base", "seat_plan",
  "randomize_seats", "created_by",
] as const;

const HANDLERS = new Map<string, Handler>([
  [SQL.playerForCredential, (s, [id]) => {
    const cred = s.player_credentials.find((c) => c.id === id && c.revoked_at === null);
    if (cred === undefined) return rows([]);
    const player = s.players.find((p) => p.id === cred.player_id && p.deleted_at === null);
    return rows(player === undefined ? [] : [pick(player, ["id", "kind", "display_name", "rating", "rating_games", "rating_season"])]);
  }],

  [SQL.insertPlayer, (s, [id, kind, display_name, created_at, updated_at, last_seen_at]) => {
    s.players.push({
      id, kind, display_name, bot_policy: null, rating: null, rating_games: 0,
      rating_season: null, almanac_user_id: null, almanac_link_source: null,
      almanac_linked_at: null, created_at, updated_at, last_seen_at, deleted_at: null,
    });
    return wrote(1);
  }],

  [SQL.insertCredential, (s, [id, player_id, kind, label, created_at, last_used_at]) => {
    s.player_credentials.push({
      id, player_id, kind, label, public_key: null, sign_count: 0,
      created_at, last_used_at, revoked_at: null,
    });
    return wrote(1);
  }],

  [SQL.touchCredential, (s, [now, id]) => {
    const c = s.player_credentials.find((r) => r.id === id);
    if (c === undefined) return wrote(0);
    c.last_used_at = now;
    return wrote(1);
  }],

  [SQL.touchPlayer, (s, [seen, updated, id]) => {
    const p = s.players.find((r) => r.id === id);
    if (p === undefined) return wrote(0);
    p.last_seen_at = seen;
    p.updated_at = updated;
    return wrote(1);
  }],

  [SQL.renamePlayer, (s, [name, updated, seen, id]) => {
    const p = s.players.find((r) => r.id === id);
    if (p === undefined) return wrote(0);
    p.display_name = name;
    p.updated_at = updated;
    p.last_seen_at = seen;
    return wrote(1);
  }],

  [SQL.archiveRuleset, (s, a) => {
    if (s.rulesets.some((r) => r.hash === a[0])) return wrote(0); // OR IGNORE
    s.rulesets.push({
      hash: a[0], ruleset_id: a[1], label: a[2], minimum_faan: a[3], limit_faan: a[4],
      payment_id: a[5], self_draw_settlement: a[6], use_flowers: a[7], config: a[8],
      first_seen_at: a[9],
    });
    return wrote(1);
  }],

  [SQL.insertMatch, (s, a) => {
    s.matches.push({
      id: a[0], status: a[1], match_format: a[2], ruleset_hash: a[3], ruleset_id: a[4],
      engine_version: a[5], log_schema_version: a[6], room_code: a[7], join_code: a[8],
      rated: a[9], bot_seats: a[10], hand_count: 0, log_key: null, log_bytes: null,
      log_sha256: null, started_at: a[11], ended_at: null,
      access: a[12], mode: a[13], lobby_status: a[14], current_hand: 0,
      hands_base: a[15], seat_plan: a[16], randomize_seats: a[17], created_by: a[18],
    });
    return wrote(1);
  }],

  [SQL.matchById, (s, [id]) => {
    const m = s.matches.find((r) => r.id === id);
    return rows(m === undefined ? [] : [pick(m, MATCH_COLUMNS)]);
  }],

  [SQL.matchLogById, (s, [id]) => {
    const m = s.matches.find((r) => r.id === id);
    return rows(m === undefined ? [] : [pick(m, ["id", "status", "log_key"])]);
  }],

  [SQL.matchByJoinCode, (s, [code]) => {
    const m = s.matches.find((r) => r.status === "running" && r.join_code === code);
    return rows(m === undefined ? [] : [pick(m, MATCH_COLUMNS)]);
  }],

  [SQL.matchesForPlayer, (s, [playerId, limit]) =>
    rows(matchPage(s, playerId, null, Number(limit)))],

  [SQL.matchesForPlayerBefore, (s, [playerId, before, limit]) =>
    rows(matchPage(s, playerId, String(before), Number(limit)))],

  [SQL.seatOf, (s, [matchId, playerId]) => {
    const mp = s.match_players.find((r) => r.match_id === matchId && r.player_id === playerId);
    return rows(mp === undefined ? [] : [{ seat: mp.seat }]);
  }],

  [SQL.seatsOfMatch, (s, [matchId]) => {
    const seats = s.match_players
      .filter((r) => r.match_id === matchId)
      .sort((a, b) => Number(a.seat) - Number(b.seat));
    return rows(seats.map((mp) => {
      const p = s.players.find((r) => r.id === mp.player_id);
      return {
        ...pick(mp, ["seat", "player_id", "wind", "final_chips", "faan_won", "place",
          "hands_won", "self_draws", "deal_ins", "bot_takeover_hands",
          "moves_graded", "moves_matched", "gap_sum",
          "rating_before", "rating_after"]),
        display_name: p === undefined ? "" : p.display_name,
        kind: p === undefined ? "human" : p.kind,
      };
    }));
  }],

  [SQL.claimSeat, (s, [matchId, seat, playerId, wind]) => {
    // PRIMARY KEY (match_id, seat) and UNIQUE (match_id, player_id), both ignored.
    const clash = s.match_players.some(
      (r) => r.match_id === matchId && (r.seat === seat || r.player_id === playerId),
    );
    if (clash) return wrote(0);
    s.match_players.push({
      match_id: matchId, seat, player_id: playerId, wind, final_chips: 0, faan_won: 0,
      place: null, hands_won: 0, self_draws: 0, deal_ins: 0, bot_takeover_hands: 0,
      moves_graded: 0, moves_matched: 0, gap_sum: 0,
      rating_before: null, rating_after: null, connected: 0,
    });
    return wrote(1);
  }],

  [SQL.handsOfMatch, (s, [matchId]) =>
    rows(s.hands.filter((h) => h.match_id === matchId)
      .sort((a, b) => Number(a.hand_index) - Number(b.hand_index)))],

  /* ── the lobby ────────────────────────────────────────────────────────── */

  [SQL.upsertPresence, (s, [playerId, state, seenAt]) => {
    const existing = s.presence.find((r) => r.player_id === playerId);
    if (existing) {
      existing.state = state;
      existing.seen_at = seenAt;
    } else {
      s.presence.push({ player_id: playerId, state, seen_at: seenAt });
    }
    return wrote(1);
  }],

  [SQL.presenceSince, (s, [since]) =>
    rows(
      s.presence
        .filter((r) => String(r.seen_at) >= String(since))
        .map((r) => {
          const p = s.players.find((row) => row.id === r.player_id && row.deleted_at === null);
          return p === undefined ? null : ({ ...r, display_name: p.display_name } as Row);
        })
        .filter((r): r is Row => r !== null),
    )],

  [SQL.presenceInRoom, (s, [roomCode, since]) =>
    rows(
      s.presence
        .filter((r) => String(r.seen_at) >= String(since))
        .filter((r) =>
          s.room_players.some(
            (rp) => rp.room_code === roomCode && rp.player_id === r.player_id && rp.archived_at === null,
          ))
        .map((r) => {
          const p = s.players.find((row) => row.id === r.player_id && row.deleted_at === null);
          return p === undefined ? null : ({ ...r, display_name: p.display_name } as Row);
        })
        .filter((r): r is Row => r !== null),
    )],

  [SQL.matchesWaitingOrPlaying, (s, [limit]) =>
    rows(
      s.matches
        .filter((m) => m.lobby_status === "waiting" || m.lobby_status === "playing")
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
        .slice(0, Number(limit))
        .map((m) => pick(m, [
          "id", "match_format", "ruleset_id", "access", "mode", "lobby_status",
          "current_hand", "hands_base", "seat_plan", "bot_seats", "created_by",
          "started_at", "join_code", "room_code",
        ])),
    )],

  [SQL.matchesWaitingOrPlayingInRoom, (s, [roomCode, limit]) =>
    rows(
      s.matches
        .filter((m) => (m.lobby_status === "waiting" || m.lobby_status === "playing") && m.room_code === roomCode)
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
        .slice(0, Number(limit))
        .map((m) => pick(m, [
          "id", "match_format", "ruleset_id", "access", "mode", "lobby_status",
          "current_hand", "hands_base", "seat_plan", "bot_seats", "created_by",
          "started_at", "join_code", "room_code",
        ])),
    )],

  [SQL.matchesDone, (s, [limit]) =>
    rows(
      s.matches
        .filter((m) => m.lobby_status === "done" && m.room_code === null)
        .sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)))
        .slice(0, Number(limit))
        .map((m) => pick(m, ["id", "mode", "ended_at"])),
    )],

  [SQL.matchesDoneInRoom, (s, [roomCode, limit]) =>
    rows(
      s.matches
        .filter((m) => m.lobby_status === "done" && m.room_code === roomCode)
        .sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)))
        .slice(0, Number(limit))
        .map((m) => pick(m, ["id", "mode", "ended_at"])),
    )],

  [SQL.humanSeatsOfMatch, (s, [matchId]) => {
    const seats = s.match_players
      .filter((r) => r.match_id === matchId)
      .filter((mp) => s.players.find((r) => r.id === mp.player_id)?.kind === "human")
      .sort((a, b) => Number(a.seat) - Number(b.seat));
    return rows(seats.map((mp) => {
      const p = s.players.find((r) => r.id === mp.player_id);
      return {
        seat: mp.seat,
        player_id: mp.player_id,
        display_name: p === undefined ? "" : p.display_name,
        connected: mp.connected ?? 0,
      };
    }));
  }],

  /* ── lobby chat (§8) ──────────────────────────────────────────────────── */

  [SQL.insertLobbyMessage, (s, [playerId, displayName, text, roomCode, createdAt]) => {
    const id = s.lobby_messages.reduce((max, r) => Math.max(max, Number(r.id)), 0) + 1;
    s.lobby_messages.push({
      id, player_id: playerId, display_name: displayName, text, room_code: roomCode, created_at: createdAt,
    });
    return wrote(1);
  }],

  [SQL.lastLobbyMessageForPlayer, (s, [playerId]) => {
    const mine = s.lobby_messages
      .filter((r) => r.player_id === playerId)
      .sort((a, b) => Number(b.id) - Number(a.id));
    return rows(mine.length === 0 ? [] : [pick(mine[0], ["created_at"])]);
  }],

  [SQL.recentLobbyMessages, (s, [limit]) =>
    rows(
      s.lobby_messages
        .filter((r) => (r.room_code ?? null) === null)
        .slice()
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, Number(limit))
        .map((r) => pick(r, ["id", "player_id", "display_name", "text", "created_at"])),
    )],

  [SQL.recentLobbyMessagesInRoom, (s, [roomCode, limit]) =>
    rows(
      s.lobby_messages
        .filter((r) => r.room_code === roomCode)
        .slice()
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, Number(limit))
        .map((r) => pick(r, ["id", "player_id", "display_name", "text", "created_at"])),
    )],

  /* ── stats and leaderboards ────────────────────────────────────────────── */

  [SQL.playerById, (s, [id]) => {
    const p = s.players.find((r) => r.id === id && r.deleted_at === null);
    return rows(p === undefined ? [] : [pick(p, ["id", "kind", "display_name", "rating", "rating_games", "rating_season"])]);
  }],

  [SQL.statsTotalsForPlayer, (s, [playerId]) => {
    const joined = s.match_players
      .filter((mp) => mp.player_id === playerId)
      .map((mp) => ({ mp, m: s.matches.find((r) => r.id === mp.match_id) }))
      .filter((j): j is { mp: Row; m: Row } => j.m !== undefined && j.m.status === "complete");
    const n = joined.length;
    const cnt = (pred: (j: (typeof joined)[number]) => boolean): number | null =>
      n === 0 ? null : joined.filter(pred).length;
    const sumField = (field: string): number | null =>
      n === 0 ? null : joined.reduce((acc, j) => acc + Number(j.mp[field] ?? 0), 0);
    return rows([{
      matches: n,
      ranked: cnt((j) => j.m.mode === "ranked"),
      casual: cnt((j) => j.m.mode === "casual"),
      place1: cnt((j) => Number(j.mp.place) === 1),
      place2: cnt((j) => Number(j.mp.place) === 2),
      place3: cnt((j) => Number(j.mp.place) === 3),
      place4: cnt((j) => Number(j.mp.place) === 4),
      hands_won: sumField("hands_won"),
      self_draws: sumField("self_draws"),
      deal_ins: sumField("deal_ins"),
      moves_graded: sumField("moves_graded"),
      moves_matched: sumField("moves_matched"),
    }]);
  }],

  [SQL.avgFaanForPlayer, (s, [playerId]) => {
    const won = s.hands.filter((h) => h.winner_player_id === playerId);
    const n = won.length;
    const avg = n === 0 ? null : won.reduce((acc, h) => acc + Number(h.faan), 0) / n;
    return rows([{ avg_faan: avg, n }]);
  }],

  [SQL.netChipsForPlayer, (s, [playerId]) => {
    const seatsFor = s.match_players.filter((mp) => mp.player_id === playerId);
    let sum: number | null = null;
    for (const mp of seatsFor) {
      for (const h of s.hands.filter((r) => r.match_id === mp.match_id)) {
        const col = `delta_seat${mp.seat}`;
        sum = (sum ?? 0) + Number(h[col] ?? 0);
      }
    }
    return rows([{ net_chips: sum }]);
  }],

  [SQL.recentMatchesForPlayer, (s, [playerId, limit]) => {
    const joined = s.match_players
      .filter((mp) => mp.player_id === playerId)
      .map((mp) => ({ mp, m: s.matches.find((r) => r.id === mp.match_id) }))
      .filter((j): j is { mp: Row; m: Row } => j.m !== undefined && j.m.status === "complete")
      .sort((a, b) => String(b.m.ended_at).localeCompare(String(a.m.ended_at)))
      .slice(0, Number(limit));
    return rows(joined.map((j) => ({
      match_id: j.m.id,
      ended_at: j.m.ended_at,
      mode: j.m.mode,
      place: j.mp.place,
      final_chips: j.mp.final_chips,
      rating_before: j.mp.rating_before,
      rating_after: j.mp.rating_after,
    })));
  }],

  [SQL.ratingHistoryForPlayer, (s, [playerId, limit]) => {
    const list = s.rating_history
      .filter((r) => r.player_id === playerId)
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, Number(limit));
    return rows(list.map((r) => ({
      at: r.created_at, before: r.rating_before, after: r.rating_after, match_id: r.match_id,
    })));
  }],

  [SQL.leaderboardRanked, (s, [season, limit]) => {
    const list = s.players
      .filter((p) =>
        p.kind === "human" && p.deleted_at === null &&
        p.rating_season === season && Number(p.rating_games) >= 1,
      )
      .sort((a, b) => Number(b.rating) - Number(a.rating))
      .slice(0, Number(limit));
    return rows(list.map((p) => pick(p, ["id", "display_name", "rating", "rating_games"])));
  }],

  [SQL.leaderboardCasual, (s, [limit]) => {
    const byPlayer = new Map<string, { p: Row; rs: { mp: Row; m: Row }[] }>();
    for (const mp of s.match_players) {
      const m = s.matches.find((r) => r.id === mp.match_id);
      if (m === undefined || m.mode !== "casual" || m.status !== "complete") continue;
      const p = s.players.find((r) => r.id === mp.player_id);
      if (p === undefined || p.kind !== "human" || p.deleted_at !== null) continue;
      const key = String(p.id);
      const entry = byPlayer.get(key) ?? { p, rs: [] };
      entry.rs.push({ mp, m });
      byPlayer.set(key, entry);
    }
    const list = [...byPlayer.values()]
      .map(({ p, rs }) => ({
        player_id: p.id,
        display_name: p.display_name,
        matches: rs.length,
        wins: rs.filter((r) => Number(r.mp.place) === 1).length,
        place1: rs.filter((r) => Number(r.mp.place) === 1).length,
        place2: rs.filter((r) => Number(r.mp.place) === 2).length,
        place3: rs.filter((r) => Number(r.mp.place) === 3).length,
        place4: rs.filter((r) => Number(r.mp.place) === 4).length,
        moves_graded: rs.reduce((acc, r) => acc + Number(r.mp.moves_graded ?? 0), 0),
        moves_matched: rs.reduce((acc, r) => acc + Number(r.mp.moves_matched ?? 0), 0),
      }))
      .sort((a, b) => b.wins - a.wins || b.matches - a.matches)
      .slice(0, Number(limit));
    return rows(list);
  }],

  /* ── rooms (§8b) ────────────────────────────────────────────────────────── */

  [SQL.roomByCode, (s, [code]) => {
    const r = s.rooms.find((row) => row.code === code);
    return rows(r === undefined ? [] : [pick(r, ["code", "name", "settings", "admin_code_hash", "created_at", "updated_at"])]);
  }],

  // Bind order matches SQL.insertRoom exactly: `password_hash`/`password_attempts`
  // are literal NULL/0 in the statement itself, not placeholders — see db.ts.
  [SQL.insertRoom, (s, [code, name, settings, adminCodeHash, createdAt, updatedAt]) => {
    if (s.rooms.some((r) => r.code === code)) return wrote(0);
    s.rooms.push({
      code, name, password_hash: null, password_attempts: 0,
      password_locked_until: null, settings, admin_code_hash: adminCodeHash,
      created_at: createdAt, updated_at: updatedAt,
    });
    return wrote(1);
  }],

  [SQL.updateRoomSettings, (s, [settings, updatedAt, code]) => {
    const r = s.rooms.find((row) => row.code === code);
    if (r === undefined) return wrote(0);
    r.settings = settings;
    r.updated_at = updatedAt;
    return wrote(1);
  }],

  [SQL.insertRoomPlayer, (s, [roomCode, playerId, name]) => {
    if (s.room_players.some((r) => r.room_code === roomCode && r.player_id === playerId)) return wrote(0);
    s.room_players.push({ room_code: roomCode, player_id: playerId, name, seed_rating: null, archived_at: null });
    return wrote(1);
  }],

  [SQL.roomMember, (s, [roomCode, playerId]) => {
    const present = s.room_players.some(
      (r) => r.room_code === roomCode && r.player_id === playerId && r.archived_at === null,
    );
    return rows(present ? [{ present: 1 }] : []);
  }],

  [SQL.roomMemberCount, (s, [roomCode]) =>
    rows([{ n: s.room_players.filter((r) => r.room_code === roomCode && r.archived_at === null).length }])],

  [SQL.roomsForPlayer, (s, [playerId]) => {
    const mine = s.room_players
      .filter((rp) => rp.player_id === playerId && rp.archived_at === null)
      .map((rp) => s.rooms.find((r) => r.code === rp.room_code))
      .filter((r): r is Row => r !== undefined)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return rows(mine.map((r) => pick(r, ["code", "name", "settings", "admin_code_hash", "created_at", "updated_at"])));
  }],

  [SQL.abandonWaitingMatch, (s, [endedAt, matchId]) => {
    const m = s.matches.find((r) => r.id === matchId && r.lobby_status === "waiting");
    if (m === undefined) return wrote(0);
    m.status = "abandoned";
    m.lobby_status = "done";
    m.ended_at = endedAt;
    return wrote(1);
  }],
]);

function matchPage(s: Store, playerId: SqlValue, before: string | null, limit: number): Row[] {
  return s.match_players
    .filter((mp) => mp.player_id === playerId)
    .map((mp) => ({ mp, m: s.matches.find((r) => r.id === mp.match_id) }))
    .filter((j): j is { mp: Row; m: Row } => j.m !== undefined)
    .filter((j) => before === null || String(j.m.started_at) < before)
    .sort((a, b) => String(b.m.started_at).localeCompare(String(a.m.started_at)))
    .slice(0, limit)
    .map((j) => ({
      ...pick(j.m, ["id", "status", "match_format", "ruleset_id", "rated", "bot_seats",
        "hand_count", "room_code", "join_code", "log_key", "started_at", "ended_at"]),
      ...pick(j.mp, ["seat", "place", "final_chips", "faan_won", "rating_before", "rating_after"]),
    }));
}

class FakeStatement implements D1Statement {
  private args: SqlValue[] = [];

  constructor(
    private readonly store: Store,
    private readonly sql: string,
    private readonly placeholders: number,
  ) {}

  bind(...values: SqlValue[]): D1Statement {
    this.args = values;
    return this;
  }

  private exec(): { rows: Row[]; changes: number } {
    const handler = HANDLERS.get(this.sql);
    if (handler === undefined) throw new Error(`fake D1: unregistered statement\n${this.sql}`);
    if (this.args.length !== this.placeholders) {
      throw new Error(
        `fake D1: bound ${this.args.length} values for ${this.placeholders} placeholders\n${this.sql}`,
      );
    }
    return handler(this.store, this.args);
  }

  async first<T>(): Promise<T | null> {
    const { rows: r } = this.exec();
    return r.length === 0 ? null : (r[0] as T);
  }

  async all<T>(): Promise<D1AllResult<T>> {
    return { results: this.exec().rows as T[], success: true };
  }

  async run(): Promise<D1RunResult> {
    return { success: true, meta: { changes: this.exec().changes } };
  }
}

class FakeD1 implements D1Like {
  constructor(readonly store: Store) {}
  prepare(sql: string): D1Statement {
    return new FakeStatement(this.store, sql, (sql.match(/\?/g) ?? []).length);
  }
}

/* ── in-memory R2 ─────────────────────────────────────────────────────────── */

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

class FakeR2 implements R2Like {
  readonly gets: string[] = [];
  private readonly blobs = new Map<string, Uint8Array>();

  put(key: string, text: string): void {
    this.blobs.set(key, new TextEncoder().encode(text));
  }

  async get(key: string): Promise<R2ObjectLike | null> {
    this.gets.push(key);
    const bytes = this.blobs.get(key);
    if (bytes === undefined) return null;
    return { body: streamOf(bytes), size: bytes.length, httpEtag: `"${key}"` };
  }
}

/* ── the Table DO seam ────────────────────────────────────────────────────── */

class FakeTables implements TableNamespace {
  readonly opened: TableSpec[] = [];
  readonly seated: SeatClaim[] = [];
  readonly filled: string[] = [];
  readonly left: { tableId: string; playerId: string }[] = [];
  fail = false;
  private counter = 0;

  idFromName(name: string): TableId {
    return { toString: () => `table-${name}` };
  }

  get(id: TableId): TableStub {
    const ns = this;
    return {
      async openTable(spec: TableSpec): Promise<void> {
        if (ns.fail) throw new Error("table unavailable");
        ns.opened.push(spec);
      },
      async issueSeatToken(claim: SeatClaim): Promise<{ seatToken: string; expiresAt: string }> {
        if (ns.fail) throw new Error("table unavailable");
        ns.seated.push(claim);
        ns.counter += 1;
        return {
          seatToken: `seat-${id.toString()}-${claim.seat}-${ns.counter}`,
          expiresAt: "2026-08-26T00:01:00.000Z",
        };
      },
      async fill(): Promise<void> {
        if (ns.fail) throw new Error("table unavailable");
        ns.filled.push(id.toString());
      },
      async leave(playerId: string): Promise<void> {
        if (ns.fail) throw new Error("table unavailable");
        ns.left.push({ tableId: id.toString(), playerId });
      },
    };
  }
}

/* ── platform ─────────────────────────────────────────────────────────────── */

const SECRET = "test-replay-secret-that-is-long-enough";

interface Harness {
  platform: Platform;
  store: Store;
  logs: FakeR2;
  tables: FakeTables;
}

/**
 * Time and randomness are counters. Nothing in this service may reach for
 * `Date.now` or `Math.random` — the prototype bug DESIGN.md §5.5 names is
 * exactly an unseeded call making two identical inputs diverge — and a harness
 * whose ids are predictable is what lets the determinism test below assert it.
 */
function harness(): Harness {
  const store = emptyStore();
  const logs = new FakeR2();
  const tables = new FakeTables();
  let tick = 0;
  let byte = 0;
  return {
    store,
    logs,
    tables,
    platform: {
      db: new FakeD1(store),
      logs,
      tables,
      now: () => {
        tick += 1;
        return `2026-08-26T00:00:${String(tick).padStart(2, "0")}.000Z`;
      },
      random: (n) => {
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i += 1) {
          byte = (byte + 7) % 251;
          out[i] = byte;
        }
        return out;
      },
      engineVersion: "engine-0.1.0-test",
      replayTokenSecret: SECRET,
    },
  };
}

const TOKEN_A = "0123456789abcdefghijklmnopqrstuvwxyzABCD";
const TOKEN_B = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxw";
const TOKEN_C = "1111222233334444555566667777888899990000";

const get = (path: string, token?: string): Request =>
  new Request(`https://game.mahjongresearch.com${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

const post = (path: string, body: unknown, token?: string): Request =>
  new Request(`https://game.mahjongresearch.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

async function identify(h: Harness, token: string, displayName: string): Promise<string> {
  const res = await handle(post("/api/identity", { deviceToken: token, displayName }), h.platform);
  const body = (await res.json()) as { playerId: string };
  return body.playerId;
}

/** A finished match with one hand, seated by whoever is passed. */
function seedMatch(
  h: Harness,
  opts: {
    id: string;
    seats: string[];
    status?: string;
    logKey?: string | null;
    startedAt?: string;
    lobbyStatus?: string;
    access?: string;
    mode?: string;
    seatPlan?: string;
    createdBy?: string | null;
    currentHand?: number;
    handsBase?: number;
    roomCode?: string | null;
  },
): void {
  const status = opts.status ?? "complete";
  const logKey = opts.logKey === undefined ? `logs/${opts.id}.json` : opts.logKey;
  h.store.matches.push({
    id: opts.id,
    status,
    match_format: "east",
    ruleset_hash: "hash-hkos",
    ruleset_id: "hkos-standard",
    engine_version: "engine-0.1.0-test",
    log_schema_version: 1,
    room_code: opts.roomCode ?? null,
    join_code: null,
    rated: 0,
    bot_seats: 0,
    hand_count: 1,
    log_key: logKey,
    log_bytes: 128,
    log_sha256: null,
    started_at: opts.startedAt ?? "2026-08-20T10:00:00.000Z",
    ended_at: status === "running" ? null : "2026-08-20T10:30:00.000Z",
    access: opts.access ?? "open",
    mode: opts.mode ?? "casual",
    lobby_status: opts.lobbyStatus ?? (status === "complete" ? "done" : "waiting"),
    current_hand: opts.currentHand ?? 0,
    hands_base: opts.handsBase ?? 4,
    seat_plan: opts.seatPlan ?? JSON.stringify([{ kind: "human" }, { kind: "human" }, { kind: "human" }, { kind: "human" }]),
    randomize_seats: 0,
    created_by: opts.createdBy === undefined ? (opts.seats[0] ?? null) : opts.createdBy,
  });
  opts.seats.forEach((playerId, seat) => {
    h.store.match_players.push({
      match_id: opts.id, seat, player_id: playerId, wind: seat, final_chips: 0,
      faan_won: 0, place: null, hands_won: 0, self_draws: 0, deal_ins: 0,
      bot_takeover_hands: 0, moves_graded: 0, moves_matched: 0, gap_sum: 0,
      rating_before: null, rating_after: null, connected: 0,
    });
  });
  h.store.hands.push({
    match_id: opts.id, hand_index: 0, dealer_seat: 0, round_wind: 0, dealer_repeat: 0,
    seed: 12345, outcome: "win", winner_seat: 1, winner_player_id: opts.seats[1] ?? null,
    win_from_seat: 2, win_from_player_id: opts.seats[2] ?? null, winning_tile: 5,
    self_draw: 0, robbed_kong: 0, on_kong_replacement: 0, faan: 4, raw_faan: 4, capped: 0,
    awards: JSON.stringify([{ id: "allPungs", faan: 3 }, { id: "seatWind", faan: 1 }]),
    delta_seat0: 0, delta_seat1: 16, delta_seat2: -16, delta_seat3: 0, refused_wins: 1,
    wall_remaining: 30, event_count: 90, log_seq_start: 0, log_seq_end: 89,
    started_at: "2026-08-20T10:00:00.000Z", ended_at: "2026-08-20T10:05:00.000Z",
  });
  if (logKey !== null) h.logs.put(logKey, `{"header":{"matchId":"${opts.id}"},"events":[]}`);
}

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
  beforeEach(() => {
    h = harness();
  });

  it("creates a player and stores only the digest of the token", async () => {
    const res = await handle(
      post("/api/identity", { deviceToken: TOKEN_A, displayName: "Ah Ming" }),
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
  });

  it("re-presenting the same token returns the same player, not a second one", async () => {
    const first = await identify(h, TOKEN_A, "Ah Ming");
    const res = await handle(
      post("/api/identity", { deviceToken: TOKEN_A, displayName: "Ah Ming" }),
      h.platform,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { playerId: string; created: boolean };
    expect(body.playerId).toBe(first);
    expect(body.created).toBe(false);
    expect(h.store.players).toHaveLength(1);
  });

  it("mints a token when the client supplies none, and returns it exactly once", async () => {
    const res = await handle(post("/api/identity", { displayName: "Ah Ming" }), h.platform);
    const body = (await res.json()) as { deviceToken: string };
    expect(body.deviceToken).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);

    const again = await handle(
      post("/api/identity", { deviceToken: body.deviceToken, displayName: "Ah Ming" }),
      h.platform,
    );
    expect((await again.json()) as Record<string, unknown>).not.toHaveProperty("deviceToken");
  });

  it("refuses a guessably short device token and a missing name", async () => {
    const weak = await handle(
      post("/api/identity", { deviceToken: "short", displayName: "Ah Ming" }),
      h.platform,
    );
    expect(weak.status).toBe(400);
    const unnamed = await handle(post("/api/identity", { deviceToken: TOKEN_A }), h.platform);
    expect(unnamed.status).toBe(400);
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
  it("ranked: humans with rating_games >= 1, ordered by rating desc — bots and the unrated excluded", async () => {
    const h = harness();
    const a = await identify(h, TOKEN_A, "Ah Ming");
    const b = await identify(h, TOKEN_B, "Opponent");
    await identify(h, TOKEN_C, "Never Rated"); // rating_games stays 0

    const pa = h.store.players.find((r) => r.id === a)!;
    pa.rating = 1600; pa.rating_games = 5; pa.rating_season = "p0-provisional";
    const pb = h.store.players.find((r) => r.id === b)!;
    pb.rating = 1450; pb.rating_games = 2; pb.rating_season = "p0-provisional";
    // A bot never belongs on a human leaderboard, even with a rating.
    h.store.players.push({
      id: "bot:v4", kind: "bot", display_name: "Sifu", bot_policy: "v4",
      rating: 1700, rating_games: 9, rating_season: "p0-provisional",
      almanac_user_id: null, almanac_link_source: null, almanac_linked_at: null,
      created_at: "x", updated_at: "x", last_seen_at: "x", deleted_at: null,
    });

    const res = await handle(get("/api/leaderboard?mode=ranked", TOKEN_A), h.platform);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      entries: { playerId: string; displayName: string; rating: number; games: number; provisional: boolean }[];
    };
    expect(body.mode).toBe("ranked");
    expect(body.entries.map((e) => e.playerId)).toEqual([a, b]);
    expect(body.entries[0]).toMatchObject({ displayName: "Ah Ming", rating: 1600, games: 5, provisional: true });
  });

  it("casual: humans ordered by wins then matches, over casual matches only", async () => {
    const h = harness();
    const a = await identify(h, TOKEN_A, "Ah Ming");
    const b = await identify(h, TOKEN_B, "Opponent");
    seedMatch(h, { id: "c1", seats: [a, b, "p2", "p3"], mode: "casual" });
    seedMatch(h, { id: "c2", seats: [a, b, "p2", "p3"], mode: "casual" });
    for (const matchId of ["c1", "c2"]) {
      h.store.match_players.find((r) => r.match_id === matchId && r.player_id === a)!.place = 1;
      h.store.match_players.find((r) => r.match_id === matchId && r.player_id === b)!.place = 4;
    }

    const res = await handle(get("/api/leaderboard?mode=casual", TOKEN_A), h.platform);
    const body = (await res.json()) as {
      mode: string;
      entries: { playerId: string; matches: number; wins: number; places: number[] }[];
    };
    expect(body.mode).toBe("casual");
    expect(body.entries[0]).toMatchObject({ playerId: a, matches: 2, wins: 2, places: [2, 0, 0, 0] });
    expect(body.entries.find((e) => e.playerId === b)).toMatchObject({ matches: 2, wins: 0, places: [0, 0, 0, 2] });
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

    expect(h.store.rooms).toHaveLength(1);
    const room = h.store.rooms[0];
    expect(room.code).toBe(body.code);
    expect(JSON.parse(String(room.settings))).toEqual({
      game: { rulesetId: "hkos-standard", matchFormat: "full", access: "open" },
    });
    expect(JSON.stringify(h.store)).not.toContain("1234");

    expect(h.store.room_players).toEqual([
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

    expect(h.store.rooms).toHaveLength(0);
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
    expect(body.rooms.map((r) => r.code)).toEqual([codeA]);
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

    const wrongCode = await handle(postAdmin(`/api/rooms/${code}/settings`, { matchFormat: "full" }, TOKEN_A, "0000"), h.platform);
    expect(wrongCode.status).toBe(401);
    expect(JSON.parse(String(h.store.rooms[0].settings)).game.matchFormat).toBe("east"); // unchanged

    const rightCode = await handle(postAdmin(`/api/rooms/${code}/settings`, { matchFormat: "full" }, TOKEN_A, "8899"), h.platform);
    expect(rightCode.status).toBe(200);
    const body = (await rightCode.json()) as { game: { matchFormat: string; rulesetId: string; access: string } };
    expect(body.game.matchFormat).toBe("full");
    // rulesetId/access, unspecified in this request, are carried over.
    expect(body.game.rulesetId).toBe("hkos-standard");
    expect(body.game.access).toBe("open");
    expect(JSON.parse(String(h.store.rooms[0].settings)).game.matchFormat).toBe("full");
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
    const settings = JSON.parse(String(h.store.rooms[0].settings));
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

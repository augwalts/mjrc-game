/**
 * The in-memory D1/R2/Table fakes every worker test runs against, plus the
 * fixtures built on top of them.
 *
 * Extracted from db.test.ts so auth.test.ts can share ONE fake rather than
 * carry a second, subtly different copy — two fakes that disagree about what
 * `players` looks like is exactly how a test suite starts passing against a
 * schema nobody has.
 *
 * NOT a `*.test.ts` file, so vitest's `include` pattern never collects it: a
 * test file imported by another test file registers its suites twice
 * (vitest.config.ts's own note about running every suite twice).
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
 */
import type {
  D1AllResult,
  D1Like,
  D1RunResult,
  D1Statement,
  R2Like,
  R2ObjectLike,
  SqlValue,
} from "../src/db.js";
import { SQL, sha256Hex } from "../src/db.js";
import type { Platform, SeatClaim, TableId, TableNamespace, TableSpec, TableStub } from "../src/index.js";
import { handle } from "../src/index.js";
import { SESSION_COOKIE, handleAuth } from "../src/auth.js";

/* ── in-memory D1 ─────────────────────────────────────────────────────────── */

export type Row = Record<string, SqlValue>;

export interface Store {
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
  friend_stars: Row[];
  dm_messages: Row[];
  inbox_items: Row[];
  users: Row[];
  handle_history: Row[];
  consents: Row[];
}

export const emptyStore = (): Store => ({
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
  friend_stars: [],
  dm_messages: [],
  inbox_items: [],
  users: [],
  handle_history: [],
  consents: [],
});

export type Handler = (s: Store, a: SqlValue[]) => { rows: Row[]; changes: number };

export const rows = (r: Row[]): { rows: Row[]; changes: number } => ({ rows: r, changes: 0 });
export const wrote = (n: number): { rows: Row[]; changes: number } => ({ rows: [], changes: n });

export const pick = (r: Row, keys: readonly string[]): Row => {
  const out: Row = {};
  for (const k of keys) out[k] = r[k] ?? null;
  return out;
};

export const PLAYER_COLUMNS = [
  "id", "kind", "display_name", "avatar", "rating", "rating_games", "rating_season",
  "tz_offset_min", "created_at", "almanac_user_id",
] as const;

/** Every column of `users` — `SQL.userById` and friends select all of them,
 *  because a session carries only `{uid, epoch, exp}` and everything else about
 *  the account is read from this row. */
export const USER_COLUMNS = [
  "id", "user_no", "google_sub", "email", "email_verified", "handle", "display_name",
  "picture", "is_admin", "signup_lang", "signup_source", "onboarded_at", "session_epoch",
  "created_at", "updated_at", "last_seen_at", "deleted_at",
] as const;

export const MATCH_COLUMNS = [
  "id", "status", "match_format", "ruleset_hash", "ruleset_id", "engine_version",
  "log_schema_version", "room_code", "join_code", "rated", "bot_seats", "hand_count",
  "log_key", "log_bytes", "log_sha256", "started_at", "ended_at",
  "access", "mode", "lobby_status", "current_hand", "hands_base", "seat_plan",
  "randomize_seats", "created_by", "speed", "name",
] as const;

export const HANDLERS = new Map<string, Handler>([
  [SQL.playerForCredential, (s, [id]) => {
    const cred = s.player_credentials.find((c) => c.id === id && c.revoked_at === null);
    if (cred === undefined) return rows([]);
    const player = s.players.find((p) => p.id === cred.player_id && p.deleted_at === null);
    return rows(player === undefined ? [] : [pick(player, PLAYER_COLUMNS)]);
  }],

  [SQL.insertPlayer, (s, [id, kind, display_name, avatar, created_at, updated_at, last_seen_at]) => {
    s.players.push({
      id, kind, display_name, avatar, bot_policy: null, rating: null, rating_games: 0,
      rating_season: null, almanac_user_id: null, almanac_link_source: null,
      almanac_linked_at: null, tz_offset_min: 0, created_at, updated_at, last_seen_at, deleted_at: null,
    });
    return wrote(1);
  }],

  [SQL.updatePlayerTzOffset, (s, [minutes, id]) => {
    const p = s.players.find((r) => r.id === id);
    if (p === undefined) return wrote(0);
    p.tz_offset_min = minutes;
    return wrote(1);
  }],

  [SQL.updatePlayerAvatar, (s, [avatar, updated_at, id]) => {
    const p = s.players.find((r) => r.id === id);
    if (p === undefined) return wrote(0);
    p.avatar = avatar;
    p.updated_at = updated_at;
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
      speed: a[19], name: a[20],
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
          "started_at", "join_code", "room_code", "speed", "name",
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
          "started_at", "join_code", "room_code", "speed", "name",
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

  /* ── accounts (ACCOUNTS-GAME-SIGNIN-2026-09-04.md §1) ───────────────────
   * The UNIQUE indexes on `users.handle` and `users.user_no` are modelled, not
   * assumed: `onboardUser` losing a handle race is a 409 the route only reaches
   * if the constraint actually throws, so a fake that silently allowed the
   * duplicate would make that test vacuous. */

  [SQL.userById, (s, [id]) => {
    const u = s.users.find((r) => r.id === id);
    return rows(u === undefined ? [] : [pick(u, USER_COLUMNS)]);
  }],

  [SQL.userByGoogleSub, (s, [sub]) => {
    const u = s.users.find((r) => r.google_sub === sub && r.deleted_at === null);
    return rows(u === undefined ? [] : [pick(u, USER_COLUMNS)]);
  }],

  [SQL.userByEmailUnclaimed, (s, [email]) => {
    const u = s.users
      .filter((r) => r.email === email && r.google_sub === null && r.deleted_at === null)
      .sort((a, b) => Number(a.user_no) - Number(b.user_no))[0];
    return rows(u === undefined ? [] : [pick(u, USER_COLUMNS)]);
  }],

  [SQL.userByHandle, (s, [handle]) => {
    const u = s.users.find((r) => r.handle === handle);
    return rows(u === undefined ? [] : [{ id: u.id }]);
  }],

  [SQL.handleHistoryByHandle, (s, [handle]) => {
    const h = s.handle_history.find((r) => r.handle === handle);
    return rows(h === undefined ? [] : [{ handle: h.handle }]);
  }],

  [SQL.maxUserNo, (s) => rows([{ n: s.users.length === 0 ? null : Math.max(...s.users.map((r) => Number(r.user_no))) }])],

  [SQL.insertUser, (s, a) => {
    if (s.users.some((r) => r.user_no === a[1])) throw new Error("UNIQUE constraint failed: users.user_no");
    s.users.push({
      id: a[0], user_no: a[1], google_sub: a[2], email: a[3], email_verified: a[4],
      handle: null, display_name: a[5], picture: a[6], is_admin: 0, signup_lang: a[7],
      signup_source: null, onboarded_at: null, session_epoch: 0,
      created_at: a[8], updated_at: a[9], last_seen_at: a[10], deleted_at: null,
    });
    return wrote(1);
  }],

  [SQL.attachGoogleSub, (s, [sub, verified, picture, updated, seen, id]) => {
    const u = s.users.find((r) => r.id === id && r.google_sub === null && r.deleted_at === null);
    if (u === undefined) return wrote(0);
    u.google_sub = sub;
    u.email_verified = verified;
    u.picture = picture;
    u.updated_at = updated;
    u.last_seen_at = seen;
    return wrote(1);
  }],

  [SQL.touchUser, (s, [now, id]) => {
    const u = s.users.find((r) => r.id === id);
    if (u === undefined) return wrote(0);
    u.last_seen_at = now;
    return wrote(1);
  }],

  [SQL.updateUserDisplayName, (s, [name, updated, seen, id]) => {
    const u = s.users.find((r) => r.id === id);
    if (u === undefined) return wrote(0);
    u.display_name = name;
    u.updated_at = updated;
    u.last_seen_at = seen;
    return wrote(1);
  }],

  [SQL.onboardUser, (s, [handle, name, lang, source, onboarded, updated, seen, id]) => {
    const u = s.users.find((r) => r.id === id && r.onboarded_at === null && r.deleted_at === null);
    if (u === undefined) return wrote(0);
    if (s.users.some((r) => r.id !== id && r.handle === handle)) {
      throw new Error("UNIQUE constraint failed: users.handle");
    }
    u.handle = handle;
    u.display_name = name;
    u.signup_lang = lang;
    u.signup_source = source;
    u.onboarded_at = onboarded;
    u.updated_at = updated;
    u.last_seen_at = seen;
    return wrote(1);
  }],

  [SQL.insertConsent, (s, [user_id, kind, granted, source, at]) => {
    s.consents.push({ id: s.consents.length + 1, user_id, kind, granted, source, at });
    return wrote(1);
  }],

  [SQL.insertHandleHistory, (s, [handle, user_id, released_at]) => {
    if (s.handle_history.some((r) => r.handle === handle)) return wrote(0); // OR IGNORE
    s.handle_history.push({ handle, user_id, released_at });
    return wrote(1);
  }],

  [SQL.scrubUser, (s, [email, name, deleted, updated, id]) => {
    const u = s.users.find((r) => r.id === id);
    if (u === undefined) return wrote(0);
    u.email = email;
    u.google_sub = null;
    u.handle = null;
    u.display_name = name;
    u.picture = null;
    u.signup_source = null;
    u.signup_lang = null;
    u.session_epoch = Number(u.session_epoch) + 1;
    u.deleted_at = deleted;
    u.updated_at = updated;
    return wrote(1);
  }],

  [SQL.playerForUser, (s, [userId]) => {
    const p = s.players
      .filter((r) => r.almanac_user_id === userId && r.deleted_at === null)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
    return rows(p === undefined ? [] : [pick(p, PLAYER_COLUMNS)]);
  }],

  [SQL.linkPlayerToUser, (s, [userId, source, linkedAt, updated, playerId]) => {
    const p = s.players.find(
      (r) => r.id === playerId && r.almanac_user_id === null && r.deleted_at === null,
    );
    if (p === undefined) return wrote(0);
    p.almanac_user_id = userId;
    p.almanac_link_source = source;
    p.almanac_linked_at = linkedAt;
    p.updated_at = updated;
    return wrote(1);
  }],

  [SQL.credentialById, (s, [id]) => {
    const c = s.player_credentials.find((r) => r.id === id);
    return rows(c === undefined ? [] : [pick(c, ["id", "player_id", "revoked_at"])]);
  }],

  [SQL.scrubPlayer, (s, [name, deleted, updated, id]) => {
    const p = s.players.find((r) => r.id === id);
    if (p === undefined) return wrote(0);
    p.display_name = name;
    p.avatar = null;
    p.deleted_at = deleted;
    p.updated_at = updated;
    return wrote(1);
  }],

  [SQL.revokePlayerCredentials, (s, [now, playerId]) => {
    let n = 0;
    for (const c of s.player_credentials) {
      if (c.player_id === playerId && c.revoked_at === null) {
        c.revoked_at = now;
        n += 1;
      }
    }
    return wrote(n);
  }],

  /* ── stats and leaderboards ────────────────────────────────────────────── */

  [SQL.playerById, (s, [id]) => {
    const p = s.players.find((r) => r.id === id && r.deleted_at === null);
    return rows(p === undefined ? [] : [pick(p, PLAYER_COLUMNS)]);
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

  [SQL.roomPlayerIds, (s, [roomCode]) =>
    rows(
      s.room_players
        .filter((r) => r.room_code === roomCode && r.archived_at === null)
        .map((r) => ({ player_id: r.player_id })),
    )],

  /* ── stats scoping (§10) ──────────────────────────────────────────────────
   * `matchesForPlayerScoped`/`leaderboardCandidates` bind every optional
   * filter TWICE (`(? IS NULL OR col = ?)`, db.ts's own doc comment) — the
   * fake reads both halves of each pair but only ever needs the second, the
   * first is just the null-check the real SQL performs itself.
   */

  [SQL.matchesForPlayerScoped, (s, [playerId, _m1, mode, _r1, rulesetId, _rc1, roomCode, _s1, since, limit]) => {
    const list = s.match_players
      .filter((mp) => mp.player_id === playerId)
      .map((mp) => ({ mp, m: s.matches.find((r) => r.id === mp.match_id) }))
      .filter((j): j is { mp: Row; m: Row } => j.m !== undefined && j.m.status === "complete")
      .filter((j) => mode === null || j.m.mode === mode)
      .filter((j) => rulesetId === null || j.m.ruleset_id === rulesetId)
      .filter((j) => roomCode === null || j.m.room_code === roomCode)
      .filter((j) => since === null || String(j.m.started_at) >= String(since))
      .sort((a, b) => String(b.m.started_at).localeCompare(String(a.m.started_at)))
      .slice(0, Number(limit));
    return rows(list.map((j) => ({
      id: j.m.id, started_at: j.m.started_at, ended_at: j.m.ended_at, mode: j.m.mode,
      ruleset_id: j.m.ruleset_id, room_code: j.m.room_code, hand_count: j.m.hand_count,
      seat: j.mp.seat, place: j.mp.place, final_chips: j.mp.final_chips,
      hands_won: j.mp.hands_won, self_draws: j.mp.self_draws, deal_ins: j.mp.deal_ins,
      moves_graded: j.mp.moves_graded, moves_matched: j.mp.moves_matched,
      rating_before: j.mp.rating_before, rating_after: j.mp.rating_after,
    })));
  }],

  [SQL.leaderboardCandidates, (s, [_m1, mode, _r1, rulesetId, _rc1, roomCode, _s1, since]) => {
    const byPlayer = new Map<string, { p: Row; games: number }>();
    for (const mp of s.match_players) {
      const m = s.matches.find((r) => r.id === mp.match_id);
      if (m === undefined || m.status !== "complete") continue;
      if (mode !== null && m.mode !== mode) continue;
      if (rulesetId !== null && m.ruleset_id !== rulesetId) continue;
      if (roomCode !== null && m.room_code !== roomCode) continue;
      if (since !== null && String(m.started_at) < String(since)) continue;
      const p = s.players.find((r) => r.id === mp.player_id);
      if (p === undefined || p.kind !== "human" || p.deleted_at !== null) continue;
      const entry = byPlayer.get(String(p.id)) ?? { p, games: 0 };
      entry.games += 1;
      byPlayer.set(String(p.id), entry);
    }
    return rows(
      [...byPlayer.values()]
        .filter((e) => e.games >= 5)
        .map((e) => ({ player_id: e.p.id, rating: e.p.rating, rating_games: e.p.rating_games, games: e.games })),
    );
  }],

  /* ── friends (§11 build decision 1) ───────────────────────────────────── */

  [SQL.friendsOfPlayer, (s, [playerId]) => {
    const matchIds = new Set(
      s.match_players
        .filter((mp) => mp.player_id === playerId)
        .map((mp) => mp.match_id)
        .filter((id) => {
          const m = s.matches.find((r) => r.id === id);
          return m !== undefined && m.status === "complete";
        }),
    );
    const byFriend = new Map<string, { p: Row; games: number }>();
    for (const mp of s.match_players) {
      if (!matchIds.has(mp.match_id) || mp.player_id === playerId) continue;
      const p = s.players.find((r) => r.id === mp.player_id);
      if (p === undefined || p.kind !== "human" || p.deleted_at !== null) continue;
      const entry = byFriend.get(String(mp.player_id)) ?? { p, games: 0 };
      entry.games += 1;
      byFriend.set(String(mp.player_id), entry);
    }
    return rows(
      [...byFriend.values()].map((e) => ({
        friend_id: e.p.id, display_name: e.p.display_name, rating: e.p.rating,
        rating_games: e.p.rating_games, last_seen_at: e.p.last_seen_at, games: e.games,
      })),
    );
  }],

  [SQL.insertFriendStar, (s, [playerId, friendId, now]) => {
    if (s.friend_stars.some((r) => r.player_id === playerId && r.friend_id === friendId)) return wrote(0);
    s.friend_stars.push({ player_id: playerId, friend_id: friendId, created_at: now });
    return wrote(1);
  }],

  [SQL.deleteFriendStar, (s, [playerId, friendId]) => {
    const before = s.friend_stars.length;
    s.friend_stars = s.friend_stars.filter((r) => !(r.player_id === playerId && r.friend_id === friendId));
    return wrote(before - s.friend_stars.length);
  }],

  [SQL.friendStarsOfPlayer, (s, [playerId]) =>
    rows(s.friend_stars.filter((r) => r.player_id === playerId).map((r) => ({ friend_id: r.friend_id })))],

  /* ── the players directory (players-lab.html round 3) ─────────────────── */

  [SQL.playersDirectory, (s, [limit]) =>
    rows(
      s.players
        .filter((p) => p.kind === "human" && p.deleted_at === null)
        .sort((a, b) => String(b.last_seen_at ?? "").localeCompare(String(a.last_seen_at ?? "")))
        .slice(0, Number(limit))
        .map((p) => {
          const u = s.users.find((r) => r.id === p.almanac_user_id && r.deleted_at === null);
          return {
            id: p.id, display_name: p.display_name, avatar: p.avatar ?? null,
            rating: p.rating ?? null, rating_games: p.rating_games ?? 0,
            last_seen_at: p.last_seen_at ?? null,
            almanac_user_id: p.almanac_user_id ?? null,
            handle: u === undefined ? null : (u.handle ?? null),
          } as Row;
        }),
    )],

  /** The JS twin of `SQL.playerMatchTotals`' GROUP BY — one row per (player,
   *  completed match), with the seat's own net and the match's winning-hand
   *  values. Kept deliberately close to the SQL's own shape (including the
   *  `> 0` guard on a winner's delta) so a change to one is visibly a change
   *  to the other. */
  [SQL.playerMatchTotals, (s) => {
    const delta = (h: Row, seat: number): number => Number(h[`delta_seat${seat}`] ?? 0);
    const out: Row[] = [];
    for (const mp of s.match_players) {
      const m = s.matches.find((r) => r.id === mp.match_id);
      if (m === undefined || m.status !== "complete") continue;
      const p = s.players.find((r) => r.id === mp.player_id);
      if (p === undefined || p.kind !== "human" || p.deleted_at !== null) continue;
      const seat = Number(mp.seat);
      const hs = s.hands.filter((h) => h.match_id === mp.match_id);
      let net = 0, winSum = 0, winCount = 0;
      for (const h of hs) {
        net += delta(h, seat);
        if (h.outcome === "win" && h.winner_seat !== null && h.winner_seat !== undefined) {
          const wd = delta(h, Number(h.winner_seat));
          if (wd > 0) { winSum += wd; winCount += 1; }
        }
      }
      out.push({
        player_id: mp.player_id, match_id: mp.match_id, seat,
        hands_won: Number(mp.hands_won ?? 0),
        hands: hs.length,
        net: hs.length === 0 ? null : net,
        win_value_sum: hs.length === 0 ? null : winSum,
        win_value_count: hs.length === 0 ? null : winCount,
      });
    }
    return rows(out);
  }],

  /* ── direct messages (§8) ─────────────────────────────────────────────── */

  [SQL.insertDmMessage, (s, [fromId, toId, text, now]) => {
    s.dm_messages.push({
      id: s.dm_messages.length + 1, from_player_id: fromId, to_player_id: toId,
      text, created_at: now, read_at: null,
    });
    return wrote(1);
  }],

  [SQL.dmThread, (s, [a1, b1, a2, b2, limit]) => {
    const list = s.dm_messages
      .filter((m) =>
        (m.from_player_id === a1 && m.to_player_id === b1) ||
        (m.from_player_id === a2 && m.to_player_id === b2),
      )
      .sort((x, y) => Number(y.id) - Number(x.id))
      .slice(0, Number(limit));
    return rows(list);
  }],

  [SQL.markDmThreadRead, (s, [now, toId, fromId]) => {
    let changed = 0;
    for (const m of s.dm_messages) {
      if (m.to_player_id === toId && m.from_player_id === fromId && m.read_at === null) {
        m.read_at = now;
        changed += 1;
      }
    }
    return wrote(changed);
  }],

  [SQL.lastDmMessageAt, (s, [fromId]) => {
    const list = s.dm_messages.filter((m) => m.from_player_id === fromId).sort((x, y) => Number(y.id) - Number(x.id));
    return rows(list.length === 0 ? [] : [{ created_at: list[0]!.created_at }]);
  }],

  [SQL.dmMessagesInvolving, (s, [playerIdA, playerIdB, limit]) => {
    const list = s.dm_messages
      .filter((m) => m.from_player_id === playerIdA || m.to_player_id === playerIdB)
      .sort((x, y) => Number(y.id) - Number(x.id))
      .slice(0, Number(limit));
    return rows(list);
  }],

  /* ── inbox (§8) ───────────────────────────────────────────────────────── */

  [SQL.insertInboxItem, (s, [id, playerId, kind, matchId, roomCode, fromPlayerId, text, now]) => {
    if (s.inbox_items.some((r) => r.id === id)) return wrote(0); // OR IGNORE
    s.inbox_items.push({
      id, player_id: playerId, kind, match_id: matchId, room_code: roomCode,
      from_player_id: fromPlayerId, text, created_at: now, read_at: null, dismissed_at: null,
    });
    return wrote(1);
  }],

  [SQL.inboxItemsForPlayer, (s, [playerId, limit]) => {
    const list = s.inbox_items
      .filter((r) => r.player_id === playerId && r.dismissed_at === null)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, Number(limit));
    return rows(list);
  }],

  [SQL.inboxItemById, (s, [id]) => {
    const r = s.inbox_items.find((row) => row.id === id);
    return rows(r === undefined ? [] : [r]);
  }],

  [SQL.dismissInboxItem, (s, [dismissedAt, readAtFallback, id, playerId]) => {
    const r = s.inbox_items.find((row) => row.id === id && row.player_id === playerId && row.dismissed_at === null);
    if (r === undefined) return wrote(0);
    r.dismissed_at = dismissedAt;
    if (r.read_at === null) r.read_at = readAtFallback;
    return wrote(1);
  }],
]);

/**
 * DOCUMENTED EXCEPTION — the two db.ts helpers that build a variable-length
 * `IN (...)` over an already-fetched id list (`handsForMatchIds`,
 * `matchPlayersForMatchIds`, both in ../src/db.ts) generate SQL text whose
 * exact string varies with the id count, so it can never be a `HANDLERS` map
 * key. Matched by shape instead — every bound value is still one of the ids,
 * nothing is parsed out of the SQL text itself.
 */
export function scopedIdsHandler(sql: string): Handler | undefined {
  if (sql.startsWith("SELECT match_id, hand_index, outcome, round_wind") && sql.includes("FROM hands WHERE match_id IN (")) {
    return (s, ids) => {
      const set = new Set(ids);
      const list = s.hands
        .filter((h) => set.has(h.match_id))
        .map((h) => pick(h, [
          "match_id", "hand_index", "outcome", "round_wind", "winner_seat", "win_from_seat",
          "self_draw", "faan", "awards", "delta_seat0", "delta_seat1", "delta_seat2", "delta_seat3",
        ]))
        .sort((a, b) => String(a.match_id).localeCompare(String(b.match_id)) || Number(a.hand_index) - Number(b.hand_index));
      return rows(list);
    };
  }
  if (sql.includes("FROM match_players mp") && sql.includes("WHERE mp.match_id IN (")) {
    return (s, ids) => {
      const set = new Set(ids);
      const list = s.match_players
        .filter((mp) => set.has(mp.match_id))
        .map((mp) => {
          const p = s.players.find((r) => r.id === mp.player_id);
          return {
            match_id: mp.match_id, seat: mp.seat, player_id: mp.player_id,
            display_name: p === undefined ? "" : p.display_name,
            kind: p === undefined ? "human" : p.kind,
          };
        });
      return rows(list);
    };
  }
  return undefined;
}

export function matchPage(s: Store, playerId: SqlValue, before: string | null, limit: number): Row[] {
  return s.match_players
    .filter((mp) => mp.player_id === playerId)
    .map((mp) => ({ mp, m: s.matches.find((r) => r.id === mp.match_id) }))
    .filter((j): j is { mp: Row; m: Row } => j.m !== undefined)
    .filter((j) => before === null || String(j.m.started_at) < before)
    .sort((a, b) => String(b.m.started_at).localeCompare(String(a.m.started_at)))
    .slice(0, limit)
    .map((j) => ({
      ...pick(j.m, ["id", "status", "match_format", "ruleset_id", "rated", "bot_seats",
        "hand_count", "room_code", "join_code", "log_key", "started_at", "ended_at", "name"]),
      ...pick(j.mp, ["seat", "place", "final_chips", "faan_won", "rating_before", "rating_after"]),
    }));
}

export class FakeStatement implements D1Statement {
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
    const handler = HANDLERS.get(this.sql) ?? scopedIdsHandler(this.sql);
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

export class FakeD1 implements D1Like {
  constructor(readonly store: Store) {}
  prepare(sql: string): D1Statement {
    return new FakeStatement(this.store, sql, (sql.match(/\?/g) ?? []).length);
  }
}

/* ── in-memory R2 ─────────────────────────────────────────────────────────── */

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export class FakeR2 implements R2Like {
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

export class FakeTables implements TableNamespace {
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
      async end(): Promise<void> {
        if (ns.fail) throw new Error("table unavailable");
      },
      async kick(): Promise<void> {
        if (ns.fail) throw new Error("table unavailable");
      },
      async observe(): Promise<Record<string, unknown>> {
        if (ns.fail) throw new Error("table unavailable");
        return { started: false, over: false, players: [], presence: [], seats: null };
      },
    };
  }
}

/* ── platform ─────────────────────────────────────────────────────────────── */

export const SECRET = "test-replay-secret-that-is-long-enough";
export const SESSION_SECRET = "test-session-secret-that-is-long-enough-32";

export interface Harness {
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
export function harness(): Harness {
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
      /* Accounts on, Google off: `devBypass` routes every sign-in through
       * `/auth/dev`, so the suite never touches the network and still exercises
       * the real cookie, the real `resolveUser` and the real route table. */
      auth: {
        sessionSecret: SESSION_SECRET,
        googleClientId: "test-client-id.apps.googleusercontent.com",
        googleClientSecret: "test-client-secret",
        devBypass: true,
      },
    },
  };
}

/* ── signing in ───────────────────────────────────────────────────────────── */

/** The `mjrc_session=...` cookie header value, from a real `/auth/dev` round
 *  trip through `handleAuth` — not a hand-rolled cookie, so every test that
 *  signs in also covers the sign-in path. */
export async function signIn(h: Harness, email: string, name?: string): Promise<string> {
  const url = new URL("https://game.mahjongresearch.com/auth/dev");
  url.searchParams.set("email", email);
  if (name !== undefined) url.searchParams.set("name", name);
  const res = await handleAuth(new Request(url.toString()), h.platform);
  if (res === null || res.status !== 302) {
    throw new Error(`signIn(${email}) failed: ${res === null ? "not routed" : res.status}`);
  }
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (cookie === undefined) throw new Error(`signIn(${email}) set no session cookie`);
  return cookie;
}

/**
 * One account per device token, stably — the suite's fixtures name players by
 * token, and an account is now what owns a player. Deliberately NOT derived
 * from the token's characters: a fixture token containing an admin code or a
 * join code would then plant that string in the store and break the several
 * `not.toContain(...)` secrecy assertions elsewhere in this file.
 */
export const emails = new Map<string, string>();
export function emailFor(token: string): string {
  const known = emails.get(token);
  if (known !== undefined) return known;
  const email = `player${emails.size + 1}@example.test`;
  emails.set(token, email);
  return email;
}

export const TOKEN_A = "0123456789abcdefghijklmnopqrstuvwxyzABCD";
export const TOKEN_B = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxw";
export const TOKEN_C = "1111222233334444555566667777888899990000";

export const get = (path: string, token?: string, cookie?: string): Request =>
  new Request(`https://game.mahjongresearch.com${path}`, {
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(cookie === undefined ? {} : { cookie }),
    },
  });

export const post = (path: string, body: unknown, token?: string, cookie?: string): Request =>
  new Request(`https://game.mahjongresearch.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });

/**
 * Establish a player for `token`. Since 2026-09-04 `POST /api/identity` refuses
 * to create a player without a session (ACCOUNTS-GAME-SIGNIN §3), so this signs
 * in first — one account per token — and every fixture player in this suite is
 * therefore an account-owned player, which is what production now looks like.
 */
export async function identify(h: Harness, token: string, displayName: string): Promise<string> {
  const cookie = await signIn(h, emailFor(token), displayName);
  const res = await handle(post("/api/identity", { deviceToken: token, displayName }, undefined, cookie), h.platform);
  const body = (await res.json()) as { playerId?: string; error?: string };
  // Fail loudly on a bad fixture token (e.g. under DEVICE_TOKEN_RE's 32-char
  // floor) rather than silently returning `undefined` and letting a later
  // assertion pass by accident on two `undefined`s comparing equal.
  if (!res.ok || body.playerId === undefined) {
    throw new Error(`identify(${token}) failed: ${res.status} ${body.error ?? ""}`);
  }
  return body.playerId;
}

/** A finished match with one hand, seated by whoever is passed. */
export function seedMatch(
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
    speed?: string;
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
    speed: opts.speed ?? "normal",
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


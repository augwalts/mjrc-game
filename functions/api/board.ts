/// <reference types="@cloudflare/workers-types" />
/**
 * GET /api/board — the leaderboard, across every tester.
 *
 * Behind the root gate (see ../_middleware.ts), so this file does no auth of
 * its own.
 *
 * READ ONLY, and that is the point. The owner's rule for this board is that
 * "no one can write to the leaderboard, only we can record to it" — so the
 * numbers are computed here from `game_match` and `game_move`, the tables the
 * server itself wrote when a match was uploaded. A client cannot post a
 * standing; it can only ask what the rows say.
 *
 * The client had a leaderboard before this, but it read the device's own
 * IndexedDB — so every tester saw a board with exactly one name on it. This is
 * the shared one.
 */
import type { Env } from "../_lib";
import { apiError, json } from "../_lib";

/**
 * A beta's worth of rows. The board aggregates in JS rather than SQL because
 * `chips` is a JSON array — a win is "seat 0 finished at or above every bot" —
 * and unpacking that in SQLite would cost more in clarity than the loop does
 * in time. The cap is here so the shape of the query cannot change silently if
 * the demo ever gets popular.
 */
const MAX_ROWS = 5000;

interface Row {
  player_id: string;
  player_name: string;
  chips: string;
  hands: number;
  won: number;
  self_drawn: number;
  fed: number;
  drawn_hands: number;
  moves_graded: number;
  matched: number | null;
  finished_at: number | null;
}

interface Standing {
  playerId: string;
  name: string;
  games: number;
  wins: number;
  hands: number;
  handsWon: number;
  selfDrawn: number;
  fed: number;
  chips: number;
  net: number;
  graded: number;
  matched: number;
  rate: number | null;
  lastPlayed: number | null;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.DB) return apiError(503, "no_db", "The database is not bound.");

  try {
    /**
     * `matched` comes from game_move, not from the stored match_rate: the rate
     * is a per-match ratio and averaging ratios across matches of different
     * length is simply wrong. Counting the moves that matched the engine
     * (gap = 0) and dividing by the moves graded is the honest aggregate.
     *
     * Forfeits and casual games are excluded here, exactly as the client's
     * own footer has always promised.
     */
    const sql = `
      SELECT m.player_id, m.player_name, m.chips, m.hands, m.won,
             m.self_drawn, m.fed, m.drawn_hands, m.moves_graded,
             m.finished_at,
             (SELECT COUNT(*) FROM game_move v
               WHERE v.match_id = m.id AND v.gap = 0) AS matched
        FROM game_match m
       WHERE m.recorded = 1 AND m.abandoned = 0 AND m.finished_at IS NOT NULL
       ORDER BY m.finished_at DESC
       LIMIT ${MAX_ROWS}`;
    const res = await env.DB.prepare(sql).all<Row>();
    const rows = res.results ?? [];

    const byPlayer = new Map<string, Standing>();
    for (const r of rows) {
      let s = byPlayer.get(r.player_id);
      if (!s) {
        s = {
          playerId: r.player_id, name: r.player_name, games: 0, wins: 0,
          hands: 0, handsWon: 0, selfDrawn: 0, fed: 0, chips: 0, net: 0,
          graded: 0, matched: 0, rate: null, lastPlayed: null,
        };
        byPlayer.set(r.player_id, s);
      }
      // the name is a label the player can change; the most recent one wins,
      // and the rows arrive newest first
      if (s.games === 0) s.name = r.player_name;

      let chips: number[] = [];
      try {
        const parsed: unknown = JSON.parse(r.chips);
        if (Array.isArray(parsed)) chips = parsed.map((v) => (typeof v === "number" ? v : 0));
      } catch { /* a malformed row costs its chips, not the whole board */ }

      const mine = chips[0] ?? 0;
      const best = chips.length > 1 ? Math.max(...chips.slice(1)) : 0;
      if (chips.length > 0 && mine >= best) s.wins++;

      s.games++;
      s.hands += r.hands ?? 0;
      s.handsWon += r.won ?? 0;
      s.selfDrawn += r.self_drawn ?? 0;
      s.fed += r.fed ?? 0;
      s.chips += mine;
      s.graded += r.moves_graded ?? 0;
      s.matched += r.matched ?? 0;
      if (r.finished_at !== null && (s.lastPlayed === null || r.finished_at > s.lastPlayed)) {
        s.lastPlayed = r.finished_at;
      }
    }

    const table = [...byPlayer.values()].map((s) => ({
      ...s,
      net: s.hands ? s.chips / s.hands : 0,
      rate: s.graded ? s.matched / s.graded : null,
    }));
    // a default order so a client that does not sort still shows something sane
    table.sort((a, b) => b.wins - a.wins || b.hands - a.hands);

    /**
     * Every game, not just the standings.
     *
     * The aggregate above excludes forfeits and casual games, which is right
     * for a ranking and wrong for "what has actually been played" — of the
     * first four testers, two quit mid-match and vanished from the board
     * entirely. This list carries them, flagged, so the demo shows its own
     * activity honestly.
     */
    const recent = await env.DB.prepare(`
      SELECT player_name, rounds, ruleset_id, table_id, hands, won, chips,
             recorded, abandoned, moves_graded, match_rate, finished_at
        FROM game_match
       WHERE finished_at IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 100`).all<Record<string, unknown>>();

    return json({
      players: table,
      games: (recent.results ?? []).map((g) => ({
        name: g.player_name, rounds: g.rounds, ruleset: g.ruleset_id, table: g.table_id,
        hands: g.hands, won: g.won,
        chips: (() => { try { const c: unknown = JSON.parse(String(g.chips));
          return Array.isArray(c) && typeof c[0] === "number" ? c[0] : 0; } catch { return 0; } })(),
        casual: g.recorded === 0, quit: g.abandoned === 1,
        graded: g.moves_graded, rate: g.match_rate, at: g.finished_at,
      })),
      matches: rows.length,
      generatedAt: Date.now(),
    });
  } catch (e) {
    return apiError(500, "board_failed", String(e).slice(0, 200));
  }
};

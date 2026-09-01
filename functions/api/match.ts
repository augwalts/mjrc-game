/// <reference types="@cloudflare/workers-types" />
/**
 * POST /api/match — a finished game from the demo.
 *
 * Behind the root gate (see ../_middleware.ts), so this file does no auth of
 * its own. It is idempotent: the client mints the match id and retries anything
 * it has not had a 2xx for, so a flaky phone re-sending is normal traffic
 * rather than an error.
 */
import type { Env } from "../_lib";
import { apiError, json, readJsonBody } from "../_lib";

/**
 * 512 KB. The default 32 KB is far too small here: a four-wind match carries a
 * gzipped action log plus a few hundred graded moves. It is still a hard cap —
 * the event log is deliberately NOT uploaded (D1's statement limit is 100 KB;
 * see migrations/0012_game.sql).
 */
const MAX_BODY = 512 * 1024;

interface MoveIn {
  hand: number; turn: number; kind: string; played: string;
  enginePick: string; gap: number; top1MinusTop2: number; reason?: string;
}
interface MatchIn {
  id: string; playerId: string; playerName: string;
  rounds: number; rulesetId: string; tableId: string; seats: unknown; seed: number;
  recorded: boolean; abandoned: boolean;
  startedAt: number; finishedAt: number | null;
  chips: unknown; hands: number; won: number; selfDrawn: number; fed: number;
  drawnHands: number; seatWins: unknown;
  matchRate: number | null; meanGap: number | null; movesGraded: number;
  client?: unknown; actionsGz?: string; moves?: MoveIn[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Reject early and by name, so a client bug is obvious rather than a 500. */
function invalid(m: MatchIn): string | null {
  if (!isStr(m.id) || m.id.length > 64) return "id";
  if (!isStr(m.playerId) || m.playerId.length > 64) return "playerId";
  if (!isStr(m.playerName) || m.playerName.length > 64) return "playerName";
  if (!isNum(m.rounds) || m.rounds < 1 || m.rounds > 4) return "rounds";
  if (!isStr(m.rulesetId) || !isStr(m.tableId)) return "rulesetId/tableId";
  if (!isNum(m.seed)) return "seed";
  if (!isNum(m.hands) || m.hands < 0) return "hands";
  if (!Array.isArray(m.chips) || m.chips.length !== 4) return "chips";
  if (!Array.isArray(m.seatWins) || m.seatWins.length !== 4) return "seatWins";
  if (m.actionsGz !== undefined && (typeof m.actionsGz !== "string" || m.actionsGz.length > 400_000)) {
    return "actionsGz";
  }
  if (m.moves !== undefined && (!Array.isArray(m.moves) || m.moves.length > 4000)) return "moves";
  return null;
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const body = await readJsonBody(ctx.request, MAX_BODY);
  if (body instanceof Response) return body;
  const m = body as MatchIn;

  const bad = invalid(m);
  if (bad) return apiError(400, "invalid", `Bad or missing field: ${bad}.`);

  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  stmts.push(ctx.env.DB.prepare(
    `INSERT OR REPLACE INTO game_match (
       id, player_id, player_name, rounds, ruleset_id, table_id, seats, seed,
       recorded, abandoned, started_at, finished_at, chips, hands, won,
       self_drawn, fed, drawn_hands, seat_wins, match_rate, mean_gap,
       moves_graded, client, actions_gz, uploaded_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)`,
  ).bind(
    m.id, m.playerId, m.playerName.slice(0, 64), m.rounds, m.rulesetId, m.tableId,
    JSON.stringify(m.seats ?? []), m.seed,
    m.recorded ? 1 : 0, m.abandoned ? 1 : 0, m.startedAt, m.finishedAt ?? null,
    JSON.stringify(m.chips), m.hands, m.won ?? 0, m.selfDrawn ?? 0, m.fed ?? 0,
    m.drawnHands ?? 0, JSON.stringify(m.seatWins),
    m.matchRate ?? null, m.meanGap ?? null, m.movesGraded ?? 0,
    m.client ? JSON.stringify(m.client) : null, m.actionsGz ?? null, now,
  ));

  // A re-send must not double the moves. They are keyed (match, hand, turn),
  // but clearing first also lets a corrected upload replace an earlier one.
  stmts.push(ctx.env.DB.prepare(`DELETE FROM game_move WHERE match_id = ?1`).bind(m.id));
  for (const v of m.moves ?? []) {
    if (!isNum(v.hand) || !isNum(v.turn) || !isStr(v.kind)) continue;
    stmts.push(ctx.env.DB.prepare(
      `INSERT OR REPLACE INTO game_move
         (match_id, hand, turn, kind, played, engine_pick, gap, top1_minus_top2, reason)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(
      m.id, v.hand, v.turn, v.kind, String(v.played ?? "").slice(0, 40),
      String(v.enginePick ?? "").slice(0, 40),
      isNum(v.gap) ? v.gap : 0, isNum(v.top1MinusTop2) ? v.top1MinusTop2 : 0,
      (v.reason ?? "").slice(0, 200) || null,
    ));
  }

  try {
    await ctx.env.DB.batch(stmts);
  } catch (e) {
    return apiError(500, "write_failed", `Could not store the match: ${String(e).slice(0, 120)}`);
  }
  return json({ ok: true, id: m.id, moves: (m.moves ?? []).length });
};

/// <reference types="@cloudflare/workers-types" />
/**
 * POST /api/feedback — a note from a tester, with the game state attached.
 *
 * Behind the root gate. Idempotent on the client-minted id, so a retry after a
 * dropped connection replaces rather than duplicates.
 */
import type { Env } from "../_lib";
import { apiError, json, readJsonBody } from "../_lib";

const MAX_BODY = 64 * 1024;
const MAX_TEXT = 4000;

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const body = await readJsonBody(ctx.request, MAX_BODY);
  if (body instanceof Response) return body;
  const f = body as {
    id?: string; matchId?: string | null; hand?: number | null;
    text?: string; createdAt?: number; context?: unknown;
  };

  if (typeof f.id !== "string" || !f.id || f.id.length > 64) {
    return apiError(400, "invalid", "Bad or missing field: id.");
  }
  const text = typeof f.text === "string" ? f.text.trim() : "";
  if (!text) return apiError(400, "invalid", "Feedback text is required.");

  try {
    await ctx.env.DB.prepare(
      `INSERT OR REPLACE INTO game_feedback
         (id, match_id, hand, text, created_at, context, uploaded_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    ).bind(
      f.id,
      typeof f.matchId === "string" ? f.matchId : null,
      typeof f.hand === "number" ? f.hand : null,
      text.slice(0, MAX_TEXT),
      typeof f.createdAt === "number" ? f.createdAt : Date.now(),
      f.context ? JSON.stringify(f.context).slice(0, 20_000) : null,
      Date.now(),
    ).run();
  } catch (e) {
    return apiError(500, "write_failed", `Could not store the feedback: ${String(e).slice(0, 120)}`);
  }
  return json({ ok: true, id: f.id });
};

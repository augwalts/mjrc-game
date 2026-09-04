/// <reference types="@cloudflare/workers-types" />
/**
 * The few helpers the demo's endpoints need.
 *
 * Deliberately a small local copy rather than an import: mjrc-app owns the
 * originals in `functions/api/scoring/_lib/shared.ts`, and the two repos are
 * separate. Four short functions duplicated is cheaper than coupling this
 * project's deploy to another repo's file layout — and each is small enough
 * that drift would be obvious.
 */

export interface Env {
  /** The same `mjrc-scoring` database the website uses. See wrangler.toml. */
  DB: D1Database;
  /** The demo's shared password. Unset means the gate fails closed. */
  GAME_PASSWORD?: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/**
 * Read and size-limit a JSON body. The cap is the caller's because a match
 * carries a gzipped replay and a few hundred graded moves, while a feedback
 * note does not.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown | Response> {
  const raw = await request.text();
  if (raw.length > maxBytes) {
    return apiError(413, "too_large", `Body exceeds ${maxBytes} bytes.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return apiError(400, "bad_json", "Body is not valid JSON.");
  }
}

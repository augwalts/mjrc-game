/// <reference types="@cloudflare/workers-types" />
/**
 * Password gate for the whole demo.
 *
 * The game is the ROOT of this Pages project — `game.mahjongresearch.com/` is
 * the table itself — so one root middleware covers the page, its assets and its
 * API together. That is the reason the demo lives in its own project rather
 * than on a path of the main site: serving it under a host rewrite there would
 * have reached the static files through the ASSETS binding, which bypasses
 * Functions and therefore bypasses this gate.
 *
 * HTTP Basic Auth, one shared password, any username. Held as a Pages secret:
 *
 *   wrangler pages secret put GAME_PASSWORD --project-name mjrc-game
 *
 * Local `wrangler pages dev`: put GAME_PASSWORD in .dev.vars.
 *
 * The pattern is lifted from mjrc-app's `functions/directory/_middleware.ts`,
 * which has been in production on the main site. Same constant-time compare,
 * same fail-closed behaviour on an unset secret.
 */
import { sha256Hex, type Env } from "./_lib";

/** Length-independent, early-exit-free comparison via fixed-width digests. */
async function passwordsMatch(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

const unauthorized = (message: string, status = 401): Response =>
  new Response(message, {
    status,
    headers: {
      "WWW-Authenticate": 'Basic realm="MJRC game demo", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const expected = ctx.env.GAME_PASSWORD;
  if (!expected) {
    // Fail closed. An unset secret must not publish the demo, and must not
    // leave the upload endpoints open either.
    return unauthorized("The game demo gate is not configured on this deployment.", 503);
  }

  const auth = ctx.request.headers.get("authorization") ?? "";
  if (auth.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(auth.slice(6));
    } catch {
      return unauthorized("The game is a private demo. Enter the demo password to continue.");
    }
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (await passwordsMatch(password, expected)) return ctx.next();
  }

  return unauthorized("The game is a private demo. Enter the demo password to continue.");
};

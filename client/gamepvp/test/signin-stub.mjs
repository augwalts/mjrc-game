/**
 * signin-stub.mjs — the accounts contract with nobody behind it.
 *
 * The Worker half of ACCOUNTS-GAME-SIGNIN-2026-09-04 is being built in
 * parallel, so this is how the client half gets looked at: a ~150-line static
 * server for `gamepvp/assets/` that answers the five accounts routes from
 * §3 out of one in-memory variable, and every other `/api/*` call with the
 * emptiest success that still lets a page paint. It is a VIEWING tool, not a
 * test double — there is no session cookie, no validation worth the name, and
 * the state is global, so two browsers pointed at it share one identity.
 *
 *   ./gamepvp/build.sh                       # from the worktree root, first
 *   node client/gamepvp/test/signin-stub.mjs # http://localhost:8890
 *
 * State machine, driven by `GET /__stub?state=…` (curl it before loading a
 * page) or by following the sign-in button:
 *
 *   signedout   → /api/me { signedIn:false }              → sign-in screen
 *   onboarding  → signed in, onboarded:false              → sign-up page
 *   onboarded   → signed in with a player and a token     → the app
 *
 * `GET /auth/google` does what the real one does at the end: 302 back to
 * `next`. It flips the state to `onboarding`, which is the interesting case —
 * a first sign-in that still owes a sign-up.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8890);
const ROOT = resolve(fileURLToPath(new URL("../../../gamepvp/assets", import.meta.url)));

let state = process.env.STUB_STATE ?? "signedout"; // signedout | onboarding | onboarded
const takenHandles = new Set(["augie", "admin", "mjrc", "taken", "sable"]);
const reserved = new Set(["admin", "mjrc", "augie", "sable", "open", "hall", "bot"]);
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

const user = (onboarded) => ({
  id: "USER0AUGWALTS000",
  userNo: 7,
  email: "player@example.com",
  displayName: "Wing Lam",
  handle: onboarded ? "winglam" : null,
  picture: null, // a real Google URL would be an external fetch; the client
                 // falls back to its letter avatar, which is what a headless
                 // screenshot should be showing anyway.
  isAdmin: false,
  onboarded,
  language: null,
});
const player = () => ({ playerId: "PL_STUB_0001", displayName: "Wing Lam", avatar: null, rating: 1500 });
const me = () =>
  state === "signedout"
    ? { signedIn: false, user: null, player: null, deviceToken: null }
    : state === "onboarding"
      ? { signedIn: true, user: user(false), player: null, deviceToken: null }
      : { signedIn: true, user: user(true), player: player(), deviceToken: "STUBDEVICETOKEN0123456789ABCDEFGHIJKL" };

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};
const empty = (res, code = 204) => { res.writeHead(code); res.end(); };
const readBody = (req) => new Promise((ok) => {
  let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } });
});

/** Everything else under /api/ — the shape each caller in net.ts unwraps,
 *  empty. Home asks for four of these before it can paint. */
function passthrough(path) {
  if (path.startsWith("/api/matches")) return { matches: [], total: 0 };
  if (path.startsWith("/api/lobby")) return { tables: [], here: [], recent: [], chat: [] };
  if (path.startsWith("/api/stats/histograms")) return { fanByRuleset: [], handTypes: [] };
  if (path.startsWith("/api/stats/series")) return { progression: [], rating: [], form: [], sizes: [] };
  if (path.startsWith("/api/identity")) return { ...player(), avatar: null };
  return [];
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === "/__stub") {
    const want = url.searchParams.get("state");
    if (want) state = want;
    return json(res, 200, { state });
  }

  if (path === "/auth/google") {
    state = "onboarding";
    const next = url.searchParams.get("next") ?? "/";
    res.writeHead(302, { location: next.startsWith("/") ? next : "/" });
    return res.end();
  }
  if (path === "/auth/signout") { state = "signedout"; return empty(res); }

  if (path === "/api/me") return json(res, 200, me());
  if (path.startsWith("/api/handles/")) {
    const h = decodeURIComponent(path.slice("/api/handles/".length)).toLowerCase();
    if (!HANDLE_RE.test(h)) return json(res, 200, { available: false, reason: "invalid" });
    if (reserved.has(h)) return json(res, 200, { available: false, reason: "reserved" });
    if (takenHandles.has(h)) return json(res, 200, { available: false, reason: "taken" });
    return json(res, 200, { available: true });
  }
  if (path === "/api/signup" && req.method === "POST") {
    const body = await readBody(req);
    const h = String(body.handle ?? "").toLowerCase();
    if (takenHandles.has(h)) return json(res, 409, { error: "handle_taken" });
    takenHandles.add(h);
    state = "onboarded";
    const out = me();
    out.user.handle = h;
    out.user.displayName = String(body.displayName ?? out.user.displayName);
    out.player.displayName = out.user.displayName;
    return json(res, 200, out);
  }
  if (path === "/api/account/delete" && req.method === "POST") { state = "signedout"; return empty(res); }
  if (path.startsWith("/api/")) return json(res, 200, passthrough(path));

  // static, with the SPA fallback the Worker does for /signup, /rooms, /j/…
  const file = join(ROOT, path === "/" ? "index.html" : path.replace(/^\/+/, ""));
  const safe = file.startsWith(ROOT + sep) || file === ROOT;
  const target = safe && existsSync(file) && extname(file) ? file : join(ROOT, "index.html");
  try {
    const buf = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(PORT, () => console.log(`signin stub on http://localhost:${PORT}  (state=${state})`));

/**
 * Google sign-in, sessions, and the `/auth/*` routes.
 *
 * Contract: ../../ACCOUNTS-GAME-SIGNIN-2026-09-04.md §2 and §3, built against
 * the tables of gamepvp/migrations/remote-2026-09-04-accounts.sql. The owner's
 * ruling (2026-09-04) is that gamepvp forces a Google login — nobody plays
 * under a random typed name — so this file is the front half of every identity
 * the game has, and `worker/src/index.ts` is the back half.
 *
 * Three decisions worth stating up front, because each has a cheaper-looking
 * alternative that is wrong:
 *
 *  1. **Confidential client, code flow.** The ID token is fetched server-side
 *     with the client secret and verified here, rather than accepting a token
 *     the browser hands us. A browser-supplied credential is an assertion by
 *     the browser; this one is an assertion by Google.
 *
 *  2. **Stateless signed cookie, not a sessions table.** `{uid, epoch, exp}` +
 *     HMAC. Revocation is `users.session_epoch`, which is a column the account
 *     already has and a single UPDATE at deletion time — versus a table, an
 *     index, a cleanup job and a read on every request. The cost is that a
 *     session cannot be revoked individually, only all at once, which is
 *     exactly what §2 asks for.
 *
 *  3. **No npm dependency.** RS256 against Google's JWKS is ~40 lines of
 *     WebCrypto (DESIGN.md §8: no deps), and a JWT library here would be a
 *     supply-chain dependency in the authentication path of the whole site.
 *
 * This file issues NO SQL of its own — every statement lives in db.ts, per that
 * file's rule 1.
 */
import {
  ID_LENGTH,
  attachGoogleSub,
  insertUser,
  nextUserNo,
  randomId,
  touchUser,
  userByEmailUnclaimed,
  userByGoogleSub,
  userById,
  type UserRow,
} from "./db.js";
import type { Platform } from "./index.js";

/* ── configuration ────────────────────────────────────────────────────────── */

/**
 * Everything sign-in needs from the environment. Optional on `Platform`: a
 * deployment without it still serves the game to grandfathered device tokens
 * and answers `/api/me` with `signedIn: false`, rather than 500ing every route
 * because a secret is missing. `/auth/*` 503s instead, which is the one place
 * the missing configuration is actually load-bearing.
 */
export interface AuthConfig {
  /** HMAC key for the session and oauth cookies. */
  sessionSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  /**
   * Local development and the headless smoke only: enables `GET /auth/dev`
   * (§3), which mints a session without Google. Set from `AUTH_DEV_BYPASS` in
   * `gamepvp/.dev.vars`, and never in production — the route 404s when unset,
   * so a deployment that forgets to unset it is the only way this can leak,
   * and that is a `wrangler secret` the owner never creates.
   */
  devBypass: boolean;
}

/**
 * Device players created before this instant keep working without a session:
 * the headless smoke's demo tokens, and the sable/augie stand-ins that predate
 * accounts. Nothing else — a device token whose player was created after it
 * gets 401 `sign_in_required` from `POST /api/identity`, and a player is never
 * created without a session. Frozen deliberately: this is not a feature flag,
 * it is the seam between two eras of the identity model, and moving it forward
 * would silently reopen anonymous sign-up.
 */
export const ACCOUNTS_CUTOFF = "2026-09-05T00:00:00Z";

const ACCOUNTS_CUTOFF_MS = Date.parse(ACCOUNTS_CUTOFF);

/** Was this player row made before the cutoff, i.e. grandfathered? */
export function isGrandfathered(createdAt: string): boolean {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && t < ACCOUNTS_CUTOFF_MS;
}

export const SESSION_COOKIE = "mjrc_session";
export const OAUTH_COOKIE = "mjrc_oauth";

const SESSION_TTL_S = 30 * 24 * 60 * 60;
/** Re-issue the cookie once less than this remains, so an active player is
 *  never signed out mid-session by an expiry they could not see coming. */
const SESSION_REFRESH_S = 7 * 24 * 60 * 60;
const OAUTH_TTL_S = 10 * 60;

const MAX_DISPLAY_NAME = 40;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
/** Google emits both spellings and has done for years. Both are correct. */
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/* ── base64url and HMAC ───────────────────────────────────────────────────── */

const encoder = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const bin = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const encodeJson = (value: unknown): string => b64urlEncode(encoder.encode(JSON.stringify(value)));

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/** Length-independent compare — the same rule `verifyReplayToken` follows, for
 *  the same reason: a cookie is a capability, and leaking how many leading
 *  characters of a forgery were right leaks the capability. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>` — §2's exact shape,
 *  used for both cookies this file mints. */
export async function signPayload(secret: string, payload: unknown): Promise<string> {
  const body = encodeJson(payload);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyPayload<T>(secret: string, token: string): Promise<T | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  if (!constantTimeEqual(token.slice(dot + 1), b64urlEncode(new Uint8Array(sig)))) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

/* ── cookies ──────────────────────────────────────────────────────────────── */

export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** `Secure` only over https, exactly like the front-door gate cookie in
 *  gamepvp/src/index.ts: a Secure cookie is silently dropped by the browser on
 *  `http://localhost`, which would make local sign-in impossible to test. */
function setCookie(request: Request, name: string, value: string, maxAgeS: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; Max-Age=${maxAgeS}; SameSite=Lax; HttpOnly${secure}`;
}

function clearCookie(request: Request, name: string): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure}`;
}

/* ── sessions ─────────────────────────────────────────────────────────────── */

export interface SessionPayload {
  uid: string;
  /** Must equal `users.session_epoch`; a bump invalidates every session. */
  epoch: number;
  /** Unix seconds. */
  exp: number;
}

export interface ResolvedSession {
  user: UserRow;
  /** A replacement `Set-Cookie` when the session was inside its refresh window
   *  (§2: refreshed when < 7 days remain), else null. */
  refresh: string | null;
}

const nowSeconds = (p: Platform): number => Math.floor(Date.parse(p.now()) / 1000);

export async function mintSessionCookie(request: Request, p: Platform, user: UserRow): Promise<string> {
  const auth = requireAuth(p);
  const payload: SessionPayload = {
    uid: user.id,
    epoch: user.session_epoch,
    exp: nowSeconds(p) + SESSION_TTL_S,
  };
  return setCookie(request, SESSION_COOKIE, await signPayload(auth.sessionSecret, payload), SESSION_TTL_S);
}

/**
 * The session behind this request, or null. Four ways to be null and every one
 * of them is silent on purpose: no cookie, a forged or malformed one, an
 * expired one, and a valid one whose account has been deleted or whose epoch
 * has moved. A signed-out caller and a caller holding a revoked cookie must be
 * indistinguishable from outside.
 */
export async function resolveSession(request: Request, p: Platform): Promise<ResolvedSession | null> {
  if (p.auth === undefined) return null;
  const raw = cookieValue(request, SESSION_COOKIE);
  if (raw === null || raw === "") return null;
  const payload = await verifyPayload<SessionPayload>(p.auth.sessionSecret, raw);
  if (payload === null || typeof payload.uid !== "string" || typeof payload.epoch !== "number") return null;
  const now = nowSeconds(p);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;

  const user = await userById(p.db, payload.uid);
  if (user === null || user.deleted_at !== null || user.session_epoch !== payload.epoch) return null;

  const refresh =
    payload.exp - now < SESSION_REFRESH_S ? await mintSessionCookie(request, p, user) : null;
  return { user, refresh };
}

/* ── Google's JWKS ────────────────────────────────────────────────────────── */

/**
 * Verification keys by `kid`, cached for as long as Google's own
 * `Cache-Control: max-age` says. Module-level, so every request on a warm
 * isolate verifies with no network call — and a cold isolate makes exactly one.
 * Keys rotate; `kid` is the whole point of the map, so a rotation is a cache
 * miss for one key rather than a failure.
 */
const jwksKeys = new Map<string, CryptoKey>();
let jwksExpiresAt = 0;

interface JwkSet {
  keys: Array<JsonWebKey & { kid?: string; alg?: string; kty?: string }>;
}

function maxAgeOf(header: string | null): number {
  const m = header === null ? null : /max-age=(\d+)/i.exec(header);
  /* 10 minutes when Google says nothing — short enough that a rotation heals
   * on its own, long enough that this is not a per-request fetch. */
  return m === null ? 600 : Number.parseInt(m[1], 10);
}

/** Exposed so the tests can install a locally generated key and never touch the
 *  network. Production never calls it. */
export function installJwksForTest(keys: ReadonlyMap<string, CryptoKey>, expiresAtMs: number): void {
  jwksKeys.clear();
  for (const [kid, key] of keys) jwksKeys.set(kid, key);
  jwksExpiresAt = expiresAtMs;
}

async function googleKey(kid: string, nowMs: number): Promise<CryptoKey | null> {
  if (nowMs < jwksExpiresAt && jwksKeys.has(kid)) return jwksKeys.get(kid) ?? null;
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) return null;
  const set = (await res.json()) as JwkSet;
  jwksKeys.clear();
  for (const jwk of set.keys ?? []) {
    if (jwk.kid === undefined || (jwk.kty !== undefined && jwk.kty !== "RSA")) continue;
    try {
      jwksKeys.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          { ...jwk, alg: "RS256", ext: true, key_ops: ["verify"] },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    } catch {
      /* One unusable key in the set must not blind us to the others. */
    }
  }
  jwksExpiresAt = nowMs + maxAgeOf(res.headers.get("cache-control")) * 1000;
  return jwksKeys.get(kid) ?? null;
}

/* ── ID tokens ────────────────────────────────────────────────────────────── */

export interface IdTokenClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  locale?: string;
}

export type IdTokenResult =
  | { ok: true; claims: IdTokenClaims }
  | { ok: false; reason: string };

/**
 * Verify a Google ID token end to end: RS256 signature against the JWKS, then
 * `iss`, `aud`, `exp`, `nonce` and `email_verified`.
 *
 * The order matters. Nothing in the payload is read as fact before the
 * signature checks out — a JWT's body is attacker-controlled until then, and
 * "decode, look at the claims, then verify" is how `alg: none` bugs happen.
 */
export async function verifyIdToken(
  token: string,
  opts: { clientId: string; nonce: string; nowMs: number },
): Promise<IdTokenResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headB64, bodyB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(headB64)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "bad_alg" };

  const key = await googleKey(header.kid, opts.nowMs);
  if (key === null) return { ok: false, reason: "unknown_kid" };

  const signed = encoder.encode(`${headB64}.${bodyB64}`);
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    b64urlDecode(sigB64),
    signed,
  );
  if (!ok) return { ok: false, reason: "bad_signature" };

  let claims: IdTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(bodyB64)));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!GOOGLE_ISSUERS.has(claims.iss)) return { ok: false, reason: "bad_iss" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) return { ok: false, reason: "bad_aud" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= opts.nowMs) return { ok: false, reason: "expired" };
  if (claims.nonce !== opts.nonce) return { ok: false, reason: "bad_nonce" };
  if (typeof claims.sub !== "string" || claims.sub === "") return { ok: false, reason: "no_sub" };
  if (typeof claims.email !== "string" || claims.email === "") return { ok: false, reason: "no_email" };
  /* Google sends the boolean; some paths have historically sent the string. */
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    return { ok: false, reason: "email_unverified" };
  }
  return { ok: true, claims };
}

/* ── resolving a Google profile to an account ─────────────────────────────── */

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  lang: string | null;
}

/**
 * §3's three-way rule, in order:
 *   1. a live account with this `google_sub` — the ordinary sign-in;
 *   2. a live account with this verified email and NO sub — the seeded user 0,
 *      which claims its own sub on Augustine's first sign-in and keeps member
 *      number 0;
 *   3. otherwise a new account at `MAX(user_no) + 1`.
 *
 * Step 2 is safe only because the email arrived inside a Google-signed token
 * with `email_verified` true; matching an unverified email here would let
 * anyone claim the owner's account by typing his address.
 */
export async function resolveUser(p: Platform, profile: GoogleProfile): Promise<UserRow> {
  const now = p.now();

  const bySub = await userByGoogleSub(p.db, profile.sub);
  if (bySub !== null) {
    await touchUser(p.db, bySub.id, now);
    return { ...bySub, last_seen_at: now };
  }

  const seeded = await userByEmailUnclaimed(p.db, profile.email);
  if (seeded !== null) {
    const claimed = await attachGoogleSub(
      p.db,
      seeded.id,
      profile.sub,
      profile.emailVerified,
      profile.picture,
      now,
    );
    if (claimed) {
      const fresh = await userById(p.db, seeded.id);
      if (fresh !== null) return fresh;
    }
    /* Lost the race for that row — fall through and make a fresh account
     * rather than returning a row somebody else's sub now owns. */
  }

  const id = randomId(p.random, ID_LENGTH);
  await insertUser(p.db, {
    id,
    userNo: await nextUserNo(p.db),
    googleSub: profile.sub,
    email: profile.email,
    emailVerified: profile.emailVerified,
    displayName: (profile.name ?? profile.email.split("@")[0] ?? "player").slice(0, MAX_DISPLAY_NAME),
    picture: profile.picture,
    signupLang: profile.lang,
    now,
  });
  const created = await userById(p.db, id);
  if (created === null) throw new Error("user row vanished immediately after insert");
  return created;
}

/* ── routes ───────────────────────────────────────────────────────────────── */

function requireAuth(p: Platform): AuthConfig {
  if (p.auth === undefined) throw new Error("auth is not configured on this platform");
  return p.auth;
}

const textFail = (code: string, status: number): Response =>
  new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * `next` is a SAME-ORIGIN PATH and nothing else. Anything starting `//` or
 * carrying a scheme is an open redirect, which turns a trusted sign-in link
 * into a phishing primitive — the classic OAuth bug, and the reason this is a
 * whitelist ("starts with one slash") rather than a blacklist.
 */
export function safeNext(raw: string | null): string {
  if (raw === null) return "/";
  const value = raw.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

const redirect = (location: string, cookies: readonly string[]): Response => {
  const res = new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
  for (const c of cookies) res.headers.append("set-cookie", c);
  return res;
};

interface OauthPayload {
  state: string;
  nonce: string;
  next: string;
  exp: number;
}

const redirectUriFor = (request: Request): string =>
  `${new URL(request.url).origin}/auth/google/callback`;

/** GET /auth/google?next=/path */
async function getAuthGoogle(request: Request, p: Platform): Promise<Response> {
  const auth = requireAuth(p);
  /* `authFromEnv` lets a dev-bypass deployment run with no Google secrets at
   * all; refuse here rather than redirecting to Google with an empty client
   * id and letting the user meet Google's own error page. */
  if (auth.googleClientId === "" || auth.googleClientSecret === "") {
    return textFail("google_not_configured", 503);
  }
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const state = randomId(p.random, 24);
  const nonce = randomId(p.random, 24);
  const payload: OauthPayload = { state, nonce, next, exp: nowSeconds(p) + OAUTH_TTL_S };
  const cookie = setCookie(
    request,
    OAUTH_COOKIE,
    await signPayload(auth.sessionSecret, payload),
    OAUTH_TTL_S,
  );

  const target = new URL(GOOGLE_AUTH_URL);
  target.searchParams.set("client_id", auth.googleClientId);
  target.searchParams.set("redirect_uri", redirectUriFor(request));
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", state);
  target.searchParams.set("nonce", nonce);
  target.searchParams.set("prompt", "select_account");
  return redirect(target.toString(), [cookie]);
}

interface TokenResponse {
  id_token?: string;
  error?: string;
}

/** GET /auth/google/callback?code&state */
async function getAuthGoogleCallback(request: Request, p: Platform): Promise<Response> {
  const auth = requireAuth(p);
  if (auth.googleClientId === "" || auth.googleClientSecret === "") {
    return textFail("google_not_configured", 503);
  }
  const url = new URL(request.url);

  const raw = cookieValue(request, OAUTH_COOKIE);
  if (raw === null) return textFail("oauth_state_missing", 400);
  const pending = await verifyPayload<OauthPayload>(auth.sessionSecret, raw);
  if (pending === null || pending.exp <= nowSeconds(p)) return textFail("oauth_state_expired", 400);

  const state = url.searchParams.get("state");
  if (state === null || !constantTimeEqual(state, pending.state)) return textFail("oauth_state_mismatch", 400);

  const code = url.searchParams.get("code");
  if (code === null || code === "") return textFail("oauth_no_code", 400);

  const form = new URLSearchParams({
    code,
    client_id: auth.googleClientId,
    client_secret: auth.googleClientSecret,
    redirect_uri: redirectUriFor(request),
    grant_type: "authorization_code",
  });
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!tokenRes.ok) return textFail("oauth_token_exchange_failed", 502);
  const tokens = (await tokenRes.json()) as TokenResponse;
  if (typeof tokens.id_token !== "string") return textFail("oauth_no_id_token", 502);

  const verified = await verifyIdToken(tokens.id_token, {
    clientId: auth.googleClientId,
    nonce: pending.nonce,
    nowMs: Date.parse(p.now()),
  });
  if (!verified.ok) return textFail(`oauth_${verified.reason}`, 401);

  const c = verified.claims;
  return signInAndRedirect(request, p, pending.next, {
    sub: c.sub,
    email: c.email!.toLowerCase(),
    emailVerified: true,
    name: typeof c.name === "string" ? c.name : null,
    picture: typeof c.picture === "string" ? c.picture : null,
    lang: languageOf(request),
  });
}

/**
 * GET /auth/dev?email&name — the callback with Google removed. Exists so the
 * browser and `gamepvp/test/smoke.mjs` can sign in against `wrangler dev`
 * without a real OAuth round trip, and so the sign-in path itself is covered
 * by the smoke rather than only by unit tests. 404 (not 403) when the bypass is
 * off: an attacker probing a production deployment learns nothing.
 */
async function getAuthDev(request: Request, p: Platform): Promise<Response> {
  const auth = requireAuth(p);
  if (!auth.devBypass) return textFail("not_found", 404);
  const url = new URL(request.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  if (email === "" || !email.includes("@")) return textFail("bad_email", 400);
  const name = (url.searchParams.get("name") ?? "").trim();
  return signInAndRedirect(request, p, safeNext(url.searchParams.get("next")), {
    /* Namespaced so a dev account can never collide with a real Google sub. */
    sub: `dev:${email}`,
    email,
    emailVerified: true,
    name: name === "" ? null : name.slice(0, MAX_DISPLAY_NAME),
    picture: null,
    lang: languageOf(request),
  });
}

/** `Accept-Language`, first tag only, and never `request.cf` — the account spec
 *  is explicit that signup language is what the browser asked for, not where
 *  the IP happens to be. */
function languageOf(request: Request): string | null {
  const header = request.headers.get("accept-language");
  if (header === null) return null;
  const first = header.split(",")[0]?.trim().split(";")[0]?.trim() ?? "";
  return first === "" ? null : first.slice(0, 16);
}

async function signInAndRedirect(
  request: Request,
  p: Platform,
  next: string,
  profile: GoogleProfile,
): Promise<Response> {
  const user = await resolveUser(p, profile);
  const cookie = await mintSessionCookie(request, p, user);
  /* Sign-up is not finished until a handle exists, and every screen past this
   * point assumes one — so an un-onboarded account goes to /signup and carries
   * `next` through it, rather than landing on a lobby it cannot be listed in. */
  const target =
    user.onboarded_at === null ? `/signup?next=${encodeURIComponent(next)}` : next;
  return redirect(target, [cookie, clearCookie(request, OAUTH_COOKIE)]);
}

/** The `Set-Cookie` that signs a browser out. Exported because account
 *  deletion (worker/src/index.ts) must clear the cookie too, and there should
 *  be exactly one place that knows the cookie's attributes. */
export function clearSessionCookie(request: Request): string {
  return clearCookie(request, SESSION_COOKIE);
}

/** POST /auth/signout — clears the cookie. The session is stateless, so there
 *  is nothing server-side to delete; account deletion is what revokes. */
function postSignout(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": clearCookie(request, SESSION_COOKIE), "cache-control": "no-store" },
  });
}

/**
 * The `/auth/*` router. Returns `null` for a path this file does not own, so
 * the caller (gamepvp/src/index.ts) can fall through to assets — same shape as
 * the platform's own `handle`, one level up.
 */
export async function handleAuth(request: Request, p: Platform): Promise<Response | null> {
  const url = new URL(request.url);
  const seg = url.pathname.split("/").filter((s) => s !== "");
  if (seg[0] !== "auth") return null;

  const method = request.method.toUpperCase();

  if (seg.length === 2 && seg[1] === "signout") {
    if (method !== "POST") return textFail("method_not_allowed", 405);
    return postSignout(request);
  }

  if (p.auth === undefined) return textFail("auth_not_configured", 503);

  if (seg.length === 2 && seg[1] === "google") {
    if (method !== "GET") return textFail("method_not_allowed", 405);
    return getAuthGoogle(request, p);
  }
  if (seg.length === 3 && seg[1] === "google" && seg[2] === "callback") {
    if (method !== "GET") return textFail("method_not_allowed", 405);
    return getAuthGoogleCallback(request, p);
  }
  if (seg.length === 2 && seg[1] === "dev") {
    if (method !== "GET") return textFail("method_not_allowed", 405);
    return getAuthDev(request, p);
  }

  return textFail("not_found", 404);
}

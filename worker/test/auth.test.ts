/**
 * Accounts — the sign-in half of the service (../src/auth.ts) and the four
 * routes it gates in ../src/index.ts. Contract:
 * ../../ACCOUNTS-GAME-SIGNIN-2026-09-04.md.
 *
 * Everything here runs against the shared fakes in ./harness.ts and against a
 * locally generated RSA key standing in for Google's JWKS, so the suite never
 * makes a network call and still exercises the real RS256 verification path —
 * the one piece of this feature where "probably fine" is not good enough.
 *
 * The five properties under test are the security properties, not the features:
 * a forged cookie is rejected, a forged ID token is rejected, an anonymous
 * device token can no longer mint a player, deleting an account really does
 * invalidate its outstanding sessions, and the seeded owner account cannot be
 * claimed by an unverified email.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Platform } from "../src/index.js";
import { handle } from "../src/index.js";
import {
  ACCOUNTS_CUTOFF,
  SESSION_COOKIE,
  b64urlEncode,
  handleAuth,
  installJwksForTest,
  safeNext,
  signPayload,
  verifyIdToken,
  verifyPayload,
} from "../src/auth.js";
import { sha256Hex } from "../src/db.js";
import type { Harness } from "./harness.js";
import { get, harness, post, signIn } from "./harness.js";

const SESSION_SECRET = "test-session-secret-that-is-long-enough-32";

const TOKEN_OLD = "grandfathered-token-0123456789abcdef";
const TOKEN_NEW = "post-cutoff-token-0123456789abcdefgh";

/* ── helpers ──────────────────────────────────────────────────────────────── */

const jsonOf = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

/** Push a player and its device credential straight into the store, with an
 *  exact `created_at` — the only way to build a player on the far side of
 *  `ACCOUNTS_CUTOFF`, since no route will make one any more. */
async function seedDevicePlayer(
  h: Harness,
  opts: { id: string; token: string; createdAt: string; name?: string; userId?: string | null },
): Promise<void> {
  h.store.players.push({
    id: opts.id,
    kind: "human",
    display_name: opts.name ?? "Legacy",
    avatar: null,
    bot_policy: null,
    rating: null,
    rating_games: 0,
    rating_season: null,
    almanac_user_id: opts.userId ?? null,
    almanac_link_source: null,
    almanac_linked_at: null,
    tz_offset_min: 0,
    created_at: opts.createdAt,
    updated_at: opts.createdAt,
    last_seen_at: opts.createdAt,
    deleted_at: null,
  });
  h.store.player_credentials.push({
    id: await sha256Hex(opts.token),
    player_id: opts.id,
    kind: "device",
    label: null,
    public_key: null,
    sign_count: 0,
    created_at: opts.createdAt,
    last_used_at: opts.createdAt,
    revoked_at: null,
  });
}

/* ── the session cookie (§2) ──────────────────────────────────────────────── */

describe("the session cookie", () => {
  it("round-trips a payload and rejects every tampered form of it", async () => {
    const payload = { uid: "USER123", epoch: 0, exp: 2_000_000_000 };
    const token = await signPayload(SESSION_SECRET, payload);
    expect(await verifyPayload(SESSION_SECRET, token)).toEqual(payload);

    const [body, sig] = token.split(".") as [string, string];
    /* A different body under the same signature. */
    const forgedBody = b64urlEncode(
      new TextEncoder().encode(JSON.stringify({ ...payload, uid: "USER999" })),
    );
    expect(await verifyPayload(SESSION_SECRET, `${forgedBody}.${sig}`)).toBeNull();
    /* A flipped signature. */
    const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(await verifyPayload(SESSION_SECRET, `${body}.${flipped}`)).toBeNull();
    /* Another server's key. */
    expect(await verifyPayload(`${SESSION_SECRET}-other`, token)).toBeNull();
    /* Structurally wrong. */
    expect(await verifyPayload(SESSION_SECRET, body)).toBeNull();
    expect(await verifyPayload(SESSION_SECRET, `${body}.${sig}.${sig}`)).toBeNull();
  });

  it("refuses a forged cookie at the route boundary, not merely in the helper", async () => {
    const h = harness();
    await signIn(h, "forge@example.test", "Forge");
    const payload = { uid: h.store.users[0].id as string, epoch: 0, exp: 2_000_000_000 };
    const unsigned = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    const res = await handle(
      get("/api/me", undefined, `${SESSION_COOKIE}=${unsigned}.notasignature`),
      h.platform,
    );
    expect(await jsonOf(res)).toMatchObject({ signedIn: false });
  });

  it("stops verifying once the account's epoch moves", async () => {
    const h = harness();
    const cookie = await signIn(h, "epoch@example.test", "Epoch");
    expect(await jsonOf(await handle(get("/api/me", undefined, cookie), h.platform))).toMatchObject({
      signedIn: true,
    });
    h.store.users[0].session_epoch = 1;
    expect(await jsonOf(await handle(get("/api/me", undefined, cookie), h.platform))).toMatchObject({
      signedIn: false,
    });
  });
});

describe("safeNext", () => {
  it("keeps same-origin paths and flattens everything else to /", () => {
    expect(safeNext("/rooms/ABC")).toBe("/rooms/ABC");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
  });
});

/* ── ID tokens (§3) ───────────────────────────────────────────────────────── */

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const NONCE = "test-nonce-value";
const NOW_MS = Date.parse("2026-09-04T12:00:00.000Z");

interface Signer {
  sign(header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string>;
}

/** A local RSA key installed as if it were Google's JWKS. The signature path
 *  under test is the real one — same algorithm, same `kid` lookup, same
 *  WebCrypto verify — only the key's provenance differs. */
async function fakeGoogle(kid = "test-kid"): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const pub = await crypto.subtle.importKey(
    "jwk",
    { ...jwk, alg: "RS256", ext: true, key_ops: ["verify"] },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  installJwksForTest(new Map([[kid, pub]]), NOW_MS + 3_600_000);
  const enc = (v: unknown): string => b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
  return {
    async sign(header, claims) {
      const signed = `${enc({ alg: "RS256", kid, ...header })}.${enc(claims)}`;
      const sig = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(signed),
      );
      return `${signed}.${b64urlEncode(new Uint8Array(sig))}`;
    },
  };
}

const goodClaims = () => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "1029384756",
  exp: Math.floor(NOW_MS / 1000) + 3600,
  nonce: NONCE,
  email: "player@example.test",
  email_verified: true,
  name: "A Player",
  picture: "https://lh3.example/photo",
});

describe("Google ID tokens", () => {
  const opts = { clientId: CLIENT_ID, nonce: NONCE, nowMs: NOW_MS };

  it("accepts a well-formed token signed by the advertised key", async () => {
    const g = await fakeGoogle();
    const result = await verifyIdToken(await g.sign({}, goodClaims()), opts);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe("1029384756");
  });

  it("accepts the bare-hostname issuer Google also emits", async () => {
    const g = await fakeGoogle();
    const token = await g.sign({}, { ...goodClaims(), iss: "accounts.google.com" });
    expect((await verifyIdToken(token, opts)).ok).toBe(true);
  });

  it("rejects a token whose payload was edited after signing", async () => {
    const g = await fakeGoogle();
    const token = await g.sign({}, goodClaims());
    const [h, , s] = token.split(".") as [string, string, string];
    const forged = b64urlEncode(
      new TextEncoder().encode(JSON.stringify({ ...goodClaims(), sub: "someone-else" })),
    );
    const result = await verifyIdToken(`${h}.${forged}.${s}`, opts);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects the wrong issuer, audience, nonce, expiry, algorithm and kid", async () => {
    const g = await fakeGoogle();
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
      [{}, { iss: "https://evil.example" }, "bad_iss"],
      [{}, { aud: "another-client.apps.googleusercontent.com" }, "bad_aud"],
      [{}, { nonce: "not-the-nonce" }, "bad_nonce"],
      [{}, { exp: Math.floor(NOW_MS / 1000) - 1 }, "expired"],
      [{}, { email_verified: false }, "email_unverified"],
      [{}, { email: undefined }, "no_email"],
      [{ alg: "none" }, {}, "bad_alg"],
      [{ kid: "some-other-kid" }, {}, "unknown_kid"],
    ];
    for (const [header, claims, reason] of cases) {
      const token = await g.sign(header, { ...goodClaims(), ...claims });
      /* `unknown_kid` would otherwise try to fetch the real JWKS; the cache is
       * warm and unexpired, so `googleKey` answers from it and returns null. */
      expect(await verifyIdToken(token, opts), reason).toEqual({ ok: false, reason });
    }
  });

  it("rejects a token that is not three dot-separated parts", async () => {
    await fakeGoogle();
    expect(await verifyIdToken("not.a.jwt.at.all", opts)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyIdToken("nope", opts)).toEqual({ ok: false, reason: "malformed" });
  });
});

/* ── /auth/dev ────────────────────────────────────────────────────────────── */

describe("GET /auth/dev", () => {
  it("404s when AUTH_DEV_BYPASS is unset", async () => {
    const h = harness();
    const p: Platform = { ...h.platform, auth: { ...h.platform.auth!, devBypass: false } };
    const res = await handleAuth(
      new Request("https://game.mahjongresearch.com/auth/dev?email=x@example.test"),
      p,
    );
    expect(res?.status).toBe(404);
  });

  it("sends a brand-new account to /signup and an onboarded one to next", async () => {
    const h = harness();
    const first = await handleAuth(
      new Request("https://game.mahjongresearch.com/auth/dev?email=a@example.test&next=/rooms/ABC"),
      h.platform,
    );
    expect(first?.status).toBe(302);
    expect(first?.headers.get("location")).toBe("/signup?next=%2Frooms%2FABC");

    h.store.users[0].onboarded_at = "2026-08-26T00:00:00.000Z";
    const again = await handleAuth(
      new Request("https://game.mahjongresearch.com/auth/dev?email=a@example.test&next=/rooms/ABC"),
      h.platform,
    );
    expect(again?.headers.get("location")).toBe("/rooms/ABC");
  });

  it("signs out by clearing the cookie", async () => {
    const h = harness();
    const res = await handleAuth(
      new Request("https://game.mahjongresearch.com/auth/signout", { method: "POST" }),
      h.platform,
    );
    expect(res?.status).toBe(204);
    expect(res?.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
  });
});

/* ── the seeded owner account (§1, §3) ────────────────────────────────────── */

describe("user 0", () => {
  it("attaches the Google sub to the seeded row on the owner's first sign-in", async () => {
    const h = harness();
    h.store.users.push({
      id: "USER0AUGWALTS000",
      user_no: 0,
      google_sub: null,
      email: "augwalts@gmail.com",
      email_verified: 0,
      handle: null,
      display_name: "augie",
      picture: null,
      is_admin: 1,
      signup_lang: null,
      signup_source: null,
      onboarded_at: null,
      session_epoch: 0,
      created_at: "2026-09-04T00:00:00.000Z",
      updated_at: "2026-09-04T00:00:00.000Z",
      last_seen_at: "2026-09-04T00:00:00.000Z",
      deleted_at: null,
    });

    const cookie = await signIn(h, "augwalts@gmail.com", "Augustine");
    expect(h.store.users).toHaveLength(1);
    expect(h.store.users[0].id).toBe("USER0AUGWALTS000");
    expect(h.store.users[0].google_sub).toBe("dev:augwalts@gmail.com");

    const me = await jsonOf(await handle(get("/api/me", undefined, cookie), h.platform));
    expect(me.user).toMatchObject({ userNo: 0, isAdmin: true, email: "augwalts@gmail.com" });
  });

  it("gives the next account MAX(user_no) + 1", async () => {
    const h = harness();
    await signIn(h, "one@example.test");
    await signIn(h, "two@example.test");
    expect(h.store.users.map((u) => u.user_no)).toEqual([0, 1]);
  });
});

/* ── the grandfather rule (§3) ────────────────────────────────────────────── */

describe("POST /api/identity without a session", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("still serves a device player created before the cutoff", async () => {
    await seedDevicePlayer(h, { id: "OLDPLAYER0000001", token: TOKEN_OLD, createdAt: "2026-09-01T00:00:00.000Z" });
    const res = await handle(post("/api/identity", { deviceToken: TOKEN_OLD }), h.platform);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ playerId: "OLDPLAYER0000001", created: false });
  });

  it("refuses a device player created after the cutoff", async () => {
    await seedDevicePlayer(h, { id: "NEWPLAYER0000001", token: TOKEN_NEW, createdAt: "2026-09-06T00:00:00.000Z" });
    const res = await handle(post("/api/identity", { deviceToken: TOKEN_NEW }), h.platform);
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toEqual({ error: "sign_in_required" });
  });

  it("never creates a player for an unseen token, however well-formed", async () => {
    const res = await handle(
      post("/api/identity", { deviceToken: "0123456789abcdef0123456789abcdef", displayName: "Nobody" }),
      h.platform,
    );
    expect(res.status).toBe(401);
    expect(h.store.players).toHaveLength(0);
  });

  it("refuses a request with no token at all", async () => {
    const res = await handle(post("/api/identity", { displayName: "Nobody" }), h.platform);
    expect(res.status).toBe(401);
  });

  it("puts the cutoff where the contract says", () => {
    expect(ACCOUNTS_CUTOFF).toBe("2026-09-05T00:00:00Z");
  });
});

/* ── handles (§3) ─────────────────────────────────────────────────────────── */

describe("GET /api/handles/:handle", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  const check = async (handleName: string): Promise<Record<string, unknown>> =>
    jsonOf(await handle(get(`/api/handles/${handleName}`), h.platform));

  it("accepts a well-formed handle", async () => {
    expect(await check("ah_ming7")).toEqual({ available: true });
  });

  it("refuses the reserved words", async () => {
    for (const word of ["admin", "mjrc", "augie", "sable", "open", "hall", "bot"]) {
      expect(await check(word), word).toEqual({ available: false, reason: "reserved" });
    }
  });

  it("refuses anything outside ^[a-z0-9_]{3,20}$", async () => {
    for (const bad of ["ab", "a".repeat(21), "has-dash", "has space", "Ünicode", "dot.dot"]) {
      expect(await check(bad), bad).toEqual({ available: false, reason: "invalid" });
    }
  });

  it("lowercases before judging, so ALICE and alice are one handle", async () => {
    await signUp(h, await signIn(h, "alice@example.test", "Alice"), { handle: "alice" });
    expect(await check("ALICE")).toEqual({ available: false, reason: "taken" });
  });
});

/* ── sign-up (§3) ─────────────────────────────────────────────────────────── */

interface SignUpOverrides {
  handle?: string;
  displayName?: string;
  deviceToken?: string;
  language?: string;
  source?: string;
  consents?: Record<string, unknown>;
}

async function signUp(h: Harness, cookie: string, o: SignUpOverrides = {}): Promise<Response> {
  return handle(
    post(
      "/api/signup",
      {
        displayName: o.displayName ?? "Ah Ming",
        handle: o.handle ?? "ah_ming",
        language: o.language ?? "en",
        consents: o.consents ?? { terms: true, privacy: true, marketing: false },
        ...(o.deviceToken === undefined ? {} : { deviceToken: o.deviceToken }),
        ...(o.source === undefined ? {} : { source: o.source }),
      },
      undefined,
      cookie,
    ),
    h.platform,
  );
}

describe("POST /api/signup", () => {
  let h: Harness;
  let cookie: string;
  beforeEach(async () => {
    h = harness();
    cookie = await signIn(h, "ahming@example.test", "Ah Ming");
  });

  it("refuses without a session", async () => {
    const res = await handle(
      post("/api/signup", { displayName: "X", handle: "xxx", language: "en", consents: { terms: true, privacy: true, marketing: false } }),
      h.platform,
    );
    expect(res.status).toBe(401);
  });

  it("creates a player, writes the handle, the consents and the source", async () => {
    const res = await signUp(h, cookie, { source: "/r/ABC123" });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ signedIn: true });
    expect(body.user).toMatchObject({ handle: "ah_ming", onboarded: true, language: "en" });
    expect(body.player).toMatchObject({ displayName: "Ah Ming" });
    /* The browser gets a device token it did not have, and it is a mint, not
     * anything the client chose. */
    expect(body.deviceToken).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);

    expect(h.store.users[0].signup_source).toBe("/r/ABC123");
    expect(h.store.consents.map((c) => [c.kind, c.granted, c.source])).toEqual([
      ["terms", 1, "signup"],
      ["privacy", 1, "signup"],
      ["marketing", 0, "signup"],
    ]);
    expect(h.store.players).toHaveLength(1);
    expect(h.store.players[0].almanac_user_id).toBe(h.store.users[0].id);
  });

  it("adopts the device player this browser already had, history and all", async () => {
    await seedDevicePlayer(h, {
      id: "LEGACYPLAYER0001",
      token: TOKEN_OLD,
      createdAt: "2026-09-01T00:00:00.000Z",
      name: "Old Name",
    });
    const res = await signUp(h, cookie, { deviceToken: TOKEN_OLD });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.player).toMatchObject({ playerId: "LEGACYPLAYER0001", displayName: "Ah Ming" });
    /* Adopted, not duplicated — and the token the browser already holds is
     * still the token, so nothing is minted. */
    expect(h.store.players).toHaveLength(1);
    expect(h.store.players[0].almanac_user_id).toBe(h.store.users[0].id);
    expect(h.store.players[0].almanac_link_source).toBe("sign_in");
    expect(body.deviceToken).toBeNull();
  });

  it("will not steal a device player that already belongs to somebody else", async () => {
    const other = await signIn(h, "other@example.test", "Other");
    await signUp(h, other, { handle: "other_one" });
    const stolenToken = (await jsonOf(await handle(get("/api/me", undefined, other), h.platform)))
      .deviceToken as string;

    const res = await signUp(h, cookie, { deviceToken: stolenToken });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect((body.player as { playerId: string }).playerId).not.toBe(h.store.players[0].id);
    expect(h.store.players).toHaveLength(2);
    /* And the thief gets a token of their own rather than the one they sent. */
    expect(body.deviceToken).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
  });

  it("refuses a second sign-up for the same account", async () => {
    expect((await signUp(h, cookie)).status).toBe(201);
    const again = await signUp(h, cookie, { handle: "other_name" });
    expect(again.status).toBe(409);
    expect(await jsonOf(again)).toEqual({ error: "already_onboarded" });
  });

  it("refuses a handle somebody else already holds", async () => {
    await signUp(h, await signIn(h, "first@example.test", "First"), { handle: "ah_ming" });
    const res = await signUp(h, cookie, { handle: "ah_ming" });
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toEqual({ error: "handle_taken" });
  });

  it("refuses a reserved handle, a bad language and a missing consent", async () => {
    expect((await signUp(h, cookie, { handle: "admin" })).status).toBe(400);
    expect((await signUp(h, cookie, { language: "fr" })).status).toBe(400);
    expect(
      (await signUp(h, cookie, { consents: { terms: true, privacy: false, marketing: false } })).status,
    ).toBe(400);
    expect(h.store.users[0].onboarded_at).toBeNull();
  });
});

/* ── GET /api/me (§3) ─────────────────────────────────────────────────────── */

describe("GET /api/me", () => {
  it("answers the signed-out shape with no cookie", async () => {
    const h = harness();
    expect(await jsonOf(await handle(get("/api/me"), h.platform))).toEqual({
      signedIn: false,
      user: null,
      player: null,
      deviceToken: null,
    });
  });

  it("reports a signed-in but un-onboarded account with no player", async () => {
    const h = harness();
    const cookie = await signIn(h, "new@example.test", "New");
    const body = await jsonOf(await handle(get("/api/me", undefined, cookie), h.platform));
    expect(body).toMatchObject({ signedIn: true, player: null, deviceToken: null });
    expect(body.user).toMatchObject({ onboarded: false, handle: null });
  });

  it("mints a device token once, then stops when the browser presents it", async () => {
    const h = harness();
    const cookie = await signIn(h, "mint@example.test", "Mint");
    await signUp(h, cookie);
    const first = await jsonOf(await handle(get("/api/me", undefined, cookie), h.platform));
    const token = first.deviceToken as string;
    expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);

    const second = await jsonOf(await handle(get("/api/me", token, cookie), h.platform));
    expect(second.deviceToken).toBeNull();
    expect((second.player as { playerId: string }).playerId).toBe(
      (first.player as { playerId: string }).playerId,
    );
  });
});

/* ── deletion (§3, ACCOUNTS-BUILD-SPEC.md §9.3) ───────────────────────────── */

describe("POST /api/account/delete", () => {
  it("scrubs in place, releases the handle, and invalidates every session", async () => {
    const h = harness();
    const cookie = await signIn(h, "bye@example.test", "Bye");
    await signUp(h, cookie, { handle: "bye_bye" });
    const playerId = h.store.players[0].id as string;

    const res = await handle(post("/api/account/delete", {}, undefined, cookie), h.platform);
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);

    const user = h.store.users[0];
    expect(user).toMatchObject({
      email: "deleted",
      google_sub: null,
      handle: null,
      display_name: "deleted user",
      picture: null,
      session_epoch: 1,
    });
    expect(user.deleted_at).not.toBeNull();
    expect(h.store.handle_history).toEqual([
      { handle: "bye_bye", user_id: user.id, released_at: expect.any(String) },
    ]);

    const player = h.store.players.find((p) => p.id === playerId)!;
    expect(player).toMatchObject({ display_name: "deleted player", avatar: null });
    expect(player.deleted_at).not.toBeNull();
    expect(h.store.player_credentials.every((c) => c.revoked_at !== null)).toBe(true);

    /* The cookie the browser is still holding no longer verifies. */
    expect(await jsonOf(await handle(get("/api/me", undefined, cookie), h.platform))).toMatchObject({
      signedIn: false,
    });
  });

  it("keeps the released handle unavailable to the next person", async () => {
    const h = harness();
    const cookie = await signIn(h, "gone@example.test", "Gone");
    await signUp(h, cookie, { handle: "gone_now" });
    await handle(post("/api/account/delete", {}, undefined, cookie), h.platform);
    expect(await jsonOf(await handle(get("/api/handles/gone_now"), h.platform))).toEqual({
      available: false,
      reason: "taken",
    });
  });

  it("refuses without a session", async () => {
    const h = harness();
    expect((await handle(post("/api/account/delete", {}), h.platform)).status).toBe(401);
  });
});

/* ── POST /api/identity with a session ────────────────────────────────────── */

describe("POST /api/identity with a session", () => {
  it("resolves to the account's player and mirrors a rename onto the account", async () => {
    const h = harness();
    const cookie = await signIn(h, "rename@example.test", "Before");
    await signUp(h, cookie, { displayName: "Before", handle: "before_x" });
    const playerId = h.store.players[0].id as string;

    const res = await handle(
      post("/api/identity", { displayName: "After" }, undefined, cookie),
      h.platform,
    );
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({ playerId, displayName: "After", created: false });
    expect(h.store.players[0].display_name).toBe("After");
    expect(h.store.users[0].display_name).toBe("After");
  });

  it("creates and links a player for an account that has none yet", async () => {
    const h = harness();
    const cookie = await signIn(h, "fresh@example.test", "Fresh");
    const res = await handle(post("/api/identity", {}, undefined, cookie), h.platform);
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body).toMatchObject({ created: true, displayName: "Fresh" });
    expect(body.deviceToken).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
    expect(h.store.players[0].almanac_user_id).toBe(h.store.users[0].id);
  });
});

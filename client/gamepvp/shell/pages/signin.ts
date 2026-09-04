/**
 * The sign-in screen (ACCOUNTS-GAME-SIGNIN-2026-09-04 §4) — the ONLY thing a
 * signed-out visitor can ever see. Not a route so much as a state: the router
 * renders this in place of whatever path was asked for whenever
 * `session.authState === "signed-out"`, carrying that path through as `next`
 * so Google's callback lands the player back where they were headed (an
 * invite link included — `/j/<code>` and `/r/<code>` survive the round trip).
 *
 * Deliberately dumb: the sign-in button is a PLAIN `<a href>`, not a fetch.
 * OAuth is a browser redirect — a `fetch` to `/auth/google` would follow the
 * 302 to Google inside XHR and get nowhere. There is no form, no state, and
 * nothing to submit; everything that decides anything lives on the Worker.
 *
 * The Google glyph is inline SVG (a lettermark, not Google's own logo art) —
 * the contract's "no external assets" rule, and a remote image here would
 * also be the one thing on screen that could fail to load.
 */
import type { PageMount } from "../router.js";
import { esc } from "../session.js";
import { S, t, tAlt } from "../strings.js";

export const TERMS_URL = "https://mahjongresearch.com/terms";
export const PRIVACY_URL = "https://mahjongresearch.com/privacy";

const G_GLYPH =
  '<svg class="si-g" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<circle cx="10" cy="10" r="9.25" fill="#fff"/>' +
  '<text x="10" y="14.6" text-anchor="middle" font-size="13.5" font-weight="700" fill="var(--si-blue)"' +
  ' font-family="Arial,Helvetica,sans-serif">G</text></svg>';

/** Same-origin paths only — `next` reaches this page from the URL bar. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export const mount: PageMount = (container, params) => {
  const next = safeNext(params.next);
  const altLede = tAlt(S.signInLede);
  container.innerHTML = `
    <div class="si-wrap">
      <div class="si-card">
        <div class="si-mark">${esc(t(S.siteMark))}</div>
        <p class="si-lede">${esc(t(S.signInLede))}</p>
        ${altLede ? `<p class="si-lede si-alt">${esc(altLede)}</p>` : ""}
        <a class="si-google" href="/auth/google?next=${encodeURIComponent(next)}">
          ${G_GLYPH}<span>${esc(t(S.signInWithGoogle))}</span>
        </a>
        <p class="si-legal">
          <a href="${TERMS_URL}" target="_blank" rel="noopener">${esc(t(S.termsLink))}</a>
          <span aria-hidden="true">·</span>
          <a href="${PRIVACY_URL}" target="_blank" rel="noopener">${esc(t(S.privacyLink))}</a>
        </p>
      </div>
    </div>`;
};

/**
 * Shared app-wide state: identity, presence heartbeat, local settings, theme,
 * chat mute list, and the handful of tiny DOM/format helpers both `table.ts`
 * (the match runtime) and every `shell/` page import. Nothing here has any
 * game authority or gameplay behaviour of its own — it is state and plumbing
 * that happens to be needed on both sides of "is a match open right now".
 *
 * Kept dependency-light on purpose: `table.ts` imports from here, `shell/`
 * pages import from here, and this file imports only `net.ts` — never the
 * other way around, so there is no import cycle between the table runtime
 * and the shell.
 */
import {
  ApiError, identify as apiIdentify, getMe, identityFromMe, postPresence, rememberMe,
  type Identity, type MeUser, type PresenceState,
} from "../net.js";
import { RequestRejected } from "../net.js";

export const $ = (id: string): HTMLElement => document.getElementById(id)!;
export const fmtChips = (n: number): string => `${n > 0 ? "+" : ""}${n}`;
/** Free-text (a display name, a chat line) lands in `innerHTML` all over this
 *  client — escape it first. */
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.code;
  if (e instanceof RequestRejected) return e.code;
  if (e instanceof Error) return e.message;
  return String(e);
}

/* ── identity ──────────────────────────────────────────────────────────── */
export let identity: Identity | null = null;
export function setIdentity(id: Identity | null): void { identity = id; }

/** The client's UTC offset in minutes (JS convention: `getTimezoneOffset()`
 *  is positive WEST of UTC — e.g. +300 for UTC-5), sent on `identify` and
 *  every presence heartbeat (task brief §11.5) so streaks and "today" count
 *  in the player's own day, not the server's. */
export const tzOffsetMin = (): number => new Date().getTimezoneOffset();

export async function identify(displayName: string): Promise<Identity> {
  const id = await apiIdentify(displayName, tzOffsetMin());
  identity = id;
  return id;
}

/* ── who is signed in (ACCOUNTS-GAME-SIGNIN-2026-09-04 §4) ───────────────
 * Three states, and every screen in the shell depends on which one we are
 * in — shell/router.ts reads `authState` on every dispatch:
 *
 *   "signed-out"    → the sign-in screen, whatever path was asked for
 *   "needs-signup"  → /signup (a Google session exists, onboarding does not)
 *   "ready"         → the app, exactly as before
 *
 * `account` is the USER (email, handle, member number); `identity` is the
 * PLAYER (the thing every `/api/*` Bearer call and the table runtime use).
 * They are separate on purpose: a signed-in user has no player until
 * sign-up finishes, and `table.ts` must never learn about accounts. */
export type AuthState = "signed-out" | "needs-signup" | "ready";
export let authState: AuthState = "signed-out";
export let account: MeUser | null = null;
export function setAuthState(s: AuthState): void { authState = s; }
export function setAccount(u: MeUser | null): void { account = u; }

/**
 * The boot decision, one call: `GET /api/me`.
 *
 *   not signed in / call failed  → "signed-out"   (fail CLOSED: the contract
 *                                  forbids anonymous players, so an
 *                                  unreachable server shows sign-in rather
 *                                  than a half-working offline app)
 *   signed in, `onboarded:false` → "needs-signup"
 *   signed in, onboarded         → "ready", identity restored from the same
 *                                  response, falling back to
 *                                  `POST /api/identity` if the server sent no
 *                                  player/token pair with it
 *
 * The server-minted `deviceToken` is stored whenever one comes back, in every
 * signed-in branch — that is the token every other `/api/*` call keeps using.
 */
export async function bootIdentity(): Promise<AuthState> {
  let me;
  try {
    me = await getMe();
  } catch {
    authState = "signed-out"; account = null; identity = null;
    return authState;
  }
  if (!me.signedIn || !me.user) {
    authState = "signed-out"; account = null; identity = null;
    return authState;
  }
  account = me.user;
  rememberMe(me);
  if (me.user.language && me.user.language !== SETTINGS.language) {
    SETTINGS.language = me.user.language;
    localStorage.setItem("mjrc.gamepvp.settings", JSON.stringify(SETTINGS));
  }
  if (!me.user.onboarded) {
    authState = "needs-signup"; identity = null;
    return authState;
  }
  identity = identityFromMe(me);
  if (!identity) {
    // Signed in and onboarded but the response carried no player/token —
    // `POST /api/identity` resolves (and links) the user's player, §3.
    try { identity = await apiIdentify(null, tzOffsetMin()); }
    catch { identity = null; }
  }
  authState = "ready";
  return authState;
}

/* ── presence heartbeat (PVP-LOBBY-PROPOSAL §3.2/§7.2) ───────────────────
 * "lobby" is the only state this client ever sends while the app is simply
 * open — it means "this device is open", not "the lobby screen is on
 * screen"; `GET /api/lobby` derives the richer waiting/playing state
 * server-side from match participation. Starts once identity exists and
 * never stops (the app, not any one screen). */
let presenceHeartbeatStarted = false;
let presenceHeartbeatTimer = 0;
export function ensurePresenceHeartbeat(): void {
  if (presenceHeartbeatStarted) return;
  presenceHeartbeatStarted = true;
  const beat = (state: PresenceState = "lobby"): void => {
    if (identity) void postPresence(identity.deviceToken, state, tzOffsetMin()).catch(() => { /* best effort */ });
  };
  const startTicking = (): void => {
    if (presenceHeartbeatTimer) return;
    presenceHeartbeatTimer = window.setInterval(() => beat(), 30_000);
  };
  const stopTicking = (): void => {
    window.clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = 0;
  };
  if (document.visibilityState === "visible") startTicking();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { beat(); startTicking(); } else { stopTicking(); }
  });
}

/* ── chat mute list (PVP-LOBBY-PROPOSAL §8) ───────────────────────────────
 * Local-only, `localStorage`, a set of muted `playerId`s — never sent to the
 * server. Applies to both table chat and lobby/room chat. */
const MUTE_KEY = "mjrc.gamepvp.mutedPlayers";
export function mutedSet(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(MUTE_KEY) ?? "[]") as string[]); }
  catch { return new Set(); }
}
export function setMuted(playerId: string, muted: boolean): void {
  const s = mutedSet();
  if (muted) s.add(playerId); else s.delete(playerId);
  localStorage.setItem(MUTE_KEY, JSON.stringify([...s]));
}
/** Wired onto any `.cname[data-player][data-name]` element in a chat row — a
 *  plain `confirm()`, same pattern as the in-game "leave table" confirm.
 *  `onChanged` repaints whatever chat list called this. */
export function wireMuteTaps(container: ParentNode, onChanged: () => void): void {
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(".cname[data-player]"))) {
    const id = el.dataset.player;
    if (!id) continue;
    el.onclick = (e) => {
      e.stopPropagation();
      const nm = el.dataset.name ?? "this player";
      const already = mutedSet().has(id);
      if (!window.confirm(already ? `Unmute ${nm}?` : `Mute ${nm}? You won't see their chat messages.`)) return;
      setMuted(id, !already);
      onChanged();
    };
  }
}

/* ── settings (table + game settings page) ────────────────────────────────
 * `tileScale`/`dev`/`hcCount`/`hcCalling`/`hcWhatIf` drive the table's own
 * rendering (unchanged behaviour — see table.ts). `sound`/`haptics`/
 * `language` are new surfaces the shell's Game settings page exposes
 * (task brief §11 build item 2); nothing in the engine plays audio or fires
 * haptics yet, so these are inert prefs recorded for when it does — reading
 * one never throws and never blocks the page. */
export type Language = "en" | "zh";
export interface Settings {
  tileScale: number; dev: boolean;
  hcCount: boolean; hcCalling: boolean; hcWhatIf: boolean;
  sound: boolean; haptics: boolean; coaching: boolean; language: Language;
  /** Double tap to discard (table.ts build item 3) — TWO independent flags,
   *  because the two input models want different answers and a laptop that
   *  also has a touchscreen would otherwise have to pick one. Which one
   *  applies is decided per tap by the POINTER, not by the breakpoint alone:
   *  `matchMedia("(pointer: coarse)")` or a viewport under 768px counts as
   *  the phone. Both default true — a mis-thrown tile is unrecoverable and a
   *  second tap costs nothing. */
  discardDoubleTapDesktop: boolean; discardDoubleTapMobile: boolean;
}
/** The tile-size slider's range. 2.0 used to be allowed; at that size a
 *  14-tile hand is wider than an iPad and the row wraps into the table.
 *  A stored value outside the range is clamped on load, so a device that
 *  was already stuck comes back at the cap. */
export const TILE_SCALE_MIN = 0.8;
export const TILE_SCALE_MAX = 1.5;
export const clampTileScale = (v: unknown): number =>
  Math.min(TILE_SCALE_MAX, Math.max(TILE_SCALE_MIN, Number(v) || 1));
export const SETTINGS: Settings = {
  tileScale: 1, dev: false, hcCount: true, hcCalling: false, hcWhatIf: false,
  sound: true, haptics: true, coaching: true, language: "en",
  discardDoubleTapDesktop: true, discardDoubleTapMobile: true,
  ...JSON.parse(localStorage.getItem("mjrc.gamepvp.settings") ?? "{}"),
};
SETTINGS.tileScale = clampTileScale(SETTINGS.tileScale);
/** Saved settings are spread OVER the defaults above, so changing a default
 *  reaches new devices only — see the historical `hcCountDefaulted`
 *  migration this ported from game.ts. */
if (localStorage.getItem("mjrc.gamepvp.hcCountDefaulted") === null) {
  localStorage.setItem("mjrc.gamepvp.hcCountDefaulted", "1");
  SETTINGS.hcCount = true;
  localStorage.setItem("mjrc.gamepvp.settings", JSON.stringify(SETTINGS));
}
export const saveSettings = (): void => {
  SETTINGS.tileScale = clampTileScale(SETTINGS.tileScale);
  localStorage.setItem("mjrc.gamepvp.settings", JSON.stringify(SETTINGS));
  document.documentElement.style.setProperty("--tscale", String(SETTINGS.tileScale));
  document.body.classList.toggle("devmode", SETTINGS.dev);
};

/* ── theme (light / dark / system) ────────────────────────────────────────
 * `shell/theme.css` scopes every colour token under `#shell{…}` (light) and
 * `@media (prefers-color-scheme: dark) #shell:not(.theme-light)`/
 * `#shell.theme-dark` (dark) — never on `:root`, so nothing here can ever
 * touch the table screen's own felt/tile palette (index.html's `:root`).
 * `system` (the default) removes both override classes and lets the media
 * query decide. */
export type ThemeChoice = "system" | "light" | "dark";
const THEME_KEY = "mjrc.gamepvp.theme";
export function getThemeChoice(): ThemeChoice {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : "system";
}
export function applyTheme(root: HTMLElement, choice: ThemeChoice): void {
  root.classList.remove("theme-light", "theme-dark");
  if (choice === "light") root.classList.add("theme-light");
  else if (choice === "dark") root.classList.add("theme-dark");
}
export function setThemeChoice(root: HTMLElement, choice: ThemeChoice): void {
  localStorage.setItem(THEME_KEY, choice);
  applyTheme(root, choice);
}

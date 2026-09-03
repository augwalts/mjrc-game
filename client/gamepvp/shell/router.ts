/**
 * The shell's router — real URL paths (task brief §11.3), `history.pushState`,
 * back/forward works, a refresh keeps your place. One page module per route
 * under `shell/pages/`; an unknown path falls back to `/`.
 *
 * Every route needs an onboarded identity (ACCOUNTS-GAME-SIGNIN-2026-09-04
 * §4). `dispatch` checks `session.authState` BEFORE it matches a route, so
 * there is exactly one gate rather than a check per page:
 *
 *   signed-out    → the sign-in screen, `next` = the path that was asked for
 *   needs-signup  → `/signup`, `next` = that path, `source` = an invite code
 *   ready         → the app, as before
 *
 * Nothing here mints an identity any more — the old name prompt is gone.
 *
 * `/j/<code>` and `/r/<code>` are NOT shell pages — they are the existing
 * table/room invite-link redirects (the Worker already serves `index.html`
 * for them; see README.md for the other paths it needs to map the same way).
 * Handled once, before the first route dispatch, exactly like the old
 * `boot()`'s `pendingJoinCodeFromUrl()` did: read the code, replace the URL
 * with `/`, then act on it.
 */
import { joinRoom } from "../net.js";
import { authState, identity } from "./session.js";
import { wireNav } from "./ui.js";

import { mount as mountHome } from "./pages/home.js";
import { mount as mountRooms } from "./pages/rooms.js";
import { mount as mountRoom } from "./pages/room.js";
import { mount as mountPlayers } from "./pages/players.js";
import { mount as mountStats } from "./pages/stats.js";
import { mount as mountGame } from "./pages/game-detail.js";
import { mount as mountWatch } from "./pages/watch.js";
import { mount as mountPlayer } from "./pages/player.js";
import { mount as mountMessages } from "./pages/messages.js";
import { mount as mountDm } from "./pages/dm.js";
import { mount as mountProfile } from "./pages/profile.js";
import { mount as mountAccount } from "./pages/account.js";
import { mount as mountSettings } from "./pages/settings.js";
import { mount as mountSignin, safeNext } from "./pages/signin.js";
import { mount as mountSignup } from "./pages/signup.js";
import { mountJoinModal, mountNewTableModal } from "./pages/newtable.js";

export type PageParams = Record<string, string>;
/** A page module returns an optional cleanup — stop a poll, clear a timer —
 *  run right before the router mounts whatever comes next. */
export type PageMount = (container: HTMLElement, params: PageParams, router: Router) => void | (() => void);

export interface Router {
  navigate(path: string, opts?: { replace?: boolean }): void;
  /** Re-render the current page's chrome (top bar unread badge, nav active
   *  state) without a full remount — cheap, used after the inbox count
   *  changes elsewhere. */
  currentPath(): string;
}

interface Route { pattern: RegExp; keys: string[]; mount: PageMount; }
function route(path: string, mount: PageMount): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + path.replace(/:[A-Za-z]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "/?$",
  );
  return { pattern, keys, mount };
}

const ROUTES: Route[] = [
  route("/", mountHome),
  route("/rooms", mountRooms),
  route("/rooms/:code", mountRoom),
  route("/players", mountPlayers),
  /* `/friends` was the module's old name (its nav tab, its links, anything a
   *  browser bookmarked). Players replaced it wholesale — one list, filtered
   *  — so the old path redirects rather than rendering a second screen. */
  route("/friends", (_c, _p, r) => { r.navigate("/players", { replace: true }); }),
  route("/stats", mountStats),
  route("/games/:id", mountGame),
  route("/watch", mountWatch),
  route("/watch/:id", mountWatch),
  route("/players/:id", mountPlayer),
  route("/messages", mountMessages),
  route("/messages/:playerId", mountDm),
  route("/me", mountProfile),
  route("/me/account", mountAccount),
  route("/me/settings", mountSettings),
  route("/signin", mountSignin),
  route("/signup", mountSignup),
];

function matchRoute(path: string): { route: Route; params: PageParams } | null {
  for (const r of ROUTES) {
    const m = r.pattern.exec(path);
    if (m) {
      const params: PageParams = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!); });
      return { route: r, params };
    }
  }
  return null;
}

/** `/j/<code>` (a table invite) or `/r/<code>` (a room invite) — read once,
 *  acted on, then the URL is rewritten to whatever the action lands on.
 *  Returns `true` when it consumed the path (the caller should not also try
 *  to match it as a normal route). */
const INVITE_RE = /^\/(j|r)\/([A-Za-z0-9]+)\/?$/;
/** The room/table code an invite path carries, for `signup`'s `source`. */
function inviteCodeOf(path: string): string | null {
  const m = INVITE_RE.exec(path);
  return m ? m[2]!.toUpperCase() : null;
}

async function handleInviteLink(path: string): Promise<boolean> {
  const j = /^\/j\/([A-Za-z0-9]+)\/?$/.exec(path);
  if (j) {
    history.replaceState(null, "", "/");
    mountJoinModal(j[1]!.toUpperCase());
    return true;
  }
  const r = /^\/r\/([A-Za-z0-9]+)\/?$/.exec(path);
  if (r) {
    const code = r[1]!.toUpperCase();
    history.replaceState(null, "", "/");
    if (identity) {
      try { await joinRoom(identity.deviceToken, code); } catch { /* already a member, or not live yet — still route there */ }
    }
    history.replaceState(null, "", `/rooms/${code}`);
    return true;
  }
  return false;
}

let currentCleanup: (() => void) | null = null;
let currentPath = "/";
let shellRoot: HTMLElement;
let viewEl: HTMLElement;

function unmountCurrent(): void {
  if (currentCleanup) { try { currentCleanup(); } catch { /* ignore */ } }
  currentCleanup = null;
}

const router: Router = {
  navigate(path, opts) {
    if (opts?.replace) history.replaceState(null, "", path);
    else if (path !== location.pathname) history.pushState(null, "", path);
    void dispatch(path);
  },
  currentPath() { return currentPath; },
};

async function dispatch(rawPath: string): Promise<void> {
  // `navigate("/signup?next=/rooms")` and a popstate to `/signup` must reach
  // the same page with the same `next`, so the query is read off whichever of
  // the two carried it.
  const qi = rawPath.indexOf("?");
  const path = qi >= 0 ? rawPath.slice(0, qi) : rawPath;
  const query = new URLSearchParams(qi >= 0 ? rawPath.slice(qi + 1) : location.search);
  currentPath = path;

  if (authState !== "ready") {
    unmountCurrent();
    // `next` is what the visitor actually asked for — an invite path
    // included, so the code survives Google and sign-up both.
    const next = path === "/signin" || path === "/signup" ? safeNext(query.get("next")) : path;
    const params: PageParams = { next };
    const code = inviteCodeOf(next) ?? query.get("source");
    if (code) params.source = code;
    const mountAuth = authState === "needs-signup" ? mountSignup : mountSignin;
    const cleanup = mountAuth(viewEl, params, router);
    if (typeof cleanup === "function") currentCleanup = cleanup;
    return;
  }

  // Signed in and onboarded: nobody should sit on the auth pages any more.
  if (path === "/signin" || path === "/signup") {
    router.navigate(safeNext(query.get("next")), { replace: true });
    return;
  }
  if (await handleInviteLink(path)) return;
  const hit = matchRoute(path);
  unmountCurrent();
  if (!hit) { router.navigate("/", { replace: true }); return; }
  const cleanup = hit.route.mount(viewEl, hit.params, router);
  if (typeof cleanup === "function") currentCleanup = cleanup;
  wireNav(shellRoot, router);
}

/** Mounted once by the bootstrap, after identity + hostHooks are ready. */
export function initRouter(root: HTMLElement): Router {
  shellRoot = root;
  root.innerHTML = `<div class="view"></div>`;
  viewEl = root.querySelector(".view")!;
  window.addEventListener("popstate", () => void dispatch(location.pathname));
  void dispatch((location.pathname || "/") + location.search);
  return router;
}

export { mountNewTableModal };

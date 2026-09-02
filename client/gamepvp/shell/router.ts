/**
 * The shell's router — real URL paths (task brief §11.3), `history.pushState`,
 * back/forward works, a refresh keeps your place. One page module per route
 * under `shell/pages/`; an unknown path falls back to `/`.
 *
 * `/j/<code>` and `/r/<code>` are NOT shell pages — they are the existing
 * table/room invite-link redirects (the Worker already serves `index.html`
 * for them; see README.md for the other paths it needs to map the same way).
 * Handled once, before the first route dispatch, exactly like the old
 * `boot()`'s `pendingJoinCodeFromUrl()` did: read the code, replace the URL
 * with `/`, then act on it.
 */
import { joinRoom } from "../net.js";
import { describeError, ensurePresenceHeartbeat, identity, identify } from "./session.js";
import { S, t } from "./strings.js";
import { wireNav } from "./ui.js";

import { mount as mountHome } from "./pages/home.js";
import { mount as mountRooms } from "./pages/rooms.js";
import { mount as mountRoom } from "./pages/room.js";
import { mount as mountFriends } from "./pages/friends.js";
import { mount as mountStats } from "./pages/stats.js";
import { mount as mountGame } from "./pages/game-detail.js";
import { mount as mountPlayer } from "./pages/player.js";
import { mount as mountMessages } from "./pages/messages.js";
import { mount as mountDm } from "./pages/dm.js";
import { mount as mountProfile } from "./pages/profile.js";
import { mount as mountAccount } from "./pages/account.js";
import { mount as mountSettings } from "./pages/settings.js";
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
  route("/friends", mountFriends),
  route("/stats", mountStats),
  route("/games/:id", mountGame),
  route("/players/:id", mountPlayer),
  route("/messages", mountMessages),
  route("/messages/:playerId", mountDm),
  route("/me", mountProfile),
  route("/me/account", mountAccount),
  route("/me/settings", mountSettings),
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

/** The one-time name entry, shown in place of any route while there is no
 *  identity yet — same copy as the old `nameScreen()`, now inline in the
 *  shell's own `.view` rather than a `#veil` overlay (there is no table
 *  chrome mounted at all at this point in boot). */
function renderNameGate(container: HTMLElement, then: () => void): void {
  container.innerHTML = `<div class="card" style="max-width:420px;margin:40px auto">
    <h2 style="margin:0 0 6px">${t(S.titleHome)}</h2>
    <p class="mut">${t(S.yourName)} This is a private beta — every game you play is recorded on our server, seat by seat, hand by hand.</p>
    <div class="row" style="margin-top:12px"><input id="nameIn" type="text" maxlength="24" placeholder="your name" style="flex:1"></div>
    <p class="mut" id="nameNote" style="margin-top:8px">No account, no email — just this name. Change it any time.</p>
    <button class="sit" id="btnName" style="margin-top:6px">${t(S.continue_)}</button>
  </div>`;
  const input = document.getElementById("nameIn") as HTMLInputElement;
  const note = document.getElementById("nameNote")!;
  const go = async (): Promise<void> => {
    const nm = input.value.trim();
    if (!nm) { input.focus(); return; }
    try {
      await identify(nm);
      ensurePresenceHeartbeat();
      then();
    } catch (e) {
      note.innerHTML = `<b style="color:var(--red)">${t(S.couldNotReach)}</b> — ${describeError(e)}`;
    }
  };
  (document.getElementById("btnName") as HTMLButtonElement).onclick = () => void go();
  input.onkeydown = (e) => { if (e.key === "Enter") void go(); };
  input.focus();
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

async function dispatch(path: string): Promise<void> {
  currentPath = path;
  if (await handleInviteLink(path)) return;
  if (!identity) { unmountCurrent(); renderNameGate(viewEl, () => void dispatch(path)); return; }
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
  void dispatch(location.pathname || "/");
  return router;
}

export { mountNewTableModal };

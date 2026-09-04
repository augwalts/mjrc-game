/**
 * MJRC gamepvp — bootstrap. Decides whether to show the table (a resumed
 * session, or a match just joined) or the shell (everything else), wires
 * `table.ts`'s `hostHooks` to the router, resolves identity, and handles
 * `/j/<code>`/`/r/<code>` at the very first paint.
 *
 * 2026-09-02 shell rebuild (PVP-LOBBY-PROPOSAL-2026-09-02.md §11): this file
 * used to BE the whole client. It is now the thin seam between two things
 * that don't otherwise know about each other — `table.ts` (the match
 * runtime, unchanged behaviour) and `shell/` (the router-driven app around
 * it) — see table.ts's own header comment for the dependency-direction
 * rule this keeps.
 *
 * Build: ./gamepvp/build.sh (esbuild game.ts --bundle --platform=browser
 *        --format=iife --outfile=gamepvp/assets/game.js)
 */
import { connectToMatch, initTableChrome, resumeActiveSession, setHostHooks } from "./table.js";
import { initRouter, type Router } from "./shell/router.js";
import { applyTheme, authState, bootIdentity, ensurePresenceHeartbeat, getThemeChoice } from "./shell/session.js";

const tableRoot = document.getElementById("tableRoot")!;
const shellRoot = document.getElementById("shell")!;

function showTable(): void {
  tableRoot.style.display = "flex";
  shellRoot.hidden = true;
}
function showShell(): void {
  tableRoot.style.display = "none";
  shellRoot.hidden = false;
}

let router: Router | null = null;

/** `/?spectate=<matchId>&seat=N&token=…&rules=…&format=…` — one seat of a
 *  live table, as that seat sees it, for the admin watch page's iframes
 *  (2026-09-03). No shell, no router, no session: the table only. */
function spectateParams(): { matchUuid: string; seat: 0 | 1 | 2 | 3; token: string; rulesetId: string; matchFormat: string } | null {
  const q = new URLSearchParams(location.search);
  const matchUuid = q.get("spectate"); const token = q.get("token"); const seat = Number(q.get("seat"));
  if (!matchUuid || !token || ![0, 1, 2, 3].includes(seat)) return null;
  return { matchUuid, seat: seat as 0 | 1 | 2 | 3, token, rulesetId: q.get("rules") ?? "mjrc-standard", matchFormat: q.get("format") ?? "east" };
}

async function boot(): Promise<void> {
  applyTheme(shellRoot, getThemeChoice());
  initTableChrome();
  const spec = spectateParams();
  if (spec) {
    setHostHooks({
      enterTable: () => showTable(),
      leaveToShell: () => { showTable(); },
      goToPlayer: () => { /* nothing to navigate to */ },
      goToSettings: () => { /* nothing to navigate to */ },
    });
    connectToMatch({
      matchUuid: spec.matchUuid, joinCode: null, seat: spec.seat, seatToken: spec.token,
      rulesetId: spec.rulesetId, matchFormat: spec.matchFormat as never, spectator: true,
    });
    return;
  }
  showShell(); // default until something says otherwise, below

  setHostHooks({
    enterTable: () => showTable(),
    leaveToShell: () => { showShell(); router?.navigate("/", { replace: true }); },
    goToPlayer: (playerId) => { showShell(); router?.navigate(`/players/${playerId}`); },
    goToSettings: () => { showShell(); router?.navigate("/me/settings"); },
  });

  // One call, three outcomes (shell/session.ts's `bootIdentity`): signed out,
  // signed in but not onboarded, or ready. The router reads the same state
  // and renders the sign-in / sign-up screen in place of any route until it
  // says "ready" — there is no name prompt any more
  // (ACCOUNTS-GAME-SIGNIN-2026-09-04 §4).
  await bootIdentity();
  ensurePresenceHeartbeat();

  router = initRouter(shellRoot);

  // A resumed match wins over whatever path the router just dispatched to —
  // mirrors the old boot()'s own ordering (resumeOrLobby before the lobby
  // screen painted). `/j/<code>`/`/r/<code>` are handled inside the router
  // itself (shell/router.ts's `handleInviteLink`) and always win over a
  // resume, same as the pre-rebuild client ("a deep link is a deliberate act
  // and wins over both").
  // Nothing resumes a table for somebody who is not signed in and onboarded:
  // the shell is showing the sign-in screen, and `resumeActiveSession` would
  // otherwise pull the table over the top of it.
  const isInviteLink = /^\/(j|r)\/[A-Za-z0-9]+\/?$/.test(location.pathname);
  if (authState === "ready" && !isInviteLink) await resumeActiveSession();
}

void boot();

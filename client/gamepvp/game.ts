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
 * `?playtest=a|b` (see `playtest.ts`) replaces the identity + resume half of
 * boot with the playtest harness's own. It is the ONE fork in this file;
 * everything above it — theme, table chrome, host hooks, the router — is the
 * same code path a real session takes, which is the whole point of it.
 *
 * Build: ./gamepvp/build.sh (esbuild game.ts --bundle --platform=browser
 *        --format=iife --outfile=gamepvp/assets/game.js)
 */
import { initTableChrome, resumeActiveSession, setHostHooks } from "./table.js";
import { initRouter, type Router } from "./shell/router.js";
import { applyTheme, bootIdentity, ensurePresenceHeartbeat, getThemeChoice } from "./shell/session.js";
import { playtestRole, runPlaytest } from "./playtest.js";

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

async function boot(): Promise<void> {
  applyTheme(shellRoot, getThemeChoice());
  initTableChrome();
  showShell(); // default until something says otherwise, below

  setHostHooks({
    enterTable: () => showTable(),
    leaveToShell: () => { showShell(); router?.navigate("/", { replace: true }); },
    goToPlayer: (playerId) => { showShell(); router?.navigate(`/players/${playerId}`); },
    goToSettings: () => { showShell(); router?.navigate("/me/settings"); },
  });

  const role = playtestRole();
  if (role) {
    // The playtest pane mints its own identity (never through localStorage — two
    // panes share one origin, and neither may clobber the real device token
    // sitting there), THEN mounts the router: the other order flashes the
    // name gate, which `dispatch` shows for as long as `identity` is null.
    // No resume and no invite link — the reel owns where this pane goes.
    await runPlaytest({
      role,
      mountRouter: () => (router = initRouter(shellRoot)),
      showTable,
      showShell,
    });
    return;
  }

  await bootIdentity();
  ensurePresenceHeartbeat();

  router = initRouter(shellRoot);

  // A resumed match wins over whatever path the router just dispatched to —
  // mirrors the old boot()'s own ordering (resumeOrLobby before the lobby
  // screen painted). `/j/<code>`/`/r/<code>` are handled inside the router
  // itself (shell/router.ts's `handleInviteLink`) and always win over a
  // resume, same as the pre-rebuild client ("a deep link is a deliberate act
  // and wins over both").
  const isInviteLink = /^\/(j|r)\/[A-Za-z0-9]+\/?$/.test(location.pathname);
  if (!isInviteLink) await resumeActiveSession();
}

void boot();

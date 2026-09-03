/**
 * Rooms — search-or-code field, Open hall pinned first, Starred, All
 * (task brief §11 build item 2; lobby-lab.html's Rooms page).
 */
import { getLobby, getMyRooms, joinRoom, joinTable, starRoom, unstarRoom, type LobbyTable, type RoomSummary } from "../../net.js";
import { connectToMatch } from "../../table.js";
import { tableRow } from "./room.js";
import { ruleLabel, matchFormatLabel } from "../../table.js";
import type { PageMount } from "../router.js";
import { describeError, esc, identity } from "../session.js";
import { S, t } from "../strings.js";
import { navHtml, pageTop, wireNav } from "../ui.js";

const OPEN_HALL_CODE = "OPEN";
const OPEN_HALL_ROOM: RoomSummary = { code: OPEN_HALL_CODE, name: "Open hall", online: undefined, live: undefined, starred: true };

function roomRow(r: RoomSummary): string {
  const rules = r.rulesetId ? `${esc(ruleLabel(r.rulesetId))}${r.matchFormat ? ` · ${matchFormatLabel(r.matchFormat)}` : ""}` : "any ruleset · any length";
  const n = r.online !== undefined
    ? `${r.online > 0 ? `<span class="dot"></span> ${r.online} ${esc(t(S.online))}` : esc(t(S.quiet))}${r.live !== undefined ? ` · ${r.live} ${esc(t(S.live))}` : ""}`
    : (r.memberCount !== undefined ? `${r.memberCount} members` : "");
  return `<div class="row room" data-nav="/rooms/${esc(r.code)}">
    <button class="star ${r.starred ? "on" : ""}" data-star="${esc(r.code)}">★</button>
    <div class="rname"><b>${esc(r.name)}</b><small>${rules}</small></div>
    <div class="n">${n}</div>
  </div>`;
}

export const mount: PageMount = (container, _params, router) => {
  let alive = true;
  /* Tables are hard to find (owner, 2026-09-03): the global lobby's live
   * tables — every room's, and the ones opened from Home with no room — sit
   * above the rooms, with the same Sit / Rejoin row the room page draws. */
  let liveTables: LobbyTable[] | null = null;
  let lastRooms: RoomSummary[] | null = null;
  let lastErr: string | null = null;
  const sitDown = async (joinCode: string): Promise<void> => {
    if (!identity) return;
    try {
      const r = await joinTable(identity.deviceToken, joinCode);
      connectToMatch({ matchUuid: r.matchUuid, joinCode, seat: r.seat, seatToken: r.seatToken, rulesetId: r.rulesetId, matchFormat: r.matchFormat });
    } catch (e) { paint(lastRooms, String(e)); }
  };
  const paint = (rooms: RoomSummary[] | null, err: string | null): void => {
    if (!alive) return;
    lastRooms = rooms; lastErr = err;
    // The Open hall is pinned first, once: the API's row when it has one (it carries the live counts),
    // the local placeholder until then. It never appears again under All.
    const fromApi = (rooms ?? []).find((r) => r.code === OPEN_HALL_CODE);
    const openHall: RoomSummary = fromApi ? { ...fromApi, name: OPEN_HALL_ROOM.name, starred: true } : OPEN_HALL_ROOM;
    const others = (rooms ?? []).filter((r) => r.code !== OPEN_HALL_CODE);
    const starred = [openHall, ...others.filter((r) => r.starred)];
    const rest = others.filter((r) => !r.starred);
    container.innerHTML = `
      ${pageTop(t(S.titleRooms), { displayName: identity?.displayName ?? "", unread: 0 })}
      <div class="row" style="margin-bottom:8px">
        <input id="roomSearch" placeholder="${esc(t(S.searchOrCode))}" style="flex:1">
        <button class="sit" id="roomGo">${esc(t(S.go))}</button>
      </div>
      <div class="sec">${esc(t(S.liveTables))} · <span id="liveN">${liveTables ? liveTables.length : "…"}</span></div>
      <div class="card tables" id="liveTables">${liveTables === null ? `<p class="empty">${esc(t(S.loading))}</p>`
        : liveTables.length > 0 ? liveTables.map(tableRow).join("") : `<p class="empty">${esc(t(S.noLiveTables))}</p>`}</div>
      <div class="sec">${esc(t(S.starred))}</div>
      <div class="card rooms">${starred.map(roomRow).join("")}</div>
      ${rest.length > 0 ? `<div class="sec">${esc(t(S.allRooms(rest.length)))}</div><div class="card rooms">${rest.map(roomRow).join("")}</div>` : ""}
      ${err ? `<p class="mut">${esc(err)}</p>` : ""}
      <a class="more" id="roomCreate">${esc(t(S.createRoom))}</a>
      ${navHtml("/rooms")}`;
    wireNav(container, router);
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-sit]"))) {
      el.onclick = () => void sitDown(el.dataset.sit!);
    }
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-star]"))) {
      el.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        const code = el.dataset.star!;
        const on = el.classList.contains("on");
        el.classList.toggle("on", !on);
        try { if (on) await unstarRoom(identity?.deviceToken ?? "", code); else await starRoom(identity?.deviceToken ?? "", code); }
        catch { el.classList.toggle("on", on); }
      };
    }
    const go = async (): Promise<void> => {
      const code = (document.getElementById("roomSearch") as HTMLInputElement).value.trim();
      if (!code) return;
      try { await joinRoom(identity?.deviceToken ?? "", code); router.navigate(`/rooms/${code.toUpperCase()}`); }
      catch (e) { paint(rooms, describeError(e)); }
    };
    document.getElementById("roomGo")!.addEventListener("click", () => void go());
    document.getElementById("roomCreate")!.addEventListener("click", (e) => { e.preventDefault(); void createRoomFlow(router); });
  };
  paint(null, null);
  void getLobby(identity?.deviceToken ?? "").then((lobby) => {
    liveTables = lobby.tables.filter((tb) => tb.lobbyStatus !== "done");
    if (alive) paint(lastRooms, lastErr);
  }).catch(() => { liveTables = []; if (alive) paint(lastRooms, lastErr); });
  void getMyRooms(identity?.deviceToken ?? "").then((rooms) => { if (alive) paint(rooms, null); })
    .catch(() => { if (alive) paint([], null); });
  return () => { alive = false; };
};

/** Creating a room has no UI yet (owner, 2026-09-03: "for now just popup and
 *  say admin is working on this feature"). The API (`POST /api/rooms`, §8b)
 *  exists and is exercised by the headless smoke; the form — name, ruleset,
 *  length, speed, admin code — belongs with New table's own pickers and
 *  lands with the fuller Rooms create form on the features list. */
async function createRoomFlow(_router: { navigate(p: string): void }): Promise<void> {
  window.alert(t(S.comingSoon));
}

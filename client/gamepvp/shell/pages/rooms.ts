/**
 * Rooms — search-or-code field, Open hall pinned first, Starred, All
 * (task brief §11 build item 2; lobby-lab.html's Rooms page).
 */
import { getMyRooms, joinRoom, starRoom, unstarRoom, type RoomSummary } from "../../net.js";
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
  const paint = (rooms: RoomSummary[] | null, err: string | null): void => {
    if (!alive) return;
    const starred = [OPEN_HALL_ROOM, ...(rooms ?? []).filter((r) => r.starred)];
    const rest = (rooms ?? []).filter((r) => !r.starred);
    container.innerHTML = `
      ${pageTop(t(S.titleRooms), { displayName: identity?.displayName ?? "", unread: 0 })}
      <div class="row" style="margin-bottom:8px">
        <input id="roomSearch" placeholder="${esc(t(S.searchOrCode))}" style="flex:1">
        <button class="sit" id="roomGo">${esc(t(S.go))}</button>
      </div>
      <div class="sec">${esc(t(S.starred))}</div>
      <div class="card rooms">${starred.map(roomRow).join("")}</div>
      ${rest.length > 0 ? `<div class="sec">${esc(t(S.allRooms(rest.length)))}</div><div class="card rooms">${rest.map(roomRow).join("")}</div>` : ""}
      ${err ? `<p class="mut">${esc(err)}</p>` : ""}
      <a class="more" id="roomCreate">${esc(t(S.createRoom))}</a>
      ${navHtml("/rooms")}`;
    wireNav(container, router);
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
  void getMyRooms(identity?.deviceToken ?? "").then((rooms) => { if (alive) paint(rooms, null); })
    .catch(() => { if (alive) paint([], null); });
  return () => { alive = false; };
};

/** A minimal create-room prompt (§8b: `name`/`rulesetId`/`matchFormat`/
 *  `adminCode`) — a full picker for this belongs with New table's own
 *  ruleset/length UI; kept to three `prompt()`s for now since rooms are
 *  still landing server-side and this is reachable, not the primary flow. */
async function createRoomFlow(router: { navigate(p: string): void }): Promise<void> {
  const name = window.prompt("Room name?");
  if (!name) return;
  const adminCode = window.prompt("Pick an admin code (you'll need this to manage the room):");
  if (!adminCode) return;
  try {
    const { createRoom } = await import("../../net.js");
    const r = await createRoom(identity?.deviceToken ?? "", { name, rulesetId: "mjrc-standard", matchFormat: "east", adminCode });
    router.navigate(`/rooms/${r.code}`);
  } catch (e) {
    window.alert(describeError(e));
  }
}

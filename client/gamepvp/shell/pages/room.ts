/**
 * A room's own page — header, tables as compact rows, Here, members link,
 * chat, admin strip when the admin code is held (task brief §11 build
 * item 2). `?room=CODE` scopes `GET /api/lobby` (§8b).
 */
import { getLobby, getRoom, joinTable, postLobbyChat, type LobbyHereEntry, type LobbyPayload, type LobbyTable, type RoomDetail } from "../../net.js";
import { connectToMatch, handLabel, matchFormatLabel, ruleLabel } from "../../table.js";
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { S, t } from "../strings.js";
import { avatarLetter, navHtml, pageTop, secCard, wireNav } from "../ui.js";
import { mountNewTableModal } from "./newtable.js";

const ADMIN_KEY_PREFIX = "mjrc.gamepvp.roomAdmin.";

export function tableRow(tb: LobbyTable): string {
  const filled = tb.seats.filter((s) => s.kind === "bot" || s.connected).length;
  // A seat that is mine at a table still running is a REJOIN, whatever the
  // table's status: the server keeps the seat (a bot plays it meanwhile) and
  // `/join` hands the same seat back with a fresh token. Before this, a
  // playing table showed "playing, hand 3" and nothing to press.
  const mine = !!identity && tb.seats.some((s) => s.kind === "human" && s.playerId === identity!.playerId);
  const canRejoin = mine && tb.lobbyStatus !== "done" && !!tb.joinCode;
  const canSit = !canRejoin && tb.access === "open" && tb.lobbyStatus === "waiting" && !!tb.joinCode;
  const status = tb.lobbyStatus === "playing" ? handLabel(tb.hand, tb.handsBase) : `${filled}/4 seated`;
  return `<div class="trow">
    <div class="trow-l">
      <span class="badge ${tb.mode}">${tb.mode}</span>
      ${tb.name ? `<b>${esc(tb.name)}</b>` : ""}
      <small>${esc(ruleLabel(tb.rulesetId))} · ${matchFormatLabel(tb.matchFormat)}</small>
    </div>
    <div class="mini">${tb.seats.map((s) => `<span class="ms ${s.kind}">${s.kind === "bot" ? "bot" : (s.displayName ? esc(s.displayName.slice(0, 4)) : "·")}</span>`).join("")}</div>
    ${canRejoin ? `<button class="sit sm" data-sit="${tb.joinCode}">${esc(t(S.rejoin))}</button>`
      : canSit ? `<button class="sit sm" data-sit="${tb.joinCode}">Sit ${filled}/4</button>` : `<small class="playing">${status}</small>`}
  </div>`;
}
function hereRow(e: LobbyHereEntry): string {
  const dotCls = e.state === "lobby" ? "" : e.state === "waiting" ? "wait" : "play";
  const label = e.state === "lobby" ? "in the room" : e.state === "playing" ? `playing, ${handLabel(e.hand, e.handsBase)}` : "waiting at a table";
  return `<div class="row" style="padding:4px 0"><span class="avatar">${avatarLetter(e.displayName)}</span><b>${esc(e.displayName)}</b>
    <span class="mut"><span class="dot ${dotCls}"></span> ${esc(label)}</span></div>`;
}

export const mount: PageMount = (container, params, router) => {
  let alive = true;
  const code = params.code!;
  let pollTimer = 0;
  let detail: RoomDetail | null = null;

  const adminCode = (): string | null => localStorage.getItem(ADMIN_KEY_PREFIX + code);

  const paint = (lobby: LobbyPayload | null, err: string | null): void => {
    if (!alive) return;
    const title = detail?.name ?? code;
    container.innerHTML = `
      ${pageTop(title, { back: "/rooms", displayName: identity?.displayName ?? "", unread: 0 })}
      <div class="card roomhead"><div class="row">
        <div><small class="mut">${detail?.game ? `${esc(ruleLabel(detail.game.rulesetId))} · ${matchFormatLabel(detail.game.matchFormat)} · ` : ""}code ${esc(code)} · ${detail?.memberCount ?? 0} members</small></div>
        <button class="sit" id="playHere" style="margin-left:auto">${esc(t(S.playNow))}</button>
      </div></div>
      ${err ? `<p class="mut">${esc(err)}</p>` : ""}
      <div class="sec">${esc(t(S.tables))} · ${lobby?.tables.length ?? 0}</div>
      <div class="card tables">${lobby && lobby.tables.length > 0 ? lobby.tables.map(tableRow).join("") : `<p class="empty">${esc(t(S.nothingHere))}</p>`}</div>
      <div class="sec">${esc(t(S.here))} · ${lobby?.here.length ?? 0}</div>
      <div class="card friends">${lobby && lobby.here.length > 0 ? lobby.here.map(hereRow).join("") : `<p class="empty">${esc(t(S.nothingHere))}</p>`}</div>
      ${secCard(t(S.roomChat), "blue", `
        <div id="roomChatMsgs">${(lobby?.chat ?? []).slice(-6).map((m) => `<div><b>${esc(m.displayName)}</b> ${esc(m.text)}</div>`).join("") || `<p class="empty">${esc(t(S.nothingHere))}</p>`}</div>
        <div class="row" style="margin-top:6px"><input id="roomChatIn" placeholder="say something" style="flex:1"><button class="sit sm" id="roomChatSend">${esc(t(S.sendMessage))}</button></div>`)}
      ${adminCode() ? secCard(t(S.admin), "grey", `<p class="mut">Change rules or speed · close a waiting table · remove a member · rotate the admin code</p>`) : ""}
      ${navHtml("/rooms")}`;
    wireNav(container, router);
    document.getElementById("playHere")!.addEventListener("click", () => mountNewTableModal({ fromRoomCode: code }));
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-sit]"))) {
      el.onclick = () => void sitDown(el.dataset.sit!);
    }
    const send = async (): Promise<void> => {
      const input = document.getElementById("roomChatIn") as HTMLInputElement;
      const text = input.value.trim();
      if (!text || !identity) return;
      input.value = "";
      try { await postLobbyChat(identity.deviceToken, text, code); } catch { /* best effort */ }
      void tick();
    };
    document.getElementById("roomChatSend")?.addEventListener("click", () => void send());
    document.getElementById("roomChatIn")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void send(); });
  };

  const sitDown = async (joinCode: string): Promise<void> => {
    if (!identity) return;
    try {
      const r = await joinTable(identity.deviceToken, joinCode);
      connectToMatch({ matchUuid: r.matchUuid, joinCode, seat: r.seat, seatToken: r.seatToken, rulesetId: r.rulesetId, matchFormat: r.matchFormat });
    } catch (e) { paint(null, String(e)); }
  };

  const tick = async (): Promise<void> => {
    try {
      const lobby = await getLobby(identity?.deviceToken ?? "", code);
      if (alive) paint(lobby, null);
    } catch {
      if (alive) paint(null, "rooms are coming — not live on this server yet");
    }
  };

  container.innerHTML = `<div class="spinner">${esc(t(S.loading))}</div>`;
  void getRoom(identity?.deviceToken ?? "", code).then((d) => { detail = d; }).catch(() => { /* degrade: header shows code only */ });
  void tick();
  pollTimer = window.setInterval(() => { if (document.visibilityState === "visible") void tick(); }, 5000);
  return () => { alive = false; window.clearInterval(pollTimer); };
};

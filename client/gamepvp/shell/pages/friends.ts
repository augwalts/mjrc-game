/**
 * Friends — everyone you have played with, online first, star to pin
 * (task brief §11.1). Online/All pills; the lobby chat doubles as this
 * page's chat (Open hall chat, §11.2).
 */
import { getLobby, getFriends, starFriend, unstarFriend, postLobbyChat, type FriendEntry } from "../../net.js";
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { S, t } from "../strings.js";
import { avatarLetter, filterRow, navHtml, pageTop, secCard, wireNav } from "../ui.js";

function stateLabel(f: FriendEntry): string {
  if (f.state === "offline") return "offline";
  if (f.state === "lobby") return "in the lobby";
  if (f.state === "waiting") return "waiting at a table";
  return f.hand !== undefined ? `playing, hand ${f.hand + 1}/${f.handsBase ?? "?"}` : "playing";
}
function row(f: FriendEntry): string {
  const dotCls = f.state === "offline" ? "" : f.state === "waiting" ? "wait" : f.state === "playing" ? "play" : "";
  return `<div class="row" style="padding:5px 0" data-nav="/players/${esc(f.playerId)}">
    <button class="star ${f.starred ? "on" : ""}" data-star="${esc(f.playerId)}">★</button>
    <span class="avatar">${avatarLetter(f.displayName)}</span><b>${esc(f.displayName)}</b>
    <span class="mut">${f.state === "offline" ? "" : `<span class="dot ${dotCls}"></span>`} ${esc(stateLabel(f))}</span>
    <span style="margin-left:auto;color:var(--dim);font-size:12px">${f.rating === null ? "unrated" : f.rating}</span>
  </div>`;
}

export const mount: PageMount = (container, _params, router) => {
  let alive = true;
  let filter: "Online" | "All" = "Online";
  let friends: FriendEntry[] = [];

  const paint = (): void => {
    if (!alive) return;
    const online = friends.filter((f) => f.state !== "offline");
    const offline = friends.filter((f) => f.state === "offline");
    const shown = filter === "Online" ? online : friends;
    container.innerHTML = `
      ${pageTop(t(S.titleFriends), { displayName: identity?.displayName ?? "", unread: 0 })}
      ${filterRow([t(S.filterOnline), t(S.filterAll)], filter === "Online" ? t(S.filterOnline) : t(S.filterAll))}
      <div class="row" style="margin:6px 0 4px"><input placeholder="${esc(t(S.addFriendPlaceholder))}" style="flex:1" disabled></div>
      ${shown.length === 0 ? `<p class="empty">${esc(t(S.nothingHere))}</p>` : `<div class="card friends">${shown.map(row).join("")}</div>`}
      ${filter === "Online" && offline.length > 0 ? `<div class="sec">${esc(t(S.filterOffline))} · ${offline.length}</div><div class="card friends"><p class="mut">${esc(t(S.offlineLinkNote))}</p></div>` : ""}
      ${secCard(t(S.lobbyChat), "blue", `
        <div id="lobbyChatMsgs"><p class="empty">${esc(t(S.loading))}</p></div>
        <div class="row" style="margin-top:6px"><input id="lobbyChatIn" placeholder="say something" style="flex:1"><button class="sit sm" id="lobbyChatSend">${esc(t(S.sendMessage))}</button></div>`)}
      ${navHtml("/friends")}`;
    wireNav(container, router);
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(".tabs button"))) {
      el.onclick = () => { filter = el.textContent === t(S.filterAll) ? "All" : "Online"; paint(); };
    }
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-star]"))) {
      el.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = el.dataset.star!;
        const on = el.classList.contains("on");
        el.classList.toggle("on", !on);
        try { if (on) await unstarFriend(identity?.deviceToken ?? "", id); else await starFriend(identity?.deviceToken ?? "", id); }
        catch { el.classList.toggle("on", on); }
      };
    }
    const send = async (): Promise<void> => {
      const input = document.getElementById("lobbyChatIn") as HTMLInputElement;
      const text = input.value.trim();
      if (!text || !identity) return;
      input.value = "";
      try { await postLobbyChat(identity.deviceToken, text); } catch { /* best effort */ }
      void tick();
    };
    document.getElementById("lobbyChatSend")?.addEventListener("click", () => void send());
    document.getElementById("lobbyChatIn")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void send(); });
  };

  const tick = async (): Promise<void> => {
    try {
      const lobby = await getLobby(identity?.deviceToken ?? "");
      if (!alive) return;
      const el = document.getElementById("lobbyChatMsgs");
      if (el) el.innerHTML = lobby.chat.slice(-6).map((m) => `<div><b>${esc(m.displayName)}</b> ${esc(m.text)}</div>`).join("") || `<p class="empty">${esc(t(S.nothingHere))}</p>`;
    } catch { /* degrade silently — the chat card just stays as it was */ }
  };

  container.innerHTML = `<div class="spinner">${esc(t(S.loading))}</div>`;
  void getFriends(identity?.deviceToken ?? "").then((list) => { friends = list; paint(); }).catch(() => { friends = []; paint(); });
  void tick();
  const pollTimer = window.setInterval(() => { if (document.visibilityState === "visible") void tick(); }, 5000);
  return () => { alive = false; window.clearInterval(pollTimer); };
};

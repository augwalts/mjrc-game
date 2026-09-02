/** A DM thread (`/messages/:playerId`) — bubbles, input (PVP-LOBBY-PROPOSAL
 *  §8). Table-invite bubbles are not modelled separately here — an invite
 *  reaches this player through the inbox (`messages.ts`), same as any other
 *  `InboxEntry`; a DM thread just shows text. */
import { getDm, postDm, type DmMessage } from "../../net.js";
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { S, t } from "../strings.js";
import { navHtml, pageTop, wireNav } from "../ui.js";

function bubble(m: DmMessage, me: string): string {
  return `<div class="bub ${m.fromPlayerId === me ? "me" : "them"}"><span>${esc(m.text)}</span><small>${new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div>`;
}

export const mount: PageMount = (container, params, router) => {
  let alive = true;
  const playerId = params.playerId!;
  const me = identity?.playerId ?? "";
  let pollTimer = 0;

  const paint = (list: DmMessage[]): void => {
    if (!alive) return;
    container.innerHTML = `
      ${pageTop(playerId, { back: "/messages", displayName: identity?.displayName ?? "", unread: 0 })}
      <div class="card thread">${list.length === 0 ? `<p class="empty">${esc(t(S.nothingHere))}</p>` : list.map((m) => bubble(m, me)).join("")}</div>
      <div class="row" style="margin-top:8px"><input id="dmIn" placeholder="${esc(t(S.messagePlaceholder(playerId)))}" style="flex:1">
        <button class="sit" id="dmSend">${esc(t(S.sendMessage))}</button></div>
      ${navHtml("/friends")}`;
    wireNav(container, router);
    const box = container.querySelector(".thread") as HTMLElement | null;
    if (box) box.scrollTop = box.scrollHeight;
    const send = async (): Promise<void> => {
      const input = document.getElementById("dmIn") as HTMLInputElement;
      const text = input.value.trim();
      if (!text || !identity) return;
      input.value = "";
      try { await postDm(identity.deviceToken, playerId, text); } catch { /* best effort */ }
      void tick();
    };
    document.getElementById("dmSend")!.addEventListener("click", () => void send());
    document.getElementById("dmIn")!.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void send(); });
  };

  const tick = async (): Promise<void> => {
    try { const list = await getDm(identity?.deviceToken ?? "", playerId); if (alive) paint(list); }
    catch { if (alive) paint([]); }
  };

  container.innerHTML = `<div class="spinner">${esc(t(S.loading))}</div>`;
  void tick();
  pollTimer = window.setInterval(() => { if (document.visibilityState === "visible") void tick(); }, 5000);
  return () => { alive = false; window.clearInterval(pollTimer); };
};

/**
 * Messages (inbox) — All/Invites/Rooms/Results pills, unread in gold,
 * Sit/Open buttons (PVP-LOBBY-PROPOSAL §8, "Direct messages and the inbox").
 */
import { acceptInbox, dismissInbox, getInbox, type InboxEntry, type InboxKind } from "../../net.js";
import { connectToMatch } from "../../table.js";
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { S, t } from "../strings.js";
import { avatarLetter, filterRow, navHtml, pageTop, wireNav } from "../ui.js";

const KIND_TO_FILTER: Record<InboxKind, string> = { invite: "Invites", room: "Rooms", dm: "All", result: "Results" };

function row(m: InboxEntry): string {
  const action = m.kind === "invite" ? `<button class="sit sm" data-accept="${esc(m.id)}">${esc(t(S.sit))}</button>`
    : m.kind === "room" ? `<button class="sit sm ghost" data-nav="/rooms/${esc(m.roomCode ?? "")}">${esc(t(S.open))}</button>`
    : `<button class="sit sm ghost" data-dismiss="${esc(m.id)}">${esc(t(S.dismiss))}</button>`;
  return `<div class="row msg ${m.unread ? "unread" : ""}" ${m.kind === "dm" ? `data-nav="/messages/${esc(m.fromPlayerId ?? "")}"` : ""}>
    <span class="avatar">${avatarLetter(m.fromDisplayName)}</span>
    <div style="flex:1"><b>${esc(m.fromDisplayName)}</b> <span>${esc(m.text)}</span><br>
      <small class="mut">${new Date(m.at).toLocaleString()} · ${esc(m.kind)}</small></div>
    ${action}
  </div>`;
}

export const mount: PageMount = (container, _params, router) => {
  let alive = true;
  let filter = "All";
  let items: InboxEntry[] = [];

  const paint = (): void => {
    if (!alive) return;
    const shown = filter === "All" ? items : items.filter((m) => KIND_TO_FILTER[m.kind] === filter);
    container.innerHTML = `
      ${pageTop(t(S.titleMessages), { displayName: identity?.displayName ?? "", unread: items.filter((i) => i.unread).length })}
      ${filterRow([t(S.filterAll), t(S.filterInvites), t(S.titleRooms), t(S.filterResults)], filter)}
      <div class="card">${items.length === 0
        ? `<div class="welcome"><b>${esc(t(S.inboxWelcomeTitle))}</b><p class="mut">${esc(t(S.inboxWelcome))}</p></div>`
        : shown.length === 0 ? `<p class="empty">${esc(t(S.nothingHere))}</p>` : shown.map(row).join("")}</div>
      ${navHtml("/")}`;
    wireNav(container, router);
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(".tabs button"))) el.onclick = () => { filter = el.textContent ?? "All"; paint(); };
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-accept]"))) {
      el.onclick = async (e) => {
        e.stopPropagation();
        try {
          const r = await acceptInbox(identity?.deviceToken ?? "", el.dataset.accept!);
          connectToMatch({ matchUuid: r.matchUuid, joinCode: null, seat: r.seat, seatToken: r.seatToken, rulesetId: r.rulesetId, matchFormat: r.matchFormat });
        } catch { /* stays in the list; a retry is another tap */ }
      };
    }
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-dismiss]"))) {
      el.onclick = async (e) => {
        e.stopPropagation();
        const id = el.dataset.dismiss!;
        items = items.filter((m) => m.id !== id);
        paint();
        try { await dismissInbox(identity?.deviceToken ?? "", id); } catch { /* best effort */ }
      };
    }
  };
  container.innerHTML = `<div class="spinner">${esc(t(S.loading))}</div>`;
  void getInbox(identity?.deviceToken ?? "").then((list) => { items = list; paint(); }).catch(() => { items = []; paint(); });
  return () => { alive = false; };
};

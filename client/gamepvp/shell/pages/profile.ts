/** Profile (`/me`) — name, rating, links to Account and Game settings. */
import { getStatsRecord, type StatsRecordRow } from "../../net.js";
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { S, t } from "../strings.js";
import { avatarLetter, navHtml, pageTop, secCard, wireNav } from "../ui.js";

export const mount: PageMount = (container, _params, router) => {
  let alive = true;
  container.innerHTML = `<div class="spinner">${esc(t(S.loading))}</div>`;
  void getStatsRecord(identity?.deviceToken ?? "", { player: identity?.playerId ?? "" }).then((rows) => {
    if (!alive) return;
    const row: StatsRecordRow | null = rows[0] ?? null;
    container.innerHTML = `
      ${pageTop(t(S.titleProfile), { back: "/", displayName: identity?.displayName ?? "", unread: 0 })}
      <div class="card"><div class="row">
        <span class="avatar" style="width:44px;height:44px;font-size:18px">${avatarLetter(identity?.displayName ?? "")}</span>
        <div><b style="font-size:17px">${esc(identity?.displayName ?? "")}</b><br>
          <small class="mut">${row?.rating != null ? `rating ${row.rating} · provisional · ` : ""}${row?.games ?? 0} games</small></div>
        <div style="margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <a href="#" class="more" data-nav="/me/account">${esc(t(S.gearAccount))}</a>
          <a href="#" class="more" data-nav="/me/settings">${esc(t(S.gearSettings))}</a>
        </div></div></div>
      ${secCard(t(S.secYourNumbers), "green", row ? `<div class="stats"><div class="tiles">
          <div><b>${row.games}</b><small>games</small></div><div><b>${Math.round(row.winPct * 100)}%</b><small>win rate</small></div>
          <div><b>${row.worthPerHand.toFixed(1)}</b><small>worth/hand</small></div><div><b>${row.placements.join("·")}</b><small>1st·2nd·3rd·4th</small></div>
        </div></div>` : `<p class="empty">${esc(t(S.nothingHere))}</p>`)}
      ${navHtml("/")}`;
    wireNav(container, router);
  }).catch(() => {
    if (!alive) return;
    container.innerHTML = `${pageTop(t(S.titleProfile), { back: "/", displayName: identity?.displayName ?? "", unread: 0 })}<p class="empty">${esc(t(S.nothingHere))}</p>${navHtml("/")}`;
    wireNav(container, router);
  });
  return () => { alive = false; };
};

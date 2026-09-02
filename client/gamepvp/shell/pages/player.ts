/** A player's own page (`/players/:id`) — their record, reached by tapping
 *  a name anywhere (friends, tables, the match-end scoreboard). */
import { getStatsRecord, type StatsRecordRow } from "../../net.js";
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { S, t } from "../strings.js";
import { avatarLetter, navHtml, pageTop, secCard, wireNav } from "../ui.js";

export const mount: PageMount = (container, params, router) => {
  let alive = true;
  const id = params.id!;
  container.innerHTML = `<div class="spinner">${esc(t(S.loading))}</div>`;
  void getStatsRecord(identity?.deviceToken ?? "", { player: id }).then((rows) => {
    if (!alive) return;
    const row: StatsRecordRow | null = rows[0] ?? null;
    container.innerHTML = `
      ${pageTop(row?.displayName ?? id, { back: "/friends", displayName: identity?.displayName ?? "", unread: 0 })}
      <div class="card"><div class="row"><span class="avatar" style="width:44px;height:44px;font-size:18px">${avatarLetter(row?.displayName ?? id)}</span>
        <div><b style="font-size:17px">${esc(row?.displayName ?? id)}</b><br><small class="mut">${row?.rating != null ? `rating ${row.rating} · ` : ""}${row?.games ?? 0} games</small></div></div></div>
      ${secCard(t(S.titleStats), "green", row ? `<div class="stats"><div class="tiles">
          <div><b>${row.games}</b><small>games</small></div><div><b>${Math.round(row.winPct * 100)}%</b><small>win rate</small></div>
          <div><b>${row.worthPerHand.toFixed(1)}</b><small>worth/hand</small></div><div><b>${row.placements.join("·")}</b><small>1st·2nd·3rd·4th</small></div>
        </div></div>` : `<p class="empty">${esc(t(S.nothingHere))}</p>`)}
      ${navHtml("/friends")}`;
    wireNav(container, router);
  }).catch(() => {
    if (!alive) return;
    container.innerHTML = `${pageTop(id, { back: "/friends", displayName: identity?.displayName ?? "", unread: 0 })}<p class="empty">${esc(t(S.nothingHere))}</p>${navHtml("/friends")}`;
    wireNav(container, router);
  });
  return () => { alive = false; };
};

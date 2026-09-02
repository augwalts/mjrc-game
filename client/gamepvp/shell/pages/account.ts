/** Account (`/me/account`) — the lab's own list, each row a stub until the
 *  site's account section exists (lobby-lab.html's own note: "verify the
 *  list against the live site before building"). */
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { S, t } from "../strings.js";
import { navHtml, pageTop, wireNav } from "../ui.js";

export const mount: PageMount = (container, _params, router) => {
  container.innerHTML = `
    ${pageTop(t(S.titleAccount), { back: "/me", displayName: identity?.displayName ?? "", unread: 0 })}
    <div class="card">
      <div class="listrow"><span>${esc(t(S.displayName))}</span><b>${esc(identity?.displayName ?? "—")} ›</b></div>
      <div class="listrow"><span>${esc(t(S.handle))}</span><b>@${esc((identity?.displayName ?? "you").toLowerCase().replace(/\s+/g, ""))} ›</b></div>
      <div class="listrow"><span>${esc(t(S.signIn))}</span><b class="mut">${esc(t(S.notLinked))} · Google ›</b></div>
      <div class="listrow"><span>${esc(t(S.devicesWithAccess))}</span><b>this device ›</b></div>
      <div class="listrow"><span>${esc(t(S.almanacProfile))}</span><b class="mut">${esc(t(S.notLinked))} ›</b></div>
      <div class="listrow"><span>${esc(t(S.exportData))}</span><b>›</b></div>
      <div class="listrow"><span>${esc(t(S.deleteAccount))}</span><b style="color:var(--red)">›</b></div>
    </div>
    <p class="mut" style="margin-top:8px;font-size:12px">${esc(t(S.accountFooter))}</p>
    ${navHtml("/")}`;
  wireNav(container, router);
};

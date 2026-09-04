/**
 * A game's own page (`/games/:id`) — result with rating deltas, progression,
 * hand-by-hand table, this viewer's hands, decisions (desktop), chat,
 * replay/share (PVP-LOBBY-PROPOSAL §10, "Score progression is a per-game
 * view").
 */
import { getGame, type GameDetail } from "../../net.js";
import { matchFormatLabel, ruleLabel } from "../../table.js";
import { progressionSvg, chartTokens } from "../charts.js";
import type { PageMount } from "../router.js";
import { esc, fmtChips, identity } from "../session.js";
import { S, t } from "../strings.js";
import { navHtml, pageTop, secCard } from "../ui.js";
import { wireNav } from "../ui.js";

function standingsHtml(g: GameDetail): string {
  return g.standings.map((s) => `<div class="row"><b style="width:30px">${s.place}${["st", "nd", "rd", "th"][s.place - 1] ?? "th"}</b>
    <span>${esc(s.displayName)}</span>
    <span class="${s.chips > 0 ? "up" : s.chips < 0 ? "down" : ""}" style="margin-left:auto">${fmtChips(s.chips)}</span>
    ${s.ratingAfter != null ? `<small class="mut" style="width:90px;text-align:right">${s.ratingAfter} (${s.ratingDelta != null ? fmtChips(s.ratingDelta) : "—"})</small>` : ""}
  </div>`).join("");
}
function handRows(g: GameDetail): string {
  if (g.hands.length === 0) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  return `<table class="lb"><tr><th>hand</th><th>result</th><th>fan</th><th>東</th><th>南</th><th>西</th><th>北</th></tr>${
    g.hands.map((h) => {
      const r = h as Record<string, unknown>;
      return `<tr><td>${esc(String(r.label ?? r.hand ?? ""))}</td><td>${esc(String(r.result ?? ""))}</td><td>${esc(String(r.fan ?? ""))}</td>
        ${["e", "s", "w", "n"].map((k) => `<td>${esc(String((r[k] as string | number | undefined) ?? ""))}</td>`).join("")}</tr>`;
    }).join("")
  }</table>`;
}

export const mount: PageMount = (container, params, router) => {
  let alive = true;
  const id = params.id!;
  container.innerHTML = `<div class="spinner">${esc(t(S.loading))}</div>`;
  void getGame(identity?.deviceToken ?? "", id).then((g) => {
    if (!alive) return;
    const T = chartTokens();
    container.innerHTML = `
      ${pageTop(`Game · ${new Date(g.startedAt).toLocaleDateString()}`, { back: "/stats", displayName: identity?.displayName ?? "", unread: 0 })}
      <div class="card"><div class="row">
        <div><b>${esc(ruleLabel(g.rulesetId))} · ${matchFormatLabel(g.matchFormat)}</b><br>
        <small class="mut">${g.mode} · ${g.roomName ? esc(g.roomName) : "open hall"} · ${g.handCount} hands</small></div>
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="sit sm ghost" id="btnReplay" ${g.replayToken ? "" : "disabled"}>${esc(t(S.replay))}</button>
          <button class="sit sm ghost" id="btnShare" ${g.replayToken ? "" : "disabled"}>${esc(t(S.share))}</button>
        </div></div></div>
      ${secCard(t(S.secResult), "green", standingsHtml(g))}
      ${secCard(t(S.secProgression), "gold", progressionSvg([], [], T.gold))}
      ${secCard(t(S.secHandByHand), "green", handRows(g))}
      ${secCard(t(S.secChatFromGame), "blue", g.chat.length > 0 ? g.chat.map((m) => `<div><b>${esc(m.displayName)}</b> ${esc(m.text)}</div>`).join("") : `<p class="empty">${esc(t(S.nothingHere))}</p>`)}
      ${navHtml("/stats")}`;
    wireNav(container, router);
    if (g.replayToken) {
      document.getElementById("btnReplay")!.addEventListener("click", () => window.open(`/replay/${g.replayToken}`, "_blank"));
      document.getElementById("btnShare")!.addEventListener("click", () => {
        const url = `${location.origin}/replay/${g.replayToken}`;
        void navigator.clipboard?.writeText(url).catch(() => {});
      });
    }
  }).catch(() => {
    if (!alive) return;
    container.innerHTML = `${pageTop("Game", { back: "/stats", displayName: identity?.displayName ?? "", unread: 0 })}<p class="empty">${esc(t(S.nothingHere))}</p>${navHtml("/stats")}`;
    wireNav(container, router);
  });
  return () => { alive = false; };
};

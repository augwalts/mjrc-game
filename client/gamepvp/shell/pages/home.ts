/**
 * Home — Variant D (lobby-lab.html, design of record): Play now / Join by
 * code, Friends top 5, Your numbers with streak, Your recent games (3) with
 * ranked/casual badges. Desktop: two columns via `.cols` (theme.css).
 */
import { getFriends, getInbox, getStatsRecord, listMatches, type FriendEntry, type MatchListItem, type StatsRecordRow } from "../../net.js";
import type { PageMount } from "../router.js";
import { esc, fmtChips, identity } from "../session.js";
import { S, t } from "../strings.js";
import { ICONS, avatarLetter, navHtml, pageTop, secCard, wireNav } from "../ui.js";
import { mountNewTableModal, mountJoinModal } from "./newtable.js";

function dot(state: string): string {
  const cls = state === "waiting" ? "wait" : state === "playing" ? "play" : "";
  return `<span class="dot ${cls}"></span>`;
}
function friendStateLabel(f: FriendEntry): string {
  if (f.state === "offline") return f.lastSeenAt ? new Date(f.lastSeenAt).toLocaleDateString() : "offline";
  if (f.state === "lobby") return "in the lobby";
  if (f.state === "waiting") return `waiting at a table ${typeof f.hand === "number" ? "" : ""}`.trim();
  return f.hand !== undefined ? `playing, hand ${f.hand + 1}/${f.handsBase ?? "?"}` : "playing";
}
function friendsHtml(list: FriendEntry[]): string {
  if (list.length === 0) return `<p class="empty">no friends yet — play a game with someone</p>`;
  return list.slice(0, 5).map((f) => `<div class="row frow" data-nav="/players/${esc(f.playerId)}" style="padding:5px 0">
      <span class="avatar">${avatarLetter(f.displayName)}</span><b>${esc(f.displayName)}</b>
      <span class="mut">${f.state === "offline" ? "" : dot(f.state)} ${esc(friendStateLabel(f))}</span>
      <span style="margin-left:auto;color:var(--dim);font-size:12px">${f.rating === null ? "unrated" : f.rating}</span>
    </div>`).join("") + `<a class="more" data-nav="/players">${esc(t(S.allPlayers))}</a>`;
}
function statsHtml(row: StatsRecordRow | null): string {
  if (!row) return `<p class="empty">play a game to see your numbers</p>`;
  const places = row.placements.join("·");
  return `<div class="tiles">
      <div><b>${row.rating ?? "—"}</b><small>rating${row.rating !== null && row.rating !== undefined ? " · provisional" : ""}</small></div>
      <div><b>${row.wins}/${row.games}</b><small>wins</small></div>
      <div><b>${row.agreement !== null && row.agreement !== undefined ? `${Math.round(row.agreement * 100)}%` : "—"}</b><small>like the engine</small></div>
      <div><b>${places}</b><small>1st·2nd·3rd·4th</small></div></div>
    <div class="streak"><span class="flame">${ICONS.flame}</span><b>${row.streakDays}-day streak</b><span>best ${row.bestStreak}</span></div>`;
}
function recentGamesHtml(list: MatchListItem[]): string {
  if (list.length === 0) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  return list.slice(0, 3).map((m) => {
    const chips = m.finalChips ?? 0;
    return `<div class="row frow" data-nav="/games/${esc(m.matchId)}">${new Date(m.startedAt).toLocaleDateString()} ·
      <b>${m.place ? `${m.place}${["st", "nd", "rd", "th"][m.place - 1] ?? "th"}` : m.status}</b>
      <span class="${chips > 0 ? "up" : chips < 0 ? "down" : ""}">${m.finalChips === null ? "—" : fmtChips(m.finalChips)}</span>
      <span class="badge ${m.rated ? "ranked" : ""}" style="margin-left:auto">${m.rated ? "ranked" : "casual"}</span></div>`;
  }).join("") + `<a class="more" data-nav="/stats">${esc(t(S.allGames))}</a>`;
}

export const mount: PageMount = (container, _params, router) => {
  let alive = true;
  container.innerHTML = `<div class="spinner">${esc(t(S.loading))}</div>`;
  const token = identity?.deviceToken ?? "";
  const playerId = identity?.playerId ?? "";

  const paintShell = (unread: number): void => {
    if (!alive) return;
    container.innerHTML = `
      ${pageTop(t(S.titleHome), { displayName: identity?.displayName ?? "", unread })}
      <div class="cta"><button class="primary" id="ctaPlay"><b>${esc(t(S.playNow))}</b><small>${esc(t(S.playNowSub))}</small></button>
      <button id="ctaJoin"><b>${esc(t(S.joinByCode))}</b><small>${esc(t(S.joinByCodeSub))}</small></button></div>
      <div class="cols">
        <div>
          ${secCard(t(S.secYourNumbers), "green", `<div class="stats"><div id="statsBody" class="spinner">${esc(t(S.loading))}</div></div>`)}
          ${secCard(t(S.secYourGames), "green", `<div id="recentBody" class="spinner">${esc(t(S.loading))}</div>`)}
        </div>
        <div>
          ${secCard(t(S.secFriends), "blue", `<div id="friendsBody" class="spinner">${esc(t(S.loading))}</div>`)}
        </div>
      </div>
      ${navHtml("/")}`;
    wireNav(container, router);
    document.getElementById("ctaPlay")!.addEventListener("click", () => mountNewTableModal());
    document.getElementById("ctaJoin")!.addEventListener("click", () => mountJoinModal());
  };
  paintShell(0);

  void getInbox(token).then((inbox) => { if (alive) paintShell(inbox.filter((i) => i.unread).length); }).catch(() => { /* degrade: badge stays 0 */ });
  void getFriends(token).then((friends) => {
    const el = document.getElementById("friendsBody");
    if (el) el.innerHTML = friendsHtml(friends);
    wireNav(container, router);
  }).catch(() => { const el = document.getElementById("friendsBody"); if (el) el.innerHTML = `<p class="empty">${esc(t(S.nothingHere))}</p>`; });
  void getStatsRecord(token, { player: playerId }).then((rows) => {
    const el = document.getElementById("statsBody");
    if (el) el.innerHTML = statsHtml(rows[0] ?? null);
  }).catch(() => { const el = document.getElementById("statsBody"); if (el) el.innerHTML = statsHtml(null); });
  void listMatches(token, { limit: 3 }).then((r) => {
    const el = document.getElementById("recentBody");
    if (el) el.innerHTML = recentGamesHtml(r.matches);
    wireNav(container, router);
  }).catch(() => { const el = document.getElementById("recentBody"); if (el) el.innerHTML = recentGamesHtml([]); });

  return () => { alive = false; };
};

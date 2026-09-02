/**
 * Stats — the standard set (PVP-LOBBY-PROPOSAL §10), in the proposal's own
 * order: overall tiles, recent games, hand histogram by winning fan, score
 * progression, feeds by points, recent form, hand sizes by game, hand type
 * × fan, rating, decisions, leaderboard. Filters: All · Online · Offline ·
 * Ranked · Casual · ruleset · Last 10 · Last 5.
 */
import {
  getLeaderboard, getStatsHistograms, getStatsRecord, getStatsSeries, listMatches,
  type CasualLeaderboardEntry, type LeaderboardMode, type MatchListItem,
  type RankedLeaderboardEntry, type StatsHistograms, type StatsScope, type StatsSeries, type StatsRecordRow,
} from "../../net.js";
import { RULE_PICKS, ruleLabel } from "../../table.js";
import { chartTokens, lineChartSvg, progressionSvg } from "../charts.js";
import type { PageMount } from "../router.js";
import { esc, fmtChips, identity } from "../session.js";
import { S, t } from "../strings.js";
import { navHtml, pageTop, secCard, wireNav } from "../ui.js";

const FILTERS = ["All", "Online", "Offline", "Ranked", "Casual", ...RULE_PICKS.map(([, label]) => label), "Last 10", "Last 5"];

function scopeFromFilter(filter: string, playerId: string): StatsScope {
  const scope: StatsScope = { player: playerId };
  if (filter === "Online") scope.source = "online";
  else if (filter === "Offline") scope.source = "offline";
  else if (filter === "Ranked") scope.mode = "ranked";
  else if (filter === "Casual") scope.mode = "casual";
  else if (filter === "Last 10") scope.lastN = 10;
  else if (filter === "Last 5") scope.lastN = 5;
  else { const pick = RULE_PICKS.find(([, label]) => label === filter); if (pick) scope.rulesetId = pick[0]; }
  return scope;
}

function tilesHtml(row: StatsRecordRow | null): string {
  if (!row) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  return `<div class="tiles">
    <div><b>${row.games}</b><small>games · ${row.hands} hands</small></div>
    <div><b>${row.worthPerHand.toFixed(1)}</b><small>worth/hand</small></div>
    <div><b>${Math.round(row.winPct * 100)}%</b><small>win rate</small></div>
    <div><b>${row.inPct.toFixed(1)}</b><small>IN rate</small></div>
  </div>
  <div class="tiles" style="margin-top:8px">
    <div><b>${row.rating ?? "—"}</b><small>rating · online</small></div>
    <div><b>${row.placements.join("·")}</b><small>1st·2nd·3rd·4th</small></div>
    <div><b>${row.selfDraws}</b><small>self-draws</small></div>
    <div><b>${row.avgWinFan ?? "—"}</b><small>avg win fan</small></div>
  </div>`;
}
function recentGamesHtml(list: MatchListItem[]): string {
  if (list.length === 0) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  return list.map((m) => {
    const chips = m.finalChips ?? 0;
    return `<div class="row frow" data-nav="/games/${esc(m.matchId)}">${new Date(m.startedAt).toLocaleDateString()} ·
      <b>${m.place ? `${m.place}${["st", "nd", "rd", "th"][m.place - 1] ?? "th"}` : m.status}</b>
      <span class="${chips > 0 ? "up" : chips < 0 ? "down" : ""}">${m.finalChips === null ? "—" : fmtChips(m.finalChips)}</span>
      <span class="badge ${m.rated ? "ranked" : ""}" style="margin-left:auto">${m.rated ? "ranked" : "casual"}</span>
      <span class="badge">${esc(ruleLabel(m.rulesetId))}</span></div>`;
  }).join("");
}
function faanHistHtml(hist: StatsHistograms | null): string {
  if (!hist) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  const T = chartTokens();
  const rulesets = Object.entries(hist.fan.byRuleset);
  if (rulesets.length === 0) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  const colors = [T.gold, T.series2, T.series3];
  const series = rulesets.map(([, arr], i) => ({ v: arr, c: colors[i % colors.length]!, dots: true }));
  const labels = Array.from({ length: (rulesets[0]?.[1].length ?? 13) }, (_, i) => (i === 13 ? "13+" : String(i + 1)));
  return `${lineChartSvg(series, labels)}<small class="mut">${rulesets.map(([id], i) => `<span style="color:${colors[i % colors.length]}">—</span> ${esc(ruleLabel(id))}`).join(" ")}</small>`;
}
function handSizesHtml(hist: StatsHistograms | null): string {
  if (!hist || hist.fanByGame.length === 0) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  const T = chartTokens();
  return progressionSvg(hist.fanByGame, [], T.gold);
}
function handTypeHtml(hist: StatsHistograms | null): string {
  if (!hist || hist.handType.length === 0) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  return hist.handType.map((h) => `<div class="row"><span>${esc(h.id)}</span><b style="margin-left:auto">${h.count} · avg ${h.avgFan} fan</b></div>`).join("");
}
function feedsHtml(hist: StatsHistograms | null): string {
  if (!hist) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  const T = chartTokens();
  const row = (arr: StatsHistograms["feeds"]["from"], color: string): string =>
    arr.length === 0 ? `<p class="empty">${esc(t(S.nothingHere))}</p>` : arr.map((f) => `<div class="row" style="padding:3px 0"><span style="width:80px">${esc(f.displayName ?? f.playerId)}</span>
      <svg viewBox="0 0 300 14" width="60%" height="14"><rect x="0" y="2" width="${Math.min(300, f.points / 4)}" height="10" rx="3" fill="${color}"/></svg>
      <b style="margin-left:auto">${f.points} pts · ${f.hands}</b></div>`).join("");
  return `<small class="mut">who feeds you</small>${row(hist.feeds.from, T.green)}
    <small class="mut" style="display:block;margin-top:10px">who you feed</small>${row(hist.feeds.to, T.red)}`;
}
function progressionHtml(series: StatsSeries | null): string {
  if (!series) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  const T = chartTokens();
  const games = series.progression.map((g) => g.hands);
  return progressionSvg(games, series.progressionAvg.mean ?? [], T.gold);
}
function formHtml(series: StatsSeries | null): string {
  if (!series || series.worthByGame.length === 0) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  const T = chartTokens();
  return lineChartSvg([{ v: series.worthByGame.map((w) => w.worth), c: T.green, dots: true }],
    series.worthByGame.map((_, i) => String(i + 1)));
}
function ratingHtml(series: StatsSeries | null): string {
  if (!series || series.rating.length === 0) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  const T = chartTokens();
  return lineChartSvg([{ v: series.rating.map((r) => r.after), c: T.gold }], series.rating.map(() => ""));
}
function leaderboardHtml(mode: LeaderboardMode, entries: (RankedLeaderboardEntry | CasualLeaderboardEntry)[], me: string): string {
  if (entries.length === 0) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  if (mode === "ranked") {
    const rows = entries as RankedLeaderboardEntry[];
    return `<table class="lb"><tr><th>player</th><th>games</th><th>rating</th></tr>${
      rows.map((r) => `<tr class="${r.playerId === me ? "me" : ""}"><td>${esc(r.displayName)}</td><td>${r.games}</td><td>${r.rating}${r.provisional ? " (p)" : ""}</td></tr>`).join("")
    }</table>`;
  }
  const rows = entries as CasualLeaderboardEntry[];
  return `<table class="lb"><tr><th>player</th><th>games</th><th>wins</th><th>places</th></tr>${
    rows.map((r) => `<tr class="${r.playerId === me ? "me" : ""}"><td>${esc(r.displayName)}</td><td>${r.matches}</td><td>${r.wins}</td><td>${r.places.join("·")}</td></tr>`).join("")
  }</table>`;
}

export const mount: PageMount = (container, _params, router) => {
  let alive = true;
  let filter = "All";
  const playerId = identity?.playerId ?? "";
  const token = identity?.deviceToken ?? "";

  const sections = [
    "tiles", "recent", "hist", "progression", "feeds", "form", "sizes", "handtype", "rating", "leaderboard",
  ] as const;
  const body: Record<(typeof sections)[number], string> = {
    tiles: `<p class="spinner">${esc(t(S.loading))}</p>`, recent: `<p class="spinner">${esc(t(S.loading))}</p>`,
    hist: `<p class="spinner">${esc(t(S.loading))}</p>`, progression: `<p class="spinner">${esc(t(S.loading))}</p>`,
    feeds: `<p class="spinner">${esc(t(S.loading))}</p>`, form: `<p class="spinner">${esc(t(S.loading))}</p>`,
    sizes: `<p class="spinner">${esc(t(S.loading))}</p>`, handtype: `<p class="spinner">${esc(t(S.loading))}</p>`,
    rating: `<p class="spinner">${esc(t(S.loading))}</p>`, leaderboard: `<p class="spinner">${esc(t(S.loading))}</p>`,
  };

  const paint = (): void => {
    if (!alive) return;
    container.innerHTML = `
      ${pageTop(t(S.titleStats), { displayName: identity?.displayName ?? "", unread: 0 })}
      <div class="tabs" id="statFilters">${FILTERS.map((f) => `<button class="${f === filter ? "on" : ""}" data-f="${esc(f)}">${esc(f)}</button>`).join("")}</div>
      <div class="dash">
        ${secCard(t(S.titleStats), "green", `<div class="stats">${body.tiles}</div>`)}
        <div class="cell">${secCard(t(S.secRecentGames), "green", body.recent)}</div>
        <div class="cell">${secCard(t(S.secHistogram), "gold", body.hist)}</div>
        <div class="cell">${secCard(t(S.secLeaderboard), "blue", body.leaderboard)}</div>
        <div class="cell">${secCard(t(S.secProgression), "gold", body.progression)}</div>
        <div class="cell">${secCard(t(S.secForm), "green", body.form)}</div>
        <div class="cell">${secCard(t(S.secHandSizes), "gold", body.sizes)}</div>
        <div class="cell">${secCard(t(S.secRating), "grey", body.rating)}</div>
        <div class="cell">${secCard(t(S.secFeeds), "blue", body.feeds)}</div>
        <div class="cell">${secCard(t(S.secHandType), "gold", body.handtype)}</div>
      </div>
      ${navHtml("/stats")}`;
    wireNav(container, router);
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("#statFilters button"))) {
      el.onclick = () => { filter = el.dataset.f!; loadAll(); };
    }
  };
  paint();

  const patch = (key: (typeof sections)[number], html: string): void => { body[key] = html; if (alive) paint(); };

  function loadAll(): void {
    for (const k of sections) body[k] = `<p class="spinner">${esc(t(S.loading))}</p>`;
    paint();
    const scope = scopeFromFilter(filter, playerId);
    void getStatsRecord(token, scope).then((rows) => patch("tiles", tilesHtml(rows[0] ?? null))).catch(() => patch("tiles", tilesHtml(null)));
    void listMatches(token, { limit: 10 }).then((r) => patch("recent", recentGamesHtml(r.matches))).catch(() => patch("recent", recentGamesHtml([])));
    void getStatsHistograms(token, scope).then((h) => {
      patch("hist", faanHistHtml(h)); patch("sizes", handSizesHtml(h)); patch("handtype", handTypeHtml(h)); patch("feeds", feedsHtml(h));
    }).catch(() => { patch("hist", faanHistHtml(null)); patch("sizes", handSizesHtml(null)); patch("handtype", handTypeHtml(null)); patch("feeds", feedsHtml(null)); });
    void getStatsSeries(token, scope).then((s) => {
      patch("progression", progressionHtml(s)); patch("form", formHtml(s)); patch("rating", ratingHtml(s));
    }).catch(() => { patch("progression", progressionHtml(null)); patch("form", formHtml(null)); patch("rating", ratingHtml(null)); });
    void getLeaderboard(token, "ranked").then((r) => patch("leaderboard", leaderboardHtml("ranked", r.entries, playerId))).catch(() => patch("leaderboard", leaderboardHtml("ranked", [], playerId)));
  }
  loadAll();

  return () => { alive = false; };
};

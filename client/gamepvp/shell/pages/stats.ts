/**
 * Stats — the standard set (PVP-LOBBY-PROPOSAL §10), in the proposal's own
 * order: overall tiles, recent games, hand histogram by winning fan, score
 * progression, feeds by points, recent form, hand sizes by game, hand type
 * × fan, rating, decisions, leaderboard. Filters: All · Online · Offline ·
 * Ranked · Casual · ruleset · Last 10 · Last 5.
 *
 * Every module title carries an ⓘ button (secCardInfo, ui.ts) that opens a
 * plain-language explanation of what the number is, how it's computed, and
 * which filters apply — written per module in strings.ts (`S.statsHelp*`).
 */
import {
  getLeaderboard, getStatsHistograms, getStatsRecord, getStatsSeries, listMatches,
  type CasualLeaderboardEntry, type LeaderboardMode, type MatchListItem,
  type RankedLeaderboardEntry, type StatsHistograms, type StatsScope, type StatsSeries, type StatsRecordRow,
} from "../../net.js";
import { AWARDS, RULE_PICKS, ruleLabel } from "../../table.js";
import { chartTokens, lineChartSvg, progressionSvg } from "../charts.js";
import type { PageMount } from "../router.js";
import { esc, fmtChips, identity } from "../session.js";
import { S, t } from "../strings.js";
import { avatarHtml, navHtml, pageTop, secCardInfo, wireInfoSheets, wireNav } from "../ui.js";

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

/** Tiny four-bar sparkline for the placements tile — ink-coloured bars,
 *  counts under the bars, 1st..4th labels under those. Local to stats.ts:
 *  unlike charts.ts's line/bar charts this is a fixed 4-category glyph, not
 *  a reusable series shape. */
function placementsSparkline(placements: readonly [number, number, number, number]): string {
  const T = chartTokens();
  const W = 120, H = 30, n = 4, bw = 16, gap = (W - bw * n) / (n + 1);
  const max = Math.max(...placements, 1);
  const bars = placements.map((v, i) => {
    const x = gap + i * (bw + gap);
    const h = Math.max(1, v / max * H);
    return `<rect x="${x}" y="${H - h}" width="${bw}" height="${h}" rx="2" fill="${T.ink}"/>` +
      `<text x="${x + bw / 2}" y="${H + 10}" text-anchor="middle" fill="${T.dim}" font-size="9">${v}</text>`;
  }).join("");
  const labels = ["1st", "2nd", "3rd", "4th"].map((l, i) => {
    const x = gap + i * (bw + gap) + bw / 2;
    return `<text x="${x}" y="${H + 21}" text-anchor="middle" fill="${T.dim}" font-size="8">${l}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H + 24}" width="100%" height="44">${bars}${labels}</svg>`;
}

function tilesHtml(row: StatsRecordRow | null): string {
  if (!row) return `<p class="empty">${esc(t(S.statsEmptyTiles))}</p>`;
  return `<div class="tiles">
    <div><b>${row.games}</b><small>games · ${row.hands} hands</small></div>
    <div><b>${row.worthPerHand.toFixed(1)}</b><small>worth per hand</small></div>
    <div><b>${Math.round(row.winPct * 100)}%</b><small>win rate</small></div>
    <div><b>${row.inPct.toFixed(1)}</b><small>dealt-in %</small></div>
  </div>
  <div class="tiles" style="margin-top:8px">
    <div><b>${row.rating ?? "—"}</b><small>rating · online</small></div>
    <div class="place-tile">${placementsSparkline(row.placements)}</div>
    <div><b>${row.selfDraws}</b><small>self-draws</small></div>
    <div><b>${row.avgWinFan ?? "—"}</b><small>avg win fan</small></div>
  </div>`;
}
function recentGamesHtml(list: MatchListItem[]): string {
  if (list.length === 0) return `<p class="empty">${esc(t(S.statsEmptyRecent))}</p>`;
  // `MatchListItem` (net.ts) carries no opponent names — only playerId-less
  // aggregate fields (place, finalChips, faanWon) — so the "opponents on a
  // second line" item is skipped here; nothing to read, nothing to show.
  return list.map((m) => {
    const chips = m.finalChips ?? 0;
    return `<div class="recent-item frow" data-nav="/games/${esc(m.matchId)}">
      <div class="row">${m.name ? `<b>${esc(m.name)}</b> · ` : ""}${new Date(m.startedAt).toLocaleDateString()} ·
      <b>${m.place ? `${m.place}${["st", "nd", "rd", "th"][m.place - 1] ?? "th"}` : m.status}</b>
      <span class="${chips > 0 ? "up" : chips < 0 ? "down" : ""}">${m.finalChips === null ? "—" : fmtChips(m.finalChips)}</span>
      <span class="badge ${m.rated ? "ranked" : ""}" style="margin-left:auto">${m.rated ? "ranked" : "casual"}</span>
      <span class="badge">${esc(ruleLabel(m.rulesetId))}</span></div>
    </div>`;
  }).join("");
}
function faanHistHtml(hist: StatsHistograms | null): string {
  if (!hist) return `<p class="empty">${esc(t(S.statsEmptyHistogram))}</p>`;
  const T = chartTokens();
  const rulesets = Object.entries(hist.fan.byRuleset);
  if (rulesets.length === 0) return `<p class="empty">${esc(t(S.statsEmptyHistogram))}</p>`;
  const colors = [T.gold, T.series2, T.series3];
  const series = rulesets.map(([, arr], i) => ({ v: arr, c: colors[i % colors.length]!, dots: true }));
  const labels = Array.from({ length: (rulesets[0]?.[1].length ?? 13) }, (_, i) => (i === 13 ? "13+" : String(i + 1)));
  const legend = rulesets.map(([id, arr], i) => {
    const total = arr.reduce((a, b) => a + b, 0);
    return `<span style="color:${colors[i % colors.length]}">—</span> ${esc(ruleLabel(id))} · ${total} hands`;
  }).join("  ");
  return `${lineChartSvg(series, labels, { xLabel: "winning fan" })}<small class="mut">${legend}</small>`;
}
function handSizesHtml(hist: StatsHistograms | null): string {
  if (!hist || hist.fanByGame.length === 0) return `<p class="empty">${esc(t(S.statsEmptySizes))}</p>`;
  const T = chartTokens();
  return progressionSvg(hist.fanByGame, [], T.gold, { yLabel: "fan" });
}
function handTypeHtml(hist: StatsHistograms | null): string {
  if (!hist || hist.handType.length === 0) return `<p class="empty">${esc(t(S.statsEmptyHandType))}</p>`;
  // Human-readable names (table.ts's AWARDS: "對對糊 All Pungs"), never the
  // pattern id; most-won first; one column per number so nothing reads as
  // "2 · avg 1 fan" (owner, 2026-09-03).
  const rows = [...hist.handType].sort((a, b) => b.count - a.count);
  return `<table class="lb"><tr><th>hand</th><th>wins</th><th>avg fan</th></tr>${
    rows.map((h) => `<tr><td>${esc(AWARDS[h.id] ?? h.id)}</td><td>${h.count}</td><td>${Number(h.avgFan).toFixed(1)}</td></tr>`).join("")
  }</table>`;
}
function feedsHtml(hist: StatsHistograms | null): string {
  if (!hist) return `<p class="empty">${esc(t(S.statsEmptyFeeds))}</p>`;
  const row = (arr: StatsHistograms["feeds"]["from"], color: string): string => {
    if (arr.length === 0) return `<p class="empty">${esc(t(S.statsEmptyFeeds))}</p>`;
    const max = Math.max(...arr.map((f) => f.points), 1);
    return arr.map((f) => `<div class="feedrow"><span class="fname">${esc(f.displayName ?? f.playerId)}</span>
      <svg viewBox="0 0 300 14" width="100%" height="14"><rect x="0" y="2" width="${f.points / max * 300}" height="10" rx="3" fill="${color}"/></svg>
      <b>+${f.points} · ${f.hands} hand${f.hands === 1 ? "" : "s"}</b></div>`).join("");
  };
  const T = chartTokens();
  return `<small class="mut">who feeds you</small>${row(hist.feeds.from, T.green)}
    <small class="mut" style="display:block;margin-top:10px">who you feed</small>${row(hist.feeds.to, T.red)}`;
}
function progressionHtml(series: StatsSeries | null): string {
  if (!series) return `<p class="empty">${esc(t(S.statsEmptyProgression))}</p>`;
  const T = chartTokens();
  // The Worker's series answer carries the per-game hand series inside
  // `progressionAvg.games` (no top-level `progression` today); accept both,
  // and never throw here — this `.then` also patches form and rating.
  const games = series.progression?.map((g) => g.hands) ?? series.progressionAvg?.games ?? [];
  if (games.length === 0) return `<p class="empty">${esc(t(S.statsEmptyProgression))}</p>`;
  return progressionSvg(games, series.progressionAvg.mean ?? [], T.gold, { yLabel: "chips" });
}
function formHtml(series: StatsSeries | null): string {
  if (!series || series.worthByGame.length === 0) return `<p class="empty">${esc(t(S.statsEmptyForm))}</p>`;
  const T = chartTokens();
  return lineChartSvg([{ v: series.worthByGame.map((w) => w.worth), c: T.green, dots: true }],
    series.worthByGame.map((_, i) => String(i + 1)), { yLabel: "worth", zeroLine: true });
}
function ratingHtml(series: StatsSeries | null): string {
  if (!series || series.rating.length === 0) return `<p class="empty">${esc(t(S.statsEmptyRating))}</p>`;
  const T = chartTokens();
  return lineChartSvg([{ v: series.rating.map((r) => r.after), c: T.gold }], series.rating.map(() => ""));
}
/** Current rating + change over the shown window, for the title-row "right"
 *  slot (small, ink) — owner: "show the current rating and the change over
 *  the window as numbers", not only as a line. */
function ratingSummary(series: StatsSeries | null): string {
  if (!series || series.rating.length === 0) return "";
  const cur = series.rating[series.rating.length - 1]!.after;
  const delta = cur - series.rating[0]!.before;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  return `${cur} (${sign}${Math.abs(delta)})`;
}
function leaderboardHtml(mode: LeaderboardMode, entries: (RankedLeaderboardEntry | CasualLeaderboardEntry)[], me: string): string {
  if (entries.length === 0) return `<p class="empty">${esc(t(S.statsEmptyLeaderboard))}</p>`;
  if (mode === "ranked") {
    const rows = entries as RankedLeaderboardEntry[];
    return `<table class="lb"><tr><th>player</th><th>games</th><th>rating</th></tr>${
      rows.map((r) => `<tr class="${r.playerId === me ? "me" : ""}"><td class="lbname">${avatarHtml(r.displayName, r.avatar)}${esc(r.displayName)}</td><td>${r.games}</td><td>${r.rating}${r.provisional ? " (p)" : ""}</td></tr>`).join("")
    }</table>`;
  }
  const rows = entries as CasualLeaderboardEntry[];
  return `<table class="lb"><tr><th>player</th><th>games</th><th>wins</th><th>places</th></tr>${
    rows.map((r) => `<tr class="${r.playerId === me ? "me" : ""}"><td class="lbname">${avatarHtml(r.displayName, r.avatar)}${esc(r.displayName)}</td><td>${r.matches}</td><td>${r.wins}</td><td>${r.places.join("·")}</td></tr>`).join("")
  }</table>`;
}

export const mount: PageMount = (container, _params, router) => {
  let alive = true;
  let filter = "All";
  let ratingRight = "";
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
        ${secCardInfo(t(S.titleStats), "green", `<div class="stats">${body.tiles}</div>`, { title: t(S.titleStats), body: t(S.statsHelpTiles) })}
        <div class="cell">${secCardInfo(t(S.secRecentGames), "green", body.recent, { title: t(S.secRecentGames), body: t(S.statsHelpRecent) })}</div>
        <div class="cell">${secCardInfo(t(S.secHistogram), "gold", body.hist, { title: t(S.secHistogram), body: t(S.statsHelpHistogram) })}</div>
        <div class="cell">${secCardInfo(t(S.secLeaderboard), "blue", body.leaderboard, { title: t(S.secLeaderboard), body: t(S.statsHelpLeaderboard) })}</div>
        <div class="cell">${secCardInfo(t(S.secProgression), "gold", body.progression, { title: t(S.secProgression), body: t(S.statsHelpProgression) })}</div>
        <div class="cell">${secCardInfo(t(S.secForm), "green", body.form, { title: t(S.secForm), body: t(S.statsHelpForm) })}</div>
        <div class="cell">${secCardInfo(t(S.secHandSizes), "gold", body.sizes, { title: t(S.secHandSizes), body: t(S.statsHelpSizes) })}</div>
        <div class="cell">${secCardInfo(t(S.secRating), "grey", body.rating, { title: t(S.secRating), body: t(S.statsHelpRating) }, ratingRight)}</div>
        <div class="cell">${secCardInfo(t(S.secFeeds), "blue", body.feeds, { title: t(S.secFeeds), body: t(S.statsHelpFeeds) })}</div>
        <div class="cell">${secCardInfo(t(S.secHandType), "gold", body.handtype, { title: t(S.secHandType), body: t(S.statsHelpHandType) })}</div>
      </div>
      ${navHtml("/stats")}`;
    wireNav(container, router);
    wireInfoSheets(container);
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("#statFilters button"))) {
      el.onclick = () => { filter = el.dataset.f!; loadAll(); };
    }
  };
  paint();

  const patch = (key: (typeof sections)[number], html: string): void => { body[key] = html; if (alive) paint(); };

  function loadAll(): void {
    for (const k of sections) body[k] = `<p class="spinner">${esc(t(S.loading))}</p>`;
    ratingRight = "";
    paint();
    const scope = scopeFromFilter(filter, playerId);
    void getStatsRecord(token, scope).then((rows) => patch("tiles", tilesHtml(rows[0] ?? null))).catch(() => patch("tiles", tilesHtml(null)));
    void listMatches(token, { limit: 10 }).then((r) => patch("recent", recentGamesHtml(r.matches))).catch(() => patch("recent", recentGamesHtml([])));
    void getStatsHistograms(token, scope).then((h) => {
      patch("hist", faanHistHtml(h)); patch("sizes", handSizesHtml(h)); patch("handtype", handTypeHtml(h)); patch("feeds", feedsHtml(h));
    }).catch(() => { patch("hist", faanHistHtml(null)); patch("sizes", handSizesHtml(null)); patch("handtype", handTypeHtml(null)); patch("feeds", feedsHtml(null)); });
    void getStatsSeries(token, scope).then((s) => {
      ratingRight = ratingSummary(s);
      patch("progression", progressionHtml(s)); patch("form", formHtml(s)); patch("rating", ratingHtml(s));
    }).catch(() => { ratingRight = ""; patch("progression", progressionHtml(null)); patch("form", formHtml(null)); patch("rating", ratingHtml(null)); });
    void getLeaderboard(token, "ranked").then((r) => patch("leaderboard", leaderboardHtml("ranked", r.entries, playerId))).catch(() => patch("leaderboard", leaderboardHtml("ranked", [], playerId)));
  }
  loadAll();

  return () => { alive = false; };
};

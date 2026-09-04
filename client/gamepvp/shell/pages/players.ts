/**
 * Players (`/players`) — design of record: client/gamepvp/players-lab.html
 * round 3. ONE list on both surfaces:
 *
 *   phone   title + a search icon and a filter icon, three chips
 *           (All · Friends · Online), rows of star · name-over-status ·
 *           rank-over-game-count. The icons open the search bar and a bottom
 *           sheet holding rank format, games counted and sort.
 *   ≥900px  the same rows with the search bar and all four chip groups open,
 *           and three more stat columns beside rank.
 *
 * Nothing exists on one surface the other cannot reach — the phone just folds
 * it. There is no separate leaderboard: sorting by rank IS the leaderboard
 * (lab §4).
 *
 * Replaces the old Friends page. The lobby chat card that lived there is
 * gone, not moved: the Open hall room page carries the same chat.
 */
import { getPlayers, starFriend, unstarFriend, type PlayerSummary, type PlayersQuery } from "../../net.js";
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { S, t } from "../strings.js";
import { avatarHtml, navHtml, pageTop, wireNav } from "../ui.js";

const ICON_SEARCH = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const ICON_FILTER = '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';

/** The four filters, remembered per device (lab: the phone and the desktop
 *  are one screen, so one saved shape serves both). `q` is deliberately NOT
 *  saved — a search is a moment, not a preference. */
type Filters = Required<Pick<PlayersQuery, "scope" | "format" | "games" | "sort">>;
const DEFAULTS: Filters = { scope: "all", format: "hk", games: "all", sort: "recent" };
const LS_FILTERS = "mjrc.gamepvp.playerFilters";

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(LS_FILTERS);
    if (raw === null) return { ...DEFAULTS };
    const saved = JSON.parse(raw) as Partial<Filters>;
    /* Field by field, against the live vocabulary: a value this build no
     * longer offers (or a hand-edited key) falls back to its default rather
     * than being sent to the server, which would only degrade it anyway. */
    return {
      scope: SCOPES.some(([k]) => k === saved.scope) ? saved.scope! : DEFAULTS.scope,
      format: FORMATS.some(([k]) => k === saved.format) ? saved.format! : DEFAULTS.format,
      games: GAMESETS.some(([k]) => k === saved.games) ? saved.games! : DEFAULTS.games,
      sort: SORTS.some(([k]) => k === saved.sort) ? saved.sort! : DEFAULTS.sort,
    };
  } catch { return { ...DEFAULTS }; }
}
function saveFilters(f: Filters): void {
  try { localStorage.setItem(LS_FILTERS, JSON.stringify(f)); } catch { /* private mode — the page still works */ }
}

/* Each group is [value, label] pairs in the lab's own order and wording. */
const SCOPES = [
  ["all", () => t(S.filterAll)], ["friends", () => t(S.filterFriends)], ["online", () => t(S.filterOnline)],
] as const;
const FORMATS = [
  ["hk", () => t(S.rankHk)], ["tw", () => t(S.rankTw)], ["offline", () => t(S.rankOffline)],
] as const;
const GAMESETS = [
  ["all", () => t(S.filterAll)], ["online", () => t(S.filterOnline)], ["offline", () => t(S.filterOffline)],
] as const;
const SORTS = [
  ["recent", () => t(S.sortRecent)], ["rank", () => t(S.sortRank)],
  ["games", () => t(S.sortGames)], ["worth", () => t(S.sortWorth)],
] as const;

const chipGroup = (
  key: keyof Filters,
  items: readonly (readonly [string, () => string])[],
  on: string,
): string =>
  items.map(([v, label]) =>
    `<button data-f="${key}" data-v="${v}" class="${v === on ? "on" : ""}">${esc(label())}</button>`).join("");

/* ── presentation ─────────────────────────────────────────────────────── */

const pct = (v: number | null): string => (v === null ? "—" : `${Math.round(v * 100)}%`);
/** Worth per hand is signed and small; the lab prints it to two places with
 *  an explicit sign and colours it. */
const worth = (v: number | null): string => (v === null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`);
const worthCls = (v: number | null): string => (v === null || v === 0 ? "" : v > 0 ? "up" : "dn");

/** "offline · Tue" / "offline · last week" / "offline · 12/05/2026" — the
 *  lab's three shapes, cheapest first. */
function seenLabel(iso: string | undefined): string {
  if (iso === undefined) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const days = (Date.now() - at) / 86_400_000;
  if (days < 7) return new Date(at).toLocaleDateString(undefined, { weekday: "short" });
  if (days < 14) return "last week";
  return new Date(at).toLocaleDateString();
}

/** The status cell: a dot and a phrase. The room name is desktop-only (the
 *  phone row has no width for it), hence `.pl-web` on that fragment. */
function statusHtml(p: PlayerSummary): string {
  const st = p.status;
  const room = st.room ? `<span class="pl-web"> · ${esc(st.room)}</span>` : "";
  if (st.state === "online") return `<i></i><span class="t">${esc(t(S.statusOnline))}</span>`;
  if (st.state === "queue") {
    return `<i class="q"></i><span class="t">${esc(t(S.statusQueue))} · ${esc(st.queue ?? "?/4")}${room}</span>`;
  }
  if (st.state === "playing") {
    const hand = st.hand === undefined ? "" : ` · ${esc(t(S.handWord))} ${st.hand + 1}/${st.handsBase ?? "?"}`;
    return `<i></i><span class="t">${esc(t(S.statusPlaying))}${hand}${room}</span>`;
  }
  const seen = seenLabel(st.lastSeenAt);
  return `<i class="off"></i><span class="t">${esc(t(S.statusOffline))}${seen ? ` · ${esc(seen)}` : ""}</span>`;
}

function rowHtml(p: PlayerSummary, meId: string): string {
  const sub = p.handle !== null ? `@${esc(p.handle)}` : esc(t(S.notLinkedName));
  return `<div class="pl-lr ${p.id === meId ? "pl-me" : ""}" data-nav="/players/${esc(p.id)}">
    <button class="star ${p.starred ? "on" : ""}" data-star="${esc(p.id)}" aria-label="star">${p.starred ? "★" : "☆"}</button>
    <div class="pl-pid ${p.linked ? "" : "unlinked"}">${avatarHtml(p.displayName, p.avatar)}<span class="pl-nm"><b>${esc(p.displayName)}</b><small>${sub}</small></span></div>
    <span class="pl-pres">${statusHtml(p)}</span>
    <span class="pl-num"><b>${p.rank ?? "—"}</b><small>${esc(t(S.nGames(p.games)))}</small></span>
    <span class="pl-num pl-web">${p.games}</span>
    <span class="pl-num pl-web">${pct(p.winPct)}</span>
    <span class="pl-num pl-web ${worthCls(p.worthPerHand)}">${worth(p.worthPerHand)}</span>
  </div>`;
}

function listHtml(list: PlayerSummary[], meId: string): string {
  if (list.length === 0) return `<p class="empty">${esc(t(S.nothingHere))}</p>`;
  return `<div class="card pl-card">
    <div class="pl-lh"><span></span><span>${esc(t(S.colPlayer))}</span><span class="pl-web">${esc(t(S.colStatus))}</span><span class="r">${esc(t(S.colRank))}</span><span class="r pl-web">${esc(t(S.colGames))}</span><span class="r pl-web">${esc(t(S.colWinPct))}</span><span class="r pl-web">${esc(t(S.colWorth))}</span></div>
    ${list.map((p) => rowHtml(p, meId)).join("")}
  </div>`;
}

/* ── the page ─────────────────────────────────────────────────────────── */

export const mount: PageMount = (container, _params, router) => {
  let alive = true;
  let filters = loadFilters();
  let query = "";
  let searchOpen = false;
  let sheetOpen = false;
  let list: PlayerSummary[] = [];
  let loading = true;
  let seq = 0;

  const token = identity?.deviceToken ?? "";
  const meId = identity?.playerId ?? "";

  const fetchList = async (): Promise<void> => {
    const mine = ++seq;
    try {
      const rows = await getPlayers(token, { ...filters, q: query || undefined });
      /* Out-of-order responses: only the newest request may paint, or a slow
       * early query overwrites the letters typed after it. */
      if (!alive || mine !== seq) return;
      list = rows;
    } catch {
      if (!alive || mine !== seq) return;
      list = [];
    }
    loading = false;
    paintList();
    paintCounts();
  };

  const paintList = (): void => {
    const el = container.querySelector("#plList");
    if (el === null) return;
    el.innerHTML = loading ? `<div class="spinner">${esc(t(S.loading))}</div>` : listHtml(list, meId);
    wireNav(container, router);
    wireStars();
  };

  /** The two places the result count is written: the desktop's title-row
   *  readout and the sheet's primary button. Both are painted before the
   *  fetch returns, so both are refreshed after it. */
  const paintCounts = (): void => {
    const btn = container.querySelector("#plShow");
    if (btn !== null) btn.textContent = t(S.showNPlayers(list.length));
    const count = container.querySelector("#plCount");
    if (count !== null) count.textContent = t(S.nPlayers(list.length));
  };

  const sheetHtml = (): string => `<div class="pl-sheet" id="plSheet"><div class="pl-pane">
      <h4>${esc(t(S.filterTitle))}<button id="plReset">${esc(t(S.filterReset))}</button></h4>
      <div class="k">${esc(t(S.sheetRank))}</div><div class="pl-chips">${chipGroup("format", FORMATS, filters.format)}</div>
      <div class="k">${esc(t(S.sheetGames))}</div><div class="pl-chips">${chipGroup("games", GAMESETS, filters.games)}</div>
      <div class="k">${esc(t(S.sheetSort))}</div><div class="pl-chips">${chipGroup("sort", SORTS, filters.sort)}</div>
      <button class="pl-primary" id="plShow">${esc(t(S.showNPlayers(list.length)))}</button>
    </div></div>`;

  const paint = (): void => {
    if (!alive) return;
    const actions = `<span class="pl-count pl-web" id="plCount">${esc(t(S.nPlayers(list.length)))}</span>
      <div class="pl-ico">
        <button id="plSearchBtn" class="${searchOpen ? "on" : ""}" title="search" aria-label="search">${ICON_SEARCH}</button>
        <button id="plFilterBtn" class="${sheetOpen ? "on" : ""}" title="filter" aria-label="filter">${ICON_FILTER}</button>
      </div>`;
    /* NOT wrapped in an element of its own: `.view > .nav` is what turns the
     * bottom nav into a desktop top row (theme.css ≥1100px), and a wrapper
     * would bury it. */
    container.innerHTML = `
      ${pageTop(t(S.titlePlayers), { displayName: identity?.displayName ?? "", unread: 0, alt: "玩家", actions })}
      <div class="pl-search ${searchOpen ? "open" : ""}"><input id="plQ" type="search" placeholder="${esc(t(S.searchPlayers))}" value="${esc(query)}"></div>
      <div class="pl-chips ${searchOpen ? "pl-hidep" : ""}">
        <span class="k pl-web">${esc(t(S.groupShow))}</span>${chipGroup("scope", SCOPES, filters.scope)}
        <span class="k pl-web">${esc(t(S.groupRank))}</span><span class="pl-web">${chipGroup("format", FORMATS, filters.format)}</span>
        <span class="k pl-web">${esc(t(S.groupGames))}</span><span class="pl-web">${chipGroup("games", GAMESETS, filters.games)}</span>
        <span class="k pl-web">${esc(t(S.groupSort))}</span><span class="pl-web">${chipGroup("sort", SORTS, filters.sort)}</span>
      </div>
      <div id="plList"></div>
      ${sheetOpen ? sheetHtml() : ""}
      ${navHtml("/players")}`;
    wireNav(container, router);
    wireChrome();
    paintList();
  };

  /** A chip changes one field, saves, repaints (the chip's own `on` state is
   *  in the markup) and refetches — the server owns filtering and sorting, so
   *  nothing here re-sorts a stale list behind the request. */
  const wireChips = (): void => {
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-f]"))) {
      el.onclick = () => {
        const key = el.dataset.f as keyof Filters;
        filters = { ...filters, [key]: el.dataset.v } as Filters;
        saveFilters(filters);
        loading = true;
        paint();
        void fetchList();
      };
    }
  };

  let debounce = 0;
  const wireChrome = (): void => {
    wireChips();
    container.querySelector<HTMLElement>("#plSearchBtn")!.onclick = () => {
      searchOpen = !searchOpen;
      if (!searchOpen && query !== "") { query = ""; loading = true; void fetchList(); }
      paint();
      if (searchOpen) container.querySelector<HTMLInputElement>("#plQ")?.focus();
    };
    container.querySelector<HTMLElement>("#plFilterBtn")!.onclick = () => { sheetOpen = !sheetOpen; paint(); };

    const input = container.querySelector<HTMLInputElement>("#plQ");
    if (input !== null) {
      input.oninput = () => {
        query = input.value.trim();
        window.clearTimeout(debounce);
        /* 300 ms: long enough that a typed word is one request, short enough
         * that the list feels live. */
        debounce = window.setTimeout(() => void fetchList(), 300);
      };
    }

    const sheet = container.querySelector<HTMLElement>("#plSheet");
    if (sheet !== null) {
      sheet.onclick = (e) => { if (e.target === sheet) { sheetOpen = false; paint(); } };
      container.querySelector<HTMLElement>("#plShow")!.onclick = () => { sheetOpen = false; paint(); };
      container.querySelector<HTMLElement>("#plReset")!.onclick = () => {
        filters = { ...DEFAULTS };
        saveFilters(filters);
        loading = true;
        paint();
        void fetchList();
      };
    }
  };

  /** Optimistic, then reconciled: the glyph flips on tap and flips back if
   *  the server refuses — the same posture friends.ts used before it. */
  const wireStars = (): void => {
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-star]"))) {
      el.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = el.dataset.star!;
        const on = el.classList.contains("on");
        el.classList.toggle("on", !on);
        el.textContent = on ? "☆" : "★";
        const row = list.find((p) => p.id === id);
        if (row !== undefined) row.starred = !on;
        try { if (on) await unstarFriend(token, id); else await starFriend(token, id); }
        catch {
          el.classList.toggle("on", on);
          el.textContent = on ? "★" : "☆";
          if (row !== undefined) row.starred = on;
        }
      };
    }
  };

  paint();
  void fetchList();
  return () => { alive = false; window.clearTimeout(debounce); };
};

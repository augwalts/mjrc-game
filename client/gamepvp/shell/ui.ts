/**
 * Shared shell chrome: the top bar (title, colour square, back, the
 * envelope + name corner), the bottom nav, and the "fold a section title
 * into the card below it" card helper — every `shell/pages/*.ts` builds its
 * screen out of these instead of re-deriving the same markup. Matches
 * lobby-lab.html's own `pageTop`/`navHtml`/`foldTitles` closely; simplified
 * to build the folded card directly rather than doing lab's post-render DOM
 * surgery, since every page here already knows its own section labels up
 * front.
 */
import { esc } from "./session.js";
import { S, t } from "./strings.js";
import type { Router } from "./router.js";

export const ICONS = {
  home: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/></svg>',
  rooms: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V6l8-3 8 3v14"/><path d="M9 20v-5h6v5"/></svg>',
  friends: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 20a5 5 0 0 1 6-4.5"/></svg>',
  stats: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  flame: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/></svg>',
};

/** Module colour is meaning, one rule (lobby-lab.html's own comment):
 *  green = tables/rooms/games, blue = people, gold = stats, red = attention,
 *  grey = reference/system. */
const HUE: Record<string, string> = {
  Home: "var(--ink)", Rooms: "#1a8b3a", Friends: "#1845a5", Stats: "#e3cf70",
  Messages: "#c1272d", Account: "var(--dim)", "Game settings": "var(--dim)",
  Game: "#1a8b3a", Profile: "#1845a5",
};
function hueFor(title: string): string {
  return HUE[title] ?? HUE[Object.keys(HUE).find((h) => title.startsWith(h)) ?? ""] ?? "";
}

export const NAV: readonly [string, () => string, () => string][] = [
  ["/", () => ICONS.home, () => t(S.navHome)],
  ["/rooms", () => ICONS.rooms, () => t(S.navRooms)],
  ["/friends", () => ICONS.friends, () => t(S.navFriends)],
  ["/stats", () => ICONS.stats, () => t(S.navStats)],
];
const NAV_KEY: Record<string, string> = { "/": "home", "/rooms": "rooms", "/friends": "friends", "/stats": "stats" };

/** The name + envelope corner, shown on every page's top bar. `unread` is
 *  best-effort (0 until the inbox has been fetched at least once this
 *  session) — never blocks the page it sits on. */
export function meHtml(displayName: string, unread: number): string {
  return `<div class="me">
    <button class="inbox" data-nav="/messages" title="messages">${ICONS.inbox}${unread > 0 ? `<span class="n">${unread > 99 ? "99+" : unread}</span>` : ""}</button>
    <button class="name" data-nav="/me"><span class="dot"></span>${esc(displayName)}</button>
  </div>`;
}

export function pageTop(title: string, opts: { back?: string; displayName: string; unread: number }): string {
  const hue = hueFor(title);
  return `<div class="top">
    ${opts.back ? `<button class="back" data-nav="${opts.back}">‹</button>` : ""}
    <h2>${hue ? `<span class="k" style="background:${hue}"></span>` : ""}${esc(title)}</h2>
    ${meHtml(opts.displayName, opts.unread)}
  </div>`;
}

export function navHtml(path: string): string {
  const active = NAV_KEY[path] ?? "";
  return `<div class="nav">${NAV.map(([to, icon, label]) => {
    const k = NAV_KEY[to];
    return `<button data-nav="${to}" data-k="${k}" class="${k === active ? "on" : ""}"><span class="i">${icon()}</span>${esc(label())}</button>`;
  }).join("")}</div>`;
}

export function filterRow(items: readonly string[], on: string): string {
  return `<div class="tabs">${items.map((it) => `<button class="${it === on ? "on" : ""}" data-filter="${esc(it)}">${esc(it)}</button>`).join("")}</div>`;
}

/** A section title folded into the top of its own card, tinted by `tone`
 *  (`"green"|"blue"|"gold"|"red"|"grey"|""`) via `data-tone` — matches
 *  lobby-lab.html's `foldTitles()`/`toneFor()` output shape without needing
 *  its post-render DOM pass. */
export function secCard(label: string, tone: string, bodyHtml: string, cls = ""): string {
  return `<div class="card ${cls}" data-tone="${tone}"><div class="sec in">${esc(label)}</div>${bodyHtml}</div>`;
}

/** Wires every `[data-nav]` element (back button, nav bar, envelope, name,
 *  in-page links) inside `container` to `router.navigate`. Call after every
 *  repaint — pages rebuild their own inner content often, this is cheap and
 *  idempotent. */
export function wireNav(container: ParentNode, router: Router): void {
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-nav]"))) {
    el.onclick = (e) => { e.preventDefault(); router.navigate(el.dataset.nav!); };
  }
}

export const avatarLetter = (name: string): string => esc((name || "?").slice(0, 1).toUpperCase());

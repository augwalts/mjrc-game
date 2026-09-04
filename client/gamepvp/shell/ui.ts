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
import { esc, identity } from "./session.js";
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
  Home: "var(--ink)", Rooms: "#1a8b3a", Players: "#1845a5", Friends: "#1845a5", Stats: "#e3cf70",
  Messages: "#c1272d", Account: "var(--dim)", "Game settings": "var(--dim)",
  Game: "#1a8b3a", Profile: "#1845a5",
};
function hueFor(title: string): string {
  return HUE[title] ?? HUE[Object.keys(HUE).find((h) => title.startsWith(h)) ?? ""] ?? "";
}

export const NAV: readonly [string, () => string, () => string][] = [
  ["/", () => ICONS.home, () => t(S.navHome)],
  ["/rooms", () => ICONS.rooms, () => t(S.navRooms)],
  ["/players", () => ICONS.friends, () => t(S.navPlayers)],
  ["/stats", () => ICONS.stats, () => t(S.navStats)],
];
const NAV_KEY: Record<string, string> = { "/": "home", "/rooms": "rooms", "/players": "players", "/stats": "stats" };

/** The name + envelope corner, shown on every page's top bar. `unread` is
 *  best-effort (0 until the inbox has been fetched at least once this
 *  session) — never blocks the page it sits on. */
export function meHtml(displayName: string, unread: number): string {
  return `<div class="me">
    <button class="inbox" data-nav="/messages" title="messages">${ICONS.inbox}${unread > 0 ? `<span class="n">${unread > 99 ? "99+" : unread}</span>` : ""}</button>
    <button class="name" data-nav="/me">${avatarHtml(displayName, identity?.avatar)}<span class="dot"></span>${esc(displayName)}</button>
  </div>`;
}

/** `alt` is the same word in the other language, dimmed beside the title —
 *  the lab's `Players 玩家` (players-lab.html §1), used where BOTH belong on
 *  screen rather than one being chosen by `SETTINGS.language`. `actions` is
 *  raw HTML dropped between the title and the name corner, for a page whose
 *  title row carries its own controls (Players' search + filter icons). */
export function pageTop(
  title: string,
  opts: { back?: string; displayName: string; unread: number; alt?: string | null; actions?: string },
): string {
  const hue = hueFor(title);
  return `<div class="top">
    ${opts.back ? `<button class="back" data-nav="${opts.back}">‹</button>` : ""}
    <h2>${hue ? `<span class="k" style="background:${hue}"></span>` : ""}${esc(title)}${opts.alt ? `<span class="talt">${esc(opts.alt)}</span>` : ""}</h2>
    ${opts.actions ?? ""}
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

/** A `secCard` with an ⓘ button folded into the title row (and, optionally,
 *  a small numeric readout — e.g. rating's "current (Δ)" — before it). Tapping
 *  the button opens an in-page explanation sheet via `wireInfoSheets`. Kept
 *  general (not stats-specific) so any page — `friends.ts` included — can
 *  reuse the same title-with-info row. */
export function secCardInfo(
  label: string, tone: string, bodyHtml: string,
  info?: { title: string; body: string }, right?: string, cls = "",
): string {
  const rightHtml = right ? `<span class="sec-right">${esc(right)}</span>` : "";
  const infoBtn = info
    ? `<button class="info" data-info-title="${esc(info.title)}" data-info-body="${esc(info.body)}" aria-label="info">ⓘ</button>`
    : "";
  return `<div class="card ${cls}" data-tone="${tone}"><div class="sec in infot"><span>${esc(label)}</span>${rightHtml}${infoBtn}</div>${bodyHtml}</div>`;
}

/** Wires every `[data-info-title]` button inside `container` to open a
 *  small overlay card (close via × / Esc / backdrop) with the plain-language
 *  explanation carried in its `data-info-title`/`data-info-body`. Call after
 *  every repaint, same as `wireNav`. */
export function wireInfoSheets(container: ParentNode): void {
  for (const btn of Array.from(container.querySelectorAll<HTMLElement>("[data-info-title]"))) {
    btn.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      openInfoSheet(btn.dataset.infoTitle ?? "", btn.dataset.infoBody ?? "");
    };
  }
}

function openInfoSheet(title: string, body: string): void {
  const shell = document.getElementById("shell");
  if (!shell) return;
  shell.querySelectorAll(".infoveil").forEach((el) => el.remove());
  const veil = document.createElement("div");
  veil.className = "infoveil";
  veil.innerHTML = `<div class="infocard"><button class="iclose" aria-label="${esc(t(S.close))}">×</button><h3></h3><p></p></div>`;
  veil.querySelector("h3")!.textContent = title;
  veil.querySelector("p")!.textContent = body;
  const close = (): void => { veil.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  veil.querySelector(".iclose")!.addEventListener("click", close);
  veil.addEventListener("click", (e) => { if (e.target === veil) close(); });
  document.addEventListener("keydown", onKey);
  shell.appendChild(veil);
}

/* ── avatar (profile pictures, 2026-09-03) ────────────────────────────────
 * A player's avatar, image or letter, as one drop-in unit — same 28px
 * `.avatar` circle `avatarLetter` already renders inside, so every existing
 * `<span class="avatar">${avatarLetter(name)}</span>` call site can become
 * `${avatarHtml(name, avatar)}` unchanged around it. `avatar` is the data URI
 * from `Identity.avatar`/`FriendEntry.avatar`/etc (net.ts) — falsy (null,
 * undefined, "") falls back to the letter avatar, never a broken `<img>`.
 */
export function avatarHtml(name: string, avatar: string | null | undefined): string {
  if (avatar) return `<img class="avatar avatar-img" src="${esc(avatar)}" alt="">`;
  return `<span class="avatar">${avatarLetter(name)}</span>`;
}

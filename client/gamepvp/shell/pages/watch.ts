/**
 * The admin observer (`/watch`, `/watch/:id` — owner request 2026-09-03,
 * "four windows at the same time, each one a person's hand"). Admin only:
 * the API answers 404 to anyone else, and this page says so. `/watch` lists
 * the live tables the global lobby knows; `/watch/:id` polls one table every
 * 2s and paints four panels, one per seat — that seat's own hand, drawn
 * tile, melds, flowers, discards, and who is on turn. Deliberately plain:
 * it is a monitor for a playtest host, not a player surface.
 */
import { endTable, getLiveTablesEverywhere, getWatch, getWatchTokens, kickSeat, startTable, type LobbyTable, type WatchSeatOwn, type WatchView } from "../../net.js";
import { handLabel, meldHtml, ruleLabel, tileHtml } from "../../table.js";
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { navHtml, pageTop, wireNav } from "../ui.js";

const WINDS = ["東", "南", "西", "北"];

/* ── zoom for the four screens ─────────────────────────────────────────
 * Two knobs, remembered per browser: screens per row (1 · 2 · 4) and the
 * virtual screen each iframe renders at (phone 430×860, tablet 1024×768,
 * desktop 1280×800). The scale is whatever makes that virtual width fit the
 * cell, recomputed on resize. */
const SIZES = { phone: [430, 860], tablet: [1024, 768], desktop: [1280, 800] } as const;
type SizeKey = keyof typeof SIZES;
const ZOOM_KEY = "mjrc.gamepvp.watchZoom";
function readZoom(): { cols: 1 | 2 | 4; size: SizeKey } {
  try {
    const z = JSON.parse(localStorage.getItem(ZOOM_KEY) ?? "{}") as { cols?: number; size?: string };
    return { cols: ([1, 2, 4] as const).find((c) => c === z.cols) ?? 2, size: (z.size && z.size in SIZES ? z.size : "desktop") as SizeKey };
  } catch { return { cols: 2, size: "desktop" }; }
}
function wireZoom(root: HTMLElement): void {
  const screens = root.querySelector<HTMLElement>("#screens");
  if (!screens) return;
  let z = readZoom();
  const apply = (): void => {
    const [vw, vh] = SIZES[z.size];
    screens.style.setProperty("--cols", String(z.cols));
    for (const cell of Array.from(screens.querySelectorAll<HTMLElement>(".cell"))) {
      cell.style.setProperty("--vw", `${vw}px`); cell.style.setProperty("--vh", `${vh}px`);
      cell.style.setProperty("--k", String(Math.min(1, cell.clientWidth / vw)));
    }
    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-zoom] button"))) {
      const group = (b.parentElement as HTMLElement).dataset.zoom;
      b.classList.toggle("on", group === "cols" ? Number(b.dataset.v) === z.cols : b.dataset.v === z.size);
    }
    try { localStorage.setItem(ZOOM_KEY, JSON.stringify(z)); } catch { /* fine */ }
  };
  for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>("[data-zoom] button"))) {
    b.onclick = () => {
      const group = (b.parentElement as HTMLElement).dataset.zoom;
      if (group === "cols") z = { ...z, cols: Number(b.dataset.v) as 1 | 2 | 4 }; else z = { ...z, size: b.dataset.v as SizeKey };
      apply();
    };
  }
  window.addEventListener("resize", apply);
  apply();
  // cells have no width until laid out; one more pass after paint
  requestAnimationFrame(apply);
}
const POLL_MS = 2000;

function tableRow(tb: LobbyTable): string {
  const who = tb.seats.map((s) => s.kind === "bot" ? "bot" : (s.displayName ?? "·")).join(" · ");
  return `<div class="row frow" data-nav="/watch/${esc(tb.matchId)}" style="padding:6px 0">
    <b>${tb.name ? esc(tb.name) : esc(ruleLabel(tb.rulesetId))}</b>
    <span class="mut">${tb.lobbyStatus === "playing" ? handLabel(tb.hand, tb.handsBase) : tb.lobbyStatus}</span>
    <span class="mut" style="margin-left:auto">${esc(who)}</span></div>`;
}

function seatPanel(v: WatchView, seat: 0 | 1 | 2 | 3): string {
  const p = v.players[seat];
  const pr = v.presence[seat];
  const snap = v.seats?.[seat];
  const own = snap?.seats[seat] as WatchSeatOwn | undefined;
  const onTurn = !!snap && snap.turn === seat;
  const status = !p ? "" : p.bot ? "bot" : pr?.botControlled ? "bot playing (away)" : pr?.connected ? "connected" : "disconnected";
  const hand = own ? [...own.hand].sort((a, b) => a - b).map((t) => tileHtml(t, "sm")).join("") : "";
  const drawn = own?.drawn !== null && own?.drawn !== undefined ? tileHtml(own.drawn, "sm") : "";
  const melds = own ? own.melds.map((m) => `<span class="meld">${meldHtml(m as never, "sm")}</span>`).join("") : "";
  const flowers = own ? own.flowers.map((t) => tileHtml(t, "sm")).join("") : "";
  const discards = own ? own.discards.map((t) => tileHtml(t, "sm")).join("") : "";
  return `<div class="card watchseat${onTurn ? " onturn" : ""}">
    <div class="row"><b>${WINDS[own?.wind ?? seat]} ${esc(p?.displayName ?? "—")}</b>
      <span class="mut">${esc(status)}</span>
      ${onTurn ? `<span class="badge ranked" style="margin-left:auto">on turn</span>` : `<span class="mut" style="margin-left:auto">${own ? own.chips : ""}</span>`}</div>
    <div class="wrow"><small class="mut">hand</small><div class="tiles">${hand}${drawn ? `<span class="drawn">${drawn}</span>` : ""}</div></div>
    ${melds ? `<div class="wrow"><small class="mut">melds</small><div class="tiles">${melds}</div></div>` : ""}
    ${flowers ? `<div class="wrow"><small class="mut">flowers</small><div class="tiles">${flowers}</div></div>` : ""}
    <div class="wrow"><small class="mut">discards</small><div class="tiles dis">${discards || "<span class=mut>none yet</span>"}</div></div>
  </div>`;
}

function viewHtml(v: WatchView): string {
  const snap = v.seats?.[0];
  const head = !v.started ? "waiting to start"
    : v.over ? "match over"
    : snap ? `${WINDS[snap.roundWind]}圈 · hand ${snap.handIndex + 1} · ${WINDS[snap.dealer]} deals · wall ${snap.wallRemaining}`
      + (snap.lastDiscard ? ` · last ${WINDS[snap.lastDiscard.from]} threw ${tileHtml(snap.lastDiscard.tile, "sm")}` : "")
    : "";
  return `<div class="card"><div class="row"><b>${esc(ruleLabel(v.rulesetId))}</b><span class="mut">${head}</span>
      <small class="mut" style="margin-left:auto">${v.roomCode ? `room ${esc(v.roomCode)}` : ""}</small></div></div>
    <div class="watchgrid">${([0, 1, 2, 3] as const).map((s) => seatPanel(v, s)).join("")}</div>`;
}

const STYLE = `<style>
  #shell .watchgrid{display:grid;grid-template-columns:1fr;gap:10px}
  @media (min-width:900px){#shell .watchgrid{grid-template-columns:1fr 1fr}}
  #shell .watchseat.onturn{outline:2px solid var(--gold,#c9a54a)}
  #shell .wrow{display:flex;gap:8px;align-items:flex-start;margin-top:6px}
  #shell .wrow small{width:58px;flex:0 0 auto;padding-top:4px}
  #shell .tiles{display:flex;flex-wrap:wrap;gap:2px;align-items:flex-end}
  #shell .tiles .tile{--th:40px}
  #shell .tiles.dis .tile{--th:28px}
  #shell .meld{display:inline-flex;gap:1px;margin-right:6px}
  #shell .drawn{margin-left:8px}
  #shell .tiles .back{display:inline-block;width:28px;height:40px;border-radius:4px;background:#2b5f4a}
  /* Each screen is the real client rendered at a VIRTUAL size (--vw × --vh,
     a desktop or a phone) and scaled down to fit its cell — so a cell shows
     the desktop layout small, not the phone layout large. --cols and the
     virtual size are the zoom controls; --k is computed per resize. */
  #shell .screens{display:grid;grid-template-columns:repeat(var(--cols,2),1fr);gap:8px}
  #shell .screens .cell{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#111;height:calc(var(--vh) * var(--k,0.5))}
  #shell .screens .cell iframe{position:absolute;left:0;top:0;width:var(--vw);height:var(--vh);border:0;transform:scale(var(--k,0.5));transform-origin:0 0}
  #shell .zoombar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px}
  #shell .zoombar .seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
  #shell .zoombar .seg button{border:0;border-radius:0;padding:6px 10px;font-size:12px;color:var(--dim);background:none;cursor:pointer}
  #shell .zoombar .seg button.on{background:var(--panel2);color:var(--ink);font-weight:600}
  #shell .zoombar .lbl{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);margin-right:2px}
  #shell .screens .who{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);margin:0 0 4px}
  #shell .hostbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
</style>`;

export const mount: PageMount = (container, params, router) => {
  let alive = true;
  let timer = 0;
  const token = identity?.deviceToken ?? "";
  const id = params.id;

  if (!id) {
    container.innerHTML = `${STYLE}${pageTop("Watch", { back: "/", displayName: identity?.displayName ?? "", unread: 0 })}
      <div class="sec">live tables</div><div class="card" id="watchList"><div class="spinner">loading…</div></div>${navHtml("/")}`;
    wireNav(container, router);
    void getLiveTablesEverywhere(token).then((live) => {
      const el = document.getElementById("watchList");
      if (!el || !alive) return;
      el.innerHTML = live.length ? live.map(tableRow).join("") : `<p class="empty">no live tables</p>`;
      wireNav(container, router);
    }).catch(() => { const el = document.getElementById("watchList"); if (el) el.innerHTML = `<p class="empty">could not load</p>`; });
    return () => { alive = false; };
  }

  container.innerHTML = `${STYLE}${pageTop("Watch", { back: "/watch", displayName: identity?.displayName ?? "", unread: 0 })}
    <div id="watchBody"><div class="spinner">loading…</div></div>${navHtml("/")}`;
  wireNav(container, router);

  // The real thing (owner, 2026-09-03: "what they see on their screens"):
  // four iframes of the actual client, each attached as an observer of one
  // seat. `?panels=1` keeps the summary view.
  if (!new URLSearchParams(location.search).has("panels")) {
    void getWatchTokens(token, id).then((w) => {
      const el = document.getElementById("watchBody");
      if (!el || !alive) return;
      const host = !!identity && w.createdBy === identity.playerId;
      el.innerHTML = `${host ? `<div class="card hostbar"><span class="mut" style="font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase">host controls</span>
          ${w.lobbyStatus === "waiting" ? `<button class="sit sm" data-host="start">start now · fill empty seats with bots</button>` : ""}
          ${[0, 1, 2, 3].map((s) => `<button class="sit sm ghost" data-host="kick" data-seat="${s}">remove ${WINDS[s]}</button>`).join("")}
          <button class="sit sm ghost" data-host="end" style="margin-left:auto;color:var(--red);border-color:var(--red)">end the table</button></div>` : ""}
        <div class="zoombar"><span class="lbl">per row</span><div class="seg" data-zoom="cols">${[1, 2, 4].map((n) => `<button data-v="${n}">${n}</button>`).join("")}</div>
          <span class="lbl" style="margin-left:8px">screen</span><div class="seg" data-zoom="size">${(["phone", "tablet", "desktop"] as const).map((k) => `<button data-v="${k}">${k}</button>`).join("")}</div></div>
        <div class="screens" id="screens">${w.tokens.map((tok, seat) => `<div><p class="who">${WINDS[seat]} · seat ${seat + 1}</p><div class="cell">
        <iframe src="/?spectate=${encodeURIComponent(id)}&seat=${seat}&token=${encodeURIComponent(tok)}&rules=${encodeURIComponent(w.rulesetId)}&format=${encodeURIComponent(w.matchFormat)}" title="seat ${seat + 1}"></iframe></div></div>`).join("")}</div>
        <p class="mut" style="margin-top:8px"><a href="/watch/${esc(id)}?panels=1">summary panels instead ›</a></p>`;
      wireZoom(el);
      // Two taps on remove/end (arm, then send); start is one tap.
      for (const b of Array.from(el.querySelectorAll<HTMLButtonElement>("[data-host]"))) {
        b.onclick = () => {
          const kind = b.dataset.host!;
          if (kind !== "start" && !b.dataset.armed) { b.dataset.armed = "1"; b.dataset.label = b.textContent ?? ""; b.textContent = "tap again to confirm"; return; }
          b.disabled = true;
          const done = (): void => { b.textContent = "done"; };
          const fail = (): void => { b.disabled = false; delete b.dataset.armed; b.textContent = b.dataset.label ?? b.textContent; };
          if (kind === "start") void startTable(token, id).then(done).catch(fail);
          else if (kind === "end") void endTable(token, id).then(done).catch(fail);
          else void kickSeat(token, id, Number(b.dataset.seat) as 0 | 1 | 2 | 3).then(done).catch(fail);
        };
      }
    }).catch((e) => {
      const el = document.getElementById("watchBody");
      if (el && alive) el.innerHTML = `<p class="empty">${esc(String(e).includes("not_found") ? "not found — or you are not an admin" : String(e))}</p>`;
    });
    return () => { alive = false; };
  }
  const tick = async (): Promise<void> => {
    try {
      const v = await getWatch(token, id);
      const el = document.getElementById("watchBody");
      if (el && alive) el.innerHTML = viewHtml(v);
    } catch (e) {
      const el = document.getElementById("watchBody");
      if (el && alive) el.innerHTML = `<p class="empty">${esc(String(e).includes("not_found") ? "not found — or you are not an admin" : String(e))}</p>`;
    }
  };
  void tick();
  timer = window.setInterval(() => { if (document.visibilityState === "visible") void tick(); }, POLL_MS);
  return () => { alive = false; window.clearInterval(timer); };
};

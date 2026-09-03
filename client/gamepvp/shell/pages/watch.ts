/**
 * The admin observer (`/watch`, `/watch/:id` — owner request 2026-09-03,
 * "four windows at the same time, each one a person's hand"). Admin only:
 * the API answers 404 to anyone else, and this page says so. `/watch` lists
 * the live tables the global lobby knows; `/watch/:id` polls one table every
 * 2s and paints four panels, one per seat — that seat's own hand, drawn
 * tile, melds, flowers, discards, and who is on turn. Deliberately plain:
 * it is a monitor for a playtest host, not a player surface.
 */
import { getLobby, getWatch, type LobbyTable, type WatchSeatOwn, type WatchView } from "../../net.js";
import { handLabel, meldHtml, ruleLabel, tileHtml } from "../../table.js";
import type { PageMount } from "../router.js";
import { esc, identity } from "../session.js";
import { navHtml, pageTop, wireNav } from "../ui.js";

const WINDS = ["東", "南", "西", "北"];
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
    void getLobby(token).then((lobby) => {
      const el = document.getElementById("watchList");
      if (!el || !alive) return;
      const live = lobby.tables.filter((tb) => tb.lobbyStatus !== "done");
      el.innerHTML = live.length ? live.map(tableRow).join("") : `<p class="empty">no live tables</p>`;
      wireNav(container, router);
    }).catch(() => { const el = document.getElementById("watchList"); if (el) el.innerHTML = `<p class="empty">could not load</p>`; });
    return () => { alive = false; };
  }

  container.innerHTML = `${STYLE}${pageTop("Watch", { back: "/watch", displayName: identity?.displayName ?? "", unread: 0 })}
    <div id="watchBody"><div class="spinner">loading…</div></div>${navHtml("/")}`;
  wireNav(container, router);
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

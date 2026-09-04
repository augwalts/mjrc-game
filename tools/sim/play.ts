/**
 * Play against the strongest bots — browser game over the real engine.
 * Human sits chair 0; the other three run the current champion profile
 * (window.KINGS from kings.js). Same reducer, same legality, same payments
 * as the sims: mjrc-standard, 3-10 faan.
 *
 * Build: esbuild play.ts --bundle --platform=browser --format=iife --outfile=play.js
 */
import {
  startMatch, startNextHand, applyAction, legalActions,
} from "../../engine/src/reducer.js";
import type { MatchState } from "../../engine/src/reducer.js";
import { decideAction, DEFAULT_PROFILE, assessRoutes, shapeOf, rankDiscards, scoreAdjust, visibleCounts, type BotConfig, type BotProfile, type RouteAssessment, type DiscardScore } from "../../engine/src/bots.js";
import { liveTiles } from "../../engine/src/ready.js";
import { counts } from "../../engine/src/tiles.js";
import { tableThreat } from "../../engine/src/threat.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import { prng } from "../../engine/src/wall.js";
import { TILE_NAMES, isFlower } from "../../engine/src/tiles.js";
import type { Action, SeatIndex, TileId } from "../../engine/src/types.js";
import { viewFor } from "./driver.js";

declare global { interface Window { KINGS?: { king?: Partial<BotProfile>; v2?: Partial<BotProfile>; label?: string } } }

/* ── tiles ───────────────────────────────────────────────────────────── */
const GLYPH: string[] = (() => {
  const g: string[] = [];
  for (let i = 0; i < 9; i++) g.push(String.fromCodePoint(0x1f007 + i));   // 萬
  for (let i = 0; i < 9; i++) g.push(String.fromCodePoint(0x1f010 + i));   // 索
  for (let i = 0; i < 9; i++) g.push(String.fromCodePoint(0x1f019 + i));   // 筒
  g.push("\u{1f000}", "\u{1f001}", "\u{1f002}", "\u{1f003}");              // 東南西北
  g.push("\u{1f004}", "\u{1f005}", "\u{1f006}");                            // 中發白
  for (let i = 0; i < 8; i++) g.push(String.fromCodePoint(0x1f022 + i));   // 花
  return g;
})();
const label = (t: TileId): string => TILE_NAMES[t] ?? `?${t}`;
const WINDS = ["東 East", "南 South", "西 West", "北 North"];

const AWARD_LABELS: Record<string, string> = {
  selfDraw: "Self-Draw 自摸", allChows: "All Chows 平糊", allPungs: "All Pungs 對對糊",
  halfFlush: "Half Flush 混一色", fullFlush: "Full Flush 清一色", dragonPung: "Dragon Pung 三元牌",
  seatWind: "Seat Wind 門風", roundWind: "Round Wind 圈風", ownFlower: "Own Flower 正花",
  ownSeason: "Own Season 正花", noFlowers: "No Flowers 無花", concealedHand: "Concealed 門前清",
  winOnKongReplacement: "Kong Flower 槓上開花", winOnLastTile: "Last Tile 海底撈月",
  winOnLastDiscard: "Last Discard 河底撈魚", smallThreeDragons: "Small 3 Dragons 小三元",
  bigThreeDragons: "Big 3 Dragons 大三元", allTerminals: "All Terminals 清么九",
  allHonours: "All Honours 字一色", fourConcealedPungs: "4 Concealed Pungs 四暗刻",
  nineGates: "Nine Gates 九蓮寶燈", thirteenOrphans: "13 Orphans 十三么",
  robbingKong: "Robbing the Kong 搶槓", mixedTerminals: "Mixed Terminals 混么九",
  allKongs: "All Kongs 十八羅漢", bigFourWinds: "Big 4 Winds 大四喜", smallFourWinds: "Small 4 Winds 小四喜",
  allFlowers: "All 4 Flowers 齊四花", allSeasons: "All 4 Seasons 齊四季", winByDoubleKong: "Double Kong 槓上槓",
};

/* ── setup ───────────────────────────────────────────────────────────── */
const HUMAN: SeatIndex = 0;
const KING: BotProfile = { ...DEFAULT_PROFILE, ...(window.KINGS?.king ?? window.KINGS?.v2 ?? {}) };
const urlSeed = new URLSearchParams(location.search).get("seed");
let seed = urlSeed ? Number(urlSeed) : Math.floor(Math.random() * 2 ** 31);

let state: MatchState;
let botCfgs: BotConfig[];
const feed: string[] = [];
let overlayHtml: string | null = null;
let fast = false;
let peek = false;


function newMatch(): void {
  const r = startMatch({ seed, ruleset: MJRC_STANDARD, matchLength: "oneWindRound" } as never);
  state = r.state;
  botCfgs = [0, 1, 2, 3].map((i) => ({
    ruleset: MJRC_STANDARD, profile: KING,
    rnd: prng((seed ^ ((i + 1) * 0x9e3779b1)) >>> 0),
  }));
  feed.length = 0;
  oddsHistory = []; oddsHtml = "";
  feed.push(`new match · seed ${seed} · you are chair 0 · bots: ${window.KINGS?.label ?? "champion"}`);
  consume(r.events);
  overlayHtml = null;
  advance();
}

/* ── event feed + hand-end overlay ───────────────────────────────────── */
function consume(events: readonly { type: string; payload?: unknown; seat?: number }[]): void {
  for (const e of events as never[]) {
    const ev = e as { type: string; payload: Record<string, never> };
    const p = ev.payload as Record<string, unknown> ?? {};
    const who = (s: unknown): string => (s === HUMAN ? "YOU" : `Bot ${WINDS[state.seats[s as SeatIndex]!.wind]!.slice(0, 1)}`);
    switch (ev.type) {
      case "discard": feed.push(`${who(p.seat)} cuts ${label(p.tile as TileId)}`); break;
      case "claimed": feed.push(`${who(p.seat)} ${p.kind === "chow" ? "chows 上" : p.kind === "pung" ? "pungs 碰" : "kongs 槓"} ${label(p.tile as TileId)}`); break;
      case "claimDeclined": if ((p.reason as string) === "pass" && p.seat !== HUMAN)
        feed.push(`§  ${who(p.seat)} passes on ${(p.options as {kind:string}[] | undefined)?.map((o)=>o.kind).join("/") ?? "claim"} of ${label(p.tile as TileId)}`); break;
      case "concealedKong": feed.push(`${who(p.seat)} concealed kong 暗槓`); break;
      case "addedKong": feed.push(`${who(p.seat)} added kong 加槓 ${label(p.tile as TileId)}`); break;
      case "flowerReplacement": feed.push(`${who(p.seat)} reveals flower ${label(p.flower as TileId)}`); break;
      case "refusedWin": if (p.context && (p.context as { seat: number }).seat === HUMAN)
        feed.push(`!! your winning shape holds only ${(p.score as { faan: number }).faan} faan — refused (3-faan floor)`); break;
      case "winOnDiscard": case "selfDraw": {
        const ctx = p.context as { seat: SeatIndex; selfDraw: boolean; from: SeatIndex | null };
        const score = p.score as { faan: number; awards: { id: string; faan: number }[] };
        const tiles = ((p.concealed as TileId[]) ?? []).map(label).join(" ");
        const melds = ((p.melds as { tiles: TileId[] }[]) ?? []).map((m) => `[${m.tiles.map(label).join(" ")}]`).join(" ");
        overlayHtml = `<h2>${ctx.seat === HUMAN ? "YOU WIN" : who(ctx.seat) + " wins"} — ${score.faan} faan ${ctx.selfDraw ? "自摸 self-draw" : "食糊" + (ctx.from === HUMAN ? " — off YOUR discard" : "")}</h2>
          <div class="tilesrow">${tiles} ${melds}</div>
          <div class="awards">${score.awards.map((a) => `${AWARD_LABELS[a.id] ?? a.id} <b>${a.faan}</b>`).join(" · ")}</div>`;
        break;
      }
      case "exhaustiveDraw": overlayHtml = `<h2>流局 — the wall ran out, nobody wins</h2>`; break;
      case "handEnd": {
        const st = p.standings as number[];
        const deltas = p.chipDeltas as number[] | undefined;
        overlayHtml = (overlayHtml ?? "") + `<div class="pay">${[0, 1, 2, 3].map((i) =>
          `${i === HUMAN ? "YOU" : "Bot " + WINDS[state.seats[i]!.wind]!.slice(0, 1)}: ${deltas ? (deltas[i]! > 0 ? "+" : "") + deltas[i] + " → " : ""}<b>${st[i]}</b>`).join(" · ")}</div>
          <button onclick="window.__next()">next hand ▸</button>`;
        break;
      }
      case "matchEnd": {
        const st = p.standings as number[];
        const order = [0, 1, 2, 3].sort((a, b) => st[b]! - st[a]!);
        overlayHtml = `<h2>MATCH OVER</h2><div class="pay">${order.map((i, r) =>
          `${r + 1}. ${i === HUMAN ? "YOU" : "Bot"} ${st[i]! > 0 ? "+" : ""}${st[i]}`).join(" · ")}</div>
          <button onclick="window.__rematch()">play again ▸</button>`;
        break;
      }
    }
  }
  if (feed.length > 140) feed.splice(0, feed.length - 140);
}

/* ── bot thinking for the side terminal ──────────────────────────────── */
const SUIT_G = ["萬", "索", "筒"];
function routeName(r: RouteAssessment["route"]): string {
  if (r.orphans) return "13-orphans 十三么";
  if (r.honoursOnly) return "honours 字一色";
  if (r.suit !== null) return (r.pungs ? "pung-flush " : "flush ") + (r.suit === "chars" ? "萬" : r.suit === "bamboo" ? "索" : "筒");
  return r.pungs ? "all-pungs 對對糊" : "balanced";
}
function botThink(seat: SeatIndex): string[] {
  const v = viewFor(state, seat);
  const name = `Bot ${WINDS[state.seats[seat]!.wind]!.slice(0, 1)}`;
  const out: string[] = [`§┈ ${name} thinking`];
  const threats = tableThreat(v, MJRC_STANDARD);
  const reads = threats.seats
    .filter((t) => t.threat > 0.15 || t.intentSuit !== null)
    .sort((a, b) => b.threat - a.threat).slice(0, 2)
    .map((t) => `${t.seat === HUMAN ? "YOU" : "Bot " + WINDS[state.seats[t.seat]!.wind]!.slice(0, 1)} threat ${t.threat.toFixed(2)}` +
      (t.intentSuit !== null ? ` · collecting ${SUIT_G[t.intentSuit]}` : "") + ` · est ${t.expectedFaan} faan`);
  if (reads.length) out.push(`§  reads: ${reads.join("  |  ")}`);
  const routes = assessRoutes(shapeOf(v), MJRC_STANDARD, KING, threats)
    .filter((r) => r.feasible && Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score).slice(0, 2);
  if (routes.length) out.push(`§  plans: ` + routes.map((r, i) =>
    `${i === 0 ? "▸" : ""}${routeName(r.route)} (${Math.min(r.faan, 10)}f, ${Math.max(0, r.distance)} away, score ${r.score.toFixed(1)})`).join("  ·  "));
  return out;
}

/* ── win odds: Monte Carlo, two information levels ─────────────────────
 * blind    — what YOU can know: opponents' concealed tiles and the wall are
 *            re-dealt at random from the unseen pool each rollout.
 * all-seeing — every hand known; only the wall ORDER is unknown.
 * Both play every seat with the champion policy. The gap between the bars is
 * the cash value of hidden information. */
let oddsGen = 0;
let oddsHtml = "";
/** Per-hand odds trace — the chess-app eval graph, but win probability. */
let oddsHistory: { blind: number; omni: number }[] = [];
function oddsChart(): string {
  const H = oddsHistory;
  if (H.length < 2) return `<div class="mut" style="font-size:10.5px;margin-top:3px">odds graph builds as the hand goes on…</div>`;
  const W = 460, Hh = 88, L = 30, R = 6, T = 8, B = 16;
  const x = (i: number): number => L + i / Math.max(1, H.length - 1) * (W - L - R);
  const y = (v: number): number => T + (1 - v) * (Hh - T - B);
  const line = (key: "blind" | "omni"): string => H.map((h, i) => `${x(i).toFixed(1)},${y(h[key]).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${Hh}" style="width:100%;height:${Hh}px;display:block;margin-top:4px">
    ${[0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#3a3a44" stroke-width="${v === 0.5 ? 1 : 0.5}" stroke-dasharray="3 3"/>
      <text x="${L - 3}" y="${y(v) + 3}" text-anchor="end" font-size="8" fill="#9a9aa6">${v * 100}%</text>`).join("")}
    <polyline points="${line("blind")}" fill="none" stroke="#7fb3ff" stroke-width="1.6" stroke-dasharray="5 3"/>
    <polyline points="${line("omni")}" fill="none" stroke="#5dbb7a" stroke-width="1.8"/>
    ${H.map((h, i) => `<circle cx="${x(i)}" cy="${y(h.omni)}" r="2" fill="#5dbb7a"/>`).join("")}
    <text x="${L}" y="${Hh - 4}" font-size="8" fill="#7fb3ff">╌ your view (blind)</text>
    <text x="${W - R}" y="${Hh - 4}" text-anchor="end" font-size="8" fill="#5dbb7a">— all-seeing 天眼</text>
  </svg>`;
}
/** Worker pool: rollouts run parallel and off the main thread. */
const POOL: Worker[] = [];
function pool(): Worker[] {
  if (POOL.length === 0) {
    const n = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) POOL.push(new Worker("playworker.js?v=" + Date.now()));
  }
  return POOL;
}
function computeOdds(): void {
  const gen = ++oddsGen;
  const base = state;
  const K = 24;
  const wins = { blind: [0, 0, 0, 0, 0], omni: [0, 0, 0, 0, 0] };
  let doneB = 0, doneO = 0;
  const paint = (final: boolean): void => {
    const pct = (n: number, d: number): string => (d ? `${Math.round(100 * n / d)}%` : "…");
    const b = wins.blind, o = wins.omni;
    oddsHtml = `<div class="oname">Win odds — champion plays it out from here (${doneB + doneO}/${K * 2} rollouts)</div>
      <div class="orow" style="font-size:12px">your view (blind): <b>YOU ${pct(b[0]!, doneB)}</b> · draw ${pct(b[4]!, doneB)}</div>
      <div class="orow" style="font-size:12px">all-seeing 天眼: <b class="${doneO && o[0]! / doneO > (doneB ? b[0]! / doneB : 0) + 0.08 ? "up" : doneO && o[0]! / doneO < (doneB ? b[0]! / doneB : 1) - 0.08 ? "down" : ""}">YOU ${pct(o[0]!, doneO)}</b>
       · 南 ${pct(o[1]!, doneO)} · 西 ${pct(o[2]!, doneO)} · 北 ${pct(o[3]!, doneO)} · draw ${pct(o[4]!, doneO)}</div>`;
    if (final) { oddsHistory.push({ blind: b[0]! / Math.max(1, doneB), omni: o[0]! / Math.max(1, doneO) }); oddsHtml += oddsChart(); }
    const el = document.getElementById("odds");
    if (el) el.innerHTML = oddsHtml;
  };
  const ws = pool();
    const jobs: { blind: boolean; rseed: number }[] = [];
  for (let k = 0; k < K; k++) for (const blind of [true, false]) jobs.push({ blind, rseed: (0xabc123 + k * 613 + (blind ? 7 : 0)) >>> 0 });
  let next = 0;
  const dispatch = (w: Worker): void => {
    if (gen !== oddsGen || next >= jobs.length) return;
    const j = jobs[next++]!;
    w.postMessage({ state: base, blind: j.blind, rseed: j.rseed, king: KING, job: gen });
  };
  for (const w of ws) {
    w.onmessage = (e: MessageEvent): void => {
      const { job, blind, winner } = e.data as { job: number; blind: boolean; winner: number };
      if (job !== oddsGen || gen !== oddsGen) return;
      wins[blind ? "blind" : "omni"][winner < 0 ? 4 : winner]!++;
      if (blind) doneB++; else doneO++;
      paint(doneB + doneO === K * 2);
      dispatch(w);
    };
    dispatch(w); dispatch(w);   // two in flight per worker
  }
  oddsHtml = `<div class="oname">Win odds</div><span class="mut" style="font-size:11.5px">computing…</span>`;
  paint(false);
}

/* ── discard coach: grade the human's cut against the champion's ranking ── */
const coach: { cls: string; html: string }[] = [];
function coachDiscard(tile: TileId): void {
  const v = viewFor(state, HUMAN);
  const cfg: BotConfig = { ruleset: MJRC_STANDARD, profile: scoreAdjust(KING, v), rnd: prng(0xc0ac4) };
  const ranked = [...rankDiscards(v, cfg)].sort((a, b) => b.score - a.score);
  const best = ranked[0]!;
  const mine = ranked.find((d) => d.tile === tile);
  if (!mine) return;
  const rank = ranked.indexOf(mine) + 1;
  const gap = best.score - mine.score;
  const stats = (d: DiscardScore): string => `${d.distance} away · danger ${d.danger.toFixed(1)}${d.outs >= 0 ? ` · ${d.outs} outs` : ""}`;
  // your active plan, waits after the cut, and who a risky cut feeds
  const threats = tableThreat(v, MJRC_STANDARD);
  const routes = assessRoutes(shapeOf(v), MJRC_STANDARD, cfg.profile!, threats)
    .filter((r) => r.feasible && Number.isFinite(r.score)).sort((a, b) => b.score - a.score);
  const plan = routes[0] ? `${routeName(routes[0].route)} — pays ${Math.min(routes[0].faan, 10)} faan, ${Math.max(0, routes[0].distance)} away` : "";
  const waitsAfter = (cut: TileId): string => {
    const all = [...v.hand, ...(v.drawn !== null ? [v.drawn] : [])];
    const c = counts(all); c[cut] = (c[cut] ?? 1) - 1;
    const lt = liveTiles(c, v.melds[v.seat]!.length, visibleCounts(v));
    if (lt.distance > 1) return "";
    return lt.distance === 0
      ? ` · READY — waiting on ${lt.tiles.slice(0, 5).map((w) => `${label(w.tile)}(${w.unseen})`).join(" ")} = ${lt.total} live`
      : ` · 1 away, ${lt.total} improving tiles live`;
  };
  const feeds = (): string => {
    const scary = [...threats.seats].sort((a, b) => b.threat - a.threat)[0];
    return scary && scary.threat > 0.3
      ? ` — mainly ${scary.seat === HUMAN ? "you" : "Bot " + WINDS[state.seats[scary.seat]!.wind]!.slice(0, 1)} (threat ${scary.threat.toFixed(2)}${scary.intentSuit !== null ? ", collecting " + SUIT_G[scary.intentSuit] : ""})` : "";
  };
  const order = ranked.slice(0, 3).map((d) => label(d.tile)).join(" › ");
  let cls: string, head: string, why = "";
  if (tile === best.tile) { cls = "ok"; head = `✓ perfect — the champion cuts ${label(tile)} too`; }
  else if (gap < 0.6) { cls = "ok"; head = `✓ good — within a hair of the champion's ${label(best.tile)}`; }
  else {
    cls = gap < 2.2 ? "mid" : "bad";
    head = `${gap < 2.2 ? "⚠ okay" : "✗ costly"} — champion cuts ${label(best.tile)} (your pick ranked #${rank}/${ranked.length})`;
    if (mine.distance > best.distance) why = `slows your hand: ${mine.distance} away vs ${best.distance}`;
    else if (mine.danger - best.danger > 0.8) why = `riskier: danger ${mine.danger.toFixed(1)} vs ${best.danger.toFixed(1)} — it feeds the table`;
    else if (!mine.onRoute && best.onRoute) why = `off your best route — ${label(best.tile)} keeps the plan intact`;
    else if (mine.outs >= 0 && best.outs >= 0 && mine.outs < best.outs) why = `fewer winning tiles stay live: ${mine.outs} vs ${best.outs}`;
    else why = `the champion's cut simply scores better on speed + safety combined`;
  }
  coach.unshift({ cls, html: `<div class="chead">${head}</div>
    <div class="cbody">${plan ? `your plan: ${plan}<br>` : ""}you cut ${label(tile)} — ${stats(mine)}${waitsAfter(tile)}${
      tile !== best.tile ? `<br>champion: ${label(best.tile)} — ${stats(best)}${waitsAfter(best.tile)}` : ""}${
      why ? `<br><b>${why}${why.startsWith("riskier") ? feeds() : ""}</b>` : ""}<br><span style="opacity:.75">champion's top 3: ${order}</span></div>` });
  if (coach.length > 6) coach.length = 6;
}

/* ── game loop ───────────────────────────────────────────────────────── */
let pendingHuman: Action[] | null = null;

function advance(): void {
  render();
  if (overlayHtml) return;                       // waiting on the overlay button
  if (state.phase === "matchEnd") return;
  if (state.phase === "handEnd") return;         // overlay button drives startNextHand
  const mine = legalActions(state, HUMAN);
  if (mine.length > 0) {
    pendingHuman = mine;
    if (state.phase === "awaitDiscard" && state.turn === HUMAN) computeOdds();
    render(); return;
  }
  for (const seat of [1, 2, 3] as SeatIndex[]) {
    const options = legalActions(state, seat);
    if (options.length === 0) continue;
    const act = (): void => {
      const v = viewFor(state, seat);
      if (!fast && options.some((o) => o.type === "discard")) feed.push(...botThink(seat));
      const a = decideAction(v, options, botCfgs[seat]!);
      const r = applyAction(state, a);
      state = r.state; consume(r.events); advance();
    };
    if (fast) act(); else setTimeout(act, 450);
    return;
  }
  render();
}

function humanAct(a: Action): void {
  pendingHuman = null;
  oddsGen++;   // stale rollouts must not repaint
  const r = applyAction(state, a);
  state = r.state; consume(r.events);
  advance();
}

(window as never as Record<string, unknown>).__next = (): void => {
  overlayHtml = null;
  oddsHistory = []; oddsHtml = "";
  const r = startNextHand(state);
  state = r.state; consume(r.events);
  advance();
};
(window as never as Record<string, unknown>).__rematch = (): void => { seed = Math.floor(Math.random() * 2 ** 31); newMatch(); };
(window as never as Record<string, unknown>).__fast = (on: boolean): void => { fast = on; };
(window as never as Record<string, unknown>).__peek = (on: boolean): void => { peek = on; render(); };

/* ── render ──────────────────────────────────────────────────────────── */
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const tileHtml = (t: TileId, cls = "", onclick = ""): string =>
  `<span class="tile ${cls}" ${onclick ? `onclick="${onclick}"` : ""} title="${label(t)}"><span class="g">${GLYPH[t] ?? "?"}</span><span class="l">${label(t)}</span></span>`;

(window as never as Record<string, unknown>).__discard = (t: number): void => {
  const a = pendingHuman?.find((x) => x.type === "discard" && x.tile === t);
  if (a) { coachDiscard(t as TileId); humanAct(a); }
};
(window as never as Record<string, unknown>).__act = (i: number): void => {
  if (pendingHuman?.[i]) humanAct(pendingHuman[i]!);
};

function render(): void {
  const v = viewFor(state, HUMAN);
  const me = state.seats[HUMAN]!;
  $("topbar").innerHTML =
    `round wind <b>${WINDS[state.roundWind]}</b> · hand ${state.handIndex} · wall <b>${v.wallRemaining}</b> · floor 3 / limit 10 faan` +
    ` · <label style="margin-left:12px"><input type="checkbox" onchange="window.__fast(this.checked)" ${fast ? "checked" : ""}> fast bots</label>` +
    ` <label style="margin-left:8px"><input type="checkbox" onchange="window.__peek(this.checked)" ${peek ? "checked" : ""}> show bot hands 開牌</label>` +
    ` <button style="margin-left:12px" onclick="window.__rematch()">new match</button>`;
  for (const s of [1, 2, 3] as SeatIndex[]) {
    const b = state.seats[s]!;
    $("opp" + s).innerHTML =
      `<div class="oname">Bot ${WINDS[b.wind]} ${state.dealer === s ? "· dealer 莊" : ""} · <b>${b.chips > 0 ? "+" : ""}${b.chips}</b></div>
      <div class="orow">${peek
        ? b.hand.map((t) => tileHtml(t, "s")).join("") + (b.drawn !== null ? '<span class="drawnsep"></span>' + tileHtml(b.drawn, "s drawn") : "")
        : "🀫".repeat(b.hand.length + (b.drawn !== null ? 1 : 0))}</div>
      <div class="orow">${b.melds.map((m) => m.tiles.map((t) => tileHtml(t, "s")).join("")).join(" · ")} ${b.flowers.map((t) => tileHtml(t, "s f")).join("")}</div>
      <div class="river">${b.discards.map((t, i) => tileHtml(t, "s" + (state.lastDiscard && state.lastDiscard.from === s && i === b.discards.length - 1 ? " hot" : ""))).join("")}</div>`;
  }
  $("myinfo").innerHTML = `<div class="oname">YOU — ${WINDS[me.wind]} ${state.dealer === HUMAN ? "· dealer 莊" : ""} · <b>${me.chips > 0 ? "+" : ""}${me.chips}</b></div>
    <div class="orow">${me.melds.map((m) => m.tiles.map((t) => tileHtml(t, "s")).join("")).join(" · ")} ${me.flowers.map((t) => tileHtml(t, "s f")).join("")}</div>
    <div class="river">${me.discards.map((t) => tileHtml(t, "s")).join("")}</div>`;
  const canDiscard = !!pendingHuman?.some((a) => a.type === "discard");
  $("myhand").innerHTML =
    me.hand.map((t) => tileHtml(t, canDiscard ? "big click" : "big", canDiscard ? `window.__discard(${t})` : "")).join("") +
    (me.drawn !== null ? `<span class="drawnsep"></span>` + tileHtml(me.drawn, canDiscard ? "big click drawn" : "big drawn", canDiscard ? `window.__discard(${me.drawn})` : "") : "");
  // action bar
  let bar = "";
  if (pendingHuman) {
    const btns: string[] = [];
    pendingHuman.forEach((a, i) => {
      if (a.type === "discard") return;
      if (a.type === "declareWin") btns.push(`<button class="win" onclick="window.__act(${i})">WIN 食糊</button>`);
      else if (a.type === "pass") btns.push(`<button onclick="window.__act(${i})">pass</button>`);
      else if (a.type === "concealedKong") btns.push(`<button onclick="window.__act(${i})">concealed kong 暗槓 ${label(a.tile)}</button>`);
      else if (a.type === "addedKong") btns.push(`<button onclick="window.__act(${i})">added kong 加槓 ${label(a.tile)}</button>`);
      else if (a.type === "claim") {
        const o = a.option;
        if (o.kind === "win") btns.push(`<button class="win" onclick="window.__act(${i})">WIN 食糊</button>`);
        else btns.push(`<button onclick="window.__act(${i})">${o.kind === "pung" ? "pung 碰" : o.kind === "kong" ? "kong 槓" : `chow 上 (${(o.with ?? []).map(label).join("+")})`}</button>`);
      }
    });
    bar = btns.length ? btns.join(" ") : (canDiscard ? `<span class="mut">your turn — click a tile to discard</span>` : "");
    if (btns.length && canDiscard) bar += ` <span class="mut">· or click a tile to discard</span>`;
  } else if (!overlayHtml && state.phase !== "matchEnd") bar = `<span class="mut">bots thinking…</span>`;
  $("actions").innerHTML = bar;
  $("odds").innerHTML = oddsHtml || `<div class="oname">Win odds</div><span class="mut" style="font-size:11.5px">appears on your turn</span>`;
  $("coach").innerHTML = coach.length
    ? coach.map((c) => `<div class="centry ${c.cls}">${c.html}</div>`).join("")
    : `<span class="mut" style="font-size:11.5px">your discards get graded here — against what the champion would cut in your exact seat</span>`;
  $("feed").innerHTML = feed.slice(-48).map((l) =>
    l.startsWith("§") ? `<div class="think">${l.slice(1)}</div>` : `<div>${l}</div>`).join("");
  $("feed").scrollTop = $("feed").scrollHeight;
  const ov = $("overlay");
  if (overlayHtml) { ov.style.display = "flex"; ov.querySelector(".card")!.innerHTML = overlayHtml; }
  else ov.style.display = "none";
}

newMatch();

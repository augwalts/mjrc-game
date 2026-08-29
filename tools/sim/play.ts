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
import { decideAction, DEFAULT_PROFILE, type BotConfig, type BotProfile } from "../../engine/src/bots.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import { prng } from "../../engine/src/wall.js";
import { TILE_NAMES } from "../../engine/src/tiles.js";
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
  if (feed.length > 60) feed.splice(0, feed.length - 60);
}

/* ── game loop ───────────────────────────────────────────────────────── */
let pendingHuman: Action[] | null = null;

function advance(): void {
  render();
  if (overlayHtml) return;                       // waiting on the overlay button
  if (state.phase === "matchEnd") return;
  if (state.phase === "handEnd") return;         // overlay button drives startNextHand
  const mine = legalActions(state, HUMAN);
  if (mine.length > 0) { pendingHuman = mine; render(); return; }
  for (const seat of [1, 2, 3] as SeatIndex[]) {
    const options = legalActions(state, seat);
    if (options.length === 0) continue;
    const act = (): void => {
      const v = viewFor(state, seat);
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
  const r = applyAction(state, a);
  state = r.state; consume(r.events);
  advance();
}

(window as never as Record<string, unknown>).__next = (): void => {
  overlayHtml = null;
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
  if (a) humanAct(a);
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
  $("feed").innerHTML = feed.slice(-24).map((l) => `<div>${l}</div>`).join("");
  $("feed").scrollTop = $("feed").scrollHeight;
  const ov = $("overlay");
  if (overlayHtml) { ov.style.display = "flex"; ov.querySelector(".card")!.innerHTML = overlayHtml; }
  else ov.style.display = "none";
}

newMatch();

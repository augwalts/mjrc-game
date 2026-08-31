/**
 * MJRC — the basic game. One human, three bots, HK Old Style, over the real
 * engine (same reducer, legality and payments as every simulation).
 *
 * Doctrine (DESIGN.md §5): the client is disposable, the engine holds the
 * logic. Nothing here decides a rule — it renders `MatchState` and posts
 * `Action`s back. Opponents are the frozen ladder from the training programme
 * (window.BOTS), so difficulty is a measured quantity, not a guess.
 *
 * Build: esbuild client/game/game.ts --bundle --platform=browser --format=iife
 *        --outfile=client/game/game.js
 */
import { startMatch, startNextHand, applyAction, legalActions } from "../../engine/src/reducer.js";
import type { MatchState } from "../../engine/src/reducer.js";
import { decideAction, DEFAULT_PROFILE, assessRoutes, shapeOf, rankDiscards, scoreAdjust,
  type BotConfig, type BotProfile, type RouteAssessment } from "../../engine/src/bots.js";
import { tableThreat } from "../../engine/src/threat.js";
import { MJRC_STANDARD, ruleset as rulesetById } from "../../rulesets/src/presets.js";
import type { Ruleset } from "../../engine/src/types.js";
import { prng } from "../../engine/src/wall.js";
import { TILE_NAMES } from "../../engine/src/tiles.js";
import type { Action, SeatIndex, TileId } from "../../engine/src/types.js";
import { viewFor } from "../../tools/sim/driver.js";

declare global {
  interface Window { BOTS?: Record<string, Partial<BotProfile>>; }
}

/* ── tiles: the site's own SVG art (public/tiles/tile-engine.js) ────────
 * The engine draws a 100x140 face from real pip geometry — the same art the
 * scoring pages use. Flowers/seasons are keyed BY CHARACTER because the
 * engine's array order (梅蘭竹菊) differs from the tile ids (梅蘭菊竹).      */
declare const tileWan: (n: number) => string;
declare const tileTong: (n: number) => string;
declare const tileSuo: (n: number) => string;
declare const tileWind: (ch: string) => string;
declare const tileDragon: (kind: string) => string;
declare const FLOWER_TILES: [string, () => string][];
declare const SEASON_TILES: [string, () => string][];
declare const recenterGlyphs: (root: Element | Document) => void;

const faceCache = new Map<number, string>();
function face(t: TileId): string {
  const hit = faceCache.get(t);
  if (hit !== undefined) return hit;
  let svg: string;
  if (t < 9) svg = tileWan(t + 1);
  else if (t < 18) svg = tileSuo(t - 8);
  else if (t < 27) svg = tileTong(t - 17);
  else if (t < 31) svg = tileWind(["東", "南", "西", "北"][t - 27]!);
  else if (t < 34) svg = tileDragon(["red", "green", "white"][t - 31]!);
  else {
    const ch = TILE_NAMES[t]!;
    const all = [...FLOWER_TILES, ...SEASON_TILES];
    const hitF = all.find(([label]) => label.includes(ch));
    svg = hitF ? hitF[1]() : "";
  }
  faceCache.set(t, svg);
  return svg;
}
const name = (t: TileId): string => TILE_NAMES[t] ?? "?";
const tileHtml = (t: TileId, cls = "", attrs = ""): string =>
  `<span class="tile ${cls}" ${attrs}><svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet">${face(t)}</svg></span>`;

const WIND_CH = ["東", "南", "西", "北"];
const AWARDS: Record<string, string> = {
  selfDraw: "自摸 Self-Draw", allChows: "平糊 All Chows", allPungs: "對對糊 All Pungs",
  halfFlush: "混一色 Half Flush", fullFlush: "清一色 Full Flush", dragonPung: "三元牌 Dragon Pung",
  seatWind: "門風 Seat Wind", roundWind: "圈風 Round Wind", ownFlower: "正花 Own Flower",
  ownSeason: "正花 Own Season", noFlowers: "無花 No Flowers", concealedHand: "門前清 Concealed",
  winOnKongReplacement: "槓上開花 Kong Flower", winOnLastTile: "海底撈月 Last Tile",
  winOnLastDiscard: "河底撈魚 Last Discard", robbingKong: "搶槓 Robbing the Kong",
  smallThreeDragons: "小三元 Small 3 Dragons", bigThreeDragons: "大三元 Big 3 Dragons",
  allTerminals: "清么九 All Terminals", allHonours: "字一色 All Honours", mixedTerminals: "混么九 Mixed Terminals",
  fourConcealedPungs: "四暗刻 4 Concealed Pungs", nineGates: "九蓮寶燈 Nine Gates",
  thirteenOrphans: "十三么 13 Orphans", allKongs: "十八羅漢 All Kongs",
  bigFourWinds: "大四喜 Big 4 Winds", smallFourWinds: "小四喜 Small 4 Winds",
  allFlowers: "齊四花 All Flowers", allSeasons: "齊四季 All Seasons", winByDoubleKong: "槓上槓 Double Kong",
};

/* ── opponents: the frozen ladder, as difficulty ───────────────────────── */
interface Table { id: string; label: string; blurb: string; seats: string[]; }
const TABLES: Table[] = [
  { id: "friendly", label: "Friendly table", seats: ["v0", "v0", "v1"],
    blurb: "Two beginners who never defend, and one loose claimer. Good for learning the flow." },
  { id: "mixed", label: "Mixed table", seats: ["v1", "persona", "v2"],
    blurb: "A maniac, an action player and a disciplined bot. The liveliest game." },
  { id: "sharks", label: "Sharks", seats: ["v4", "v4", "v4"],
    blurb: "Three copies of the strongest bot the training programme produced. It defends hard." },
  { id: "boss", label: "The champion + friends", seats: ["v4", "persona", "v2"],
    blurb: "The champion, an action player and a disciplined bot — the most human-feeling table." },
];
const profileOf = (key: string): BotProfile => ({ ...DEFAULT_PROFILE, ...(window.BOTS?.[key] ?? {}) });
const BOT_NAMES: Record<string, string> = {
  v0: "Bo", v1: "Kwan", v2: "Ling", v3: "Fai", v4: "Sifu", persona: "Ming",
};

/* ── state ─────────────────────────────────────────────────────────────── */
const HUMAN: SeatIndex = 0;
const $ = (id: string): HTMLElement => document.getElementById(id)!;
let state: MatchState;
let cfgs: BotConfig[];
let table: Table = TABLES[1]!;
let seed = 0;
let pending: Action[] | null = null;
let busy = false;
const feed: string[] = [];
let pileTiles: { tile: TileId; seat: number }[] = [];
const rec = JSON.parse(localStorage.getItem("mjrc.record") ?? '{"played":0,"won":0,"chips":0}');
interface Settings { rulesetId: string; tileScale: number; botMs: number; dev: boolean; }
const SETTINGS: Settings = {
  rulesetId: "mjrc-standard", tileScale: 1, botMs: 420, dev: false,
  ...JSON.parse(localStorage.getItem("mjrc.settings") ?? "{}"),
};
const saveSettings = (): void => {
  localStorage.setItem("mjrc.settings", JSON.stringify(SETTINGS));
  document.documentElement.style.setProperty("--tscale", String(SETTINGS.tileScale));
  document.body.classList.toggle("devmode", SETTINGS.dev);
};
const rules = (): Ruleset => rulesetById(SETTINGS.rulesetId) ?? MJRC_STANDARD;
const RULE_CHOICES = [
  ["mjrc-standard", "MJRC standard", "3–10 faan · the house ruleset · flowers"],
  ["hkos-standard", "HK Old Style (published)", "3–13 faan · the full limit ladder"],
  ["tvb-2026", "TVB Championship 2026", "1 faan minimum · linear payments · no flowers"],
];

/* ── flow ──────────────────────────────────────────────────────────────── */
function startScreen(): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = `
    <h1>香港麻雀 · MJRC</h1>
    <p>Hong Kong Old Style · 3 faan minimum · one wind round.
    Your opponents are bots from the training programme — each one measurably stronger than the last.</p>
    <div class="choices">${TABLES.map((t) => `
      <div class="choice ${t.id === table.id ? "sel" : ""}" data-t="${t.id}">
        <b>${t.label}</b><span>${t.blurb}</span>
        <span style="margin-top:5px;color:var(--gold)">${t.seats.map((s) => BOT_NAMES[s] ?? s).join(" · ")}</span>
      </div>`).join("")}</div>
    ${rec.played ? `<p>Your record: <b>${rec.won}</b> wins in <b>${rec.played}</b> matches ·
      lifetime <b>${rec.chips > 0 ? "+" : ""}${rec.chips}</b> chips</p>` : ""}
    <button id="btnStart">sit down ▸</button>`;
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".choice"))) {
    el.onclick = () => { table = TABLES.find((t) => t.id === el.dataset.t)!; startScreen(); };
  }
  ($("btnStart") as HTMLButtonElement).onclick = () => newMatch();
}

function newMatch(): void {
  seed = Math.floor(Math.random() * 2 ** 31);
  const R = rules();
  const r = startMatch({ seed, ruleset: R, matchLength: "oneWindRound" } as never);
  state = r.state;
  cfgs = [0, 1, 2, 3].map((i) => ({
    ruleset: R,
    profile: i === HUMAN ? DEFAULT_PROFILE : profileOf(table.seats[i - 1]!),
    rnd: prng((seed ^ ((i + 1) * 0x9e3779b1)) >>> 0),
  }));
  feed.length = 0; pileTiles = []; devBotLines = [];
  $("veil").style.display = "none";
  $("hudTable").textContent = table.label + " — " + table.seats.map((s) => BOT_NAMES[s] ?? s).join(", ");
  consume(r.events);
  advance();
}

/* ── events ────────────────────────────────────────────────────────────── */
let overlay: string | null = null;
function consume(events: readonly unknown[]): void {
  for (const e of events as { type: string; payload: Record<string, unknown> }[]) {
    const p = e.payload ?? {};
    const who = (s: unknown): string =>
      s === HUMAN ? "You" : (BOT_NAMES[table.seats[(s as number) - 1]!] ?? "Bot");
    switch (e.type) {
      case "discard":
        pileTiles.push({ tile: p.tile as TileId, seat: p.seat as number });
        feed.push(`${who(p.seat)} discards ${name(p.tile as TileId)}`);
        break;
      case "claimed": {
        pileTiles.pop();
        const verb = p.kind === "chow" ? "chows 上" : p.kind === "pung" ? "pungs 碰" : "kongs 槓";
        feed.push(`${who(p.seat)} ${verb} ${name(p.tile as TileId)}`);
        break;
      }
      case "concealedKong": feed.push(`${who(p.seat)} declares a concealed kong 暗槓`); break;
      case "addedKong": feed.push(`${who(p.seat)} adds a kong 加槓`); break;
      case "flowerReplacement": feed.push(`${who(p.seat)} reveals ${name(p.flower as TileId)} 花`); break;
      case "refusedWin":
        if ((p.context as { seat: number }).seat === HUMAN)
          feed.push(`Your hand completes but holds only ${(p.score as { faan: number }).faan} faan — under the 3-faan floor`);
        break;
      case "winOnDiscard": case "selfDraw": {
        const ctx = p.context as { seat: SeatIndex; selfDraw: boolean; from: SeatIndex | null };
        const sc = p.score as { faan: number; awards: { id: string; faan: number }[] };
        const mine = ctx.seat === HUMAN;
        const tiles = [...((p.concealed as TileId[]) ?? [])].sort((a, b) => a - b);
        const melds = (p.melds as { tiles: TileId[] }[] ?? []);
        overlay = `<h1>${mine ? "You win! 食糊" : who(ctx.seat) + " wins"}</h1>
          <h2>${sc.faan} faan · ${ctx.selfDraw ? "自摸 self-draw" : ctx.from === HUMAN ? "off YOUR discard" : "食糊 on a discard"}</h2>
          <div class="tiles">${tiles.map((t) => tileHtml(t, "sm")).join("")}
            ${melds.map((m) => `<span style="width:8px"></span>` + m.tiles.map((t) => tileHtml(t, "sm")).join("")).join("")}</div>
          <div class="awards">${sc.awards.map((a) => `${AWARDS[a.id] ?? a.id} <b>${a.faan}</b>`).join(" &nbsp;·&nbsp; ")}</div>`;
        break;
      }
      case "exhaustiveDraw":
        overlay = `<h1>流局</h1><h2>The wall ran out — nobody wins</h2>`;
        break;
      case "handEnd": {
        const st = p.standings as number[];
        const d = p.chipDeltas as number[] | undefined;
        overlay = (overlay ?? "") + `<div class="pay">${[0, 1, 2, 3].map((i) => `
          <div>${i === HUMAN ? "You" : who(i)}<br>
            <span class="d ${d && d[i]! > 0 ? "up" : d && d[i]! < 0 ? "down" : ""}">${d ? (d[i]! > 0 ? "+" : "") + d[i] : ""}</span>
            <span style="opacity:.6"> → ${st[i]}</span></div>`).join("")}</div>
          <button id="btnNext">next hand ▸</button>`;
        break;
      }
      case "matchEnd": {
        const st = p.standings as number[];
        const order = [0, 1, 2, 3].sort((a, b) => st[b]! - st[a]!);
        const place = order.indexOf(HUMAN) + 1;
        rec.played++; if (place === 1) rec.won++; rec.chips += st[HUMAN]!;
        localStorage.setItem("mjrc.record", JSON.stringify(rec));
        overlay = `<h1>${place === 1 ? "🏆 You win the round" : `You finish ${place}${["st","nd","rd","th"][place - 1]}`}</h1>
          <div class="pay">${order.map((i, r) => `<div>${r + 1}. ${i === HUMAN ? "You" : who(i)}<br>
            <span class="d ${st[i]! > 0 ? "up" : st[i]! < 0 ? "down" : ""}">${st[i]! > 0 ? "+" : ""}${st[i]}</span></div>`).join("")}</div>
          <p>Record: ${rec.won} wins in ${rec.played} · lifetime ${rec.chips > 0 ? "+" : ""}${rec.chips} chips</p>
          <button id="btnAgain">play again ▸</button>`;
        break;
      }
    }
  }
  if (feed.length > 8) feed.splice(0, feed.length - 8);
}

/* ── dev analysis (settings ▸ dev mode) ────────────────────────────────── */
const SUITG = ["萬", "索", "筒"];
function routeName(r: RouteAssessment["route"]): string {
  if (r.orphans) return "13 orphans";
  if (r.honoursOnly) return "all honours";
  if (r.suit !== null) return (r.pungs ? "pung-flush " : "flush ") + (r.suit === "chars" ? "萬" : r.suit === "bamboo" ? "索" : "筒");
  return r.pungs ? "all pungs" : "balanced";
}
let devBotLines: string[] = [];
function noteBotThinking(seat: SeatIndex): void {
  if (!SETTINGS.dev) return;
  const v = viewFor(state, seat);
  const R = rules();
  const threats = tableThreat(v, R);
  const routes = assessRoutes(shapeOf(v), R, cfgs[seat]!.profile!, threats)
    .filter((r) => r.feasible && Number.isFinite(r.score)).sort((a, b) => b.score - a.score).slice(0, 2);
  const who = BOT_NAMES[table.seats[seat - 1]!] ?? "Bot";
  const reads = threats.seats.filter((t) => t.threat > 0.25)
    .sort((a, b) => b.threat - a.threat).slice(0, 2)
    .map((t) => `${t.seat === HUMAN ? "YOU" : (BOT_NAMES[table.seats[t.seat - 1]!] ?? "?")} ${t.threat.toFixed(2)}` +
      (t.intentSuit !== null ? `/${SUITG[t.intentSuit]}` : ""));
  devBotLines.unshift(`<b>${who}</b> ${routes.map((r, i) =>
    `${i === 0 ? "▸" : ""}${routeName(r.route)} <span class="mut">${Math.min(r.faan, 13)}f · ${Math.max(0, r.distance)} away</span>`).join(" · ")}` +
    (reads.length ? `<div class="mut">fears ${reads.join(" · ")}</div>` : ""));
  if (devBotLines.length > 5) devBotLines.length = 5;
}
function devPanel(): string {
  if (!SETTINGS.dev) return "";
  let mine = "";
  if (pending?.some((a) => a.type === "discard")) {
    const v = viewFor(state, HUMAN);
    const R = rules();
    const cfg: BotConfig = { ruleset: R, profile: scoreAdjust(profileOf("v4"), v), rnd: prng(7) };
    const ranked = [...rankDiscards(v, cfg)].sort((a, b) => b.score - a.score).slice(0, 5);
    mine = `<div class="devsec"><b>champion would discard</b>${ranked.map((d, i) =>
      `<div class="${i === 0 ? "best" : ""}">${i + 1}. ${name(d.tile)} <span class="mut">${d.distance} away · danger ${d.danger.toFixed(1)}${d.outs >= 0 ? ` · ${d.outs} outs` : ""}</span></div>`).join("")}</div>`;
  }
  return `<div id="dev"><div class="devsec"><b>what the bots are thinking</b>
    ${devBotLines.join("") || '<div class="mut">…</div>'}</div>${mine}</div>`;
}

/* ── turn loop ─────────────────────────────────────────────────────────── */
function advance(): void {
  render();
  if (overlay) { showOverlay(); return; }
  if (state.phase === "matchEnd" || state.phase === "handEnd") return;
  const mine = legalActions(state, HUMAN);
  if (mine.length > 0) { pending = mine; render(); return; }
  for (const seat of [1, 2, 3] as SeatIndex[]) {
    const options = legalActions(state, seat);
    if (options.length === 0) continue;
    busy = true;
    if (options.some((o) => o.type === "discard")) noteBotThinking(seat);
    setTimeout(() => {
      const a = decideAction(viewFor(state, seat), options, cfgs[seat]!);
      const r = applyAction(state, a);
      state = r.state; consume(r.events); busy = false; advance();
    }, SETTINGS.botMs);
    return;
  }
}
function act(a: Action): void {
  pending = null;
  const r = applyAction(state, a);
  state = r.state; consume(r.events); advance();
}
function showOverlay(): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = overlay!;
  const next = document.getElementById("btnNext");
  if (next) next.onclick = () => {
    overlay = null; $("veil").style.display = "none";
    const r = startNextHand(state); state = r.state; pileTiles = []; consume(r.events); advance();
  };
  const again = document.getElementById("btnAgain");
  if (again) again.onclick = () => { overlay = null; startScreen(); };
}

/* ── render ────────────────────────────────────────────────────────────── */
function seatBox(seat: SeatIndex): string {
  const s = state.seats[seat]!;
  const nm = BOT_NAMES[table.seats[seat - 1]!] ?? "Bot";
  const hidden = s.hand.length + (s.drawn !== null ? 1 : 0);
  return `<div class="nameplate ${state.turn === seat && !overlay ? "turn" : ""}">
      <span class="avatar">${nm[0]}</span><span>${nm}</span>
      <span class="wind">${WIND_CH[s.wind]}</span>
      ${state.dealer === seat ? '<span class="dealer">莊</span>' : ""}
      <span class="chips">${s.chips > 0 ? "+" : ""}${s.chips}</span></div>
    <div class="backrow">${'<span class="back"></span>'.repeat(Math.min(hidden, 13))}</div>
    <div class="meldrow">${s.melds.map((m) => m.tiles.map((t) => tileHtml(t, "sm")).join("")).join('<span style="width:6px"></span>')}
      ${s.flowers.map((t) => tileHtml(t, "sm")).join("")}</div>`;
}

function render(): void {
  const me = state.seats[HUMAN]!;
  $("hudRound").textContent = WIND_CH[state.roundWind]!;
  $("hudHand").textContent = String(state.handIndex + 1);
  $("hudWall").textContent = String(Math.max(0, state.wallEnd - state.wallIndex));
  $("seatE").innerHTML = seatBox(1);
  $("seatN").innerHTML = seatBox(2);
  $("seatW").innerHTML = seatBox(3);
  $("wallinfo").innerHTML = `wall <b>${Math.max(0, state.wallEnd - state.wallIndex)}</b> tiles left`;

  // THE PILE. Messy but never overlapping — the guarantee is geometric, from
  // sketches/RENDERING.md: lay centres on a staggered grid whose cell is the
  // tile's DIAGONAL, because a rectangle rotated by any angle fits inside a
  // square of its own diagonal. Alternate rows offset by half a cell to break
  // the grid read; nearest-centre distance across the stagger is 1.047 x cell,
  // so the guarantee survives. Jitter stays inside the slack.
  const pileEl = $("pile");
  const boxW = pileEl.clientWidth || 420, boxH = pileEl.clientHeight || 240;
  const th = 30 * SETTINGS.tileScale, tw = th * (100 / 140);
  const cell = Math.sqrt(th * th + tw * tw) * 1.02;      // diagonal + 2% slack
  const perRow = Math.max(4, Math.floor(boxW / cell));
  const jrnd = prng((seed ^ 0x51ed) >>> 0);
  pileEl.innerHTML = pileTiles.map((d, i) => {
    const row = Math.floor(i / perRow), col = i % perRow;
    const stagger = (row % 2) * 0.5;
    // centre each row on the tiles it actually holds, so a partial last row
    // sits under the middle of the table rather than hugging the left edge
    const inRow = Math.min(perRow, pileTiles.length - row * perRow);
    const cx = (col + stagger + 0.5) * cell - (inRow * cell) / 2 + boxW / 2;
    const cy = (row + 0.5) * cell - (Math.ceil(pileTiles.length / perRow) * cell) / 2 + boxH / 2;
    const jx = (jrnd() - 0.5) * cell * 0.06, jy = (jrnd() - 0.5) * cell * 0.06;
    const rot = (jrnd() * 24 - 12).toFixed(1);
    const hot = i === pileTiles.length - 1 ? "hot fresh" : "";
    return tileHtml(d.tile, `sm ${hot}`,
      `style="left:${(cx + jx).toFixed(1)}px;top:${(cy + jy).toFixed(1)}px;transform:translate(-50%,-50%) rotate(${rot}deg)"`);
  }).join("");

  $("mymelds").innerHTML = me.melds.map((m) => m.tiles.map((t) => tileHtml(t)).join("")).join('<span style="width:10px"></span>')
    + me.flowers.map((t) => tileHtml(t, "sm")).join("");

  const canDiscard = !!pending?.some((a) => a.type === "discard");
  const hand = [...me.hand].sort((a, b) => a - b);
  $("myhand").className = canDiscard ? "" : "locked";
  $("myhand").innerHTML = hand.map((t) => tileHtml(t, "", `data-t="${t}"`)).join("")
    + (me.drawn !== null ? tileHtml(me.drawn, "drawn", `data-t="${me.drawn}"`) : "");
  if (canDiscard) {
    for (const el of Array.from($("myhand").querySelectorAll<HTMLElement>(".tile"))) {
      el.onclick = () => {
        const t = Number(el.dataset.t) as TileId;
        const a = pending?.find((x) => x.type === "discard" && x.tile === t);
        if (a) act(a);
      };
    }
  }

  // action bar
  let bar = "";
  if (pending) {
    const btns: string[] = [];
    pending.forEach((a, i) => {
      if (a.type === "discard") return;
      const mk = (label: string, cls = "") => btns.push(`<button class="${cls}" data-i="${i}">${label}</button>`);
      if (a.type === "declareWin") mk("WIN 食糊", "win");
      else if (a.type === "pass") mk("pass", "pass");
      else if (a.type === "concealedKong") mk(`kong 暗槓 ${name(a.tile)}`);
      else if (a.type === "addedKong") mk(`kong 加槓 ${name(a.tile)}`);
      else if (a.type === "claim") {
        const o = a.option;
        if (o.kind === "win") mk("WIN 食糊", "win");
        else mk(o.kind === "pung" ? "pung 碰" : o.kind === "kong" ? "kong 槓"
          : `chow 上 ${(o.with ?? []).map(name).join("+")}`);
      }
    });
    bar = btns.join("") || (canDiscard ? `<span class="hint">your turn — tap a tile to discard</span>` : "");
    if (btns.length && canDiscard) bar += `<span class="hint">or tap a tile to discard</span>`;
  } else if (!overlay && busy) bar = `<span class="hint">…</span>`;
  $("actions").innerHTML = bar;
  for (const el of Array.from($("actions").querySelectorAll<HTMLElement>("button"))) {
    el.onclick = () => { const a = pending?.[Number(el.dataset.i)]; if (a) act(a); };
  }
  $("log").innerHTML = feed.map((l) => `<div>${l}</div>`).join("");
  $("devwrap").innerHTML = devPanel();
  recenterGlyphs(document);
}

function settingsScreen(back: () => void): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = `
    <h1>Settings</h1>
    <h2 style="margin-top:12px">Rules</h2>
    <div class="choices">${RULE_CHOICES.map(([id, label, blurb]) => `
      <div class="choice ${SETTINGS.rulesetId === id ? "sel" : ""}" data-r="${id}"><b>${label}</b><span>${blurb}</span></div>`).join("")}</div>
    <p class="mut">Changing the ruleset applies to the next match.</p>
    <h2 style="margin-top:14px">Table</h2>
    <div class="setrow"><label>Tile size</label>
      <input type="range" id="setScale" min="0.8" max="2" step="0.05" value="${SETTINGS.tileScale}">
      <span id="setScaleV">${Math.round(SETTINGS.tileScale * 100)}%</span></div>
    <div class="setrow"><label>Bot speed</label>
      <input type="range" id="setSpeed" min="0" max="1200" step="60" value="${SETTINGS.botMs}">
      <span id="setSpeedV">${SETTINGS.botMs === 0 ? "instant" : SETTINGS.botMs + "ms"}</span></div>
    <div class="setrow"><label>Dev mode</label>
      <input type="checkbox" id="setDev" ${SETTINGS.dev ? "checked" : ""}>
      <span class="mut">show what each bot is planning, and how the champion would rank your discards</span></div>
    <button id="btnBack">done ▸</button>`;
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".choice"))) {
    el.onclick = () => { SETTINGS.rulesetId = el.dataset.r!; saveSettings(); settingsScreen(back); };
  }
  const sc = document.getElementById("setScale") as HTMLInputElement;
  sc.oninput = () => { SETTINGS.tileScale = Number(sc.value); $("setScaleV").textContent = Math.round(SETTINGS.tileScale * 100) + "%"; saveSettings(); render(); };
  const sp = document.getElementById("setSpeed") as HTMLInputElement;
  sp.oninput = () => { SETTINGS.botMs = Number(sp.value); $("setSpeedV").textContent = SETTINGS.botMs === 0 ? "instant" : SETTINGS.botMs + "ms"; saveSettings(); };
  const dv = document.getElementById("setDev") as HTMLInputElement;
  dv.onchange = () => { SETTINGS.dev = dv.checked; saveSettings(); render(); };
  ($("btnBack") as HTMLButtonElement).onclick = () => { $("veil").style.display = "none"; back(); };
}
($("btnSettings") as HTMLButtonElement).onclick = () => settingsScreen(() => { if (!state) startScreen(); else render(); });
($("btnQuit") as HTMLButtonElement).onclick = () => { overlay = null; startScreen(); };
saveSettings();
startScreen();

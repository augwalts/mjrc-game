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
declare let SHOW_MEASURE: boolean;
SHOW_MEASURE = false;   // the lab's dimension annotations are not game art

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
const TOSS_MS = 1000;   // owner: ~1s to simulate the throw
const DRAW_MS = 700;    // owner: ~0.7s to draw off the wall
const $ = (id: string): HTMLElement => document.getElementById(id)!;
let state: MatchState;
let cfgs: BotConfig[];
let table: Table = TABLES[1]!;
let seed = 0;
let pending: Action[] | null = null;
let busy = false;
const feed: string[] = [];
interface Placed { x: number; y: number; rot: number; spin: number; }
let pileTiles: { tile: TileId; seat: number; pos?: Placed }[] = [];
/**
 * ORGANIC HEAP (owner photo, 2026-08-29). Tiles land where they land: many
 * orientations, irregular gaps, a roughly circular pile that grows outward —
 * and never an overlap, because a real tile cannot lie on top of another.
 *
 * Placement is rejection sampling with an exact separating-axis test, not a
 * grid: sample a point at a radius that grows with the pile, give it a random
 * angle, keep it if it touches nothing. That is what produces the photo's
 * texture — tiles nestle close where their angles happen to agree and leave
 * gaps where they do not.
 */
function rectCorners(p: { x: number; y: number; rot: number }, w: number, h: number): { x: number; y: number }[] {
  const c = Math.cos(p.rot * Math.PI / 180), s2 = Math.sin(p.rot * Math.PI / 180);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => ({ x: p.x + x * c - y * s2, y: p.y + x * s2 + y * c }));
}
function hits(a: { x: number; y: number; rot: number }, b: { x: number; y: number; rot: number },
              w: number, h: number): boolean {
  const A = rectCorners(a, w, h), B = rectCorners(b, w, h);
  for (const poly of [A, B]) {
    for (let i = 0; i < 4; i++) {
      const p1 = poly[i]!, p2 = poly[(i + 1) % 4]!;
      const ax = -(p2.y - p1.y), ay = p2.x - p1.x;
      const pa = A.map((p) => p.x * ax + p.y * ay), pb = B.map((p) => p.x * ax + p.y * ay);
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
  }
  return true;
}
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
  feed.length = 0; pileTiles = []; devBotLines = []; coachLog.length = 0;
  $("veil").style.display = "none";
  $("hudTable").textContent = table.label + " — " + table.seats.map((s) => BOT_NAMES[s] ?? s).join(", ");
  consume(r.events);
  advance();
  buildWall();
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
        announce(p.kind as string, who(p.seat), name(p.tile as TileId), p.seat as SeatIndex);
        break;
      }
      case "concealedKong": feed.push(`${who(p.seat)} declares a concealed kong 暗槓`); announce("concealedKong", who(p.seat), "", p.seat as SeatIndex); break;
      case "addedKong": feed.push(`${who(p.seat)} adds a kong 加槓`); announce("addedKong", who(p.seat), "", p.seat as SeatIndex); break;
      case "flowerReplacement": feed.push(`${who(p.seat)} reveals ${name(p.flower as TileId)} 花`);
        if (state.handsPlayed !== undefined && pileTiles.length > 0) announce("flower", who(p.seat), name(p.flower as TileId), p.seat as SeatIndex);
        break;
      case "refusedWin":
        if ((p.context as { seat: number }).seat === HUMAN)
          feed.push(`Your hand completes but holds only ${(p.score as { faan: number }).faan} faan — under the 3-faan floor`);
        break;
      case "winOnDiscard": case "selfDraw": {
        const ctx = p.context as { seat: SeatIndex; selfDraw: boolean; from: SeatIndex | null };
        const sc = p.score as { faan: number; awards: { id: string; faan: number }[] };
        const mine = ctx.seat === HUMAN;
        announce(ctx.selfDraw ? "selfDraw" : "win", mine ? "You" : who(ctx.seat), `${sc.faan} faan`, ctx.seat);
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
/** Graded verdicts on YOUR discards. Kept as a scrollable history so a call
 *  does not vanish the instant you make it (owner note 2026-08-29). */
const coachLog: string[] = [];
function gradeMyDiscard(tile: TileId): void {
  if (!SETTINGS.dev) return;
  const v = viewFor(state, HUMAN);
  const R = rules();
  const cfg: BotConfig = { ruleset: R, profile: scoreAdjust(profileOf("v4"), v), rnd: prng(7) };
  const ranked = [...rankDiscards(v, cfg)].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const mine = ranked.find((d) => d.tile === tile);
  if (!best || !mine) return;
  const gap = best.score - mine.score;
  const rank = ranked.indexOf(mine) + 1;
  const cls = tile === best.tile || gap < 0.6 ? "good" : gap < 2.2 ? "ok" : "bad";
  const verdict = tile === best.tile ? "best discard"
    : gap < 0.6 ? "fine — within a hair of the best"
    : gap < 2.2 ? `#${rank} of ${ranked.length} — champion cuts ${name(best.tile)}`
    : `costly — champion cuts ${name(best.tile)}`;
  const why = mine.distance > best.distance ? `slower: ${mine.distance} away vs ${best.distance}`
    : mine.danger - best.danger > 0.8 ? `riskier: danger ${mine.danger.toFixed(1)} vs ${best.danger.toFixed(1)}`
    : !mine.onRoute && best.onRoute ? "off your best route"
    : "";
  coachLog.unshift(`<div class="ce ${cls}"><b>${name(tile)}</b> — ${verdict}
    ${why ? `<div class="mut">${why}</div>` : ""}</div>`);
  if (coachLog.length > 24) coachLog.length = 24;
}
function devPanel(): string {
  if (!SETTINGS.dev) return "";
  let upcoming = "";
  if (pending?.some((a) => a.type === "discard")) {
    const v = viewFor(state, HUMAN);
    const cfg: BotConfig = { ruleset: rules(), profile: scoreAdjust(profileOf("v4"), v), rnd: prng(7) };
    const ranked = [...rankDiscards(v, cfg)].sort((a, b) => b.score - a.score).slice(0, 4);
    upcoming = `<div class="sug">champion would cut ${ranked.map((d, i) =>
      `<span class="${i === 0 ? "best" : ""}">${name(d.tile)}</span>`).join(" › ")}</div>`;
  }
  return `<div id="dev">
    <div class="devbox"><b>what the bots are thinking</b>
      <div class="scroll">${devBotLines.join("") || '<div class="mut">…</div>'}</div></div>
    <div class="devbox"><b>discard helper</b>${upcoming}
      <div class="scroll">${coachLog.join("") || '<div class="mut">your discards get graded here, and the grades stay</div>'}</div></div>
  </div>`;
}

/* ── announcements ─────────────────────────────────────────────────────
 * A claim used to happen in silence — tiles simply appeared in someone's meld.
 * At a real table the call IS the event: you hear 碰 before you see anything.
 * Phrasing follows EXPRESSIONS.md — Cantonese leads, English supports, and it
 * is a CANNED call, never free text.                                        */
const CALLS: Record<string, [string, string]> = {
  pung: ["碰", "pung"], chow: ["上", "chow"], kong: ["槓", "kong"],
  concealedKong: ["暗槓", "concealed kong"], addedKong: ["加槓", "added kong"],
  win: ["食糊", "win"], selfDraw: ["自摸", "self-draw"],
  robbingKong: ["搶槓", "robbed the kong"], flower: ["花", "flower"],
};
let callTimer = 0;
function announce(kind: string, who: string, extra = "", seat: SeatIndex = HUMAN): void {
  const [ch, en] = CALLS[kind] ?? [kind, ""];
  const el = $("call");
  el.innerHTML = `<div class="inner"><div class="cw">${who}</div><div class="cc">${ch}</div>
    <div class="ce">${en}${extra ? ` · ${extra}` : ""}</div></div>`;
  el.className = `show s${seat} ` + (kind === "win" || kind === "selfDraw" ? "big" : "");
  clearTimeout(callTimer);
  callTimer = window.setTimeout(() => { el.className = ""; }, kind === "win" || kind === "selfDraw" ? 1800 : 1150);
}

/* ── your clock ────────────────────────────────────────────────────────
 * A visible, generous timer so a turn feels paced. It is a NUDGE: nothing
 * expires and no action is taken for you — MatchScene.ts rule 1 says the
 * affordance must never be taken away by a clock the player cannot see.     */
const TURN_MS = 30_000;
let turnStart = 0, turnRaf = 0;
function startTurnClock(): void {
  turnStart = performance.now();
  cancelAnimationFrame(turnRaf);
  const tick = (): void => {
    if (!pending) { $("clock").style.width = "0%"; return; }
    const frac = Math.min(1, (performance.now() - turnStart) / TURN_MS);
    $("clock").style.width = `${(1 - frac) * 100}%`;
    $("clock").className = frac > 0.8 ? "low" : "";
    turnRaf = requestAnimationFrame(tick);
  };
  turnRaf = requestAnimationFrame(tick);
}

/* ── turn loop ─────────────────────────────────────────────────────────── */
function advance(): void {
  render();
  if (overlay) { showOverlay(); return; }
  if (state.phase === "matchEnd" || state.phase === "handEnd") return;
  const mine = legalActions(state, HUMAN);
  if (mine.length > 0) { pending = mine; startTurnClock(); render(); return; }
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
  cancelAnimationFrame(turnRaf);
  $("clock").style.width = "0%";
  const r = applyAction(state, a);
  state = r.state; consume(r.events); advance();
}
function showOverlay(): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = overlay!;
  const next = document.getElementById("btnNext");
  if (next) next.onclick = () => {
    overlay = null; $("veil").style.display = "none";
    const r = startNextHand(state); state = r.state; pileTiles = []; devBotLines = [];
    consume(r.events); advance(); buildWall();
  };
  const again = document.getElementById("btnAgain");
  if (again) again.onclick = () => { overlay = null; startScreen(); };
}

/* ── the wall ──────────────────────────────────────────────────────────
 * A ring of face-down tiles around the pile. It is decorative — the engine's
 * wall is a shuffled array — but it carries the two things a player reads off
 * a real wall: how much game is left, and where the live end is. Tiles are
 * removed from the live end as the count falls, so the wall visibly erodes.  */
let buildAnim = false;
let wallBuilt = 0;          // tiles the wall was built with, this hand
/**
 * The wall is BUILT ONCE and then only erodes. Consumed tiles are hidden in
 * place, never removed, so nothing reflows — the owner's note: "the wall should
 * not move and you simply subtract tiles from that wall". Live tiles are drawn
 * from the front of side 0 onward; the last 14 are the dead wall, where kong
 * replacements and flowers come from, and they are marked.
 */
function renderWall(): void {
  const left = Math.max(0, state.wallEnd - state.wallIndex);
  if (!wallBuilt) wallBuilt = 144;              // a real wall is built whole...
  const used = Math.max(0, wallBuilt - left);   // ...then eaten from the live end
  // Two tiles high, eighteen stacks a side — the real thing. One rendered
  // element IS a stack, so it vanishes only when both its tiles are gone.
  const STACKS = 18;
  const stacksUsed = Math.floor(used / 2);
  const jr = prng((seed ^ 0xbeef) >>> 0);
  $("wall").className = buildAnim ? "building" : "";
  $("wall").innerHTML = ["top", "right", "bottom", "left"].map((side, si) => {
    return `<div class="side ${side}">${Array.from({ length: STACKS }, (_, i) => {
      const idx = si * STACKS + i;
      const gone = idx < stacksUsed;
      const dead = idx >= STACKS * 4 - 7;       // the dead wall — kongs and flowers
      const d = buildAnim
        ? ` style="--ax:${(jr() * 150 - 75).toFixed(0)}px;--ay:${(jr() * -130 - 30).toFixed(0)}px;--ar:${(jr() * 70 - 35).toFixed(0)}deg;animation-delay:${(si * 70 + i * 12)}ms"`
        : "";
      return `<span class="wt${gone ? " gone" : ""}${dead ? " dead" : ""}"${d}></span>`;
    }).join("")}</div>`;
  }).join("");
}
/** Shuffle-and-build: run once when a hand starts. */
function buildWall(): void {
  wallBuilt = 0;
  buildAnim = true;
  renderWall();
  setTimeout(() => { buildAnim = false; renderWall(); }, 1100);
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
    <div class="backrow">${Array.from({ length: Math.min(hidden, 14) }, (_, i) =>
      `<span class="back ${i === hidden - 1 && s.drawn !== null ? "wtnew" : ""}"></span>`).join("")}</div>
    <div class="meldrow">${s.melds.map((m) => m.tiles.map((t) => tileHtml(t, "sm")).join("")).join('<span style="width:6px"></span>')}
      ${s.flowers.map((t) => tileHtml(t, "fl")).join("")}</div>`;
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
  renderWall();

  // THE PILE. A tile lands where it lands and NEVER moves again — the owner's
  // rule and the real table's: you throw into the middle and tiles accumulate
  // around what is already there. So slots come from a fixed centre-out square
  // spiral whose step is the tile's DIAGONAL (a rectangle at any rotation fits
  // inside a square of its own diagonal, so no two tiles can overlap), and each
  // discard is assigned its slot ONCE, at the moment it is thrown.
  const pileEl = $("pile");
  const boxW = pileEl.clientWidth || 420, boxH = pileEl.clientHeight || 240;
  const th = 30, tw = th * (100 / 140);
  // Compressed: rotation is kept small so centres can sit closer than the full
  // diagonal and still never touch (owner: "compress the middle pile more").
  const cell = Math.sqrt(th * th + tw * tw) * 0.80;
  const jr = prng((seed ^ 0x51ed) >>> 0);
  pileTiles.forEach((d, i) => {
    if (d.pos) return;                              // already placed — leave it
    const placed = pileTiles.filter((o) => o.pos).map((o) => o.pos!);
    let best: Placed | null = null;
    for (let tries = 0; tries < 260 && !best; tries++) {
      // radius grows with the pile; sqrt keeps the middle denser than the rim
      const grow = cell * (0.55 + Math.sqrt(i) * 0.62) * (1 + tries / 300);
      const a = jr() * Math.PI * 2, r = Math.sqrt(jr()) * grow;
      // orientation is genuinely varied — most tiles askew, some lying sideways
      const rot = jr() < 0.22 ? (jr() < 0.5 ? 90 : -90) + (jr() - 0.5) * 26 : (jr() - 0.5) * 78;
      const c: Placed = { x: boxW / 2 + Math.cos(a) * r * 1.28, y: boxH / 2 + Math.sin(a) * r * 0.82, rot, spin: 0 };
      if (!placed.some((o) => hits(c, o, tw, th))) best = c;
    }
    d.pos = best ?? { x: boxW / 2, y: boxH / 2, rot: 0, spin: 0 };
    d.pos.spin = jr() * 220 - 110;
  });
  pileEl.innerHTML = pileTiles.map((d, i) => {
    const fresh = i === pileTiles.length - 1;
    const from = [[0, 190], [230, 0], [0, -190], [-230, 0]][d.seat] ?? [0, 190];
    const fly = fresh
      ? `--fx:${from[0]}px;--fy:${from[1]}px;--fr:${d.pos!.spin.toFixed(0)}deg;--rot:${d.pos!.rot.toFixed(1)}deg;--tossms:${TOSS_MS}ms;`
      : "";
    return tileHtml(d.tile, `pt ${fresh ? "hot fresh" : ""}`,
      `style="left:${d.pos!.x.toFixed(1)}px;top:${d.pos!.y.toFixed(1)}px;${fly}transform:translate(-50%,-50%) rotate(${d.pos!.rot.toFixed(1)}deg)"`);
  }).join("");

  $("mymelds").innerHTML = me.melds.map((m) => m.tiles.map((t) => tileHtml(t)).join("")).join('<span style="width:10px"></span>')
    + me.flowers.map((t) => tileHtml(t, "fl")).join("");

  const canDiscard = !!pending?.some((a) => a.type === "discard");
  const hand = [...me.hand].sort((a, b) => a - b);
  $("myhand").className = canDiscard ? "" : "locked";
  $("myhand").innerHTML = hand.map((t) => tileHtml(t, "", `data-t="${t}"`)).join("")
    + (me.drawn !== null
        ? tileHtml(me.drawn, "drawn",
            `data-t="${me.drawn}" style="--drawms:${DRAW_MS}ms;--wx:${(120 - hand.length * 9).toFixed(0)}px;--wy:-190px"`)
        : "");
  if (canDiscard) {
    for (const el of Array.from($("myhand").querySelectorAll<HTMLElement>(".tile"))) {
      el.onclick = () => {
        const t = Number(el.dataset.t) as TileId;
        const a = pending?.find((x) => x.type === "discard" && x.tile === t);
        if (a) { gradeMyDiscard(t); act(a); }
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

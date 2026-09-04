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
import type { MatchRounds } from "../../engine/src/reducer.js";
import type { MatchState } from "../../engine/src/reducer.js";
import { decideAction, DEFAULT_PROFILE, assessRoutes, shapeOf, rankDiscards, scoreAdjust,
  assessClaim, claimContext, claimDecision, shouldKong, visibleCounts, faanCeiling,
  type BotConfig, type BotProfile, type RouteAssessment, type SeatView } from "../../engine/src/bots.js";
import { tableThreat } from "../../engine/src/threat.js";
import { MJRC_STANDARD, ruleset as rulesetById } from "../../rulesets/src/presets.js";
import type { Ruleset } from "../../engine/src/types.js";
import { prng } from "../../engine/src/wall.js";
import { TILE_NAMES, counts } from "../../engine/src/tiles.js";
import { liveTiles } from "../../engine/src/ready.js";
import type { Action, ClaimOption, SeatIndex, TileId } from "../../engine/src/types.js";
import { viewFor } from "../../tools/sim/driver.js";
import * as store from "./store.js";
import * as sync from "./sync.js";
import type { MatchRec, MoveRec, PlayerRec } from "./store.js";

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
/**
 * How a tile is NAMED in prose — the discard feed, the calls, the coach's
 * notes. The engine's own names are 萬索筒; most players cannot read them
 * (owner, 2026-08-30), so a suit is written with the mark that is actually
 * PRINTED on its face: a circle for circles, a stick for bamboo, and 萬 for
 * characters, whose face is that character. Honours and flowers get English,
 * having no mark to borrow. The tile ART is unchanged — this is only prose.
 */
const HONOUR_NAMES = ["East", "South", "West", "North", "Red", "Green", "White",
  "Plum", "Orchid", "Chrysanth", "Bamboo", "Spring", "Summer", "Autumn", "Winter"];
const name = (t: TileId): string =>
  t < 9 ? `${t + 1}萬` : t < 18 ? `${t - 8}▮` : t < 27 ? `${t - 17}●`
  : HONOUR_NAMES[t - 27] ?? "?";
/**
 * EVERY tile carries `data-t`. The counting handicap lights up every copy of a
 * tile on the table, and it can only do that if the pile, the melds and the
 * hand all say which tile they are — not just the hand, which was the only
 * place that carried it before.
 */
const tileHtml = (t: TileId, cls = "", attrs = ""): string =>
  `<span class="tile ${cls}" data-t="${t}" ${attrs}><svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet">${face(t)}</svg></span>`;

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
// Owner asked for ~1s toss and ~0.7s draw, then for the whole thing a shade
// slower again (2026-08-30). These are the numbers of record; the CSS that
// paces the wall build and the calls was moved with them.
const TOSS_MS = 1300;   // the throw
const DRAW_MS = 900;    // drawing off the wall

/* ── one motion at a time ───────────────────────────────────────────────
 * THE PROBLEM: the reducer batches. `doDiscard` emits the discard and then
 * calls `advanceTurn`, which draws for the next seat — both inside a single
 * `applyAction` (reducer.ts:1143). The client consumes that batch and renders
 * once, so the tile flying across the table and the tile flying into your hand
 * started in the SAME FRAME. Two motions competing for one pair of eyes
 * (owner, 2026-08-31).
 *
 * THE RULE, and it is the whole model: **motions queue, announcements do not.**
 * A motion is something physically moving — a toss, a draw, the wall building.
 * An announcement is a label appearing over the top of it, and it is free to
 * ride alongside the motion that caused it.
 *
 * Motions queue by DELAY, never by gating. Every element is created the moment
 * its event arrives and the affordance is live immediately; only the animation
 * waits, held at frame 0 by `animation-fill-mode: backwards`. MatchScene.ts
 * rule 1 — an affordance is never taken away by an animation — is intact.
 *
 * A draw follows a toss from the moment the tile has LANDED AND SETTLED (64 %
 * of the toss, the end of the pause), not from the end of the skid. By then
 * nothing is flying: the skid is a small settling motion and the next player
 * reaching for the wall over it is exactly what a real table looks like.
 */
const TOSS_LAND = 0.52;    // keyframe where the tile meets the felt
const TOSS_SETTLED = 0.64; // keyframe where the pause ends and the skid begins
const AFTER_TOSS_MS = TOSS_MS * TOSS_SETTLED;
/** When the most recent toss started. The draw queues behind it. */
let lastTossAt = -1e9;
const queueBehindToss = (): number =>
  Math.max(0, Math.round(lastTossAt + AFTER_TOSS_MS - performance.now()));
const $ = (id: string): HTMLElement => document.getElementById(id)!;
let state: MatchState;
let cfgs: BotConfig[];
let table: Table = TABLES[1]!;
let seed = 0;
let pending: Action[] | null = null;
let busy = false;
const feed: string[] = [];
interface Placed { x: number; y: number; rot: number; spin: number; }
let pileTiles: { id: number; tile: TileId; seat: number; pos?: Placed }[] = [];
let pileSeq = 0;     // every discard gets an id its DOM node is keyed to
let handSig = "";   // rebuild your hand only when it changes, so a draw animates once
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
interface Settings {
  rulesetId: string; tileScale: number; botMs: number; dev: boolean;
  rounds: MatchRounds; recorded: boolean;
  /** Handicaps — training wheels, each independently switchable. */
  hcCount: boolean;    // hover a tile, see every copy of it on the table
  hcCalling: boolean;  // a running read of whether the hand is calling
  hcWhatIf: boolean;   // hover your own tile, see what cutting it would leave you on
}
const SETTINGS: Settings = {
  rulesetId: "mjrc-standard", tileScale: 1, botMs: 420, dev: false, rounds: 1, recorded: true,
  hcCount: false, hcCalling: false, hcWhatIf: false,
  ...JSON.parse(localStorage.getItem("mjrc.settings") ?? "{}"),
};
const saveSettings = (): void => {
  localStorage.setItem("mjrc.settings", JSON.stringify(SETTINGS));
  document.documentElement.style.setProperty("--tscale", String(SETTINGS.tileScale));
  document.body.classList.toggle("devmode", SETTINGS.dev);
};
const rules = (): Ruleset => rulesetById(SETTINGS.rulesetId) ?? MJRC_STANDARD;
/**
 * Match length. The numbers are MEASURED, not guessed — 25 matches per length
 * on the mixed ladder gave 7.5 / 15.6 / 24.8 / 34.6 hands. A wind round is
 * nowhere near four hands because the dealer repeats on a dealer win AND on
 * 流局, and the 3-faan floor sends about a third of hands to 流局.
 *
 * Stating the cost on the button is deliberate: a player who picks 全莊 without
 * being told it is an evening is a player who abandons halfway.
 */
const LENGTHS: [MatchRounds, string, string, string][] = [
  [1, "東圈", "one wind", "~8 hands · 10–15 min"],
  [2, "東南", "two winds", "~16 hands · 20–30 min"],
  [3, "東南西", "three winds", "~25 hands · 35–50 min"],
  [4, "全莊", "four winds", "~35 hands · 50–70 min · a full sitting"],
];

/**
 * Rulesets offered for a game. Only the two that have actually been played
 * through the client are here: the owner wants testers on TVB specifically, and
 * offering an untested table invites feedback about something we already know
 * is unvalidated. `hkos-standard` stays registered in @mjrc/rulesets and is one
 * line from being listed again.
 */
const RULE_PICKS: [string, string, string][] = [
  ["mjrc-standard", "MJRC standard", "3–10 faan · flowers · doubling payments. The house game."],
  ["tvb-2026", "TVB Championship 2026", "1 faan minimum · no flowers · linear payments. Every hand is payable, and big hands barely out-earn small ones."],
];
/* ── handicaps ─────────────────────────────────────────────────────────
 * Training wheels, each switchable on its own. They tell the player only what
 * a careful player could work out from the table themselves — which tiles are
 * gone, what the hand is waiting on, what a discard would leave them on. No
 * hidden information: `visibleCounts` sees exactly what this seat can see.
 */
interface HandRead {
  distance: number;
  calling: boolean;
  /** Winning tiles when calling, improving tiles otherwise. */
  waits: { tile: TileId; unseen: number }[];
  total: number;
  ceiling: number;
  payable: boolean;
}
/** @param without a tile to imagine having cut first — the what-if handicap */
function readHand(without?: TileId): HandRead | null {
  if (!state) return null;
  const v = viewFor(state, HUMAN);
  const R = rules();
  const tiles = [...v.hand, ...(v.drawn !== null ? [v.drawn] : [])];
  if (without !== undefined) {
    const k = tiles.indexOf(without);
    if (k < 0) return null;
    tiles.splice(k, 1);
  }
  const c = counts(tiles);
  const melds = v.melds[HUMAN]!.length;
  // the house's 七對子 answer, or the assistant reads a six-pair hand as five
  // away when it is one tile from a win
  const seven = R.faanTable.sevenPairs !== undefined;
  const lt = liveTiles(c, melds, visibleCounts(v), seven);
  // faanCeiling adds components without clamping, so it can exceed the house
  // limit — it read "12 faan" under a 10-cap table. Cap it: 10 is the price.
  const ceiling = Math.min(faanCeiling(shapeOf(v), R), R.limitFaan);
  return {
    distance: lt.distance, calling: lt.distance <= 0,
    waits: lt.tiles.map((x) => ({ tile: x.tile, unseen: x.unseen })),
    total: lt.total, ceiling, payable: ceiling >= R.minimumFaan,
  };
}

/**
 * Naming the tiles is only useful when there are few of them. Five away from
 * calling, `liveTiles` returns nearly every tile in the game — nineteen of them
 * in testing, which is not a reading aid, it is wallpaper. Past six the count
 * alone carries the information.
 */
const WAIT_LIST_MAX = 6;
const waitList = (r: HandRead): string => {
  if (r.waits.length === 0) return "nothing live";
  if (r.waits.length > WAIT_LIST_MAX) return `<b>${r.waits.length}</b> different tiles help`;
  return r.waits.map((w) => `<b>${name(w.tile)}</b>&thinsp;<span class="n">${w.unseen}</span>`).join(" ");
};

/** The standing read, shown above your hand while the handicap is on. */
function callingBar(): string {
  if (!SETTINGS.hcCalling || !state || overlay) return "";
  const r = readHand();
  if (!r) return "";
  const faan = r.payable
    ? `<span class="ok">can reach ${r.ceiling} faan</span>`
    : `<span class="warn">only ${r.ceiling} faan — under the ${rules().minimumFaan} minimum,
       this hand cannot be taken yet</span>`;
  return `<div id="callbar" class="${r.calling ? "calling" : ""}">
    ${r.calling
      ? `<b class="lead">CALLING 聽牌</b> waiting on ${waitList(r)}
         <span class="tot">${r.total} live</span>`
      : `<b class="lead">${r.distance} away</b> from calling · helps: ${waitList(r)}
         <span class="tot">${r.total} live</span>`}
    <span class="faan">${faan}</span></div>`;
}

/** What cutting THIS tile would leave you on. Driven by hover. */
function whatIf(tile: TileId): string {
  const r = readHand(tile);
  if (!r) return "";
  return r.calling
    ? `<b class="lead">cut ${name(tile)} → CALLING</b> on ${waitList(r)}
       <span class="tot">${r.total} live</span>`
    : `<b class="lead">cut ${name(tile)} → ${r.distance} away</b> · helps: ${waitList(r)}
       <span class="tot">${r.total} live</span>`;
}

/**
 * Hover wiring, delegated from the document so it survives every re-render.
 * Counting lights every copy of the tile anywhere on the table; the what-if
 * read only applies to tiles in your own hand, since cutting somebody else's
 * is not a move you have.
 */
function wireHover(): void {
  document.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.(".tile") as HTMLElement | null;
    if (!el?.dataset.t) return;
    const t = Number(el.dataset.t) as TileId;
    if (SETTINGS.hcCount) {
      // the class on <body> is what dims everything else — see index.html
      document.body.classList.add("counting");
      for (const o of Array.from(document.querySelectorAll<HTMLElement>(`.tile[data-t="${t}"]`))) {
        o.classList.add("samet");
      }
    }
    if (SETTINGS.hcWhatIf && el.closest("#myhand") && !overlay) {
      const bar = document.getElementById("callbar");
      if (bar) { bar.dataset.saved ??= bar.innerHTML; bar.innerHTML = whatIf(t); bar.classList.add("whatif"); }
    }
  });
  document.addEventListener("mouseout", (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.(".tile") as HTMLElement | null;
    if (!el) return;
    document.body.classList.remove("counting");
    for (const o of Array.from(document.querySelectorAll<HTMLElement>(".tile.samet"))) {
      o.classList.remove("samet");
    }
    const bar = document.getElementById("callbar");
    if (bar?.dataset.saved) { bar.innerHTML = bar.dataset.saved; delete bar.dataset.saved; bar.classList.remove("whatif"); }
  });
}

/* ── what happened in one match ────────────────────────────────────────
 * Derived by walking the stored event log. This is the payoff for keeping the
 * full log rather than a summary row: none of the numbers below were decided
 * on in advance, and a new one is a re-read rather than a schema change.
 */
interface SeatStat {
  discards: number; claims: number; kongs: number; flowers: number;
  wins: number; selfDraws: number; fed: number; faan: number; best: number;
}
interface HandLine { n: number; winner: number | null; selfDraw: boolean; from: number | null; faan: number; deltas: number[]; }
interface MatchStats { seats: SeatStat[]; hands: HandLine[]; discards: number; draws: number; }

function deriveMatchStats(m: MatchRec): MatchStats {
  const blank = (): SeatStat =>
    ({ discards: 0, claims: 0, kongs: 0, flowers: 0, wins: 0, selfDraws: 0, fed: 0, faan: 0, best: 0 });
  const st: MatchStats = { seats: [blank(), blank(), blank(), blank()], hands: [], discards: 0, draws: 0 };
  let pending: Omit<HandLine, "n" | "deltas"> = { winner: null, selfDraw: false, from: null, faan: 0 };
  for (const raw of m.events as { type: string; payload: Record<string, unknown> }[]) {
    const p = raw?.payload ?? {};
    switch (raw?.type) {
      case "discard": { const s2 = p.seat as number; st.seats[s2]!.discards++; st.discards++; break; }
      case "claimed": {
        const s2 = p.seat as number; st.seats[s2]!.claims++;
        if (p.kind === "kong") st.seats[s2]!.kongs++;
        break;
      }
      case "concealedKong": case "addedKong": st.seats[p.seat as number]!.kongs++; break;
      case "flowerReplacement": st.seats[p.seat as number]!.flowers++; break;
      case "winOnDiscard": case "selfDraw": {
        const ctx = p.context as { seat: number; selfDraw: boolean; from: number | null };
        const sc = p.score as { faan: number };
        const w = st.seats[ctx.seat]!;
        w.wins++; w.faan += sc.faan; w.best = Math.max(w.best, sc.faan);
        if (ctx.selfDraw) w.selfDraws++;
        else if (ctx.from !== null && ctx.from !== undefined) st.seats[ctx.from]!.fed++;
        pending = { winner: ctx.seat, selfDraw: ctx.selfDraw, from: ctx.from ?? null, faan: sc.faan };
        break;
      }
      case "exhaustiveDraw": st.draws++; break;
      case "handEnd":
        st.hands.push({ n: st.hands.length + 1, ...pending, deltas: (p.chipDeltas as number[]) ?? [0, 0, 0, 0] });
        pending = { winner: null, selfDraw: false, from: null, faan: 0 };
        break;
    }
  }
  return st;
}

const seatNamesOf = (m: MatchRec): string[] =>
  ["You", ...m.seats.map((k) => BOT_NAMES[k] ?? k)];

/**
 * The scoreboard for one match — shown the moment a game ends, and again from
 * Your games. The owner's complaint was that a finished game simply stopped
 * and the score was nowhere: "I actually don't even know what the score was."
 */
function matchScreen(m: MatchRec, back: () => void): void {
  $("veil").style.display = "flex";
  const s2 = deriveMatchStats(m);
  const names = seatNamesOf(m);
  const chips = m.chips ?? [0, 0, 0, 0];
  const order = [0, 1, 2, 3].sort((a, b) => (chips[b] ?? 0) - (chips[a] ?? 0));
  const place = order.indexOf(HUMAN) + 1;
  const mins = m.finishedAt ? Math.round((m.finishedAt - m.startedAt) / 60000) : null;
  $("panel").innerHTML = `
    <h1>${m.abandoned ? "Forfeited"
      : place === 1 ? "🏆 You win" : `You finish ${place}${["st", "nd", "rd", "th"][place - 1]}`}</h1>
    <p class="mut">${m.rounds}-wind · ${m.tableId} table · ${m.rulesetId} ·
      ${m.hands} hands${mins !== null ? ` · ${mins} min` : ""} ·
      ${new Date(m.finishedAt ?? m.startedAt).toLocaleString()}</p>

    <h2 style="margin-top:14px">Final score</h2>
    <div class="rows head"><span class="c1">player</span><span class="c2">chips</span>
      <span class="c2">hands won</span><span class="c2">self-draw</span>
      <span class="c2">fed</span><span class="c2">best</span></div>
    <div class="rows">${order.map((i, r) => {
      const q = s2.seats[i]!;
      return `<div class="row ${i === HUMAN ? "me" : ""}">
        <span class="c1">${r + 1}. ${names[i]}</span>
        <span class="c2 ${(chips[i] ?? 0) > 0 ? "up" : (chips[i] ?? 0) < 0 ? "down" : ""}">${fmtChips(chips[i] ?? 0)}</span>
        <span class="c2">${q.wins}</span><span class="c2">${q.selfDraws}</span>
        <span class="c2">${q.fed}</span><span class="c2">${q.best || "—"}</span></div>`;
    }).join("")}</div>

    <h2 style="margin-top:14px">At the table</h2>
    <div class="rows head"><span class="c1">player</span><span class="c2">discards</span>
      <span class="c2">claims</span><span class="c2">kongs</span><span class="c2">flowers</span></div>
    <div class="rows">${[0, 1, 2, 3].map((i) => {
      const q = s2.seats[i]!;
      return `<div class="row ${i === HUMAN ? "me" : ""}"><span class="c1">${names[i]}</span>
        <span class="c2">${q.discards}</span><span class="c2">${q.claims}</span>
        <span class="c2">${q.kongs}</span><span class="c2">${q.flowers}</span></div>`;
    }).join("")}</div>
    <p class="mut">${s2.discards} tiles thrown in all · ${s2.draws} hand${s2.draws === 1 ? "" : "s"} ended 流局.</p>

    ${s2.hands.length === 0 ? "" : `
    <h2 style="margin-top:14px">Hand by hand</h2>
    <div class="rows">${s2.hands.map((h) => `
      <div class="row"><span class="c1">${h.n}. ${
        h.winner === null ? "<span class=\"mut\">流局 — nobody wins</span>"
        : `${names[h.winner]} ${h.selfDraw ? "自摸" : h.from === HUMAN ? "on YOUR discard"
            : h.from !== null ? `off ${names[h.from]}` : "食糊"} · <b>${h.faan} faan</b>`}</span>
        <span class="c2 ${(h.deltas[0] ?? 0) > 0 ? "up" : (h.deltas[0] ?? 0) < 0 ? "down" : ""}">${
          h.deltas[0] ? fmtChips(h.deltas[0]) : "—"}</span></div>`).join("")}</div>`}

    ${m.movesGraded === 0 ? "" : `
    <h2 style="margin-top:14px">How you played it</h2>
    <div class="statgrid">
      <div><span>${fmtPct(m.matchRate)}</span>engine agreement</div>
      <div><span>${m.meanGap === null ? "—" : m.meanGap.toFixed(2)}</span>mean gap</div>
      <div><span>${m.movesGraded}</span>decisions graded</div>
    </div>`}
    ${backRow(back)}`;
  wireBack(back);
}

/* ── getting the data off the device ───────────────────────────────────
 * The store is a queue; sync.ts drains it. Drained on boot and again whenever a
 * match finishes, so a tester who plays and closes the tab has still sent it.
 * Never awaited by anything the player is waiting on.                       */
async function showSync(): Promise<void> {
  const el = document.getElementById("syncLine");
  if (!el) return;
  const left = await sync.pending(store);
  el.textContent = left === 0 ? "all games sent" : `${left} waiting to send…`;
  if (left === 0) return;
  const r = await sync.drain(store);
  const now = await sync.pending(store);
  el.textContent = now === 0
    ? `sent ${r.matches + r.feedback}`
    : `${now} still to send${r.why ? ` (${r.why})` : ""} — they will go next time`;
}

/* ── the lobby ─────────────────────────────────────────────────────────
 * Home. Everything that is not a game in progress hangs off here: start a
 * match, look at what you have played, see how everyone compares.
 *
 * Finishing a match returns HERE, not to a fresh game (owner 2026-08-31). A
 * "play again" button treats the last result as something to get past; a lobby
 * treats it as something that was recorded.                                  */
const fmtPct = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);
const fmtChips = (n: number): string => `${n > 0 ? "+" : ""}${n}`;

/** Everything the stats screens need, derived from stored matches. */
interface Agg {
  matches: number; finished: number; abandoned: number;
  hands: number; won: number; selfDrawn: number; fed: number; drawnHands: number;
  chips: number; graded: number; matched: number; gapSum: number;
  seatWins: number[]; seatGames: number;
}
function aggregate(rows: MatchRec[]): Agg {
  const a: Agg = { matches: 0, finished: 0, abandoned: 0, hands: 0, won: 0, selfDrawn: 0,
    fed: 0, drawnHands: 0, chips: 0, graded: 0, matched: 0, gapSum: 0,
    seatWins: [0, 0, 0, 0], seatGames: 0 };
  for (const m of rows) {
    a.matches++;
    if (m.abandoned) a.abandoned++; else if (m.finishedAt) a.finished++;
    a.hands += m.hands; a.won += m.won; a.selfDrawn += m.selfDrawn;
    a.fed += m.fed; a.drawnHands += m.drawnHands;
    a.chips += m.chips[0] ?? 0;
    a.graded += m.movesGraded;
    // matchRate is a mean over that match's moves — reconstruct the numerator
    if (m.matchRate !== null) a.matched += m.matchRate * m.movesGraded;
    if (m.meanGap !== null) a.gapSum += m.meanGap * m.movesGraded;
    for (let i = 0; i < 4; i++) a.seatWins[i]! += m.seatWins[i] ?? 0;
    a.seatGames++;
  }
  return a;
}

/**
 * What this is, for somebody opening it for the first time. Shown once after
 * the name screen, and always reachable from the lobby.
 *
 * It is deliberately blunt about the state of things. A tester who thinks they
 * are looking at a finished product files the wrong bugs, and a tester who does
 * not know their play is recorded has not been asked.
 */
function aboutScreen(back: () => void): void {
  $("veil").style.display = "flex";
  $("panel").classList.add("about");          // prose reads left-aligned
  $("panel").innerHTML = `
    <h1>Solo — a demo, not a game yet</h1>
    <p>A playable Hong Kong Old Style table against three bots. It exists so we
    can find out what breaks before any of it is finished — so play a hand or
    two and tell us what felt wrong.</p>
    <p class="mut">This build is called <b>Solo</b>. It is frozen: the same rules,
    the same bots and the same scoring every time you open it, so everything it
    records stays comparable.</p>

    <h2>What we are testing</h2>
    <ul class="about">
      <li><b>The bots</b> — do they play like people, and can you beat them?</li>
      <li><b>The rules</b> — legality, scoring, the 3-faan floor, the calls.</li>
      <li><b>The feel</b> — pacing, animation, whether a turn reads clearly.</li>
    </ul>

    <h2>The bots are the part we have spent the most time on</h2>
    <p>They came out of a long training programme: five eras of evolution, each
    era's champion frozen and made the next era's opponent, so the difficulty on
    the table picker is a <b>measured</b> quantity rather than a guess. Sifu is
    the strongest one that programme produced.</p>
    <p class="mut">They still have gaps we know about — they will not chase
    七對子, for one. If one plays a hand that looks foolish, that is worth
    telling us about.</p>

    <h2>The look will change</h2>
    <p>Treat the interface as a sketch. Notes on it are welcome, but expect most
    of it to be redrawn.</p>

    <h2>Later</h2>
    <p>Playing against each other rather than against bots. That is a separate
    build, and it will not change this one.</p>

    <h2>Your games are recorded</h2>
    <p>Every match, every decision we grade, and every note you send goes to our
    server. That is the point of the demo: we want to know how the bots hold up
    against real people, and the whole training programme was bots against bots
    — the comparison has never been made.</p>
    <p class="mut">No account and no email. Just the name you typed, which you
    can change whenever you like.</p>

    <p>The <b>✎ feedback</b> button is on every screen, and it attaches whatever
    you were looking at — the hand, the seed, the last few plays — so a report
    can be replayed rather than guessed at.</p>
    <button id="btnAbout">got it ▸</button>`;
  ($("btnAbout") as HTMLButtonElement).onclick = () => {
    $("panel").classList.remove("about");
    $("veil").style.display = "none";
    back();
  };
}

function lobbyScreen(): void {
  overlay = null;
  $("veil").style.display = "flex";
  $("panel").innerHTML = `
    <h1>香港麻雀 · MJRC</h1>
    <p class="mut">Playing as <b>${player?.name ?? "—"}</b> ·
      <a href="#" id="btnRename" style="color:var(--gold)">change name</a></p>
    <div class="choices lobby" style="margin-top:16px">
      <div class="choice" id="goPlay"><b>Play ▸</b><span>Pick a length and a table, then sit down.</span></div>
      <div class="choice" id="goStats"><b>Your games</b><span>Every match you have played, and how close to the engine you played it.</span></div>
      <div class="choice" id="goBoard"><b>Leaderboard</b><span>How your games compare.</span></div>
    </div>
    <div id="lobbySum" class="mut" style="margin-top:14px">…</div>
    <p class="mut"><a href="#" id="btnAbout2" style="color:var(--gold)">what is this?</a>
      · <span id="syncLine">…</span></p>`;
  ($("goPlay") as HTMLElement).onclick = () => startScreen();
  ($("goStats") as HTMLElement).onclick = () => statsScreen();
  ($("goBoard") as HTMLElement).onclick = () => boardScreen();
  ($("btnRename") as HTMLElement).onclick = (e) => { e.preventDefault(); nameScreen(lobbyScreen); };
  ($("btnAbout2") as HTMLElement).onclick = (e) => { e.preventDefault(); aboutScreen(lobbyScreen); };
  void showSync();
  void store.allMatches().then((rows) => {
    const mine = rows.filter((m) => m.playerId === player?.id);
    const a = aggregate(mine);
    const el = document.getElementById("lobbySum");
    if (!el) return;
    el.innerHTML = a.matches === 0
      ? "No games yet. Everything you play is recorded so we can see how the bots hold up."
      : `<b>${a.matches}</b> games · <b>${a.hands}</b> hands · <b>${a.won}</b> hands won ·
         lifetime <b>${fmtChips(a.chips)}</b> chips ·
         engine agreement <b>${fmtPct(a.graded ? a.matched / a.graded : null)}</b>`;
  });
}

function backRow(to: () => void): string {
  return `<button id="btnLobby" style="margin-top:16px">◂ back to lobby</button>`;
}
const wireBack = (to: () => void): void => {
  const b = document.getElementById("btnLobby");
  if (b) (b as HTMLButtonElement).onclick = () => to();
};

function statsScreen(): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = `<h1>Your games</h1><p class="mut">reading…</p>`;
  void Promise.all([store.allMatches(), store.usage()]).then(([rows, use]) => {
    const mine = rows.filter((m) => m.playerId === player?.id)
      .sort((x, y) => (y.finishedAt ?? y.startedAt) - (x.finishedAt ?? x.startedAt));
    const a = aggregate(mine);
    const rate = a.graded ? a.matched / a.graded : null;
    const gap = a.graded ? a.gapSum / a.graded : null;
    $("panel").innerHTML = `
      <h1>Your games</h1>
      ${mine.length === 0 ? "<p>Nothing recorded yet.</p>" : `
      <div class="statgrid">
        <div><span>${a.matches}</span>games</div>
        <div><span>${a.hands}</span>hands</div>
        <div><span>${a.won}</span>hands won</div>
        <div><span>${fmtChips(a.chips)}</span>chips</div>
        <div><span>${fmtPct(rate)}</span>engine agreement</div>
        <div><span>${gap === null ? "—" : gap.toFixed(2)}</span>mean gap</div>
      </div>
      <p class="mut" style="margin-top:8px">
        <b>Engine agreement</b> is how often you played the champion's own top choice —
        ${a.graded} decisions graded. It measures closeness to the bot, not correctness:
        the bot is the strongest one the training programme produced, not a solved game.
        <b>Mean gap</b> is what your choices cost in its scoring units; lower is closer.</p>
      <p class="mut">You fed ${a.fed} winning discards · self-drew ${a.selfDrawn} ·
        ${a.drawnHands} hands ended 流局 · ${a.abandoned} game(s) abandoned.</p>
      <h2 style="margin-top:14px">Match by match</h2>
      <div class="rows">${mine.slice(0, 40).map((m, k) => `
        <div class="row click" data-k="${k}">
          <span class="c1">${new Date(m.finishedAt ?? m.startedAt).toLocaleDateString()} ·
            ${m.rounds}-wind · ${m.tableId}${m.abandoned ? " · <b style=\"color:var(--danger)\">forfeit</b>" : ""}</span>
          <span class="c2">${m.hands}h</span>
          <span class="c2 ${(m.chips[0] ?? 0) > 0 ? "up" : (m.chips[0] ?? 0) < 0 ? "down" : ""}">${fmtChips(m.chips[0] ?? 0)}</span>
          <span class="c2">${fmtPct(m.matchRate)}</span>
        </div>`).join("")}</div>
      <p class="mut" style="margin-top:10px">Tap a match to see how it went.
        ${use.matches} matches stored, about ${Math.round(use.approxBytes / 1024)} KB.
        Sent to us as you play, so we can see how the bots do against real people.</p>`}
      ${backRow(lobbyScreen)}`;
    for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".row.click"))) {
      el.onclick = () => { const m = mine[Number(el.dataset.k)]; if (m) matchScreen(m, statsScreen); };
    }
    wireBack(lobbyScreen);
  });
}

/**
 * The leaderboard. Sorted by wins by default (owner 2026-08-31), with every
 * other column sortable — because no single one of them is the truth:
 *
 *   wins        matches finished in first place. What people care about, and
 *               the noisiest thing here over a handful of games.
 *   hands       most hands played. Rewards showing up, which in a beta is
 *               exactly what we want to reward.
 *   chips       the scoreboard. Also mostly wall luck at this sample size —
 *               the training work measured ±16 chips of noise in one block.
 *   net/hand    chips normalised by exposure, so a long session does not
 *               outrank a good one on volume alone.
 *   agreement   how often you played the engine's own top choice. By far the
 *               steadiest of the five, because it scores every decision rather
 *               than the handful that happened to end in a payout.
 */
type BoardKey = "wins" | "hands" | "chips" | "net" | "rate";
let boardSort: BoardKey = "wins";

function boardScreen(): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = `<h1>Leaderboard</h1><p class="mut">reading…</p>`;
  void store.allMatches().then((rows) => {
    const counted = rows.filter((m) => m.recorded && !m.abandoned && m.finishedAt !== null);
    const byPlayer = new Map<string, { name: string; rows: MatchRec[] }>();
    for (const m of counted) {
      const e = byPlayer.get(m.playerId) ?? { name: m.playerName, rows: [] };
      e.name = m.playerName; e.rows.push(m); byPlayer.set(m.playerId, e);
    }
    const table = [...byPlayer.values()].map((e) => {
      const a = aggregate(e.rows);
      // a match is won by finishing first on chips; ties share the place
      const wins = e.rows.filter((m) => {
        const c = m.chips ?? [0, 0, 0, 0];
        return (c[0] ?? 0) >= Math.max(...c.slice(1).map((x) => x ?? 0));
      }).length;
      return {
        name: e.name, games: a.matches, wins, hands: a.hands, handsWon: a.won,
        chips: a.chips, net: a.hands ? a.chips / a.hands : 0,
        rate: a.graded ? a.matched / a.graded : null,
      };
    });
    const key = (r: typeof table[number]): number =>
      boardSort === "wins" ? r.wins : boardSort === "hands" ? r.hands
      : boardSort === "chips" ? r.chips : boardSort === "net" ? r.net : (r.rate ?? -1);
    table.sort((x, y) => key(y) - key(x) || y.hands - x.hands);
    const COLS: [BoardKey, string][] = [
      ["wins", "wins"], ["hands", "hands"], ["chips", "chips"],
      ["net", "net/hd"], ["rate", "agree"],
    ];
    $("panel").innerHTML = `
      <h1>Leaderboard</h1>
      <p class="mut">Sorted by <b>${COLS.find((c) => c[0] === boardSort)![1]}</b> —
        tap a heading to change it. None of these is the whole picture: wins and
        chips are what you feel but carry most of the luck (±16 chips of noise in a
        single block), while agreement scores every decision rather than the few
        that ended in a payout.</p>
      ${table.length === 0 ? "<p>No completed recorded games yet.</p>" : `
      <div class="rows head"><span class="c1">player</span>${
        COLS.map(([k, label]) =>
          `<span class="c2 sortable ${boardSort === k ? "on" : ""}" data-k="${k}">${label}</span>`).join("")}</div>
      <div class="rows">${table.map((r, i) => `
        <div class="row ${r.name === player?.name ? "me" : ""}">
          <span class="c1">${i + 1}. ${r.name} <span class="mut">· ${r.games}g</span></span>
          <span class="c2">${r.wins}</span>
          <span class="c2">${r.hands}</span>
          <span class="c2 ${r.chips > 0 ? "up" : r.chips < 0 ? "down" : ""}">${fmtChips(r.chips)}</span>
          <span class="c2 ${r.net > 0 ? "up" : r.net < 0 ? "down" : ""}">${r.net.toFixed(1)}</span>
          <span class="c2">${fmtPct(r.rate)}</span>
        </div>`).join("")}</div>`}
      <p class="mut" style="margin-top:10px">Forfeits and casual games are excluded.
        This board is what THIS device has played; everyone\u2019s games are sent to us,
        but a shared board across testers is not built yet.</p>
      ${backRow(lobbyScreen)}`;
    for (const h of Array.from($("panel").querySelectorAll<HTMLElement>(".sortable"))) {
      h.onclick = () => { boardSort = h.dataset.k as BoardKey; boardScreen(); };
    }
    wireBack(lobbyScreen);
  });
}

/* ── flow ──────────────────────────────────────────────────────────────── */

/**
 * Who is playing. A name and nothing else: no password, no email, no sign-in.
 * The key is a generated uuid, not the name, so two friends both called "Dave"
 * do not merge into one record and renaming yourself does not fork you into two.
 *
 * The limitation is stated on screen rather than hidden: this is per-device.
 */
function nameScreen(then: () => void): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = `
    <h1>香港麻雀 · MJRC</h1>
    <p>What should we call you? This is a private beta — every game you play is
    recorded and sent to us, so we can see how the bots hold up against real
    people. That comparison has never been made: the bots were trained entirely
    against each other.</p>
    <div class="setrow" style="margin-top:14px">
      <input id="nameIn" type="text" maxlength="24" placeholder="your name"
        value="${(player?.name ?? "").replace(/"/g, "&quot;")}"
        style="flex:1;padding:9px 12px;font-size:16px;border-radius:9px;
               background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);color:var(--ink)">
    </div>
    <p class="mut" id="nameNote">Your games are sent to us so we can see how the bots hold up
      against real people. No account, no email \u2014 just this name.</p>
    <button id="btnName">continue ▸</button>`;
  const input = document.getElementById("nameIn") as HTMLInputElement;
  const go = async (): Promise<void> => {
    const nm = input.value.trim();
    if (!nm) { input.focus(); return; }
    player = await store.setPlayerName(nm);
    then();
  };
  ($("btnName") as HTMLButtonElement).onclick = () => void go();
  input.onkeydown = (e) => { if (e.key === "Enter") void go(); };
  input.focus();
  // say so plainly if the store did not take, rather than silently losing games
  void store.available().then((a) => {
    if (!a.ok) $("nameNote").innerHTML =
      `<b style="color:var(--danger)">This browser will not let us store anything</b>, so nothing
       can be recorded — the game still plays. (${a.why || "IndexedDB unavailable"})`;
  });
}

function startScreen(): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = `
    <h1>Sit down</h1>

    <h2>Length</h2>
    <div class="seg">${LENGTHS.map(([n, ch, en]) => `
      <button class="${SETTINGS.rounds === n ? "on" : ""}" data-len="${n}">
        <b>${ch}</b><span>${en}</span></button>`).join("")}</div>
    <p class="segcap">${LENGTHS.find(([n]) => n === SETTINGS.rounds)?.[3] ?? ""}</p>

    <h2>Rules</h2>
    <div class="choices two">${RULE_PICKS.map(([id, label, blurb]) => `
      <div class="choice ${SETTINGS.rulesetId === id ? "sel" : ""}" data-r="${id}">
        <b>${label}</b><span>${blurb}</span></div>`).join("")}</div>

    <h2>Table</h2>
    <div class="choices two">${TABLES.map((t) => `
      <div class="choice ${t.id === table.id ? "sel" : ""}" data-t="${t.id}">
        <b>${t.label}</b><span>${t.blurb}</span>
        <span class="seats">${t.seats.map((x) => BOT_NAMES[x] ?? x).join(" · ")}</span>
      </div>`).join("")}</div>

    <div class="setrow" style="margin-top:12px">
      <label>Record this game</label>
      <input type="checkbox" id="setRec" ${SETTINGS.recorded ? "checked" : ""}>
      <span class="mut">counts for your stats · quitting is recorded as a forfeit</span>
    </div>
    <p class="mut">Playing as <b>${player?.name ?? "—"}</b> ·
      <a href="#" id="btnRename" style="color:var(--gold)">change name</a></p>
    <button id="btnStart">sit down ▸</button>
    <button id="btnLobby" style="margin-left:8px;background:rgba(255,255,255,.08)">◂ lobby</button>`;
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seg button"))) {
    el.onclick = () => { SETTINGS.rounds = Number(el.dataset.len) as MatchRounds; saveSettings(); startScreen(); };
  }
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".choice"))) {
    el.onclick = () => {
      if (el.dataset.r) SETTINGS.rulesetId = el.dataset.r;
      else table = TABLES.find((t) => t.id === el.dataset.t)!;
      saveSettings();
      startScreen();
    };
  }
  const rcx = document.getElementById("setRec") as HTMLInputElement | null;
  if (rcx) rcx.onchange = () => { SETTINGS.recorded = rcx.checked; saveSettings(); };
  const ren = document.getElementById("btnRename");
  if (ren) ren.onclick = (e) => { e.preventDefault(); nameScreen(startScreen); };
  wireBack(lobbyScreen);
  ($("btnStart") as HTMLButtonElement).onclick = () => newMatch();
}

function newMatch(): void {
  seed = Math.floor(Math.random() * 2 ** 31);
  const R = rules();
  beginRecord();
  const r = startMatch({ seed, ruleset: R, matchLength: SETTINGS.rounds } as never);
  state = r.state;
  cfgs = [0, 1, 2, 3].map((i) => ({
    ruleset: R,
    profile: i === HUMAN ? DEFAULT_PROFILE : profileOf(table.seats[i - 1]!),
    rnd: prng((seed ^ ((i + 1) * 0x9e3779b1)) >>> 0),
  }));
  feed.length = 0; pileTiles = []; handSig = ""; devBotLines = [];
  $("say").className = ""; coachLog.length = 0;
  $("veil").style.display = "none";
  $("hudTable").textContent = table.label + " — " + table.seats.map((s) => BOT_NAMES[s] ?? s).join(", ");
  consume(r.events);
  advance();
  buildWall();
}

/* ── the recorder ───────────────────────────────────────────────────────
 * Everything a match produces is accumulated in memory and written to
 * IndexedDB at each hand end. Never on a per-turn basis: a store write must
 * not sit between a player tapping a tile and the tile moving.
 *
 * Nothing here decides anything about the game. If the store is unavailable
 * the accumulators still fill and the writes quietly no-op — the game is
 * identical, it just goes unrecorded.                                       */
let player: PlayerRec | null = null;
let rc: MatchRec | null = null;         // the match being recorded
/**
 * The last match's id and where it got to, kept AFTER `rc` is cleared. People
 * file feedback about the game they just left, not the one they are in, and a
 * report that cannot be tied back to a match cannot be replayed.
 */
let lastMatch: { id: string; hand: number; label: string } | null = null;
let rcMoves: MoveRec[] = [];
/** Totals that survive a flush emptying rcMoves. See summariseMoves. */
let rcGraded = 0, rcMatched = 0, rcGapSum = 0;
let humanTurns = 0;

const RECORD_VERSION = 1;

function beginRecord(): void {
  humanTurns = 0;
  rcMoves = [];
  rcGraded = 0; rcMatched = 0; rcGapSum = 0;
  const id = crypto.randomUUID();
  rc = {
    id,
    playerId: player?.id ?? "anonymous",
    playerName: player?.name ?? "anonymous",
    rounds: SETTINGS.rounds,
    rulesetId: rules().id,
    seats: [...table.seats],
    tableId: table.id,
    seed,
    recorded: SETTINGS.recorded,
    abandoned: false,
    startedAt: Date.now(),
    finishedAt: null,
    chips: [0, 0, 0, 0],
    hands: 0, won: 0, selfDrawn: 0, fed: 0, drawnHands: 0,
    seatWins: [0, 0, 0, 0],
    matchRate: null, meanGap: null, movesGraded: 0,
    events: [], actions: [],
  };
  lastMatch = { id, hand: 0, label: `${SETTINGS.rounds}-wind game vs ${table.label}` };
}

/** Roll the move grades up into the two headline numbers. */
/**
 * RUNNING totals, not a count of the buffer.
 *
 * `flushRecord` hands `rcMoves` to the store and empties it, so summarising
 * from that array only ever described the moves since the last flush — and the
 * final flush at match end runs immediately after the last hand-end flush, when
 * the buffer is empty. Completed matches were therefore stored with
 * movesGraded 0 and matchRate null while their moves uploaded fine. Caught on
 * the first real tester's game: 124 rows in game_move, 0 on the match.
 */
function recordMove(m: MoveRec): void {
  rcMoves.push(m);
  rcGraded++;
  if (m.gap <= 0.0001) rcMatched++;
  rcGapSum += m.gap;
}

function summariseMoves(): void {
  if (!rc) return;
  rc.movesGraded = rcGraded;
  if (rcGraded === 0) { rc.matchRate = null; rc.meanGap = null; return; }
  rc.matchRate = rcMatched / rcGraded;
  rc.meanGap = rcGapSum / rcGraded;
}

/** Upsert what we have. Called at hand end, match end, and on quitting. */
function flushRecord(): void {
  if (!rc) return;
  summariseMoves();
  rc.chips = [0, 1, 2, 3].map((i) => state?.seats[i as SeatIndex]?.chips ?? 0);
  void store.putMatch({ ...rc, events: [...rc.events], actions: [...rc.actions] });
  void store.putMoves(rcMoves.splice(0));   // moves are append-only; hand them over once
}

/* ── events ────────────────────────────────────────────────────────────── */
let overlay: string | null = null;
function consume(events: readonly unknown[]): void {
  if (rc) rc.events.push(...(events as unknown[]));
  for (const e of events as { type: string; payload: Record<string, unknown> }[]) {
    const p = e.payload ?? {};
    const who = (s: unknown): string =>
      s === HUMAN ? "You" : (BOT_NAMES[table.seats[(s as number) - 1]!] ?? "Bot");
    switch (e.type) {
      case "discard":
        pileTiles.push({ id: ++pileSeq, tile: p.tile as TileId, seat: p.seat as number });
        feed.push(`${who(p.seat)} discards ${name(p.tile as TileId)}`);
        sayDiscard(p.tile as TileId, p.seat as SeatIndex);
        break;
      case "claimed": {
        // read the tile's pile position before the pop takes its node away
        armGrab(p.tile as TileId, p.seat as SeatIndex,
          pileTiles[pileTiles.length - 1]?.pos?.rot ?? 0);
        landingMeld = { seat: p.seat as SeatIndex, index: state.seats[p.seat as SeatIndex]!.melds.length - 1 };
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
        if (rc) {
          rc.seatWins[ctx.seat]!++;
          if (ctx.seat === HUMAN) { rc.won++; if (ctx.selfDraw) rc.selfDrawn++; }
          else if (ctx.from === HUMAN) rc.fed++;   // you paid for that one
        }
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
        if (rc) rc.drawnHands++;
        overlay = `<h1>流局</h1><h2>The wall ran out — nobody wins</h2>`;
        break;
      case "handEnd": {
        if (rc) { rc.hands++; flushRecord(); }
        if (lastMatch) lastMatch.hand = state.handIndex;
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
        if (rc) {
          rc.finishedAt = Date.now();
          flushRecord();
          // hand the finished record to advance(), which shows the scoreboard
          endedMatch = { ...rc, chips: [...rc.chips], events: [...rc.events] };
          // send it now; a tester who closes the tab has still reported
          void sync.drain(store);
        }
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
/** The champion, reading YOUR seat. Fresh each call so its rng never drifts. */
const coachCfg = (v: SeatView): BotConfig =>
  ({ ruleset: rules(), profile: scoreAdjust(profileOf("v4"), v), rnd: prng(7) });
/** A verdict, coloured. Green you played it, amber close, red it cost you. */
const verdictHtml = (cls: string, grade: string, head: string, why = ""): string =>
  `<div class="ce ${cls}"><span class="g">${grade}</span>${head}` +
  `${why ? `<div class="mut">${why}</div>` : ""}</div>`;
/**
 * Grade one of YOUR discards against the champion's ranking.
 *
 * This used to be gated on dev mode and thrown away. It now always runs and is
 * always recorded: `rankDiscards` costs 0.07 ms, so a whole four-wind match
 * spends about 45 ms grading — there was never a performance reason to hide it.
 * Dev mode now controls only whether the reasoning is SHOWN.
 */
function gradeMyDiscard(tile: TileId): void {
  const v = viewFor(state, HUMAN);
  const cfg = coachCfg(v);
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
  // The record keeps the NUMBERS; the log keeps the prose. top1MinusTop2 is
  // stored so an "obvious" turn can be filtered out later: agreeing with the
  // engine on a forced move says nothing about the player.
  recordMove({
    matchId: rc?.id ?? "", hand: state.handIndex, turn: humanTurns++,
    kind: "discard", played: name(tile), enginePick: name(best.tile),
    gap, top1MinusTop2: ranked.length > 1 ? best.score - ranked[1]!.score : 0,
    reason: why,
  });
  if (!SETTINGS.dev) return;
  coachLog.unshift(verdictHtml(cls, cls === "good" ? "GOOD" : cls === "ok" ? "OK" : "BAD",
    `<b>${name(tile)}</b> — ${verdict}`, why));
  if (coachLog.length > 24) coachLog.length = 24;
}

/* ── the helper on CLAIMS ──────────────────────────────────────────────
 * Pung and chow are where a HK hand is won or thrown away, and until now the
 * helper had nothing to say about them (owner 2026-08-30). It runs the same
 * `assessClaim` the bot runs, so the advice and the grade are the bot's actual
 * reasoning rather than a story told about it.                              */
const CLAIM_LABEL = (o: ClaimOption): string =>
  o.kind === "pung" ? "pung 碰" : o.kind === "kong" ? "kong 槓"
  : `chow 上 ${(o.with ?? []).map(name).join("+")}`;
/** Why a claim was refused, in words a player can act on. */
const REFUSAL: Record<string, string> = {
  faanFloor: "it leaves no path to the faan floor — an unpayable hand is a dead one",
  offRoute: "it is off the route your hand is playing",
  concealedRoute: "it kills the concealed hand you are building",
  tooSlow: "it buys too little speed for what it exposes",
};
const sameClaim = (a: ClaimOption, b: ClaimOption): boolean =>
  a.kind === b.kind && (a.with ?? []).join() === (b.with ?? []).join();
/** The claims on offer to you right now. A win is never a decision. */
const myClaims = (): ClaimOption[] =>
  (pending ?? []).flatMap((a) => (a.type === "claim" && a.option.kind !== "win" ? [a.option] : []));

/** Live advice, shown while the buttons are still in front of you. */
function claimAdvice(): string {
  const options = myClaims();
  if (options.length === 0) return "";
  const v = viewFor(state, HUMAN);
  const cfg = coachCfg(v);
  const ctx = claimContext(v, cfg);
  const want = claimDecision(v, options, coachCfg(v));
  const rows = options.map((o) => {
    const a = assessClaim(v, o, cfg, ctx);
    const take = want !== null && sameClaim(want, o);
    return verdictHtml(take ? "good" : "bad", take ? "TAKE" : "SKIP", `<b>${CLAIM_LABEL(o)}</b>`,
      a.reason === "accepted"
        ? `${a.distanceBefore} → ${a.distanceAfter} from ready, worth up to ${a.faanCeiling} faan`
        : REFUSAL[a.reason] ?? a.reason);
  });
  if (want === null) rows.push(verdictHtml("good", "TAKE", "<b>pass</b>", "the champion claims nothing here"));
  return rows.join("");
}

/** The grade, kept after you have chosen. */
function gradeMyClaim(action: Action): void {
  const v = viewFor(state, HUMAN);
  const cfg = coachCfg(v);
  if (action.type === "concealedKong" || action.type === "addedKong") {
    const form = action.type === "concealedKong" ? "concealed" : "added";
    const yes = shouldKong(v, action.tile, form, coachCfg(v));
    recordMove({
      matchId: rc?.id ?? "", hand: state.handIndex, turn: humanTurns++, kind: "kong",
      played: `kong ${name(action.tile)}`, enginePick: yes ? `kong ${name(action.tile)}` : "hold",
      gap: yes ? 0 : 1, top1MinusTop2: 0, reason: yes ? "" : "the champion holds it",
    });
    if (!SETTINGS.dev) return;
    coachLog.unshift(verdictHtml(yes ? "good" : "ok", yes ? "GOOD" : "OK",
      `<b>kong ${name(action.tile)}</b> — ${yes ? "the champion lays this too" : "the champion holds it"}`,
      yes ? "" : "a kong fixes four tiles into one set slot, and an added kong opens a 搶槓 window"));
    if (coachLog.length > 24) coachLog.length = 24;
    return;
  }
  const options = myClaims();
  if (options.length === 0) return;                 // nothing was on offer
  if (action.type === "declareWin" || (action.type === "claim" && action.option.kind === "win")) return;
  const ctx = claimContext(v, cfg);
  const want = claimDecision(v, options, coachCfg(v));
  const took = action.type === "claim" ? action.option : null;
  let cls = "ok", grade = "OK", head = "", why = "";
  if (took === null && want === null) {
    cls = "good"; grade = "GOOD"; head = "<b>pass</b> — the champion passes too";
    why = "nothing on offer was worth the exposure";
  } else if (took === null) {
    const w = assessClaim(v, want!, cfg, ctx);
    cls = "bad"; grade = "BAD"; head = `<b>passed ${CLAIM_LABEL(want!)}</b> — the champion takes it`;
    why = `it would have moved you ${w.distanceBefore} → ${w.distanceAfter} from ready, worth up to ${w.faanCeiling} faan`;
  } else if (want === null) {
    const t = assessClaim(v, took, cfg, ctx);
    cls = "bad"; grade = "BAD"; head = `<b>${CLAIM_LABEL(took)}</b> — the champion refuses this`;
    why = REFUSAL[t.reason] ?? "";
  } else if (sameClaim(took, want)) {
    const t = assessClaim(v, took, cfg, ctx);
    cls = "good"; grade = "GOOD"; head = `<b>${CLAIM_LABEL(took)}</b> — what the champion takes`;
    why = `${t.distanceBefore} → ${t.distanceAfter} from ready, worth up to ${t.faanCeiling} faan`;
  } else {
    head = `<b>${CLAIM_LABEL(took)}</b> — playable, but the champion prefers ${CLAIM_LABEL(want)}`;
  }
  // A claim's "gap" is coarser than a discard's — assessClaim scores options,
  // it does not rank every alternative on one scale — so it records as 0 when
  // you did what the champion does and 1 when you did not. Good enough to
  // measure agreement; do not read it as a magnitude.
  recordMove({
    matchId: rc?.id ?? "", hand: state.handIndex, turn: humanTurns++,
    kind: took === null ? "pass" : "claim",
    played: took === null ? "pass" : CLAIM_LABEL(took),
    enginePick: want === null ? "pass" : CLAIM_LABEL(want),
    gap: cls === "good" ? 0 : 1, top1MinusTop2: 0, reason: why,
  });
  if (!SETTINGS.dev) return;
  coachLog.unshift(verdictHtml(cls, grade, head, why));
  if (coachLog.length > 24) coachLog.length = 24;
}
function devPanel(): string {
  if (!SETTINGS.dev) return "";
  let upcoming = claimAdvice();
  if (pending?.some((a) => a.type === "discard")) {
    const v = viewFor(state, HUMAN);
    const ranked = [...rankDiscards(v, coachCfg(v))].sort((a, b) => b.score - a.score).slice(0, 4);
    upcoming += `<div class="sug">champion would cut ${ranked.map((d, i) =>
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
/**
 * DECLARING THE THROW. At a table you say what you throw, and the owner asked
 * for it (2026-08-31). This is the ANNOUNCEMENT lane, so it runs alongside the
 * toss and deliberately does NOT touch `lastTossAt`, `holdMs` or anything else
 * the motion queue reads — see ANIMATION-SEQUENCE.md §1.
 *
 * Its life fits inside the toss's flight: up at 14%, gone by 100%, all within
 * SAY_MS < the 676 ms the tile spends in the air. A label still on screen when
 * the next tile is thrown would stack eighty times a hand.
 *
 * Restarting a CSS animation on a reused element needs the class removed, a
 * reflow forced, and the class put back. Without the reflow the browser
 * coalesces both style changes and the animation never re-runs — so a fast
 * exchange would silently show only the first player's call.
 */
const SAY_MS = 640;
let sayTimer = 0;
function sayDiscard(tile: TileId, seat: SeatIndex): void {
  const el = $("say");
  el.innerHTML = `<div class="inner">${name(tile)}</div>`;
  el.className = "";
  void el.offsetWidth;                       // reflow — see above
  el.style.setProperty("--sayms", `${SAY_MS}ms`);
  el.className = `show s${seat}`;
  clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => { el.className = ""; }, SAY_MS);
}

let callTimer = 0;
/**
 * THE TABLE STOPS FOR A CALL. At a real table nobody moves while someone is
 * saying 碰 and laying the meld down — the next throw does not overlap the
 * call (owner 2026-08-30). `announce()` arms the hold, so it fires exactly
 * when a call was really made and shown, flower gate and all, and the loop
 * spends it before the next bot moves.
 *
 * It never delays YOU: `advance()` clears the hold the moment you have a legal
 * action, because MatchScene.ts rule 1 says an affordance is never taken away
 * by an animation.
 */
/**
 * THE GRAB. A claimed tile used to disappear from the pile and reappear in a
 * meld in the same frame — the owner called it jarring, and it was: nothing
 * connected the two, so it read as a glitch rather than as somebody taking a
 * tile.
 *
 * It is a MOTION (ANIMATION-SEQUENCE.md §1), so the claim hold is sized to
 * cover it and nothing else moves while the tile is in the air.
 *
 * Two positions have to be captured at different moments, which is the whole
 * awkwardness here:
 *   FROM — the tile's spot in the pile, read BEFORE `consume` pops it, because
 *          the identity-keyed cleanup deletes that node on the next render.
 *   TO   — where it lands in the meld, readable only AFTER that render.
 * So the grab is armed during `consume` and launched at the end of `render`.
 */
const GRAB_MS = 760;
interface Grab { tile: TileId; seat: SeatIndex; cx: number; cy: number; w: number; h: number; rot: number; }
let pendingGrab: Grab | null = null;
/** Marks the meld that is being flown into, so it stays hidden until it lands. */
let landingMeld: { seat: SeatIndex; index: number } | null = null;
/**
 * Set when a match finishes, so `advance` shows the full scoreboard instead of
 * the four-line overlay that used to stand in for it. The owner's complaint:
 * a finished game just stopped and the score was nowhere.
 */
let endedMatch: MatchRec | null = null;

/**
 * Measure CENTRE and LAYOUT SIZE, never the bounding rect's size.
 * A pile tile is rotated, and `getBoundingClientRect()` returns the rotated
 * AABB — 42px across for a tile that is actually 26px wide. Building the flier
 * from that makes it too wide and scales it against the wrong basis. The rect
 * is right for *where* the tile is; `offsetWidth/Height` for *how big*.
 */
function centreOf(el: HTMLElement): { cx: number; cy: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: el.offsetWidth, h: el.offsetHeight };
}

function armGrab(tile: TileId, seat: SeatIndex, rot: number): void {
  const last = $("pile").lastElementChild as HTMLElement | null;
  if (!last) return;
  pendingGrab = { tile, seat, rot, ...centreOf(last) };
}

/** Called at the end of render(), once the destination meld actually exists. */
function launchGrab(): void {
  const g = pendingGrab;
  if (!g) return;
  pendingGrab = null;
  const row = g.seat === HUMAN ? $("mymelds")
    : document.querySelector<HTMLElement>(`.seat.${["", "e", "n", "w"][g.seat]} .meldrow`);
  const target = row?.querySelector<HTMLElement>(".tile.claimed") ?? row;
  if (!target || g.w === 0) return;
  const t = centreOf(target);
  if (t.w === 0) return;                            // not laid out — skip rather than fly to 0,0
  const el = document.createElement("span");
  el.className = "tile";
  el.innerHTML = `<svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet">${face(g.tile)}</svg>`;
  el.setAttribute("style",
    `left:${(g.cx - g.w / 2).toFixed(1)}px;top:${(g.cy - g.h / 2).toFixed(1)}px;`
    + `width:${g.w}px;height:${g.h}px;`
    + `--dx:${(t.cx - g.cx).toFixed(1)}px;--dy:${(t.cy - g.cy).toFixed(1)}px;`
    + `--ds:${(t.w / g.w).toFixed(3)};--r0:${g.rot.toFixed(0)}deg;--grabms:${GRAB_MS}ms`);
  $("fly").appendChild(el);
  window.setTimeout(() => { el.remove(); landingMeld = null; }, GRAB_MS + 40);
}

const CLAIM_HOLD_MS = GRAB_MS + 260;  // the tile must land before anything else moves
const FLOWER_HOLD_MS = 500;  // a flower is a smaller moment
let holdMs = 0;
const takeHold = (): number => { const h = holdMs; holdMs = 0; return h; };
function announce(kind: string, who: string, extra = "", seat: SeatIndex = HUMAN): void {
  const [ch, en] = CALLS[kind] ?? [kind, ""];
  const el = $("call");
  // the kind rides on the element as a class, so the stylesheet can colour and
  // size each call on its own — see "the call, by kind" in index.html
  el.innerHTML = `<div class="inner"><div class="cw">${who}</div>`
    + `<div class="cc${ch.length > 1 ? " two" : ""}">${ch}</div>`
    + `<div class="ce">${en}${extra ? ` · ${extra}` : ""}</div></div>`;
  el.className = `show s${seat} k-${kind} `
    + (kind === "win" || kind === "selfDraw" ? "big" : "");
  clearTimeout(callTimer);
  // Long enough to actually read across the table (owner 2026-08-30). Must
  // match the callIn keyframes, which do the holding.
  callTimer = window.setTimeout(() => { el.className = ""; }, kind === "win" || kind === "selfDraw" ? 3200 : 2200);
  // A win ends the hand and raises the overlay, which stops play on its own.
  holdMs = kind === "win" || kind === "selfDraw" ? 0
    : kind === "flower" ? FLOWER_HOLD_MS : CLAIM_HOLD_MS;
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
  // the match scoreboard outranks the hand-end overlay: both are set in the
  // same batch when the last hand ends, and the match is the bigger news
  if (endedMatch) {
    const m = endedMatch;
    matchScreen(m, () => { endedMatch = null; rc = null; overlay = null; lobbyScreen(); });
    return;
  }
  if (overlay) { showOverlay(); return; }
  if (state.phase === "matchEnd" || state.phase === "handEnd") return;
  const mine = legalActions(state, HUMAN);
  // Your turn is never held back — and if the call was yours, you have already
  // spent the beat making it, so the hold is dropped rather than banked.
  if (mine.length > 0) { holdMs = 0; pending = mine; startTurnClock(); render(); return; }
  const hold = takeHold();
  if (hold > 0) { busy = true; setTimeout(() => { busy = false; advance(); }, hold); return; }
  for (const seat of [1, 2, 3] as SeatIndex[]) {
    const options = legalActions(state, seat);
    if (options.length === 0) continue;
    busy = true;
    if (options.some((o) => o.type === "discard")) noteBotThinking(seat);
    setTimeout(() => {
      const a = decideAction(viewFor(state, seat), options, cfgs[seat]!);
      if (rc) rc.actions.push(a);
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
  if (rc) rc.actions.push(a);
  const r = applyAction(state, a);
  state = r.state; consume(r.events); advance();
}
function showOverlay(): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = overlay!;
  const next = document.getElementById("btnNext");
  if (next) next.onclick = () => {
    overlay = null; $("veil").style.display = "none";
    const r = startNextHand(state); state = r.state;
    // every per-hand cache, or the new hand inherits the old one's state
    pileTiles = []; handSig = ""; landingMeld = null; devBotLines = [];
    $("say").className = "";
    consume(r.events); advance(); buildWall();
  };
  const again = document.getElementById("btnAgain");
  if (again) again.onclick = () => { rc = null; overlay = null; lobbyScreen(); };
}

/* ── the wall ──────────────────────────────────────────────────────────
 * A ring of face-down tiles around the pile. It is decorative — the engine's
 * wall is a shuffled array — but it carries the two things a player reads off
 * a real wall: how much game is left, and where the live end is. Tiles are
 * removed from the live end as the count falls, so the wall visibly erodes.  */
let buildAnim = false;
/**
 * The wall is BUILT ONCE and then only erodes. Consumed tiles are hidden in
 * place, never removed, so nothing reflows — the owner's note: "the wall should
 * not move and you simply subtract tiles from that wall". Live tiles are drawn
 * from the front of side 0 onward; the last 14 are the dead wall, where kong
 * replacements and flowers come from, and they are marked.
 */
function renderWall(): void {
  const left = Math.max(0, state.wallEnd - state.wallIndex);
  /**
   * The wall is as long as the ruleset makes it: 144 with flowers, 136 without.
   * This was hardcoded to 144, so a TVB table — flowerless — ate four stacks
   * that were never there and the square came apart early.
   */
  const total = rules().useFlowers ? 144 : 136;
  const stacks = total / 2;                       // two tiles high
  const perSide = Math.ceil(stacks / 4);
  const liveStacks = Math.ceil(left / 2);
  /**
   * Erosion is spread ACROSS the four sides rather than run through them in
   * order. A real wall is eaten from one break point, and rendering that
   * literally is what produced the lopsided table the owner saw at the start of
   * a TVB hand: after the deal one whole side and half of another are simply
   * gone, which reads as broken rather than as authentic.
   *
   * The wall's job here is the one thing a player actually reads off it — how
   * much game is left — and a square that thins evenly says that more clearly
   * than a square with a bite out of it. Legibility over literalism, and the
   * only information lost is where the break happened, which this client never
   * modelled anyway.
   */
  /**
   * Scale the wall so `perSide` stacks actually FIT the table, in both axes.
   * A fixed tile size needed ~289px of width for a side; a phone's table centre
   * is about 227px, so the bottom row ran off the edge and the side columns sat
   * on top of the seat nameplates. The wall is decorative — its one job is
   * showing how much game is left — so shrinking it costs nothing and being
   * clipped cost everything.
   */
  const wallEl = $("wall");
  const bw = wallEl.clientWidth || 480, bh = wallEl.clientHeight || 300;
  const fitW = (bw / perSide - 2) / 17;      // 17px wide per stack, 2px gap
  const fitH = (bh / perSide - 2) / 15;      // 15px tall in the side columns
  const ws = Math.max(0.4, Math.min(1, fitW, fitH));   // never bigger than desktop, never microscopic
  wallEl.style.setProperty("--ws", ws.toFixed(3));
  const jr = prng((seed ^ 0xbeef) >>> 0);
  wallEl.className = buildAnim ? "building" : "";
  wallEl.innerHTML = ["top", "right", "bottom", "left"].map((side, si) => {
    const share = Math.floor(liveStacks / 4) + (si < liveStacks % 4 ? 1 : 0);
    return `<div class="side ${side}">${Array.from({ length: perSide }, (_, i) => {
      const gone = i >= share;
      // the dead wall 尾 — where kong and flower replacements come from
      const dead = !gone && si === 3 && i >= share - 4;
      const d = buildAnim
        ? ` style="--ax:${(jr() * 150 - 75).toFixed(0)}px;--ay:${(jr() * -130 - 30).toFixed(0)}px;--ar:${(jr() * 70 - 35).toFixed(0)}deg;animation-delay:${(si * 70 + i * 12)}ms"`
        : "";
      return `<span class="wt${gone ? " gone" : ""}${dead ? " dead" : ""}"${d}></span>`;
    }).join("")}</div>`;
  }).join("");
}
/** Shuffle-and-build: run once when a hand starts. */
function buildWall(): void {
  buildAnim = true;
  renderWall();
  setTimeout(() => { buildAnim = false; renderWall(); }, 1450);
}

/* ── render ────────────────────────────────────────────────────────────── */
/** One nameplate: who, which wind, dealer or not, and how they stand. */
function plate(seat: SeatIndex, who: string, initial: string): string {
  const s = state.seats[seat]!;
  const sign = s.chips > 0 ? "up" : s.chips < 0 ? "down" : "";
  return `<div class="nameplate ${state.turn === seat && !overlay ? "turn" : ""}">
      <span class="avatar">${initial}</span><span>${who}</span>
      <span class="wind">${WIND_CH[s.wind]}</span>
      ${state.dealer === seat ? '<span class="dealer">莊</span>' : ""}
      <span class="chips ${sign}">${s.chips > 0 ? "+" : ""}${s.chips}</span></div>`;
}
/**
 * YOUR plate. Until now the three bots had one and you had none — your seat
 * wind, whether you were dealer, and your own chip count were not on screen at
 * any point during a hand (owner 2026-08-30). No back row and no meld row: your
 * tiles are face up in your own hand below.
 */
const myPlate = (): string => plate(HUMAN, "You", "Y");

function seatBox(seat: SeatIndex): string {
  const s = state.seats[seat]!;
  const nm = BOT_NAMES[table.seats[seat - 1]!] ?? "Bot";
  const hidden = s.hand.length + (s.drawn !== null ? 1 : 0);
  return plate(seat, nm, nm[0]!) + `
    <div class="backrow">${Array.from({ length: Math.min(hidden, 14) }, (_, i) =>
      `<span class="back ${i === hidden - 1 && s.drawn !== null ? "wtnew" : ""}"
         style="--drawdelay:${queueBehindToss()}ms"></span>`).join("")}</div>
    <div class="meldrow">${s.melds.map((m, i) => m.tiles.map((t) => tileHtml(t,
        `sm ${landingMeld && landingMeld.seat === seat && landingMeld.index === i ? "claimed" : ""}`)).join(""))
        .join('<span style="width:6px"></span>')}
      ${s.flowers.map((t) => tileHtml(t, "fl")).join("")}</div>`;
}

function render(): void {
  const me = state.seats[HUMAN]!;
  // Everything the player needs is inside the felt: the match state at the far
  // corner, their own plate at the near edge. Nothing lives in a window strip
  // a phone would have to drop (owner 2026-08-30).
  const left = Math.max(0, state.wallEnd - state.wallIndex);
  const stateEl = $("state");
  // the wall going short is the clock every HK player actually watches
  stateEl.className = left <= 16 ? "low" : "";
  stateEl.innerHTML =
    `<div class="r1"><span class="wind">${WIND_CH[state.roundWind]}</span>`
    + `<span>hand <b>${state.handIndex + 1}</b></span></div>`
    + `<div class="r2">wall <b>${left}</b> left</div>`;
  $("seatE").innerHTML = seatBox(1);
  $("seatN").innerHTML = seatBox(2);
  $("seatW").innerHTML = seatBox(3);
  $("seatS").innerHTML = myPlate();
  renderWall();

  // THE PILE. A tile lands where it lands and NEVER moves again — the owner's
  // rule and the real table's: you throw in front of yourself and tiles pile up
  // around what is already there.
  //
  // Each discard creeps outward from ITS THROWER'S side of the heap and takes
  // the first spot that touches nothing, so a seat's tiles gather nearest that
  // seat while the four lobes still merge into one mass. The overlap test is
  // exact (separating axis on the true rotated rectangle) and is fed the tile's
  // MEASURED size, read off the DOM rather than assumed: the CSS draws pile
  // tiles at 36px and the settings slider scales that, while this code used to
  // hardcode 30px — a fifth too small, which is exactly how tiles came to
  // overlap (owner, 2026-08-30).
  const pileEl = $("pile");
  const boxW = pileEl.clientWidth || 420, boxH = pileEl.clientHeight || 240;
  /**
   * Size the pile tile to the box before anything is measured off it. The
   * divisor is calibrated so a 600px-wide centre gives 42px — the biggest that
   * still holds a full 流局 hand there — and a cramped window scales down
   * rather than stacking tiles on top of each other at the centre, which is
   * what the fallback in the packer would otherwise do. The 21px floor is set
   * by the narrowest box the layout produces; below that the table itself is
   * already unusable (SPEC.md, portrait is a known gap).
   */
  pileEl.style.setProperty("--pileth",
    `${Math.round(Math.min(46, Math.max(21, boxW / 14.3)))}px`);
  const probe = pileEl.querySelector<HTMLElement>(".tile");
  const th = probe?.offsetHeight || 36 * SETTINGS.tileScale;   // offset*, not the
  const tw = probe?.offsetWidth || th * 0.714;                 // rotated bounding box
  const jr = prng((seed ^ 0x51ed) >>> 0);
  pileTiles.forEach((d) => {
    if (d.pos) return;                              // already placed — leave it
    const placed = pileTiles.filter((o) => o.pos).map((o) => o.pos!);
    // Anchor: the spot on the heap in front of whoever threw. Seats run
    // you / east / north / west, clockwise from the near edge of the table.
    const ax = boxW / 2 + [0, tw * 1.7, 0, -tw * 1.7][d.seat]!;
    const ay = boxH / 2 + [th * 0.75, 0, -th * 0.75, 0][d.seat]!;
    // Tiles may kiss. They must never overlap (owner, 2026-08-30) — so the
    // clearance is a hair, not a margin, and the search is fine enough to use
    // it: rings a pixel apart, forty angles each, four candidate rotations per
    // angle, because a tile that will not fit at one tilt often fits at another.
    const CLEAR = 0.3;
    /**
     * The heap grows as an ellipse shaped like the TABLE, not as a circle.
     * The pile box is far wider than it is tall (600×360), so a round heap runs
     * out of height with the width barely touched — and a 流局 hand throws
     * eighty-odd tiles. Matching the box's aspect reaches both walls at once,
     * which is the most tiles that fit without anything overlapping.
     */
    const squash = Math.min(0.9, Math.max(0.5, boxH / boxW));
    const fits = (c: Placed): boolean => !placed.some((o) => hits(c, o, tw + CLEAR, th + CLEAR));
    let best: Placed | null = null;
    const step = Math.max(0.8, th * 0.028);
    for (let r = 0; r < 320 && !best; r += step) {
      const off = jr() * Math.PI * 2;                 // rotate each ring's spokes
      for (let k = 0; k < 40 && !best; k++) {
        const a = off + (k / 40) * Math.PI * 2;
        for (let t = 0; t < 4 && !best; t++) {
          // orientation is genuinely varied — most askew, some lying sideways
          const rot = jr() < 0.24 ? (jr() < 0.5 ? 90 : -90) + (jr() - 0.5) * 22 : (jr() - 0.5) * 74;
          const c: Placed = { x: ax + Math.cos(a) * r, y: ay + Math.sin(a) * r * squash, rot, spin: 0 };
          if (fits(c)) best = c;
        }
      }
    }
    // Gravity, then settle. Radial gravity walks the tile straight back toward
    // its anchor until a neighbour stops it — but if that one neighbour blocks
    // the line, the tile parks with room on both sides of it. So follow with a
    // jiggle: propose small shifts and tilts, keep any that is legal AND nearer
    // the anchor. Gravity makes the heap; the jiggle closes its gaps (owner:
    // "as tight as possible without overlapping").
    const drop = (c: Placed): Placed => {
      const dx = ax - c.x, dy = ay - c.y, dist = Math.hypot(dx, dy);
      if (dist < 0.01) return c;
      const ux = dx / dist * 0.5, uy = dy / dist * 0.5;
      for (let moved = 0; moved < dist; moved += 0.5) {
        const n: Placed = { ...c, x: c.x + ux, y: c.y + uy };
        if (!fits(n)) break;
        c = n;
      }
      return c;
    };
    if (best) {
      const far = (c: Placed): number => (c.x - ax) ** 2 + (c.y - ay) ** 2;
      best = drop(best);
      // Sidestep, THEN fall, and keep the result only if it ended up nearer.
      // Requiring the sidestep itself to be nearer is what a dropped tile can
      // never do — it is already as deep as that line goes — so the tile has to
      // be allowed to move sideways past its blocker first and fall around it.
      for (let i = 0; i < 220; i++) {
        // ±22° keeps a sideways tile sideways, so the photo's mix of
        // orientations survives the squeeze
        const c: Placed = {
          x: best.x + (jr() - 0.5) * 14, y: best.y + (jr() - 0.5) * 14,
          rot: best.rot + (jr() - 0.5) * 22, spin: 0,
        };
        if (!fits(c)) continue;
        const settled = drop(c);
        if (far(settled) < far(best)) best = settled;
      }
    }
    d.pos = best ?? { x: boxW / 2, y: boxH / 2, rot: 0, spin: 0 };
    d.pos.spin = jr() * 220 - 110;
  });
  // NODES ARE KEYED TO TILE IDENTITY, never to a count. render() runs two or
  // three times per turn — on entry, again once the turn is yours, again on any
  // settings change — and a claim lifts a tile back off the pile. Rebuilding
  // the pile's innerHTML, or re-appending after it shrank, restarted the toss
  // keyframes on tiles that were already lying on the table: the owner's
  // "double toss animation bug", 4 tiles playing 16 animations. Each discard
  // carries an id, its node carries the same id, and a node is created exactly
  // once in its life — so only a genuinely new discard ever animates.
  const live = new Set(pileTiles.map((d) => d.id));
  const pid = (el: Element): number => Number((el as HTMLElement).dataset.pid);
  for (const el of Array.from(pileEl.children)) if (!live.has(pid(el))) el.remove();
  const have = new Set(Array.from(pileEl.children).map(pid));
  for (const d of pileTiles) {
    if (have.has(d.id)) continue;
    const from = [[0, 190], [230, 0], [0, -190], [-230, 0]][d.seat] ?? [0, 190];
    // Where it first hits the felt: 30% of the way back from the thrower, so
    // the skid covers the last stretch — about two tile widths, which is what
    // a thrown tile actually slides.
    const lx = from[0]! * 0.3, ly = from[1]! * 0.3;
    // and it lands crooked, straightening as it skids
    const lr = d.pos!.rot + (d.pos!.spin - d.pos!.rot) * 0.22;
    lastTossAt = performance.now();
    // the gold ring marks the tile in play; it leaves with the tile when
    // somebody claims it, rather than drifting back onto an older discard
    for (const el of Array.from(pileEl.children)) el.classList.remove("hot");
    pileEl.insertAdjacentHTML("beforeend", tileHtml(d.tile, "pt fresh hot",
      `data-pid="${d.id}" style="left:${d.pos!.x.toFixed(1)}px;top:${d.pos!.y.toFixed(1)}px;`
      + `--fx:${from[0]}px;--fy:${from[1]}px;--fr:${d.pos!.spin.toFixed(0)}deg;`
      + `--lx:${lx.toFixed(0)}px;--ly:${ly.toFixed(0)}px;--lr:${lr.toFixed(1)}deg;`
      + `--rot:${d.pos!.rot.toFixed(1)}deg;--tossms:${TOSS_MS}ms;`
      + `transform:translate(-50%,-50%) rotate(${d.pos!.rot.toFixed(1)}deg)"`));
  }

  const mine = (i: number): string =>
    landingMeld && landingMeld.seat === HUMAN && landingMeld.index === i ? "claimed" : "";
  $("mymelds").innerHTML = me.melds.map((m, i) => m.tiles.map((t) => tileHtml(t, mine(i))).join(""))
    .join('<span style="width:10px"></span>')
    + me.flowers.map((t) => tileHtml(t, "fl")).join("");

  const canDiscard = !!pending?.some((a) => a.type === "discard");
  const hand = [...me.hand].sort((a, b) => a - b);
  $("myhand").className = canDiscard ? "" : "locked";
  // Rebuild ONLY when the hand actually changed. render() runs two or three
  // times a turn, and re-writing innerHTML re-created the drawn tile each time
  // and restarted its flight — the same defect the pile had before its nodes
  // were keyed to an id. The click handlers read `pending` at click time, so
  // they never go stale between rebuilds.
  const sig = `${hand.join(",")}|${me.drawn ?? "-"}|${canDiscard}`;
  if (sig !== handSig) {
    handSig = sig;
    const delay = queueBehindToss();
    $("myhand").innerHTML = hand.map((t) => tileHtml(t, "", `data-t="${t}"`)).join("")
      + (me.drawn !== null
          ? tileHtml(me.drawn, "drawn",
              `data-t="${me.drawn}" style="--drawms:${DRAW_MS}ms;--drawdelay:${delay}ms;`
              + `--wx:${(120 - hand.length * 9).toFixed(0)}px;--wy:-190px"`)
          : "");
  }
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
    el.onclick = () => {
      const a = pending?.[Number(el.dataset.i)];
      if (a) { gradeMyClaim(a); act(a); }
    };
  }
  $("log").innerHTML = feed.map((l) => `<div>${l}</div>`).join("");
  $("callwrap").innerHTML = callingBar();
  $("devwrap").innerHTML = devPanel();
  recenterGlyphs(document);
  launchGrab();      // the destination meld is laid out only now
}

function settingsScreen(back: () => void): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = `
    <h1>Settings</h1>
    <h2 style="margin-top:14px">Table</h2>
    <div class="setrow"><label>Tile size</label>
      <input type="range" id="setScale" min="0.8" max="2" step="0.05" value="${SETTINGS.tileScale}">
      <span id="setScaleV">${Math.round(SETTINGS.tileScale * 100)}%</span></div>
    <div class="setrow"><label>Bot speed</label>
      <input type="range" id="setSpeed" min="0" max="1200" step="60" value="${SETTINGS.botMs}">
      <span id="setSpeedV">${SETTINGS.botMs === 0 ? "instant" : SETTINGS.botMs + "ms"}</span></div>
    <h2 style="margin-top:14px">Handicaps</h2>
    <p class="mut">Training wheels. Each only tells you what a careful player could
      work out from the table — nothing hidden is revealed.</p>
    <div class="setrow"><label>Count tiles</label>
      <input type="checkbox" id="hcCount" ${SETTINGS.hcCount ? "checked" : ""}>
      <span class="mut">hover any tile to light up every copy of it on the table</span></div>
    <div class="setrow"><label>Calling read</label>
      <input type="checkbox" id="hcCalling" ${SETTINGS.hcCalling ? "checked" : ""}>
      <span class="mut">whether you are 聽牌, what you wait on, how many are live, and
        whether the hand can pay</span></div>
    <div class="setrow"><label>What-if</label>
      <input type="checkbox" id="hcWhatIf" ${SETTINGS.hcWhatIf ? "checked" : ""}>
      <span class="mut">hover a tile in your hand to see what cutting it would leave you
        waiting on (needs the calling read)</span></div>
    <div class="setrow"><label>Dev mode</label>
      <input type="checkbox" id="setDev" ${SETTINGS.dev ? "checked" : ""}>
      <span class="mut">show what each bot is planning, and how the champion would rank your discards</span></div>
    <button id="btnBack">done ▸</button>`;
  const sc = document.getElementById("setScale") as HTMLInputElement;
  sc.oninput = () => { SETTINGS.tileScale = Number(sc.value); $("setScaleV").textContent = Math.round(SETTINGS.tileScale * 100) + "%"; saveSettings(); render(); };
  const sp = document.getElementById("setSpeed") as HTMLInputElement;
  sp.oninput = () => { SETTINGS.botMs = Number(sp.value); $("setSpeedV").textContent = SETTINGS.botMs === 0 ? "instant" : SETTINGS.botMs + "ms"; saveSettings(); };
  const dv = document.getElementById("setDev") as HTMLInputElement;
  dv.onchange = () => { SETTINGS.dev = dv.checked; saveSettings(); render(); };
  for (const [id, key] of [["hcCount", "hcCount"], ["hcCalling", "hcCalling"], ["hcWhatIf", "hcWhatIf"]] as const) {
    const box = document.getElementById(id) as HTMLInputElement | null;
    if (box) box.onchange = () => { (SETTINGS as never as Record<string, boolean>)[key] = box.checked; saveSettings(); if (state) render(); };
  }
  ($("btnBack") as HTMLButtonElement).onclick = () => { $("veil").style.display = "none"; back(); };
}
/**
 * Feedback, with the game state attached.
 *
 * The whole point of the beta is finding bugs and bad feel, and a report that
 * says "something looked wrong" is worth very little on its own. So every
 * report carries the match id, the hand, and the last few log lines — enough
 * to go and replay exactly what they were looking at.
 */
function feedbackScreen(back: () => void): void {
  $("veil").style.display = "flex";
  const live = rc !== null;
  const where = live ? `hand ${state.handIndex + 1} of your ${SETTINGS.rounds}-wind game vs ${table.label}`
    : lastMatch ? `your last game — hand ${lastMatch.hand + 1} of the ${lastMatch.label}`
    : "not in a game";
  $("panel").innerHTML = `
    <h1>Tell us what you saw</h1>
    <p class="mut">Bugs, rules that looked wrong, animations that felt off, anything.
    We attach where you were — <b>${where}</b> — so we can replay it.</p>
    <textarea id="fbText" placeholder="What happened? What did you expect instead?"></textarea>
    <div class="setrow" style="margin-top:10px">
      <button id="btnFbSend">send ▸</button>
      <button id="btnFbBack" style="background:rgba(255,255,255,.08)">cancel</button>
    </div>`;
  const ta = document.getElementById("fbText") as HTMLTextAreaElement;
  ta.focus();
  ($("btnFbSend") as HTMLButtonElement).onclick = () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    void store.putFeedback({
      id: crypto.randomUUID(),
      matchId: rc?.id ?? lastMatch?.id ?? null,
      hand: rc ? state.handIndex : lastMatch?.hand ?? null,
      text,
      createdAt: Date.now(),
      context: {
        player: player?.name, rounds: SETTINGS.rounds, ruleset: SETTINGS.rulesetId,
        table: table.id, seats: [...table.seats], seed,
        live,
        wall: live && state ? state.wallEnd - state.wallIndex : null,
        chips: state ? [0, 1, 2, 3].map((i) => state.seats[i as SeatIndex]!.chips) : null,
        recentLog: feed.slice(-8),
        ua: navigator.userAgent, viewport: [innerWidth, innerHeight],
      },
    });
    void sync.drain(store);
    $("panel").innerHTML = `<h1>Thank you</h1>
      <p>Filed against ${where} and sent to us with the game it came from \u2014 the
      seed, the hand, the last few plays \u2014 so we can replay exactly what you saw.</p>
      <button id="btnFbBack2">back to the game ▸</button>`;
    ($("btnFbBack2") as HTMLButtonElement).onclick = () => { $("veil").style.display = "none"; back(); };
  };
  ($("btnFbBack") as HTMLButtonElement).onclick = () => { $("veil").style.display = "none"; back(); };
}
($("btnFeedback") as HTMLButtonElement).onclick = () =>
  feedbackScreen(() => { if (!state) startScreen(); else render(); });
($("btnSettings") as HTMLButtonElement).onclick = () => settingsScreen(() => { if (!state) startScreen(); else render(); });
($("btnQuit") as HTMLButtonElement).onclick = () => {
  // A forfeit is a result. Recording it keeps the stats honest — a player who
  // abandons every losing match would otherwise look like a strong player.
  if (rc && rc.finishedAt === null) {
    rc.abandoned = true; rc.finishedAt = Date.now(); flushRecord();
    void sync.drain(store);       // a forfeit is data too
  }
  rc = null;
  endedMatch = null;
  overlay = null;
  lobbyScreen();
};
saveSettings();
wireHover();
// Boot: fetch the player, then either greet them or ask who they are. The game
// never blocks on the store beyond this one read.
void store.getPlayer().then((p) => {
  player = p;
  if (p) lobbyScreen(); else nameScreen(() => aboutScreen(lobbyScreen));
});

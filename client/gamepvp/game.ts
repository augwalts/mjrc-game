/**
 * MJRC gamepvp — a thin view over a server-authoritative WebSocket table.
 *
 * Doctrine: the client has ZERO game authority. `snap` (a `SeatSnapshot`) is
 * the server's redacted fold of the match for THIS seat; every legal action
 * comes from the server's `prompt` (`LegalRequests`), never computed here.
 * Every button press is a `request*` message; nothing renders as done until
 * the server's `accepted` + `events` say so.
 *
 * This file is a retrofit of Solo's `client/game/game.ts` — same DOM
 * structure, CSS, tile art (`tile-engine.js`) and animations, a new core.
 * See README.md for what changed and why.
 *
 * Build: ./gamepvp/build.sh (esbuild game.ts --bundle --platform=browser
 *        --format=iife --outfile=gamepvp/assets/game.js)
 */
import {
  DEFAULT_PROFILE, assessClaim, claimContext, claimDecision, faanCeiling, rankDiscards, scoreAdjust,
  shapeOf, shouldKong, visibleCounts,
  type BotConfig, type BotProfile, type SeatView,
} from "../../engine/src/bots.js";
import { MJRC_STANDARD, ruleset as rulesetById } from "../../rulesets/src/presets.js";
import type { Ruleset } from "../../engine/src/types.js";
import { prng } from "../../engine/src/wall.js";
import { TILE_NAMES, counts } from "../../engine/src/tiles.js";
import { liveTiles } from "../../engine/src/ready.js";
import type { Action, ClaimOption, Meld, SeatIndex, TileId } from "../../engine/src/types.js";
import { isOwnSeatView, type SeatVisibleMeld } from "../../protocol/src/events.js";
import type {
  AnySeatView, FourSeats, OwnSeatView, RedactedGameEvent, SeatSnapshot, SeatVisible,
} from "../../protocol/src/events.js";
import { actionsOf, seatViewOf } from "../../protocol/src/seatview.js";
import type {
  LegalRequests, PromptPayload, PresencePayload, ProtocolFaultPayload,
  RejectCode, RejectedPayload, SeatDirectoryEntry, WelcomePayload,
} from "../../protocol/src/messages.js";
import {
  ApiError, RequestRejected, TableSocket,
  createTable, getLeaderboard, getLobby, getMyStats, getPlayerStats, identify, joinTable,
  leaveTable as apiLeaveTable, listBots, listMatches,
  matchDetail, postPresence, startTable as apiStartTable, storedIdentity,
  type BotCatalogueEntry, type CasualLeaderboardEntry, type CreateTableResult, type Identity,
  type LeaderboardMode, type LobbyHereEntry, type LobbyPayload,
  type LobbyTable, type LobbyTableSeat, type MatchFormat, type MatchListItem,
  type PlayerStats, type PlayerStatsRecentMatch, type PlayerStatsTotals,
  type RankedLeaderboardEntry, type SeatSpec, type TableAccess, type TableMode,
} from "./net.js";

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
/** How a tile is NAMED in prose — the discard feed, the calls, the coach's
 *  notes. See Solo's game.ts for the full rationale; unchanged here. */
const HONOUR_NAMES = ["East", "South", "West", "North", "Red", "Green", "White",
  "Plum", "Orchid", "Chrysanth", "Bamboo", "Spring", "Summer", "Autumn", "Winter"];
const name = (t: TileId): string =>
  t < 9 ? `${t + 1}萬` : t < 18 ? `${t - 8}▮` : t < 27 ? `${t - 17}●`
  : HONOUR_NAMES[t - 27] ?? "?";
const tileHtml = (t: TileId, cls = "", attrs = ""): string =>
  `<span class="tile ${cls}" data-t="${t}" ${attrs}><svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet">${face(t)}</svg></span>`;
/** A meld as another seat may show it: a concealed kong they hold is hidden
 *  from us (`tiles: null`) and renders as four backs, never a guess. */
const meldHtml = (m: Meld | SeatVisibleMeld, cls = ""): string =>
  m.tiles === null ? `<span class="back"></span>`.repeat(4) : m.tiles.map((t) => tileHtml(t, cls)).join("");

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

const RULE_PICKS: [string, string, string][] = [
  ["mjrc-standard", "MJRC standard", "3–10 faan · flowers · doubling payments. The house game."],
  ["tvb-2026", "TVB Championship 2026", "1 faan minimum · no flowers · linear payments. Every hand is payable, and big hands barely out-earn small ones."],
];

/* ── bot picker (New table screen) ────────────────────────────────────────
 * The catalogue is server data (GET /api/bots — gamepvp/src/bots.ts
 * BOT_CATALOGUE) fetched once and cached; DEFAULT_BOT_LINEUP mirrors that
 * file's BOT_LINEUP purely so the picker can pre-select the same default the
 * server falls back to when a table is created with no `bots` picks. Bot
 * seats fill from the top (worker/src/index.ts tableInitOf), so for N bot
 * seats the defaults are the LAST N entries here, in seat order. */
const DEFAULT_BOT_LINEUP = ["v1", "v4", "persona", "v2"];

let botCatalogue: BotCatalogueEntry[] | null = null;
let botCatalogueP: Promise<BotCatalogueEntry[]> | null = null;
function loadBotCatalogue(): Promise<BotCatalogueEntry[]> {
  if (botCatalogue) return Promise.resolve(botCatalogue);
  botCatalogueP ??= listBots().catch(() => []).then((list) => { botCatalogue = list; return list; });
  return botCatalogueP;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const fmtChips = (n: number): string => `${n > 0 ? "+" : ""}${n}`;
/** The lobby lists free-text display names — escape them before they land in
 *  `innerHTML` (the rest of this file trusts server-shaped prose, but a name
 *  is player-authored). */
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ── identity + session ───────────────────────────────────────────────── */
let identity: Identity | null = null;
const SESSION_KEY = "mjrc.gamepvp.activeMatch";
/** Set only by `doCreateTable()`, right before `connectToMatch`, and cleared
 *  whenever a match/table is left. Nothing on the wire says "you made this
 *  table" — `/start` is creator-only server-side regardless, this only gates
 *  whether the waiting room OFFERS the button. Persisted alongside the
 *  session key so a reload of the creator's own tab keeps the button. */
let isCreatorOfCurrentTable = false;

/* ── presence heartbeat (PVP-LOBBY-PROPOSAL §3.2/§7.2) ───────────────────
 * "lobby" is the only state this client ever sends — it means "this device
 * is open", not "the lobby screen is on screen"; GET /api/lobby derives the
 * richer waiting/playing state server-side from match participation. Starts
 * once identity exists and never stops (the app, not any one screen). */
let presenceHeartbeatStarted = false;
function ensurePresenceHeartbeat(): void {
  if (presenceHeartbeatStarted) return;
  presenceHeartbeatStarted = true;
  const beat = (): void => {
    if (identity && document.visibilityState === "visible") {
      void postPresence(identity.deviceToken, "lobby").catch(() => { /* best effort */ });
    }
  };
  window.setInterval(beat, 30_000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") beat(); });
}

/* ── the live table ────────────────────────────────────────────────────
 * `snap` is this seat's redacted fold, replaced whole every time the server
 * sends one (never mutated field-by-field). `mySeat` is 0-3, whichever this
 * player was seated at — everything that used to assume "HUMAN is seat 0"
 * now reads `mySeat` and converts to a SCREEN position with `rel()`.       */
let ts: TableSocket | null = null;
let snap: SeatVisible<SeatSnapshot> | null = null;
let directory: FourSeats<SeatDirectoryEntry> | null = null;
const presence: Partial<Record<SeatIndex, { connected: boolean; botActing: boolean }>> = {};
let mySeat: SeatIndex = 0;
let lastSeq = -1;
let currentMatchUuid: string | null = null;
let currentJoinCode: string | null = null;
let currentRulesetId = "mjrc-standard";
let currentMatchFormat: MatchFormat = "east";

let curLegal: LegalRequests | null = null;
let pending: Action[] | null = null;
const feed: string[] = [];
interface Placed { x: number; y: number; rot: number; spin: number; }
let pileTiles: { id: number; tile: TileId; seat: SeatIndex; pos?: Placed }[] = [];
let pileSeq = 0;
let handSig = "";
let overlay: string | null = null;
interface MatchEndInfo { standings: number[]; placements: number[]; reason: string; handsPlayed: number; }
let matchEndInfo: MatchEndInfo | null = null;
/** The server's move-grading record for this match, per seat — desktop only
 *  (see DESKTOP above). `undefined` until `fetchMatchAgreement` lands; a
 *  landed seat's own `agreement` is null when nothing about it was graded. */
interface SeatAgreement { movesGraded: number; movesMatched: number; agreement: number | null }
let matchAgreement: FourSeats<SeatAgreement> | undefined = undefined;

/** Screen position for seat `s`: 0 = you (bottom), 1 = right, 2 = across
 *  (top), 3 = left — turn order runs to the right (SPEC.md §4), whichever
 *  actual seat you were dealt. This is the ONE conversion every piece of
 *  screen-position art (pile anchors, toss origin, #call/#say `.s0`-`.s3`)
 *  goes through; snapshot/directory lookups always use the real seat. */
const rel = (s: SeatIndex): 0 | 1 | 2 | 3 => (((s - mySeat + 4) % 4) as 0 | 1 | 2 | 3);
const actualSeat = (r: 0 | 1 | 2 | 3): SeatIndex => (((mySeat + r) % 4) as SeatIndex);
const seatName = (s: SeatIndex): string =>
  s === mySeat ? (identity?.displayName ?? "You") : (directory?.[s]?.displayName ?? `seat ${s}`);

/** Purely decorative jitter — the wall's assemble stagger and the pile's
 *  organic-heap placement. Solo seeded these from the match's engine seed;
 *  that seed never reaches a seat socket (protocol/events.ts: "the seed IS
 *  the wall"), so this derives a stable-enough number from the match id and
 *  hand instead. Nothing about legality or replay depends on it. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const decorSeed = (): number => hashStr(`${currentMatchUuid ?? "x"}:${snap?.handIndex ?? 0}`);

/* ── settings ──────────────────────────────────────────────────────────── */
interface Settings {
  tileScale: number; dev: boolean;
  hcCount: boolean; hcCalling: boolean; hcWhatIf: boolean;
}
const SETTINGS: Settings = {
  tileScale: 1, dev: false, hcCount: false, hcCalling: false, hcWhatIf: false,
  ...JSON.parse(localStorage.getItem("mjrc.gamepvp.settings") ?? "{}"),
};
const saveSettings = (): void => {
  localStorage.setItem("mjrc.gamepvp.settings", JSON.stringify(SETTINGS));
  document.documentElement.style.setProperty("--tscale", String(SETTINGS.tileScale));
  document.body.classList.toggle("devmode", SETTINGS.dev);
};
const currentRuleset = (): Ruleset => rulesetById(currentRulesetId) ?? MJRC_STANDARD;

/* ── desktop gate ──────────────────────────────────────────────────────
 * Owner's ruling (2026-09-01): grading and coaching are a web-app feature,
 * not a phone one — "the phone is cluttered". ONE rule decides it, re-read on
 * every render rather than cached at boot (a laptop's window can cross the
 * breakpoint; a tablet can rotate). Everything gated on it — the discard
 * helper, what-if, the calling bar, the live coach tally, the server's
 * agreement line — reads `isDesktop()` fresh, never a value captured once. */
const DESKTOP = matchMedia("(min-width: 900px) and (pointer: fine)");
const isDesktop = (): boolean => DESKTOP.matches;
DESKTOP.addEventListener("change", () => { if (snap) render(); syncVeil(); });

/* ── handicaps ─────────────────────────────────────────────────────────
 * Unchanged from Solo except the source: `seatViewOf(snap)` builds the same
 * `SeatView` the engine's analysis functions expect, from the redacted wire
 * snapshot instead of an omniscient `MatchState`. These only ever look at
 * the player's own seat, so nothing here needed to change shape.          */
interface HandRead {
  distance: number; calling: boolean;
  waits: { tile: TileId; unseen: number }[];
  total: number; ceiling: number; payable: boolean;
}
function readHand(without?: TileId): HandRead | null {
  if (!snap) return null;
  const v = seatViewOf(snap);
  const R = currentRuleset();
  const tiles = [...v.hand, ...(v.drawn !== null ? [v.drawn] : [])];
  if (without !== undefined) {
    const k = tiles.indexOf(without);
    if (k < 0) return null;
    tiles.splice(k, 1);
  }
  const c = counts(tiles);
  const melds = v.melds[v.seat]!.length;
  const seven = R.faanTable.sevenPairs !== undefined;
  const lt = liveTiles(c, melds, visibleCounts(v), seven);
  const ceiling = Math.min(faanCeiling(shapeOf(v), R), R.limitFaan);
  return {
    distance: lt.distance, calling: lt.distance <= 0,
    waits: lt.tiles.map((x) => ({ tile: x.tile, unseen: x.unseen })),
    total: lt.total, ceiling, payable: ceiling >= R.minimumFaan,
  };
}
const WAIT_LIST_MAX = 6;
const waitList = (r: HandRead): string => {
  if (r.waits.length === 0) return "nothing live";
  if (r.waits.length > WAIT_LIST_MAX) return `<b>${r.waits.length}</b> different tiles help`;
  return r.waits.map((w) => `<b>${name(w.tile)}</b>&thinsp;<span class="n">${w.unseen}</span>`).join(" ");
};
function callingBar(): string {
  if (!isDesktop() || !SETTINGS.hcCalling || !snap || overlay) return "";
  const r = readHand();
  if (!r) return "";
  const faan = r.payable
    ? `<span class="ok">can reach ${r.ceiling} faan</span>`
    : `<span class="warn">only ${r.ceiling} faan — under the ${currentRuleset().minimumFaan} minimum,
       this hand cannot be taken yet</span>`;
  return `<div id="callbar" class="${r.calling ? "calling" : ""}">
    ${r.calling
      ? `<b class="lead">CALLING 聽牌</b> waiting on ${waitList(r)}
         <span class="tot">${r.total} live</span>`
      : `<b class="lead">${r.distance} away</b> from calling · helps: ${waitList(r)}
         <span class="tot">${r.total} live</span>`}
    <span class="faan">${faan}</span></div>`;
}
function whatIf(tile: TileId): string {
  const r = readHand(tile);
  if (!r) return "";
  return r.calling
    ? `<b class="lead">cut ${name(tile)} → CALLING</b> on ${waitList(r)}
       <span class="tot">${r.total} live</span>`
    : `<b class="lead">cut ${name(tile)} → ${r.distance} away</b> · helps: ${waitList(r)}
       <span class="tot">${r.total} live</span>`;
}
/** Hover for desktop, long-press for touch (task: "touch first" — nothing
 *  in the coach may be hover-only). Both funnel into the same show/clear. */
function wireHover(): void {
  const closestTile = (t: EventTarget | null): HTMLElement | null =>
    (t as HTMLElement | null)?.closest?.(".tile") as HTMLElement | null;
  const show = (el: HTMLElement): void => {
    if (!el.dataset.t) return;
    const t = Number(el.dataset.t) as TileId;
    if (SETTINGS.hcCount) {
      document.body.classList.add("counting");
      for (const o of Array.from(document.querySelectorAll<HTMLElement>(`.tile[data-t="${t}"]`))) {
        o.classList.add("samet");
      }
    }
    if (isDesktop() && SETTINGS.hcWhatIf && el.closest("#myhand") && !overlay) {
      const bar = document.getElementById("callbar");
      if (bar) { bar.dataset.saved ??= bar.innerHTML; bar.innerHTML = whatIf(t); bar.classList.add("whatif"); }
    }
  };
  const clear = (): void => {
    document.body.classList.remove("counting");
    for (const o of Array.from(document.querySelectorAll<HTMLElement>(".tile.samet"))) o.classList.remove("samet");
    const bar = document.getElementById("callbar");
    if (bar?.dataset.saved) { bar.innerHTML = bar.dataset.saved; delete bar.dataset.saved; bar.classList.remove("whatif"); }
  };
  document.addEventListener("mouseover", (e) => { const el = closestTile(e.target); if (el) show(el); });
  document.addEventListener("mouseout", (e) => { const el = closestTile(e.target); if (el) clear(); });
  let pressTimer = 0;
  let pressed: HTMLElement | null = null;
  document.addEventListener("touchstart", (e) => {
    const el = closestTile(e.target);
    pressed = el;
    if (!el) return;
    pressTimer = window.setTimeout(() => { if (pressed) show(pressed); }, 260);
  }, { passive: true });
  const releaseTouch = (): void => { window.clearTimeout(pressTimer); if (pressed) clear(); pressed = null; };
  document.addEventListener("touchend", releaseTouch);
  document.addEventListener("touchcancel", releaseTouch);
}

/* ── dev coach (discard helper + claim advice) ───────────────────────────
 * Analysis on the player's OWN `SeatView` only — never omniscient. Solo's
 * "what the bots are thinking" box read every other seat's hand via a local
 * `MatchState` and has no equivalent here: a seat socket is never told what
 * another seat holds, so that panel is DROPPED, not ported. See README.    */
const champProfile = (): BotProfile => ({ ...DEFAULT_PROFILE, ...(window.BOTS?.["v4"] ?? {}) });
const coachCfg = (v: SeatView): BotConfig =>
  ({ ruleset: currentRuleset(), profile: scoreAdjust(champProfile(), v), rnd: prng(7) });
const verdictHtml = (cls: string, grade: string, head: string, why = ""): string =>
  `<div class="ce ${cls}"><span class="g">${grade}</span>${head}${why ? `<div class="mut">${why}</div>` : ""}</div>`;
const coachLog: string[] = [];
/** Session-only tally — Solo persisted every graded move to IndexedDB and
 *  uploaded it; here the server IS the record (match history, not move
 *  history), so this is just what the scoreboard shows for "this match". */
const coachTally = { graded: 0, matched: 0 };

function gradeMyDiscard(tile: TileId): void {
  if (!snap) return;
  const v = seatViewOf(snap);
  const cfg = coachCfg(v);
  const ranked = [...rankDiscards(v, cfg)].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const mine = ranked.find((d) => d.tile === tile);
  if (!best || !mine) return;
  coachTally.graded++;
  const gap = best.score - mine.score;
  if (gap <= 0.0001) coachTally.matched++;
  if (!SETTINGS.dev) return;
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
  coachLog.unshift(verdictHtml(cls, cls === "good" ? "GOOD" : cls === "ok" ? "OK" : "BAD",
    `<b>${name(tile)}</b> — ${verdict}`, why));
  if (coachLog.length > 24) coachLog.length = 24;
}

const CLAIM_LABEL = (o: ClaimOption): string =>
  o.kind === "pung" ? "pung 碰" : o.kind === "kong" ? "kong 槓"
  : `chow 上 ${(o.with ?? []).map(name).join("+")}`;
const REFUSAL: Record<string, string> = {
  faanFloor: "it leaves no path to the faan floor — an unpayable hand is a dead one",
  offRoute: "it is off the route your hand is playing",
  concealedRoute: "it kills the concealed hand you are building",
  tooSlow: "it buys too little speed for what it exposes",
};
const sameClaim = (a: ClaimOption, b: ClaimOption): boolean =>
  a.kind === b.kind && (a.with ?? []).join() === (b.with ?? []).join();
/** The claims on offer — read off `pending`, which `actionsOf` already built
 *  from the server's `legal.claims`/`legal.robKong`. A win is never a
 *  decision to grade against. */
const myClaims = (): ClaimOption[] =>
  (pending ?? []).flatMap((a) => (a.type === "claim" && a.option.kind !== "win" ? [a.option] : []));

function claimAdvice(): string {
  const options = myClaims();
  if (options.length === 0 || !snap) return "";
  const v = seatViewOf(snap);
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

function gradeMyClaim(action: Action): void {
  if (!snap) return;
  const v = seatViewOf(snap);
  const cfg = coachCfg(v);
  if (action.type === "concealedKong" || action.type === "addedKong") {
    const form = action.type === "concealedKong" ? "concealed" : "added";
    const yes = shouldKong(v, action.tile, form, coachCfg(v));
    if (!SETTINGS.dev) return;
    coachLog.unshift(verdictHtml(yes ? "good" : "ok", yes ? "GOOD" : "OK",
      `<b>kong ${name(action.tile)}</b> — ${yes ? "the champion lays this too" : "the champion holds it"}`,
      yes ? "" : "a kong fixes four tiles into one set slot, and an added kong opens a 搶槓 window"));
    if (coachLog.length > 24) coachLog.length = 24;
    return;
  }
  const options = myClaims();
  if (options.length === 0) return;
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
  if (!SETTINGS.dev) return;
  coachLog.unshift(verdictHtml(cls, grade, head, why));
  if (coachLog.length > 24) coachLog.length = 24;
}
function devPanel(): string {
  if (!isDesktop() || !SETTINGS.dev || !snap) return "";
  let upcoming = claimAdvice();
  if (pending?.some((a) => a.type === "discard")) {
    const v = seatViewOf(snap);
    const ranked = [...rankDiscards(v, coachCfg(v))].sort((a, b) => b.score - a.score).slice(0, 4);
    upcoming += `<div class="sug">champion would cut ${ranked.map((d, i) =>
      `<span class="${i === 0 ? "best" : ""}">${name(d.tile)}</span>`).join(" › ")}</div>`;
  }
  // The LIVE tally — this session's own read, ahead of the server's. It is a
  // during-play hint only: the scoreboard's number comes from the server
  // (showMatchEndScreen's `matchAgreement`), never from this running count.
  const live = coachTally.graded === 0 ? ""
    : ` <span class="mut">· so far: ${Math.round((coachTally.matched / coachTally.graded) * 100)}% (${coachTally.graded})</span>`;
  return `<div id="dev">
    <div class="devbox" style="grid-column:1/-1"><b>discard &amp; claim helper</b>${live}${upcoming}
      <div class="scroll">${coachLog.join("") || '<div class="mut">your discards get graded here, and the grades stay</div>'}</div></div>
  </div>`;
}

/* ── announcements (unchanged from Solo — purely decorative) ────────────── */
const CALLS: Record<string, [string, string]> = {
  pung: ["碰", "pung"], chow: ["上", "chow"], kong: ["槓", "kong"],
  concealedKong: ["暗槓", "concealed kong"], addedKong: ["加槓", "added kong"],
  win: ["食糊", "win"], selfDraw: ["自摸", "self-draw"],
  robbingKong: ["搶槓", "robbed the kong"], flower: ["花", "flower"],
};
const SAY_MS = 640;
let sayTimer = 0;
/** `screenPos`: 0-3, already converted with `rel()` by the caller. */
function sayDiscard(tile: TileId, screenPos: 0 | 1 | 2 | 3): void {
  const el = $("say");
  el.innerHTML = `<div class="inner">${name(tile)}</div>`;
  el.className = "";
  void el.offsetWidth;
  el.style.setProperty("--sayms", `${SAY_MS}ms`);
  el.className = `show s${screenPos}`;
  clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => { el.className = ""; }, SAY_MS);
}

let callTimer = 0;
const GRAB_MS = 760;
interface Grab { tile: TileId; screenPos: 0 | 1 | 2 | 3; cx: number; cy: number; w: number; h: number; rot: number; }
let pendingGrab: Grab | null = null;
/** Which seat's meld is being flown into — the REAL seat, since this indexes
 *  `snap.seats[...]` at render time, not a screen position. */
let landingMeld: { seat: SeatIndex; index: number } | null = null;

function centreOf(el: HTMLElement): { cx: number; cy: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: el.offsetWidth, h: el.offsetHeight };
}
function armGrab(tile: TileId, seat: SeatIndex, rot: number): void {
  const last = $("pile").lastElementChild as HTMLElement | null;
  if (!last) return;
  pendingGrab = { tile, screenPos: rel(seat), rot, ...centreOf(last) };
}
function launchGrab(): void {
  const g = pendingGrab;
  if (!g) return;
  pendingGrab = null;
  const row = g.screenPos === 0 ? $("mymelds")
    : document.querySelector<HTMLElement>(`.seat.${["", "e", "n", "w"][g.screenPos]} .meldrow`);
  const target = row?.querySelector<HTMLElement>(".tile.claimed") ?? row;
  if (!target || g.w === 0) return;
  const t = centreOf(target);
  if (t.w === 0) return;
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
const CLAIM_HOLD_MS = GRAB_MS + 260;
const FLOWER_HOLD_MS = 500;
let holdMs = 0;
const takeHold = (): number => { const h = holdMs; holdMs = 0; return h; };
/** `screenPos` positions the call bubble; `who`/`extra` are prose already
 *  resolved by the caller. */
function announce(kind: string, who: string, extra = "", screenPos: 0 | 1 | 2 | 3 = 0): void {
  const [ch, en] = CALLS[kind] ?? [kind, ""];
  const el = $("call");
  el.innerHTML = `<div class="inner"><div class="cw">${who}</div>`
    + `<div class="cc${ch.length > 1 ? " two" : ""}">${ch}</div>`
    + `<div class="ce">${en}${extra ? ` · ${extra}` : ""}</div></div>`;
  el.className = `show s${screenPos} k-${kind} ` + (kind === "win" || kind === "selfDraw" ? "big" : "");
  clearTimeout(callTimer);
  callTimer = window.setTimeout(() => { el.className = ""; }, kind === "win" || kind === "selfDraw" ? 3200 : 2200);
  holdMs = kind === "win" || kind === "selfDraw" ? 0
    : kind === "flower" ? FLOWER_HOLD_MS : CLAIM_HOLD_MS;
}

/* ── the clock — server's deadlineTs, not a local cosmetic timer ─────────
 * Rule (W3/PVP plan §2.2): zero animation frames when nothing is moving. The
 * rAF loop below runs ONLY while a deadline is armed and cancels itself the
 * instant it is not — Solo's version ran continuously from boot.          */
let clockDeadline = 0, clockTotalMs = 1, clockRaf = 0;
function startClock(deadlineTs: number): void {
  clockDeadline = deadlineTs;
  clockTotalMs = Math.max(1, deadlineTs - Date.now());
  cancelAnimationFrame(clockRaf);
  const tick = (): void => {
    const remain = clockDeadline - Date.now();
    const frac = Math.min(1, Math.max(0, remain / clockTotalMs));
    $("clock").style.width = `${frac * 100}%`;
    $("clock").className = frac < 0.2 ? "low" : "";
    if (remain <= 0) { clockRaf = 0; return; }
    clockRaf = requestAnimationFrame(tick);
  };
  clockRaf = requestAnimationFrame(tick);
}
function stopClock(): void {
  cancelAnimationFrame(clockRaf);
  clockRaf = 0;
  $("clock").style.width = "0%";
  $("clock").className = "";
}

/* ── the wall (decorative — see decorSeed above) ─────────────────────── */
let buildAnim = false;
function renderWall(): void {
  const left = Math.max(0, snap?.wallRemaining ?? 0);
  const total = currentRuleset().useFlowers ? 144 : 136;
  const stacks = total / 2;
  const perSide = Math.ceil(stacks / 4);
  const liveStacks = Math.ceil(left / 2);
  const wallEl = $("wall");
  const bw = wallEl.clientWidth || 480, bh = wallEl.clientHeight || 300;
  const fitW = (bw / perSide - 2) / 17;
  const fitH = (bh / perSide - 2) / 15;
  const ws = Math.max(0.4, Math.min(1, fitW, fitH));
  wallEl.style.setProperty("--ws", ws.toFixed(3));
  const jr = prng((decorSeed() ^ 0xbeef) >>> 0);
  wallEl.className = buildAnim ? "building" : "";
  wallEl.innerHTML = ["top", "right", "bottom", "left"].map((side, si) => {
    const share = Math.floor(liveStacks / 4) + (si < liveStacks % 4 ? 1 : 0);
    return `<div class="side ${side}">${Array.from({ length: perSide }, (_, i) => {
      const gone = i >= share;
      const dead = !gone && si === 3 && i >= share - 4;
      const d = buildAnim
        ? ` style="--ax:${(jr() * 150 - 75).toFixed(0)}px;--ay:${(jr() * -130 - 30).toFixed(0)}px;--ar:${(jr() * 70 - 35).toFixed(0)}deg;animation-delay:${(si * 70 + i * 12)}ms"`
        : "";
      return `<span class="wt${gone ? " gone" : ""}${dead ? " dead" : ""}"${d}></span>`;
    }).join("")}</div>`;
  }).join("");
}
function buildWall(): void {
  buildAnim = true;
  renderWall();
  setTimeout(() => { buildAnim = false; renderWall(); }, 1450);
}

/* ── events: animate, THEN snap to the new state ──────────────────────────
 * Contract (task brief): an `events`/`restore` message carries the batch to
 * animate AND the snapshot from after it landed. `consume()` runs against
 * the OLD `snap` (still in scope when it is called) so it can read
 * "how many melds did this seat have before this claim" the same way Solo's
 * synchronous reducer loop could — `applyBatch()` below is what enforces the
 * ordering: animate first, replace `snap` only afterward.                  */
interface SessionHand { n: number; winner: SeatIndex | null; selfDraw: boolean; from: SeatIndex | null; faan: number; deltas: number[]; }
const sessionHands: SessionHand[] = [];
let pendingHandOutcome: { winner: SeatIndex | null; selfDraw: boolean; from: SeatIndex | null; faan: number } | null = null;
let handEndTimer = 0;

function consume(events: readonly RedactedGameEvent[]): void {
  for (const e of events) {
    const p = e.payload as unknown as Record<string, unknown>;
    switch (e.type) {
      case "deal":
        overlay = null;
        window.clearTimeout(handEndTimer);
        pileTiles = []; handSig = ""; landingMeld = null;
        $("say").className = "";
        buildWall();
        break;
      case "flowerReplacement":
        feed.push(`${seatName(p.seat as SeatIndex)} reveals ${name(p.flower as TileId)} 花`);
        announce("flower", seatName(p.seat as SeatIndex), name(p.flower as TileId), rel(p.seat as SeatIndex));
        break;
      case "discard": {
        const seat = p.seat as SeatIndex, tile = p.tile as TileId;
        pileTiles.push({ id: ++pileSeq, tile, seat });
        feed.push(`${seatName(seat)} discards ${name(tile)}`);
        sayDiscard(tile, rel(seat));
        break;
      }
      case "claimed": {
        const seat = p.seat as SeatIndex, tile = p.tile as TileId, kind = p.kind as string;
        armGrab(tile, seat, pileTiles[pileTiles.length - 1]?.pos?.rot ?? 0);
        // OLD snap, pre-update: the new meld's index equals the CURRENT count
        // (not count - 1 — see the file header on ordering).
        const before = snap ? (snap.seats[seat] as AnySeatView).melds.length : 0;
        landingMeld = { seat, index: before };
        pileTiles.pop();
        const verb = kind === "chow" ? "chows 上" : kind === "pung" ? "pungs 碰" : "kongs 槓";
        feed.push(`${seatName(seat)} ${verb} ${name(tile)}`);
        announce(kind, seatName(seat), name(tile), rel(seat));
        break;
      }
      case "concealedKong":
        feed.push(`${seatName(p.seat as SeatIndex)} declares a concealed kong 暗槓`);
        announce("concealedKong", seatName(p.seat as SeatIndex), "", rel(p.seat as SeatIndex));
        break;
      case "addedKong":
        feed.push(`${seatName(p.seat as SeatIndex)} adds a kong 加槓`);
        announce("addedKong", seatName(p.seat as SeatIndex), "", rel(p.seat as SeatIndex));
        break;
      case "refusedWin": {
        const seat = p.seat as SeatIndex;
        if (seat === mySeat) {
          const faan = (p.score as { faan: number } | null)?.faan ?? "?";
          feed.push(`Your hand completes but holds only ${faan} faan — under the ${p.minimumFaan as number}-faan floor`);
        }
        break;
      }
      case "winOnDiscard": case "selfDraw": {
        const ctx = p.context as { seat: SeatIndex; selfDraw: boolean; from: SeatIndex | null };
        const sc = p.score as { faan: number; awards: { id: string; faan: number }[] };
        const mine = ctx.seat === mySeat;
        announce(ctx.selfDraw ? "selfDraw" : "win", seatName(ctx.seat), `${sc.faan} faan`, rel(ctx.seat));
        const tiles = [...((p.concealed as TileId[]) ?? [])].sort((a, b) => a - b);
        const melds = (p.melds as Meld[] ?? []);
        overlay = `<h1>${mine ? "You win! 食糊" : seatName(ctx.seat) + " wins"}</h1>
          <h2>${sc.faan} faan · ${ctx.selfDraw ? "自摸 self-draw" : ctx.from === mySeat ? "off YOUR discard" : "食糊 on a discard"}</h2>
          <div class="tiles">${tiles.map((t) => tileHtml(t, "sm")).join("")}
            ${melds.map((m) => `<span style="width:8px"></span>` + m.tiles.map((t) => tileHtml(t, "sm")).join("")).join("")}</div>
          <div class="awards">${sc.awards.map((a) => `${AWARDS[a.id] ?? a.id} <b>${a.faan}</b>`).join(" &nbsp;·&nbsp; ")}</div>`;
        pendingHandOutcome = { winner: ctx.seat, selfDraw: ctx.selfDraw, from: ctx.from, faan: sc.faan };
        break;
      }
      case "exhaustiveDraw":
        overlay = `<h1>流局</h1><h2>The wall ran out — nobody wins</h2>`;
        pendingHandOutcome = { winner: null, selfDraw: false, from: null, faan: 0 };
        break;
      case "handEnd": {
        const st = p.standings as number[];
        const d = p.chipDeltas as number[] | undefined;
        sessionHands.push({
          n: sessionHands.length + 1,
          ...(pendingHandOutcome ?? { winner: null, selfDraw: false, from: null, faan: 0 }),
          deltas: d ?? [0, 0, 0, 0],
        });
        pendingHandOutcome = null;
        overlay = (overlay ?? "") + `<div class="pay">${[0, 1, 2, 3].map((i) => `
          <div>${seatName(i as SeatIndex)}<br>
            <span class="d ${d && d[i]! > 0 ? "up" : d && d[i]! < 0 ? "down" : ""}">${d ? (d[i]! > 0 ? "+" : "") + d[i] : ""}</span>
            <span style="opacity:.6"> → ${st[i]}</span></div>`).join("")}</div>`;
        // Auto-dismisses on the next `deal`; this is a fallback in case a
        // deal is unusually slow to arrive (a bot-heavy hand, a lagging pass).
        window.clearTimeout(handEndTimer);
        handEndTimer = window.setTimeout(() => { overlay = null; syncVeil(); }, 6000);
        break;
      }
      case "matchEnd": {
        const p2 = p as unknown as { standings: number[]; placements: number[]; reason: string; handsPlayed: number };
        matchEndInfo = { standings: p2.standings, placements: p2.placements, reason: p2.reason, handsPlayed: p2.handsPlayed };
        sessionStorage.removeItem(SESSION_KEY);
        // Grading is desktop-only UI, so there is no reason to spend the
        // round trip on mobile. GET /api/matches/:id is written by the
        // outbox shortly after matchEnd — poll it a couple of times.
        if (isDesktop()) void fetchMatchAgreement(currentMatchUuid);
        break;
      }
      default:
        break;
    }
  }
  if (feed.length > 8) feed.splice(0, feed.length - 8);
}

function applyBatch(events: readonly RedactedGameEvent[], snapshot: SeatVisible<SeatSnapshot> | null): void {
  const fresh = events.filter((e) => e.seq > lastSeq);
  if (fresh.length) {
    consume(fresh);
    lastSeq = fresh[fresh.length - 1]!.seq;
  }
  if (snapshot) {
    snap = snapshot;
    if (snapshot.seq > lastSeq) lastSeq = snapshot.seq;
  }
  render();
  syncVeil();
}

/** Best-effort reconstruction of the discard heap after a cold join/restore,
 *  when there is no event batch to animate — only per-seat discard lists in
 *  the snapshot, not their true interleave order (that information never
 *  reaches a seat socket). Grouped by seat rather than perfectly
 *  chronological; the packer places them without overlap either way. Known
 *  limitation, see README. */
function seedPileFromSnapshot(): void {
  pileTiles = [];
  if (!snap) return;
  for (let s = 0; s < 4; s++) {
    const view = snap.seats[s]!;
    for (const tile of view.discards) pileTiles.push({ id: ++pileSeq, tile, seat: s as SeatIndex });
  }
}

/* ── waiting room / table / overlays: what the veil shows ────────────── */
function humansConnected(): boolean {
  if (!directory) return false;
  return directory.every((d) => d.bot || (presence[d.seat]?.connected ?? d.connected));
}
function syncVeil(): void {
  if (matchEndInfo) { showMatchEndScreen(); return; }
  if (overlay) { showOverlay(); return; }
  if (snap && directory && !humansConnected() && !(pending && pending.length > 0)) { waitingRoomScreen(); return; }
  $("veil").style.display = "none";
}
function showOverlay(): void {
  $("veil").style.display = "flex";
  $("panel").innerHTML = `${overlay}<button id="btnCont" style="margin-top:14px">continue ▸</button>`;
  const b = document.getElementById("btnCont");
  if (b) (b as HTMLButtonElement).onclick = () => { overlay = null; syncVeil(); };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * GET /api/matches/:id after `matchEnd`, desktop only. The match_players
 * close-out (worker/src/table.ts's `finishMatch`, called from the outbox) can
 * land a beat after the socket's `matchEnd` event, so this polls a few times
 * rather than trusting the first read — `place` is null until that write has
 * happened, for every seat, at once. A stale response for a match the player
 * has since left is dropped by the `matchId` check before touching `render`.
 */
async function fetchMatchAgreement(matchId: string | null): Promise<void> {
  if (!identity || !matchId) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(700);
    try {
      const detail = await matchDetail(identity.deviceToken, matchId);
      const seats = detail.seats as unknown as {
        seat: number; place: number | null;
        movesGraded?: number; movesMatched?: number; agreement?: number | null;
      }[];
      if (!seats.every((s) => s.place !== null)) continue; // summary not written yet
      matchAgreement = ([0, 1, 2, 3] as SeatIndex[]).map((seat) => {
        const row = seats.find((s) => s.seat === seat);
        return {
          movesGraded: row?.movesGraded ?? 0,
          movesMatched: row?.movesMatched ?? 0,
          agreement: row?.agreement ?? null,
        };
      }) as FourSeats<SeatAgreement>;
      if (matchId === currentMatchUuid) syncVeil();
      return;
    } catch {
      /* transient — retry */
    }
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
    throw new Error("no clipboard api");
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
async function copyInviteLink(): Promise<void> {
  if (!currentJoinCode) return;
  const url = `${location.origin}/j/${currentJoinCode}`;
  flashHudNote(await copyText(url) ? "invite link copied" : `could not copy — ${url}`);
}

/** Best-effort `POST /api/tables/:matchId/leave` (bot takes the seat for the
 *  rest of the match), then always the local reset + back-to-lobby — a
 *  failed leave call must not strand the player on a dead screen. */
async function leaveTableAndReturn(matchId: string | null): Promise<void> {
  if (identity && matchId) {
    try { await apiLeaveTable(identity.deviceToken, matchId); } catch { /* best effort */ }
  }
  leaveTable();
}
async function startTableNow(btn: HTMLButtonElement): Promise<void> {
  if (!identity || !currentMatchUuid) return;
  btn.disabled = true; btn.textContent = "starting…";
  try {
    await apiStartTable(identity.deviceToken, currentMatchUuid);
    // No local transition needed — the server's own prompt/events clear the
    // waiting-room veil via syncVeil() the instant the clocks start.
  } catch (e) {
    flashHudNote(describeError(e));
    btn.disabled = false; btn.textContent = "Start now — fill empty seats with bots";
  }
}

function waitingRoomScreen(): void {
  beforeScreen();
  $("veil").style.display = "flex";
  const connectedN = directory ? directory.filter((d) => d.bot || (presence[d.seat]?.connected ?? d.connected)).length : 0;
  $("panel").innerHTML = `
    <h1>Waiting for the table</h1>
    ${currentJoinCode ? `
      <p class="mut">join code</p><h1 style="letter-spacing:.14em;color:var(--gold)">${currentJoinCode}</h1>
      <button id="btnCopyInvite" style="background:rgba(255,255,255,.08)">copy invite link</button>` : ""}
    <div class="rows">${[0, 1, 2, 3].map((s) => {
      const d = directory?.[s];
      const isMe = s === mySeat;
      const conn = d ? (d.bot || (presence[s as SeatIndex]?.connected ?? d.connected)) : isMe;
      return `<div class="row ${isMe ? "me" : ""}"><span class="c1">${isMe ? "You" : (d?.displayName ?? "empty seat")}</span>
        <span class="c2">${d?.bot ? "bot" : conn ? "connected" : "waiting…"}</span></div>`;
    }).join("")}</div>
    <p class="mut">waiting for ${Math.max(0, 4 - connectedN)} more player${Math.max(0, 4 - connectedN) === 1 ? "" : "s"}</p>
    ${isCreatorOfCurrentTable ? `<button id="btnStartNow">Start now — fill empty seats with bots</button>` : ""}
    <button id="btnLeaveWait" style="background:rgba(255,255,255,.08);margin-left:${isCreatorOfCurrentTable ? "8px" : "0"}">◂ leave</button>`;
  const copyBtn = document.getElementById("btnCopyInvite");
  if (copyBtn) copyBtn.onclick = () => void copyInviteLink();
  const startBtn = document.getElementById("btnStartNow") as HTMLButtonElement | null;
  if (startBtn) startBtn.onclick = () => void startTableNow(startBtn);
  const b = document.getElementById("btnLeaveWait");
  if (b) (b as HTMLButtonElement).onclick = () => void leaveTableAndReturn(currentMatchUuid);
}

/** "played like the engine 62% · 41 moves" — server truth (`matchAgreement`),
 *  desktop only, empty on mobile and while nothing has been graded. Grading
 *  UI is web-only by owner's ruling; the record itself is always server-side. */
const agreementLine = (seat: SeatIndex): string => {
  if (!isDesktop() || !matchAgreement) return "";
  const a = matchAgreement[seat];
  if (!a || a.movesGraded === 0 || a.agreement === null) return "";
  return ` <span class="mut">· played like the engine ${Math.round(a.agreement * 100)}% · ${a.movesGraded} moves</span>`;
};

function showMatchEndScreen(): void {
  const info = matchEndInfo;
  if (!info) return;
  beforeScreen();
  $("veil").style.display = "flex";
  const order = [0, 1, 2, 3].sort((a, b) => info.standings[b]! - info.standings[a]!);
  const place = order.indexOf(mySeat) + 1;
  const mine = isDesktop() && matchAgreement ? matchAgreement[mySeat] : null;
  $("panel").innerHTML = `
    <h1>${place === 1 ? "🏆 You win" : `You finish ${place}${["st", "nd", "rd", "th"][place - 1]}`}</h1>
    <p class="mut">${info.reason} · ${info.handsPlayed} hands · ${currentRulesetId} · ${currentMatchFormat}</p>
    <h2 style="margin-top:14px">Final standings</h2>
    <div class="rows">${order.map((i, r) => `
      <div class="row ${i === mySeat ? "me" : ""}"><span class="c1">${r + 1}. <span class="pname" data-player="${esc(directory?.[i as SeatIndex]?.playerId ?? "")}">${seatName(i as SeatIndex)}</span>${agreementLine(i as SeatIndex)}</span>
        <span class="c2 ${info.standings[i]! > 0 ? "up" : info.standings[i]! < 0 ? "down" : ""}">${fmtChips(info.standings[i]!)}</span></div>`).join("")}</div>
    ${sessionHands.length === 0 ? "" : `
    <h2 style="margin-top:14px">Hand by hand</h2>
    <div class="rows">${sessionHands.map((h) => `
      <div class="row"><span class="c1">${h.n}. ${
        h.winner === null ? "<span class=\"mut\">流局 — nobody wins</span>"
        : `${seatName(h.winner)} ${h.selfDraw ? "自摸" : h.from === mySeat ? "on YOUR discard" : h.from !== null ? `off ${seatName(h.from)}` : "食糊"} · <b>${h.faan} faan</b>`}</span>
        <span class="c2 ${(h.deltas[mySeat] ?? 0) > 0 ? "up" : (h.deltas[mySeat] ?? 0) < 0 ? "down" : ""}">${h.deltas[mySeat] ? fmtChips(h.deltas[mySeat]!) : "—"}</span></div>`).join("")}</div>`}
    ${!mine || mine.movesGraded === 0 || mine.agreement === null ? "" : `
    <h2 style="margin-top:14px">How you played it</h2>
    <div class="statgrid"><div><span>${Math.round(mine.agreement * 100)}%</span>engine agreement</div>
      <div><span>${mine.movesGraded}</span>decisions graded</div></div>`}
    <button id="btnBackLobby" style="margin-top:16px">◂ back to lobby</button>`;
  (document.getElementById("btnBackLobby") as HTMLButtonElement).onclick = () => {
    matchEndInfo = null; ts?.close(); ts = null; snap = null; directory = null;
    sessionHands.length = 0; coachTally.graded = 0; coachTally.matched = 0; matchAgreement = undefined;
    currentMatchUuid = null; currentJoinCode = null; isCreatorOfCurrentTable = false;
    lobbyScreen();
  };
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".pname[data-player]"))) {
    const id = el.dataset.player;
    if (!id) continue;
    el.onclick = (e) => { e.stopPropagation(); playerScreen(id, showMatchEndScreen); };
  }
}

/** Local-only: closes the socket and returns to the lobby. Does NOT call
 *  the server's `/leave` — that is `leaveTableAndReturn()`'s job, for the
 *  cases where the player is actually asking to be replaced by a bot
 *  (the quit-menu confirm, the waiting-room leave button). This is also the
 *  fallback for "there is nothing left to leave" paths: after `matchEnd`,
 *  and a join that was refused outright. */
function leaveTable(): void {
  ts?.close(); ts = null;
  sessionStorage.removeItem(SESSION_KEY);
  snap = null; directory = null; matchEndInfo = null; overlay = null; curLegal = null; pending = null;
  matchAgreement = undefined;
  currentMatchUuid = null; currentJoinCode = null; isCreatorOfCurrentTable = false;
  stopClock();
  lobbyScreen();
}

/* ── acting: send a request, wait, never mutate on send ────────────────── */
function act(a: Action): void {
  if (!ts) return;
  pending = null;
  stopClock();
  render();
  const legal = curLegal;
  let req: Promise<unknown>;
  switch (a.type) {
    case "discard": req = ts.request("requestDiscard", { tile: a.tile }); break;
    case "concealedKong": req = ts.request("requestConcealedKong", { tile: a.tile }); break;
    case "addedKong": req = ts.request("requestAddedKong", { tile: a.tile }); break;
    case "declareWin": req = ts.request("requestWinOnSelfDraw", {}); break;
    case "pass":
      req = ts.request("requestPass", { offerSeq: legal?.claims?.offerSeq ?? legal?.robKong?.offerSeq ?? -1 });
      break;
    case "claim":
      if (a.option.kind === "win") {
        req = legal?.robKong
          ? ts.request("requestRobKong", { offerSeq: legal.robKong.offerSeq })
          : ts.request("requestWinOnDiscard", { offerSeq: legal?.claims?.offerSeq ?? -1 });
      } else {
        req = ts.request("requestClaim", { offerSeq: legal?.claims?.offerSeq ?? -1, option: a.option });
      }
      break;
    default:
      req = Promise.reject(new Error("no request maps to this action"));
  }
  req.then(
    () => {},
    (e: unknown) => {
      flashHudNote(e instanceof RequestRejected ? (REJECT_NOTES[e.code] ?? e.code) : "that didn't go through — try again");
      if (curLegal) pending = actionsOf(mySeat, curLegal);
      render();
    },
  );
}
const REJECT_NOTES: Record<RejectCode, string> = {
  unauthenticated: "session expired — reconnecting",
  notYourTurn: "not your turn anymore",
  tileNotHeld: "you don't hold that tile",
  notALegalMove: "not legal right now",
  staleOffer: "that window already closed",
  windowClosed: "too late — the window closed",
  duplicateRequest: "already sent",
  rateLimited: "slow down a moment",
  matchOver: "the match is over",
};

/* ── render ────────────────────────────────────────────────────────────── */
function plate(seat: SeatIndex, who: string, initial: string): string {
  const s = snap!.seats[seat]!;
  const sign = s.chips > 0 ? "up" : s.chips < 0 ? "down" : "";
  const conn = presence[seat]?.connected ?? s.connected;
  const bot = directory?.[seat]?.bot ?? false;
  const marker = bot ? "" : presence[seat]?.botActing ? '<span class="mut"> · bot playing</span>'
    : !conn ? '<span class="mut"> · disconnected</span>' : "";
  return `<div class="nameplate ${snap!.turn === seat && !overlay ? "turn" : ""}">
      <span class="avatar">${initial}</span><span>${who}${marker}</span>
      <span class="wind">${WIND_CH[s.wind]}</span>
      ${snap!.dealer === seat ? '<span class="dealer">莊</span>' : ""}
      <span class="chips ${sign}">${s.chips > 0 ? "+" : ""}${s.chips}</span></div>`;
}
const myPlate = (): string => plate(mySeat, "You", "Y");

function seatBox(seat: SeatIndex): string {
  const s = snap!.seats[seat]!;
  const nm = seatName(seat);
  const hidden = s.handCount + (s.holdingDrawn ? 1 : 0);
  return plate(seat, nm, nm[0]!) + `
    <div class="backrow">${Array.from({ length: Math.min(hidden, 14) }, (_, i) =>
      `<span class="back ${i === hidden - 1 && s.holdingDrawn ? "wtnew" : ""}"
         style="--drawdelay:0ms"></span>`).join("")}</div>
    <div class="meldrow">${s.melds.map((m, i) => meldHtml(m,
        `sm ${landingMeld && landingMeld.seat === seat && landingMeld.index === i ? "claimed" : ""}`))
        .join('<span style="width:6px"></span>')}
      ${s.flowers.map((t) => tileHtml(t, "fl")).join("")}</div>`;
}

function render(): void {
  if (!snap) return;
  const meRaw = snap.seats[mySeat]!;
  if (!isOwnSeatView(meRaw)) return;
  const me: OwnSeatView = meRaw;

  const left = Math.max(0, snap.wallRemaining);
  const stateEl = $("state");
  stateEl.className = left <= 16 ? "low" : "";
  stateEl.innerHTML =
    `<div class="r1"><span class="wind">${WIND_CH[snap.roundWind]}</span>`
    + `<span>hand <b>${snap.handIndex + 1}</b></span></div>`
    + `<div class="r2">wall <b>${left}</b> left</div>`;
  $("seatE").innerHTML = seatBox(actualSeat(1));
  $("seatN").innerHTML = seatBox(actualSeat(2));
  $("seatW").innerHTML = seatBox(actualSeat(3));
  $("seatS").innerHTML = myPlate();
  renderWall();

  const pileEl = $("pile");
  const boxW = pileEl.clientWidth || 420, boxH = pileEl.clientHeight || 240;
  pileEl.style.setProperty("--pileth", `${Math.round(Math.min(46, Math.max(21, boxW / 14.3)))}px`);
  const probe = pileEl.querySelector<HTMLElement>(".tile");
  const th = probe?.offsetHeight || 36 * SETTINGS.tileScale;
  const tw = probe?.offsetWidth || th * 0.714;
  const jr = prng((decorSeed() ^ 0x51ed) >>> 0);
  pileTiles.forEach((d) => {
    if (d.pos) return;
    const r = rel(d.seat);
    const placed = pileTiles.filter((o) => o.pos).map((o) => o.pos!);
    const ax = boxW / 2 + [0, tw * 1.7, 0, -tw * 1.7][r]!;
    const ay = boxH / 2 + [th * 0.75, 0, -th * 0.75, 0][r]!;
    const CLEAR = 0.3;
    const squash = Math.min(0.9, Math.max(0.5, boxH / boxW));
    const fits = (c: Placed): boolean => !placed.some((o) => hits(c, o, tw + CLEAR, th + CLEAR));
    let best: Placed | null = null;
    const step = Math.max(0.8, th * 0.028);
    for (let rr = 0; rr < 320 && !best; rr += step) {
      const off = jr() * Math.PI * 2;
      for (let k = 0; k < 40 && !best; k++) {
        const a = off + (k / 40) * Math.PI * 2;
        for (let t = 0; t < 4 && !best; t++) {
          const rot = jr() < 0.24 ? (jr() < 0.5 ? 90 : -90) + (jr() - 0.5) * 22 : (jr() - 0.5) * 74;
          const c: Placed = { x: ax + Math.cos(a) * rr, y: ay + Math.sin(a) * rr * squash, rot, spin: 0 };
          if (fits(c)) best = c;
        }
      }
    }
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
      for (let i = 0; i < 220; i++) {
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
  const live = new Set(pileTiles.map((d) => d.id));
  const pid = (el: Element): number => Number((el as HTMLElement).dataset.pid);
  for (const el of Array.from(pileEl.children)) if (!live.has(pid(el))) el.remove();
  const have = new Set(Array.from(pileEl.children).map(pid));
  for (const d of pileTiles) {
    if (have.has(d.id)) continue;
    const r = rel(d.seat);
    const from = [[0, 190], [230, 0], [0, -190], [-230, 0]][r] ?? [0, 190];
    const lx = from[0]! * 0.3, ly = from[1]! * 0.3;
    const lr = d.pos!.rot + (d.pos!.spin - d.pos!.rot) * 0.22;
    for (const el of Array.from(pileEl.children)) el.classList.remove("hot");
    pileEl.insertAdjacentHTML("beforeend", tileHtml(d.tile, "pt fresh hot",
      `data-pid="${d.id}" style="left:${d.pos!.x.toFixed(1)}px;top:${d.pos!.y.toFixed(1)}px;`
      + `--fx:${from[0]}px;--fy:${from[1]}px;--fr:${d.pos!.spin.toFixed(0)}deg;`
      + `--lx:${lx.toFixed(0)}px;--ly:${ly.toFixed(0)}px;--lr:${lr.toFixed(1)}deg;`
      + `--rot:${d.pos!.rot.toFixed(1)}deg;--tossms:1300ms;`
      + `transform:translate(-50%,-50%) rotate(${d.pos!.rot.toFixed(1)}deg)"`));
  }

  const mine = (i: number): string =>
    landingMeld && landingMeld.seat === mySeat && landingMeld.index === i ? "claimed" : "";
  $("mymelds").innerHTML = me.melds.map((m, i) => m.tiles.map((t) => tileHtml(t, mine(i))).join(""))
    .join('<span style="width:10px"></span>')
    + me.flowers.map((t) => tileHtml(t, "fl")).join("");

  const canDiscard = !!pending?.some((a) => a.type === "discard");
  const hand = [...me.hand].sort((a, b) => a - b);
  $("myhand").className = canDiscard ? "" : "locked";
  const sig = `${hand.join(",")}|${me.drawn ?? "-"}|${canDiscard}`;
  if (sig !== handSig) {
    handSig = sig;
    $("myhand").innerHTML = hand.map((t) => tileHtml(t, "", `data-t="${t}"`)).join("")
      + (me.drawn !== null
          ? tileHtml(me.drawn, "drawn",
              `data-t="${me.drawn}" style="--drawms:900ms;--drawdelay:0ms;`
              + `--wx:${(120 - hand.length * 9).toFixed(0)}px;--wy:-190px"`)
          : "");
  }
  if (canDiscard) {
    for (const el of Array.from($("myhand").querySelectorAll<HTMLElement>(".tile"))) {
      el.onclick = () => {
        const t = Number(el.dataset.t) as TileId;
        const a = pending?.find((x) => x.type === "discard" && x.tile === t);
        if (a) { if (isDesktop()) gradeMyDiscard(t); act(a); }
      };
    }
  }

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
  } else if (!overlay) bar = `<span class="hint">…</span>`;
  $("actions").innerHTML = bar;
  for (const el of Array.from($("actions").querySelectorAll<HTMLElement>("button"))) {
    el.onclick = () => {
      const a = pending?.[Number(el.dataset.i)];
      if (a) { if (isDesktop()) gradeMyClaim(a); act(a); }
    };
  }
  $("log").innerHTML = feed.map((l) => `<div>${l}</div>`).join("");
  $("callwrap").innerHTML = isDesktop() ? callingBar() : "";
  $("devwrap").innerHTML = isDesktop() ? devPanel() : "";
  recenterGlyphs(document);
  launchGrab();
}
function rectCorners(p: { x: number; y: number; rot: number }, w: number, h: number): { x: number; y: number }[] {
  const c = Math.cos(p.rot * Math.PI / 180), s2 = Math.sin(p.rot * Math.PI / 180);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => ({ x: p.x + x! * c - y! * s2, y: p.y + x! * s2 + y! * c }));
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

/* ── hud notes / connection badge ─────────────────────────────────────── */
let noteTimer = 0;
function flashHudNote(msg: string, ms = 2600): void {
  const el = document.getElementById("hudNote");
  if (!el) return;
  el.textContent = msg;
  window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => { el.textContent = ""; }, ms);
}
function setConnBadge(msg: string): void {
  const el = document.getElementById("netStatus");
  if (el) el.textContent = msg;
}

/* ── socket wiring ─────────────────────────────────────────────────────── */
function connectToMatch(r: {
  matchUuid: string; joinCode: string | null; seat: SeatIndex; seatToken: string;
  rulesetId: string; matchFormat: MatchFormat; creator?: boolean;
}): void {
  currentMatchUuid = r.matchUuid; currentJoinCode = r.joinCode;
  currentRulesetId = r.rulesetId; currentMatchFormat = r.matchFormat;
  mySeat = r.seat;
  isCreatorOfCurrentTable = r.creator ?? false;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    matchUuid: r.matchUuid, joinCode: r.joinCode, seat: r.seat, creator: isCreatorOfCurrentTable,
  }));
  snap = null; directory = null; lastSeq = -1; curLegal = null; pending = null;
  overlay = null; matchEndInfo = null; matchAgreement = undefined;
  pileTiles = []; handSig = ""; landingMeld = null; feed.length = 0;
  sessionHands.length = 0; coachTally.graded = 0; coachTally.matched = 0;
  for (const k of Object.keys(presence)) delete presence[Number(k) as SeatIndex];
  ts?.close();
  ts = new TableSocket(r.matchUuid, r.seatToken, {
    onWelcome(payload: WelcomePayload) {
      directory = payload.directory;
      mySeat = payload.seat;
      currentRulesetId = payload.rulesetId;
      snap = payload.snapshot;
      lastSeq = payload.snapshot.seq;
      seedPileFromSnapshot();
      buildWall();
      setConnBadge("");
      render();
      syncVeil();
      ts?.resync(lastSeq);
    },
    onRestore(events, snapshot) { applyBatch(events, snapshot); },
    onEvents(events, snapshot) { applyBatch(events, snapshot); },
    onPrompt(payload: PromptPayload) {
      curLegal = payload.legal;
      pending = actionsOf(mySeat, payload.legal);
      if (pending.length > 0) startClock(payload.deadlineTs); else stopClock();
      render();
      syncVeil();
    },
    onPresence(payload: PresencePayload) {
      presence[payload.seat] = { connected: payload.connected, botActing: payload.botActing };
      render();
      syncVeil();
    },
    onFault(payload: ProtocolFaultPayload) {
      if (payload.code === "unsupportedProtocolVersion") {
        fatalScreen("This build is out of date — please reload the page.");
      } else if (payload.code === "notJoined") {
        ts?.rejoin();
      } else {
        flashHudNote(`protocol error: ${payload.code}`);
      }
    },
    onJoinRejected(payload: RejectedPayload) {
      if (payload.code === "unauthenticated" && currentJoinCode && identity) {
        void joinTable(identity.deviceToken, currentJoinCode).then((jr) => {
          ts?.setSeatToken(jr.seatToken);
          ts?.rejoin();
        }).catch(() => { flashHudNote("could not rejoin — back to lobby"); leaveTable(); });
      } else {
        flashHudNote(`join refused: ${payload.code}`);
        leaveTable();
      }
    },
    onClose(info) { setConnBadge(info.willRetry ? "reconnecting…" : ""); },
  });
  ts.connect();
  waitingRoomScreen();
}

function fatalScreen(msg: string): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").innerHTML = `<h1>Something needs a reload</h1><p>${msg}</p>
    <button id="btnReload">reload ▸</button>`;
  (document.getElementById("btnReload") as HTMLButtonElement).onclick = () => location.reload();
}

/* ── screens ───────────────────────────────────────────────────────────── */
function backRow(): string { return `<button id="btnLobby" style="margin-top:16px">◂ back to lobby</button>`; }
const wireBack = (to: () => void): void => {
  const b = document.getElementById("btnLobby");
  if (b) (b as HTMLButtonElement).onclick = () => to();
};

/* ── the lobby's own poll: 5s while lobbyScreen is showing, stopped the
 * instant anything else is (task: "stop when it is not"). Every OTHER
 * screen function calls `beforeScreen()` first, which is what stops it —
 * there is no separate "leaving the lobby" event to hook. */
let lobbyPollTimer = 0;
let lobbyGen = 0;
let lobbyData: LobbyPayload | null = null;
function stopLobbyPoll(): void { window.clearInterval(lobbyPollTimer); lobbyPollTimer = 0; }
/** Every screen but the lobby calls this first: stops the lobby poll and
 *  clears the two panel-width classes the lobby and about screens set. */
function beforeScreen(): void {
  stopLobbyPoll();
  $("panel").classList.remove("about", "lobby3");
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.code;
  if (e instanceof RequestRejected) return e.code;
  if (e instanceof Error) return e.message;
  return String(e);
}

function aboutScreen(back: () => void): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").classList.add("about");
  $("panel").innerHTML = `
    <h1>MJRC gamepvp — a private beta</h1>
    <p>Real Hong Kong Old Style mahjong against real people. Four humans join a
    table by a short code; any empty seat is filled by one of the training
    programme's bots, so a table is playable even before everyone is online.</p>
    <p class="mut">Invite-only. Everything you play is recorded on our
    server — there is no local game state to lose, and no account beyond the
    name you typed.</p>
    <h2>What we are testing</h2>
    <ul class="about">
      <li><b>The server</b> — a real match surviving real networks: drops, backgrounding, slow phones.</li>
      <li><b>The rules</b> — legality, scoring, the faan floor, the calls — all enforced server-side now.</li>
      <li><b>The feel</b> — whether a turn-based game over a socket still reads as immediate.</li>
    </ul>
    <h2>Coaching is still yours, only</h2>
    <p>The discard helper and calling read work off your own hand — they were
    never allowed to see anyone else's, and now neither is the client that
    runs them.</p>
    <h2>Later</h2>
    <p>Spectating, and a shared leaderboard across testers. Treat everything
    here as a sketch.</p>
    <button id="btnAbout">got it ▸</button>`;
  (document.getElementById("btnAbout") as HTMLButtonElement).onclick = () => {
    $("panel").classList.remove("about");
    $("veil").style.display = "none";
    back();
  };
}

function nameScreen(then: () => void): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").innerHTML = `
    <h1>香港麻雀 · MJRC</h1>
    <p>What should we call you? This is a private beta — every game you play
    is recorded on our server, seat by seat, hand by hand.</p>
    <div class="setrow" style="margin-top:14px">
      <input id="nameIn" type="text" maxlength="24" placeholder="your name"
        value="${(identity?.displayName ?? "").replace(/"/g, "&quot;")}"
        style="flex:1;padding:9px 12px;font-size:16px;border-radius:9px;
               background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);color:var(--ink)">
    </div>
    <p class="mut" id="nameNote">No account, no email — just this name. Change it any time.</p>
    <button id="btnName">continue ▸</button>`;
  const input = document.getElementById("nameIn") as HTMLInputElement;
  const go = async (): Promise<void> => {
    const nm = input.value.trim();
    if (!nm) { input.focus(); return; }
    try {
      identity = await identify(nm);
      ensurePresenceHeartbeat();
      then();
    } catch (e) {
      $("nameNote").innerHTML = `<b style="color:var(--danger)">Could not reach the server</b> — ${describeError(e)}`;
    }
  };
  (document.getElementById("btnName") as HTMLButtonElement).onclick = () => void go();
  input.onkeydown = (e) => { if (e.key === "Enter") void go(); };
  input.focus();
}

/** "hand 3/4" — `hand` is 0-indexed on the wire, `handsBase` is the
 *  dealership-count denominator (4 east, 16 full); a repeat pushes the
 *  numerator past it on purpose ("hand 5/4" — task spec item 6). */
function handLabel(hand: number | undefined, handsBase: number | undefined): string {
  if (hand === undefined || handsBase === undefined) return "in a hand";
  return `hand ${hand + 1}/${handsBase}`;
}
function ruleLabel(id: string): string {
  return RULE_PICKS.find(([rid]) => rid === id)?.[1] ?? id;
}
const matchFormatLabel = (f: MatchFormat): string => (f === "full" ? "全莊" : "東圈");
/** `createdBy` on the wire is a player id (schema.sql), not a name — the
 *  creator is always the table's first human seat, so read the name off
 *  `seats` instead and fall back to the raw id if that seat has none yet. */
function creatorName(t: LobbyTable): string {
  return t.seats.find((s) => s.kind === "human" && s.displayName)?.displayName ?? t.createdBy;
}

function hereStateLabel(e: LobbyHereEntry, tables: LobbyTable[]): string {
  if (e.state === "lobby") return "in the lobby";
  if (e.state === "playing") return `playing, ${handLabel(e.hand, e.handsBase)}`;
  const t = e.matchId ? tables.find((x) => x.matchId === e.matchId) : undefined;
  if (!t) return "waiting at a table";
  const filled = t.seats.filter((s) => s.kind === "bot" || s.connected).length;
  return `waiting at a table ${filled}/4`;
}
function hereRowHtml(e: LobbyHereEntry, tables: LobbyTable[]): string {
  const t = e.matchId ? tables.find((x) => x.matchId === e.matchId) : undefined;
  const clickable = e.state === "waiting" && t?.access === "open" && t.lobbyStatus === "waiting" && !!t.joinCode;
  const dot = e.state === "lobby" ? "here" : e.state === "waiting" ? "wait" : "play";
  // The name is its own tap target (→ Player) inside a row that may ALSO be
  // clickable as a whole (→ sit down) — `pname`'s handler stops propagation
  // so tapping a name never fires the row's sit-down click underneath it.
  return `<div class="row${clickable ? " clickable" : ""}" ${clickable ? `data-code="${t!.joinCode}"` : ""}>
    <span class="dot ${dot}"></span>
    <span class="c1"><span class="pname" data-player="${esc(e.playerId)}">${esc(e.displayName)}</span></span>
    <span class="c2 mut" style="width:auto">${hereStateLabel(e, tables)}</span></div>`;
}

function seatTileHtml(s: LobbyTableSeat): string {
  const filled = s.kind === "bot" || !!s.displayName;
  const label = s.kind === "bot" ? (s.displayName ?? "bot") : (s.displayName ?? "empty");
  return `<span class="seattile ${s.kind === "bot" ? "bot" : filled ? "human" : "empty"}">${esc(label)}</span>`;
}
function tableRowHtml(t: LobbyTable): string {
  const filled = t.seats.filter((s) => s.kind === "bot" || s.connected).length;
  const canSit = t.access === "open" && t.lobbyStatus === "waiting" && !!t.joinCode;
  const status = t.lobbyStatus === "playing" ? handLabel(t.hand, t.handsBase)
    : t.lobbyStatus === "waiting" ? `${filled}/4 seated` : "";
  return `<div class="tablerow">
    <div class="tr-head">
      <b>${esc(creatorName(t))}</b>
      <span class="badge ${t.mode}">${t.mode}</span>
      ${t.access === "private" ? `<span class="lock" title="private — needs the code">🔒</span>` : ""}
      <span class="mut">${esc(ruleLabel(t.rulesetId))} · ${matchFormatLabel(t.matchFormat)}</span>
    </div>
    <div class="tr-seats">${t.seats.map(seatTileHtml).join("")}</div>
    <div class="tr-foot"><span class="mut">${status}</span>
      ${canSit ? `<button class="sitdown" data-code="${t.joinCode}">Sit down</button>` : ""}</div>
  </div>`;
}

function recentRowHtml(m: LobbyRecentMatchSafe): string {
  const order = [...m.standings].sort((a, b) => a.place - b.place);
  const line = order.map((s) =>
    `${s.place}. ${esc(s.displayName)} <b class="${s.chips > 0 ? "up" : s.chips < 0 ? "down" : ""}">${fmtChips(s.chips)}</b>`,
  ).join(" &nbsp;·&nbsp; ");
  return `<div class="row"><span class="c1">${new Date(m.endedAt).toLocaleDateString()}
    <span class="badge ${m.mode}">${m.mode}</span> &nbsp; ${line}</span></div>`;
}
/** `LobbyRecentMatch` re-exported locally only to keep this file's imports
 *  from net.ts to one line above; identical shape. */
type LobbyRecentMatchSafe = LobbyPayload["recent"][number];

async function sitDownByCode(code: string): Promise<void> {
  if (!identity) return;
  try {
    const r = await joinTable(identity.deviceToken, code);
    connectToMatch({
      matchUuid: r.matchUuid, joinCode: code, seat: r.seat, seatToken: r.seatToken,
      rulesetId: r.rulesetId, matchFormat: r.matchFormat,
    });
  } catch (e) {
    flashHudNote(describeError(e));
    lobbyScreen();
  }
}

function wireLobbyPanel(): void {
  (document.getElementById("goNew") as HTMLElement).onclick = () => { beforeScreen(); newTableScreen(); };
  (document.getElementById("goJoin") as HTMLElement).onclick = () => { beforeScreen(); joinScreen(); };
  (document.getElementById("goStats") as HTMLElement).onclick = () => { beforeScreen(); statsScreen(); };
  (document.getElementById("goYourStats") as HTMLElement).onclick = () => { beforeScreen(); yourStatsScreen(); };
  (document.getElementById("goLeaderboard") as HTMLElement).onclick = () => { beforeScreen(); leaderboardScreen("ranked"); };
  (document.getElementById("btnRename") as HTMLElement).onclick = (e) => { e.preventDefault(); beforeScreen(); nameScreen(lobbyScreen); };
  (document.getElementById("btnAbout2") as HTMLElement).onclick = (e) => { e.preventDefault(); beforeScreen(); aboutScreen(lobbyScreen); };
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".row.clickable[data-code]"))) {
    el.onclick = () => { const code = el.dataset.code!; beforeScreen(); void sitDownByCode(code); };
  }
  for (const el of Array.from($("panel").querySelectorAll<HTMLButtonElement>("button.sitdown"))) {
    el.onclick = () => { const code = el.dataset.code!; beforeScreen(); void sitDownByCode(code); };
  }
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".pname[data-player]"))) {
    el.onclick = (e) => {
      e.stopPropagation();
      const id = el.dataset.player!;
      beforeScreen();
      playerScreen(id, lobbyScreen);
    };
  }
}

/** Redraws from `lobbyData` only — never fetches. `lobbyData` starts `null`
 *  ("reading…") and, per the task brief ("degrade gracefully… rather than
 *  faking data"), simply stays whatever it last was on a failed poll — an
 *  empty array once the first successful read comes back empty, never a
 *  fabricated row. */
function renderLobby(): void {
  const data = lobbyData;
  const here = data?.here ?? [];
  const tables = data?.tables ?? [];
  const recent = data?.recent ?? [];
  const reading = data === null;
  $("panel").innerHTML = `
    <h1>香港麻雀 · MJRC</h1>
    <p class="mut">Playing as <b>${esc(identity?.displayName ?? "—")}</b> ·
      <a href="#" id="btnRename" style="color:var(--gold)">change name</a></p>
    <div class="lobbygrid">
      <div class="lobbycol">
        <h2>Here now</h2>
        <div class="rows">${here.length === 0
          ? `<p class="mut">${reading ? "reading…" : "nobody else is around right now"}</p>`
          : here.map((e) => hereRowHtml(e, tables)).join("")}</div>
      </div>
      <div class="lobbycol">
        <h2>Open tables</h2>
        <div class="tablelist">${tables.length === 0
          ? `<p class="mut">${reading ? "reading…" : "no tables right now — start one"}</p>`
          : tables.map(tableRowHtml).join("")}</div>
      </div>
      <div class="lobbycol">
        <div class="choices lobby">
          <div class="choice" id="goNew"><b>New table ▸</b><span>Pick rules, mode and seats, invite by code.</span></div>
          <div class="choice" id="goJoin"><b>Join by code</b><span>Enter a table's join code to sit down.</span></div>
          <div class="choice" id="goStats"><b>Your games</b><span>Every match you have played — our record of it, not this device's.</span></div>
          <div class="choice" id="goYourStats"><b>Stats</b><span>Your totals, placements and rating over time.</span></div>
          <div class="choice" id="goLeaderboard"><b>Leaderboard</b><span>Ranked by rating, casual by record.</span></div>
        </div>
      </div>
    </div>
    <h2 style="margin-top:16px">Recent results</h2>
    <div class="rows">${recent.length === 0
      ? `<p class="mut">${reading ? "reading…" : "nothing finished yet"}</p>`
      : recent.map(recentRowHtml).join("")}</div>
    <p class="mut" style="margin-top:10px"><a href="#" id="btnAbout2" style="color:var(--gold)">what is this?</a></p>`;
  wireLobbyPanel();
}

/** GET /api/lobby every 5s while this screen is up (§3, §7.2). Not yet
 *  implemented server-side as of this build — a failed poll is swallowed and
 *  the panels stay on whatever they last showed (or "reading…" on the very
 *  first attempt), never a fake row. */
async function refreshLobby(gen: number): Promise<void> {
  if (!identity || gen !== lobbyGen) return;
  try {
    lobbyData = await getLobby(identity.deviceToken);
  } catch {
    /* degrade gracefully — see renderLobby's doc comment */
  }
  if (gen === lobbyGen) renderLobby();
}

function lobbyScreen(): void {
  const gen = ++lobbyGen;
  stopLobbyPoll();
  $("veil").style.display = "flex";
  $("panel").classList.remove("about");
  $("panel").classList.add("lobby3");
  renderLobby();
  void refreshLobby(gen);
  lobbyPollTimer = window.setInterval(() => void refreshLobby(gen), 5000);
}

/** Seat 東南西北 order, exactly what `POST /api/tables` `seats[4]` sends.
 *  `bot` is remembered even while `kind === "human"` so toggling a seat back
 *  to bot restores the last pick instead of resetting it. */
interface SeatDraft { kind: "human" | "bot"; bot: string; }
const newTableDraft: {
  rulesetId: string; matchFormat: MatchFormat; mode: TableMode; access: TableAccess;
  randomizeSeats: boolean; seats: [SeatDraft, SeatDraft, SeatDraft, SeatDraft];
} = {
  rulesetId: "mjrc-standard", matchFormat: "east", mode: "casual", access: "open", randomizeSeats: false,
  seats: [
    { kind: "human", bot: DEFAULT_BOT_LINEUP[0]! },
    { kind: "bot", bot: DEFAULT_BOT_LINEUP[1]! },
    { kind: "bot", bot: DEFAULT_BOT_LINEUP[2]! },
    { kind: "bot", bot: DEFAULT_BOT_LINEUP[3]! },
  ],
};
/** "The creator's own seat is the first human seat" (task spec item 3). */
const firstHumanSeatIx = (): number => Math.max(0, newTableDraft.seats.findIndex((s) => s.kind === "human"));
const humanSeatCount = (): number => newTableDraft.seats.filter((s) => s.kind === "human").length;
const botDisplayName = (key: string): string => botCatalogue?.find((b) => b.key === key)?.displayName ?? key;

function botChipsRow(i: number): string {
  const picked = newTableDraft.seats[i]!.bot;
  const catalogue = botCatalogue ?? [];
  return catalogue.length > 0
    ? catalogue.map((b) => `
      <button class="botchip ${b.key === picked ? "on" : ""}" data-seat="${i}" data-key="${b.key}"
        title="${esc(b.blurb)} · strength ${b.strength}/5">${esc(b.displayName)}</button>`).join("")
    : `<button class="botchip on" data-seat="${i}" data-key="${picked}">${esc(picked)}</button>`;
}
function seatSlotHtml(i: number): string {
  const seat = newTableDraft.seats[i]!;
  const isCreator = seat.kind === "human" && firstHumanSeatIx() === i;
  const ranked = newTableDraft.mode === "ranked";
  const label = seat.kind === "human" ? (isCreator ? "you" : "open — a player joins") : botDisplayName(seat.bot);
  return `<div class="seatslot">
    <div class="seatcard ${seat.kind}${ranked ? " locked" : ""}" data-seat="${i}">
      <span class="sc-wind">${WIND_CH[i]}</span>
      <b class="sc-kind">${seat.kind === "human" ? "Human" : "Bot"}</b>
      <span class="sc-label">${esc(label)}</span>
    </div>
    ${seat.kind === "bot" && !ranked ? `<div class="chips">${botChipsRow(i)}</div>` : ""}
  </div>`;
}

let newTableGen = 0;
function newTableScreen(): void {
  beforeScreen();
  const gen = ++newTableGen;
  $("veil").style.display = "flex";
  const ranked = newTableDraft.mode === "ranked";
  $("panel").innerHTML = `
    <h1>New table</h1>
    <h2>Length</h2>
    <div class="seg">
      <button class="${newTableDraft.matchFormat === "east" ? "on" : ""}" data-fmt="east"><b>東圈</b><span>one wind · ~8 hands</span></button>
      <button class="${newTableDraft.matchFormat === "full" ? "on" : ""}" data-fmt="full"><b>全莊</b><span>four winds · ~35 hands</span></button>
    </div>
    <h2>Rules</h2>
    <div class="choices two">${RULE_PICKS.map(([id, label, blurb]) => `
      <div class="choice ${newTableDraft.rulesetId === id ? "sel" : ""}" data-r="${id}">
        <b>${label}</b><span>${blurb}</span></div>`).join("")}</div>
    <h2>Mode</h2>
    <div class="seg">
      <button class="${!ranked ? "on" : ""}" data-mode="casual"><b>Casual</b><span>unrated · any mix of bots</span></button>
      <button class="${ranked ? "on" : ""}" data-mode="ranked"><b>Ranked</b><span>rated · four humans</span></button>
    </div>
    <h2>Access</h2>
    <div class="seg">
      <button class="${newTableDraft.access === "open" ? "on" : ""}" data-access="open"><b>Open</b><span>listed in the lobby</span></button>
      <button class="${newTableDraft.access === "private" ? "on" : ""}" data-access="private"><b>Private</b><span>code only</span></button>
    </div>
    <p class="segcap">${newTableDraft.access === "open"
      ? "Everyone can see this table in the lobby and sit down."
      : "Private — only people with the code can join."}</p>
    <div class="setrow"><label style="width:auto;flex:1">Randomize seats at start</label>
      <input type="checkbox" id="setRandomize" ${newTableDraft.randomizeSeats ? "checked" : ""}></div>
    <h2>Seats</h2>
    <p class="segcap">${ranked ? "Ranked needs four human seats — bots are off."
      : "Tap a seat to swap human/bot; tap a bot's name below it to pick which one."}</p>
    <div class="seatgrid">${[0, 1, 2, 3].map((i) => seatSlotHtml(i)).join("")}</div>
    <p class="mut">Playing as <b>${esc(identity?.displayName ?? "—")}</b> ·
      <a href="#" id="btnRename" style="color:var(--gold)">change name</a></p>
    <button id="btnCreate">create table ▸</button>
    <button id="btnLobby" style="margin-left:8px;background:rgba(255,255,255,.08)">◂ lobby</button>
    <p class="mut" id="createErr"></p>`;
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seg button[data-fmt]"))) {
    el.onclick = () => { newTableDraft.matchFormat = el.dataset.fmt as MatchFormat; newTableScreen(); };
  }
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seg button[data-mode]"))) {
    el.onclick = () => {
      newTableDraft.mode = el.dataset.mode as TableMode;
      if (newTableDraft.mode === "ranked") for (const s of newTableDraft.seats) s.kind = "human";
      newTableScreen();
    };
  }
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seg button[data-access]"))) {
    el.onclick = () => { newTableDraft.access = el.dataset.access as TableAccess; newTableScreen(); };
  }
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".choice[data-r]"))) {
    el.onclick = () => { newTableDraft.rulesetId = el.dataset.r!; newTableScreen(); };
  }
  const rnd = document.getElementById("setRandomize") as HTMLInputElement | null;
  if (rnd) rnd.onchange = () => { newTableDraft.randomizeSeats = rnd.checked; };
  if (!ranked) {
    for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seatcard"))) {
      el.onclick = () => {
        const i = Number(el.dataset.seat);
        const seat = newTableDraft.seats[i]!;
        if (seat.kind === "human") {
          if (humanSeatCount() <= 1) return; // the creator needs a seat somewhere
          seat.kind = "bot";
        } else {
          seat.kind = "human";
        }
        newTableScreen();
      };
    }
    for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".botchip"))) {
      el.onclick = (e) => {
        e.stopPropagation();
        const i = Number(el.dataset.seat);
        newTableDraft.seats[i]!.bot = el.dataset.key!;
        newTableScreen();
      };
    }
  }
  const ren = document.getElementById("btnRename");
  if (ren) ren.onclick = (e) => { e.preventDefault(); nameScreen(newTableScreen); };
  wireBack(lobbyScreen);
  (document.getElementById("btnCreate") as HTMLButtonElement).onclick = () => void doCreateTable();
  if (!botCatalogue) {
    void loadBotCatalogue().then(() => { if (gen === newTableGen) newTableScreen(); });
  }
}
async function doCreateTable(): Promise<void> {
  if (!identity) return;
  if (humanSeatCount() < 1) {
    const err = document.getElementById("createErr");
    if (err) err.innerHTML = `<b style="color:var(--danger)">at least one seat has to be human — that's you</b>`;
    return;
  }
  const btn = document.getElementById("btnCreate") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = "creating…"; }
  try {
    const seats = newTableDraft.seats.map((s): SeatSpec =>
      s.kind === "human" ? { kind: "human" } : { kind: "bot", bot: s.bot },
    ) as [SeatSpec, SeatSpec, SeatSpec, SeatSpec];
    const r: CreateTableResult = await createTable(identity.deviceToken, {
      rulesetId: newTableDraft.rulesetId, matchFormat: newTableDraft.matchFormat,
      mode: newTableDraft.mode, access: newTableDraft.access, randomizeSeats: newTableDraft.randomizeSeats,
      seats,
    });
    connectToMatch({
      matchUuid: r.matchUuid, joinCode: r.joinCode, seat: r.seat, seatToken: r.seatToken,
      rulesetId: r.rulesetId, matchFormat: r.matchFormat, creator: true,
    });
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "create table ▸"; }
    const err = document.getElementById("createErr");
    if (err) err.innerHTML = `<b style="color:var(--danger)">${describeError(e)}</b>`;
  }
}

/** `prefill`: the code from a `/j/<code>` deep link — see `boot()`. */
function joinScreen(prefill = ""): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").innerHTML = `
    <h1>Join a table</h1>
    <p class="mut">Enter the code the table's creator was shown.</p>
    <div class="setrow"><input id="codeIn" type="text" maxlength="10" autocapitalize="characters"
      placeholder="join code" value="${esc(prefill)}" style="flex:1;padding:9px 12px;font-size:18px;letter-spacing:.08em;
      text-transform:uppercase;border-radius:9px;background:rgba(255,255,255,.07);
      border:1px solid rgba(255,255,255,.18);color:var(--ink)"></div>
    <button id="btnJoin">join ▸</button>
    <button id="btnLobby" style="margin-left:8px;background:rgba(255,255,255,.08)">◂ lobby</button>
    <p class="mut" id="joinErr"></p>`;
  const input = document.getElementById("codeIn") as HTMLInputElement;
  input.focus();
  if (prefill) input.select();
  const go = async (): Promise<void> => {
    if (!identity) return;
    const code = input.value.trim();
    if (!code) { input.focus(); return; }
    const btn = document.getElementById("btnJoin") as HTMLButtonElement;
    btn.disabled = true; btn.textContent = "joining…";
    try {
      const r = await joinTable(identity.deviceToken, code);
      connectToMatch({
        matchUuid: r.matchUuid, joinCode: code, seat: r.seat, seatToken: r.seatToken,
        rulesetId: r.rulesetId, matchFormat: r.matchFormat,
      });
    } catch (e) {
      btn.disabled = false; btn.textContent = "join ▸";
      const err = document.getElementById("joinErr");
      if (err) err.innerHTML = `<b style="color:var(--danger)">${describeError(e)}</b>`;
    }
  };
  (document.getElementById("btnJoin") as HTMLButtonElement).onclick = () => void go();
  input.onkeydown = (e) => { if (e.key === "Enter") void go(); };
  wireBack(lobbyScreen);
}

function statsScreen(): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").innerHTML = `<h1>Your games</h1><p class="mut">reading…</p>`;
  if (!identity) { lobbyScreen(); return; }
  void listMatches(identity.deviceToken, { limit: 40 }).then((r) => {
    const rows: MatchListItem[] = r.matches;
    const finished = rows.filter((m) => m.status === "complete");
    const chips = finished.reduce((s, m) => s + (m.finalChips ?? 0), 0);
    const wins = finished.filter((m) => m.place === 1).length;
    $("panel").innerHTML = `
      <h1>Your games</h1>
      ${rows.length === 0 ? "<p>Nothing recorded yet.</p>" : `
      <div class="statgrid">
        <div><span>${finished.length}</span>finished</div>
        <div><span>${wins}</span>wins</div>
        <div><span>${fmtChips(chips)}</span>chips</div>
      </div>
      <div class="rows">${rows.map((m) => `
        <div class="row"><span class="c1">${new Date(m.startedAt).toLocaleDateString()} ·
          ${m.matchFormat} · ${m.rulesetId}${m.status !== "complete" ? ` · <b>${m.status}</b>` : ""}</span>
          <span class="c2">${m.handCount}h</span>
          <span class="c2 ${(m.finalChips ?? 0) > 0 ? "up" : (m.finalChips ?? 0) < 0 ? "down" : ""}">${m.finalChips === null ? "—" : fmtChips(m.finalChips)}</span>
          <span class="c2">${m.place ? `#${m.place}` : "—"}</span></div>`).join("")}</div>`}
      ${backRow()}`;
    wireBack(lobbyScreen);
  }).catch(() => {
    $("panel").innerHTML = `<h1>Your games</h1><p class="mut">could not reach the server.</p>${backRow()}`;
    wireBack(lobbyScreen);
  });
}

/* ── stats and leaderboard (PVP-LOBBY-PROPOSAL-2026-09-02.md §6 decision 6,
 * §7.2's last two bullets) ────────────────────────────────────────────────
 * `statsBodyHtml` is the one layout shared by "Your stats" (own totals) and
 * "Player" (someone else's, tapped from the leaderboard, Here now, or a
 * match's own scoreboard) — same numbers, same GET /api/players/:id/stats
 * shape, only the page framing around it differs. */

function statTilesHtml(t: PlayerStatsTotals): string {
  const tiles: [string, string][] = [
    [String(t.matches), "matches"],
    [String(t.wins), "wins"],
    [t.avgFaan === null ? "—" : t.avgFaan.toFixed(1), "avg faan"],
    [fmtChips(t.netChips), "net chips"],
    [String(t.handsWon), "hands won"],
    [String(t.selfDraws), "self-draws"],
    [String(t.dealIns), "deal-ins"],
  ];
  // Grading is a web-only feature (owner's ruling — see `agreementLine`
  // above): the number itself is server truth either way, only the DISPLAY
  // is gated, same rule as the match-end screen's "how you played it".
  if (isDesktop() && t.agreement !== null) tiles.push([`${Math.round(t.agreement * 100)}%`, "engine agreement"]);
  return `<div class="statgrid">${tiles.map(([v, l]) => `<div><span>${v}</span>${l}</div>`).join("")}</div>`;
}

function placeBarsHtml(places: readonly [number, number, number, number]): string {
  const max = Math.max(1, ...places);
  return `<div class="placebars">${places.map((n, i) => `
    <div class="prow"><span class="plabel">#${i + 1}</span>
      <span class="ptrack"><span class="pfill" style="width:${Math.round((n / max) * 100)}%"></span></span>
      <span class="pcount">${n}</span></div>`).join("")}</div>`;
}

function recentMatchRowHtml(m: PlayerStatsRecentMatch): string {
  const delta = m.ratingDelta === null ? "" :
    ` <b class="${m.ratingDelta > 0 ? "up" : m.ratingDelta < 0 ? "down" : ""}">${m.ratingDelta > 0 ? "+" : ""}${m.ratingDelta}</b>`;
  return `<div class="row"><span class="c1">${m.endedAt ? new Date(m.endedAt).toLocaleDateString() : "—"}
      <span class="badge ${m.mode}">${m.mode}</span>${delta}</span>
    <span class="c2">${m.place ? `#${m.place}` : "—"}</span>
    <span class="c2 ${m.chips > 0 ? "up" : m.chips < 0 ? "down" : ""}">${fmtChips(m.chips)}</span></div>`;
}

/** Inline SVG only — drawn once per render, no animation loop, and only when
 *  there is more than one point to connect (task spec item 4). Oldest to
 *  newest, left to right; `ratingHistory` itself is newest-first on the wire. */
function sparklineSvg(oldestToNewest: number[]): string {
  if (oldestToNewest.length < 2) return "";
  const w = 280, h = 56, pad = 5;
  const min = Math.min(...oldestToNewest);
  const max = Math.max(...oldestToNewest);
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (oldestToNewest.length - 1);
  const pts = oldestToNewest
    .map((v, i) => `${(pad + i * stepX).toFixed(1)},${(pad + (h - pad * 2) * (1 - (v - min) / span)).toFixed(1)}`)
    .join(" ");
  const rising = oldestToNewest[oldestToNewest.length - 1]! >= oldestToNewest[0]!;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="display:block;margin-top:6px">
    <polyline points="${pts}" fill="none" stroke="${rising ? "#7fe0a4" : "#ff9b93"}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function statsBodyHtml(stats: PlayerStats): string {
  const p = stats.player;
  const ratingLine = p.rating === null
    ? `<span class="mut">unrated</span>`
    : `${Math.round(p.rating)}${p.provisional ? ` <span class="mut">(provisional)</span>` : ""}`;
  const spark = sparklineSvg([...stats.ratingHistory].reverse().map((r) => r.after));
  return `
    <p class="mut">rating <b style="color:var(--gold)">${ratingLine}</b></p>
    ${statTilesHtml(stats.totals)}
    <h2 style="margin-top:14px">Placement</h2>
    ${placeBarsHtml(stats.totals.places)}
    ${spark ? `<h2 style="margin-top:14px">Rating over time</h2>${spark}` : ""}
    <h2 style="margin-top:14px">Recent matches</h2>
    <div class="rows">${stats.recent.length === 0
      ? `<p class="mut">nothing finished yet</p>`
      : stats.recent.map(recentMatchRowHtml).join("")}</div>`;
}

function yourStatsScreen(): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").innerHTML = `<h1>Your stats</h1><p class="mut">reading…</p>`;
  if (!identity) { lobbyScreen(); return; }
  void getMyStats(identity.deviceToken).then((stats) => {
    $("panel").innerHTML = `
      <h1>Your stats</h1>
      <p class="mut">Playing as <b>${esc(stats.player.displayName)}</b></p>
      ${statsBodyHtml(stats)}
      <p class="mut" style="margin-top:10px"><a href="#" id="goLb" style="color:var(--gold)">leaderboard ▸</a></p>
      ${backRow()}`;
    const lb = document.getElementById("goLb");
    if (lb) lb.onclick = (e) => { e.preventDefault(); leaderboardScreen("ranked"); };
    wireBack(lobbyScreen);
  }).catch(() => {
    $("panel").innerHTML = `<h1>Your stats</h1><p class="mut">could not reach the server.</p>${backRow()}`;
    wireBack(lobbyScreen);
  });
}

/** Reached from the leaderboard, the lobby's Here now list, or a match's own
 *  scoreboard — `back` is wherever the tap came from, so "◂ back" returns
 *  there rather than always to the lobby. */
function playerScreen(playerId: string, back: () => void): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").innerHTML = `<h1>Player</h1><p class="mut">reading…</p>`;
  if (!identity || !playerId) { back(); return; }
  const self = playerId === identity.playerId;
  void getPlayerStats(identity.deviceToken, playerId).then((stats) => {
    $("panel").innerHTML = `
      <h1>${esc(stats.player.displayName)}${self ? ` <span class="mut">(you)</span>` : ""}</h1>
      ${statsBodyHtml(stats)}
      ${backRow()}`;
    wireBack(back);
  }).catch(() => {
    $("panel").innerHTML = `<h1>Player</h1><p class="mut">could not reach the server.</p>${backRow()}`;
    wireBack(back);
  });
}

function leaderboardModeToggleHtml(mode: LeaderboardMode): string {
  return `<div class="seg">
    <button class="${mode === "ranked" ? "on" : ""}" data-lb="ranked"><b>Ranked</b><span>by rating</span></button>
    <button class="${mode === "casual" ? "on" : ""}" data-lb="casual"><b>Casual</b><span>by record</span></button>
  </div>`;
}

function leaderboardRowHtml(rank: number, e: RankedLeaderboardEntry | CasualLeaderboardEntry, mode: LeaderboardMode): string {
  if (mode === "ranked") {
    const r = e as RankedLeaderboardEntry;
    return `<div class="row clickable" data-player="${esc(r.playerId)}">
      <span class="c1">${rank}. ${esc(r.displayName)}</span>
      <span class="c2">${Math.round(r.rating)}${r.provisional ? "*" : ""}</span></div>`;
  }
  const c = e as CasualLeaderboardEntry;
  const agree = isDesktop() && c.agreement !== null ? ` <span class="mut">· ${Math.round(c.agreement * 100)}%</span>` : "";
  return `<div class="row clickable" data-player="${esc(c.playerId)}">
    <span class="c1">${rank}. ${esc(c.displayName)}${agree}</span>
    <span class="c2">${c.wins}-${c.matches - c.wins}</span></div>`;
}

function wireLeaderboardPanel(mode: LeaderboardMode): void {
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seg button[data-lb]"))) {
    el.onclick = () => leaderboardScreen(el.dataset.lb as LeaderboardMode);
  }
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".row[data-player]"))) {
    el.onclick = () => { const id = el.dataset.player!; playerScreen(id, () => leaderboardScreen(mode)); };
  }
  wireBack(lobbyScreen);
}

/** The two overloads of `getLeaderboard` (net.ts) exist so a caller with a
 *  LITERAL mode gets the matching entry shape typed; this screen's mode is a
 *  runtime value, so it branches once here rather than casting past the
 *  overloads (which would let a "casual" call through the "ranked" typing). */
async function fetchLeaderboard(
  token: string,
  mode: LeaderboardMode,
): Promise<(RankedLeaderboardEntry | CasualLeaderboardEntry)[]> {
  if (mode === "ranked") return (await getLeaderboard(token, "ranked")).entries;
  return (await getLeaderboard(token, "casual")).entries;
}

function leaderboardScreen(mode: LeaderboardMode): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").innerHTML = `<h1>Leaderboard</h1>${leaderboardModeToggleHtml(mode)}<p class="mut" style="margin-top:10px">reading…</p>`;
  wireLeaderboardPanel(mode);
  if (!identity) return;
  void fetchLeaderboard(identity.deviceToken, mode).then((entries) => {
    $("panel").innerHTML = `
      <h1>Leaderboard</h1>
      ${leaderboardModeToggleHtml(mode)}
      ${mode === "ranked" ? `<p class="mut" style="margin-top:6px">* provisional — still finding its level</p>` : ""}
      <div class="rows" style="max-height:400px">${entries.length === 0
        ? `<p class="mut">nobody yet</p>`
        : entries.map((e, i) => leaderboardRowHtml(i + 1, e, mode)).join("")}</div>
      ${backRow()}`;
    wireLeaderboardPanel(mode);
  }).catch(() => {
    $("panel").innerHTML = `<h1>Leaderboard</h1>${leaderboardModeToggleHtml(mode)}<p class="mut">could not reach the server.</p>${backRow()}`;
    wireLeaderboardPanel(mode);
  });
}

function settingsScreen(back: () => void): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").innerHTML = `
    <h1>Settings</h1>
    <h2 style="margin-top:14px">Table</h2>
    <div class="setrow"><label>Tile size</label>
      <input type="range" id="setScale" min="0.8" max="2" step="0.05" value="${SETTINGS.tileScale}">
      <span id="setScaleV">${Math.round(SETTINGS.tileScale * 100)}%</span></div>
    <h2 style="margin-top:14px">Handicaps</h2>
    <p class="mut">Training wheels. Each only tells you what a careful player could
      work out from the table — nothing hidden is revealed.</p>
    <div class="setrow"><label>Count tiles</label>
      <input type="checkbox" id="hcCount" ${SETTINGS.hcCount ? "checked" : ""}>
      <span class="mut">hover or long-press any tile to light up every copy of it on the table</span></div>
    <div class="setrow"><label>Calling read</label>
      <input type="checkbox" id="hcCalling" ${SETTINGS.hcCalling ? "checked" : ""}>
      <span class="mut">whether you are 聽牌, what you wait on, how many are live, and
        whether the hand can pay</span></div>
    <div class="setrow"><label>What-if</label>
      <input type="checkbox" id="hcWhatIf" ${SETTINGS.hcWhatIf ? "checked" : ""}>
      <span class="mut">hover or long-press a tile in your hand to see what cutting it would leave you
        waiting on (needs the calling read)</span></div>
    <div class="setrow"><label>Dev mode</label>
      <input type="checkbox" id="setDev" ${SETTINGS.dev ? "checked" : ""}>
      <span class="mut">show how the champion would rank your discards and claims</span></div>
    <button id="btnBack">done ▸</button>`;
  const sc = document.getElementById("setScale") as HTMLInputElement;
  sc.oninput = () => { SETTINGS.tileScale = Number(sc.value); $("setScaleV").textContent = `${Math.round(SETTINGS.tileScale * 100)}%`; saveSettings(); if (snap) render(); };
  const dv = document.getElementById("setDev") as HTMLInputElement;
  dv.onchange = () => { SETTINGS.dev = dv.checked; saveSettings(); if (snap) render(); };
  for (const [id, key] of [["hcCount", "hcCount"], ["hcCalling", "hcCalling"], ["hcWhatIf", "hcWhatIf"]] as const) {
    const box = document.getElementById(id) as HTMLInputElement | null;
    if (box) box.onchange = () => { (SETTINGS as never as Record<string, boolean>)[key] = box.checked; saveSettings(); if (snap) render(); };
  }
  (document.getElementById("btnBack") as HTMLButtonElement).onclick = () => { $("veil").style.display = "none"; back(); };
}

/** Feedback used to be a text report POSTed to a Solo-only endpoint. There is
 *  no such endpoint here — instead this copies a small diagnostic blob to the
 *  clipboard (match id, seat, last seq folded in, last 8 feed lines) so a
 *  tester can paste it into wherever they are actually filing the report. */
async function copyDiagnostic(): Promise<void> {
  const blob = {
    matchUuid: currentMatchUuid, seat: mySeat, lastSeq, feed: feed.slice(-8),
    ua: navigator.userAgent, at: new Date().toISOString(),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(blob, null, 2));
    flashHudNote("diagnostic copied — paste it into your report");
  } catch {
    flashHudNote("could not copy — clipboard blocked");
  }
}

/* ── boot ──────────────────────────────────────────────────────────────── */
(document.getElementById("btnFeedback") as HTMLButtonElement).onclick = () => void copyDiagnostic();
(document.getElementById("btnSettings") as HTMLButtonElement).onclick = () => settingsScreen(() => syncVeil());
/** "Leave table" (task item 5): only a live seat needs the confirm and the
 *  server-side `/leave` call — quitting from anywhere else (the lobby, a
 *  finished match's scoreboard) is just "go to the lobby", which `leaveTable`
 *  already does safely with a null `ts`. */
(document.getElementById("btnQuit") as HTMLButtonElement).onclick = () => {
  if (ts && currentMatchUuid && !matchEndInfo) {
    const ok = window.confirm(
      "Leave the table? A bot plays your seat for the rest of the match — you can come back.",
    );
    if (!ok) return;
    void leaveTableAndReturn(currentMatchUuid);
  } else {
    leaveTable();
  }
};
saveSettings();
wireHover();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ts && lastSeq >= 0) ts.resync(lastSeq);
});

async function resumeOrLobby(): Promise<void> {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (raw && identity) {
    try {
      const s = JSON.parse(raw) as { matchUuid: string; joinCode: string | null; seat: SeatIndex; creator?: boolean };
      if (s.joinCode) {
        const r = await joinTable(identity.deviceToken, s.joinCode);
        connectToMatch({
          matchUuid: r.matchUuid, joinCode: s.joinCode, seat: r.seat, seatToken: r.seatToken,
          rulesetId: r.rulesetId, matchFormat: r.matchFormat, creator: s.creator,
        });
        return;
      }
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }
  lobbyScreen();
}

/** `/j/<code>` deep link (task item 4): "go straight to the join flow with
 *  the code filled (after identity), then history.replaceState to /." Read
 *  once at boot, before the URL is rewritten — a resumed session (an active
 *  match in sessionStorage) still loses to an explicit invite link, since
 *  opening one is a deliberate act the task calls out by name. */
function pendingJoinCodeFromUrl(): string | null {
  const m = /^\/j\/([A-Za-z0-9]+)\/?$/.exec(location.pathname);
  return m ? m[1]!.toUpperCase() : null;
}

async function boot(): Promise<void> {
  const joinCode = pendingJoinCodeFromUrl();
  if (joinCode) history.replaceState(null, "", "/");
  const stored = storedIdentity();
  if (stored.deviceToken && stored.displayName) {
    try {
      identity = await identify(stored.displayName);
    } catch {
      identity = { playerId: "", displayName: stored.displayName, rating: null, deviceToken: stored.deviceToken };
    }
    ensurePresenceHeartbeat();
    if (joinCode) joinScreen(joinCode);
    else await resumeOrLobby();
  } else {
    nameScreen(() => (joinCode ? joinScreen(joinCode) : aboutScreen(lobbyScreen)));
  }
}
void boot();

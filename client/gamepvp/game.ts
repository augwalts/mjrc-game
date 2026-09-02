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
  ChatMessagePayload, ChatPhrase, LegalRequests, PausedPayload, PausedState, PresencePayload,
  ProtocolFaultPayload, PromptPayload, RejectCode, RejectedPayload, SeatDirectoryEntry, WelcomePayload,
} from "../../protocol/src/messages.js";
import { CHAT_PHRASES, CHAT_TEXT_MAX_LENGTH } from "../../protocol/src/messages.js";
import {
  ApiError, RequestRejected, TableSocket,
  createRoom, createTable, getLeaderboard, getLobby, getMyRooms, getMyStats, getPlayerStats,
  identify, joinRoom, joinTable,
  leaveTable as apiLeaveTable, listBots, listMatches,
  matchDetail, postLobbyChat, postPresence, startTable as apiStartTable, storedIdentity,
  type BotCatalogueEntry, type CasualLeaderboardEntry, type CreateTableResult, type Identity,
  type LeaderboardMode, type LobbyChatEntry, type LobbyHereEntry, type LobbyPayload,
  type LobbyTable, type LobbyTableSeat, type MatchFormat, type MatchListItem,
  type PlayerStats, type PlayerStatsRecentMatch, type PlayerStatsTotals,
  type RankedLeaderboardEntry, type RoomSummary, type SeatSpec, type TableAccess, type TableMode,
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

/** The meld a claim button would BUILD, drawn as tiles rather than decoded
 *  from a label — ported from the demo (task item 4a). `thrown` (the tile in
 *  play) is marked by POSITION, not value: a pung and a kong are all the same
 *  number, so matching on value would ring every tile in the strip. */
const claimStrip = (tiles: TileId[], thrown: TileId | null): string => {
  const parts = tiles.map((t) => ({ t, got: false }));
  if (thrown !== null) parts.push({ t: thrown, got: true });
  parts.sort((a, b) => a.t - b.t); // stable: the thrown tile stays last among equals
  return `<span class="tw">${parts.map((p) => tileHtml(p.t, p.got ? "got" : "")).join("")}</span>`;
};

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

/* ── chat (PVP-LOBBY-PROPOSAL §8) ─────────────────────────────────────────
 * Two chats (table, lobby), one client-side mute list, shared by both. Chat
 * is never a game event: it never touches `snap`, `pending`, or the reducer
 * — it is pure transport + a couple of small local rings, same discipline as
 * `feed` (decorative). Quick phrases: 好牌 nice · 快啲 hurry · 唔好意思 sorry ·
 * 再嚟 again · 👍 thumbs — `CHAT_PHRASES`/`ChatPhrase` are the wire's stable
 * ids (messages.ts); this is the only place they get Chinese/English prose. */
const CHAT_PHRASE_LABELS: Record<ChatPhrase, [string, string]> = {
  nice: ["好牌", "nice"], hurry: ["快啲", "hurry"], sorry: ["唔好意思", "sorry"],
  again: ["再嚟", "again"], thumbs: ["👍", "thumbs"],
};

/** Local-only, `localStorage`, a set of muted `playerId`s — never sent to the
 *  server (task spec item 4: "local"). Applies to both chats: table chat
 *  resolves a message's seat to a playerId via `directory` at the moment the
 *  message arrives (`chatEntry()` below); lobby chat's rows already carry one. */
const MUTE_KEY = "mjrc.gamepvp.mutedPlayers";
function mutedSet(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(MUTE_KEY) ?? "[]") as string[]); }
  catch { return new Set(); }
}
function setMuted(playerId: string, muted: boolean): void {
  const s = mutedSet();
  if (muted) s.add(playerId); else s.delete(playerId);
  localStorage.setItem(MUTE_KEY, JSON.stringify([...s]));
}
/** Wired onto any `.cname[data-player][data-name]` element in either chat's
 *  rows — a plain `confirm()` (same pattern as the in-game "leave table"
 *  confirm) rather than a custom widget, since this is a rare, low-stakes
 *  toggle. Never offered on your own name (`data-player` is empty for it —
 *  see `chatEntry()`/`LobbyChatEntry` render sites). */
function wireMuteTaps(container: ParentNode): void {
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(".cname[data-player]"))) {
    const id = el.dataset.player;
    if (!id) continue;
    el.onclick = (e) => {
      e.stopPropagation();
      const nm = el.dataset.name ?? "this player";
      const already = mutedSet().has(id);
      if (!window.confirm(already ? `Unmute ${nm}?` : `Mute ${nm}? You won't see their chat messages.`)) return;
      setMuted(id, !already);
      renderTableChat();
      paintLobbyPanel("chat", true);
    };
  }
}

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
let presenceHeartbeatTimer = 0;
function ensurePresenceHeartbeat(): void {
  if (presenceHeartbeatStarted) return;
  presenceHeartbeatStarted = true;
  const beat = (): void => {
    if (identity) void postPresence(identity.deviceToken, "lobby").catch(() => { /* best effort */ });
  };
  // The interval itself stops while the tab is hidden — not just a guard
  // inside `beat()` that skips the network call — so a backgrounded tab
  // truly stops ticking, not just stops sending. Resuming beats immediately
  // rather than waiting out the rest of a stale 30s window.
  const startTicking = (): void => {
    if (presenceHeartbeatTimer) return;
    presenceHeartbeatTimer = window.setInterval(beat, 30_000);
  };
  const stopTicking = (): void => {
    window.clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = 0;
  };
  if (document.visibilityState === "visible") startTicking();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { beat(); startTicking(); } else { stopTicking(); }
  });
}

/* ── the live table ────────────────────────────────────────────────────
 * `snap` is this seat's redacted fold, replaced whole every time the server
 * sends one (never mutated field-by-field). `mySeat` is 0-3, whichever this
 * player was seated at — everything that used to assume "HUMAN is seat 0"
 * now reads `mySeat` and converts to a SCREEN position with `rel()`.       */
let ts: TableSocket | null = null;
let snap: SeatVisible<SeatSnapshot> | null = null;
let directory: FourSeats<SeatDirectoryEntry> | null = null;
/** What the waiting room shows BEFORE `directory` lands (the socket's
 *  `welcome` message is a round trip away). `createTable` already told this
 *  client its own seat plan (the request body it just sent); `joinTable`
 *  did not, so that path falls back to this match's row in `lobbyData`, if
 *  the lobby happens to have one cached. Either way this is only ever a
 *  seed — `directory`/`presence` are authoritative the moment they arrive,
 *  see `seatWaitInfo()`. */
interface SeatPlanEntry { bot: boolean; displayName?: string; }
let seatPlan: FourSeats<SeatPlanEntry> | null = null;
const presence: Partial<Record<SeatIndex, { connected: boolean; botActing: boolean }>> = {};
let mySeat: SeatIndex = 0;
let lastSeq = -1;
let currentMatchUuid: string | null = null;
let currentJoinCode: string | null = null;
let currentRulesetId = "mjrc-standard";
let currentMatchFormat: MatchFormat = "east";

/* ── pause + auto-play ─────────────────────────────────────────────────
 * `paused` mirrors the server's `paused` broadcast (and `welcome`/`restore`'s
 * own seed of it, `PausedState`) exactly: non-null means the table is frozen
 * for everyone, by whoever is named in it. `myAuto` mirrors this SEAT's own
 * auto-play flag — authoritative from `presence`, but also flipped off the
 * instant this client sends any game request ("the server does this too;
 * mirror it locally on send" — a UI-responsiveness exception to the
 * no-optimism doctrine, not a game-state prediction). */
let paused: PausedState | null = null;
let myAuto = false;

/* ── table chat state (§8) ─────────────────────────────────────────────
 * `tableChat` mirrors the table's own last-50 ring (server-side, table.ts) —
 * replaced whole on `welcome`/`restore` (`onChatHistory`), appended to on a
 * live `chat` (`onChat`), capped at 50 here too so a long-running reconnect
 * never grows it past what the server itself would show. `playerId` is
 * resolved from `directory` AT ARRIVAL TIME (the wire's `ChatMessagePayload`
 * carries only `seat`) — see `chatEntry()`. */
interface ChatEntry extends ChatMessagePayload { playerId: string; }
let tableChat: ChatEntry[] = [];
/** "Messages of the current hand shown by default" (task spec item 2) — the
 *  timestamp of the most recent `deal` this session has animated, or 0 (the
 *  dawn of time) before the first one, so a cold join's whole history counts
 *  as "this hand" until a real deal is seen. */
let handStartTs = 0;
let chatShowAll = false;
/** Mobile-only drawer state; always true (and irrelevant to the badge) on
 *  desktop, where the panel is open beside the table by CSS alone. */
let chatOpen = false;
let chatUnread = 0;
const chatEntry = (p: ChatMessagePayload): ChatEntry =>
  ({ ...p, playerId: directory?.[p.seat]?.playerId ?? "" });

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

/* ── hand-end reveal (task brief item 1) ──────────────────────────────────
 * `overlay` above IS the reveal's content once a hand ends — this block is
 * just the state around it: when it may auto-close, and what this seat has
 * captured from the hand-ending events to build it (the win/selfDraw event
 * carries the winner's hand, `handEnd` carries the chips — they land in the
 * same batch, so a `pending*` value never survives past one hand-end). */
/** unix ms from `handEnd`'s `nextHandTs` (events.ts: absent when the table
 *  advances at once — no human connected, or the intermission is disabled —
 *  and also true of an older server that never stamps it at all). `null`
 *  here means either: fall back to a fixed hold rather than a countdown. */
let revealDeadlineTs: number | null = null;
let revealTimer = 0;
/** This seat already sent `requestNextHand` for the hand now revealing. */
let revealRequested = false;
interface PendingWinDetail {
  seat: SeatIndex; selfDraw: boolean; from: SeatIndex | null; winningTile: TileId;
  concealed: TileId[]; melds: Meld[];
  faan: number; rawFaan: number; capped: boolean; awards: { id: string; faan: number }[];
}
let pendingWinDetail: PendingWinDetail | null = null;
/** Own distance-to-ready at an exhaustive draw — the redacted payload only
 *  ever tells a seat its OWN value (§5.3), so this is never set for anyone
 *  else's row in the 流局 reveal. */
let pendingDrawDistance: number | null = null;
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
/** `directory[s].displayName` is `""` for an unfilled human seat (protocol
 *  doc comment on `PresencePayload`) — `||`, not `??`, so an empty string
 *  falls through to the placeholder same as a missing entry. */
const seatName = (s: SeatIndex): string =>
  s === mySeat ? (identity?.displayName ?? "You") : (directory?.[s]?.displayName || `seat ${s}`);

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
  tileScale: 1, dev: false, hcCount: true, hcCalling: false, hcWhatIf: false,
  ...JSON.parse(localStorage.getItem("mjrc.gamepvp.settings") ?? "{}"),
};
/** Saved settings are spread OVER the defaults above, so changing a default
 *  reaches new devices only — a tester who already played carries
 *  hcCount:false forever. This turns it on once for existing devices too and
 *  records that it has done so, so a player who then switches it back off
 *  keeps it off. Ported from the demo (owner 2026-09-01): "it's super
 *  helpful", and it reveals nothing hidden — every copy it lights up is
 *  already face-up on the table. */
if (localStorage.getItem("mjrc.gamepvp.hcCountDefaulted") === null) {
  localStorage.setItem("mjrc.gamepvp.hcCountDefaulted", "1");
  SETTINGS.hcCount = true;
  localStorage.setItem("mjrc.gamepvp.settings", JSON.stringify(SETTINGS));
}
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

/** Task brief item 2 (2026-09-02 live demo): "win → resize → popup vanishes,
 *  player stuck". A resize/orientation change must NEVER clear an
 *  overlay/veil — only an explicit close (a button's own onclick) may. This
 *  mirrors the DESKTOP listener just above, which already gets this right:
 *  re-render the table under whatever is showing, then resync the veil so it
 *  stays exactly what it was (paused / hand-end reveal / matchEnd / waiting
 *  room) — never reset to "none". Neither `render()` nor `syncVeil()` ever
 *  touches `overlay`/`matchEndInfo`/`paused` themselves (audited below), so
 *  this can never be the thing that drops a popup.
 *
 *  Debounced: iOS fires a burst of `resize` while the address bar
 *  hides/shows on scroll, and a rotation fires both `resize` and
 *  `orientationchange` for the same physical event — one coalesced re-render
 *  is enough, and it also keeps width-dependent layout (the pile's
 *  `--pileth`, computed from `pileEl.clientWidth` in `render()`) current,
 *  which nothing previously did on a resize at all. */
let viewportSyncTimer = 0;
const onViewportChange = (): void => {
  window.clearTimeout(viewportSyncTimer);
  viewportSyncTimer = window.setTimeout(() => {
    if (snap) render();
    syncVeil();
  }, 120);
};
window.addEventListener("resize", onViewportChange);
window.addEventListener("orientationchange", onViewportChange);

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

/* ── motion queue (task brief item 4) ─────────────────────────────────────
 * THE PROBLEM: a discard's toss and the very next seat's draw can land in
 * the SAME batch — `applyBatch()` consumes the discard event (which only
 * marks `pileTiles`, no DOM yet) and replaces `snap` (which already shows
 * the next seat holding a drawn tile) BEFORE the one `render()` call that
 * creates both DOM nodes. Both animations used to start at frame 0
 * together — two motions competing for one pair of eyes. This client never
 * had a fix for it; only the CSS half (`--tossdelay`/`--drawdelay` custom
 * properties) existed, unused, defaulting to 0ms everywhere.
 *
 * RULE: a draw queues BEHIND the most recent toss, by delay, never by
 * gating — the element exists and is clickable immediately (`backwards`
 * fill mode holds it at frame 0 until its delay elapses), so no affordance
 * is ever taken away by an animation.
 *
 * `TOSS_MS`/the toss's own easing (`cubic-bezier(.15,0,.85,.85)`, index.html
 * `#pile .tile.fresh`) are the owner's `discard-lab.html` trial, revised
 * 2026-09-02: a short push off the finger for the first ~15% of 380ms, then
 * constant speed, then a dead stop exactly on the tile's slot — ONE motion
 * to ONE destination decided before the toss starts (see the pile-placement
 * loop below), never a second leg to correct a landing spot. Since the toss
 * no longer has an early "settled" plateau the old three-phase keyframe
 * did, a queued draw simply waits out the toss's FULL duration, not some
 * fraction of it. */
const TOSS_MS = 380;
const DRAW_MS = 900;
/** When the most recent toss started (`performance.now()`), so a draw that
 *  lands in the same render pass — or the very next one — queues behind it
 *  instead of racing it. Far in the past at boot, so the first draw of a
 *  match never waits on a toss that never happened. */
let lastTossAt = -1e9;
const queueBehindToss = (): number => Math.max(0, Math.round(lastTossAt + TOSS_MS - performance.now()));

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
let clockDeadline = 0, clockTotalMs = 1, clockRaf = 0, clockPausedAt = 0;
function clockTick(): void {
  const remain = clockDeadline - Date.now();
  const frac = Math.min(1, Math.max(0, remain / clockTotalMs));
  $("clock").style.width = `${frac * 100}%`;
  $("clock").className = frac < 0.2 ? "low" : "";
  if (remain <= 0) { clockRaf = 0; return; }
  clockRaf = requestAnimationFrame(clockTick);
}
/** `deadlineTs === 0` (task brief item 4's last bullet) is the server's "no
 *  clock" sentinel for this prompt — not a real Unix-ms deadline in 1970.
 *  Starting the rAF loop against it used to leave `#clockbar`'s own 3px
 *  track visible (unfilled, briefly tinted `.low` for one frame) even though
 *  nothing is actually counting down; this hides the track outright instead,
 *  same as `stopClock()`'s "not your turn" case already leaves it (unfilled
 *  but visible) — a real deadline always un-hides it via `startClock`. */
function startClock(deadlineTs: number): void {
  if (deadlineTs === 0) { stopClock(); $("clockbar").style.display = "none"; return; }
  $("clockbar").style.display = "";
  clockDeadline = deadlineTs;
  clockTotalMs = Math.max(1, deadlineTs - Date.now());
  cancelAnimationFrame(clockRaf);
  clockRaf = requestAnimationFrame(clockTick);
}
function stopClock(): void {
  cancelAnimationFrame(clockRaf);
  clockRaf = 0;
  clockPausedAt = 0;
  $("clock").style.width = "0%";
  $("clock").className = "";
}
/** Pause (task brief item 2): "clocks stop ticking (freeze the countdown
 *  display)". Cancels the rAF loop but leaves the bar painted where it was —
 *  `thawClock()` below shifts `clockDeadline` forward by however long the
 *  freeze lasted, so the remaining time reads the same on resume regardless
 *  of what the server does with the underlying deadline. If a fresh `prompt`
 *  arrives instead (the more likely server behaviour), `startClock()` just
 *  overwrites this outright — nothing here needs to be "correct", only not
 *  to keep ticking while the table is frozen. */
function freezeClock(): void {
  if (clockRaf) { clockPausedAt = Date.now(); cancelAnimationFrame(clockRaf); clockRaf = 0; }
}
function thawClock(): void {
  if (clockPausedAt) {
    clockDeadline += Date.now() - clockPausedAt;
    clockPausedAt = 0;
    cancelAnimationFrame(clockRaf);
    clockRaf = requestAnimationFrame(clockTick);
  }
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

function consume(events: readonly RedactedGameEvent[]): void {
  for (const e of events) {
    const p = e.payload as unknown as Record<string, unknown>;
    switch (e.type) {
      case "deal":
        // Any reveal for the hand that just ended is done its job the moment
        // a new deal lands (applyBatch() below is what actually withholds
        // this event from `consume()` until the reveal has closed — this is
        // just belt-and-braces for the first hand of a match, when neither
        // ever ran).
        window.clearTimeout(revealTimer);
        revealTimer = 0; revealDeadlineTs = null; revealRequested = false;
        overlay = null;
        pileTiles = []; handSig = ""; landingMeld = null;
        $("say").className = "";
        buildWall();
        // "this hand"'s chat filter (§8 task item 2) anchors here — a fresh
        // deal is the one unambiguous hand boundary a seat socket ever sees.
        handStartTs = e.ts;
        renderTableChat();
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
        const ctx = p.context as { seat: SeatIndex; selfDraw: boolean; from: SeatIndex | null; winningTile: TileId };
        const sc = p.score as { faan: number; rawFaan: number; capped: boolean; awards: { id: string; faan: number }[] };
        announce(ctx.selfDraw ? "selfDraw" : "win", seatName(ctx.seat), `${sc.faan} faan`, rel(ctx.seat));
        // The full reveal (tiles, awards, chips, standings) is built once, at
        // `handEnd` below — this event only ever carries the winner's hand,
        // and `handEnd` always lands in the same batch right after it.
        pendingWinDetail = {
          seat: ctx.seat, selfDraw: ctx.selfDraw, from: ctx.from, winningTile: ctx.winningTile,
          concealed: [...((p.concealed as TileId[]) ?? [])], melds: (p.melds as Meld[]) ?? [],
          faan: sc.faan, rawFaan: sc.rawFaan, capped: sc.capped, awards: sc.awards,
        };
        pendingHandOutcome = { winner: ctx.seat, selfDraw: ctx.selfDraw, from: ctx.from, faan: sc.faan };
        break;
      }
      case "exhaustiveDraw": {
        // Own value only — RedactedExhaustiveDrawPayload nulls every other
        // seat's (§5.3); the reveal falls back to a tile count for those.
        const dist = (p.distanceToReady as (number | null)[] | undefined)?.[mySeat];
        pendingDrawDistance = dist ?? null;
        pendingHandOutcome = { winner: null, selfDraw: false, from: null, faan: 0 };
        break;
      }
      case "handEnd": {
        const st = p.standings as number[];
        const d = p.chipDeltas as number[] | undefined;
        // `HandEndPayload.nextHandTs` (events.ts) — absent when the table
        // advances at once (no human connected, or the intermission is
        // disabled); an older server omitting the field entirely reads the
        // same way. Either way `startReveal()` below falls back to a fixed
        // hold rather than a countdown.
        const nextHandTs = p.nextHandTs as number | undefined;
        sessionHands.push({
          n: sessionHands.length + 1,
          ...(pendingHandOutcome ?? { winner: null, selfDraw: false, from: null, faan: 0 }),
          deltas: d ?? [0, 0, 0, 0],
        });

        const win = pendingWinDetail;
        let head: string;
        if (win) {
          const mine = win.seat === mySeat;
          // `concealed` excludes `winningTile` on BOTH paths (events.ts
          // WinPayload's own doc comment) — append it, marked, rather than
          // leaving it out of the reveal entirely.
          const tiles = win.concealed.slice().sort((a, b) => a - b).map((t) => tileHtml(t, "sm"));
          tiles.push(tileHtml(win.winningTile, "sm win-tile"));
          const capNote = win.capped ? ` <span class="mut">(capped from ${win.rawFaan})</span>` : "";
          head = `<h1>${mine ? "You win! 食糊" : seatName(win.seat) + " wins"}</h1>
            <h2>${win.faan} faan${capNote} · ${win.selfDraw ? "自摸 self-draw"
              : win.from === mySeat ? "off YOUR discard" : "食糊 on a discard"}</h2>
            <div class="tiles">${tiles.join("")}
              ${win.melds.map((m) => `<span style="width:8px"></span>` + meldHtml(m, "sm")).join("")}</div>
            <div class="awards">${win.awards.map((a) => `${AWARDS[a.id] ?? a.id} <b>${a.faan}</b>`).join(" &nbsp;·&nbsp; ")}</div>`;
        } else {
          const distLine = pendingDrawDistance === null ? ""
            : pendingDrawDistance <= 0 ? `<p><span class="ok" style="color:#7fe0a4">you were 聽牌 — ready</span></p>`
            : `<p class="mut">you were ${pendingDrawDistance} away from ready</p>`;
          head = `<h1>流局</h1><h2>The wall ran out — nobody wins</h2>${distLine}
            <div class="rows">${[0, 1, 2, 3].map((i) => {
              const s = snap?.seats[i as SeatIndex];
              const n = s ? s.handCount + (s.holdingDrawn ? 1 : 0) : 0;
              return `<div class="row"><span class="c1">${seatName(i as SeatIndex)}</span>
                <span class="c2">${n} tiles</span></div>`;
            }).join("")}</div>`;
        }
        overlay = head + `<div class="pay">${[0, 1, 2, 3].map((i) => `
          <div>${seatName(i as SeatIndex)}<br>
            <span class="d ${d && d[i]! > 0 ? "up" : d && d[i]! < 0 ? "down" : ""}">${d ? (d[i]! > 0 ? "+" : "") + d[i] : ""}</span>
            <span style="opacity:.6"> → ${st[i]}</span></div>`).join("")}</div>`;

        pendingHandOutcome = null; pendingWinDetail = null; pendingDrawDistance = null;
        startReveal(typeof nextHandTs === "number" ? nextHandTs : null);
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

/** Arms the reveal's own close timer — a live countdown to `deadlineTs` when
 *  the server sent one, or a fixed hold when it didn't (no `nextHandTs`: an
 *  older server, or the table is advancing at once — either way there is
 *  nothing to count down to). Either way this is the ONLY thing that may
 *  close the reveal on its own; a new-hand batch arriving early closes it
 *  too, but that path is `applyBatch()` below, not this timer. */
function startReveal(deadlineTs: number | null): void {
  window.clearTimeout(revealTimer);
  revealDeadlineTs = deadlineTs;
  revealRequested = false;
  if (deadlineTs !== null) {
    // A 1Hz interval while the reveal is up, not a rAF loop — the client's
    // "zero idle animation frames" rule (see the clock above) is about
    // continuous per-frame work, not a bounded once-a-second repaint tied to
    // a screen that is actually showing.
    revealTimer = window.setInterval(() => {
      if (Date.now() >= deadlineTs) { closeReveal(); render(); syncVeil(); return; }
      if (overlay) showOverlay();
    }, 1000);
  } else {
    revealTimer = window.setTimeout(() => { closeReveal(); render(); syncVeil(); }, 6000);
  }
}
/** Clears the reveal's own state. Does NOT render/sync — every caller does
 *  that itself right after, since `applyBatch()`'s caller is about to anyway. */
function closeReveal(): void {
  window.clearTimeout(revealTimer);
  revealTimer = 0;
  overlay = null;
  revealDeadlineTs = null;
  revealRequested = false;
}

function applyBatch(events: readonly RedactedGameEvent[], snapshot: SeatVisible<SeatSnapshot> | null): void {
  const fresh = events.filter((e) => e.seq > lastSeq);
  // The reveal overlay owns the table between a handEnd and the next deal
  // (task brief item 1: "do NOT apply the next hand's deal events or
  // snapshot to the table while the overlay is up"). A hand only ever OPENS
  // on `deal` (the log format enforces it — see events.ts's
  // assertEventStreamWellFormed), so a fresh batch whose first event is a
  // `deal` is exactly "a batch that starts a new hand". Its arrival is
  // itself one of the reveal's own close conditions — the server would not
  // have sent it if the intermission were not genuinely over, whether by
  // full countdown or everyone tapping early — so this closes the reveal
  // and falls straight through to applying the batch, rather than holding it
  // any longer once that proof has arrived.
  if (overlay && fresh.length && fresh[0]!.type === "deal") closeReveal();
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
  // Pause (task brief item 2) takes the table over completely, whatever else
  // is showing — it can land mid-hand, mid-reveal, anywhere.
  if (paused) { showPausedScreen(); return; }
  // The reveal comes BEFORE matchEnd: a match's last hand still gets its own
  // reveal, and only once that closes does the scoreboard follow (task brief
  // item 1's closing line) — the old order here showed the scoreboard first
  // and skipped the last hand's reveal entirely.
  if (overlay) { showOverlay(); return; }
  if (matchEndInfo) { showMatchEndScreen(); return; }
  if (snap && directory && !humansConnected() && !(pending && pending.length > 0)) { waitingRoomScreen(); return; }
  $("veil").style.display = "none";
}
/** The hand-end reveal (task brief item 1). `revealDeadlineTs` present means
 *  the server stamped `nextHandTs` — show a live countdown and no manual
 *  dismiss; absent (an older server) falls back to a plain "continue" tap,
 *  same as the fixed 6s hold `startReveal()` already armed for that case. */
function showOverlay(): void {
  $("veil").style.display = "flex";
  const countdown = revealDeadlineTs !== null
    ? `<p class="mut">next hand in ${Math.max(0, Math.ceil((revealDeadlineTs - Date.now()) / 1000))}s</p>` : "";
  const nextBtn = revealRequested
    ? `<button id="btnNextHand" disabled style="opacity:.55">waiting for others…</button>`
    : `<button id="btnNextHand">next hand ▸</button>`;
  const contBtn = revealDeadlineTs === null
    ? `<button id="btnCont" style="background:rgba(255,255,255,.08);margin-left:8px">continue ▸</button>` : "";
  $("panel").innerHTML = `${overlay}${countdown}<div style="margin-top:10px">${nextBtn}${contBtn}</div>`;
  const nb = document.getElementById("btnNextHand") as HTMLButtonElement | null;
  if (nb && !revealRequested) {
    nb.onclick = () => {
      revealRequested = true;
      void ts?.requestNextHand().catch(() => { /* best effort — the countdown/deal still closes it */ });
      showOverlay();
    };
  }
  const cb = document.getElementById("btnCont");
  if (cb) (cb as HTMLButtonElement).onclick = () => { closeReveal(); render(); syncVeil(); };
}
function showPausedScreen(): void {
  $("veil").style.display = "flex";
  const who = paused?.displayName || "a player";
  $("panel").innerHTML = `<h1>Paused</h1><p>Paused by <b>${esc(who)}</b></p>
    <button id="btnResume">Resume ▸</button>`;
  const b = document.getElementById("btnResume") as HTMLButtonElement | null;
  if (b) {
    b.onclick = () => {
      void ts?.requestResume().catch((e) =>
        flashHudNote(e instanceof RequestRejected ? (REJECT_NOTES[e.code] ?? e.code) : "that didn't go through"));
    };
  }
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

/** One seat's row in the waiting room. `directory` (from the socket's
 *  `welcome`) is authoritative the moment it exists; before that, `seatPlan`
 *  (seeded at `connectToMatch` — see its doc comment) tells us who's a bot
 *  RIGHT AWAY instead of every seat reading "empty seat / waiting…" for one
 *  round trip. A bot seat is always "connected" — it has no human to wait
 *  on — and so is this device's own seat, the one actually looking at this
 *  screen. */
interface SeatWaitInfo { isMe: boolean; bot: boolean; label: string; connected: boolean; }
function seatWaitInfo(s: SeatIndex): SeatWaitInfo {
  const isMe = s === mySeat;
  const d = directory?.[s];
  const plan = seatPlan?.[s];
  const bot = d?.bot ?? plan?.bot ?? false;
  // `||`, not `??` — an unfilled human seat's `displayName` is `""` on the
  // wire (see `seatName`'s doc comment), which must fall through to the
  // placeholder same as a missing directory entry, not render blank.
  const label = isMe ? "You" : (d?.displayName || plan?.displayName || (bot ? "bot" : "empty seat"));
  const connected = bot || isMe || (presence[s]?.connected ?? d?.connected ?? false);
  return { isMe, bot, label, connected };
}
/** "waiting for N more" counts only unfilled HUMAN seats (task brief) — a
 *  bot seat is never something anyone is waiting on. */
function humanSeatsStillNeeded(): number {
  let n = 0;
  for (let s = 0; s < 4; s++) if (!seatWaitInfo(s as SeatIndex).connected) n++;
  return n;
}

function waitingRoomScreen(): void {
  beforeScreen();
  $("veil").style.display = "flex";
  const needed = humanSeatsStillNeeded();
  $("panel").innerHTML = `
    <h1>Waiting for the table</h1>
    ${currentJoinCode ? `
      <p class="mut">join code</p><h1 style="letter-spacing:.14em;color:var(--gold)">${currentJoinCode}</h1>
      <button id="btnCopyInvite" style="background:rgba(255,255,255,.08)">copy invite link</button>` : ""}
    <div class="rows">${[0, 1, 2, 3].map((s) => {
      const info = seatWaitInfo(s as SeatIndex);
      return `<div class="row ${info.isMe ? "me" : ""}"><span class="c1">${esc(info.label)}</span>
        <span class="c2">${info.bot ? "bot" : info.connected ? "connected" : "waiting…"}</span></div>`;
    }).join("")}</div>
    <p class="mut">waiting for ${needed} more player${needed === 1 ? "" : "s"}</p>
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
    paused = null; myAuto = false;
    closeReveal(); pendingWinDetail = null; pendingDrawDistance = null;
    updateChatVisibility();
    updateHudButtons();
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
  snap = null; directory = null; seatPlan = null; matchEndInfo = null; overlay = null; curLegal = null; pending = null;
  matchAgreement = undefined;
  currentMatchUuid = null; currentJoinCode = null; isCreatorOfCurrentTable = false;
  paused = null; myAuto = false;
  closeReveal(); pendingWinDetail = null; pendingDrawDistance = null;
  stopClock();
  updateChatVisibility();
  updateHudButtons();
  lobbyScreen();
}

/* ── acting: send a request, wait, never mutate on send ────────────────── */
function act(a: Action): void {
  if (!ts) return;
  // Belt-and-braces: the paused veil already blocks every click that could
  // reach a game control (it is a full-screen element on top of the table),
  // so this should be unreachable — but a request sent anyway would just
  // come back `rejected: "paused"` regardless (REJECT_NOTES), so refusing it
  // here is strictly redundant, never a source of a stuck control.
  if (paused) return;
  // Task brief item 3: "any move you make yourself turns [auto] off (the
  // server does this too; mirror it locally on send)" — a UI-responsiveness
  // exception, not a game-state prediction: the label updates immediately
  // and `presence` confirms it a beat later either way.
  if (myAuto) { myAuto = false; updateHudButtons(); }
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
  chatRefused: "that message wasn't sent",
  matchOver: "the match is over",
  pauseRefused: "that didn't go through",
  paused: "the table is paused",
  autoRefused: "auto-play isn't available right now",
};

/* ── render ────────────────────────────────────────────────────────────── */
function plate(seat: SeatIndex, who: string, initial: string): string {
  const s = snap!.seats[seat]!;
  const sign = s.chips > 0 ? "up" : s.chips < 0 ? "down" : "";
  const conn = presence[seat]?.connected ?? s.connected;
  const bot = directory?.[seat]?.bot ?? false;
  // Task brief item 3: auto is server truth for every OTHER seat (directory,
  // via presence) and this seat's own optimistic-on-send mirror for itself.
  const isAuto = seat === mySeat ? myAuto : (directory?.[seat]?.auto ?? false);
  const marker = bot ? "" : isAuto ? '<span class="mut"> · auto</span>'
    : presence[seat]?.botActing ? '<span class="mut"> · bot playing</span>'
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
  // Motion queue (task item 4), same rule as the own hand's drawn tile below
  // — an opponent's draw indicator queues behind the toss most recently
  // placed, rather than always animating at delay 0. `seatBox()` runs before
  // the pile loop each render() pass (same order the demo's own `seatBox`
  // uses), so this reads whichever toss is still settling from the PREVIOUS
  // pass; a toss from THIS pass queues the next render's backrow instead,
  // same as the demo.
  const drawDelay = queueBehindToss();
  return plate(seat, nm, nm[0]!) + `
    <div class="backrow">${Array.from({ length: Math.min(hidden, 14) }, (_, i) =>
      `<span class="back ${i === hidden - 1 && s.holdingDrawn ? "wtnew" : ""}"
         style="--drawdelay:${drawDelay}ms"></span>`).join("")}</div>
    <div class="meldrow">${s.melds.map((m, i) => meldHtml(m,
        `sm ${landingMeld && landingMeld.seat === seat && landingMeld.index === i ? "claimed" : ""}`))
        .join('<span style="width:6px"></span>')}
      ${/* `sm` so a flower matches the melds beside it — the meld tiles in
           this row already carry it; a flower without it came out visibly
           larger than its neighbours (demo port, task item 4c). */""}
      ${s.flowers.map((t) => tileHtml(t, "fl sm")).join("")}</div>`;
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
    // Own seat's origin (r===0) flies from further down than the demo's
    // `[0, 190]`: the claim bar (`#actions`, task item 4a) now sits between
    // the table and the hand, ~60px it never had to clear before (its CSS
    // `min-height:54px` + `margin-top:6px`, always present — see index.html
    // — since the bar shows either buttons or a hint the rest of the time).
    // #surface's 3D tilt (`perspective(1500px) rotateX(17deg)`) rules out
    // measuring the real DOM gap directly: a viewport rect from outside that
    // transformed subtree does not convert linearly into the untransformed
    // local pixels `left`/`top`/`--fx`/`--fy` are all expressed in here, so
    // this is a deliberate constant, not a guess left unexamined.
    const OWN_TOSS_ORIGIN_FY = 190 + 60;
    const from = [[0, OWN_TOSS_ORIGIN_FY], [230, 0], [0, -190], [-230, 0]][r] ?? [0, OWN_TOSS_ORIGIN_FY];
    for (const el of Array.from(pileEl.children)) el.classList.remove("hot");
    // Queue any draw that lands behind this toss (motion queue above) — set
    // BEFORE the element goes in, not after, so a draw rendered later in
    // this same pass (own hand, or an opponent's backrow) already sees it.
    lastTossAt = performance.now();
    // ONE motion straight to the slot (`d.pos`, fixed above and never
    // recomputed once set) — no `--lx`/`--ly`/`--lr` "contact" leg any more,
    // see the `toss` keyframe's own doc comment in index.html.
    pileEl.insertAdjacentHTML("beforeend", tileHtml(d.tile, "pt fresh hot",
      `data-pid="${d.id}" style="left:${d.pos!.x.toFixed(1)}px;top:${d.pos!.y.toFixed(1)}px;`
      + `--fx:${from[0]}px;--fy:${from[1]}px;--fr:${d.pos!.spin.toFixed(0)}deg;`
      + `--rot:${d.pos!.rot.toFixed(1)}deg;--tossms:${TOSS_MS}ms;`
      + `transform:translate(-50%,-50%) rotate(${d.pos!.rot.toFixed(1)}deg)"`));
  }

  const mine = (i: number): string =>
    landingMeld && landingMeld.seat === mySeat && landingMeld.index === i ? "claimed" : "";
  $("mymelds").innerHTML = me.melds.map((m, i) => m.tiles.map((t) => tileHtml(t, mine(i))).join(""))
    .join('<span style="width:10px"></span>')
    + me.flowers.map((t) => tileHtml(t, "fl")).join("");

  // Task brief item 3: auto-play disables this seat's own controls entirely.
  const canDiscard = !!pending?.some((a) => a.type === "discard") && !myAuto;
  const hand = [...me.hand].sort((a, b) => a - b);
  $("myhand").className = canDiscard ? "" : "locked";
  const sig = `${hand.join(",")}|${me.drawn ?? "-"}|${canDiscard}`;
  if (sig !== handSig) {
    handSig = sig;
    // Motion queue (task item 4): if a discard's toss just landed in THIS
    // same render pass (or is still settling from the last one), this draw
    // waits behind it rather than starting in the same frame — see the
    // `queueBehindToss` doc comment above.
    const drawDelay = queueBehindToss();
    $("myhand").innerHTML = hand.map((t) => tileHtml(t, "", `data-t="${t}"`)).join("")
      + (me.drawn !== null
          ? tileHtml(me.drawn, "drawn",
              `data-t="${me.drawn}" style="--drawms:${DRAW_MS}ms;--drawdelay:${drawDelay}ms;`
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

  // The tile currently up for claim — from the snapshot, not client-tracked
  // state (`snap.lastDiscard` is part of `SeatSnapshot` already). Used only
  // to ring it in a claim button's meld preview (demo port, task item 4a);
  // never to decide what is legal — that is still `pending` alone.
  const inPlay = snap.lastDiscard?.tile ?? null;
  let bar = "";
  if (myAuto) {
    bar = `<span class="hint">auto is playing for you</span>`;
  } else if (pending) {
    const btns: string[] = [];
    pending.forEach((a, i) => {
      if (a.type === "discard") return;
      const mk = (label: string, cls = "", tiles = "") =>
        btns.push(`<button class="${cls}" data-i="${i}"><span class="lb">${label}</span>${tiles}</button>`);
      // The WIN button offered here is exactly the win `pending` carries —
      // the server only ever prompts it when it pays (or, on a shape-complete
      // underfloor hand, as the deliberate 教學 refusedWin teaching moment,
      // see events.ts) — so this is presentation only, ported from the demo
      // (task item 4b) with no local faan preview (the client has none).
      if (a.type === "declareWin") mk("WIN 食糊", "win");
      else if (a.type === "pass") mk("pass", "pass");
      // A concealed/added kong is built from your OWN hand — nothing is in
      // play to ring, so all four tiles are drawn plain.
      else if (a.type === "concealedKong") mk("kong 暗槓", "kong", claimStrip([a.tile, a.tile, a.tile, a.tile], null));
      else if (a.type === "addedKong") mk("kong 加槓", "kong", claimStrip([a.tile, a.tile, a.tile, a.tile], null));
      else if (a.type === "claim") {
        const o = a.option;
        if (o.kind === "win") mk("WIN 食糊", "win");
        else if (o.kind === "chow") mk("chow 上", "chow", claimStrip(o.with ?? [], inPlay));
        else if (o.kind === "pung") mk("pung 碰", "pung", inPlay === null ? "" : claimStrip([inPlay, inPlay], inPlay));
        else mk("kong 槓", "kong", inPlay === null ? "" : claimStrip([inPlay, inPlay, inPlay], inPlay));
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
  updateHudButtons();
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

/* ── table chat (§8, reworked 2026-09-02 — task brief item 1) ────────────
 * "Chat must not be a window." The old bottom-sheet drawer (mobile) / pinned
 * sidebar (desktop) is gone — both were a panel with a background that
 * pushed or sat over the table as its own surface. Chat is now ONE round
 * button (`#chatBtn`, bottom-right of the felt, unread badge — unchanged)
 * and, only while tapped open, a fully transparent overlay directly on the
 * felt (`#chatOverlay`): bare translucent text lines with a text-shadow for
 * legibility, no panel background, positioned bottom-right above the button
 * on a phone and top-left (below `#state`) on desktop — see index.html's
 * `@media (min-width:900px) and (pointer:fine)` block. It never pushes the
 * table layout around: both the button and the overlay are `position:
 * absolute` children of `#felt`, exactly like `#state`/`#say`/`#call`, laid
 * OVER the table rather than beside or under it.
 *
 * Tapping the button again, or tapping the felt itself, closes it
 * (`wireChatDrawer()` below). While it is closed, an incoming message shows
 * as a fading translucent line near the button for 4s (`showChatPreviewLine`)
 * and bumps the badge — separate from the existing per-seat phrase bubble
 * (`showChatBubble`/`#chatbubble`, unchanged below), which is a call heard
 * at the TABLE, not a chat notification near the button.
 *
 * The drawer's own DOM is static furniture in index.html, wired ONCE at boot
 * (below) — unlike a screen's `.panel`, this survives every screen change,
 * since it only makes sense while a match exists. `updateChatVisibility()`
 * is what shows/hides it, keyed on `currentMatchUuid`, not on which screen
 * happens to be up. */
const CHAT_BUBBLE_MS = 2500;
let chatBubbleTimer = 0;
/** A phrase from another seat, near their nameplate — same TIMED CLASS SWAP
 *  mechanism as `sayDiscard`/`announce` (no rAF, nothing continuous), on its
 *  own element (`#chatbubble`) so it never fights a discard's own `#say` for
 *  the same slot. `screenPos` is already `rel()`-converted by the caller. */
function showChatBubble(html: string, screenPos: 0 | 1 | 2 | 3): void {
  const el = document.getElementById("chatbubble");
  if (!el) return;
  el.innerHTML = `<div class="inner">${html}</div>`;
  el.className = "";
  void el.offsetWidth;
  el.style.setProperty("--bubblems", `${CHAT_BUBBLE_MS}ms`);
  el.className = `show s${screenPos}`;
  clearTimeout(chatBubbleTimer);
  chatBubbleTimer = window.setTimeout(() => { el.className = ""; }, CHAT_BUBBLE_MS);
}

function chatRowHtml(m: ChatEntry): string {
  const mine = m.seat === mySeat;
  const body = m.phrase
    ? `${CHAT_PHRASE_LABELS[m.phrase][0]} <span class="mut">${CHAT_PHRASE_LABELS[m.phrase][1]}</span>`
    : esc(m.text ?? "");
  // Your own name is never a mute target — `data-player=""` (empty) makes
  // `wireMuteTaps`'s selector skip it, same convention `playerScreen`'s
  // `.pname` rows already use elsewhere in this file.
  return `<div class="crow ${mine ? "mine" : ""}">
    <span class="cname" data-player="${mine ? "" : esc(m.playerId)}" data-name="${esc(m.displayName)}">${esc(m.displayName)}</span>
    <span class="ctext">${body}</span></div>`;
}

/** How many messages the transparent overlay shows at once (task item 1:
 *  "the last ~6 messages"). Independent of the server's own 50-message ring
 *  (`tableChat`'s cap) and of `chatShowAll`'s hand/all filter — both apply
 *  first, then this trims to the tail. */
const CHAT_OVERLAY_ROWS = 6;

/** Repaints the overlay's message list AND the FAB badge — called on every
 *  chat-relevant change (a new message, `chatShowAll`/mute toggling, a fresh
 *  match). Cheap and small (already ≤50 rows before the ~6 trim), so no
 *  diffing needed. Runs regardless of whether the overlay is currently open
 *  — cheap DOM writes behind `display:none` are fine, and it means the list
 *  is already current the instant `setChatOpen(true)` reveals it. */
function renderTableChat(): void {
  const box = document.getElementById("chatMsgs");
  if (box) {
    const muted = mutedSet();
    const visible = tableChat
      .filter((m) => !muted.has(m.playerId) && (chatShowAll || m.ts >= handStartTs))
      .slice(-CHAT_OVERLAY_ROWS);
    box.innerHTML = visible.length === 0
      ? `<p class="mut">${chatShowAll ? "no messages yet" : "nothing this hand yet — try “show all”"}</p>`
      : visible.map(chatRowHtml).join("");
    wireMuteTaps(box);
    // `.chat-msgs` caps at 150px (index.html) — wrapped long lines among the
    // ~6 shown can still overflow it, so pin to the newest (bottom) rather
    // than leaving it scrolled to whatever the browser defaults to (top).
    box.scrollTop = box.scrollHeight;
  }
  // Owned here, not just the click handler — `chatShowAll` is also reset
  // programmatically (a fresh `connectToMatch`), which must not leave the
  // link reading "this hand only" while behaviour has already gone back to
  // filtering.
  const showAll = document.getElementById("chatShowAll");
  if (showAll) showAll.textContent = chatShowAll ? "this hand only" : "show all";
  updateChatBadge();
}
function updateChatBadge(): void {
  const badge = document.getElementById("chatBadge");
  if (!badge) return;
  const show = !chatOpen && chatUnread > 0;
  badge.hidden = !show;
  if (show) badge.textContent = chatUnread > 99 ? "99+" : String(chatUnread);
}
/** Toggles the transparent table overlay — the SAME behaviour on a phone and
 *  on desktop now (task item 1: chat is an overlay everywhere, not a
 *  permanently-pinned sidebar on desktop any more). */
function setChatOpen(open: boolean): void {
  chatOpen = open;
  const overlay = document.getElementById("chatOverlay");
  if (overlay) overlay.style.display = open && currentMatchUuid !== null ? "flex" : "none";
  if (open) { chatUnread = 0; hideChatPreview(); }
  updateChatBadge();
}
/** Shown only while a table exists at all — waiting room through the
 *  post-match scoreboard — never in the lobby or any other screen (the lobby
 *  has its own chat column instead). The button now shows on every
 *  breakpoint; only the overlay's CORNER differs by CSS media query. */
function updateChatVisibility(): void {
  const btn = document.getElementById("chatBtn");
  const show = currentMatchUuid !== null;
  if (btn) btn.style.display = show ? "flex" : "none";
  setChatOpen(show && chatOpen);
}

/** The near-button preview (task item 1): while the overlay is closed, an
 *  incoming message — phrase OR free text, unlike the per-seat
 *  `showChatBubble` above which is phrase-only — fades in as a bare
 *  translucent line next to `#chatBtn` for 4s, no panel, same timed
 *  class-swap technique as `sayDiscard`/`announce`/`showChatBubble`. */
const CHAT_PREVIEW_MS = 4000;
let chatPreviewTimer = 0;
function showChatPreviewLine(html: string): void {
  const el = document.getElementById("chatPreview");
  if (!el) return;
  el.innerHTML = html;
  el.className = "";
  void el.offsetWidth;
  el.style.setProperty("--previewms", `${CHAT_PREVIEW_MS}ms`);
  el.className = "show";
  clearTimeout(chatPreviewTimer);
  chatPreviewTimer = window.setTimeout(() => { el.className = ""; }, CHAT_PREVIEW_MS);
}
function hideChatPreview(): void {
  clearTimeout(chatPreviewTimer);
  const el = document.getElementById("chatPreview");
  if (el) el.className = "";
}
/** The HUD's Pause and Auto buttons (task brief items 2/3) — same "shown
 *  only while a table exists" rule as the chat FAB above, plus their own
 *  label/state. Cheap enough to call from every render(). */
function updateHudButtons(): void {
  const show = currentMatchUuid !== null;
  const p = document.getElementById("btnPause") as HTMLButtonElement | null;
  if (p) {
    p.style.display = show ? "" : "none";
    p.textContent = paused ? "▶ resume" : "⏸ pause";
  }
  const a = document.getElementById("btnAuto") as HTMLButtonElement | null;
  if (a) {
    a.style.display = show ? "" : "none";
    a.classList.toggle("on", myAuto);
    a.textContent = myAuto ? "🤖 auto: on" : "🤖 auto";
  }
}
async function sendTableChatText(): Promise<void> {
  const input = document.getElementById("chatInput") as HTMLInputElement | null;
  if (!input || !ts) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try { await ts.sendChat({ text }); }
  catch (e) { flashHudNote(e instanceof RequestRejected ? (REJECT_NOTES[e.code] ?? e.code) : "message not sent"); }
}
async function sendTableChatPhrase(phrase: ChatPhrase): Promise<void> {
  if (!ts) return;
  try { await ts.sendChat({ phrase }); }
  catch (e) { flashHudNote(e instanceof RequestRejected ? (REJECT_NOTES[e.code] ?? e.code) : "message not sent"); }
}
/** Wired exactly once at boot (the drawer's HTML is static furniture, not
 *  rebuilt per screen/match) — mirrors how `#btnFeedback`/`#btnSettings`/
 *  `#btnQuit` are wired at the bottom of this file. */
function wireChatDrawer(): void {
  const phrases = document.getElementById("chatPhrases");
  if (phrases) {
    phrases.innerHTML = CHAT_PHRASES.map((p) => {
      const [ch, en] = CHAT_PHRASE_LABELS[p];
      // The English sub-label is a `title` tooltip here, not visible text —
      // task item 1 asks for "the five quick-phrase buttons in one row",
      // and the overlay is only ~230px wide on a phone; five two-line chips
      // wrapped to two rows there. `<span>` stays in the markup (CSS hides
      // it only inside `#chatOverlay`) in case this button HTML is ever
      // reused somewhere wider.
      return `<button class="phrasebtn" data-p="${p}" title="${en}">${ch}<span>${en}</span></button>`;
    }).join("");
    for (const el of Array.from(phrases.querySelectorAll<HTMLButtonElement>(".phrasebtn"))) {
      el.onclick = () => void sendTableChatPhrase(el.dataset.p as ChatPhrase);
    }
  }
  // Task item 1: the button toggles the overlay; tapping it again, or
  // tapping the felt itself, closes it — nothing else on the felt is
  // clickable (discards/claims live in `#mine`, outside `#felt`), so a plain
  // felt click is unambiguous. `stopPropagation` on the button and the
  // overlay itself is what stops that SAME click from also reaching the
  // felt's own handler below and immediately closing what it just opened
  // (the button is a child of `#felt`, so its click bubbles there too).
  const btn = document.getElementById("chatBtn");
  if (btn) btn.onclick = (e) => { e.stopPropagation(); setChatOpen(!chatOpen); };
  const overlay = document.getElementById("chatOverlay");
  if (overlay) overlay.onclick = (e) => { e.stopPropagation(); };
  const felt = document.getElementById("felt");
  if (felt) felt.onclick = () => { if (chatOpen) setChatOpen(false); };
  const send = document.getElementById("chatSend");
  if (send) send.onclick = () => void sendTableChatText();
  const input = document.getElementById("chatInput") as HTMLInputElement | null;
  if (input) {
    input.maxLength = CHAT_TEXT_MAX_LENGTH;
    input.onkeydown = (e) => { if (e.key === "Enter") void sendTableChatText(); };
  }
  const showAll = document.getElementById("chatShowAll");
  if (showAll) {
    showAll.onclick = (e) => {
      e.preventDefault();
      chatShowAll = !chatShowAll;
      renderTableChat(); // also syncs this link's own label
    };
  }
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
  /** Best-effort seed for the waiting room — see `seatPlan`'s doc comment. */
  seatPlan?: FourSeats<SeatPlanEntry> | null;
}): void {
  currentMatchUuid = r.matchUuid; currentJoinCode = r.joinCode;
  currentRulesetId = r.rulesetId; currentMatchFormat = r.matchFormat;
  mySeat = r.seat;
  isCreatorOfCurrentTable = r.creator ?? false;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    matchUuid: r.matchUuid, joinCode: r.joinCode, seat: r.seat, creator: isCreatorOfCurrentTable,
  }));
  snap = null; directory = null; seatPlan = r.seatPlan ?? null; lastSeq = -1; curLegal = null; pending = null;
  overlay = null; matchEndInfo = null; matchAgreement = undefined;
  paused = null; myAuto = false;
  window.clearTimeout(revealTimer); revealTimer = 0; revealDeadlineTs = null; revealRequested = false;
  pendingWinDetail = null; pendingDrawDistance = null;
  pileTiles = []; handSig = ""; landingMeld = null; feed.length = 0;
  sessionHands.length = 0; coachTally.graded = 0; coachTally.matched = 0;
  tableChat = []; handStartTs = 0; chatShowAll = false; chatUnread = 0; chatOpen = false;
  renderTableChat();
  for (const k of Object.keys(presence)) delete presence[Number(k) as SeatIndex];
  ts?.close();
  ts = new TableSocket(r.matchUuid, r.seatToken, {
    onWelcome(payload: WelcomePayload) {
      directory = payload.directory;
      mySeat = payload.seat;
      currentRulesetId = payload.rulesetId;
      snap = payload.snapshot;
      lastSeq = payload.snapshot.seq;
      paused = payload.paused;
      myAuto = payload.directory[mySeat]?.auto ?? false;
      seedPileFromSnapshot();
      buildWall();
      setConnBadge("");
      render();
      syncVeil();
      updateChatVisibility();
      updateHudButtons();
      ts?.resync(lastSeq);
    },
    onRestore(events, snapshot, dir, pausedInfo) {
      // Who sits where may have changed (seats filled or shuffled) since this
      // seat's own `welcome` — `restore`'s directory is the fresh truth,
      // wholesale, same as `welcome`'s (never patched field-by-field).
      directory = dir;
      const wasPaused = paused !== null;
      paused = pausedInfo;
      if (!wasPaused && paused) freezeClock();
      else if (wasPaused && !paused) thawClock();
      myAuto = dir[mySeat]?.auto ?? false;
      applyBatch(events, snapshot);
    },
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
      // A player who joins AFTER this seat's own `welcome` is otherwise
      // nameless here forever — `directory` used to ride on `welcome` only.
      // `presence` now carries enough (playerId/displayName/bot/auto) to keep
      // this seat's directory current too; update it in place (one seat,
      // not a wholesale replace like `welcome`/`restore` do) so nameplates
      // and the waiting room pick up the name on the very next render.
      if (directory) {
        directory[payload.seat] = {
          seat: payload.seat,
          playerId: payload.playerId,
          displayName: payload.displayName,
          bot: payload.bot,
          connected: payload.connected,
          auto: payload.auto,
        };
      }
      if (payload.seat === mySeat) myAuto = payload.auto;
      render();
      syncVeil();
    },
    onPaused(payload: PausedPayload) {
      const wasPaused = paused !== null;
      paused = payload.on ? { bySeat: payload.bySeat, displayName: payload.displayName, since: payload.ts } : null;
      if (!wasPaused && paused) freezeClock();
      else if (wasPaused && !paused) thawClock();
      render();
      syncVeil();
    },
    onChat(payload: ChatMessagePayload) {
      const entry = chatEntry(payload);
      tableChat.push(entry);
      if (tableChat.length > 50) tableChat.splice(0, tableChat.length - 50);
      const mine = payload.seat === mySeat;
      if (!mine && !mutedSet().has(entry.playerId)) {
        // Phrases only bubble at the sender's own nameplate (task spec item
        // 2) — a call heard AT THE TABLE, reusing the announce/sayDiscard
        // STYLE (a timed CSS class swap, no rAF loop) via its own element so
        // it never collides with a discard's own #say.
        if (payload.phrase) {
          const [ch, en] = CHAT_PHRASE_LABELS[payload.phrase];
          showChatBubble(`${ch} <span class="mut">${en}</span>`, rel(payload.seat));
        }
        // Task item 1: while the overlay is closed, ANY incoming message —
        // phrase or free text — also previews as a fading line near the
        // button and bumps its badge; this is what tells a player with the
        // overlay closed that something arrived at all.
        if (!chatOpen) {
          chatUnread++;
          const preview = payload.phrase
            ? `${CHAT_PHRASE_LABELS[payload.phrase][0]} ${CHAT_PHRASE_LABELS[payload.phrase][1]}`
            : (payload.text ?? "");
          showChatPreviewLine(`<b>${esc(entry.displayName)}</b> ${esc(preview)}`);
        }
      }
      renderTableChat();
    },
    onChatHistory(list: ChatMessagePayload[]) {
      tableChat = list.map(chatEntry);
      renderTableChat();
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
  updateChatVisibility();
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

/** `joinTable`'s response carries no seat layout (unlike `createTable`, this
 *  client never chose it) — best-effort recover one from this match's row in
 *  the last lobby poll, if it's still cached. Missing entirely (a stale
 *  cache, or a code typed straight from an invite link with no lobby fetch
 *  yet) just means the waiting room falls back to `directory` only, same as
 *  before this seed existed. */
function seatPlanFromLobby(matchUuid: string): FourSeats<SeatPlanEntry> | null {
  const t = lobbyData?.tables.find((x) => x.matchId === matchUuid);
  if (!t) return null;
  return ([0, 1, 2, 3] as const).map((i): SeatPlanEntry => {
    const seat = t.seats.find((s) => s.seat === i);
    return seat ? { bot: seat.kind === "bot", displayName: seat.displayName } : { bot: false };
  }) as FourSeats<SeatPlanEntry>;
}

async function sitDownByCode(code: string): Promise<void> {
  if (!identity) return;
  try {
    const r = await joinTable(identity.deviceToken, code);
    connectToMatch({
      matchUuid: r.matchUuid, joinCode: code, seat: r.seat, seatToken: r.seatToken,
      rulesetId: r.rulesetId, matchFormat: r.matchFormat, seatPlan: seatPlanFromLobby(r.matchUuid),
    });
  } catch (e) {
    flashHudNote(describeError(e));
    lobbyScreen();
  }
}

/* ── lobby tabs (task brief item 3, 2026-09-02) ───────────────────────────
 * Play (Here now / Open tables / New table / Join by code), Chat (the lobby
 * chat), Stats (Your stats / Leaderboard), Games (Your games / recent
 * results), Rooms (a placeholder — see `refreshLobbyRooms` below). Each
 * pane is built ONCE with the rest of the shell and only ever hidden/shown
 * (`setLobbyTab`) — a switch never rebuilds `#lobbyHere`/`#lobbyTables`/
 * `#lobbyChat`/`#lobbyRecent`, so those keep their scroll position and their
 * `LOBBY_PANELS` signature-diffed repaint discipline untouched. The active
 * tab is remembered in `sessionStorage` so a reload (or a trip through
 * another screen and "back to lobby") returns to the same one. */
type LobbyTab = "play" | "chat" | "stats" | "games" | "rooms";
const LOBBY_TABS: readonly LobbyTab[] = ["play", "chat", "stats", "games", "rooms"];
const LOBBY_TAB_KEY = "mjrc.gamepvp.lobbyTab";
let lobbyActiveTab: LobbyTab = "play";
function loadLobbyTab(): LobbyTab {
  const v = sessionStorage.getItem(LOBBY_TAB_KEY);
  return (LOBBY_TABS as readonly string[]).includes(v ?? "") ? (v as LobbyTab) : "play";
}
/** Switches panes, repaints whatever that tab owns from data already in hand
 *  (`paintLobbyPanel(key, true)` — a poll tick may have fetched fresh
 *  `lobbyData` while this tab was hidden without painting it, see
 *  `refreshLobby`'s "only the visible tab" rule below), and kicks off the
 *  Rooms tab's own fetch the first time it is opened. */
function setLobbyTab(tab: LobbyTab): void {
  lobbyActiveTab = tab;
  sessionStorage.setItem(LOBBY_TAB_KEY, tab);
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".tabpane[data-tab]")))
    el.classList.toggle("on", el.dataset.tab === tab);
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".tabpill[data-tab]")))
    el.classList.toggle("on", el.dataset.tab === tab);
  for (const key of Object.keys(LOBBY_PANELS) as LobbyPanelKey[])
    if (PANEL_TAB[key] === tab) paintLobbyPanel(key, true);
  if (tab === "rooms") void refreshLobbyRooms();
}

/** Handlers for the lobby's STATIC furniture — title, rename link, the tab
 *  pills, the nav cards, "what is this?" — wired exactly once per
 *  `lobbyScreen()` entry, never on a poll tick (bug fix, PVP-LOBBY-PROPOSAL
 *  §3.1: the old `wireLobbyPanel` re-queried and re-bound all of this every
 *  5s, which is also when a tap landing mid-rebind could miss — see
 *  `paintLobbyPanel` below for the part that actually needs to redraw on a
 *  schedule). */
function wireLobbyStatic(): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".tabpill[data-tab]")))
    el.onclick = () => setLobbyTab(el.dataset.tab as LobbyTab);
  (document.getElementById("goNew") as HTMLElement).onclick = () => { beforeScreen(); newTableScreen(); };
  (document.getElementById("goJoin") as HTMLElement).onclick = () => { beforeScreen(); joinScreen(); };
  (document.getElementById("goStats") as HTMLElement).onclick = () => { beforeScreen(); statsScreen(); };
  (document.getElementById("goYourStats") as HTMLElement).onclick = () => { beforeScreen(); yourStatsScreen(); };
  (document.getElementById("goLeaderboard") as HTMLElement).onclick = () => { beforeScreen(); leaderboardScreen("ranked"); };
  (document.getElementById("btnRename") as HTMLElement).onclick = (e) => { e.preventDefault(); beforeScreen(); nameScreen(lobbyScreen); };
  (document.getElementById("btnAbout2") as HTMLElement).onclick = (e) => { e.preventDefault(); beforeScreen(); aboutScreen(lobbyScreen); };
  wireLobbyChatInput();
}

/** The lobby chat panel's own input row (§8) — rebuilt fresh every
 *  `lobbyScreen()` entry along with the rest of the static shell, so this is
 *  wired from `wireLobbyStatic()` rather than living inside `LOBBY_PANELS`
 *  (whose `wire()` re-runs on every repaint of the MESSAGE rows only). */
function wireLobbyChatInput(): void {
  const btn = document.getElementById("lobbyChatSend") as HTMLButtonElement | null;
  const input = document.getElementById("lobbyChatIn") as HTMLInputElement | null;
  const note = document.getElementById("lobbyChatNote");
  if (!btn || !input) return;
  input.maxLength = CHAT_TEXT_MAX_LENGTH;
  const send = async (): Promise<void> => {
    if (!identity) return;
    const text = input.value.trim();
    if (!text) return;
    btn.disabled = true;
    try {
      await postLobbyChat(identity.deviceToken, text);
      input.value = "";
      if (note) note.textContent = "";
      void refreshLobby(lobbyGen);
    } catch (e) {
      // §8/task item 3: a 429 reads as "slow down", not the raw ApiError code.
      if (note) note.textContent = e instanceof ApiError && e.code === "rate_limited" ? "slow down" : describeError(e);
    }
    // "disable the send button for 2s after a send" (task item 3) — from the
    // attempt, success or failure, not just a successful one: a 429 is
    // exactly the case a cooldown exists to prevent hammering through.
    window.setTimeout(() => { btn.disabled = false; }, 2000);
  };
  btn.onclick = () => void send();
  input.onkeydown = (e) => { if (e.key === "Enter") void send(); };
}

/** The lobby's static shell — everything `wireLobbyStatic` wires, plus the
 *  five tab panes (one of which is "on" at a time — see `setLobbyTab`) and
 *  the EMPTY panel containers inside them (`#lobbyHere`/`#lobbyTables`/
 *  `#lobbyRecent`/`#lobbyChat`) that `paintLobbyPanel` fills in and keeps
 *  current. Built once per `lobbyScreen()` entry; a poll tick never touches
 *  this HTML again — only `paintLobbyPanel`'s own containers repaint. */
function lobbyShellHtml(): string {
  const tab = (id: LobbyTab, label: string): string =>
    `<button class="tabpill" data-tab="${id}">${label}</button>`;
  return `
    <h1>香港麻雀 · MJRC</h1>
    <p class="mut">Playing as <b>${esc(identity?.displayName ?? "—")}</b> ·
      <a href="#" id="btnRename" style="color:var(--gold)">change name</a></p>
    <div class="tabbar">
      ${tab("play", "Play")}${tab("chat", "Chat")}${tab("stats", "Stats")}${tab("games", "Games")}${tab("rooms", "Rooms")}
    </div>

    <div class="tabpane" data-tab="play">
      <div class="lobbygrid">
        <div class="lobbycol">
          <h2>Here now</h2>
          <div class="rows" id="lobbyHere"></div>
        </div>
        <div class="lobbycol">
          <h2>Open tables</h2>
          <div class="tablelist" id="lobbyTables"></div>
        </div>
      </div>
      <div class="choices lobby" style="margin-top:14px">
        <div class="choice" id="goNew"><b>New table ▸</b><span>Pick rules, mode and seats, invite by code.</span></div>
        <div class="choice" id="goJoin"><b>Join by code</b><span>Enter a table's join code to sit down.</span></div>
      </div>
    </div>

    <div class="tabpane" data-tab="chat">
      <h2>Chat</h2>
      <div class="rows chatrows" id="lobbyChat"></div>
      <div class="chat-input-row lobby">
        <input id="lobbyChatIn" type="text" placeholder="say something…">
        <button id="lobbyChatSend">send</button>
      </div>
      <p class="mut" id="lobbyChatNote"></p>
    </div>

    <div class="tabpane" data-tab="stats">
      <div class="choices lobby">
        <div class="choice" id="goYourStats"><b>Your stats ▸</b><span>Your totals, placements and rating over time.</span></div>
        <div class="choice" id="goLeaderboard"><b>Leaderboard ▸</b><span>Ranked by rating, casual by record.</span></div>
      </div>
    </div>

    <div class="tabpane" data-tab="games">
      <div class="choices lobby">
        <div class="choice" id="goStats"><b>Your games ▸</b><span>Every match you have played — our record of it, not this device's.</span></div>
      </div>
      <h2 style="margin-top:14px">Recent results</h2>
      <div class="rows" id="lobbyRecent"></div>
    </div>

    <div class="tabpane" data-tab="rooms">
      <div id="lobbyRooms"><p class="mut">reading…</p></div>
    </div>

    <p class="mut" style="margin-top:14px"><a href="#" id="btnAbout2" style="color:var(--gold)">what is this?</a></p>`;
}

function hereHtml(data: LobbyPayload | null): string {
  const here = data?.here ?? [];
  const tables = data?.tables ?? [];
  if (here.length === 0) return `<p class="mut">${data === null ? "reading…" : "nobody else is around right now"}</p>`;
  return here.map((e) => hereRowHtml(e, tables)).join("");
}
function tablesHtml(data: LobbyPayload | null): string {
  const tables = data?.tables ?? [];
  if (tables.length === 0) return `<p class="mut">${data === null ? "reading…" : "no tables right now — start one"}</p>`;
  return tables.map(tableRowHtml).join("");
}
function recentHtml(data: LobbyPayload | null): string {
  const recent = data?.recent ?? [];
  if (recent.length === 0) return `<p class="mut">${data === null ? "reading…" : "nothing finished yet"}</p>`;
  return recent.map(recentRowHtml).join("");
}
function lobbyChatRowHtml(m: LobbyChatEntry): string {
  const mine = identity?.playerId === m.playerId;
  return `<div class="row"><span class="c1">
    <span class="cname" data-player="${mine ? "" : esc(m.playerId)}" data-name="${esc(m.displayName)}">${esc(m.displayName)}</span>
    ${esc(m.text)}</span></div>`;
}
function lobbyChatHtml(data: LobbyPayload | null): string {
  const muted = mutedSet();
  const chat = (data?.chat ?? []).filter((m) => !muted.has(m.playerId));
  if (chat.length === 0) return `<p class="mut">${data === null ? "reading…" : "quiet in here — say something"}</p>`;
  return chat.map(lobbyChatRowHtml).join("");
}
function wireLobbyChatPanel(container: HTMLElement): void {
  wireMuteTaps(container);
  container.scrollTop = container.scrollHeight;
}
function wireHerePanel(container: HTMLElement): void {
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(".row.clickable[data-code]"))) {
    el.onclick = () => { const code = el.dataset.code!; beforeScreen(); void sitDownByCode(code); };
  }
  for (const el of Array.from(container.querySelectorAll<HTMLElement>(".pname[data-player]"))) {
    el.onclick = (e) => { e.stopPropagation(); const id = el.dataset.player!; beforeScreen(); playerScreen(id, lobbyScreen); };
  }
}
function wireTablesPanel(container: HTMLElement): void {
  for (const el of Array.from(container.querySelectorAll<HTMLButtonElement>("button.sitdown"))) {
    el.onclick = () => { const code = el.dataset.code!; beforeScreen(); void sitDownByCode(code); };
  }
}

/** The three panels that actually change on a poll (task item 1) — "Here
 *  now", "Open tables", "Recent results". Everything else in the lobby
 *  (title, the five nav cards) is the STATIC shell above and is never
 *  touched again once `lobbyScreen()` builds it.
 *
 *  `sig` is the "serialized snapshot" the task brief asks for: a panel only
 *  repaints when its slice of `lobbyData` actually serializes differently
 *  from last time, not on every 5s tick regardless. "Here now" reads both
 *  `here` and `tables` (a row's click target and its "waiting at a table
 *  N/4" label both depend on the matching table), so its signature covers
 *  both. */
type LobbyPanelKey = "here" | "tables" | "recent" | "chat";
const LOBBY_PANELS: Record<LobbyPanelKey, {
  containerId: string;
  sig: (d: LobbyPayload | null) => string;
  html: (d: LobbyPayload | null) => string;
  wire: (c: HTMLElement) => void;
}> = {
  here: {
    containerId: "lobbyHere",
    sig: (d) => JSON.stringify([d?.here ?? [], d?.tables ?? []]),
    html: hereHtml, wire: wireHerePanel,
  },
  tables: {
    containerId: "lobbyTables",
    sig: (d) => JSON.stringify(d?.tables ?? []),
    html: tablesHtml, wire: wireTablesPanel,
  },
  recent: {
    containerId: "lobbyRecent",
    sig: (d) => JSON.stringify(d?.recent ?? []),
    html: recentHtml, wire: () => {},
  },
  chat: {
    containerId: "lobbyChat",
    sig: (d) => JSON.stringify(d?.chat ?? []),
    html: lobbyChatHtml, wire: wireLobbyChatPanel,
  },
};
/** Which tab each `LOBBY_PANELS` key lives in — what `refreshLobby`'s "only
 *  the visible tab" rule and `setLobbyTab`'s catch-up repaint both key off. */
const PANEL_TAB: Record<LobbyPanelKey, LobbyTab> = { here: "play", tables: "play", recent: "games", chat: "chat" };
/** `down`: a pointer is currently down somewhere inside this panel's
 *  container — see `wireLobbyPanelDownTracking`/`ensureLobbyPointerGuard`
 *  below (task item 1: "never re-render a panel while a pointer is down
 *  inside it"). `dirty`: fresh data arrived while `down` was true, so the
 *  repaint this panel owes is deferred to the next pointerup/pointercancel. */
const lobbyPanelState: Record<LobbyPanelKey, { sig: string | null; down: boolean; dirty: boolean }> = {
  here: { sig: null, down: false, dirty: false },
  tables: { sig: null, down: false, dirty: false },
  recent: { sig: null, down: false, dirty: false },
  chat: { sig: null, down: false, dirty: false },
};
/** Repaints one panel from the current `lobbyData` — but only if its
 *  signature actually changed (or `force`, used once on a fresh
 *  `lobbyScreen()` entry to fill the empty shell), and never mid-tap. */
function paintLobbyPanel(key: LobbyPanelKey, force = false): void {
  const def = LOBBY_PANELS[key];
  const st = lobbyPanelState[key];
  const container = document.getElementById(def.containerId);
  if (!container) return;
  const sig = def.sig(lobbyData);
  if (!force) {
    if (sig === st.sig) return;
    if (st.down) { st.dirty = true; return; }
  }
  container.innerHTML = def.html(lobbyData);
  def.wire(container);
  st.sig = sig;
  st.dirty = false;
}
/** Fresh `pointerdown` listeners on this visit's (fresh) panel containers —
 *  cheap to re-wire every `lobbyScreen()` entry since the old containers,
 *  and their listeners, are thrown away with the old shell. */
function wireLobbyPanelDownTracking(): void {
  for (const key of Object.keys(LOBBY_PANELS) as LobbyPanelKey[]) {
    const container = document.getElementById(LOBBY_PANELS[key].containerId);
    container?.addEventListener("pointerdown", () => { lobbyPanelState[key].down = true; });
  }
}
/** The release side is wired to `document`, ONCE ever (not per lobby visit —
 *  unlike the containers above, `document` never gets thrown away, so
 *  re-adding this every visit would leak one listener per visit). A drag can
 *  end outside the container it started in, so catching the release at the
 *  document is what makes this reliable rather than merely usually-true. */
let lobbyPointerGuardWired = false;
function ensureLobbyPointerGuard(): void {
  if (lobbyPointerGuardWired) return;
  lobbyPointerGuardWired = true;
  const release = (): void => {
    for (const key of Object.keys(LOBBY_PANELS) as LobbyPanelKey[]) {
      const st = lobbyPanelState[key];
      if (!st.down) continue;
      st.down = false;
      if (st.dirty) paintLobbyPanel(key);
    }
  };
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
}

/* ── Rooms tab (task brief item 3; PVP-LOBBY-PROPOSAL-2026-09-02.md §8b) ──
 * A placeholder, by design: another agent is building the room API to this
 * exact contract in parallel, so every call here degrades on a 404 rather
 * than assuming it exists yet. Not part of the 5s `GET /api/lobby` poll —
 * this is its own fetch, run once when the tab is first opened (and again
 * after a successful join/create). */
interface RoomsTabState { status: "loading" | "unavailable" | "error" | "ready"; rooms: RoomSummary[]; }
let roomsTabState: RoomsTabState = { status: "loading", rooms: [] };

function roomRowHtml(r: RoomSummary): string {
  return `<div class="row"><span class="c1">${esc(r.name)} <span class="mut">${esc(r.code)}</span></span>
    ${r.memberCount === undefined ? "" : `<span class="c2">${r.memberCount}</span>`}</div>`;
}

/** The join-by-code input and create-room form (§8b: `POST /api/rooms/:code
 *  /join`, `POST /api/rooms`) — shown under the rooms list, or on their own
 *  under the "coming soon"/error note, so the tab is never a dead end even
 *  before a player is in any room, or before the backend exists at all.
 *  Ruleset/format default to the standard table (`newTableDraft`'s own
 *  defaults) rather than a picker — a fuller form is follow-up work once
 *  rooms are actually live, not this placeholder pass. */
function roomsFormsHtml(): string {
  const inputStyle = "flex:1;min-width:0;padding:9px 12px;font-size:14px;border-radius:9px;"
    + "background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);color:var(--ink)";
  return `
    <h2 style="margin-top:14px">Join a room</h2>
    <div class="setrow">
      <input id="roomJoinCode" type="text" maxlength="10" autocapitalize="characters"
        placeholder="room code" style="${inputStyle};text-transform:uppercase;letter-spacing:.06em">
      <button id="roomJoinBtn">join ▸</button>
    </div>
    <p class="mut" id="roomJoinNote"></p>
    <h2 style="margin-top:14px">Create a room</h2>
    <div class="setrow" style="flex-direction:column;align-items:stretch">
      <input id="roomCreateName" type="text" maxlength="40" placeholder="room name" style="${inputStyle}">
      <input id="roomCreateAdmin" type="text" maxlength="40" placeholder="admin code — yours to remember"
        style="${inputStyle};margin-top:6px">
    </div>
    <button id="roomCreateBtn" style="margin-top:8px">create ▸</button>
    <p class="mut" id="roomCreateNote"></p>`;
}

/** A 404 on either call reads as "not live on this server yet" — the same
 *  "rooms are coming" framing as the tab's own empty state, not a raw error. */
const ROOMS_NOT_LIVE_NOTE = "rooms are coming — not live on this server yet";
function wireRoomsForms(): void {
  const joinBtn = document.getElementById("roomJoinBtn") as HTMLButtonElement | null;
  const joinIn = document.getElementById("roomJoinCode") as HTMLInputElement | null;
  const joinNote = document.getElementById("roomJoinNote");
  if (joinBtn && joinIn) {
    const go = async (): Promise<void> => {
      if (!identity) return;
      const code = joinIn.value.trim();
      if (!code) { joinIn.focus(); return; }
      joinBtn.disabled = true;
      try {
        await joinRoom(identity.deviceToken, code);
        joinIn.value = "";
        void refreshLobbyRooms();
      } catch (e) {
        if (joinNote) joinNote.textContent = e instanceof ApiError && e.status === 404 ? ROOMS_NOT_LIVE_NOTE : describeError(e);
      }
      joinBtn.disabled = false;
    };
    joinBtn.onclick = () => void go();
    joinIn.onkeydown = (e) => { if (e.key === "Enter") void go(); };
  }
  const createBtn = document.getElementById("roomCreateBtn") as HTMLButtonElement | null;
  const nameIn = document.getElementById("roomCreateName") as HTMLInputElement | null;
  const adminIn = document.getElementById("roomCreateAdmin") as HTMLInputElement | null;
  const createNote = document.getElementById("roomCreateNote");
  if (createBtn && nameIn && adminIn) {
    const go = async (): Promise<void> => {
      if (!identity) return;
      const name = nameIn.value.trim();
      const adminCode = adminIn.value.trim();
      if (!name || !adminCode) { (name ? adminIn : nameIn).focus(); return; }
      createBtn.disabled = true;
      try {
        const r = await createRoom(identity.deviceToken, {
          name, adminCode, rulesetId: newTableDraft.rulesetId, matchFormat: newTableDraft.matchFormat,
        });
        nameIn.value = ""; adminIn.value = "";
        if (createNote) createNote.textContent = `created — code ${r.code}`;
        void refreshLobbyRooms();
      } catch (e) {
        if (createNote) createNote.textContent = e instanceof ApiError && e.status === 404 ? ROOMS_NOT_LIVE_NOTE : describeError(e);
      }
      createBtn.disabled = false;
    };
    createBtn.onclick = () => void go();
  }
}

function renderRoomsTab(): void {
  const el = document.getElementById("lobbyRooms");
  if (!el) return;
  if (roomsTabState.status === "loading") { el.innerHTML = `<p class="mut">reading…</p>`; return; }
  const lead = roomsTabState.status === "unavailable" ? `<p class="mut">${ROOMS_NOT_LIVE_NOTE}</p>`
    : roomsTabState.status === "error" ? `<p class="mut">could not reach the server.</p>`
    : roomsTabState.rooms.length === 0 ? `<p class="mut">You are not in a room yet.</p>`
    : `<div class="rows">${roomsTabState.rooms.map(roomRowHtml).join("")}</div>`;
  el.innerHTML = lead + roomsFormsHtml();
  wireRoomsForms();
}

/** `GET /api/rooms/mine` — see net.ts's doc comment for why a 404 here is
 *  "not built yet", not a real error. Guarded by `lobbyGen` the same way
 *  `refreshLobby` is: a slow response landing after the player has already
 *  left the lobby (or come back to a fresh visit) must not paint over it. */
async function refreshLobbyRooms(): Promise<void> {
  if (!identity) return;
  const gen = lobbyGen;
  try {
    const rooms = await getMyRooms(identity.deviceToken);
    if (gen !== lobbyGen) return;
    roomsTabState = { status: "ready", rooms };
  } catch (e) {
    if (gen !== lobbyGen) return;
    roomsTabState = e instanceof ApiError && e.status === 404
      ? { status: "unavailable", rooms: [] }
      : { status: "error", rooms: [] };
  }
  renderRoomsTab();
}

/** GET /api/lobby every 5s while this screen is up (§3, §7.2). A failed poll
 *  is swallowed and the panels stay on whatever they last showed (or
 *  "reading…" on the very first attempt), never a fake row.
 *
 *  Task brief item 3: "the 5-second poll only repaints panels on the visible
 *  tab." The fetch itself always runs (one shared `GET /api/lobby` behind
 *  all four `here`/`tables`/`recent`/`chat` panels — there is no cheaper way
 *  to keep an inactive tab's data current for when it IS switched to); only
 *  the DOM repaint is gated. A panel on a hidden tab simply keeps its old
 *  `lobbyPanelState.sig`, so `setLobbyTab`'s forced repaint on the next
 *  switch-to always shows the latest fetch, not a stale one. */
async function refreshLobby(gen: number): Promise<void> {
  if (!identity || gen !== lobbyGen) return;
  try {
    lobbyData = await getLobby(identity.deviceToken);
  } catch {
    /* degrade gracefully — see refreshLobby's/hereHtml's "reading…" fallback */
  }
  if (gen !== lobbyGen) return;
  for (const key of Object.keys(LOBBY_PANELS) as LobbyPanelKey[])
    if (PANEL_TAB[key] === lobbyActiveTab) paintLobbyPanel(key);
}

function lobbyScreen(): void {
  const gen = ++lobbyGen;
  stopLobbyPoll();
  $("veil").style.display = "flex";
  $("panel").classList.remove("about");
  $("panel").classList.add("lobby3");
  $("panel").innerHTML = lobbyShellHtml();
  wireLobbyStatic();
  for (const key of Object.keys(LOBBY_PANELS) as LobbyPanelKey[]) lobbyPanelState[key] = { sig: null, down: false, dirty: false };
  wireLobbyPanelDownTracking();
  ensureLobbyPointerGuard();
  for (const key of Object.keys(LOBBY_PANELS) as LobbyPanelKey[]) paintLobbyPanel(key, true);
  roomsTabState = { status: "loading", rooms: [] };
  setLobbyTab(loadLobbyTab());
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
      <button class="${newTableDraft.access === "open" ? "on" : ""}" data-access="open"><b>Open</b><span>anyone can sit down</span></button>
      <button class="${newTableDraft.access === "private" ? "on" : ""}" data-access="private"><b>Private</b><span>needs the code to sit down</span></button>
    </div>
    <p class="segcap">${newTableDraft.access === "open"
      ? "Open — every table is listed in the lobby; access only controls sitting down. Anyone in the lobby can sit down."
      : "Private — visible in the lobby like any table; the code is needed to sit down."}</p>
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
    // The server's CreateTableResult doesn't echo the seat layout back, but
    // this client is the one that just SENT it — the request body already
    // says who's a bot and which one. (Randomizing happens at /start, not at
    // creation, so this is still accurate for the waiting room.)
    const plan = newTableDraft.seats.map((s): SeatPlanEntry =>
      s.kind === "bot" ? { bot: true, displayName: botDisplayName(s.bot) } : { bot: false },
    ) as FourSeats<SeatPlanEntry>;
    connectToMatch({
      matchUuid: r.matchUuid, joinCode: r.joinCode, seat: r.seat, seatToken: r.seatToken,
      rulesetId: r.rulesetId, matchFormat: r.matchFormat, creator: true, seatPlan: plan,
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
        rulesetId: r.rulesetId, matchFormat: r.matchFormat, seatPlan: seatPlanFromLobby(r.matchUuid),
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
/** A Pause button in the HUD, alongside Quit — while paused, `paused` (set
 *  from the `paused` broadcast/welcome/restore) drives its own full-table
 *  veil with the actual Resume button (`showPausedScreen`); this one only
 *  ever toggles the request the current state calls for. */
(document.getElementById("btnPause") as HTMLButtonElement).onclick = () => {
  if (!ts) return;
  const req = paused ? ts.requestResume() : ts.requestPause();
  void req.catch((e) =>
    flashHudNote(e instanceof RequestRejected ? (REJECT_NOTES[e.code] ?? e.code) : "that didn't go through"));
};
(document.getElementById("btnAuto") as HTMLButtonElement).onclick = () => {
  if (!ts) return;
  const target = !myAuto;
  void ts.requestAuto(target).catch((e) =>
    flashHudNote(e instanceof RequestRejected ? (REJECT_NOTES[e.code] ?? e.code) : "that didn't go through"));
};
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
wireChatDrawer();
updateChatVisibility();
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

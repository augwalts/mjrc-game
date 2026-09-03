/**
 * MJRC gamepvp — the table runtime: a thin view over a server-authoritative
 * WebSocket table. Everything that happens once a match is joined —
 * rendering, animations, prompts, the claim bar, the hand-end reveal, the
 * chat overlay, pause/auto, the start card, the waiting room and the match-
 * end scoreboard — lives here, extracted verbatim out of the old `game.ts`
 * (2026-09-02 shell rebuild, PVP-LOBBY-PROPOSAL-2026-09-02.md §11) so the
 * new router-driven shell (`shell/`) can sit around it without touching its
 * behaviour. `game.ts` is now the thin bootstrap that decides whether to
 * show this or the shell; `shell/session.ts` holds identity/settings/theme,
 * the app-wide state both this file and every shell page need.
 *
 * Doctrine, unchanged: the client has ZERO game authority. `snap` (a
 * `SeatSnapshot`) is the server's redacted fold of the match for THIS seat;
 * every legal action comes from the server's `prompt` (`LegalRequests`),
 * never computed here. Every button press is a `request*` message; nothing
 * renders as done until the server's `accepted` + `events` say so.
 *
 * `hostHooks` (below `isCreatorOfCurrentTable`) is the ONLY way this module
 * talks to the shell around it — two callbacks the bootstrap wires once at
 * boot (`setHostHooks`), so this file never imports anything under `shell/`
 * except the app-wide state in `shell/session.ts`. That keeps the dependency
 * graph one-directional (shell → table, never table → shell/router or
 * shell/pages) and is what makes "move it into its own file, untouched"
 * possible without dragging the whole shell in after it.
 *
 * Build: ./gamepvp/build.sh (esbuild game.ts --bundle --platform=browser
 *        --format=iife --outfile=gamepvp/assets/game.js — game.ts imports
 *        this file, so it is bundled in, not a separate entry point)
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
  RequestRejected, TableSocket,
  createTable, joinTable,
  endTable as apiEndTable, kickSeat as apiKickSeat, leaveTable as apiLeaveTable, listBots,
  matchDetail, startTable as apiStartTable,
  type BotCatalogueEntry, type MatchFormat, type StartingPayload, type TableSpeed,
} from "./net.js";
import {
  $, describeError, esc, fmtChips, identity, mutedSet, wireMuteTaps,
  SETTINGS, saveSettings, TILE_SCALE_MAX, TILE_SCALE_MIN } from "./shell/session.js";
/** The one addition to the "table.ts imports nothing under shell/ except
 *  session.ts" rule in the header above: `strings.ts` is a leaf (it imports
 *  session.ts and nothing else), so this adds no cycle — shell/pages → table
 *  → strings → session stays one-directional. It is here for the handful of
 *  strings the TABLE itself now shows the player (the double-tap hint, the
 *  hand's sort button); everything else this file prints is game prose that
 *  is already bilingual by nature and stays where it is. */
import { S, t } from "./shell/strings.js";

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
export const tileHtml = (t: TileId, cls = "", attrs = ""): string =>
  `<span class="tile ${cls}" data-t="${t}" ${attrs}><svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet">${face(t)}</svg></span>`;
/** A meld as another seat may show it: a concealed kong they hold is hidden
 *  from us (`tiles: null`) and renders as four backs, never a guess. */
export const meldHtml = (m: Meld | SeatVisibleMeld, cls = ""): string =>
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

export const WIND_CH = ["東", "南", "西", "北"];
export const AWARDS: Record<string, string> = {
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

export const RULE_PICKS: [string, string, string][] = [
  ["mjrc-standard", "MJRC standard", "3–10 faan · flowers · doubling payments. The house game."],
  ["tvb-2026", "TVB Championship 2026", "1 faan minimum · no flowers · linear payments. Every hand is payable, and big hands barely out-earn small ones."],
];

/* ── speed (New table picker, lobby/waiting-room badges, the start card) ──
 * PVP-LOBBY-PROPOSAL-2026-09-02.md §8a-2's table, verbatim. `caption` is the
 * picker's one-line-per-pill text; `wordy` is the same numbers read out as
 * prose for the start card. `untimed`'s own caption is the task brief's own
 * wording, not derived from the numbers (there are none to show). */
export const SPEED_INFO: Record<TableSpeed, { label: string; caption: string; wordy: string }> = {
  untimed: {
    label: "Untimed",
    caption: "no clocks; a 10-minute idle timeout switches you to auto",
    wordy: "no clock — a 10-minute idle timeout switches an inactive seat to auto",
  },
  "very-slow": {
    label: "Very slow",
    caption: "60s turns · pung 15s · chow 20s · win 30s",
    wordy: "60s turns, pung 15s, chow 20s, win 30s",
  },
  normal: {
    label: "Normal",
    caption: "40s turns · pung 10s · chow 15s · win 20s",
    wordy: "40s turns, pung 10s, chow 15s, win 20s",
  },
  faster: {
    label: "Faster",
    caption: "20s turns · pung 6s · chow 12s · win 15s",
    wordy: "20s turns, pung 6s, chow 12s, win 15s",
  },
  insane: {
    label: "Insane",
    caption: "8s turns · pung 3s · chow 4s · win 6s",
    wordy: "8s turns, pung 3s, chow 4s, win 6s",
  },
};
/** "Bot-only tables default to untimed; tables with two or more humans
 *  default to normal" (§8a-2) — read literally: the ONE-human case (a lone
 *  human against bots) is grouped with bot-only under "untimed" here, since
 *  a solo human has nobody else's clock to keep fair either. */
const defaultSpeedFor = (humanCount: number): TableSpeed => (humanCount <= 1 ? "untimed" : "normal");
/** `hkos-doubling`/`liu-brackets`/`tvb-linear` — `rulesets/src/payment.ts`'s
 *  own `PaymentTable.id`s, which is the most likely shape of the wire's
 *  `paymentId` (§8a-2's `settings`) though it is not yet confirmed live —
 *  falls back to the raw id for anything unrecognised. */
export const PAYMENT_LABELS: Record<string, string> = {
  "hkos-doubling": "doubling", "liu-brackets": "bracket", "tvb-linear": "linear",
};
export const matchFormatLabel = (f: MatchFormat): string => (f === "full" ? "全莊" : "東圈");
/** "hand 3/4" — `hand` is 0-indexed on the wire, `handsBase` is the
 *  dealership-count denominator (4 east, 16 full); a repeat pushes the
 *  numerator past it on purpose ("hand 5/4", PVP-LOBBY-PROPOSAL §6 item 4). */
export function handLabel(hand: number | undefined, handsBase: number | undefined): string {
  if (hand === undefined || handsBase === undefined) return "in a hand";
  return `hand ${hand + 1}/${handsBase}`;
}
export function ruleLabel(id: string): string {
  return RULE_PICKS.find(([rid]) => rid === id)?.[1] ?? id;
}

/* ── bot picker (New table screen) ────────────────────────────────────────
 * The catalogue is server data (GET /api/bots — gamepvp/src/bots.ts
 * BOT_CATALOGUE) fetched once and cached; DEFAULT_BOT_LINEUP mirrors that
 * file's BOT_LINEUP purely so the picker can pre-select the same default the
 * server falls back to when a table is created with no `bots` picks. Bot
 * seats fill from the top (worker/src/index.ts tableInitOf), so for N bot
 * seats the defaults are the LAST N entries here, in seat order. */
export const DEFAULT_BOT_LINEUP = ["v1", "v4", "persona", "v2"];

let botCatalogue: BotCatalogueEntry[] | null = null;
let botCatalogueP: Promise<BotCatalogueEntry[]> | null = null;
export function loadBotCatalogue(): Promise<BotCatalogueEntry[]> {
  if (botCatalogue) return Promise.resolve(botCatalogue);
  botCatalogueP ??= listBots().catch(() => []).then((list) => { botCatalogue = list; return list; });
  return botCatalogueP;
}

/* ── chat (PVP-LOBBY-PROPOSAL §8) ─────────────────────────────────────────
 * Two chats (table, lobby/room), one client-side mute list (shell/session.ts,
 * shared by both). Chat is never a game event: it never touches `snap`,
 * `pending`, or the reducer — it is pure transport + a couple of small local
 * rings, same discipline as `feed` (decorative). Quick phrases: 好牌 nice ·
 * 快啲 hurry · 唔好意思 sorry · 再嚟 again · 👍 thumbs — `CHAT_PHRASES`/
 * `ChatPhrase` are the wire's stable ids (messages.ts); this is the only
 * place they get Chinese/English prose. */
const CHAT_PHRASE_LABELS: Record<ChatPhrase, [string, string]> = {
  nice: ["好牌", "nice"], hurry: ["快啲", "hurry"], sorry: ["唔好意思", "sorry"],
  again: ["再嚟", "again"], thumbs: ["👍", "thumbs"],
};

/* ── session ───────────────────────────────────────────────────────────
 * `identity` itself lives in shell/session.ts (both this module and every
 * shell page need it); this file only ever reads it. */
const SESSION_KEY = "mjrc.gamepvp.activeMatch";
/** Set only by `doCreateTable()` (shell/pages/newtable.ts), right before
 *  `connectToMatch`, and cleared whenever a match/table is left. Nothing on
 *  the wire says "you made this table" — `/start` is creator-only
 *  server-side regardless, this only gates whether the waiting room OFFERS
 *  the button. Persisted alongside the session key so a reload of the
 *  creator's own tab keeps the button. */
let isCreatorOfCurrentTable = false;

/* ── the shell boundary ────────────────────────────────────────────────
 * The bootstrap (game.ts) wires these once, after the router exists —
 * `enterTable()`/`leaveToShell()` swap which of `#tableRoot`/`#shell` is
 * visible, `goToPlayer()` is the one cross-page navigation the table screen
 * itself ever asks for (a name tapped on the match-end scoreboard). Calling
 * either before `setHostHooks()` runs is a no-op, not a crash — harmless
 * during the earliest boot instant, before the router has mounted. */
export const hostHooks = {
  enterTable: (): void => { /* replaced by setHostHooks */ },
  leaveToShell: (): void => { /* replaced by setHostHooks */ },
  goToPlayer: (_playerId: string): void => { /* replaced by setHostHooks */ },
  /** "sound, haptics, language, theme ›" link on the in-match quick Settings
   *  panel — swaps to the shell's fuller Game settings page. The match
   *  socket is left connected (nothing here calls `leaveTable()`); the HUD's
   *  own quit button is still what actually leaves a live match. */
  goToSettings: (): void => { /* replaced by setHostHooks */ },
};
export function setHostHooks(h: Partial<typeof hostHooks>): void {
  Object.assign(hostHooks, h);
}
/** Every screen that used to start with `beforeScreen()` still does — it
 *  used to also stop the old lobby's 5s poll, which lived in this file and
 *  is gone now (the shell owns its own polling, stopped whenever a page
 *  unmounts). What is left is still worth keeping: `.about`/`.lobby3` were
 *  modifier classes the old full lobby/about screens put on `#panel`; wiping
 *  them before any of THIS file's own `#panel` screens (waiting room, match
 *  end, fatal) render is harmless and keeps this a one-line no-op change
 *  instead of touching every call site. */
function beforeScreen(): void {
  $("panel").classList.remove("about", "lobby3", "modal");
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
/** Best current knowledge of this table's speed (§8a-2) — seeded from
 *  whatever this client itself sent/read at connect time (`doCreateTable`'s
 *  own request, or the joined table's row in `lobbyData`, same "seed, then
 *  authoritative data overwrites it" pattern `seatPlan` already uses), then
 *  overwritten the moment a `starting` push/`welcome.starting`/`restore.
 *  starting` supplies the server's own value. `null` only when neither has
 *  happened yet — every reader shows "…" rather than guessing. */
let currentSpeed: TableSpeed | null = null;

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
/** §8a-2's untimed idle timeout switches a seat to auto the SAME way
 *  `requestAuto`/`presence.auto` already does — the wire gives no separate
 *  "why" for the transition, so this client infers it: `myAutoRequestedOn`
 *  is set right when THIS client asks for auto itself (`#btnAuto`), and
 *  cleared the moment a `presence` confirms it; if `presence` instead turns
 *  this seat's `auto` on WITHOUT that flag having been set, nobody at this
 *  keyboard asked for it, so it reads as the idle timeout (`myAutoIdle`) —
 *  see `onPresence`. Both are always false again once `auto` goes back off,
 *  from any cause. */
let myAutoIdle = false;
let myAutoRequestedOn = false;
/** Drives the "no clock" marker (task item 4) — set by `startClock()`
 *  itself on the `deadlineTs === 0` sentinel, so it needs no separate
 *  tracking of which speed the table is on (works even when `currentSpeed`
 *  is still unknown, e.g. an older server that never sends `starting`). */
let noClock = false;

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
/* ── the throw that is still takeable (build item 1) ─────────────────────
 * `pileTiles[].id` of the discard currently in play, or null. The snapshot's
 * own `lastDiscard` cannot answer this: the engine only clears it when the
 * tile is CONSUMED by a claim or a new hand starts (reducer.ts
 * `consumeDiscard`/`startHand`), so it still names the previous throw long
 * after the next seat has drawn and the window has shut.
 *
 * So this is tracked off the event stream instead, which does know: a
 * `discard` arms it, and the very next event that is not itself part of the
 * claim negotiation (`claimOffered`/`claimDeclined`/`robKongWindow`/
 * `refusedWin`) disarms it — a draw, a claim, a kong, the next throw, the end
 * of the hand. That is exactly "for as long as it can still be taken". */
let liveThrowId: number | null = null;
const THROW_SURVIVES: ReadonlySet<string> =
  new Set(["claimOffered", "claimDeclined", "robKongWindow", "refusedWin"]);
let handSig = "";
let overlay: string | null = null;
interface MatchEndInfo { standings: number[]; placements: number[]; reason: string; handsPlayed: number; }
let matchEndInfo: MatchEndInfo | null = null;

/* ── the start card (task brief item 2, §8a-2) ─────────────────────────────
 * `starting { startsAt, settings }` — a full-table hold before the first
 * turn. `startingInfo` non-null is its own veil state, above the waiting
 * room but below the pause veil/hand-end reveal/matchEnd in `syncVeil()`'s
 * priority (a `starting` push only ever fires once every human seat is
 * already connected, so it can never race the waiting room in practice, but
 * the ordering documents which one wins if it somehow did). */
let startingInfo: StartingPayload | null = null;
/** Fallback close at `startsAt` (+ slack) in case no `deal`/`prompt` ever
 *  arrives to close it the "proof" way (`onPrompt`, consume()'s "deal"
 *  case) — mirrors `startReveal()`'s own fixed-hold fallback. */
let startingCloseTimer = 0;
/** 1Hz repaint while the card is up, same "bounded, not continuous" rAF
 *  exception `startReveal()`'s own countdown already documents. */
let startingTickTimer = 0;
/** This seat already sent `requestNextHand` to end the hold early. */
let startCardReady = false;

/* ── optimistic discard (task brief item 3, §8a-2) ─────────────────────────
 * The one place this client predicts anything: the toss animation runs the
 * instant a legal tile is tapped, ahead of the server's own `discard` event
 * — everything else about the doctrine (§ top of this file) is unchanged,
 * this is animation running ahead of state, never state running ahead of
 * the server. `pileId` is the optimistic `pileTiles` entry's own `id`, so a
 * `rejected` can find and drop exactly that one pile tile (see `act()`). */
interface PendingOptimisticDiscard { tile: TileId; pileId: number; }
let pendingOptimisticDiscard: PendingOptimisticDiscard | null = null;

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

/* ── settings ──────────────────────────────────────────────────────────── *
 * `SETTINGS`/`saveSettings` live in shell/session.ts now (the Game settings
 * page reads/writes the same object) — this file only reads it. */
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
/* ── the tile coach: count + what-if ──────────────────────────────────────
 * Hoisted out of `wireHover()` (they used to be two closures inside it) so
 * the LIFT (build item 3) can raise exactly the same read a hover does — the
 * first tap of a double-tap discard is meant to answer "how many of these are
 * left, and what does cutting it leave me on", which is precisely this. One
 * implementation, two ways in. */
const closestTile = (t: EventTarget | null): HTMLElement | null =>
  (t as HTMLElement | null)?.closest?.(".tile") as HTMLElement | null;
/** The tile the coach is currently reading, or null. Kept so a repeat
 *  read of the same tile is a no-op and a read of a different tile SWAPS
 *  the highlight rather than clearing and rebuilding it — every pile tile's
 *  style hangs off `body.counting` and the `.samet` set, so a clear-then-
 *  show is two whole-felt repaints, and with `mouseover`/`mouseout` firing
 *  on every child boundary inside a tile's SVG that used to run several
 *  times per pointer move. That was the strobe (owner, 2026-09-03). */
let coachedEl: HTMLElement | null = null;
function restoreWhatIfBar(): void {
  const bar = document.getElementById("callbar");
  if (bar?.dataset.saved) { bar.innerHTML = bar.dataset.saved; delete bar.dataset.saved; bar.classList.remove("whatif"); }
}
function showTileCoach(el: HTMLElement): void {
  if (!el.dataset.t) return;
  if (el === coachedEl) return;
  const t = Number(el.dataset.t) as TileId;
  const prev = coachedEl;
  coachedEl = el;
  if (SETTINGS.hcCount) {
    if (Number(prev?.dataset.t) !== t) {
      // add the new set first, then drop what is no longer in it — the body
      // class is set once and never flips in between
      const next = new Set(Array.from(document.querySelectorAll<HTMLElement>(`.tile[data-t="${t}"]`)));
      for (const o of next) o.classList.add("samet");
      for (const o of Array.from(document.querySelectorAll<HTMLElement>(".tile.samet"))) if (!next.has(o)) o.classList.remove("samet");
    }
    document.body.classList.add("counting");
  }
  if (isDesktop() && SETTINGS.hcWhatIf && el.closest("#myhand") && !overlay) {
    const bar = document.getElementById("callbar");
    if (bar) { bar.dataset.saved ??= bar.innerHTML; bar.innerHTML = whatIf(t); bar.classList.add("whatif"); }
  } else {
    restoreWhatIfBar();
  }
}
function clearTileCoach(): void {
  coachedEl = null;
  document.body.classList.remove("counting");
  for (const o of Array.from(document.querySelectorAll<HTMLElement>(".tile.samet"))) o.classList.remove("samet");
  restoreWhatIfBar();
}
/** What a HOVER/long-press release does, as opposed to what lowering a lifted
 *  tile does: it falls back to whatever tile is currently lifted — as a SWAP
 *  (see `coachedEl`), never as a clear followed by a rebuild. */
function clearTileCoachToLift(): void {
  if (liftedEl) showTileCoach(liftedEl); else clearTileCoach();
}
/** Hover for desktop, long-press for touch (task: "touch first" — nothing
 *  in the coach may be hover-only). Both funnel into the same show/clear. */
function wireHover(): void {
  document.addEventListener("mouseover", (e) => { const el = closestTile(e.target); if (el) showTileCoach(el); });
  document.addEventListener("mouseout", (e) => {
    const el = closestTile(e.target);
    if (!el) return;
    // moving between two children of the SAME tile (its SVG's paths) fires
    // this too — that is not leaving the tile, and must not touch the coach
    if (closestTile(e.relatedTarget) === el) return;
    clearTileCoachToLift();
  });
  let pressTimer = 0;
  let pressed: HTMLElement | null = null;
  document.addEventListener("touchstart", (e) => {
    const el = closestTile(e.target);
    pressed = el;
    if (!el) return;
    pressTimer = window.setTimeout(() => { if (pressed) showTileCoach(pressed); }, 260);
  }, { passive: true });
  const releaseTouch = (): void => {
    window.clearTimeout(pressTimer);
    if (pressed) clearTileCoachToLift();
    pressed = null;
  };
  document.addEventListener("touchend", releaseTouch);
  document.addEventListener("touchcancel", releaseTouch);
}

/* ── double tap to discard (build item 3) ─────────────────────────────────
 * Default ON, on every device. A thrown tile cannot be taken back — not by
 * the client, not by the server — so the one gesture in this whole client
 * that is irreversible is the one that gets a confirmation, and the
 * confirmation is the cheapest possible: tap the same tile again.
 *
 * TWO settings, not one (`discardDoubleTapDesktop`/`discardDoubleTapMobile`,
 * shell/session.ts): a mouse and a thumb miss in different ways and at
 * different rates, and a laptop with a touchscreen is both. Which one applies
 * is decided by the POINTER at the moment of the tap, not by a breakpoint
 * captured at boot — same discipline as `isDesktop()` above.
 *
 * When the applicable toggle is off, one tap throws, exactly as before. */
const COARSE = matchMedia("(pointer: coarse)");
const isMobileInput = (): boolean => COARSE.matches || window.innerWidth < 768;
const doubleTapDiscard = (): boolean =>
  isMobileInput() ? SETTINGS.discardDoubleTapMobile : SETTINGS.discardDoubleTapDesktop;
/** The tile raised by a first tap, or null. A DOM node rather than an index:
 *  `render()` only rebuilds `#myhand`'s markup when the hand actually changed
 *  (`handSig`), and any change that rebuilds it also invalidates the lift, so
 *  the node either survives intact or is gone — see the containment check in
 *  `render()`. */
let liftedEl: HTMLElement | null = null;
function lowerTile(): void {
  if (!liftedEl) return;
  liftedEl.classList.remove("lifted");
  liftedEl = null;
  clearTileCoach();
  paintTapHint();
}
function liftTile(el: HTMLElement): void {
  // not `lowerTile()` first: that clears the coach, and the show below would
  // rebuild it — one more whole-felt flip per tap
  if (liftedEl && liftedEl !== el) liftedEl.classList.remove("lifted");
  liftedEl = el;
  el.classList.add("lifted");
  showTileCoach(el);
  paintTapHint();
}
/** Swaps the claim bar's hint between its own text and "tap again to
 *  discard", without a full `render()` — a lift changes nothing about the
 *  game state and has no business repainting the pile. `data-base` carries
 *  the hint's own words so this can put them back. */
function paintTapHint(): void {
  for (const h of Array.from($("actions").querySelectorAll<HTMLElement>(".hint.taphint"))) {
    h.textContent = liftedEl ? t(S.tapAgainToDiscard) : (h.dataset.base ?? "");
  }
}

/* ── drag to rearrange your own hand (build item 4) ───────────────────────
 * LOCAL ONLY. Nothing here is ever sent, and nothing here is ever read back
 * from the server: `me.hand` stays canonical and `render()` still derives the
 * default (ascending) order straight from it. `handOrder` is a preferred
 * ARRANGEMENT of tile ids, matched against the real hand as a multiset on
 * every render — which is what makes it survive re-renders without holding a
 * stale hand: a tile that left drops out, a tile that arrived (a draw, a
 * claim's leftovers) joins at the RIGHT END rather than being sorted in, and
 * everything still held keeps the order the player put it in.
 *
 * Duplicates need no disambiguation: two 3萬 are the same object to the game
 * and to the player, so matching by tile id is matching by identity here. */
let handOrder: TileId[] = [];
function orderedHand(defaultHand: TileId[]): TileId[] {
  if (handOrder.length === 0) return defaultHand;
  const pool = [...defaultHand];
  const out: TileId[] = [];
  for (const t of handOrder) {
    const i = pool.indexOf(t);
    if (i >= 0) { out.push(t); pool.splice(i, 1); }
  }
  out.push(...pool);            // anything the server added since: right end
  handOrder = out;              // re-anchored to what is actually held now
  return out;
}
const handReordered = (defaultHand: TileId[], shown: TileId[]): boolean =>
  shown.some((t, i) => t !== defaultHand[i]);

const DRAG_SLOP = 8;
interface HandDrag {
  el: HTMLElement; tiles: HTMLElement[]; rects: DOMRect[];
  from: number; to: number;
  startX: number; startY: number; pointerId: number; moved: boolean;
}
let handDrag: HandDrag | null = null;
/** A drag ends in a `click` the browser fires anyway; this eats exactly that
 *  one, so a rearrange never also throws a tile. A drag that never passed the
 *  slop threshold sets nothing and the tap goes through untouched — "a tap
 *  that does not move is still a tap". */
let swallowHandClick = false;
let swallowTimer = 0;

/** Wired ONCE (initTableChrome), delegated on `#myhand` — the row's contents
 *  are rebuilt by `render()` whenever the hand changes, so per-tile listeners
 *  would have to be re-attached every time and would leak the drag mid-flight.
 *
 *  Pointer events, not mouse+touch: one code path for a finger and a mouse,
 *  and `setPointerCapture` keeps the stream coming when the finger leaves the
 *  tile — which it always does, since the whole gesture is about leaving it. */
function wireHandDrag(): void {
  const row = $("myhand");
  const endDrag = (commit: boolean, x: number, y: number): void => {
    const d = handDrag;
    if (!d) return;
    handDrag = null;
    for (const t of d.tiles) t.style.transform = "";
    d.el.style.transform = "";
    d.el.classList.remove("dragging");
    if (d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId);
    if (!d.moved) return;                       // a tap: item 3 handles it
    swallowHandClick = true;
    window.clearTimeout(swallowTimer);
    // Belt and braces: if the browser never fires the click (it does not when
    // the pointer is released outside the element it went down on), the flag
    // must not sit armed waiting to eat the player's NEXT real tap.
    swallowTimer = window.setTimeout(() => { swallowHandClick = false; }, 300);
    // "Dragging out of the hand row never discards; it snaps back." Released
    // anywhere outside the row — over the table, over the claim bar — and the
    // arrangement is simply not committed. There is no drop target on this
    // screen but the row itself.
    const r = row.getBoundingClientRect();
    const inside = x >= r.left - 30 && x <= r.right + 30 && y >= r.top - 24 && y <= r.bottom + 24;
    if (!commit || !inside || d.to === d.from) return;
    const shown = d.tiles.map((t) => Number(t.dataset.t) as TileId);
    const [moved] = shown.splice(d.from, 1);
    shown.splice(d.to, 0, moved!);
    handOrder = shown;
    handSig = "";                               // force the row to repaint
    render();
  };

  row.addEventListener("pointerdown", (e) => {
    if (handDrag) return;
    const el = closestTile(e.target);
    // `.drawn` is deliberately not draggable: it has its own slot at the far
    // right (摸切 is a different act from rearranging), and it joins the hand
    // proper — at the right end — on its own the moment the server folds it in.
    if (!el || !row.contains(el) || el.classList.contains("drawn")) return;
    const tiles = Array.from(row.querySelectorAll<HTMLElement>(".tile:not(.drawn)"));
    const from = tiles.indexOf(el);
    if (from < 0) return;
    // Slot geometry is measured ONCE, before anything has moved: every target
    // calculation below reads these frozen rects, so the tiles sliding out of
    // the way can never feed back into where the drop lands.
    const rects = tiles.map((t) => t.getBoundingClientRect());
    handDrag = {
      el, tiles, rects, from, to: from,
      startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, moved: false,
    };
  });

  row.addEventListener("pointermove", (e) => {
    const d = handDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;   // still a tap, not yet a drag
      d.moved = true;
      d.el.setPointerCapture(d.pointerId);
      d.el.classList.add("dragging");
      lowerTile();                                  // a drag is not a first tap
    }
    d.el.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
    // Where it would land: standard move semantics — remove at `from`, insert
    // at `to` — read off the frozen slot boxes.
    //
    // READING ORDER, not x alone: `#myhand` is `flex-wrap:wrap` and thirteen
    // tiles at the phone's own `--th:44px` need ~468px, so on any phone the
    // hand IS two rows. Comparing x only would put a tile dropped at the left
    // of the second row before tiles that are visually above and to the right
    // of it. Row is decided first, x only within a row.
    const pastSlot = (r: DOMRect): boolean =>
      e.clientY > r.bottom ? true
      : e.clientY < r.top ? false
      : e.clientX > r.left + r.width / 2;
    let to = d.from;
    for (let i = 0; i < d.rects.length; i++) {
      if (i === d.from) continue;
      if (i < d.from && !pastSlot(d.rects[i]!)) to = Math.min(to, i);
      if (i > d.from && pastSlot(d.rects[i]!)) to = Math.max(to, i);
    }
    if (to !== d.to) d.to = to;
    // The gap. Each displaced tile is moved to its NEIGHBOUR'S frozen box —
    // a real (dx, dy), not a fixed slot width — which is the only version
    // that survives a wrap: the tile at the end of the first row slides down
    // and left to the start of the second, exactly as the reflow would, and
    // there is no reflow. Transforms only, so nothing relayouts and the row's
    // own `transition:transform .12s` does the sliding. No rAF loop anywhere
    // in this gesture.
    for (let i = 0; i < d.tiles.length; i++) {
      if (i === d.from) continue;
      const shift = to > d.from && i > d.from && i <= to ? -1
        : to < d.from && i >= to && i < d.from ? 1 : 0;
      if (!shift) { d.tiles[i]!.style.transform = ""; continue; }
      const src = d.rects[i]!, dst = d.rects[i + shift]!;
      d.tiles[i]!.style.transform =
        `translate(${(dst.left - src.left).toFixed(1)}px,${(dst.top - src.top).toFixed(1)}px)`;
    }
  });

  row.addEventListener("pointerup", (e) => endDrag(true, e.clientX, e.clientY));
  row.addEventListener("pointercancel", (e) => endDrag(false, e.clientX, e.clientY));
  // Capture phase, so it runs before the per-tile `onclick` render() attaches.
  row.addEventListener("click", (e) => {
    if (!swallowHandClick) return;
    swallowHandClick = false;
    window.clearTimeout(swallowTimer);
    e.stopPropagation();
    e.preventDefault();
  }, true);
  // "a tap elsewhere lowers it" (build item 3) — anywhere that is not another
  // tile in your own hand, since tapping one of those lifts that one instead.
  document.addEventListener("click", (e) => {
    if (!liftedEl) return;
    const el = closestTile(e.target);
    if (el && $("myhand").contains(el)) return;
    lowerTile();
  });
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
const TOSS_MS = 480;   // one motion, ease with a tiny overshoot, minimal spin (Augustine, 2026-09-02)
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
/* ── the throw's name, held for the claim window (build item 1) ──────────
 * The 640ms flash is right for the eighty throws a hand that nobody wants:
 * it is gone before the tile lands and it never competes with anything. It
 * is wrong for the throw somebody CAN take — the player is looking at a
 * pung/chow/pass decision with nothing on screen naming the tile.
 *
 * So the flash now has a second life: while a claim window is open for this
 * seat, `render()` calls `holdSay()` and the same element settles into a
 * small neutral label at the thrower's position (`#say.held` in index.html)
 * until the window closes. `sayHold` is the WANTED state; the flash's own
 * timer is what actually applies it, so a hold asked for mid-flash never
 * truncates the flash — it just changes what happens when it finishes. */
let sayHold: { tile: TileId; screenPos: 0 | 1 | 2 | 3 } | null = null;
function applySayHold(): void {
  const h = sayHold;
  if (!h) return;
  const el = $("say");
  el.innerHTML = `<div class="inner">${name(h.tile)}</div>`;
  el.className = `held s${h.screenPos}`;
}
/** Asks for the hold. A no-op if it is already held on the same tile (never
 *  restart it — `render()` runs many times while one window is open), and
 *  deferred to the flash's own timer if a flash is still running. */
function holdSay(tile: TileId, screenPos: 0 | 1 | 2 | 3): void {
  if (sayHold && sayHold.tile === tile && sayHold.screenPos === screenPos) return;
  sayHold = { tile, screenPos };
  if ($("say").classList.contains("show")) return;   // the flash's timer will apply it
  applySayHold();
}
/** Drops the hold — the window closed, or the hand did. Leaves a running
 *  flash alone; that has its own timer and its own reason to be up. */
function releaseSay(): void {
  if (!sayHold) return;
  sayHold = null;
  const el = $("say");
  if (el.classList.contains("held")) el.className = "";
}
/** `screenPos`: 0-3, already converted with `rel()` by the caller. */
function sayDiscard(tile: TileId, screenPos: 0 | 1 | 2 | 3): void {
  sayHold = null;                       // a new throw supersedes the old hold
  const el = $("say");
  el.innerHTML = `<div class="inner">${name(tile)}</div>`;
  el.className = "";
  void el.offsetWidth;
  el.style.setProperty("--sayms", `${SAY_MS}ms`);
  el.className = `show s${screenPos}`;
  clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => {
    if (sayHold) applySayHold(); else el.className = "";
  }, SAY_MS);
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
 *  resolved by the caller.
 *
 *  `tiles` (build item 2) is what the call is ABOUT, drawn to the left of the
 *  text through the site's own renderer (`face()`, same art as everywhere
 *  else) — the tile for a pung or a kong, all three for a chow, the winning
 *  tile for a win, the flower for a flower. An empty array draws nothing, so
 *  a call with no tile to show (a concealed kong seen from another seat,
 *  whose tile is nulled by the redacted serializer) degrades to text alone
 *  rather than to a placeholder.
 *
 *  Layout, colour and sizing all live in index.html's `#call` block — see its
 *  own comment for why the Cantonese and the English are the same size and
 *  the underline is the only colour in the banner. Show/hide timing here is
 *  unchanged: 2.2s, 3.2s for a win, matching the `callIn` animation. */
function announce(
  kind: string, who: string, extra = "", screenPos: 0 | 1 | 2 | 3 = 0, tiles: TileId[] = [],
): void {
  const [ch, en] = CALLS[kind] ?? [kind, ""];
  const el = $("call");
  const art = tiles.length ? `<span class="ct">${tiles.map((t) => tileHtml(t)).join("")}</span>` : "";
  const caption = [who, extra].filter(Boolean).join(" · ");
  el.innerHTML = `<div class="inner">${art}<span class="cb">`
    + `<span class="cline"><span class="cc">${ch}</span><span class="ce">${en}</span></span>`
    + `<span class="cw">${caption}</span></span></div>`;
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
  if (deadlineTs === 0) { noClock = true; stopClock(); $("clockbar").style.display = "none"; return; }
  noClock = false;
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
    // Build item 1: anything that is not the throw itself, and not part of
    // the claim negotiation around it, ends the window on the tile in play.
    // The `discard` case below re-arms it for the new throw.
    if (e.type !== "discard" && !THROW_SURVIVES.has(e.type)) liveThrowId = null;
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
        // The start card (task brief item 2) closes the same way — a `deal`
        // could only land if the server's own hold is genuinely over.
        closeStartCardOnPlay();
        pileTiles = []; handSig = ""; landingMeld = null;
        pendingOptimisticDiscard = null;
        // A fresh hand: no throw in play, no held label, and the local hand
        // arrangement (build item 4) starts from the server's default again —
        // last hand's order means nothing to thirteen new tiles.
        liveThrowId = null; handOrder = [];
        lowerTile();
        sayHold = null;
        $("say").className = "";
        buildWall();
        // "this hand"'s chat filter (§8 task item 2) anchors here — a fresh
        // deal is the one unambiguous hand boundary a seat socket ever sees.
        handStartTs = e.ts;
        renderTableChat();
        break;
      case "flowerReplacement":
        feed.push(`${seatName(p.seat as SeatIndex)} reveals ${name(p.flower as TileId)} 花`);
        // The flower itself is drawn in the banner now (build item 2), so the
        // name it used to spell out as `extra` would only repeat the picture.
        announce("flower", seatName(p.seat as SeatIndex), "", rel(p.seat as SeatIndex),
          [p.flower as TileId]);
        break;
      case "discard": {
        const seat = p.seat as SeatIndex, tile = p.tile as TileId;
        // Task item 3: this seat's own discard already tossed on tap — the
        // pile entry (and its `.pos`, fixed once by the very placement loop
        // the toss reused, `render()` below) already exists. Reconcile
        // instead of pushing a second one, or the pile loop's own
        // "have.has(d.id)" new-node check creates a fresh DOM node and
        // re-tosses it (exactly what this feature exists to avoid).
        if (seat === mySeat && pendingOptimisticDiscard?.tile === tile) {
          // The optimistic entry is already the live throw (the click handler
          // armed it) — reconciling must not renumber it.
          pendingOptimisticDiscard = null;
        } else {
          pileTiles.push({ id: ++pileSeq, tile, seat });
          liveThrowId = pileSeq;
        }
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
        // Build item 2: a chow shows the RUN it built (three tiles, off the
        // event's own `meld` — `claimed` is not redacted, so `meld.tiles` is
        // always real here); a pung or a kong shows the tile that was taken,
        // since three or four of the same picture says nothing four times.
        const meld = p.meld as Meld | undefined;
        const art = kind === "chow" ? (meld?.tiles ?? [tile]) : [tile];
        announce(kind, seatName(seat), "", rel(seat), art);
        break;
      }
      case "concealedKong": {
        // 暗槓 lies face down: the redacted payload nulls `tile` for every
        // seat but the one declaring it, so the banner shows text alone there
        // rather than inventing a tile (events.ts RedactedConcealedKongPayload).
        const kt = p.tile as TileId | null;
        feed.push(`${seatName(p.seat as SeatIndex)} declares a concealed kong 暗槓`);
        announce("concealedKong", seatName(p.seat as SeatIndex), "", rel(p.seat as SeatIndex),
          kt === null ? [] : [kt]);
        break;
      }
      case "addedKong":
        feed.push(`${seatName(p.seat as SeatIndex)} adds a kong 加槓`);
        announce("addedKong", seatName(p.seat as SeatIndex), "", rel(p.seat as SeatIndex),
          [p.tile as TileId]);
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
        announce(ctx.selfDraw ? "selfDraw" : "win", seatName(ctx.seat), `${sc.faan} faan`,
          rel(ctx.seat), [ctx.winningTile]);
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
/* Has the first deal happened? `welcome`/`restore` say so (2026-09-03,
 * `started`); an older server does not, and then the snapshot has to do:
 * a hand past the first, any discard on the table, or an open prompt all
 * mean the table is playing. The waiting room keys off THIS — it used to
 * key off "every human is connected", which is also false mid-match
 * whenever one seat is disconnected and bot-played, so a rejoin (or a
 * reconnect after a deploy) sat on "Waiting for the table" forever. */
let matchStarted: boolean | null = null;
function tableStarted(): boolean {
  if (matchStarted !== null) return matchStarted;
  if (!snap) return false;
  return snap.handIndex > 0
    || snap.seats.some((s) => s.discards.length > 0)
    || (pending !== null && pending.length > 0);
}
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
  // The start card (task brief item 2, §8a-2) — above the waiting room: a
  // `starting` push only ever fires once every human seat is connected, so
  // by the time it lands `humansConnected()` is already true and the
  // waiting room would show nothing here anyway; this ordering is belt and
  // braces, same spirit as the reveal-before-matchEnd rule just above.
  if (startingInfo) { showStartCard(); return; }
  if (snap && directory && !tableStarted() && !humansConnected()) { waitingRoomScreen(); return; }
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

/** Sets/clears the start card's state (task brief item 2, §8a-2) — called
 *  from `onWelcome`/`onRestore` (already holding when this socket connects)
 *  and `onStarting` (starts holding while connected). `null` tears the
 *  whole thing down; a fresh payload arms both of its own timers. Does NOT
 *  call `render()`/`syncVeil()` itself — every caller does that right after,
 *  same convention `closeReveal()` already follows. */
function applyStarting(payload: StartingPayload | null): void {
  window.clearTimeout(startingCloseTimer); startingCloseTimer = 0;
  window.clearInterval(startingTickTimer); startingTickTimer = 0;
  startingInfo = payload;
  startCardReady = false;
  if (!payload) return;
  currentSpeed = payload.settings.speed;
  startingCloseTimer = window.setTimeout(() => {
    startingInfo = null;
    render(); syncVeil();
  }, Math.max(0, payload.startsAt - Date.now()) + 250);
  // 1Hz repaint of the countdown text only, while the card is actually up —
  // same "bounded, not continuous" exception to the zero-idle-rAF rule
  // `startReveal()`'s own countdown already uses.
  startingTickTimer = window.setInterval(() => { if (startingInfo) showStartCard(); }, 1000);
}
/** Closes the card the moment real play proves the hold is over — called
 *  from `onPrompt` and consume()'s "deal" case. The server only ever sends
 *  either while `starting`'s own hold has genuinely ended, so arrival alone
 *  is the proof (same pattern `applyBatch()` already uses for the hand-end
 *  reveal — see its own doc comment on why a fresh `deal` closes it). */
function closeStartCardOnPlay(): void {
  if (startingInfo) applyStarting(null);
}
/** The start card itself (task brief item 2). Reuses the reveal overlay's
 *  own `#veil`/`#panel` styling and `.rows`/`.row` list — the same "full
 *  table takeover" surface, just a different moment. */
function showStartCard(): void {
  const info = startingInfo;
  if (!info) return;
  $("veil").style.display = "flex";
  const s = info.settings;
  const remain = Math.max(0, Math.ceil((info.startsAt - Date.now()) / 1000));
  const humanCount = s.seats.filter((seat) => !seat.bot).length;
  const seatRows = s.seats.map((seat, i) => `
    <div class="row"><span class="c1">${WIND_CH[i]}
      <b>${esc(seat.displayName || (seat.bot ? "bot" : "empty seat"))}</b></span>
      <span class="c2 mut" style="width:auto">${seat.bot ? "bot" : ""}</span></div>`).join("");
  const readyBtn = startCardReady
    ? `<button id="btnStartReady" disabled style="opacity:.55">waiting for others…</button>`
    : `<button id="btnStartReady">${humanCount <= 1 ? "start now ▸" : "ready ▸"}</button>`;
  $("panel").innerHTML = `
    <h1>Hong Kong Old Style · ${esc(s.rulesetLabel)}</h1>
    <p class="mut">${s.minimumFaan}–${s.limitFaan} faan · ${s.useFlowers ? "flowers" : "no flowers"}
      · ${esc(PAYMENT_LABELS[s.paymentId] ?? s.paymentId)} payments · ${matchFormatLabel(s.matchFormat)}</p>
    <p class="mut">${esc(SPEED_INFO[s.speed]?.wordy ?? s.speed)}</p>
    <div class="rows" style="margin-top:10px">${seatRows}</div>
    <p class="mut" style="margin-top:10px">starting in ${remain}s</p>
    <div style="margin-top:10px">${readyBtn}</div>`;
  const b = document.getElementById("btnStartReady") as HTMLButtonElement | null;
  if (b && !startCardReady) {
    b.onclick = () => {
      startCardReady = true;
      void ts?.requestNextHand().catch(() => { /* best effort — the countdown/close-on-play still ends it */ });
      showStartCard();
    };
  }
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
    <p class="mut">speed: ${currentSpeed
      ? `<span class="badge speed">${esc(SPEED_INFO[currentSpeed]?.label ?? currentSpeed)}</span>`
      : "…"}</p>
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
    paused = null; myAuto = false; myAutoIdle = false; myAutoRequestedOn = false; noClock = false;
    currentSpeed = null; applyStarting(null); pendingOptimisticDiscard = null;
    closeReveal(); pendingWinDetail = null; pendingDrawDistance = null;
    updateChatVisibility();
    updateHudButtons();
    hostHooks.leaveToShell();
  };
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".pname[data-player]"))) {
    const id = el.dataset.player;
    if (!id) continue;
    el.onclick = (e) => { e.stopPropagation(); hostHooks.goToPlayer(id); };
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
  paused = null; myAuto = false; myAutoIdle = false; myAutoRequestedOn = false; noClock = false;
  currentSpeed = null; applyStarting(null); pendingOptimisticDiscard = null;
  closeReveal(); pendingWinDetail = null; pendingDrawDistance = null;
  // Table-only view state (build items 1/3/4). `body.claimwindow` and the
  // coach's `body.counting` are on the BODY, which outlives the table screen
  // — without this they follow the player into the shell.
  liveThrowId = null; handOrder = []; sayHold = null;
  lowerTile(); clearTileCoach();
  document.body.classList.remove("claimwindow");
  $("say").className = "";
  stopClock();
  matchClockBase = null; paintHudClock();
  matchStarted = null;
  updateChatVisibility();
  updateHudButtons();
  hostHooks.leaveToShell();
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
  if (myAuto) { myAuto = false; myAutoIdle = false; myAutoRequestedOn = false; updateHudButtons(); }
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
      // Task item 3: any failure of a discard this client tossed
      // optimistically (a real `rejected`, a timeout, or the socket closing
      // mid-flight — `TableSocket.request`'s promise rejects the same way
      // for all three) puts the tile back. Dropping the pile entry is
      // enough: the pile loop's own "remove whatever isn't in `pileTiles`
      // any more" cleanup (`render()`, below) takes the DOM node with it,
      // and the hand filter (also `render()`) stops excluding the tile the
      // instant `pendingOptimisticDiscard` is cleared.
      if (a.type === "discard" && pendingOptimisticDiscard?.tile === a.tile) {
        if (liveThrowId === pendingOptimisticDiscard.pileId) liveThrowId = null;
        pileTiles = pileTiles.filter((d) => d.id !== pendingOptimisticDiscard!.pileId);
        pendingOptimisticDiscard = null;
      }
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

/** Re-paints the table if one is live — called by the shell's Game settings
 *  page after a tile-size/handicap change, so a setting flipped while a
 *  match is connected (but the shell is showing on top, via
 *  `hostHooks.goToSettings`) takes effect the moment the player goes back to
 *  it, without this file exposing `snap`/`render` themselves. */
export function refreshTableIfLive(): void {
  if (snap) render();
}

function render(): void {
  paintHudTitle();
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
  const pileTh = Math.round(Math.min(46, Math.max(21, boxW / 14.3)));
  pileEl.style.setProperty("--pileth", `${pileTh}px`);
  // Mirrored onto the root so anything OUTSIDE #pile can size against the same
  // tile — the call banner's art (build item 2) is 1.4x the pile tile, and
  // #call is a sibling of #centre, so it never inherits #pile's own variable.
  document.documentElement.style.setProperty("--pileth", `${pileTh}px`);
  const probe = pileEl.querySelector<HTMLElement>(".tile");
  const th = probe?.offsetHeight || 36;
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
          rot: best.rot + (jr() - 0.5) * 12, spin: 0,
        };
        if (!fits(c)) continue;
        const settled = drop(c);
        if (far(settled) < far(best)) best = settled;
      }
    }
    d.pos = best ?? { x: boxW / 2, y: boxH / 2, rot: 0, spin: 0 };
    d.pos.spin = jr() * 30 - 15;   // minimal spin in flight (Augustine, 2026-09-02)
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
    // `.hot` (build item 1) is no longer decided here. Insertion time is the
    // wrong moment for it: it can only ever say "this is the newest tile",
    // which stops being true the instant the next one lands, while the ring
    // has to come off when the window SHUTS — often long before that. The
    // single toggle after this loop owns it, off `liveThrowId`.
    // Queue any draw that lands behind this toss (motion queue above) — set
    // BEFORE the element goes in, not after, so a draw rendered later in
    // this same pass (own hand, or an opponent's backrow) already sees it.
    lastTossAt = performance.now();
    // ONE motion straight to the slot (`d.pos`, fixed above and never
    // recomputed once set) — no `--lx`/`--ly`/`--lr` "contact" leg any more,
    // see the `toss` keyframe's own doc comment in index.html.
    pileEl.insertAdjacentHTML("beforeend", tileHtml(d.tile, "pt fresh",
      `data-pid="${d.id}" style="left:${d.pos!.x.toFixed(1)}px;top:${d.pos!.y.toFixed(1)}px;`
      + `--fx:${from[0]}px;--fy:${from[1]}px;--fr:${d.pos!.spin.toFixed(0)}deg;`
      + `--rot:${d.pos!.rot.toFixed(1)}deg;--tossms:${TOSS_MS}ms;`
      // `scale(var(--hotscale,1))` is inert (1) on every tile but the one in
      // play — a class cannot override an inline transform, so the 1.12x of
      // `#pile .tile.hot` has to ride a variable this inline style reads.
      + `transform:translate(-50%,-50%) rotate(${d.pos!.rot.toFixed(1)}deg) scale(var(--hotscale,1))"`));
  }
  // Build item 1: exactly one tile wears the seal-red ring, and only for as
  // long as it can still be claimed. Re-asserted every render rather than set
  // once, so a resize, a reconnect or a re-render can never leave it stale.
  for (const el of Array.from(pileEl.children)) {
    el.classList.toggle("hot", Number((el as HTMLElement).dataset.pid) === liveThrowId);
  }

  const mine = (i: number): string =>
    landingMeld && landingMeld.seat === mySeat && landingMeld.index === i ? "claimed" : "";
  $("mymelds").innerHTML = me.melds.map((m, i) => m.tiles.map((t) => tileHtml(t, mine(i))).join(""))
    .join('<span style="width:10px"></span>')
    + me.flowers.map((t) => tileHtml(t, "fl")).join("");

  // Task brief item 3: auto-play disables this seat's own controls entirely.
  const canDiscard = !!pending?.some((a) => a.type === "discard") && !myAuto;
  const hand = [...me.hand].sort((a, b) => a - b);
  // Task item 3 (§8a-2 optimistic discard): the tile already tossed on tap
  // is pulled OUT of the rendered hand — drawn-tile and hand-tile are two
  // different slots in this markup (摸切 discards the drawn tile itself),
  // so both are checked; only ever one of the two ever matches.
  let drawnTile = me.drawn;
  if (pendingOptimisticDiscard) {
    if (drawnTile === pendingOptimisticDiscard.tile) {
      drawnTile = null;
    } else {
      const k = hand.indexOf(pendingOptimisticDiscard.tile);
      if (k >= 0) hand.splice(k, 1);
    }
  }
  $("myhand").className = canDiscard ? "" : "locked";
  // Build item 4: `hand` is the DEFAULT order (what the server gave, sorted);
  // `shown` is that order with the player's own local arrangement applied.
  // Only `shown` is ever drawn, and only `hand` is ever compared against to
  // decide whether the sort button has anything to undo.
  const shown = orderedHand(hand);
  const reordered = handReordered(hand, shown);
  const sig = `${shown.join(",")}|${drawnTile ?? "-"}|${canDiscard}|${reordered ? "r" : ""}`;
  if (sig !== handSig) {
    handSig = sig;
    // Motion queue (task item 4): if a discard's toss just landed in THIS
    // same render pass (or is still settling from the last one), this draw
    // waits behind it rather than starting in the same frame — see the
    // `queueBehindToss` doc comment above.
    const drawDelay = queueBehindToss();
    $("myhand").innerHTML = shown.map((t) => tileHtml(t, "", `data-t="${t}"`)).join("")
      + (drawnTile !== null
          ? tileHtml(drawnTile, "drawn",
              `data-t="${drawnTile}" style="--drawms:${DRAW_MS}ms;--drawdelay:${drawDelay}ms;`
              + `--wx:${(120 - shown.length * 9).toFixed(0)}px;--wy:-190px"`)
          : "")
      + (reordered
          ? `<button class="handsort" id="handSort" title="${esc(t(S.sortHandTitle))}">${esc(t(S.sortHand))}</button>`
          : "");
    // The row was rebuilt, so whatever was lifted is gone with it — every
    // change that rebuilds this markup (a draw, a discard, a claim, a
    // rearrange) also invalidates the lift, so this is a drop, not a loss.
    if (liftedEl && !$("myhand").contains(liftedEl)) { liftedEl = null; clearTileCoach(); }
    // The coach's read survives a rebuild the same way: its tile either
    // still exists (re-run the read so the fresh `.tile` nodes get their
    // `.samet` back) or is gone (fall back to the lift, or to nothing).
    if (coachedEl) {
      const el = coachedEl; coachedEl = null;
      if (document.contains(el)) showTileCoach(el); else clearTileCoachToLift();
    }
    // Same for a drag in flight (build item 4): a rebuild while a finger is
    // down — a draw landing because the turn came round mid-drag — detaches
    // the node being dragged and every slot rect measured against it, so the
    // gesture is abandoned rather than committed against stale geometry. The
    // swallow flag still has to be armed: the browser will fire the click
    // this gesture ends in whether or not this file is still listening, and
    // that click must not become a discard.
    if (handDrag && !$("myhand").contains(handDrag.el)) {
      if (handDrag.moved) {
        swallowHandClick = true;
        window.clearTimeout(swallowTimer);
        swallowTimer = window.setTimeout(() => { swallowHandClick = false; }, 300);
      }
      handDrag = null;
    }
  }
  const sortBtn = document.getElementById("handSort") as HTMLButtonElement | null;
  if (sortBtn) {
    sortBtn.onclick = () => {
      handOrder = [];              // back to the default the renderer already uses
      lowerTile();
      handSig = "";
      render();
    };
  }
  // Not your turn any more: nothing is liftable, so nothing stays lifted.
  if (!canDiscard) lowerTile();
  if (canDiscard) {
    for (const el of Array.from($("myhand").querySelectorAll<HTMLElement>(".tile"))) {
      el.onclick = () => {
        if (pendingOptimisticDiscard) return; // one pending discard at a time
        const t = Number(el.dataset.t) as TileId;
        const a = pending?.find((x) => x.type === "discard" && x.tile === t);
        if (!a) return;
        // Build item 3: the FIRST tap on a tile that is not already lifted
        // only raises it (and lights its count/what-if read). The second tap
        // on that same tile falls through to the throw below. With the
        // applicable toggle off, there is no first tap — one tap throws.
        if (doubleTapDiscard() && liftedEl !== el) { liftTile(el); return; }
        lowerTile();
        if (isDesktop()) gradeMyDiscard(t);
        // Optimistic discard (task item 3): toss the tile NOW, off the same
        // pile-placement function the real event will read too — the loop
        // below only assigns `.pos` once per `pileTiles` entry, so the slot
        // chosen here is never recomputed once the server's own `discard`
        // reconciles it (consume()'s "discard" case). `act()` clears
        // `pending` synchronously, so a second tap before this round-trips
        // has no legal action to find anyway — the guard above is belt and
        // braces on top of that.
        const pid = ++pileSeq;
        pileTiles.push({ id: pid, tile: t, seat: mySeat });
        pendingOptimisticDiscard = { tile: t, pileId: pid };
        liveThrowId = pid;                 // build item 1: it is in play now
        sayDiscard(t, rel(mySeat));
        act(a);
      };
    }
  } else if (myAuto && myAutoIdle) {
    // Task item 4: "tap any tile to take back" — this seat's own idle-timeout
    // auto (not a voluntary one, see `myAutoIdle`'s doc comment) is the one
    // case where the — otherwise fully inert, `.locked` — hand still answers
    // a tap, and what it does is relinquish auto rather than discard
    // whatever was tapped; the player gets a normal turn back on the next
    // real prompt, same as `requestAuto(false)` from the HUD button already
    // does.
    for (const el of Array.from($("myhand").querySelectorAll<HTMLElement>(".tile"))) {
      el.onclick = () => {
        void ts?.requestAuto(false).catch((e) =>
          flashHudNote(e instanceof RequestRejected ? (REJECT_NOTES[e.code] ?? e.code) : "that didn't go through"));
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
    // `.taphint` + `data-base` (build item 3): `paintTapHint()` swaps these to
    // "tap again to discard" while a tile is lifted and back again when it is
    // lowered, without going near `render()` — a lift changes no game state.
    const tapHint = (words: string): string =>
      `<span class="hint taphint" data-base="${esc(words)}">${esc(words)}</span>`;
    bar = btns.join("") || (canDiscard ? tapHint("your turn — tap a tile to discard") : "");
    if (btns.length && canDiscard) bar += tapHint("or tap a tile to discard");
  } else if (!overlay) bar = `<span class="hint">…</span>`;
  $("actions").innerHTML = bar;
  paintTapHint();
  for (const el of Array.from($("actions").querySelectorAll<HTMLElement>("button"))) {
    el.onclick = () => {
      const a = pending?.[Number(el.dataset.i)];
      if (a) { if (isDesktop()) gradeMyClaim(a); act(a); }
    };
  }
  /* ── the claim window (build item 1) ──────────────────────────────────
   * "A prompt with claims offered" — read off `pending`, the same server
   * truth every button here is built from, never inferred from the snapshot.
   * `pass` counts: the server only ever offers it alongside a claim, and a
   * window where the only thing on the table is "decline" is still a window.
   *
   * While it is open: `body.claimwindow` steps every other highlight back to
   * 40% (index.html), and the thrown tile's NAME stays on screen at the
   * thrower's position instead of having flashed past 640ms after the toss. */
  const claimWindow = !!pending?.some((a) => a.type === "claim" || a.type === "pass") && !myAuto;
  document.body.classList.toggle("claimwindow", claimWindow);
  const throwEntry = liveThrowId === null ? undefined : pileTiles.find((d) => d.id === liveThrowId);
  if (claimWindow && throwEntry) holdSay(throwEntry.tile, rel(throwEntry.seat));
  else releaseSay();

  $("log").innerHTML = feed.map((l) => `<div>${l}</div>`).join("");
  $("callwrap").innerHTML = isDesktop() ? callingBar() : "";
  $("devwrap").innerHTML = isDesktop() ? devPanel() : "";
  updateHudButtons();
  updateClockNote();
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
    wireMuteTaps(box, () => renderTableChat());
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
  document.getElementById("chatBtn")?.classList.toggle("open", open);
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
/** The HUD's left slot (gameplay-lab: "the table's name and ruleset in
 *  mono caps on the left where the empty net-status used to sit"): ruleset ·
 *  round wind · speed while a match is open, blank otherwise. */
function paintHudTitle(): void {
  const el = document.getElementById("hudTitle");
  if (!el) return;
  if (currentMatchUuid === null) { el.textContent = ""; return; }
  const parts = [ruleLabel(currentRulesetId)];
  if (snap) parts.push(`${["東", "南", "西", "北"][snap.roundWind] ?? ""}圈`);
  if (currentSpeed) parts.push(String(currentSpeed));
  el.textContent = parts.join(" · ");
  paintHudClock();
}
function updateHudButtons(): void {
  const show = currentMatchUuid !== null;
  paintHudTitle();
  const p = document.getElementById("btnPause") as HTMLButtonElement | null;
  if (p) {
    p.style.display = show ? "" : "none";
    p.textContent = paused ? "resume" : "pause";
    p.classList.toggle("on", !!paused);
  }
  const a = document.getElementById("btnAuto") as HTMLButtonElement | null;
  if (a) {
    a.style.display = show ? "" : "none";
    a.classList.toggle("on", myAuto);
    a.textContent = myAuto ? "auto · on" : "auto";
  }
}
/** `#clockNote` — task brief item 4: sits where the clock bar's own 3px
 *  track would be, for the two states with no running clock to show there.
 *  `noClock` is set purely off `startClock(0)`'s own sentinel (see its doc
 *  comment), so this needs no separate knowledge of the table's `speed` and
 *  degrades correctly even when that field never arrives. The idle-auto
 *  line takes priority — it is actionable ("tap any tile"), not just a
 *  status line, and (§8a-2) it only ever happens in untimed play anyway. */
function updateClockNote(): void {
  const el = document.getElementById("clockNote");
  if (!el) return;
  if (currentMatchUuid === null) { el.style.display = "none"; return; }
  if (myAuto && myAutoIdle) {
    el.textContent = "auto on: idle for 10 min · tap any tile to take back";
    el.className = "idle";
    el.style.display = "";
  } else if (noClock) {
    el.textContent = "no clock";
    el.className = "";
    el.style.display = "";
  } else {
    el.style.display = "none";
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
 *  rebuilt per screen/match) — mirrors how `#btnSettings`/
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
export function connectToMatch(r: {
  matchUuid: string; joinCode: string | null; seat: SeatIndex; seatToken: string;
  rulesetId: string; matchFormat: MatchFormat; creator?: boolean;
  /** Best-effort seed for the waiting room — see `seatPlan`'s doc comment. */
  seatPlan?: FourSeats<SeatPlanEntry> | null;
  /** Best-effort seed for `currentSpeed` — see its own doc comment. */
  speed?: TableSpeed | null;
}): void {
  hostHooks.enterTable();
  currentMatchUuid = r.matchUuid; currentJoinCode = r.joinCode;
  currentRulesetId = r.rulesetId; currentMatchFormat = r.matchFormat;
  mySeat = r.seat;
  isCreatorOfCurrentTable = r.creator ?? false;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    matchUuid: r.matchUuid, joinCode: r.joinCode, seat: r.seat, creator: isCreatorOfCurrentTable,
  }));
  snap = null; directory = null; seatPlan = r.seatPlan ?? null; lastSeq = -1; curLegal = null; pending = null;
  overlay = null; matchEndInfo = null; matchAgreement = undefined;
  paused = null; myAuto = false; myAutoIdle = false; myAutoRequestedOn = false; noClock = false;
  currentSpeed = r.speed ?? null;
  applyStarting(null);
  window.clearTimeout(revealTimer); revealTimer = 0; revealDeadlineTs = null; revealRequested = false;
  pendingWinDetail = null; pendingDrawDistance = null;
  pileTiles = []; handSig = ""; landingMeld = null; feed.length = 0;
  liveThrowId = null; handOrder = []; sayHold = null;
  lowerTile(); clearTileCoach();
  document.body.classList.remove("claimwindow");
  pendingOptimisticDiscard = null;
  sessionHands.length = 0; coachTally.graded = 0; coachTally.matched = 0;
  tableChat = []; handStartTs = 0; chatShowAll = false; chatUnread = 0; chatOpen = false;
  renderTableChat();
  for (const k of Object.keys(presence)) delete presence[Number(k) as SeatIndex];
  ts?.close();
  ts = new TableSocket(r.matchUuid, r.seatToken, {
    onWelcome(payload: WelcomePayload, starting) {
      matchStarted = payload.started ?? null;
      directory = payload.directory;
      mySeat = payload.seat;
      currentRulesetId = payload.rulesetId;
      snap = payload.snapshot;
      lastSeq = payload.snapshot.seq;
      paused = payload.paused;
      myAuto = payload.directory[mySeat]?.auto ?? false;
      // A fresh join has no history to tell "I asked for this" from "the
      // idle timeout did" — read as plain auto, never the idle banner, same
      // as a reconnect landing mid-idle-auto would.
      myAutoIdle = false; myAutoRequestedOn = false;
      applyStarting(starting);
      seedPileFromSnapshot();
      buildWall();
      setConnBadge("");
      render();
      syncVeil();
      updateChatVisibility();
      updateHudButtons();
      ts?.resync(lastSeq);
    },
    onRestore(events, snapshot, dir, pausedInfo, starting, started) {
      if (started !== undefined) matchStarted = started;
      // Who sits where may have changed (seats filled or shuffled) since this
      // seat's own `welcome` — `restore`'s directory is the fresh truth,
      // wholesale, same as `welcome`'s (never patched field-by-field).
      directory = dir;
      const wasPaused = paused !== null;
      paused = pausedInfo;
      if (!wasPaused && paused) freezeClock();
      else if (wasPaused && !paused) thawClock();
      myAuto = dir[mySeat]?.auto ?? false;
      applyStarting(starting);
      applyBatch(events, snapshot);
    },
    onEvents(events, snapshot) { applyBatch(events, snapshot); },
    onStarting(payload) { applyStarting(payload); render(); syncVeil(); },
    onPrompt(payload: PromptPayload) {
      // The start card (task brief item 2) closes the same way `deal` does
      // above — a real prompt could only be sent once the server's own hold
      // is over.
      closeStartCardOnPlay();
      matchStarted = true;
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
      if (payload.seat === mySeat) {
        // Task item 4: tell "the idle timeout did this" from "I asked for
        // this" — see `myAutoIdle`'s own doc comment for the heuristic.
        if (payload.auto && !myAuto && !myAutoRequestedOn) myAutoIdle = true;
        if (!payload.auto) myAutoIdle = false;
        myAutoRequestedOn = false;
        myAuto = payload.auto;
      }
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

/** The HUD's own gear button, while a match is live — unchanged from before
 *  the shell rebuild (table screen behaviour). The shell's own richer Game
 *  settings PAGE (`shell/pages/settings.ts`, reachable from Profile even
 *  outside a match) reads/writes the exact same `SETTINGS` object; this stays
 *  the quick in-match version so leaving the table is never required just to
 *  nudge the tile size. */
function settingsScreen(back: () => void): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").innerHTML = `
    <h1>Settings</h1>
    <h2 style="margin-top:14px">Table</h2>
    <div class="setrow"><label>Tile size</label>
      <input type="range" id="setScale" min="${TILE_SCALE_MIN}" max="${TILE_SCALE_MAX}" step="0.05" value="${SETTINGS.tileScale}">
      <span id="setScaleV">${Math.round(SETTINGS.tileScale * 100)}%</span>
      <a href="#" id="setScaleReset" class="mut">reset</a></div>
    <div class="setrow"><label>${esc(t(S.doubleTapDiscardDesktop))}</label>
      <input type="checkbox" id="ddtDesktop" ${SETTINGS.discardDoubleTapDesktop ? "checked" : ""}>
      <span class="mut">first click lifts the tile and reads it, second click on the same
        tile throws it — a thrown tile cannot be taken back</span></div>
    <div class="setrow"><label>${esc(t(S.doubleTapDiscardPhone))}</label>
      <input type="checkbox" id="ddtMobile" ${SETTINGS.discardDoubleTapMobile ? "checked" : ""}>
      <span class="mut">the same, for a touch pointer or a screen under 768px</span></div>
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
    <p class="mut"><a href="#" id="fullSettings" style="color:var(--gold)">sound, haptics, language, theme ›</a></p>
    <button id="btnBack">done ▸</button>`;
  const sc = document.getElementById("setScale") as HTMLInputElement;
  sc.oninput = () => { SETTINGS.tileScale = Number(sc.value); $("setScaleV").textContent = `${Math.round(SETTINGS.tileScale * 100)}%`; saveSettings(); if (snap) render(); };
  (document.getElementById("setScaleReset") as HTMLElement).onclick = (e) => { e.preventDefault(); sc.value = "1"; sc.oninput!(new Event("input")); };
  // Esc closes the panel — the one way out that cannot be under anything.
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const close = (): void => { document.removeEventListener("keydown", onKey); $("veil").style.display = "none"; back(); };
  document.addEventListener("keydown", onKey);
  const dv = document.getElementById("setDev") as HTMLInputElement;
  dv.onchange = () => { SETTINGS.dev = dv.checked; saveSettings(); if (snap) render(); };
  for (const [id, key] of [
    ["hcCount", "hcCount"], ["hcCalling", "hcCalling"], ["hcWhatIf", "hcWhatIf"],
    ["ddtDesktop", "discardDoubleTapDesktop"], ["ddtMobile", "discardDoubleTapMobile"],
  ] as const) {
    const box = document.getElementById(id) as HTMLInputElement | null;
    if (box) box.onchange = () => { (SETTINGS as never as Record<string, boolean>)[key] = box.checked; saveSettings(); if (snap) render(); };
  }
  (document.getElementById("btnBack") as HTMLButtonElement).onclick = () => close();
  (document.getElementById("fullSettings") as HTMLElement).onclick = (e) => {
    e.preventDefault(); close(); hostHooks.goToSettings();
  };
}

/* ── the game clock (owner, 2026-09-03) ──────────────────────────────
 * Elapsed since the first deal, mm:ss (h:mm:ss past an hour), in the HUD.
 * Base: `starting.startsAt` when the table announced one, else the moment
 * this client first saw a snapshot — a reconnect mid-match therefore reads
 * a little low, which is the honest answer for a clock nobody keeps. */
let matchClockBase: number | null = null;
function paintHudClock(): void {
  const el = document.getElementById("hudClock");
  if (!el) return;
  if (currentMatchUuid === null || !snap) { el.textContent = ""; return; }
  matchClockBase ??= startingInfo?.startsAt ?? Date.now();
  const s = Math.max(0, Math.floor((Date.now() - matchClockBase) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  el.textContent = h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The gear toggles `#hudMenu`; a tap on any row, a tap outside, or Esc
 *  closes it. The rows are the same four buttons that always existed
 *  (pause, auto, settings, quit) with their own wiring untouched. */
function wireHudMenu(): void {
  const gear = document.getElementById("btnMenu") as HTMLButtonElement | null;
  const menu = document.getElementById("hudMenu") as HTMLElement | null;
  if (!gear || !menu) return;
  const setOpen = (open: boolean): void => {
    menu.hidden = !open;
    gear.setAttribute("aria-expanded", open ? "true" : "false");
  };
  gear.onclick = (e) => { e.stopPropagation(); setOpen(menu.hidden); };
  menu.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("button")) setOpen(false); });
  document.addEventListener("pointerdown", (e) => {
    if (menu.hidden) return;
    if (!(e.target as HTMLElement).closest("#hud")) setOpen(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) setOpen(false); });
}

/** "Leave the table?" as the app's own dialog on `#veil/#panel`, not
 *  `window.confirm()` — Safari's system sheet on iPad, and suppressed
 *  outright in some standalone contexts, so a guest saw "quit just
 *  happened". Stay is the default action; Esc is stay. */
function quitScreen(back: () => void): void {
  beforeScreen();
  $("veil").style.display = "flex";
  $("panel").classList.add("modal");
  $("panel").innerHTML = `
    <div class="mhead"><h2>${esc(t(S.quitTitle))}</h2></div>
    <div class="mbody">${esc(t(S.quitBody))}</div>
    ${isCreatorOfCurrentTable ? `<div class="mbody" style="padding-top:0"><b>${esc(t(S.quitKick))}</b><br>${esc(t(S.quitKickHint))}
      <div class="kickrow">${(directory ?? []).filter((d) => !d.bot && d.seat !== mySeat && d.playerId !== "").map((d) =>
        `<button class="ghost" data-kick="${d.seat}">${esc(d.displayName)}</button>`).join("") || `<span class="mut">${esc(t(S.nothingHere))}</span>`}</div></div>
    <div class="mbody" style="padding-top:0"><b>${esc(t(S.quitEndAll))}</b><br>${esc(t(S.quitEndAllHint))}
      <div style="margin-top:8px"><button id="quitEndAll" class="ghost" style="border-color:var(--c-danger);color:var(--c-danger)">${esc(t(S.quitEndConfirm))}</button></div></div>` : ""}
    <div class="mfoot">
      <button id="quitLeave" class="ghost">${esc(t(S.quitLeave))}</button>
      <span class="hint2">esc · ${esc(t(S.quitStay))}</span>
      <button id="quitStay" class="primary">${esc(t(S.quitStay))} ▸</button>
    </div>`;
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const close = (): void => { document.removeEventListener("keydown", onKey); $("veil").style.display = "none"; back(); };
  document.addEventListener("keydown", onKey);
  ($("quitStay") as HTMLButtonElement).onclick = close;
  ($("quitStay") as HTMLButtonElement).focus();
  ($("quitLeave") as HTMLButtonElement).onclick = () => {
    document.removeEventListener("keydown", onKey);
    $("veil").style.display = "none";
    void leaveTableAndReturn(currentMatchUuid);
  };
  // Kick: two taps on the same name — the first arms it (label swaps to the
  // confirm text), the second sends. Any other tap disarms.
  for (const b of Array.from($("panel").querySelectorAll<HTMLButtonElement>("[data-kick]"))) {
    b.onclick = () => {
      if (!b.dataset.armed) {
        for (const o of Array.from($("panel").querySelectorAll<HTMLButtonElement>("[data-kick]"))) { delete o.dataset.armed; o.textContent = o.dataset.name ?? o.textContent; }
        b.dataset.name = b.textContent ?? ""; b.dataset.armed = "1"; b.textContent = t(S.quitKickConfirm);
        b.style.borderColor = "var(--c-danger)"; b.style.color = "var(--c-danger)";
        return;
      }
      b.disabled = true;
      if (identity && currentMatchUuid) {
        void apiKickSeat(identity.deviceToken, currentMatchUuid, Number(b.dataset.kick) as SeatIndex)
          .then(() => { b.textContent = `${b.dataset.name} · ${t(S.quitKicked)}`; })
          .catch(() => { b.disabled = false; delete b.dataset.armed; b.textContent = b.dataset.name ?? ""; flashHudNote("could not remove that player"); });
      }
    };
  }
  const endBtn = document.getElementById("quitEndAll") as HTMLButtonElement | null;
  if (endBtn) endBtn.onclick = () => {
    // The server's matchEnd does the rest: every client, this one included,
    // gets the scoreboard through the normal event path.
    endBtn.disabled = true;
    if (identity && currentMatchUuid) {
      void apiEndTable(identity.deviceToken, currentMatchUuid)
        .then(() => close())
        .catch(() => { endBtn.disabled = false; flashHudNote("could not end the table"); });
    }
  };
}

/** Wires the HUD chrome that is always present regardless of shell/table —
 *  pause, auto, settings, quit — plus the hover coach and the chat
 *  drawer. Called exactly once by the bootstrap (game.ts), after
 *  `setHostHooks()`, mirroring the top-level wiring the old `game.ts` used to
 *  run at import time; pulled into a function so import order no longer
 *  matters. */
export function initTableChrome(): void {
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
    if (target) myAutoRequestedOn = true;
    void ts.requestAuto(target).catch((e) => {
      if (target) myAutoRequestedOn = false;
      flashHudNote(e instanceof RequestRejected ? (REJECT_NOTES[e.code] ?? e.code) : "that didn't go through");
    });
  };
  (document.getElementById("btnSettings") as HTMLButtonElement).onclick = () => settingsScreen(() => syncVeil());
  /** "Leave table": only a live seat needs the confirm and the server-side
   *  `/leave` call — quitting from anywhere else is just "go to the shell",
   *  which `leaveTable` already does safely with a null `ts`. */
  (document.getElementById("btnQuit") as HTMLButtonElement).onclick = () => {
    if (ts && currentMatchUuid && !matchEndInfo) {
      quitScreen(() => syncVeil());
    } else {
      leaveTable();
    }
  };
  wireHudMenu();
  window.setInterval(paintHudClock, 1000);
  saveSettings();
  wireHover();
  // Build item 4: delegated on #myhand, which is static furniture (only its
  // CONTENTS are rebuilt by render()), so this is a once-at-boot wiring like
  // every other listener here — never re-attached per hand.
  wireHandDrag();
  wireChatDrawer();
  updateChatVisibility();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ts && lastSeq >= 0) ts.resync(lastSeq);
  });
}

/** Best-effort resume of a match this device was already seated at
 *  (`sessionStorage`'s `mjrc.gamepvp.activeMatch`) — used by the bootstrap
 *  at boot, before it decides whether to show the shell instead. Returns
 *  `true` (and has already called `connectToMatch`) when a session was
 *  resumed, `false` when there was nothing to resume (or resuming failed),
 *  so the caller knows to fall back to the shell/router. */
export async function resumeActiveSession(): Promise<boolean> {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw || !identity) return false;
  try {
    const s = JSON.parse(raw) as { matchUuid: string; joinCode: string | null; seat: SeatIndex; creator?: boolean };
    if (!s.joinCode) return false;
    const r = await joinTable(identity.deviceToken, s.joinCode);
    connectToMatch({
      matchUuid: r.matchUuid, joinCode: s.joinCode, seat: r.seat, seatToken: r.seatToken,
      rulesetId: r.rulesetId, matchFormat: r.matchFormat, creator: s.creator,
    });
    return true;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return false;
  }
}

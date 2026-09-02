/**
 * "Play now" (New table) and "Join by code" — task brief §11 build item 5:
 * "Play now opens the EXISTING New table screen with a room picker at the
 * top... a room with presets fixes rules/length/speed and hides those
 * pickers." Ported near-verbatim from the pre-rebuild `game.ts`'s
 * `newTableScreen()`/`doCreateTable()`/`joinScreen()` (still the
 * `#veil`/`#panel` overlay every one of those used, and still the CSS in
 * `index.html` written for them — task brief explicitly says reuse, not
 * redesign) with two additions: the room picker, and a `/j/<code>` deep
 * link opens the same join modal these were always going to need.
 */
import {
  createTable, joinRoom, joinTable, getMyRooms,
  TABLE_SPEEDS, type BotCatalogueEntry, type CreateTableResult, type MatchFormat, type RoomSummary,
  type SeatSpec, type TableAccess, type TableMode, type TableSpeed,
} from "../../net.js";
import {
  DEFAULT_BOT_LINEUP, RULE_PICKS, SPEED_INFO, WIND_CH,
  connectToMatch, loadBotCatalogue,
} from "../../table.js";
import { $, describeError, esc, identity } from "../session.js";

const OPEN_HALL_CODE = "OPEN";

/* ── shared veil plumbing (mirrors table.ts's own beforeScreen/backRow) ── */
function openVeil(): void {
  $("veil").style.display = "flex";
  $("panel").classList.remove("about", "lobby3");
}
function closeVeil(): void {
  $("veil").style.display = "none";
}
/** Navigate the shell without needing a `Router` handed all the way down
 *  here — pushes the URL, then re-fires `popstate`, which is exactly what
 *  `initRouter()`'s own listener (shell/router.ts) is already wired to. */
function navigateShell(path: string): void {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
function backButton(): string {
  return `<button id="mBack" style="margin-left:8px;background:rgba(255,255,255,.08)">◂ back</button>`;
}
function wireBackButton(onClick: () => void): void {
  const b = document.getElementById("mBack");
  if (b) (b as HTMLButtonElement).onclick = onClick;
}

/* ── New table ─────────────────────────────────────────────────────────── */

interface SeatDraft { kind: "human" | "bot"; bot: string; }
const draft: {
  roomCode: string | null; roomLocked: boolean;
  rulesetId: string; matchFormat: MatchFormat; mode: TableMode; access: TableAccess;
  randomizeSeats: boolean; seats: [SeatDraft, SeatDraft, SeatDraft, SeatDraft];
  speed: TableSpeed; speedManual: boolean;
} = {
  roomCode: null, roomLocked: false,
  rulesetId: "mjrc-standard", matchFormat: "east", mode: "casual", access: "open", randomizeSeats: false,
  speed: "untimed", speedManual: false,
  seats: [
    { kind: "human", bot: DEFAULT_BOT_LINEUP[0]! },
    { kind: "bot", bot: DEFAULT_BOT_LINEUP[1]! },
    { kind: "bot", bot: DEFAULT_BOT_LINEUP[2]! },
    { kind: "bot", bot: DEFAULT_BOT_LINEUP[3]! },
  ],
};
const LAST_ROOM_KEY = "mjrc.gamepvp.lastRoom";
const firstHumanSeatIx = (): number => Math.max(0, draft.seats.findIndex((s) => s.kind === "human"));
const humanSeatCount = (): number => draft.seats.filter((s) => s.kind === "human").length;
const defaultSpeedFor = (n: number): TableSpeed => (n <= 1 ? "untimed" : "normal");

let botCatalogue: BotCatalogueEntry[] | null = null;
let myRooms: RoomSummary[] = [];
const botDisplayName = (key: string): string => botCatalogue?.find((b) => b.key === key)?.displayName ?? key;

function botChipsRow(i: number): string {
  const picked = draft.seats[i]!.bot;
  const catalogue = botCatalogue ?? [];
  return catalogue.length > 0
    ? catalogue.map((b) => `
      <button class="botchip ${b.key === picked ? "on" : ""}" data-seat="${i}" data-key="${b.key}"
        title="${esc(b.blurb)} · strength ${b.strength}/5">${esc(b.displayName)}</button>`).join("")
    : `<button class="botchip on" data-seat="${i}" data-key="${picked}">${esc(picked)}</button>`;
}
function seatSlotHtml(i: number): string {
  const seat = draft.seats[i]!;
  const isCreator = seat.kind === "human" && firstHumanSeatIx() === i;
  const ranked = draft.mode === "ranked";
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

function roomPickerHtml(): string {
  const opts = [
    `<option value="${OPEN_HALL_CODE}" ${draft.roomCode === OPEN_HALL_CODE ? "selected" : ""}>Open hall</option>`,
    ...myRooms.map((r) => `<option value="${esc(r.code)}" ${draft.roomCode === r.code ? "selected" : ""}>${esc(r.name)}</option>`),
  ];
  return `<h2>Room</h2>
    <div class="setrow"><select id="roomPick" style="flex:1;padding:9px 12px;border-radius:9px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);color:var(--ink)">${opts.join("")}</select></div>
    ${draft.roomLocked ? `<p class="segcap">This room fixes its own rules and length — its pickers below are hidden.</p>` : ""}`;
}

let gen = 0;
export function mountNewTableModal(opts: { fromRoomCode?: string } = {}): void {
  gen++;
  const myGen = gen;
  openVeil();
  if (opts.fromRoomCode) { draft.roomCode = opts.fromRoomCode; }
  else if (!draft.roomCode) { draft.roomCode = localStorage.getItem(LAST_ROOM_KEY) || OPEN_HALL_CODE; }
  void loadBotCatalogue().then((list) => { botCatalogue = list; if (myGen === gen) paint(); });
  void getMyRooms(identity?.deviceToken ?? "").then((rooms) => { myRooms = rooms; if (myGen === gen) paint(); }).catch(() => { /* not built yet */ });
  paint();
}

function paint(): void {
  if (!draft.speedManual) draft.speed = defaultSpeedFor(humanSeatCount());
  const ranked = draft.mode === "ranked";
  const locked = draft.roomLocked;
  $("panel").innerHTML = `
    <h1>New table</h1>
    ${roomPickerHtml()}
    ${locked ? "" : `
    <h2>Length</h2>
    <div class="seg">
      <button class="${draft.matchFormat === "east" ? "on" : ""}" data-fmt="east"><b>東圈</b><span>one wind · ~8 hands</span></button>
      <button class="${draft.matchFormat === "full" ? "on" : ""}" data-fmt="full"><b>全莊</b><span>four winds · ~35 hands</span></button>
    </div>
    <h2>Rules</h2>
    <div class="choices two">${RULE_PICKS.map(([id, label, blurb]) => `
      <div class="choice ${draft.rulesetId === id ? "sel" : ""}" data-r="${id}">
        <b>${label}</b><span>${blurb}</span></div>`).join("")}</div>`}
    <h2>Mode</h2>
    <div class="seg">
      <button class="${!ranked ? "on" : ""}" data-mode="casual"><b>Casual</b><span>unrated · any mix of bots</span></button>
      <button class="${ranked ? "on" : ""}" data-mode="ranked"><b>Ranked</b><span>rated · four humans</span></button>
    </div>
    <h2>Access</h2>
    <div class="seg">
      <button class="${draft.access === "open" ? "on" : ""}" data-access="open"><b>Open</b><span>anyone can sit down</span></button>
      <button class="${draft.access === "private" ? "on" : ""}" data-access="private"><b>Private</b><span>needs the code to sit down</span></button>
    </div>
    <div class="setrow"><label style="width:auto;flex:1">Randomize seats at start</label>
      <input type="checkbox" id="setRandomize" ${draft.randomizeSeats ? "checked" : ""}></div>
    ${locked ? "" : `
    <h2>Speed</h2>
    <div class="seg wrap">${TABLE_SPEEDS.map((sp) => `
      <button class="${draft.speed === sp ? "on" : ""}" data-speed="${sp}">
        <b>${SPEED_INFO[sp].label}</b><span>${SPEED_INFO[sp].caption}</span></button>`).join("")}</div>`}
    <h2>Seats</h2>
    <p class="segcap">${ranked ? "Ranked needs four human seats — bots are off."
      : "Tap a seat to swap human/bot; tap a bot's name below it to pick which one."}</p>
    <div class="seatgrid">${[0, 1, 2, 3].map((i) => seatSlotHtml(i)).join("")}</div>
    <p class="mut">Playing as <b>${esc(identity?.displayName ?? "—")}</b></p>
    <button id="btnCreate">create table ▸</button>
    ${backButton()}
    <p class="mut" id="createErr"></p>`;
  const sel = document.getElementById("roomPick") as HTMLSelectElement | null;
  if (sel) sel.onchange = () => { void selectRoom(sel.value); };
  if (!locked) {
    for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seg button[data-fmt]")))
      el.onclick = () => { draft.matchFormat = el.dataset.fmt as MatchFormat; paint(); };
    for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".choice[data-r]")))
      el.onclick = () => { draft.rulesetId = el.dataset.r!; paint(); };
    for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seg button[data-speed]")))
      el.onclick = () => { draft.speed = el.dataset.speed as TableSpeed; draft.speedManual = true; paint(); };
  }
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seg button[data-mode]")))
    el.onclick = () => { draft.mode = el.dataset.mode as TableMode; if (draft.mode === "ranked") for (const s of draft.seats) s.kind = "human"; paint(); };
  for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seg button[data-access]")))
    el.onclick = () => { draft.access = el.dataset.access as TableAccess; paint(); };
  const rnd = document.getElementById("setRandomize") as HTMLInputElement | null;
  if (rnd) rnd.onchange = () => { draft.randomizeSeats = rnd.checked; };
  if (!ranked) {
    for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".seatcard"))) {
      el.onclick = () => {
        const i = Number(el.dataset.seat);
        const seat = draft.seats[i]!;
        if (seat.kind === "human") { if (humanSeatCount() <= 1) return; seat.kind = "bot"; }
        else seat.kind = "human";
        paint();
      };
    }
    for (const el of Array.from($("panel").querySelectorAll<HTMLElement>(".botchip"))) {
      el.onclick = (e) => { e.stopPropagation(); const i = Number(el.dataset.seat); draft.seats[i]!.bot = el.dataset.key!; paint(); };
    }
  }
  wireBackButton(() => closeVeil());
  (document.getElementById("btnCreate") as HTMLButtonElement).onclick = () => void doCreateTable();
}

async function selectRoom(code: string): Promise<void> {
  draft.roomCode = code;
  localStorage.setItem(LAST_ROOM_KEY, code);
  if (code === OPEN_HALL_CODE) { draft.roomLocked = false; paint(); return; }
  // Best effort: a room with fixed `game` settings hides the pickers below
  // and forces its ruleset/format (task brief item 5). A 404/not-live room
  // just behaves like Open hall — never a dead end.
  try {
    const { getRoom } = await import("../../net.js");
    const detail = await getRoom(identity?.deviceToken ?? "", code);
    if (detail.game) {
      draft.roomLocked = true;
      draft.rulesetId = detail.game.rulesetId;
      draft.matchFormat = detail.game.matchFormat;
    } else {
      draft.roomLocked = false;
    }
  } catch {
    draft.roomLocked = false;
  }
  paint();
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
    const seats = draft.seats.map((s): SeatSpec => s.kind === "human" ? { kind: "human" } : { kind: "bot", bot: s.bot }) as [SeatSpec, SeatSpec, SeatSpec, SeatSpec];
    const r: CreateTableResult = await createTable(identity.deviceToken, {
      rulesetId: draft.rulesetId, matchFormat: draft.matchFormat, mode: draft.mode, access: draft.access,
      randomizeSeats: draft.randomizeSeats, speed: draft.speed, seats,
    });
    const plan = draft.seats.map((s) => s.kind === "bot" ? { bot: true, displayName: botDisplayName(s.bot) } : { bot: false });
    closeVeil();
    connectToMatch({
      matchUuid: r.matchUuid, joinCode: r.joinCode, seat: r.seat, seatToken: r.seatToken,
      rulesetId: r.rulesetId, matchFormat: r.matchFormat, creator: true,
      seatPlan: plan as never, speed: draft.speed,
    });
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "create table ▸"; }
    const err = document.getElementById("createErr");
    if (err) err.innerHTML = `<b style="color:var(--danger)">${describeError(e)}</b>`;
  }
}

/* ── Join by code — a table OR a room (task brief §11.2's Home CTA) ──────
 * Tries a table join first (the more common case — an invite from a
 * friend's table); a `not_found`/`bad_code`-shaped failure falls back to a
 * room join. Either 4xx reads as "try the other kind" here — only a genuine
 * network failure surfaces as an error. */
export function mountJoinModal(prefill = ""): void {
  openVeil();
  $("panel").innerHTML = `
    <h1>Join a table or room</h1>
    <p class="mut">Enter the code you were given.</p>
    <div class="setrow"><input id="codeIn" type="text" maxlength="10" autocapitalize="characters"
      placeholder="code" value="${esc(prefill)}" style="flex:1;padding:9px 12px;font-size:18px;letter-spacing:.08em;
      text-transform:uppercase;border-radius:9px;background:rgba(255,255,255,.07);
      border:1px solid rgba(255,255,255,.18);color:var(--ink)"></div>
    <button id="btnJoin">join ▸</button>
    ${backButton()}
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
      closeVeil();
      connectToMatch({ matchUuid: r.matchUuid, joinCode: code, seat: r.seat, seatToken: r.seatToken, rulesetId: r.rulesetId, matchFormat: r.matchFormat });
      return;
    } catch {
      /* fall through to a room join */
    }
    try {
      await joinRoom(identity.deviceToken, code);
      closeVeil();
      navigateShell(`/rooms/${code}`);
    } catch (e) {
      btn.disabled = false; btn.textContent = "join ▸";
      const err = document.getElementById("joinErr");
      if (err) err.innerHTML = `<b style="color:var(--danger)">${describeError(e)}</b>`;
    }
  };
  (document.getElementById("btnJoin") as HTMLButtonElement).onclick = () => void go();
  input.onkeydown = (e) => { if (e.key === "Enter") void go(); };
  wireBackButton(() => closeVeil());
}

/**
 * "Play now" (New table) and "Join by code".
 *
 * Design of record: `client/gamepvp/newtable-lab.html` (rounds 1–7, owner
 * rulings 2026-09-03/04): three groups — Table (name, room, access, mode),
 * Seats (cards with an easy→hard bot slider, randomize), Game details (rules
 * with an Almanac-style summary bar + payout curve/table, length, a speed
 * slider, payment, 連莊, repeat-after-draw) — with a basic/advanced split
 * (the footer link; remembered per device), blue as the one config colour,
 * every Chinese term paired with English, and a live summary line in the
 * header. Both modals mount their own overlay inside `#shell` (× / Esc /
 * backdrop close) so the shell's tokens and theme apply.
 *
 * Not yet in the engine, shown disabled as "coming soon": classical spread
 * payment (the PaymentTable contract is 全銃-only), a 連莊 limit, and
 * turning off dealer-repeats-after-a-draw. Custom rulesets likewise.
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
import { ruleset as rulesetById } from "../../../../rulesets/src/presets.js";
import { winnerCollects } from "../../../../rulesets/src/payment.js";
import { describeError, esc, identity } from "../session.js";
import { S, t } from "../strings.js";

const OPEN_HALL_CODE = "OPEN";
const WIND_EN = ["East", "South", "West", "North"];
const LAST_ROOM_KEY = "mjrc.gamepvp.lastRoom";
const ADVANCED_KEY = "mjrc.gamepvp.newtableAdvanced";

/* ── shell modal plumbing ─────────────────────────────────────────────── */
const VEIL_ID = "shellVeil";
const PANEL_ID = "shellPanel";
const panel = (): HTMLElement => document.getElementById(PANEL_ID)!;
let escHandler: ((e: KeyboardEvent) => void) | null = null;
function openVeil(): void {
  let veil = document.getElementById(VEIL_ID);
  if (!veil) {
    veil = document.createElement("div");
    veil.id = VEIL_ID;
    veil.className = "shellveil";
    veil.innerHTML = `<div class="shellpanel" id="${PANEL_ID}"></div>`;
    (document.getElementById("shell") ?? document.body).appendChild(veil);
    const v = veil;
    v.addEventListener("click", (e) => { if (e.target === v) closeVeil(); });
  }
  veil.style.display = "flex";
  if (!escHandler) {
    escHandler = (e) => { if (e.key === "Escape") closeVeil(); };
    document.addEventListener("keydown", escHandler);
  }
}
function closeVeil(): void {
  const veil = document.getElementById(VEIL_ID);
  if (veil) veil.style.display = "none";
  if (escHandler) { document.removeEventListener("keydown", escHandler); escHandler = null; }
}
function closeButton(): string {
  return `<button class="mclose" id="mClose" aria-label="${esc(t(S.close))}" title="${esc(t(S.close))} · Esc">×</button>`;
}
function wireClose(): void {
  const b = document.getElementById("mClose");
  if (b) (b as HTMLButtonElement).onclick = () => closeVeil();
}

/* ── New table ─────────────────────────────────────────────────────────── */

interface SeatDraft { kind: "human" | "bot"; bot: string; }
const draft: {
  name: string;
  roomCode: string | null; roomLocked: boolean;
  rulesetId: string; matchFormat: MatchFormat; mode: TableMode; access: TableAccess;
  randomizeSeats: boolean; seats: [SeatDraft, SeatDraft, SeatDraft, SeatDraft];
  speed: TableSpeed; speedManual: boolean;
  advanced: boolean; payoutOpen: boolean;
} = {
  name: "",
  roomCode: null, roomLocked: false,
  rulesetId: "mjrc-standard", matchFormat: "east", mode: "casual", access: "open", randomizeSeats: false,
  speed: "untimed", speedManual: false,
  advanced: false, payoutOpen: false,
  seats: [
    { kind: "human", bot: DEFAULT_BOT_LINEUP[0]! },
    { kind: "bot", bot: DEFAULT_BOT_LINEUP[1]! },
    { kind: "bot", bot: DEFAULT_BOT_LINEUP[2]! },
    { kind: "bot", bot: DEFAULT_BOT_LINEUP[3]! },
  ],
};
try { draft.advanced = localStorage.getItem(ADVANCED_KEY) === "1"; } catch { /* private mode */ }

const firstHumanSeatIx = (): number => Math.max(0, draft.seats.findIndex((s) => s.kind === "human"));
const humanSeatCount = (): number => draft.seats.filter((s) => s.kind === "human").length;
const botSeatCount = (): number => 4 - humanSeatCount();
const defaultSpeedFor = (n: number): TableSpeed => (n <= 1 ? "untimed" : "normal");

let botCatalogue: BotCatalogueEntry[] | null = null;
let myRooms: RoomSummary[] = [];

/** The catalogue easy → hard, for the slider; a stable fallback until it loads. */
function botsByStrength(): BotCatalogueEntry[] {
  const list = botCatalogue ?? DEFAULT_BOT_LINEUP.map((key, i) => ({ key, displayName: key, blurb: "", strength: i + 1 }));
  return [...list].sort((a, b) => a.strength - b.strength || a.displayName.localeCompare(b.displayName));
}
const botEntry = (key: string): BotCatalogueEntry | undefined => botsByStrength().find((b) => b.key === key);
const botDisplayName = (key: string): string => botEntry(key)?.displayName ?? key;

/* ── pieces ── */
const h3 = (en: string, zh: string): string => `<h3 class="nt-h">${esc(en)} <span>${esc(zh)}</span></h3>`;
const row = (label: string, zh: string, control: string, cap = "", adv = false): string =>
  `<div class="nt-row${adv ? " nt-adv" : ""}"><span class="nt-lbl">${esc(label)} <span>${esc(zh)}</span></span>${control}${cap ? `<span class="nt-cap">${cap}</span>` : ""}</div>`;
const seg = (items: { v: string; label: string; small?: string; on: boolean; disabled?: boolean; title?: string }[], attr: string): string =>
  `<div class="nt-seg">${items.map((it) => `<button class="${it.on ? "on" : ""}" data-${attr}="${esc(it.v)}"${it.disabled ? " disabled" : ""}${it.title ? ` title="${esc(it.title)}"` : ""}><b>${it.label}</b>${it.small ? `<small>${it.small}</small>` : ""}</button>`).join("")}</div>`;
const sw = (id: string, on: boolean, disabled = false): string => `<button class="nt-sw ${on ? "on" : ""}" id="${id}" role="switch" aria-checked="${on}"${disabled ? " disabled" : ""}></button>`;

function seatCardHtml(i: number): string {
  const seat = draft.seats[i]!;
  const isCreator = seat.kind === "human" && firstHumanSeatIx() === i;
  const ranked = draft.mode === "ranked";
  const who = seat.kind === "bot" ? "Bot" : isCreator ? "You" : "Open seat";
  const tag = isCreator ? "host" : ranked ? "human" : "swap";
  let body = "";
  if (seat.kind === "bot") {
    const bots = botsByStrength();
    const ix = Math.max(0, bots.findIndex((b) => b.key === seat.bot));
    const cur = bots[ix];
    body = `<div class="nt-bot"><input type="range" min="1" max="${bots.length}" value="${ix + 1}" data-botseat="${i}" aria-label="bot strength">
      <div class="ends"><span>easy</span><span>hard</span></div>
      <div class="who"><b>${esc(cur?.displayName ?? seat.bot)}</b> <span>${cur?.blurb ? `· ${esc(cur.blurb)}` : ""}</span></div></div>`;
  } else if (!isCreator && !ranked) {
    body = seg([{ v: "human", label: "Human", on: true }, { v: "bot", label: "Bot", on: false }], `seatkind-${i}`);
  }
  return `<div class="nt-seat ${seat.kind}${isCreator ? " you" : ""}" data-seat="${i}">
    <div class="w"${isCreator || ranked ? "" : ` data-swap="${i}" role="button"`}><b>${WIND_CH[i]}</b><span>${WIND_EN[i]} · ${who}</span><span class="tag">${tag}</span></div>${body}</div>`;
}

function roomOptions(): string {
  const opts = [`<option value="${OPEN_HALL_CODE}" ${draft.roomCode === OPEN_HALL_CODE ? "selected" : ""}>Open hall 公開大廳</option>`];
  // Everyone is a member of the Open hall, so `getMyRooms` lists it too — pinned above, dropped here.
  for (const r of myRooms.filter((r) => r.code !== OPEN_HALL_CODE)) {
    opts.push(`<option value="${esc(r.code)}" ${draft.roomCode === r.code ? "selected" : ""}>${esc(r.name)}</option>`);
  }
  return opts.join("");
}

/** The Almanac-style rules summary + payout band, from the real preset. */
function rulesFacts(): { bar: string; band: string } {
  const rs = rulesetById(draft.rulesetId);
  if (!rs) return { bar: "", band: "" };
  const schedule = rs.payment.id.includes("doubling") ? "doubling" : rs.payment.id.includes("linear") ? "linear" : "brackets";
  const bar = `${rs.minimumFaan}–${rs.limitFaan} faan · ${rs.useFlowers ? "flowers" : "no flowers"} · ${schedule} · 全銃`;
  const rows: [number, number, number][] = [];
  for (let f = rs.minimumFaan; f <= rs.limitFaan; f++) rows.push([f, winnerCollects(rs.payment, f, false), winnerCollects(rs.payment, f, true)]);
  const max = Math.max(1, ...rows.map((r) => r[2]));
  const W = 300, H = 120, x0 = 34, x1 = 292, y0 = 100, y1 = 8;
  const px = (i: number): number => rows.length === 1 ? x0 : x0 + (i / (rows.length - 1)) * (x1 - x0);
  const py = (v: number): number => y0 - (v / max) * (y0 - y1);
  const line = (k: 1 | 2): string => rows.map((r, i) => `${px(i).toFixed(1)},${py(r[k]).toFixed(1)}`).join(" ");
  const mid = rows[Math.floor(rows.length / 2)]!;
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="${x0}" y1="${y0}" x2="${x1 + 4}" y2="${y0}" stroke="var(--line)"/><line x1="${x0}" y1="${y1}" x2="${x0}" y2="${y0}" stroke="var(--line)"/>
    <line x1="${x0}" y1="${py(max / 2).toFixed(1)}" x2="${x1 + 4}" y2="${py(max / 2).toFixed(1)}" stroke="var(--line)" stroke-dasharray="2 3"/>
    <text x="2" y="${y1 + 4}" font-size="9" fill="var(--dim)" font-family="monospace">${max}</text>
    <text x="2" y="${(py(max / 2) + 3).toFixed(1)}" font-size="9" fill="var(--dim)" font-family="monospace">${Math.round(max / 2)}</text>
    <text x="8" y="${y0 + 3}" font-size="9" fill="var(--dim)" font-family="monospace">0</text>
    <polyline fill="none" stroke="var(--blue)" stroke-width="2" points="${line(1)}"/>
    <polyline fill="none" stroke="var(--blue)" stroke-width="2" stroke-dasharray="4 3" points="${line(2)}"/>
    <text x="${(px(0) - 4).toFixed(1)}" y="112" font-size="9" fill="var(--dim)" font-family="monospace">${rows[0]![0]}</text>
    <text x="${(px(Math.floor(rows.length / 2)) - 4).toFixed(1)}" y="112" font-size="9" fill="var(--dim)" font-family="monospace">${mid[0]}</text>
    <text x="${(x1 - 30).toFixed(1)}" y="112" font-size="9" fill="var(--dim)" font-family="monospace">${rows[rows.length - 1]![0]} faan</text>
  </svg>`;
  const table = `<div class="nt-paytable"><span class="h">faan</span><span class="h v">出銃 discard</span><span class="h v">自摸 self-draw</span>${
    rows.map(([f, d, s]) => `<span class="f${f === rs.limitFaan ? " capf" : ""}">${f}</span><span class="v">${d}</span><span class="v">${s}</span>`).join("")
  }</div>`;
  const band = `<div class="nt-paywrap">
      <div class="nt-curve"><div class="t"><span>winner collects</span><span>— 出銃 · - - 自摸</span></div>${svg}</div>${table}</div>
    <span class="nt-ptsub">Winner's total collect. Discard 出銃: the discarder alone pays 2× the table value (全銃). Self-draw 自摸: each of the three pays 1×. ${rs.limitFaan} is the cap${rs.useFlowers ? "; flowers 1 faan each" : ""}. <a href="https://mahjongresearch.com/scoring" target="_blank" rel="noopener">Every hand's faan on mahjongresearch.com/scoring ›</a></span>`;
  return { bar, band };
}

function summaryLine(): string {
  const roomName = draft.roomCode === OPEN_HALL_CODE || !draft.roomCode ? "Open hall" : (myRooms.find((r) => r.code === draft.roomCode)?.name ?? draft.roomCode);
  const rules = RULE_PICKS.find(([id]) => id === draft.rulesetId)?.[1] ?? draft.rulesetId;
  const humans = humanSeatCount(), bots = botSeatCount();
  const seatsWord = `you${bots > 0 ? ` + ${bots} bot${bots === 1 ? "" : "s"}` : ""}${humans > 1 ? ` + ${humans - 1} open` : ""}`;
  return [draft.name.trim() || null, roomName, draft.matchFormat === "full" ? "全莊" : "東圈", rules, "全銃", draft.mode, draft.access,
    SPEED_INFO[draft.speed]?.label.toLowerCase() ?? draft.speed, seatsWord].filter(Boolean).join(" · ");
}

let gen = 0;
export function mountNewTableModal(opts: { fromRoomCode?: string } = {}): void {
  gen++;
  const myGen = gen;
  openVeil();
  panel().classList.add("nt-panel");
  if (opts.fromRoomCode) { draft.roomCode = opts.fromRoomCode; }
  else if (!draft.roomCode) { draft.roomCode = localStorage.getItem(LAST_ROOM_KEY) || OPEN_HALL_CODE; }
  void loadBotCatalogue().then((list) => { botCatalogue = list; if (myGen === gen) paint(); });
  void getMyRooms(identity?.deviceToken ?? "").then((rooms) => { myRooms = rooms; if (myGen === gen) paint(); }).catch(() => { /* not built yet */ });
  if (draft.roomCode && draft.roomCode !== OPEN_HALL_CODE) void selectRoom(draft.roomCode);
  paint();
}

function paint(): void {
  if (!draft.speedManual) draft.speed = defaultSpeedFor(humanSeatCount());
  const ranked = draft.mode === "ranked";
  const locked = draft.roomLocked;
  const facts = rulesFacts();
  const speedIx = Math.max(0, TABLE_SPEEDS.indexOf(draft.speed));
  const rulesOptions = RULE_PICKS.map(([id, label]) => `<option value="${id}" ${draft.rulesetId === id ? "selected" : ""}>${esc(label)}</option>`).join("")
    + `<option disabled>Custom · coming soon</option>`;

  panel().innerHTML = `<div class="nt${draft.advanced ? " showadv" : ""}">
    <div class="nt-head"><h1>New table</h1><span class="nt-sum" id="ntSum">${esc(summaryLine())}</span>${closeButton()}</div>
    <div class="nt-body">
      <div class="nt-col">
        ${h3("Table", "枱")}
        ${row("Name", "名稱", `<input class="nt-txt" id="ntName" maxlength="40" placeholder="${esc(`${identity?.displayName ?? "my"}'s table`)}" value="${esc(draft.name)}">`, "", true)}
        ${row("Room", "房間", `<select class="nt-sel" id="roomPick">${roomOptions()}</select>`, locked ? "this room fixes its own rules, length and speed" : "")}
        ${row("Access", "開放", seg([{ v: "open", label: "Open", on: draft.access === "open" }, { v: "private", label: "Private", on: draft.access === "private" }], "access"),
          draft.access === "open" ? "anyone can sit down" : "needs the code to sit down", true)}
        ${row("Mode", "模式", seg([{ v: "casual", label: "Casual", on: !ranked }, { v: "ranked", label: "Ranked", on: ranked }], "mode"),
          ranked ? "rated · four humans · counts toward your rating" : "unrated · any mix of bots")}
        ${h3("Seats", "座位")}
        <div class="nt-seats">${[0, 1, 2, 3].map(seatCardHtml).join("")}</div>
        <p class="nt-seatsum">${esc(`you${botSeatCount() > 0 ? ` + ${botSeatCount()} bot${botSeatCount() === 1 ? "" : "s"}` : ""}${humanSeatCount() > 1 ? ` + ${humanSeatCount() - 1} open seat${humanSeatCount() > 2 ? "s" : ""}` : ""}`)} · playing as <b>${esc(identity?.displayName ?? "—")}</b>${ranked ? "" : " · tap a seat to swap human/bot; slide to pick how strong the bot is"}</p>
        <div class="nt-row nt-switch nt-adv"><span class="nt-lbl">Randomize seats at start <span>隨機座位</span></span>${sw("ntRandomize", draft.randomizeSeats)}</div>
      </div>
      <div class="nt-col">
        ${h3("Game details", "牌局細則")}
        ${row("Rules", "規則", `<select class="nt-sel" id="rulePick"${locked ? " disabled" : ""}>${rulesOptions}</select>`)}
        <button class="nt-rsum" id="ntPayoutTog"><span class="s">${esc(facts.bar)}</span><span class="l">${draft.payoutOpen ? "hide payouts" : "payout table"}</span></button>
        ${locked ? "" : row("Length", "圈數", seg([
          { v: "east", label: "東圈", small: "one wind · ~8 hands", on: draft.matchFormat === "east" },
          { v: "full", label: "全莊", small: "four winds · ~35 hands", on: draft.matchFormat === "full" }], "fmt"), "", true)}
        ${locked ? "" : row("Speed", "速度", `<div class="nt-speed"><input type="range" min="1" max="${TABLE_SPEEDS.length}" value="${speedIx + 1}" id="ntSpeed" aria-label="speed">
          <div class="ends">${TABLE_SPEEDS.map((sp) => `<span>${esc(SPEED_INFO[sp].label)}</span>`).join("")}</div>
          <div class="who" id="ntSpeedWho"><b>${esc(SPEED_INFO[draft.speed].label)}</b> <span>· ${esc(SPEED_INFO[draft.speed].caption)}</span></div></div>`)}
        ${row("Payment", "計分", seg([
          { v: "defensive", label: "Defensive 全銃", on: true },
          { v: "classical", label: "Classical", small: "spread · coming soon", on: false, disabled: true, title: "spread payments are not in the engine yet" }], "pay"),
          "the discarder pays the whole hand · self-draw: each of the three pays 1×", true)}
        ${row("連莊", "streak", seg([{ v: "0", label: "0", on: false, disabled: true }, { v: "1", label: "1", on: false, disabled: true }, { v: "2", label: "2", on: false, disabled: true }, { v: "inf", label: "∞", on: true, disabled: true }], "streak"),
          "the dealer repeats after every win · a limit is coming soon", true)}
        <div class="nt-row nt-switch nt-adv"><span class="nt-lbl">Dealer repeats after a draw <span>流局連莊</span></span>${sw("ntDrawRepeat", true, true)}</div>
      </div>
      <div class="nt-band" ${draft.payoutOpen ? "" : "hidden"}>${facts.band}</div>
    </div>
    <div class="nt-foot"><a href="#" class="nt-advtog" id="ntAdvTog">${draft.advanced ? "basic settings ▸" : "advanced settings ▸"}</a><span class="nt-hint">Esc or the backdrop closes${locked ? " · this room fixes rules, length and speed" : ""}</span><button id="btnCreate" class="primary">create table ▸</button></div>
    <p class="mut nt-err" id="createErr"></p>
  </div>`;

  const p = panel();
  const q = <T extends HTMLElement>(sel: string): T[] => Array.from(p.querySelectorAll<T>(sel));
  (document.getElementById("ntName") as HTMLInputElement | null)?.addEventListener("input", (e) => {
    draft.name = (e.target as HTMLInputElement).value;
    const sum = document.getElementById("ntSum"); if (sum) sum.textContent = summaryLine();
  });
  const roomSel = document.getElementById("roomPick") as HTMLSelectElement | null;
  if (roomSel) roomSel.onchange = () => { void selectRoom(roomSel.value); };
  const ruleSel = document.getElementById("rulePick") as HTMLSelectElement | null;
  if (ruleSel) ruleSel.onchange = () => { draft.rulesetId = ruleSel.value; paint(); };
  for (const el of q<HTMLElement>("[data-access]")) el.onclick = () => { draft.access = el.dataset.access as TableAccess; paint(); };
  for (const el of q<HTMLElement>("[data-mode]")) el.onclick = () => {
    draft.mode = el.dataset.mode as TableMode;
    if (draft.mode === "ranked") for (const s of draft.seats) s.kind = "human";
    paint();
  };
  for (const el of q<HTMLElement>("[data-fmt]")) el.onclick = () => { draft.matchFormat = el.dataset.fmt as MatchFormat; paint(); };
  for (const el of q<HTMLElement>("[data-swap]")) el.onclick = () => {
    const i = Number(el.dataset.swap);
    const seat = draft.seats[i]!;
    if (seat.kind === "human") { if (humanSeatCount() <= 1) return; seat.kind = "bot"; }
    else seat.kind = "human";
    paint();
  };
  for (let i = 0; i < 4; i++) {
    for (const el of q<HTMLElement>(`[data-seatkind-${i}]`)) el.onclick = (e) => {
      e.stopPropagation();
      const kind = el.dataset[`seatkind-${i}`] ?? el.getAttribute(`data-seatkind-${i}`);
      if (kind === "bot") { if (humanSeatCount() <= 1) return; draft.seats[i]!.kind = "bot"; } else draft.seats[i]!.kind = "human";
      paint();
    };
  }
  for (const r of q<HTMLInputElement>("input[data-botseat]")) {
    const i = Number(r.dataset.botseat);
    r.oninput = () => {
      const bots = botsByStrength();
      const b = bots[Number(r.value) - 1];
      if (!b) return;
      draft.seats[i]!.bot = b.key;
      const who = r.parentElement?.querySelector(".who");
      if (who) who.innerHTML = `<b>${esc(b.displayName)}</b> <span>${b.blurb ? `· ${esc(b.blurb)}` : ""}</span>`;
    };
    r.onchange = () => { const sum = document.getElementById("ntSum"); if (sum) sum.textContent = summaryLine(); };
  }
  const sp = document.getElementById("ntSpeed") as HTMLInputElement | null;
  if (sp) {
    sp.oninput = () => {
      draft.speed = TABLE_SPEEDS[Number(sp.value) - 1] ?? draft.speed;
      draft.speedManual = true;
      const who = document.getElementById("ntSpeedWho");
      if (who) who.innerHTML = `<b>${esc(SPEED_INFO[draft.speed].label)}</b> <span>· ${esc(SPEED_INFO[draft.speed].caption)}</span>`;
      const sum = document.getElementById("ntSum"); if (sum) sum.textContent = summaryLine();
    };
  }
  const rnd = document.getElementById("ntRandomize") as HTMLButtonElement | null;
  if (rnd) rnd.onclick = () => { draft.randomizeSeats = !draft.randomizeSeats; paint(); };
  const tog = document.getElementById("ntPayoutTog");
  if (tog) tog.onclick = () => { draft.payoutOpen = !draft.payoutOpen; paint(); };
  const adv = document.getElementById("ntAdvTog");
  if (adv) adv.onclick = (e) => {
    e.preventDefault();
    draft.advanced = !draft.advanced;
    try { localStorage.setItem(ADVANCED_KEY, draft.advanced ? "1" : "0"); } catch { /* private mode */ }
    paint();
  };
  wireClose();
  (document.getElementById("btnCreate") as HTMLButtonElement).onclick = () => void doCreateTable();
}

async function selectRoom(code: string): Promise<void> {
  draft.roomCode = code;
  localStorage.setItem(LAST_ROOM_KEY, code);
  if (code === OPEN_HALL_CODE) { draft.roomLocked = false; paint(); return; }
  // A room with fixed `game` settings hides the pickers and forces its
  // ruleset/format; a 404 or an unconfigured room behaves like the Open hall.
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
  const err = document.getElementById("createErr");
  if (humanSeatCount() < 1) {
    if (err) err.innerHTML = `<b style="color:var(--red)">at least one seat has to be human — that's you</b>`;
    return;
  }
  const btn = document.getElementById("btnCreate") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = "creating…"; }
  try {
    const seats = draft.seats.map((s): SeatSpec => s.kind === "human" ? { kind: "human" } : { kind: "bot", bot: s.bot }) as [SeatSpec, SeatSpec, SeatSpec, SeatSpec];
    const name = draft.name.trim();
    const r: CreateTableResult = await createTable(identity.deviceToken, {
      rulesetId: draft.rulesetId, matchFormat: draft.matchFormat, mode: draft.mode, access: draft.access,
      randomizeSeats: draft.randomizeSeats, speed: draft.speed, seats,
      ...(name ? { name } : {}),
      ...(draft.roomCode && draft.roomCode !== OPEN_HALL_CODE ? { roomCode: draft.roomCode } : {}),
    } as Parameters<typeof createTable>[1]);
    const plan = draft.seats.map((s) => s.kind === "bot" ? { bot: true, displayName: botDisplayName(s.bot) } : { bot: false });
    closeVeil();
    connectToMatch({
      matchUuid: r.matchUuid, joinCode: r.joinCode, seat: r.seat, seatToken: r.seatToken,
      rulesetId: r.rulesetId, matchFormat: r.matchFormat, creator: true,
      seatPlan: plan as never, speed: draft.speed,
    });
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "create table ▸"; }
    if (err) err.innerHTML = `<b style="color:var(--red)">${describeError(e)}</b>`;
  }
}

/* ── Join by code — a table OR a room ─────────────────────────────────── */
export function mountJoinModal(prefill = ""): void {
  openVeil();
  panel().classList.remove("nt-panel");
  panel().innerHTML = `
    <h1>Join a table or room</h1>
    ${closeButton()}
    <p class="mut">Enter the code you were given.</p>
    <div class="setrow"><input id="codeIn" type="text" maxlength="10" autocapitalize="characters"
      placeholder="code" value="${esc(prefill)}" style="font-size:18px;letter-spacing:.08em;text-transform:uppercase"></div>
    <button id="btnJoin" class="primary">join ▸</button>
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
      history.pushState(null, "", `/rooms/${code}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (e) {
      btn.disabled = false; btn.textContent = "join ▸";
      const err = document.getElementById("joinErr");
      if (err) err.innerHTML = `<b style="color:var(--red)">${describeError(e)}</b>`;
    }
  };
  (document.getElementById("btnJoin") as HTMLButtonElement).onclick = () => void go();
  input.onkeydown = (e) => { if (e.key === "Enter") void go(); };
  wireClose();
}

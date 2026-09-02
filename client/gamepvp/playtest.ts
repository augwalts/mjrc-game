/**
 * MJRC gamepvp — the playtest pane's autopilot (`?playtest=a` / `?playtest=b`).
 *
 * ONE of the two panes inside `playtest.html`, the local playability harness.
 * This file is inert unless that query parameter is present: `game.ts` calls
 * `playtestRole()` first and takes its normal boot path when the answer is
 * `null`.
 *
 * What it is for: running the whole client — every shell page, the new-table
 * modal, the waiting room, the start card, a real match, the hand-end reveal,
 * the scoreboard — hands-free, on a local `wrangler dev`, at two viewport
 * sizes at once, so behaviour and layout can be watched side by side. It is a
 * debugging instrument, not a product surface.
 *
 * Three rules it keeps, and why:
 *
 * 1. **It plays by clicking the real DOM.** A discard is a click on a tile in
 *    `#myhand`; a chow is a click on the button in `#actions`. It never sends
 *    a `request*` of its own and never reads `pending`. So the prompt UI, the
 *    claim bar, the optimistic-discard toss and the clock all run exactly as
 *    they do under a finger — which is the only reason watching this proves
 *    anything about the real thing.
 *
 * 2. **It has no game authority**, same as the client around it. The policy
 *    below picks among options the SERVER has already offered and rendered;
 *    it computes no legality. A click that lands on nothing is simply retried
 *    on the next prompt.
 *
 * 3. **It never writes `localStorage`.** Both panes share one origin with
 *    each other and with your own dev session, so minting an identity through
 *    `net.ts`'s `identify()` would have the two panes fight over one device
 *    token and overwrite your real one. Instead each role posts a fixed token
 *    of its own straight to `/api/identity` and hands the result to
 *    `setIdentity()`, leaving storage untouched. The tokens are constants
 *    below: local-only by construction, and worthless anywhere else.
 *
 * ADDING A UI ELEMENT TO THE PLAYTEST DOES NOT USUALLY MEAN EDITING THIS
 * FILE. The reel — which screen, in which order, for how long — lives in
 * `playtest.html`'s `REEL` array, and `click` reaches any button on any of
 * them by selector. Come back here only when a pane needs to *do* something
 * new (a new kind of request, a new thing to watch for), not when it needs
 * to *show* something new.
 */
import { connectToMatch, playtestHooks, liveSocket } from "./table.js";
import { createTable, joinTable, type MatchFormat, type SeatSpec, type TableSpeed } from "./net.js";
import type { Router } from "./shell/router.js";
import { ensurePresenceHeartbeat, setIdentity } from "./shell/session.js";

export type PlaytestRole = "a" | "b";

/** `?playtest=a` (the phone pane, and the one that creates the table) or
 *  `?playtest=b` (the desktop pane, which joins it by code). Any other value,
 *  or none at all, reads as `a`, so a single pane can be opened on its own. */
export function playtestRole(): PlaytestRole | null {
  const params = new URLSearchParams(location.search);
  if (!params.has("playtest")) return null;
  return params.get("playtest") === "b" ? "b" : "a";
}

/** 46 characters of `[A-Za-z0-9_]`, past the server's 32-char floor
 *  (worker/src/index.ts `DEVICE_TOKEN_RE`). Fixed rather than random so the
 *  reel reuses the same two player rows however many times it loops, instead
 *  of filling the local D1 with a new player per run. */
const DEVICE_TOKEN: Record<PlaytestRole, string> = {
  a: "mjrc_playtest_pane_a_local_only_000000000000",
  b: "mjrc_playtest_pane_b_local_only_000000000000",
};
const DISPLAY_NAME: Record<PlaytestRole, string> = { a: "Play A", b: "Play B" };

/* ── the wire to playtest.html ─────────────────────────────────────────
 * Same origin, so a plain structured-clone `postMessage` both ways. Every
 * message carries `mjrcPlaytest: true` and the sender's role; anything without
 * that marker is somebody else's traffic and is ignored. */
interface FromPane { mjrcPlaytest: true; role: PlaytestRole; t: string; [k: string]: unknown }
interface ToPane { mjrcPlaytest: true; t: string; [k: string]: unknown }

let role: PlaytestRole = "a";

function emit(t: string, extra: Record<string, unknown> = {}): void {
  const msg: FromPane = { mjrcPlaytest: true, role, t, ...extra };
  try { window.parent.postMessage(msg, location.origin); } catch { /* not framed */ }
}

/* ── the discard policy ─────────────────────────────────────────────────
 * Deliberately a beginner's heuristic over nothing but the tile ids visible
 * in `#myhand`: throw the most isolated single first, honours before suits,
 * and never break a pair. It is not trying to play well — the three real
 * bots at the other seats do that, and a harness seat that played perfectly
 * would be a worse test, since half the UI worth watching (a claim you lost,
 * a hand you did not finish) would stop happening.
 *
 * Reading the DOM rather than the snapshot is the point, not a shortcut: it
 * is the same information a player has, and it keeps this file free of any
 * engine or protocol import.
 */
const suitOf = (t: number): number => (t < 27 ? Math.floor(t / 9) : -1);

function pickDiscard(tiles: number[]): number {
  const count = new Map<number, number>();
  for (const t of tiles) count.set(t, (count.get(t) ?? 0) + 1);
  const has = (t: number): boolean => count.has(t);
  let worst = tiles[0]!;
  let worstScore = Infinity;
  for (const t of new Set(tiles)) {
    const copies = count.get(t)!;
    let score = copies * 100;              // a pair or better is never thrown first
    if (t >= 34) score += 1000;            // a flower is not in hand to be thrown
    else if (t >= 27) score += 0;          // a lone honour is the cheapest throw
    else {
      const s = suitOf(t);
      let neighbours = 0;
      for (const d of [-2, -1, 1, 2]) {
        const n = t + d;
        if (suitOf(n) === s && has(n)) neighbours += d === -1 || d === 1 ? 2 : 1;
      }
      score += 10 + neighbours * 12;
      const rank = t % 9;
      if (rank === 0 || rank === 8) score -= 6; // a terminal is worth less than a middle tile
    }
    if (score < worstScore) { worstScore = score; worst = t; }
  }
  return worst;
}

/* ── acting on a prompt ─────────────────────────────────────────────────
 * `#actions` holds whatever claim buttons the server offered, already
 * rendered; `#myhand` is tappable exactly when a discard is legal (table.ts
 * puts `.locked` on it otherwise). `claimRate` is the harness's dial: how
 * often an offered chow/pung/kong is actually taken, so passing — and the
 * window expiring on somebody else's claim — both still get exercised. */
let answerDelayMs = 900;
let claimRate = 0.65;
let answering = 0;
/** Set while the harness is holding the table frozen on a trap; the pane
 *  stops answering prompts until it is cleared, so the state on screen is
 *  the state you were trying to look at. */
let frozen = false;

function actNow(): void {
  if (frozen) return;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("#actions button"));
  if (buttons.length) {
    const win = buttons.find((b) => b.classList.contains("win"));
    const pass = buttons.find((b) => b.classList.contains("pass"));
    const claims = buttons.filter((b) => b !== win && b !== pass);
    // A win is always taken: it is the one outcome the whole scoreboard,
    // reveal and payment UI hangs off, and refusing it for variety's sake
    // would mean rarely seeing any of them.
    const pick = win ?? (claims.length && Math.random() < claimRate
      ? claims[Math.floor(Math.random() * claims.length)]!
      : pass ?? null);
    if (pick) { emit("act", { what: pick.querySelector(".lb")?.textContent ?? "claim" }); pick.click(); return; }
  }
  const hand = document.getElementById("myhand");
  if (!hand || hand.classList.contains("locked")) return;
  const tiles = Array.from(hand.querySelectorAll<HTMLElement>(".tile"));
  if (!tiles.length) return;
  const ids = tiles.map((el) => Number(el.dataset.t)).filter((n) => Number.isFinite(n));
  const want = pickDiscard(ids);
  const el = tiles.find((x) => Number(x.dataset.t) === want) ?? tiles[tiles.length - 1]!;
  emit("act", { what: `discard ${want}` });
  el.click();
}

function onPrompt(): void {
  window.clearTimeout(answering);
  // The delay is the whole reason this is not on server auto-play: it is the
  // window in which the claim bar, the clock and the highlighted hand are on
  // screen to be looked at.
  answering = window.setTimeout(actNow, answerDelayMs);
}

/* ── event reporting + traps ────────────────────────────────────────────
 * Every applied batch is reported to the harness as a list of event types
 * (never their payloads — the log pane wants "kong, discard, discard", not a
 * wire dump). `traps` is the set the harness is waiting for; when one lands
 * the pane says so and stops answering, and the harness pauses the table for
 * real through the same `requestPause` the HUD button sends. */
let traps = new Set<string>();

function onEvents(events: readonly { type: string; seq: number }[]): void {
  const types = events.map((e) => e.type);
  emit("ev", { types, seq: events[events.length - 1]?.seq ?? -1 });
  if (types.includes("matchEnd")) emit("matchEnd");
  if (traps.size) {
    const hit = types.find((ty) => traps.has(ty));
    if (hit) { frozen = true; window.clearTimeout(answering); emit("trapped", { what: hit }); }
  }
}

/* ── identity without touching storage — see rule 3 in the header ─────── */
async function playtestIdentify(r: PlaytestRole): Promise<void> {
  const res = await fetch("/api/identity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      deviceToken: DEVICE_TOKEN[r],
      displayName: DISPLAY_NAME[r],
      tzOffsetMin: new Date().getTimezoneOffset(),
    }),
  });
  if (!res.ok) throw new Error(`identity ${res.status}`);
  const data = await res.json() as { playerId: string; displayName: string; rating: number | null };
  setIdentity({
    playerId: data.playerId,
    displayName: data.displayName,
    rating: data.rating ?? null,
    deviceToken: DEVICE_TOKEN[r],
  });
}

/* ── the commands playtest.html sends ─────────────────────────────────── */
interface PlaytestContext {
  role: PlaytestRole;
  mountRouter: () => Router;
  showTable: () => void;
  showShell: () => void;
}

export async function runPlaytest(ctx: PlaytestContext): Promise<void> {
  role = ctx.role;
  await playtestIdentify(role);
  const router = ctx.mountRouter();
  ensurePresenceHeartbeat();

  playtestHooks.onPrompt = onPrompt;
  playtestHooks.onEvents = onEvents as (e: readonly { type: string; seq: number }[]) => void;
  playtestHooks.onWelcome = () => { frozen = false; emit("welcome"); };

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.origin !== location.origin) return;
    const m = e.data as ToPane | null;
    if (!m || typeof m !== "object" || m.mjrcPlaytest !== true) return;
    void handle(m, ctx, router);
  });

  emit("ready", { name: DISPLAY_NAME[role] });
}

async function handle(m: ToPane, ctx: PlaytestContext, router: Router): Promise<void> {
  try {
    switch (m.t) {
      case "tune":
        if (typeof m.answerDelayMs === "number") answerDelayMs = m.answerDelayMs;
        if (typeof m.claimRate === "number") claimRate = m.claimRate;
        break;

      case "route":
        ctx.showShell();
        router.navigate(String(m.path));
        break;

      case "showTable":
        ctx.showTable();
        break;

      /** A generic "press this" — the harness's escape hatch for showing a
       *  panel that only a real button opens (the New table modal, the
       *  in-match settings sheet, the chat overlay). Keeping it generic is
       *  what lets a new stop be added to the reel in playtest.html alone. */
      case "click": {
        const el = document.querySelector<HTMLElement>(String(m.selector));
        if (el) el.click();
        else emit("miss", { selector: m.selector });
        break;
      }

      case "create": {
        const seats = m.seats as [SeatSpec, SeatSpec, SeatSpec, SeatSpec];
        const r = await createTable(DEVICE_TOKEN[role], {
          rulesetId: String(m.rulesetId ?? "mjrc-standard"),
          matchFormat: (m.matchFormat ?? "east") as MatchFormat,
          mode: "casual",
          access: "private",
          randomizeSeats: false,
          seats,
          speed: (m.speed ?? "faster") as TableSpeed,
        });
        frozen = false;
        connectToMatch({
          matchUuid: r.matchUuid, joinCode: r.joinCode, seat: r.seat, seatToken: r.seatToken,
          rulesetId: r.rulesetId, matchFormat: r.matchFormat, creator: true,
          speed: (m.speed ?? "faster") as TableSpeed,
        });
        emit("created", { code: r.joinCode, matchUuid: r.matchUuid, seat: r.seat });
        break;
      }

      case "join": {
        const r = await joinTable(DEVICE_TOKEN[role], String(m.code));
        frozen = false;
        connectToMatch({
          matchUuid: r.matchUuid, joinCode: String(m.code), seat: r.seat, seatToken: r.seatToken,
          rulesetId: r.rulesetId, matchFormat: r.matchFormat, creator: false,
        });
        emit("joined", { matchUuid: r.matchUuid, seat: r.seat });
        break;
      }

      case "pause": {
        const ts = liveSocket();
        if (!ts) break;
        await (m.on ? ts.requestPause() : ts.requestResume());
        break;
      }

      case "auto": {
        const ts = liveSocket();
        if (!ts) break;
        await ts.requestAuto(Boolean(m.on));
        break;
      }

      case "nextHand": {
        const ts = liveSocket();
        if (ts) await ts.requestNextHand();
        break;
      }

      case "chat": {
        const ts = liveSocket();
        if (ts) await ts.sendChat({ text: String(m.text) });
        break;
      }

      case "trap":
        traps = new Set((m.kinds as string[] | undefined) ?? []);
        emit("trapset", { kinds: [...traps] });
        break;

      case "thaw":
        frozen = false;
        traps = new Set();
        // Nothing may be pending right now (the freeze can land between
        // prompts), so nudge rather than wait: `actNow` is a no-op when
        // there is nothing legal on screen to click.
        window.setTimeout(actNow, answerDelayMs);
        break;
    }
  } catch (err) {
    emit("error", { what: m.t, msg: err instanceof Error ? err.message : String(err) });
  }
}

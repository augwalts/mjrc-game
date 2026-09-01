/**
 * `replay` — the developer CLI over an event log. DESIGN.md §8 lists tools/ as
 * "log analysis, replay CLI, bot eval, sim-theory generators"; this is the
 * replay CLI. Terminology: ../../TERMINOLOGY.md — Hong Kong Old Style only.
 *
 *   ./node_modules/.bin/vite-node tools/replay/cli.ts -- <logfile> [options]
 *
 * (Plain `node cli.ts` cannot load the engine: this workspace's relative
 * imports carry `.js` extensions that only a TS-aware resolver maps back to
 * sources, so the CLI runs through vite-node, which vitest already ships.)
 *
 *   <logfile>              step through the log, render state as text
 *   <logfile> --at N       the board at event N
 *   <logfile> --verify     re-execute the log and assert it reconstructs
 *   <logfile> --stats      per-hand summary: outcome, winner, faan, deltas
 *
 *   --seat N    render from seat N's perspective 一家 (redacted, as they saw it)
 *   --hand N    limit stepping to one hand
 *   --seed N    supply the match seed --verify could not recover from the log
 *
 * ── --verify IS GATE 2 ───────────────────────────────────────────────────
 *
 * §3's gate 2 reads "100% of completed games reconstruct in the viewer". That
 * is a claim about two independent readings of one log agreeing:
 *
 *   1. RE-EXECUTION. `replayMatch` feeds actions back through the state machine
 *      and regenerates every event from the seed. This is the authority (§5.5).
 *   2. THE FOLD. `foldAt` reads the log and never touches the reducer.
 *
 * They share no code, so agreement is evidence. `--verify` runs both and
 * compares the final state seat by seat, plus the event count via `seq` and the
 * logical clock via `ts` — a divergence of one event moves both.
 *
 * ── the one thing a log cannot yet tell us ───────────────────────────────
 *
 * The §5.5 header pins `engineVersion` and `rulesetId` but NOT the match seed,
 * and the `deal` payload records the per-HAND seed. Re-execution needs the
 * match seed. `recoverMatchSeed` gets it back because `handSeedFor` multiplies
 * by an odd constant and multiplication by an odd number is invertible mod
 * 2^32 — and then it VERIFIES the recovered value against every deal in the
 * log rather than trusting the inversion, so a change to `handSeedFor` can
 * never hand back a confident wrong seed. If any deal disagrees it returns null
 * and --verify asks for `--seed`. Recording the match seed in the header would
 * retire the whole mechanism; that is an open question for the schema, not
 * something this file should decide.
 *
 * ── dependency-free ──────────────────────────────────────────────────────
 *
 * argv is parsed by hand and the entire Node surface sits behind `Host`, so
 * every decision this file makes is exercised from fold.test.ts without a
 * filesystem. There is no @types/node in this workspace and DESIGN.md §8 adds
 * no dependencies, so the one dynamic import in `main` is the only unchecked
 * line here and it does nothing but read a file.
 *
 * Determinism (§5.5): no Math.random, no Date.now, no unordered key iteration.
 */

import { TILE_NAMES, WIND_NAMES, type SeatIndex, type TileId } from "@mjrc/engine";
import type { GameEvent, MatchLogHeader, SeatSnapshot } from "@mjrc/protocol";
import { isOwnSeatView } from "@mjrc/protocol";
import {
  TICK_MS,
  handSeedFor,
  replayMatch,
  type MatchConfig,
  type MatchState,
} from "../../engine/src/reducer.js";
import {
  foldAt,
  foldStates,
  liveWallCount,
  parseMatchLog,
  seatSnapshotOf,
  type FoldedState,
  type HandSummary,
  type MatchLogFile,
} from "./fold.js";

/* ── the Node surface, in one interface ────────────────────────────────── */

export interface Host {
  readFile(path: string): string;
  write(text: string): void;
}

/** Collects output instead of printing it. The test host. */
export function bufferHost(files: Readonly<Record<string, string>> = {}): Host & { out: string } {
  const h = {
    out: "",
    readFile(path: string): string {
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
    write(text: string): void {
      h.out += text;
    },
  };
  return h;
}

/* ── rendering ─────────────────────────────────────────────────────────── */

/** 萬索筒東南西北中發白 and the eight 花, straight out of TILE_NAMES. */
export const tileText = (t: TileId): string => TILE_NAMES[t] ?? `?${t}`;

export const tilesText = (ts: readonly TileId[]): string =>
  ts.length === 0 ? "—" : ts.map(tileText).join(" ");

const SEAT_MARK = ["S0", "S1", "S2", "S3"] as const;

const seatText = (s: SeatIndex | null): string => (s === null ? "—" : SEAT_MARK[s]);

/** 上 / 碰 / 明槓 / 暗槓 / 加槓 — the five forms, named as the table names them. */
export function meldText(m: {
  kind: string;
  tiles: readonly TileId[] | null;
  concealed: boolean;
  addedToPung?: boolean;
  from: SeatIndex;
}): string {
  const label =
    m.kind === "chow"
      ? "上"
      : m.kind === "pung"
        ? "碰"
        : m.concealed
          ? "暗槓"
          : m.addedToPung
            ? "加槓"
            : "明槓";
  const body = m.tiles === null ? "▯▯▯▯" : tilesText(m.tiles);
  const src = m.concealed ? "" : ` ←${seatText(m.from)}`;
  return `${label} ${body}${src}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

/* ── the omniscient board ──────────────────────────────────────────────── */

export function renderBoard(s: FoldedState): string {
  const lines: string[] = [];
  lines.push(
    `hand ${s.handIndex} · 圈 ${WIND_NAMES[s.roundWind]} · dealer ${seatText(s.dealer)} · turn ` +
      `${seatText(s.turn)} · phase ${s.phase} · wall ${liveWallCount(s)} · ` +
      `event ${s.eventIndex}${s.lastEventType ? ` (${s.lastEventType})` : ""}`,
  );
  if (s.lastDiscard) {
    lines.push(`  on the table: ${tileText(s.lastDiscard.tile)} from ${seatText(s.lastDiscard.from)}`);
  }
  for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) {
    const st = s.seats[i];
    const marks = [
      i === s.dealer ? "莊" : "",
      i === s.turn ? "→" : "",
    ].filter((x) => x.length > 0).join("");
    lines.push(
      `  ${SEAT_MARK[i]} ${WIND_NAMES[st.wind]} ${pad(marks, 3)} chips ${padStart(String(st.chips), 5)}`,
    );
    lines.push(`     hand     ${tilesText(st.hand)}${st.drawn === null ? "" : `  ⟨${tileText(st.drawn)}⟩`}`);
    if (st.melds.length > 0) lines.push(`     melds    ${st.melds.map(meldText).join("  |  ")}`);
    if (st.flowers.length > 0) lines.push(`     flowers  ${tilesText(st.flowers)}`);
    lines.push(`     discards ${tilesText(st.discards)}`);
  }
  if (s.claim) {
    const kind = s.claim.robKong ? "搶槓 window" : "claim window";
    lines.push(
      `  ${kind} on ${tileText(s.claim.tile)} from ${seatText(s.claim.from)}: ` +
        s.claim.offers
          .map((o) => `${seatText(o.seat)} ${o.options.map((x) => x.kind).join("/")} → ${o.answer ?? "…"}`)
          .join(", "),
    );
  }
  for (const r of s.refusals) {
    lines.push(
      `  refused win: ${seatText(r.seat)} on ${tileText(r.winningTile)} — ` +
        `${r.faan} faan, house minimum ${r.minimumFaan}`,
    );
  }
  return lines.join("\n") + "\n";
}

/* ── the per-seat board ────────────────────────────────────────────────── */

/** 一家 — what one seat could see. Other hands are counts, never tiles. */
export function renderSeatBoard(snap: SeatSnapshot): string {
  const lines: string[] = [];
  lines.push(
    `hand ${snap.handIndex} · 圈 ${WIND_NAMES[snap.roundWind]} · dealer ${seatText(snap.dealer)} · ` +
      `turn ${seatText(snap.turn)} · phase ${snap.phase} · wall ${snap.wallRemaining} · ` +
      `seq ${snap.seq} · seen by ${seatText(snap.seat)}`,
  );
  if (snap.lastDiscard) {
    lines.push(
      `  on the table: ${tileText(snap.lastDiscard.tile)} from ${seatText(snap.lastDiscard.from)}`,
    );
  }
  for (const v of snap.seats) {
    lines.push(
      `  ${SEAT_MARK[v.seat]} ${WIND_NAMES[v.wind]} ${v.seat === snap.seat ? "(you)" : "     "} ` +
        `chips ${padStart(String(v.chips), 5)}`,
    );
    if (isOwnSeatView(v)) {
      lines.push(`     hand     ${tilesText(v.hand)}${v.drawn === null ? "" : `  ⟨${tileText(v.drawn)}⟩`}`);
    } else {
      lines.push(`     hand     ▯ ×${v.handCount}${v.holdingDrawn ? "  ⟨▯⟩" : ""}`);
    }
    if (v.melds.length > 0) lines.push(`     melds    ${v.melds.map(meldText).join("  |  ")}`);
    if (v.flowers.length > 0) lines.push(`     flowers  ${tilesText(v.flowers)}`);
    lines.push(`     discards ${tilesText(v.discards)}`);
  }
  return lines.join("\n") + "\n";
}

/* ── one line per event ────────────────────────────────────────────────── */

export function eventLine(e: GameEvent): string {
  const head = `${padStart(String(e.seq), 5)}  ${pad(typeof e.actor === "number" ? SEAT_MARK[e.actor] : "server", 7)}${pad(e.type, 18)}`;
  return head + eventDetail(e);
}

function eventDetail(e: GameEvent): string {
  switch (e.type) {
    case "deal": {
      const p = e.payload;
      return `dealer ${seatText(p.dealer)} · 圈 ${WIND_NAMES[p.roundWind]} · seed ${p.seed} · wall ${p.wallRemaining}`;
    }
    case "flowerReplacement": {
      const p = e.payload;
      return `${seatText(p.seat)} 花 ${tileText(p.flower)} → ${tileText(p.replacement)} · wall ${p.wallRemaining}`;
    }
    case "draw": {
      const p = e.payload;
      return `${seatText(p.seat)} ← ${tileText(p.tile)} · wall ${p.wallRemaining}`;
    }
    case "discard": {
      const p = e.payload;
      return `${seatText(p.seat)} → ${tileText(p.tile)}${p.drawAndCut ? " 摸切" : ""}`;
    }
    case "claimOffered": {
      const p = e.payload;
      return `${seatText(p.seat)} may ${p.options.map((o) => o.kind).join("/")} on ${tileText(p.tile)} from ${seatText(p.from)}`;
    }
    case "claimDeclined": {
      const p = e.payload;
      return `${seatText(p.seat)} ${p.reason} on ${tileText(p.tile)}`;
    }
    case "claimed": {
      const p = e.payload;
      return `${seatText(p.seat)} ${meldText(p.meld)} on ${tileText(p.tile)} from ${seatText(p.from)}`;
    }
    case "kongReplacement": {
      const p = e.payload;
      return `${seatText(p.seat)} ← ${tileText(p.tile)} (${p.kongKind} kong) · wall ${p.wallRemaining}`;
    }
    case "concealedKong":
      return `${seatText(e.payload.seat)} 暗槓 ${tileText(e.payload.tile)}`;
    case "addedKong":
      return `${seatText(e.payload.seat)} 加槓 ${tileText(e.payload.tile)}`;
    case "robKongWindow": {
      const p = e.payload;
      return `搶槓 offered on ${tileText(p.tile)} to ${p.offeredTo.map(seatText).join(",") || "nobody"}`;
    }
    case "refusedWin": {
      const p = e.payload;
      return `${seatText(p.context.seat)} on ${tileText(p.context.winningTile)} — ${p.score.faan} faan, below the ${p.minimumFaan}-faan minimum`;
    }
    case "winOnDiscard": {
      const p = e.payload;
      return `${seatText(p.context.seat)} 食糊 ${tileText(p.context.winningTile)} from ${seatText(p.context.from)} — ${p.score.faan} faan${p.context.robbedKong ? " 搶槓" : ""}`;
    }
    case "selfDraw": {
      const p = e.payload;
      return `${seatText(p.context.seat)} 自摸 ${tileText(p.context.winningTile)} — ${p.score.faan} faan`;
    }
    case "exhaustiveDraw":
      return `流局 · wall ${e.payload.wallRemaining} · away ${e.payload.distanceToReady.join("/")}`;
    case "handEnd": {
      const p = e.payload;
      return `${p.outcome} · winner ${seatText(p.winner)} · faan ${p.faan ?? "—"} · deltas ${p.chipDeltas.join("/")} · standings ${p.standings.join("/")}${p.dealerRepeats ? " · 連莊" : ""}`;
    }
    case "matchEnd": {
      const p = e.payload;
      return `${p.reason} · standings ${p.standings.join("/")} · placements ${p.placements.join("/")} · ${p.handsPlayed} hands`;
    }
  }
  return "";
}

/* ── --stats ───────────────────────────────────────────────────────────── */

export function renderStats(header: MatchLogHeader, s: FoldedState): string {
  const lines: string[] = [];
  lines.push(`match ${header.matchId} · ruleset ${header.rulesetId} · engine ${header.engineVersion}`);
  lines.push(
    `players ${header.players.map((p) => `${SEAT_MARK[p.seat]} ${p.displayName}${p.bot ? " (bot)" : ""}`).join(" · ")}`,
  );
  lines.push("");
  lines.push(
    `${pad("hand", 6)}${pad("outcome", 16)}${pad("winner", 8)}${pad("loser", 7)}${padStart("faan", 5)}  ${pad("winning", 8)}${pad("deltas", 22)}${pad("events", 8)}notes`,
  );
  for (const h of s.hands) lines.push(statsRow(h));
  lines.push("");

  const wins = s.hands.filter((h) => h.outcome !== "exhaustiveDraw");
  const draws = s.hands.length - wins.length;
  const faanTotal = wins.reduce((n, h) => n + (h.faan ?? 0), 0);
  lines.push(
    `${s.hands.length} hands · ${wins.length} wins · ${draws} 流局` +
      (s.hands.length > 0 ? ` (${pct(draws, s.hands.length)})` : "") +
      (wins.length > 0 ? ` · mean winning faan ${(faanTotal / wins.length).toFixed(2)}` : ""),
  );
  const selfDraws = wins.filter((h) => h.selfDraw).length;
  if (wins.length > 0) {
    lines.push(
      `自摸 ${selfDraws}/${wins.length} (${pct(selfDraws, wins.length)}) · ` +
        `爆棚 ${wins.filter((h) => h.capped).length} · 搶槓 ${wins.filter((h) => h.robbedKong).length} · ` +
        `refused wins ${s.hands.reduce((n, h) => n + h.refusals, 0)}`,
    );
  }
  lines.push(`standings ${s.seats.map((st) => `${SEAT_MARK[st.seat]} ${st.chips}`).join(" · ")}`);
  if (s.placements) lines.push(`placements ${s.placements.map((p, i) => `${SEAT_MARK[i as SeatIndex]} #${p}`).join(" · ")}`);
  return lines.join("\n") + "\n";
}

function statsRow(h: HandSummary): string {
  const notes: string[] = [];
  if (h.dealerRepeats) notes.push("連莊");
  if (h.capped) notes.push(`爆棚 (raw ${h.rawFaan})`);
  if (h.robbedKong) notes.push("搶槓");
  if (h.selfDraw) notes.push("自摸");
  if (h.refusals > 0) notes.push(`${h.refusals} refused`);
  if (h.awardIds.length > 0) notes.push(h.awardIds.join("+"));
  return (
    pad(String(h.handIndex), 6) +
    pad(h.outcome, 16) +
    pad(seatText(h.winner), 8) +
    pad(seatText(h.loser), 7) +
    padStart(h.faan === null ? "—" : String(h.faan), 5) +
    "  " +
    pad(h.winningTile === null ? "—" : tileText(h.winningTile), 8) +
    pad(h.chipDeltas.join("/"), 22) +
    pad(String(h.events), 8) +
    notes.join(" · ")
  );
}

const pct = (n: number, of: number): string => `${((100 * n) / of).toFixed(0)}%`;

/* ── --verify ──────────────────────────────────────────────────────────── */

export interface VerifyResult {
  ok: boolean;
  /** Every disagreement, as a sentence. Empty when `ok`. */
  problems: string[];
  /** null when the match seed could not be recovered and none was supplied. */
  matchSeed: number | null;
  events: number;
  hands: number;
}

/** Multiplicative inverse mod 2^32 of an odd number. Newton, four doublings. */
function inverseMod32(a: number): number {
  let x = a | 0;
  for (let i = 0; i < 5; i++) x = Math.imul(x, 2 - Math.imul(a, x));
  return x >>> 0;
}

const HAND_SEED_MULTIPLIER = 0x9e3779b1;

/**
 * The match seed, recovered from the per-hand seeds the deal events record and
 * then CHECKED against every one of them. Returns null when the check fails —
 * which is the honest answer whenever `handSeedFor` is not what produced these
 * seeds, so a schema change can never silently hand back a wrong seed.
 */
export function recoverMatchSeed(events: readonly GameEvent[]): number | null {
  const deals = events.filter((e): e is Extract<GameEvent, { type: "deal" }> => e.type === "deal");
  if (deals.length === 0) return null;
  const first = deals[0];
  const inv = inverseMod32(HAND_SEED_MULTIPLIER);
  const guess = ((Math.imul(first.payload.seed, inv) >>> 0) ^ (first.handIndex + 1)) >>> 0;
  for (const d of deals) {
    if (handSeedFor(guess, d.handIndex) !== d.payload.seed) return null;
  }
  return guess;
}

/**
 * Gate 2 (§3): re-execute the log through the reducer and assert the result is
 * the state the log itself describes. The two readings share no code.
 */
export function verifyLog(
  header: MatchLogHeader,
  events: readonly GameEvent[],
  opts: { seed?: number } = {},
): VerifyResult {
  const fail = (problem: string, matchSeed: number | null): VerifyResult => ({
    ok: false,
    problems: [problem],
    matchSeed,
    events: events.length,
    hands: 0,
  });

  // Order matters: the seed and the deal are checked BEFORE the log is folded,
  // so a truncated or scrambled log gets a sentence instead of a stack trace.
  const matchSeed = opts.seed !== undefined ? opts.seed >>> 0 : recoverMatchSeed(events);
  if (matchSeed === null) {
    return fail(
      "the match seed is not in the log and could not be recovered from the deal seeds — pass --seed N",
      null,
    );
  }
  const firstDeal = events.find((e): e is Extract<GameEvent, { type: "deal" }> => e.type === "deal");
  if (!firstDeal) return fail("log has no deal event", matchSeed);
  if (events.length === 0) return fail("log has no events", matchSeed);

  let folded: FoldedState;
  try {
    folded = foldAt(header, events);
  } catch (err) {
    return fail(`the log does not fold: ${err instanceof Error ? err.message : String(err)}`, matchSeed);
  }

  const problems: string[] = [];
  const chips = header.startingChips;
  if (!(chips[0] === chips[1] && chips[1] === chips[2] && chips[2] === chips[3])) {
    problems.push(`starting chips differ per seat (${chips.join("/")}); re-execution seats them equally`);
  }

  const config: MatchConfig = {
    matchId: header.matchId,
    seed: matchSeed,
    rulesetId: header.rulesetId,
    dealer: firstDeal.payload.dealer,
    matchLength: header.matchLength,
    startingChips: chips[0],
    // The logical clock, not the wall clock: `emit` ticks BEFORE stamping, so
    // the first event's ts is the origin plus one tick.
    startedAt: events[0].ts - TICK_MS,
  };

  let replayed: MatchState;
  try {
    replayed = replayMatch(config, events);
  } catch (err) {
    problems.push(`re-execution threw: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, problems, matchSeed, events: events.length, hands: folded.hands.length };
  }

  // A sim's log carries the reducer's logical clock; a live table's carries the
  // wall clock the DO stamped after the reducer ran (§5.5: ts is a coordination
  // fact). Only the former can agree with re-execution tick for tick.
  const logicalClock = events.every((e, i) => e.ts === events[0].ts + i * TICK_MS);
  problems.push(...compareStates(replayed, folded, { logicalClock }));

  return {
    ok: problems.length === 0,
    problems,
    matchSeed,
    events: events.length,
    hands: folded.hands.length,
  };
}

const sameTiles = (a: readonly TileId[], b: readonly TileId[]): boolean =>
  a.length === b.length && a.every((t, i) => t === b[i]);

function compareStates(
  r: MatchState,
  f: FoldedState,
  opts: { logicalClock: boolean } = { logicalClock: true },
): string[] {
  const bad: string[] = [];
  const eq = (what: string, a: unknown, b: unknown): void => {
    if (a !== b) bad.push(`${what}: re-execution ${String(a)}, log ${String(b)}`);
  };

  // `seq` on a MatchState is the NEXT number to stamp; on a FoldedState it is
  // the last one stamped. One event of divergence moves both.
  eq("event count (seq)", r.seq, f.seq + 1);
  if (opts.logicalClock) eq("logical clock (ts)", r.ts, f.ts);
  eq("phase", r.phase, f.phase);
  eq("hand index", r.handIndex, f.handIndex);
  eq("hands played", r.handsPlayed, f.hands.length);
  eq("dealer", r.dealer, f.dealer);
  eq("round wind", r.roundWind, f.roundWind);
  // `turn` is deliberately NOT compared. Once a hand is over the pointer means
  // nothing, and on 流局 the two readings legitimately differ: `advanceTurn` in
  // the reducer moves `turn` to the seat that WOULD have drawn and only then
  // discovers the wall is spent, and no event records that step — so the fold
  // cannot know it and must not guess. Everything that does mean something at
  // the end of a match is compared below.
  eq("wall head", r.wallIndex, f.wallIndex);
  eq("wall tail", r.wallEnd, f.wallEnd);
  eq("match over", r.matchOver, f.matchOver);

  // The ONE intended divergence. After a 食糊 the reducer's final state leaves
  // the winning tile nowhere: `consumeDiscard` took it off the discarder's pile
  // and the winner's concealed tiles never received it. The fold parks it in
  // the winner's `drawn` so 144 still balances, so that seat's `drawn` is
  // expected to differ and only there.
  const winner =
    f.hands.length > 0 && f.hands[f.hands.length - 1].outcome === "winOnDiscard"
      ? f.hands[f.hands.length - 1].winner
      : null;

  for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) {
    const a = r.seats[i];
    const b = f.seats[i];
    eq(`seat ${i} chips`, a.chips, b.chips);
    eq(`seat ${i} wind`, a.wind, b.wind);
    if (!sameTiles(a.hand, b.hand)) {
      bad.push(`seat ${i} hand: re-execution ${tilesText(a.hand)}, log ${tilesText(b.hand)}`);
    }
    if (!sameTiles(a.flowers, b.flowers)) {
      bad.push(`seat ${i} flowers: re-execution ${tilesText(a.flowers)}, log ${tilesText(b.flowers)}`);
    }
    if (!sameTiles(a.discards, b.discards)) {
      bad.push(`seat ${i} discards: re-execution ${tilesText(a.discards)}, log ${tilesText(b.discards)}`);
    }
    if (a.melds.length !== b.melds.length) {
      bad.push(`seat ${i} melds: re-execution ${a.melds.length}, log ${b.melds.length}`);
    } else {
      for (let m = 0; m < a.melds.length; m++) {
        const x = a.melds[m];
        const y = b.melds[m];
        if (x.kind !== y.kind || x.concealed !== y.concealed || !sameTiles(x.tiles, y.tiles)) {
          bad.push(`seat ${i} meld ${m}: re-execution ${meldText(x)}, log ${meldText(y)}`);
        }
      }
    }
    if (i !== winner && a.drawn !== b.drawn) {
      bad.push(`seat ${i} drawn: re-execution ${a.drawn}, log ${b.drawn}`);
    }
  }
  return bad;
}

/* ── argv ──────────────────────────────────────────────────────────────── */

export interface Options {
  file: string | null;
  mode: "step" | "at" | "verify" | "stats" | "help";
  at: number;
  hand: number | null;
  seat: SeatIndex | null;
  seed: number | null;
  errors: string[];
}

const USAGE = `replay — step, inspect and verify an MJRC event log (DESIGN.md §8)

run it with:
  ./node_modules/.bin/vite-node tools/replay/cli.ts -- <logfile> [options]

usage:
  replay <logfile>                step through the log, render state as text
  replay <logfile> --at N         print the board at event N
  replay <logfile> --verify       re-execute the log and assert it reconstructs
  replay <logfile> --stats        per-hand summary: outcome, winner, faan, deltas

options:
  --seat N    render from seat N's perspective 一家, redacted as they saw it
  --hand N    step through one hand only
  --seed N    the match seed, when --verify cannot recover it from the log
  --help      this text

the log is JSON { header, events } or JSONL with the header on line one.
`;

/** Hand-rolled, because tools/ carries no dependencies (DESIGN.md §8). */
export function parseArgs(argv: readonly string[]): Options {
  const o: Options = {
    file: null,
    mode: "step",
    at: 0,
    hand: null,
    seat: null,
    seed: null,
    errors: [],
  };
  const num = (name: string, raw: string | undefined): number | null => {
    if (raw === undefined) {
      o.errors.push(`${name} needs a number`);
      return null;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      o.errors.push(`${name} needs a number, got "${raw}"`);
      return null;
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let flag = arg;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      flag = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    const take = (): string | undefined => (inline !== undefined ? inline : argv[++i]);

    switch (flag) {
      case "--help":
      case "-h":
        o.mode = "help";
        break;
      case "--verify":
        o.mode = "verify";
        break;
      case "--stats":
        o.mode = "stats";
        break;
      case "--at": {
        const n = num("--at", take());
        if (n !== null) {
          o.mode = "at";
          o.at = Math.trunc(n);
        }
        break;
      }
      case "--hand": {
        const n = num("--hand", take());
        if (n !== null) o.hand = Math.trunc(n);
        break;
      }
      case "--seat": {
        const n = num("--seat", take());
        if (n !== null) {
          if (n < 0 || n > 3) o.errors.push(`--seat must be 0-3, got ${n}`);
          else o.seat = Math.trunc(n) as SeatIndex;
        }
        break;
      }
      case "--seed": {
        const n = num("--seed", take());
        if (n !== null) o.seed = Math.trunc(n);
        break;
      }
      default:
        if (arg.startsWith("-")) o.errors.push(`unknown option "${arg}"`);
        else if (o.file === null) o.file = arg;
        else o.errors.push(`unexpected argument "${arg}"`);
    }
  }
  return o;
}

/* ── the command ───────────────────────────────────────────────────────── */

/** 0 success, 1 a failed check, 2 a usage or IO error. */
export function runCli(argv: readonly string[], host: Host): number {
  const o = parseArgs(argv);
  if (o.mode === "help") {
    host.write(USAGE);
    return 0;
  }
  if (o.errors.length > 0) {
    for (const e of o.errors) host.write(`replay: ${e}\n`);
    host.write(USAGE);
    return 2;
  }
  if (o.file === null) {
    host.write("replay: a log file is required\n");
    host.write(USAGE);
    return 2;
  }

  let log: MatchLogFile;
  try {
    log = parseMatchLog(host.readFile(o.file));
  } catch (err) {
    host.write(`replay: ${o.file}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  switch (o.mode) {
    case "verify":
      return runVerify(log, o, host);
    case "stats":
      host.write(renderStats(log.header, foldAt(log.header, log.events)));
      return 0;
    case "at":
      return runAt(log, o, host);
    default:
      return runStep(log, o, host);
  }
}

/** Omniscient by default; 一家 when a seat was named. */
function boardAt(s: FoldedState, seat: SeatIndex | null): string {
  return seat === null ? renderBoard(s) : renderSeatBoard(seatSnapshotOf(seat, s));
}

function runAt(log: MatchLogFile, o: Options, host: Host): number {
  if (o.at < 0 || o.at > log.events.length) {
    host.write(`replay: --at ${o.at} is outside 0..${log.events.length}\n`);
    return 2;
  }
  const s = foldAt(log.header, log.events, o.at);
  if (o.at > 0) host.write(eventLine(log.events[o.at - 1]) + "\n\n");
  host.write(boardAt(s, o.seat));
  return 0;
}

function runStep(log: MatchLogFile, o: Options, host: Host): number {
  const states = foldStates(log.header, log.events);
  host.write(
    `match ${log.header.matchId} · ruleset ${log.header.rulesetId} · engine ${log.header.engineVersion} · ` +
      `${log.events.length} events${o.seat === null ? "" : ` · seen by ${seatText(o.seat)}`}\n\n`,
  );
  let shown = 0;
  for (let i = 0; i < log.events.length; i++) {
    const e = log.events[i];
    if (o.hand !== null && e.handIndex !== o.hand) continue;
    shown++;
    host.write(eventLine(e) + "\n");
    // The board at every hand boundary — the two moments a reader wants it.
    if (e.type === "deal" || e.type === "handEnd") {
      host.write("\n" + boardAt(states[i + 1], o.seat) + "\n");
    }
  }
  if (shown === 0) {
    host.write(`replay: no events for hand ${o.hand}\n`);
    return 2;
  }
  return 0;
}

function runVerify(log: MatchLogFile, o: Options, host: Host): number {
  const r = verifyLog(log.header, log.events, o.seed === null ? {} : { seed: o.seed });
  host.write(
    `verify ${log.header.matchId}: ${r.events} events · ${r.hands} hands · ` +
      `match seed ${r.matchSeed === null ? "unknown" : r.matchSeed}\n`,
  );
  if (r.ok) {
    host.write("OK — re-execution reproduces the log's final state exactly (gate 2, DESIGN.md §3)\n");
    return 0;
  }
  for (const p of r.problems) host.write(`  MISMATCH ${p}\n`);
  host.write(`FAILED — ${r.problems.length} disagreement${r.problems.length === 1 ? "" : "s"}\n`);
  return 1;
}

/* ── the Node entry point ──────────────────────────────────────────────── */

/**
 * The Node globals this file touches, typed here because the workspace carries
 * no @types/node and DESIGN.md §8 adds no dependencies. Four members, and none
 * of them do anything but read a file, write a string, and set an exit code.
 */
interface ProcessLike {
  argv?: string[];
  env?: Record<string, string | undefined>;
  exitCode?: number;
  stdout?: { write(text: string): unknown };
}

const proc = (globalThis as { process?: ProcessLike }).process;

async function main(): Promise<void> {
  if (!proc || !proc.argv || !proc.stdout) return;
  // @ts-ignore — no @types/node here; see the note above.
  const fs = await import("node:fs");
  const host: Host = {
    readFile: (path: string) => fs.readFileSync(path, "utf8") as string,
    write: (text: string) => {
      proc.stdout!.write(text);
    },
  };
  // Both runners below put the user's arguments at argv[2].
  proc.exitCode = runCli(proc.argv.slice(2), host);
}

/**
 * Run only when this file IS the program, and never on a mere import.
 *
 * Two runners can be the program: `vite-node`, which is how a .ts CLI runs in
 * this workspace — relative imports carry `.js` extensions that only a
 * TS-aware resolver maps back to sources, so plain `node cli.ts` cannot load
 * the engine — and node itself, once a build emits .js.
 *
 * vitest is excluded explicitly rather than by argv shape: fold.test.ts imports
 * this module for `runCli`, and a test run that quietly executed a command
 * would be a nasty surprise.
 */
const entry = proc?.argv?.[1] ?? "";
const underTest = proc?.env?.VITEST !== undefined;
const isProgram = /(replay[/\\]cli\.(ts|js|mts|mjs)|vite-node(\.mjs)?)$/.test(entry);
if (!underTest && isProgram) void main();

/**
 * Game-log transcriber — plays N full matches headlessly with the shipping
 * bots and writes one human-readable transcript per match, so the owner can
 * scan raw bot activity for anything weird.
 *
 *   node tools/sim/transcribe.mjs --matches 3 --seed 700000 --out tools/sim/logs/
 *
 * The transcript is OMNISCIENT: all four hands are rendered face up, exactly
 * as the archive serializer sees them. Server-side eyes only — never show a
 * player this file.
 *
 * Terminology: ../../TERMINOLOGY.md. English leads, Cantonese characters
 * follow; Japanese terms are banned.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Meld, ScoreResult, SeatIndex, TileId, FaanAward } from "../../engine/src/types.js";
import { TILE_NAMES, WIND_NAMES, isFlower } from "../../engine/src/tiles.js";
import { prng } from "../../engine/src/wall.js";
import {
  startMatch, startNextHand, applyAction, legalActions,
  type MatchState, type MatchConfig,
} from "../../engine/src/reducer.js";
import {
  assessRoutes, decideAction, shapeOf, DEFAULT_PROFILE,
  type BotConfig, type RouteAssessment,
} from "../../engine/src/bots.js";
import { tableThreat, type SeatThreat } from "../../engine/src/threat.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import { readFileSync as _rfs, existsSync as _exs } from "node:fs";
import { isPattern, pattern } from "../../rulesets/src/patterns.js";
import type { GameEvent } from "../../protocol/src/events.js";
import { SEATS, viewFor } from "./driver.js";

const THINK = process.argv.includes("--think");

function loadProfile(flagName) {
  const i = process.argv.indexOf(flagName);
  if (i < 0 || !process.argv[i + 1] || !_exs(process.argv[i + 1])) return DEFAULT_PROFILE;
  return { ...DEFAULT_PROFILE, ...JSON.parse(_rfs(process.argv[i + 1], "utf8")) };
}
/** --hero <json> plays East (seat 0); --table <json> plays the other three. */
const HERO_MODE = process.argv.includes("--hero");
const HERO_PROFILE = loadProfile("--hero");
const TABLE_PROFILE = loadProfile("--table");

const SUIT_GLYPH = ["萬", "|", "\u25cf"];

function routeName(r: RouteAssessment["route"]): string {
  if (r.orphans) return "13-orphans 十三么";
  if (r.honoursOnly) return "honours 字一色";
  if (r.suit !== null) {
    const g = r.suit === "chars" ? "萬" : r.suit === "bamboo" ? "|" : "\u25cf";
    return (r.pungs ? "pung-flush " : "flush ") + g;
  }
  return r.pungs ? "all-pungs 對對糊" : "balanced/chows";
}

function threatLine(t: SeatThreat, name: string): string | null {
  const signals: string[] = [];
  if (t.exposure > 0) signals.push(`${Math.round(t.exposure * 4)}/4 melded`);
  if (t.intentSuit !== null) signals.push(`collecting ${SUIT_GLYPH[t.intentSuit]} (${t.intentStrength.toFixed(2)})`);
  if (t.read.suitPhasing > 0.55) signals.push("suit-phased cuts → BIG-hand read");
  if (t.read.earlySpread) signals.push("all suits cut early → all-pungs read");
  if (t.read.lateHonours > 0.5) signals.push("honours late → near-ready read");
  if (t.read.earlyValueHonours > 0) signals.push("value honours early → suspicious");
  if (signals.length === 0 && t.threat < 0.15) return null;
  return `     ${name.padEnd(9)} threat ${t.threat.toFixed(2)} · est ${t.expectedFaan} faan (${t.chipsRel.toFixed(0)}× floor payout) · ${signals.join(" · ") || "quiet"}`;
}

/** The seat's whole position after the cut — full hand, then melds compactly. */
function handDump(state: MatchState, seat: number): string {
  const st = state.seats[seat]!;
  const melds = st.melds.length
    ? " \u2016 " + st.melds.map((m) => {
        const tag = m.kind === "chow" ? "\u4e0a" : m.kind === "pung" ? "\u78b0" : m.concealed ? "\u6697\u69d3" : "\u69d3";
        return m.kind === "chow" ? tag + m.tiles.map(glyph).join("") : tag + glyph(m.tiles[0]!);
      }).join(" ")
    : "";
  return ` \u2502 ${row(st.hand)}${melds}`;
}

/** What the acting bot is evaluating, mathematically, right now. */
function thinkBlock(v: Parameters<typeof shapeOf>[0], seat: number, discardCount: number, names: string[]): string {
  const threats = tableThreat(v, MJRC_STANDARD);
  const lines: string[] = [`  ┈┈ ${names[seat]} thinking (discard ${discardCount}) ┈┈`];
  const reads = threats.seats
    .map((t) => threatLine(t, names[t.seat] ?? `seat${t.seat}`))
    .filter((l): l is string => l !== null);
  lines.push(reads.length ? "     table read:" : "     table read: all quiet — no signals yet");
  lines.push(...reads);
  if (threats.max > 0.05) lines.push(`     race pressure ${threats.max.toFixed(2)} → distant plans discounted harder`);
  const routes = assessRoutes(shapeOf(v), MJRC_STANDARD, DEFAULT_PROFILE, threats)
    .filter((r) => r.feasible && Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  lines.push("     plans considered:");
  for (const [i, r] of routes.entries()) {
    lines.push(
      `       ${i === 0 ? "→" : " "} ${routeName(r.route).padEnd(16)} score ${r.score.toFixed(2).padStart(6)}` +
      ` · pays ${r.faan} faan · ${r.distance} away · wastes ${r.surplus} tiles` +
      (r.attainable < 3 ? " · CANNOT reach the 3-faan floor" : ""),
    );
  }
  return lines.join("\n");
}

const LEGEND = [
  "══ tile legend ══════════════════════════════════════════════════════════",
  "  suits    N萬 = characters (\"man\")   N| = bamboo (sticks)   N\u25cf = circles (dots)",
  "  winds    東 East   南 South   西 West   北 North",
  "  dragons  中 red    發 green   白 white",
  "  flowers  梅 plum 蘭 orchid 菊 mum 竹 bamboo · seasons 春 spr 夏 sum 秋 aut 冬 win",
  "  terms    食糊 win on a discard · 自摸 self-draw win · 摸切 drew-and-cut",
  "           碰 pung · 上 chow · 槓 kong (暗槓 concealed · 加槓 added) · 流局 nobody won",
  "═════════════════════════════════════════════════════════════════════════",
  "",
].join("\n");


/* ── small renderers ───────────────────────────────────────────────────── */

const WIND_EN = ["East", "South", "West", "North"] as const;

// Human-scan notation (owner, 2026-08-27): characters keep 萬; bamboo are
// sticks N|, circles are dots N● — three shapes the eye separates instantly.
const TILE_SYM: string[] = TILE_NAMES.map((n, i) =>
  i >= 9 && i < 18 ? `${(i % 9) + 1}|` : i >= 18 && i < 27 ? `${(i % 9) + 1}\u25cf` : n,
);
const glyph = (t: TileId): string => TILE_SYM[t] ?? `?${t}`;
const row = (ts: readonly TileId[]): string =>
  [...ts].sort((a, b) => a - b).map(glyph).join(" ");
const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);
const ordinal = (n: number): string => `${n}${["th", "st", "nd", "rd"][n] ?? "th"}`;

const meldText = (m: Meld): string =>
  `[${m.kind}${m.concealed ? " · concealed" : ""} ${m.tiles.map(glyph).join(" ")}]`;

/** One award as "Half Flush 混一色 3" — English leads, characters follow. */
const awardText = (a: FaanAward): string => {
  if (!isPattern(a.id)) return `${a.id} ${a.faan}`;
  const def = pattern(a.id);
  return `${def.label} ${def.characters} ${a.faan}`;
};

const scoreText = (s: ScoreResult): string => {
  const parts = s.awards.length ? s.awards.map(awardText).join(" + ") : "(no awards)";
  const cap = s.capped ? ` · capped at the limit 爆棚 (raw ${s.rawFaan})` : "";
  return `${s.faan} faan: ${parts}${cap}`;
};

/* ── the transcriber ───────────────────────────────────────────────────── */

/**
 * Folds the omniscient event stream into readable lines. Consecutive
 * draw→cut, claim→cut and kong→replacement→cut steps are merged onto one
 * line via a one-slot pending buffer; anything else flushes it first.
 */
class Transcriber {
  private lines: string[] = [];
  /** Raw annotation lines — the --think readouts ride the same transcript. */
  annotate(text: string): void { this.lines.push(text); }
  /** Per-hand display names by seat index — East/South/West/North by seat wind. */
  private names: string[] = ["?", "?", "?", "?"];
  private pending: {
    seat: SeatIndex;
    /** What would continue this line: the seat's cut, or a kong replacement. */
    expect: "cut" | "replacement";
    text: string;
    /** Tile currently held apart (drawn or replacement), for flower chains. */
    drawn: TileId | null;
  } | null = null;
  /** Claim kinds offered per seat in the open window, for decline lines. */
  private offers = new Map<SeatIndex, string[]>();
  private roundWind = 0;
  /** Seat indexes in wind order (East first) for the hand in play. */
  private windOrder: SeatIndex[] = [...SEATS];

  constructor(matchId: string, seed: number) {
    this.lines.push(
      `MATCH ${matchId} · seed ${seed} · ruleset ${MJRC_STANDARD.id} (${MJRC_STANDARD.label})`,
      `floor ${MJRC_STANDARD.minimumFaan} faan · limit ${MJRC_STANDARD.limitFaan} faan 爆棚 · one wind round`,
      `OMNISCIENT LOG — all four hands are face up in this file. Server-side eyes only.`,
      `bots: chair dealt East in hand 0 plays the --hero profile; the other three play --table.`,
      `(no flags given = shipping DEFAULT_PROFILE for that side). Chair names rotate with the deal.`,
      ...(HERO_MODE ? [`\u2605 marks the hero bot on every line \u2014 follow the star through the wind rotations.`] : []),
      `Seats are named East/South/West/North by their seat wind for the hand in play;`,
      `winds rotate when the deal passes, so the same chair changes name between hands.`,
    );
  }

  /** Seat display name, padded so tile columns roughly line up. */
  seatNames(): string[] {
    return this.names;
  }

  private n(seat: SeatIndex): string {
    return (this.names[seat] ?? `seat${seat}`).padEnd(HERO_MODE ? 6 : 5);
  }

  private flush(): void {
    if (this.pending) {
      this.lines.push(this.pending.text);
      this.pending = null;
    }
  }

  push(e: GameEvent, state: MatchState): void {
    switch (e.type) {
      case "deal": {
        this.flush();
        this.offers.clear();
        const p = e.payload;
        for (const s of SEATS) this.names[s] = WIND_EN[p.seatWinds[s]] + (HERO_MODE && s === 0 ? "\u2605" : "");
        this.roundWind = p.roundWind;
        this.lines.push(
          "",
          `hand ${e.handIndex} · dealer ${WIND_EN[p.seatWinds[p.dealer]]} ${WIND_NAMES[p.seatWinds[p.dealer]]}` +
            ` · round wind ${WIND_EN[p.roundWind]} ${WIND_NAMES[p.roundWind]} · wall seed ${p.seed}`,
        );
        this.windOrder = [...SEATS].sort((a, b) => p.seatWinds[a] - p.seatWinds[b]);
        let label = "deal ";
        for (const s of this.windOrder) {
          const tiles = p.hands[s];
          const plain = tiles.filter((t) => !isFlower(t));
          const flowers = tiles.filter(isFlower);
          this.lines.push(
            `  ${label} ${this.n(s)}: ${row(plain)}` +
              (flowers.length ? `  flowers: ${row(flowers)}` : ""),
          );
          label = "     ";
        }
        break;
      }

      case "flowerReplacement": {
        const p = e.payload;
        const pd = this.pending;
        if (pd && pd.seat === p.seat && pd.expect === "cut" && pd.drawn === p.flower) {
          // The tile this seat just picked up was a flower — chain it.
          pd.text += ` — a flower · replacement ${glyph(p.replacement)}`;
          pd.drawn = p.replacement;
        } else {
          this.flush();
          this.lines.push(
            `  ${this.n(p.seat)} reveals flower ${glyph(p.flower)} · replacement ${glyph(p.replacement)}`,
          );
        }
        break;
      }

      case "draw": {
        this.flush();
        this.offers.clear();
        const p = e.payload;
        this.pending = {
          seat: p.seat,
          expect: "cut",
          text: `  ${this.n(p.seat)} draws ${glyph(p.tile)}`,
          drawn: p.tile,
        };
        break;
      }

      case "discard": {
        const p = e.payload;
        const pd = this.pending;
        const held = handDump(state, p.seat);
        if (pd && pd.seat === p.seat && pd.expect === "cut") {
          const cut = p.drawAndCut && pd.drawn === p.tile
            ? `cuts it right back (drew and cut 摸切)`
            : `cuts ${glyph(p.tile)}`;
          this.lines.push(`${pd.text} · ${cut}${held}`);
          this.pending = null;
        } else {
          this.flush();
          this.lines.push(`  ${this.n(p.seat)} cuts ${glyph(p.tile)}${held}`);
        }
        break;
      }

      case "claimOffered": {
        // Not rendered as its own line — remembered so the decline/claim
        // lines can say WHAT was on offer.
        const p = e.payload;
        this.offers.set(p.seat, p.options.map((o) => o.kind));
        break;
      }

      case "claimDeclined": {
        this.flush();
        const p = e.payload;
        const offered = this.offers.get(p.seat) ?? [];
        // Dedupe: three chow variants render as "chow×3", not "chow/chow/chow".
        const byKind = new Map<string, number>();
        for (const k of offered) byKind.set(k, (byKind.get(k) ?? 0) + 1);
        const kinds = byKind.size === 0
          ? "claim"
          : [...byKind.entries()].map(([k, c]) => (c > 1 ? `${k}×${c}` : k)).join("/");
        // A bot passing on an offered WIN would be genuinely weird — flag it.
        const bang = kinds.includes("win") ? "!! " : "";
        const text = p.reason === "pass"
          ? `${bang}(${this.names[p.seat]} passes on ${kinds} of ${glyph(p.tile)})`
          : p.reason === "outranked"
            ? `${bang}(${this.names[p.seat]}'s ${kinds} claim on ${glyph(p.tile)} was outranked)`
            : `${bang}(${this.names[p.seat]} timed out on ${kinds} of ${glyph(p.tile)})`;
        this.lines.push(`      ${text}`);
        break;
      }

      case "claimed": {
        this.flush();
        const p = e.payload;
        this.offers.clear();
        const verb = p.kind === "chow" ? "chows" : p.kind === "pung" ? "pungs" : "kongs";
        this.pending = {
          seat: p.seat,
          expect: p.kind === "kong" ? "replacement" : "cut",
          text: `  ${this.n(p.seat)} ${verb} ${glyph(p.tile)} from ${this.names[p.from]} → ${meldText(p.meld)}`,
          drawn: null,
        };
        break;
      }

      case "concealedKong": {
        this.flush();
        const p = e.payload;
        this.pending = {
          seat: p.seat,
          expect: "replacement",
          text: `  ${this.n(p.seat)} declares concealed kong 暗槓 ${glyph(p.tile)}`,
          drawn: null,
        };
        break;
      }

      case "addedKong": {
        this.flush();
        const p = e.payload;
        this.pending = {
          seat: p.seat,
          expect: "replacement",
          text: `  ${this.n(p.seat)} adds ${glyph(p.tile)} to the exposed pung (added kong 加槓)`,
          drawn: null,
        };
        break;
      }

      case "kongReplacement": {
        const p = e.payload;
        const pd = this.pending;
        if (pd && pd.seat === p.seat && pd.expect === "replacement") {
          pd.text += ` · replacement ${glyph(p.tile)}`;
          pd.expect = "cut";
          pd.drawn = p.tile;
        } else {
          this.flush();
          this.pending = {
            seat: p.seat,
            expect: "cut",
            text: `  ${this.n(p.seat)} draws replacement ${glyph(p.tile)} (${p.kongKind} kong)`,
            drawn: p.tile,
          };
        }
        break;
      }

      case "robKongWindow": {
        this.flush();
        const p = e.payload;
        const who = p.offeredTo.map((s) => this.names[s]).join(", ");
        this.lines.push(
          `      (rob-the-kong 搶槓 window on ${glyph(p.tile)} — offered to ${who || "nobody"})`,
        );
        break;
      }

      case "refusedWin": {
        this.flush();
        const p = e.payload;
        const seat = p.context.seat;
        const how = p.context.selfDraw || p.context.from === null
          ? `drew a winning tile ${glyph(p.context.winningTile)}`
          : `hit a winning shape on ${this.names[p.context.from]}'s ${glyph(p.context.winningTile)}`;
        this.lines.push(
          `  !! ${this.names[seat]} ${how} but holds ${p.score.faan} faan — ` +
            `REFUSED (under the ${p.minimumFaan}-faan floor)`,
        );
        const detail = p.score.awards.length
          ? p.score.awards.map(awardText).join(" + ")
          : "no scoring patterns at all";
        this.lines.push(
          `     held: ${row(p.concealed)}` +
            (p.melds.length ? ` · melds: ${p.melds.map(meldText).join(" ")}` : "") +
            (p.flowers.length ? ` · flowers: ${row(p.flowers)}` : "") +
            ` · would score: ${detail}`,
        );
        break;
      }

      case "winOnDiscard":
      case "selfDraw": {
        this.flush();
        this.offers.clear();
        const p = e.payload;
        const seat = p.context.seat;
        const head = e.type === "selfDraw"
          ? `  ${this.n(seat)} WINS by self-draw 自摸 on ${glyph(p.context.winningTile)}`
          : `  ${this.n(seat)} WINS 食糊 on ${glyph(e.payload.context.winningTile)} from ${this.names[e.payload.context.from]}` +
            (e.payload.context.robbedKong ? " (robbing the kong 搶槓)" : "");
        this.lines.push(`${head} · ${scoreText(p.score)}`);
        this.lines.push(
          `        winning hand: ${row([...p.concealed, p.context.winningTile])}` +
            (p.melds.length ? ` · melds: ${p.melds.map(meldText).join(" ")}` : "") +
            (p.flowers.length ? ` · flowers: ${row(p.flowers)}` : ""),
        );
        break;
      }

      case "exhaustiveDraw": {
        this.flush();
        const p = e.payload;
        this.lines.push(`  == wall exhausted 流局 — nobody wins · all four hands:`);
        for (const s of this.windOrder) {
          const d = p.distanceToReady[s];
          const status = d < 0 ? "COMPLETE?!" : d === 0 ? "ready" : `${d} away`;
          const melds = state.seats[s].melds;
          const flowers = state.seats[s].flowers;
          this.lines.push(
            `     ${this.n(s)} (${status.padEnd(6)}): ${row(p.hands[s])}` +
              (melds.length ? ` · melds: ${melds.map(meldText).join(" ")}` : "") +
              (flowers.length ? ` · flowers: ${row(flowers)}` : ""),
          );
        }
        break;
      }

      case "handEnd": {
        this.flush();
        const p = e.payload;
        const chips = this.windOrder.map((s) => `${this.names[s]} ${signed(p.chipDeltas[s])}`).join("  ");
        const totals = this.windOrder.map((s) => `${this.names[s]} ${p.standings[s]}`).join("  ");
        const dealer = p.dealerRepeats ? "dealer repeats 連莊" : "dealer rotates";
        const windTail = p.nextRoundWind !== this.roundWind
          ? ` · round wind advances to ${WIND_EN[p.nextRoundWind]} ${WIND_NAMES[p.nextRoundWind]}`
          : "";
        this.lines.push(
          `  == hand ${e.handIndex} ends: chips ${chips} · totals ${totals} · ${dealer}${windTail}`,
        );
        break;
      }

      case "matchEnd": {
        this.flush();
        const p = e.payload;
        const order = [...SEATS].sort((a, b) => p.placements[a] - p.placements[b]);
        const standings = order
          .map((s) => `${ordinal(p.placements[s])} ${this.names[s]} ${signed(p.standings[s])}`)
          .join(" · ");
        this.lines.push(
          "",
          `== MATCH ENDS (${p.reason}) after ${p.handsPlayed} hands: ${standings}`,
          `   (final placements name seats by their LAST hand's wind)`,
        );
        break;
      }
    }
  }

  text(): string {
    this.flush();
    return this.lines.join("\n") + "\n";
  }
}

/* ── the match loop — driver.playMatch, but keeping the event stream ───── */

function playAndTranscribe(seed: number): string {
  const matchId = `transcribe-${seed}`;
  const config: MatchConfig = {
    matchId,
    seed,
    rulesetId: MJRC_STANDARD.id,
    matchLength: "oneWindRound",
  };
  // One deterministic stream per seat, same derivation watch.ts uses.
  const configs: BotConfig[] = SEATS.map((s) => ({
    ruleset: MJRC_STANDARD,
    profile: s === 0 ? HERO_PROFILE : TABLE_PROFILE,
    rnd: prng((seed ^ ((s + 1) * 0x9e3779b1)) >>> 0),
  }));

  let { state, events } = startMatch(config);
  const t = new Transcriber(matchId, seed);

  let discardCount = 0;
  for (let guard = 0; guard < 200_000; guard++) {
    for (const e of events) {
      if (e.type === "discard") discardCount++;
      t.push(e, state);
    }
    if (state.phase === "matchEnd") return t.text();
    if (state.phase === "handEnd") {
      ({ state, events } = startNextHand(state));
      discardCount = 0;
      continue;
    }
    let acted = false;
    for (const seat of SEATS) {
      const options = legalActions(state, seat);
      if (options.length === 0) continue;
      const v = viewFor(state, seat);
      if (THINK && state.phase === "awaitDiscard" && state.turn === seat &&
          discardCount > 0 && discardCount % 8 === 0) {
        t.annotate(thinkBlock(v, seat, discardCount, t.seatNames()));
      }
      const action = decideAction(v, options, configs[seat]!);
      ({ state, events } = applyAction(state, action));
      acted = true;
      break;
    }
    if (!acted) throw new Error(`stuck in phase ${state.phase}`);
  }
  throw new Error("match did not terminate");
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const flagVal = (n: string): string | null => {
  const i = args.indexOf(n);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const MATCHES = Number(flagVal("--matches") ?? 3);
const BASE_SEED = Number(flagVal("--seed") ?? 700000);
const OUT_DIR = flagVal("--out") ?? "tools/sim/logs/";

if (!Number.isFinite(MATCHES) || MATCHES < 1) throw new Error(`bad --matches`);
if (!Number.isFinite(BASE_SEED)) throw new Error(`bad --seed`);

mkdirSync(OUT_DIR, { recursive: true });
const written: string[] = [];
for (let m = 0; m < MATCHES; m++) {
  const seed = BASE_SEED + m;
  const path = join(OUT_DIR, `match-${seed}.txt`);
  writeFileSync(path, LEGEND + playAndTranscribe(seed));
  written.push(path);
}
console.log(`wrote ${written.length} transcript(s):`);
for (const p of written) console.log(`  ${p}`);

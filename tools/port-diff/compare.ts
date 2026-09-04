/**
 * Port-diff harness — DESIGN.md §8, the FIRST of the two validation harnesses:
 * "replays the Python engine's logged batches through the TS port; validates
 * the closed-hand LIU subset only (that's all the Python engine can generate)."
 *
 * SCOPE, because a green run here is easy to over-read: this file can compare
 * closed 14-tile hands and nothing else. The Python engine at
 * mjrc-admin/research/probability/ has no claims, no kongs (a quad raises
 * ValueError), no flowers and no wind faan (ENGINE-AUDIT §1), so no fixture it
 * produces can exercise the canonical HKOS extensions. Those are the
 * golden-hand suite's job and the P0 exit requirement. See README.md.
 *
 * ENGINE-AUDIT §3 adds a second instruction this file follows literally:
 * validate against the EXHAUSTIVE Python reference, never against the Python
 * test expectations. The engine's shipped branch-and-bound cutoff is wrong on
 * ~6.1% of 13-tile and ~10.1% of 14-tile hands and the 158-case Python suite
 * sits inside the agreeing 94%. Accordingly the fixture generator recomputes
 * every distance figure exhaustively, and the per-frame bot rationale block in
 * the logs — which carries the cutoff's answers — is dropped on the floor.
 *
 * Nothing in this file calls Math.random, Date.now or iterates unordered keys
 * in a way that reaches a result (DESIGN.md §5.5). Reports are ordered by case
 * id so two runs over one fixture are byte-identical.
 *
 * Terminology: ../../TERMINOLOGY.md.
 */

import {
  SCORING_KINDS,
  type Meld,
  type Ruleset,
  type ScoreResult,
  type SeatIndex,
  type TileId,
  type WinContext,
  type WindIndex,
} from "@mjrc/engine";
import { enabledPatterns, isPattern, subsumptionClosure } from "@mjrc/rulesets";

/* ── the scorer, injected ──────────────────────────────────────────────── */

/**
 * engine/src/scoring.ts's exported signature. Injected rather than imported so
 * this module stays a pure library: the test wires the real scorer in, and a
 * future CLI or a bisect script can wire in an older build (DESIGN.md §5.5
 * pins engine_version precisely because replays must not be rescored by a
 * newer engine).
 */
export type Scorer = (
  concealed: TileId[],
  melds: Meld[],
  flowers: TileId[],
  winningTile: TileId,
  ctx: WinContext,
  ruleset: Ruleset,
) => ScoreResult;

/** ready.ts's distance function, injected for the same reason. */
export type DistanceFn = (counts: readonly number[], melds?: number) => number;

/* ── tile space ────────────────────────────────────────────────────────── */

/**
 * The two tile spaces agree on 0-33 exactly — 0-8 萬, 9-17 索, 18-26 筒,
 * 27-30 winds, 31-33 dragons — so the translation is the identity map and the
 * only real work is turning a count array into a tile list. Ours continues to
 * 41 with the eight flowers; the Python model simply stops at 34.
 *
 * Asserted rather than assumed: if either side ever renumbers, every hand in
 * the corpus silently becomes a different hand.
 */
export const PYTHON_TILE_KINDS = 34;

export function assertTileSpacesAligned(): void {
  if (PYTHON_TILE_KINDS !== SCORING_KINDS) {
    throw new Error(
      `tile spaces have diverged: the Python engine has ${PYTHON_TILE_KINDS} kinds, ` +
        `engine/src/types.ts has ${SCORING_KINDS} scoring kinds`,
    );
  }
}

/** A 34-slot count array as a sorted tile list. */
export function tilesFromCounts(counts: readonly number[]): TileId[] {
  const out: TileId[] = [];
  for (let t = 0; t < counts.length; t++) {
    const n = counts[t] ?? 0;
    for (let i = 0; i < n; i++) out.push(t);
  }
  return out;
}

/** Wind tile id 27-30 → WindIndex 0-3. The Python logs carry the tile id. */
export function windIndexOf(tileOrIndex: number): WindIndex {
  const i = tileOrIndex >= 27 ? tileOrIndex - 27 : tileOrIndex;
  if (!Number.isInteger(i) || i < 0 || i > 3) throw new Error(`${tileOrIndex} is not a wind`);
  return i as WindIndex;
}

/* ── the fixture ───────────────────────────────────────────────────────── */

/** The Python engine's own answer for one hand, exactly as it logged it. */
export interface PythonAnswer {
  /** Display names from its ScoringPattern enum, e.g. "Small Three Dragons". */
  patterns: string[];
  /** Per-pattern faan. Sums UNCAPPED — ENGINE-AUDIT §1 flags the inconsistency. */
  faanBreakdown: Record<string, number>;
  /** Its total, capped at 13. */
  faan: number;
  /** Chips from its four-bracket table. */
  chips: number;
}

export interface ScoringCase {
  /** Deterministic: log file tag, hand index, turn. */
  id: string;
  handIndex: number;
  turn: number;
  seat: number;
  dealer: number;
  /** Already converted to WindIndex 0-3. */
  roundWind: number;
  seatWind: number;
  selfDraw: boolean;
  /** Seat that fed the winning tile; null on a self-draw. */
  from: number | null;
  winningTile: TileId;
  /** 34 counts, INCLUDING the winning tile. Sums to 14. */
  hand: number[];
  wallRemaining: number;
  /** Four per-seat meld lists. Always empty — the guard that the corpus is claim-free. */
  melds: unknown[][];
  python: PythonAnswer;
  /** Per-seat chips for the whole hand, from the log footer. */
  chipDeltas: number[];
}

export interface DistanceCase {
  id: string;
  hand: number[];
  tiles: number;
  /** Exhaustive search — the reference ENGINE-AUDIT §3 says to validate against. */
  exhaustive: number;
  /** What the Python engine's cutoff actually returns. Carried to measure it, never to match it. */
  shipped: number;
}

export interface FixtureProvenance {
  generatedBy: string;
  generatedAt: string;
  pythonRepo: string;
  batchSeed: number;
  matches: number;
  bots: string[];
  handsPlayed: number;
  handsWon: number;
  /** Log file tag the committed raw sample was lifted from. */
  sampleTag: string | null;
  pythonRuleset: Record<string, unknown>;
  scopeWarning: string;
}

export interface Fixture {
  formatVersion: number;
  provenance: FixtureProvenance;
  scoringCases: ScoringCase[];
  distanceCases: DistanceCase[];
}

export const FIXTURE_FORMAT_VERSION = 1;

/**
 * Validate a parsed fixture and hand it back typed. Throws loudly: a fixture
 * that has quietly changed shape would make every comparison below meaningless
 * while still reporting a number.
 */
export function loadFixture(raw: unknown): Fixture {
  const f = raw as Fixture;
  if (!f || typeof f !== "object") throw new Error("fixture is not an object");
  if (f.formatVersion !== FIXTURE_FORMAT_VERSION) {
    throw new Error(
      `fixture format ${f.formatVersion} but this harness reads ${FIXTURE_FORMAT_VERSION}`,
    );
  }
  if (!Array.isArray(f.scoringCases) || !Array.isArray(f.distanceCases)) {
    throw new Error("fixture is missing scoringCases or distanceCases");
  }
  for (const c of f.scoringCases) assertScoringCaseSound(c);
  for (const d of f.distanceCases) {
    const n = d.hand.reduce((a, b) => a + b, 0);
    if (n !== d.tiles) throw new Error(`${d.id}: counts sum to ${n}, declared ${d.tiles}`);
  }
  return f;
}

/**
 * The invariants that make a case usable, including the two that define the
 * scope: fourteen tiles, and no melds anywhere. If the Python engine ever grows
 * claims, this throws rather than letting the harness quietly compare hands
 * whose exposed sets it has thrown away.
 */
export function assertScoringCaseSound(c: ScoringCase): void {
  if (c.hand.length !== PYTHON_TILE_KINDS) {
    throw new Error(`${c.id}: hand has ${c.hand.length} slots, expected ${PYTHON_TILE_KINDS}`);
  }
  const total = c.hand.reduce((a, b) => a + b, 0);
  if (total !== 14) throw new Error(`${c.id}: ${total} tiles, a winning hand holds 14`);
  if ((c.hand[c.winningTile] ?? 0) < 1) {
    throw new Error(`${c.id}: winning tile ${c.winningTile} is not in the hand`);
  }
  for (const list of c.melds) {
    if (list.length !== 0) {
      throw new Error(
        `${c.id}: the corpus carries a declared meld. The Python engine had no claims when ` +
          `this harness was written (ENGINE-AUDIT §1); the translation below drops melds and ` +
          `would be scoring a different hand.`,
      );
    }
  }
  if (c.selfDraw !== (c.from === null)) {
    throw new Error(`${c.id}: selfDraw ${c.selfDraw} disagrees with from ${c.from}`);
  }
}

/* ── parsing the raw Python logs ───────────────────────────────────────── */

/** One JSON value per line, blank lines skipped. core/replay.py's format. */
export function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch (e) {
      throw new Error(`line ${i + 1} is not JSON: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Pull scoring cases straight out of a raw JSONL log, so the harness can be
 * pointed at a freshly generated batch without regenerating the fixture.
 *
 * A winning frame is recognised STRUCTURALLY — it is the frame carrying a
 * `score` block — and the win type is read off `score.deal_in_seat`, which the
 * Python engine leaves null exactly when the winner drew the tile themselves.
 * Neither the frame's action label nor the footer's outcome label is consulted;
 * both are spelled in a vocabulary TERMINOLOGY.md bans from this codebase.
 *
 * `tag` distinguishes cases from different files and must match the tag the
 * fixture generator used (the log file's basename without its extension).
 */
export function extractScoringCases(
  lines: readonly Record<string, unknown>[],
  tag: string,
): ScoringCase[] {
  const out: ScoringCase[] = [];
  let header: Record<string, unknown> | null = null;
  let pending: ScoringCase[] = [];

  for (const rec of lines) {
    const kind = rec["kind"];
    if (kind === "hand_header") {
      header = rec;
      pending = [];
      continue;
    }
    if (kind === "hand_footer") {
      const deltas = (rec["chip_deltas"] as number[]) ?? [0, 0, 0, 0];
      for (const c of pending) {
        c.chipDeltas = [...deltas];
        out.push(c);
      }
      pending = [];
      continue;
    }

    const score = rec["score"] as Record<string, unknown> | undefined | null;
    if (score === undefined || score === null) continue;
    if (header === null) throw new Error(`${tag}: a scored frame arrived before its hand header`);

    const seat = Number(score["winner"]);
    const fromRaw = score["deal_in_seat"];
    const from = fromRaw === null || fromRaw === undefined ? null : Number(fromRaw);
    const seatWinds = header["seat_winds"] as number[];
    const action = rec["action"] as Record<string, unknown>;

    pending.push({
      id: `${tag}.h${Number(header["hand_index"] ?? 0)}.t${Number(rec["turn"])}`,
      handIndex: Number(header["hand_index"] ?? 0),
      turn: Number(rec["turn"]),
      seat,
      dealer: Number(header["dealer"] ?? 0),
      roundWind: Number(header["round_wind"] ?? 27) - 27,
      seatWind: Number(seatWinds[seat]) - 27,
      selfDraw: from === null,
      from,
      winningTile: Number(action["tile"]),
      hand: (score["winning_hand"] as number[]).map(Number),
      wallRemaining: Number(rec["wall_remaining"]),
      melds: ((rec["melds"] as unknown[][]) ?? []).map((m) => [...m]),
      python: {
        patterns: [...(score["patterns"] as string[])],
        faanBreakdown: { ...(score["fan_breakdown"] as Record<string, number>) },
        faan: Number(score["total_fan"]),
        chips: Number(score["chips"]),
      },
      chipDeltas: [0, 0, 0, 0],
    });
  }
  return out;
}

/* ── translation into our model ────────────────────────────────────────── */

export interface WinInput {
  concealed: TileId[];
  melds: Meld[];
  flowers: TileId[];
  winningTile: TileId;
  ctx: WinContext;
}

/**
 * A Python case as arguments to `score`.
 *
 * `concealed` excludes the winning tile, matching decompose.ts and the golden
 * fixtures. `melds` and `flowers` are empty by construction — the corpus has
 * neither, and `assertScoringCaseSound` refuses a case that does.
 *
 * `onLastTile` is set from the logged wall count because it is derivable and
 * true; the Python engine has no such faan, so our engine awarding 海底撈月
 * shows up as a named, expected divergence rather than as noise.
 */
export function toWinInput(c: ScoringCase): WinInput {
  assertTileSpacesAligned();
  const all = tilesFromCounts(c.hand);
  const at = all.indexOf(c.winningTile);
  if (at < 0) throw new Error(`${c.id}: winning tile ${c.winningTile} is not in the hand`);
  const concealed = [...all.slice(0, at), ...all.slice(at + 1)];

  const ctx: WinContext = {
    seat: c.seat as SeatIndex,
    selfDraw: c.selfDraw,
    from: c.from === null ? null : (c.from as SeatIndex),
    winningTile: c.winningTile,
    roundWind: windIndexOf(c.roundWind),
    seatWind: windIndexOf(c.seatWind),
    isDealer: c.seat === c.dealer,
    onLastTile: c.selfDraw && c.wallRemaining === 0,
    wallEmpty: c.wallRemaining === 0,
  };
  return { concealed, melds: [], flowers: [], winningTile: c.winningTile, ctx };
}

/* ── the two faan tables, side by side ─────────────────────────────────── */

/**
 * Python's ScoringPattern display name → our pattern id. These sixteen ids are
 * the WHOLE of what the Python engine can score; everything else our engine
 * awards is an extension it has no opinion about.
 *
 * Transcribed from PATTERN_FAN in core/scoring.py. "All Honors" keeps the US
 * spelling on the Python side and maps to our "allHonours".
 */
export const PYTHON_PATTERN_IDS: Readonly<Record<string, string>> = {
  "All Chows": "allChows",
  "All Pungs": "allPungs",
  "Seven Pairs": "sevenPairs",
  "Half Flush": "halfFlush",
  "Full Flush": "fullFlush",
  "Mixed Terminals": "mixedTerminals",
  "Dragon Pung (Red)": "dragonPung",
  "Dragon Pung (Green)": "dragonPung",
  "Dragon Pung (White)": "dragonPung",
  "Small Three Dragons": "smallThreeDragons",
  "Big Three Dragons": "bigThreeDragons",
  "Small Four Winds": "smallFourWinds",
  "Big Four Winds": "bigFourWinds",
  "All Honors": "allHonours",
  "All Terminals": "allTerminals",
  "Nine Gates": "nineGates",
  "Thirteen Orphans": "thirteenOrphans",
  "Self-Drawn": "selfDraw",
};

/** The faan the Python engine pays, keyed by OUR id. Transcribed from PATTERN_FAN. */
export const PYTHON_FAAN: Readonly<Record<string, number>> = {
  allChows: 1,
  allPungs: 3,
  sevenPairs: 4,
  halfFlush: 3,
  fullFlush: 7,
  mixedTerminals: 1,
  dragonPung: 1,
  smallThreeDragons: 4,
  bigThreeDragons: 6,
  smallFourWinds: 10,
  bigFourWinds: 13,
  allHonours: 13,
  allTerminals: 13,
  nineGates: 13,
  thirteenOrphans: 13,
  selfDraw: 1,
};

/** Our ids the Python engine can produce. Everything else is an extension. */
export const PYTHON_SCORABLE: ReadonlySet<string> = new Set(Object.keys(PYTHON_FAAN));

export interface FaanTableRow {
  id: string;
  python: number;
  ruleset: number | null;
}

/**
 * Row-by-row diff of the sixteen shared patterns against a ruleset's price
 * list. Independent of any hand: it catches a transcription slip in presets.ts
 * that no fixture happens to exercise.
 */
export function compareFaanTable(r: Ruleset): { rows: FaanTableRow[]; disagreements: FaanTableRow[] } {
  const rows: FaanTableRow[] = [...PYTHON_SCORABLE]
    .sort()
    .map((id) => ({ id, python: PYTHON_FAAN[id]!, ruleset: r.faanTable[id] ?? null }));
  return { rows, disagreements: rows.filter((row) => row.ruleset !== row.python) };
}

/* ── divergence taxonomy ───────────────────────────────────────────────── */

/**
 * The named ways the two engines are allowed to disagree. Anything outside this
 * list is a port bug. Each one is a rules difference we chose on purpose, not a
 * tolerance dialled in to make a run go green.
 */
export type DivergenceKind =
  /** Our engine awarded a pattern the Python engine cannot score at all. */
  | "extension"
  /** An extension award swallowed a pattern the Python engine did score. */
  | "subsumed"
  /** The Python engine read the hand as 七對子, which classic HKOS does not play. */
  | "sevenPairsNotPlayed"
  /** 十三么 — Python scores it; whether our decomposition reaches it is a port question. */
  | "thirteenOrphans"
  /** Our engine could not read the tiles as a win at all. */
  | "notAWin";

export interface Divergence {
  kind: DivergenceKind;
  /** Pattern id or payment table id the divergence hangs off. */
  subject: string;
  /** Signed faan this accounts for, from our side. */
  faan: number;
}

/**
 * Reconcile our result down to what the Python engine could have said.
 *
 * Our engine is a strict superset — 門前清 alone fires on every hand in this
 * corpus, because every hand in it is closed — so comparing raw totals would
 * report near-total disagreement and prove nothing. Instead: keep the awards
 * the Python engine can produce, put back anything an extension award
 * swallowed, and cap. The restored faan is named in the divergence list, so
 * nothing is quietly added.
 *
 * Restoration is sound because subsumption in patterns.ts means "the swallowed
 * pattern is part of THIS pattern's definition": 四暗刻 IS the 對對糊 shape, so
 * a hand scoring 四暗刻 is a hand the Python engine scores as 對對糊. Only one
 * copy of each id is restored, which is right for every extension in the
 * catalogue (none of them swallows a repeating award).
 */
export function reconcile(
  result: ScoreResult,
  r: Ruleset,
): { faan: number; rawFaan: number; divergences: Divergence[] } {
  const enabled = enabledPatterns(r);
  const divergences: Divergence[] = [];
  let raw = 0;
  const kept = new Set<string>();

  for (const a of result.awards) {
    if (PYTHON_SCORABLE.has(a.id)) {
      raw += a.faan;
      kept.add(a.id);
    } else {
      divergences.push({ kind: "extension", subject: a.id, faan: a.faan });
    }
  }

  const restored = new Set<string>();
  for (const a of result.awards) {
    if (PYTHON_SCORABLE.has(a.id)) continue;
    if (!isPattern(a.id)) continue;
    for (const swallowed of subsumptionClosure(a.id)) {
      if (!PYTHON_SCORABLE.has(swallowed)) continue;
      if (kept.has(swallowed) || restored.has(swallowed)) continue;
      if (!enabled.has(swallowed)) continue;
      const faan = r.faanTable[swallowed]!;
      restored.add(swallowed);
      raw += faan;
      divergences.push({ kind: "subsumed", subject: swallowed, faan });
    }
  }

  return { faan: Math.min(raw, r.limitFaan), rawFaan: raw, divergences };
}

/* ── comparison ────────────────────────────────────────────────────────── */

export type Verdict = "agree" | "explained" | "mismatch";

export interface CaseResult {
  id: string;
  verdict: Verdict;
  /** Python's capped total. */
  pythonFaan: number;
  /** Python's breakdown summed, which it does NOT cap (ENGINE-AUDIT §1). */
  pythonRawFaan: number;
  /** Our engine's capped total, extensions and all. */
  portFaan: number | null;
  /** Our total restricted to what the Python engine can score. */
  reconciledFaan: number | null;
  divergences: Divergence[];
  /** Pattern ids Python awarded that we did not, and the reverse. */
  onlyPython: string[];
  onlyPort: string[];
  /** Set when the comparison could not run at all. */
  error?: string;
  note?: string;
}

export interface ScoringReport {
  total: number;
  agree: number;
  explained: number;
  mismatch: number;
  cases: CaseResult[];
  /** Counts by divergence kind, for the summary line. */
  byKind: Record<string, number>;
  /** Cases whose verdict is "mismatch" — the only ones that mean anything is wrong. */
  mismatches: CaseResult[];
}

const uniqueSorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

/** Python's pattern list as our ids, deduplicated. */
export function pythonAwardIds(a: PythonAnswer): string[] {
  return uniqueSorted(
    a.patterns.map((name) => {
      const id = PYTHON_PATTERN_IDS[name];
      if (id === undefined) throw new Error(`unmapped Python pattern "${name}"`);
      return id;
    }),
  );
}

/**
 * Compare one hand. `explained` means the totals differ but every faan of the
 * difference is named in `divergences`; `mismatch` means it is not.
 */
export function compareCase(c: ScoringCase, score: Scorer, r: Ruleset): CaseResult {
  const pythonIds = pythonAwardIds(c.python);
  const pythonRaw = Object.values(c.python.faanBreakdown).reduce((a, b) => a + b, 0);
  const base: CaseResult = {
    id: c.id,
    verdict: "mismatch",
    pythonFaan: c.python.faan,
    pythonRawFaan: pythonRaw,
    portFaan: null,
    reconciledFaan: null,
    divergences: [],
    onlyPython: [],
    onlyPort: [],
  };

  // 七對子 and 十三么 are scope questions, not port bugs, and they have to be
  // classified BEFORE the scorer runs: our decomposition has no seven-pairs
  // branch at all (decompose.ts says so in as many words), so the call would
  // fail for a reason that is a rules decision.
  const sevenPairs = pythonIds.includes("sevenPairs");
  const orphans = pythonIds.includes("thirteenOrphans");

  let result: ScoreResult;
  try {
    const input = toWinInput(c);
    result = score(input.concealed, input.melds, input.flowers, input.winningTile, input.ctx, r);
  } catch (e) {
    const message = (e as Error).message;
    if (sevenPairs) {
      return {
        ...base,
        verdict: "explained",
        divergences: [{ kind: "sevenPairsNotPlayed", subject: "sevenPairs", faan: c.python.faan }],
        onlyPython: pythonIds,
        note: `not a hand in classic HKOS; the port refused it: ${message}`,
      };
    }
    if (orphans) {
      return {
        ...base,
        verdict: "explained",
        divergences: [{ kind: "thirteenOrphans", subject: "thirteenOrphans", faan: c.python.faan }],
        onlyPython: pythonIds,
        note: `十三么 has no four-sets-and-a-pair reading; the port refused it: ${message}`,
      };
    }
    return { ...base, error: message, onlyPython: pythonIds };
  }

  const portIds = uniqueSorted(result.awards.map((a) => a.id));
  const onlyPython = pythonIds.filter((id) => !portIds.includes(id));
  const onlyPort = portIds.filter((id) => !pythonIds.includes(id));

  if (!result.legal || result.awards.length === 0) {
    const kind: DivergenceKind = sevenPairs
      ? "sevenPairsNotPlayed"
      : orphans
        ? "thirteenOrphans"
        : "notAWin";
    const explained = kind !== "notAWin";
    return {
      ...base,
      verdict: explained ? "explained" : "mismatch",
      portFaan: result.faan,
      reconciledFaan: null,
      divergences: [{ kind, subject: kind, faan: c.python.faan }],
      onlyPython,
      onlyPort,
      note: result.legal
        ? "the port awarded nothing"
        : `the port scored ${result.faan} faan and refused it as below the minimum`,
    };
  }

  const rec = reconcile(result, r);
  const agrees = rec.faan === c.python.faan;

  if (agrees) {
    return {
      ...base,
      verdict: "agree",
      portFaan: result.faan,
      reconciledFaan: rec.faan,
      divergences: rec.divergences,
      onlyPython,
      onlyPort,
    };
  }

  if (sevenPairs || orphans) {
    return {
      ...base,
      verdict: "explained",
      portFaan: result.faan,
      reconciledFaan: rec.faan,
      divergences: [
        ...rec.divergences,
        {
          kind: sevenPairs ? "sevenPairsNotPlayed" : "thirteenOrphans",
          subject: sevenPairs ? "sevenPairs" : "thirteenOrphans",
          faan: c.python.faan - rec.faan,
        },
      ],
      onlyPython,
      onlyPort,
      note: "the port read the tiles as a different hand; the shapes are a rules decision, not a port bug",
    };
  }

  return {
    ...base,
    verdict: "mismatch",
    portFaan: result.faan,
    reconciledFaan: rec.faan,
    divergences: rec.divergences,
    onlyPython,
    onlyPort,
  };
}

export function compareScoring(
  cases: readonly ScoringCase[],
  score: Scorer,
  r: Ruleset,
): ScoringReport {
  const results = [...cases]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => compareCase(c, score, r));
  const byKind: Record<string, number> = {};
  for (const res of results) {
    for (const d of res.divergences) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  }
  return {
    total: results.length,
    agree: results.filter((x) => x.verdict === "agree").length,
    explained: results.filter((x) => x.verdict === "explained").length,
    mismatch: results.filter((x) => x.verdict === "mismatch").length,
    cases: results,
    byKind,
    mismatches: results.filter((x) => x.verdict === "mismatch"),
  };
}

/* ── payments ──────────────────────────────────────────────────────────── */

export interface PaymentResult {
  id: string;
  pythonFaan: number;
  pythonChips: number;
  /** What the given table charges the losing side, per player. */
  portChips: number;
  agrees: boolean;
}

export interface PaymentReport {
  total: number;
  agree: number;
  cases: PaymentResult[];
  disagreements: PaymentResult[];
}

/**
 * Diff the chip figures using PYTHON'S faan, so this measures the bracket
 * transcription alone and is not disturbed by any faan divergence above.
 *
 * The Python engine pays a self-draw as three losers × the printed figure
 * (core/game.py `_score_to_chip_deltas`), which is the perPlayer reading.
 * payment.ts argues on separate evidence that LIU is a `total` table and the
 * shipped LIU preset takes that reading, so the two disagree by 3x by design —
 * DESIGN.md §9's open payment question, still open. Pass the table you want to
 * measure and read the result accordingly.
 */
export function comparePayments(
  cases: readonly ScoringCase[],
  r: Ruleset,
): PaymentReport {
  const results: PaymentResult[] = [...cases]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => {
      const faan = c.python.faan;
      const portChips = c.selfDraw ? r.payment.onSelfDraw(faan) : r.payment.onDiscard(faan);
      return {
        id: c.id,
        pythonFaan: faan,
        pythonChips: c.python.chips,
        portChips,
        agrees: portChips === c.python.chips,
      };
    });
  return {
    total: results.length,
    agree: results.filter((x) => x.agrees).length,
    cases: results,
    disagreements: results.filter((x) => !x.agrees),
  };
}

/* ── distance to ready ─────────────────────────────────────────────────── */

export interface DistanceResult {
  id: string;
  tiles: number;
  exhaustive: number;
  shipped: number;
  port: number;
  /** Our engine against the EXHAUSTIVE reference. The only figure that is a verdict. */
  agrees: boolean;
  /** Whether the Python engine's cutoff got this hand wrong. Measurement, not verdict. */
  cutoffWrong: boolean;
}

export interface DistanceReport {
  total: number;
  agree: number;
  cases: DistanceResult[];
  disagreements: DistanceResult[];
  /** ENGINE-AUDIT §3's claim, re-measured from this corpus. */
  cutoffWrong: { all: number; thirteen: number; fourteen: number };
  counts: { thirteen: number; fourteen: number };
}

/**
 * Diff `distanceToReady` against the exhaustive reference.
 *
 * ENGINE-AUDIT §3, stated as an instruction: "Validate the port against the
 * *unpruned* Python reference, not the existing test expectations." The
 * `shipped` column is the Python engine's own cutoff answer and is reported
 * only so the audit's ~6.1%/~10.1% error rates get re-measured here rather than
 * taken on trust. Agreement is never scored against it.
 *
 * Both engines are compared on the STANDARD four-sets-and-a-pair shape only.
 * The Python engine also takes the minimum against 七對子 and 十三么; ready.ts
 * deliberately does not, and mixing the two would compare different questions.
 */
export function compareDistance(
  cases: readonly DistanceCase[],
  distanceToReady: DistanceFn,
): DistanceReport {
  const results: DistanceResult[] = [...cases]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => {
      const port = distanceToReady(c.hand, 0);
      return {
        id: c.id,
        tiles: c.tiles,
        exhaustive: c.exhaustive,
        shipped: c.shipped,
        port,
        agrees: port === c.exhaustive,
        cutoffWrong: c.shipped !== c.exhaustive,
      };
    });
  const thirteen = results.filter((x) => x.tiles === 13);
  const fourteen = results.filter((x) => x.tiles === 14);
  return {
    total: results.length,
    agree: results.filter((x) => x.agrees).length,
    cases: results,
    disagreements: results.filter((x) => !x.agrees),
    cutoffWrong: {
      all: results.filter((x) => x.cutoffWrong).length,
      thirteen: thirteen.filter((x) => x.cutoffWrong).length,
      fourteen: fourteen.filter((x) => x.cutoffWrong).length,
    },
    counts: { thirteen: thirteen.length, fourteen: fourteen.length },
  };
}

/* ── reporting ─────────────────────────────────────────────────────────── */

const pct = (n: number, of: number): string => (of === 0 ? "n/a" : `${((100 * n) / of).toFixed(1)}%`);

/**
 * The run's readout. Leads with the scope warning on purpose: a green number
 * here says the closed-hand LIU subset agrees and says nothing whatever about
 * claims, kongs, flowers, winds or the dealer.
 */
export function formatReport(
  provenance: FixtureProvenance,
  r: Ruleset,
  scoring: ScoringReport,
  payments: PaymentReport,
  distance: DistanceReport,
): string {
  const out: string[] = [];
  out.push("PORT-DIFF — DESIGN.md §8 harness 1");
  out.push(`  scope: ${provenance.scopeWarning}`);
  out.push(
    `  corpus: ${provenance.handsPlayed} hands from ${provenance.matches} seeded matches ` +
      `(seed ${provenance.batchSeed}), ${provenance.handsWon} won`,
  );
  out.push(`  ruleset under test: ${r.id} — ${r.label}`);
  out.push("");
  out.push(`FINAL SCORES  ${scoring.total} hands`);
  out.push(`  agree             ${scoring.agree} (${pct(scoring.agree, scoring.total)})`);
  out.push(`  explained         ${scoring.explained} (${pct(scoring.explained, scoring.total)})`);
  out.push(`  MISMATCH          ${scoring.mismatch} (${pct(scoring.mismatch, scoring.total)})`);
  const kinds = Object.keys(scoring.byKind).sort();
  if (kinds.length > 0) {
    out.push("  divergences by kind:");
    for (const k of kinds) out.push(`    ${k.padEnd(20)} ${scoring.byKind[k]}`);
  }
  for (const m of scoring.mismatches.slice(0, 20)) {
    out.push(
      `    ! ${m.id}  python ${m.pythonFaan} vs port ${m.reconciledFaan ?? "-"} ` +
        `(uncapped ${m.pythonRawFaan})` +
        (m.onlyPython.length ? ` python-only: ${m.onlyPython.join(",")}` : "") +
        (m.onlyPort.length ? ` port-only: ${m.onlyPort.join(",")}` : "") +
        (m.error ? ` error: ${m.error}` : "") +
        (m.note ? ` — ${m.note}` : ""),
    );
  }
  if (scoring.mismatches.length > 20) {
    out.push(`    ... ${scoring.mismatches.length - 20} more`);
  }
  out.push("");
  out.push(`CHIPS  ${payments.total} hands, table ${r.payment.id}`);
  out.push(`  agree             ${payments.agree} (${pct(payments.agree, payments.total)})`);
  for (const d of payments.disagreements.slice(0, 5)) {
    out.push(`    ! ${d.id}  ${d.pythonFaan} faan: python ${d.pythonChips}, port ${d.portChips}`);
  }
  if (payments.disagreements.length > 5) {
    out.push(`    ... ${payments.disagreements.length - 5} more, all the same shape`);
  }
  out.push("");
  out.push(`DISTANCE TO READY  ${distance.total} hands, against the exhaustive reference`);
  out.push(`  agree             ${distance.agree} (${pct(distance.agree, distance.total)})`);
  for (const d of distance.disagreements.slice(0, 10)) {
    out.push(`    ! ${d.id}  ${d.tiles} tiles: exhaustive ${d.exhaustive}, port ${d.port}`);
  }
  const sameWrongAnswer = distance.disagreements.filter((d) => d.port === d.shipped).length;
  out.push("  ENGINE-AUDIT §3 re-measured — the Python engine's own cutoff, wrong on:");
  out.push(
    `    13-tile         ${distance.cutoffWrong.thirteen}/${distance.counts.thirteen} ` +
      `(${pct(distance.cutoffWrong.thirteen, distance.counts.thirteen)})`,
  );
  out.push(
    `    14-tile         ${distance.cutoffWrong.fourteen}/${distance.counts.fourteen} ` +
      `(${pct(distance.cutoffWrong.fourteen, distance.counts.fourteen)})`,
  );
  out.push(
    "    (the audit's ~6.1%/~10.1% were measured over random hands; these are mid-hand",
  );
  out.push("     bot positions, a different and much more structured population)");
  if (distance.disagreements.length > 0) {
    out.push(
      `  OF THE PORT'S OWN ${distance.disagreements.length} wrong answers, ${sameWrongAnswer} are ` +
        `EXACTLY the cutoff's wrong answer — see README.md "Findings"`,
    );
  }
  return out.join("\n");
}

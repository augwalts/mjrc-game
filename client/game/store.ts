/**
 * The local record — IndexedDB, database `mjrc-game`.
 *
 * WHY NOT localStorage: a one-wind match is ~187 KB of event log plus ~24 KB of
 * action log. localStorage caps around 5 MB, which is about 24 games. That is a
 * wall, not a tuning problem, and we are collecting data from friends over
 * weeks. IndexedDB gives hundreds of MB, so everything is stored uncompressed
 * and nothing has to be thrown away or summarised early.
 *
 * WHAT IS STORED, and why both logs:
 *   events   the engine's OUTPUTS — every discard, claim, score, chip delta.
 *            This is what the stats pages read.
 *   actions  the INPUTS — what each player chose, bots included. Replaying
 *            these through the reducer regenerates `events` exactly, because
 *            the reducer is pure. It is the source; `events` is a cache of it.
 *
 * Keeping both means a game recorded today still replays correctly after the
 * bots are retrained — the bots' *decisions* are on record, so history cannot
 * be silently rewritten by a later model. §5.5 of the protocol makes the same
 * argument for `engineVersion`.
 *
 * The store is also the UPLOAD QUEUE. The owner wants the data on the server,
 * not on the device (2026-08-31), so every record carries `uploadedAt` and
 * `sync.ts` drains whatever lacks it. Local-first rather than post-directly is
 * deliberate: a friend on a flaky connection must not lose the match they just
 * played, and the server being down must not stop the game.
 *
 * TWO HARD RULES for callers:
 *   1. Never await a store call inside the turn loop. Every write here is
 *      fire-and-forget; a slow disk must not stall a discard.
 *   2. Every entry point degrades to a no-op. Private browsing, a blocked
 *      origin, a quota refusal — the game must still be playable, just
 *      unrecorded. `available()` reports whether it took.
 */

export interface PlayerRec {
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
}

/** One graded human decision. Derived from `events`, so droppable and rebuildable. */
export interface MoveRec {
  matchId: string;
  hand: number;
  turn: number;
  kind: "discard" | "claim" | "pass" | "kong";
  /** What you did — a tile id for a discard, a claim kind otherwise. */
  played: string;
  /** What the champion would have done in the same seat. */
  enginePick: string;
  /** Cost of your choice in the engine's own scoring units. 0 = you matched it. */
  gap: number;
  /**
   * How much better the engine's first choice was than its second. A large
   * value means the position was a real decision; near zero means it was
   * forced, and agreeing with the engine there says nothing about you.
   */
  top1MinusTop2: number;
  reason: string;
}

export interface MatchRec {
  id: string;
  /** When the server took it. Undefined until then — sync.ts drains on that. */
  uploadedAt?: number;
  playerId: string;
  playerName: string;
  rounds: number;
  rulesetId: string;
  /** The three bot profile keys, seats 1-3. */
  seats: string[];
  tableId: string;
  seed: number;
  recorded: boolean;
  /** True when the player quit mid-match. A forfeit is data too. */
  abandoned: boolean;
  startedAt: number;
  finishedAt: number | null;
  chips: number[];
  hands: number;
  /** Hands YOU won, self-drew, and fed to somebody else. */
  won: number;
  selfDrawn: number;
  fed: number;
  drawnHands: number;
  /** Per seat, so bot-vs-human strength is answerable: wins and chips by seat. */
  seatWins: number[];
  /** % of decisions where you played the engine's top choice. */
  matchRate: number | null;
  meanGap: number | null;
  movesGraded: number;
  events: unknown[];
  actions: unknown[];
}

export interface FeedbackRec {
  id: string;
  uploadedAt?: number;
  matchId: string | null;
  hand: number | null;
  text: string;
  createdAt: number;
  /** Enough context to know what they were looking at without asking. */
  context: Record<string, unknown>;
}

const DB_NAME = "mjrc-game";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;
let unavailableReason = "";

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      unavailableReason = String(e);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("player")) db.createObjectStore("player", { keyPath: "id" });
      if (!db.objectStoreNames.contains("match")) {
        const m = db.createObjectStore("match", { keyPath: "id" });
        m.createIndex("playerId", "playerId");
        m.createIndex("finishedAt", "finishedAt");
      }
      if (!db.objectStoreNames.contains("move")) {
        const mv = db.createObjectStore("move", { autoIncrement: true });
        mv.createIndex("matchId", "matchId");
      }
      if (!db.objectStoreNames.contains("feedback")) {
        db.createObjectStore("feedback", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { unavailableReason = String(req.error); resolve(null); };
    req.onblocked = () => { unavailableReason = "another tab holds an older version open"; resolve(null); };
  });
  return dbPromise;
}

/** Whether the store took. Null until the first call resolves. */
export async function available(): Promise<{ ok: boolean; why: string }> {
  const db = await open();
  return { ok: db !== null, why: unavailableReason };
}

async function tx<T>(store: string, mode: IDBTransactionMode,
                     run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const t = db.transaction(store, mode);
      const req = run(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);      // a failed write must not throw into the game
      t.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function all<T>(store: string): Promise<T[]> {
  const r = await tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
  return r ?? [];
}

/* ── player ────────────────────────────────────────────────────────────── */

/**
 * There is exactly one player per device, keyed by a generated uuid rather than
 * by the name. Two friends both called "Dave" must not merge, and a player who
 * renames themselves must not fork into two records.
 */
export async function getPlayer(): Promise<PlayerRec | null> {
  const rows = await all<PlayerRec>("player");
  return rows[0] ?? null;
}

export async function setPlayerName(name: string): Promise<PlayerRec> {
  const now = Date.now();
  const existing = await getPlayer();
  const rec: PlayerRec = existing
    ? { ...existing, name, lastSeen: now }
    : { id: crypto.randomUUID(), name, firstSeen: now, lastSeen: now };
  await tx("player", "readwrite", (s) => s.put(rec));
  return rec;
}

/* ── matches and moves ─────────────────────────────────────────────────── */

/** Upsert. Called at each hand end so a crash mid-match still keeps the hands played. */
export async function putMatch(m: MatchRec): Promise<void> {
  await tx("match", "readwrite", (s) => s.put(m));
}

export async function putMoves(moves: MoveRec[]): Promise<void> {
  if (moves.length === 0) return;
  const db = await open();
  if (!db) return;
  try {
    const t = db.transaction("move", "readwrite");
    const s = t.objectStore("move");
    for (const mv of moves) s.put(mv);
  } catch { /* unrecorded, not fatal */ }
}

export const allMatches = (): Promise<MatchRec[]> => all<MatchRec>("match");

export async function movesFor(matchId: string): Promise<MoveRec[]> {
  const db = await open();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const req = db.transaction("move", "readonly").objectStore("move")
        .index("matchId").getAll(matchId);
      req.onsuccess = () => resolve(req.result as MoveRec[]);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

/* ── feedback ──────────────────────────────────────────────────────────── */

export async function putFeedback(f: FeedbackRec): Promise<void> {
  await tx("feedback", "readwrite", (s) => s.put(f));
}

export const allFeedback = (): Promise<FeedbackRec[]> => all<FeedbackRec>("feedback");

/* ── export ────────────────────────────────────────────────────────────── */

/**
 * Everything, as one JSON blob. Until there is a server this is how a tester's
 * data reaches us, so it has to be complete — matches, moves and feedback, not
 * a summary of them.
 */
export async function exportAll(): Promise<string> {
  const [player, matches, feedback] = await Promise.all([
    getPlayer(), allMatches(), allFeedback(),
  ]);
  const moves = await all<MoveRec>("move");
  return JSON.stringify({
    exportedAt: Date.now(), schema: DB_VERSION, player, matches, moves, feedback,
  });
}

/** Rough bytes held, so the stats page can say so rather than guess. */
export async function usage(): Promise<{ matches: number; approxBytes: number }> {
  const matches = await allMatches();
  let bytes = 0;
  for (const m of matches) bytes += JSON.stringify(m).length;
  return { matches: matches.length, approxBytes: bytes };
}

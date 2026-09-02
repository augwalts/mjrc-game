-- MJRC game platform — D1 schema for the stateless Worker: identity, match
-- records, per-hand results, and rating. Hong Kong Old Style only; the naming
-- rules in ../TERMINOLOGY.md apply to column names and enum values too.
--
-- Implements: DESIGN.md §5.4 (platform services — plain HTTP, no Durable
-- Object, "queryable across all tables from day one"), §5.5 (event log schema
-- and pinned engine version), §4 (ruleset and match structure), §3 (provisional
-- Elo at P0).
--
-- Rationale for every table, the migration procedure, and the seam to the
-- Almanac's accounts (../../ACCOUNTS-BUILD-SPEC.md §8.2) live in ./README.md.
-- Read that before changing anything here.
--
-- applied through: 0001
--
-- This file is BOTH the authoritative full schema and migration 0001. A fresh
-- database is created with:
--   wrangler d1 execute mjrc-game --file worker/schema.sql --remote
-- Every later change ships as an additive migration under worker/migrations/
-- AND is folded back into this file in the same commit; the marker above says
-- how far this file has been folded, so drift is visible in review.
--
-- Conventions, deliberately identical to the Almanac's schema
-- (mjrc-app/web/migrations/0001-0006) so the two read as one codebase:
--   * timestamps are TEXT, ISO-8601 UTC — '2026-08-26T12:34:56.789Z'
--   * booleans are INTEGER 0/1
--   * SQL identifiers and enum values are snake_case
--   * app-generated ids are Crockford base32, like the Almanac's users.id
--   * JSON columns carry the engine's TS types verbatim, so the KEYS inside
--     them are camelCase (engine/src/types.ts). Never translate on the way in
--     and out — the point of a JSON column is that it round-trips.
--   * plain tables, not STRICT, so migrations stay dialect-identical to the
--     Almanac's and can be read side by side without a translation step.
--
-- Regenerable vs stateful (human-data-ingestion.md §2 — stated at the top of
-- every schema by house rule). Almost everything here is written once by the
-- server and never touched again: a match record is a statement about what
-- happened, and nothing may overwrite it. The exceptions, and the only fields a
-- rebuild job may recompute in place, are the derived projections — every one
-- of them a fold over a canonical table in this same database:
--   REGENERABLE  players.rating / rating_games / rating_season  (← rating_history)
--                matches.hand_count                              (← hands)
--                match_players.hands_won / self_draws / deal_ins (← hands)
--                hands.winner_player_id / win_from_player_id     (← match_players)
--   STATEFUL     everything else, including every column of `hands` that
--                describes the hand, and every rating_history row.
-- A `hands` row is corrected by voiding and re-deriving from the R2 log, never
-- by an UPDATE that leaves no trace.
--
-- Closed vocabularies (matches.status, hands.outcome, ...) are enforced in
-- code, NOT by CHECK constraints. SQLite cannot drop a CHECK without rebuilding
-- the table, so a CHECK on a vocabulary turns "add one enum value" into a data
-- migration. This is the same discipline as KNOWN_EVENT_TYPES in the Almanac's
-- _lib/shared.ts and admin_audit.action (ACCOUNTS-BUILD-SPEC.md §5.7): an
-- unknown value is a bug, caught at the boundary. The CHECKs that do exist
-- below are structural invariants of mahjong itself, not vocabularies.

-- ─────────────────────────────────────────────────────────────────────────────
-- rulesets — a ruleset is DATA, and history points at the exact bytes it was
-- played under (DESIGN.md §4).
--
-- Storing only matches.ruleset_id would mean that editing rulesets/*.json — a
-- faan value, the self-draw settlement — silently rewrites the meaning of every
-- past match. That is the same failure DESIGN.md §5.5 pins engine_version to
-- avoid, and it applies with equal force to the ruleset. So: the resolved
-- config is archived once per content hash, and matches reference the hash.
--
-- `config` is the serializable part of the Ruleset type (engine/src/types.ts):
-- faan table, payment brackets, settlement rule, limits, feature flags. The
-- PaymentTable's onDiscard/onSelfDraw are CODE selected by payment_id, not data
-- — the archived row records which implementation was in force, not the source.
--
-- The 3-faan minimum and 13-faan limit are columns here rather than constants
-- anywhere, precisely because the LIU preset and future house rules change them.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE rulesets (
  hash                 TEXT PRIMARY KEY,   -- sha256 of `config`, canonically serialized
  ruleset_id           TEXT NOT NULL,      -- Ruleset.id, e.g. 'hk-old-style'
  label                TEXT NOT NULL,      -- Ruleset.label, display string
  minimum_faan         INTEGER NOT NULL,   -- 3 for canonical HKOS
  limit_faan           INTEGER NOT NULL,   -- 13 爆棚 for canonical HKOS
  payment_id           TEXT NOT NULL,      -- PaymentTable.id — selects the code path
  self_draw_settlement TEXT NOT NULL,      -- per_player | total (SelfDrawSettlement)
  use_flowers          INTEGER NOT NULL,   -- 0/1
  config               TEXT NOT NULL,      -- JSON, the full serializable Ruleset
  first_seen_at        TEXT NOT NULL
);

-- The lobby needs "what presets exist" ordered by most recently used; the id is
-- not unique because each edit of a preset produces a new hash under the same id.
CREATE INDEX idx_rulesets_id ON rulesets(ruleset_id, first_seen_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- players — one row per identity that can hold a seat (DESIGN.md §5.4:
-- "Identity + rating ... lives outside any DO from day 1").
--
-- P0 identity is a device token; P1 adds passkeys and, later, the MJRC account.
-- The reason none of that appears as a column here: CREDENTIALS ARE ROWS, in
-- player_credentials. A `device_token_hash` column would have to be widened,
-- then made nullable, then ignored, then dropped when a second credential kind
-- lands — and a player with a phone and a laptop cannot be expressed at all.
-- With credentials in their own table, "add passkeys" is one INSERT path and
-- zero changes to this table. That is the migration-not-a-rewrite property the
-- brief asks for.
--
-- Bots are players. DESIGN.md §6: "a bot is a player whose input arrives from a
-- function call instead of a socket" — same action API, same legality checks.
-- Making them real rows keeps match_players.player_id NOT NULL and keeps the
-- foreign key honest. Every human-facing aggregate filters kind = 'human'.
-- One row per bot POLICY VERSION, not one row per bot forever: a policy upgrade
-- is a different player, and gate 3 (bot-vs-human parity, DESIGN.md §3) is a
-- GROUP BY over exactly that distinction. Smearing v2 and v3 into one row would
-- make the gate unmeasurable.
--
-- Soft delete only, and scrub in place — the same rule the Almanac states as
-- invariant I4 (ACCOUNTS-BUILD-SPEC.md §3, §9.3). Hard-deleting a player would
-- destroy match history that three other people are also in. Their history is
-- not this player's to delete.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE players (
  id             TEXT PRIMARY KEY,           -- app-generated, Crockford base32
  kind           TEXT NOT NULL DEFAULT 'human', -- human | bot
  display_name   TEXT NOT NULL,              -- freeform, <= 40 chars. NOT the Almanac handle.
  bot_policy     TEXT,                       -- bots only: policy id + version, e.g. 'steer-v3'

  -- Rating cache. rating_history is canonical; these three are a derived
  -- projection kept here so the leaderboard and the results screen are one
  -- indexed read instead of a per-player scan of the history. Regenerable at
  -- any time by folding rating_history — canonical/derived layering per
  -- AI/standards/software-patterns/human-data-ingestion.md §1.
  rating         REAL,                       -- null until the first rated match settles
  rating_games   INTEGER NOT NULL DEFAULT 0, -- rated matches counted into `rating`
  rating_season  TEXT,                       -- which season `rating` belongs to; see rating_history

  -- ── the Almanac seam (ACCOUNTS-BUILD-SPEC.md §8.2) ────────────────────────
  -- users.id in the SEPARATE mjrc-scoring database. No FOREIGN KEY: D1 has no
  -- cross-database references and none is wanted — see README §"The Almanac
  -- seam". Null for every P0 player and for every bot.
  --
  -- No cached handle or display name from that account. Handles are changeable
  -- (D7) and a cached copy goes stale silently; the game resolves them at read
  -- time. A cached copy is also PII sitting in a second database for no reason.
  almanac_user_id     TEXT,
  almanac_link_source TEXT,                  -- sign_in | admin — see README
  almanac_linked_at   TEXT,

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  deleted_at     TEXT                        -- soft delete; scrub in place, never DELETE
);

-- Leaderboard and "who is rated at all": humans, alive, with a rating. Partial
-- so the bot rows and the tombstones never enter the index.
CREATE INDEX idx_players_rating
  ON players(rating_season, rating DESC)
  WHERE kind = 'human' AND deleted_at IS NULL AND rating IS NOT NULL;

-- Resolving an Almanac account to its game identity, and the reverse. Partial
-- because the column is null for almost every row at P0.
CREATE INDEX idx_players_almanac
  ON players(almanac_user_id)
  WHERE almanac_user_id IS NOT NULL;

-- Ops: recently active players, and the invite-only roster view.
CREATE INDEX idx_players_last_seen ON players(last_seen_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- player_credentials — every way a person proves they are a given player.
--
-- P0: kind = 'device'. The client mints a random token, keeps it, and presents
-- it on each HTTP request; only its SHA-256 lands here. Same pattern as the
-- Almanac's games.edit_token_hash and auth_sessions.id — a stolen database does
-- not yield a usable credential.
--
-- P1: kind = 'passkey'. public_key and sign_count are the WebAuthn fields; they
-- are null for device tokens. Adding passkeys touches this table's DATA, not its
-- shape, and touches `players` not at all.
--
-- Revocation is a column, not a DELETE, so "this phone was lost" stays
-- answerable and a revoked credential id can never be reissued.
--
-- Deliberately NOT here: the one-time seat token from the lobby handoff
-- (DESIGN.md §5.3, `{table_id, seat_token, match_uuid}`). It lives for seconds,
-- has exactly one consumer, and that consumer is the Table DO — putting it in
-- D1 buys a round trip and a cleanup job for nothing.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE player_credentials (
  id           TEXT PRIMARY KEY,   -- sha256 of the device token, or the passkey credential id
  player_id    TEXT NOT NULL REFERENCES players(id),
  kind         TEXT NOT NULL,      -- device | passkey
  label        TEXT,               -- user-typed, e.g. "Ah Ming's phone"
  public_key   TEXT,               -- passkey only: COSE key, base64url
  sign_count   INTEGER NOT NULL DEFAULT 0, -- passkey only: WebAuthn replay counter
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  revoked_at   TEXT
);

-- "List my devices", and the revocation sweep. Partial: a revoked credential is
-- read only by the audit view, never by the hot path.
CREATE INDEX idx_player_credentials_player
  ON player_credentials(player_id)
  WHERE revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- matches — one row per match. A match is many hands (DESIGN.md §4: the ranked
-- default is one wind round 東圈, 4 rotations plus repeats).
--
-- engine_version, ruleset_hash and log_schema_version are the three pins that
-- make gate 2 ("100% of completed games reconstruct in the viewer", DESIGN.md
-- §3) survive a bugfix. Replay is re-execution, so a scoring fix must not
-- silently rewrite history: an old match replays through the engine build and
-- ruleset bytes recorded here.
--
-- log_key is stored rather than derived from the id because the key convention
-- WILL change — a second serializer, a re-shard, a lifecycle policy — and every
-- old row must keep pointing at where its blob actually is.
--
-- log_key stays NULL until the Table DO's outbox confirms the R2 write
-- (DESIGN.md §5.3). NULL after status = 'complete' is therefore the exact
-- definition of a lost log, which is what idx_matches_missing_log finds.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE matches (
  id                  TEXT PRIMARY KEY,      -- match_uuid; on every log record (§5.5)
  status              TEXT NOT NULL,         -- running | complete | abandoned
  match_format        TEXT NOT NULL,         -- east | full | custom (DESIGN.md §4)

  ruleset_hash        TEXT NOT NULL REFERENCES rulesets(hash),
  ruleset_id          TEXT NOT NULL,         -- denormalized from rulesets for filtering
  engine_version      TEXT NOT NULL,         -- pinned; replay loads this build (§5.5)
  log_schema_version  INTEGER NOT NULL,      -- the `v` on every event record (§5.5)

  -- Where this match came from. Both nullable and both meaning different things,
  -- which is why they are two columns:
  --   room_code — an MJRC room (rooms.code in the Almanac's mjrc-scoring DB).
  --               Opaque cross-database reference; no FK is possible. Null for
  --               ad-hoc games.
  --   join_code — the P0 lobby's friends-join-by-code string (DESIGN.md §5.3).
  --               Null for matches created any other way. Not a credential: it
  --               is spent at join time, and the seat token is the real gate.
  room_code           TEXT,
  join_code           TEXT,

  -- Rating eligibility, decided at match end and frozen. Not derived at read
  -- time: the policy for what counts as rated will change, and a leaderboard
  -- that silently restates last month's results is worse than a stale one.
  rated               INTEGER NOT NULL DEFAULT 0,
  bot_seats           INTEGER NOT NULL DEFAULT 0,  -- 0-4; P0 alpha is bot-backed

  -- Derived counters, maintained as hands land so the match list does not fan
  -- out a query per row. Regenerable from `hands`.
  hand_count          INTEGER NOT NULL DEFAULT 0,

  -- ── the lobby (PVP-LOBBY-PROPOSAL-2026-09-02.md §7.1) ─────────────────────
  -- access/mode/lobby_status are the lobby's own vocabulary, distinct from
  -- `status` above (running | complete | abandoned, the outbox's vocabulary) —
  -- lobby_status tracks whether the TABLE has humans to seat, not whether the
  -- MATCH RECORD is settled, and the two finish at different moments (a table
  -- goes lobby_status='playing' the instant clocks start; status stays
  -- 'running' until the outbox drains).
  access              TEXT NOT NULL DEFAULT 'open',    -- open | private (code required)
  mode                TEXT NOT NULL DEFAULT 'casual',  -- casual | ranked
  lobby_status        TEXT NOT NULL DEFAULT 'waiting', -- waiting | playing | done
  -- Written by the table object on every deal (afterCommit/advance), so the
  -- lobby can show "hand 3 of ~8" without opening a socket. The denominator is
  -- `hands_base`, not this column — repeats push the numerator past it.
  current_hand        INTEGER NOT NULL DEFAULT 0,
  -- The base dealership count the lobby divides by: 4 for one wind round
  -- (east), 16 for a full match (four wind rounds). Set from `matchFormat` at
  -- creation; a match with repeats plays more hands than this, on purpose.
  hands_base           INTEGER NOT NULL DEFAULT 4,
  -- The four seat specs exactly as the creator submitted them (§7.2 POST
  -- /api/tables `seats`), JSON array of { kind: 'human' | 'bot', bot?: key }.
  -- Canonical for two things the running table cannot answer on its own once a
  -- seat has changed hands: what a still-open seat WOULD be filled with by
  -- /fill, and what a bot seat's catalogue key was — the header's `bot:<key>`
  -- playerId says the same thing but only for seats a table has opened.
  seat_plan           TEXT NOT NULL DEFAULT '[]',
  -- Shuffle the player->seat mapping at start (§6, decision 3). 0/1.
  randomize_seats     INTEGER NOT NULL DEFAULT 0,
  -- The creator's player id. Authorises /start and lets the lobby list "hosted
  -- by". Nullable: rows written before this column existed have none.
  created_by          TEXT,

  -- The omniscient event log blob in R2 (server-only serializer, §5.5).
  log_key             TEXT,                  -- null until the outbox confirms the write
  log_bytes           INTEGER,               -- truncated-write detection
  log_sha256          TEXT,                  -- integrity check for the research corpus

  started_at          TEXT NOT NULL,
  ended_at            TEXT                   -- null while running or abandoned mid-flight
);

-- Match list / history, newest first. The single most common read on the site.
CREATE INDEX idx_matches_started ON matches(started_at DESC);

-- Room pages aggregate their matches. Partial: most matches have no room.
CREATE INDEX idx_matches_room
  ON matches(room_code, started_at DESC)
  WHERE room_code IS NOT NULL;

-- Ops: what is live right now, and reaping tables that never ended.
CREATE INDEX idx_matches_running
  ON matches(started_at)
  WHERE status = 'running';

-- Gate 2's alarm. A finished match with no log blob is a data-loss incident and
-- has to be findable in one query, not a scan. Partial, so in the healthy case
-- this index is empty and free.
CREATE INDEX idx_matches_missing_log
  ON matches(ended_at)
  WHERE log_key IS NULL AND status = 'complete';

-- Corpus queries slice by engine build when a scoring fix lands.
CREATE INDEX idx_matches_engine ON matches(engine_version, started_at);

-- The lobby's "open tables" list: waiting or playing, newest first. Partial so
-- a lobby with thousands of finished matches never touches this index for them.
CREATE INDEX idx_matches_lobby_open
  ON matches(lobby_status, started_at DESC)
  WHERE lobby_status IN ('waiting', 'playing');

-- The lobby's "recent results" strip: last 5 done, newest first.
CREATE INDEX idx_matches_lobby_done
  ON matches(lobby_status, ended_at DESC)
  WHERE lobby_status = 'done';

-- ─────────────────────────────────────────────────────────────────────────────
-- match_players — the four seats of a match.
--
-- Seat is physical table position and never moves; it is what `actor` means in
-- the event log. Wind rotates with the dealer every hand, so `wind` here is the
-- seat's wind at the FIRST deal — the thing that fixes the rotation order. A
-- given hand's seat wind derives from hands.dealer_seat, and is not stored four
-- times per hand.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE match_players (
  match_id      TEXT NOT NULL REFERENCES matches(id),
  seat          INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
  player_id     TEXT NOT NULL REFERENCES players(id),
  wind          INTEGER NOT NULL CHECK (wind BETWEEN 0 AND 3), -- 0東 1南 2西 3北, at the first deal

  final_chips   INTEGER NOT NULL DEFAULT 0,   -- chips at match end; every seat starts equal per ruleset
  faan_won      INTEGER NOT NULL DEFAULT 0,   -- capped faan summed over hands this seat won
  place         INTEGER CHECK (place BETWEEN 1 AND 4), -- null until complete; ties share the lower place

  -- Derived counters, regenerable from `hands`. Present because they are gate 3's
  -- measured behaviours (DESIGN.md §3: call rate, mean winning faan, deal-in
  -- rate, draw rate) and the results screen shows all of them at once.
  hands_won     INTEGER NOT NULL DEFAULT 0,
  self_draws    INTEGER NOT NULL DEFAULT 0,   -- 自摸 wins, a subset of hands_won
  deal_ins      INTEGER NOT NULL DEFAULT 0,   -- hands where this seat discarded the winning tile

  -- Hands this seat was played by a bot after a disconnect (DESIGN.md §5.3
  -- grace → bot takeover). Material to whether the match should have been rated,
  -- and to reading the seat's stats honestly. Not inferable from the D1 rows.
  bot_takeover_hands INTEGER NOT NULL DEFAULT 0,

  -- "kind/version" as the seat's client presented itself on join (protocol
  -- ClientInfo): web/abc1234, ios/1.0.3, headless/smoke. NULL = unknown or a
  -- bot. So web and app behaviour stay comparable later.
  client        TEXT,

  -- Move grading against the champion bot (worker/src/table.ts BotBrain.grade),
  -- tallied live in the Table DO and written once at match end alongside the
  -- rest of this close-out. moves_graded counts every gradable decision this
  -- seat made (a win is never gradable); moves_matched is how many equalled
  -- the champion's pick; gap_sum is the summed score gap on the ones that did
  -- not (0 for a matched discard, roughly 1 per mismatched claim/kong — see
  -- BotBrain.grade's doc comment). The UI (web only, by owner's ruling) reads
  -- moves_matched / moves_graded as an agreement rate.
  moves_graded  INTEGER NOT NULL DEFAULT 0,
  moves_matched INTEGER NOT NULL DEFAULT 0,
  gap_sum       REAL NOT NULL DEFAULT 0,

  -- Lobby-facing "is this seat's human here right now", updated by the table
  -- object on socket join/close (PVP-LOBBY-PROPOSAL-2026-09-02.md §7.2's
  -- `seats[].connected`). A cache, not canonical — the table object's own
  -- presence map is truth for the live match; this column exists so the
  -- STATELESS lobby query can render it without asking the DO. 0 for a bot
  -- seat always (bots do not "connect").
  connected     INTEGER NOT NULL DEFAULT 0,

  -- Provisional Elo (DESIGN.md §3). Null on an unrated match. Stored on the
  -- match, not only in rating_history, because the results screen renders the
  -- delta and that must be one read.
  rating_before REAL,
  rating_after  REAL,

  PRIMARY KEY (match_id, seat),
  -- One person cannot hold two seats of the same match. Without this a client
  -- retry that re-seats a reconnecting player silently produces a five-seat match.
  UNIQUE (match_id, player_id)
);

-- "My matches". Ordering by date needs the join to matches; a covering
-- started_at copy here was rejected as a second source of truth for a screen
-- that already loads the match rows.
CREATE INDEX idx_match_players_player ON match_players(player_id, match_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- hands — one row per hand within a match. THE review and stats surface.
--
-- This table exists so that no screen has to fetch and parse the R2 log blob to
-- answer "what happened". The blob is the corpus and the replay source; this is
-- the index over it. If a stats screen ever needs the blob for a number that
-- belongs on a scoreboard, that number belongs in a column here instead.
--
-- (match_id, hand_index) mirrors the Almanac's events PK (session_code, seq) on
-- purpose: same shape, same ordering guarantee, same mental model.
--
-- winner_player_id / win_from_player_id are denormalized from match_players.
-- They turn every per-player stat — mean winning faan, deal-in count — into a
-- single indexed read instead of a join through match_players for each one.
-- Derived from the seat columns, which stay canonical.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE hands (
  match_id       TEXT NOT NULL REFERENCES matches(id),
  hand_index     INTEGER NOT NULL,            -- 0-based; equals hand_idx in the log (§5.5)

  -- Match structure at deal time (DESIGN.md §4).
  dealer_seat    INTEGER NOT NULL CHECK (dealer_seat BETWEEN 0 AND 3),
  round_wind     INTEGER NOT NULL CHECK (round_wind BETWEEN 0 AND 3), -- 圈 prevailing wind
  dealer_repeat  INTEGER NOT NULL DEFAULT 0,  -- 連莊 count: repeats on a dealer win and on 流局

  -- uint32 passed to prng(). buildWall(seed) reproduces this hand's wall
  -- exactly (engine/src/wall.ts), so a hand is replayable from this row plus
  -- the actions in the log — and a golden case can be cut straight from a
  -- reported hand without shipping the whole blob.
  seed           INTEGER NOT NULL,

  outcome        TEXT NOT NULL,               -- win | exhaustive_draw | abandoned (code-enforced)

  -- Win detail. All null on a draw.
  winner_seat        INTEGER CHECK (winner_seat BETWEEN 0 AND 3),
  winner_player_id   TEXT REFERENCES players(id),  -- denormalized; see header
  win_from_seat      INTEGER CHECK (win_from_seat BETWEEN 0 AND 3), -- discarder; null on 自摸
  win_from_player_id TEXT REFERENCES players(id),  -- denormalized; see header
  winning_tile       INTEGER,                 -- TileId 0-41 (engine/src/types.ts)
  self_draw          INTEGER NOT NULL DEFAULT 0, -- 自摸 0/1
  robbed_kong        INTEGER NOT NULL DEFAULT 0, -- 搶槓 0/1
  on_kong_replacement INTEGER NOT NULL DEFAULT 0, -- 槓上開花 0/1

  -- Scoring, mirroring ScoreResult (engine/src/types.ts). raw_faan is the
  -- uncapped total; faan is what was paid. Both, because the review screen says
  -- "15 faan, paid at the 13 爆棚 limit" and that is a teaching moment, not a
  -- rounding detail.
  faan           INTEGER NOT NULL DEFAULT 0,
  raw_faan       INTEGER NOT NULL DEFAULT 0,
  capped         INTEGER NOT NULL DEFAULT 0,  -- 0/1, the 爆棚 limit applied
  -- JSON [{ id, faan, subsumes? }, ...] — FaanAward[] verbatim, camelCase keys.
  -- This is the faan breakdown the results screen renders. Stable pattern ids,
  -- never display strings: the Cantonese and English labels are a client
  -- concern (TERMINOLOGY.md house style) and must stay retranslatable.
  awards         TEXT NOT NULL DEFAULT '[]',

  -- Chip deltas, one column per seat, always four, summing to zero. A child
  -- table would triple the row count for a fixed-width fact and would lose the
  -- CHECK below — which catches a settlement bug at write time, on the row,
  -- before it reaches a rating. If a house ruleset ever introduces a non
  -- zero-sum pot, this CHECK is the deliberate blocker: see README §"Rebuilding
  -- a table" before removing it.
  delta_seat0    INTEGER NOT NULL DEFAULT 0,
  delta_seat1    INTEGER NOT NULL DEFAULT 0,
  delta_seat2    INTEGER NOT NULL DEFAULT 0,
  delta_seat3    INTEGER NOT NULL DEFAULT 0,

  -- Wins refused for being under the ruleset minimum (DESIGN.md §5.2 — these
  -- are emitted as visible events, they are the teaching moment). Counted here
  -- because "how often do people reach for a 2-faan hand" is a headline
  -- teaching metric and gate 4 mines it for WWYD material.
  refused_wins   INTEGER NOT NULL DEFAULT 0,

  wall_remaining INTEGER,                     -- live tiles left at hand end; 0 on 流局
  event_count    INTEGER NOT NULL DEFAULT 0,

  -- Where this hand sits in the match's log blob. The review screen folds one
  -- hand, not the whole match. A seq range rather than a byte range: byte
  -- offsets break the moment the serializer's whitespace changes, seq numbers
  -- are part of the event contract (§5.5).
  log_seq_start  INTEGER,
  log_seq_end    INTEGER,

  started_at     TEXT NOT NULL,
  ended_at       TEXT,

  PRIMARY KEY (match_id, hand_index),

  -- Structural invariants of the game, not vocabularies — safe to CHECK because
  -- no rule change can make them false.
  CHECK (delta_seat0 + delta_seat1 + delta_seat2 + delta_seat3 = 0),
  CHECK (outcome <> 'win' OR winner_seat IS NOT NULL),   -- a win has a winner
  CHECK (self_draw = 0 OR win_from_seat IS NULL),        -- 自摸: nobody discarded it
  CHECK (win_from_seat IS NULL OR win_from_seat <> winner_seat), -- cannot win off your own discard
  CHECK (raw_faan >= faan)                               -- capping only ever lowers
  -- NOT checked: faan >= the ruleset minimum. The minimum is ruleset DATA
  -- (rulesets.minimum_faan) — 3 in canonical HKOS, different in the LIU preset
  -- and in future house rules. A constant here would make those unrepresentable.
);

-- Per-player hand stats: mean winning faan, hands won, self-draw rate.
CREATE INDEX idx_hands_winner
  ON hands(winner_player_id, ended_at)
  WHERE winner_player_id IS NOT NULL;

-- Deal-in rate — gate 3's third measured behaviour, in one indexed read.
CREATE INDEX idx_hands_dealt_in
  ON hands(win_from_player_id, ended_at)
  WHERE win_from_player_id IS NOT NULL;

-- Global rates over a window: draw rate, win rate, faan distribution.
CREATE INDEX idx_hands_outcome ON hands(outcome, ended_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- rating_history — canonical record of every rating change (DESIGN.md §3:
-- provisional per-device Elo at P0, visible on the results screen, labelled
-- unofficial and resettable).
--
-- Append-only. players.rating is a cache of the latest row per player per
-- season; this table is the truth, and a full recompute is a fold over it.
--
-- `system` exists so P1's Glicko-2 (DESIGN.md §3, HKMA-aligned per §1) is a new
-- value in this column and not a rewrite of these rows. Elo numbers and Glicko
-- numbers must never be compared, and a column that says which is which is the
-- cheapest possible way to keep that true. Glicko's deviation and volatility
-- arrive as additive nullable columns when that system ships.
--
-- k_factor and games_played_before are stored, not recomputed, because
-- provisional Elo decays K with experience: without the inputs, a past delta
-- cannot be reproduced, and an unreproducible rating is an unarguable one.
--
-- `season` is here from day 0 even though P0 has exactly one season. Adding a
-- partition key to a history table later means backfilling every row and
-- guessing; adding it now costs a default.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE rating_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id           TEXT NOT NULL REFERENCES players(id),
  match_id            TEXT REFERENCES matches(id),  -- null for seed | reset | adjustment
  kind                TEXT NOT NULL,   -- match | seed | reset | adjustment (code-enforced)
  system              TEXT NOT NULL,   -- 'elo-provisional-v1' at P0
  season              TEXT NOT NULL,   -- 'p0-provisional' at P0

  rating_before       REAL NOT NULL,
  rating_after        REAL NOT NULL,
  games_played_before INTEGER NOT NULL,
  k_factor            REAL NOT NULL,

  -- What the rating actually scored. HK is a four-player chip game, so the
  -- input is the match's chip result and placement, not a win/loss.
  place               INTEGER CHECK (place BETWEEN 1 AND 4),
  chip_delta          INTEGER,

  -- Free-text reason for kind <> 'match'. An admin adjustment with no stated
  -- reason is indistinguishable from a bug.
  note                TEXT,
  created_at          TEXT NOT NULL
);

-- A player's rating curve, newest first. Also the recompute-from-scratch scan.
CREATE INDEX idx_rating_history_player ON rating_history(player_id, id DESC);

-- "Show the four rating changes from this match" on the results screen.
CREATE INDEX idx_rating_history_match
  ON rating_history(match_id)
  WHERE match_id IS NOT NULL;

-- Season rollover and audits of one rating system's rows.
CREATE INDEX idx_rating_history_season ON rating_history(season, system, id);

-- ─────────────────────────────────────────────────────────────────────────────
-- presence — the lobby's "here now" heartbeat (PVP-LOBBY-PROPOSAL-2026-09-02.md
-- §3.3, §7.1). The client POSTs /api/presence every 30s while the lobby screen
-- is open; a row older than 90s is treated as gone (idx_presence_seen finds the
-- live set without a scan).
--
-- One row per player, upserted in place — this is presence, not history. A
-- player seated at a table is ALSO shown "here" via `match_players`/`matches`
-- (DESIGN.md, `GET /api/lobby` §7.2), not via this table: a table's own state
-- already says who is seated, and duplicating that into a presence row would
-- be a second source of truth that can go stale the moment a socket drops
-- without a matching heartbeat.
--
-- No `match_id` column, deliberately — an earlier draft (proposal §3.3) had
-- one; the settled contract (§7.1) does not, because "which table" is already
-- answerable from `match_players` and a redundant copy here is one more place
-- for the two to disagree.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE presence (
  player_id  TEXT PRIMARY KEY REFERENCES players(id),
  state      TEXT NOT NULL,  -- lobby | away (code-enforced, see "Closed vocabularies" above)
  seen_at    TEXT NOT NULL
);

-- The 90s "here now" window, and the sweep for rows nobody will read again.
CREATE INDEX idx_presence_seen ON presence(seen_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- lobby_messages — the lobby's chat (PVP-LOBBY-PROPOSAL-2026-09-02.md §8).
-- Rides the same 5s poll as GET /api/lobby (last 50 rows, returned inside that
-- same response) until the lobby moves to a Durable Object (L2), at which
-- point the same rows are pushed instead of polled.
--
-- display_name is denormalized at write time, same rule as everywhere else a
-- name reaches a read-only lobby view: a later rename must not rewrite what a
-- message looked like when it was sent.
--
-- Never archived, never part of any match's event log or R2 blob — chat is
-- not a game fact (table.ts's own K_CHAT ring makes the identical decision for
-- table chat). Append-only; no edit or delete path exists at P0, on purpose —
-- the gate password is the moderation (proposal §8).
--
-- room_code (§8b, added 2026-09-02): NULL = the global lobby, non-NULL scopes
-- a message to one Almanac room (`rooms.code` — see "rooms" below). Same
-- opaque cross-database reference as `matches.room_code`; no FOREIGN KEY is
-- possible, for the same reason. `GET /api/lobby?room=CODE` reads only rows
-- with that room_code; the unscoped lobby reads only `room_code IS NULL`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE lobby_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    TEXT NOT NULL REFERENCES players(id),
  display_name TEXT NOT NULL,
  text         TEXT NOT NULL,
  room_code    TEXT,
  created_at   TEXT NOT NULL
);

-- The per-player rate check reads this player's newest row; the "last 50"
-- read is the table's own rowid order and needs no extra index.
CREATE INDEX idx_lobby_messages_player ON lobby_messages(player_id, id DESC);

-- The room-scoped "last 50" read (and, via `room_code IS NULL`, the global
-- one too — SQLite can range-scan a NULL group of a multi-column index).
CREATE INDEX idx_lobby_messages_room ON lobby_messages(room_code, id DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- rooms (§8b, added 2026-09-02) — NOT owned by this schema. `rooms` and
-- `room_players` are the Almanac's tables, created by
-- mjrc-app/web/migrations/0004_rooms.sql, 0008_room_builder.sql and
-- 0011_room_codes.sql in the SAME remote `mjrc-scoring` database this file
-- targets. No CREATE TABLE for either lives here — writing one would either
-- collide with the Almanac's real migration history or silently diverge from
-- it. The game reads `rooms.settings`/`admin_code_hash` and writes only the
-- `game` key of `settings` (`{ "game": { "rulesetId", "matchFormat", "access"
-- } }`) and its own `room_players` rows (game player id as `player_id`,
-- display name as free-text `name` — see PVP-LOBBY-PROPOSAL-2026-09-02.md
-- §8b). `matches.room_code` above already references `rooms.code` the same
-- opaque way.
--
-- Local D1 has no Almanac migrations to replay, so `rooms`/`room_players`
-- do not exist there unless created separately —
-- gamepvp/migrations/local-almanac-rooms.sql does that, LOCAL ONLY, with the
-- exact column set those three Almanac migrations produce. Never run it
-- against remote.
-- ─────────────────────────────────────────────────────────────────────────────

-- LOCAL DEV ONLY. Never run against remote.
--
-- `rooms` and `room_players` are the Almanac's tables, not the game's
-- (worker/schema.sql's "rooms" note explains the split). They already exist
-- in the remote mjrc-scoring database, created by
-- mjrc-app/web/migrations/0004_rooms.sql, 0008_room_builder.sql and
-- 0011_room_codes.sql. Local D1 (`wrangler d1 execute --local`) only ever
-- replays worker/schema.sql, so it never sees those Almanac migrations — this
-- file recreates the exact column set they produce, so the game's local dev
-- and tests have something to read and write against.
--
-- Column set is 0004 + 0008's ALTERs + 0011's ALTER, verbatim. Only the
-- columns worker/src/db.ts actually touches matter here; room_rotations,
-- room_seatings and room_queue (0008) are physical-seating tables the game
-- never reads and are intentionally omitted.
--
-- Apply once:
--   cd gamepvp && npx wrangler d1 execute mjrc-scoring --local --file migrations/local-almanac-rooms.sql

CREATE TABLE rooms (
  code                  TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  password_hash         TEXT,
  password_attempts     INTEGER NOT NULL DEFAULT 0,
  password_locked_until TEXT,
  -- JSON: { rulesetPresetId?, purpose?, leaderboard?, notes?, game? }. The
  -- game reads/writes only the `game` key (worker/src/db.ts
  -- roomGameSettingsOf/withRoomGameSettings) and never touches the rest.
  settings              TEXT NOT NULL DEFAULT '{}',
  -- 0011: sha256 hex of the room's own 4-ish-digit organizer code. NULL means
  -- the room has no code of its own — the game route (postRoomSettings /
  -- postRoomTableClose) then refuses every admin action, on purpose: there is
  -- no master-code fallback on the game side (see gamepvp/README.md §Rooms).
  admin_code_hash       TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE room_players (
  room_code    TEXT NOT NULL REFERENCES rooms(code),
  -- Whatever identity namespace inserted this row: an Almanac roster id for a
  -- physical-play room, or a game `players.id` for an online-first one. The
  -- two coexist in this one table by construction (no FK to either identity
  -- table) — see worker/schema.sql's "rooms" note.
  player_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  seed_rating  REAL,
  archived_at  TEXT,
  PRIMARY KEY (room_code, player_id)
);

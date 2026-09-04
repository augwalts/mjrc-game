-- The new lobby shell's server side (PVP-LOBBY-PROPOSAL-2026-09-02.md §10
-- stats standard, §8 DMs/inbox, §11 build decisions, §8b rooms). Run once
-- against the remote mjrc-scoring database — see worker/README.md §3 for the
-- fold-into-schema.sql procedure this file follows (the same one every
-- other gamepvp/migrations/remote-2026-09-0N-*.sql in this directory does).
--
-- The Open Hall (§11.2, §11 build decision 2) needs NO schema change: it is
-- a `rooms` row with code = 'OPEN', inserted lazily at runtime the same way
-- `POST /api/rooms` inserts any other room (`ensureOpenRoom`,
-- worker/src/index.ts) — see schema.sql's "rooms" note.

-- players.tz_offset_min (§11 build decision 5) — the client's last-reported
-- UTC offset in minutes, set from POST /api/identity and POST /api/presence.
-- Streak days and "today" (GET /api/stats/record's streakDays/bestStreak)
-- are counted in this offset, not UTC.
ALTER TABLE players ADD COLUMN tz_offset_min INTEGER NOT NULL DEFAULT 0;

-- friend_stars — a player's own pin on a friend (§11 build decision 1:
-- "star to pin"). "Friends" itself needs no table — GET /api/friends folds
-- match_players/matches at read time.
CREATE TABLE friend_stars (
  player_id  TEXT NOT NULL REFERENCES players(id),
  friend_id  TEXT NOT NULL REFERENCES players(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (player_id, friend_id)
);

-- dm_messages — direct messages (§8 "Direct messages and the inbox").
CREATE TABLE dm_messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_player_id TEXT NOT NULL REFERENCES players(id),
  to_player_id   TEXT NOT NULL REFERENCES players(id),
  text           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  read_at        TEXT
);
CREATE INDEX idx_dm_messages_from ON dm_messages(from_player_id, to_player_id, id DESC);
CREATE INDEX idx_dm_messages_to   ON dm_messages(to_player_id, from_player_id, id DESC);
CREATE INDEX idx_dm_messages_sender ON dm_messages(from_player_id, id DESC);
CREATE INDEX idx_dm_messages_unread ON dm_messages(to_player_id, id DESC) WHERE read_at IS NULL;

-- inbox_items — invites, room notices and results (§8). Real, append-only
-- rows (not a read-time fold) because dismissal is a per-viewer fact this
-- schema otherwise has no place to record.
CREATE TABLE inbox_items (
  id             TEXT PRIMARY KEY,
  player_id      TEXT NOT NULL REFERENCES players(id),
  kind           TEXT NOT NULL,   -- invite | room | result (code-enforced)
  match_id       TEXT,
  room_code      TEXT,
  from_player_id TEXT,
  text           TEXT,
  created_at     TEXT NOT NULL,
  read_at        TEXT,
  dismissed_at   TEXT
);
CREATE INDEX idx_inbox_items_player ON inbox_items(player_id, created_at DESC) WHERE dismissed_at IS NULL;

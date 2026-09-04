-- lobby, presence, seat plans (PVP-LOBBY-PROPOSAL §7.1). Run once against the remote mjrc-scoring.
ALTER TABLE matches ADD COLUMN access TEXT NOT NULL DEFAULT 'open';
ALTER TABLE matches ADD COLUMN mode TEXT NOT NULL DEFAULT 'casual';
ALTER TABLE matches ADD COLUMN lobby_status TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE matches ADD COLUMN current_hand INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN hands_base INTEGER NOT NULL DEFAULT 4;
ALTER TABLE matches ADD COLUMN seat_plan TEXT NOT NULL DEFAULT '[]';
ALTER TABLE matches ADD COLUMN randomize_seats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN created_by TEXT;
ALTER TABLE match_players ADD COLUMN connected INTEGER NOT NULL DEFAULT 0;
CREATE TABLE presence (player_id TEXT PRIMARY KEY REFERENCES players(id), state TEXT NOT NULL, seen_at TEXT NOT NULL);
CREATE INDEX idx_presence_seen ON presence(seen_at);
CREATE INDEX idx_matches_lobby_open ON matches(lobby_status, started_at DESC) WHERE lobby_status IN ('waiting', 'playing');
CREATE INDEX idx_matches_lobby_done ON matches(lobby_status, ended_at DESC) WHERE lobby_status = 'done';
UPDATE matches SET lobby_status='done' WHERE status IN ('complete','abandoned') AND lobby_status<>'done';

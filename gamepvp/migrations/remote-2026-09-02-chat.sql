-- chat: table chat needs no schema (worker/src/table.ts K_CHAT, DO storage
-- only); lobby chat needs this one table. Run once against the remote
-- mjrc-scoring (PVP-LOBBY-PROPOSAL-2026-09-02.md §8).
CREATE TABLE lobby_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    TEXT NOT NULL REFERENCES players(id),
  display_name TEXT NOT NULL,
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_lobby_messages_player ON lobby_messages(player_id, id DESC);

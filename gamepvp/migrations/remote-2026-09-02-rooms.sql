-- rooms, phase 1+2 (PVP-LOBBY-PROPOSAL-2026-09-02.md §8b). Run once against
-- the remote mjrc-scoring database.
--
-- `rooms` and `room_players` are NOT created here — they already exist
-- remotely, owned by the Almanac (mjrc-app/web/migrations/0004_rooms.sql,
-- 0008_room_builder.sql, 0011_room_codes.sql). This migration only adds what
-- the game's OWN table needs to scope chat to a room.
ALTER TABLE lobby_messages ADD COLUMN room_code TEXT;
CREATE INDEX idx_lobby_messages_room ON lobby_messages(room_code, id DESC);

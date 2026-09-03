-- Demo data (2026-09-03): the demo games in the "Demo room" (YT84RJ) were
-- played headlessly by "sable" and a stand-in player "augie-standin". This
-- re-points every stand-in row to the real augie player and removes the
-- stand-in, so augie's stats, recent games, friends (played-with) and room
-- membership show those games as his own. Idempotent: running it twice is a
-- no-op because the stand-in no longer exists after the first run.
--
-- Run it only once every demo game has finished — a table still running
-- with the stand-in seated would fail its archive writes once the row is gone.
--
--   cd /Users/augustineliu/Local_Projects/mjrc/mjrc-worktrees/gamepvp-deploy/gamepvp
--   npx wrangler d1 execute mjrc-scoring --remote --file migrations/remote-2026-09-03-demo-augie.sql -y
--
-- No temporary table: D1 refuses CREATE TEMP TABLE (SQLITE_AUTH), so the two
-- ids are looked up inline in every statement. "augie" = the most recently
-- seen live human whose display name is exactly augie; the stand-in row is
-- deleted last, so every earlier lookup still resolves.

UPDATE match_players
  SET player_id = (SELECT id FROM players WHERE kind = 'human' AND deleted_at IS NULL AND display_name = 'augie' ORDER BY last_seen_at DESC LIMIT 1)
  WHERE player_id = (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1);

UPDATE hands
  SET winner_player_id = (SELECT id FROM players WHERE kind = 'human' AND deleted_at IS NULL AND display_name = 'augie' ORDER BY last_seen_at DESC LIMIT 1)
  WHERE winner_player_id = (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1);

UPDATE hands
  SET win_from_player_id = (SELECT id FROM players WHERE kind = 'human' AND deleted_at IS NULL AND display_name = 'augie' ORDER BY last_seen_at DESC LIMIT 1)
  WHERE win_from_player_id = (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1);

UPDATE matches
  SET created_by = (SELECT id FROM players WHERE kind = 'human' AND deleted_at IS NULL AND display_name = 'augie' ORDER BY last_seen_at DESC LIMIT 1)
  WHERE created_by = (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1);

UPDATE inbox_items
  SET player_id = (SELECT id FROM players WHERE kind = 'human' AND deleted_at IS NULL AND display_name = 'augie' ORDER BY last_seen_at DESC LIMIT 1)
  WHERE player_id = (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1);

UPDATE inbox_items
  SET from_player_id = (SELECT id FROM players WHERE kind = 'human' AND deleted_at IS NULL AND display_name = 'augie' ORDER BY last_seen_at DESC LIMIT 1)
  WHERE from_player_id = (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1);

-- Room membership: give augie the stand-in's seat in the Demo room, then drop the stand-in's.
INSERT OR IGNORE INTO room_players (room_code, player_id, name, seed_rating, archived_at)
  SELECT room_code,
         (SELECT id FROM players WHERE kind = 'human' AND deleted_at IS NULL AND display_name = 'augie' ORDER BY last_seen_at DESC LIMIT 1),
         'augie', seed_rating, archived_at
    FROM room_players
   WHERE player_id = (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1);

DELETE FROM room_players
  WHERE player_id = (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1);

DELETE FROM presence
  WHERE player_id = (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1);

DELETE FROM player_credentials
  WHERE player_id = (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1);

DELETE FROM players
  WHERE kind = 'human' AND display_name = 'augie-standin';

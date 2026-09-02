-- Demo data (2026-09-03): the four demo games in the "Demo room" (YT84RJ) were
-- played headlessly by "sable" and a stand-in player "augie-standin". This
-- re-points every stand-in row to the real augie player and removes the
-- stand-in, so augie's stats, recent games, friends (played-with) and room
-- membership show those games as his own. Idempotent: running it twice is a
-- no-op because the stand-in no longer exists after the first run.
--
--   cd /Users/augustineliu/Local_Projects/mjrc/mjrc-worktrees/gamepvp-deploy/gamepvp
--   npx wrangler d1 execute mjrc-scoring --remote --file migrations/remote-2026-09-03-demo-augie.sql -y
--
-- "augie" = the most recently seen human whose display name is exactly augie.

CREATE TEMP TABLE demo_ids AS
  SELECT
    (SELECT id FROM players WHERE kind = 'human' AND deleted_at IS NULL AND display_name = 'augie'
       ORDER BY last_seen_at DESC LIMIT 1) AS augie,
    (SELECT id FROM players WHERE kind = 'human' AND display_name = 'augie-standin' LIMIT 1) AS standin;

UPDATE match_players SET player_id = (SELECT augie FROM demo_ids)
  WHERE player_id = (SELECT standin FROM demo_ids);
UPDATE hands SET winner_player_id = (SELECT augie FROM demo_ids)
  WHERE winner_player_id = (SELECT standin FROM demo_ids);
UPDATE hands SET win_from_player_id = (SELECT augie FROM demo_ids)
  WHERE win_from_player_id = (SELECT standin FROM demo_ids);
UPDATE matches SET created_by = (SELECT augie FROM demo_ids)
  WHERE created_by = (SELECT standin FROM demo_ids);
UPDATE inbox_items SET player_id = (SELECT augie FROM demo_ids)
  WHERE player_id = (SELECT standin FROM demo_ids);
UPDATE inbox_items SET from_player_id = (SELECT augie FROM demo_ids)
  WHERE from_player_id = (SELECT standin FROM demo_ids);

-- Room membership: give augie the stand-in's seat in the Demo room, then drop the stand-in's.
INSERT OR IGNORE INTO room_players (room_code, player_id, name, seed_rating, archived_at)
  SELECT room_code, (SELECT augie FROM demo_ids), 'augie', seed_rating, archived_at
    FROM room_players WHERE player_id = (SELECT standin FROM demo_ids);
DELETE FROM room_players WHERE player_id = (SELECT standin FROM demo_ids);

DELETE FROM presence WHERE player_id = (SELECT standin FROM demo_ids);
DELETE FROM player_credentials WHERE player_id = (SELECT standin FROM demo_ids);
DELETE FROM players WHERE id = (SELECT standin FROM demo_ids);

DROP TABLE demo_ids;

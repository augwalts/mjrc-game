-- match_players grading columns (plan §3 W7). Run once against the remote mjrc-scoring.
ALTER TABLE match_players ADD COLUMN moves_graded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match_players ADD COLUMN moves_matched INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match_players ADD COLUMN gap_sum REAL NOT NULL DEFAULT 0;

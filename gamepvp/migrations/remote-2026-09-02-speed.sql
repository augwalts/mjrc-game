-- matches.speed (PVP-LOBBY-PROPOSAL-2026-09-02.md §8a-2). Run once against the remote mjrc-scoring.
ALTER TABLE matches ADD COLUMN speed TEXT NOT NULL DEFAULT 'normal';

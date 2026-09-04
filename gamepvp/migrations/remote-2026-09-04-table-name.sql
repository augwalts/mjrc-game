-- Optional table display name (owner request 2026-09-04). Adds matches.name
-- — trimmed, control characters stripped, <= 40 chars, null = none — see
-- worker/schema.sql for the column comment and worker/README.md §3 for the
-- fold-into-schema.sql procedure this file follows (the same one every other
-- gamepvp/migrations/remote-2026-09-0N-*.sql in this directory does).
--
-- Run against the remote database:
--   cd /Users/augustineliu/Local_Projects/mjrc/mjrc-worktrees/gamepvp-deploy/gamepvp && npx wrangler d1 execute mjrc-scoring --remote --file migrations/remote-2026-09-04-table-name.sql -y
--
-- Local dev database:
--   cd gamepvp && npx wrangler d1 execute mjrc-scoring --local --file migrations/remote-2026-09-04-table-name.sql

ALTER TABLE matches ADD COLUMN name TEXT;

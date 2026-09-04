-- TVB training hall (owner request 2026-09-03): a real room, locked to the
-- TVB Championship 2026 ruleset, east round, open access. The Demo room is
-- untouched. No admin code yet (admin_code_hash NULL) — set one through
-- POST /api/rooms/:code/admin when the room needs administering.
-- Apply: cd gamepvp && npx wrangler d1 execute mjrc-scoring --remote --file migrations/remote-2026-09-03-tvb-hall.sql
INSERT OR IGNORE INTO rooms (code, name, password_hash, password_attempts, settings, admin_code_hash, created_at, updated_at)
VALUES ('TVBHALL', 'TVB training hall', NULL, 0,
        '{"game":{"rulesetId":"tvb-2026","matchFormat":"east","access":"open"}}',
        NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

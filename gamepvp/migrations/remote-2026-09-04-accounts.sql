-- Accounts for gamepvp — Google sign-in and sign-up.
-- Contract: ../../ACCOUNTS-GAME-SIGNIN-2026-09-04.md §1. Table shapes follow
-- ../../ACCOUNTS-BUILD-SPEC.md §users, extended with the four columns that
-- contract adds (`user_no`, `picture`, `onboarded_at`, `session_epoch`).
--
-- These tables live in the SHARED `mjrc-scoring` database — the same one the
-- Almanac writes and the same one worker/schema.sql's game tables already sit
-- in — so the site inherits them rather than growing a second account store.
-- `players.almanac_user_id` (worker/schema.sql, "the Almanac seam") is the link
-- from a game player to `users.id`; at most one live player per user.
--
-- Additive only, IF NOT EXISTS throughout (worker/README.md §3): the Almanac
-- may create `users` first, and this file must be a no-op in that case rather
-- than an error.
--
-- Run against the remote database (owner only, after `wrangler secret put`):
--   cd gamepvp && npx wrangler d1 execute mjrc-scoring --remote --file migrations/remote-2026-09-04-accounts.sql -y
--
-- Local dev database:
--   cd gamepvp && npx wrangler d1 execute mjrc-scoring --local --file migrations/remote-2026-09-04-accounts.sql

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,          -- Crockford base32, app-generated
  user_no        INTEGER NOT NULL UNIQUE,   -- display/ordering number; 0 = augwalts
  google_sub     TEXT,                      -- null until first sign-in; nulled on deletion
  email          TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  handle         TEXT UNIQUE,               -- null until sign-up confirms it
  display_name   TEXT NOT NULL,
  picture        TEXT,                      -- Google photo URL (not the game avatar)
  is_admin       INTEGER NOT NULL DEFAULT 0,
  signup_lang    TEXT,
  signup_source  TEXT,                      -- landing path or room/table code
  onboarded_at   TEXT,                      -- null = signed in but sign-up not finished
  session_epoch  INTEGER NOT NULL DEFAULT 0,-- bump to invalidate every session
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  deleted_at     TEXT
);

-- Uniqueness over live values only, so deletion can null the column
-- (ACCOUNTS-BUILD-SPEC.md §9.3 step 1) and a later sign-in makes a fresh
-- account rather than resurrecting the scrubbed one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sub ON users(google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE deleted_at IS NULL;

-- A released handle is never reissued: it keeps redirecting (D7) and a deleted
-- account's handle cannot be claimed by someone else impersonating them.
CREATE TABLE IF NOT EXISTS handle_history (
  handle      TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  released_at TEXT NOT NULL
);

-- Consent is a record, not a state (ACCOUNTS-BUILD-SPEC.md §users): the latest
-- row per kind is the current answer, and the history stays evidentiary.
CREATE TABLE IF NOT EXISTS consents (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind    TEXT NOT NULL,          -- terms | privacy | marketing
  granted INTEGER NOT NULL,       -- 1 / 0; latest row per kind is the state
  source  TEXT NOT NULL,          -- signup | account
  at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consents_user ON consents(user_id, kind, at DESC);

-- User 0 is Augustine (ACCOUNTS-BUILD-SPEC.md decision 2026-09-03). Seeded with
-- a NULL google_sub on purpose: the first Google sign-in carrying this verified
-- email attaches the sub to THIS row instead of creating user #1, so the owner
-- keeps member number 0. OR IGNORE, so a re-run changes nothing.
INSERT OR IGNORE INTO users (id, user_no, email, display_name, is_admin, created_at, updated_at, last_seen_at)
  VALUES ('USER0AUGWALTS000', 0, 'augwalts@gmail.com', 'augie', 1,
          '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z');

# worker — platform services (D1)

The stateless half of the back end. Plain HTTP over Workers, no Durable Object:
identity, match history, per-hand results, rating (`DESIGN.md` §5.4). Boring on
purpose, and queryable across all tables from day one.

The live match is the other half and does not appear here — it is one Durable
Object per table, holding authoritative game state over a WebSocket
(`DESIGN.md` §5.3, `sketches/BACKEND.md` §1). **The two planes never share a
channel.** Everything this schema serves — match list, results screen, replay
viewer, review, stats, leaderboard — is a plain `GET`.

Files:

- `/Users/augustineliu/Local_Projects/mjrc/mjrc-game/worker/schema.sql` —
  the authoritative full schema, and migration `0001`.
- `/Users/augustineliu/Local_Projects/mjrc/mjrc-game/worker/README.md` — this file.

Terminology: `../TERMINOLOGY.md` binds column names and enum values as much as
it binds code. HK Old Style only.

---

## 1. Resources and bindings

| Binding | Kind | Name | Access |
|---|---|---|---|
| `DB` | D1 | `mjrc-game` | read/write — this schema |
| `LOGS` | R2 | `mjrc-game-logs` | read/write — the omniscient event log blobs |
| `ALMANAC` | D1 | `mjrc-scoring` | **read only, by convention** — accounts and rooms |

> **gamepvp deviates from the table above, deliberately.** `gamepvp/wrangler.jsonc`
> binds ONE database, `mjrc-scoring`, as `DB` — the game tables and the accounts
> tables (`users`, `handle_history`, `consents`,
> `gamepvp/migrations/remote-2026-09-04-accounts.sql`) live side by side in it.
> The two-database split described in §6 and open question 1 is the mjrc-game
> design; the shipped gamepvp Worker answered open question 1 the other way.

`ALMANAC` is the same database the Mahjong Almanac writes
(`/Users/augustineliu/Local_Projects/mjrc/mjrc-app/web/migrations/`). D1 has no
per-binding permissions, so "read only" is a code-review rule, not an enforced
one: **the game Worker never issues a write against `ALMANAC`.** If it ever
needs to, that write belongs in an mjrc-app endpoint the game calls.

**Do not create any Cloudflare resource, and do not deploy, without Augustine's
explicit approval** — the same rule stated in
`/Users/augustineliu/Local_Projects/mjrc/mjrc-app/web/wrangler.toml`.

## 2. Applying the schema

```sh
# local
wrangler d1 execute mjrc-game --file worker/schema.sql --local

# remote — after approval
wrangler d1 execute mjrc-game --file worker/schema.sql --remote
```

**Apply to remote D1 before deploying the code that reads it.** The Almanac
learned this the hard way with `0005_analytics.sql`; the gates fail closed and
the site 500s otherwise.

## 3. Migrations

The rule inherited from the Almanac and from
`AI/standards/software-patterns/human-data-ingestion.md` §3: **additive only.**
No migration drops a column or destroys data. A column that turns out wrong gets
stopped being written and stays in place.

Procedure for any schema change:

1. Write `worker/migrations/000N_short_name.sql` containing only the delta —
   `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, `CREATE INDEX`.
2. Fold the same change into `schema.sql` **in the same commit**, and bump the
   `-- applied through:` marker at its top. That marker is the drift detector:
   if it does not match the highest file in `migrations/`, the two have
   diverged and review should catch it.
3. Apply to local, then remote, then deploy.

`schema.sql` is not generated from the migrations and the migrations are not
generated from it. Both are hand-written, which is why step 2 is a rule rather
than a convention.

### Rebuilding a table

SQLite cannot drop a `CHECK` constraint or a column without recreating the
table. That is why closed vocabularies (`matches.status`, `hands.outcome`,
`rating_history.kind`, ...) are enforced in application code and **never** by a
`CHECK` — adding one enum value must stay a one-line change. Same discipline as
`KNOWN_EVENT_TYPES` in the Almanac's `_lib/shared.ts` and `admin_audit.action`
in `ACCOUNTS-BUILD-SPEC.md` §5.7: an unknown value is a bug, not a feature.

The `CHECK`s that do exist are structural invariants of mahjong — four seats,
zero-sum chip settlement, a win has a winner, nobody wins off their own discard.
The one to think about before writing is `hands`' zero-sum check: if a house
ruleset ever introduces a pot or a kitty that chips leave, that check becomes a
blocker and clearing it costs a full table rebuild (create new, copy, drop,
rename, recreate indices — all in one migration, with the old table kept until
the row counts match). That cost is accepted deliberately: a settlement bug that
reaches a rating is worse than a rebuild.

## 4. The tables

Seven, in dependency order. Every one carries its reasoning inline in
`schema.sql`; this section is the map, not a duplicate.

### Regenerable vs stateful

Stated at the top of `schema.sql` as the house standard requires
(`human-data-ingestion.md` §2). Almost every column here is **stateful**:
written once by the server, never touched again, because a match record is a
statement about what happened. The only fields a rebuild job may recompute in
place are the derived projections, each a fold over a canonical table in this
same database:

| Regenerable | Folded from |
|---|---|
| `players.rating`, `rating_games`, `rating_season` | `rating_history` |
| `matches.hand_count` | `hands` |
| `match_players.hands_won`, `self_draws`, `deal_ins` | `hands` |
| `hands.winner_player_id`, `win_from_player_id` | `match_players` |

Everything else — every column of `hands` describing the hand, every
`rating_history` row — is stateful. A wrong `hands` row is corrected by voiding
it and re-deriving from the R2 log, never by an `UPDATE` that leaves no trace.

### `rulesets`

The archive of every ruleset configuration that has ever been played, keyed by
the SHA-256 of its canonical JSON. `matches.ruleset_hash` points at a row here.

Rulesets are data, not code (`DESIGN.md` §4). The consequence people miss: if
matches recorded only `ruleset_id`, then editing a faan value in
`rulesets/*.json` would silently restate the meaning of every past match. This
is the same failure `engine_version` pinning exists to prevent (`DESIGN.md`
§5.5), and it applies to the ruleset with equal force. Edit a preset, get a new
hash, old matches keep pointing at the old bytes.

`minimum_faan` (3 canonical) and `limit_faan` (13 爆棚) are columns, not
constants, because the LIU preset and future house rules change them. Nothing in
this schema hard-codes either number.

`config` holds the serializable Ruleset — faan table, payment brackets,
settlement rule, feature flags. `PaymentTable.onDiscard` / `onSelfDraw` are
functions and cannot be archived; `payment_id` records which implementation was
in force. The self-draw settlement (`per_player` vs `total`) is promoted to its
own column because `DESIGN.md` §9 lists it as an unsettled ambiguity and every
golden case must state which it assumes — it needs to be readable without
parsing JSON.

### `players`

One row per identity that can hold a seat.

**Credentials are rows, not columns** — see `player_credentials`. This is the
whole answer to "adding real accounts later is a migration, not a rewrite". A
`device_token_hash` column on this table would have to be widened for passkeys,
then made nullable, then ignored, then dropped; and a player with a phone and a
laptop could not be expressed at all.

**Bots are players**, `kind = 'bot'`. A bot's input arrives from a function call
instead of a socket, and it uses the same action API and the same legality checks
(`DESIGN.md` §6). Real rows keep `match_players.player_id` `NOT NULL` and the
foreign key honest; human aggregates filter `kind = 'human'`. One row per **bot
policy version**, not one row per bot forever — gate 3 (bot-vs-human parity,
`DESIGN.md` §3) is a `GROUP BY` over exactly that distinction, and reusing one
row across a policy upgrade makes the gate unmeasurable.

`rating`, `rating_games` and `rating_season` are a **derived cache** of
`rating_history`, present so the leaderboard is one indexed read. The history is
canonical; a full recompute is a fold over it.

Deletion is soft, scrub in place — the Almanac's invariant I4
(`ACCOUNTS-BUILD-SPEC.md` §3, §9.3). Three other people are in every match this
player played, and that history is not this player's to delete.

### `player_credentials`

Every way a person proves they are a given player. `kind = 'device'` at P0
(SHA-256 of a client-minted token, never the token — same pattern as the
Almanac's `games.edit_token_hash`); `kind = 'passkey'` at P1, with the WebAuthn
`public_key` and `sign_count` in the columns that are null for device tokens.
Adding passkeys changes this table's data, not its shape, and changes `players`
not at all.

Revocation is a column, not a `DELETE`, so "this phone was lost" stays
answerable and a revoked credential id can never be reissued.

### `matches`

One row per match. A match is many hands — the ranked default is one wind round
東圈, four rotations plus repeats, 20-35 minutes (`DESIGN.md` §4).

Three pins make gate 2 ("100% of completed games reconstruct in the viewer")
survive a bugfix: `engine_version`, `ruleset_hash`, `log_schema_version`. Replay
is re-execution, so an old match replays through the engine build and ruleset
bytes recorded on its own row.

`log_key` is the R2 key of the omniscient event log blob, and it is **stored
rather than derived** from the match id, because the key convention will change
— a second serializer, a re-shard, a lifecycle policy — and every old row must
keep pointing at where its blob actually is. It stays `NULL` until the Table
DO's outbox confirms both the R2 write and this row (`DESIGN.md` §5.3), which
makes `log_key IS NULL AND status = 'complete'` the exact definition of a lost
log. `idx_matches_missing_log` is a partial index over precisely that condition:
empty and free in the healthy case, one query in the unhealthy one.

`room_code` and `join_code` are two columns because they are two different
things: the first is an MJRC room (`rooms.code` in `mjrc-scoring` — an opaque
cross-database reference, no FK possible), the second is the P0 lobby's
friends-join-by-code string. A join code is not a credential; it is spent at join
time and the one-time seat token is the real gate.

`rated` is decided at match end and frozen, not derived at read time. The policy
for what counts as rated will change, and a leaderboard that silently restates
last month's results is worse than a stale one.

### `match_players`

The four seats. `PRIMARY KEY (match_id, seat)`, plus
`UNIQUE (match_id, player_id)` — without the second, a client retry that
re-seats a reconnecting player silently produces a five-seat match.

**Seat is not wind.** Seat is physical table position, never moves, and is what
`actor` means in the event log. Wind rotates with the dealer every hand, so
`wind` here is the seat's wind at the *first* deal — the thing that fixes the
rotation order. A given hand's seat wind derives from `hands.dealer_seat` and is
not stored four times per hand.

`hands_won`, `self_draws`, `deal_ins` are denormalized from `hands` and
regenerable from it. They are here because they are gate 3's measured behaviours
(call rate, mean winning faan, deal-in rate, draw rate) and the results screen
shows all of them at once.

`bot_takeover_hands` counts hands this seat was played by a bot after a
disconnect (`DESIGN.md` §5.3: grace alarm → bot takeover → seat reclaim). It is
material to whether the match should have been rated and to reading the seat's
stats honestly, and it is not inferable from anything else in D1.

### `hands`

One row per hand within a match. **This is the review and stats surface.**

It exists so no screen has to fetch and parse the R2 blob to answer "what
happened". The blob is the corpus and the replay source; this table is the index
over it. Rule of thumb: if a stats screen needs the blob for a number that
belongs on a scoreboard, that number belongs in a column here instead.

`(match_id, hand_index)` mirrors the Almanac's `events` primary key
`(session_code, seq)` on purpose — same shape, same ordering guarantee, same
mental model.

Notable columns:

- `seed` — the uint32 handed to `prng()`. `buildWall(seed)`
  (`engine/src/wall.ts`) reproduces this hand's wall exactly, so a hand replays
  from this row plus the log's actions, and a golden case can be cut from a
  reported hand without shipping the whole blob.
- `faan` / `raw_faan` / `capped` — mirroring `ScoreResult`. Both totals, because
  the review screen says "15 faan, paid at the 13 爆棚 limit" and that is a
  teaching moment, not a rounding detail.
- `awards` — `FaanAward[]` verbatim as JSON, camelCase keys, stable pattern ids
  and never display strings. The Cantonese and English labels are a client
  concern (`TERMINOLOGY.md` house style) and must stay retranslatable.
- `delta_seat0..3` — chip deltas, four columns rather than a child table. A
  child table triples the row count for a fixed-width fact and loses the
  zero-sum `CHECK`, which catches a settlement bug on the row, at write time,
  before it reaches a rating.
- `refused_wins` — wins refused for being under the ruleset minimum. These are
  emitted as visible events on purpose (`DESIGN.md` §5.2: teaching moments, not
  silent rollbacks); counted here because "how often do people reach for a
  2-faan hand" is a headline teaching metric and gate 4 mines it for material.
- `log_seq_start` / `log_seq_end` — where this hand sits in the match's blob, so
  the review screen folds one hand instead of the whole match. A `seq` range and
  not a byte range: byte offsets break the moment the serializer's whitespace
  changes, `seq` is part of the event contract (`DESIGN.md` §5.5).
- `winner_player_id` / `win_from_player_id` — denormalized from
  `match_players`, so every per-player stat is one indexed read instead of a
  join per metric. The seat columns stay canonical.

There is deliberately **no** `CHECK` that a win reaches the minimum faan. The
minimum is ruleset data (`rulesets.minimum_faan`), 3 in canonical HKOS and
different in the LIU preset; a constant here would make those unrepresentable.

### `rating_history`

Append-only, canonical, one row per rating change. `players.rating` is a cache
of the latest row per player per season.

`system` (`'elo-provisional-v1'` at P0) exists so P1's Glicko-2 family
(`DESIGN.md` §3, HKMA-aligned per §1) is a *new value in this column*, not a
rewrite of these rows. Elo numbers and Glicko numbers must never be compared,
and a column saying which is which is the cheapest way to keep that true.
Glicko's rating deviation and volatility arrive as additive nullable columns
when that system ships.

`k_factor` and `games_played_before` are stored, not recomputed. Provisional Elo
decays K with experience; without the inputs a past delta cannot be reproduced,
and an unreproducible rating is an unarguable one.

`season` is present from day 0 even though P0 has exactly one. Adding a
partition key to a history table later means backfilling every row and guessing.

The rated quantity is `place` + `chip_delta`, not a win/loss: HK is a
four-player chip game.

## 5. What is deliberately not in D1

| Thing | Where it lives | Why not here |
|---|---|---|
| The event log itself | R2, `matches.log_key` | Append-only blob per match, read whole by the replay viewer. Rows per event would be millions of rows serving one access pattern that a single `GET` already serves. |
| Live game state | Table DO storage | `state = fold(events)`; the DO is the coordination atom and is disposable at MATCH_END. |
| The outbox | Table DO storage | Hand events stay in DO storage until **both** the R2 write and the D1 row confirm (`DESIGN.md` §5.3). An outbox in D1 would need the very durability it exists to provide. |
| One-time seat tokens | Table DO storage | Lives for seconds, one consumer, and that consumer is the DO. D1 buys a round trip and a cleanup job for nothing. |
| Product telemetry | The Almanac's `analytics_*` tables | `DESIGN.md` §3: two data pipes, never conflated. The game event log is sacred and versioned; funnel metrics are disposable. Separate plumbing entirely. |
| Sessions / cookies | — (still no table) | **Superseded in part, 2026-09-04.** gamepvp now has Google sign-in (`ACCOUNTS-GAME-SIGNIN-2026-09-04.md`, `worker/src/auth.ts`), but the session is a signed stateless cookie `{uid, epoch, exp}` and revocation is `users.session_epoch` — so there is still no sessions table, and the device token is still what every `/api/*` route past `/api/me` authenticates with. `player_sessions` remains unbuilt and passkeys remain P1. |

## 6. The Almanac seam

The Almanac (`/almanac` on mahjongresearch.com) records **physical** sessions
into an append-only ledger in the `mjrc-scoring` D1. `ACCOUNTS-BUILD-SPEC.md`
§8.2 gives it a trust-ranked link from a seat to an account:
`(session_code, player_id) → user_id`, with `source` ranked
`roster` > `scorekeeper` > `self_confirmed` > `admin`.

The game is a **new source at the top of that ranking**, and it earns the
position: nobody typed anything. The seat was authenticated at the socket
against a credential in `player_credentials`, and the engine — not a person —
decided who won, what it was worth, and who paid. Call it `game`:
machine-witnessed, exact by construction, above `roster`.

### The seam is three columns, and no duplicated tables

On `players`:

```
almanac_user_id      -- users.id in mjrc-scoring. No FK: D1 has no cross-database references.
almanac_link_source  -- sign_in | admin
almanac_linked_at
```

`sign_in` means the player authenticated to the game *as* that MJRC account
(Google OIDC, `ACCOUNTS-BUILD-SPEC.md` §6.2) — the account and the game player
are the same person by construction. `admin` means the owner fixed it, and it
should be written to `admin_audit` on the Almanac side like every other admin
action.

No handle, display name or email is copied across. Handles are changeable (D7)
and a cached copy goes stale silently; the game resolves them at read time
through the `ALMANAC` binding. A copy is also PII sitting in a second database
for no reason.

### Why the game does not write `player_links` rows

`player_links` keys on `(session_code, player_id)` and references
`games(code)` — an Almanac *session*, meaning a physical table someone scored by
hand. An online match is not one of those and has no `session_code`.

Writing online matches into `games` to get links would put machine-witnessed
data into the hand-typed ledger and make the union below happen by accident,
which is the exact thing to avoid. So the direction of reference is one way:
`mjrc-game.players.almanac_user_id → mjrc-scoring.users.id`, and nothing in
`mjrc-scoring` learns about online matches except through an mjrc-app endpoint
that asks for them explicitly.

If the Almanac later wants to show "this account also plays online", it queries
the game Worker over HTTP for that account's online record and renders it as its
own labelled block. `source = 'game'` is added to the §8.2 vocabulary only if
the Almanac decides to show game-derived links in the same list — a UI decision,
not a data one.

### Two databases, on purpose

`mjrc-game` and `mjrc-scoring` are separate D1 databases, and the game Worker
binds both. The cost is real: no foreign key and no `JOIN` across the boundary.
That cost is the point. D1 gives no cross-database join, so **the union that
must never happen cannot be written by accident.** It also keeps the two repos'
migration cadences independent, which they already are.

Flagged as an open question below, because it is an architectural call.

## 7. Why online and offline stats are never unioned

A profile page may show both. Side by side, each labelled with its source. Never
one summed number, never one rating, never one "career faan" total.

1. **Provenance.** An Almanac row is a human assertion about a physical table: a
   scorekeeper can mistype the faan, void a hand, or record a session that did
   not happen. A game row is machine-witnessed and replayable from a seeded wall
   and a pinned engine version. Averaging the two averages a measurement with a
   claim.
2. **Rules.** Almanac sessions run whatever house ruleset was on the table that
   night, often unrecorded; game matches run one archived ruleset hash with an
   enforced minimum and an enforced limit. "Mean winning faan" is not the same
   quantity under two payment tables.
3. **Sample shape.** A game match is one wind round with every hand recorded,
   every tile known, every decision timestamped. An Almanac session has variable
   length, no tiles, no wall, no per-decision data. Rates computed over the union
   are weighted by whichever source logged more, not by anything meaningful.
4. **Rating validity.** Elo assumes a closed pool under enforced rules. Feeding
   hand-typed results into it makes the number unfalsifiable and trivially
   inflatable — anyone can type a session in which they won ten hands. The
   ladder covers online matches only, and that is not a limitation to be fixed
   later.
5. **Identity confidence.** The Almanac ranks link sources precisely because
   identity there is uncertain; the game's is exact. Unioning applies the
   weakest link's uncertainty to the strongest data and calls the result one
   number. `ACCOUNTS-BUILD-SPEC.md` §8.3 already refuses this trade in the
   Almanac's own scope: unverified self-claim turns honestly fuzzy stats into
   confidently wrong ones.

The gambling-adjacency posture (`DESIGN.md` §9) points the same way: chips are
points, and a combined lifetime chip total across real tables and online play
reads like a bankroll. It should not exist.

## 8. Open questions

Design decisions above the pay grade of a schema file. Each needs Augustine's
call before the code that depends on it ships.

1. **One database or two.** This schema assumes `mjrc-game` separate from
   `mjrc-scoring`, with the game Worker binding both. One database would buy
   real foreign keys to `users(id)` and cheap identity joins; two make the
   forbidden union structurally impossible and keep migration cadences
   independent. Chosen: two. Confirm or overturn before the first remote apply —
   afterwards it is a data migration.
2. **P0 identity vs. MJRC accounts.** `DESIGN.md` §5.4 specifies device tokens
   at P0 and passkeys at P1, written before `ACCOUNTS-BUILD-SPEC.md` chose
   Google OIDC for the Almanac. If the game adopts Almanac accounts directly,
   `player_credentials.kind = 'passkey'` may never be used and the seam becomes
   the primary identity path instead of an annotation. Cheap either way, but the
   answer changes what P1 builds.
3. **Are bot-seat matches rated?** `matches.rated` is stored and frozen, but no
   policy is set. P0's alpha is bot-backed, so rating only 4-human matches yields
   almost no rating data — and rating bot games inflates against a fixed
   opponent. `bot_seats` is recorded so the decision can be made from data, but
   it has to be made before the first rated match settles.
4. **Self-draw settlement.** `per_player` vs `total` is unresolved
   (`DESIGN.md` §9 — settle against
   `mjrc-admin/reference/hk-scoring-calculator.xlsx` before scoring ships). The
   schema records which was used per ruleset hash and does not care; the golden
   cases and the payment code do.
5. **Handle resolution at read time.** Reading `mjrc-scoring` directly through
   the `ALMANAC` binding is assumed here. The alternative is an mjrc-app HTTP
   endpoint, which keeps the coupling to a contract instead of a schema at the
   cost of a round trip per render. Not decided.
6. **Season identifiers.** `rating_history.season` defaults to
   `'p0-provisional'`. Whether seasons are dated (`2027-s1`) or named, and
   whether a season rollover reseeds ratings or carries them, is a P1 ladder
   decision.
7. **Log retention.** Nothing here expires. R2 blobs are the research corpus and
   should presumably live forever; `hands` rows likewise. If a retention policy
   is ever wanted, it needs a stated reason — the Almanac's 24-month
   `admin_audit` scrub (D6) is about PII, and there is none in these tables
   beyond `players.display_name`.
8. **`player_sessions` for passkeys.** A WebAuthn assertion needs a session
   afterwards. Deliberately absent at P0 (the device token is presented per
   request). When passkeys land it is an additive table shaped like the
   Almanac's `auth_sessions` — revocable, hashed token as the primary key, no IP.

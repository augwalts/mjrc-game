# AUTH.md — accounts and identity for the game

**Status:** proposal, 2026-08-26. Decides the game side of an already-settled question.
**Scope:** what `ACCOUNTS-BUILD-SPEC.md` means for `mjrc-game`, and the four places the game
genuinely differs. Terminology: `TERMINOLOGY.md` — HK Old Style, no borrowed terms.

**This document does not redesign authentication.** `../ACCOUNTS-BUILD-SPEC.md` §6.2 already
chose Google OIDC with PKCE, `google_sub` as the identity key, and no stored password. That is
settled and inherited whole. Where this document and that one appear to disagree, that one
wins — except on the four subjects in §5 through §8, which are game-specific and are decided
here.

Reading order if you are new: `DESIGN.md` §5.4 (identity lives outside any Durable Object),
`worker/schema.sql` (`players`, `player_credentials`), `worker/README.md` §6-§7 (the Almanac
seam, and why the two stat sets are never unioned). This document supersedes
`worker/README.md`'s open questions **2** (P0 identity vs. MJRC accounts) and folds in a
recorded default for it — see G2.

---

## 1. The shape, in one paragraph

Identity in the game is **three layers, and they are not the same thing**:

| Layer | What it is | Where it lives | Lifetime |
|---|---|---|---|
| **Credential** | proof you may act as a player | `player_credentials` (game D1) | revocable, many per player |
| **Player** | the thing that holds a seat, a rating, and a history | `players` (game D1) | permanent, never rewritten |
| **Account** | the person, across the whole of MJRC | `users` (Almanac D1, `mjrc-scoring`) | permanent, one per `google_sub` |

A guest has the first two. Signing in adds the third and writes three columns
(`almanac_user_id`, `almanac_link_source`, `almanac_linked_at`) onto the player row. **Google
is never the game's per-request credential** — it is an identity assertion that links a player
row to an account. The game's credential is always a row in `player_credentials`.

That separation is why guest-first works and why the merge is cheap: identity was a durable
row from the first hand, so signing in has nothing to invent.

---

## 2. Inherited, and non-negotiable

Carried from `ACCOUNTS-BUILD-SPEC.md` without amendment. Do not re-litigate any of these in
game code.

| Fact | Source | Consequence for the game |
|---|---|---|
| **Google OIDC is the only credential.** No `password_hash` exists anywhere | §5.6, §6.2 | The game never collects a password, never offers "forgot password", never emails a magic link |
| Authorization-code flow with **PKCE**: `/api/auth/google/start` mints `code_verifier`, `state` **and `nonce`**; the callback validates the `id_token` signature, `iss`, `aud`, `azp`, `exp` and `nonce` | §6.2 | The game does not reimplement this. See §5 — the recommended design is that the game never runs an OIDC flow at all |
| **The identity key is `google_sub`, never email.** Emails change hands | §5.2 | `players.almanac_user_id` points at `users.id`, which is keyed on `google_sub`. The game never sees, stores, or matches on an email address |
| **No `avatar_url` is stored.** Google's `picture` is a hotlinked Google-hosted image that leaks a referer | §5.6 | Reinforced, not merely accepted, by the game — see §9 |
| Sessions are **opaque rows, not JWTs**, so revocation is immediate | §5.2, §7.4 | Same discipline in `player_credentials.revoked_at`. The game has no JWT anywhere |
| **Accounts are never a gate** (invariant I1) | §3 | Stronger in the game: guest play is a permanent first-class mode, not a fallback — §4 |
| Google is **unreachable from mainland China** | §3 | Stated plainly, with the game's mitigation, in §10 |
| Deleting an account **never destroys history**; deletion unlinks (I4) | §3, §9.3 | The game's `players` rows are soft-deleted and scrubbed in place. Three other people are in every match; that history is not one player's to delete |

Two inherited details that are easy to get backwards:

- **`/api/auth/me` returns 200 with `{user: null}`, not 401** (§11). Anonymous is a normal
  state, not an error. If the game ever consumes that endpoint, treat a null user as success.
- **The Almanac's merge endpoint takes `mjrc.scoring.token.*` values only** (§6.6). The game's
  device token is a different credential in a different database and **must never be posted to
  `/api/account/merge`**. It will match no `games.edit_token_hash`; at best that is a wasted
  round trip, at worst it hands a live game credential to a second origin.

---

## 3. What already exists

Not a plan — code, today, in `worker/`.

- `POST /api/identity` (`worker/src/index.ts`) takes `{displayName, deviceToken?}`. A token the
  server has never seen mints a new `players` row; a token it has seen **is** the
  authentication path and returns the same player. The token itself appears in exactly one
  response, ever; after that only its SHA-256 exists.
- `authenticate()` reads `Authorization: Bearer <token>`, checks a shape floor
  (`/^[A-Za-z0-9_-]{32,200}$/`) before spending a digest, and resolves the hash to a player.
- `players` already carries the seam columns `almanac_user_id`, `almanac_link_source`
  (`sign_in | admin`), `almanac_linked_at`, with a partial index. There is **no** foreign key
  and there cannot be one — separate D1 databases.
- `player_credentials.kind` is `device | passkey`. Credentials are rows, so a second kind is an
  INSERT path, not a migration of `players`.

So P0 identity is built. What follows is the layer above it.

---

## 4. P0 — guest play first

`DESIGN.md` §5.4 puts P0 identity at "device token plus a display name". The reason is the
funnel (§2: short-form discovery → phone → play now). A sign-in wall between a stranger and
their first hand is the single most expensive thing this product could add.

### 4.1 The handoff, step by step

```
first visit
  → client mints a 160-bit token, stores it locally
  → POST /api/identity {displayName, deviceToken}
  → players row + player_credentials row (kind='device')
  → every later request: Authorization: Bearer <token>
                                  ↓
                    plays 12 hands. All of it lands on that player row:
                    match_players, hands, rating_history, R2 log blobs.
                                  ↓
                          taps "Sign in"  (§5)
                                  ↓
      three columns written on the SAME row. Zero rows move. Nothing transfers,
      because nothing needs to.
```

The display name is asked for **once, inline, on the way into the first match** — not on a
separate screen, and never before the mode has been chosen. A guest who declines gets a
generated seat name.

### 4.2 What a guest can do

Everything on the P0 screen map (`sketches/PAGE-INVENTORY.md`): quick match vs bots, create a
table, join by code, results, match history, hand review, replay, share-replay links, and a
**provisional rating** — which `DESIGN.md` §3 already labels unofficial and resettable.

What a guest cannot do, and why:

| Not available to a guest | Reason |
|---|---|
| Play on a second device as the same identity | The credential is the identity; a second device is a second player row until an account joins them (§6) |
| Recover from a cleared browser or a lost phone | There is nothing to recover *to*. This is the honest pitch for signing in |
| Room-scoped matches (P1) | Room membership and roles live in the Almanac's `room_members`, keyed on `users.id` (G6) |
| The official ladder (P1) | A device token is trivially re-mintable per browser, so an unlinked identity cannot hold a ladder position (G5) |

### 4.3 The hole: a shared phone

Four friends passing one phone all play under one device token, so one player row accumulates
four people's hands. If one of them later signs in, they inherit the lot.

This is the game's weakest identity claim and it should be stated rather than discovered.
Mitigations, in order of cost:

1. **"Not you? Start a new player"** on the results screen and in the header menu. Mints a
   fresh token and a fresh player row; the old one is untouched and still reachable from the
   old token if it was kept. One button, P0, do it.
2. At invite-only alpha scale the case is rare and the rating is provisional anyway.
3. It is bounded by §6.5: a merge never rewrites the log, so a wrongly-attributed player row can
   be unlinked without touching a single event.

Do **not** solve this with a per-match "who is playing?" prompt. It is friction on the hot path
to protect a number that P0 explicitly calls resettable.

### 4.4 Guest names are never identity

A guest types any 40 characters they like, including someone else's name. This is the Almanac's
P2 problem (`ACCOUNTS-BUILD-SPEC.md` §2) arriving by a different door, and it gets the same
answer as §8.5 there:

- **The typed name renders plain.** No badge, no link, no profile.
- **A linked player renders the handle as an adjacent badge**, resolved at read time through the
  account, linking to `/almanac/u/{handle}`.
- The badge — not the name — is the only identity signal anywhere in the game UI.
- `players.display_name` is **not** the Almanac handle and never becomes one. The schema
  comment already says so; keep it true.
- No uniqueness constraint, no name reservation, no impersonation reporting at P0.
  `DESIGN.md` §5.3 defers moderation tooling to open registration and that still holds.

---

## 5. How Google reaches the game

### 5.1 The finding that settles this: cookies cannot be shared

`ACCOUNTS-BUILD-SPEC.md` §6.2 sets the session cookie as `__Host-mjrc_session`. The `__Host-`
prefix forbids a `Domain` attribute, so the cookie is sent **only to the exact host that set
it**. Not to a subdomain. Not to `game.mahjongresearch.com`, and certainly not to a separate
consumer domain if the brand forks (`DESIGN.md` §3, Track A).

**There is therefore no implicit single sign-on between mahjongresearch.com and the game,
under any hosting arrangement, and none should be manufactured by weakening the cookie.** The
`__Host-` prefix is doing real work; widening it to `Domain=mahjongresearch.com` to get SSO
would hand the session to every present and future subdomain, which is a strictly worse trade
than one redirect.

The handoff must be explicit. Two ways to make it explicit:

### 5.2 Option A — link-token handoff (recommended default, G1)

The game never implements OIDC. mjrc-app owns the entire Google relationship.

```
1. game client (holds device token)
     POST /api/identity/link/start        →  game Worker
     ← link_state = HMAC({playerId, exp}, LINK_STATE_SECRET)
        No table. Same trick as mintReplayToken: a signed capability, not a stored row.

2. redirect to
     https://mahjongresearch.com/api/auth/google/start?next=/link-game%3Fs=<link_state>
        mjrc-app runs §6.2's flow exactly as specced. The game sees no code, no
        id_token, no client secret.

3. /link-game (mjrc-app, signed in): an EXPLICIT confirmation screen.
     "Link your game identity to @handle?"  — and if a merge will occur, it says
     what will happen, in numbers: "12 hands played on this device will be added
     to @handle." (§6.3)
     On confirm mjrc-app mints a ONE-TIME ticket bound to {users.id, link_state}.

4. redirect back to the game with ?ticket=…
     game Worker redeems it against mjrc-app, gets {userId}, then verifies:
       - the ticket is unspent and unexpired
       - link_state's HMAC is valid and unexpired
       - the playerId inside link_state matches the caller's own device credential
     then writes the three seam columns, or performs §6.3's merge.
```

Why this is the default:

- **One OIDC implementation.** The `state`/`nonce`/PKCE store, the JWKS cache, the `azp` check,
  and `GOOGLE_CLIENT_SECRET` exist in exactly one codebase. Two implementations means two
  chances to skip nonce validation.
- It is the codebase's existing idiom — a one-time token redeemed by exactly one consumer, the
  same shape as `{table_id, seat_token, match_uuid}` (`DESIGN.md` §5.3).
- Binding `link_state` to the requesting `playerId` means a ticket lifted out of a redirect
  cannot be redeemed by another device.
- The confirmation screen is not ceremony. Linking is the moment a machine-witnessed history
  attaches to a named person; it should be an act, not a side effect.

Cost: the sign-in button visibly bounces through mahjongresearch.com. At alpha that is fine and
arguably correct — "Sign in with your MJRC account" is what is actually happening.

**Verify before building:** the game Worker → mjrc-app redemption call wants a Cloudflare
service binding rather than a shared secret. Whether a Pages Functions project can be the
target of a service binding has changed over time — check current Cloudflare docs, do not
assume. Fall back to a rotated shared secret in an `Authorization` header if it cannot.
Rate-limit `/api/identity/link/*` and the redemption endpoint at the edge, as §6.2 does for
`/api/auth/*`.

### 5.3 Option B — the game runs its own callback

Second authorized redirect URI on the same Google client ID; the game runs §6.2's flow itself
and resolves `google_sub → users.id`. One less redirect, and it is the right answer if the
brand forks to a domain that should not visibly depend on mahjongresearch.com.

The cost is real: a second OIDC implementation, a second copy of the client secret, a second
`state`/`nonce` store in a Worker that currently holds no state at all, and a decision about
which side owns the `users` upsert — because two writers on `users` keyed by `google_sub` is a
race waiting to happen.

**Recorded default: Option A.** Revisit if and only if the brand fork lands and the redirect is
judged unacceptable.

### 5.4 Sign-in does not replace the device token

After linking, the game still authenticates every request with the bearer device credential.
Consequences worth stating because they are counter-intuitive:

- **Revoking the game's Google access does not lock anyone out of the game.** Losing the device
  token does.
- **The game has no sign-out**, because it has no session. It has *revoke this device*
  (`player_credentials.revoked_at`) and *unlink account* (clear the three seam columns).
- The game D1 **never stores an email address and never stores a `google_sub`.** Its only PII
  is `players.display_name`. That is a deliberate property; keep it.

### 5.5 Recovery is the merge, running forwards

New phone, cleared browser, lost laptop — all one path:

```
mint a token → POST /api/identity → a fresh, empty player row
   → sign in (§5.2) → the account already resolves to a canonical player row
   → the new device credential is repointed at the canonical row
   → the empty row is marked absorbed
```

Recovery and second-device linking are the same code. Build it once.

---

## 6. The merge

### 6.1 The common case is not a merge

A guest plays 12 hands and signs in. Their hands, their rating, their match history and their
R2 log blobs are all already on one `players` row, keyed by `players.id`, which does not change.
Signing in writes `almanac_user_id`, `almanac_link_source='sign_in'`, `almanac_linked_at`.

**Nothing transfers. No row moves. There is no merge.** That is the whole P0 handoff, and it
works because identity was a durable row from the first hand instead of being conjured at
sign-in. Build this case first; it covers nearly everyone.

### 6.2 Why the game merge is safe where Almanac adoption is not

`ACCOUNTS-BUILD-SPEC.md` D2 forbids an account from adopting a legacy Almanac session, while
§6.6 makes merge-on-first-sign-in mandatory. Those are not in tension — they are different
objects, and the difference is the whole argument.

| | Almanac session (D2 — adoption refused) | Guest game player (merge permitted) |
|---|---|---|
| What the credential proves | **Write access to a shared artifact.** The edit token is *deliberately shareable* — that is how a second phone scores today | Continuous possession of one client. Nothing in the product ever asks for it, displays it, or speaks it aloud |
| Who the credential identifies | A *set* of holders, not a person | The device that minted it and has presented it since |
| Who else has a claim | Up to four humans at that table, plus anyone the code was shared with. First-signer-wins is a land grab | Nobody. There is no second party whose claim gets extinguished |
| What the record asserts | A **human typed a name and typed a result.** "Augustine, 5 faan" is an assertion by whoever held the phone | Nothing was asserted. The server generated the wall from its own seed, authenticated the seat at the socket, adjudicated every claim, computed every faan, and wrote every event |
| Can it be wrong? | Yes, and silently — mistyped faan, a session that did not happen, a voided hand | Only if the engine is wrong, in which case it is wrong identically for everyone and is replayable from the pinned `engine_version` |

Put plainly: **adopting an Almanac session means taking over someone's claim about the past;
merging a guest player means attaching a name to facts the server itself produced.** The first
requires arbitration between competing claimants, which is why D2 routes it to a revocable
session grant instead. The second has one claimant by construction.

The honest caveats, both already handled above:

- A device token is only *unshared by design*, not unshareable. It can be lifted out of local
  storage exactly like a session cookie. The mitigation is revocation
  (`player_credentials.revoked_at`), not secrecy, and it is the same mitigation the Almanac
  uses for `auth_sessions`.
- The shared-phone case (§4.3) is the one place where a guest player row really does contain
  more than one person. It is bounded, it is cheap to opt out of, and no merge rewrites
  anything, so it is reversible.

### 6.3 The second-device case — the actual merge

The merge branch fires when the account is **already linked to a different `players` row**.

**Rule zero, and it is an invariant: a `players.id` never changes, and nothing that keys on it
is ever repointed.** Annotating a row with `merged_into` is fine; moving a match to a different
player is not. `match_players`, `hands`, `rating_history` and the R2 log blobs all key on
`players.id`, and the log is immutable — `DESIGN.md` §5.5 pins `engine_version` precisely so
that history is never rewritten. `UPDATE match_players SET player_id = …` would corrupt the
research corpus and break replay, permanently and silently. It is the same failure mode as
letting cosmetics into the log (§9).

So the merge is an **indirection**, exactly as `player_links` is an indirection in the Almanac.
One additive migration:

```sql
-- worker/migrations/0002_player_merge.sql
-- An account may resolve to several player rows over time — one per device that
-- played before it was linked. Rows are never rewritten (the event log keys on
-- players.id and is immutable), so absorption is a pointer, not a rewrite.
ALTER TABLE players ADD COLUMN merged_into TEXT REFERENCES players(id);
ALTER TABLE players ADD COLUMN merged_at   TEXT;

CREATE INDEX idx_players_merged
  ON players(merged_into) WHERE merged_into IS NOT NULL;
```

The merge, as one `batch()`:

1. Choose the **canonical** row: the one with the most `rating_games`; ties broken by earliest
   `created_at`. (G3.)
2. `UPDATE player_credentials SET player_id = <canonical> WHERE player_id = <absorbed>` — the
   *credential* moves. It holds no history, so moving it costs nothing.
3. `UPDATE players SET merged_into = <canonical>, merged_at = ? WHERE id = <absorbed>`.
4. Ensure the three seam columns are set on the canonical row.

Repointing the credential rather than walking `merged_into` at authentication time is a
deliberate denormalization: `playerForCredential` stays **one indexed lookup on the hot path**,
and `merged_into` is read only by career aggregates.

Absorbed rows stop being seatable — `POST /api/tables/:code/join` resolves the credential to
the canonical row and cannot reach an absorbed one. Career queries widen by one clause:

```sql
WHERE player_id IN (SELECT id FROM players WHERE id = ?1 OR merged_into = ?1)
```

**Exactly what transfers:**

| Thing | Transfers? | How |
|---|---|---|
| Hands played, per-hand rows | **Yes**, by reference | `merged_into`; no row is rewritten |
| Match history list | **Yes** | career queries union canonical + absorbed |
| R2 event log blobs | **Yes**, by reference | blobs are immutable; the player id inside them stands forever |
| Device credential | **Yes**, literally moved | `player_credentials.player_id` repointed |
| Cosmetic selections | **Yes** | account-scoped, rendering only (§9) |
| Display name | **No** | the canonical row's name wins; the absorbed name stays as history on its own row |
| **Rating** | **No** — see §6.4 | the canonical row's rating stands |
| `rating_history` rows | **No** — retained, readable, not fused | |
| Room membership, roles | N/A | lives in the Almanac, keyed on `users.id` |

The UI must state the outcome **before** the merge, in numbers ("12 hands played on this device
will be added to @handle") — §5.2 step 3. A merge is hard to explain afterwards.

Because nothing is rewritten, a merge is **reversible**: null the two columns, repoint the
credential back. That is a property worth protecting; it disappears the moment anyone
"optimizes" this into an `UPDATE match_players`.

**One edge case to handle explicitly:** if the same person held two seats in one match from two
devices — possible at a private table, and not worth preventing at the engine level — then after
a merge that match appears twice in the account's career count. Deduplicate career aggregates by
`match_id`, not by row. It is a `COUNT(DISTINCT match_id)` and it is easy to forget until a
leaderboard looks wrong.

### 6.4 Rating does not fuse, and that is not laziness

There is no defined merge operator for a rating. Averaging two ratings does not produce a
rating. Recomputing is possible in principle — `players.rating` is an explicitly derived cache
and `rating_history` is canonical, so a rating *is* a fold — but the opponents' ratings in both
histories were computed against the **unmerged** pool, so a sound recompute is a pool-wide
recompute, not a per-player one.

The recorded default (G3): the canonical row's rating stands; the absorbed history is retained
and readable and stops accruing; **career counts union across the set but rating does not**, and
the profile says so. Yes, that means a profile can read "42 matches" beside a rating built on
30 of them. Label it, exactly as `ACCOUNTS-BUILD-SPEC.md` D3 requires the Almanac to label
viewer-dependent totals.

The cost is bounded by timing: P0 rating is provisional and explicitly resettable
(`DESIGN.md` §3), and the P1 official ladder reseeds. Get this slightly wrong now and it costs
nothing; get it wrong at P1 and it is a ladder integrity problem.

### 6.5 The three things a merge must never do

1. **Rewrite the event log, or any row that keys into it.** Not `match_players`, not `hands`,
   not the R2 blob. Ever.
2. **Move a rating between rows.** See above.
3. **Reach into `mjrc-scoring`.** The game writes its own three seam columns and nothing else.
   An `admin`-sourced link is fixed by the owner and audited on the Almanac side as
   `ACCOUNTS-BUILD-SPEC.md` §5.7 requires; a `sign_in` link is self-documenting via
   `almanac_linked_at`.

---

## 7. Trust ranking — the game slots in at the top

### 7.1 The amended table

`ACCOUNTS-BUILD-SPEC.md` §8.2 ranks link sources by trust. The game is a new source, and it goes
above `roster`:

| Source | Mechanism | What was asserted, and by whom | Trust |
|---|---|---|---|
| **`game`** *(new)* | seat authenticated at the socket against `player_credentials`; the engine decided the outcome; `players.almanac_user_id` set by sign-in | **nothing was asserted.** The server witnessed it | **machine-witnessed, exact by construction** |
| `roster` | `room_players.user_id` claimed once; sessions in that room reuse those `player_id`s | one human said "this roster slot is this account", in advance | exact by construction |
| `scorekeeper` | edit-credential holder assigns a seat to a handle | a human, about another human | high |
| `self_confirmed` | user clicks "this is me" → `pending` → approved | a human, about themselves, unverified | medium |
| `admin` | owner fixes it | audited | — |

### 7.2 Why it outranks `roster`

`roster` is exact *given* that the roster entry was right. Its exactness is **inherited from one
prior human assertion** — someone typed a name into a roster and attached an account to it, and
every session in that room inherits whatever that person got right or wrong.

The game's is inherited from no assertion at all. The identity chain is: a credential presented
per request → a seat token minted for one seat in one match → an authenticated socket → events
the reducer emitted. Nobody typed a name, nobody typed a result, and the whole chain is
replayable from a seeded wall and a pinned `engine_version`.

That is a different *kind* of confidence, not a higher grade of the same kind, and it is why the
row sits above `roster` rather than beside it.

### 7.3 What it unlocks: the mixed room

A room already means "join code + pinned ruleset + roster + N tables"
(`sketches/PAGE-INVENTORY.md` §3). A room containing **both** online matches and offline Almanac
sessions, under one roster, is **the only context in the entire product where comparing the two
is statistically defensible.**

The reason is identity, not statistics: on both sides, a seat resolves to an account *by
construction* — `roster` on the Almanac side, `game` on the game side — rather than by matching
a typed string. Everywhere else in the product, the offline half of any comparison is
name-grouped and fuzzy, so the comparison inherits the fuzziness and hides it inside a number.

Concretely, inside a room, these become answerable and honest:

- Does this player's online deal-in rate track their offline one?
- Is the room's mean winning faan the same at physical tables and online, under the same pinned
  ruleset?
- Did the player who improved online improve at the table?

Everywhere else, and even here, **compared side by side — never unioned** (§8).

### 7.4 What it does not unlock

The game does **not** write `player_links` rows. That table keys on `(session_code, player_id)`
and references `games(code)` — an Almanac session, meaning a physical table someone scored by
hand. An online match is not one of those and has no `session_code`.

Writing online matches into `games` to obtain links would put machine-witnessed data into the
hand-typed ledger and would make the union in §8 happen **by accident**. The reference direction
is one way and stays one way:

```
mjrc-game.players.almanac_user_id  →  mjrc-scoring.users.id
```

If the Almanac wants to show "this account also plays online", it asks the game Worker over HTTP
for that account's online record and renders it as its own labelled block. `source = 'game'`
enters the §8.2 *vocabulary* only if the Almanac decides to display game-derived links in the
same list — a UI decision, not a data one (G7).

---

## 8. What stays separate

Online and offline share an **identity**. They never share a **number**.

`ACCOUNTS-BUILD-SPEC.md` §8.3 states the principle in its own scope: unverified linking turns
*honestly fuzzy* stats into *confidently wrong* ones. Unioning the two records is that failure
with the direction reversed — it applies the weakest link's uncertainty to the strongest data
and then prints one number.

The five reasons, compressed from `worker/README.md` §7:

| | Why not |
|---|---|
| **Provenance** | An Almanac row is a human assertion about a physical table; a game row is machine-witnessed and replayable. Averaging the two averages a measurement with a claim |
| **Rules** | Almanac sessions run whatever house ruleset was on the table that night, often unrecorded. Game matches run one archived `ruleset_hash` with an enforced minimum and limit. "Mean winning faan" is not the same quantity under two payment tables |
| **Sample shape** | A game match is one wind round 東圈 with every hand, every tile and every decision timestamped. An Almanac session has variable length, no tiles, no wall, no per-decision data. A rate over the union is weighted by whichever source logged more |
| **Rating validity** | Elo assumes a closed pool under enforced rules. Hand-typed results make it unfalsifiable and trivially inflatable — anyone can type a session in which they won ten hands. **The ladder covers online matches only, and that is not a limitation to be fixed later** |
| **Identity confidence** | The Almanac ranks link sources precisely because identity there is uncertain. The game's is exact. Do not launder one into the other |

**The enforcement is architectural, not a code review rule.** `mjrc-game` and `mjrc-scoring` are
separate D1 databases. D1 has no cross-database join, so the union that must never happen
**cannot be written by accident**. That is the point of the two-database choice, and it is the
reason to confirm it before the first remote apply rather than after (`worker/README.md` open
question 1).

The display contract, wherever both appear:

- Two blocks, two labels: **Online** (machine-witnessed) and **At the table** (scorekeeper-recorded).
- No combined rating. No combined match count. No combined "career faan".
- **No combined lifetime chip total, specifically.** `DESIGN.md` §9 holds the gambling-adjacency
  line — chips are points — and a lifetime chip figure spanning real tables and online play
  reads like a bankroll. It should not exist in any view, for any viewer, including the owner
  console.

---

## 9. Cosmetics never touch the engine

This is the architectural rule that most often gets broken by an account system, because
cosmetics look like account state and account state looks like something worth logging.

**The engine is a pure reducer and the client is disposable by design** (`DESIGN.md` §5). Tile
art, avatars, hand models, expressions, table surfaces and call audio are **purely a rendering
concern**. They must never touch:

- the engine (`engine/`),
- the reducer's state or its emitted events,
- the protocol event schema (`protocol/`),
- the event log in R2, or any column in `hands` / `match_players`.

The log records **"tile 18 was discarded"**. Never "tile 18 in the jade set was discarded by the
fox avatar". If a cosmetic identifier ever lands in the log:

1. the research corpus is polluted **forever** — the log is append-only and immutable by design;
2. replay breaks the day a cosmetic is retired, because replay is *re-execution* and the
   renderer would be asked for an asset that no longer exists;
3. `engine_version` pinning stops being sufficient, because the log now depends on an asset
   catalogue that is not versioned and never will be.

**This is non-negotiable.** The correct seam already exists: `MatchScene`
(`sketches/RENDERING.md` §7) takes `SeatView` and `GameEvent` and decides everything visual on
its own side of the boundary. A cosmetic selection is an input to `mount(el, opts)`, not a field
on an event.

Where cosmetics *do* live: **game-side account state** — a row per player in the game D1,
resolved at render time and carried in the merge (§6.3). Not in `mjrc-scoring`, which has no
business knowing what a player's tiles look like.

**The Google `picture` interaction, since it looks like a conflict and is not.**
`ACCOUNTS-BUILD-SPEC.md` §5.6 stores no `avatar_url` because Google's `picture` is a hotlinked
Google-hosted image that leaks a referer on every public page view. The game wants avatars.
These do not collide, because they are different objects:

| | Google `picture` | Game avatar |
|---|---|---|
| What it is | a profile photo of a person, hosted by Google | art we own, drawn in the `mjrc-admin/art/` direction |
| Who controls it | Google and the user's Google account | us |
| Lifecycle | changes without notice, can 404 | versioned assets in our build |
| Where it appears | nowhere in MJRC, by decision | the match scene and the profile |

So: **the game never stores, hotlinks, or displays a Google profile photo**, and the avatar is
never a photograph of anyone. Both decisions point the same way and reinforce each other.

The positioning constraint that governs the roster (`DESIGN.md` §1): **cosmetics are not gacha.**
Avatars, hand models and tile sets are fine *provided they are chosen or earned by playing,
never randomised paid pulls.* Super Smash Bros is the reference — a roster with personality,
unlocked by playing. Riichi City and Mahjong Soul are the anti-reference; that lane is taken and
unwanted. `sketches/PAGE-INVENTORY.md` already rules out the Mail/rewards screen on exactly
these grounds, because that screen is the gacha economy's plumbing. Anything in an accounts
system that starts to look like an inventory, a currency, or a pull needs to stop at this
paragraph. Detail lives in `PRESENTATION.md`.

---

## 10. Mainland China

**Google is unreachable from mainland China** (`ACCOUNTS-BUILD-SPEC.md` §3). Stated here so it
is a known constraint rather than a discovery.

For an HK and diaspora audience this is largely fine, and the game's position is **stronger than
the Almanac's**, because guest play is not a degraded fallback — it is a permanent, first-class
mode. Without Google, a player on the mainland can still: play every P0 mode, hold a rating,
create and join tables, review every hand, and share replays. A device token is a complete
identity.

What is lost without Google: cross-device continuity, account recovery, room-scoped matches
(G6), the official ladder (G5), and the handle badge.

If that ever becomes a real constraint for a real person, the options in order of cost are:

1. **Passkeys** — `player_credentials.kind = 'passkey'` already exists in the schema, and a
   platform authenticator involves no Google round trip. This is the cheapest real answer.
2. A second OIDC provider. More code, more `users` upsert paths, and it reopens §5.3's
   two-writers problem.

**Build neither now.** Note the constraint, ship guest play, and revisit when a named user needs
it (G2).

---

## 11. Sequencing

### P0 — already built, no blockers

Device token, display name, guest play. `POST /api/identity` and `authenticate()` exist. The
only additions are the **"Not you? Start a new player"** affordance (§4.3) and the display-name
rendering rule (§4.4). Both are client work measured in hours.

**P0 is not blocked by D8.** The Almanac's privacy policy blocks *its* Phase 2 because that
phase introduces the site's first PII. The game's P0 introduces no data class the site does not
already collect: the game D1 holds a freeform display name (the Almanac already accepts freeform
typed names on public surfaces today), a token digest, and match records. No email, no
`google_sub`, no cookie, no third-party call.

### P1 — sign-in, and the chain that gates it

```
D8 (privacy policy — AUGUSTINE WRITES IT, NOT AN AGENT)
  └─→ Almanac Phase 2  (0008_accounts.sql, OIDC endpoints, /api/auth/me, merge-to-grants)
        ├─→ mjrc-app /link-game + ticket endpoints        ← NEW mjrc-app work, §5.2, not in
        │                                                    ACCOUNTS-BUILD-SPEC's phase list
        └─→ game sign-in + link + merge (§5, §6)
              └─→ 0002_player_merge.sql (game D1)

Almanac Phase 3  (0009_roles.sql — room_members, roles)
  └─→ room-scoped matches in the game (matches.room_code already exists)
        └─→ the mixed-room comparison of §7.3

Official ladder (P1, DESIGN.md §3)
  └─→ requires sign-in (G5) and a settled merge rating rule (G3)
```

Read that as four statements:

1. **D8 blocks game sign-in**, transitively. It is the critical path and only Augustine can
   clear it.
2. **The `/link-game` handoff is new mjrc-app work that no existing phase covers.** Add it to
   Almanac Phase 2's scope or it will be discovered late, as a surprise dependency, by whoever
   builds the game client.
3. **Game rooms wait for Almanac Phase 3**, because room membership lives in `room_members`.
   Nothing in the game should reimplement roles.
4. **The official ladder waits for both**, because an unrecoverable, freely re-mintable identity
   cannot hold a ladder position.

Independent of all of the above, and buildable now: the merge migration, the canonical-row
selection rule, and the career-aggregate query shape. They are pure game-side work.

### Later

Passkeys (§10, G2). Cosmetic ownership (§9, `PRESENTATION.md`). Public game profiles beyond the
`/almanac/u/{handle}` badge.

---

## 12. Open decisions

Numbered `G` so they never collide with `ACCOUNTS-BUILD-SPEC.md`'s `D1`-`D8`. Each has a
recorded default so nothing is blocked on taste; the two marked **gate** need Augustine's word
before the code that depends on them ships.

**G1 — How Google reaches the game.** *Default: Option A, the link-token handoff (§5.2) — the
game never implements OIDC.* Alternative: the game runs its own callback (§5.3), which is the
right answer if the brand forks to a domain that should not visibly depend on
mahjongresearch.com. **Gate:** decides whether `/link-game` lands in Almanac Phase 2.

**G2 — Does Google supersede passkeys as the game's account credential?** *Default: yes. Defer
passkeys indefinitely; revisit when a named user needs one.* This **amends `DESIGN.md` §3**,
which lists P1 as "real accounts (passkeys)", and **answers `worker/README.md` open question
2**. `player_credentials` already has the shape, so deferring costs nothing and building early
buys nothing. Note this does not contradict `ACCOUNTS-BUILD-SPEC.md` §6.4's refusal to build
WebAuthn: that refusal is about second factors *on top of* Google, and this is about a primary
credential *where Google is unavailable*. Different question, and it stays deferred either way.

**G3 — Rating on merge.** *Default: the canonical row's rating stands; absorbed `rating_history`
is retained, readable and unfused; career counts union, rating does not, and the profile labels
it (§6.4).* Canonical = most `rating_games`, tie broken by earliest `created_at`. Open at P1:
whether a merge triggers a pool-wide recompute once the official ladder exists. **Gate before
the first rated match settles.**

**G4 — Who owns handles.** *Default: the Almanac, entirely (`ACCOUNTS-BUILD-SPEC.md` §6.3).* The
game never mints, validates or caches a handle; it resolves one at read time and renders it as a
badge. A cached handle goes stale silently (D7 makes handles changeable) and is PII sitting in a
second database for no reason.

**G5 — Is an unlinked player eligible for the ladder?** *Default: provisional rating yes at P0
(it is per-player-row and explicitly resettable); the P1 official ladder requires an account.*
A device token is re-mintable per browser, so an unlinked identity is a free smurf.

**G6 — Do room-scoped matches require an account for every seat?** *Default: yes.* Room
membership and roles live in `room_members`, keyed on `users.id`. Guests keep ad-hoc matches and
join-by-code, which is the whole of P0 anyway.

**G7 — Does `source = 'game'` enter the Almanac's §8.2 vocabulary?** *Default: only if the
Almanac chooses to display game-derived links in the same list.* The data direction stays one
way regardless (§7.4). This is a UI decision on the Almanac's side, not a schema decision on the
game's.

**G8 — One database or two.** Restated here because it is upstream of §8's enforcement, and it
is `worker/README.md` open question 1. *Default: two.* One would buy real foreign keys to
`users(id)`; two make the forbidden union structurally impossible. **Confirm before the first
remote apply — afterwards it is a data migration.**

---

## 13. Do not "fix" these

Deliberate choices that read as defects:

- **Sign-in does not replace the device token.** The game's per-request credential is always a
  row in `player_credentials`; Google links, it does not authenticate (§5.4).
- **The game has no sign-out**, because it has no session. It has "revoke this device" and
  "unlink account".
- **The game D1 stores no email and no `google_sub`.** The only PII is `display_name`.
- **`players` rows are never merged, rewritten or deleted** — absorbed rows keep their history
  and their id forever (§6.3). An `UPDATE match_players SET player_id` is corpus corruption.
- **A profile can show more matches than its rating was built on.** Correct behaviour under G3;
  label it, the way the Almanac labels viewer-dependent totals under D3.
- **Career aggregates cost one extra `IN (SELECT …)` clause** rather than a denormalized
  `account_id` column. The hot authentication path stays one indexed lookup; the cold path pays.
- **The game does not write `player_links`.** Not a gap — §7.4.
- **Guest display names have no uniqueness constraint.** Impersonation is answered by the handle
  badge, not by name reservation (§4.4).
- **`players.almanac_user_id` has no foreign key.** D1 has no cross-database references, and
  none is wanted (§8).
- **The sign-in button bounces through mahjongresearch.com** under G1's default. That is the
  `__Host-` cookie doing its job (§5.1), not a routing bug.

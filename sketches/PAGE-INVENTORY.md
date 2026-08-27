# MJRC Game — page inventory (brainstorm, 2026-08-26)

Working list of every screen the game plausibly needs, tiered. **P0** = on the critical path
to a rated, logged, replayable hand. **P1** = after the gate. **Later** = real, not now.
**No** = ruled out by DESIGN.md §1, permanently.

Structural change from the current sketch: **persistent header bar**, not a left nav rail.
Identity, rating, room context and settings live in the header on every screen; the body
below it changes. That is the pattern both references use and it survives all three form
factors.

---

## 1. Auth & identity

| Screen | Tier | Notes |
|---|---|---|
| Logged-out landing | P0 | What the shared-replay link drops strangers onto. Doubles as the marketing surface. |
| Sign in — Google OIDC | P0 | `ACCOUNTS-BUILD-SPEC` §6.2. Already specced; do not invent a second auth path. |
| Play as guest | P0 | Device token, §5.4. The friction-free path into a first hand. |
| Handle creation | P0 | §6.3. Changeable, old handle retained (D7). |
| Guest → account merge | P0 | **Needs a decision.** §6.6 makes merge-on-first-sign-in mandatory, but D2 says a legacy Almanac session cannot be adopted. Guest *game* history is a different case: it is machine-witnessed, so merging it is safe in a way adopting a typed-name session is not. Write this down before building. |
| Consent / privacy | P0 | D8 blocks Phase 2 and says **Augustine writes it, not Claude**. |
| Account settings | P1 | Passkeys, linked identities, delete account. |

## 2. Home

| Screen | Tier | Notes |
|---|---|---|
| Home / lobby | P0 | Rating card, a **short** stats strip, mode buttons, updates feed. |
| Updates / patch notes | P0 | Cheap, and it is what makes a live game look alive. Static content, near-zero client work. |
| Notifications | P1 | Only once there is something to notify about. |
| Mail / rewards | **No** | This is the gacha economy's plumbing. §1 rules it out. |

The stats strip on Home should be **three numbers, not a dashboard** — rating, hands played,
win rate. The dashboard is its own screen; putting it on Home is how lobbies rot.

## 3. Play — modes & tables

| Screen | Tier | Notes |
|---|---|---|
| Quick match vs bots | P0 | The only mode that works at zero population. |
| Quick match vs players | P1 | Honest note: with an invite-only alpha this is a button that spins forever. Needs bot-backfill-after-N-seconds or it is worse than not shipping it. |
| Create table | P0 | Ruleset preset, match length, **time control**, seats. |
| Join by code | P0 | §5.3 — codes ≥6 chars, per-IP rate limit. |
| My rooms | P1 | List of rooms you belong to. |
| Room detail | P1 | Roster, pinned ruleset, tables, room leaderboard, recent sessions **both online and offline**. |
| Room admin | P1 | Rule config, roster management, invites, roles. Reuses `room_members` + roles. |
| Tournament / series | Later | `scoring-domain-model.md` explicitly says **Series: do not build yet**. |
| Spectate | P1 | §3 cuts live spectating from P0. |

**Rooms are the offline↔online join.** A room already means "join code + pinned ruleset +
roster + N tables." A room that contains both Almanac sessions and online matches, under one
roster, is the only context where comparing the two is defensible — because roster identity
is exact by construction (§8.2) rather than fuzzy name-matching.

## 4. Match

| Screen | Tier | Notes |
|---|---|---|
| Match scene | P0 | See §6 below on dimensionality and the clock. |
| In-match menu | P0 | Sound, concede, disconnect state. Minimal. |
| Results | P0 | §2 — ceremony first, detail second. |
| Report player | P1 | §5.3 defers moderation tooling to open registration. |

## 5. Review & data — *the part that matters most*

Renaming this area is the point. Today the sketch calls it **Replays**; it should be
**Review**, with the replay as one tab inside it rather than the headline.

| Screen | Tier | Notes |
|---|---|---|
| Match history | P0 | List. Filterable by room, ruleset, opponent. |
| Match detail — hand list | P0 | Every hand in the match, outcome, faan, chip delta. |
| **Hand review — move by move** | P0 | The decision timeline. Each of your draws/discards/claims as a row, with what was known at that moment. |
| Key moments | P0 | **Rule-derived annotations only** — dealt into a win, melded below the 3-faan floor, passed a legal winning claim, discarded a tile already seen three times. No theory needed; these are facts in the log. |
| Move classification | Later | Chess.com's Best/Inaccuracy/Mistake/Blunder. **Blocked on the route evaluator that does not exist** (§7). |
| Accuracy score | Later | Same dependency. |
| Win-probability graph | Later | The eval bar. Same dependency, plus it needs simulation baselines from Track R. |
| Stats — offline vs online | P1 | Side by side, never blended. |
| Leaderboards | P1 | Global, seasonal, and **per-room** — the per-room one is the useful one early. |
| Public profile | P1 | |
| Replay viewer | P0 | Keep it, demote it. Forward-step, omniscient. |

**The sequencing that makes this cheap:** build the review *shell* now with rule-derived
annotations, and the classification layer slots into the same UI later when the evaluator
exists. Pinned `engine_version` means it runs retroactively over every hand ever logged.
You do not need the analyser before you start collecting.

## 6. Two design questions this raises

### Dimensionality
§5 already plans "portrait PWA shell + SVG match scene" at P0 and a "full-craft WebGL scene"
as the endgame, with the client explicitly **disposable by design**. So 3D is not a new
ambition — it is the planned end state. Pulling WebGL into P0 buys feel at the cost of the
one thing §5 says is replaceable.

Cheap middle ground, all of it CSS/SVG:
- **A visible wall that depletes.** Wall count drives push/fold decisions in HK more than in
  Riichi. Today it is a number in the top bar; it should be a physical thing shrinking.
- **Tile thickness** — a side face on each tile reads as 3D for a few pixels of gradient.
- **Perspective on the discard pools** — rows receding slightly toward each seat.
- **Melds rotated** to show the claimed tile's source seat.

That is most of the "it feels like a table" for a small fraction of a WebGL rebuild.

### The clock — and a real constraint on "mahjong bullet"
Worth taking seriously; it is a genuine differentiator and nobody in HK mahjong has done it.
Both references already ship a base clock + time bank (~5s + 20s), so the mechanism is proven.

**The constraint:** §5.2 requires a *fixed minimum* claim window so response timing never
leaks who is holding a claim. A variable clock that ticks during claim windows breaks that —
a player who takes 4s to pass has just told the table they had something.

**Resolution: the clock charges only your own-turn discard decisions.** Claim windows stay
fixed-length and free. That preserves the no-leak property and still gives real time pressure,
because discards are where the thinking actually is. Time controls then become a table
setting: Standard / Rapid / Bullet.

---

## 7. Rough count

P0 is roughly **18 screens**, up from 12 — the additions are auth (5), updates, room-aware
home, and the review surface (3). Every one of the new ones is either cheap static content or
a view over the event log that already exists. None of them touch the engine, which is where
the 2-3 week core sits.


---

## 8. Input & hotkeys

Desktop app and iPad-with-keyboard make this worth designing rather than bolting on. It is
also the accessibility story — a keyboard-only player should be able to play a full hand.

**Two rules matter more than the specific bindings.**

**1. Action-bound, never position-bound.** Call buttons appear and disappear depending on what
is legal, so "key 1 = leftmost button" would mean a different action every window. `P` is
always pong whether or not pong is on offer, and a key with no legal action does nothing —
it never falls through to something else.

**2. The win keys are nowhere near the pass key.** Under a fixed 5s claim window, fumbling
Pass when you meant Ron is unrecoverable and will lose someone a limit hand. `R`/`T` sit far
from `Space`/`Esc` on every layout.

`Space` is "do the neutral thing" in every context: on your turn it discards the tile you just
drew, in a claim window it passes. Both are the no-change action, so the mental model holds.

| Key | Match |
|---|---|
| `Space` | Discard drawn tile · or pass a claim |
| `←` `→` | Move hand selection |
| `Enter` | Discard selected tile |
| `1`-`9` | Jump to hand position (arrows reach 10-13) |
| `C` | Chow 上 — press again to cycle variants |
| `P` | Pong 碰 |
| `K` | Kong 槓 — concealed on your turn, claimed in a window |
| `R` | Ron win 食糊 sik wu |
| `T` | Tsumo self-draw 自摸 zi mo |
| `Esc` | Pass |
| `A` | Toggle auto-pass |

| Key | Review · replay · observer |
|---|---|
| `←` `→` | Step one event |
| `Shift` + `←` `→` | Step ten |
| `Space` | Play / pause |
| `Home` / `End` | Jump to start / end |

`?` opens the overlay anywhere. Live in the sketch — press it.

**Open question:** whether `C`/`P`/`K` should instead be Cantonese-mnemonic, given §7 wants
terminology-first labels throughout. English initials are safer for an English-first audience
and the on-screen buttons already carry both, so the sketch uses English initials with the
Cantonese on the button face.

# From a game to a testable product — proposal v2

Status: **proposal, nothing built.** Written 2026-08-31 for Augustine.
v2 after owner review — see §6 for what changed and why.

Covers: name entry, leaderboard, 1–4 wind games, stats pages, move-quality
tracking, a bots page. **Local only.** No backend, no accounts, no deployment
decision — those come after this works.

Companion: `SPEC.md` (this client's spec of record) · `../../DESIGN.md` §5
(the client is disposable, the engine holds the logic).

---

## 1. Settled by the owner

| question | ruling |
| --- | --- |
| leaderboard forgery | **Not a concern.** Local, private beta; only we write to it. No server verification. |
| accounts | **Ignore `ACCOUNTS-PROPOSAL.md` for now.** Type a name in, move on. |
| deployment / D1 | **Not yet.** Build and prove it locally first. |
| repo structure | **Stay two repos** for now; revisit only if code sharing becomes real (§5). |
| what to store | **The event log**, the detailed one. Do not optimise early. |
| move quality | **A continuous measure of how close a player is to the engine**, not a blunder/brilliance binary. |

---

## 2. Measured facts this design rests on

### 2.1 A 4-wind match is 33–39 hands, and the 3-faan floor is why

The floor is 16 (4 rounds × 4 dealers). Measured over 20 matches per table:

| table | hands per 4-wind match | dealer repeats | of which draws | draw rate |
| --- | --- | --- | --- | --- |
| untrained default | 30.4 (21–39) | 47 % | 30 % | 30 % |
| **mixed** — the game's default | **33.0** (23–45) | 52 % | 33 % | 33 % |
| **sharks** — v4 × 3 | **38.6** (31–47) | 59 % | 45 % | **45 %** |

`16 / (1 − repeat rate)` predicts every row exactly. The mechanism:

1. `mjrc-standard` has a **3-faan minimum**, so many completed hands are refused.
2. A refused hand tends to end 流局.
3. `reducer.ts:631` repeats the dealer on **every** 流局 as well as every dealer win.
4. Stronger bots draw *more*, not less, because they refuse to feed — hence
   sharks at 45 %.

**Estimated wall clock** (from 2,576 actions × 260 ms bot pacing + ~3 s human
decisions + 750 ms call holds): 1 wind ≈ 10–15 min, 4 wind ≈ 50–70 min.

**Open ruling wanted (§7.1):** dealer-repeats-on-流局 is a house rule, not a law.
Passing the deal on a draw would take a 4-wind match from ~38 hands to ~19 and
change nothing else. A third to a half of hands ending in nothing is also a
*fun* problem, not only a length one.

### 2.2 Two of the four match lengths do not exist yet

`engine/src/reducer.ts:105` — `type MatchLength = "oneWindRound" | "fourWindRounds"`;
`protocol/src/events.ts:78` pins the same union; `reducer.ts:641` reads
`target = s.matchLength === "oneWindRound" ? 1 : 4`.

Nothing conceptual — 3 winds is 3 × 1 wind — there is simply nowhere to put a 2.
**Fix:** `rounds: 1 | 2 | 3 | 4`, with the two old strings accepted as aliases so
every existing sim caller keeps working untouched.

### 2.3 Grading every move is free

`rankDiscards` costs **0.07 ms**. A 4-wind game has ~640 human discards → **45 ms
of grading across the entire match.** The coach comes out from behind the
dev-mode flag: grading always runs, and dev mode becomes "show me the reasoning
as I play".

### 2.4 Storage: keep the event log, but not in localStorage

| | event log | action log |
| --- | --- | --- |
| 1 wind | 187 KB (max 301) | 23.5 KB (max 38) |
| 4 wind | 754 KB (max 901) | 93 KB (max 112) |

These are **not** two versions of the same thing:

- The **event log** is the engine's *outputs* — every discard, claim, score,
  chip delta. It is what the stats pages read.
- The **action log** is the *inputs* — what each player chose. Replaying it
  through the reducer regenerates the event log exactly, because the reducer is
  pure and every action is stored, bots' included.

Source versus cache, not small versus detailed. **Store both** — 210 KB per
1-wind game, and the action log means an old game still replays correctly after
the bots are retrained.

The one hard limit: **`localStorage` caps at ~5 MB — about 24 games.** That is a
wall, not an optimisation. **Use IndexedDB** (hundreds of MB), store everything
uncompressed, and stop thinking about it.

---

## 3. What gets built

### 3.1 Identity — a name, and nothing else

- Name-entry screen on first visit. Name + `crypto.randomUUID()` in IndexedDB.
- The uuid is the key so two friends both called "Dave" do not merge; the name
  is a label they can change whenever.
- No auth, no password, no email, no login screen.

Stated plainly on the stats page rather than hidden: history is per-device, and
clearing site data loses it. Correct for a beta, wrong for anything public.

### 3.2 Local store (IndexedDB, database `mjrc-game`)

```
player   { id, name, firstSeen, lastSeen }

match    { id, playerId, rounds, rulesetId, seats[3], seed,
           recorded, startedAt, finishedAt,
           chips[4], hands, won, selfDrawn, fed, drawnHands,
           matchRate, meanGap, movesGraded,
           events[],        // the full event log — the detailed record
           actions[] }      // the inputs, so it can be replayed exactly

move     { matchId, hand, turn, kind, played, enginePick, gap, top1MinusTop2,
           reason }         // one row per graded human decision
```

`move` is derived from `events` + a re-grade, so it can be dropped and rebuilt.
It exists so the stats pages need not re-grade 640 moves to draw a chart.

### 3.3 Move quality — how close do you play to the engine

Per human decision, record what was played, what the engine's top choice was,
and the gap between them in the bot's own scoring units. `rankDiscards` already
returns exactly this; `assessClaim` gives the claim equivalent with a reason.

Two headline numbers per game, both rolling up across games and across players:

- **match rate** — % of turns where you played the engine's top move.
- **mean gap** — average cost of your choices, in the engine's units.

`top1MinusTop2` is stored per move so "obvious" turns can be filtered out: on a
forced move, agreeing with the engine means nothing, and a match rate that
counts them flatters everybody equally and distinguishes nobody.

Honest framing on the page: this measures **agreement with Sifu**, not
correctness. Sifu is a measured-strongest bot, not a solved game, and the model
is still being fixed. The number is "how close to the computer", exactly as
asked — not "how good".

### 3.4 The leaderboard — sort by agreement, not chips

Chips over 8 hands are mostly wall luck: the training work put single-block
noise at **±16 chips**, which is larger than most real skill differences over
one match. Agreement rate is far lower variance.

So: rank by match rate, show chips alongside. Chips are what people care about;
agreement is what actually ranks them. Both visible, no pretending.

### 3.5 The pages

| page | answers | source |
| --- | --- | --- |
| name entry | who is playing | first visit, editable later |
| leaderboard | who plays closest to the engine | all recorded matches |
| all games | how am I trending | my matches over time |
| one game | what happened, move by move | `events` + `move` rows |
| by player | how do we compare | grouped by player |
| the bots | who am I playing, and how do they think | §3.6 |

**Recorded vs casual** is an explicit toggle on the table picker, independent of
length: a recorded game counts for the board and records a forfeit if abandoned;
a casual game stores nothing. Any of 1/2/3/4 rounds can be either.

### 3.6 The bots page

Generated from the ladder JSON, not hand-written, so it cannot drift from the
bots that actually ship: `tools/sim/baseline-v0..v4.json`, `persona-action.json`,
the `experiments.js` ledger, and census numbers from `headtohead.ts` /
`validate-bot.ts`.

Per bot — Bo, Kwan, Ling, Fai, Sifu, Ming — its rung on the ladder, its measured
margin over the previous rung, its census stats, and a playstyle read derived
from its actual dials (high `claimSpeedGain` + low `threatSensitivity` = "claims
early, does not watch the table").

---

## 4. Build order

1. **Engine `rounds: 1|2|3|4`** with back-compat aliases. Smallest; unblocks the picker.
2. **IndexedDB store + name entry + recording.** Event log, action log, and
   always-on move grading. Proves the data model against real play.
3. **Stats pages** — all games, one game, by player.
4. **Leaderboard** over local records.
5. **Bots page**, generated from the ladder JSON.
6. *(later, separate decision)* backend, deployment, repo structure.

---

## 5. Repo structure — deliberately deferred

Measured topology: `mjrc/` is itself a git repo that **explicitly gitignores**
`mjrc-app/`, `mjrc-game/`, `mjrc-admin/`, `mj-queue/`, `content-strategy/`.
They are **not** submodules — there are no gitlinks. Each is independent, and the
root `.gitignore` says so in a comment.

- **Two repos (today).** Works. Cost: no atomic commit across app and game, and
  the game's `engine/` / `rulesets/` cannot be imported by the app.
- **Submodules.** Advised against — detached HEADs and stale pointers, for a
  solo project, buy nothing.
- **True monorepo.** Merge histories, restructure to workspaces, re-point the
  Pages deploy flow. Real surgery.

**The only thing that forces a monorepo is `mjrc-app` needing to import the
game's engine or rulesets. Nothing does today.** It is reversible and it is not
blocking, so: stay as-is, revisit when code sharing becomes real.

---

## 6. What changed from v1, and why

| v1 said | v2 says | why |
| --- | --- | --- |
| Server-replay-verify the leaderboard | Dropped | No threat model. Local, private, only we write. |
| Slot under `ACCOUNTS-PROPOSAL.md`'s L0 tier | Just a name box | Owner: figure identity out later. |
| Decide `mjrc-app` vs standalone now | Deferred | Nothing is blocked by it; it is reversible. |
| Store seed + actions (8× smaller) | Store **both**, in IndexedDB | The framing was wrong — source vs cache, not small vs detailed. Do not optimise early. |
| 4-wind ≈ 31 hands | **33–39** | v1 measured untrained bots. Real tables are worse. |
| blunders and "strong" moves | match rate + mean gap | Owner's framing is better: a continuous measure of closeness to the engine. |
| — | Rank the board by agreement, not chips | ±16 chips of block noise swamps skill over one match. |

---

## 7. Still needs your ruling

1. **Dealer repeat on 流局 (§2.1).** Keep it (authentic, 4-wind ≈ 38 hands, a
   third to a half of hands end in nothing), or pass the deal on a draw
   (4-wind ≈ 19 hands)? This is a rules decision, so it is yours. It could also
   be a ruleset option rather than a change.
2. **Default match length for the picker.** I would default to 1 wind (~10–15
   min) and label each option with its length.
3. **Anything on the six pages in §3.5 that is missing or wrong** before I start.

Nothing has been built. Phase 1 starts on your word.

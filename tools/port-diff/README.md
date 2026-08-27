# Port-diff harness

DESIGN.md §8 specifies two validation harnesses. **This is the first one.**

> "Port-diff harness — replays the Python engine's logged batches through the TS
> port; validates the closed-hand LIU subset only (that's all the Python engine
> can generate)."

---

## Read this before you read a green run

**This harness validates the CLOSED-HAND LIU SUBSET AND NOTHING ELSE.**

The Python research engine at `mjrc-admin/research/probability/` is the only
source of reference answers here, and ENGINE-AUDIT §1 records exactly what it
is not able to do:

| Canonical HKOS rule (DESIGN.md §4) | Python engine |
|---|---|
| 上 chow, 碰 pung claims | do not exist anywhere in the code |
| 明槓 / 暗槓 / 加槓 kongs | no kong meld type at all — a quad raises `ValueError` |
| 搶槓 rob-the-kong, 槓上開花 | unreachable, no kongs to build them from |
| exposed vs concealed melds | no distinction; every logged hand is closed |
| 8 flowers with replacement draws | tile model stops at 34 kinds; `use_flowers` is a stub |
| 門風 seat wind / 圈風 round wind faan | **an East pung scores 0** — verified |
| dealer double, 包 liability, situational faan | none |
| 七對子 seven pairs | scored at 4 faan — a hand classic HKOS does not play at all |

So a hand this harness has never seen is a hand it cannot have validated. A
green run here says the two engines agree about **fourteen closed tiles under
the LIU price list**. It says nothing whatever about claims, kongs, flowers,
winds, the dealer, or any situational faan.

**Those are the golden-hand suite's job** (`engine/test/golden/`), which
DESIGN.md §8 makes the P0 exit requirement and calls "the only validation
source for the canonical extensions — the part that 'destroys credibility
instantly' if wrong." Nothing in this directory substitutes for it.

One more thing a reader of a green run should know: the corpus is not just
narrow, it is **lopsided**. The Python bots optimise a distance function that
counts 七對子 as a winning shape, and the 3-faan minimum then filters out most
ordinary hands, so the majority of the wins the engine logs are seven-pairs
hands — a shape this project does not play. See "What the corpus actually
contains" below for the measured mix.

---

## Current status — 11 green, 1 red, on purpose

| Dimension | Result |
|---|---|
| Final scores, 473 logged wins | **0 mismatches.** 81 agree, 392 are 七對子 hands this project does not play. |
| Chips, 473 wins | Bracket table exact under the per-player reading. The 3x self-draw gap is DESIGN.md §9's open question, not a bug. |
| Faan table, 16 shared patterns | Exact. |
| Distance to ready, 800 hands | **12 wrong — `engine/src/ready.ts` reads one too high**, and on all 12 it gives exactly the wrong answer the Python cutoff gives. Not fixed here. See Findings. |

The red test is the harness working. It is left red rather than quarantined:
`ready.ts` is another agent's file, and the whole point of a port-diff harness
is that it goes red when the port is wrong.

---

## What it does

1. **Parses** the Python engine's JSONL replay logs (`core/replay.py` format).
2. **Translates** each logged win into our tile space, `Meld` model and
   `WinContext`.
3. **Scores** it with `engine/src/scoring.ts` under the `liu` preset.
4. **Reconciles and diffs** — our engine is a strict superset, so raw totals
   are compared only after our result is restricted to what the Python engine
   is capable of saying. Every faan of the remaining difference has to be
   named. Anything unnamed is a port bug.
5. **Also diffs chips** against the LIU bracket table, and
   **distance-to-ready** against an exhaustive reference.

### Files

| File | Role |
|---|---|
| `compare.ts` | the library: log parser, translation, reconciliation, reports. Pure — no I/O, no clock, no randomness. |
| `fixtures.test.ts` | the executable harness. Loads the fixture, runs the diff, asserts, prints the readout. |
| `generate_fixtures.py` | runs the Python engine and distils a batch into the fixture. Not part of the TS build. |
| `fixtures/liu-closed.json` | the committed corpus: every logged win plus sampled mid-hand tile counts. |
| `fixtures/sample-batch.json` | log lines from one batch file, so the TS parser stays pinned to the real format. Four fields removed — see below. |
| `tsconfig.json` | so `tools/` can be type checked at all — the root script does not reach it. |
| `vitest.config.ts` | convenience: run this harness alone instead of the whole suite. |

---

## Running it

The root `vitest.config.ts` collects `tools/**/*.test.ts`, so **`npm test` runs
this harness already**. To run only it, without waiting on the rest of the
suite:

```sh
cd /Users/augustineliu/Local_Projects/mjrc/mjrc-game
./node_modules/.bin/vitest run --config tools/port-diff/vitest.config.ts
```

Type checking is a different story: the root `typecheck` script enumerates
`engine`, `protocol`, `rulesets` and `worker` by name and does not reach
`tools/`. This directory carries its own `tsconfig.json` so it can be checked:

```sh
./node_modules/.bin/tsc --noEmit -p tools/port-diff
```

Adding `&& tsc --noEmit -p tools/port-diff` to the root `typecheck` script is a
one-line change, deliberately left to whoever owns `package.json` rather than
made from here while other work is in flight.

The test prints the full readout via `formatReport`, which leads with the scope
warning:

```
PORT-DIFF — DESIGN.md §8 harness 1
  scope: Closed-hand LIU subset only. ...
  corpus: N hands from M seeded matches ...
FINAL SCORES  ...
  agree / explained / MISMATCH
CHIPS  ...
DISTANCE TO READY  ...
```

---

## Regenerating the fixture

Requires Python 3.11+ and numpy, and the research repo on disk.

```sh
python3 tools/port-diff/generate_fixtures.py \
  --python-repo /Users/augustineliu/Local_Projects/mjrc/mjrc-admin/research/probability \
  --matches 400 --seed 20260826 \
  --out         tools/port-diff/fixtures/liu-closed.json \
  --sample-out  tools/port-diff/fixtures/sample-batch.json \
  --keep-replays /tmp/port-diff-batch     # optional: keep the raw JSONL
```

Add `--reuse-replays DIR` to re-extract from a kept batch without replaying it.

The batch is **seeded and reproducible**: the same `--seed` replays the same
hands, and every field in the fixture is byte-identical run to run. One
exception was found and removed rather than papered over — see "Findings".

---

## The Python log format (`core/replay.py`)

One JSON object per line. Per hand: a `hand_header`, then a frame per
transition, then a `hand_footer`.

```
{"kind":"hand_header","ruleset":{...},"hand_index":0,"round_wind":27,
 "seat_winds":[27,28,29,30],"dealer":0,"starting_hands":[[34 counts]×4],"seed":478163327,...}
{"turn":0,"actor":0,"phase":"draw","hands":[[34 counts]×4],"discards":[[...]×4],
 "melds":[[],[],[],[]],"wall_remaining":83,"action":{"type":"...","tile":12}}
...
{"turn":41,"actor":2,"phase":"end",...,"score":{"winner":2,"winning_hand":[34 counts],
 "patterns":["Half Flush","Self-Drawn"],"fan_breakdown":{...},"total_fan":5,
 "chips":156,"deal_in_seat":null}}
{"kind":"hand_footer","winner":2,"total_fan":5,"chip_deltas":[-156,-156,468,-156],...}
```

### What the committed sample keeps, and what it drops

`fixtures/sample-batch.json` holds real log lines from one batch file, so the
TypeScript extractor and the Python one stay pinned to each other. Each line is
what the Python engine wrote, byte for byte, **minus four fields**:

| Dropped | Where | Why it can go |
|---|---|---|
| `ruleset` | `hand_header` | republished in `provenance.pythonRuleset`, renamed into our vocabulary |
| `outcome` | `hand_footer` | a label; `winner` carries the same fact |
| `action.type` | win frames | a label; the presence of a `score` block is the signal |
| `score.is_tsumo` | win frames | a flag; `deal_in_seat` carries the same fact |

Two reasons, and both matter. **The parser reads none of them** — so the pin is
undiminished; every field it touches is untouched. And all four are spelled in
the vocabulary `TERMINOLOGY.md` bans from this repo, which covers strings, and a
committed fixture is a string in this repo. `provenance.pythonRuleset` gets the
same treatment: every value carried across, every key renamed
(`fan_minimum` → `minimumFaan`, `allow_chi` → `allowsChow`, the payout brackets'
two columns → `onDiscard` / `selfDrawFigure`).

Two decisions about how this is read:

- **Win frames are found structurally** — a frame carrying a `score` block —
  and the win type is read off `score.deal_in_seat`, which is `null` exactly
  when the winner drew the tile themselves. No label is ever consulted, which
  is what lets the four fields above be dropped without weakening anything.
- **The per-frame `rationale` block is dropped on the floor.** It carries the
  bot's distance figures, and those come from the Python engine's shipped
  branch-and-bound cutoff, which ENGINE-AUDIT §3 measured wrong on ~6.1% of
  13-tile and ~10.1% of 14-tile hands. See below.

---

## Translation

The two tile spaces **agree on 0–33 exactly** — 0-8 萬, 9-17 索, 18-26 筒,
27-30 winds, 31-33 dragons — so the translation is the identity map, and the
only real work is turning a 34-slot count array into a tile list. Ours
continues to 41 with the eight flowers; the Python model simply stops.

That identity is load-bearing, so it is asserted (`assertTileSpacesAligned`)
and spot-checked at every suit boundary against `TILE_NAMES` in the test. If
either side ever renumbers, every hand in the corpus silently becomes a
different hand and nothing else would catch it.

| Ours | From the log |
|---|---|
| `concealed` | the 14 winning counts, minus one copy of the winning tile |
| `winningTile` | the winning frame's `action.tile` |
| `melds` | always `[]` — the corpus has none, and a case that carried one is rejected |
| `flowers` | always `[]` — not representable in a 34-kind model |
| `ctx.selfDraw` / `ctx.from` | `score.deal_in_seat` |
| `ctx.roundWind` / `ctx.seatWind` | header wind tile ids, minus 27 |
| `ctx.isDealer` | winner seat vs header `dealer` |
| `ctx.onLastTile` / `ctx.wallEmpty` | frame `wall_remaining` |

`onLastTile` is set faithfully even though the Python engine has no 海底撈月
faan, so our engine awarding it shows up as a *named* divergence rather than as
noise.

---

## How disagreement is classified

Our engine is a strict superset of the Python one — 門前清 alone fires on every
hand in this corpus, because every hand in it is closed. Comparing raw totals
would report near-total disagreement and prove nothing.

So `reconcile()` restricts our result to what the Python engine can express:

1. Keep the awards whose ids are among the sixteen patterns Python implements.
2. Put back anything an **extension** award swallowed. Subsumption in
   `rulesets/src/patterns.ts` means "the swallowed pattern is part of THIS
   pattern's definition", so a hand scoring 四暗刻 *is* a hand the Python engine
   scores as 對對糊 and the 3 faan is restored — and reported by name, never
   quietly added.
3. Cap at the ruleset limit and compare.

Each case then lands on one of three verdicts:

| Verdict | Meaning |
|---|---|
| `agree` | reconciled totals are equal. |
| `explained` | they differ, and every faan of the difference is named in the case's divergence list. |
| `mismatch` | **the port is wrong.** The only verdict the test asserts on. |

The named divergences, all of them deliberate rules decisions rather than
tolerances dialled in to make a run go green:

- `extension` — we award a pattern Python cannot score (門前清, 門風, 圈風,
  四暗刻, 海底撈月).
- `subsumed` — an extension award swallowed a pattern Python did score; the
  faan is restored and named.
- `sevenPairsNotPlayed` — Python read the hand as 七對子. `decompose.ts` has no
  seven-pairs branch on purpose: "Not a hand in classic HK Old Style".
- `thirteenOrphans` — 十三么 has no four-sets-and-a-pair reading; `scoring.ts`
  special-cases it, and this class exists so the difference is visible either way.
- `notAWin` — our engine could not read the tiles as a win at all. Never
  explained away; it is a mismatch unless one of the two classes above applies.

Chips are diffed separately and have their own story — see below.

A guard against the obvious failure mode of this design: the test also asserts
that the number of `agree` cases is **greater than zero**, so the harness can
never pass by explaining everything away.

---

## Chips

Chip figures are diffed using **Python's** faan, not ours, so the comparison
measures the four-bracket transcription in `rulesets/src/payment.ts`
(92/108 · 124/156 · 188/252 · 316/444) on its own, undisturbed by any faan
divergence.

The result splits cleanly, and it is the concrete form of DESIGN.md §9's open
payment question:

- Under `LIU_BRACKET_PER_PLAYER`, the chip figures reproduce the Python engine
  **exactly, on every hand**. The bracket table is transcribed correctly.
- Under the shipped `liu` preset, which pairs the same brackets with the
  `total` settlement, discard wins still agree exactly and self-draws differ by
  a factor of three — because `core/game.py` pays each of the three losers the
  printed figure while `payment.ts` argues the printed figure is the pot.

Neither is a port bug. The disagreement is a rules question that DESIGN.md §4
says to settle against `mjrc-admin/reference/hk-scoring-calculator.xlsx` before
scoring ships, and it is still open.

---

## Distance to ready, and the audit's instruction

ENGINE-AUDIT §3, quoted as an instruction:

> "Validate the port against the *unpruned* Python reference, not the existing
> test expectations."

The reason is in the same section: the Python engine's branch-and-bound cutoff
"uses the subtree's *worst* case as if it were an optimistic bound and prunes
winners", returning a distance too high on ~6.1% of 13-tile and ~10.1% of
14-tile hands — and the 158-case Python test suite happens to sit inside the
agreeing ~94%. Validating against those expectations would certify the bug.

So this harness never uses the Python test suite and never uses the distance
figures recorded in the logs. `generate_fixtures.py` recomputes each sampled
hand **twice**: once exhaustively (the reference) and once with the cutoff
restored (a measurement). Both go in the fixture, and the tests are:

- `distanceToReady` matches the **exhaustive** figure on every hand — the only
  assertion, and the one that is currently red;
- the corpus still contains hands the cutoff gets wrong, so the assertion above
  cannot go quietly vacuous.

The generator re-implements both searches rather than importing them, because
the shipped Python function has the cutoff baked in and exposes no exhaustive
entry point. It is one function with the cutoff behind a flag, so the two
differ by exactly the four lines the audit cites and nothing else. **The
transcription was checked against the shipped function itself** over all 800
sampled hands — call it directly on the fixture's `hand` arrays and compare
against the `shipped` column; they agree on every one. Re-run that check if the
research repo's search ever changes.

Measured on this corpus, the cutoff is wrong on **1 of 397 13-tile hands
(0.3%) and 15 of 403 14-tile hands (3.7%)** — well under the audit's ~6.1% and
~10.1%, and not a contradiction of them: the audit measured random hands, while
these are mid-hand bot positions, a far more structured population. The report
prints both so nobody reads one as the other.

Both engines are compared on the **standard four-sets-and-a-pair shape only**.
The Python function also takes the minimum against 七對子 and 十三么;
`engine/src/ready.ts` deliberately does not, and mixing the two would be
comparing different questions.

---

## What the corpus actually contains

Generated with `--matches 400 --seed 20260826`, four greedy bots, LIU ruleset.
**1,600 hands played, 473 won** — the rest ended in an exhaustive draw 流局,
matching the game texture ENGINE-AUDIT §3 measured and called a product blocker.

Of those 473 wins, on the run committed here:

| | count | share |
|---|---|---|
| `agree` — the port and the Python engine reach the same total | 81 | 17.1% |
| `explained` — a named rules difference, **all of them 七對子** | 392 | 82.9% |
| `mismatch` — the port is wrong | **0** | 0.0% |

Read that table carefully. **Eighty-three per cent of the corpus is a hand
shape this project does not play.** The greedy bots optimise a distance
function that counts 七對子 as a winning shape, and the 3-faan minimum then
filters out most ordinary hands, so the engine's own bots converge on it.
`allow_seven_pairs` cannot be turned off to fix this — see Findings.

So the honest headline is not "473 hands validated". It is:

> **81 closed HK hands agree. Nothing else on this page is validation.**

Alongside them: 800 sampled mid-hand tile counts (397 of 13 tiles, 403 of 14)
for the distance dimension, which is where the harness found something.

---

## Findings

### 1. `engine/src/ready.ts` is wrong on 12 of 800 hands — THIS SUITE IS RED

**This is the harness earning its keep on its first run, and it is not fixed
here.** `ready.ts` belongs to another agent; a validation harness that edits the
thing it validates is worth nothing.

`distanceToReady` returns a value **one too high** on 12 of the 800 sampled
hands (1 of 397 at 13 tiles, 11 of 403 at 14). Every error is in the same
direction. The kicker:

> **All 12 are exactly the wrong answer the Python engine's cutoff gives.**

`ready.ts`'s own header says "The decomposition is UNPRUNED … Do not
reintroduce it." It did not reintroduce the prune — it introduced a different
defect of the same strength and landed on the same wrong answers.

**Cause.** `maxBlocks` searches for the split maximising `2 * sets + partials`,
then `score` applies the cap afterwards:

```ts
const [s, p0] = maxBlocks(c, 0, 0, 0);
const sets = s + melds;
const parts = sets + p0 > 4 ? 4 - sets : p0;   // cap applied AFTER the search
return 8 - 2 * sets - parts - (hasPair ? 1 : 0);
```

`2 * sets + partials` is not the quantity the formula minimises once
`sets + partials <= 4` bites. A split with `sets=1, partials=4` scores 6 on the
proxy and a split with `sets=2, partials=2` also scores 6 — but the cap
truncates the first to 3 partials, so it yields distance 2 while the second
yields 1. `take()` breaks that tie with a strict `>`, keeping whichever the DFS
reached first. The cap has to be applied *inside* the search, or the objective
has to be the distance itself.

Instrumenting `maxBlocks` on the hand below confirms it exactly: with 中中 taken
as the pair it returns `sets=1, parts=4`, objective 6, which the cap truncates
to 3 partials for a distance of 2. The `sets=2, parts=2` split scores the same
6 and would have given 1.

**Minimal reproduction** — 六索 · 七索七索七索 · 一筒一筒 · 五筒五筒 · 六筒六筒 ·
七筒 · 中中, thirteen tiles:

```ts
const hand = [0,0,0,0,0,0,0,0,0, 0,0,0,0,0,1,3,0,0, 2,0,0,0,2,2,1,0,0, 0,0,0,0,2,0,0];
distanceToReady(hand, 0);   // returns 2; the correct answer is 1
```

Read it as: pair 中中, pung 七索七索七索, chow 五筒六筒七筒, partials 五筒六筒 and
一筒一筒 — two sets and two partials with a pair, so `8 - 4 - 2 - 1 = 1`.

**Confirmed three independent ways**, because a harness accusing another
module had better be sure: (a) the generator's exhaustive DFS, (b) a
cap-inside-the-search variant of `ready.ts`'s own algorithm, and (c) a
definition-only reference that never uses the distance formula at all —
`13 - max over complete 14-tile hands W of |hand ∩ W|`, enumerating W directly.
All three say 1.

The existing `engine/test/ready.test.ts` passes, so nothing else catches this.

### Other findings

1. **The Python logs are not byte-reproducible from a seed.** `play_match`
   mints `match_id` with `uuid.uuid4()` rather than deriving it from the seed,
   so two runs of the same seeded batch produce identical play and different
   ids. The fixture drops `match_id` and keys cases on
   `<file tag>.h<hand>.t<turn>` instead, which is deterministic. One more entry
   for ENGINE-AUDIT §2's list of replay-format gaps.
2. **`allow_seven_pairs` is a dead flag** — which is why the corpus is 83%
   七對子 and cannot simply be regenerated without it. `core/ruleset.py`
   declares the flag and `describe()` publishes it into every manifest, but
   `core/scoring.py` and the distance module never import a ruleset at all, so
   turning it off changes nothing.
   Making this corpus useful at scale means fixing the flag in the research
   repo, or teaching the bots faan awareness — ENGINE-AUDIT §3's other ask.
3. **The chip brackets are transcribed correctly; the settlement is not
   settled.** Under the per-player reading the port reproduces the Python chip
   figure on all 473 hands. Under the shipped `liu` preset, all 358 discard
   wins agree and all 115 self-draws differ by 3x. See "Chips".
4. **Refused wins are invisible.** A below-minimum win emits no frame at all
   (`core/game.py` un-commits the tile and continues), so the harness cannot
   check that our `legal: false` path agrees with Python's refusals. DESIGN.md
   §5.5 already requires our own log to emit them.

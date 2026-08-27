# Golden-hand audit

Adversarial re-derivation of every case in `basic.ts`, `flush.ts`, `honours.ts`,
`kongs.ts` and `limit.ts`, done from the `TileId` arrays outwards. Descriptions
were read only after the hand had been worked out independently, so a wrong
description could not launder a wrong expectation.

**Scope.** DESIGN.md §8 makes this suite the P0 exit gate and the only
validation source for exposed melds, kongs, flowers, winds, dealer context and
situational faan. Every value here is checked against the shipped catalogue
`rulesets/src/patterns.ts` and the shipped price lists
`rulesets/src/presets.ts`. Nothing in the fixture files was edited — the
corrections below are for a human to apply.

**Count.** 121 cases, not 124: `basic` 25, `flush` 25, `honours` 25, `kongs`
25, `limit` **21**. See G1.

**Verdicts.** 95 OK · 18 WRONG · 8 QUESTIONABLE.

The mechanical half of this audit is encoded in `audit.test.ts`, which passes
today because each known defect is listed in a `KNOWN_*` allowlist. Striking an
id off that list is the last step of applying a correction; forgetting to fails
the test.

---

## What the arithmetic already proves

Every one of the 121 award lists prices, against its own preset's `faanTable`
and clamped at `limitFaan`, to exactly the `expected.faan` it claims; every
`legal` flag matches `faan >= minimumFaan`; no award list contains a pattern
another listed pattern subsumes; every meld is shape-legal, every chow comes
from 上家 and only 暗槓 is owned by its own seat; no hand uses a fifth copy of a
tile; no bonus tile appears in a hand and no scoring tile appears in `flowers`;
and 正花 is paid once per bonus tile matching the seat and never for another
seat's.

That is the good news, and it is also the trap: **the totals were computed FROM
the award lists.** An award that was never noticed is invisible to arithmetic.
Every defect below is either a missing award, a mis-chosen id, or a value the
scorer cannot be told.

---

## Defects

### D1 · `flush-full-chars-concealed` is a limit hand scored as an ordinary one

The worst single case in the suite.

```
concealed: 1萬 1萬 1萬 2萬 3萬 4萬 5萬 6萬 7萬 7萬 8萬 9萬 9萬   winningTile: 9萬
melds: []   flowers: [梅]   seat 3, round 0, discard
expected: { faan: 7, awards: ["fullFlush", "concealedHand"] }
```

Sorted, the winning fourteen are **1112345677999萬** — the 九蓮寶燈 base shape
`1112345678999` plus a duplicate 7. The hand is fully concealed with no melds,
so it satisfies 九蓮寶燈 outright. `patterns.ts` has `nineGates` subsume
`fullFlush`, and `presets.ts` prices it at the limit.

* Correct: **13 faan**, awards `["nineGates"]` (`concealedHand` is suppressed by
  `concealedOnly`, per D8).
* The description — "1萬 pung, three runs and 9萬 eyes" — is what hid it. The
  author counted sets and never looked at the multiset.

**Recommended repair: change the tiles, not the expectation.** The flush family
needs a plain concealed 清一色 here, and turning this into a second nine-gates
case would duplicate `limit-nine-gates-self-draw`. Dropping 2萬 breaks the base
shape while preserving the stated reading exactly:

```
concealed: [m(1), m(1), m(1), m(3), m(4), m(5), m(5), m(6), m(7), m(7), m(8), m(9), m(9)]
winningTile: m(9)          // 111 / 345 / 567 / 789 / 99  → 清一色 6 + 門前清 1 = 7
```

### D2 · 字一色 and 清么九 do not subsume 對對糊 — four cases forget it, and one file contradicts another

`patterns.ts` is explicit: `allHonours` subsumes `halfFlush` and
`mixedTerminals`; `allTerminals` subsumes `mixedTerminals`. Neither swallows
`allPungs`, and both notes say 對對糊 is paid on top because those patterns are
about the CLASS of tile, not the shape.

The suite disagrees with itself:

| case | `allPungs`? |
|---|---|
| `limit-all-terminals-accumulates-to-thirteen` | **yes** — and its 13 depends on it |
| `flush-all-terminals-concealed` | no |
| `flush-all-terminals-melded-self-draw` | no |
| `flush-all-honours-concealed` | no |
| `flush-all-honours-melded-reaches-limit` | no |
| `honours-big-three-dragons-all-honours-capped` | no |
| `honours-small-four-winds-all-honours` | no |

The 清么九 split is a hard contradiction — the same pattern, scored two ways in
two files. `limit.ts` is the one that matches the catalogue, and its own
description counts 對對糊 3 explicitly, so the four flush/honours cases are the
ones that are wrong. Resolving it the other way (making the two patterns
subsume `allPungs`) would drop
`limit-all-terminals-accumulates-to-thirteen` from 13 to 10 and break its
stated arithmetic.

Corrections:

* `flush-all-terminals-concealed` → `["allTerminals", "allPungs", "concealedHand"]`, **8 → 11**
* `flush-all-terminals-melded-self-draw` → `["allTerminals", "allPungs", "selfDraw"]`, **8 → 11**
* `flush-all-honours-concealed` → `+ "allPungs"`, raw 12 → 15, **12 → 13 (capped)**
* `flush-all-honours-melded-reaches-limit` → `+ "allPungs"`, raw 13 → 16, faan stays 13 but `capped` flips
* `honours-big-three-dragons-all-honours-capped` → `+ "allPungs"`, faan stays 13
* `honours-small-four-winds-all-honours` → `+ "allPungs"`, faan stays 13

`flush-all-honours-concealed`'s `contested` note ("under the flat-limit reading
this scores 13 rather than 12") becomes moot: it is 13 under both readings.

### D3 · 小四喜 and 大四喜 do not swallow 門風 / 圈風 — three cases assume they do

`patterns.ts` gives `smallFourWinds` an empty `subsumes` list, with a note
arguing that seat and round wind are POSITIONAL faan and cannot be inside a
shape pattern. `bigFourWinds` subsumes only `smallFourWinds`.

That note also says the ruling was "taken from `engine/test/golden/honours.ts`,
which fixes it for the whole suite". **It was not — `honours.ts` rules the
opposite way**, and its `contested` text says so outright ("the preset has the
pattern subsume 圈風"). One of the two files is citing the other for a ruling
neither of them holds.

Taking the catalogue as authoritative:

* `honours-small-four-winds-half-flush` — seat 北, round 東, and a 東 pung on
  the table. Missing `roundWind`. **10 → 11.** (The seat's own 北 is only the
  pair, so no `seatWind`; the case reasons that part correctly.)
* `honours-small-four-winds-all-honours` — seat 西, round 南, with pungs of
  both. Missing `seatWind` and `roundWind`. Faan stays 13.
* `honours-big-four-winds-subsumes-small` — seat 南, round 西, all four wind
  pungs. Missing `seatWind` and `roundWind`. Faan stays 13. The case's own
  `contested` note concedes it cannot settle the question; the catalogue can.

Only the first changes a payout, and it is the one case in the group whose
value is not already at the cap — which is exactly why the other two hid it.

### D4 · `limit-big-three-dragons-caps` is also 混么九

Pungs of 中 發 白 and 1索, pair 北. Every tile is a terminal or an honour, at
least one is an honour and at least one is suited, so 混么九 fires — the same
shape `basic-mixed-terminals-all-pungs` and `flush-half-mixed-terminals-overlap`
both pay it on. `bigThreeDragons` does not subsume it.

* Correct: `+ "mixedTerminals"`. `rawFaan` **14 → 15**; `faan` stays 13, `capped`
  stays true.

### D5 · 正花 on a season is emitted as `ownFlower` — six cases, and `ownSeason` is dead

`patterns.ts` carries two ids for 正花 — `ownFlower` (梅蘭菊竹, tiles 34-37) and
`ownSeason` (春夏秋冬, tiles 38-41) — and both presets price both at 1. No golden
case ever emits `ownSeason`. Six cases hold a season matching their seat and
award `ownFlower` for it:

| case | season held | seat |
|---|---|---|
| `basic-own-flowers-lift-over-floor` | 春 | 0 東 |
| `honours-dragon-pung-own-flower-and-season` | 夏 | 1 南 |
| `honours-big-three-dragons-added-kong` | 秋 | 2 西 |
| `honours-dealer-scores-no-extra-faan` | 春 | 0 東 |
| `honours-all-four-seasons-with-dragon-pung` | 秋 | 2 西 |
| `honours-all-eight-bonus-tiles` | 冬 | 3 北 |

No total moves — both ids are worth 1 — but a scorer cannot satisfy the
catalogue and the fixtures at once, and the second case's own id literally reads
`own-flower-and-season`.

**Fix the six cases, not the catalogue.** `allFlowers` and `allSeasons` are
already distinct ids the suite does use, so collapsing only the singleton pair
would leave the bonus-tile family half-merged. `assertRulesetSound` will not
catch a dead id, so nothing else will find this.

### D6 · Two LIU cases were written against a LIU that does not ship

`presets.ts` `LIU` sets `useFlowers: true` and prices `concealedHand: 1`,
`noFlowers: 1`, `ownFlower: 1`. Two cases assert the opposite in their prose and
score accordingly:

* `basic-full-flush-liu-seven` — `flowers: []`, no melds, self-drawn. Missing
  `concealedHand` and `noFlowers`. **9 → 11**; the description's "LIU has no
  門前清, no wind faan and no flowers at all" is false against the shipped preset.
* `honours-liu-concealed-small-three-dragons` — `flowers: []`, no melds,
  self-drawn. Missing `concealedHand` and `noFlowers`. **5 → 7**; its
  `contested` note claims "useFlowers is false", which it is not.

`kongs-liu-concealed-kong-only` gets this right — it awards both — which is what
makes the other two provably wrong rather than merely a different reading.
`limit-thirteen-orphans-liu-variant` names the disagreement explicitly and is
built to be immune to it; that case is fine, and its note should be the one that
survives.

### D7 · Eight cases depend on context the `score()` signature cannot carry

`score(concealed, melds, flowers, winningTile, ctx, ruleset)` takes a
`WinContext` with `robbedKong`, `onKongReplacement`, `onLastTile` and
`wallEmpty`. It has no field for any of these:

| award | cases | what is missing |
|---|---|---|
| `winByDoubleKong` 槓上槓 | `kongs-double-kong-replacement` | nothing says the replacement came off a SECOND kong; the fixture sets only `onKongReplacement` |
| `heavenlyHand` 天糊 | `limit-heavenly-hand-all-chows`, `-after-flower-replacement`, `-is-thirteen-orphans` | `opening: "heavenly"` |
| `earthlyHand` 地糊 | `limit-earthly-hand-dealer-first-discard`, `-half-flush-contested-value` | `opening: "earthly"`, and no discarder seat |
| `winOnLastDiscard` 河底撈魚 | `limit-last-discard-all-pungs-half-flush`, `-below-floor-refused` | `onLastDiscard` |

`limit.ts` already noticed part of this and declared a local
`interface LimitCase extends GoldenCase` carrying `opening` and `onLastDiscard`.
`kongs.ts` did not, so 槓上槓 is unreachable from any input at all.

The values are not in dispute — each of the eight recomputes correctly *given*
the flag. The defect is that four awards in the shipped `faanTable` are
undetectable, so any golden runner has to smuggle fixture fields into the
context by hand, and a live game can never produce them. This needs a decision
above the fixture layer: extend `WinContext` (currently marked do-not-edit), or
strike the four ids from the presets.

### D8 · `patterns.ts` prose misdescribes the fixtures in three places (fixtures are right)

Recorded because the catalogue's comments are what the scorer is being written
against, and three of them are false:

1. The header and the `thirteenOrphans` / `heavenlyHand` notes claim "the golden
   fixtures pay 門前清 on 十三么, 九蓮寶燈, 天糊 and 地糊". They do not — all eight
   such cases omit it, and `scoring.ts` correctly suppresses it via the
   `concealedOnly` flag. **The fixtures are right; the prose is wrong.**
2. The `allHonours` note claims "the golden fixtures award both" 字一色 and
   對對糊. None of the four do — see D2.
3. The `smallFourWinds` note cites `honours.ts` for a ruling `honours.ts`
   contradicts — see D3.

## General findings

**G1 · The limit family is short of its own test file, and `limit.test.ts` is
already red.** 21 cases where the family's own assertions demand more:

* `limit-nine-gates-liu-reaches-limit` is named in the paired-case table and
  does not exist (`expected undefined to be defined`).
* `cases.filter(c => c.ruleset === "liu").length >= 2` — there is 1.
* `cases.filter(c => c.rawFaan === LIMIT_FAAN).length >= 3` — there are 2
  (`limit-thirteen-orphans-single-wait-discard`, `limit-all-terminals-accumulates-to-thirteen`).

Note the interaction: `limit-thirteen-orphans-single-wait-discard` is the only
uncapped 13 that is not the all-terminals case, so any change that pushes its
`rawFaan` above 13 makes that third assertion strictly harder.

**G2 · `case.ts::assertWellFormed` has a dead ternary.**

```ts
c.melds.reduce((n, m) => n + (m.kind === "kong" ? 3 : 3), 0)
```

Both branches are 3. The 14-count it computes is right (a kong fills one set
slot), but the expression reads as if it were distinguishing kongs and is not,
and the helper never checks that a kong actually carries four tiles or that a
chow carries three. `audit.test.ts` now checks both physical and slot counts;
the ternary should still collapse to `3` with a comment, or grow into a real
shape check.

**G3 · `decomposeWin` returns no reading for the four 十三么 cases.** Expected —
there is no orphans branch, by design — but it means those four cases cannot be
validated for completeness by the same path as every other case, and any runner
that treats "no decomposition" as "not a win" will reject them. They are legal:
each holds all thirteen orphan kinds with exactly one paired, and all four pass
the four-copy and 14-count checks.

**G4 · Provenance is uniformly `provisional: true`.** Correct per §8 — nothing
here has been signed off by a strong HK player, and D1 is a demonstration of why
that gate matters. The `contested` notes are generally excellent and several
correctly predicted the disagreements above; the failures are all cases where a
note asserted a fact about another file (`presets.ts`, `patterns.ts`,
`honours.ts`) instead of reading it.

---

## Corrections, in one list

| case | from | to | change |
|---|---|---|---|
| `flush-full-chars-concealed` | 7 | 13 | it is 九蓮寶燈 — or change the tiles (D1) |
| `flush-all-terminals-concealed` | 8 | 11 | `+ allPungs` |
| `flush-all-terminals-melded-self-draw` | 8 | 11 | `+ allPungs` |
| `flush-all-honours-concealed` | 12 | 13 | `+ allPungs`, now capped |
| `honours-small-four-winds-half-flush` | 10 | 11 | `+ roundWind` |
| `basic-full-flush-liu-seven` | 9 | 11 | `+ concealedHand + noFlowers` |
| `honours-liu-concealed-small-three-dragons` | 5 | 7 | `+ concealedHand + noFlowers` |
| `flush-all-honours-melded-reaches-limit` | 13 | 13 | `+ allPungs`; `capped` false → true |
| `honours-big-three-dragons-all-honours-capped` | 13 | 13 | `+ allPungs` |
| `honours-small-four-winds-all-honours` | 13 | 13 | `+ allPungs + seatWind + roundWind` |
| `honours-big-four-winds-subsumes-small` | 13 | 13 | `+ seatWind + roundWind` |
| `limit-big-three-dragons-caps` | 13 | 13 | `+ mixedTerminals`; `rawFaan` 14 → 15 |
| six cases in D5 | — | — | `ownFlower` → `ownSeason` on the season tile |
| eight cases in D7 | — | — | no value change; the context field is the problem |


---

## Case-by-case

### basic.ts — 25 cases

| case id | faan | verdict | finding |
|---|---|---|---|
| `basic-all-chows-melded-chicken` | 1 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `basic-all-chows-concealed-discard-short` | 2 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `basic-all-chows-concealed-selfdraw-floor` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-all-chows-honour-eyes-contested` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-all-chows-selfdraw-melded-short` | 2 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `basic-all-pungs-melded-floor` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-all-pungs-seat-wind` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-all-pungs-double-east-dealer` | 5 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-all-pungs-round-wind-only` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-all-pungs-concealed-discard` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-mixed-chicken-zero` | 0 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `basic-mixed-chicken-wrong-wind-pung` | 0 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `basic-mixed-chicken-no-flowers-one` | 1 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `basic-mixed-concealed-selfdraw-short` | 2 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `basic-mixed-dragon-pung-melded-short` | 1 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `basic-mixed-dragon-pung-concealed-selfdraw-floor` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-half-flush-melded-floor` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-half-flush-all-chows-honour-eyes` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-full-flush-melded` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-full-flush-liu-seven` | 9 | **WRONG** | D6 — LIU prices 門前清 and 無花; hand is concealed and holds no bonus tile. **9 → 11**, awards `+concealedHand +noFlowers`. |
| `basic-full-flush-all-chows` | 7 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-full-flush-all-pungs-selfdraw` | 10 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-mixed-terminals-all-pungs` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `basic-own-flowers-lift-over-floor` | 3 | **WRONG** | D5 — 春 is a season. Second `ownFlower` must be `ownSeason`. Faan unchanged (3). |
| `basic-no-flowers-lift-over-floor` | 3 | OK | Recomputed from the tiles; award list and total agree. |

### flush.ts — 25 cases

| case id | faan | verdict | finding |
|---|---|---|---|
| `flush-half-chars-concealed` | 5 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-half-bamboo-melded` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-half-circles-self-draw-all-pungs` | 8 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-full-chars-concealed` | 7 | **WRONG** | D1 — the multiset is 1112345677999萬: this is 九蓮寶燈, not a plain 清一色. **7 → 13**. |
| `flush-full-bamboo-melded-all-pungs` | 9 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-full-circles-concealed-kong` | 8 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-full-one-honour-short` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-full-one-honour-discarded` | 7 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-pair-decides-half` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-pair-decides-full` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-none-two-suits-below-minimum` | 2 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `flush-half-honour-melds` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-all-honours-concealed` | 12 | **WRONG** | D2 — 字一色 does not subsume 對對糊 (patterns.ts). **12 → 13** (raw 15, capped). |
| `flush-all-honours-melded-reaches-limit` | 13 | **WRONG** | D2 — missing `allPungs`. Faan stays 13 but raw 13 → 16, so `capped` flips false → true. |
| `flush-all-terminals-concealed` | 8 | **WRONG** | D2 — 清么九 does not subsume 對對糊, and limit.ts pays it. **8 → 11**. |
| `flush-all-terminals-melded-self-draw` | 8 | **WRONG** | D2 — missing `allPungs`. **8 → 11**. |
| `flush-half-mixed-terminals-overlap` | 9 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-full-parse-maximisation` | 9 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-full-all-chows-concealed` | 8 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-half-all-chows-honour-eyes` | 5 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-full-two-kong-forms` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-half-robbing-kong` | 5 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-full-last-tile` | 8 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-half-dealer-self-draw-all-pungs` | 10 | OK | Recomputed from the tiles; award list and total agree. |
| `flush-full-melded-all-chows` | 7 | OK | Recomputed from the tiles; award list and total agree. |

### honours.ts — 25 cases

| case id | faan | verdict | finding |
|---|---|---|---|
| `honours-seat-wind-pung-below-minimum` | 2 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `honours-round-wind-pung-below-minimum` | 2 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `honours-double-east-dealer-exactly-three` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-double-west-not-dealer` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-guest-wind-pung-scores-nothing` | 1 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `honours-round-wind-kong-scores-as-pung` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-seat-wind-concealed-kong-two-dragon-pungs` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-dragon-pung-own-flower-and-season` | 3 | **WRONG** | D5 — 夏 is a season; the id says so and the award list does not. `ownFlower` → `ownSeason`. |
| `honours-small-three-dragons` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-small-three-dragons-double-wind-half-flush` | 11 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-small-three-dragons-won-on-third-dragon` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-big-three-dragons-subsumes-small` | 9 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-big-three-dragons-added-kong` | 9 | **WRONG** | D5 — 秋 is a season. `ownFlower` → `ownSeason`. Faan unchanged (9). |
| `honours-big-three-dragons-all-honours-capped` | 13 | **WRONG** | D2 — missing `allPungs`. Faan stays 13 (raw 21 → 24). |
| `honours-small-four-winds-half-flush` | 10 | **WRONG** | D3 — 小四喜 subsumes nothing; the 東 pung is the round wind. **10 → 11**, awards `+roundWind`. |
| `honours-small-four-winds-all-honours` | 13 | **WRONG** | D2+D3 — missing `allPungs` (字一色), `seatWind` (西 pung, seat 西) and `roundWind` (南 pung, 南 round). Faan stays 13. |
| `honours-big-four-winds-subsumes-small` | 13 | **WRONG** | D3 — 大四喜 subsumes only 小四喜. Missing `seatWind` (南) and `roundWind` (西). Faan stays 13. |
| `honours-dealer-scores-no-extra-faan` | 3 | **WRONG** | D5 — 春 is a season. `ownFlower` → `ownSeason`. |
| `honours-dealer-self-draw-double-east` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-others-flowers-score-nothing` | 2 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `honours-all-four-flowers` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-all-four-seasons-with-dragon-pung` | 4 | **WRONG** | D5 — the own tile is 秋, a season. `ownFlower` → `ownSeason`. |
| `honours-all-eight-bonus-tiles` | 7 | **WRONG** | D5 — own tiles are 竹 (flower) and 冬 (season). Second `ownFlower` → `ownSeason`. |
| `honours-no-flowers-reaches-minimum` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `honours-liu-concealed-small-three-dragons` | 5 | **WRONG** | D6 — its `contested` note asserts LIU has no 門前清 and no bonus tiles; presets.ts says otherwise. **5 → 7**. |

### kongs.ts — 25 cases

| case id | faan | verdict | finding |
|---|---|---|---|
| `kongs-exposed-kong-all-pungs-self-draw` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-exposed-kong-below-minimum` | 0 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-exposed-kong-of-round-wind` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-exposed-kong-double-wind-dealer` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-concealed-kong-keeps-hand-concealed` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-concealed-kong-dragon-self-draw` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-two-concealed-kongs-score-nothing-extra` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-added-kong-replacement-wins` | 5 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-concealed-kong-replacement-wins` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-exposed-kong-replacement-completes-run` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-robbing-added-kong-dealer` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-robbing-kong-closed-wait` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-robbing-kong-below-minimum` | 1 (refused) | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-double-kong-replacement` | 10 | QUESTIONABLE | D7 — `winByDoubleKong` is not derivable: neither GoldenCase nor WinContext records that the replacement came off a SECOND kong. Value 10 is right if it ever reaches the scorer. |
| `kongs-three-kongs-all-pungs` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-four-kongs-limit` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-four-concealed-kongs` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-four-concealed-pungs-self-draw` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-four-concealed-pungs-discard-completes-pair` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-four-concealed-pungs-discard-completes-pung` | 5 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-four-concealed-pungs-with-concealed-kong` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-added-kong-half-flush-replacement` | 9 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-replacement-on-last-tile` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-exposed-kong-own-flower` | 5 | OK | Recomputed from the tiles; award list and total agree. |
| `kongs-liu-concealed-kong-only` | 4 | OK | Recomputed from the tiles; award list and total agree. |

### limit.ts — 21 cases

| case id | faan | verdict | finding |
|---|---|---|---|
| `limit-thirteen-orphans-single-wait-discard` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-thirteen-orphans-thirteen-wait-self-draw` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-thirteen-orphans-liu-variant` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-nine-gates-self-draw` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-nine-gates-on-last-tile` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-nine-gates-near-miss-full-flush` | 7 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-heavenly-hand-all-chows` | 13 | QUESTIONABLE | D7 — `opening: "heavenly"` lives on limit.ts's local `LimitCase`, not on GoldenCase or WinContext. Values check out. |
| `limit-heavenly-hand-after-flower-replacement` | 13 | QUESTIONABLE | D7 — same. Values check out. |
| `limit-heavenly-hand-is-thirteen-orphans` | 13 | QUESTIONABLE | D7 — same. 十三么 is derivable, 天糊 is not. |
| `limit-heavenly-hand-non-dealer-guard` | 4 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-earthly-hand-dealer-first-discard` | 13 | QUESTIONABLE | D7 — same, plus GoldenCase carries no discarder seat. |
| `limit-earthly-hand-half-flush-contested-value` | 13 | QUESTIONABLE | D7 — same. |
| `limit-last-tile-half-flush-self-draw` | 6 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-last-tile-lifts-over-floor` | 3 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-last-discard-all-pungs-half-flush` | 8 | QUESTIONABLE | D7 — `onLastDiscard` is on `LimitCase` only; WinContext has `onLastTile`/`wallEmpty` and no 河底 flag. |
| `limit-last-discard-below-floor-refused` | 2 (refused) | QUESTIONABLE | D7 — same. Refusal at 2 faan is right once the flag can be delivered. |
| `limit-big-three-dragons-caps` | 13 | **WRONG** | D4 — every tile is a terminal or honour and one is suited, so 混么九 fires. Missing `mixedTerminals`; faan stays 13, `rawFaan` 14 → 15. |
| `limit-all-terminals-accumulates-to-thirteen` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-all-terminals-four-concealed-pungs-caps` | 13 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-full-flush-all-pungs-melded` | 10 | OK | Recomputed from the tiles; award list and total agree. |
| `limit-full-flush-four-concealed-pungs-caps` | 13 | OK | Recomputed from the tiles; award list and total agree. |

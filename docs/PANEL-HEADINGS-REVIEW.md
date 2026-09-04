# Panel headings — review and proposed renames (2026-08-29)

> **DECISION (owner, 2026-08-29): do not mass-rename.** Some plumbing-speak is
> fine; what every heading needs is a description anyone can eventually
> understand. Shipped in commit `574307c`: titles unchanged, a plain-language
> note added under all nine sections, plus a global era filter on the Overall
> tab. The rename tables below are kept as a reference for wording — the Tier-1
> entries are still worth folding into the descriptions, and
> "Threat detection" remains the one title whose *name* actively misleads.

Reviewed: 2 tab labels, 9 section labels, 20 card scopes, 16 card titles,
10 cycle-texture chart titles, 4 longitudinal chart titles, 10 matrix rows.

## The one diagnosis behind almost every weak name

**Most headings name the data source or the slice; almost none name the
question the chart answers.** "Cycle texture," "Table behavior by cycle
endpoint," "Overall history," "Operation and archive coverage" are all true and
all leave you no wiser about why you'd look. The good ones on the page already
do the opposite — "Big hands — share of wins at 8+ faan" tells you what you
learn before you read the axis.

Secondary problem: **four titles are duplicated across sections with different
meanings.** "Mean winning faan" appears three times, "Threat detection" three
times, "Exhaustive draw rate" twice, "Claim mix" twice. The uppercase scope
chips disambiguate them, but when scrolling or linking someone to a chart, the
title is what gets read.

What is genuinely working: **the scope chips.** They consistently answer "what
slice, how much data" (`WITHIN CURRENT CYCLE · 8 GENERATIONS`, `ONE POINT PER
CYCLE`). Leave that system alone — it is the most disciplined thing on the page.

---

## Tier 1 — actively hides what is measured (fix first)

| current | proposed | why |
|---|---|---|
| Threat detection | **Winners flagged before they won** | The single worst name on the page. It sounds like a capability score; it is the share of wins where an opponent's read had flagged the winner beforehand. The plain-words version is also honest about its known weakness (it only scores at win moments). Applies in 3 places. |
| Refused wins / hand | **Wins refused — shape complete, under 3 faan** | "Refused wins" reads like the bot declining to win. It means a hand completed a winning shape it could not legally take under the faan floor. |
| Fixed-bench chips/match vs baseline-v2 | **Chips/match vs baseline-v2 — same opponent every generation** | "Fixed-bench" is internal vocabulary. The point it is trying to make (comparable across generations) should just be said. |
| Faan distribution | **Winning-hand sizes, latest generation** | Doesn't say whose hands or from when; it is the latest generation's bench only. |
| Incumbent weights — cycle start → now | **The bot's dials — cycle start → now** | "Incumbent" is optimizer jargon. It is simply the bot's current settings. |

## Tier 2 — plumbing-speak: describes implementation, not meaning

| current | proposed | why |
|---|---|---|
| Cycle texture — one point per cycle, proper axes | **How the table plays, cycle by cycle** | "Texture" is insider shorthand; "proper axes" is a note-to-self that leaked into the UI. |
| Table behavior by cycle endpoint | **The same numbers as a table, with cycle-to-cycle changes** | "Endpoint" is plumbing. Saying it duplicates the charts above resolves the "why is this here twice" confusion instead of causing it. |
| Operation and archive coverage | **Training run status** | Says nothing; it is the alive/stale health bar plus totals. |
| Current-cycle trends — generation by generation | **Bench results this cycle — generation by generation** | "Trends" is filler. Every card under it is a bench measurement; say so. |
| Current-cycle weights and inspection | **The bot's dials, and the matches it played** | "Inspection" is vague; the section is a settings table plus a match browser. |
| Current-cycle generation decisions | **Promotion decisions, generation by generation** | "Decisions" alone doesn't say what is being decided. |
| Generation decision log | **Why each generation promoted or rejected** | Same fix, at card level. |
| Overall history | **Across all eras** | It is not a history tab; it is the cross-cycle, cross-era view. |
| CURRENT OPERATION (scope) | **TRAINING RUN** | Minor, but "operation" is grander than what it is. |

## Tier 3 — duplicate titles that collide across sections

Fix by making the granularity part of the title, consistently. Current-cycle
cards already say "by generation"; the cycle-level ones should say "by cycle",
and the longitudinal ones "every generation".

| where | current | proposed |
|---|---|---|
| cycle texture | Mean winning faan | **Mean winning faan, by cycle** |
| cycle texture | Exhaustive draw rate 流局 | **Draw rate 流局, by cycle** |
| cycle texture | Claims per table hand | **Claims per hand, by cycle** |
| cycle texture | Claim mix — share of all claims | **Claim mix (whole table), by cycle** |
| longitudinal | Mean winning faan | **Mean winning faan — every generation** |
| longitudinal | Exhaustive draw rate | **Draw rate — every generation** |
| longitudinal | Refused wins per table hand | **Wins refused per hand — every generation** |

## Tier 4 — small clarity wins

| current | proposed | why |
|---|---|---|
| Champion ladder vs baseline-v0 | **Each era's champion vs baseline-v0** | "Ladder" described the old bar chart; it is a line over eras now. |
| Challenger economy — chips won vs bled, per match | **Where the challenger's chips come from and go** | "Economy" is abstract; the subtitle already says the real thing. |
| Win mix per table hand | **How hands are won — self-draw vs discard** | |
| Claim mix per table hand | **What gets claimed — pung, chow, kong** | |
| Across all cycles — every archived generation, with era breaks | **Every generation ever recorded** | Wordy; era breaks are visible on the charts. |

## Leave alone (already good)

- Both `Current cycle` tab label and every scope chip
- `Absolute progress — measured against the fixed v0 yardstick`
- `Held-out exam — chips/match vs era enemy` ("held-out" is real, defined project vocabulary)
- `Big hands — share of wins at 8+ faan`
- `Hand types — share of bench wins`
- `Net chips/match vs baseline-v0`
- `Research archive`

## Note on vocabulary that should NOT be plain-languaged

`faan`, `流局`, `self-draw / 自摸`, `chips`, `cycle`, `era`, `held-out`,
`all-seats` are the project's real vocabulary, defined in the legend, and used
consistently. Replacing them with casual paraphrases would make the page
longer and less precise. The renames above only target words that are vague
(`texture`, `trends`, `behavior`, `operation`, `inspection`) or that describe
the machinery rather than the meaning (`endpoint`, `fixed-bench`, `incumbent`).

## Suggested scope if you only want the high-value half

Tier 1 plus Tier 3 (nine renames) fixes the misleading names and the
collisions, which is where nearly all the real cost is. Tier 2 is polish that
mostly helps a newcomer or a future you.

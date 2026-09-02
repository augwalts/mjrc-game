# Game stats — what the site already does, and what only the game can do

Written 2026-09-01, after reading `mjrc-app/web/src/features/scoring/utility/`
and the live pages at `mahjongresearch.com/almanac`.

Status: **proposal, nothing built.**

---

## 1. What the website already does — inherit this, do not reinvent it

The scoring utility's player surface is the house standard and it is good.
Live example, `/almanac/p/Wen L`, 19 games and 287 hands:

**Headline tiles** — GAMES · WORTH/HAND · WIN RATE · DEAL-IN RATE

**Charts**
| chart | what it is |
| --- | --- |
| recent form | sparkline, worth/hand per game |
| worth/hand by game | "net per hand, priced in each game's average winning hand — comparable across rule sets" |
| hand sizes by game | faan histogram, one faint line per game with the aggregate bold on top, `hands` / `points` toggle |

**The players index** (`/almanac/players`, 62 names across 31 games) is the
vocabulary to match:

```
PLAYER  GAMES  HANDS  WINS  WIN%  INS  IN%  HANDS W:L  PTS W:L  NET/HAND  WORTH/HAND
```

Note `INS` — hands you paid in on. The game calls this `fed`. **Use the site's
word.** A tester who has seen one surface should not have to learn a second
vocabulary for the other.

### Conventions worth copying verbatim

Read from `hubcharts.ts` and `chart.ts`, and all of them are load-bearing:

- **Hand-rolled inline SVG.** No chart library anywhere on the site.
- **Never two y-scales.** `hubcharts.ts`: putting two magnitudes on one pair of
  axes "is the most reliable way to make a chart lie" — it uses a *toggle*, and
  the heading follows the toggle so the card always names what is drawn.
- **Densify the x-axis.** `densify()` emits every day between first and last,
  including empty ones, because charting only the days with data "would space a
  fortnight's gap the same as an overnight one".
- **Cumulative must be earned.** Only the players count is cumulative, because
  only that question ("how big is the crowd") is monotonic. Everything else is
  per-period, because flat stretches are real.
- **Faint per-game lines, bold aggregate on top.** The faan histogram's shape.
- Tokens: `--su-hairline`, `--su-faint`, `--su-ink`, `--su-line-mid`, `--su-mono`.
  Seat colours are oklch, one hue per seat.

### Worth adopting outright

**"Worth"** — net per hand priced in that game's average winning hand. It makes
a TVB game and an MJRC-standard game comparable, which the demo needs the moment
it offers two rulesets. The game currently reports raw chips, which are not
comparable across rulesets at all.

---

## 2. What the game has that the site never will

The website records **outcomes**: who won, how big, who paid. It is a scorekeeper
for games played on a real table, so a decision that was never written down does
not exist.

The game records **decisions**. `game_move` already holds one row per graded
human choice:

```sql
hand, turn, kind, played, engine_pick, gap, top1_minus_top2, reason
```

- `gap` — what your choice cost against the engine's pick, in its own units. 0 = matched.
- `top1_minus_top2` — how much better the engine's first choice was than its
  second. **Near zero means the position was forced**, and agreeing there says
  nothing about you.
- `reason` — why the engine preferred what it preferred.

Nothing on the site can produce any of this, and the demo has been collecting it
since the first tester. It is currently uploaded and never looked at.

`top1_minus_top2` is the one that matters most and is the easiest to waste, and
**measuring it changed what I thought it would say.** I assumed a raw match rate
would flatter players by scoring forced moves as successes. Built against the
447 real graded moves (`stats-lab.html`), it does the opposite:

| difficulty | moves | agreement |
| --- | ---: | ---: |
| forced — engine indifferent | 117 | 71% |
| near-tie | 227 | **29%** |
| a real choice | 48 | 42% |
| clear | 7 | 86% |
| obvious | 48 | **94%** |
| **all** | **447** | **49%** |
| **decisions that cost something** (≥0.5) | 103 | **69%** |

A U. Testers play the obvious moves right and diverge on the close ones, and
the near-tie band is HALF of every move ever graded — so the headline 49%
*understates* them, because diverging on a near-tie is worth almost nothing by
definition. The single number is not just noisy, it points the wrong way.

---

## 3. Proposed

### Tier 1 — the site's stats, for the game (mostly reuse)

1. **Headline tiles**, site vocabulary: GAMES · WORTH/HAND · WIN RATE · DEAL-IN RATE.
2. **Score progression**, one line per seat, per match. `chart.ts::progressionSvg`
   is already exactly this and is worth porting rather than rewriting.
3. **Hand distribution** — faan histogram, faint line per match, bold aggregate,
   `hands`/`points` toggle. Straight port of `fanHistChart`.

### Tier 2 — move quality (new ground, game only)

4. **Agreement by decision difficulty.** Bucket every graded move by
   `top1_minus_top2` and show agreement in each bucket. Separates "you agreed
   because there was nothing else to do" from "you found it". The single most
   honest number available, and only the game can compute it.
5. **Error distribution.** Histogram of `gap`. Most moves are 0; the story is the
   shape of the tail.
6. **Where errors happen.** Mean `gap` by turn within a hand — does anyone drift
   as the wall shortens? — and by `kind` (discard / claim / pass / kong).
7. **Your worst moves.** Top N by `gap`, drawn as tiles: what you played, what the
   engine played, and the `reason`. Almost certainly the most *useful* thing on
   this list for an actual player, and the cheapest to build.

### Tier 3 — bots vs humans

8. **Agreement over time** — is a tester improving across matches?
9. **Per-bot results** — `seatWins` is already stored per seat, so which ladder
   rung beats people is answerable today and has never been asked.

---

## 4. The obstacle I claimed, and why it was wrong

I first wrote that per-hand faan and chip totals "are not stored", so the two
ported charts had no server-side source. **That was wrong, and the owner was
right to push back: the entire game IS stored.**

`actions_gz` is the complete action log, the reducer is pure, and replaying the
inputs regenerates every event exactly. `engine/test/replay-upload.test.ts`
proves it against **real traffic** — the fixture is Auhie's 7-hand match pulled
out of the live database:

```
672 actions  ->  1365 events  ·  7 hands  ·  5 wins
final standings [-288, 0, 272, 16]  ==  the chips column in game_match
```

Every `handEnd` payload carries what a stats page needs:

```json
{ "outcome": "winOnDiscard", "winner": 2, "loser": 0, "faan": 8,
  "chipDeltas": [-128, 0, 128, 0], "standings": [-160, 0, 176, -16],
  "dealerRepeats": true, "nextDealer": 2, "nextRoundWind": 0 }
```

- `faan` per win → the **hand distribution** chart. That match: 5, 4, 8, 4, 7.
- `standings` after every hand → the **score progression** chart, one line per
  seat, which is exactly what `chart.ts::progressionSvg` already draws.
- `outcome` distinguishes 流局, which a faan histogram has to exclude — two of
  Auhie's seven hands were draws.

So **no migration and no new columns.** What is missing is not the data, it is
a *queryable* form of it: SQL cannot see inside a gzipped blob.

### What actually needs building

A replay step. Two shapes, and the choice is real:

- **Replay on read.** The stats endpoint ungzips and replays the matches it
  needs. Nothing new is stored and it cannot drift from the truth, because the
  truth is recomputed every time. 672 actions replay in ~25ms, so a page over
  a few dozen matches is fine; it wants a cache once the demo has hundreds.
- **Replay on write, into a `game_hand` table.** One row per hand — faan,
  outcome, chip deltas, standings — written when the match uploads, and
  backfilled for the four matches already in D1 by replaying them once. SQL can
  then aggregate directly, which every chart here wants.

**Recommendation: replay on write.** The read path stays a plain query, the
charts get to be SQL rather than JavaScript over blobs, and the backfill is
cheap because the fixture test already shows the replay is exact. Keep
`actions_gz` regardless — it is the source, and `game_hand` is a derived cache
that can always be rebuilt from it.

### Suggested first build

Chart 7 (your worst moves) and chart 4 (agreement by difficulty) still come
first: `game_move` is already queryable and needs none of the above. Then
`game_hand` and the two ported charts.

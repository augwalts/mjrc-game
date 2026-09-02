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

`top1_minus_top2` is the one that matters most and is the easiest to waste. A raw
match rate counts forced moves as successes, so it flatters everyone and drifts
toward the share of positions that were obvious. Filtering to real decisions is
what makes the number mean something — the column exists precisely so that is
possible, and nothing yet uses it.

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

## 4. The one real obstacle

**Per-hand detail is not stored.** `MatchRec` keeps `chips[]` (final only),
`hands`, `won`, `selfDrawn`, `fed`, `drawnHands`, `seatWins[]` — and **no faan per
win and no per-hand chip totals.**

So charts 2 and 3 have no source, and this splits by surface:

| | client (your own games) | server (across testers) |
| --- | --- | --- |
| source | the local **event log** has everything | needs work |
| cost | none — build today | see below |

Server-side has three options:

- **A — replay `actions_gz`.** The action log is uploaded and the reducer is
  pure, so replaying regenerates the events exactly. Nothing new to store, and
  it is correct by construction. Costs CPU per request, so it wants caching.
- **B — add summary columns**: faan per win, per-hand chip totals. A migration
  and a client change, and it silently misses every match already uploaded.
- **C — client-only for now.** Charts 2 and 3 on your own games, tiers 2 and 3
  shared. Ships immediately and defers the decision.

**Recommendation: C now, A when the shared versions are wanted.** Tier 2 is the
genuinely new thing and needs none of this — `game_move` is already in D1 and
already complete.

### Suggested first build

Chart 7 (your worst moves) and chart 4 (agreement by difficulty). Between them
they answer "am I any good and where exactly am I losing it", they need no
schema change, and they use the data the demo was built to collect.

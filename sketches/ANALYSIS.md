# Review metrics & observer mode

Two questions: what is mahjong's eval bar, and what does watching a finished hand look like.

---

## 1. Why chess's eval bar does not port

Centipawns work because chess is perfect-information, two-player, and deterministic. One
scalar says who is winning, and it only moves when someone moves.

Mahjong breaks all four:

| Chess | Mahjong |
|---|---|
| Perfect information | Hidden hands — any number is conditional on what is observable |
| Two players | Four; "winning" is not one axis |
| Deterministic | Stochastic — **eval moves on random draws, not just on decisions** |
| One outcome type | Win / deal in / be tsumo'd / draw, with wildly different values |
| No floor | **HK's 3-faan minimum**: a ready 聽牌 ting paai hand can be worth literally zero |

The third row is the one that matters most, and it is addressed in §3.

## 2. The one number: expected chip delta

If there must be a single number, it is **expected chip delta for the current hand** — how
many chips you expect to gain or lose from this position through hand end.

It is the right choice because it:

- is zero-sum across four seats, so the four numbers sum to zero and the display is honest;
- folds win probability × value, deal-in probability × cost, and the draw branch into one
  quantity without hiding any of them;
- handles the 3-faan floor automatically — a hand that cannot legally reach 3 faan has a
  zero-valued win branch, so its EV collapses to deal-in risk, which is exactly the truth;
- is denominated in chips, which the player already understands. No invented unit.

**Tier the decomposition by payment bracket, not by arbitrary bands.** Your instinct to tier
is right, but 1-3 / 3-5 / 6-7 are not where the money steps. HK payment roughly doubles per
faan, so the brackets in the payment table *are* the value discontinuities. Use them:

| Bracket | Meaning |
|---|---|
| 0-2 faan | **cannot be won** — a category, not a low tier |
| 3-4 | minimum win |
| 5-6 | solid |
| 7-9 | big |
| 10-12 | near limit |
| 13 the limit 爆棚 baau paang | limit |

So the readout is: one number (expected chips), expanding into P(win) split by bracket,
P(deal in), P(draw). One glance, full detail on demand.

## 3. Separating skill from luck — the thing chess does not have to do

In chess, Δeval between your moves is your fault. In mahjong your EV moves for two unrelated
reasons: **what you chose**, and **what the wall gave you**. Show one line and players will
blame themselves for variance, in a game that is mostly variance. That is a retention problem
and an honesty problem at once.

Decompose every step:

```
ΔEV  =  decision effect  +  chance effect

decision effect = EV(what you did) − EV(best available)     ≤ 0 always. This is skill.
chance effect   = everything else                            the draw, and what opponents did.
```

The decision effect is the honest blunder metric, denominated in chips, and it maps directly
onto chess.com's Inaccuracy / Mistake / Blunder — with thresholds set in chips rather than
centipawns. The chance effect is explicitly labelled as not your doing.

**A review that tells a player "you lost 40 chips of EV here, 38 of it was the draw" is more
useful and more trusted than one that just shows a line going down.**

## 4. What ships when

### Now — exact, no theory, already implemented in the sketch
- **Distance-to-ready away from ready 上聽 soeng ting** — distance to a winning hand. Unpruned recursive decomposition, ~7µs per call,
  matching the Python reference's 9.1µs. (Do not port the prune: wrong on 6-10% of hands.)
- **Live tiles 有效牌 *jau haau paai*** — which tiles advance the hand, and how many copies remain unseen, computed from
  what was actually visible at that moment.
- **Faan-floor status** — can this hand legally reach 3 faan. Rule-derived.
- **Rule-derived key moments** — dealt in, melded below the floor, passed a legal win,
  discarded a tile with 2+ of 4 already visible.

These are facts. They cannot be wrong, and distance-to-ready + live tiles 有效牌 *jau haau paai* is already the readout serious
Riichi players live on.

### Next — simulation-derived (Track R, §7)
The engine runs ~110K hands/sec. Freeze the known state, randomise the unknown, roll out, and
count outcomes. That yields P(win), P(deal in), the faan distribution, and expected chips —
with no human corpus required, which is the point §1 makes about simulation preceding data.

### The dependency to be honest about
**Rollout quality is policy quality.** With today's placeholder bots as the rollout policy the
numbers would be systematically wrong. A confident-looking number is more dangerous than a
suggestion, because it looks authoritative — the §7 "strong player screenshots one wrong call"
risk, amplified. So the eval bar ships when the policy is good enough, and not before. The
sketch deliberately renders the bracket legend and leaves the bar undrawn.

## 4b. Hand review — your seat, with the table around it

Review and observer are the same shape, different vantage. Review is a **play-by-play from
your seat**: pick a turn and see both what you did and what the table looked like at that
moment.

- **Hand evolution** — one row per turn, your whole hand rendered, with what came in and what
  went out marked. Reading down the page shows the hand changing. Draw-and-cut drew and cut 摸切 mo cit (cutting the tile
  you just drew) gets its own state, because "the draw did nothing for you" is different
  information from "I drew X and cut Y".
- **The table at that turn** — the same mini-table diagram observer uses: discards, exposed
  melds, whose turn, the wall.
- **Opponents** — what was public: melds, flowers, discard counts.
- Selecting a turn moves the chart marker, the table, and the opponent panel together.

**Opponents' concealed hands are hidden by default, and "reveal" is opt-in.** The point of
reviewing from your seat is to judge your decisions against what you could actually have
known. Showing their hands first is hindsight poisoning — you will "see" the deal-in you had
no way to see. Reveal exists because it is genuinely instructive after you have formed a view,
which is why it is a deliberate second click rather than the default.

## 5. Observer mode

**The physical-table metaphor is what makes this feel unsolvable** *as the whole answer*.
Four hands on a round table means two are sideways and tiny, and comparing them means rotating
your head. But dropping the table entirely loses the thing a table is genuinely good at:
seeing at a glance what is going on.

So it is a **hybrid**: a mini table for orientation, analytical lanes for meaning.

Observing a finished hand is a different job from playing one. You are not choosing a discard;
you are asking who was close, who pushed, who folded, and where the danger was. That is a
comparison, so the layout should be a comparison:

1. **Mini table** — a *diagram*, not a second copy of the match UI. Seats, winds, whose turn,
   exposed melds, the discard pile and the wall count. Flat top-down rather than in
   perspective: perspective is for playing, an analytical view wants something you can read
   straight down. No hands on it — those live in the lanes, so nothing is drawn twice.
2. **Readiness race chart** — all four seats on one time axis, with a shaded ready band ready 聽牌 ting paai. This
   is the narrative view: two lines entering the band together *is* the drama of the hand, and
   it is legible in one glance. Nothing physical can show you this.
3. **Four aligned lanes** below — per seat: wind, name, ready 聽牌 ting paai badge, **what they were waiting
   on and how many copies were live**, hand face-up, melds, flowers, discards.
4. **One scrubber** driving all three.

Reading down a column compares seats at one moment; reading across compares moments for one
seat. The table answers "what is happening"; the lanes answer "what does it mean".

### The security line
This uses the **omniscient serializer** (§5.5), which is legitimate *because the hand is over*.

**Live spectating may not.** A spectator relaying hands to a seated player is a straightforward
cheating vector. Live spectating must be delayed or redacted — which makes post-hoc observer
and live spectator two different products with two different serializers, not one feature with
a flag. Worth deciding before either is built.

### Later
With all four hands known, the log can mark **every deal-in tile that was ever discarded** —
"you discarded 5筒 on turn 6; Kai was waiting on it from turn 4." That is the single most
instructive thing in a mahjong post-mortem and it is pure log analysis, no evaluator needed.

---

## Appendix — performance note

`observerSeries()` recomputes a fold plus four distance-to-ready calls per event step, which is O(n²).
At 204 events that is ~56ms — fine for a sketch, not fine for a full match. Fold forward once
and cache per-step distance-to-ready when this becomes real.

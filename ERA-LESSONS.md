# Four eras of bot training — the lessons, and the case for era 5

One line per era first, then the detail.

| era | regime | outcome | one-line lesson |
|---|---|---|---|
| 1 | evolve vs defenseless v0 | **+40 real** | evolution works — but only against an absolute yardstick |
| 2 | evolve vs v1 (a defender) | +12, then 14 straight rejections | dial-tuning saturates; new weights ≠ new play |
| 3 | + capabilities, chips fitness | par on chips, rich in rulings | capabilities alone don't score vs bots; fear is dead weight bot-vs-bot |
| 4 | league exam + CMA + margin 6 | **+17 real** | the selection regime matters more than search effort |

## Era 1 — evolution works, and it audits you (vs baseline-v0, +40)

- **Mirror self-play taught nothing** (runs 1–8: zero real progress — self-play is zero-sum and
  cannot show absolute improvement). The breakthrough came immediately once training faced a frozen
  external baseline. Lesson: *always have an absolute yardstick.*
- What it learned was legible: faanWeight +70%, aggression +65%, safety −33% — it beat the
  self-draw-tax problem not by folding better but by **winning first**. Offense compounds.
- It **partially reverted hand-built features** (chipValuation −43%): the optimizer is an audit of
  your design priors, and it was right.
- The era also seeded the measurement canon the hard way: cross-block comparisons crowned variance
  (the false hall of fame), and the celebrated +70.2 peak was later shown to be ~+40 of true skill
  plus block luck.

## Era 2 — the saturation proof (vs baseline-v1, +12 then stall)

- Two admissions in the first three cycles, then **fourteen consecutive rejections at par**. Against
  an opponent that defends, re-balancing the existing 19 dials was exhausted within hours.
- Corroborated independently: hand-tuned "defender" profiles lost to everything (bolt-on defense
  −21 vs even the defenseless baseline). *Neither evolution nor hand-tuning could squeeze more play
  from the same senses.*
- The same-block admission gate proved itself: the king defended 14 challenges legitimately.

## Era 3 — null on chips, the richest in rulings (capabilities, par)

- Given score awareness, an evolvable hard fold, and feed denial, evolution issued verdicts:
  **fold trigger nearly doubled (fold rarely), continuous threat-sensitivity gutted −76%, feed
  denial rejected, trailSwing untouched.** Bot-vs-bot, fear is mostly dead weight — the empirical
  answer to the owner's "what's the mathematically correct fold?" (against non-bluffing opponents:
  far less than a human folds).
- **Fun is nearly free**: persona-action (king minus the turtle apparatus) tied the king within ~3
  chips. The whole behavior the owner disliked at the table costs nothing to remove.
- **Style non-transitivity**: a maniac farms a table of turtles (+28) and a turtle farms a table of
  maniacs (+30). Single-enemy training therefore rewards style-matching, not strength — the
  motivating discovery for era 4.
- Process lesson, honestly earned: too many mid-era changes (cycle length, mutation operator, sigma
  schedule, engine swap, second-session restarts) — the null result is trustworthy, its attribution
  is not. And 26 admissions at a +4 margin produced a sideways random walk: **margins must scale
  with how often the gate is tried.**

## Era 4 — regime beats effort (league + CMA, +17 real)

- Same genome as era 3; only the *exam* changed (mean vs {v3, v2, persona} on shared walls, margin
  6, CMA-ES every third cycle) — and real progress returned: **+17 league chips over baseline-v3**,
  confirmed paired on fresh blocks.
- The league partially **reversed** era 3's choices (claims +307%, threat-push +147%, fold threshold
  back down): era 3's dials weren't wrong, they were overfit to one enemy. *What you train against
  shapes what you become more than how hard you train.*
- With 2.5-minute cycles (the distance-engine DP), training became interactive — the plateau after
  cycle 84 was visible in real time, and stopping on sight was correct.
- Hand-designed candidates matched evolution's output (persona ≈ king): human insight through the
  same admission gate is a legitimate candidate source.

## The cross-era canon (the durable part)

1. **Name the enemy** on every number; scores are meaningless without it.
2. **Only paired same-walls comparisons and multi-block means are load-bearing**; a single held-out
   exam carries ±16 of block luck. Trust verdicts and trajectories, not points.
3. **All-seats evaluation** — a bot benched against itself must score exactly 0.
4. **Keep the reference oracle** when optimizing correctness-critical code (250k-hand fuzz).
5. **Archive every era and cycle** — the cycle-7 exhumation settled a real dispute.
6. **One change per era.** Attribution dies otherwise.

## Era 5 — what to test and improve

Search is exploited (two optimizers), regime is exploited (league). What remains is **new pressure
and new senses**, and the owner's own table play has already located the targets:

1. **The anti-exploit league** (recommended core). Script two adversaries that embody the known
   human exploits — a **bluffer** (cheap junk exposures to trigger table-wide folds) and a
   **concealed stylist** (never claims; attacks through the 90% blind spot) — and put them IN the
   league. Success metric: the chips those two exploits currently farm from the champion, driven
   toward zero while overall league score holds. This makes the training pressure match reality
   (humans), not just bot ancestry.
2. **Deception-aware threat features** (the new sense that pairs with #1): threat should weigh
   exposure against what it actually threatens — two junk pungs ≠ a half-flush machine — plus
   discard-timing tells for concealed seats. New dials, evolvable, measured by the threat-audit's
   exposed/concealed split.
3. **查叫 (not-ready pays ready at a draw)** — awaiting the owner's ruling. Authentic HK, the only
   direct economic pressure against turtling and the ~25% draw rate.
4. **Process upgrades**: freeze the era config before launch (no mid-era changes); margin scaled to
   attempts; a decision-temperature dial (product need for difficulty tiers, and it would also give
   rollout odds honest variance).
5. **Human calibration log** on the play page: predicted odds vs the owner's realized outcomes —
   a dozen matches yields the first "human vs champion-in-your-chair" skill measurement, the number
   the whole ladder ultimately exists to serve.

The through-line of all four eras: every leap came from changing **what the bot is measured
against** — a yardstick (1), a defender (2), a league (4) — and the one stall came from changing
only what the bot *is* (3). Era 5 should follow the winning pattern: put the human exploits in the
exam, then let the machine figure out the rest.

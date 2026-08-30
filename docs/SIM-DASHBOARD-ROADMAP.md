# Sim dashboard — roadmap (2026-08-28)

Dashboard: https://augwalts.github.io/mjrc-game/tools/sim/panel.html
Source: `mjrc-game/tools/sim/panel.html` (repo `augwalts/mjrc-game`, branch `engine-v1`)

## Shipped 2026-08-28 (commit 116a2cc)

- **Overall tab · "Cycle texture" section** — proper per-cycle plots (real axes,
  era boundaries, tooltips, ±2SE bands): exam chips/match, claim mix
  (pung/chow/kong), claims/hand, self-draw vs discard wins, mean faan, draw
  rate, challenger economy (won/lost/deal-in), 8+ faan share. Renders even
  during the blank window at cycle start.
- **Extended exam STATS** (`headtohead.ts`) — counts, chipsSD (→ the ±2SE band:
  ~±21 chips on a 160-match block), self-draw share, claim mix, challenger
  chip decomposition (won / lost / deal-in loss / deal-in count / tax).
  Flows into the log from era-3 cycle 3 on.
- **Era-label bug fixed + archive repaired** — `overnight.mjs` archived every
  cycle as era 2; era-3 points were mislabeled and clobbered same-numbered
  era-2 cycles. Source fixed, archive restored, panel relabels defensively
  while tonight's (pre-fix) process runs. After era 3 ends, run once:
  `node tools/sim/repair-series-history.mjs`.

## Data already available, unplotted (per-generation bench, in data.js)

The bench runs 192 all-seat matches (~1,475 hands) per generation — a larger
sample than the cycle-end exam — so per-generation tactical texture within a
cycle is statistically meaningful:

- `bench.activity.patterns` — full winning-pattern census (halfFlush, allPungs,
  fullFlush, dragonPung, concealedHand, thirteenOrphans, …)
- `bench.activity.faanHist` — full faan histogram per generation
- `bench.activity` chows/pungs/kongs, winsOnDiscard/selfDraws
- won/lost/deal-in/tax decomposition per generation (already partly shown in
  the chips KPI card, not plotted)

## Shipped 2026-08-28 pm (commit 51d8b04) — Current-cycle tab + goal badges

1. **Hand types by generation** — share-of-wins lines (halfFlush, allPungs,
   fullFlush, concealedHand, allChows) + full latest-gen census table.
2. **Claim mix by generation** — chow/pung/kong per hand.
3. **Win mix by generation** — self-draw vs discard wins per hand.
4. **Faan distribution** — latest-gen histogram + 8+ tail trend.
5. **Goal badges on every chart** — ▲ WANT UP (chips, threat detection,
   challenger won), ▼ WANT DOWN/→0 (refused wins, |lost|, deal-in loss),
   ▭ TARGET 10–20% (draw rate, band drawn on the plot), ◇ TEXTURE — NO
   TARGET (claim mix, hand types, win mix, mean faan, 8+ share — deliberately
   unbadged with a direction: no owner ruling exists, so none is invented).
   Bench labels now derive from the actual baseline file (era-3 = baseline-v2
   was being mislabeled by a v1-or-v0 binary).

## Shipped 2026-08-28 eve (commit 43665c3) — the harness-side backlog

6. **Hand-type mix per cycle (Overall tab)** — pattern shares + 8+ faan share
   archived per generation; archive regenerated from git (832 points, eras
   1–3, including era-2 cycles 17–18 the old archive never captured). Chart:
   5-pattern meta over the full 61-cycle history.
7. **Challenger-only claim mix** — per-seat claim counters in `driver.ts`
   (kongs incl. concealed/added); exam STATS carries `me.claims`; new chart
   compares the challenger's calling style against the table's.
8. **Pattern census in exam STATS** — table-wide `patternShares` and
   challenger `me.patternShares` per cycle exam.

Notes: challenger claim mix / pattern census fill in from the next era-3
cycle; the hand-type history is complete now. `evolve.mjs` was deliberately
NOT rebuilt under the live run (another session has uncommitted evalcore.ts
WIP that a rebuild would sweep in); other tool bundles pick up the driver
counters whenever they are next rebuilt.

## Remaining

- After era 3 ends: re-run `node tools/sim/build-series-history.js --backfill`
  (fills tonight's era-3 points with pattern shares and correct labels; the
  git-scan is immune to the running process's era-label clobber, making
  repair-series-history.mjs a backup rather than a necessity).
- Owner rulings welcome on texture targets (e.g. desired chow share or
  claims/hand band) — any ruling converts a ◇ TEXTURE badge into a real
  target on the charts.

## Working constraints

- The overnight process auto-commits `panel.html`, `data.js`, `log.js`,
  `series-history.js`, `STATUS.md` on `engine-v1` every cycle (plus a 4-minute
  mid-cycle tick). Commit between benches; stage explicit paths only —
  multiple sessions share this tree.
- Harness stat changes are counters-only and land mid-era with a "from cycle
  N" caveat; anything touching decisions or the driver waits for an era
  boundary.

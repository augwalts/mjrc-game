# Review guide — mjrc-game engine snapshot 2026-08-27

For an external reviewer (human or AI). One session built this; assume bugs exist.
HK mahjong only — `TERMINOLOGY.md` bans Japanese terms repo-wide.

## What to review hardest, in order

1. **`engine/src/scoring.ts` + `rulesets/src/patterns.ts`** — faan scoring and
   subsumption. Wrong scoring is the product-killing failure. The subsumption
   edges marked "Owner ruling 2026-08-26" are deliberate; challenge the REST.
   Cross-checks that already exist: `engine/test/reference-scorer.ts` (an
   independent brute-force scorer; both agree on 40k random hands under both
   presets) and 124 golden fixtures in `engine/test/golden/`.
2. **`engine/src/reducer.ts`** — the match state machine (claim priority,
   kongs, flower replacement, dealer rotation). Replay = re-execution, so any
   hidden nondeterminism corrupts the archive. `Math.random`/`Date.now` are
   banned from game state; check we didn't slip.
3. **`engine/src/ready.ts`** — distance-to-winning-shape. Two real bugs were
   already found here by an exhaustive reference (see header comments); it now
   agrees 800/800, but the leaf-recursion is subtle. Complexity review welcome.
4. **`engine/src/bots.ts` + `engine/src/threat.ts`** — the opponents. BotProfile
   weights are evolution-tuned; threat.ts (opponent modeling) is new and an A/B
   showed it does NOT yet pay (−6.5 chips/match held-out) — critique the signal
   design. `tools/sim/evolve.ts` is the self-play loop (placement-point fitness,
   two-stage confirmed promotion after runs 1–2 promoted 25 flukes).
5. **`worker/src/table.ts`** — Durable Object; written but never run against
   real Cloudflare infra. The alarm multiplexer and outbox deserve scrutiny.

## Data included

- `tools/sim/data.js` — evolution run history (weights, metrics per generation)
- `tools/sim/best-profile.json`, `run1-best-profile.json` — evolved weights
- `engine/test/golden/` — the scoring fixture corpus + `AUDIT.md`, `CONTESTED.md`

## Added 2026-08-27/28 — the sim/ML stack (review this too)

6. **`engine/src/threat.ts` + the step-zero wiring in `bots.ts`** — opponent
   reads (suit-phasing, honour timing, intent) feeding route choice via
   urgency/suit-contest/left-feed/claim-supply terms. Measured weak: 35%
   detection, 72% false alarms (`tools/sim/threat-audit.mjs`) — signal-design
   critique is the most valuable review here.
7. **`tools/sim/evolve.ts` + `evalcore.ts` + `evalworker.ts`** — (1+6)
   evolution, placement-point fitness, two-stage confirmed promotion, parallel
   workers (serial path byte-matches), per-generation benchmarks vs a frozen
   baseline AND vs the run's start profile.
8. **`tools/sim/overnight.mjs`** — unattended cycle harness: hall-of-fame with
   SAME-BLOCK admission (an earlier cross-block comparison crowned a variance
   fluke — check the fix is airtight), per-cycle git pushes, live 4-min data
   ticks. History of subtle bugs: TDZ crash, cwd-dependence, stale anchored
   edits. Assume more exist.
9. **`tools/sim/panel.html`** — the dashboard (hosted via GitHub Pages).
   All rendering is hand-built JS over data.js/overnight.js; review for
   metric mislabeling — a wrong label here misleads every decision we make.

## Known open items (do not "discover" these)

- Threat feature is calibration-unproven (dials default 0 = off).
- `kongs-double-kong-replacement`: 槓上槓 not expressible in WinContext; scored
  as single kong-replacement, documented contested.
- Worker package untested against real runtime; client package is contracts only.
- Golden cases are `provisional: true` pending a strong HK player's sign-off.
- Current defaults LOSE to `baseline-v0` (~−18 chips/match, mostly self-draw
  tax = speed). The overnight series is searching; an empty hall of fame is a
  legitimate outcome meaning the dial-space is exhausted.
- Threat detection precision is poor (see item 6) — known, quantified.

## The dashboard

Live: https://augwalts.github.io/mjrc-game/tools/sim/panel.html
Source: `tools/sim/panel.html` · data contracts: `data.js` (per-generation),
`series-history.js` (longitudinal archive), `overnight.js` (series), and
`baselines.js` (historical reference).
Mobile text status: `tools/sim/STATUS.md` (pushed every cycle).

## Build/test

    npm install && npm run typecheck && npx vitest run    # full suite ~5 min (bot sims)


## 10. Panel & sim data pipeline (added 2026-08-28 — owner wants an external audit)

The dashboard is `tools/sim/panel.html` (hosted: https://augwalts.github.io/mjrc-game/tools/sim/panel.html).
It renders six window-globals from several producers — audit the CHAIN, not just the page:

| data file | producer | contents |
|---|---|---|
| `data.js` (`window.SIM_DATA`) | `tools/sim/evolve.ts` (via `evalcore.ts` + `evalworker.ts` + `driver.ts`) | live cycle: per-generation history, bench vs `--baseline`, per-gen dial changes, faan histograms, threatDetection |
| `series-history.js` (`SERIES_HISTORY`) | backfilled by `tools/sim/build-series-history.js` from committed cycle-end `data.js` snapshots; updated after future cycles by `overnight.mjs` | compact longitudinal generation metrics across all recoverable cycles, with explicit era/cycle/gen coordinates |
| `overnight.js` (`OVERNIGHT`) | `tools/sim/overnight.mjs` | series state: cycles, hall-of-fame score |
| `log.js` (`SERIES_LOG`) | `overnight.mjs` (from `overnight-log.jsonl`) | every cycle both eras; era-2 rows carry `enemy`, `ts`, `stats` (from headtohead's `STATS` JSON line) |
| `experiments.js` (`EXPERIMENTS`) | curated by hand | the experiment ledger |
| `baselines.js` (`BASELINES`) | curated | era texture reference points |

Things the owner keeps catching (verify these classes of bug are gone, and hunt for more):
1. **Wrong data source for a chart** — texture KPIs must read `bench` (fixed enemy) not `control` (opponent alternates mirror/baseline per cycle).
2. **Unlabeled/auto-zoomed axes** — every chart must show y ticks and generation x-labels; rates zero-based.
3. **Scores without a named enemy** — every chips number must say who it was earned against.
4. **Fixed-seed seat-luck bias** — all benches/headtoheads must be all-seats (mirror == exactly 0). Check `evalcore.evaluate` allSeats and `headtohead.ts` seat loop.
5. **Misattributed think blocks / stale labels** in `transcribe.ts` (fixed once — seat names must come from live wind mapping).
6. Cross-check every number the panel shows against its producer's units (chips vs placement points; per-match vs per-hand).
7. **Wrong time scope** — the Overall tab uses `SERIES_HISTORY` across all cycles, while the Current Cycle tab uses only `SIM_DATA.history`; a moment-in-time value must never be labeled as a longitudinal KPI.

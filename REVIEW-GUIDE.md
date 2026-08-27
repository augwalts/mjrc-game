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
`overnight.js` (series), `baselines.js` (historical reference), `threat-audit.js`.
Mobile text status: `tools/sim/STATUS.md` (pushed every cycle).

## Build/test

    npm install && npm run typecheck && npx vitest run    # full suite ~5 min (bot sims)

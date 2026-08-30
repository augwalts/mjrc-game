# Probes — one-off experiment profiles

Scratch bot profiles from hand-run experiments. Kept because each one is the
subject of a row in the experiment ledger (`../experiments.js`) and re-running
a claim there means loading the exact profile that produced it.

| file | experiment | result |
|---|---|---|
| `champ-aggro.json` | era-1 champion with aggression ×1.3, faan ×1.15, safety ×0.8 | lost to the champion 26.7 vs 31.1 — evolution's aggression was already at the optimum |
| `cand-defender.json`, `cand-defender-cautious.json` | hand-built "defender" baselines (threat dials on) | both lost to the defenceless v0 (−21.1, −22.8); bolt-on defence does not work |
| `probe-racer.json` | pure speed racer (faanWeight 0.05) under TVB | 80% of wins at the floor; validated that dials alone can produce racing texture |
| `probe-floor.json`, `probe-floor-strict.json` | discard-realistic floor test (the dial that did nothing) | ZERO behavioural change — the routes were payable on paper; hypothesis refuted |
| `probe-route-hard.json` | discardRouteWeight ×2.5 | refusals 0.19/hand — dials alone cannot fix claim drift |
| `probe-claim-tight.json` | claimRouteTolerance 0.8, claimSpeedGain 2.0 | refusals 0.00 but draws 16% → 30%: the frontier that proved "claim less" is the wrong fix |
| `probe-fb{0.5,1.5,3.0}.json` | claimFallbackWeight sweep | 0.5 is the Pareto point: refusals 0.14, draws 12% |
| `probe-kp{0.5,1.5,3.0}.json` | keepPayableWeight sweep on top of fb0.5 | 0.13 refusals, saturates immediately (binary guard) |
| `probe-owner-rules.json` | foldSizeBias 1 + belowMinimumPenalty 4 | refusals 0.15 but −8.4 TVB / −12.3 HK: hand-tuning loses, dials must be evolved |
| `cma-best.json`, `cma-log.json` | CMA-ES smoke run output | sigma self-adapted, population mean climbed — machinery verified |

Shipping profiles live one level up: `baseline-v0…v4.json` (the frozen ladder),
`persona-action.json`, `tvb-candidate.json`, `tvb-king.json`.

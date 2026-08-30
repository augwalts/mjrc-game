# tools/sim — the training and analysis stack

What lives here, and which files are canonical vs derived vs disposable.

## Canonical (hand-authored or frozen — never regenerate blindly)

- **`baseline-v0.json` … `baseline-v4.json`** — the frozen ladder. Each is a
  previous era's champion, kept forever so old scores stay meaningful. v0 is the
  original defenceless bot and is the only fixed yardstick in the project.
- **`persona-action.json`** — the champion with the turtle apparatus removed
  (costs ~3 chips, plays far more watchably).
- **`tvb-candidate.json`, `tvb-king.json`, `tvb-adapted.json`** — TVB-ruleset bots.
- **`experiments.js`** — the curated experiment ledger. Append-only; the panel's
  research archive renders it. Add a row for anything worth remembering.
- **`baselines.js` / `baselines.json`** — frozen texture reference points.
- **`panel.html`**, **`play.html`** — the dashboard and the playable game.

## Tools (TypeScript source; `.mjs` bundles are gitignored, rebuild with esbuild)

| tool | what it does |
|---|---|
| `evolve.ts` | (1+6) evolution with sparse hard kicks; `--ruleset --baseline --fitness --sigma --gens` |
| `cmaes.ts` | CMA-ES optimiser (log-space, CSA, Jacobi eig) |
| `overnight.mjs` | the unattended harness: cycles, league exams, hall of fame, archives |
| `headtohead.ts` | held-out exam, all-seats; prints a machine-readable `STATS` line |
| `evalcore.ts` / `evalworker.ts` | shared evaluation; `setSimRuleset()` selects the ruleset |
| `validate-bot.ts` | behavioural census as a pure mirror (claims, wins, hand types, faan) |
| `refusal-audit.ts` | dissects refused wins — faan held, concealment, meld shapes |
| `threat-audit.ts` | threat-model quality, split by exposed vs concealed winners |
| `transcribe.ts` | human-readable game transcripts (`--think`, `--hero`, ★ marks the hero) |
| `findbest.ts` / `watch.ts` | best-game search; terminal spectator |
| `build-dials-history.js` | scans `runs/` → `dials-history.js` (dial trajectories) |
| `build-series-history.js` | rebuilds `series-history.js` (`--backfill` scans git history) |

Rebuild a bundle:
`../../../mjrc-app/web/node_modules/.bin/esbuild tools/sim/X.ts --bundle --platform=node --format=esm --outfile=tools/sim/X.mjs`

## Derived (regenerate; safe to delete)

`data.js` (live cycle), `log.js`, `series-history.js`, `dials-history.js`,
`overnight.js`, `tvb.js`, `champions.js`, `threat-audit.js`, `overnight-status.txt`,
`overnight.out`, `best-profile.json`, `hall-of-fame*`.

## Archives

- **`runs/`** — one full dump per training cycle (~60MB, **gitignored**). The raw
  material for `build-dials-history.js`; safe to delete if space is needed, at the
  cost of being unable to rebuild dial history.
- **`era1/` … `era5-tvb/`** — each concluded era's champion, score, and log.
  `era5-tvb/bugged-prefix-artifacts/` holds output from before the ruleset-resolution
  fix, quarantined rather than deleted.
- **`probes/`** — one-off experiment profiles with a README mapping each to its result.
- **`logs/`, `best-game-champion.txt/`** — transcripts.

## Hard-won measurement rules (do not regress)

1. Every score names its **enemy**; a number without one is meaningless.
2. **All-seats** evaluation — a bot benched against itself must score exactly 0.
3. Only **same-block paired comparisons** and multi-block means are load-bearing;
   a single held-out exam carries ±16 chips of block luck.
4. Admission is same-block versus the reigning champion, margin scaled to how
   often the gate is tried.
5. Verify a new lever actually **moves the metric** before believing in it —
   four dials this project added turned out to be silent no-ops at first.

# MJRC training stack — architecture review (2026-08-28)

Scope: `mjrc-game/tools/sim/` training pipeline, its data files, the GitHub Pages panel, and repo hygiene.
Strictly read-only review — nothing was modified (a live run + a second active Claude session made that mandatory, see §4).

## TL;DR

- **There is no database.** The training stack is flat files. The canonical record is
  `tools/sim/overnight-log.jsonl` (append-only, one line per cycle). Everything else is either a
  derived view (`data.js`, `log.js`, `series-history.js`, `overnight.js` — JS globals the panel loads),
  a frozen artifact (`baseline-v*.json`, `era1/`, `era2/`), or hand-curated (`experiments.js`, `baselines.js`).
  The site's Cloudflare D1 databases (analytics, almanac rooms) are unrelated to training.
- **The viewer is a static page fed by git pushes.** The training harness itself commits data files
  into the public engine repo every ~4 min; GitHub Pages serves them. 374 of 457 commits on
  `engine-v1` (82%) are `live: mid-cycle data tick` noise.
- **Three live era-2 hardcode bugs** will misfile/hide era-3 data (§3.3) — the harness relaunched at
  ~12:35 today still carries them.
- **A second Claude session is actively editing and respawning the harness right now** (§4). This is
  the single biggest operational risk in the whole setup.
- Overall verdict: the *data model* is sound (append-only ledger, derived views, frozen era archives,
  `sourceCommit` provenance). The *packaging* is disorganized: telemetry polluting a public code repo,
  an incomplete published toolchain, naming traps, and dead experiment files littering the live directory.

## 1. Component map

### Processes (what runs during a training night)

```
caffeinate -is node tools/sim/overnight.mjs --hours 20 --era 3 \
  --enemy tools/sim/baseline-v2.json --seed-profile tools/sim/era3-start.json \
  --fitness chips --gens 8
```

- **`overnight.mjs`** — the harness. Loop: spawn `evolve.mjs` (one cycle, varied opponent/matches/mutseed)
  → held-out `headtohead.mjs` admission on a virgin seed block (+4 chip margin, same-block, all-seats)
  → update hall of fame → write status/log/panel files → `git add/commit/push`. Also runs a background
  "tick" that pushes `data.js`/`overnight.js`/`log.js` whenever `data.js` changes (≥4 min apart).
- **`evolve.mjs`** — per-generation evolution. Writes `data.js` after each generation. Heavy work is
  fanned out to **`evalworker.mjs`** child processes (job JSON on stdin, result on stdout).
- **`headtohead.mjs` / `transcribe.mjs` / `findbest.mjs` / `watch.mjs`** — evaluation and inspection tools.
- All tools are authored as `.ts` and bundled to `.mjs` with mjrc-app's esbuild; **the `.mjs` is what runs.**

### Data files in `tools/sim/` — who writes what

| File | Writer | Role |
|---|---|---|
| `overnight-log.jsonl` | harness (append-only) | **canonical ledger** — one JSON line per cycle |
| `data.js` | `evolve.mjs`, per generation | live current-cycle detail; **reset every cycle** |
| `runs/era{N}-cycle-{NNN}.js` | harness (copy of data.js) | per-cycle archive of the generation detail (dir created on first completed cycle) |
| `series-history.js` | `build-series-history.js` | longitudinal per-generation archive across eras (390 KB), with `sourceCommit` provenance |
| `overnight.js` | harness `flushPanel()` | series status line, deadline, cycles-so-far (a *data* file, despite the name) |
| `log.js` | harness | derived: jsonl re-serialized as `window.SERIES_LOG` |
| `experiments.js` | hand-curated | the experiment ledger (append manually) |
| `baselines.js` / `baselines.json` | hand-curated | frozen-champion metadata |
| `baseline-v0/1/2.json`, `era3-start.json` | frozen | bot profiles (enemy / seeds) |
| `hall-of-fame.json` + `hall-of-fame-score.txt` | harness | reigning champion (currently deleted — fresh era 3) |
| `era1/`, `era2/` | archived at era close | champions, final HOF, raw `.out` logs |
| `STATUS.md` | harness, per cycle | mobile-readable summary, pushed to GitHub |
| `overnight-status.txt`, `overnight.out` | harness / nohup | local-only status (both currently stale/empty) |

The `window.*` JS-global format is deliberate: the panel must also work from `file://`, where `fetch()`
of local JSON is blocked. Reasonable design, documented in the code.

## 2. What's on GitHub, and how the viewer gets data

- Repo: **public** `augwalts/mjrc-game`, GitHub Pages serving branch `engine-v1` at repo root.
- Panel: `https://augwalts.github.io/mjrc-game/tools/sim/panel.html`.
- **The harness is the publisher.** Mid-cycle ticks push 3 files; end-of-cycle commits push
  `STATUS.md`, the jsonl, HOF, `series-history.js`, `experiments.js`, `baselines.js`, `panel.html`.
- Panel boot: appends 6 cache-busted `<script>` tags (`overnight.js`, `series-history.js`, `baselines.js`,
  `experiments.js`, `log.js`, `data.js`); a missing file does not block boot; page self-reloads every 45 s;
  a STALE banner fires when the newest of `data.js.updated` / `overnight.js.now` is older than **8 minutes**.

## 3. Why the hosted viewer "never seems to work"

Four compounding causes, ranked:

1. **The 8-minute heartbeat is structurally too tight.** `data.js` only changes when a generation
   finishes (~2–4 min at era-2 cadence), ticks push at most every 4 min, and a Pages build adds ~1–2 min.
   Healthy operation regularly sits at 5–8 min of apparent age. And during the admission/bench phase
   between cycles (three 160-match head-to-heads, tens of minutes — era-2 cycles ran 15.6–38.1 min),
   `data.js` doesn't change at all, so **STALE is guaranteed at every cycle boundary.** Most of the time
   you saw "broken", the run was fine.
2. **Six files, four writers, no atomicity.** Right now the hosted set is: `data.js` from era 3 (24 dials),
   `log.js` containing only era-2 rows, `overnight.js` freshly reset ("cycle 1 evolving",
   `hofScore: null` — `-Infinity` JSON-serializes to `null`), `series-history.js` from 10:22, and an
   era-2 `STATUS.md`. Mixed-era mush is the *normal* state after a relaunch, until the first cycle lands.
3. **Era-2 hardcodes — actual bugs, live in the running harness:**
   - `overnight.mjs:134` — `updateSeriesHistory({ ..., era: 2, ... })`: every archived era-3 cycle will be
     recorded as **era 2** in `series-history.js`, corrupting the longitudinal chart's era breaks.
   - `overnight.mjs:188` — commit messages hardcoded `era2: cycle N — X vs v1` during era 3.
   - `panel.html:129` — the operational KPI strip filters `SERIES_LOG` to `r.era === 2`, so era-3 cycles
     will be invisible there (other sections compute era dynamically).
   The process that loaded this code is already running; a file fix only takes effect at the next respawn.
   Repairable post-hoc: `runs/` archives are named `era3-cycle-NNN.js` correctly, so `series-history.js`
   can be rebuilt with correct labels via `build-series-history.js`.
4. **End-of-cycle publishing can silently stop.** The per-cycle `git add` list includes
   `tools/sim/hall-of-fame.json`, which is currently deleted (fresh era). The first cycle-commit stages the
   deletion fine; but if cycle 1 doesn't produce an admission, every later cycle's `git add -f` hits a
   nonexistent pathspec, exits nonzero, and the loop `break`s **before commit/push** — STATUS.md and
   series-history stop publishing until the first era-3 hall-of-famer recreates the file. Mid-cycle ticks
   keep flowing meanwhile, which produces the confusing "half-updating" look.

## 4. Concurrency — the biggest operational risk

Observed live *during this review* (~12:30–12:37): another Claude session (the overnight-training
session, `08c8a1dd`) killed the 12:14 harness, patched `evolve.ts` (a "sparse hard kicks" mutator —
each mutant now moves 1–5 dials boldly instead of jittering all 24 faintly), rebuilt `evolve.mjs`,
smoke-tested, and relaunched the harness with `--gens 8`. Uncommitted WIP is sitting in the tree
(`evalcore.ts`, `watch.mjs`, `REVIEW-GUIDE.md`, deleted hall-of-fame files, untracked
`PANEL-REDESIGN-PROPOSAL.md`). This is exactly the known clobber hazard: two sessions sharing one tree,
one of them mid-edit on files the other might "fix". Any write to `tools/sim/` from a second session
right now risks corrupting the respawn loop. **One session should own `mjrc-game` while a series runs.**

## 5. Organization assessment

What's actually *good* (and matches the ingestion standard): append-only canonical ledger; derived
views regenerable from it and from `runs/`; frozen era archives with final champions; provenance via
`sourceCommit`; fair-admission discipline encoded in code comments.

What's genuinely disorganized:

- **Public repo pollution.** 82% of `engine-v1` history is telemetry ticks in the same public repo as
  ~19k LOC of engine code. History rewrite is now effectively impossible without breaking the harness's
  push loop and Pages.
- **Incomplete published toolchain.** `.gitignore` ignores `tools/**/*.mjs`, but 4 bundles are
  force-added (`overnight`, `evolve`, `headtohead`, `watch`) while their runtime dependency
  `evalworker.mjs` (and `evalcore.mjs`, `transcribe.mjs`, `findbest.mjs`) is **not** tracked — a clone of
  the public repo cannot actually run `evolve.mjs`. Committed bundles also silently drift from their
  `.ts` sources (`evalcore.ts` is modified in-tree right now).
- **Naming traps.** `best-game-champion.txt` is a *directory* (holding 3 match transcripts).
  `overnight.js` is data while `overnight.mjs` is the program. `data.js` / `log.js` / `series-history.js`
  overlap in purpose with no README explaining the split.
- **Dead files beside live state.** `run1-best-profile.json`, `run4-start.json`, `run5-start.json`,
  `cand-defender*.json`, `champ-aggro.json`, `threat-on.json`, `threat2-on.json`, `linear-valuation.json`
  — pre-era experiments sitting in the live directory with no manifest saying they're dead. `retired/`
  exists but holds only 2 files.
- **Stale mirrors.** `STATUS.md` and `overnight-status.txt` still describe era-2 cycle 18 (11:42);
  `overnight.out` is empty because each relaunch's `>` truncates it.
- **Workspace-root litter.** 8 untracked review docs (`ERA2-REVIEW-2026-08-28.md`,
  `THREAT-DETECTION-ANALYSIS-2026-08-27.md`, …) plus `engine.cpuprofile` at `mjrc/` root, tracked nowhere.

## 6. Recommendations (none applied — a live respawn loop owns the tree)

Cheap → structural:

1. **Fix the three era hardcodes** (`overnight.mjs:134`, `:188`, `panel.html:129`): thread `ERA` through
   `updateSeriesHistory` and the commit message; make the panel filter dynamic. Takes effect at the next
   respawn; then rebuild `series-history.js` from `runs/` to repair any misfiled era-3 cycles.
2. **Harden the publish path**: filter the `git add` list through `existsSync` (fixes §3.4), and raise the
   panel heartbeat limit to ~15 min — or scale it to the cycle's `matches` — to kill the false STALE banners.
3. **Split telemetry from code.** Point the harness's pushes at a dedicated data repo (e.g.
   `mjrc-sim-data`, with Pages) or at least a `data` branch. The engine repo's history goes back to
   meaning something, and the public repo stops being 82% ticks.
4. **Toolchain coherence**: stop committing `.mjs` bundles entirely (publish `.ts` + a documented esbuild
   command) *or* commit the complete set including `evalworker.mjs`. Half-and-half is the worst option.
5. **Directory hygiene** (idle-time task): rename `best-game-champion.txt/` → `best-game-champion/`;
   sweep the 8 dead profile JSONs into `retired/` with a one-line-each manifest; add a 20-line README to
   `tools/sim/` with the table from §1.
6. **Single-writer rule**: while a series runs, one session owns `mjrc-game` — consider having
   `overnight.mjs` write a `RUNNING.lock` (pid + launch args) that other sessions check first.

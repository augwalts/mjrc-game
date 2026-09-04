# tools/sim/ reorganization proposal (2026-08-28)

Status: PROPOSAL — nothing moved. Execution must wait until the era-3 run ends (harness has
hardcoded paths) and should be done by one session in one pass, bundled with the era-hardcode
fixes from `TRAINING-ARCHITECTURE-REVIEW-2026-08-28.md` §6.1–6.2.

## Problem

`tools/sim/` root holds ~40 loose items spanning six unrelated kinds: TypeScript sources,
compiled bundles, live run state, frozen bot profiles, dead experiments, and viewer data files —
plus naming traps (`best-game-champion.txt` is a directory; `overnight.js` is data while
`overnight.mjs` is code). Nothing marks what is canonical vs regenerable vs dead.

## Target structure

```
tools/sim/
├── README.md            # manifest: purpose, who-writes-what table, canonical vs regenerable
│
├── panel/               # THE VIEWER LAYER — every human-facing readout, one home
│   ├── index.html                 # the dashboard (was panel.html); reads ../data/
│   │                              #   local:  open tools/sim/panel/index.html (file://)
│   │                              #   cloud:  …github.io/…/panel/ via Pages — same file,
│   │                              #   only difference is data freshness (push + Pages lag)
│   ├── README.md                  # viewer inventory: this panel, watch.mjs (terminal
│   │                              #   spectator), transcribe.mjs (readable transcripts),
│   │                              #   which to reach for, local-vs-cloud caveats
│   └── PANEL-REDESIGN-PROPOSAL.md # active redesign workstream
│
├── data/                # THE "DATABASE": all machine-written run state + panel feeds
│   ├── overnight-log.jsonl        # canonical ledger — append-only, never edit
│   ├── data.js                    # live cycle detail (evolve, per gen) — scratch
│   ├── run-state.js               # series status (renamed from overnight.js)
│   ├── log.js                     # derived from the jsonl
│   ├── series-history.js          # longitudinal archive — regenerable from era dirs
│   ├── experiments.js             # hand-curated research ledger (panel-loaded)
│   ├── baselines.js               # hand-curated baselines metadata (panel-loaded)
│   ├── threat-audit.js            # panel-loaded audit data
│   ├── best-profile.json          # latest cycle output
│   ├── hall-of-fame.json + hall-of-fame-score.txt   # reigning champion
│   ├── STATUS.md                  # mobile summary, pushed per cycle
│   └── overnight-status.txt       # local one-glance status
│
├── profiles/            # frozen INPUTS — read-only once written
│   ├── baseline-v0.json · baseline-v1.json · baseline-v2.json
│   ├── era3-start.json
│   └── baselines.json
│
├── src/                 # authoritative code — the only thing a human edits
│   ├── overnight.mjs              # harness (plain JS, no .ts)
│   ├── build-series-history.js
│   └── *.ts                       # evolve, evalcore, evalworker, headtohead,
│                                  #   transcribe, findbest, watch, driver,
│                                  #   claimprobe, threat-audit
│
├── dist/                # compiled .mjs bundles — GITIGNORED WHOLESALE, rebuilt on demand
│
├── era1/                # closed-era archives — immutable once an era ends
│   ├── (existing champion/HOF/out files)
│   ├── best-game/                 # the 3 transcripts from best-game-champion.txt/
│   └── MATCH-3729651-ANALYSIS.md
├── era2/                # as today
├── era3/                # live era: absorbs runs/ → era3/cycle-001.js, cycle-002.js …
│
├── retired/             # dead experiments, each with a line in retired/MANIFEST.md
└── logs/                # gitignored transcript scratch (as today)
```

Depth stays within limits: nothing deeper than `tools/sim/<dir>/<file>` except one small
`era1/best-game/` bucket.

## File dispositions (everything currently in sim/ root)

| Current | Goes to | Note |
|---|---|---|
| overnight-log.jsonl, data.js, overnight.js, log.js, series-history.js, best-profile.json, hall-of-fame.json, hall-of-fame-score.txt, STATUS.md, overnight-status.txt, experiments.js, baselines.js, threat-audit.js | `data/` | overnight.js renamed `run-state.js` |
| baseline-v0/1/2.json, era3-start.json, baselines.json | `profiles/` | frozen inputs |
| *.ts, overnight.mjs, build-series-history.js | `src/` | |
| *.mjs bundles (evolve, evalworker, evalcore, headtohead, transcribe, findbest, watch, claimprobe, threat-audit) | `dist/` | gitignored; delete tracked copies from git |
| runs/era3-cycle-*.js | `era3/` | per-cycle archives live with their era |
| best-game-champion.txt/ (directory) | `era1/best-game/` | kills the fake-.txt trap |
| MATCH-3729651-ANALYSIS.md | `era1/` | it's an era-1 study |
| run1-best-profile.json, run4-start.json, run5-start.json, cand-defender.json, cand-defender-cautious.json, champ-aggro.json, threat-on.json, threat2-on.json, linear-valuation.json | `retired/` | one line each in retired/MANIFEST.md |
| overnight.out | delete (regenerated by nohup each launch); relaunch command writes to `logs/overnight.out` | |
| PANEL-REDESIGN-PROPOSAL.md | stays at sim root or moves to repo docs — owner's call | |
| panel.html, README.md (new) | sim root | |

## Code changes this requires (the cost)

All small, but they must land together with a rebuild + smoke test:

1. `overnight.mjs` — split `DIR = "tools/sim"` into `SRC`/`DATA`/era-dir constants; update the
   two `git add` lists; archive per-cycle files to `era${ERA}/` instead of `runs/`.
2. `evolve.mjs` (via `evolve.ts`) — default `--out` to `tools/sim/data`; worker path → `dist/`.
3. `panel.html` — loader prefixes files with `data/`; `overnight.js` → `run-state.js`.
4. `build-series-history.js` — read from era dirs, write to `data/`.
5. esbuild commands — `--outfile=tools/sim/dist/<tool>.mjs`; document the one-line build in README.
6. `.gitignore` — replace `tools/**/*.mjs` with `tools/sim/dist/` and `tools/sim/logs/`; `git rm --cached` the four force-added bundles.

Estimate: 1–2 hours including a `--gens 1 --serial` smoke test and one full dry cycle.
Old GitHub paths break (e.g. anyone's bookmark of `tools/sim/STATUS.md`) — acceptable; panel URL survives.

## Rules going forward (put these in the new README)

- **data/ is machine territory.** Never hand-edit anything there except `experiments.js` and `baselines.js`.
- **Everything in data/ except overnight-log.jsonl is regenerable** (from the jsonl and the era dirs). The jsonl is the one file to protect.
- **New era:** seed profile into `profiles/`, archives accumulate in `era{N}/`, freeze the champion back into `profiles/` at era close.
- **Dead experiment:** move to `retired/` immediately, add a MANIFEST line. Nothing dead lives beside live state.
- **Never commit dist/.** One esbuild command rebuilds all of it.

## Telemetry split (approved in principle 2026-08-28 — mechanics below for confirmation)

Owner OK'd separating telemetry from code. Two ways to do it; **recommend Option A**.

**Option A — separate data repo (recommended):**
- New public repo `augwalts/mjrc-sim-data`, GitHub Pages enabled at root.
- It contains: `panel.html`, everything in `data/`, and the `era1/ era2/ era3/` archives.
  The panel moves with the data because it versions with the data schema, not the engine.
- Locally it is checked out **at `tools/sim/data-repo/`** (or directly as `tools/sim/data/`),
  gitignored by mjrc-game — a nested repo. The harness's git commands just gain `-C <that dir>`.
- `profiles/`, `src/`, `dist/` stay in mjrc-game: a clone of the engine repo remains runnable.
- Result: mjrc-game's history never sees another tick commit; the data repo is *supposed* to be
  82% ticks, and can even be squashed periodically without breaking anything.
- One-time costs: panel URL changes to `augwalts.github.io/mjrc-sim-data/panel.html`
  (bookmark update); ~10 lines in overnight.mjs; era1/era2 archives copied over once.

**Option B — orphan `data` branch in mjrc-game:** keeps one repo, but the old tick history stays
in the repo forever, Pages must switch branches (panel URL path changes anyway), and the harness
needs a second worktree to push a different branch than the one it runs from. More moving parts,
weaker payoff. Not recommended.

Sequencing: create the empty repo any time; the actual cutover happens in the same
between-eras pass as the directory reorg — it's ~10 extra minutes once `data/` exists.

## Game records (design settled in conversation 2026-08-28 — implement after era 3)

Today no games are stored — only aggregates plus seeds. Owner ruling (2026-08-28): **store
full-game records for ALL games — selection, bench, control, head-to-head. "A few GB is not
that bad. No need to debate optimizing."** Rationale, strongest first:

1. **Retroactive visualization.** The panel's metrics change regularly; today a new metric has
   no history ("not recorded" backwards forever). With records, a new chart column = a script
   over stored hands, backfillable across all generations.
2. **Determinism insurance.** Replay-by-seed is only exact against unchanged code, and owner is
   not fully confident in determinism anyway — so each record stores the initial wall (144 tile
   IDs, ~150–300 bytes) and is self-contained.
3. Post-hoc research (best-game studies, era retrospectives) stops requiring re-simulation.

**Record = one JSONL line per hand, full game** (no bot reasoning — owner explicitly
deprioritized "thought process"; everything else is complete):

- seed · era/cycle/gen · phase (selection|bench|control|headtohead) · seat assignment
- profiles (candidate hash + enemy name)
- wall: the full 144-tile deal (includes all hidden tiles)
- **complete action list**: every discard and claim/pass decision (draws are implied by the
  wall order — chess-PGN style, not RTS-style state dumps)
- outcome (discard-win | self-draw | exhausted-draw) · winner · feeder
- faan · chips moved per seat · final winning-hand shape (transcribe notation)

Claim counts, hand length, refusals, and any future metric all derive from the action list —
they are not stored separately.

Size: ~1KB raw, ~0.4–0.8KB gzipped per hand. Volume at full scope: est. 3–6M hands per 20h
night → **~1.5–4GB/night gzipped, ~30–60GB/month**. Owner accepts this; no retention policy
for now (revisit only if disk pressure actually appears — Mac Mini free-space check before
each era launch is enough).

**Storage location: `era{N}/games/cycle-{NNN}.jsonl.gz` — GITIGNORED, local-only.** GitHub
caps repos far below this volume, so raw records never ride the telemetry pushes; only the
aggregates derived from them (series-history, panel data) go to the data repo. Back up the
games/ dirs like any large local dataset (external drive), and note in the README that they
are the one thing besides overnight-log.jsonl that cannot be regenerated after code drift.
Write path: each evalworker appends to its own shard file; the harness concatenates + gzips
per cycle — no cross-process file contention.

Principles that come with it:
- **New panel metrics are computed from records** (extend `build-series-history.js`), not added
  as new hot-loop telemetry fields. One source of truth; backfill for free.
- Writer is `evalcore.ts`/`evalworker.ts` (the `recordHands`/`sampleMatches` machinery already
  collects most of this — extend it to emit JSONL instead of inventing a new path).
- Pre-record history (eras 1–3) can optionally be backfilled by re-simulating old benches from
  seeds at their `sourceCommit`s — CPU spend, owner's call, not automatic.

## Why this shape

- `data/` becomes exactly the subtree that would move to a separate telemetry repo or branch
  later (review §6.3) — that split becomes a one-line change to the harness's push loop.
- src/dist split ends the half-committed-toolchain problem and the .ts↔.mjs drift ambiguity.
- Era dirs absorbing `runs/` puts everything about an era in one immutable folder.
- No CHANGELOG.md added: git history covers file-level changes and `experiments.js` is already
  the research-decision ledger — a third log would duplicate both.

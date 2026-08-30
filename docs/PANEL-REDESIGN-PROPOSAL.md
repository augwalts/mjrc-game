# Simulation Panel Redesign Proposal

Status: Phase 1 and core Phase 2 changes implemented locally on 2026-08-28; visual QA remains  
Scope: `tools/sim/panel.html` and telemetry fields consumed by it  
Out of scope: mutation strategy, fitness function, match rules, promotion thresholds, benchmark policy, and experiment design

## Objective

Turn the panel into an away-monitoring dashboard that answers, in order:

1. Is the overnight process alive and making operational progress?
2. Is the current candidate better than the reigning player under the actual gate?
3. What changed, and why was the candidate promoted or rejected?
4. How does the current player behave against a clearly named benchmark?

The panel currently mixes an operations monitor, experiment decision log, and research archive into one long page. The redesign separates them into two explicit tabs: **Current Cycle** for monitoring the active run, and **Overall** for comparisons across every recoverable cycle and era.

## Run hierarchy and time-scope contract

The hierarchy must be stated plainly in the viewer:

```text
era (rare rules/benchmark regime)
  -> cycle (currently 16 generations, then a held-out exam)
       -> generation (one mutation-and-promotion step)
```

There are currently only two eras, so era is context rather than the primary long-term axis. The useful long-term comparison is **across all cycles**, with era boundaries marked where the rules or benchmark change.

Counts such as total generations and completed cycles are run context, not performance KPIs. The primary performance views are longitudinal plots.

Every panel section and card must carry one of three explicit scope labels:

- **ACROSS ALL CYCLES** — every recoverable generation, with cycle endpoints and era boundaries;
- **CURRENT CYCLE** — generations since the active evolution process started;
- **LATEST GENERATION** — one generation’s fixed bench, control, or sample matches, used only when a trend is not a sensible replacement.

The across-cycle plots cover refused wins, mean winning faan, draw rate, threat detection where recorded, and other comparable table-texture measures. Thin boundaries separate cycles, outlined points mark cycle endpoints, gold points mark promotions, and strong gold boundaries separate eras. Lines must break at era boundaries rather than implying that changed rules/benchmarks are one continuous measurement regime.

The separate current-cycle section compares every generation inside the active cycle, where minor changes are expected. Latest-generation data is retained only for detailed activity and sample inspection; it is not promoted into a large KPI when the same longitudinal metric exists.

The viewer must not silently aggregate incompatible measurements. If historical cycle records do not contain a field, show `not recorded` and the number of comparable cycles rather than blending in generation-level or differently sourced data.

## Non-goals and safety boundary

This work may add telemetry fields or correct telemetry accounting, but it must not change:

- how profiles mutate;
- which opponents are selected;
- the seed schedule;
- how matches are played or scored;
- the `0.5` generation promotion margin;
- the `4 chips/match` cycle admission margin;
- hall-of-fame replacement behavior.

## Problems to correct

### 1. Cross-block scores look like a progression

Cycle-end candidates are evaluated on different held-out wall blocks. Their absolute scores may be shown as noisy observations, but differences between those scores are not valid admission deltas.

The actual admission question is:

```text
candidate score on block - reigning score on the same block > 4 chips/match
```

The panel must show candidate, reigning, delta, threshold, and verdict together. `reigningOnSameBlock` is already recorded in `overnight-log.jsonl`/`log.js`; it also needs to be present in the live `OVERNIGHT.cycles` payload.

### 2. Generation confirmation is explained with the wrong comparison

The panel currently compares the challenger’s absolute confirmation score with `0.5`. The real check compares the challenger with the incumbent on confirmation seed set B.

Add `confirmControl` and/or `confirmDelta` to each generation record. Display both gate-A and gate-B deltas. Historical records without this field must render an honest “confirmation failed; comparison unavailable” rather than inventing a reason.

### 3. Process health has no heartbeat semantics

`OVERNIGHT.now` is a snapshot, so it cannot be used as the current time. Derive display age and remaining time from `Date.now()`. Use the newest timestamp from `SIM_DATA.updated`, `OVERNIGHT.now`, or the latest completed cycle.

Suggested states:

- **RUNNING**: producer status is active and telemetry age is at most 8 minutes;
- **STALE**: producer says active but telemetry age exceeds 8 minutes;
- **FINISHED**: producer reports completion;
- **FAILED**: latest explicit status reports failure.

The stale threshold is deliberately longer than the four-minute publication interval.

### 4. Opponents and seats are unnamed

Add these fields to `SIM_DATA`:

```ts
trainingOpponent: "baseline" | "mirror";
trainingOpponentLabel: string;
selectionMatches: number;
benchMatches: number;
```

Sample matches should also identify the candidate seat. Until older data is regenerated, the viewer should use conservative fallback labels and say when the opponent is unknown.

### 5. Candidate metrics and table-texture metrics are mixed

Financial metrics such as chips, deal-ins, and self-draw tax are candidate-seat metrics. Draws, refused wins, claims, faan distribution, and activity are currently whole-table aggregates.

The viewer must label the latter as table texture and state the composition: one evaluated player and three named opponents, repeated across all seats for the fixed bench. Per-seat behavior telemetry is a possible later enhancement, not required for this redesign.

### 6. Work totals are inaccurate

The generation workload must include:

```text
selection: control + six challengers
confirmation when attempted: challenger + confirmation control
fixed benchmark: incumbent, all seats
past-champion benchmark: incumbent, all seats
```

Emit a structured workload breakdown rather than requiring the viewer to infer it. Keep `work.matches` and `work.hands` as exact totals for compatibility.

### 7. Threat detection is shown at the wrong time scope

The standalone offline-audit snapshot is not useful for monitoring progress. Plot fixed-benchmark threat detection within the current cycle and across all recorded cycles. Older cycles that predate the metric must remain visibly missing rather than being backfilled or blended with the separate audit.

### 8. The page is too wide and too long on mobile

At 390px, the current two-column KPI breakpoint causes body overflow. The redesign needs:

- one KPI column below 700px;
- `min-width: 0` on grid/card children;
- explicit horizontal-scroll wrappers for wide tables;
- no primary monitoring information inside a horizontal scroller;
- research/detail sections collapsed by default;
- a useful status and progress summary within the first two mobile screens.

## Implemented information architecture

### Tab 1: Current Cycle (default)

#### A. Monitor summary

Always visible at the top:

- health state and telemetry age;
- cycle and generation progress;
- elapsed/remaining time;
- exact workload if available;
- latest failure, if any.

#### B. Current-cycle generation decisions

The generation log sits near the top of the tab, newest first, and shows:

- gate-A delta;
- gate-B confirmation delta when attempted;
- promoted/rejected verdict;
- changed dials and timestamp.

It does not repeat stable behavior-distribution columns.

#### C. Current-cycle trends

Use the fixed generation bench for current-cycle continuity:

- chips/match and named opponent;
- won, lost, deal-in loss, self-draw tax;
- draw rate, refused wins, mean faan, and claim mix, all explicitly labeled table-wide;
- sample size and all-seat status.

This section says `CURRENT CYCLE`. Charts may span all generations in the current cycle because their fixed benchmark source is comparable generation to generation. They must not be described as covering the full overnight series.

#### D. Current-cycle weights and inspection

Keep the incumbent weights and match inspector available below the trends. Remove the standalone latest-generation table-texture module: its moment-in-time values are replaced by within-cycle trends and the Overall cycle matrix.

### Tab 2: Overall

#### E. Operation and archive coverage

A compact line states the current era, total generations, completed cycles, active cycle, and archive coverage. These are context counts, not performance KPI cards.

#### F. Across all cycles

Plot every recoverable generation across every cycle for refused wins, mean winning faan, draw rate, and threat detection. Each chart includes cycle boundaries, cycle endpoint markers, promotion markers, and era boundaries. The visible coverage denominator makes missing older telemetry explicit.

The compact `series-history.js` file is derived from committed cycle-end `data.js` snapshots. `node tools/sim/build-series-history.js --backfill` reconstructs existing history from Git, and `overnight.mjs` updates it automatically after future cycles.

#### G. Table behavior by cycle endpoint

Use rows for chow, pung, kong, total claims, discard wins, self-draws, and threat detection. Use one column per cycle endpoint, labeled by era and cycle. Each cell shows the endpoint value and an up/down/flat indicator relative to the preceding cycle in the same era. A strong divider marks an era boundary, and the active incomplete cycle is marked separately.

#### H. Cycle archive

Keep the full cycle archive and definitions below the comparisons. Admission decisions must show candidate, reigning player, same-block delta, threshold, opponent, and verdict together; never infer progress from scores on different wall blocks.

## Display and terminology rules

Every score must be adjacent to:

- metric name and unit;
- evaluated player;
- opponent;
- seed/sample source;
- match count;
- seat treatment when relevant.

Additional rules:

- “Hall-of-fame score” means the admission-block result, not a permanent estimate of strength.
- “Latest candidate vs v0” must not be labeled as hall-of-fame continuity unless the candidate was admitted.
- Percentage differences from a zero default render as `0 -> value` or `enabled`, never `Infinity%`.
- Faan shares include `%` in visible cells, not only tooltips.
- “Game” and “match” should use one term consistently; this panel should prefer “match” for a one-wind round.

## Implementation phases

### Phase 1: correctness and handoff safety

- Add this proposal.
- Emit opponent metadata, confirmation-control result, exact workload breakdown, and same-block reigning score.
- Replace the top overnight series with a health summary and admission-decision summary.
- Correct misleading labels and universal sample-size claims.
- Add historical-data fallbacks.

Implementation status: complete in the current worktree. Older telemetry renders explicit `not recorded`/`legacy count unavailable` fallbacks until a newly bundled evolution cycle emits the added fields.

### Phase 2: usable monitoring surface

- Replace the 19-column generation table with a compact decision log.
- Group stable benchmark and table-texture cards.
- Replace isolated threat-audit data with current-cycle and across-cycle threat trends.
- Collapse research details.
- Fix phone-width overflow.
- Backfill a compact longitudinal archive from Git's committed cycle snapshots.
- Add across-all-cycles plots with cycle endpoints, promotion markers, and era boundaries.
- Demote latest-value KPI cards into within-cycle plots.
- Split the viewer into Current Cycle and Overall tabs.
- Replace latest-generation table texture with a cycle-end comparison matrix.

Implementation status: source changes complete. Browser rendering remains to be verified because the in-app browser security policy rejected the local `file://` URL; use an approved local HTTP origin or a published preview for the final desktop/mobile pass.

Longitudinal backfill is regenerated from Git and grows while the overnight process runs. At the latest validation it recovered 656 complete generation snapshots across 41 cycles: 416 generations/26 recoverable cycles in era 1 and 240 generations/15 cycles in era 2. Refused wins, mean faan, draw rate, fixed-bench chips, and claim activity are present throughout those snapshots. Threat detection was introduced later and is therefore intentionally sparse; the chart displays its recorded/total denominator rather than filling old values.

### Phase 3: optional richer telemetry

- Emit per-seat activity if owner-specific behavioral metrics are required.
- Emit confidence intervals or repeated fixed-scoreboard measurements.
- Add a stable profile identifier/hash to connect promotions, hall-of-fame entries, and archived runs.
- Add a publication heartbeat independent of git deployment if stale detection needs stronger guarantees.

## Acceptance criteria

- A person unfamiliar with the harness can explain the latest promotion/rejection from the first screen.
- No delta displayed as “improvement” compares different wall blocks.
- A stopped producer becomes visibly stale within 8 minutes of its last successful publication.
- Every primary score names its opponent and sample size.
- Whole-table metrics are not attributed to the evaluated player alone.
- Work totals match the number of evaluations actually executed.
- The page has no body-level horizontal overflow at 390px.
- The top monitoring view remains useful when optional data files are missing or historical records lack new fields.
- Across-cycle plots show every recoverable generation, clearly mark every cycle endpoint, and break at era boundaries.
- Current-cycle plots contain no isolated large latest-value KPI when a generation trend is available.
- Current Cycle is the default tab and its generation decision log appears before trend/detail sections.
- Overall behavior comparisons use one column per recoverable cycle, with changes computed only within an era.
- Existing simulation and promotion behavior is unchanged.

## Validation checklist

- Run `npm run typecheck`.
- Run `npm test`.
- Load `panel.html` with current live data and with optional scripts missing.
- Inspect browser console errors.
- Check at approximately 1440px, 768px, and 390px widths.
- Confirm the 390px document width equals the viewport width.
- Manually verify one admitted and one rejected cycle against `reigningOnSameBlock`.
- Manually verify a confirmation failure against challenger and control-B scores.
- Compare displayed workload totals with the structured producer breakdown.

## Handoff notes

Generated/live files such as `data.js`, `best-profile.json`, `overnight-status.txt`, and `overnight.out` may change while the harness runs. Do not overwrite or revert those unrelated live changes. Source changes should be limited to `panel.html`, `evolve.ts`, `evalcore.ts` only if telemetry shape requires it, `overnight.mjs`, and this proposal. After changing the TypeScript telemetry sources, mechanically rebuild `evolve.mjs` and `evalworker.mjs` with the repository's local esbuild binary because those bundles are what the overnight process executes.

Checks completed for the current implementation:

- inline panel scripts compile with `new Function`;
- both runtime bundles build successfully with esbuild;
- `npm run typecheck` passes;
- `npm test` passes all 1,868 tests;
- a zero-generation bundle smoke run emitted the new opponent and sample-size metadata under `/tmp`;
- an optional one-generation smoke run was stopped because the two fixed all-seat benches dominate runtime even with one selection match; no project files were touched.

Before continuing, inspect `git status` and re-read the current source because the live harness may have published new generated data since the previous session.

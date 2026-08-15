# mjrc-game

Design workspace for the MJRC competitive Hong Kong mahjong game. No code yet — the build
happens in a new `mjrc-game` repo per `DESIGN.md` §8.

Read in this order:

1. **`DESIGN.md`** — the working design (v1.1, adversarially reviewed). Positioning, product
   shape, two-track roadmap with gates and effort, canonical-HKOS ruleset + match structure,
   architecture (event-sourced reducer, DO-per-table, claim state machine), bots, teaching,
   validation harnesses, open actions.
2. **`ENGINE-AUDIT.md`** — verified facts about the existing code and market (6-agent audit,
   2026-07-18): scoring/replay/bot/shanten findings incl. the shanten prune bug, mj-queue
   reuse map, corrected competitive landscape (Amatsuki broke the naive wedge claim).
3. **`SKETCH.md`** — the original decision-forcing draft, kept as the record of why the pivot
   was made (2026-07-18) and which leans were confirmed.

Context: the game is HK-specific by design; the MJRC hub (mjrc-app) stays region-agnostic.
`mjrc-admin/STRATEGY.md` carries a dated amendment reflecting the pivot.

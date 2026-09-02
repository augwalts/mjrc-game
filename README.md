# mjrc-game

The MJRC competitive Hong Kong mahjong game: a pure rules engine, a versioned
wire protocol, a server-authoritative table (Durable Object), a platform Worker,
bots, and two clients.

## Two versions

| | **the demo** | **gamepvp** |
| --- | --- | --- |
| What | The live demo: you against three bots, everything runs in the browser | Real-time play against people, server-authoritative |
| Source | `client/game/` | `client/gamepvp/` + `gamepvp/` (the Worker) |
| Built into | `deploy/` (`tools/publish-demo.sh`) | `gamepvp/assets/` |
| Cloudflare | Pages project `mjrc-game` → game.mahjongresearch.com | Worker `mjrc-gamepvp` → gamepvp.mahjongresearch.com |
| Status | Live; pinned at tag `demo-2026-09-01` | In build — see `../PVP-MULTIPLAYER-PLAN-2026-09-01.md` |

The two are developed in parallel. The demo is where gameplay and the mobile
layout get tested; gamepvp is where the online-specific pieces get tested, and
every game feature the demo proves is meant to end up in gamepvp. Engine,
ruleset and protocol changes flow to both by merging `engine-v1` into `pvp`;
client changes are ported by hand from `client/game/` to `client/gamepvp/`,
because the two clients share DOM, CSS and tile art but not their core loop.
The tag `demo-2026-09-01` marks where gamepvp branched, and the demo's action
logs replay through the engine build that recorded them (DESIGN.md §5.5).

## Packages

| Dir | What |
| --- | --- |
| `engine/` | `@mjrc/engine` — pure reducer (`applyAction`, `legalActions`), seeded wall, scoring, bots, analysis |
| `rulesets/` | `@mjrc/rulesets` — ruleset presets as data (`mjrc-standard`, `tvb-2026`, …) |
| `protocol/` | `@mjrc/protocol` — client/server messages, omniscient vs per-seat event serializers |
| `worker/` | Table Durable Object (`src/table.ts`), platform routes (`src/index.ts`), D1 schema |
| `client/` | `game/` the demo · `gamepvp/` the PvP client · `src/` the `MatchScene` renderer boundary |
| `gamepvp/` | The gamepvp Worker project: wrangler config, entry, static assets |
| `tools/` | sim/training stack, replay, validation, `publish-demo.sh` |

```sh
npm test          # vitest across engine, protocol, rulesets, worker, client
npm run typecheck
```

## Design docs

Read in this order:

1. **`DESIGN.md`** — the working design (v1.1). Positioning, two-track roadmap,
   ruleset + match structure, architecture (event-sourced reducer, DO-per-table,
   claim state machine), bots, teaching, validation harnesses.
2. **`ENGINE-AUDIT.md`** — verified facts about the code and market (2026-07-18).
3. **`sketches/BACKEND.md`**, **`sketches/BUILD-PLAN.md`** — the two-planes rule
   and the build order.
4. **`AUTH.md`** — identity for the game; P0 is guest play.
5. **`REVIEW-GUIDE.md`** — what deserves scrutiny.

Context: the game is HK-specific by design; the MJRC hub (mjrc-app) stays
region-agnostic. `TERMINOLOGY.md` binds names in code and copy alike.

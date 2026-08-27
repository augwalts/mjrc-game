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

## Known open items (do not "discover" these)

- Threat feature is calibration-unproven (dials default 0 = off).
- `kongs-double-kong-replacement`: 槓上槓 not expressible in WinContext; scored
  as single kong-replacement, documented contested.
- Worker package untested against real runtime; client package is contracts only.
- Golden cases are `provisional: true` pending a strong HK player's sign-off.

## Build/test

    npm install && npm run typecheck && npx vitest run    # full suite ~5 min (bot sims)

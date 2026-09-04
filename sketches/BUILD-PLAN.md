# Build order — what survives the redesigns

**The test for "build this now":** would it still be correct if every screen were redrawn
tomorrow? If yes, build it. If its correctness depends on how something looks, wait.

By that test the entire durable asset is the **engine, the event schema, and the tests**.
The client is explicitly disposable (§5), so nothing there is worth locking in yet beyond
the `MatchScene` interface.

---

## Tier 0 — already written and verified in the sketch

These exist today, are tested, and port almost verbatim. Hours of work, not weeks.

| Piece | State | Evidence |
|---|---|---|
| 42-tile model (34 + 8 flowers) | done | drives every sketch screen |
| Seeded wall (mulberry32) | done | deterministic replay works |
| **Distance-to-ready away from ready 上聽 soeng ting, unpruned** | done | 5 cases correct, **7µs/call** vs the Python reference's 9.1µs |
| **Live tiles 有效牌 *jau haau paai*** | done | exact, drives the live review screen |
| §5.2 state machine shape | done | claims + priority + all 3 kongs + flowers + refused wins; **hand-size invariant held across 53,308 checks** |
| Event schema v1 | done | replay is a genuine fold over it |
| Non-overlap scatter | done | proven: min centre distance ≥ tile diagonal |

**Do not re-derive these.** Lift them.

## Tier 1 — the durable core

`engine/` as a pure TS package, zero dependencies, zero I/O.

1. **Tile + meld model** — exposed vs concealed, all three kong forms. The sketch's model is
   thin here; this is where the real work starts.
2. **Distance-to-ready away from ready 上聽 soeng ting / live tiles 有效牌 *jau haau paai*** — port from the sketch.
3. **Scoring — the big one.** Canonical HKOS faan with **exposed-meld decomposition**. The
   Python `scoring.py` DFS assumes a concealed 14-tile hand; fixed melds change the algorithm,
   not just the faan table. §3 prices this at **2-3 weeks** and it is the single largest
   engineering item in P0.
4. **Reducer** — `applyAction(state, action) → {state', events[]}` and `legalActions(state, seat)`.
   The §5.2 machine, properly.
5. **`protocol/`** — versioned event and message schemas, `engine_version` pinned.
6. **`rulesets/`** — faan and payment tables as **data**. Seed from
   `mjrc-app/web/src/data/hk-scoring.ts`, which already encodes six systems' values with the
   conflicts documented. Copy it; do not edit it in place (parallel scorecard work owns it).

## Tier 2 — validation, and the best use of parallel agents

7. **Golden-hand suite — 100+ hand-authored canonical HKOS cases.** §8 makes this the **P0
   exit requirement** and the only validation source for everything the Python engine cannot
   generate. Exposed melds, all kong forms, flowers, seat/round winds, dealer double,
   subsumption edges, limit hands, situational faan.
8. **Port-diff harness** — replay the Python engine's logged batches through the TS port.
   Validates the closed-hand LIU subset only; that is all the Python engine can produce.

**Write the golden suite BEFORE the scoring engine.** Three reasons: it is the acceptance
criterion, it parallelises perfectly (every case is independent and needs no implementation to
exist), and it forces every rules ambiguity to surface *before* code is written rather than
after. Scoring being wrong is the thing §4 says "destroys credibility instantly."

## Tier 3 — settled shape, safe to build

9. **Table DO** — per-seat redacted views, the named-deadline multiplexer, outbox, reconnect.
10. **Platform Worker + D1 schema** — boring on purpose (`BACKEND.md`).
11. **Bots** — claim logic, faan-route steering, count-based safety. A product blocker (§6),
    but it depends on the engine, so it comes after.

## Tier 4 — do not build yet

12. **The client.** Everything visual will change. The one thing worth fixing now is the
    `MatchScene` interface (`RENDERING.md` §7) so the eventual DOM→Pixi swap stays mechanical.

---

## How to parallelise it

The governing principle: **fan out on tests and mechanical ports; converge on the engine.**
Scoring correctness is the credibility surface — many agents writing scoring in parallel
produces plausible, subtly-wrong code. Many agents writing *test cases* in parallel produces
coverage.

**Wave 1 — fully parallel, no interdependencies** (needs only a shared types file)
- tile model + constants
- seeded wall + dead wall
- distance-to-ready + live tiles 有效牌 *jau haau paai* port
- event schema + protocol types
- D1 schema + migrations
- ruleset config format, seeded from `hk-scoring.ts`

**Wave 1b — parallel with everything, start immediately**
- golden-hand suite, split by pattern family: chows/pungs · flushes · honours & winds ·
  kongs & replacements · situational & limit hands. One agent per family, plus one adversarial
  agent whose only job is to find cases where two families interact (subsumption, e.g. Big
  Three Dragons subsuming Small Three Dragons).

**Wave 2 — needs Wave 1** — meld model, then scoring by pattern family, gated by Wave 1b's tests.

**Wave 3 — cohesive, few agents** — the reducer / state machine. This is one design; splitting
it across many agents produces seams.

**Wave 4 — parallel** — Table DO, platform Worker, bots, tools (replay CLI, log analysis, bot eval).

---

## What is needed before starting

Only one of these actually blocks anything.

1. **BLOCKING — the tsumo payment rule.** §9 lists it as an open action: settle
   per-player-vs-total against `mjrc-admin/reference/hk-scoring-calculator.xlsx` **before
   scoring ships**. Guess wrong and the scoring engine and every golden-hand answer are wrong
   together. Everything in Wave 1 proceeds without it; Wave 2 does not.
2. **Repo shape.** New standalone `mjrc-game` repo per §8, or a package inside this one? §8
   says new repo; it is currently docs-only with one commit.
3. **Golden-hand authority.** Do agent-authored answers stand provisionally until a strong HK
   player reviews, or does the suite block on human validation? §8 says validation by strong
   players is the exit requirement — so provisional-then-reviewed is the workable order, but
   the cases must be *marked* provisional so nothing silently ships unvalidated.

**Wave 1 and Wave 1b are unblocked right now.** That is roughly 11 parallel agents' worth of
work that cannot be invalidated by any design change or by the payment-table answer.

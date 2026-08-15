# Engine & Infrastructure Audit — verified facts

**Date:** 2026-07-18. Produced by a 6-agent audit of the existing code and market before writing
`DESIGN.md`. Everything here was verified against the actual code (tests run, behavior measured)
or cited web sources — not recalled from docs. The DEVLOG in `mjrc-admin/research/probability/`
is stale (covers Phases 1-2 only); trust this document over it.

---

## 1. Scoring engine (`core/scoring.py`) — complete for what it does, structurally limited

**Status: solid-core-needs-completion.** ~475 lines, **38/38 tests pass** (verified by running
them). Not a stub — the DEVLOG's "Phase 5: Scoring engine" next-step is outdated.

**Works today:** 18 patterns for closed 14-tile hands — All Chows/Pungs, Seven Pairs, Half/Full
Flush, dragon pungs with Small/Big Three Dragons subsumption, Small/Big Four Winds, All
Honors/Terminals, Nine Gates, Thirteen Orphans, Self-Drawn +1. Full DFS over all hand
decompositions with best-faan selection, 13-faan cap, 3-faan minimum flag, faan→chips table.
`game.py` applies payments correctly (ron: discarder pays; tsumo: all three pay) and correctly
refuses below-minimum rons.

**Structurally missing (tile/meld model changes, not patches):**
- **Claims (chow/pong/kong) don't exist anywhere** — no KONG meld type, no exposed/concealed
  distinction, a quad raises ValueError. Consequently no 槓上開花, 搶槓, 門前清, four-concealed-pungs.
- **No seat/prevailing wind faan** — verified: an East pung scores 0. `game.py` rotates seat
  winds but never passes them to scoring.
- **No flowers** — the tile model is 34 types; `use_flowers=False` is a stub.
- No situational faan (last-tile, heavenly/earthly), no dealer double, no pao.

**It's the "LIU" house variant**, codified in `ruleset.py`: 3-faan floor, 13 cap, flat 4-bracket
chip table (92/108 · 124/156 · 188/252 · 316/444) — *not* the standard HK doubling ladder.
Several non-standard values (Big Three Dragons 6, Small Four Winds 10, Seven Pairs 4 — not in
classic HKOS at all). Whether the tsumo bracket means per-player or total is undocumented —
check against `mjrc-admin/reference/hk-scoring-calculator.xlsx`.

**Minor defects found:** `fan_breakdown` sums uncapped while `total_fan` is capped (display
inconsistency); payout table duplicated in `scoring._fan_to_chips` and `ruleset.chips_for_fan`
(drift risk — two different callers use different copies); equal-faan decomposition ties resolved
arbitrarily; zero tests for `game.py` payments or `ruleset.py`.

**Conflict to resolve:** `content-strategy/05` specifies canonical HKOS — 144 tiles *with*
flowers, wind faan, dealer double, doubling payments. The implemented LIU variant is a
different game. The product must pick (see DESIGN.md §4).

## 2. Replay format & game loop (`core/replay.py`, `core/game.py`)

**Replay: can fully reconstruct current games.** JSONL per match — HandHeader (ruleset, seeds,
starting hands, winds) → per-action frames (actor, phase, tile, all-4-hands snapshots, discards,
wall count, optional bot rationale with shanten before/after) → HandFooter (outcome, faan,
chip deltas). Verified against actual batch samples.

**Gaps for a product log:** claims have no exercised encoding (schema reserves slots; meld dict
shape undefined in practice); no per-frame timestamps; wall order derivable only by re-running
the seed; refused below-minimum wins are invisible (no frame emitted — a viewer can't show
"seat 2 hit but couldn't legally win"); exhaust endings emit no end-frame in the dominant path;
frames carry no match_id (fragile outside single-file streaming); no cumulative standings in the
stream.

**Game loop: blocking synchronous, one human injection point.** `play_hand` is a nested for-loop;
each seat-turn: draw → engine auto-detects tsumo → `bots[seat].choose_discard(view)` (blocking)
→ engine auto-detects ron (nearest-seat priority). The `Bot` protocol has exactly two methods.
Wins are engine-automatic — players never declare.

- **Path A (works today, pre-claims):** a `HumanBot` whose `choose_discard` blocks on a queue fed
  by a WebSocket — drops in with zero engine changes, ~a day. Scaffolding, not the destination.
- **Path B (the destination):** the moment claims land, the loop must become an explicit
  event-driven state machine — claim windows prompt up to 3 players simultaneously with timeouts
  and ron > pong/kong > chow priority, which a synchronous single-actor loop cannot express.

**Server-authority posture is already right:** clients would only ever submit a discard;
legality/scoring is engine-computed; `PlayerView` already hides opponent hands per seat. Two
cautions: the omniscient replay frames must never be streamed to live clients (separate
serializers required), and `Wall.__init__` calls global unseeded `random.shuffle` — a
determinism footgun; only the explicit `shuffle(seed)` path is reproducible.

## 3. Bots & shanten (`core/bots.py`, `core/shanten.py`)

**⚠️ Correctness bug (not in DEVLOG):** the Phase-2 branch-and-bound prune in
`shanten.py:52-55` uses the subtree's *worst* case as if it were an optimistic bound and prunes
winners. Empirically verified: **~6.1% of 13-tile and ~10.1% of 14-tile hands return shanten
too high** (by 1, occasionally 2) vs the unpruned DFS. The celebrated 14.4x speedup is partly
bought with wrong answers; the 158-case test suite happens to sit in the agreeing ~94%.
**Do not port the prune.** (Spun off as a separate fix task for the research repo.)

**Bot quality: pushover, and weird rather than credible.** Pure shanten-greedy discarder; outs
computed but never used (no ukeire tiebreak); no faan awareness at all. Measured under real LIU
rules (100 hands, 4×GreedyBot): **69% exhaustive draws**, and every win was a 4+ faan accident —
a faan-blind bot races to chicken-hand tenpai it legally cannot win. It never calls (alien in HK
play within two hands), never defends meaningfully (DefensiveBot's "safety" is furiten logic —
a Riichi concept HK doesn't have). One tooth: instant, perfect ron detection.
**Minimum for credible opponents:** claim logic + crude faan-route steering + count-based
discard safety. This is a product blocker, not polish — 69%-draw game texture kills retention.

**Perf (measured):** shanten 9.1µs/call (~110K hands/sec, matches DEVLOG); GreedyBot decision
4.0ms (33× slower than needed — a rationale-only outs loop plus an import inside the hot loop);
full 4-bot hand 282ms. All irrelevant-to-comfortable inside a Durable Object after a TS port
(V8 typically 5-20× CPython on integer-array recursion).

**TS port estimate:** tiles+wall+shanten+scoring+ruleset+game loop ≈ 1,500-1,600 Python LOC →
~1,200-1,500 TS LOC. Mechanically easy, 2-4 days: numpy is used as a dumb int array, no
memoization, shallow recursion, only need a seedable PRNG shim (~10-line mulberry32). Validate
the port against the *unpruned* Python reference, not the existing test expectations.
**The hard part is what doesn't exist in Python either:** the claim/interrupt system and
exposed-meld scoring — realistically 1-2 weeks of new development, harder than the entire port.

## 4. mj-queue as the DO template (`mj-queue/src/`)

**Directly liftable:** the whole DO skeleton (hydrate via `blockConcurrencyWhile` + storage.get
+ invariant repair); hibernation WebSocket accept + `webSocketMessage` dispatch;
`serializeAttachment` for per-socket metadata surviving hibernation (today `{admin}`, becomes
`{seatIndex, playerId}`); the **commit pipeline** (mutate → validate → persist → *then*
broadcast — clients never see unpersisted state); full-snapshot resync on reconnect with
exponential backoff client loop; `getByName` keying (FUTURE.md already sketches
one-DO-per-table); wrangler.jsonc shape with SQLite-backed DO migration.

**Gaps a game table must fill:**
- **Per-seat private state.** mj-queue broadcasts identical payloads to all — and today
  *literally leaks seat tokens to every client* (app.js depends on it). Concealed hands need
  per-socket redacted views (`snapshotFor(seat)`) or tagged sockets. No such code exists.
- **Alarms: zero usage.** Turn clocks, auto-discard on timeout, claim windows (open on discard,
  collect responses or expire, resolve ron > pong/kong > chow) all need `storage.setAlarm` +
  a pending-claims structure. Nothing analogous exists.
- **No game state machine** — three arrays + two invariant helpers today; needs phase tracking,
  legality validation, append-only action log.
- **No disconnect handling** (`webSocketClose`/`webSocketError` unimplemented — the DO never
  learns a player dropped); needs reattach-to-seat with private snapshot, grace timers,
  abandonment policy (bot takeover).
- **No platform layer:** no D1/KV bindings, no lobby/matchmaker across DOs, no real identity
  (client-generated UUID + spoofable names + shared admin password compared with `===`).
  Ratings/history need DO → D1 write-out at game end.

## 5. Competitive landscape — the wedge, corrected (web-verified 2026-07-18)

**Doc 03's literal claim ("no ranked HK with replays") is FALSE.**

| Incumbent | HK rules | Ranked | Replays | Threat |
|---|---|---|---|---|
| **Amatsuki Mahjong** (天月麻雀, Cyber Alice, Jan 2025) | ✅ | ✅ seasonal ladder incl. HK | ✅ 牌譜 last-20/save-10/share | **High** — the wedge-breaker. Anime/gacha styling, Cantonese VO, cross-platform, updated monthly (June 2026). Mixed 49% on Steam; Riichi-centric esports push. |
| **Mahjong Time** (2004) | ✅ | ✅ Elo-style | ⚠️ archive viewer (last verified 2016) | Medium — nominally checks every box; dated UI, thin aging population. |
| **mahjonggame.hk** | ✅ | ❌ leaderboard only | ❌ | Medium — closest strategic overlap (HK-first, web, English, fast-shipping, AI coach reports); no ladder/replays per its own June-2026 comparison. |
| **Mahjong Soul** (Yostar) | ❌ Riichi-only | ✅ | ✅ | Low direct; sets the UX bar. Existential if it ever adds HK. |
| **HK Mahjong Club** (Recax) | ✅ | ❌ hall-of-fame list | ❌ | Low — largest install base (~34K ratings) but maintenance mode since Sept 2024. |
| **MahJongo** | ✅ | ❌ leaderboard | ❌ | Medium — newer web-native multi-variant entrant. |
| **Mahjong Dream** (Apr 2025) | ✅ | ⚠️ claimed | ❓ | Low — 33 Steam reviews, Mostly Negative. |
| **HKMA** (hkmahjong.org) | ✅ | ✅ official Elo initiative, HK variants due end-2026 | ❌ | Medium — not a product; the emerging *official* HK rating standard. **Potential partner / legitimacy gatekeeper.** |

Caveat: Amatsuki's "HK ranked + HK replays simultaneously live" rests on official store/social
descriptions, not first-hand play — worth one evening of actually playing it before P1 decisions.

**The wedge that survives (and it's the lane already chosen):** a serious, clean, **HK-first,
web-native, English+Cantonese platform combining rating + replays + teaching, without gacha**.
Amatsuki occupied the anime/gacha lane; heritage-craft + theory/teaching + diaspora-English
remains empty. Also note nobody has the teaching layer (doc 05's decision-node framework, WWYD,
drills) integrated with play — that combination is unclaimed.

## 6. What this changes in the design

1. **Claims are non-negotiable for P0.** Both the bot audit (never-calls = alien) and the loop
   audit (claims force the state-machine rewrite) point the same way: build the event-driven
   claim state machine from the start, in TS, rather than porting the synchronous loop and
   rewriting it a month later.
2. **Ruleset decision required:** LIU variant (implemented, closed-hand) vs doc 05 canonical
   HKOS (winds, flowers, kongs, dealer double, doubling payments). For an HK-audience product,
   canonical is the credibility floor; LIU survives as a config preset.
3. **Bots need faan awareness + claim logic before launch** — measured 69%-draw texture is a
   retention killer.
4. **Positioning updates:** differentiation is craft aesthetic + teaching integration + research
   credibility, not mere existence of ranked HK. Track HKMA as a partner for rating legitimacy.
5. **Port the engine unpruned; validate against the unpruned reference.**

# MJRC Game — Design v1.1

**Status:** working design, 2026-07-18. v1.1 after an adversarial 3-lens review (fact
consistency, strategy coherence, feasibility) — the gate structure, claim state machine, P0
scope, and effort accounting were all materially corrected. Supersedes the scope framing in
`SKETCH.md` (kept as the decision record). Verified technical claims live in `ENGINE-AUDIT.md`.

**One line:** a competitive Hong Kong mahjong game — basic playable gameplay generating
analytics first, competition layer second, craft/artwork in parallel as the brand — architected
so every early piece survives into the long-term ambition: *the definitive HK mahjong platform*
("the Mahjong Soul of HK," built in the opposite aesthetic).

---

## 1. Positioning (post-recon, corrected)

The original wedge claim — "nobody offers ranked HK with replays" — was **never cleanly true**
(Mahjong Time has nominally qualified since the 2000s, dated and thin) and is **unambiguously
false since Jan 2025**: Amatsuki Mahjong ships ranked HK + replays in an anime/gacha package
(ENGINE-AUDIT §5). The surviving, narrower, still-empty lane:

> **A serious, clean, HK-first, web-native platform — English + Cantonese — combining rating,
> replays, and integrated teaching, with a heritage-craft aesthetic and zero gacha.**

Differentiation, stated honestly:

1. **Craft aesthetic** — the vintage bone-set art direction in `mjrc-admin/art/` (ivory faces,
   indigo ink, floral rosettes). Amatsuki took the anime lane; nobody owns this one. Note:
   Cantonese call audio is **table stakes, not a differentiator** — Amatsuki ships Cantonese VO.
   Our claim is craft *direction* (heritage human delivery vs anime styling), to be verified
   against their actual HK-mode audio in the recon evening (§9).
2. **Teaching integrated with play** — doc 05's six-decision-node framework, WWYD, terminology-
   first Cantonese. No incumbent combines teaching with ranked play.
3. **Research credibility — via simulation first, corpus later.** The honest math: at P0 scale
   (~20 players) we log 1-3K hands/week; Riichi's numeric canon came from millions of Tenhou
   logs, and Amatsuki accumulates HK logs at a scale we won't match for years. The near-term
   theory pipeline is therefore **simulation-derived**: the (bug-fixed) engine at ~110K
   hands/sec generates route-conditioned ukeire and speed-vs-faan tables without any human
   corpus — an explicit deliverable (§7), not a hope. The defensible asset is **publishing
   English HK theory and owning the content flywheel** — which Amatsuki has the data for but no
   incentive or capability to do. Human logs refine the simulation numbers over time; they are
   not the moat's foundation.

**How Amatsuki kills this / why they probably won't:** they kill the lane by shipping English
localization + a clean UI theme + a drills mode — all cheap for a funded studio updating
monthly. The evidence they won't: their esports push is Riichi-centric, their Steam rating is
Mixed 49%, and HK is one of four side variants, not their identity. That is a *window*, not a
moat — which is why P0 carries dates (§3) and why the positioning legs are things they'd have
to *become*, not features they'd have to add.

**Not building:** gacha/loot mechanics, real-money anything (gambling adjacency — hard no),
native apps at launch, Riichi/other variants (the hub stays multi-style; the game is
HK-specific by design). **HKMA** (official HK Elo standard, HK variants due end-2026) is
promoted from watch-item to action: initiate contact **before** designing the P1 rating system,
so our ladder launches aligned with (or blessed by) the emerging standard rather than
pre-delegitimized by it.

## 2. Product shape — the competitive lobby-shell pattern

Two-plane architecture, per the pattern TFT/Mahjong Soul/Valorant converge on:

- **Plane 1 — lobby shell** (DOM web app): Play, rank, profile, replays, news. Talks **HTTP**
  to platform services.
- **Plane 2 — match scene**: connects over **WebSocket** to one authoritative table (a Durable
  Object), renders state, submits actions, dies at match end.

Hard rule from day 1: **the two planes never share a channel** (mj-queue tunnels everything
through one WS — do not inherit that). This is the shipped-at-scale shape: Mahjong Soul's
reverse-engineered protocol (`liqi.proto`) separates a `Lobby` service (~200 RPCs) from
`FastTest` (in-match: `authGame`, `inputOperation`, `inputChiPengGang`) on separate sockets;
League's client exposes canonical state as REST + a push WebSocket ("the entire UI can be
reconstituted using GETs"). See §10.

```
Lobby → queue → Match → Results screen → Lobby
```

**The results screen is the product.** Rating delta (provisional rating ships in P0 — §3), the
winning hand with faan breakdown, chip deltas, "watch replay," **"share" — which works in P0**
via a tokenized public replay URL (unauthenticated viewer over the R2 log blob; full spectator
mode stays P1). An invite-only alpha's only viral loop is the share artifact; it cannot be
deferred. Sequencing precedent (League 2022 post-game rework): **ceremony first, detail
second** — tab 1 progression (rating delta, the hand, faan), tab 2 full scoreboard.

**Screen map (P0):** Lobby · Match · Results · Match list (replay browser; deep stats deferred)
· shared-replay viewer (logged-out). **P1:** Profile stats, Leaderboard, Learn tab in-app.

**Mobile-first, grounded correctly:** the reason is the funnel — short-form discovery →
phone → play now (docs 02/03) — so portrait-first layout is the requirement. Poor connectivity
is a **risk, not a use case**: a live game with claim timers degrades on bad signal no matter
what, so the mitigation is game rules (reconnect-with-resync §5.3, generous disconnect grace,
auto-pass as safe default), not offline caching. P0 "PWA" scope is precisely: responsive
portrait layout + manifest (installable) + WS reconnect. Service-worker/offline: deferred.

## 3. Two tracks, a gate, and honest effort

### Track P — product

**P0 — playable + logging + provisional rating** (invite-only: friends + LA scene).
Canonical HKOS rules (§4) with claims/kongs/flowers/winds, humans + bots, full event logging,
results screen with share-replay links, forward-step replay viewer, match list, **provisional
per-device Elo** — visible on the results screen, labeled unofficial/resettable. The v1.0 draft
deferred rating to P1 and then gated P1 on retention; that was circular (the thesis says rating
*produces* the retention). SKETCH's MVP must-haves always included a rating number — restored.

**P0 explicitly cuts** (each was specified in v1.0 with zero budget — the feasibility review
priced the full list at 11-19 FT weeks): best-route HUD recommendations (§7 — what remains is
the rule-derived faan-floor warning), in-app Learn tab (the ten WWYD problems publish on
mjrc-app instead — same content, zero client work), profile stat dashboards, PWA offline,
live spectating, per-seat replay perspectives (omniscient viewer only at P0).

**P1 — competition** (gated): real accounts (passkeys), official rating (Glicko-2-family;
HKMA-aligned per §1), seasonal ladder, leaderboard, rated matchmaking queue, spectator mode,
in-app Learn tab, post-game analysis.

**Effort roll-up (FT weeks, honest):**

| Component | Est. |
|---|---|
| Engine port (tiles/wall/shanten/scoring-core — *not* the loop, which is rewritten) | 0.5 |
| Canonical HKOS completion + event-driven reducer + claim/kong machine + exposed-meld scoring | 2-3 |
| Golden-hand scoring suite (authoring + HK-player validation, overlaps above) | 1 |
| Table DO (views, alarm scheduler, reconnect, outbox) + lobby DO + platform (D1/R2) | 1.5-2 |
| Client: lobby shell, portrait match scene, claim prompts/timers, results, replay viewer | 3-4 |
| Bots: claim logic + route steering + safety (gate-relevant, can't skimp) | 1.5-2 |
| **Total P0** | **~9-12 FT weeks** |

At part-time (~15-20 h/wk) that is **4-6 calendar months**. Proposed clock, assuming start
Aug 2026: **P0 alpha at tables by end of 2026; gate evaluation Feb-Mar 2027.** If that timeline
is unacceptable against the Amatsuki window, the levers are client scope and hours — not
engine correctness or logging, which are the permanent assets. (Dates are a proposal —
Augustine's call.)

**Gate P0→P1** (all four):
1. **Retention:** invited players return unprompted — ≥20 weekly-actives at ≥3 sessions/week,
   sustained a month without new invites. Now a fair test: P0 contains the provisional-rating
   loop the thesis says drives it.
2. **Data quality:** 100% of completed games reconstruct in the viewer; zero unversioned schema
   breaks for 4+ weeks. (Enabled by engine-version pinning, §5.5.)
3. **Game texture:** bot-vs-human parity on measurable behaviors in *mixed-seat* games — call
   rate, mean winning faan, deal-in rate, draw rate — with the initial draw-rate band seeded
   exogenously by tallying physical games at the LA venue (the mj-queue network is literally
   standing at real tables); refined from logs later. (v1.0's "calibrate from human-vs-human
   logs" was circular — a bot-backed alpha rarely produces 4-human games.)
4. **Flywheel proof:** ≥5 logged real hands converted into published WWYD/short-form pieces
   during P0 — the log→content pipeline demonstrated end-to-end, since that pipeline is the
   accepted reason this app exists.

### Track A — craft/brand (parallel, from day 1)

The art direction is real but **not complete for the canonical ruleset**: `draft-v2/` contains
exactly 34 tile faces — **zero flower/season tiles, no tile back** (needed for opponents'
concealed hands, the wall, and concealed kongs). On the P0 critical path, sequenced before
match-scene UI work:
- **8 flower/season faces + tile back, in draft-v2 style** (the natural brief for the flowers
  is the reference bone set's watercolor florals — the style guide already describes them).
  Fallback if art slips: numbered draft-v2-style blanks, explicitly interim — the
  "never placeholder rectangles" rule bends here or it gates Track P.
- Then progressively: table surface, motion (draw/discard/claim), recorded Cantonese call audio
  (parity feature done in our register — see §1), brand identity.
- **Brand fork (Augustine's call):** own consumer name vs mahjongresearch.com sub-brand.
  Lean: own name, "by Mahjong Research Co" behind it.

**Two data pipes, never conflated:** (1) game event log — append-only, versioned, sacred;
(2) product telemetry — disposable funnels/session metrics that steer the gate. Separate
plumbing entirely.

## 4. Ruleset & match structure — the credibility decision

**P0 ships canonical HK Old Style** — chow/pong/kong (all three kong forms: exposed 明槓,
concealed 暗槓, added 加槓), 8 flowers with replacement draws, seat/round wind faan, dealer
double, 3-faan minimum, 13-faan limit, standard faan table per doc 05 §0 including situational
faan reachable through the state machine (self-draw, robbing-the-kong, last-tile; heavenly/
earthly are trivial checks). The implemented "LIU" closed-hand variant is a different game
(ENGINE-AUDIT §1) — it survives as a config preset for private tables.

**Match structure (was unspecified in v1.0; wind faan and dealer double are meaningless
without it):**
- **Dealer repeats** on a dealer win and on an exhaustive draw; otherwise deal rotates.
- Prevailing wind advances when the deal passes East's seat a full cycle.
- **Default match = one wind round (東圈)** — 4 rotations + repeats, ~20-35 min: the mobile-
  session-compatible unit, and the unit ratings attach to. Full four-wind games (60-90+ min)
  are a private-table option, not the ranked default.

**Rulesets are data, not code:** faan table, payment table, feature flags load from config —
LIU preset, future house-rule presets, and the HK→Taiwanese expansion (doc 03) as config + a
rules module, not a fork. **Payment table:** settle the per-player-vs-total tsumo ambiguity
against `mjrc-admin/reference/hk-scoring-calculator.xlsx` before scoring ships.

## 5. Architecture

Doctrine: **server-authoritative, event-sourced core; everything user-facing is a replaceable
view over the event stream.**

| Piece | P0 form | Endgame form | What makes it survive |
|---|---|---|---|
| Rules engine | Pure TS reducer | Same lib: client prediction, drills, bot sims, TW module | Purity + determinism; zero I/O |
| Event log | Append-only, versioned, every game | Research corpus, WWYD gen, bot training, anti-cheat | Versioned schema *and* pinned engine version |
| Identity + rating | Device token + provisional Elo in D1 | Accounts, ladder, seasons | Lives outside any DO from day 1 |
| Protocol | Versioned WS/HTTP messages | New clients speak it | Version field; zero client authority |
| Table DO | One per match | Thousands, matchmaker-spawned | Coordination atom; state = fold(events) |
| Bots | Claim-aware, route-steering | MC → trained on our logs | Same action API as humans |
| Client | Portrait PWA shell + SVG scene | Full-craft WebGL scene | Disposable by design; no game logic |

### 5.1 Rules engine (TS, new package)

- **Port scope (0.5 wk):** tiles, wall, shanten (**unpruned** — the pruned version is wrong on
  6-10% of hands; validate against the unpruned Python reference, not existing test
  expectations), scoring-core. The Python game *loop* is **not ported** — it's replaced by the
  event-driven reducer below.
- **Completion scope (the real work, 2-3 wk with §5.2):** 42-type tile model (34 + 8 flowers),
  KONG melds in all three forms, exposed/concealed distinction, **exposed-meld scoring
  decomposition** (scoring.py's DFS assumes a concealed 14-tile hand — fixed melds change the
  algorithm, not just the faan table), wind-faan context, dealer double, situational faan.
- Deterministic wall from logged per-hand seeds (seedable PRNG; kill the unseeded-shuffle
  footgun).
- Shape: `applyAction(state, action) → {state', events[]}` + `legalActions(state, seat)`.
  The DO, replay viewer, drills, and bot sims all call the same reducer. Replay = re-execution.

### 5.2 The match state machine (the core new build)

```
DEAL → FLOWER_REPLACEMENT (seat order, recursive — replacement flowers re-replace;
                            strictly ordered so replay re-execution is deterministic)
     → AWAIT_DISCARD(dealer)

AWAIT_DISCARD(seat):
  discard        → CLAIM_WINDOW(tile)
  concealed kong → replacement draw → AWAIT_DISCARD(seat)      [own-turn declaration]
  added kong     → ROB_KONG window (ron-only claims)
                     robbed → HAND_END | clear → replacement draw → AWAIT_DISCARD(seat)
  tsumo          → HAND_END

CLAIM_WINDOW(tile) — prompts only seats with legal claims (per-socket, private);
                     fixed minimum window so timing never leaks a held claim:
  all pass / timeout → next seat draws (flower auto-replaces) → AWAIT_DISCARD
  claims → resolve priority ron > kong/pong > chow (multi-ron: config; default nearest-seat):
    ron        → HAND_END
    pong/chow  → AWAIT_DISCARD(claimant)          [no draw]
    kong       → replacement draw → AWAIT_DISCARD(claimant)

HAND_END → SCORE → settle → dealer repeats on dealer-win or draw, else rotate;
                            wind advances on full cycle → next DEAL or MATCH_END
```

Refused below-minimum wins emit visible events (teaching moments, not silent rollbacks).
Estimate: this machine + exposed-meld scoring is the 2-3 week core of P0 engineering
(engine side). It is unavoidable — an HK game without calls is alien within two hands.

### 5.3 The table (Durable Object)

Lift from mj-queue (audit §4): hydration, hibernation WS accept, `serializeAttachment`
(→ `{playerId, seat}`), persist-then-broadcast commit, reconnect-with-resync. Add:

- **Per-seat redacted views** — `viewFor(seat)`: own hand, all discards/melds, wall count,
  others' hand counts. Omniscient state never leaves the server (mj-queue broadcasts its
  tokens to everyone today — the anti-pattern this exists to kill).
- **Deadline multiplexer — a DO has exactly ONE alarm.** `setAlarm()` overwrites. Naive use
  means a claim window clobbers a disconnect-grace deadline and the table hangs. Persist a
  named-deadline map (`turnClock`, `claimWindow`, `disconnectGrace:seat`, `botPace`), always
  `setAlarm(min(deadlines))`, dispatch all due entries in `alarm()` and re-arm. Bot replies
  route through `botPace` (synchronous bot answers would violate §5.2's no-timing-leak rule).
- **Outbox, not fire-and-forget:** hand events stay in DO storage until the R2 blob write AND
  the D1 result row are both confirmed (retried via the scheduler). The DO is disposable at
  **MATCH_END** (not hand end — matches are many hands) with the outbox flushed. This is what
  makes gate 2's "100% reconstruct" achievable rather than aspirational.
- **Reconnect = snapshot + actions-since** (Majsoul's `syncGame → GameRestore` shape — nearly
  free given event sourcing). `webSocketClose`/`webSocketError` → presence marking → grace
  alarm → bot takeover → seat reclaim by server-issued credential on return.
- **Match handoff (Majsoul's, adopted):** lobby issues `{table_id, seat_token, match_uuid}`;
  client opens the table WS and authenticates with the one-time token; the lobby never proxies
  match traffic. (Industry-standard placement flow — Agones/GameLift — with the fleet layer
  outsourced to Cloudflare.)
- **P0 lobby** = one DO handing out join codes (friends-join-by-code; rated queue is P1).
  Minimal abuse posture even invite-only: codes ≥6 chars, per-IP join rate limit, host-kick.
  Report/moderation tooling: explicitly deferred to P1 open registration.

### 5.4 Platform services (Worker + D1)

Plain HTTP, no DO: identity (P0 device token + display name; P1 passkeys), match history (D1
rows → R2 log blobs), provisional rating at P0 / rating_history at P1, leaderboard (P1).
Schema: `players`, `matches`, `match_players (seat, chips, faan_won, rating_before/after)`,
`rating_history`. Boring on purpose; queryable across all tables from day 1.

### 5.5 Event log schema v1

Per-event: `{v, match_id, hand_idx, seq, ts, actor, type, payload}`. Closes the audited gaps:
exercised claim events (`claim_offered/declined/claimed`), refused-win events, flower/kong
replacement draws, explicit hand-end on every path, cumulative standings in footers,
per-event timestamps, match_id on every record. **Header pins `engine_version`** — replay is
re-execution, so a scoring bugfix must not silently rewrite history: old hands replay through
their recorded engine version (keep old reducer builds loadable), or gate 2 fails for reasons
that aren't data corruption. Two serializers, never mixed: **omniscient** (R2, server-only)
and **redacted per-seat** (live streams). Validation this is the right shape: Mahjong Soul's
replays *are* its stored server event log (`RecordNewRound`, `RecordDealTile`...), re-rendered
client-side.

## 6. Bots — product blocker, not polish

Current measured texture: 69% dead draws, zero calls, furiten-logic "defense" for a rule HK
doesn't have (audit §3). P0 requirements, priority order: (1) claim logic serving a target
route — never the "HK sin" of melding into a sub-3-faan hand; (2) faan-route steering (doc
05's route table is the playbook); (3) count-based discard safety; (4) inherited fixes in the
port — ukeire tiebreak, drop the 33×-wasteful rationale loop. Success measure = gate 3's
parity metrics, not vibes. Later: MC evaluation, then bots trained on our own logs. A bot is a
player whose input is a function call — same action API as humans, paced through `botPace`.

## 7. Teaching & theory (P0-lite by design)

- **P0 in-game:** the **faan-floor warning** — "no legal path to 3 faan" — plus current-faan
  display. This is doc 05's one *rule-derived* principle (an unwinnable hand is a fact, not a
  heuristic), so it cannot embarrass us. The full "best route" HUD is **deferred**: it needs a
  partial-hand route evaluator that exists nowhere (an unbudgeted 1-2 wk search problem) and
  would assert recommendations doc 05 explicitly flags as [needs data] — a strong player
  screenshotting one wrong call at alpha hits the exact credibility leg we're standing on.
  It returns at P1 gated on the simulation-derived route tables below.
- **P0 in-UI:** terminology-first — doc 05's ~25-term Cantonese romanization set as the
  vocabulary of labels and call subtitles. Standardize romanization once, early.
- **P0 content (off-app):** the ten seed WWYD problems publish on mjrc-app (validated by
  strong HK players first — recruit from the LA scene); gate 4 turns real logged hands into
  the next ones. The in-app Learn tab is P1.
- **Theory pipeline (Track R, parallel):** the fixed engine (shanten bug first — task spawned)
  at ~110K hands/sec generates route-conditioned ukeire tables, speed-vs-faan crossover
  estimates, deal-in baselines — simulation-derived HK theory as publishable research and the
  P1 HUD's evidence base. This is the honest version of the research moat (§1), and it's the
  original "pure research" effort returning as the theory generator.
- **Onboarding order is Chiba's:** play first (vs bots, floor-warning on), read your own
  results, then theory. Never a rules lecture before a hand is played.

## 8. Repo & stack

New repo `mjrc-game` (family pattern): `engine/` (pure TS, no deps) · `protocol/` (versioned
schemas) · `worker/` (platform HTTP, TableDO, LobbyDO) · `client/` (portrait PWA shell + SVG
match scene from draft-v2) · `tools/` (log analysis, replay CLI, bot eval, sim-theory
generators). Cloudflare end-to-end (Workers/DO/D1/R2/Pages).

**Two validation harnesses, matching what each can validate:**
1. **Port-diff harness** — replays the Python engine's logged batches through the TS port;
   validates the closed-hand LIU subset only (that's all the Python engine can generate).
2. **Golden-hand suite** — 100+ hand-authored canonical HKOS cases (exposed melds, all kong
   forms, flowers, winds, dealer double, subsumption edges), answers validated by strong HK
   players. This is the only validation source for the canonical extensions — the part that
   "destroys credibility instantly" if wrong. **P0 exit requirement.**

## 9. Open questions & actions

- **Brand/name** — Augustine's call. Lean: own consumer name, MJRC as the research layer.
- **Amatsuki recon evening** — actually play it (HK ranked + replays are store-page-verified
  only; check their HK-mode audio too). Do before engine work starts.
- **HKMA contact** — before P1 rating design (see §1). Owner: Augustine.
- **Payment table** — settle tsumo per-player-vs-total against the reference xlsx before
  scoring ships.
- **Flower + tile-back art** — Track A's first deliverable, on the P0 critical path (§3).
- **Timeline confirmation** — §3's clock assumes ~15-20 h/wk from Aug 2026; confirm or re-cut.
- **STRATEGY.md** — amended 2026-07-18 with the pivot note (done; the "not a play platform"
  line now carries the HK-game exception).
- **Gambling adjacency** — skill-framed forever; chips are points; no cash-in/out, no wagering
  language. Legal review only if monetization ever approaches the game loop.
- **Liveops reality** — P0 invite-only is the mitigation; don't open registration until P1
  staffing/attention is real.

## 10. Precedents (verified 2026-07-18)

- **Mahjong Soul**: LayaAir HTML5/WebGL, browser-first, wrapped (majsoul-plus is an Electron
  shell). Protocol via github.com/MahjongRepository/mahjong_soul_api (`liqi.proto`):
  Lobby/FastTest split; `NotifyMatchGameStart {game_url, connect_token, game_uuid}` handoff;
  `syncGame → GameRestore {snapshot, actions[]}` reconnect; replays = per-UUID stored event log.
- **League client (LCU)**: CEF + JS plugins over a C++ foundation exposing REST + push WS
  (Riot tech blog, "Architecture of the League Client Update"); meta-client and game process
  are separate programs. 2022 post-game rework: progression/rating tab first, scoreboard second.
- **Match orchestration**: Agones / AWS GameLift — matchmaker → backend-mediated placement →
  client connects directly to an ephemeral single-session server that reports results and dies.
  A DO per table is this with the fleet layer outsourced.
- **Rating design**: Josh Menke, GDC 2016, "Skill, Matchmaking, and Ranking Systems Design" —
  hidden MMR vs displayed rank as a retention split (P1 reading).

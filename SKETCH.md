# MJRC Game — v0 Sketch

**Status:** DECIDED 2026-07-18 — Augustine confirmed the pivot: MJRC builds the game.
The four leans in §2 stand (casual/diaspora wedge · HK Old Style · English-first · build on
existing engine). Detailed design lives in `DESIGN.md`; engine verification in `ENGINE-AUDIT.md`.
**Purpose (historical):** the decision-forcing draft that framed the choice. Kept as the record
of why.

> This doc supersedes one line in `mjrc-admin/STRATEGY.md`: *"MJRC is not an online play
> platform... no competing here on gameplay."* Building a game is a deliberate pivot away
> from that line. If we proceed, update STRATEGY.md so the two docs don't contradict.

---

## 1. What the game is actually for (read this first)

The game is **not** a bid to out-gameplay Mahjong Soul / Mahjong Time. We lose that fight and
the strategy already says not to fight it.

Per `content-strategy/03-hk-integration-and-app-thesis.md`, the reason to build is
infrastructure, not entertainment:

- **Ranked play → a "my rank went up" loop → retention.**
- **Logged games + replays → raw material for content** *and* **the dataset to derive HK
  efficiency / EV theory** (the Tenhou-logs-built-the-digital-school move).
- **Somewhere for the content to point, and something to sell.**

**Design implication:** the product target is *"the minimum thing that produces rated,
logged, replayable HK games,"* not *"a polished HK client."* Every feature is judged against
that. A beautiful client that doesn't emit rating/replay/exportable logs is off-strategy. An
ugly one that logs everything is on-strategy.

---

## 2. The four open decisions (with my lean)

These are lifted from doc 03. Pick a lane before any building — the MVP shape depends on them.

| Decision | Options | Lean | Why |
|---|---|---|---|
| **Primary audience** | Casual "beat your friends" / diaspora **vs** competitive | **Casual/diaspora wedge, competitive as the retention+credibility engine** | Bigger, defensible, fits the LA/diaspora scene mjrc already touches. Competitive HK is small and leaks toward MCR. |
| **Ruleset** | HK Old Style **vs** drift toward MCR | **HK Old Style** | It's the cultural wedge and the thing nobody serves competitively. MCR chases a legitimacy ceiling we don't need yet. |
| **Language** | English-first **vs** Chinese-first | **English-first** | Diaspora + learners, less content competition, the audience that actually consumes strategy. Chinese later. |
| **Build vs partner** | Build **vs** partner/white-label | **Build on the existing engine** (see §4) | We already own a working HK rules core. The net-new work is UI + multiplayer + rating/replay, not the rules. That flips build from "huge" to "scoped." |

If you disagree with any lean, that's the conversation to have before §3 means anything.

---

## 3. Minimum viable game (the smallest on-strategy version)

**Goal of the MVP:** emit a **rated, logged, replayable** HK Old Style game. Nothing more.

Core loop:
1. Player joins → gets/uses a numeric rating.
2. A 4-seat HK table forms (humans + bots to fill).
3. Play a hand of HK Old Style with correct scoring (faan).
4. Every action is logged to a persistent game log.
5. Result updates ratings; the game is viewable as a **replay**.

**MVP must-haves**
- HK Old Style rules + faan scoring (from the existing engine — see §4).
- Persistent, append-only **game log** per game (every draw/discard/meld/win).
- A **rating number** per player (Elo/Glicko-style; exact system is a later tuning problem).
- **Replay viewer** — step through a logged game tile-by-tile.
- Bots to fill empty seats so early lobbies aren't dead.

**MVP explicitly excludes** (v1+, not v0): polished animations, cosmetics/skins, real-money
anything, tournaments, mobile-native app, matchmaking beyond "fill a table," social graph.

### The one real sub-fork: async vs live

| | **Async / turn-based** (like correspondence chess) | **Live / real-time** (4 players present) |
|---|---|---|
| Coordination | Easy — no presence problem | Hard — need 4 people online at once |
| Cold-start | Survives an empty playerbase | Dies in an empty playerbase (needs bots to feel alive) |
| Feel | Not how mahjong "feels"; weaker retention hook | Authentic; stronger "rank up tonight" loop |
| Infra | Simpler | WebSockets + presence — but **`mj-queue` already proves this stack** (Durable Object + WS hibernation) in this repo |

**Lean:** live, bot-backed. It matches how mahjong is played, delivers the retention loop the
thesis wants, and `mj-queue` is a working precedent for the exact Cloudflare DO + WebSocket
pattern. Async is the safer cold-start hedge if we think we can't get 4 humans online — worth
keeping in pocket.

---

## 4. Reuse map — what already exists vs. net-new

The "older" probability effort is stale as *research framing*, but its **code is a working HK
rules kernel** and doesn't expire. Location: `mjrc-admin/research/probability/core/`.

| Component | Exists? | Notes |
|---|---|---|
| Tiles / wall / deal | ✅ `tiles.py`, `wall.py` | Reusable as-is. |
| Hand parsing / shanten | ✅ `hand_parser.py`, `shanten.py` | Reusable. |
| Game loop (4-player) | ✅ `game.py` | Headless today; becomes the server-side authority. |
| Bots | ⚠️ `bots.py` (greedy-shanten only) | Good enough to fill seats; not good enough to be *fun* opponents. Upgrade later. |
| HK faan scoring | ⚠️ `scoring.py` | Listed as a future phase in the engine's DEVLOG — **verify how complete it is before trusting it.** |
| Replay format | ⚠️ `replay.py` exists | Check whether its log format is rich enough to reconstruct a full game for the viewer. |
| Rating system | ❌ | Net-new. |
| Multiplayer transport / presence | ❌ (but `mj-queue` is a template) | Net-new; reuse the DO + WS pattern. |
| Client UI / replay viewer | ❌ | Net-new. Biggest single chunk of work. |

**Net-new work, honestly:** client UI + replay viewer, multiplayer/presence layer, rating
system, bot quality. The rules engine is largely done. That's the whole argument for "build,
not partner."

---

## 5. Rough shape (if we build)

Consistent with the repo's existing split (`mjrc-app` Astro site, `mj-queue` standalone
Worker):

- **Standalone Cloudflare Worker + Durable Object**, same family as `mj-queue`. One DO per
  live table is the coordination atom.
- **Rules authority runs server-side** — port/wrap the Python engine, or reimplement the hot
  path in TS. (Open: Python engine as a service vs. TS reimplementation. Server must be
  authoritative; never trust the client for legality/scoring — anti-cheat + fairness.)
- **Game logs → durable storage** (append-only), the same discipline as the rest of mjrc
  (`AI/standards/software-patterns/human-data-ingestion.md`).
- **Replay viewer** can live in `mjrc-app` as a route, reading logs.
- Later, a subdomain like `play.mahjongresearch.com`.

---

## 6. Open questions / risks

- **Gambling adjacency.** HK mahjong is socially played for money. Keep it skill-framed
  (rating, not stakes); no real-money play or betting. Legal + optics risk if we drift.
- **Liveops cost.** A live game is a service, not a static site — moderation, abuse, uptime,
  empty-lobby management. This is the real ongoing cost, not the build.
- **Bot quality / cold-start.** Greedy bots fill seats but won't retain players. Early
  playerbase is thin; bots must be *tolerable* to play against or the retention loop never
  starts.
- **Scoring correctness.** HK faan has many house variants. Which canonical ruleset? Wrong
  scoring destroys credibility instantly with the exact audience we want.
- **Server authority / anti-cheat.** Client can't be trusted with legality or scoring.
- **Is this mjrc's roadmap or a separate product?** Liveops + the pivot away from
  "community hub" is a real strategic weight. Decide ownership before committing headcount.

---

## 7. Next step

Not "start building." The next step is a **decision:** confirm or overturn the four leans in
§2, then verify the two engine unknowns (faan scoring completeness, replay-log richness) so we
know how big "net-new" actually is. After that, a one-week spike: port the engine's game loop
behind a `mj-queue`-style DO and get two humans playing one logged, replayable hand.

# The game

A playable HK Old Style match: you against three bots from the training
programme, over the real engine.

Open `index.html` (any static server) — no build step at runtime, no backend,
no accounts. State lives in memory; your record persists in `localStorage`.

    python3 -m http.server 8480 --directory client/game

## What gets recorded

A name on first visit — no password, no email, no sign-in. The key is a
generated uuid, not the name, so two friends both called "Dave" do not merge
and renaming yourself does not fork you in two. Per-device, and the screen says
so.

Every match then records, to **IndexedDB** (`store.ts`):

- **The event log** — the engine's outputs, what the stats pages read.
- **The action log** — the inputs, bots' choices included. Replaying it through
  the reducer regenerates the events exactly, because the reducer is pure. So a
  game recorded today still replays correctly after the bots are retrained;
  their *decisions* are on record and history cannot be quietly rewritten.
- **Every one of your decisions, graded** against the champion — what you
  played, what it would have played, the gap, and how much better its first
  choice was than its second. That last number is what separates a real
  decision from a forced one: agreeing with the engine on a forced move says
  nothing about you.
- **Per-seat outcomes**, so "how do the bots do against real humans" is
  answerable — the one comparison the whole training programme never made.

Not localStorage: a one-wind match is ~187 KB of events, and localStorage's ~5 MB
would fill at about 24 games.

Quitting mid-match records a **forfeit**. A player who abandoned every losing
game would otherwise look like a strong player.

The **✎ feedback** button files a report with the game state attached — match id,
hand, the last eight log lines, the seed — so a "something looked wrong" can be
replayed rather than guessed at. It attaches to your last match too, since
people file feedback about the game they just left.

## Match length

One to four wind rounds, chosen on the start screen. The hand counts on the
buttons are measured, not guessed — 25 matches per length on the mixed ladder:

| | hands | range | est. time |
| --- | ---: | --- | --- |
| 東圈 one wind | 7.5 | 4–16 | 10–15 min |
| 東南 two winds | 15.6 | 8–23 | 20–30 min |
| 東南西 three winds | 24.8 | 17–32 | 35–50 min |
| 全莊 four winds | 34.6 | 25–51 | 50–70 min |

A wind round is nowhere near four hands: the dealer repeats on a dealer win
**and on 流局**, and the 3-faan floor sends about a third of hands to 流局.

## Settings (⚙ in the top bar)

- **Rules** — MJRC standard (3–10 faan), HK Old Style published (3–13), or TVB
  Championship 2026 (1-faan floor, linear payments, no flowers). Applies to the
  next match; the engine does the rest.
- **Tile size** — 80–200%. Everything scales off one CSS variable.
- **Bot speed** — 0 (instant) to 1.2s per move.
- **Dev mode** — two boxes. The first shows what each bot is planning: its top
  routes, distance and who it fears. The second is the **helper**, and it
  covers both halves of a turn:
  - *Discards* — how the champion ranks yours, graded **green / amber / red**
    with the reason ("slower: 4 away vs 3", "off your best route").
  - *Claims* — while the pung/chow buttons are up it says TAKE or SKIP for each
    and why; once you choose, the verdict joins the log. A refusal is quoted in
    the bot's own terms ("leaves no path to the faan floor", "kills the
    concealed hand you are building").

  It runs `assessRoutes` / `rankDiscards` / `assessClaim` / `claimDecision` /
  `shouldKong` — the very calls the bot makes, so the advice is its reasoning
  rather than a story told about it.

## What it is

- **The real engine.** `game.ts` renders `MatchState` and posts `Action`s back.
  It decides no rules: legality, scoring, payments and the 3-faan floor all come
  from `engine/` and `rulesets/`, exactly as the simulations use them.
- **Measured opponents.** `bots.js` carries the frozen ladder — `v0` (the
  original defenceless bot) through `v4` (the strongest bot the programme
  produced), plus `persona-action` (nearly as strong, far more watchable).
  Difficulty here is a measured quantity: see `tools/sim/experiments.js`.
- **The site's own tile art.** `tile-engine.js` is the SVG engine copied from
  `mjrc-app/web/public/tiles/` — the same faces the scoring pages draw, with
  real pip geometry. Flowers and seasons are keyed BY CHARACTER because the
  engine's array order (梅蘭竹菊) differs from the tile ids (梅蘭菊竹).
- **A pile that never overlaps.** Discards form an organic heap — the owner
  picked it from ten sketches in `pile-lab.html` against a photo of a real
  table. A tile lands on its thrower's side, falls toward it until a neighbour
  stops it, then hops sideways-and-down 220 times looking for somewhere nearer;
  a separating-axis test on the true rotated rectangle keeps it from ever lying
  on another tile. 60 % of the heap's area is tile. Counting the discards is a
  core skill; a pile you cannot count is worse than useless.
- **Tiles are named by their face.** `4●` circles, `4▮` bamboo, `4萬`
  characters, honours and flowers in English — the discard feed and the coach
  should read without Chinese. The tile ART is untouched.
- **Everything you need is on the table.** Round, hand and wall sit in the
  felt's top-left; your own plate — seat wind, 莊, chips — sits at the near
  edge mirroring the bots'. Nothing lives in a window strip a phone would have
  to drop. Chips read green when you are up, red when you are down.
- **HK table conventions.** Chow is offered only from 上家; the seat and
  round winds, dealer mark 莊 and dealer repeats are all engine state.

## Rebuild after changing `game.ts`

    ../../../mjrc-app/web/node_modules/.bin/esbuild client/game/game.ts \
      --bundle --platform=browser --format=iife --outfile=client/game/game.js

Refresh the bot roster after a new champion is frozen:

    python3 -c "import json;d={k:json.load(open('tools/sim/%s.json'%f)) for k,f in \
      [('v0','baseline-v0'),('v1','baseline-v1'),('v2','baseline-v2'),('v3','baseline-v3'),\
       ('v4','baseline-v4'),('persona','persona-action')]}; \
      open('client/game/bots.js','w').write('window.BOTS = '+json.dumps(d)+';\n')"

## Animation

Three beats, all pure CSS so none of them can gate input (`MatchScene.ts` rule 1:
show the affordance immediately, animate underneath it):

- **Build the wall — 1.45s.** At the start of every hand the wall assembles: each
  face-down tile flies in from a random offset with a random tilt, staggered by
  side and position, so it reads as shuffling-then-stacking.
- **Draw off the wall — 0.9s.** The drawn tile arcs from the wall into the gap at
  the right of your hand. Bots' face-down tiles pop in the same way.
- **Toss — 1.3s.** A discard flies in *from the thrower's seat*, lands short of
  its slot at 52%, lies there for a beat, then skids the last stretch —
  accelerating and stopping dead against the pile. The final easing is an
  ease-IN, because a curve still gaining speed when it ends reads as a hard
  stop; a decelerating one reads as a glide.

**Two motions never run at once.** The reducer emits a discard and the next
player's draw in one batch, so they used to start in the same frame. Motions now
queue by delay — a draw begins 832ms into the toss, once the tile has landed and
settled — while announcements (碰, 花, 食糊) ride alongside the motion that caused
them. Queueing is delay plus `animation-fill-mode: backwards`, never a gate: the
affordance is always live. The full audit is in `ANIMATION-SEQUENCE.md`.

- **The hold after a call — 0.75s (0.5s for a flower).** A pung, chow, kong or
  flower stops the table: nothing else animates until the call has been made
  and the meld is down, the way play pauses at a real table. It is armed by
  `announce()` so it fires exactly when a call was shown, and it never applies
  to your own turn — an affordance is not taken away by an animation.

The wall itself is decorative (the engine's wall is a shuffled array) but it
carries what a real wall tells you: how much game is left, and it visibly erodes
as tiles are drawn.

## Not built yet

Sound · replay viewer · avatars and
expressions (`EXPRESSIONS.md`) · online play (`DESIGN.md` §5.3 specifies the
snapshot + actions-since resync the renderer boundary already assumes).

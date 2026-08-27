# Motion — the full animation plan

**Scope.** The match scene only. Lobby, review, results panels and settings are DOM and
animate like a web app; that is not interesting and not here. This document specifies the
actual motions on the table: what triggers each one, how long it runs, what moves, what it is
forbidden to block, and what it degrades to.

**What is already settled and is not re-litigated here.** `sketches/RENDERING.md` §4 fixes the
architecture: an event-driven queue, presentation trailing authoritative state, and three hard
rules — *animation never gates input*, *resync snaps*, *ceremonies are skippable*. §7 fixes the
`MatchScene` interface. §4a fixes the jumbled HK pile and its non-overlap guarantee. All of
that stands. This document extends it in four places where §4 stops short:

1. **Lanes** (§4 below). A single serial queue is wrong: `doDiscard` emits `discard` and the
   next seat's `draw` **in the same commit**, so two seats are always mid-motion together.
2. **Admission vs. drawing** (§3). The model mutates synchronously in event order; frames only
   paint. This is what makes `flush()` correct by construction instead of by care.
3. **Compression bands** (§7). §4 says "snap if the queue gets deep." Between 1× and snap there
   are two useful bands, and the tightest case in the game lives in them.
4. **Motion-by-motion specs** (§6), which is most of the page.

**Terminology.** `TERMINOLOGY.md` governs. Two existing docs violate it and should be fixed:
`RENDERING.md` §5's inventory table names `ron` / `tsumo` (→ `winOnDiscard` / `selfDraw`), and
`PAGE-INVENTORY.md` §8's hotkey table names Ron and Tsumo, with `R`/`T` bindings derived from
the banned words. The protocol is already clean — `WinOnDiscardEvent` / `SelfDrawEvent`.

---

## 1. The cosmetics firewall — non-negotiable

`DESIGN.md` §5 makes the client **disposable by design** because the engine is a pure reducer
holding all the logic. Motion is the place where that doctrine is most likely to be broken by
accident, because motion is where the temptation to "just add a field" lives.

**The log records that tile 18 was discarded. It never records that tile 18 in the jade set was
thrown by the fox-hand avatar.** If a cosmetic ever reaches the event log, the research corpus
is polluted permanently and replay breaks the day that cosmetic is retired — because
`replayMatch` is re-execution, and re-execution cannot re-execute a texture that no longer
exists.

Five rules, the last of which is a test rather than a principle:

1. **No event payload gains a field for a cosmetic.** The seventeen types in
   `protocol/src/events.ts` are complete for rendering. A motion that needs data not in the log
   is a motion that is specified wrong. Every timing in §6 was derived under this constraint and
   none of them needed an exception.
2. **Every motion is a pure function of `(event, presentationState, seed)`** where the seed is
   the envelope's `seq` — already on every record, already strictly +1 per event. That is why
   the pile scatter is reproducible, why replay scrubbing does not shimmer, and why the golden
   timeline test in §14 is possible at all.
3. **Cosmetic selection travels on the lobby plane, never the match socket.** Avatar, hand model
   and tile set live in the player row in D1 (`DESIGN.md` §5.4), reach the client over HTTP
   before the match socket opens, and are keyed by `playerId` — which the log already carries
   once, in
   `MatchLogHeader.players`. A retired cosmetic falls back to the default. The log is untouched.
4. **`MatchScene` has no return channel.** `applyEvent(e): void` is `void` today. Keep it. The
   renderer must be structurally incapable of writing to the stream it renders.
5. **The assertion:** replay one archived match twice — once with every cosmetic disabled, once
   with every cosmetic maximal — and the `SeatSnapshot` fold must be identical at every `seq`.
   Run it in CI. A firewall you cannot test is a firewall you do not have.

Cosmetics are *encouraged* inside that fence. `DESIGN.md` §1's anti-gacha position is a
positioning leg, not a scope cut: a roster of hands and tile sets with personality, unlocked by
playing, is the Smash Bros model and is exactly right here. What is ruled out is randomised paid
pulls, not character.

---

## 2. Coordinate and pose model

Inherited from `RENDERING.md` §2. Table space `(x, y, z)` in tile units, origin at table centre,
`y` depth, `z` height. `project(x, y, z) → (sx, sy, scale)`, fixed. Nothing is positioned in
pixels; everything is positioned in table space and projected.

The tile face is **100 × 140** (`mjrc-app/web/src/features/tiles/render.ts`, `RULES.W/H`).

Camera elevation θ is **still open** — `RENDERING.md` §9 says fix it at 28–32° before any sprite
is baked. Every constant below that depends on it is written as a function of θ:

| Quantity | Formula | at θ = 30° |
|---|---|---|
| Depth foreshortening of a flat tile | `sin θ` | 0.500 |
| A flat tile's on-screen box | `100 × 140·sin θ` | 100 × 70 |
| Toss arc apex, in tile heights | `0.9 / sin θ` … capped at 1.4 | 1.4 |
| Draw lift before travel | `0.5 / sin θ` … capped at 0.8 | 0.8 |

The caps exist because at shallow θ the naive formula sends tiles off the top of a portrait
viewport. **Pick θ before hand art is drawn** — poses are baked against it and re-drawing is not
a re-render.

**Four tile orientations** cover the whole game under a fixed camera: `upright` (in a hand),
`flat` (pile, melds, wall top), `flat-crosswise` (the claimed tile in a meld, and the 加槓 tile
stacked on top), and `back` (any of the above, face down). A tile in flight is interpolating
between exactly two of them.

---

## 3. Admission mutates the model; frames only paint

This is the piece `RENDERING.md` §4 implies but does not state, and it is what makes the three
hard rules mechanical instead of aspirational.

Every motion is admitted in strict `seq` order, synchronously, in the frame the event arrives.
Admission runs `reserve()`, which **mutates the presentation model to its post-event value**:
the tile leaves the hand array, the pile slot is allocated, `wallIndex` advances. Only after
that does anything animate, and what animates is a *transient* the motion owns.

```ts
type LaneId = `seat${0 | 1 | 2 | 3}` | "table" | "ceremony";

interface Motion {
  /** `${seq}:${kind}` — stable across a replay scrub, so re-admission dedupes. */
  id: string;
  lane: LaneId;
  durationMs: number;
  /** Synchronous, in seq order, before any paint. Allocates slots, mutates the model. */
  reserve(scene: SceneModel): void;
  /** p ∈ [0,1] post-easing. Transform and opacity ONLY. Never layout, never paint. */
  frame(scene: SceneModel, p: number): void;
  /** Idempotent end state. Called on completion, on cut, and on flush(). */
  settle(scene: SceneModel): void;
  /** ms from start at which the sound cue fires (§10). */
  cueAt?: number;
  policy: "queue" | "cut" | "retarget";
}
```

Three consequences worth naming:

- **`flush()` is trivially correct.** It is `for (m of pending) m.settle(scene)` in order. There
  is no separate snap path to keep in sync with the animated path, which is the usual way this
  goes wrong.
- **Hit targets can never lie.** Input binds to the model, and the model is already at its
  post-event value the instant the event lands. A tile still visibly in flight toward the pile
  is, as far as taps and the rules are concerned, already in the pile — which is correct.
- **Hand contents and hand *layout* are different things.** The model's hand array changes at
  admission; the rendered slot positions are recomputed when the motion completes. Conflating
  them is what makes cheap implementations re-flow a hand out from under a player's finger.

**A concrete bug this fixes, already present in the sketch.** `sketches/ui.js:318`
`scatterLayout(n, tileW)` assigns pile positions by *index within the current pile*, and
`globalPile` splices a tile out when it is claimed. Growth is stable (cells are sorted by
distance and sliced, so the first *n* never change), but **removal renumbers every tile after
the removed one** — so every 碰 silently reshuffles half the pile. Allocate the slot at
admission, key it by the discard's `seq`, and free it without renumbering. The pile is
information (`RENDERING.md` §4a: counting discards is a core skill); information that
rearranges itself is worse than no information.

---

## 4. Lanes

Six lanes: one per seat, one for the table (wall, pile, dealer marker), one for full-screen
ceremony. **Admission is serial and ordered; playback is concurrent across lanes and serial
within one.**

Why this is forced rather than chosen: `reducer.ts:1124` — `doDiscard` calls `advanceTurn` in
the same `applyAction` when no seat has a legal claim, so `discard`(seat A) and `draw`(seat B)
arrive **in one WebSocket frame with zero server-side spacing**. A serial queue would start the
draw 380 ms after the toss, and at `botMinPaceMs: 700` the next discard lands before the draw
finishes. The lag compounds every turn and never recovers. Lanes remove the failure mode
entirely rather than tuning around it.

| Lane | Owns | Typical concurrency |
|---|---|---|
| `seat0..3` | that seat's hand, melds, flower tray, prompt UI | 1–2 at once, routinely |
| `table` | wall stacks, pile slots, dealer / round markers | 1 |
| `ceremony` | the dim overlay, the win reveal, faan bars, hand-end sweep | 0, or 1 exclusively |

Conflicts are resolved at admission, not at playback, because `reserve()` has already claimed
whatever the motion needs. A motion that spans two lanes (a meld touches the pile *and* a seat)
is assigned to the **seat** lane and reserves the pile slot synchronously — the pile mutation is
instantaneous, only the drawing is animated.

A `ceremony` motion is exclusive: admitting one cuts every seat lane to its end state first.

---

## 5. The five invariants, stated as assertions

Restating §4's three rules plus two the specs below depend on, in a form a test can check.

| # | Invariant | Mechanical check |
|---|---|---|
| I1 | Animation never gates input. | For every event that opens a window (`claimOffered`, `robKongWindow`) or hands a seat the turn (`claimed`, `draw`), the interactive element exists in the DOM **in the same frame** the event was applied. |
| I2 | Resync snaps. | `setView()` and any lane backlog > 2500 ms call `settle()` on all pending motions and start nothing. |
| I3 | Every ceremony is skippable, from its first frame. | The skip handler is bound in `reserve()`, not in `frame()`. |
| I4 | Transform and opacity only. | No motion may touch `width`, `height`, `top`, `left`, `box-shadow`, `filter`, or `background`. Enforced by lint over the scene stylesheet; violation is a dropped-frame bug on low-end Android, not a style opinion. |
| I5 | End state is animation-independent. | For every motion, the model after `settle()` is identical whether the motion ran at 1×, was compressed, was cut, or was flushed. |

**I1 has teeth because the clock is server-side.** `DEFAULT_TABLE_CONFIG.claimWindowMs` is
5 000 ms and the DO opens the window at commit. Animating for 400 ms and *then* mounting the
call buttons silently costs the player 8 % of their window, on top of whatever the network
already took.

**A corollary of I1 that is easy to miss: the countdown ring is driven by
`deadlineTs − now()`, never by a local 5 000 ms countdown started on receipt.** The payload
carries `deadlineTs` precisely so this is possible. Estimate the clock offset at connect. And if
the ring reaches zero before `claimDeclined` arrives, **hold it at zero with the buttons still
live** — the server may still accept, and disabling early is losing a hand to a rendering
decision.

---

## 6. The motions

Each spec gives: trigger, total duration, phase breakdown, easing, what moves, what stays, what
it must not block, reduced-motion form, overlap behaviour, and interruption policy.

Two conventions used throughout:

- **The draw is smooth; the toss is ballistic.** That contrast is most of what will make a
  Cantonese player recognise the table. A pickup is deliberate (`cubic-bezier(.4,0,.2,1)`); a
  throw is a projectile (linear in X, arced in Y, with a small landing overshoot).
- **Parameterised arcs use three nested transform layers** — a *carrier* animating X linearly, a
  *lifter* animating Y with the arc, a *spinner* animating rotation. Each is one composited
  transform-only animation. This gets a real parabola out of CSS without a twelve-stop keyframe,
  and it makes the one retarget case in §7 tractable: retargeting changes the carrier and leaves
  the lifter alone. Cost is 3 elements per flying tile, which is why the deal (§6.10) uses a
  single shared keyframe instead.

---

### 6.1 GRAB 拿牌 — reaching into your own hand

**Trigger: none. There is no log event for a grab, and there must not be.** A grab is a local
input affordance that happens *before* an action is sent — pointerdown, hover-with-intent, or a
keyboard selection move. It is reversible: the player can change their mind, and no event has
been emitted to reverse.

| Phase | ms | What |
|---|---|---|
| reach | 0–60 | Hand sprite slides along the table edge to the tile's x, pivoting about the wrist. |
| grasp | 60–130 | Fingers close (pose swap, 60 ms crossfade). Tile lifts `0.35` tile-heights. Contact shadow softens and offsets. |
| hold | ∞ | Tile floats. Hand holds `lift`. No idle wobble — a wobbling held tile reads as a bug. |
| cancel | 90 | Reverse, `ease-in`. |

**Easing.** Lift `cubic-bezier(.22,.61,.36,1)`. Finger close `cubic-bezier(.4,0,.2,1)` — snappier
than the arm, because that is how hands work.

**Must not block: the discard itself.** The action is sent on the input event, not on the
animation's completion. A double-tap discards on the second tap while the first tap's grasp is
still crossfading. This is I1 applied to input rather than output, and it is the one place the
rule is usually forgotten.

**Remote seats do not get their own grab motion.** You cannot know another seat is reaching
until `discard` arrives — inventing a "thinking" animation would either be a fabrication or, if
driven by anything real, a timing leak. Instead the remote grab is folded into the *front* of
the toss (§6.2) as a 70 ms wind-up. That makes the local toss 70 ms shorter than a remote one,
which is correct: your own hand feels faster than the table.

**Reduced motion.** No hand, no lift. The selected tile gets a 2 px `translateY` and a 1 px
outline, applied instantly.

**Overlap.** One grab exists at a time; last pointer wins on multi-touch. **Interruption:**
cancel — it owns no model state, so abandoning it costs nothing.

---

### 6.2 TOSS 打牌 — the signature motion

`RENDERING.md` §5 is right that this is the single most recognisable motion in Hong Kong
mahjong. In HK the discard is *thrown*: it arcs, lands at an angle, and joins a jumbled central
pile. Getting this one right is worth more than the other nine combined.

**Trigger:** `discard` `{ seat, tile, drawAndCut }`.
**Total: 310 ms local / 380 ms remote.**

| Phase | ms (remote) | What |
|---|---|---|
| wind-up | 0–70 | Remote only: hand pose `reach`→`grasp`, tile lifts. Local seat skips this — §6.1 already did it. |
| flight | 70–290 | Carrier translates X linearly to the reserved pile slot. Lifter arcs Y through an apex of `0.9/sin θ` tile-heights. Spinner rotates `upright → flat` **and** in-plane to the slot's scatter angle, both over the same 220 ms. |
| land | 290–330 | Overshoot the final Y by 6 %, settle. `cubic-bezier(.34,1.3,.64,1)`. The one place a back-overshoot is right: a thrown tile bounces. |
| settle | 330–380 | Contact shadow tightens from blurred to sharp. Scale 1.02 → 1.00. |

**`drawAndCut` 摸切 changes the start position, not the motion.** When true, the tile leaves the
detached drawn slot to the right of the hand; when false it leaves from inside the fan. HK
players read this — it is the difference between "they had no use for it" and "they chose to
break their hand" — and the flag is already in the payload. Free information, rendered.

**What stays.** The hand fan **does not re-flow during flight.** It closes the gap after the
tile lands, starting at t=330, over 120 ms. Two things moving at once is exactly what makes
cheap discards read as mushy, and the eye should be on the tile.

**Must not block.** The claim prompt, which mounts at t=0 (I1). The toss animates underneath a
live button.

**Reduced motion.** 120 ms cross-fade: the tile fades out of the hand and fades in at its final
slot **at its final angle**. The mess is kept — `RENDERING.md` §4a is explicit that the pile's
messiness is downstream of the ruleset and that counting it is a core skill. Reduced motion
removes the path,
never the state.

**Overlap.** Two tosses can never contend for a slot (allocated at admission). The common
overlap is toss ∥ draw from the same frame (§4), on different lanes, running fully concurrently.
Toss ∥ deal cannot occur.

**Interruption: queue, never cancel.** The end state — a tile in the pile at a specific angle —
*is* the pile's information content, so cancelling would have to apply it anyway and buys
nothing but a pop. Under backlog it **cuts to the land phase** (last 90 ms), so the tile always
visibly arrives.

---

### 6.3 DRAW 摸牌 — the wall shortens

**Trigger:** `draw` `{ seat, tile, wallIndex, wallRemaining }`.
**Total: 180 ms.**

| Phase | ms | What |
|---|---|---|
| lift | 0–40 | The top tile of the head stack rises `0.5/sin θ` tile-heights straight up. **The wall's silhouette changes here** — that stack is now one tile high. |
| travel | 40–160 | To the drawing seat's drawn slot, rotating `flat → upright`. Local seat: the face turns over during the last 60 ms. Remote seats: it stays a back the whole way. |
| land | 160–180 | 20 ms settle, no overshoot. |

**Easing:** `cubic-bezier(.4,0,.2,1)` throughout. A draw is a deliberate pick-up.

**Wall depletion is derived, never counted.** `wallIndex` advances from the head; the tail
pointer is `wallIndex + wallRemaining`, and replacement draws (花 and 槓, `takeTail`, 執尾)
retreat it from the far end. Both numbers are on the payload of every drawing event. The
renderer computes stack occupancy from them and **keeps no count of its own**, which makes a
desynced wall structurally impossible. This is the cheapest correctness win in the document, and
it delivers what `PAGE-INVENTORY.md` §6 asks for: a wall that is a physical shrinking object
rather than a number in a bar.

**Must not block.** Your own discard. If you have pre-selected or are playing drawAndCut, the
action can be sent while the draw tile is still flying — see the one retarget case in §7.

**Reduced motion.** The stack loses its top tile instantly; the drawn tile fades in at the slot
over 90 ms.

**Overlap.** Never with another draw. Routinely with the previous seat's toss, same frame,
different lanes — which is precisely the case lanes exist for.

**Interruption: retarget** (the only motion with this policy). See §7.

---

### 6.4 FLOWER REPLACEMENT 補花 — the one no competitor has

The Japanese game has no flowers, so no competitor has this motion at all. `RENDERING.md` §5 flags
it as
worth making feel good; it is also structurally distinctive, because the replacement comes off
the **opposite end of the wall** from a normal draw.

**Trigger:** `flowerReplacement` `{ seat, flower, replacement, wallIndex, wallRemaining }`.
Recursive — a replacement that is itself a flower emits another, same seat, strictly ordered.

**Total: 300 ms for one; chained links overlap by 120 ms, so N flowers = `300 + 180(N−1)` ms.**
Three flowers is 660 ms, not 900.

| Phase | ms | What |
|---|---|---|
| reveal | 0–50 | The flower turns face-up **in place**, in the hand. It was a back to everyone else; a flower is public the moment it is shown. This beat is what makes the motion read. |
| to tray | 50–210 | Arcs out to the face-up flower tray in front of that seat and lands **squared up**. |
| replacement | 120–280 | Lifts off the wall's **tail** 執尾 and travels to the drawn slot — overlapping the flower's flight by 90 ms. |
| settle | 280–300 | |

**Flowers are tidy; the pile is messy.** That contrast is not a style choice — it is what a real
table looks like, because flowers are laid down and discards are thrown.

**The tail-end pickup is the detail worth having.** Normal draws come off one end of the wall,
replacements off the other, exactly as `takeHead` / `takeTail` do it. Anyone who has played at a
HK table will notice; anyone who hasn't will not care. That is the correct kind of detail — it
costs one branch and it is never wrong.

**Must not block.** Nothing. Flower replacement is resolved server-side before the turn is
anyone's; no clock is running against any player during it.

**Reduced motion.** Flower cross-fades from hand to tray (100 ms); replacement fades in at the
slot (100 ms); no chain overlap, and the whole chain is cut at 600 ms total.

**Overlap.** With itself, handled by the 120 ms chain overlap. Inside the deal, where it is the
tail of the ceremony (§6.10).

**Interruption: cut.** A six-flower chain arriving during a reconnect compresses to one 300 ms
motion showing the *last* flower and the final tray contents. The tray is the state; the
individual flights are not.

---

### 6.5 MELD 上 / 碰 / 槓 — the claimed tile flies over

**Trigger:** `claimed` `{ seat, kind, tile, from, meld }`. Arrives in the window-close burst.
**Total: 420 ms (chow/pung), 500 ms (kong).**

| Phase | ms | What |
|---|---|---|
| lift | 0–60 | The claimed tile rises `0.6/sin θ` out of the pile; its contact shadow drops. **The rest of the pile does not move** — the slot was freed at admission without renumbering (§3). |
| flight | 60–260 | To the claimant's meld strip. Flatter and lower than a toss: a claim is a reach, not a throw. `cubic-bezier(.2,.7,.3,1)`. |
| reveal | 200–320 | The two (kong: three) concealed tiles rotate face-up and slide out to join it, staggered 40 ms apart. The stagger is what makes 碰 read as *snatch, then reveal* rather than as a teleport. |
| settle | 320–420 | The meld rotates as a unit so the claimed tile sits **crosswise on the side facing `from`**. `cubic-bezier(.34,1.2,.64,1)` — placed down firmly. |

**That final rotation encodes `from`.** It is the physical convention at a real table and it
renders a real piece of information for free — `PAGE-INVENTORY.md` §6 lists "melds rotated to
show the claimed tile's source seat" as one of the cheap wins, and this is where it happens.

**Must not block: the claimant's own next discard.** This is the sharpest instance of "presentation
lags, input binds to authoritative state" in the whole game, because it is the one moment when
the tiles under a player's finger are moving. `turnMs` (20 000 ms) is *already running* when the
motion starts.

The concrete mitigation: while a meld motion owns a hand, **the hand's remaining tiles hold
their post-meld positions from t=0**, and only the departing tiles animate. Nothing the player
can tap ever moves. That is what "must not block" means in implementation terms.

**Reduced motion.** Pile tile fades out; the meld appears complete and correctly rotated over
140 ms.

**Overlap.** With `claimDeclined` dismissals on other seats (§6.6), and — for a claimed kong —
with the `kongReplacement` chain that follows in the same lane. See §8 for the arithmetic.

**Interruption: queue, compress under backlog.** The kong case is the tightest in the game.

---

### 6.6 CLAIM DECLINED — the window closing

**Trigger:** `claimDeclined` `{ seat, tile, from, reason }`. You only ever see your own; the
redactor drops everyone else's, because who was offered a claim is the strongest tell in the game.

| `reason` | ms | Treatment |
|---|---|---|
| `pass` / `timeout` | 140 | Prompt buttons drop 8 px and fade; countdown ring completes and dissolves. |
| `outranked` | 240 | Buttons flash once before dismissing. |

**`outranked` deserves its own treatment.** "You were beaten to it" is a different fact from
"you passed", the log records which, and every other client would throw that away. It is also a
teaching moment of exactly the kind `DESIGN.md` §7 wants — cheap, rule-derived, incapable of
being wrong.

**Must not block: absolutely nothing.** If the window closed and someone else claimed, that
claimant is already on their clock.

**Reduced motion.** 90 ms opacity fade; `outranked` keeps the single flash, because it is
information rather than flourish.

**Interruption: cut.** It owns nothing.

---

### 6.7 KONG DECLARATION 暗槓 / 加槓

**Trigger:** `concealedKong` `{ seat, tile, meld }` or `addedKong` `{ seat, tile, meld }`.

**Concealed kong 暗槓 — 380 ms.** Four tiles slide out of the hand as a block, staggered 30 ms,
and land **face down**. `RedactedConcealedKongPayload` nulls the identity for every other seat,
so remote clients render four backs and the local client renders four faces. **Take the identity
from the payload and never from a local inference** — this is precisely where a rendering
shortcut becomes a rules leak. Some houses turn the outer two face up; that is a ruleset flag,
and the renderer draws what the payload gives it and nothing more.

**Added kong 加槓 — 300 ms.** The single tile lifts from the hand, travels to the existing
exposed pung, and is placed **crosswise on top of** the meld's already-crosswise claimed tile.
That stack is the physical convention and it makes 加槓 distinguishable from 明槓 at a glance,
across the table, without a label.

**The rob window is the highest-stakes 5 000 ms in the game.** `addedKong` is immediately
followed by `robKongWindow`, and 搶槓 is the one claim that can turn a routine kong into a
limit-adjacent hand. **The prompt must be live before the placement animation finishes** — I1,
at its most expensive if violated. Buttons at t=0, tile still in the air at t=260.

**Reduced motion.** The block appears in place over a 120 ms fade; the 加槓 tile appears stacked.

**Overlap.** Chains directly into `kongReplacement` (§6.8) in the same lane.
**Interruption: queue.**

---

### 6.8 KONG REPLACEMENT — off the tail

**Trigger:** `kongReplacement` `{ seat, tile, kongKind, wallIndex, wallRemaining }`.
**Total: 200 ms.**

Structurally a draw, with two deliberate differences: it comes off the wall's **tail** 執尾, and
its arc is **flatter and longer** because the distance is genuinely greater. Do not reuse the
draw's 180 ms and arc — if the replacement travels the same distance in the same time as a head
draw, the wall stops reading as an object with two ends, and the whole point of §6.4's tail
pickup goes with it.

**Must not block: the claimant's discard.** `turnMs` has been running since the window closed
(claimed kong) or since the declaration (concealed / added kong). This motion sits at the end of
the longest chain in the game — §8.3 — and is the one most likely to be compressed. It must
never be the reason a player cannot act.

**`kongKind` distinguishes the three forms in the payload**, so the renderer can vary the
pickup: `exposed` 明槓 follows a meld that just flew in from the pile, `concealed` 暗槓 follows a
face-down block, `added` 加槓 follows a rob window that may have run its full 5 000 ms. Same
motion, three different things just happened before it.

**Reduced motion / interruption:** as §6.3.

---

### 6.9 OPENING THE HAND 開牌 — the reveal at a win

**Trigger:** `winOnDiscard` or `selfDraw`. The payload carries `concealed[]`, `melds[]`,
`flowers[]` and the full `ScoreResult`.
**Total: 2 000 ms. Ceremony lane, exclusive, skippable from frame 1 (I3).**

| Phase | ms | What |
|---|---|---|
| dim | 0–120 | Everything except the winning seat's area dims 35 % and desaturates. Via **one overlay element**, never a `filter` on sixty nodes (I4). |
| the beat | 120–160 | The winning tile pulses once, 1.0 → 1.08 → 1.0, **wherever it is** — in the pile for 食糊, in the drawn slot for 自摸. Same beat, different origin: that difference is the entire distinction between the two wins, and it costs nothing. |
| **the sweep** | 160–890 | Concealed tiles rotate up from backs to faces, **left to right, 36 ms apart**, each tile's own flip taking 160 ms. The winning tile flips **last**, with an extra 100 ms of air before it. |
| regroup | 890–1030 | The revealed hand re-sorts into its scoring decomposition — `ScoreResult` names which tiles form which set, so the tiles slide into clusters with gaps between sets. |
| faan | 1030–2000 | Faan bars stack in 120 ms apart; the total counts up over the final 320 ms. DOM, not scene. |

**The sweep's arithmetic, since it is the one phase that has to close.** Worst case is a fully
concealed win: 13 tiles plus the winning tile. Flip *k* starts at `36k` and runs 160 ms, so the
thirteenth starts at 432 ms and lands at 592 ms; the winning tile starts at `432 + 36 + 100 =
568` and lands at 728. Add the settle and the phase is 730 ms wide. A hand with exposed melds
has fewer concealed tiles and finishes sooner — **the sweep is variable-length and the phases
after it are anchored to its end, not to a fixed offset.** Getting this backwards is how a
ceremony ends up with the faan bars sliding in over tiles that are still turning.

**The stagger is the whole trick.** Thirteen simultaneous flips read as a rendering glitch. A
36 ms wave reads as a person turning their hand over. This is the motion the owner named and it
is one of the two places (with the toss) where the specific number matters more than the idea.

**The regroup at 890–1030 ms is teaching for free.** A player who cannot yet see *why* a hand is
worth four faan watches the sets separate themselves. `DESIGN.md` §7 wants teaching integrated
with play and rule-derived rather than heuristic; a decomposition the scorer already computed
is as rule-derived as it gets. Whether this ships at P0 is listed as open (§15) — it is roughly
forty lines and it is the strongest teaching beat available, so the lean is yes.

**Skip.** A tap at any point applies all end states and leaves the score panel up. The handler
is bound in `reserve()`, so it is live before the dim starts — a player who has seen this two
hundred times must never wait 120 ms for the ability to dismiss it.

**Reduced motion.** No rotation. Backs cross-fade to faces in the **same left-to-right stagger**,
at 20 ms apart with 90 ms fades. **Keep the stagger, drop the rotation.** The stagger is the
information — it directs the eye along the hand — and the rotation is the flourish. The sweep
falls to ~420 ms and the ceremony total to ~750 ms.

**Overlap: none.** Admitting this cuts every seat lane to its end state first.

---

### 6.10 THE SWEEP AT HAND END 洗牌

**Trigger:** `handEnd` `{ outcome, chipDeltas, standings, dealerRepeats, nextDealer, … }`,
after the score panel is dismissed.
**Total: 700 ms. Ceremony lane, skippable.**

| Phase | ms | What |
|---|---|---|
| collapse | 0–200 | Shadows drop; melds un-rotate; standing hands fall face-down. |
| sweep | 150–550 | Everything slides toward the table centre with a per-tile stagger, converging into a loose mound. Not a physics collapse — a directed sweep. Stagger seeded from the tile's slot index using the same `jit()` hash as the pile scatter, so it is deterministic and replay-stable. |
| clear | 400–700 | The mound fades out as the next hand's wall fades in. |

**One thing the sweep must not erase.** On `dealerRepeats: true` 連莊 the dealer's seat badge
holds its marker *through* the sweep rather than the dealer button animating anywhere. Whether
the dealer repeated is the single most-asked question at the end of a hand, and it is the one
piece of state that must survive the clear.

**Must not block.** The results / hand-summary panel, which is DOM and sits above the scene.
**Reduced motion.** 250 ms cross-fade, table to empty table.
**Interruption: cut.**

---

### 6.11 SHUFFLE AND BUILD 砌牌 — and the deal

**Trigger:** `deal` `{ seed, dealer, roundWind, seatWinds, hands[], wallIndex, wallRemaining }`,
followed by the `flowerReplacement` chain.

**This is the free budget, and it is the only one.** The DO does not start any clock until the
table is full, and `startMatch` runs the deal *and* the entire flower chain to completion
server-side before anybody can act. Nothing is ticking. **Spend animation where the clock is
not running — deal, hand end, results — and starve it where it is.** That single principle
explains most of the durations in this document.

**Total: 1 400 ms for hand 0. 520 ms for hands 1..n.**

That asymmetry is deliberate. A full build ceremony every twenty-five minutes is charming; the
same ceremony every three minutes is a tax, and a default match is one wind round 東圈 — four
rotations plus repeats, so roughly eight to sixteen deals. Most games get this wrong by shipping
one duration.

| Phase | ms (hand 0) | What |
|---|---|---|
| build | 0–400 | The four walls assemble as **8 groups, two per side** — *not* 72 individual stacks; see §11. Each group is a 160 ms drop-and-settle, staggered 40 ms. |
| break | 350–500 | The break marker snaps onto the break stack. **Derived from `wallIndex` in the payload, not chosen.** If the rendered break does not match the pointer, the wall depletes from the wrong place for the entire hand. |
| deal | 450–1150 | Thirteen tiles per seat, dealt the way it is actually done: **blocks of four, four rounds, then the singles.** Four seats × four beats at 90 ms per beat, then singles 60 ms apart. Local seat's tiles arrive as backs and flip to faces on landing, staggered 30 ms — you do not see your hand until it is in front of you. |
| flowers | 1150+ | §6.4's chain, overlapped: `300 + 180(N−1)` ms. |

**How long is the flower tail, really.** Eight flowers in 144 tiles; the deal moves 53 tiles
(13 × 4 + 1). Expected flowers dealt ≈ `8 × 53/144 ≈ 2.9`, plus a small recursive tail. So the
typical deal is `1400 + 660 = ~2.1 s`, with a long tail to ~3 s on a flowery deal. That is the
longest uninterrupted stretch in the game, it happens against no clock, and it is where the
table gets to look like a table.

**Reduced motion.** The wall appears whole, hands fade in over 200 ms, flowers apply to the tray
instantly. Total ≤ 300 ms.

**Overlap: none.** The deal owns every lane. **Interruption: cut** — a replay scrub past a deal
lands on the completed table.

---

## 7. Interruption — one policy per motion

Four policies. The default is queue; everything supports compression, which is a *lane*
behaviour rather than a motion behaviour.

| Policy | Meaning | Used by |
|---|---|---|
| **queue** | Runs to completion; the next motion in the lane waits. | toss, meld, kong declaration, flower, kong replacement |
| **cut** | Jump to the final phase (last ~90 ms), or straight to `settle()`. | declines, sweep, deal, chained flowers under backlog |
| **retarget** | A running motion's destination is changed in flight. | **draw, and only draw** |
| **cancel** | Abandon and apply `settle()`. | grab (owns no model state) |

**There is exactly one retarget in the whole game, and that is on purpose.** When a `draw` is
still in flight and the same seat's `discard` arrives with `drawAndCut: true`, the toss must
originate from wherever the draw tile currently *is* — not from a drawn slot it has not reached.
Retargeting there is one line (change the carrier's endpoint, leave the lifter alone) and it
removes a visible teleport that would appear on every fast drawAndCut, which is a large fraction
of all discards.

Everywhere else, blending is refused. Blending is where animation systems go to die: every
blend is a pairwise case, the pairs multiply, and the failure mode is a scene that is subtly
wrong in ways no one can reproduce. Queue-with-compression covers the same ground with one
rule instead of N².

**Compression bands.** `RENDERING.md` §4 says "if the queue gets deep, snap." Between 1× and
snap there are two useful bands, and the tightest case in the game (§8) lives in one of them.

| Lane backlog | Policy |
|---|---|
| ≤ 250 ms | Play at 1×. |
| 250–900 ms | **Compress**: `rate = backlog / 250`, capped at 3×. |
| 900–2 500 ms | **Cut**: apply `settle()` to all but the newest motion; play the newest at 1×. |
| > 2 500 ms, or any `setView()` | **Snap**: `flush()`. No animation. (I2 — §4's reconnect rule, now with a number on it.) |

Backlog is measured per lane, not globally, so a deep ceremony never compresses an unrelated
seat's draw.

---

## 8. The timing budget, worked

The claim window is a **fixed 5 000 ms** (`DEFAULT_TABLE_CONFIG.claimWindowMs`) and the DO opens
it at commit. Every animation has to fit in the gaps that leaves.

### 8.1 A discard with a live claim prompt and two other seats mid-motion

Client clock zero at frame arrival. One-way RTT assumed 60 ms typical.

| t (ms) | Server fact | Client obligation | Lane | Cost |
|---|---|---|---|---|
| −60 | Discard commits; window opens; `deadlineTs = commit + 5000` | — | — | — |
| **0** | Frame: `discard`(s2), `claimOffered`(s0, pung) | **Call buttons interactive this frame** (I1) | UI | 0 |
| 0–380 | — | Toss s2 → pile slot | `seat2` | 380 |
| 380–4 940 | Window open | Nothing. Dead air. | — | 0 |
| 4 940 | Window closes server-side | — | — | — |
| **5 000** | Frame: `claimDeclined`(s0, outranked), `claimed`(s3, chow). **`turnMs` for s3 starts now.** | s3's hand interactive this frame | — | — |
| 5 000–5 140 | — | Decline dismiss | `seat0` UI | 140 |
| 5 000–5 420 | — | Meld: lift, fly, reveal, rotate | `seat3` | 420 |
| 5 700 | s3 is a bot at `botMinPaceMs`: frame `discard`(s3) + `draw`(s0) | — | `seat3`, `seat0` | 380 ∥ 180 |

Lane 3 backlog at t=5 700 is `5 420 − 5 700 = −280` ms — idle. Everything plays at 1×.

**The toss is not the problem.** It consumes 380 ms of a 4 940 ms window: **7.7 %**. There is
more than twelve times the headroom needed.

### 8.2 The gaps, enumerated

| Gap | Length | Motions that must fit | Verdict |
|---|---|---|---|
| Discard → window close | 4 940 ms | toss 380 | 7.7 % — trivial |
| Discard → next draw, **no claim offered** (same commit) | `botMinPaceMs` = **700 ms** | toss 380 ∥ draw 180, different lanes | 380 ms peak, 320 ms slack |
| Window close → claimant's discard, **chow/pung**, bot | **700 ms** | meld 420 | 60 % — fits |
| Window close → claimant's discard, **kong**, bot | **700 ms** | meld 500 + kongReplacement 200 + flowers `300+180(N−1)` | **over budget** |
| Any gap, human player | up to `turnMs` = 20 000 ms | anything | never a constraint |

### 8.3 The one pressure point

A **claimed kong followed by a flower-bearing replacement, against a bot at minimum pace**:

```
meld (kong)         500 ms
kongReplacement     200 ms
flowerReplacement   300 ms          (N=1)
  each extra        180 ms
                  ─────────
N=1 chain         1 000 ms   against a 700 ms gap  →  300 ms over
N=3 chain         1 360 ms   against a 700 ms gap  →  660 ms over
```

At N=3 the lane backlog is 660 ms, landing in the 250–900 band: `rate = 660/250 = 2.64×`,
capped at 3×. The chain compresses from 1 360 ms to ~515 ms and fits with room. **Nothing
breaks, but this is the only case in the game where compression is load-bearing rather than a
safety net**, and it is the reason band 2 exists at all.

**Two ways to remove it, and a recommendation.**

- **Raise `botMinPaceMs` from 700 to 900.** Still far inside `botMaxPaceMs: 2 500`, still well
  clear of `botWindowMarginMs: 400`. It does not remove the pressure point outright — it moves
  the common N=1 chain into band 1 (100 ms backlog, no compression at all) and drops N=3 from
  2.64× to **1.84×**, which is under the threshold at which compression is visible. This is a
  game-feel change, so it is the owner's call, not the renderer's. **Lean: do it** — a bot that
  claims a kong and discards 700 ms later reads as inhuman regardless of what it costs the
  renderer.
- **Do nothing.** 2.6× compression on a chain that occurs in a small fraction of hands is a
  legitimate outcome. The bands exist for exactly this.

### 8.4 A constant that disagrees with itself

`engine/src/reducer.ts:101` exports `CLAIM_WINDOW_MS = 3000`. `worker/src/table.ts:297` sets
`claimWindowMs: 5_000`, and the DO's contract note is explicit that the reducer's `deadlineTs`
"is overwritten on the way out; the live table's `claimWindowMs` is the one that counts."

Behaviour is therefore 5 000 ms and this whole section is right — but **any test, tool, bot
harness or animation tuned against the reducer standalone is tuned against 3 000 ms.** Recommend
the reducer take the window from the ruleset config rather than a module constant, or at minimum
rename it `DEFAULT_CLAIM_WINDOW_MS` so the divergence is visible at the call site. Two-line fix;
it will otherwise be found the hard way.

---

## 9. Concurrency — what four at once actually looks like

**A hard budget: ≤ 24 concurrently animating elements in `DomScene`.** This is not a round
number; it is what the deal costs, and the deal is the ceiling.

| Motion | Elements at peak | Note |
|---|---|---|
| Toss | 3 | carrier + lifter + spinner (+ 2 hand layers at P1) |
| Draw | 3 + 1 | nested arc + the wall stack losing its top |
| Flower chain | 4 | two links × 2 tiles, overlapped |
| Meld | 5 | claimed tile + up to 3 revealed + the meld group's rotation |
| Decline dismiss | 1 | |
| Opening the hand | 15 | 14 tiles (uniform, single-element) + dim overlay |
| Hand-end sweep | ~20 | uniform keyframe, single element each |
| **Deal** | **24** | 16 tiles in flight (uniform, single-element) + 8 wall groups |

**Why the deal is single-element and the toss is not.** Nested carrier/lifter/spinner is needed
only where the arc is *parameterised at runtime* — the toss, the meld, the flower, the draw.
Deal arcs are all the same shape, so one shared `@keyframes` with per-tile CSS custom properties
and a `--delay` covers all sixteen at one element each. That is what keeps the deal at 24 rather
than 56.

**Realistic simultaneous worst case, mid-hand:** toss (3) + draw (4) + flower chain (4) +
decline dismiss (1) = **12**. Half the budget. The ceiling is set by a ceremony that owns the
whole table, so it is never contended.

**The admitter enforces it.** A motion that would push the scene over 24 does not start; the
oldest lane compresses or cuts instead (§7). That makes the budget a mechanical property rather
than a hope, and it makes the 30 fps floor on low-end Android (`RENDERING.md` §6) something the
system defends rather than something you measure after the fact.

---

## 10. Sound hooks

Not an audio spec — a list of the points where audio attaches, recorded now because **timings
tuned without audio have to be re-tuned with it**, and `DESIGN.md` §1 calls Cantonese call audio
table stakes.

| Motion | Cue | Offset from motion start |
|---|---|---|
| Toss | the clack | **290 ms** — the landing, not the throw |
| Draw | soft wooden slide | 30 ms — the lift off the stack |
| Flower | reveal chime, then clack into the tray | 40 ms / 200 ms |
| Meld | **the call — 碰 / 上 / 槓, spoken** | **0 ms** |
| Concealed kong | four-tile knock | 200 ms |
| Added kong | single clack onto the pung | 260 ms |
| Win | 食糊 / 自摸, spoken | 0 ms, before the dim |
| Hand-end sweep | the wash 洗牌 | 150 ms, sustained ~400 ms |
| Deal | stacks knocking | staggered with the build |

**Two of these are load-bearing.**

The toss clack fires at **290 ms**, at the landing — not on event receipt. The clack is *the*
sound of mahjong, and firing it when the tile leaves the hand instead of when it hits the table
makes the whole game feel wrong in a way most players cannot name but all of them notice.

The meld call fires at **0 ms**, *before* the tile moves. At a real table the call comes out of
someone's mouth and the hand follows. Getting that order backwards is the difference between
"these people play mahjong" and "these people have seen mahjong."

---

## 11. The hands

Hands are the thing nobody else renders, and they are also the hardest thing to animate
believably. The proposal is to make them tractable by refusing to rig them.

### 11.1 The approach: six poses, one quad, no skeleton

**A hand is a sprite that translates and rotates as one quad, exactly like a tile. It never
deforms.** All apparent articulation comes from three things:

1. **Moving the quad** — 60 fps, transform only.
2. **Swapping which pose is drawn** — on a fixed **60 ms grid** (~16 fps of pose over 60 fps of
   position). The low pose rate is a *feature*: it is how 2D animation has always worked, and it
   reads as drawn rather than uncanny. Sub-frame-rate pose stepping is what separates "stylised"
   from "cheap."
3. **Crossfading between adjacent poses** over 60–90 ms where the swap would otherwise pop.

**The pose set — six, and that is the whole vocabulary:**

| Pose | Used by |
|---|---|
| `rest` | idle at the table edge |
| `reach` | §6.1 grab, §6.2 toss wind-up |
| `grasp` | §6.1, §6.5 meld |
| `lift` | §6.1 hold, §6.3 draw |
| `release` | §6.2 toss flight |
| `sweep` | §6.10 hand end, §6.11 gathering the deal |

**The wrist is the anchor.** The sprite pivots about the point where it meets the table edge.
One rotational degree of freedom gets almost all of the reach: a hand pivoting at the wrist to
cover a thirteen-tile fan is what a real hand does.

**The carried tile is a separate sprite drawn against a per-pose grip anchor** — an (x, y) in
the pose's own coordinates, authored with the art. So tile identity and hand pose are fully
independent, which is also, not coincidentally, what keeps cosmetics out of the log (§1).

**The one genuine complication: fingers must be in front of the tile.** That is the entire
illusion, and a single-layer sprite drawn over or under the tile gets it wrong either way. So
`grasp` and `lift` — and only those two — are **two-part poses**: a back-of-hand layer beneath
the tile and a fingers layer above it. Two poses × two layers, not six.

### 11.2 What it costs

| Item | Count | Note |
|---|---|---|
| Poses | 6 | fixed vocabulary above |
| Distinct viewing angles | 3 | near seat, side seat, far seat |
| Unique drawings per hand model | **18** | 6 × 3 |
| Rendered variants | 36 | side seats mirror |
| Extra layers | +2 | `grasp` and `lift` split |
| DPR tiers | ×3 | atlas cost, not drawing cost |

**Estimate: 4–8 working days of illustration per hand model** (18 drawings at this level of
finish, ~2–4 per day). Estimate, with a range, not a quote. After the first model the *poses*
are shared and only the drawings differ, so additional characters are the same 4–8 days each
with zero engineering.

### 11.3 What it buys, and what it cannot do

**Buys.** Riichi City and Mahjong Soul render tiles that move by themselves. A table where hands
move the tiles is instantly, visibly a different product, and it is the "warm, funny,
characterful" register the tone brief asks for — the opposite pole from both the anime-gacha
lane and the po-faced heritage-museum lane. It is also cosmetic by construction: a hand model is
a texture set plus a pose table, so retiring one breaks nothing, because the log never mentioned
it.

**Cannot do.** No per-tile finger placement — the grip anchor is per-pose, so a hand holding the
third tile of a fan looks the same as one holding the eleventh apart from wrist rotation. Nobody
will notice. No unique reactions, no idle personality beyond `rest`, no physics, no IK, no rig.
All deliberate.

### 11.4 Hands are P1-visual and P0-architectural

`DESIGN.md` §3 already puts **eight flower/season faces and a tile back** on the P0 critical
path as Track A's first deliverable, ahead of match-scene UI work. Hands come after those. They
are not P0 art.

But the *layer* is P0: reserve the hand layer, the wrist anchor, the grip anchors and the pose
crossfade mechanism now, and ship the drawings later.

**Every duration in §6 was chosen so the motion reads with or without hands.** The hand is drawn
on top of a motion that already works. Nothing in the timing budget (§8) changes when hands
arrive; only the element counts in §9 move, by two per animating seat, which the 12-of-24
mid-hand headroom absorbs.

---

## 12. Reduced motion

`RENDERING.md` §5 says "fall back to cross-fades and keep the timings." Half right. Keeping the
timings is correct for **pacing** and wrong for **dead air**: a 1 900 ms win ceremony that is
only a cross-fade is 1 900 ms of nothing happening.

**Policy, in three lines.**

1. **Motions that carry information keep their end state exactly and lose their path.** Which
   slot a tile landed in, at what angle, which seat a meld came from — all preserved. The pile's
   messiness is information (`RENDERING.md` §4a), not decoration, so reduced motion keeps the
   mess.
2. **Ceremonies keep their sequence and lose ~60 % of their duration.** The win reveal keeps its
   left-to-right stagger at 20 ms instead of 36 ms and drops from 2 000 ms to ~750 ms.
3. **Nothing is removed.** A reduced-motion player must still witness every state change, or
   they lose information the log carries and sighted-with-motion players get.

**The addition most implementations miss: replace the attention cue you removed.** Motion's job
is to direct the eye. Delete the motion and the eye has nothing to follow, so reduced-motion
mode adds a **120 ms outline pulse on the changed object** — the landed tile, the completed
meld, the shortened wall stack. This is not a consolation flourish; it is the functional
replacement for the thing that was taken away.

**A settings control, not only an OS query.** Ship **Motion: Full / Reduced / Off**, defaulting
to `prefers-reduced-motion`. A player on a five-year-old Android wants reduced motion for
frame-rate reasons rather than vestibular ones and should not have to change an OS-wide setting
to get it. `Off` goes further than `Reduced`: instant state application, no cross-fades, keep the
outline pulses.

**The assertion (I5):** for every motion, the model after `settle()` is byte-identical under
Full, Reduced and Off. Testable, and it is what guarantees rule 3.

---

## 13. P0 or later — CSS versus sprites

`RENDERING.md` §8 phases `DomScene` (P0, CSS 3D) then `PixiScene` (after the gate). Here is
which motions land on which side, and why.

### 13.1 Achievable in CSS at P0

| Motion | Technique | Caveat |
|---|---|---|
| Grab | translate + scale, no hand art | none |
| Toss | nested carrier/lifter/spinner, keyframed arc | the z-order pop, below |
| Draw | same, plus the wall stack's top element removed | none |
| Flower replacement | same, off the tail | none |
| Meld | same + a group rotation | none |
| Decline dismiss | opacity + translate | none |
| Kong declaration + replacement | block slide, crosswise placement | none |
| **Opening the hand** | `rotateY` + `backface-visibility`, staggered `animation-delay` | **the highest impressiveness-per-line motion available** |
| Hand-end sweep | ~20 uniform keyframes | none |
| Deal | 8 wall groups + block dealing, uniform keyframes | see below |

**Why CSS survives P0 at all: the non-overlap guarantee.** `RENDERING.md` §2 is right that CSS
sorts flat and upright 3D-transformed elements wrong at some angles with no clean fix. But
`RENDERING.md` §4a's pile is *geometrically non-overlapping* — cells on a staggered grid of the
tile's own diagonal —
so **there is no per-tile sort to get wrong inside the pile.** What remains is a coarse five-band
ordering (table → pile → melds → wall → hands), which is a static `z-index` assignment updated
only at slot allocation, never per frame. A decision made in `RENDERING.md` §4a for a completely
different
reason (countability) is what makes the P0 renderer viable. Worth knowing, because it means
changing the pile layout has a renderer consequence.

**The one honest cost of `DomScene`: a single popping frame.** A tile landing into the *middle*
depth of the pile is drawn on top for its whole flight and snaps into its correct z-band on
landing. There is one frame where the sort changes and it is visible if you look for it. That is
the concrete price of P0 and it is acceptable. Name it rather than pretending it isn't there.

**The deal's P0 compromise.** A faithful build is 72 stacks × 2 tiles = 144 animating elements
at 1×. That breaks the 30 fps floor on low-end Android and blows §9's budget by 6×. So P0 builds
the wall as **8 groups, two per side**, each one composited element with its stacks baked into
the background. It looks ~90 % as good for 8 animations instead of 144. The 72-stack build is a
`PixiScene` feature.

### 13.2 Genuinely needs sprites — `PixiScene`, after the gate

| Thing | Why CSS cannot |
|---|---|
| **Hands with correct per-seat occlusion** | A far-seat hand is behind its own tiles in some poses and in front in others. Two layers per hand × four seats interleaved with tiles is exactly where CSS compositing gives up. This alone is most of the case for Pixi. |
| **72-stack wall build** | Element count. |
| **Full-fidelity deal** | 53 per-tile parameterised arcs. |
| **Tile thickness and specular during the flip** | CSS `rotateY` is a real, *clean* 3D rotation. A real tile turning over shows its edge and a light sweep across the face. Baked poses do that; CSS cannot without extra geometry per tile. P0 accepts the clean flip. |
| **The mid-pile landing sort** | Per-frame painter's-algorithm ordering — the pop above. |
| Landing dust, per-tile contact shadows at full quality | Cosmetic, and cheap once you own the painter. |

### 13.3 The recommended order

1. **P0, in order:** toss → draw → flower replacement → meld → decline dismiss → kong forms →
   opening the hand → deal (compromised) → hand-end sweep. The toss first, because it is the
   motion that decides whether the table feels Cantonese, and everything else is easier once its
   carrier/lifter/spinner scaffolding exists.
2. **P0 architectural, no art:** the hand layer, wrist anchor, grip anchors, pose crossfade.
3. **After the gate:** `PixiScene`, then hand art, then the fidelity items in 13.2.

---

## 14. How we know it is right

Six tests, all mechanical. Determinism comes free: every stagger and scatter seed is derived
from the envelope's `seq`, which is strictly +1 per event.

| Test | Assertion |
|---|---|
| **Golden timeline** | Feed a canned event log at a fixed clock; assert the exact set of active motions and their progress at 30 sampled timestamps. |
| **Budget** | Simulate 100 hands at `botMinPaceMs`; assert no lane ever enters the cut or snap band (§7). This is the test that would have caught §8.3 before a player did. |
| **Non-blocking (I1)** | For every window-opening and turn-handing event, assert the interactive element is in the DOM in the same frame the event was applied. |
| **Element ceiling (I5, §9)** | Assert peak concurrently-animating elements ≤ 24 across a full match. |
| **Motion-independent end state (I5)** | For every motion: model after `settle()` identical under 1×, compressed, cut, flushed, and under Full / Reduced / Off. |
| **Cosmetics firewall (§1, rule 5)** | Replay one archived match with cosmetics disabled and with cosmetics maximal; `SeatSnapshot` folds identical at every `seq`. |

---

## 15. Open decisions

Marked open because they are open, not because they are hard.

1. **Camera elevation θ.** `RENDERING.md` §9 says fix at 28–32° before baking sprites. Every
   foreshortening constant and arc apex in §2 is written as a function of θ. **Blocking on hand
   art and on any sprite bake; not blocking on P0 CSS.** Owner's call.
2. **`botMinPaceMs` 700 → 900.** §8.3. Removes the only case where compression is load-bearing.
   A game-feel change, so not the renderer's to make. Lean: yes.
3. **`CLAIM_WINDOW_MS = 3000` in the reducer vs `claimWindowMs: 5_000` in the DO.** §8.4.
   Behaviour is correct today; the constant is a trap for tools and tests. Two-line fix.
4. **Does the win ceremony's scoring-decomposition regroup (§6.9, 890–1030 ms) ship at P0?** It is
   ~40 lines, it is the strongest rule-derived teaching beat available, and `DESIGN.md` §7 wants
   exactly this kind of thing. Lean: yes. Genuinely a scope call.
5. **Do opponents get hands at P0-visual, or only the local seat?** The local seat is the one you
   look at, so it is the obvious first. But one handed seat facing three ghost seats may read
   *worse* than four ghost seats. This needs to be looked at rather than argued about — build
   both and put them side by side.
6. **The pile slot allocator's behaviour on a claimed tile.** §3 fixes the renumbering bug, but
   leaves a question: does the freed slot get reused by the next discard, or does the pile keep
   growing outward past the hole? Reuse is tidier and matches a real table (you throw into the
   gap); growing outward is simpler. Lean: reuse. Cheap either way, so decide it with the toss.

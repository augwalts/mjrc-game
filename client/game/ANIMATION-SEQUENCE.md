# Animation sequence — the audit

Written 2026-08-31 after the owner reported the previous player's discard
animating on top of their own draw. Every animation in the client is listed
here with what triggers it, how long it runs, and — the point of the document —
**whether it queues or runs alongside.**

Companions: `SPEC.md` §4 (timing table) · `../../sketches/ANIMATION.md` (the
original budgets, which §3 of SPEC records us deviating from).

---

## 1. The rule

> **Motions queue. Announcements ride alongside.**

A **motion** is something physically moving across the table — a tile thrown, a
tile drawn, the wall assembling. Two motions at once give the eye two things to
follow and it follows neither.

An **announcement** is a label appearing over the top — 碰, 花, 食糊. It is not
competing for the same attention, so it is free to run at the same time as the
motion that caused it. (Owner: *"it's ok for each player to 'declare' what tile
was tossed and run that animation similar to a call — that animation can happen
in parallel to the discard."*)

### Queueing never gates input

A queued motion is delayed, not withheld. The element is created the instant its
event arrives and any affordance on it is live immediately; only the *animation*
waits, pinned at frame 0 by `animation-fill-mode: backwards`.

This is `MatchScene.ts` rule 1 — **an affordance is never taken away by an
animation** — and it is not negotiable. If a queue ever needs to block a click,
the queue is wrong.

---

## 2. What was broken

`doDiscard` (`engine/src/reducer.ts:1143`) emits the discard and then calls
`advanceTurn`, which draws for the next seat. **Both happen inside one
`applyAction`.** The client consumed that batch and rendered once, so the tile
flying across the table and the tile flying into your hand began in the *same
frame*.

This is a general hazard, not a one-off: **the reducer batches, the client
renders once.** Any two motions the engine emits together will collide unless
the client schedules them. The same root cause produced two earlier defects:

- the pile's double-toss (nodes rebuilt by count, so settled tiles re-animated)
- the drawn tile re-flying on every `render()`, because `#myhand` was rebuilt
  wholesale two or three times a turn

Both are fixed the same way — **identity, then schedule.** A node is created
once for the thing it represents, and its animation is given a start time.

---

## 3. The inventory

| animation | fires on | duration | queues? |
| --- | --- | ---: | --- |
| `assemble` | start of every hand, per wall tile, staggered | 820 ms each, 1450 ms window | **starts the sequence** — nothing else is moving |
| `toss` | a discard reaches the pile | **1300 ms** | **yes** — it is the anchor the next motion queues behind |
| `tossFade` | with `toss` | 170 ms | rides with `toss` (see §4) |
| `drawFromWall` | you draw | 900 ms | **yes** — waits for the toss to settle |
| `botDraw` | a bot draws | 900 ms | **yes** — same delay |
| `callIn` | 碰 上 槓 花 食糊 自摸 搶槓 | 2200 ms (3200 ms for a win) | **no** — announcement, runs alongside |

Non-animation beats, for completeness:

| beat | value | what it is |
| --- | ---: | --- |
| claim hold | 750 ms | the table stops while a meld goes down |
| flower hold | 500 ms | the same, smaller |
| turn clock | 30 s | a visible nudge; expires nothing |

---

## 4. The toss, in four beats

Owner, 2026-08-31: *"the tile should land on the table, pause then accelerate
then stop suddenly — that is closer to the physics of tossing a tile and hitting
the pile."*

| phase | keyframe | ms | easing |
| --- | ---: | ---: | --- |
| **flight** | 0 → 52 % | 676 | `cubic-bezier(.11,.6,.32,1)` — fast out, slowing as it meets the felt |
| **contact** | 52 % | — | lands at 30 % of the throw distance, still crooked, scale back to 1 |
| **pause** | 52 → 64 % | 156 | `linear` — it is simply lying there |
| **skid** | 64 → 100 % | 468 | `cubic-bezier(.72,0,1,1)` — an ease-**IN**, still gaining speed at 100 % |

The last curve is the whole trick. A bezier that is **still accelerating when it
ends** reads as a hard stop, which is what a tile hitting other tiles does. The
previous version decelerated into its slot, which reads as a glide.

The landing point and angle are computed per throw in `game.ts`:
`--lx/--ly` = 30 % of the thrower's offset (about two tile widths of skid), and
`--lr` sits 22 % of the way from the throw's spin toward the resting angle, so
it straightens as it slides.

**Transform and opacity are two separate animations** (`toss` and `tossFade`).
Keyframes carry per-phase timing functions; folding an opacity ramp into the
same track would have split the flight into two differently-eased segments for
no reason.

---

## 5. The schedule, batch by batch

What the engine emits together, and what the player should see.

| engine batch | sequence |
| --- | --- |
| `discard` → `draw` *(the common case)* | toss flies · **at 64 % of it** the next draw begins |
| `discard` → `draw` → `flowerReplacement` → `draw` | toss · draw · 花 announcement **over** the replacement draw · replacement draw |
| `claimed` | 碰 announcement **with** the meld appearing · then a 750 ms hold before anything else moves |
| `concealedKong` → `draw` | 暗槓 announcement **with** the meld · hold · replacement draw |
| `discard` with a claim window open | toss only — no draw follows until the window resolves |
| `winOnDiscard` / `selfDraw` | 食糊 announcement, then the hand-end overlay. No hold: the overlay stops play by itself |

`AFTER_TOSS_MS` = `TOSS_MS × 0.64` = **832 ms**. Measured on a live game: draws
queue at 0.821–0.826 s behind their toss, and the deal's first draw correctly
gets 0 ms because nothing precedes it.

**Why 64 % and not 100 %.** At 64 % the tile has landed and paused — nothing is
flying. The skid is a small settling motion, and the next player reaching for
the wall over it is exactly what a real table looks like. Waiting for the full
1300 ms would add half a second to every turn to remove nothing the eye objects
to. `TOSS_SETTLED` in `game.ts` is the knob if that judgement turns out wrong.

---

## 6. Declaring the throw

At a table you say what you throw, so every discard now puts the tile's name up
beside the player who threw it. Built 2026-08-31 on the owner's instruction,
after I flagged the noise risk below and was overruled.

It is the **announcement lane**, so it runs alongside the toss and touches
nothing the motion queue reads — not `lastTossAt`, not `holdMs`. Adding it did
not lengthen a turn by a millisecond.

| | |
| --- | --- |
| element | `#say` — **its own**, not `#call` |
| duration | **640 ms**, entirely inside the toss's 676 ms flight |
| position | `s0`–`s3`, offset from `#call`'s so both can be up at once |
| weight | small, low-contrast, no gold. A whisper next to `#call`'s shout |

**Why a separate element.** A claim fires on the very next event after the
discard it claims, so sharing one banner would have 碰 stomping the declaration
that caused it. Verified: with both showing, their rects do not intersect.

**Why so quiet.** A call happens six or seven times a hand; this happens eighty.
The same treatment at call weight would be unreadable noise. Its life is over
before the tile lands, so labels never stack.

**One implementation trap.** Restarting a CSS animation on a reused element
needs the class removed, **a reflow forced**, then the class put back. Without
`void el.offsetWidth` between them the browser coalesces both style changes and
the animation never re-runs — a fast exchange would silently show only the first
player's call. Verified across a live game: nine declarations, all four seats in
turn order, none dropped.

## 7. Rules for adding an animation

1. **Decide the lane first.** Motion, or announcement? A motion queues; an
   announcement does not. If it is unclear, it is probably a motion.
2. **Give the node an identity.** Keyed to the thing it represents, created
   once. Never rebuild a container by count or wholesale — that is what
   re-triggered the toss and the draw.
3. **Delay, never gate.** `animation-delay` plus `backwards`. If you find
   yourself withholding a click, stop.
4. **Two places must agree** when a beat has both a CSS duration and a JS timer
   (`callIn` and `announce()` are the live example). Change both or neither.
5. **Verify with computed styles, not by watching.** A hidden browser pane
   creates animations that never tick, so `animationstart` never fires and
   everything looks fine. `getComputedStyle(el).animationDelay` tells the truth
   either way.

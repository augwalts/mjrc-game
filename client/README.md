# client — the match renderer boundary

**Status: no renderer here yet, and that is the point.** This package currently holds an
interface, its types, a null implementation and one test. `sketches/BUILD-PLAN.md` puts the
client in tier 4, "do not build yet", with a single exception: *"The one thing worth fixing
now is the `MatchScene` interface so the eventual DOM→Pixi swap stays mechanical."*

That is what this is.

Spec: `sketches/RENDERING.md` §4 (animation architecture), §4a (table layouts), §5 (animation
inventory), §7 (the interface). Doctrine: `DESIGN.md` §5. Terminology: `TERMINOLOGY.md` — Hong
Kong Old Style only, Japanese terms banned from code, comments, tests and strings alike.

```
client/
  src/scene/MatchScene.ts   the interface, the three hard rules, describeEvent, NullScene
  src/scene/types.ts        SeatView, SceneEvent, SceneOpts, the queue and its descriptors
  test/scene-boundary.test.ts
```

---

## Why the client is disposable

`DESIGN.md` §5's table ends with: *Client — P0: portrait PWA shell + SVG scene. Endgame: full
craft scene. What makes it survive: disposable by design; no game logic.*

The engine is a pure reducer and the server is authoritative, so the client holds nothing that
cannot be thrown away. Every rule, every faan, every claim priority decision lives behind the
socket. The client's whole job is to draw a seat's view of a table and report what the player
touched.

Disposable is a **property that has to be maintained**, not a fact about the code. It survives
exactly as long as no game logic accretes on this side of the line. The moment the scene knows
that a chow is legal, throwing it away costs a rewrite.

## Two implementations, one interface

| Phase | Renderer | When |
|---|---|---|
| 0 | Flat DOM sketch, no animation | done — `sketches/` |
| 1 | **`DomScene`** — CSS 3D transforms, the animation queue, real timings | P0 |
| 2 | **`PixiScene`** — sprite atlas, owned z-sort, same queue | after the P0 gate |
| 3 | True 3D | probably never; needs a moving camera to justify |

Both implement `MatchScene`. Same interface, same event stream, same log — so phase 2 replaces
only the drawing.

**Why Pixi and not a 3D engine.** The camera in mahjong never moves (§1). One projection
computed once, tiles are flat quads, lighting is baked into the sprite, and roughly four
rasterizations per tile cover every orientation. That is a 2D sprite problem in a 3D costume.

**Why not stay on CSS.** §2: z-sorting. The old-school HK layout is one jumbled centre pile —
dozens of overlapping quads at arbitrary rotations, all at z≈0 — so draw order *is* the visual.
Browsers composite 3D-transformed elements with their own painter heuristics and will sort
flat-lying against upright tiles wrong at some angles, with no clean fix. `PixiScene` owns the
sort. `DomScene` ships first anyway, because a wrong sort in P0 is a bug and a missing product
is not a product.

**Why the swap is cheap.** The replay viewer is the same renderer fed the same events from a
log instead of a socket, so phase 2 is validated against every hand ever played, not against a
hand somebody remembered to write down.

## The five methods

```ts
mount(el: HTMLElement, opts: SceneOpts): void
setView(v: SeatView): void      // authoritative snapshot — SNAPS, no animation
applyEvent(e: SceneEvent): void // enqueue ONE animation, return immediately
flush(): void                   // drop the queue, snap to the current view
destroy(): void
```

`SceneEvent` is `SeatVisible<RedactedGameEvent>`, which is a deliberate tightening of §7's
`applyEvent(e: GameEvent)`. §7 predates the two serializers in `protocol/src/events.ts`;
`GameEvent` is the **omniscient** union and carries the wall seed, every seat's dealt hand and
all four hands at an exhaustive draw. Handing that to a renderer would put the whole table in
the DOM for anyone with devtools.

**Six methods is the smell.** If the host needs a seventh thing from the scene, the likely
truth is that the host is reaching in. Ask what it actually wants to know before widening the
interface.

## The three hard rules

Reproduced from `RENDERING.md` §4 because these are the ones people get wrong, and the code
comments in `MatchScene.ts` carry them too.

**1. Animation never gates input.** The claim window's 5s timer starts server-side the moment
the discard commits. A client that animates the toss for 400ms and *then* shows call buttons
has silently taken 8% of the window, and the player cannot see that it happened. Show the
affordance immediately; animate underneath it. Concretely: `applyEvent` enqueues and returns —
it never awaits and returns no promise; input binds to the view last passed to `setView`, never
to what the queue has drained; countdown rings draw against the server's absolute `deadlineTs`,
so an event arriving 300ms late shows a ring already 300ms in, not a fresh 5s.

**2. Resync snaps.** Reconnect is snapshot + actions-since (`DESIGN.md` §5.3). Apply it as a
state replacement: `flush()` then `setView(snapshot)`. Never feed forty catch-up events to
`applyEvent` — forty animations to arrive at a state you already have is a minute of the player
watching history. The same path covers a backgrounded tab and every replay scrub.

**3. Every ceremony is skippable.** A player who has seen the win ceremony two hundred times
must be able to dismiss it. Anything with `skippable: true` ends on tap, lands on its final
frame immediately, and reports through `onCeremonyFinished(kind, true)`. Skipping is never
refused and never changes what is drawn at the end — only how long it took to get there.

Presentation lags state; state never waits for presentation.

---

## What must never cross the boundary

### Never *into* the scene

1. **Omniscient data.** No `GameEvent`, no `Omniscient<T>`, no wall seed, no wall order, no
   other seat's concealed tiles, no unredacted snapshot. Enforced by the compiler: the brands
   in `protocol/src/events.ts` make an omniscient payload a type error at `applyEvent`, and
   `test/scene-boundary.test.ts` pins that with a `@ts-expect-error` that fails the build if it
   ever stops erroring. Structural typing alone would not catch it — an omniscient payload is a
   *supertype* of its redacted form and would assign happily.

2. **Events this seat was never told about.** `redactEventFor` returns `null` for another
   seat's `claimOffered` / `claimDeclined`, because the mere existence of an offer to seat 2
   says seat 2 could claim. The host drops those. Do not add a "hidden" branch to accommodate
   them — a scene that cannot represent the tell cannot render it.

3. **Game logic, in any dose.** No legality, no faan, no claim priority, no readiness, no
   ruleset, no payment table. If the scene is deciding whether a chow is available, the client
   has started predicting rules and the disposability property is gone.

4. **The socket.** The scene does not send, does not receive, and does not know a server
   exists. The proof is the replay viewer: identical scene, log instead of socket, no branch.

5. **Wall-clock time as truth.** Deadlines come from the server as absolute `deadlineTs`. The
   scene never invents one, and never starts a 5s countdown of its own.

6. **`Math.random` and `Date.now`.** The pile's scatter is a pure hash of the match's
   `scatterSeed` and a stable key (`variantFor`). Random-per-frame scatter makes the pile
   visibly reshuffle every tick and makes replay scrubbing nauseating.

### Never *out of* the scene

7. **DOM or Pixi handles.** The host never calls `querySelector` into the scene container and
   the scene exports no node or display-object references. This is the clause the whole
   DOM→Pixi swap rests on: anything the host holds a handle to is something phase 2 has to
   reproduce. A helper that needs scene internals belongs *inside* the scene.

8. **Pixel coordinates.** Everything is positioned in table space `(x, y, z)` in tile units and
   projected (§2). The projection is the renderer's private business; a caller that thinks in
   pixels has pinned the camera for everybody.

9. **Decisions.** `SceneCallbacks` report what the player *touched* — `onTilePicked`,
   `onDiscardInspected`. They never assert what happened. `messages.ts`: "a client that 'knows'
   it discarded is predicting, and prediction is corrected by the next event batch."

10. **Derived game facts.** The scene must not compute "you are ready", "that discard is safe",
    or "this hand is worth 4 faan" and hand it back up. It draws what it was given.

---

## The animation queue

`applyEvent` maps one event to one `QueuedAnimation` through `describeEvent`, which is pure and
exhaustive — adding an event type without a descriptor is a compile error in two places
(`assertNever` in `toAnimation`, and the `SameKeys` proof at the foot of `types.ts`).

`ANIMATION_PROFILE` in `types.ts` is §5's inventory as data: budget, `skippable`, and `serial`.

**`serial` is about the queue, not about input.** It says whether the queue waits for this
animation before starting the next. Hard rule 1 holds either way. `claimOffered` is
`serial: false` because the call buttons rise *alongside* a discard arc still in flight — if
they waited for it, the player would lose 180ms of a 5s window.

§5's table has ten rows; the redacted event union has seventeen members. The seven timings that
are not in §5 are commented `extrapolated` in `ANIMATION_PROFILE`. They are opening proposals on
the same footing as §5's own, and retuning them is a renderer change, not a boundary change.

### Two decisions taken here that §5 does not cover

**Discard scatter is keyed on `(seat, indexWithinSeat)`, not on `seq`.** §4a says to seed the
scatter from the event index, which is right for a live stream — but `seq` does not survive a
resync. A `SeatSnapshot` carries `seats[i].discards` as per-seat arrays with no `seq` attached,
so a reconnecting player keyed on `seq` would watch the entire pile jump to new positions.
Keyed on `(seat, index)` the pile is bit-identical before and after a reconnect. See
`discardSlotKey`. Nothing is lost: the true ordered, attributed sequence lives in the event log,
which is where §4a says the pile is rendered from and where the review screen reads it.

**A refused win publishes its winning tile to everybody.**
`RedactedRefusedWinPayload.winningTile` is not redacted per-seat. Off a discard that costs
nothing — the tile is already face up in the pile. On a refused 自摸 it discloses one tile that
was concealed a moment earlier. That is arguably correct (the declaration is what exposed it)
and it is a protocol decision, not a renderer one, but the scene must not treat a declared tile
as evidence about the rest of the hand. Pinned by a test so a change to the rule fails loudly.

## `NullScene`

A `MatchScene` that draws nothing. It is not a stub awaiting replacement — it stays, as the
scene you mount when there is no screen: headless replay folds, socket plumbing under test, the
host built before either renderer exists.

It records what it was handed in `received`. That is bookkeeping, not rendering, and it is
deliberate: "no concealed tile ever reaches a renderer" is a property that has to be asserted
against *something*, and a scene that discarded its input could not be checked.

## The test

`test/scene-boundary.test.ts` asserts the property end to end — omniscient events in one side,
through the real `redactEventFor`, into a real `MatchScene`, and every tile that came out the
other side checked against tiles that were never anyone's business but their owner's. Testing
the redactor alone would not do: the leak this guards against is a *renderer* being handed
something it was never meant to draw, and that is a property of the whole path.

The fixture partitions tile space by seat — the viewer holds 萬 and 索1-4, and 索5-9, 筒2-9 and
the honours belong to seats 1, 2 and 3 — so a leak is a specific tile id showing up where it
cannot have come from anywhere else. Every public tile in the fixture (the discard, the claimed
pung, the 加槓, the 花) is drawn from outside every secret set.

The first assertion is a canary: the *omniscient* stream must trip the detector. A green test
that checks nothing is worse than a red one.

```bash
cd mjrc-game
npm run typecheck              # includes the @ts-expect-error boundary proof
./node_modules/.bin/vitest run client
```

## Writing a renderer

1. `class DomScene implements MatchScene`. The compiler will not let you forget a method.
2. Keep presentation state private and separate from the `SeatView` you were handed. §4:
   presentation lags state; state never waits for presentation. Collapsing the two — the
   sketch's `innerHTML` redraw on a 10fps interval — is the specific pattern the queue exists
   to prevent, and `RENDERING.md`'s appendix says so explicitly.
3. Draw a correct table having received zero events. `applyEvent` is a hint about how the truth
   changed, for the purpose of moving pixels. `setView` is the truth.
4. If the queue is deeper than the player's patience, `flush()` and snap. Always an option,
   never a failure.
5. Respect `opts.reducedMotion`: cross-fade and **keep the timings** (§5). Reduced motion is
   not zero duration — `opts.timeScale = 0` is.
6. Keep tile art rasterizable (§9). No runtime-only SVG trick that cannot bake into a sprite,
   or phase 2 inherits a problem it cannot fix. `mjrc-app/web/src/features/tiles/render.ts`
   stays the source of truth; the atlas is a build step over it.
7. Fix the camera at ~28-32° elevation early (§9). Sprite orientations are baked against it, so
   changing it later means re-rasterizing everything.

# Cosmetics — the boundary

Avatars, hand models, tile sets, table surfaces, and the faces an avatar pulls. Three
files: `types.ts` (the shapes), `registry.ts` (the catalogue, the defaults, `resolve()`),
this file (why they are shaped that way).

The creative direction — who is on the roster, what the sets look like, what the
characters are called — lives in `../../../PRESENTATION.md`. This module holds no art
and makes no aesthetic claims. It exists to make the art impossible to leak.

---

## 1. The rule

> Cosmetics never touch the engine, the reducer, the protocol, or the event log.

The log records:

```
{ seq: 412, handIndex: 3, actor: 2, type: "cut", payload: { tile: 18 } }
```

It must never record which tile **set** tile 18 was wearing, whose hand model threw it,
or what face seat 2 pulled afterwards.

## 2. Why — the two things that break

**The corpus.** `DESIGN.md` §1 makes the log a research asset and §5.5 makes it the
archive format. A log carrying presentation is a log every future query has to filter,
forever, including queries written by people who never heard of the 2026 tile sets.

**Replay.** §5.5 pins `engineVersion` in the header so a 2026 hand replays through the
build that produced it — replay is re-execution, not playback. Now suppose a `cut` event
had carried `tileSet: "jade"`. In 2028 "jade" is retired. Two options, both bad: keep
every cosmetic that has ever shipped alive forever, or accept that a two-year-old replay
now throws. Because the log holds no cosmetic ids, neither happens — the hand replays
byte-identically and the renderer dresses it in whatever exists today. **A retired
cosmetic is a rendering question, and rendering questions are never fatal.**

This is the same argument `../expressions/catalogue.ts` makes for table talk, reached
independently. Both conclusions are the same: presentation rides a side channel.

## 3. The boundary, drawn

```
   engine (pure reducer)        protocol (versioned events)       R2 archive / D1
        │                              │                                │
        └──── GameState, GameEvent ────┴────────────────────────────────┘
                       │                          ▲
                       │  read by                 │  NOTHING here has ever
                       ▼                          │  heard of a cosmetic
                 MatchScene  ◀──── SceneCosmetics ┴──── cosmetics/registry.ts
                                    (in SceneOpts)         ▲
                                                           │
                                          lobby plane (HTTP) hands over
                                          each seat's equipped loadout at join
```

Arrows only point one way. The scene reads cosmetics; nothing reads the scene.
Seat cosmetics arrive over the **lobby** plane at join time — `DESIGN.md` §2's hard rule
is that the two planes never share a channel, and a cosmetic id on the match socket would
be the first violation of it.

## 4. How the types make the wrong thing hard

| Technique | What it stops |
|---|---|
| **Zero imports.** This module imports nothing — not `@mjrc/engine`, not `@mjrc/protocol`, not a package. `FourSeats` and the seat indices are mirrored here on purpose. | The dependency edge that would make "just import the tile set id in the payload" a one-line change. The duplication *is* the boundary. |
| **Branded ids.** `TileSetId = string & CosmeticBrand<"tileSet">`, and so is every asset path. | Nothing on its own — but it makes cosmetics *findable* by the next row. |
| **`StaticAssert<IsLogSafe<T>>`.** A depth-limited type-level scan that finds a cosmetic brand anywhere inside `T`, at any nesting. Fails **closed** on depth exhaustion. | A cosmetic id declared in a payload type. One line per payload; see below. |
| **Art keyed by name, not by tile id.** A set supplies `chars5`, `dragonRed`, `back` — never `18`. There is exactly one crossing, `faceKeyForTileId()`, ten lines, one-way, takes a plain `number`. | A face key travelling *back* toward a tile id, which is the first step to one travelling into the log. There is no inverse and there must never be one. |
| **Cosmetics are data, never code.** A procedural tile set carries a `generatorId`, not a function. | A cosmetic that ships behaviour. Behaviour is the thing that must not vary by cosmetic. |
| **Timing is multipliers, clamped — never durations.** `HandTiming.speed` scales the budgets in `RENDERING.md` §5; `normalizeTiming()` clamps it to [0.5, 2.0] on the way into the registry. | A cosmetic lengthening a claim window. `RENDERING.md` §4 rule 1 says animation never gates input; a cosmetic naming its own milliseconds would be the way around it. |
| **Closed unions.** `EasingName`, `PlayerStatKey`, `UnlockRule`, `ReactionBeat`. | An open `cubic-bezier(…)` string that stalls for eight seconds; an unlock condition added without a code review. |
| **Exhaustive records.** `Record<TileArtKey, …>` is 43 keys; `Record<ReactionBeat, …>` is 13. | A tile set that forgets 5筒. It does not compile. |
| **`AlwaysAvailable<T>` on the defaults.** | A retired default, or a default behind an unlock. Both are compile errors, not a black screen three months from now. |

Put one line next to every payload type that reaches the wire or the archive:

```ts
import type { IsLogSafe, StaticAssert } from "../../client/src/cosmetics/types.js";
type _CutIsClean = StaticAssert<IsLogSafe<CutPayload>>;
```

### What the type system does *not* catch — and the grep that does

`IsLogSafe` catches `tileSetId: TileSetId`. It does **not** catch someone typing the same
field `tileSetId: string`. Nothing in TypeScript can. So the enforceable rule is a
directory rule, and it belongs in CI:

```bash
# 1. nothing outside the client may know cosmetics exist
! grep -rn "cosmetics/" engine protocol rulesets worker tools --include='*.ts'

# 2. cosmetics may not know the game exists  (imports only; prose may name them)
! grep -rnE "from \"@mjrc/" client/src/cosmetics --include='*.ts'
```

Both are currently true. Keeping them true is cheaper than any review.

## 5. No gacha, on purpose

`DESIGN.md` §1 lists "gacha/loot mechanics, real-money anything" under **Not building**,
and calls it a positioning leg rather than a scope cut. `PAGE-INVENTORY.md` §2 cuts the
mail/rewards screen for being that economy's plumbing.

**Cosmetics themselves were never the problem.** Super Smash Bros is the reference: a
roster with personality, unlocked by playing. Riichi City and Mahjong Soul are the
anti-reference — that lane is taken and unwanted.

So `UnlockRule` has four leaves and every one of them is a comparison against a fact the
player produced by playing:

```ts
{ kind: "open" }
{ kind: "stat", stat: "matchesFinished", atLeast: 25 }
{ kind: "grant", grant: "alpha-playtester" }
{ kind: "all" | "any", of: [ … ] }
```

Deliberately absent, and this is the point of the type rather than an oversight:

| Absent | Why |
|---|---|
| `chance`, `weight`, `odds`, `pity` | No randomness anywhere. `evaluateUnlock` takes no seed, no clock, no RNG — and the module imports nothing, so there is nowhere for one to come from. |
| `price`, `currency`, `cost` | Nothing is bought. |
| `pull`, `roll`, `box`, `crate` | There is no container to open. |
| `expiresAt`, `availableUntil` | No manufactured scarcity. |
| `bundle`, `duplicateCompensation` | No economy to compensate within. |

The property that falls out: **a player can always be told what to do to get a thing, in
one sentence.** If a proposed unlock cannot be stated that way, it does not belong here.

`evaluateUnlock` is advisory. The **server** decides what a player may equip; this exists
so a collection screen can draw a progress bar without a round trip. Two guards worth
knowing: `any: []` is `false` (fail closed — an accidentally-empty rule must not unlock
what it was meant to gate) and nesting past `UNLOCK_MAX_DEPTH` returns `unreadable`.

## 6. Slots and scope

| Slot | Scope | Who chooses | Who sees it |
|---|---|---|---|
| `tileSet` | `viewer` | you | you only |
| `tableSurface` | `viewer` | you | you only |
| `avatar` | `seat` | the seat's owner | the whole table |
| `handModel` | `seat` | the seat's owner (defaults to the avatar's) | the whole table |
| reaction set | follows the avatar | — | the whole table |

Viewer-scoped means four players can be looking at four different tile sets in the same
match and neither the rules, the protocol, nor the log notices. That is only safe because
of the rule at the top of this file, and it is a nice demonstration of it: if the tile set
were in the log, "which set was this hand played in" would be an unanswerable question.

`SceneCosmetics.seats` is indexed by **absolute** seat, 0 東 … 3 北, matching the log.
Rotating so the local player sits at the bottom is the scene's job.

## 7. Degradation and retirement

`resolve()` is **total**: any input — `null`, a partial loadout, ids from a season that no
longer exists — returns a fully-populated `ResolvedLoadout`. It never throws and never
returns a partial. What degraded is reported in `fallbacks` (worth a telemetry counter,
never a modal).

- **Retired** — withdrawn from the picker, still resolves for anyone who has it equipped.
  Nobody's table changes appearance overnight.
- **Deleted** — falls back to the default and is reported.
- **Locked** — falls back only when `resolve()` is given a `PlayerRecord`. A replay should
  omit it: the point of a replay is to reproduce the table as it was, and the server
  already validated the equip at the time.

`defaultScene()` covers every no-cosmetic case: a hand logged before cosmetics existed, a
shared replay opened by a stranger, a bot table, a screenshot harness. Because the log
carries no cosmetic ids, that is not a degraded rendering — it is the correct one.

## 8. Checklist — adding a cosmetic without breaking replay

1. **Add it to `registry.ts` only.** If your change touches a file outside
   `client/src/`, stop; you are about to break the rule.
2. **Give it an `UnlockRule` you can state in one sentence.** "Finish 25 matches." If you
   cannot, the cosmetic is not ready.
3. **Fill every exhaustive record.** 43 tile art keys, 6 hand poses, 13 reaction beats.
   The compiler will tell you; do not reach for `as`.
4. **Timing goes in as multipliers.** If you find yourself wanting to write a number of
   milliseconds, the thing you want is a change to `RENDERING.md` §5, not a cosmetic.
5. **Run the two greps in §4.** They are the only enforcement that catches a determined
   mistake.
6. **Ask what happens when this is retired in three years.** The answer must be "the
   registry falls back and replays are unaffected". If the answer involves the log, the
   design is wrong.
7. **Do not add it to the log to "measure adoption".** Equipped loadouts live in platform
   storage (D1), where that question is a `SELECT`. It is not a property of a hand.
8. **`npm run typecheck && npm run test`.** `client/test/cosmetics.test.ts` checks the
   three promises this module makes: `resolve()` is total, a missing cosmetic degrades,
   unlocks are deterministic.

## 9. Naming note

The brief calls an avatar's face set its "expression voice". It is named `ReactionSet`
here because `client/src/expressions/` already owns "expression" for 枱面話 table talk —
lines a player *chooses* to send. This is the opposite: faces the avatar pulls on its own,
that nobody selected. Two meanings of one word in one client would cost more than the
rename does.

## 10. Open decisions

1. **Flower art order.** `engine/src/types.ts` names tiles 34-37 梅蘭菊竹 (id 36 = 菊),
   but `mjrc-app/.../render.ts` draws id 36 as 竹 and id 37 as 菊, labelled 3 and 4
   respectively. One of them is wrong. `TILE_FACE_ORDER` here follows the **engine**,
   since the engine owns ids. Fixing it is a one-line art change; leaving it means the
   tile the log calls 菊 is drawn as 竹 forever. **Needs a decision from whoever owns the
   tile art.** This mismatch is exactly the class of bug the face-key layer surfaces —
   before it, nothing compared the two orderings.
2. **Two `UnlockRule` types now exist in `client/src/`.** This one is *evaluable*
   (`stat` / `grant` / `all` / `any` against a `PlayerRecord`);
   `expressions/catalogue.ts` has a *descriptive* one (`starter` / `milestone` with a
   `describe` string). Neither is wrong, and neither imports the other, so nothing is
   broken today. The clean merge is for `milestone` to become sugar over `stat` plus a
   display string. Someone should own that before a third one appears.
3. **Which face does a sent table-talk line pull?** Probably a `ReactionSet` hook keyed by
   expression id. Decide with whoever owns `EXPRESSIONS.md` before either side hard-codes
   an answer.
4. **Tile thickness.** `DEFAULT_TILE_SET.source.geometry.thickness` is a placeholder.
   `RENDERING.md` §9.3 says fix the camera elevation (~28-32°) first, because the side
   face bakes against it.
5. **Where seat cosmetics are actually delivered.** This module assumes the lobby hands
   them over at join, in `SceneOpts`. P0 has device tokens and no profile store
   (`DESIGN.md` §5.4), so at P0 every seat may simply be the default. Worth confirming
   rather than discovering.
6. **`PlayerStatKey` is closed and currently guesses.** Every entry is derivable from the
   log by folding, but nobody has written the fold. Before the first stat-gated cosmetic
   ships, someone should confirm the platform can actually produce each number.

# MJRC Game — personality & cosmetics

**Status:** proposal, 2026-08-26. Sits under `DESIGN.md` — §1 (positioning), §5 (architecture),
§7 (teaching) constrain everything here. Renderer mechanics live in `sketches/RENDERING.md`;
this document is about *what* gets rendered and *who owns it*. Terminology per `TERMINOLOGY.md`.

**One line:** a large, characterful, funny Hong Kong cast — avatars, hands, tile sets — earned
by playing, never rolled for, and structurally incapable of touching the engine.

---

## 0. Two rules, stated before anything else

Everything below is downstream of these. If a later proposal conflicts with either, the
proposal is wrong.

### Rule 1 — cosmetics are not gacha; randomised paid pulls are

`DESIGN.md` §1 lists "gacha/loot mechanics, real-money anything (gambling adjacency — hard no)"
under **Not building**. That is a positioning leg, not a scope cut. It has been read, more than
once, as "no cosmetics." That reading is wrong and it is worth killing in writing:

> **Super Smash Bros has one of the largest character rosters in games and no gacha.
> Every character is unlocked by playing. That is the model.**
> The thing §1 rules out is the *randomised paid pull* — the mechanic where money buys a
> probability distribution. A named cosmetic with a published, achievable unlock condition is
> the opposite of that mechanic, and it is one of the ways this product signals it is not
> Amatsuki, Riichi City, or Mahjong Soul.

The failure mode this section exists to prevent is somebody eighteen months from now saying
"it's only a small gacha, just for cosmetics, everyone does it." There is no small version.
The moment a paid random pull ships, the anti-gacha leg is gone, it cannot be walked back, and
the product is competing head-on in the lane §1 explicitly conceded to a funded studio. In a
*mahjong* product, where the entire legal and reputational posture is skill-framing
(§9, "chips are points; no cash-in/out, no wagering language"), shipping a paid loot box is
also the single worst-chosen risk available.

### Rule 2 — cosmetics never touch the engine, the protocol, or the log

`DESIGN.md` §5: the engine is a pure reducer; the client is **disposable by design**. Cosmetics
are purely a rendering concern.

> The event log records **"tile 18 was discarded from seat 2"**. It never records
> *"tile 18 in the Bone set was discarded by the Grand-Aunt with the jade-bangle hands."*

Two consequences, both permanent:

1. **The research corpus stays clean.** §1's third differentiation leg is a theory pipeline over
   logged hands. A corpus carrying cosmetic strings is a corpus that has to be scrubbed before
   every analysis, forever, and the scrub will be imperfect.
2. **Replay survives retirement.** A cosmetic will eventually be retired, renamed, or redrawn.
   If the log names it, every hand played with it either breaks or pins a dead asset. Because
   the log names nothing, replay of a 2027 hand in 2031 renders in whatever the viewer has —
   correctly, because §5.5 pins `engineVersion`, which is what actually determines the *game*.

**Cosmetic fidelity in replay is explicitly not a goal. Tile-identity fidelity is.** A replay
must show that seat 2 discarded 3-circles. It has no obligation to show which tile skin was
switched on that night.

The mechanism that enforces both rules is in §6. It is a test, not a convention.

---

## 1. Avatars — what the cast is actually about

### The lane

Amatsuki, Riichi City and Mahjong Soul are anime gacha products with anime gacha casts. That is
correct for them — it is a Japanese game with a Japanese visual tradition and an audience that
wants it. It is unavailable to us and undesirable: it is a crowded, expensive, well-defended
lane, and competing in it means losing on art budget to studios that have one.

The HK equivalent is not solemn heritage either. A mahjong parlour is loud, gossipy, slightly
rude, and extremely funny. Nobody has ever made that the cast of a mahjong game. The tone brief
— *"I don't want to take this too seriously"* — points at exactly this material.

### Direction A — 麻雀館 The Parlour (people you actually meet)

Illustrated human characters, warm-line 2D, mid-century HK poster palette. Not caricature to
the point of cruelty; affectionate, the way a family talks about its own.

| Character | Read | The joke |
|---|---|---|
| **姑婆** *gu po* — the Grand-Aunt | Cardigan, jade bangle, permanent opinion | Has already decided your discard was wrong |
| **阿叔** *a suk* — the Taxi Uncle | Gold watch, polo shirt, engine still running outside | Plays like the meter is on |
| **師奶** *si naai* — the Housewife on a break | Grocery bags parked under the chair | Will leave at 5:40 whatever the score |
| **阿姐** *a ze* — the Parlour Manager | Seen everything, counts everything | Never wrong about how many are left |
| **學生哥** *hok saang go* — the Kid | Learned online, plays too tight, calls nothing | Knows the theory, fears the table |

### Direction B — 三腳貓 The Menagerie (a Hong Kong bestiary)

Animals with HK city character rather than generic cute animals.

| Character | Read |
|---|---|
| **三腳貓** the three-legged cat | The idiom for a dabbler. The beginner's avatar, and a joke on itself |
| **馬騮** the Kam Shan macaque | Steals your flower tile. Fast, unbothered |
| **水牛** the Lantau buffalo | Immovable. Wins by outlasting everyone |
| **白鴿** the pigeon | Sits on the wall. Judges. Contributes nothing |
| **錦鯉** the koi | The lucky one. Always wins from behind, undeservedly |

### Direction C — 茶餐廳 Cha Chaan Teng (food and street objects)

| Character | Read |
|---|---|
| **蛋撻** egg tart | Warm, popular, slightly flaky |
| **菠蘿包** pineapple bun | No pineapple. Deceptive |
| **凍檸茶** iced lemon tea | The mangled lemon is the face |
| **紅Van** the red minibus | Destination sign is the expression. Goes too fast |
| **竹棚** bamboo scaffolding | Improbably load-bearing |

### Recommendation: **Direction A**, with B and C as later novelty tiers

The deciding argument is not taste. It is §2.

**Hand models require hands.** A pineapple bun does not have hands; a pigeon does not have a
wrist to hang a jade bangle on. The hand model is the strongest and most defensible idea in the
whole brief — no competitor renders hands at all — and it only works if the avatar and the
hands are the *same character*. Picking B or C as the core cast forces the presentation into two
unrelated systems: a food mascot up in the seat badge and an anonymous generic hand doing the
throwing. That is worse than either alone.

So: **humans first, because the hand model decides it.**

B and C survive as a deliberately rare later tier where the paw / claw / wing *is* the joke — a
macaque hand snatching a discard is funny precisely because the other fifteen hands are real
ones. That tier lands after the human cast is complete, and it stays small.

**Launch size:** 5-6 characters, all available immediately, none locked. A new player must never
meet a locked roster on their first screen — that is a gacha reflex, and it reads as one.
Growth is 2-4 characters a year, each with hands and a voice pack.

---

## 2. Hand models — the idea worth the most

### Why this is the differentiator

In Hong Kong mahjong you watch people's hands. The tiles are the same for everyone; the hands
are not. You learn who at the table is impatient from the drum of their fingers, who is close
from the way they stopped fidgeting, who is bluffing from a toss that was a little too casual.
Riichi's automatic tables and tidy rows deliberately erase most of that. HK never did.

No mahjong product renders hands. Mahjong Soul discards a tile by translating a sprite. That is
the whole animation. `RENDERING.md` §5 already identifies the toss as *"the single most
recognisable motion in Hong Kong mahjong."* A hand attached to it is the difference between a
recognisable motion and a recognisable **person**.

### A hand model is appearance plus motion, and motion is the bigger half

Static appearance (what the illustrator draws):

| Channel | Range |
|---|---|
| Skin | Tone, and the surface read — smooth, weathered, sun-marked |
| Age | Knuckle prominence, tendon definition, vein visibility, thinning skin |
| Nails | Length, shape, polish colour, chipped vs fresh, none |
| Jewellery | **Jade bangle** (the loudest HK signifier there is — it *clacks against the tiles*), gold rings, red string, plain band |
| Wrist | Casio, dive watch, dress watch, fitness band, bare, tan line where a watch usually is |
| Sleeve | Rolled shirt cuff, cardigan, tracksuit, bare arm, uniform cuff, sleeve pushed to the elbow |

Motion profile (what the renderer parameterises) — this is where personality actually lives:

```ts
interface HandMotion {
  tossVelocity: number;      // slow placement → hard throw
  arcHeight: number;         // slid across the felt vs lobbed
  tumble: number;            // does the tile turn over in the air
  landingBias: number;       // near the thrower vs deep into the pile
  grip: "pinch" | "palm" | "slide" | "flick";
  idleTic: "fingerDrum" | "bangleAdjust" | "squareUp" | "still";
  claimSnatch: number;       // how fast the hand comes in on a claim
  revealStyle: "sweep" | "flip" | "layDown";  // the win ceremony
}
```

Five characters × those channels reads as five distinct people without a face on screen. The
Grand-Aunt places tiles precisely and adjusts her bangle between turns. The Taxi Uncle throws
hard and deep and drums his fingers the whole time. The Kid squares up his hand between every
draw. None of that needs a single frame of facial animation.

### The three constraints that keep this honest

**1. Motion must be a pure function of `(event, model, seed)` — never of hidden state.**

This is a real leak risk, not a theoretical one. If the "deliberate" model's toss takes 600ms
and the "impatient" one takes 90ms, fine — that is a property of the model, published, constant,
and known to everyone. But if the *animation duration ever varies with what the player actually
holds*, the cosmetic has become a tell, and a cosmetic that leaks state is a cheat. Same
seeding discipline `RENDERING.md` §4a already applies to pile scatter: derive from the event
index, so it is deterministic across replays and independent of the hand.

Note this does not add information the stream lacks. Real decision timing is already in the
event timestamps; §5.2's fixed minimum claim window is what protects claim-holding, and it is
server-side. Hand motion is presentation over an already-committed event.

**2. `RENDERING.md` §4 rule 1 applies unchanged: animation never gates input.**

A slow hand model must never make its owner slower, and must never delay anyone else's call
buttons. Your own toss animates *after* your request commits. Opponents' call buttons appear on
the event, with the hand still swinging underneath them.

**3. Your own hands are visible for the toss, not for the hold.**

A hand hovering over your own 13 tiles occludes the one thing you must be able to read. Your
hand enters from the bottom edge for a discard, a claim, and the reveal, then leaves. Opponents'
hands come in from their edges and may idle, because their tiles are backs anyway.

### Where hands pay off most

- **The toss.** The signature motion. Every character does it differently.
- **The claim snatch.** Three hands reaching for the same discard and one getting there first is
  the most viscerally *mahjong* thing that can happen on a screen, and priority resolution
  (§5.2) already gives the renderer exactly the data to stage it.
- **The reveal.** A win is currently a scoreboard. It should be a pair of hands sweeping the
  wall of tiles over. `RENDERING.md` budgets 1.6-2.2s for it, skippable.
- **Idle.** The cheapest personality per byte in the entire product.

### Accessibility and the viewer's veto

Under `prefers-reduced-motion`, all motion profiles collapse to one neutral profile at the same
timings. Independently, a **"hide hands"** setting must exist for players who find them
distracting — and the viewer's setting always beats the other player's choice. See §5.3; this
is a general rule, not a hands-only concession.

**Cost, marked as an estimate:** this is the expensive one. ~5 hands × ~6 poses × motion tuning
is on the order of **3-5 FT weeks of art plus 1-2 weeks of renderer work**, and it is Phase-2
(`PixiScene`) work — DOM CSS 3D will not carry a convincing toss. Not P0. See §8.

---

## 3. Tile art — the skin system

### What ships today, accurately

`mjrc-app/web/src/features/tiles/render.ts` (483 lines) produces all 42 faces plus a back as
procedural SVG. It is one **baked** skin, not a skin system:

- `PAL` is a module-level `const`, referenced 17 times inside the art functions.
- `RULES` (layout engine), `GLYPH` (font, weight, stretch), `CANE_C2`, the circle-pip primitives
  and the corner radius are likewise module constants.
- The primitive-lab's `SELECT` vocabulary (`pip1` / `pip2` / `pipN` / `cane` slots) survives only
  as a header comment — the alternates were not carried into `render.ts`. The *concept* of a
  skin exists in the lab; the *mechanism* does not exist in code.

### The unresolved tension, stated precisely

The brief describes this as guide-vs-shipped. It is sharper than that, and it is a decision
someone has to make rather than a drift to fix:

| Source | Says |
|---|---|
| `DESIGN.md` §1, leg 1 | Differentiation is *"the vintage bone-set art direction — ivory faces, indigo ink, floral rosettes. Amatsuki took the anime lane; nobody owns this one."* |
| `style_guide.txt` §3 | **Palette D "HK Bright Primary" — marked ACTIVE.** Near-white face, royal blue, primary green, primary red |
| `style_guide.txt` §4 decisions log | *"OVERALL DIRECTION: classical commercial set. Vintage bone set is reference only, not the target."* Circles: *"DECIDED — concentric circles (geometric), NOT floral."* Corner radius: *"DECIDED — modern/moderate (~7%), not vintage pillowed"* |
| `render.ts:20` | `PAL = { face:#FAFAF8, border:#CCCCCC, blue:#1845A5, green:#1A8B3A, red:#D42222 }` — Palette D, shipped |

So the art track did not drift from the guide. **The art track's own decisions log deliberately
chose against the direction `DESIGN.md` §1 names as a positioning leg**, and shipped that
choice. One of the two documents is currently wrong about what this product looks like.

**Three ways out:**

| | Option | Consequence |
|---|---|---|
| a | **Keep Palette D as the default skin; build the heritage bone set as the flagship craft skin** | No repaint, no legibility risk on the default, and leg 1 gets delivered by the skin system instead of by a palette. **Recommended.** |
| b | Repaint the default to Palette B (Vintage Warmth) | Takes a legibility risk on every player's default screen for an aesthetic most HK players did not ask for. Ivory-on-indigo at 44px is genuinely harder to read than blue-on-white |
| c | Drop the heritage leg from `DESIGN.md` §1 | Honest, but it removes one of three stated differentiators and leaves leg 1 as "clean UI," which is not defensible |

Option (a) also fixes something (b) and (c) both miss: **leg 1 was never really about the tile
palette.** "Heritage craft" is carried by the table surface, the typography, the motion, the
recorded Cantonese calls and the hands — the whole presentation register — far more than by
whether a 3-circle has a rosette in it. The bone set as a flagship *earned* skin (see §4) is
also a much better story than a default nobody chose.

### What varies, and what may never

| Layer | Varies per skin? | Note |
|---|---|---|
| Face colour & material | **Yes** | Ivory, near-white, jade, lacquer, bone |
| Ink hue | **Yes** | Indigo, black, sepia |
| Corner radius / pillowing | **Yes** | 7% modern → 15% vintage |
| Pip treatment | **Yes** | Concentric vs floral rosette; uniform vs cinched canes |
| Font | **Yes** | Within a legibility floor |
| 1-bamboo bird, flowers & seasons | **Yes, widest freedom** | They carry identity only, never rank, and flowers never join melds |
| **Tile back** | **Yes, total freedom** | A back carries exactly one bit — "this is a back." Zero legibility cost. **The cheapest and best cosmetic slot; ship this one first** |
| Table surface / felt | **Yes** | |
| **Suit shape signature** | **NO** | See below |
| **Pip count** | **NO** | Three circles are always three countable circles |
| **Rank glyph system** | **NO** | Standard HK numerals. No stylisation that changes what a 4 is |

### The hard rule

> **A tile must be identifiable in under 200ms, at 44px wide, by a player who has never seen
> that skin before. Any skin that fails this does not ship, however beautiful it is.**

There is a specific reason to be strict, and it is measurable in the shipped palette rather than
theoretical. **Colour is not currently a suit channel.** Characters are a blue numeral with a red
萬; circles are a green band with blue beads; bamboo is green and red canes. Green appears in both
circles and bamboo; blue appears in both circles and characters. **Suit separation is carried by
shape, not colour.** That inverts the usual intuition about skinning: recolouring is the *safe*
axis, and any skin that touches pip geometry — exactly what the heritage rosette direction does —
is the dangerous one and needs the test below.

**Proposed gate, cheap because the atlas pipeline already exists** (`RENDERING.md` §3):

1. *Mechanical.* At atlas build time, rasterize all 42 faces of the skin at the smallest shipped
   size and pixel-diff every pair. Any pair below a distance threshold fails the build. Catches
   the "5-circles and 6-circles are now the same blob" class outright.
2. *Human.* A 42-card timed flashcard drill against someone who has not seen the skin.
   Target ≥99% correct, no pair above 2% confusion.

### The refactor that makes skins possible

Small and specific. Turn the baked constants into a `Skin` record threaded through the art
functions, defaulting to today's values so nothing renders differently on day one:

```ts
interface Skin {
  id: string;              // "hk-bright" (default) | "bone" | …
  palette: Palette;        // today's PAL
  radius: number;          // corner fillet as % of width
  glyph: GlyphSpec;        // font, weight, stretch
  pips: PipPrimitives;     // the lab's pip1 / pip2 / pipN slots
  cane: CanePrimitive;     // the lab's cane slot
}
tileArt(id, { skin });
```

Per `RENDERING.md` §3, this is a **build-time input, not a renderer concern** — the atlas builder
runs `render.ts` once per skin and the runtime never parses SVG. Keeping it build-time is what
stops a skin from becoming a per-frame cost.

**Cost, estimated:** the refactor is ~2-3 days. A recolour-only skin is ~0.5 wk thereafter. The
heritage bone skin is more — rosettes, cinched canes, the naturalistic bird, eight watercolour
flowers — call it **2-3 FT weeks**, and it is the same brief `DESIGN.md` §3 already writes for
the flower/season art.

---

## 4. Unlock model

### The property, in one sentence

> **You can always see everything in the catalogue, you always know exactly what it costs, and
> the cost is never a dice roll.**

Every locked item is browsable from day one with its condition printed on it. That single
property is what makes this structurally not-gacha, and it is worth putting on screen literally
— an unlock list a player can read end to end is a promise a loot box cannot make.

### The ladder

| Unlock | Condition | What it grants |
|---|---|---|
| Starting cast | First launch, no condition | 5-6 avatars + their hands, all playable |
| Volume | 10 / 50 / 200 / 500 matches | One hand model or tile back each |
| First 自摸 | Win on your own draw | A hand model |
| **First 爆棚** | Your first 13-faan limit hand | The flagship item — the bone tile back, or the jade-bangle hands |
| **Pattern collection** | Each faan pattern achieved for the first time | A small marker per pattern; the full set unlocks a tile skin |
| Room membership | Join a room | That room's tile back / badge |
| Seasonal placement (P1) | Ladder finish | A marker only, never a full skin |
| Consolation | Four exhaustive draws 流局 in one match; three deal-ins in a row | Something small and self-deprecating — the three-legged cat, the pigeon |

**The pattern collection is the best item on this list and it is not primarily a cosmetic.**
平糊 · 對對糊 · 混一色 · 清一色 · 小三元 · 大三元 · 字一色 · 十三么 — the unlock screen *is* the
faan table, rendered as a checklist with an example hand on each entry. That is `DESIGN.md` §7's
teaching goal arriving through the cosmetics system at almost no extra cost, and it follows
Chiba's ordering exactly: you play first, and the theory shows up as a thing you already did.

**Rules on the ladder itself:**

- **Nothing is ever taken away.** Leave a room, keep the back. Season ends, keep the marker.
  Removal-based scarcity is FOMO plumbing and it is the same instinct as the loot box.
- **Nothing is timed out of the catalogue.** Seasonal items may stop being *newly* earnable in
  that form, but the catalogue does not shrink.
- **No currency.** No coins, no dupes-to-shards conversion, no "mail / rewards" screen —
  `PAGE-INVENTORY.md` §2 already marks that screen **No**, and it is right: mail-and-rewards is
  the gacha economy's plumbing arriving before the gacha does.
- **No randomness anywhere**, including "free" randomness. A daily spin with no purchase attached
  still trains the pull reflex and still reads, correctly, as a gacha product's first move.

### If monetisation is ever wanted

The only door that does not break §1:

> **Direct purchase of a specific, named cosmetic at a published price** — and/or a subscription
> that buys zero cosmetic and zero competitive advantage (private-table features, extended
> replay retention, analysis history depth).

Why that is the only door:

1. **It is the one transaction with no probability in it.** You see the item, you see the price,
   you get that item. Nothing about it is a wager, which matters more here than in any other
   genre: this is a *mahjong* product, mahjong already carries a gambling association, and §9's
   entire posture — "chips are points; no cash-in/out, no wagering language" — is a
   skill-framing defence. A paid random pull in a mahjong game is a regulator's example.
2. **Loot-box regulation is already live** in multiple jurisdictions and trending one way. Any
   design whose legality depends on the next five years going the other way is a bad design.
3. **It preserves the earned tier's meaning.** Which requires one more rule:

> **Purchased items and earned items must be visibly different categories, and no item is ever
> both.** The 爆棚 back is not for sale, at any price. The moment achievement markers become
> purchasable, every achievement marker stops signalling anything, and the unlock ladder — the
> actual retention mechanism — is dead.

Rank and skill markers are **earned only**, permanently, no exceptions.

---

## 5. The constant — what is never cosmetic

### 5.1 Tile identity

Per §3: the pip count, the shape signature that separates the three suits, and the rank glyph
system are fixed across every skin, and every skin passes the legibility gate before it ships.
A player must never have to learn a second tile alphabet to play against someone's new skin.

### 5.2 The information on screen

No skin, avatar, hand or effect may hide, restyle away, obscure, or animate over:

- the wall count and the depleting wall (`PAGE-INVENTORY.md` §6 — wall count drives push/fold in
  HK more than in Riichi)
- **the discard pile's completeness and countability.** `RENDERING.md` §4a's non-overlap
  guarantee is geometric and load-bearing: counting discards is a core skill and a pile you
  cannot count is worse than useless. No skin trades that away for a prettier pile.
- meld rotation showing the claimed tile's source seat
- the current faan display and the 3-faan floor warning
- timers, deadlines, and the claim countdown ring
- seat winds, round wind, dealer marker, scores
- the `refusedWin` teaching moment (§5.2 — it is visible on purpose)

### 5.3 Anything that could confer advantage

No cosmetic changes a timing window, a tap target, information density, or how much anyone can
see. And the asymmetry rule that makes the whole system safe:

> **A cosmetic may only affect what its owner shows. The viewer may always override it locally.**

A skin that makes *your own* tiles easier for you to read is fine — it is your screen, and a
high-contrast set for low-vision players is a feature, not a cheat. A skin that makes *your
opponents* harder to read is not, because you chose it and they are stuck with it. Every
cosmetic another player has chosen is therefore locally overridable: force default tiles, force
default hands, hide hands entirely, disable motion. This one rule simultaneously handles
competitive fairness, accessibility, and the distraction/harassment vector that
`PAGE-INVENTORY.md` §4 currently defers to P1 moderation.

### 5.4 The engine, the reducer, the protocol, and the log

Rule 2 restated because it belongs on this list. No cosmetic identifier appears in `engine/`, in
`protocol/`, in any event, or in any archived log. See §6 for how that is enforced.

### 5.5 No free text on cosmetic surfaces

A tile back is art from a catalogue, never a user-uploaded image or arbitrary string. Display
names are already the moderation surface; do not add a second one before there is any moderation
tooling at all.

---

## 6. Where cosmetics actually live — and the firewall

### The seam

Today `protocol/src/messages.ts` carries `SeatDirectoryEntry { seat, playerId, displayName, bot,
connected }` and `events.ts` carries `PlayerRef { playerId, displayName, seat, bot }`. Both are
correctly cosmetic-free. The question is where the client learns that seat 2 is the Grand-Aunt.

| | Option | Verdict |
|---|---|---|
| A | Add a `cosmetics` field to `SeatDirectoryEntry` | **No.** `PROTOCOL_VERSION` is a compatibility contract for game semantics. A new hand model must never be able to bump it. It also puts a cosmetic string one careless `JSON.stringify` away from the archive |
| B | **Separate HTTP profile lookup, resolved client-side** | **Yes.** `GET /profiles?ids=…` off §5.4's platform services, returning `{ playerId, avatarId, handId, tileSkinId, backId }` |

Option B costs one HTTP round trip, taken during the window `RENDERING.md` §6 already reserves
for atlas preload at match start. In exchange the protocol stays cosmetic-free permanently, the
cosmetic catalogue versions independently of the game, and unknown ids fall back to the house
default — which is exactly the behaviour needed when a cosmetic is retired or when an old replay
is opened years later.

The renderer resolves cosmetics at **render time from the current profile**, never from anything
recorded with the hand. Per Rule 2, that is a feature.

### The firewall — a test, not a convention

`TERMINOLOGY.md` is enforced by discipline. The redaction contract is enforced by
`protocol/test/events.test.ts`, whose header says plainly that it *"exists to keep that from
happening again."* The cosmetics rule deserves the same treatment and is cheaper to enforce:

```
protocol/test/cosmetics-firewall.test.ts
  - scan engine/src/** and protocol/src/**
  - fail on: avatar, cosmetic, skin, tileSet, handModel, palette, theme, voicePack
  - fail on any Skin/Avatar/Cosmetic type reachable from GameEvent or ServerToSeat
```

An afternoon's work. It converts "we all agreed not to" into a red CI run, which is the only form
of agreement that survives a new contributor in 2029. Do it **before** the first cosmetic ships,
because after that the test is a refactor instead of a guard.

---

## 7. Craft vs. "don't take it too seriously"

These pull against each other and both are real. `DESIGN.md` §1 stakes a differentiation leg on
a heritage-craft aesthetic; the owner's brief says don't be po-faced. A product that resolves
this badly ends up as either a museum nobody plays in or a joke nobody trusts with their rating.

**The resolution is register, split by what the thing is.**

| Layer | Register | Why |
|---|---|---|
| Tiles, table, wall, typography, the faan display, the review screens | **Dead serious.** This is the instrument | These are the things a strong player judges the product by in the first thirty seconds. A joke here reads as amateurism, and §1's credibility legs are the whole product |
| Avatars, hands, idle tics, unlock names, win lines, voice packs, the copy | **Warm and funny.** This is the company | These are the things that make someone come back to a room, and they cost the serious layer nothing |

Said as a rule you can apply without thinking:

> **The joke lives in the character, never in the information.**
> A pineapple-bun avatar is funny. A pineapple-bun 3-circles is a bug.

This is precisely what the Smash Bros reference actually does, and it is why the reference is a
good one beyond the roster: the characters and stages are absurd, and the frame data is
merciless. Nobody experiences that as a contradiction. The absurdity is entirely in *who is
playing*; the game underneath is exact.

Two supporting moves:

- **Heritage is craft, not solemnity.** The vintage bone set is warm, hand-carved, irregular, and
  the flowers are little watercolour paintings of plum blossoms and people in landscapes.
  Somebody *enjoyed themselves* making it. Rendering that faithfully is not the museum failure
  mode — the museum failure mode is *writing about* it in a reverent tone. Ship the object, skip
  the wall text.
- **Humour is HK-specific or it is nothing.** Generic jokes are worse than none. 三腳貓 as the
  beginner avatar, the Taxi Uncle with the engine running, the Grand-Aunt already disappointed in
  your discard — these land with the audience §1 targets and are invisible to everyone else,
  which is the correct trade.

---

## 8. Phasing and cost

**None of this is P0**, and a personality plan that pretends otherwise is the thing that eats a
P0. `DESIGN.md` §3 prices P0 at 9-12 FT weeks and has already cut the in-app Learn tab, profile
dashboards, and live spectating. Cosmetics do not jump that queue.

**Three things belong in P0 anyway, because they are cheap now and expensive later:**

| Item | Cost | Why now |
|---|---|---|
| The cosmetic-resolution seam (§6, option B) — decide it, don't build it | ~0 | Same argument as `RENDERING.md` §9's `MatchScene` interface: an interface decision, free today, a refactor later |
| The firewall test (§6) | ~1 day | A guard before the first cosmetic exists; a migration after |
| **Tile backs as a skin slot** | ~1 day | `tileBack()` is already one function, a back has zero legibility cost, and it gives the unlock ladder something real to hand out from day one |

**Everything after the P0 gate**, in dependency order:

| Phase | Item | Estimate |
|---|---|---|
| 1 | `Skin` refactor in `render.ts` + per-skin atlas build + legibility gate | 2-3 days |
| 2 | Heritage bone skin (rosettes, cinched canes, bird, 8 watercolour flowers) | 2-3 FT wk |
| 3 | Avatar cast — 5-6 illustrated characters, 2D, commissioned | 1-2 FT wk of coordination; the illustration is not in-house |
| 4 | Unlock ladder + catalogue screen (doubles as the pattern-collection teaching screen) | 1 FT wk |
| 5 | **Hand models** — needs `PixiScene` first | 3-5 FT wk art + 1-2 FT wk renderer |
| 6 | Per-character voice packs over the Cantonese call audio §1 already scopes | incremental |

All estimates. Item 5 is the one worth the money and the one to resist starting early — it is
gated on the Phase-2 renderer, and a hand model in CSS 3D would land as a worse version of the
best idea here.

---

## 9. Open decisions

Marked open because they are the owner's, not this document's.

1. **Which cast direction.** Recommendation is A (The Parlour); the deciding argument is that
   hand models need hands, so B and C cannot be the core cast without splitting the presentation.
2. **The §3 tension — heritage vs shipped.** Recommendation is (a): keep Palette D as the
   default, build the bone set as the flagship earned skin, and let leg 1 be carried by the whole
   presentation register. This needs a decision recorded in *both* `DESIGN.md` §1 and
   `style_guide.txt` §4, because they currently disagree.
3. **Whether purchase ever happens at all.** §4 says which door is the only safe one; it does not
   say the door has to be opened. Not opening it is a defensible position and a cheap one at
   alpha scale.
4. **Launch roster size** — 5-6 proposed. More characters is more art budget with no engineering
   cost, so this is purely a money question.
5. **Whether hand models are P1 or Phase-2.** They are priced as Phase-2 here on the renderer
   dependency. If they are judged to be the marketing artefact — and there is a real argument
   that they are, since no competitor has one — that changes the renderer's priority, not this
   document's.
6. **The unlock catalogue's placement.** It is a cosmetics screen and a teaching screen at the
   same time (§4, pattern collection). Whether it lives under Learn or under Profile affects
   whether players actually find it.

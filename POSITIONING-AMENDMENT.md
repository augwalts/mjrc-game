# Positioning amendment — 2026-08-26

Amends `DESIGN.md` §1. Written from the owner's framing, which sharpens what
this product is for and corrects a drift in what has been getting built.

---

## 1. The mission, stated properly

> "People could use more exposure to the energy of a boisterous family-style game."

That is a better mission than "the definitive HK mahjong platform." It says who
it is for and what they get. §1's long-term ambition still holds, but this is
the thing to actually build toward, and it should be the sentence anyone reads
first.

## 2. Mixed media is not a borrow — it is culturally accurate

The Super Smash Bros reference was never really about a roster. It is about
**incompatible visual registers sharing one stage**, and the collision being the
point.

The deeper justification: **Hong Kong is itself a hybrid culture, East meeting
West.** Cha chaan teng. Neon over calligraphy. Colonial signage above a wet
market. A city that never resolved into one register and is defined by not
resolving.

So mixed media is not a gimmick applied to HK mahjong. It is the most honest
possible rendering of it. A scanned bone set beside flat vector beside woodblock
ink beside a photograph *is* what Hong Kong looks like.

This also resolves a tension flagged earlier in `sketches/RENDERING.md`: the
heritage bone-set art direction and "don't take it too seriously" seemed to pull
against each other. They do not. **Heritage is one register among several, not
the house style.** The vintage set sits next to something plastic and modern
because that is what a real table looks like.

## 3. Environments are a register too

The LA scene the owner actually plays in: **parking lot games, beach games,
fancy vibes games.** These are not one setting with skins — they are different
worlds:

- a folding table in a parking lot, harsh daylight, plastic tiles, a cooler
- a beach game, sand, towels, a portable set, glare
- the fancy table, rosewood, felt, good light, a proper set
- the family table at home, crowded, food alongside, mismatched chairs

Each is a distinct visual register, so **table surface and environment become a
cosmetic axis alongside tiles, hands and avatars** — and the same mixed-media
logic applies. This is a stronger and more specific idea than "different felt
colours".

## 3b. Craft as a subject, not a style

> "Mahjong has roots in ivory blocks, hand carvers, etc. It's a lost part of the
> game. I want to emphasize art, art culture, and craft in the visuals."
> "Eventually we will have lots of custom skins, references to various
> historical art movements."

This is the strongest idea in the brief and it upgrades §1's "craft aesthetic"
leg from a *look* into a *subject*.

**The history is real and genuinely lost.** Tiles were hand-carved — bone
laminated to bamboo, the faces cut and inked by craftsmen who did nothing else.
Regional carving styles were as recognisable as handwriting. Almost nobody
playing today knows this, and no digital mahjong product has ever bothered to
tell them. That is an open lane that costs nothing to occupy and that the anime
gacha products structurally cannot follow us into.

### The tile is a tiny canvas

Forty-two faces, each with a fixed, non-negotiable meaning, reinterpreted by
hand for two centuries. That is close to an ideal constraint for artists — the
semantics are locked, so everything else is free.

**The precedent to study is custom playing-card decks**, not other games:
theory11, Art of Play, the Kickstarter deck scene. Identical problem shape — a
fixed semantic set of 52, endless artistic reinterpretation, legibility as the
binding constraint, artist-credited, directly purchased, quietly collectible.
That culture is mature and worth learning from wholesale.

### Art movements as registers

This is what makes mixed media concrete rather than vague. Each set is a real
art-historical position, not a colour swap:

- the **vintage bone set** — the actual historical root, and the baseline
- **Chinese woodblock** woodblock 木刻 muk hak — carved line, the closest cousin to the real craft
- **Shanghai calendar poster** Shanghai calendar poster 月份牌 jyut fan paai — itself literally East-meets-West, the
  same hybrid the rest of this document is about
- **blue-and-white porcelain** blue-and-white porcelain 青花 cing faa
- **Bauhaus / De Stijl** — pure geometry against the ornament of the bone set
- **Hong Kong neon** — the city's own vernacular, and a dying craft in its own
  right, which rhymes with the carvers
- **Cantonese opera** costume and face paint

The collision between any two of these on one table is the aesthetic. A Bauhaus
set facing a bone set is exactly the point.

### The constraint that makes it work

**Legibility is sacred and non-negotiable.** A Bauhaus 5-circles must still read
instantly as five circles, at speed, at a glance, to a tired player on a phone.
Playing-card designers live with this and it is why the good decks are good.
Every set ships against a legibility test — not a taste judgement — and fails if
it cannot pass. Write the test before commissioning anything.

### The business model this unlocks, which is the ethical inverse of gacha

**Commissioned artist sets, sold directly.** The artist is credited and paid;
the player sees exactly what they are buying; there is no randomness anywhere.

This is worth stating loudly because it turns §1's anti-gacha stance from a
*restriction* into a *position*: cosmetics that fund artists rather than exploit
players. It is also the only monetisation door examined so far that does not
touch the gambling-adjacency line (§9) or contradict §1, and it is entirely
consistent with a product about craft.

Each set carries provenance in-product — who made it, which movement, which era,
and where the real objects live. The cosmetic system becomes a small museum
that people play inside.

## 4. The correction that matters most: HK is not Riichi, culturally

> "It's less strategic and more 'fun' than Riichi."

**Take this as a design constraint, not a preference.** A lot of what has been
built so far leans analytical: a distance-to-ready chart, live-tile counts,
key-moment detection, observer analytics, an argument about expected chip delta
as an eval bar. All of it defensible on §1's research-credibility leg. All of it
at risk of importing the wrong culture.

Riichi's study culture exists **because Riichi rewards it.** Furiten, a deep
defensive game and a rich pattern system make optimisation pay, and Tenhou's log
corpus made it measurable. HK is swingier: a 3-faan floor, a simpler pattern
set, more luck, and a social game wrapped around it. Grafting Riichi-style
analytics onto HK risks the same category error as using Japanese terminology —
importing another game's assumptions because its tooling is more developed.

**The resolution, which does not require giving anything up:**

- The event log and the data layer remain the durable asset. §1 is right about
  that and nothing here changes it.
- But **analysis is back-of-house.** It is opt-in depth for the people who want
  it, not the product's personality and not the front door.
- **Do not lead with the eval bar.** Lead with the table.
- The teaching layer stays, because §7's terminology-first Cantonese is about
  *belonging*, not optimisation — learning to say win 食糊 sik wu is social, not strategic.

## 5. What this promotes

Features previously filed as flavour are now core, because they are how the
mission is actually delivered:

| Feature | Was | Now |
|---|---|---|
| Cantonese expressions and swearing | fun garnish | **the primary vehicle for the energy** |
| Toss styles (fling / place / slide / slam) | animation polish | **characterisation, and cheap — no new art** |
| The ritual: shuffling 洗牌 sai paai · building the walls 砌牌 cai paai · throwing the dice 擲骰 zaak sik · breaking the wall 開牌 hoi paai | loading screen | **the sound and feel people recognise** |
| Environments | felt colour | **a register axis: parking lot to rosewood** |
| Tile sets | reskin | **art-historical positions, artist-credited, direct-purchase** |
| The carving history | absent | **a subject the product is partly about** |
| Hand models | cosmetic | **who is at the table, without a face** |

And it sharpens what the competitive layer is *for*: rating and ladders exist to
give the boisterous table stakes and a reason to come back, not to turn the game
into a study exercise.

## 6. Still true, unchanged

- No gacha, no loot mechanics, no real-money anything (§1). Cosmetics unlocked
  by playing are fine; randomised paid pulls are not, and that line is a
  positioning leg rather than a scope cut.
- The anime lane is taken and unwanted.
- HK Old Style only, Cantonese terminology throughout.

## 7. SETTLED: this is not a research product

> "This game is not meant to be research first. That is a part underneath. The
> most important part is that it's fun and people play."

**§1 is amended.** Research credibility is no longer a user-facing
differentiation leg. It is infrastructure — real, valuable, and invisible.

The priority order, in full:

  1. **It is fun.**
  2. **People come back.**
  3. Everything else, including every word about corpora and theory.

### What this actually changes

**Bots stop being a risk and become THE risk.** §6 already calls them a product
blocker. Under a research-first reading you could ship mediocre bots and console
yourself that the logs still accrue. Under fun-first there is no such consolation:
in an invite-only alpha nearly every game is against bots, so **the bots ARE the
product at P0.** The prototype measures 59-63% exhaustive draws. Six hands in ten
fizzling out is not fun, and no amount of tile art fixes it. If one thing gets
the most engineering attention after correctness, it is this.

**The P0 gate (§3) is measuring partly the wrong things.** Gate 2 (data quality)
is table stakes, not a gate — of course the logs must reconstruct. Gate 4
(flywheel proof: five logged hands turned into published content) is a research
milestone wearing a product gate's clothes, and it should not be able to block
P1. Gates 1 (retention) and 3 (game texture) are the real ones, and gate 3's
metrics — draw rate, mean winning faan, call rate, deal-in rate — are exactly
the fun measurements. Re-cut the gate around those two.

**The 3-faan minimum becomes a tuning question, not just a rule.** The floor
means many hands legally cannot be won; combined with weak bots that is a lot of
dead air. Rulesets are config (§4), so the default preset is a *choice*, and
"which minimum makes the game most fun to a newcomer playing on a phone" is now
a legitimate question. A research-first framing would never have asked it. Some
houses play a lower floor; the option exists. Worth testing rather than assuming
canonical is correct for the default room.

**Build order shifts.** Toward: bots, the ritual, animation, expressions, toss
styles, the win ceremony, tile art. Away from (not deleted, deferred): the eval
bar, observer analytics, the theory pipeline, anything with a chart in it.

### What does NOT change

**Keep the event log exactly as it is.** It costs almost nothing — the reducer
emits events regardless — and it pays for itself immediately in *fun* features:
replay, sharing a win, watching the hand back. It also preserves every research
option for free. The log was never the problem; presenting it as the pitch was.

Analysis screens stay too. They are just opt-in depth for the minority who want
them, reached deliberately, never in anyone's way.

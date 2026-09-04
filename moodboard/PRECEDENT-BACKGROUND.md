# Conceptual background — Fortnite, Stardew, Chess.com, PUBG, Halo

**Date:** 2026-09-02 · Written for: *"I just need some basic screenshots and some conceptual
background data."*

Screenshots for Stardew, PUBG and Halo are on the board. Chess.com and Fortnite need manual
capture (`PRECEDENTS.md`). What follows is the background — **why each looks the way it does,
and what mechanism produced it**, since the mechanism is the transferable part.

The most useful thing in this document is §1, which is not one of the five.

---

## 1. The Staunton set (1849) — the closest historical parallel to what MJRC is doing

Before 1849, chess sets varied enormously by region and maker — St George, Régence, Selenus
patterns, plus ornate figurative sets. Pieces were often hard to tell apart, and a player moving
between regions had to re-learn what a bishop looked like.

**What happened:**

- **Nathaniel Cooke** registered the design on **1 March 1849** at the Patent Office, under the
  Ornamental Designs Act of 1842.
- Manufactured by **John Jaques of London**.
- **Howard Staunton** — the strongest player in the world and a newspaper columnist — endorsed it
  in his column on **8 September 1849**. It went on sale **29 September 1849**.
- The set became known by the *endorser's* name, not the designer's, and became the world
  tournament standard. **It has held that position for 175 years.**

**The design criteria were functional, not decorative:** pieces that are easy to distinguish from
one another on a board, abstract rather than representational, with distinct silhouettes and a
clear height hierarchy.

**Why this matters for MJRC, concretely:**

1. **The canonical set for a traditional game was designed, not inherited.** Someone sat down and
   drew it, a manufacturer made it, and an authority blessed it. Standards for ancient games are
   authored — that is the permission structure for authoring one.
2. **There is no Staunton of mahjong tiles.** Tile faces vary by region and manufacturer, and every
   digital implementation invents its own. That is an open position, and it is a *design* position
   rather than a marketing one.
3. **You are already doing the Staunton move for rules.** This work sits on a
   `ruleset-standardization` branch. The tile set is the visual counterpart of the same project —
   same instinct, applied to the object instead of the ruleset.
4. **The cautionary half: the design alone did not win.** Staunton's endorsement did. A superb tile
   set with no authority behind it stays a nice tile set. Whatever MJRC designs needs a
   distribution or credibility path attached to it from the start.
5. **The legibility criteria transfer directly.** Distinguishable at a glance, abstract, clear
   silhouette hierarchy — the same list as the Game & Watch, INSIDE, Halo and Kinneir/Calvert
   findings elsewhere on this board.

On the board in `chess/`: pre-standardisation variety (an 1897 plate of competing chessmen
designs, a 19th-century Dutch figurative set, an 11th-century rock-crystal piece from the abstract
Islamic tradition), the Staunton standard itself, and the 1950 Dubrovnik set as the one serious
later challenger.

## 2. Chess.com — the same category, digitised

**What it is:** the dominant digital implementation of an ancient abstract board game with a
global player base. That is MJRC's category, not a metaphor for it.

**Mechanism worth understanding:**

- **Board themes and piece sets are user-selectable.** Two loads of the guest page produced two
  entirely different board-and-piece treatments of the same position. This is the theme contract
  from `RENDER-AXIS-PROPOSAL.md` §5, shipped at consumer scale, in a directly comparable product.
  Together with the MTR (`TYPOGRAPHY.md`), that is two independent proofs the architecture works.
- **The default board is flat green-and-cream at low saturation — not skeuomorphic wood.** The
  largest chess site in the world chose legibility over realism for its default. Direct argument
  for MJRC tile rendering.
- **Product shape:** play / puzzles / learn / analysis / leaderboard. That is the full lifecycle of
  a classic game turned into a service, and it is roughly the shape MJRC's roadmap will take.
- **Named bots at labelled rating strengths** — comparable to the bot and rating work already in
  the engine.

## 3. Fortnite — the generic-stylised benchmark

**What it is:** the game you named when describing "that very generic video game style."

**Mechanism** (the full analysis is in `GENERIC-GAME-STYLE.md`): stylised PBR — realistic material
physics applied to exaggerated shapes. Four forces converge on it: shared PBR rendering,
readability at competitive speed, global mass-market reach across many age ratings, and hardware
scalability.

**The cause that matters most and gets discussed least: the cosmetics economy.** Fortnite earns on
skins. A skin must read as clearly different, be recognisable at shop-thumbnail size, and stay
legible in a firefight. That demands clean shapes, strong colour blocking, and surfaces simple
enough that re-skinning is cheap. **The art style is substantially a shape of the business model.**

**Transferable:** the readability engineering. **Not transferable:** the placelessness, which is a
consequence of optimising for maximum global reach and is the precise opposite of MJRC's thesis.

## 4. PUBG — the anti-stylised pole

**What it is:** the realism end of the same genre, and useful precisely because it is not beautiful
and is not trying to be.

**Two lessons:**

1. **Competent photorealism reads as mundane, not premium.** This is what the realism MJRC was
   advised against actually looks like when executed well and at scale.
2. **The drabness is deliberate readability engineering.** The world is desaturated grey-green so
   that a *player* is the only saturated thing in frame. Figure/ground enforced through palette.
   Steal the discipline; leave the style.

Measured: 0.373 saturation, 26.7% dark, 85.4% hue-concentrated — restrained on two axes, per
`AI-DEFAULTS.md`.

## 5. Halo — silhouette and faction colour

**What it is:** the clearest AAA case of an art direction built on **readable silhouettes**.

**Mechanism:** Master Chief is among the most recognisable shapes in games, and it survives being
shrunk, backlit, or seen at distance. Faction identity is carried by palette — human green-grey,
Covenant purple, enemy red — so allegiance resolves from colour before any detail does.

**The useful test:** compare Halo MCC against Halo Infinite, twenty years apart. What survived the
fidelity increases is **the silhouettes and the faction colours** — not the textures, not the
polygon counts. That is the durable half of an art direction, and it is the half worth spending
on when you have almost no budget.

Measured: both restrained on all three axes.

## 6. Stardew Valley — scope, construction, and the tile grid

**Three arguments, and all three matter:**

1. **Scope.** One person made it over roughly four years, and it outsold most studio output. The
   existence proof for MJRC's actual resourcing situation.
2. **Method.** Pixel art is **constructed, not rendered** — hand-placed pixels on a fixed grid.
   Cheap, versionable, diffable, and structurally impossible for a generative model to fake, for
   exactly the same reasons as the Mondrian argument in `AI-ART-STRATEGY.md` §4. This is the second
   independent route to an AI-proof art direction.
3. **Structure.** It is literally a tile game — a 16px grid with everything snapped to it. The
   palette is tightly indexed; most of the visual variety comes from *arrangement* rather than
   from hue count.

Measured: 0.773 saturation — the highest of anything on this board, above Inscryption — and it
still reads calm, because 26.1% of it is dark. Further evidence that **darkness, not saturation,
is the load-bearing axis.**

---

## The through-line

Five references, four independent arrivals at the same place:

- **Staunton (1849)**, **Halo**, **Game & Watch** and **Kinneir & Calvert (1957)** all converge on
  **silhouette and differentiation before detail** — from board-game manufacturing, AAA games,
  handheld LCD, and road signage respectively. Four disciplines, four eras, one finding.
- **Stardew** and the **Mondrian/De Stijl** direction converge on **constructed rather than
  rendered** as the cheap, durable, un-fakeable route.
- **Chess.com** and the **MTR** converge on **a theme contract** as the way to get many identities
  out of one system, and to let other people contribute without touching the engine.

Three conclusions, each reached twice by unrelated routes. That is about as much confirmation as
this kind of research offers.

---

## Sources

- [Staunton chess set — Wikipedia](https://en.wikipedia.org/wiki/Staunton_chess_set)
- [Nathaniel Cooke — Wikipedia](https://en.wikipedia.org/wiki/Nathaniel_Cooke)
- [The Staunton Standard: Evolution of the Modern Chess Set — World Chess Hall of Fame](https://worldchesshof.org/program/the-staunton-standard-evolution-of-the-modern-chess-set/)
- [Staunton Chessmen history — Chess Antiques Company](https://chessantiques.com/chess-historical-background-and-articles/staunton-chessmen-history/)

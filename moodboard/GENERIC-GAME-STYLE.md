# The "generic video game style" — what it is, why it happened, and whether to copy it

**Date:** 2026-09-01 · Written in response to: "Dota, Fortnite, League of Legends — the
assets are different but the style looks the same. Why does it look that way? Is it worth
mimicking or avoiding? Has anyone talked about this?"

Short version: you've correctly identified a real phenomenon with a real name. It is
**convergent evolution under shared constraints**, not laziness or lack of talent. And MJRC
should **reject its content logic while stealing its engineering.**

---

## 1. It has a name

The industry term is **"stylized realism"** or **"stylized PBR"**: realistic rendering,
materials and light physics applied to deliberately exaggerated shapes and proportions.
Trade descriptions define it as retaining realistic materials, lighting and movement physics
while framing them in exaggerated form — "physically based material rules with fine detail
trimmed, softened edges and narrowed roughness/albedo ranges to produce a cohesive,
illustration-like look."

Informal and critical names you'll see: *the Blizzard style*, *the Overwatch look*,
*Fortnite-ification*, *global art style*.

**One distinction worth keeping straight:** this is *not* "Corporate Memphis" (also called
Alegria — the flat vector illustration with disproportionate limbs and no faces, from
Facebook/Google marketing art). People conflate them because both are criticised as generic
and placeless, but they're different media solving different problems. Yours is the 3D one.

## 2. Why it converged — seven forces, all pointing the same way

This is the part worth understanding, because each cause independently produces the same
answer. That's why the result feels designed-by-committee even when very good artists made it.

**1. PBR is a shared physical constraint.** Since roughly 2013 essentially every engine uses
the same physically based shading model — metallic/roughness workflow, the same specular
math, the same image-based lighting. You can stylise the albedo, but *the light response is
the same equations in every game*. Trade write-ups note that PBR "sets the guidelines for the
creation of textures and materials," making the working methods for realism and stylisation
converge. This alone produces a shared family of surfaces across otherwise unrelated titles.

**2. Competitive readability.** Dota, LoL, Fortnite, Overwatch and Valorant are all fast,
multiplayer, and require identifying a character instantly, at distance, in visual clutter,
under time pressure. That forces exaggerated silhouettes, restricted shape language,
saturated hero colour against desaturated environments, and rim lighting for figure/ground
separation. These constraints have a small solution space, so everyone lands in it.

**3. Global mass-market reach.** These are free-to-play titles chasing maximum worldwide
audience across many age ratings and content regimes. Realism reads as mature and violent;
strong cultural specificity reduces reach. Both get sanded off.

**4. Hardware scalability.** Must run on low-end PCs, phones and old consoles. Simplified
materials scale down far better than photoreal ones.

**5. Cosmetic monetisation.** *(my analysis, not sourced)* These games earn on skins. A skin
must read as clearly different, be recognisable at shop-thumbnail size, and stay legible
in-game. That demands clean shapes, strong colour blocking, and surfaces simple enough that
re-skinning is cheap. **The art style is partly a shape of the business model.** This is the
most underrated cause and probably the strongest one.

**6. Pipeline economics.** *(my analysis)* A style executed by 200 artists across several
outsourcing vendors must be *documentable and teachable*. Idiosyncratic authorial styles do
not survive that. The style that scales is the style that can be written down as rules — and
rules-based styles from different studios resemble each other.

**7. Talent circulation.** *(my analysis)* Artists move between these studios; ArtStation is
the shared portfolio standard; the same tool chain (ZBrush → Substance → Marmoset) and the
same tutorials train everyone. Portfolio work is made to match what gets featured, which
feeds back into what studios hire for.

## 3. Why it reads as "generic" specifically

Because **the style is defined by subtraction.** Every force above removes specificity:
cultural markers, authorial idiosyncrasy, material weirdness, regional visual grammar. What
remains is highly competent and belongs nowhere — optimised for maximum reach, which
necessarily means minimum commitment.

There's a second, subtler reason: it's a *rendering* style rather than a *content* style. It
can be applied to fantasy, sci-fi, cartoon or military content without changing. A style that
can wrap anything signals nothing about what it's wrapping.

## 4. Should MJRC mimic it? No — two specific reasons

**Reason one: it is defined by removing exactly the thing you have.** MJRC's entire premise
is cultural specificity — the east/west collision, HK's spirit, a regionally-rooted ruleset.
Stylized realism's core move is deleting cultural specificity to maximise reach. Adopting it
would delete your only real differentiator in exchange for a crowded, expensive position.
Note that Mahjong Soul already occupies the "generic anime" slot; the generic-AAA slot is
worse, because it doesn't even come with a fandom.

**Reason two: it does not degrade gracefully on a small budget.** Stylized PBR looks good
*because* of enormous polish — hand-tuned materials, custom rigs, dedicated lighting artists,
long iteration. A cheap version of it reads instantly as asset-flip, which is the identical
failure mode to the AI-slop problem in `AI-ART-STRATEGY.md`. You cannot win on that axis, and
losing on it is worse than never entering it, because the style invites direct comparison
with titles that spent a hundred times more.

## 5. But steal the engineering — it's genuinely good

The convergence has real functional reasons and those reasons are sound. Separate the
*function* from the *convention*:

**Take:**
- Silhouette-first shape language; every element identifiable from its outline alone
- Hero saturation against desaturated surroundings — figure/ground as a hard rule
- Edge/rim separation so objects never merge with backgrounds
- A restricted, documented material vocabulary rather than per-asset improvisation
- Deliberate shape-language differentiation so similar items don't confuse

**Reject:**
- The proportion conventions (oversized hands, feet, heads)
- The friendly-safe-placeless content register
- Cultural neutrality as a default
- The PBR material response itself — this is precisely where BL2's flat-fill-plus-ink
  approach is the alternative answer, and it's cheaper

**The rule in one line:** *take what follows from constraints you share (readability), reject
what follows from constraints you don't (global F2P mass market, skin economy, 200-person
distributed team).*

## 6. Where this leaves MJRC

Every document in this folder is converging on the same position, which is a good sign:

- Not photoreal (`AI-ART-STRATEGY.md` — worst AI target, worst budget target)
- Not generic stylized-PBR (this document — deletes your differentiator, needs a budget you
  don't have)
- Not anime (occupied by Mahjong Soul, and mismatched to the actual player base per
  `AUDIENCE-AND-TASTE.md`)
- **Constructed rather than rendered** — the Mondrian/De Stijl grid crossed with Chinese
  square-block logic, plus BL2's ink-contour legibility, held together by the presentation
  contract from `RENDER-AXIS-PROPOSAL.md` §5

That position is differentiated, cheap, AI-proof, artist-extensible, and culturally specific
in a way none of the three reference games are. It is also, not coincidentally, the only one
of these you can actually execute alone right now.

---

## Sources

- [The Transformation Of Stylization In Video Games — 80.lv](https://80.lv/articles/stylization-in-video-games-a-deep-dive-analysis)
- [Physically Based Rendering and Stylization — Game Developer](https://www.gamedeveloper.com/art/physically-based-rendering-and-stylization)
- [Creating Stylized Art in a PBR World — Erik McKenney, Velan Studios](https://medium.com/velan-studios/tip-of-the-brush-creating-stylized-art-in-a-pbr-world-b803b91c082f)
- [Stylized Realism: Balancing Art and Realism in Gaming Visual Styles — INLINGO](https://inlingogames.com/blog/stylized-vs-realistic/)
- [Realistic vs. Stylized Art Style in Game — Pixune](https://pixune.com/blog/stylized-vs-realistic/)
- [Realism vs Stylization in Game Art: When to Use Each — Sunstrike Studios](https://sunstrikestudios.com/en/blog/game_art_visual_direction/)

Causes 5–7 (monetisation, pipeline economics, talent circulation) are my own analysis. The
trade press covers the PBR, readability and scalability causes directly; it is much quieter
about the business-model and labour causes, which I'd argue are the strongest of the seven.

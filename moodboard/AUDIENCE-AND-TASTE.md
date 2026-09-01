# Art direction and audience — does this stuff split by gender?

**Date:** 2026-09-01 · Written in response to: "I'm a man, I might have a natural
inclination towards certain types of artwork, and making something appeal to both
genders might be trickier."

Short version: **the instinct to check your own bias is right, but gender is the wrong
variable to correct for.** For a mahjong game the variable that actually predicts
response is familiarity with mahjong, and after that age. Gender matters mostly as a
proxy for those two, and it is a lossy proxy.

---

## 1. What the evidence actually supports

**Innate gendered preference for visual styles: weak and contested.** The best-known
study pointing at a sex difference in colour preference (Hurlbert & Ling, 2007, which got
a lot of press as "women prefer pink") found a small effect on a reddish axis, tested a
narrow sample, and has been criticised for exactly the confound you would expect — the
participants grew up in cultures that had already colour-coded them for decades. Cross-cultural
replication is poor. Pink-for-girls is itself a mid-20th-century Western marketing
convention; in early-1900s US catalogues pink was frequently recommended for boys as the
stronger colour. A convention that inverted within living memory is not biology.

**What does replicate: learned signal-reading.** People are fast and accurate at judging
*who a product is for*, because those signals are conventions they have been trained on.
But the signals are almost entirely **content and tone**, not rendering technique:

- who is depicted, and whose gaze the framing adopts
- the violence register — cartoon slapstick vs. gore
- the humour register — crude/scatological vs. warm/absurd/dry
- body design conventions, especially proportion and costume
- the surrounding marketing context

Note what is *not* on that list: line weight, cel-shading, silhouette treatment, palette
structure, UI density.

## 2. The practical consequence for the Borderlands question

**The ink contour is not the gendered part of Borderlands. The content is.**

Borderlands reads as a young-male product because of guns, gore, scatological jokes,
and body proportions — not because objects have dark outlines. The rendering technique is
a legibility tool and it is essentially neutral. The same technique family covers:

| Work | Render approach | Audience skew |
|---|---|---|
| Borderlands 2 | thick ink contour, flat fill, hatching | young male |
| The Legend of Zelda: The Wind Waker | heavy cel-shade, flat fill | broad |
| Ōkami | sumi-e brush contour | broad |
| Animal Crossing | soft flat shading, no gore | female-skewing |
| Hades | hard-outlined character portraits | broad, notably strong female audience |
| Sable | pure Moebius line, minimal fill | broad |

Same tool, completely different audience outcomes, because the content differs. This is
the strongest possible argument for the render/content split proposed in
`RENDER-AXIS-PROPOSAL.md`: **take BL2's line, leave BL2's subject matter.** They are
genuinely separable, and treating them as a package is the actual mistake to avoid — not
liking Borderlands in the first place.

One image in the folder already proves the point: `games/borderlands/ui-bl2-16.jpg` is
Tiny Tina at a tea table, warm light, domestic, non-threatening — identical render
language, completely different register. The style does not force the tone.

## 3. The fact that should dominate this decision

**Mahjong's existing player base does not look like a shooter audience.** In Hong Kong
and Cantonese diaspora communities, social mahjong skews female and older — it is one of
the few competitive tile/card games with a large, established, non-male player base in
its home culture.

I want to be honest about the strength of that claim: it is well-attested culturally and
matches anything you have personally observed at a HK mahjong table, but I do not have a
reliable current figure to attach to it and will not invent one. **This is worth actually
measuring** — it is the single most decision-relevant number in the whole project, and it
is obtainable: your own room/session data on mahjongresearch.com, plus a question in any
player survey you run.

If that skew holds, then the strategic risk is specific and not vague: adopting
Borderlands' *content* register would signal "young male shooter fan" to an audience
substantially composed of women over 40 who have played this game their whole lives. The
board already identifies Mahjong Soul's anime direction as the counter-reference; note
that Mahjong Soul is making exactly this bet in the other direction — deliberately
targeting a young male otaku audience and accepting the narrowing that comes with it.
There is an unoccupied position between "anime waifu" and "sports-broadcast austerity",
and that gap is the actual opportunity.

## 4. The better axis: familiarity, not gender

For MJRC the two player types that genuinely pull art decisions in opposite directions are:

**The lifelong player** — often 45+, often female, HK or diaspora, learned at a family
table. Wants: tiles that look like real tiles, respect for the object, dense information
available at a glance, no tutorialisation, no condescension. Is offended by cuteness
applied to a serious game.

**The newcomer** — often younger, often Western, learned from an app. Wants: teaching,
tolerates and often prefers abstraction and stylisation, needs explanation of scoring,
wants the game to be legible before it is authentic.

These two conflict on the *same* concrete decisions — how abstract a tile face can be, how
dense the UI is, how long animations run, how much the game explains itself. That conflict
is real, actionable, and testable. Gender is not doing much independent work once you have
conditioned on it.

## 5. Concrete direction

**Avoid both obvious traps.** Trap one is the anime/waifu bet (narrow, occupied, and
badly matched to the actual player base). Trap two is "make it appeal to women" via pink,
florals, and softness — this is the same stereotype reasoning in reverse, it reads as
condescending to exactly the serious older players who form the core audience, and it is
the single most likely way to get this wrong while believing you are being inclusive.

**The register that travels widest is material respect and craft.** Tiles as genuinely
beautiful physical objects: weight, wear, hand-carving, the colour drift of old inks,
bone-and-bamboo and early bakelite. This reads as premium to essentially everyone, it is
what the lifelong player already loves about the game, and it gives the newcomer something
to find attractive before they understand the rules.

**This is the board's biggest actual gap.** There is currently not one image of a real
mahjong tile in the moodboard, and 98 images of other people's video games. That is
backwards, and it is a more urgent problem than any question about gender.

**Then test rather than theorise.** You are a sample of one and you already know your
bias, which is why you asked. The cheap version:

1. Produce 3 tile-face treatments (traditional / cleaned-up / strongly abstracted) and 2
   table treatments.
2. Show them to a mixed panel — crucially varied on *familiarity and age*, with gender
   recorded but not used to select.
3. Measure two things separately: **recognition speed** (objective — how fast can they name
   the tile) and **preference** (subjective and noisy).

Recognition speed is the one that should drive the decision. Preference data collected
from small panels is mostly noise, and if the two disagree, trust the clock.

## 6. What I would not claim

- That there is no aesthetic difference in aggregate between men and women. There are
  measurable differences in aggregate *preference*, but they are small relative to
  within-group variation, heavily culturally mediated, and they do not map cleanly onto
  the specific decisions in front of you (contour weight, palette structure, UI density).
- That any specific art direction will reliably move a given demographic. Anyone claiming
  a clean causal rule here is selling something.
- Any specific number about mahjong player demographics. See §3 — measure it.

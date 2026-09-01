# The default AI look — what it is, measured, and how to avoid it

**Date:** 2026-09-01 · Purpose per Augustine: *"the way to use these images is not to use any
of their ideas. It's to understand what AI produces by default, identify the cliché elements,
and find ways to avoid that look."*

So: this is a **negative reference document.** Nothing here is to be copied.

---

## 1. The measured finding — and a correction

I previously told you the AI images' problem was **missing neutral ground** (2.7–2.9% vs
Hong Kong's 17%). Testing that against twelve shipped, well-art-directed games **falsified it.**
Ōkami (3.9%), Sifu (4.0%), Stray (0.9%) and Inscryption (0.0%) all score *worse* on neutral
ground than the AI images do. The rule was wrong.

Here is what actually separates them. Three axes of restraint — saturation, value (darkness),
and hue concentration:

| | mean sat | **dark %** | hue conc. | restrained on |
|---|---|---|---|---|
| Inside | 0.217 | 84.8% | 97.5% | sat, dark, hue |
| Inscryption | 0.787 | 84.2% | 64.6% | dark, hue |
| Nine Sols | 0.710 | 71.6% | 71.7% | dark, hue |
| Jet Set Radio | 0.303 | 70.3% | 60.2% | sat, dark |
| Stray | 0.579 | 56.1% | 77.0% | dark, hue |
| Sifu | 0.678 | 42.4% | 85.4% | dark, hue |
| Ōkami | 0.438 | 34.8% | 78.2% | dark, hue |
| Persona 5 | 0.336 | 33.3% | 68.8% | sat, dark, hue |
| Balatro | 0.377 | 23.4% | 77.4% | hue |
| Guilty Gear | 0.420 | 23.3% | 84.3% | hue |
| Sable | 0.246 | 12.6% | 56.1% | sat |
| Hi-Fi Rush | 0.490 | 14.6% | 61.5% | **none** |
| **Hong Kong (real)** | 0.309 | 34.3% | 65.4% | sat, dark, hue |
| **mahjong (real)** | 0.314 | 14.5% | 67.8% | sat, hue |
| **AI — Gemini** | 0.392 | **4.4%** | 70.9% | hue only |
| **AI — ChatGPT** | 0.381 | **7.8%** | 65.3% | hue only |

*dark % = pixels below 0.28 value. hue conc. = share of chroma falling in the dominant 90° of hue.*

### The rule

**Good art direction is restrained on at least two of {saturation, darkness, hue}. The AI
images are restrained on one — hue — which is the weakest and the one you get for free from a
prompt.**

And the specific, dominant failure is **darkness**. Every shipped game clears 12% dark; most
clear 30%; several exceed 70%. Real Hong Kong photography is 34%. **The AI images are 4.4% and
7.8%.** That is the single largest gap in the whole table, and it is the most reliable tell.

Hi-Fi Rush is the honest exception — restrained on nothing, because it is a deliberate
maximalist comic-book explosion. Note that it *chose* that, and it is the outlier among twelve.

### Why AI does this

Diffusion models optimise toward a pleasing, well-exposed, evenly-lit image, because that is
what training preference signals reward. Darkness reads as "underexposed" or "low quality." So
the model lights everything, from everywhere.

The consequence is structural, not cosmetic: **no shadow means no depth, no focal hierarchy,
no rest, and no mystery.** Everything is foreground. Everything competes. That is why the
images feel loud even when their measured saturation is close to reality.

## 2. The cliché catalogue

Observed directly in the two tests, plus the general defaults.

**Light and composition**
- Radial light burst from a central vanishing point; god rays
- Rim light on every object, from no identifiable source
- Bloom on every emitter; lens flare; floating bokeh sparkles with no origin
- Dead-centre symmetry; objects arranged in a perfect arc or fan
- Uniform depth of field, or none
- **No shadow anywhere** — see §1

**Colour**
- Cyan–magenta–gold triad
- Sunset/dawn gradient sky as the universal background
- Every surface faintly emitting
- No dark, no rest, no ground

**Content**
- Dragons, lanterns, cherry blossom as generic "Asian" shorthand
- Floating fantasy pagodas; celestial cloudscapes; mandala floor plates ("gacha splash")
- Anime protagonist as the default human
- Crowds of uniformly delighted people
- Gold filigree edging on everything

**Language and symbols**
- Decorative gibberish glyphs
- Mixed scripts presented as one culture (Cantonese + katakana in the Gemini test)
- Invented compounds that look like words (麻龍)
- **Symbol systems rendered plausibly but incorrectly** — the 一索 failure

**Material**
- Everything glossy and wet-looking
- Uniform micro-detail density across the whole frame; no simplified areas
- No wear, no dirt, no asymmetry, no manufacturing irregularity

## 3. How to avoid it

Ordered by leverage.

1. **Put real darkness in the frame.** Target 25–35% below 0.28 value. This is the single
   highest-leverage move and it is measurable. Score any candidate image before shipping it.
2. **Pick a second restraint axis and commit.** Either desaturate (Sable, Jet Set Radio) or
   lock the hue range hard (Sifu's near-monochrome red, Guilty Gear at 84%). One is not enough.
3. **Give the light one nameable source and let things fall out of it.** If you cannot say
   where the light comes from, neither could the model.
4. **Build a detail hierarchy.** One area rendered, the rest simplified. Uniform detail density
   is the most reliable AI tell after flat lighting.
5. **Break symmetry.** Off-centre the subject; let something run out of frame.
6. **Every glyph must mean something**, and a reader must check it. This is non-negotiable for
   a mahjong game — see `ai-tests/README.md`.
7. **Add wear.** Chipped edges, uneven ink, yellowed plastic, fingerprints. The `mahjong/`
   folder is full of the real thing.
8. **Construct rather than render where you can.** Vector and geometric work — the Mondrian
   direction in `AI-ART-STRATEGY.md` §4 — is AI-proof by definition. Nothing generated, nothing
   to disclose, nothing to look fake.
9. **Condition on your own references.** Prompt-only generation is what produces everything in
   §2. Structural conditioning plus a style anchor plus paintover is the working pipeline.

## 4. A pass/fail test before anything ships

1. **Measure dark %.** Under 15% is a red flag. Under 10% is a fail.
2. **Count restraint axes.** Fewer than two is a fail.
3. **Name the light source.** If you can't, fail.
4. **Cover the focal element.** Is the background doing work, or is it wallpaper?
5. **Have a mahjong player read every glyph.** Any error is a fail — that reader is the core
   audience.
6. **Find the rest.** Point to where the eye is allowed to stop. If nowhere, fail.

## 5. Gemini vs ChatGPT — the honest split

You said Gemini looked better. From these two samples it isn't one-directional — they fail
differently:

| | Gemini | ChatGPT |
|---|---|---|
| Scene, context, world-building | **better** — street, crowd, architecture | none — celestial void |
| Compositional hierarchy | **better** | clean but trivial (a row of objects) |
| Subject accuracy | ~5/14 tiles, one illegal | **13/14**, one illegal |
| Object material | flat, generic | **better** — cream, gold edge, carved depth |
| Language handling | fails (script soup) | **avoids it** by having almost no text |
| Darkness | 4.4% | 7.8% |

**Gemini is better at making a picture; ChatGPT was better at making the object.** For MJRC,
where the object is the product, that split matters more than an overall ranking. Neither is
usable for tiles.

## 6. What was actually worth taking from the tests

Two ideas, both structural rather than visual:

- **The crowd reacting to a win** (Gemini). Frames mahjong as social and spectated rather than
  as solitaire. On-thesis, and survives a complete restyle.
- **The tile as a made object** (ChatGPT) — cream body, gold edge, glyph carved in and filled.
  That is a material direction worth pursuing, by hand, against the real references in `mahjong/`.

Everything else in both images is in §2.

---

**Related:** `ai-tests/README.md` (the two tests in detail) · `AI-ART-STRATEGY.md` (what to
generate, what never to) · `PALETTE.md` (measured colour) · `GENERIC-GAME-STYLE.md`

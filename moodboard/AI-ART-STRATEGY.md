# AI-generated art for MJRC — what it can and cannot do, and how to do it without slop

**Date:** 2026-09-01 · Written in response to: "I'll probably have to use AI to generate a
lot of this art until I can hire artists or get my artist friends to collaborate."

---

## 0. The tension in the ask, named

You said two things that look contradictory:

> "do not make it photorealistic — photorealistic art just looks like absolute crap"

> "I do want it to feel as realistic as possible"

These are only contradictory if "realistic" means "photoreal." It doesn't. What you're
describing is **authenticity, not fidelity** — the sense that a person decided every mark.
Photorealism is the *worst* possible target for AI art because it competes on exactly the
axis where the generation artifacts live: skin, hands, reflections, physical light, text,
continuity of occluded lines. A stylized image has no uncanny valley to fall into, because
there's no ground truth to violate.

So the resolution: **stylize hard, and get authenticity from craft decisions and real source
material rather than from rendering fidelity.** Everything below follows from that.

## 1. What generative AI actually does well and badly, for this project

**Does well**
- Texture and surface — worn concrete, fabric weave, paper grain, wood, patina. No exact
  geometry required, no legibility requirement, tiles seamlessly, and errors read as noise.
- Backgrounds and environments seen at a distance or behind UI.
- Volume of *variations* on a locked structure (given conditioning — see §3).
- Concept exploration and mood tests. Genuinely excellent; near-zero risk since nothing ships.
- Colour studies and lighting studies.

**Does badly — and these are exactly MJRC's assets**
- **Exact repeated geometry.** A mahjong set is 144 tiles across ~42 distinct faces that must
  share identical margins, stroke weight, corner radius and optical sizing. Generative models
  have no concept of "the same rectangle again." This is the single worst-case asset class
  for generation.
- **Legible text and glyphs.** Tile faces are 萬/筒/索, 東南西北, 中發白. Getting Chinese
  characters correct, consistently weighted, and correctly proportioned is a known failure
  mode. A malformed 發 is not a style choice, it's a bug the entire target audience will catch
  instantly.
- **Small-scale legibility.** Models optimise for a pleasing 1024px image, not for a shape
  that survives at 40px on a phone at a 30° table angle.
- **Consistency across an asset family.** The most-reported production problem, and the thing
  players flag first.
- **Hands, faces, physical light, occluded line continuity.** The classic tells.

**Two rules added 2026-09-01 after live tests — see `ai-tests/README.md` for the evidence.**

**Rule: don't draw anime.** Not on taste grounds. Anime is simultaneously (a) the style
generative models fake most convincingly, (b) the style whose fakeness is most legible, and
(c) the slot already occupied by Mahjong Soul. It feels uncanny because anime is a *codified*
style — strict line-weight hierarchy, specific eye and hair construction, deliberate decisions
about what not to draw — and models reproduce the surface features without the discipline.
Every line is present; none is chosen. It also has the most training data of any illustration
style, so output regresses hardest to the mean: the more competent the imitation, the more
anonymous it is.

**Rule: the tile failures cluster on counting.** Two independent models were asked for a
Thirteen Orphans hand. Both failed, and the surviving errors landed in the same place. 萬
encodes its number as a single *character* — one glyph to copy, and models get it right. 筒
and 索 encode it as **N repeated objects**, and counting discrete objects is a persistent
generative weakness. 索 is the worst case in the entire set, because it fails on counting
*and* on convention: 一索 is a **bird**, not a bamboo stalk, and a pattern-matching generator
will always draw the stalk.

**The conclusion is unusually clean for this project: never generate the tiles.** Tiles are
vector work — constructible, versionable, pixel-tunable, and the one asset where correctness
is non-negotiable. Generate the *world around* them.

## 2. The risk landscape (practical, not moral)

- **Steam requires disclosure.** Valve requires developers to disclose generative AI used in
  content players experience — art, audio, text, and marketing/store assets. The policy was
  clarified again in January 2026 and splits pre-generated from live-generated content. Code
  assistants (Copilot and similar) are explicitly *not* disclosable. Over 7,300 Steam titles
  have filed disclosures. Plan to disclose; it is not optional and not a judgement call.
- **The backlash is asymmetric and hair-trigger.** Reported cases: *Clair Obscur: Expedition
  33* had an Indie Game Awards GOTY nomination revoked after a **single** AI texture was
  flagged; *Project Zomboid* took community fire on merely *suspected* AI art. The penalty is
  not proportional to how much AI you used — it's closer to binary on detection.
- **What people actually object to is legible.** The consistent complaint across reported
  cases is *generic, obviously-AI output with inconsistent characters, a plasticky look, and
  no evident art direction* — plus the labour question. Note the first half is a **quality**
  complaint. Work that is stylised, consistent, and clearly directed draws far less fire than
  work that looks defaulted.

Read together: the risk is concentrated in *shipped, visible, character-facing* art, and it
scales with how generic the output looks. It is low for texture, mood studies, and internal
exploration. Allocate accordingly.

## 3. The technique stack — your instinct is the correct one

You said:

> "maybe we need to pull human-selected hard assets to modify and tweak rather than just
> generating all the AI assets out of thin air"

That is exactly what production practice has converged on. Prompt-only generation is the
amateur path and it is what produces the look you're trying to avoid. The 2026 production
stack is four layers, and prompting is the weakest one:

| Layer | What it does | Why it matters here |
|---|---|---|
| **Structural conditioning** (ControlNet — canny/depth/pose) | Locks composition and geometry to an input you supply | You draw or photograph the structure; AI only fills surface. This is your "hard assets" instinct |
| **Style anchor** (IP-Adapter) | Transfers style from reference images without retraining | Feed it *your* moodboard, not the model's defaults |
| **Identity/style fine-tune** (LoRA) | 15–20 reference images trains a reusable style | This is how you make it *yours* rather than the model's house style |
| **Human paintover** | A person fixes and finishes | Standard, non-optional production stage. Everything above outputs *reference*, not final art |

The single most important line in all of it: **the output is reference, not final art.** Every
credible pipeline treats generation as the sketch stage.

**The ethics shortcut that's also the quality shortcut:** train the LoRA on art you own or
have licensed — your own vector tiles, your own photography, commissioned work from your
artist friends (with their explicit agreement and payment). This simultaneously solves the
"whose work is in the model" objection and produces output that looks like *your* game
instead of like everyone else's Midjourney. Same move, two problems.

## 4. The Mondrian answer — and why it's the strategically correct direction

Bringing up Mondrian was the most useful thing in your message, because **the De Stijl grid
is the one art direction that is simultaneously cheap, AI-proof, culturally correct for
mahjong, and trivially extensible by future artists.**

**It's AI-proof.** Flat planes, black rules, primary fields, asymmetric balance — all of it is
*constructed*, not rendered. You build it in vector or code. There is nothing for a diffusion
model to do, which means there is nothing for it to get wrong and nothing to disclose. It
cannot look like slop because it isn't generated.

**It's culturally correct, and this is the part worth taking seriously.** The grid is not
only a Western modernist idea. Chinese characters are literally 方塊字 — "square-block
characters." Chinese visual culture runs on the grid: lattice windows (窗花), courtyard
plans, the go/weiqi board, seal-script squares, the ruled columns of classical text layout,
city plans like Chang'an. **De Stijl grid meeting Chinese square-block logic is a genuine
east-west collision, on the board's actual thesis, that nobody has occupied.** Compare that
to "HK neon in a mahjong game," which is the obvious move everyone would make.

And mahjong is *already* the grid: the wall is a grid, the discard pool is a grid, a hand is
a row, the tile itself is a rectangle with a ruled border. You are not imposing Mondrian on
the game — the game is already shaped that way. Sources are being collected into
`grid/destijl`, `grid/swiss` (the Bauhaus → Swiss/International Typographic lineage the grid
turns into) and `grid/chinese` (lattice, seal script, weiqi) so the two halves sit side by side.

Worth noting the YSL 1965 Mondrian dress is in the collected set — proof the language
survives translation into an entirely different medium, which is precisely the property you
need.

## 5. The architecture that solves all three problems at once

You want three things that look separate:

1. AI art that doesn't look like AI art
2. A way for artist friends to collaborate later
3. A way to "inject new aesthetic languages into this medium"

**They have one shared answer, and it's the Super Smash Bros. finding already on the board.**
Smash holds 84 mutually incompatible art styles — Minecraft voxel, Game & Watch silhouette,
Tekken photorealism — in one coherent product. It does this *not* by homogenising the art but
by making the **presentation contract** identical: same pose, same key light, same outline
weight, same crop, same framing.

Build that contract for MJRC and all three problems collapse into it:

> **A theme is a folder.** Tile faces (42 SVGs at a fixed artboard, stroke and margin spec),
> a palette token set, table surface, backing panels, tile-back pattern, and motion curves.
> Anything conforming to the contract drops in and works.

- **It disciplines AI output.** Generated work must conform to a spec — fixed geometry, fixed
  palette, fixed weights — which is exactly the constraint that stops it looking defaulted.
  Anything that can't conform is rejected before it ships.
- **It makes artist collaboration a folder handoff, not a rewrite.** Your friend delivers a
  theme folder. No engine work, no negotiation about integration, no coupling to your code.
  That is the difference between "collaboration" being a real offer and being a vague hope.
- **It is the injection mechanism you asked for.** New aesthetic languages arrive as new
  theme folders — including a Mondrian/De Stijl theme, a traditional bone-and-bamboo theme, a
  neon theme, and a guest-artist theme, all shipping side by side.

This is worth designing *before* commissioning or generating any art, because the contract
determines what can ever be accepted. Getting it wrong means every future theme is bespoke
integration work.

## 6. Concrete recommendation

**Never generate:** tile faces, any Chinese glyph, any UI element requiring exact repetition,
anything that must be legible at 40px.

**Safe to generate, with paintover:** table surfaces and felt, wood and stone textures, paper
and print grain, ambient background plates, atmospheric elements sitting behind UI, and
concept/mood exploration that never ships. **Also: tile *material* studies** — "what does aged
bakelite with a gold edge look like under this light" — which the ChatGPT test did genuinely
well. Generate the material, never the meaning.

**Grey zone, requires care and disclosure:** marketing key art, player avatars, room artwork.
Structural conditioning plus paintover mandatory. Assume these will be scrutinised hardest.

**Order of work:**
1. Design the theme contract (§5). Cheapest thing here and it gates everything else.
2. Build tiles as vector, by hand. They are the product; they are also the worst AI target.
3. Build one Mondrian/De Stijl theme end-to-end as the proof the contract works — it needs no
   generation at all, so it isolates the architecture from the art-sourcing question.
4. Only then use generation for textures and backgrounds, conditioned on your own references.
5. Train any LoRA exclusively on owned or licensed material.
6. Disclose on Steam. Plan for it from the start rather than discovering it at submission.

**And the thing that most reduces the "AI slop" read has nothing to do with AI:** a small
number of unmistakably hand-made, high-craft focal elements — the tile set, the logotype, one
signature illustration. Players calibrate their judgement off the most-looked-at assets. Get
those visibly human and the ambient texture behind them stops being interrogated.

---

## Sources

- [ComfyUI for Game Asset Pipelines: The Indie 2026 Playbook — StraySpark](https://www.strayspark.studio/blog/comfyui-game-asset-pipeline-indie-2026)
- [AI Art Tools for Game Studios in 2026: What Actually Works for Production — Inkration](https://inkration.com/ai-art-tools-for-game-studios-in-2026-what-actually-works-for-production/)
- [Control Image Generation with Stable Diffusion: ControlNet, IP-Adapter, LoRA — TechnoLynx](https://www.technolynx.com/post/control-image-generation-with-stable-diffusion)
- [Game Assets: Consistency with ControlNet Canny — Runware Docs](https://runware.ai/docs/guides/game-assets-canny)
- [Steam's 2026 AI Disclosure Rules: What Indie Developers Actually Need to Know — StraySpark](https://www.strayspark.studio/blog/steam-ai-disclosure-rules-2026-indie-developer-guide)
- [Steam AI Policy: What Every Game Developer Needs to Know — Legal Moves](https://legalmoveslawfirm.com/steam-ai-policy/)
- [Steam Week in Review: A touch of AI is all it takes to trigger backlash — PC Gamer](https://www.pcgamer.com/gaming-industry/steam-week-in-review-a-touch-of-ai-is-all-it-takes-to-trigger-backlash-as-a-promising-new-indie-falls-afoul-of-slop-skeptics/)
- [AI Art Is Entering Video Games and Players Aren't Loving It — Spilled](https://spilled.gg/ai-art-video-games/)
- [Why AI Images Look Fake: The Tells That Give Them Away — Imagera](https://imagera.ai/blog/why-ai-images-get-flagged-2026)
- [Is that image AI? 14 telltale signs — Rob Laughter](https://roblaughter.medium.com/is-that-image-ai-here-are-14-telltale-signs-to-look-for-d40e5cff2d0a)

Backlash specifics (Clair Obscur nomination, Project Zomboid, Identity V) are as reported in
the PC Gamer and Spilled pieces above — worth verifying directly before you cite them anywhere
public.

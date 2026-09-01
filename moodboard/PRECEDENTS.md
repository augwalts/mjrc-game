# Precedent studies — running index

**Date:** 2026-09-01 · Structure per your note: *"I imagine this would be two examples of
like 100."* So the board is built as **many references × few images each**, not few
references × many. Borderlands and Smash have been cut back to 8 and 6 images accordingly.

Status key: **[in]** collected · **[get]** worth collecting, not done · **[hard]** no clean
programmatic source, needs manual capture.

---

## What's on the board now

| Folder | Images | Axis |
|---|---|---|
| `mahjong` | 33 | the subject — material, type, parlour signage |
| `cities/hongkong` | 60 | neon, food/smoke, market, scaffolding, taxi, tile |
| `cities/tokyo` | 29 | the parallel case — signage stacks, alleys, LED type |
| `cities/shanghai` | 35 | Bund deco, shikumen — the W→C injection |
| `cities/singapore` | 16 | shophouses — the hybrid type in another climate |
| `cities/taipei` | 12 | night markets |
| `materials` | 26 | ceramic, terrazzo, lacquer, textile, azulejo |
| `grid/destijl` | 15 | Mondrian, Van Doesburg, Rietveld |
| `grid/chinese` | 10 | 方塊字, lattice, weiqi, cash coins |
| `grid/swiss` | 12 | Bauhaus → International Typographic |
| `games/borderlands` | 8 | ink contour (BL2), and its decay (BL4) |
| `games/smash` | 6 | presentation as unifier |

262 images. Everything culled sits in `_culled/` — recoverable, and excluded from the viewer.

## A palette finding worth acting on

The viewer's **Palette** tab now derives palettes from the collected photography, not from
games, as you asked. Naive extraction returned mud (`#080708`, `#222121`) because photographs
are mostly shadow — so it now also computes a **chroma-weighted accent palette**, which is the
usable one. Results:

- **Hong Kong** — `#bc4325` `#8d3b27` `#8c6335` `#8d7035`. Red-orange and amber. That's sodium
  street lighting plus red-and-gold signage, not the cyan-magenta cyberpunk cliché.
- **Tokyo** — `#2172df` `#c1392c` `#b24e28`. Noticeably **bluer** than HK. A real and useful
  difference: if you want the board to read HK rather than generic-Asian-city, warm amber
  against red is the tell, and cool blue is what pulls it toward Tokyo.
- **Mahjong** — `#732804` `#195f39` `#188e96` `#14bdbf` on cream. Deep red, bottle green, and
  a turquoise-cyan that most digital mahjong games render as flat blue and get wrong.
- **grid/swiss** — `#fefe00` `#000044` `#d90000`. The Bauhaus primaries came out exactly as
  they should, which is a good sanity check that the extraction works.

## FLCL — the honest status **[hard]**

I could not collect FLCL. There is no openly-licensed or programmatically accessible source
for anime stills, and I'm not going to scrape a fansite. Two things worth saying:

1. **What's valuable in FLCL is sequences, not stills.** Smear frames, the manga-panel cut in
   episode 1, the register shifts, the Pillows needle-drops carrying transitions. A still
   loses most of it. Even a good screencap set would under-represent it.
2. **The practical route** is you capturing frames yourself while watching, or naming
   timecodes and I build a shot list around them. If you grab frames, drop them in
   `motion/flcl/` and they'll appear in the viewer automatically.

Same constraint applies to every film/anime reference below marked **[hard]**.

---

## Proposed precedents, by axis

### Line, contour, cel-shading — the Borderlands question, answered better

- **Jet Set Radio** (2000) **[get]** — origin of playable ink-outline cel shading, the reason
  Borderlands looks how it does. Also graffiti and multilingual Tokyo type, so it double-counts
  on `type`. Steam-sourceable.
- **Guilty Gear Xrd / Strive** (Arc System Works) **[get]** — the technical benchmark: 3D
  models with hand-tuned normals and deliberately *stepped* animation so they read as 2D. The
  GDC talk on it is the single most useful technical document in this whole space. Steam-sourceable.
- **Ōkami** (2006) **[get]** — sumi-e brushwork as a render mode. **The most on-thesis game
  reference that exists for this project** — East Asian ink tradition surviving a 3D pipeline —
  and still not collected. I'd put this at the top of the list.
- **Sable** (2021) **[get]** — Moebius line, minimal fill; contour as the entire style.
- **Hi-Fi Rush** (2023) **[get]** — cel-shading where everything is locked to the beat.
- **Limbo / Inside** **[get]** — pure silhouette staging, zero interior detail.
- **Chinese shadow puppetry 皮影戲** **[get]** — the cultural ancestor of silhouette-first
  reading, and an `emw` + `render` double. Carved translucent hide, backlit, jointed. Connects
  the tile-legibility problem to the board's actual thesis. Commons has material.

### Interface as graphic design

- **Persona 5** (2016) **[get]** — the benchmark; every menu is a design statement.
- **Balatro** **[get]** — juice on a card/tile table, and a lesson in doing a lot with almost no art.
- **Inscryption** **[get]** — tabletop materiality: weight, wear, the feel of a physical card.
- **Casino chips and playing cards** **[get]** — edge printing, registration marks, the graphic
  language of gambling objects. Cheap to source, directly on-topic.
- **Riichi City / Mahjong Soul** **[get]** — the competition. Soul is the counter-reference
  (see `AUDIENCE-AND-TASTE.md`), but you should have its UI on the board to argue against.

### Motion **[hard]** — the FLCL lineage

- **FLCL** (Gainax, 2000) — smear frames, manga-panel cuts, tonal whiplash.
- **Studio Trigger / Imaishi** — *Promare* especially: flat geometric colour, triangular VFX,
  almost no gradients. The closest thing to "VFX as graphic design."
- **Spider-Verse** (2018) — variable frame rate as characterisation; halftone as style.
- **Mind Game** (Yuasa, 2004) — style switching inside a single sequence.

### Things I collected speculatively — calibrate on these

You asked me to grab things I thought you might like. These are the bets, so tell me which
land and I'll push further in that direction:

- **Van Doesburg's cow abstraction** (`grid/destijl/destijl-doesburgcow.jpg`) — a real animal
  reduced to rectangles in documented steps. I think this is a *method* for tile faces, not
  just a style reference. **This is my strongest single bet on the board.**
- **Chinese cash coins** (`grid/chinese`) — circle containing a square hole, seal script in the
  quadrants. The cash coin is the origin of mahjong's 筒 suit, so the round-and-square geometry
  is already native to the game. This makes the Mondrian direction a recovery rather than an import.
- **Terrazzo** (`materials`) — Italian technique, ubiquitous in HK/Singapore/Macau shophouse
  floors. Chip-in-matrix is a cheap and very good texture language for a tile game.
- **Turquoise glazed dragon reliefs** (`materials`) — Chinese architectural ceramic, and the
  closest real-world material to the cyan that shows up in the mahjong accent palette.
- **Bamboo scaffolding** (`cities/hongkong`) — a structural language with no Western equivalent,
  and daylight rather than neon.
- **The daylight half of Hong Kong generally** — wet markets, produce, dai pai dong. Less
  photographed than neon, more specific, and probably the more useful half.

### Deliberately not pursued

- **Generic stylized-PBR** (Dota / LoL / Fortnite / Overwatch) — reasoning in
  `GENERIC-GAME-STYLE.md`. Worth one or two images as a *counter*-reference, nothing more.
- **More Borderlands or Smash** — capped at 8 and 6 per your note.
- **Anime/waifu direction** — occupied by Mahjong Soul and mismatched to the player base.

---

## Related documents

- `RENDER-AXIS-PROPOSAL.md` — the content/render axis split, and the theme-contract idea
- `AI-ART-STRATEGY.md` — what to generate, what never to generate, and the Mondrian argument
- `GENERIC-GAME-STYLE.md` — why Dota/LoL/Fortnite converge, and whether to copy it
- `AUDIENCE-AND-TASTE.md` — gender, familiarity, and who this game is actually for
- `credits.json` — author and licence for every Commons-sourced image

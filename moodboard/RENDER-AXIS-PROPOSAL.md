# Proposal — the moodboard is missing an axis

**Date:** 2026-09-01 · **Status:** proposal, nothing in `README.md` or `inspiration.md`
has been changed. Merge or reject.

---

## The problem

`README.md` and `inspiration.md` are organised entirely around **what the art depicts**:
the east/west collision, HK's spirit, density, multilingual signage. That axis is well
developed — `emw`, `vhk`, `neon`, `type`, `city`, `space`, `future` are all content tags.

Borderlands, Smash Bros and FLCL do not belong on that axis at all. None of them has
anything to do with the east/west collision. They are about **how the art is drawn,
moved, and staged**. There is currently no tag for that. `ui` is the closest, but it is
defined as "screenshots from other games worth stealing from" — too narrow to hold a
rendering technique, and useless for FLCL, which is not a game.

So the board can currently record *that HK neon is a reference* but not *that a hard ink
contour is how you make a small object readable*. For a tile game, the second question is
the more urgent one.

## Why this matters more than usual for MJRC

The hardest art problem in this project is not atmosphere. It is:

> 144 tiles must read instantly, at small size, in 3D perspective, on a table, to players
> who may not know the tileset — and stay readable against any background value.

That is a **rendering and silhouette** problem. Nothing on the current board addresses it.
Two images now in the folder address it directly:

- `games/smash/ui-smash-splash-mr_game_and_watch.png` — a flat black silhouette with a thin
  keyline, holding its own in a roster of fully rendered 3D characters.
- `games/smash/ui-smash-screen-mr_game_and_watch-1.jpg` / `-2.jpg` — the same shape live,
  against a dark stage and against a light wall. It reads both ways. That robustness across
  background value is the exact property to test tile designs for.

And `games/borderlands/ui-bl4-07.jpg` (Claptrap alone, flat dusk light) is the cleanest
single-object contour study in the pull.

## Proposed tags

Content and render are **orthogonal** — an image can be `emw` *and* `render`. The current
README implies one tag per image; that should be relaxed explicitly.

| Tag | Means |
|---|---|
| `render` | How it is drawn: line weight, cel-shading, silhouette, material response |
| `motion` | How it moves or cuts: animation energy, smears, transitions, game feel |
| `present` | How it is staged for the player: roster grids, splash framing, backing panels |
| `palette` | Colour-identity systems: per-player/per-seat hues, duotone treatments |

All four are already applied in `notes.json` and filterable in `viewer.html`.

## The two findings worth acting on

**1. Presentation unifies incompatible styles.** Smash holds 84 mutually incompatible art
styles — Minecraft voxel, Game & Watch silhouette, Tekken photorealism, Kingdom Hearts
anime — in one coherent roster. It does this *not* by homogenising the art but by making
the presentation rules identical: same 3/4 dynamic pose, same weight-forward stance, same
key light, same outline weight, same crop. If MJRC ever wants multiple tile-face art sets
(traditional / modern / guest artist) without fragmenting the product, this is the
mechanism.

**2. A shipping colour-identity system, complete.** `fighter.json` carries a per-fighter
brand colour (`#d04c4a`, `#f9da4a`…) *and* the fighter's name in EN / 日本語 / 繁體 / 简体
in the same record. The `bg.jpg` files show that colour applied: a flat duotone treatment of
the character's world used as a backing panel — magenta for Inkling, deep red for Joker,
neutral grey for Game & Watch, which proves it degrades gracefully for characters with no
colour. That is a complete answer to "every player gets a seat colour, and the colour
propagates into the UI." Roster data is saved at `games/smash/fighter-roster.json` and
rendered in the viewer's **Roster palette** tab.

Note the second one is *also* a `type` reference — a multilingual roster UI shipping
繁體 and 简体 alongside English is precisely what the existing `type` tag is about. It is
the one place where the game pull touches the original thesis.

---

## Proposed additions to `inspiration.md`

### Line, silhouette and cel-shading — `render`

- **Jet Set Radio (2000)** — the origin of playable ink-outline cel shading, and the reason
  Borderlands looks the way it does. Bonus: graffiti and multilingual Tokyo type make it a
  `type` hit too, and it fits the existing Tokyo "method, not vocabulary" section.
- **Guilty Gear Xrd / Strive (Arc System Works)** — the technical benchmark: 3D models with
  hand-tuned normals and deliberately *stepped* animation so they read as 2D anime. If MJRC
  ever renders 3D tiles that must feel 2D, this is the reference, and the GDC talk on it is
  the single most useful technical document in this whole space.
- **Ōkami (2006)** — sumi-e brushwork as a render mode. Directly an `emw` + `render` double:
  East Asian ink tradition surviving translation into a 3D pipeline. Arguably the most
  on-thesis game reference that exists for this project, and it is not currently on the board.
- **Sable (2021)** — Moebius line work, minimal fill; pure contour as the entire style.
- **Hi-Fi Rush (2023)** — modern cel-shading where every element is locked to the beat.
- **Limbo / Inside (Playdead)** — pure silhouette staging, no interior detail at all.
- **Chinese shadow puppetry (皮影戲)** — the cultural ancestor of silhouette-first reading,
  and an `emw` + `render` hit. Carved translucent hide, backlit, articulated at joints. This
  is the reference that connects the tile-legibility problem to the board's actual thesis,
  and it should probably be the first thing hunted.

### Interface as graphic design — `present`, `ui`

- **Persona 5 (2016)** — the benchmark. Every menu is a graphic-design statement; diagonal
  compositions, aggressive type, motion on every transition. Joker is already in the pull.
- **Balatro** — already on the board; keep, specifically for juice on a card/tile table.
- **Inscryption** — tabletop *materiality*: weight, wear, the feel of a physical card.
- **Casino chip and playing-card design** — edge printing, registration marks, the graphic
  language of gambling objects. Cheap to source, directly on-topic, currently absent.
- **Vintage mahjong tile photography** — bone-and-bamboo and early bakelite sets, worn
  edges, hand-carved and hand-painted faces, the colour drift of old inks. **This is the
  single most on-topic reference class for the game and the board has none of it.** Fix
  before adding any more game screenshots.

### Animation energy — `motion`  *(the FLCL lineage)*

FLCL is a good instinct and it sits precisely on the axis this proposal is arguing for.
What is worth stealing from it is not the plot or the character designs but the *editing
and frame economy*:

- **FLCL (Gainax, 2000)** — smear frames and extreme in-between distortion; whole sequences
  cut as static manga panels; abrupt register shifts from slapstick to stillness; the Pillows
  needle-drops carrying scene transitions. The manga-panel sequence in episode 1 is the
  specific thing to study — it is a game-UI idea sitting in an anime.
- **Studio Trigger / Hiroyuki Imaishi** — *Gurren Lagann*, *Kill la Kill*, *Promare*. The
  direct FLCL descendant (Imaishi animated on it). **Promare** especially: flat geometric
  colour, triangular VFX, almost no gradients — the closest thing to "what if VFX were
  graphic design." Compare against `ui-bl4-11.jpg`, whose shattered-glass VFX are reaching
  for the same idea.
- **Spider-Verse (2018)** — variable frame rate as characterisation, halftone dots and
  chromatic aberration as style rather than post-processing.
- **Mind Game (Yuasa, 2004)** — style switching *within* a single sequence without losing
  coherence. The animation counterpart to the Smash pluralism finding above.

FLCL also happens to reinforce the Tokyo section already in `inspiration.md`: Western
alt-rock as the score, South Park-style cutaway gags, US comics panelling — a Japanese work
absorbing Western form on its own terms. Method, not vocabulary.

---

## What was actually collected

58 images, 56.6 MB, all annotated, under `games/`:

- `games/borderlands/` — 31 files. Borderlands 3 (8 screenshots) and Borderlands 4
  (17 screenshots), plus store banners. Source: Steam store API, 1920×1080.
- `games/smash/` — 27 files. 18 transparent-background splash renders chosen for art-style
  *range* rather than roster completeness, 6 in-game screenshots, 3 duotone backing panels,
  and `fighter-roster.json`. Source: smashbros.com official asset paths.

Nothing was collected for FLCL — there is no clean programmatic source, and the useful
references there are *sequences*, not stills. Best handled by pulling specific frames by
hand, or by noting timecodes.

## Structural changes made

- Game art went into `games/<title>/` rather than the flat root. The README's "one flat
  folder" rule was written for phone dumps of HK reference; a 58-file programmatic pull
  would have buried those. **Say the word and I will flatten it** — the viewer groups by
  directory either way.
- `notes.json` is canonical and hand-edited; `viewer.html` is derived and regenerable via
  `build_viewer.py`. Images with no note still appear, flagged "unannotated", so nothing
  dropped into the folder can go missing silently.
- `.gitignore` already covers this: `moodboard/*` with `!moodboard/*.md`, so the binaries
  and `viewer.html` stay local while the `.md` files are tracked. `notes.json` is **not**
  tracked under the current rule — if the annotations are worth keeping in git, add
  `!moodboard/notes.json` and `!moodboard/build_viewer.py`.

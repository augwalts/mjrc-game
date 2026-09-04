# Synthesis

**Updated 2026-09-02** · 435 images, 9 sections, 13 documents. This page is the argument; the
tabs are the evidence. Canonical source is `SYNTHESIS.md` — edit it and rerun `build_viewer.py`.

## The three conclusions

Each was reached **twice, by unrelated routes.** That double-arrival is the only reason to
trust them, and it's the most useful thing on the board.

![competing chessmen designs, 1897](chess/chess-atf-chessmen-1897.jpg "1897: many incompatible piece vocabularies at once — where mahjong tile faces still are") ![the Staunton standard](chess/chess-chess-game-staunton-no-6.jpg "1849: height hierarchy and distinct crowns. No ornament carries information") ![Game & Watch in Smash](games/smash/ui-smash-splash-mr_game_and_watch.png "A character reduced to flat silhouette, holding its own beside photoreal ones") ![INSIDE](games/inside/ui-inside-01.jpg "97.5% hue-concentrated — shape carrying an entire game")

**1. Silhouette and differentiation before detail.** Arrived at independently by the Staunton
chess set (1849, board-game manufacturing), Kinneir & Calvert's road signage (1957, tested at
real distances in a car park), Game & Watch (1980, LCD segment limits), and Halo (AAA, twenty
years apart — what survived the fidelity increases was the silhouettes and faction colours, not
the textures). Four disciplines, four eras, one finding. **For MJRC: design tile faces against
the confusable pairs first — 東/車, 發/白 at size, and the mid-count 筒/索 tiles that differ only
by object count — and let beauty follow.**

![Van Doesburg cow abstraction](grid/destijl/destijl-doesburgcow.jpg "The method: a real animal reduced to rectangles in documented steps") ![Mondrian, New York City II](grid/destijl/destijl-mondrian-new-york-city-ii.jpg "The grid built from coloured lines, no black rules") ![Chinese cash coin](grid/chinese/chinese-guihe-qishou-bird-worm-seal-script-coin-charm-zsbeike-01.jpg "Circle, square, four quadrants — and the origin of the 筒 suit") ![Stardew Valley](games/stardew/ui-stardew-01.jpg "Hand-placed pixels on a 16px grid — the same argument from the other end")

**2. Constructed beats rendered.** Mondrian/De Stijl and Stardew Valley reach the same place from
opposite ends of the culture. Vector and pixel work is cheap, versionable, diffable, and
structurally impossible for a generative model to fake. It is also the only art direction here
you can execute alone, today, with no budget and no disclosure obligation.

![Wan Chai platform calligraphy](mtr/mtr-dsc-1361-43477877692.jpg "灣仔 brushed at architectural scale — the calligraphy leg of the contract") ![Quarry Bay mosaic](mtr/mtr-hk-qb-quarry-bay-station-wall-green-color-tiles-october-20.jpg "The mosaic leg: many greens, not one flat fill") ![Choi Hung rainbow platform](mtr/mtr-hk-wtsd-ngau-chi-wan-choi-hung-mtr-station-platform-n-name.jpg "The colour leg: 彩虹 means rainbow, so the identity colour means something")

**3. A theme contract is how one system yields many identities.** The MTR (colour + mosaic +
calligraphy → 90-odd station identities, across decades and many architects) and Chess.com
(user-selectable board themes and piece sets) both ship it. **This is simultaneously the answer
to AI slop, to artist collaboration, and to "how do I inject new aesthetic languages" —
one mechanism, three problems.** *See the bias warning below before trusting this one.*

## What you pushed

Your interventions changed the board's shape more than mine did.

![Art Deco American mahjong set](mahjong/mahjong-daza-mahjong-art-deco-american-mahjong-tiles-no-ads.jpg "Your mahjong folder: 1920s Deco tiles — the C→W injection this project sits on") ![old vs new tiles](mahjong/mahjong-oldvnewmj1.jpg "What 'authentic' actually looks like: warm yellowed age against cold modern white") ![bamboo scaffolding](cities/hongkong/hongkong-bamboo-scaffolding-gloucester-road-1901569032.jpg "Your call that scaffolding is a colour — 5.7% of HK pixels, and no Western equivalent")

| Your call | What it changed |
|---|---|
| **"Two examples of like 100"** | Restructured everything: many references × few images, not the reverse. Borderlands cut 71→8, Smash 27→6 |
| **Vintage mahjong sets** | The subject was missing entirely. Now 33 images and the anchor of the board |
| **Palette from photography, not games** | Killed my games-palette premise; produced the measured house palette |
| **Your HK colour vocabulary** | Concrete, scaffolding, netting green, fruit, clay, jade, taxi red, temple gold — became 17 named swatches with measured hex |
| **"Shanghai is drab, more geometry than colour"** | Confirmed quantitatively: highest concrete (23.1%), missing whole colour categories |
| **Mondrian** | Became conclusion #2 and the strategic art direction |
| **"Don't draw anime"** | Now a rule with a mechanism attached |
| **The AI question generally** | Produced `AI-ART-STRATEGY.md`, `AI-DEFAULTS.md`, and the whole test log |
| **"Hard assets to modify, not generation from thin air"** | This is exactly what production practice converged on. You got there independently |
| **MTR signage** | Became conclusion #3's strongest evidence |
| **Traffic-sign typography** | Led to Prison Gothic, the best single answer to "how do we not feel AI" |
| **FLCL** | Still uncollected — no legitimate source. Your capture needed |

## What I pushed

Flagged so you can discount it. These are mine, not yours, and several are bets rather than
findings.

- **The render/content axis split.** The original board only had vocabulary for *what a thing
  depicts*, not *how it's rendered*. I added `render`/`motion`/`present`/`palette`. Not yet
  merged into your README.
- **BL2 over BL4.** I argued the real reference is 2012, where contour and hatching are baked
  into the diffuse — not the newer games where lighting replaced line.
- **Van Doesburg's cow.** My strongest single bet on the board: a real animal abstracted to
  rectangles in documented steps, as a *method* for tile faces rather than a style reference.
- **Chinese cash coins → the 筒 suit.** The dots suit depicts stacked coins, so circle-and-square
  geometry is already native to mahjong. This makes the Mondrian direction a recovery rather
  than an import — which is convenient for an argument I was already making.
- **Jade = tile green.** Measured: tiles `#00875a`, jade `#19987c`. The strongest link on the
  board between the game's object and its culture.
![ChatGPT 13 Orphans](ai-tests/aitest-chatgpt-13-orphans.png "7.8% dark. Restrained on one axis only — and it is the free one") ![Inscryption](games/inscryption/ui-inscryption-01.jpg "84.2% dark, zero neutral grey, and it still reads calm. Darkness does the work") ![Ōkami](games/okami/ui-okami-01.jpg "34.8% dark, 78.2% hue-locked — rich rather than loud")

- **Darkness as the load-bearing axis.** After my first hypothesis failed (below), testing 16
  shipped games showed good art direction is restrained on ≥2 of {saturation, darkness, hue},
  and darkness is the one AI refuses: 4.4% and 7.8% versus 12–85% for shipped games.
- **Prison Gothic and Staunton** were my finds from your prompts — you asked for typography and
  chess.com; I went to prison-made road signs and 1849. Both are load-bearing now.

## Where I was wrong

- **"Missing neutral ground" was wrong.** I told you the AI images failed on neutral grey.
  Testing 12 shipped games falsified it — Ōkami, Sifu, Stray and Inscryption all score *worse*
  than the AI images. The real axis is darkness. Corrected in place.
- **"AI can't count" was wrong.** I said ChatGPT rendered 九索 as six bamboo. Zoomed in, it's
  correctly nine. The hand is 13/14, not 12/14, and the single error is 一索 — the tile whose
  convention breaks its suit's pattern. **Models learn the regularity and miss the exception**,
  which is a better and more general finding.
- Guessed the wrong MTR calligrapher (it's Abe Au, on Paoletti's team). Shipped a duplicate tab.

## Bias warning

**I proposed the theme contract before I found the evidence for it.** The MTR and Chess.com both
turned up *after* I'd argued for it in `RENDER-AXIS-PROPOSAL.md`, and I was looking for
confirmation when I found them. Two independent confirmations is genuinely good — but I'm not a
neutral observer of that idea, and you should stress-test it rather than take it from me.

Second: **Wikimedia Commons shaped the collection.** I chose it because it's the only large
source that's openly licensed, queryable and carries attribution — but it skews documentary and
utilitarian. That's why raw palettes came back grey, and why `PHOTOGRAPHERS.md` exists. The board
under-represents *beautiful* photography of these cities, and that's my sourcing decision, not
a fact about the cities.

## Unresolved

- **"Not photorealistic" vs "as realistic as possible."** I resolved this as *authenticity, not
  fidelity*. You haven't said whether that lands.
- **No tile has been drawn.** Every conclusion points at the tile set and none of it is tested.
  The whole board is theory until a face exists at 40px on a phone at 30°.
- **FLCL, Prison Gothic specimens, Chess.com themes, Fortnite** — all need manual capture. Prison
  Gothic is urgent: 500–600 signs remain and they're being replaced.
- 390 of 435 images are unannotated. Deliberate — you're still calibrating.

## What I'd do next

1. **Draw one tile face.** 發, hardest glyph, as vector. Test at 40px, 30°, on a phone in bad
   light. That single test either validates or kills conclusion #1.
2. **Write the theme contract as a standards manual** — the MTR proves that form survives decades
   and many hands, and it gates everything about artist collaboration.
3. **Build a Mondrian/De Stijl theme end-to-end.** It needs no generation at all, so it isolates
   the architecture from the art-sourcing question entirely.
4. **Score every candidate image for darkness before shipping it.** Under 10% is a fail.

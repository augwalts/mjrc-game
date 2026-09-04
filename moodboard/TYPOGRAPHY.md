# Wayfinding typography — the research vein

**Date:** 2026-09-01 · Prompted by: *"train stations in Hong Kong, they have very special
signage"* and *"go find research on typography from train stations and traffic signs, there is
a lot of history there."*

There is, and it's the **most directly relevant research tradition to MJRC that exists** —
more so than any game reference on this board.

---

## 0. Why this is the right vein

Wayfinding typography is the engineering discipline of **legibility under constraint**: read at
distance, at speed, at an angle, in bad light, by a tired reader who may not be a native
speaker, with no second chance and real consequences for failure.

That is precisely the mahjong tile problem — read at 40px, at a 30° table angle, at speed, by
players who may not read Chinese. **The difference is that wayfinding actually tested it.**
Game art mostly intuits legibility; transit design measured it, in car parks, at real distances,
with committees and reports behind it. That body of work is free to borrow.

## 1. Hong Kong

### Prison Gothic (監獄體) — the standout find

Hong Kong's road signs have been **handmade by prison inmates since the 1970s**, at Pak Sha Wan
Correctional Institution (informally Stanley Prison), where roughly eighty inmates work across
two signage rooms.

In 2016 **Gary Yau** founded the **Road Research Society**, which located, documented and
digitised the characters on around **600 signs** made between the 1970s and 1990s, releasing
them as a font called **Prison Gothic** — about **8,000 Chinese characters** extrapolated from
those 600 collected specimens. Only 500–600 of the original signs still stand.

**The critical detail: the human error is the identity.** The characters are lop-sided, tilted,
occasionally wider or smaller than they should be — and that irregularity is exactly what
people love and what the digitisation preserved.

**This is the concrete answer to "how do we make it not feel AI-generated."** What makes Prison
Gothic beloved is precisely what generative work cannot produce: *accumulated human
inconsistency with a consistent hand behind it.* Note the distinction, because it's the whole
point — not random noise, but one maker's systematic deviation, repeated across thousands of
instances. A tile set drawn with one hand's consistent quirks will read as authentic in a way a
geometrically perfect one never will, and it cannot be faked by a model that has no hand.

It's also a perfect east/west artifact in its own right: **British Transport typeface for the
Latin, hand-cut Chinese by prison labour, set together on one sign.**

### Hong Kong road signs generally

- Follow **UK conventions** — a legacy of British administration — with Traditional Chinese added.
- **Transport Medium** on dark grounds, **Transport Heavy** on light: identical usage to the UK.
- Signs from the 2000s–2010s drifted to **Arial Narrow or Helvetica**, sometimes with a modified
  `l`. A visible degradation of the system.
- Signs built **after 2016 increasingly resumed Transport**; some new expressways use Transport
  Heavy on dark grounds.

That drift-and-return is itself instructive: a design system decays when the institution forgets
why it chose what it chose. Which is an argument for writing the reasoning down — see §3.

### The MTR

The design DNA was set by the first chief architect, **Roland Paoletti**, and is explicitly
three things: **bold colour, mosaic, and calligraphy.**

- **Colour** — every station has a signature colour, chosen so passengers recognise their stop at
  a glance. Choi Hung ("rainbow") gets rainbow stripes; Wan Chai olive-green and yellow; Quarry
  Bay teal; Kowloon Tong blue.
- **Mosaic** — small square tiles, chosen for being inexpensive, durable, easy to clean and
  suited to high traffic.
- **Calligraphy** — the station name in large ink-brush script. The Island Line names were brushed
  by **Abe Au**, an architect on Paoletti's team who was an amateur calligrapher. Separately, the
  **MTR Song Script** is a 200-character custom font based on Song-dynasty printed script, owned
  by the MTR Corporation.

**Two findings here matter more than the imagery.**

**(a) The MTR is a working theme contract, fifty years old.** Each station is *a colour + a
mosaic + a calligraphic name* — a three-part spec that generates ninety-odd distinct identities
from one system, executed by different architects across decades, and still coherent. That is
exactly the theme architecture proposed in `RENDER-AXIS-PROPOSAL.md` §5 for letting artist
friends contribute tile sets. **If you want evidence that "an artist ships a folder conforming to
a contract" actually works at scale, this is it** — and it's a Hong Kong system, so the precedent
is on-thesis as well as structurally useful.

**(b) MTR platform walls are Chinese characters built out of a square tile grid.** A mahjong tile
face is a character on a square. An MTR platform wall is a character made *of* squares. It is the
same problem — 方塊字 rendered on a modular grid — at opposite scales, and it links `grid/chinese`,
`grid/destijl` and `mahjong` into one argument. The mosaic close-up in `mtr/` shows the grain.

## 2. The Western canon

### The British line — most relevant, because Hong Kong inherited it

- **Edward Johnston, Johnston (1916)** — London Underground. The first great transit typeface.
- **Eiichi Kono, New Johnston (1979)** — a Japanese designer revised the London Underground face.
  Worth flagging: the same absorb-and-reinject move the Tokyo section of `inspiration.md` describes.
- **Harry Beck (1931)** — the Underground diagram. Topological, not geographic. The landmark
  insight of information design: **accuracy can be traded away when the reader's task differs from
  the map's subject.** Directly applicable to how MJRC displays hands, discards and scoring.
- **Jock Kinneir & Margaret Calvert (1957–63)** — **Transport** and **Motorway** for UK road signs,
  via the Anderson and Worboys committees; later **Rail Alphabet** for British Rail (1965).
  Calvert also drew the pictograms — the "children crossing" girl based on herself, the cow based
  on one from her relatives' farm.
  **Their method matters more than their letterforms:** they tested at real distances in real
  conditions, and established that **mixed case beats all caps at distance**, because word shape
  aids recognition before letters are resolved.

### Continental and American

- **Adrian Frutiger, Frutiger (1975)** — designed for Charles de Gaulle Airport: legible at an
  angle, at distance, in poor light. The purest "engineered for wayfinding" typeface.
- **DIN 1451** — German road signs; an engineering standard rather than a designed face, and it
  reads like one.
- **Massimo Vignelli / Unimark, NYC Subway Graphics Standards Manual (1970)** and the 1972 diagram.
  The **standards manual as a form** is the thing to study here — how a visual system is written
  down so other people can execute it without the author present.
- **Highway Gothic / FHWA series**, and **Clearview (2004)** — the attempted US replacement and the
  long argument over whether it measurably improved legibility. A cautionary tale about claiming
  improvements you haven't tested.

## 3. What MJRC should actually take

1. **Test at the real condition.** Kinneir and Calvert tested in a car park at real distances.
   Test tile faces at 40px, at 30°, on a phone, in poor light. A face that reads beautifully at
   1000px on your monitor has proved nothing.
2. **Differentiation over beauty.** Wayfinding faces are designed so confusable pairs cannot be
   confused. MJRC's confusable pairs are known and specific: **東/車**, **南/雨**, **發/白** at
   small size, and the mid-count 筒 and 索 tiles that differ only by object count. Design against
   the confusions first and let beauty follow.
3. **Silhouette before detail.** "Mixed case beats caps because word shape is read first" is the
   same finding as the Game & Watch and INSIDE studies, reached independently by a different
   discipline seventy years ago. Convergent evidence for silhouette-first tile design.
4. **Bilingual setting is already solved here.** HK signage has decades of tested practice setting
   Latin and Traditional Chinese together — matching optical weight, size and baseline across two
   writing systems with entirely different construction. MJRC has exactly this problem in its UI.
   Collect specimens rather than reinventing it; `mtr/` has a start.
5. **Write the theme contract as a standards manual.** That is the proven form for handing a
   visual system to other people, and the MTR proves the contract itself works across decades and
   many hands.
6. **Irregularity as identity.** Prison Gothic. One hand's consistent deviations, repeated. This is
   both the most authentic-feeling option and the one option that is structurally un-fakeable — see
   `AI-DEFAULTS.md`.

## 4. On the board

`mtr/` — 27 images: Wan Chai's brushed 灣仔 platform wall, Quarry Bay mosaic grain, Choi Hung's
rainbow, Wan Chai olive columns, Kowloon Tong blue, bilingual emergency and wayfinding signage,
and a network diagram.

**Still to collect** — none of this is on Commons, so it needs manual hunting:

- **Prison Gothic specimens** — Road Research Society, and photograph surviving signs directly.
  ~500–600 remain and they are actively disappearing. This is the most urgent item on the board.
- **Adonian Chan / Trilingua** — the 北魏楷書 Beiwei revival already in `inspiration.md`; the
  shop-sign counterpart to the road-sign story.
- **NYC Subway Graphics Standards Manual** — reissued in facsimile; buy it for the form, not the content.
- **Kinneir & Calvert** — Calvert's own writing and the Design Museum material.
- **MTR station name calligraphy**, station by station — best captured in person.

---

## Sources

- [Road Research Society digitises road signs into Prison Gothic font — Dezeen](https://www.dezeen.com/2022/08/23/prison-gothic-font-typeface-road-research-society/)
- ['Prison Gothic': Hong Kong road signs reborn as new font — HKFP](https://hongkongfp.com/2022/07/30/prison-gothic-hong-kong-road-signs-reborn-as-new-font/)
- [Designers are racing to digitize Hong Kong's disappearing street typography — Quartz](https://qz.com/2190091/prison-gothic-the-handmade-font-used-in-hong-kongs-road-signs)
- [Gary Yau | Hong Kong Road Signs and Prison Gothic Font Preservation — We Are HKers](https://www.wearehkers.com/main-english/gary-yau-hong-kong-road-signs-and-prison-gothic-font-preservation)
- [Road signs in Hong Kong — Wikipedia](https://en.wikipedia.org/wiki/Road_signs_in_Hong_Kong)
- [Transport (typeface) — Wikipedia](https://en.wikipedia.org/wiki/Transport_(typeface))
- [Margaret Calvert — Wikipedia](https://en.wikipedia.org/wiki/Margaret_Calvert)
- [The MTR Turns 45: Mosaic Tiles, Chinese Script and a Railway to Remember — Zolima CityMag](https://zolimacitymag.com/mtr-45-mosaic-tiles-chinese-script/)
- [MTR Typeface design — MTR Corporation](https://www.mtr.com.hk/en/corporate/publications/mtr-typeface-design.html)
- [MTR: Art in Station Architecture — MTR Corporation](https://www.mtr.com.hk/en/customer/community/art_architecture.html)
- [How Hong Kong's MTR stations got their colours — Cathay](https://www.cathaypacific.com/cx/en_PH/inspiration/hong-kong/mtrs-colourful-stations.html)

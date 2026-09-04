# Palette — your reading, measured

**Date:** 2026-09-01 · Your colour vocabulary from reviewing the board, turned into named
swatches with hex values **measured from the photographs**, not invented. Live in the
viewer's **Palette** tab; canonical values in `notes.json` → `curatedPalette`.

**Method:** for each named concept, find pixels inside a hue/saturation/value window, then
sample at the **88th percentile of saturation × value**. That last step matters — averaging
matched pixels returns mud (`#962c2c` for taxi red), because most instances of any colour in
a photograph sit in shadow. The percentile gives the colour as *seen*.

---

## Your readings, checked

Everything you named is genuinely present. Three of your calls were sharper than I expected:

**"Shanghai colours are pretty drab… very much about geometry than colour" — confirmed,
quantitatively.** Shanghai has the highest concrete share of any city (23.1% vs HK's 17.4%)
and is *missing entire colour categories*: no signage-yellow, no temple-gold, no jade, no
neon of any kind. Nine concepts register versus Hong Kong's fourteen. Your instinct to treat
it as a geometry reference rather than a colour reference is the correct use of that folder.

**"Singapore has some more colours… some blue… colonial blue" — confirmed, and it's a
specific blue.** Singapore measures `#3d83aa`, distinctly lighter and more cyan than Hong
Kong's navy `#2c4691`. Singapore is also the greenest city in the set (jungle-green 5.9%).
That blue-green pairing against terracotta is genuinely a different city palette, not a
variation on HK.

**Tokyo, which you didn't ask about but which falls out of the same measurement:** it's the
blue city (colonial-blue 6.6%, plastic-blue 2.8%, both highest), and its signage colours are
nearly **pure primaries** — `#db392e` red, `#fddc0b` yellow — where Hong Kong's are warmer
and dirtier — `#ab3116`, `#f6c64e`. **That difference is the main HK/Tokyo tell.** If the
game's signage reads too clean and too primary, it will drift Japanese.

## The palette

| Swatch | Name | Source | Share | Note |
|---|---|---|---|---|
| `#c84934` | taxi red | HK | 1.9% | As lit on the street; purer off the paint chip (~`#c8102e`) |
| `#ab3116` | signage red | HK | 3.9% | Warmer/dirtier than Tokyo's `#db392e` |
| `#f6c64e` | signage yellow | HK | 1.7% | The yellow half of the pair you flagged |
| `#e3cf70` | temple gold | temple | 5.2% | Wong Tai Sin / Man Mo gilding |
| `#c8a35e` | incense tan | temple | 12.0% | Hanging coils — most present colour in the temple set |
| `#b58319` | bamboo tan | HK | 5.7% | Raw scaffolding poles |
| `#4ab659` | scaffold green | HK | 1.0% | The safety netting. Tiny area, huge identity |
| `#397944` | jungle green | HK | 1.9% | Foliage |
| `#19987c` | **jade** | jade | 15.2% | See below |
| `#21c7c8` | tile cyan | mahjong | 1.9% | The turquoise on real tile faces |
| `#c25709` | fruit orange | HK | 3.6% | Market produce |
| `#784c1b` | clay brown | clay | 4.3% | More ochre/amber than "brown" |
| `#bf1930` | plastic red | plastic | 10.5% | Stools and tubs — most saturated folder on the board |
| `#3a6dbe` | plastic blue | HK | 1.1% | |
| `#e35e8b` | neon magenta | HK | 0.8% | A rare accent in reality — use it that way |
| `#3d83aa` | colonial blue | SG | 4.4% | The Singapore/HK discriminator |
| `#777777` | concrete grey | HK | 17.4% | The canvas, not a colour |

## The finding worth acting on

**Mahjong tile green and jade are effectively the same colour.** Tiles measure `#00875a`;
jade measures `#19987c`. That is the strongest link on the board between the game's own
object and the culture around it — the green on a tile face isn't an arbitrary ink choice, it
sits in the jade family, and jade is *the* Chinese material for a precious carved object.

Practical consequences:

1. **Don't let the tile green drift toward emerald or toward the generic "mahjong felt
   green."** It should read as jade, and jade is slightly blue-shifted and desaturated
   relative to a pure green.
2. **`#21c7c8` tile cyan is being lost by everyone.** Real tile faces carry a
   turquoise-cyan that digital sets flatten into a generic blue. Keeping it is close to free
   and it will read as more authentic than any amount of texture work.
3. **Jade also gives you a material story**, not just a hue: translucency, depth, a polished
   surface that shifts with viewing angle. That is a rendering direction for tiles that costs
   nothing to specify now and is impossible to retrofit later.

## How to use this palette

- **Concrete grey is the ground.** 17% of Hong Kong. Everything else is an accent against it.
  A palette that treats grey as a colour to avoid will not read as this city.
- **Restraint on at least two of {saturation, darkness, hue} — and darkness matters most.**
  An earlier version of this note claimed the key metric was neutral grey. Testing against
  twelve shipped games **disproved that** (Ōkami, Sifu, Stray and Inscryption all have less
  neutral ground than the AI images do). What actually separates them is *darkness*: every
  shipped game clears 12% of pixels below 0.28 value, most clear 30%, and real Hong Kong
  photography is 34% — while the AI images are 4.4% and 7.8%. The fix for a too-loud image is
  almost always **to add shadow**, not to desaturate. Full table in `AI-DEFAULTS.md`.
- **Respect the area proportions.** Neon magenta is under 1% of real pixels. The cyberpunk
  cliché fails precisely because it inverts these ratios — it makes the 1% colours into
  fields and drops the amber and grey that actually carry the place.
- **Warm-dirty, not cool-clean.** The single most transferable rule from the measurement:
  Hong Kong is amber, red-orange and grey. Cyan-magenta is Tokyo-adjacent, and pure primaries
  are Tokyo outright.

## Gaps

- **Scaffold-netting green** is under-collected — one usable image. It exists inside the
  bamboo scaffolding photos in `cities/hongkong`, but a dedicated set would be better.
- **Red A plastics** specifically (the red tubs and lampshades in `inspiration.md`) aren't on
  Commons as a category. Needs manual sourcing.
- **Colour-forward photography generally** — see `PHOTOGRAPHERS.md`. Wikimedia Commons skews
  documentary and utilitarian, which is exactly why the raw dominant palettes came back grey.

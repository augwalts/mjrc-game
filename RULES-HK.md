# 香港舊章 — Hong Kong Old Style, as this engine plays it

**Status:** written 2026-08-26 against the code as it stands. This is a *description of the
implementation*, cross-checked against the sources the implementation cites — not an
independent authority on HK mahjong. Where the code and the sources disagree, the
disagreement is printed rather than resolved.

**Scope.** Everything a human needs to check the engine by hand: the tile set, the deal, the
turn, every claim, every faan, every payment, and the match. Terminology follows
[`TERMINOLOGY.md`](TERMINOLOGY.md) — Hong Kong only, no borrowed vocabulary.

**Nothing here has been signed off by a strong HK player.** DESIGN.md §8 makes that the P0
exit requirement and it has not happened. Every golden-hand fixture in the repo still carries
`provisional: true`.

---

## 0. How to read this document

Every rule carries one of four tags.

| Tag | Meaning |
|---|---|
| **[UNIVERSAL]** | Every HK table plays it this way. Getting it wrong is a bug, not a preset. |
| **[HOUSE]** | Houses genuinely differ. The entry names which preset takes which side. |
| **[NEEDS VALIDATION]** | Nobody in this project has decided, or the decision has no source behind it. |
| **[NOT IMPLEMENTED]** | Named in DESIGN.md or in a source, but no code produces it. Unreachable in play today. |

Two presets ship, both defined in [`rulesets/src/presets.ts`](rulesets/src/presets.ts):

- **`hkos-standard`** — canonical HK Old Style. The default (`DEFAULT_RULESET_ID`).
- **`liu`** — the LIU family house variant the Python prototype implemented. ENGINE-AUDIT §1
  records that its faan values are genuinely non-standard. It is a private-table preset,
  not a second opinion about canonical HK.

Sources cited by name throughout:

- `mjrc-admin/reference/hk-scoring-calculator.xlsx` (the *FanSlang* sheet) — the house
  reference. It carries six systems side by side: **MJ Time · MJB · Dragon Soc · LIU ·
  Wikipedia · L2**. Where they disagree, this document says so.
- `mjrc-app/web/src/data/hk-scoring.ts` — the same table transcribed into TypeScript.
  Read by this project, never imported.
- `DESIGN.md` §4 (ruleset), §5.2 (state machine), §8 (validation).
- `ENGINE-AUDIT.md` §1 (what the Python prototype does and does not do).
- The golden-hand fixtures under `engine/test/golden/` — 121 authored cases. Several
  rulings exist **only** there.

---

## 1. The tile set

**144 tiles [UNIVERSAL].** 34 kinds at four copies each (136) plus 8 bonus tiles at one copy
each. Enforced by `assertWallIntact` in [`engine/src/wall.ts`](engine/src/wall.ts).

The engine addresses tiles as a flat `0-41` id space ([`engine/src/types.ts`](engine/src/types.ts)):

| Ids | Group | Tiles |
|---|---|---|
| 0-8 | 萬 characters *maan* | 1萬 … 9萬 |
| 9-17 | 索 bamboo *sok* | 1索 … 9索 |
| 18-26 | 筒 circles *tung* | 1筒 … 9筒 |
| 27-30 | 風 winds *fung* | 東 南 西 北 |
| 31-33 | 三元 dragons *saam jyun* | 中 red · 發 green · 白 white |
| 34-37 | 花 flowers *faa* | 梅 plum · 蘭 orchid · 菊 chrysanthemum · 竹 bamboo |
| 38-41 | 花 seasons | 春 spring · 夏 summer · 秋 autumn · 冬 winter |

`SCORING_KINDS = 34` — flowers are never part of a hand, never melded, never discarded.
`meldShapeError` rejects a flower in a meld outright.

**Honours never form runs [UNIVERSAL].** 中發白 in a row is three loose tiles; 東南西 likewise.
`isRun` requires `isSuited`. The house reference calls this out twice as the standard
beginner error.

**么九 terminals and honours** = the 1s and 9s of each suit plus all seven honours —
13 kinds (`isTerminalOrHonour`). These are the tiles 混么九, 清么九 and 十三么 are built from.

### Bonus tile ownership [UNIVERSAL]

A bonus tile belongs to the seat whose **wind** matches its position in its group of four:

| Seat wind | Flower | Season |
|---|---|---|
| 0 東 | 梅 | 春 |
| 1 南 | 蘭 | 夏 |
| 2 西 | 菊 | 秋 |
| 3 北 | 竹 | 冬 |

`flowerSeat(t) = (t - 34) % 4`, compared against `ctx.seatWind` in
[`engine/src/scoring.ts`](engine/src/scoring.ts). Someone else's flower pays nothing —
**and still denies you 無花**. That asymmetry is load-bearing in a dozen golden cases.

---

## 2. Seats, the deal, and the wall

### Seats and winds [UNIVERSAL]

Turn order runs **東 → 南 → 西 → 北**, which is `seat + 1` in the engine's indexing. Your
上家 *soeng gaa*, the seat that plays immediately before you and the only seat you may
chow from, is `seat + 3` (`leftOf` in [`engine/src/melds.ts`](engine/src/melds.ts)).

Seat winds are recomputed every hand from the dealer:

```
seats[i].wind = (i - dealer + 4) % 4
```

so **the dealer is always 東**. Seat *index* and wind *index* therefore coincide only while
seat 0 is dealing. The golden fixtures assume that identity throughout (it is the only way
a fixture can express "claimed from the seat on my left", since `Meld.from` is a seat index);
in a live match they diverge the moment the deal rotates. Do not read a fixture's `from`
as a wind.

### The deal [UNIVERSAL in shape, engine-specific in one detail]

`dealHand` in [`engine/src/reducer.ts`](engine/src/reducer.ts):

1. Build the wall from the hand's seed. 144 tiles, deterministic.
2. Deal **4-4-4-1** starting at the dealer and going clockwise: three rounds of four tiles
   to each seat, then one tile each. Thirteen tiles per seat, 52 consumed. [UNIVERSAL]
3. Flower replacement, seat by seat, starting at the dealer (§3).
4. The dealer takes their fourteenth tile as a **normal head draw**.

Step 4 is where the engine departs from the physical game. At a table the dealer is simply
dealt fourteen. Here the fourteenth is drawn, because `drawn` is the field a 自摸
declaration names as the winning tile, and a dealer holding fourteen indistinguishable tiles
could not name one. This is a modelling convention with two visible consequences:

- The dealer's fourteenth can itself be a flower, and is replaced from the tail like any
  other draw.
- 天糊 — the dealer's dealt hand already complete — becomes a statement about thirteen
  tiles plus the first draw, not about fourteen dealt tiles. See §8 and the 天糊 entry;
  the engine never actually detects it. **[NEEDS VALIDATION]**

### The wall [HOUSE — and this engine takes the minority side]

`wallIndex` walks forward from the head; `wallEnd` walks backward from the tail.
Live tiles remaining = `wallEnd - wallIndex`.

- **Normal draws come off the head.**
- **Replacement draws — flower 花 and kong 槓 — come off the tail 執尾.** [UNIVERSAL]
- **No dead wall is reserved.** All 92 undealt tiles are live; the hand ends when the head
  pointer meets the tail pointer.

Physical HK play reserves a dead wall (commonly 14 tiles) that is never drawn. This engine
reserves none — `ExhaustiveDrawPayload` in
[`protocol/src/events.ts`](protocol/src/events.ts) documents this as "0 under the standard
rule; a house ruleset that reserves tiles ends earlier, hence a number, not a literal."
The payload can *report* a reserve; no preset *sets* one. **[NEEDS VALIDATION]** — the
choice changes the number of draws per hand and therefore the draw rate, which is a
gate-3 metric in DESIGN.md §3.

### Determinism [engine invariant, not a rule]

Every wall comes from `buildWall(seed)` over a mulberry32 PRNG. No `Math.random`, no
`Date.now`, no unordered key iteration anywhere that touches game state. Replay is
re-execution (DESIGN.md §5.5), so any ambient input would rewrite history.

---

## 3. Flowers 花 and replacement draws

**[UNIVERSAL]** A bonus tile is never held. It is revealed, set aside, and replaced from the
**tail** of the wall. A replacement that is itself a bonus tile is replaced in turn, without
limit.

The engine fixes an **ordering** the physical game leaves loose, because replay must
reproduce wall consumption exactly (DESIGN.md §5.2):

- At the deal, seats are processed **in seat order starting from the dealer**.
- Within a seat's hand, flowers are replaced **lowest tile id first** (`replaceHandFlowers`).
- A flower arriving as a draw is replaced immediately, before anything else happens
  (`replaceDrawnFlowers`).

**[NEEDS VALIDATION]** No source in the repo says HK tables resolve simultaneous flowers in
this order. It is a determinism decision, not a sourced ruling. It is invisible at a
physical table and completely visible in a seeded replay.

If the wall runs out mid-replacement, the hand ends as an exhaustive draw 流局.

### Bonus tiles and the win

- A replacement draw that completes your hand scores **槓上開花** — and, because a
  replacement is a wall draw, **自摸 stacks on top**. hk-scoring.ts is explicit that this
  applies to a flower replacement as well as a kong replacement. [UNIVERSAL]
- **[NOT IMPLEMENTED]** The engine's `winOnKongReplacement` flag (`onKongReplacement` in
  `MatchState`) is set by `drawKongReplacement` only. A flower replacement clears it. So a
  hand won on a *flower* replacement scores 自摸 but **not** 槓上開花 today, contradicting
  the house reference.

### Bonus-tile hands not played

- **花糊 *faa wu*** — all eight bonus tiles as an instant win. The house reference marks it
  "instant win under some rules"; no compared system prices it. **[NOT IMPLEMENTED]**, and
  `honours-all-eight-bonus-tiles` records that if the state machine ever implements it, that
  fixture becomes unreachable rather than wrong. **[HOUSE]**
- **Seven of eight bonus tiles** — extra faan at some tables, robbing the eighth at others.
  Not priced by any compared system. **[NOT IMPLEMENTED] [HOUSE]**

---

## 4. The turn

`AWAIT_DISCARD(seat)` is the resting state. From it the seat on turn may:

| Action | Effect |
|---|---|
| `discard` | Opens a claim window on the tile (§5). |
| `concealedKong` 暗槓 | Declare four in hand; replacement draw from the tail; stay on turn. |
| `addedKong` 加槓 | Add the fourth to your own exposed pung; opens a 搶槓 window (§6). |
| `declareWin` 自摸 | Win on the tile you just drew. |

A seat that has drawn holds its new tile in `drawn`, apart from the hand, until it discards
or folds it in. Discarding the tile just drawn is **摸切** *mo cit* — "drew and cut" — and the
event records it (`drawAndCut`), because it is a strong tell and therefore research material.

`legalActions(state, seat)` is the complete, authoritative list. Nothing else is accepted by
`applyAction`. Bots and clients both read it, so a rule that is not in `legalActions` does
not exist.

---

## 5. Claims 上 碰 槓

### What can be claimed [UNIVERSAL]

| Claim | Characters | Needs | From which seat |
|---|---|---|---|
| chow | 上 *soeng* | two tiles forming a run with the discard | **上家 only** — the seat to your left |
| pung | 碰 *pung* | two matching tiles in hand | any seat |
| exposed kong | 明槓 *ming gong* | three matching tiles in hand | any seat |
| win | 食糊 *sik wu* | a completed shape worth the minimum | any seat |

**Chow is only ever available from the player to your left.** This is enforced in three
places so no caller can forget it: `chowOptions` returns empty for any other source,
`meldError` rejects the meld, and `makeChow` validates on construction.

The two kong forms that are **not** claims — declared on your own turn, from your own tiles:

| Form | Characters | Needs | Concealed? |
|---|---|---|---|
| concealed kong | 暗槓 *am gong* | all four copies in hand | **yes** — the only declared meld that stays concealed |
| added kong | 加槓 *gaa gong* | the fourth copy, plus your own exposed 碰 of it | no — it inherits the pung's exposure |

`isConcealedSet` returns true for 暗槓 alone. 加槓 keeps the `from` seat of the pung it grew
from: the fourth tile came out of your own hand, but the meld was exposed the moment you
claimed the first three.

**A kong fills one set slot, not more.** Four tiles on the table, one of the hand's four
sets. This is why a winning hand counts to 14 with kongs counted as three
(`meldTileCount`, and `case.ts`'s `assertWellFormed`).

### Claim priority [UNIVERSAL]

```
win  >  kong / pung  >  chow
```

`CLAIM_PRIORITY` in `types.ts`. Ties break to **the nearest seat clockwise from the source**
— the discarder, or the kong declarer in a 搶槓 window. The engine implements this by
building the offer list in clockwise order from the source and comparing strictly, so the
array order *is* the tie-break.

A note the reducer makes and this document repeats because it is easy to mis-model: **kong
outranking pung never decides anything between two seats.** A kong claim needs three copies
in hand and a pung claim two; five copies of a tile do not exist. The ordering only matters
when one seat holds both options.

### Only one seat can win a discard [HOUSE — the engine plays the common form]

If two seats both have a legal win on the same discard, the nearest clockwise takes it and
the other is declined as *outranked*. DESIGN.md §5.2 describes multiple simultaneous
winners as configurable with nearest-seat as the default; **[NOT IMPLEMENTED]** — only the
single-winner form exists. There is no config flag.

### A refused win does not kill the contest

If the nearest winner's hand is below the minimum, the win is **refused visibly** (§7), the
refusal is published, and the remaining claims are re-resolved. A seat that declares a
2-faan hand cannot rob a legitimate 碰 from the seat behind it. This is the engine's own
ruling; it follows from DESIGN.md §5.2's "refused below-minimum wins emit visible events"
but no source states it as a rule of play. **[NEEDS VALIDATION]**

### What happens after a claim

- **碰 and 上 take the turn with no draw.** The claimed tile is your fourteenth; you owe a
  discard immediately. [UNIVERSAL]
- **明槓 draws a replacement from the tail first**, then you discard. [UNIVERSAL]
- The claimed tile is removed from the discarder's pile — it is on the table now, in your
  meld, and is not a tile anyone can win on later. [UNIVERSAL]
- Play resumes from the claimant. Seats between the discarder and the claimant are skipped.
  [UNIVERSAL]

### Claim windows and timing [engine/transport contract, not a rule of play]

A claim window prompts **only the seats that hold a legal claim**, per seat and privately,
and carries a fixed minimum duration. If the window closed the instant everyone answered,
the length of the pause would leak whether anyone was holding a claim.

The reducer is pure and has no clock, so it splits the job: it stamps a `deadlineTs` and
resolves as soon as every prompted seat has answered. **The transport owes the other half**
— it must not release the resolution before `deadlineTs`, and at the deadline it must submit
`pass` for seats that stayed silent. Neither half works without the other.

---

## 6. 搶槓 Rob the Kong

**[UNIVERSAL]** A player waiting on the fourth copy of a tile may take it as it is added to
an exposed pung.

**Available on 加槓 only.** `opensRobKongWindow` returns true for `addedToPung` kongs and
nothing else, and the rule is enforced twice — at the meld level and in `doAddedKong`.

- **暗槓 is never robbable.** It is laid down complete; the tile was never offered to the
  table. Classic HK Old Style. Some other rule families allow robbing a concealed kong to
  complete a thirteen-orphans hand — **[HOUSE]**, not played by either preset, no flag.
- **明槓 is not robbable.** The tile it was built on already had its own claim window.

Inside the window **only win claims are offered**. `openClaimWindow` with `robKong: true`
filters every seat's options down to `[{ kind: "win" }]` or nothing.

Outcomes:

- **Robbed** — the fourth tile comes back off the 加槓, which reverts to the 碰 it grew
  from, and the declarer's melds are archived as they truly stood, not as they briefly
  appeared. The winner scores **搶槓** (1 faan) and the win counts as a win from a discard,
  not a self-draw.
- **Not robbed** — the 加槓 stands and its replacement is drawn from the tail.

---

## 7. Winning, and the 3-faan minimum

### The four ways to win

| Route | Characters | Notes |
|---|---|---|
| from a discard | 食糊 *sik wu* | scores no 自摸 |
| self-draw | 自摸 *zi mo* | +1 faan |
| on a kong replacement | 槓上開花 | +1 faan, **and** 自摸 on top — the replacement is a wall draw |
| by robbing a kong | 搶槓 | +1 faan, counts as a discard win |

`hasWinningShape` decides the shape: four sets and a pair, with declared melds fixed in
place, plus the two shapes that have no such reading (十三么 and 九蓮寶燈, detected on the
tile multiset directly).

**No seven-pairs branch in canonical HK.** `decompose.ts` and `ready.ts` both say so
explicitly. 七對子 exists in the catalogue only because the LIU preset prices it — see §8.

**Four copies in hand are not a kong.** A kong exists only when it was *declared*. Four
copies sitting quietly in a concealed hand read as a triplet plus a spare tile that must
belong to another set. [UNIVERSAL]

### The 3-faan minimum [UNIVERSAL that a floor exists; 3 is the common value]

**A complete shape worth fewer than 3 faan may not be taken.** Both presets set
`minimumFaan: 3`. A hand that cannot reach it is 雞糊 — a chicken hand.

What actually happens (DESIGN.md §5.2, `doDeclareWin` and `resolveWindow`):

1. The seat declares. The shape is legal, so the declaration is accepted for scoring.
2. `score()` returns `legal: false`.
3. A **`refusedWin` event is emitted** carrying the whole scorer input and the whole
   `ScoreResult` — every award, the raw total, the minimum it missed. This is deliberate:
   DESIGN.md §5.2 calls a refused win a teaching moment, not a silent rollback.
4. Play continues. On a self-draw refusal the seat **still owes a discard**. On a claim
   refusal the contest re-resolves among the remaining claims.
5. `refusedSelfDraw` remembers the seat and tile, so `legalActions` stops offering the same
   below-minimum declaration on the same tile. A bot cannot spin, and the log carries the
   teaching moment once rather than a thousand times. Cleared the moment the seat's tiles
   change.

### What counts toward the floor [HOUSE]

Both presets count **bonus tiles** toward the 3 faan. Tables that play 花唔計番 — the
minimum must come from the hand itself — score several golden cases one to two faan lower
and must refuse wins that both presets allow. Cases `basic-own-flowers-lift-over-floor`
and `basic-no-flowers-lift-over-floor` exist precisely to make the difference visible.
Neither preset implements 花唔計番; there is no flag. **[NEEDS VALIDATION]**

The dealer gets **no dispensation** from the floor (`honours-others-flowers-score-nothing`
is a dealer hand at 2 faan, refused). [UNIVERSAL]

---

## 8. The faan table 番

Values below are exactly what `rulesets/src/presets.ts` loads. A blank cell means the preset
**does not play that pattern** — a `faanTable` is both the price list and the enable list, and
a pattern with no entry leaves the breakdown entirely rather than showing as 0.

The **Systems** column summarises the six compared systems in the house reference
(MJ Time · MJB · Dragon Soc · LIU · Wikipedia · L2). `*` in that sheet means "limit hand",
`—` means "not listed".

### 番子 Honour melds

| 中文 | Jyutping | English | hkos | liu | Universality |
|---|---|---|---|---|---|
| 三元牌 | *saam1 jyun4 paai2* | Pung of Dragons | 1 | 1 | **[UNIVERSAL]** all six systems agree |
| 門風 | *mun4 fung1* | Pung of Seat Wind | 1 | 1 | **[UNIVERSAL]** all six agree |
| 圈風 | *hyun1 fung1* | Pung of Round Wind | 1 | 1 | **[UNIVERSAL]** all six agree |

Three rules that carry more weight than their faan:

- **One award per set, and the awards repeat.** Three dragon pungs are three separate
  1-faan awards. `applySubsumption` filters rather than deduplicates for exactly this reason.
- **A kong of an honour is worth what the pung is worth** — in all six systems. There is no
  separate kong id. The kong shape earns a replacement draw, not extra faan. [UNIVERSAL]
- **Seat wind and round wind score independently.** East seat in East round scores **both**,
  for 2 faan off one pung. This is the "doubled wind" and it is deliberate.
  (`honours-dealer-self-draw-double-east`.) [UNIVERSAL]

### 花 Bonus tiles

| 中文 | Jyutping | English | hkos | liu | Universality |
|---|---|---|---|---|---|
| 正花 | *zing3 faa1* | Own Flower | 1 | 1 | **[UNIVERSAL]** |
| 正花 | *zing3 faa1* | Own Season | 1 | 1 | **[UNIVERSAL]** |
| 一台花 | *jat1 toi4 faa1* | All Four Flowers | 2 | 2 | **[UNIVERSAL]** all six agree |
| 一台花 | *jat1 toi4 faa1* | All Four Seasons | 2 | 2 | **[UNIVERSAL]** all six agree |
| 無花 | *mou4 faa1* | No Bonus Tiles At All | 1 | 1 | **[HOUSE]** all six price it; tables that ignore bonus tiles score 1 lower |

- **一台花 does not subsume 正花.** Holding all four flowers means holding your own, so
  `1 + 2 = 3` — which is the total HK tables actually quote. **[HOUSE]**: some houses score a
  complete set as a flat 2. Both `honours-all-four-flowers` and
  `honours-all-four-seasons-with-dragon-pung` carry the split.
- **無花 is mutually exclusive with every other bonus award**, so no subsumption is needed.
- **`flowers: []` is never neutral.** An empty bonus set scores 無花. Golden cases that are
  not about bonus tiles hold *another seat's* flower, which pays nothing and keeps 無花 off
  the sheet.

### 食糊條件 Winning conditions

| 中文 | Jyutping | English | hkos | liu | Universality |
|---|---|---|---|---|---|
| 自摸 | *zi6 mo1* | Self-Draw | 1 | 1 | **[UNIVERSAL]** |
| 門前清 | *mun4 cin4 cing1* | Fully Concealed | 1 | 1 | **[HOUSE]** — MJ Time does not award it at all |
| 海底撈月 | *hoi2 dai2 lau4 jyut6* | Out on the Last Tile (last **draw**) | 1 | 1 | **[UNIVERSAL]** per hk-scoring.ts — but see the dispute below |
| 河底撈魚 | *ho4 dai2 lau4 jyu4* | Out on the Last Discard | 1 | 1 | **[HOUSE]** — many houses fold it into 海底撈月 |
| 搶槓 | *coeng2 gong3* | Rob a Kong | 1 | 1 | **[UNIVERSAL]** all six agree |
| 槓上開花 | *gong3 soeng5 hoi1 faa1* | Win on a Replacement Tile | 1 | 1 | **[UNIVERSAL]** all six agree |
| 槓上槓 | *gong3 soeng5 gong3* | Win by Double Kong | 8 | — | **[HOUSE]** — Wikipedia alone prices it |

- **[NEEDS VALIDATION] 海底撈月's universality is disputed inside the repo.** `hk-scoring.ts` prices it 1 in all six systems; `limit-last-tile-lifts-over-floor`'s own note says "two of the six compared systems do not list 海底撈月 at all", under which that hand is 2 faan and **may not be taken** — legality, not just value, turning on a situational award. Both cannot be true. §12D.
- **門前清 asks whether anything was *claimed*, not how the last tile arrived.** A 暗槓
  keeps the hand concealed. Winning on someone's discard does **not** spoil it. [UNIVERSAL
  where the pattern is played at all]
- **門前清 is dropped on hands that are concealed by definition** — patterns marked
  `concealedOnly`, sourced to hk-scoring.ts: "Hands that are concealed by definition … do not
  get this extra fan." The scorer implements this as a filter in `price()`, gated on the
  house actually playing the limit hand, rather than as subsumption — so a house that does
  not play 九蓮寶燈 keeps paying 門前清 on that shape. **[HOUSE]**: houses that stack them
  score one higher, and above the cap it makes no difference to the payout, only to the
  award list the replay viewer shows.
- **海底撈月 and 河底撈魚 are twins, never both.** 海底 is the wall's final **draw**;
  河底 the final **discard**. The scorer takes 海底 in preference.
- **[NOT IMPLEMENTED]** The reducer hardcodes `onLastTile: false` on every win from a
  discard, and never sets `onLastDiscard` or `doubleKong` at all. In live play today:
  海底撈月 is reachable only by self-drawing the wall's last tile; **河底撈魚 and 槓上槓 are
  unreachable**. Both are fully implemented in `score()` and covered by fixtures — the state
  machine simply never reports the facts.

### 牌型 Hand patterns

| 中文 | Jyutping | English | hkos | liu | Systems | Universality |
|---|---|---|---|---|---|---|
| 平糊 | *ping4 wu4* | All Chows / Common Hand | 1 | 1 | 1·1·1·1·1·1 | **[UNIVERSAL]** |
| 對對糊 | *deoi3 deoi3 wu4* | All Pungs | 3 | 3 | 3·3·3·3·3·3 | **[UNIVERSAL]** |
| 混一色 | *wan6 jat1 sik1* | Half Flush | 3 | 3 | 3·3·3·3·3·3 | **[UNIVERSAL]** |
| 清一色 | *cing1 jat1 sik1* | Full Flush / Pure Hand | 6 | 7 | 6·6·6·**7**·6·**7** | **[HOUSE]** — the most pervasive split in the table |
| 混么九 | *wan6 jiu1 gau2* | Mixed Terminals | 1 | 1 | —·—·1·1·1·1 | **[HOUSE]** — MJ Time and MJB do not list it |
| 七對子 | *cat1 deoi3 zi2* | Seven Pairs | — | 4 | 4·4·4·4·4·4 | **not HK Old Style** — see below |
| 小三元 | *siu2 saam1 jyun4* | Small Three Dragons | 5 | 4 | —·—·4·4·**5**·4 | **[HOUSE]** 4 vs 5 |
| 大三元 | *daai6 saam1 jyun4* | Big Three Dragons | 8 | 6 | 10*·10*·6·6·**8**·6 | **[HOUSE]** 6 / 8 / limit |
| 小四喜 | *siu2 sei3 hei2* | Small Four Winds | 6 | 10 | 10*·10*·—·10*·**6**·10* | **[HOUSE]** — four of six make it a limit hand |
| 大四喜 | *daai6 sei3 hei2* | Big Four Winds | 10 | 13 | 10*·10*·6·13*·**10**·13* | **[HOUSE]** |

- **七對子 is not classic HK Old Style.** It is in the catalogue only because the LIU preset
  the Python prototype implements prices it at 4, and `hkos-standard` deliberately omits it.
  `decompose.ts` and `ready.ts` have no seven-pairs branch at all, so under `hkos-standard`
  the shape is simply not a winning hand. ENGINE-AUDIT §1 lists this among the reasons LIU
  "is a different game."
- **平糊's eyes.** A minority of houses disqualify an honour pair as the eyes for 平糊.
  **[HOUSE]**, not modelled, no flag. Several golden cases carry the alternative arithmetic
  in `contested` — `basic-all-chows-honour-eyes-contested` turns *legality* on it.
- **清一色 does not literally contain 混一色** (a full flush holds no honours), but a
  detector written as "one suit plus honours" fires on both, so `fullFlush` subsumes
  `halfFlush` as a safety measure. The scorer's own detector is written as an exclusive
  `if/else` and never emits both.
- **混么九 does not subsume 對對糊**, even though it implies it. Every surveyed system
  prices 混么九 at 1 as a bonus stacked on 對對糊's 3. [UNIVERSAL where played]

### 爆棚 Limit hands

| 中文 | Jyutping | English | hkos | liu | Systems | Universality |
|---|---|---|---|---|---|---|
| 四暗刻 | *sei3 am3 hak1* | Four Concealed Pungs / 坎坎糊 | 13 | 13 | 10*·10*·—·13*·**10**·13* | **[HOUSE]** — hkos departs from its column, see below |
| 字一色 | *zi6 jat1 sik1* | All Honours | 10 | 13 | 10*·10*·—·13*·**10**·13* | **[HOUSE]** |
| 么九 / 清么九 | *jiu1 gau2* | All Terminals | 7 | 13 | 10*·10*·—·13*·**7**·13* | **[HOUSE]** — 7 is an outlier, see below |
| 九蓮寶燈 | *gau2 lin4 bou2 dang1* | Nine Gates / 九子連環 | 13 | 13 | 10*·10*·—·13*·**4†**·13* | **[HOUSE]** — hkos departs from its column |
| 十三么 | *sap6 saam1 jiu1* | Thirteen Orphans | 13 | 13 | 10*·10*·—·13*·13·13* | **[UNIVERSAL]** as a limit hand |
| 十八羅漢 | *sap6 baat3 lo4 hon3* | All Kongs / Four Kongs | 10 | 7 | 10*·10*·7·7·**10**·13* | **[HOUSE]** — genuinely split |
| 綠一色 | *luk6 jat1 sik1* | Jade Dragon / All Green | — | — | 10*·10*·5**·—·—·— | **[HOUSE]** — neither preset plays it |
| 紅一色 | *hung4 jat1 sik1* | Ruby Dragon / All Red | — | — | 10*·10*·5**·—·—·— | **[HOUSE]** |
| 白一色 | *baak6 jat1 sik1* | Pearl Dragon / All White | — | — | 10*·10*·5**·—·—·— | **[HOUSE]** |
| 天糊 | *tin1 wu4* | Heavenly Hand | 13 | 13 | 10*·10*·—·13*·13·13* | **[UNIVERSAL]** as a limit hand |
| 地糊 | *dei6 wu4* | Earthly Hand | 13 | 13 | 10*·10*·—·13*·13·13* | **[HOUSE]** — limit in most houses, well below 天糊 in some |

`hkos-standard` takes the Wikipedia column whole rather than picking a favourite value per
row — a table assembled from six sources is a table no house plays. It has **exactly two
named departures**, both forced by the golden suite:

1. **四暗刻 13, not 10.** Four of six systems star it as a limit hand; the two golden cases
   are called uncontested at 13, where a 10 would land them on 11 and 12.
2. **九蓮寶燈 13, not 4.** Wikipedia alone prices it 4 and adds 清一色's 6 for 10 effective;
   the other four pay a flat limit, and the golden limit family needs 13. `patterns.ts`
   subsumes 清一色 to match the flat reading. Under the additive reading the flush would be
   additive instead and `limit-nine-gates-*` becomes an uncapped 11, not a capped 13 — a
   payout difference, not just a display one.

And **one value that is an outlier and is not a decision**:

> **清么九 at 7.** Four of six systems star it as a limit hand. 7 is kept because the golden
> flush family pins it there (its two cases total 8) while the limit family declares 10, and
> the suite cannot be satisfied both ways. `presets.ts` labels this an **open question, not a
> decision**. **[NEEDS VALIDATION]** — this is the single widest house-to-house gap anywhere
> in the table: 8 versus 13 on the same fourteen tiles.

Other limit-hand notes:

- **Several limit *names* do not reach the limit on their own** under `hkos-standard`.
  字一色 at 10 plus 對對糊's 3 is exactly 13. An engine that hard-codes "limit hand ⇒ 13"
  fails `limit-all-terminals-*` and nothing else.
- **四暗刻 on a discard [HOUSE].** The classic form is won by self-draw. The common HK
  allowance is that a discard may complete it *only if all four pungs are already sitting
  complete and the discard fills the pair*. A pung completed by someone else's discard is
  not concealed. The engine encodes the majority reading (`concealedTripletCount` is told how
  the win arrived); a minority read "concealed" as "never melded" and would pay limit.
  `kongs-four-concealed-pungs-discard-completes-pair` is the family's contested case.
- **十八羅漢 does not subsume 四暗刻.** Houses split on whether concealed kongs count toward
  four concealed pungs, and the golden suite records a hand awarding both. **[HOUSE]**
- **The three suit-dragon hands are absent from both presets on purpose.** The house
  reference reads "—" for four of six systems. A house that plays them should price them
  rather than have a value invented here. Note the safety property in `applySubsumption`:
  a pattern the ruleset does not play may not subsume one it does, or a green hand at a
  table with no 綠一色 entry would score **zero**.
- **[NOT IMPLEMENTED] 天糊 and 地糊 are unreachable in live play.** `score()` implements
  both — 天糊 requires `ctx.heavenly && ctx.isDealer`, 地糊 requires
  `ctx.earthly && !isDealer && !selfDraw` — but the reducer never sets `heavenly` or
  `earthly`. They are exercised only through direct `score()` calls in the golden suite.
- **[HOUSE] 天糊 and a flower replacement.** If the dealer's opening fourteen included a
  flower and the *replacement* completed the hand, strict tables refuse 天糊 and score the
  hand as ordinary (3 faan in `limit-heavenly-hand-after-flower-replacement`). 13 versus 3 is the largest
  disagreement in that family. Moot today, since 天糊 is unreachable.
- **[HOUSE] 地糊's definition.** Some houses require the **dealer's** first discard; others
  accept any discard before the winner's first draw.
- **[HOUSE] Exclusive limit hands.** Some houses treat limit hands as exclusive — you name
  one, it pays the limit, and 天糊 and 十三么 never appear on a sheet together. The engine
  stacks them. The payout is 13 either way; the **award list** differs, and the replay viewer
  renders the list.

### Patterns deliberately not in the catalogue

| Pattern | Status |
|---|---|
| Per-kong bonus faan | **[HOUSE]** — some HK tables pay a flat bonus per kong, sometimes only for 暗槓. No id. `kongs-two-concealed-kongs-score-nothing-extra` records the 4-vs-6 swing. |
| 三槓子 three kongs | **[HOUSE]** — no row in the house reference; many HK tables pay it. No id. |
| 純正十三么 the thirteen-sided wait | **[HOUSE]** — cannot be expressed under a 13 cap; both forms pay 13. Would need a separate id at a higher-limit table. |
| 人和 non-dealer first-draw win | **[HOUSE]** — not canonical HKOS, neither preset implements it. Recorded so the omission reads as a decision. |
| 小綠一色 etc. (small suit-dragon hands) | **[HOUSE]** — Dragon Society's 5 is this version. Not modelled. |

---

## 9. Subsumption — what swallows what

The rule, applied consistently in [`rulesets/src/patterns.ts`](rulesets/src/patterns.ts):

> **A pattern subsumes another when the other is part of *this* pattern's definition — the
> tiles it names, not merely tiles it happens to contain.**

So 大三元 (pungs of all three dragons) swallows the dragon pungs it names, and hk-scoring.ts
confirms it outright: the 4-5 faan shown for 小三元 "typically already INCLUDES the fan for
the two dragon pungs". But 字一色 (winds and dragons only) names no particular honour set, so
it does **not** swallow dragon or wind faan.

Three mechanical properties that matter when checking a breakdown by hand:

1. **Subsumption is direct, and the closure walks.** 大三元 lists 小三元, which lists the
   dragon pungs; `subsumptionClosure` returns all of them. Never read `subsumes` straight.
2. **Multiplicity is preserved.** `applySubsumption` filters the list; it does not
   deduplicate. Three dragon pungs stay three awards.
3. **Only patterns the house plays may subsume.** `applySubsumption` takes the enabled set
   for exactly this reason (see the 綠一色 trap in §8).

### The table as implemented

| Pattern | Directly subsumes |
|---|---|
| 清一色 fullFlush | 混一色 halfFlush |
| 小三元 smallThreeDragons | 三元牌 dragonPung |
| 大三元 bigThreeDragons | 小三元, 三元牌 |
| 大四喜 bigFourWinds | 小四喜 |
| **小四喜 smallFourWinds** | **nothing** — see the dispute below |
| 四暗刻 fourConcealedPungs | 對對糊, 門前清 |
| 十八羅漢 allKongs | 對對糊 |
| 字一色 allHonours | 混一色, 混么九 *(detector safety)* |
| 么九 allTerminals | 混么九 *(detector safety)* |
| 九蓮寶燈 nineGates | 清一色 |
| 十三么 thirteenOrphans | nothing |
| 天糊 / 地糊 | nothing |
| 七對子 sevenPairs | 門前清 |
| 綠一色 / 紅一色 / 白一色 | 混一色, 對對糊, 三元牌 |
| 槓上槓 winByDoubleKong | 槓上開花 |
| 一台花 allFlowers / allSeasons | **nothing** — `1 + 2 = 3` is the quoted total |
| 混么九 mixedTerminals | **nothing** — stacked on 對對糊's 3 |

### The subsumption rulings that are still in dispute

These are not stylistic. **They are currently failing tests**, and the two sides are the
catalogue and the fixtures. See §12.

| Question | `patterns.ts` / `scoring.ts` says | The golden fixtures say |
|---|---|---|
| Does 字一色 swallow 對對糊? | **No** — it is a pattern about the *class* of tile and takes no credit for the shape. Contrast 十八羅漢, which **is** the four-set shape. | **Yes** — `flush.ts` and `honours.ts` headers both state it subsumes 對對糊. |
| Does 清么九 swallow 對對糊? | **No**, same reasoning. | **Yes**. |
| Does 小四喜 / 大四喜 swallow 門風 and 圈風? | **No** — those are *positional* faan, depending on who you are and which round it is, not on the shape. | **Yes** — "a four-winds hand always contains the seat and round wind, so the pattern's price is the price of those pungs." |

The 字一色 note in `patterns.ts` cites the golden fixtures as awarding both; the fixtures
award only one. The 小四喜 note cites `honours.ts` as fixing the ruling "for the whole
suite"; `honours.ts` fixes it the other way. **One of the two was written against a draft of
the other.** Neither is obviously right, and no external source settles it. **[NEEDS
VALIDATION]** — this is the top item to put in front of a strong HK player.

---

## 10. Payment 銃碼

### The cap 爆棚 [UNIVERSAL]

`faan = min(rawFaan, 13)`. Both presets set `limitFaan: 13`.

`ScoreResult` reports **both** totals and a `capped` flag, because ENGINE-AUDIT §1 records a
display bug in the Python prototype where the breakdown summed uncapped while the total was
capped. `rawFaan` is the sum of `awards` exactly; `faan` is that clamped; `capped` says which
one the player is being paid. Three golden cases land on **exactly 13 uncapped**, which is
the case an off-by-one in the cap check gets wrong in the direction nobody notices.

### `hkos-standard` — the doubling ladder

Base chips by faan, from `mahjong.wikidot.com`'s HKOS table, cross-checked against the curve
registry in `mjrc-app/web/src/data/rulesets.ts` (`doubling_2fan_smooth`). Doubles every
2 faan, interpolating the odd step at 1.5×:

| faan | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| base | 1 | 2 | 4 | 8 | 16 | 24 | 32 | 48 | 64 | 96 | 128 | 192 | 256 | 384 |

- **Win from a discard:** the discarder pays **2 × base**. Nobody else pays.
- **Self-draw 自摸:** **each of the three losers pays base.** The winner collects 3 × base.

Worked, at the floor and the cap:

| faan | discard win (discarder pays) | self-draw (each pays / winner collects) |
|---|---|---|
| 3 | 16 | 8 / **24** |
| 6 | 64 | 32 / **96** |
| 13 爆棚 | 768 | 384 / **1152** |

Total on a discard win is 2 units against 3 units on a self-draw — the 1.5 ratio the
mjrc-app curve registry encodes as its validated 4-vs-6-unit settlement, at half the scale.

### The self-draw settlement — both readings ship [HOUSE]

A house table prints **one figure** in its 自摸 column and does not say what it means. Two
readings are in circulation and both are played:

| Reading | Meaning | Preset |
|---|---|---|
| `perPlayer` | each of the three losers hands over the printed figure; the winner collects 3× | **`hkos-standard`** — canonical HK, 自摸每家 X |
| `total` | the printed figure is the winner's whole collection; the three losers split it | **`liu`** |

`SelfDrawSettlement` in `types.ts` names them and every `PaymentTable` fixes one.
**Every golden-hand case must state which preset it assumes, because the answers differ by
3×.** DESIGN.md §4 flags this as the thing to settle before scoring ships; it was settled by
shipping both, not by picking one.

The evidence for LIU being `total`: all four printed self-draw figures divide by three
exactly (108/156/252/444 → 36/52/84/148), and the `perPlayer` reading would make a 3-faan
self-draw pay 324 against a 92 discard win — 3.5×, which no table plays. The other reading
still ships for houses that read their own column the other way. Chips do not divide, so the
`total` reading **rounds up** in the winner's favour — being short-changed by rounding is the
complaint that starts arguments at a real table.

### `liu` — the flat bracket table

Transcribed from `LIU_FAN_BRACKETS` in
`mjrc-admin/research/probability/core/ruleset.py`. Read as `total`:

| faan | discarder pays | printed 自摸 figure | each loser pays (total ÷ 3, rounded up) |
|---|---|---|---|
| ≤ 2 | 0 | 0 | — *(never reached through a legal win)* |
| 3 | 92 | 108 | 36 |
| 4-6 | 124 | 156 | 52 |
| 7-9 | 188 | 252 | 84 |
| 10-13 | 316 | 444 | 148 |

### 全銃 — the discarder pays alone [UNIVERSAL as the HK default]

On a win from a discard the discarder carries the whole hand. This is the HK default, it is
what LIU plays, and it is the **only** settlement the `PaymentTable` contract can express:
`onDiscard` returns what the discarder pays and there is no hook for the other two seats.

**[NOT IMPLEMENTED]** A spread table — 半銃, where the other two seats also contribute —
cannot be built. `payment.ts` records this as a contract gap.

### 莊 the dealer's double — **[NOT IMPLEMENTED]**

This is the largest gap between the documented ruleset and the code, and it needs to be
read carefully.

- DESIGN.md §4 lists "dealer double" among the things P0 ships.
- The golden suite fixes the **form** it takes: `honours-dealer-scores-no-extra-faan` —
  "莊 doubles the **PAYMENT**, not the faan — no dealer award appears anywhere," and
  `honours-dealer-self-draw-double-east` — "Still no faan for being 莊." That much is
  **[UNIVERSAL]** and the scorer implements it correctly: `WinContext.isDealer` is threaded
  through and is read by nothing except the 天糊 / 地糊 checks.
- **No dealer multiplier exists anywhere in the payment layer.** `settle()` in `reducer.ts`
  uses `t.onDiscard(faan)` and `t.onSelfDraw(faan)` unmodified for every seat.
  `PaymentTable` has no dealer parameter. `winnerCollects` has none either.

**Today the dealer collects and pays exactly what a non-dealer does.** Every chip figure in
this document is the non-dealer figure, and there is no other.

**[NEEDS VALIDATION]** — and note what has to be decided, which is more than "add a ×2".
The common HK formulation is that 莊 pays and receives double: a dealer win doubles what
each loser pays, and a non-dealer's self-draw doubles what the *dealer* pays while the other
two pay single. But nothing in this repo states the incidence. Not DESIGN.md, not the golden
suite, not hk-scoring.ts, not the reference spreadsheet's FanSlang sheet. Someone has to
decide it against a real table before it is written.

### 包 liability — **[NOT IMPLEMENTED]**

`PaymentTable.liabilityRules` is a string array. **The engine reads none of it.** The
documented HK cases carried as text:

- Feeding the third dragon to a hand already showing two dragon pungs — 大三元包.
- Feeding the fourth wind to a hand already showing three wind pungs — 大四喜包.
- Discarding into a hand whose exposed melds are already all one suit — 清一色包.

LIU adds 9-tile and 12-tile 包 penalties per the family house rules; also unimplemented.
`HandEndPayload.loser` is documented to accommodate 包 resolving to a seat, so the event
schema is ready and the rule is not. **[HOUSE]** in its details, **[UNIVERSAL]** that HK
plays some form of 包.

---

## 11. Match structure

DESIGN.md §4 states this section outright, because wind faan and the dealer double are
meaningless without it.

### 連莊 Dealer repeat vs rotation [UNIVERSAL]

```
dealerRepeats = (outcome === exhaustiveDraw) || (winner === dealer)
```

- **The dealer repeats on a dealer win and on an exhaustive draw 流局.**
- Otherwise the deal rotates to `dealer + 1`.
- `dealerStreak` counts consecutive holds. It is recorded and currently pays nothing —
  **[HOUSE]**: many HK tables escalate payment with the streak (連莊 bonuses). No preset
  implements one. **[NEEDS VALIDATION]**

Seat winds are recomputed from the new dealer at every deal, so the dealer is always 東 and
every other seat's wind moves with them.

### 圈 The wind round [UNIVERSAL in principle]

```
cycleComplete = !dealerRepeats && nextDealer === startingDealer
```

The prevailing wind advances when the deal passes the starting dealer's seat a full cycle —
that is, four rotations plus however many repeats happened along the way. 東圈 → 南圈 →
西圈 → 北圈.

### Match length

| `matchLength` | Rounds | DESIGN.md §4 |
|---|---|---|
| `oneWindRound` | 1 | **the default.** 東圈 — 4 rotations plus repeats, ~20-35 min: the mobile-session-compatible unit, and the unit ratings attach to |
| `fourWindRounds` | 4 | full four-wind game, 60-90+ min. A private-table option, not the ranked default |

**[NEEDS VALIDATION]** A consequence worth noticing: the round wind advances and the match
ends at the same moment, so a `oneWindRound` match **never plays a hand in 南圈** — the
`nextRoundWind` computed on the final hand is reported and never used. That is almost
certainly correct for a one-round match, but nothing states it as an intent.

### 流局 Exhaustive draw [UNIVERSAL]

The hand ends when the head pointer meets the tail pointer — the wall is spent with no
winner. **No chips move.** The dealer repeats. The event records every seat's concealed
tiles and `distanceToReady` (聽牌 distance) for the archive and the research corpus.

**[HOUSE], not implemented:** many HK tables settle a draw between ready and unready seats
(聽牌料). Neither preset does; a draw is worth exactly zero to everyone.

A draw can also fire **mid-replacement** — if the wall runs out while a flower or kong
replacement is being drawn, the hand ends there. That is a consequence of reserving no dead
wall (§2) and is invisible at a table that does reserve one.

### Match end

`matchOver` when `roundsCompleted >= target`. Placements 1-4 by chips; ties break by seat
order **from the starting dealer**, so the ordering is stable and reproducible rather than
seat-index-arbitrary.

### Rules the state machine does not yet enforce [NEEDS VALIDATION]

- **Kong declarations near the end of the wall.** Many HK houses forbid declaring a kong
  once the live wall is down to the reserved replacement tiles. This engine reserves nothing
  and forbids nothing, so a kong can be declared on the last live tile and its replacement
  draw is what ends the hand. `kongs-replacement-on-last-tile` records this as two
  splits at once: whether the position is reachable at all, and whether the replacement
  counts as 海底. **The state machine has to settle the first before scoring can settle the
  second.**
- **Four kongs on the table across different hands** — some houses abort the hand. Not
  modelled.
- **Reconnect, disconnect grace, and bot takeover** are transport concerns (DESIGN.md §5.3),
  not rules, and are out of scope here.

---

## 12. Where this document is *not* authoritative

Honest inventory, 2026-08-26. Everything below is a known open item, not a rumour.

### A. Rulings that contradict each other in the tree right now

`npm run typecheck` is green. `vitest run` is **red**: 27 failing tests, of which 20 in
`engine/test/scoring.test.ts` are the golden suite disagreeing with the scorer. These are
not flaky — each is a rules question with two answers checked into the repo. Grouped:

| Conflict | Cases | What has to be decided |
|---|---|---|
| **對對糊 under 字一色 / 清么九** | 5 | Does an all-honours or all-terminals hand also collect 對對糊? `patterns.ts` says yes, the fixtures say no. §9. |
| **門風/圈風 under 小四喜 / 大四喜** | 2 | Do the four-winds patterns swallow the positional wind faan? `patterns.ts` says no, the fixtures say yes. §9. |
| **`ownSeason` vs `ownFlower`** | 6 | The catalogue has a separate `ownSeason` id; all four golden families emit `ownFlower` for both. Same faan, different award list — and the event log stores the list. Pure id-space decision. |
| **LIU 門前清 / 無花** | 2 | `presets.ts` sets LIU `useFlowers: true` and prices `concealedHand` and `noFlowers`; `basic-full-flush-liu-seven` assumes LIU has neither. `kongs-liu-*` adds the substantive point: under LIU every hand is concealed by construction, so 門前清 is a constant +1 carrying no information — either drop it and raise the minimum, or keep it and say so. |
| **九蓮寶燈 detector reach** | 1 | `flush-full-chars-concealed` is a 清一色 the scorer reads as 九蓮寶燈. Correct detection, or over-eager? |
| **混么九 under 大三元** | 1 | `limit-big-three-dragons-caps` is three dragon pungs plus a terminal pung and terminal eyes; the scorer fires 混么九, the fixture does not expect it. |
| **槓上槓 not expressible** | 1 | `GoldenCase` carries no double-kong flag. |

The remaining failures — 3 in `limit.test.ts`, 1 in `bots.test.ts`, 1 in
`tools/port-diff` — are fixture-coverage counts and known prototype defects, not rules
questions. They belong to another workstream.

### B. Rules named in DESIGN.md that no code produces

| Rule | Status |
|---|---|
| **莊 dealer double** | No multiplier anywhere. §10. The single biggest gap. |
| **天糊 / 地糊** | Implemented in `score()`, never triggered by the reducer. |
| **河底撈魚 / 槓上槓** | Same — implemented, never triggered. |
| **海底撈月 on a discard** | Hardcoded `onLastTile: false` on every discard win. |
| **槓上開花 after a *flower* replacement** | The flag is set by kong replacements only, contradicting hk-scoring.ts. |
| **包 liability** | Text only. Engine reads none of it. |
| **Multiple winners on one discard** | Single-winner only; DESIGN.md §5.2's config does not exist. |
| **半銃 spread payment** | Not expressible in the `PaymentTable` contract. |
| **花糊 all-eight bonus win** | Not implemented; a fixture is written to become unreachable if it ever is. |
| **聽牌料 draw settlement** | Not implemented. A draw pays zero. |
| **連莊 streak bonuses** | `dealerStreak` is counted and unused. |

### C. Decisions with no source behind them

- **清么九 at 7** in `hkos-standard` — an outlier value kept only because two golden
  families cannot both be satisfied. `presets.ts` calls it an open question in its own
  comment.
- **Flower replacement ordering** — a determinism choice, not a sourced ruling. §3.
- **No dead wall** — a departure from physical practice that changes the draw rate. §2.
- **The dealer's fourteenth tile is a draw, not a deal** — a modelling convention with
  consequences for 天糊. §2.
- **A refused win does not end the claim contest** — follows from DESIGN.md §5.2's intent,
  stated as a rule nowhere. §5.
- **One-wind-round matches never reach 南圈** — almost certainly right, never written down. §11.

### D. Stale cross-references found while writing this

- `engine/test/golden/honours.ts` header claims a "KNOWN COLLISION" where `patterns.ts` uses
  `dragonPungRed/Green/White`, `seatWindPung` and `roundWindPung`. **Three-quarters stale** —
  `patterns.ts` uses the short ids today. The `ownSeason` half of that note is still live and
  is the 6-case failure above.
- `engine/test/golden/limit.ts` says "河底撈魚 has no id in `rulesets/src/patterns.ts`
  today, so this case names one". **Stale** — `winOnLastDiscard` is in the catalogue and
  priced at 1 in both presets.
- `rulesets/src/presets.ts` says LIU "has no bonus tiles" in one comment while setting
  `useFlowers: true` in the data. See conflict D above.
- `engine/test/golden/limit.ts` says two of the six systems do not list 海底撈月;
  `hk-scoring.ts` prices it 1 in all six. One of the two is wrong and it changes whether a
  golden case is legal at all. §8.

### E. The validation that has not happened

DESIGN.md §8 makes the golden-hand suite the **only** validation source for everything the
Python prototype cannot generate — exposed melds, all three kong forms, flowers, winds,
dealer context, situational faan — and requires that a strong HK player sign the answers off
as the P0 exit gate.

**All 121 fixtures still carry `provisional: true`.** Nothing in this document has been
checked against a human who plays the game.

---

## Appendix — where each rule lives in the code

| Rule area | File |
|---|---|
| Tile identity, suits, 么九, flower ownership | `engine/src/tiles.ts` |
| 144-tile wall, seeded PRNG, integrity check | `engine/src/wall.ts` |
| Meld forms, chow-from-the-left, kong legality, 搶槓 eligibility | `engine/src/melds.ts` |
| Winning shapes, every valid reading, concealed-triplet counting | `engine/src/decompose.ts` |
| 聽牌 distance, live tiles | `engine/src/ready.ts` |
| Pattern catalogue, subsumption | `rulesets/src/patterns.ts` |
| Faan values, enable lists, both presets | `rulesets/src/presets.ts` |
| Chip schedules, self-draw settlements, 包 text | `rulesets/src/payment.ts` |
| Faan detection, cap, minimum | `engine/src/scoring.ts` |
| Deal, wall pointers, flowers, claims, kongs, hand end, match end | `engine/src/reducer.ts` |
| Event contract, redaction | `protocol/src/events.ts` |
| The 121 authored rulings | `engine/test/golden/{basic,flush,honours,kongs,limit}.ts` |

# `mjrc-standard` — the ruleset of record

Written 2026-08-31, updated the same day with the owner's 清一色 ruling.
Everything below is read out of the shipping code (`rulesets/src/presets.ts`,
`rulesets/src/payment.ts`), not from memory.

---

## 1. The one-line answer

> **`mjrc-standard` is canonical Hong Kong Old Style with the limit lowered from
> 13 faan to 10, the faan table clamped to 10 to match, and two ratified
> corrections: 清一色 full flush pays 7 and 么九 all terminals pays 10.**

`MJRC_STANDARD` is `{ ...HKOS_STANDARD, limitFaan: 10, faanTable: <every value
min'd with 10, plus fullFlush: 7, allTerminals: 10> }`.

Clamping the table rather than only the score matters: under a 10-cap house,
"十三么 pays 10" **is the price**. Scoring output is identical either way — any
single award at the cap saturates alone — but the table now tells the truth, and
the bots' route pricing stops valuing limit hands above what they actually pay.

## 2. The provenance chain

```
Wikipedia (the public HK Old Style scoring table)
      ↓  transcribed by another team into
mjrc-app  hk-scoring.ts      — 6 systems side by side, conflicts recorded
      ↓  ONE column taken whole
mjrc-game rulesets/presets.ts  HKOS_STANDARD   ("the Wikipedia column")
      ↓  limit 13 → 10, table clamped
                               MJRC_STANDARD
```

The governing principle, quoted from the file header:

> Each preset here takes **ONE** of those columns whole rather than picking a
> favourite value per row, because a table assembled from six sources is a table
> no house plays.

The Wikipedia column was chosen because it is the only one of the six with a
value for **every** classic pattern. Where it reads "—", the pattern is left out
of the game entirely rather than filled in from a neighbouring system. That is
why 七對子 seven pairs does not exist here: it is not classic HK Old Style.

`hk-scoring.ts` is owned by the parallel scorecard-builder work. It is **read,
never imported** — the game does not depend on that team's file.

## 3. The rules, in full

| | |
| --- | --- |
| minimum | **3 faan** — a hand under 3 cannot be taken |
| limit 爆棚 | **10 faan** |
| flowers | yes, with replacement draws |
| winds | seat wind 門風 and round wind 圈風 each score |
| kongs | all three forms — 明槓 exposed, 暗槓 concealed, 加槓 added |
| dealer | repeats on a dealer win **and on 流局** — ratified, see §5 |
| payment | HK doubling ladder, per-player self-draw settlement |
| 包 liability | 大三元包, 大四喜包, 清一色包 |

### Payment

Base chips by faan: `[1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, …]`.
A discard-in costs the discarder **2×** the table value; a self-draw costs each
of the three losers **1×**. Discard total 2×, self-draw total 3×.

| faan | discarder pays | self-draw, each | self-draw total |
| ---: | ---: | ---: | ---: |
| 3 | 16 | 8 | 24 |
| 4 | 32 | 16 | 48 |
| 5 | 48 | 24 | 72 |
| 6 | 64 | 32 | 96 |
| 7 | 96 | 48 | 144 |
| 8 | 128 | 64 | 192 |
| 9 | 192 | 96 | 288 |
| 10 | 256 | 128 | 384 |

### Faan table as it ships

| faan | patterns |
| ---: | --- |
| 1 | 平糊 allChows · 門前清 concealedHand · 三元牌 dragonPung · 混老頭 mixedTerminals · 無花 noFlowers · 正花 ownFlower · 正花 ownSeason · 搶槓 robbingKong · 圈風 roundWind · 門風 seatWind · 自摸 selfDraw · 槓上開花 winOnKongReplacement · 河底撈魚 winOnLastDiscard · 海底撈月 winOnLastTile |
| 2 | allFlowers · allSeasons |
| 3 | 對對糊 allPungs · 混一色 halfFlush |
| 5 | 小三元 smallThreeDragons |
| 6 | 小四喜 smallFourWinds |
| 7 | **清一色 fullFlush** ← owner ruling |
| 8 | 大三元 bigThreeDragons · winByDoubleKong |
| 10 | 字一色 allHonours · allKongs · **么九 allTerminals** ← owner ruling · 大四喜 bigFourWinds · 地糊 earthlyHand* · 四暗刻 fourConcealedPungs* · 天糊 heavenlyHand* · 九蓮寶燈 nineGates* · 十三么 thirteenOrphans* |

`*` = 13 in `hkos-standard`, clamped to 10 here. Those five plus the two
ratified corrections are the entire difference between the two rulesets.

**One deliberate, documented departure from the column:** 四暗刻 is priced 13 in
`hkos-standard` rather than the column's value, because four of the six surveyed
systems star it as a limit hand rather than pricing it, and the golden suite
fixes it at the limit. Under `mjrc-standard`'s cap it lands on 10 regardless.

---

## 4. The audit's findings, and what was done about them

Your own audit — `RULESET-STANDARDIZATION-PROPOSAL.md` §10, 2026-08-26 — found
that the column labelled *Wikipedia* in `hk-scoring.ts` **does not match
Wikipedia**: five of thirteen values are wrong, several of which you had already
flagged by instinct.

Most wash out here, because anything at 13 clamps to 10 anyway. Checked row by
row, exactly two survived into `mjrc-standard`:

| pattern | was | Wikipedia | status |
| --- | ---: | ---: | --- |
| **清一色 Full Flush** | 6 | **7** | ✅ **corrected to 7 — owner ruling 2026-08-31** |
| **么九 All Terminals** | 7 | **10** | ✅ **corrected to 10 — owner ruling 2026-08-31** |
| 大四喜 Big Four Winds | 10 | 13 | n/a — both cap to 10 |
| allKongs | 10 | 13 | n/a — both cap to 10 |
| 九蓮寶燈 Nine Gates | 13 | 10 | n/a — clamps to 10, agrees |

### 4.1 清一色 — settled at 7

Corroborated three ways: Wikipedia says 7, `LIU` already prices it 7 (`FAAN_LIU`
in `engine/test/golden/limit.ts`), and you said 7 yourself in most places.

**The correction lives in `MJRC_STANDARD`, not `HKOS_STANDARD`, deliberately.**
`hkos-standard`'s job is to be a faithful reading of that one column, warts
included, and the golden suite mirrors it — so it keeps the 6 until the source
table is fixed by the team that owns `hk-scoring.ts`. `mjrc-standard` is the
house ruleset and is allowed its own prices, provided they are *decisions*. This
one now is.

**Measured impact on the shipped bots** (60 matches per arm, `mjrc-standard`,
the mixed ladder):

| | draws | mean faan | 清一色 wins | 混一色 wins |
| --- | ---: | ---: | ---: | ---: |
| fullFlush = 6 | 31.5 % | 5.46 | 16 (4.5 %) | 258 (72.9 %) |
| fullFlush = 7 | 31.5 % | 5.46 | 17 (5.1 %) | 254 (75.8 %) |

One hand's difference in ~500; the headline metrics do not move. The bots were
evolved against a 6, so flush routes are now priced marginally under what they
pay — but on this evidence it does not warrant retraining. Caveat, per the
measurement canon: this is a **single block**, and single blocks carry noise.

Full test suite after the change: **1,980 passed, 1 skipped.** The golden suite
mirrors `hkos-standard` and `LIU`, so nothing there moved.

### 4.2 么九 — settled at 10

Shipped at 7; Wikipedia prices it a **limit hand at 10**. Under this house's
10-cap that makes 么九 a limit hand, which is what it is: every set built from
terminals alone, with no honours to fall back on.

Corrected in `MJRC_STANDARD` only, for the same reason as the flush —
`hkos-standard` is a faithful reading of one column and the golden suite mirrors
it.

**Behaviourally this is close to inert.** 么九 did not occur once in the 500-hand
sample used to test the flush change. It is corrected because leaving it would
mean `mjrc-standard` still carried an unratified transcription slip, not because
it changes how anything plays. Suite after the change: **1,980 passed, 1
skipped.**

**With both corrections in, §1 is now literally true**: `mjrc-standard` is HK Old
Style capped at 10, and every departure from the published table is a decision
somebody made on the record.

## 5. The dealer repeat — ratified

**Owner ruling 2026-08-31: under `mjrc-standard`, the dealer repeats.** No change
to `reducer.ts:631`; the existing behaviour is now a decision rather than an
inherited default.

The dealer holds the seat on a dealer win **and on every 流局**. Combined with
the 3-faan minimum pushing many hands into 流局, that is what makes a match long:

| table | draws | dealer repeats | hands per 4-wind match |
| --- | ---: | ---: | ---: |
| mixed (the default) | 33 % | 52 % | **33.0** |
| sharks (v4 × 3) | 45 % | 59 % | **38.6** |

The no-repeat floor is 16. Passing the deal on a draw would have put a 4-wind
match at ~19 hands; keeping the repeat roughly doubles it. That is the cost of
the ruling and it was made with these numbers in hand.

**Consequence for the picker**: the estimates on the length buttons — ~8 / ~16 /
~25 / ~35 hands — already assume repeats, so they stand. Four winds is an
evening, deliberately.

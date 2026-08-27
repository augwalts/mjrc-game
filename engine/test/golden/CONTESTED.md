# Where Hong Kong houses actually disagree

**Status:** draft for adjudication. Nothing here is settled.
**Audience:** a strong HK player who can make a ruling, and the engineer who has to encode it.

**Companion files.**
- `./contested.ts` — the same fourteen rulings as fixtures, with a scored hand on both sides of
  each, so neither reading silently becomes "the rule".
- `./AUDIT.md` — **a different question.** That document asks whether our fixtures are *correct*
  under the rules we already claim to play. This one asks *which rules to claim*. If a case looks
  wrong, AUDIT.md; if two houses would answer differently, here.

DESIGN.md §4 says rulesets are data: *"house-rule presets, and the HK→Taiwanese expansion as
config + a rules module, not a fork."* That only works if we know where the variation is. This
is the map.

## What this document is for

Every row below is a question a real table has argued about. For each one it gives the rule in
Cantonese and English, what the six surveyed systems say (with the faan values from
`mjrc-app/web/src/data/hk-scoring.ts`), which way `HKOS_STANDARD` currently goes, **whether that
was a decision or an accident**, how much it matters in play, and a recommendation.

Read the recommendation as a starting position to argue with, not an answer. The point of the
document is that every one of these gets *decided by a person* instead of falling out of a
column choice nobody looked at.

## The headline

**Eight of the fourteen rulings cannot be expressed as configuration today.** §4's promise —
house variants are presets, not forks — currently holds for six of them. The other eight need a
new field on `Ruleset`, a new id in `patterns.ts`, or a branch in `scoring.ts` / `reducer.ts`
before a house that plays them can be a preset at all:

| Needs | Rulings |
|---|---|
| New `Ruleset` flag | 花唔計番 · 平糊 honour eyes · 暗槓 and 門前清 |
| New pattern id | per-kong faan (and 花糊 needs one too) |
| A branch in `scoring.ts` | 四暗刻 on a discard · 七對子 recognition |
| A branch in `reducer.ts` | 搶暗槓 · 花糊 |

Three of those flags are cheap and would close the highest-frequency gaps in one pass. The two
reducer items can wait — they are the rarest things here.

## §0 · How to read the impact column

**The frequencies are reasoned estimates, not measurements.** Nothing in this repo has ever
counted a real Hong Kong hand. The only replay data is `mjrc-admin/research/probability/replays/`
— six games, twenty hands, 80% exhaustive draws, produced by the closed-hand Python engine that
has no claims and a known readiness bug (ENGINE-AUDIT §3). It cannot support a frequency claim
about anything.

Where a number is stated it comes from tile arithmetic (bonus-tile draw odds) or from ordinary
HK play experience, and it is written as a range. **Action:** once the bot harness runs full
games, measure the pattern distribution and replace this section with real numbers. Until then
treat the ordering as a considered opinion.

Chip figures use the shipped HKOS doubling ladder (`rulesets/src/payment.ts`), where a discard
win costs the discarder `2 × base` and `base` doubles every 2 faan: 3 faan → 8, 6 → 32, 9 → 96,
11 → 192, 13 → 384.

## The map, ranked by what it costs

| # | Ruling | Split | Frequency (est.) | Swing | Shipped | Status | Config? |
|---|---|---|---|---|---|---|---|
| 1 | 自摸找數 self-draw settlement | perPlayer vs total | 20-30% of wins | **3× the whole settlement** | perPlayer (HKOS) / total (LIU) | open | ✅ payment table |
| 2 | 花唔計番 flowers vs the floor | count vs don't | ~88% hold a flower; ~40% an own flower | legality of cheap hands | they count | **accident** | ❌ needs a flag |
| 3 | 門前清 concealed hand | 1 faan vs 0 | 15-25% of wins | 1 faan; legality at the floor | pays 1 | decided | ✅ faan table |
| 4 | 平糊 honour eyes | allowed vs suited only | commonest shape in the game | 1 faan; legality at the floor | allowed | decided | ❌ needs a flag |
| 5 | 清一色 full flush | 6 vs 7 | 1-3% of wins | 1 faan (one doubling step) | 6 / LIU 7 | decided | ✅ **both ship** |
| 6 | per-kong faan | 0 vs 1 each vs 暗槓 only | kong in 15-25% of hands | 1-2 faan | 0 | decided | ❌ no pattern id |
| 7 | 暗槓 and 門前清 | keeps vs breaks concealment | uncommon | 1 faan; legality here | keeps | decided | ❌ needs a flag |
| 8 | 小三元 | 5 vs 4 (vs additive) | 0.3-1% of wins | 1-3 faan | 5 | **accident** | ✅ faan table |
| 9 | 清么九 all terminals | 7 vs 10 vs 13 | <0.1% of wins | up to 6 faan | 7 | **accident** | ✅ faan table |
| 10 | 小四喜 | 6 vs 10 vs 13 vs 5 | 0.05-0.2% of wins | up to 7 faan | 6 | **open** | ✅ faan table |
| 11 | 四暗刻 on a discard | allowed vs self-draw only | 0.1-0.3%, a third on a discard | **13 vs 5 — 16× in chips** | allowed | decided | ❌ detector |
| 12 | 七對子 seven pairs | not a hand vs 4 faan | shape reachable often; wins never | the hand exists or it doesn't | omitted / LIU 4 | decided | ❌ detector |
| 13 | 搶暗槓 rob a concealed kong | forbidden vs 十三么 only | worse than 1 in 100,000 | the win exists or it doesn't | forbidden | decided | ❌ reducer |
| 14 | 花糊 all eight bonus tiles | additive vs instant win | ~1 in 25,000-50,000 | 6 faan, plus a hand with no shape | additive | **open** | ❌ reducer |

"Status" is about *this repo*, not about Hong Kong:

- **decided** — someone chose, on stated grounds, and the grounds are written down.
- **accident** — the shipped answer fell out of a column choice or a fixture, not a judgement.
- **open** — nobody has picked; the code currently guesses.

---

# 1 · 自摸找數 — what the self-draw column means

**Cantonese / English.** 自摸 *zi6 mo1* — winning on your own draw. The question is not the faan
(everyone pays 1) but the **settlement**: the house table prints one figure in its 自摸 column
and does not say what it means.

**The question.** Is the printed figure what **each** loser pays, or the winner's **whole**
collection, split three ways?

**Options.**
- **perPlayer** — each of the three losers hands over the printed figure; the winner collects 3×.
  This is the canonical HK reading, 自摸每家 X.
- **total** — the printed figure is the pot; the three losers split it.

**What the systems say.** `hk-scoring.ts` carries no payments at all — it is a faan table.
`house-rules-and-metas.md` §3.3 prints both as named schemes. TVB 2026 pays the winner 15×faan
and each loser 5×faan, which is the `total` shape with a 1.5 premium.

**What we ship.** `HKOS_STANDARD` pairs the doubling ladder with `perPlayer`; `LIU` pairs its
brackets with `total`. `payment.ts` argues the LIU reading from arithmetic: all four printed
figures divide by three exactly (108/156/252/444 → 36/52/84/148), and `perPlayer` would make a
3-faan self-draw pay 324 against a 92 discard win, which no table plays.

**Deliberate or accident?** Half-decided. DESIGN.md §4 explicitly says *"settle the
per-player-vs-total ambiguity against `mjrc-admin/reference/hk-scoring-calculator.xlsx` before
scoring ships."* That check has not been done. The arithmetic argument is good inference; it is
not the sheet.

**How much it matters.** More than anything else in this document. Self-draws are perhaps 20-30%
of wins, and the reading is a flat 3× on the entire settlement. Worked at 6 faan on the shipped
ladder (base 32):

| Reading | Each loser pays | Winner collects | vs a 6-faan discard win (64) |
|---|---|---|---|
| perPlayer | 32 | 96 | 1.5× — the documented 4-units-vs-6-units ratio |
| total | 11 | 33 | 0.5× — a self-draw pays *half* a discard win |

That second row is itself an argument: under `total` on a doubling ladder, drawing your own
winning tile is worth less than being fed it, which inverts the incentive the 自摸 faan exists to
create.

> **Recommendation.** Keep `perPlayer` for `HKOS_STANDARD` — it is canonical HK and it is the
> only reading that keeps the self-draw premium positive on a doubling ladder. Keep `total` for
> `LIU`, whose flat brackets were plainly built for it. **Then do the check DESIGN.md asked for**
> against the xlsx before scoring ships; if the sheet contradicts the inference, the sheet wins.

*No fixture.* `GoldenCase` records faan and awards, never chips. A settlement fixture belongs
beside `rulesets/src/payment.ts`, not in this family.

---

# 2 · 花唔計番 — may flowers carry a hand over the minimum?

**Cantonese / English.** 花唔計番 *faa1 m4 gai3 faan1* — "flowers don't count as faan", meaning
they do not count *toward the 3-faan floor*.

**The question.** A hand worth 1 faan from its tiles plus 2 faan of bonus tiles: is that a legal
3-faan win, or a refused 1-faan hand?

**Options.**
- Flowers count. Every faan is a faan, wherever it came from.
- 花唔計番. The hand must reach 3 on its own tiles; bonus faan are added afterwards.

**What the systems say.** All six price the bonus tiles (正花 1, 一台花 2, 無花 1) and **not one of
them says anything about the floor**. The floor rule is table lore, not table data — which is
exactly why it gets argued about.

**What we ship.** They count. Nothing states the choice; it falls out of summing the award list.

**Deliberate or accident?** Accident. No file in the repo takes a position.

**How much it matters.** The highest-frequency ruling here. Eight bonus tiles among 144, with a
player seeing roughly 34 tiles a hand: **~88% of hands hold at least one bonus tile and ~40%
hold an own flower**. This decides legality on a large share of the cheap hands the 3-faan floor
exists to filter — which is the entire purpose of the floor.

> **Recommendation.** Count them, as shipped — a flower is a real faan and HK club play treats it
> as one. But **add the flag**, because the opposite rule is common and a preset needs to be able
> to say it. This is the cheapest of the eight config gaps to close and it buys the most.

*Fixtures.* `contested-flowers-lift-to-minimum` (3, legal) / `contested-flowers-excluded-from-minimum`
(1, refused) — identical tiles, identical flowers. Also `honours-dealer-scores-no-extra-faan`.

---

# 3 · 門前清 — does concealment pay at all?

**Cantonese / English.** 門前清 *mun4 cin4 cing1* — a hand with no meld claimed from a discard.
The winning tile itself may still be a discard.

**The question.** Is a concealed hand worth 1 faan on its own?

**Options.** Yes, 1 faan. / No — 自摸 is the only reward for closing a hand.

**What the systems say.** MJ Time's column reads "—"; the other five pay 1. **The TVB 2026
tournament list does not award it either.** Two of the eight references surveyed do not pay for
concealment.

**What we ship.** 1 faan, taking the Wikipedia column.

**Deliberate or accident?** Decided — the column choice is documented in `presets.ts` — though
nobody has weighed TVB's omission against it.

**How much it matters.** Concealed wins are perhaps 15-25% of hands. One faan is one doubling
step (32 chips against 24 at 6 faan), but the real cost is legality: six cases in `basic.ts`
already turn on it, and `basic-all-chows-concealed-discard-short` is refused with it and refused
without it only because the hand is two short either way.

> **Recommendation.** Keep it at 1. Five of six systems pay it and HK club play expects it.
> Note *why* TVB drops it: that sheet also drops flowers, drops the dealer repeat and caps at 10
> faan — it is a coherent tournament design, and importing one dial from it in isolation makes
> our game worse, not more official.

*Fixtures.* `contested-concealed-hand-paid` (6) / `contested-concealed-hand-unpaid` (5).

---

# 4 · 平糊 — may the eyes be an honour pair?

**Cantonese / English.** 平糊 *ping4 wu4* — all chows, the common hand.

**The question.** Four chows and a pair of 白: is that 平糊?

**Options.** Yes — 平糊 constrains the four **sets**, not the pair. / No — the eyes must be suited.

**What the systems say.** All six price 平糊 at 1 and none qualifies the eyes. `hk-scoring.ts`
records the restriction as a real house wrinkle: *"rare, but it comes up"*.

**What we ship.** Honour eyes allowed. `patterns.ts` names the house rule and declines to model it.

**Deliberate or accident?** Decided, and stated in the catalogue.

**How much it matters.** High by frequency, small by faan. All-chows is the commonest winning
shape in the game and the 1 faan repeatedly sits at the 3-faan floor — three golden cases already
carry the note, and in `contested-all-chows-honour-eyes-refused` it kills the win outright.

> **Recommendation.** Allow honour eyes, as shipped. If a preset ever needs the restriction it is
> a boolean on `Ruleset` (`suitedEyesRequired`), not a faan value — and it is worth adding in the
> same pass as the 花唔計番 flag, since both are floor-adjacent detector conditions.

*Fixtures.* `contested-all-chows-honour-eyes-paid` (3, legal) /
`contested-all-chows-honour-eyes-refused` (2, refused). Also `flush-half-all-chows-honour-eyes`.

---

# 5 · 清一色 — 6 or 7?

**Cantonese / English.** 清一色 *cing1 jat1 sik1* — every tile from one suit, no honours.

**What the systems say.** 6 · 6 · 6 · **7** · 6 · **7**. `hk-scoring.ts` labels the row "6–7" on
its face — it does not pretend there is a consensus.

**What we ship.** `HKOS_STANDARD` 6, `LIU` 7. **Both readings already ship as presets.**

**How much it matters.** Full flush is maybe 1-3% of wins, and 1 faan is a full doubling step —
96 chips against 64 at the 9-faan step.

> **Recommendation.** Nothing to settle. This is the model working exactly as DESIGN.md §4
> describes: two columns, two presets, no argument. **Cite this row when someone asks what
> "rulesets are data" actually buys.**

*Fixtures.* `basic-full-flush-all-chows` (6) / `basic-full-flush-liu-seven` (7).

---

# 6 · Per-kong faan

**Cantonese / English.** 槓 *gong3* — a quad, in any of its three forms: 明槓 exposed, 暗槓
concealed, 加槓 added.

**The question.** Does declaring a kong pay faan of its own?

**Options.** No — the reward is the replacement draw. / 1 faan per kong. / 1 faan for 暗槓 only.

**What the systems say.** No system has a per-kong row. Every kong row in `hk-scoring.ts` prices
exactly what the matching pung prices. But the rule is common at real tables anyway, and the
party meta in `house-rules-and-metas.md` doubles the whole hand per kong.

**What we ship.** Nothing. `patterns.ts` gives kongs no id at all, deliberately: *"a kong of
dragons is worth exactly what the pung is worth in all six surveyed systems… the kong shape earns
a replacement draw, not extra faan."*

**Deliberate or accident?** Decided, and well argued — for the *default*. The problem is the
consequence: **a house that pays for kongs cannot be a preset**, because there is no id to price.

**How much it matters.** A kong appears in maybe 15-25% of hands. A 1-2 faan bonus moves a
meaningful share of settlements and, near the floor, changes legality.

> **Recommendation.** Keep paying nothing **and add the id anyway.** A `kongBonus` entry costs a
> preset nothing when it is priced 0, and without it this is a fork — precisely the case §4 says
> must never require one. Note that "暗槓 only" is a second axis the single id cannot express;
> either add two ids or accept that a house wanting the split needs a flag as well.

*Fixtures.* `kongs-two-concealed-kongs-score-nothing-extra` (4) /
`contested-per-kong-faan-paid` (6, using the uncatalogued `kongBonus`).

---

# 7 · 暗槓 and 門前清 — does a concealed kong break concealment?

**Cantonese / English.** 暗槓 *am3 gong3* — a kong drawn complete from your own tiles and declared
face-down/face-up on the table without claiming anything from anyone.

**The question.** After declaring a 暗槓, is the hand still 門前清?

**Options.** Yes — nothing was claimed from a discard. / No — the kong is on the table, so the
hand is exposed.

**What the systems say.** None addresses it directly. `hk-scoring.ts` defines 門前清 as
*"no melds claimed from discards"*, which reads for the first answer. The TVB list bans winning
off a concealed kong but says nothing about concealment.

**What we ship.** The hand stays concealed. `kongs-concealed-kong-keeps-hand-concealed` states
the reasoning in its own description.

**Deliberate or accident?** Decided, and the reasoning is written down.

**How much it matters.** Low-moderate frequency, but the faan lands on hands that are already
near the floor. On the fixture's tiles the minority reading takes the hand from 3 (legal) to 2
(refused).

> **Recommendation.** Keep it concealed. It follows from the definition every source gives, and
> the minority reading punishes a player for a declaration the rules *require* them to make
> publicly. Worth a `Ruleset` flag anyway, since it is one line and the question does come up.

*Fixtures.* `kongs-concealed-kong-keeps-hand-concealed` (3, legal) /
`contested-concealed-kong-breaks-concealment` (2, refused).

---

# 8 · 小三元 — 5 or 4, and do the dragon pungs stack?

**Cantonese / English.** 小三元 *siu2 saam1 jyun4* — two dragon pungs plus a pair of the third.

**Two questions, not one.**
1. Is the pattern worth 5 faan or 4?
2. Are the two dragon pungs **inside** that value or paid on top?

**What the systems say.** — · — · 4 · 4 · **5** · 4. `hk-scoring.ts` labels the row "4–5" and
says outright that the value *"typically already INCLUDES the fan for the two dragon pungs —
you do not count those again on top. (Systems differ on this; verify with your house.)"*

**What we ship.** 5, dragon pungs subsumed.

**Deliberate or accident?** **Accident on the value, decided on the subsumption.** The 5 is not a
judgement about 小三元 — it is whatever the Wikipedia column said, because `presets.ts` takes that
column whole *"rather than picking a favourite value per row, because a table assembled from six
sources is a table no house plays."* That is a good rule. It just means three of the four systems
that price this hand were outvoted by a policy, not by an argument.

**How much it matters.** Perhaps 0.3-1% of wins. One faan is one doubling step; the additive
reading is worth 2-3 more (4→6 or 5→7).

> **Recommendation.** **Move to 4.** Dragon Society, LIU and L2 all print 4; only the Wikipedia
> column prints 5, and the column-whole policy exists to avoid cherry-picking, not because
> Wikipedia is the better source. This is the clearest case in the document of a policy producing
> an answer nobody would defend on its merits. Keep the subsumption — the source states it plainly.

*Fixtures.* `honours-small-three-dragons` (6 = 5 + 無花) / `contested-small-three-dragons-four`
(5 = 4 + 無花).

---

# 9 · 清么九 — additive 7, or a limit hand?

**Cantonese / English.** 清么九 *cing1 jiu1 gau2* — pungs of 1s and 9s only. No honours, no simples.

**The question.** Is it a 7-faan pattern that stacks with everything else, or a flat limit hand?

**Options.** 7 additive (Wikipedia) · 13 flat (LIU, L2) · 10 starred limit (MJ Time, MJB).

**What the systems say.** 10\* · 10\* · — · 13\* · **7** · 13\*. The 7 is the outlier; every other
system treats the hand as a limit.

**What we ship.** 7 — and `presets.ts` admits it in as many words:

> *"7 is the column's own value and it is an OUTLIER — four of the six systems star 清么九 as a
> limit hand. Kept because the golden flush family pins it at 7 while the limit family declares
> 10, and the suite cannot be satisfied both ways. **Open question, not a decision.**"*

**Deliberate or accident?** Accident, and self-declared. The value is what it is because two
golden families were authored against different assumptions and 7 was the value that broke fewer
of them.

**How much it matters.** Rarer than 1 in 1,000 wins. But the swing is 6 faan on a melded hand
(11 vs 13 → 384 vs 768 chips), and **the fixtures currently disagree with each other**, which
costs the project more than the ruling does.

> **Recommendation.** **Move to 13** and fix the fixtures that pinned the 7. Five of six systems
> treat it as a limit hand. Settle the 對對糊-stacking axis in the same pass — `scoring.test.ts`
> lists six cases blocked on whether 字一色 and 清么九 pay 對對糊 on top, and this ruling cannot be
> tested cleanly until that one is answered.

*Fixtures.* `contested-all-terminals-additive` (11, melded) /
`contested-all-terminals-flat-limit` (raw 17, capped 13). The melded form is deliberate — a
concealed 清么九 reaches 13 under both readings and hides the disagreement.

---

# 10 · 小四喜 — 6, 10, 13, or 5?

**Cantonese / English.** 小四喜 *siu2 sei3 hei2* — three wind pungs plus a pair of the fourth wind.

**Two questions.**
1. What is it worth?
2. Does it swallow 門風 and 圈風, or are those paid on top?

**What the systems say.** 10\* · 10\* · — · 10\* · **6** · 10\*. Only the column we take says 6.
The TVB list goes the other way entirely and pays **5**. This is the widest spread of any row in
the sheet: 5, 6, 10 and limit are all in circulation.

**What we ship.** 6, with the winds subsumed by the fixtures — and **the subsumption is disputed
inside this repo**. `patterns.ts` says the four-winds patterns do *not* swallow the positional wind
faan (they are *"POSITIONAL faan — they depend on who you are and which round it is, not on the
shape"*), while `honours.ts` rules that they do. Each cites the other for a ruling neither holds;
`AUDIT.md` D3 catches it and takes the catalogue as authoritative.

**Deliberate or accident?** **Open.** The value is a column artefact; the subsumption is an
unresolved contradiction between two files that each claim to be the authority.

**How much it matters.** Perhaps 0.05-0.2% of wins — but 6 against 13 is the difference between a
good hand and a hand that ends the round. On the fixture's tiles, corrected per AUDIT D3: 11 faan
pays the discarder 384 chips, the limit reading 768.

> **Recommendation.** **Move to 10**, matching four of the five systems that price it, and settle
> the subsumption **against** `honours.ts`: 門風/圈風 are positional and a house paying them on top
> is paying for a different thing — which is what `patterns.ts` already says. Do the subsumption
> first: it blocks three fixtures, and only one of them shows a payout change, which is exactly why
> it survived this long.

*Fixtures.* `honours-small-four-winds-half-flush` (10, and owed a correction to 11 per AUDIT D3) /
`contested-small-four-winds-limit` (raw 18, capped 13, written on the corrected side).

---

# 11 · 四暗刻 — may it be won on a discard?

**Cantonese / English.** 四暗刻 *sei3 am3 hak1*, also 坎坎糊 — four concealed pungs and a pair.
"Hidden Treasure".

**The question.** The classic form is self-drawn. On a **discard**, what counts?

**Options.**
- The discard may complete only the **pair**; all four pungs must already be sitting complete
  in hand. (The common HK allowance.)
- No discard at all — 四暗刻 is a self-draw hand, and on a discard it is 對對糊.
- The discard may complete the fourth **pung** too. (A minority.)

**What the systems say.** `hk-scoring.ts` sets the conflict out in its own long note — the
self-draw form, the pair-only allowance, and then: *"Rules conflict across houses here — verify
yours."* The values split too: 10\* · 10\* · — · 13\* · 10 · 13\*.

**What we ship.** The pair-only allowance, paid at 13. The **value** 13 is one of the two
departures `presets.ts` names explicitly (four of six systems star it as a limit, so the
column's 10 was overruled). The **discard allowance** is stated only in a fixture description —
nowhere in the ruleset data.

**Deliberate or accident?** Decided, but recorded in the wrong place. A ruling that lives only in
a test fixture's prose is a ruling that will be re-litigated.

**How much it matters.** The widest faan gap in the map: **13 against 5 on identical tiles**, or
768 chips against 48 — a 16× swing. Frequency is low (perhaps 0.1-0.3% of wins, of which maybe a
third arrive on a discard) but this is the single ruling most likely to stop a game while four
people argue.

> **Recommendation.** Keep the pair-only allowance. It is the mainstream HK reading, and it draws
> the line where the concealment argument actually is: a pung finished by someone else's tile was
> never concealed; a pair finished by one still leaves four concealed pungs. **Move it out of the
> fixture prose into a `Ruleset` flag** (`fourConcealedPungsSelfDrawOnly`) so the strict houses
> are a preset rather than a fork.

*Fixtures.* `kongs-four-concealed-pungs-discard-completes-pair` (13) /
`contested-four-concealed-pungs-strict-discard` (5). The third reading is covered by
`kongs-four-concealed-pungs-discard-completes-pung`, which already records the majority against it.

---

# 12 · 七對子 — is seven pairs a Hong Kong hand at all?

**Cantonese / English.** 七對子 *cat1 deoi3 zi2* — seven pairs, fully concealed.

**The question.** Does HK Old Style recognise it as a winning shape?

**Options.** No — HKOS wins are four sets and a pair. / Yes, 4 faan, concealed by definition.

**What the systems say.** **All six columns print 4** — the strongest apparent consensus anywhere
in the sheet. Against that:
- The TVB 2026 tournament list does not recognise it.
- `house-rules-and-metas.md` marks it "— (not recognized)" for TVB.
- ENGINE-AUDIT §1 lists it among LIU's *"non-standard values… Seven Pairs 4 — not in classic HKOS
  at all."*

**What we ship.** `HKOS_STANDARD` omits it; `LIU` prices it 4. `presets.ts` lists it under
"absent on purpose" — a departure from its own source column that is **not counted among the two
departures the file names**.

**Deliberate or accident?** Decided, on the audit's authority, against the source column. That is
a defensible call and it is *under*-documented: the next reader who opens `hk-scoring.ts`, sees
six 4s and finds no `sevenPairs` key will assume a transcription slip.

**How much it matters.** Nil where it is omitted, structural where it is not. This is not a faan
question — **it changes what players pursue.** A payable 七對子 turns a broken hand that would be
abandoned into a live target, shifting discard behaviour across the whole game.

> **Recommendation.** Keep it out of `HKOS_STANDARD` and in `LIU`, as shipped — but write the
> reasoning *at the omission*, citing the TVB list and ENGINE-AUDIT, so it reads as a decision
> rather than an oversight.
>
> **Then fix the LIU preset, which is currently broken.** Pricing 七對子 is not enough to enable
> it: `ready.ts` and `decompose.ts` only ever look for four sets and a pair, so LIU prices a hand
> the engine cannot recognise. Either teach the decomposer the shape behind a flag, or drop the
> price and say why.

*Fixtures.* `contested-seven-pairs-not-a-hand` (not complete, refused) /
`contested-seven-pairs-liu-four` (6 = 4 + 自摸 + 無花). Both use `hk-scoring.ts`'s own
illustration, and the test asserts that the shape **does not decompose** — which is the ruling.

Two sub-rules nobody has modelled: most tables require seven **different** tiles (four identical
tiles are not two pairs), and some bar kongs from the hand.

---

# 13 · 搶暗槓 — may a concealed kong be robbed?

**Cantonese / English.** 搶槓 *coeng2 gong3* — winning on the tile that would have completed
someone's kong. 加槓 *gaa1 gong3* is the added kong that normally opens that window.

**The question.** Does a **concealed** kong open a rob window?

**Options.** No — only 加槓. / Yes, but only for 十三么. / Yes, for any hand.

**What the systems say.** Every system prices 搶槓 at 1 and **none says which kong forms open the
window.** TVB 2026 adds *"A concealed kong cannot be used to win"* — which most naturally means it
cannot be robbed, but the sentence is genuinely ambiguous and nobody has checked it against the
Chinese original in `mjrc-admin/reference/tvb-championship-2026/`.

**What we ship.** Robbing only 加槓. `types.ts` documents the rob window as belonging to the added
kong and the reducer follows.

**Deliberate or accident?** Decided, and consistent across the contract and the state machine.

**How much it matters.** Negligible in play — 十三么 is already rare and it must coincide with an
opponent kong-ing exactly the tile you need; worse than 1 in 100,000 hands. Total when it happens:
the win either exists or it does not.

> **Recommendation.** Keep it forbidden. **And resolve the TVB sentence** before that sheet is
> quoted anywhere else — an ambiguous line in a source we cite repeatedly is a liability beyond
> this one rule. The ruling matters less for its frequency than for what it says about concealed
> kongs generally: under the shipped reading a 暗槓 is completely safe, and that is a real
> strategic property worth stating on the rules page.

*Fixtures.* `contested-rob-concealed-kong-refused` (unreachable — the position never arises) /
`contested-rob-concealed-kong-allowed` (raw 15, capped 13).

---

# 14 · 花糊 — do all eight bonus tiles win the hand?

**Cantonese / English.** 花糊 *faa1 wu4* — "flower win", holding all four flowers and all four
seasons.

**The question.** Does the eighth bonus tile end the hand on the spot?

**Options.**
- No — they score additively (own flower 1 + own season 1 + 一台花 2 + 一台花 2).
- 花糊 — the hand ends immediately at the limit, with no winning shape required.
- Separately: **seven** of eight is its own event at many tables — extra faan, or the right to rob
  the eighth from whoever draws it.

**What the systems say.** Every column reads "—". `hk-scoring.ts` marks the row "Win\*" and says
*"instant win under some rules"*; the Classical meta in `house-rules-and-metas.md` turns it on.

**What we ship.** Additive. `honours-all-eight-bonus-tiles` pays 7, and its own note concedes
that *"if the state machine implements 花糊 this case becomes unreachable rather than wrong."*

**Deliberate or accident?** Open. Nobody has chosen; the additive answer is what falls out of
summing bonus tiles.

**How much it matters.** Roughly 1 in 25,000-50,000 hands by tile arithmetic, and rarer in
practice because most hands end well before the wall runs out. The scoring gap is 6 faan. **The
real problem is structural:** a 花糊 table ends the hand on a state the reducer has no path to,
and the winner may hold no winning shape at all — which `GoldenCase` cannot express either.

> **Recommendation.** Leave it off for `HKOS_STANDARD`; treat it as a Classical/party preset
> feature. If it is ever turned on it needs both a reducer branch and a pattern id, so **decide
> before either is written** rather than retrofitting. Settle the seven-tile rule at the same
> time — houses that play one usually play both.

*Fixtures.* `honours-all-eight-bonus-tiles` (7, additive) /
`contested-all-eight-flowers-instant-win` (13, using the uncatalogued `allEightBonusTiles`).

---

# Appendix A · The six systems

From `mjrc-app/web/src/data/hk-scoring.ts`, sourced from
`mjrc-admin/reference/hk-scoring-calculator.xlsx` (FanSlang sheet).

| Column | What it is | Notes |
|---|---|---|
| MJ Time | A commercial HK scoring reference | Stars most limit hands at 10\*; no 門前清 row |
| MJB | Another commercial reference | Tracks MJ Time closely |
| Dragon Soc | Dragon Society | Sparse — many rows read "—" |
| LIU | The family variant, cross-checked against `scoring.py` | Ships as a preset |
| Wikipedia | The HK mahjong scoring article | **The only column with a value for every classic pattern — which is why `HKOS_STANDARD` takes it whole** |
| L2 | A sixth reference | Tracks LIU on the limit tier |

Two more references are cited above and are **not** in that sheet: the **TVB Brain Fitness
Championship 2026** rules (`mjrc-admin/reference/tvb-championship-2026/`) and
`mjrc-admin/docs/house-rules-and-metas.md`. TVB disagrees with the sheet on 門前清, 七對子 and
小四喜, and it is the most authoritative *tournament* source we have — but it is a tournament
design, with flowers off, no dealer repeat and a 10-faan cap. **Do not import single dials from
it.**

A "\*" in the sheet means the system treats the hand as a limit rather than pricing it, which is
why several rows read `10*` — those are not really the number 10.

# Appendix B · Disagreements *inside this repo*

These are not house splits — they are two of our own files ruling opposite ways, which costs more
than most of the rulings above because it makes the golden suite fail. **`./AUDIT.md` covers them
properly**, case by case, with the corrections to apply. They are listed here only so the two
kinds of disagreement do not get confused, and because four of the fourteen rulings above cannot
be tested cleanly until they are settled.

| Conflict | Where | Blocks | Ruling above it holds up |
|---|---|---|---|
| Does 字一色 / 清么九 pay 對對糊 on top? | AUDIT D2 | 4 cases | §9 清么九 |
| Do 小四喜 / 大四喜 swallow 門風/圈風? | AUDIT D3 | 3 cases | §10 小四喜 |
| Is a season `ownSeason` or `ownFlower`? | AUDIT D5 | 6 cases | §2 花唔計番 |
| Does LIU play flowers and 門前清? | AUDIT D6 | 2 cases | §12 七對子 |
| Does 十三么 subsume 門前清? | `patterns.ts` prose vs `limit.ts`; AUDIT D8 | award lists only | §13 搶暗槓 |

None of these needs a Hong Kong player. They need one person to pick, once, and update the losing
side. Two of them — D2 and D3 — are cases where a file cites *another file* for a ruling that file
does not actually hold, which is worth noticing as a pattern: a citation is not a decision.

Where this family's fixtures touch one of those axes, they are written on the **corrected** side
rather than bug-compatible with the fixture they pair with:
`contested-all-terminals-additive` pays 對對糊 (D2) and `contested-small-four-winds-limit` pays
圈風 (D3). Their shipped-side pairs still owe those corrections.

# Appendix C · Checked and found *not* contested

Recorded so nobody re-opens them:

- **Chow only from 上家.** Universal. Every source agrees a run is claimed only from the seat to
  your left.
- **Claim priority win > kong/pung > chow, ties to the nearest seat clockwise.** Universal in HK.
  (TVB words the tie-break as "the player to the discarder's left", which is the same rule.)
- **A kong of honours is worth what the pung is worth.** All six systems, every honour, both set
  sizes.
- **Seat wind and round wind score independently.** All six. East seat in East round scores twice
  — this is the "double East" every HK player expects, not a bug.
- **搶槓 off an added kong is 1 faan.** All six. Only the *concealed* kong case is contested (§13).
- **槓上開花 stacks with 自摸.** The replacement is a wall draw; the two are additive, not
  alternatives. All six.
- **海底撈月 and 河底撈魚 are one faan each and mutually exclusive.** Every system prices the pair as
  one row; no hand can earn both.
- **3-faan minimum, 13-faan limit.** Both shipped presets, DESIGN.md §4, and the LIU engine.
  (TVB uses 1 and 10 — a tournament choice, not a house split.)

# Appendix D · What to do next, in order

1. **Do the xlsx check on the self-draw settlement** (§1). DESIGN.md §4 asked for it and it is the
   largest number in the document.
2. **Settle Appendix B / apply `AUDIT.md`.** Five internal contradictions, no HK expertise
   required, and the golden suite cannot go green without them. Four of the rulings above cannot
   be tested cleanly until they land.
3. **Add three `Ruleset` flags** — bonus faan vs the floor, suited eyes, 四暗刻 on a discard — and
   the `kongBonus` pattern id. That converts four forks into presets and closes the
   highest-frequency gaps.
4. **Re-price the three accidents** with a person in the room: 小三元 5→4, 清么九 7→13,
   小四喜 6→10. Each is a one-line change to `presets.ts` plus the fixtures that pinned it.
5. **Measure the frequencies** (§0) once the bot harness plays full games, and replace the
   estimates in the ranking table with counts.
6. **Get a strong HK player to sign off**, ruling by ruling. DESIGN.md §8 makes human validation
   the P0 exit gate, and every fixture in this family is still `provisional: true`.

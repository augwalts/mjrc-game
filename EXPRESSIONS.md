# 枱面話 — Cantonese expressions & table talk

**Status:** proposal, 2026-08-26. Implements the DESIGN.md §7 terminology-first commitment as
a gameplay system. Data lives in `client/src/expressions/catalogue.ts` (63 entries, all fields
populated, invariants machine-checked). Terminology per `TERMINOLOGY.md` — HK Old Style only.

**One line:** a canned Cantonese expression system, tiered clean → 有火 → 粗口, delivered on an
ephemeral side-channel that never touches the event log, which doubles as the vocabulary
teaching mechanism §7 already asked for.

---

## 1. Why a silent table is a broken table

A Hong Kong mahjong table is loud. Not incidentally loud — the noise *is* the social object.
People groan at their draws, curse the wall, accuse each other of cheating, announce their own
misery in operatic terms, and abuse the person who just fired the tile that lost them the hand.
Take that away and you have a very fast, very correct, very lonely piece of software.

This matters more here than it would for a Riichi product, because of what DESIGN.md §1 says we
are competing on. Amatsuki owns the anime lane and already ships Cantonese voice; our lane is a
*register* — the feel of a real HK table, in the heritage-craft direction, with the owner's tone
brief ("I don't want to take this too seriously") built into the product rather than applied to
the marketing. Table talk is the single cheapest, highest-leverage way to deliver that register.
A player's first two hands should tell them "these people have actually played at a table in
Hong Kong," and the fastest way to say that is to have the table say 「多謝夾承惠」 while it
takes their chips.

There is also a hard product reason. P0 is invite-only, bot-heavy, and low-population
(DESIGN.md §3). A bot table with no chatter reads as a tech demo. A bot table where the seat you
just dealt into says 「頂你個肺」 reads as a game. Bot expression is a texture feature with the
same weight as gate 3's bot-parity metrics, and it costs a lookup table rather than an AI.

## 2. The strategic argument: this IS the teaching system

DESIGN.md §7 commits to "terminology-first — doc 05's ~25-term Cantonese romanization set as the
vocabulary of labels and call subtitles." That commitment currently has no delivery mechanism
beyond labels, and labels are the weakest possible one: nobody has ever learned vocabulary by
reading a button.

**Expressions are the delivery mechanism.** The words in `TERMINOLOGY.md` are not dictionary
entries, they are things people shout at each other at specific moments, and that is exactly how
anyone actually acquires them. The pairing is a stimulus, not a lesson:

| Term | Carried by | Fires when |
|---|---|---|
| 出銃 *ceot1 cung3* | `iDealtIn`, `fedRightToMe` | the beat after you hand someone a win, while your chips move |
| 聽牌 *ting1 paai2* | `iWasReady`, `oneTileShort`, `myTileIsDead` | you were one tile away and somebody else won |
| 上聽 *soeng5 ting1* | `TERM_GLOSSARY.oneAway`, wheel context page | the faan-floor warning fires alongside it |
| 截糊 *zit6 wu2* | `youCutMyWin` | an earlier seat takes the tile you were waiting on |
| 爆棚 *baau3 paang4* | `limitHand` — **unlocked by your first limit hand** | the moment the word means something to you |
| 流局 *lau4 guk6* | `wallsDead` | the wall runs out |
| 死牌 *sei2 paai2* | `myTileIsDead` — unlocked by waiting on a dead tile | you discover counting discards is a skill |
| 手風 *sau2 fung1* | `handWindIsHot`, `handWindIsRotten` | someone is on a heater |
| 自摸 *zi6 mo1* | `slaughterAllThree` | you win off your own draw |
| 出千 *ceot1 cin1* | `areYouCheating` | it's a joke, and the word sticks anyway |

Three design consequences follow, and they are what turn a fun feature into a strategic one:

1. **Unlock order is the curriculum.** Expressions are earned by playing (§5), and the milestone
   that unlocks 爆棚呀 is *winning a limit hand*. The vocabulary arrives attached to the
   experience that gives it meaning. This is Smash Bros roster logic pointed at pedagogy, and it
   is why §5's anti-gacha stance is a feature here rather than a constraint: a randomised pull
   would sever exactly the pairing that does the teaching.
2. **Reception teaches before production.** The receive default is one tier above the send
   default (§6) precisely so a new player *hears* the language for several sessions before they
   are expected to use it. Comprehension precedes production; that is how language works.
3. **Acquisition by imitation.** Tapping an expression you received adds it to your wheel if you
   own it, or shows you its unlock condition if you do not. That is how you learn phrases at a
   real table — somebody says a thing, it is funny, you steal it.

The bubble is terminology-first per §7: characters large, Jyutping small underneath, English on
long-press. Not a translation with characters decorating it.

## 3. Canned, not free text

Free chat is out. Two reasons, and the second is the more important one.

**The boring reason.** Free text is a moderation surface with no floor. It carries slurs,
harassment, doxxing, links, scam solicitations, and the entire liability of user-generated
content — and DESIGN.md §5.3 explicitly defers report/moderation tooling to P1 open
registration. Shipping free chat at P0 means shipping the surface without the tooling. There is
also a specific hazard for this product: DESIGN.md §9 keeps the game "skill-framed forever, no
wagering language," and free text is precisely where players negotiate stakes. A canned set
cannot say "$20 a round."

**The real reason: canned is funnier.** Free text gets you what a person can type in four
seconds on a phone while a claim window is running, which is "lol" and "nice". A curated set
gets you 「你隻眼生喺後尾枕」 — *your eye grew on the back of your skull* — which is the correct
phrase, perfectly delivered, at the exact right moment, by someone who could not have produced
it themselves. The constraint is the joke. Everyone at the table is suddenly funnier and more
Cantonese than they are, which is the fantasy the product is selling.

It also removes the timing problem: a canned expression is one thumb-tap and does not compete
with the discard clock.

## 4. What is NOT an expression

**Calls are not expressions.** 碰 / 上 / 槓 / 食糊 / 自摸 are engine events (`protocol/src/events.ts`)
rendered by the client. They fire whether or not the player owns any expressions, cannot be sent
falsely, cannot be rate-limited, and are not affected by tier settings or mute. Muting a player
mutes their table talk, never their calls — a claim you cannot see is a rules problem, not a
social one.

The two layers share a voice booth and nothing else. `mjrc-admin` Track A already has recorded
Cantonese call audio on the roadmap (DESIGN.md §3); record the expression lines in the same
session with the same voice actors, and keep the code paths entirely separate.

## 5. The catalogue

63 entries, organised by moment. Full data with intensity tier, aim, social edge, soften target,
unlock rule and Jyutping is in `client/src/expressions/catalogue.ts`. Tier key: **·** clean,
**!** salty 有火, **!!** 粗口.

### Winning 食糊

| | Characters | Jyutping | Literal | What it does |
|---|---|---|---|---|
| · | 多謝夾承惠 | do1 ze6 gaap3 sing4 wai6 | thank you, and that will be — | shopkeeper voice, palm out, while taking their chips. The best line in the set |
| · | 唔好意思 | m4 hou2 ji3 si1 | not good meaning | "so sorry about that," said by the least sorry person at the table |
| · | 大殺三方 | daai6 saat3 saam1 fong1 | great slaughter of three directions | 自摸. Everyone pays |
| · | 爆棚呀! | baau3 paang4 aa3 | burst the shelf! | limit hand. Unlocked by hitting one |
| · | 執到寶 | zap1 dou2 bou2 | picked up a treasure | the tile was just lying there |
| ! | 餵到我口 | wai3 dou3 ngo5 hau2 | fed right into my mouth | you didn't lose that hand, you catered it |

### Dealing in 出銃

| | Characters | Jyutping | Literal | What it does |
|---|---|---|---|---|
| · | 出銃 | ceot1 cung3 | fire the gun | that was me. **The single most important teaching entry** |
| · | 死喇 | sei2 laa3 | dead already | well, I'm finished |
| · | 抵死 | dai2 sei2 | deserve to die | serves me right, I knew better |
| · | 打錯咗 | daa2 co3 zo2 | hit the wrong one | I had the safe tile and threw the other one |
| · | 我請客 | ngo5 ceng2 haak3 | I'm treating | apparently tonight is on me. Unlocked at 20 deal-ins |
| ! | 弊喇 | bai6 laa3 | it has gone bad | oh hell |
| ! | 頂! | ding2 | prop / push | the one-syllable one, as the tile lands. Minced 屌 |
| ! | 頂你個肺 | ding2 nei5 go3 fai3 | prop your lung | the famous non-swear swear |
| !! | 屌 | diu2 | the verb | one syllable, all of it |
| !! | 唔係哇屌 | m4 hai6 waa3 diu2 | it isn't so — [expletive] | you have got to be kidding me |
| ! | 仆街 | puk1 gaai1 | fall face-down in the street | the workhorse; half exclamation, half insult |
| !! | 冚家鏟 | ham6 gaa1 caan2 | the whole household, shovelled | GODDAMMIT. Nobody means it literally |

### A near miss

| | Characters | Jyutping | Literal | What it does |
|---|---|---|---|---|
| · | 爭一隻 | zaang1 jat1 zek3 | short by one piece | one tile. ONE |
| · | 我聽咗好耐 | ngo5 ting1 zo2 hou2 noi6 | I have been listening a long time | I've been ready six turns, thanks for asking |
| · | 截糊 | zit6 wu2 | intercept the pot | that was MY tile and you knew it |
| · | 眼大睇過龍 | ngaan5 daai6 tai2 gwo3 lung4 | big eyes looked clean over the dragon | it was there and I stared through it |
| · | 哎吔 | aai1 jaa4 | *(a noise)* | the all-purpose sigh. Bottom of every soften chain |

### A long wait

| | Characters | Jyutping | Literal | What it does |
|---|---|---|---|---|
| · | 等到頸都長 | dang2 dou3 geng2 dou1 coeng4 | waited till even my neck got long | I've been waiting so long I've evolved |
| · | 做人心抱甚艱難 | zou6 jan4 sam1 pou5 sam6 gaan1 naan4 | being a daughter-in-law is terribly hard | operatic self-pity. Nobody has it worse than me |
| · | 摸極都係廢牌 | mo1 gik6 dou1 hai6 fai3 paai2 | draw to the utmost, still scrap | fourteen turns of garbage |
| · | 隻牌死晒 | zek3 paai2 sei2 saai3 | the tile is entirely dead | all four are showing. I'm waiting on a ghost |
| · | 冇眼睇 | mou5 ngaan5 tai2 | have no eyes to watch | I can't watch this |
| · | 手風唔順 | sau2 fung1 m4 seon6 | the hand-wind is not smooth | my luck is against me tonight |

### Someone else's luck

| | Characters | Jyutping | Literal | What it does |
|---|---|---|---|---|
| · | 又係你?! | jau6 hai6 nei5 | again it is you?! | third hand running. THIRD |
| · | 手風好順喎 | sau2 fung1 hou2 seon6 wo3 | the hand-wind runs smooth, huh | someone's on a heater and we've noticed |
| · | 神仙牌 | san4 sin1 paai2 | an immortal's hand | no mortal draws like that |
| · | 你出千呀? | nei5 ceot1 cin1 aa4 | are you working a thousand? | the joke accusation. Ninety percent joke |
| · | 好彩 | hou2 coi2 | good colour | lucky. Said flat, it means the opposite |
| · | 邊個打呢隻? | bin1 go3 daa2 ni1 zek3 | who threw this one? | who did that |
| !! | 好撚彩 | hou2 lan2 coi2 | good [infix] colour | extremely lucky, expressed with feeling |
| !! | 邊個柒頭打呢隻 | bin1 go3 cat6 tau4 daa2 ni1 zek3 | which [expletive]-head threw this | a demand to know whose tile that was |

### Impatience

| | Characters | Jyutping | Literal | What it does |
|---|---|---|---|---|
| · | 快啲啦 | faai3 di1 laa1 | faster a bit, come on | hurry up |
| · | 打牌啦大佬 | daa2 paai2 laa1 daai6 lou2 | hit a tile, big brother | some time this evening, boss |
| · | 瞓着咗呀? | fan3 zoek6 zo2 aa4 | have you fallen asleep? | you still with us |
| ! | 打牌唔係做功課 | daa2 paai2 m4 hai6 zou6 gung1 fo3 | playing tiles is not doing homework | it's mahjong, not an exam |

### Congratulation

| | Characters | Jyutping | Literal | What it does |
|---|---|---|---|---|
| · | 打得好 | daa2 dak1 hou2 | hit it well | well played |
| · | 叻仔 | lek1 zai2 | clever lad | warm from a friend, patronising from a rival |
| · | 服咗你 | fuk6 zo2 nei5 | submitted to you | alright, you got me |
| · | 靚牌 | leng3 paai2 | pretty tiles | that's a lovely hand |
| · | 恭喜發財 | gung1 hei2 faat3 coi4 | congratulations, get rich | the New Year greeting, aimed at the person taking your money |

### Sarcasm

| | Characters | Jyutping | Literal | What it does |
|---|---|---|---|---|
| · | 犀利喎 | sai1 lei6 wo3 | sharp, huh | impressive. Delivered flat enough to sting |
| · | 咁都得? | gam2 dou1 dak1 | even that works? | that WORKED? |
| · | 教吓我啦師傅 | gaau3 haa5 ngo5 laa1 si1 fu2 | give me a lesson, master | please, sensei, share your wisdom |
| · | 唓 | ce1 | *(a noise)* | one dismissive syllable. Extremely rude for its size |
| ! | 黐線 | ci1 sin3 | the wires are stuck together | that's insane |
| ! | 你隻眼生喺後尾枕 | nei5 zek3 ngaan5 saang1 hai2 hau6 mei1 zam2 | your eye grew on the back of your skull | are you blind, or facing the wrong way |
| ! | 神經病 | san4 ging1 beng6 | nerve disease | you're out of your mind — **flagged, may be cut (§12)** |
| !! | 咁撚都得? | gam2 lan2 dou1 dak1 | even [infix] that works? | that worked?! Are you SERIOUS? |
| !! | 痴撚線 | ci1 lan2 sin3 | the wires are [infix] stuck together | that is absolutely mental |

### Resignation

| | Characters | Jyutping | Literal | What it does |
|---|---|---|---|---|
| · | 算把啦 | syun3 baa2 laa1 | count it and be done | forget it, whatever |
| · | 落雨收柴 | lok6 jyu5 sau1 caai4 | it's raining — bring the firewood in | cut the losses. Unlocked by finishing last |
| · | 聽天由命 | ting1 tin1 jau4 ming6 | listen to heaven, follow fate | nothing left to decide. Draw and pray |
| · | 流咗局 | lau4 zo2 guk6 | the round has drained away | wall's gone. Deal again |
| · | 陰功囉 | jam1 gung1 lo1 | hidden merit, alas | oh, the poor thing. Said about yourself, always |
| ! | 頂唔順 | ding2 m4 seon6 | cannot prop it up any longer | I am done. Cooked |

### Lobby

| | Characters | Jyutping | Literal | What it does |
|---|---|---|---|---|
| · | 三缺一 | saam1 kyut3 jat1 | three, missing one | WE NEED A FOURTH. The oldest recruitment call in Cantonese |
| · | 開枱! | hoi1 toi2 | open the table | let's go |

**Distribution:** 46 clean / 10 salty / 7 粗口. That ratio is deliberate — the coarse tier is a
spice, and a catalogue that is mostly obscenity stops being funny by hand three.

## 6. Two axes, not one — and the consent model

Most chat filters are stupid because they conflate two different things. This one does not.

- **Tier** — how coarse the *language* is: `clean` 斯文 / `salty` 有火 / `coarse` 粗口.
- **Edge** — how aggressive the *act* is: `warm` / `neutral` / `barbed`.

They are genuinely independent. 「犀利喎」 is spotless language and a sneer (clean + barbed).
「屌」 aimed at your own draw is filthy language that hurts nobody (coarse + neutral). A filter
that only knows about tier will happily pass the sneer and block the harmless one. Both fields
ship in the catalogue and both are queryable.

There is a third field, `aim`: `self` / `luck` / `table` / `seat`. This is where the harassment
risk actually lives (§8).

### Send and receive are separate settings

| Setting | Default for a new player | Why |
|---|---|---|
| **Send** | `clean` | The failure mode of a new player accidentally sending 粗口 to strangers on their first night is much worse than the failure mode of them being briefly polite. Raising it is one tap in settings and the setting screen shows examples, so the choice is informed rather than blind. |
| **Receive** | `salty` | Deliberately one tier above send. A table that is silent or sanitised on hand one has already failed §1 — the register *is* the product. 有火 is where 「頂你個肺」 lives, which is the exact temperature of a real HK table among people who are not related to each other. |
| **粗口 (both)** | off | Opt-in, on both sides, with no dark pattern nudging toward it. |
| **Voice** | off | Not a squeamishness call — phones are muted. Text bubbles are the default surface (§7). |

The send/receive asymmetry is the load-bearing decision in this section and it is doing double
duty: it is the safe default, and it is the comprehension-before-production ordering that makes
the teaching work (§2).

### Rooms set a cap, not a floor

The brief asked for a room "floor." Implement it as a **cap**, and the difference matters:

- A room's cap is the **maximum tier anyone may send in that room**, regardless of their
  personal send setting. A family room sets `clean`. The default is `salty`. The LA-scene room
  sets `coarse` and everyone there will.
- A room **cannot raise a player's receive tier.** A floor that forces exposure is not a consent
  model, it is the absence of one, and per-player receive always filters below the cap.

So the effective send tier is `min(playerSend, roomCap)` and the effective receive tier is
`min(playerReceive, roomCap)`. Two numbers, no special cases.

### Soften, never delete

A receiver below the sent tier does **not** see nothing. Every salty and coarse entry carries a
`softenTo` pointing at a tamer entry in the same moment, and the resolver walks down until the
phrase fits. Deletion is the wrong behaviour twice over: the table visibly goes quiet for that
one player while everyone else reacts to something, and worse, they can tell they are being
filtered, which is more alienating than the word would have been.

The mechanic also happens to be linguistically exact, because Cantonese swears by **infixing**:

| Sent | Received at clean | What changed |
|---|---|---|
| 好撚彩 | 好彩 | the infix 撚 came out; the phrase is otherwise identical |
| 痴撚線 | 黐線 | same |
| 咁撚都得? | 咁都得? | same |
| 屌 | 頂 → 哎吔 | 頂 *is* what a HK player substitutes when their mother walks in |
| 冚家鏟 | 仆街 → 哎吔 | one notch down the same ladder |

A player who receives both forms of the same phrase over a few sessions learns the infix
mechanic without ever being taught it. That is the best single argument in this document for
softening over suppression, and it fell out of the design rather than being engineered in.

`catalogueProblems()` proves every chain terminates at `clean`; it is a unit test, not a hope.

## 7. Delivery: bubble now, voice later

**Both, phased. Text bubble is the primary surface and always ships.**

| | P0 | P1 |
|---|---|---|
| Text bubble | yes, all 63 | — |
| Recorded VO | **calls only** (碰/上/槓/食糊/自摸/詐糊) — already Track A scope | expression lines — 53 of the 63 are marked `voice: true` |
| Voice characters | one | a small cast, unlocked by playing |

Reasoning, in order:

1. **VO is parity, not differentiation.** DESIGN.md §1 states this outright: Amatsuki ships
   Cantonese voice, so "we have Cantonese audio" claims nothing. What differentiates is the
   *register* — that the phrases are what people actually say, in the tone they actually say
   them. That differentiator is fully delivered by text. Recording it is polish on top of an
   argument already won, which is exactly the kind of thing that goes after the gate.
2. **Phones are muted.** Mobile-first (§2) means most first sessions have no audio at all. A
   feature that only exists in the audio channel does not exist.
3. **Text is free to iterate.** Cutting 「神經病」 after review costs a line diff. Cutting it
   after a recording session costs a recording session.
4. **VO cost is real.** ~53 lines × N voice characters × a HK-native session, plus direction —
   because the entire value is in delivery, and a flat read of 「多謝夾承惠」 is worse than
   silence.

**Voice characters are the cosmetic hook, and they are anti-gacha by construction.** The obvious
cast is a small roster with actual personality — the 阿婆 who has seen it all and is unimpressed,
the loud uncle, the impatient young guy who wants you to hurry up — tied to avatar choice and
**unlocked by playing, never by a randomised paid pull** (DESIGN.md §1: cosmetics fine, gacha
never). Same phrase, different delivery, is a lot of character for one extra audio bank.

**Bubble spec.** Characters at display size, Jyutping beneath at ~50%, English on long-press.
Anchored to the sender's seat badge, ~2.5s, max two bubbles visible per seat. Hard rule inherited
from `sketches/RENDERING.md` §4: **the expression UI never gates input.** Opening the wheel does
not block a claim window; claim buttons render above it and steal the tap. A player who lost a
claim because a bubble was in the way has been robbed by the presentation layer, which §4 exists
to prevent.

**Input.** One tap opens an 8-slot wheel; the wheel's default page is chosen by the current
moment (it shows the dealing-in page in the beat after you deal in), which is what makes
`iDealtIn` land at the moment it teaches. Long-press to re-aim at a seat where that is licensed
(§8). Respect `prefers-reduced-motion`: bubbles cross-fade, timings unchanged.

## 8. Abuse, proportionate to an invite-only alpha

Canned does not mean safe. The two real vectors are **repetition** and **targeting** — sending
「你隻眼生喺後尾枕」 at the same person nine times is harassment built entirely from vocabulary
we shipped. Four mechanisms, all cheap:

**1. Token bucket.** Per player per match: 4 tokens, one refilling every 6s, hard 1.5s floor
between sends, 10 per hand. Tuned so genuinely loud play is never throttled — the limiter should
only ever be felt by someone deliberately spamming. Plus a **free reaction window**: one send in
the 3s after a hand ends costs no token, because that beat is when everyone talks at once and a
limiter that eats the actual moment has defeated the feature.

**2. Per-expression cooldowns.** Barbed, seat-aimed lines carry 15-30s of their own. 「你出千呀?」
is 30s: once is banter, four times in a match is an accusation, and a server-authoritative wall
makes it a false one. `catalogueProblems()` fails the build if a barbed seat-aimed entry has a
cooldown under 10s.

**3. Repeat collapse.** The same id twice within 30s renders once with a ×N badge instead of two
bubbles. This kills the spam pattern at the presentation layer, costs nothing, and is funnier
than the spam was.

**4. Aim rules — curse your luck, not the player.** Two hard rules, both machine-checked:

- **A `coarse` expression may never be `seat`-aimed.** Obscenity at your own luck, yourself, or
  the room is mahjong. Obscenity at one named person is abuse. This is why the catalogue has no
  「屌你老母」 — it is the most common harassment payload in Cantonese, it targets family rather
  than the person, and it is the one phrase where "canned makes it funnier" stops being true.
  Deliberately absent, and this note is the record of why. (`冚家鏟` sits in tension with this and
  is flagged in §12 — it ships hard-pinned to `luck`, or it does not ship.)
- **Seat-aiming is licensed by moment.** You may point something at a seat only in the windows
  where a real table would: the seat that just dealt into you, and the seat that just won.
  Outside those windows a seat-aimed expression is not refused — it silently re-aims at the
  table. Refusal teaches players to hunt for the boundary; re-aiming just removes the weapon.

**Muting.** Per-player, one tap from the seat badge. Persists across matches. Suppression is
**server-side** — a muted player's chatter never reaches your socket, so it is not sitting in
your DOM waiting to be un-hidden — and the muted player is never told. Calls (§4) are never
muted. Also two global switches: text-only, and off entirely.

**Tier filtering is likewise server-side.** The softened variant is resolved on the server and
only that id crosses the wire. A client that filters is a client that can be patched.

**What gets logged.** Not the event log — §9. A per-match **ring buffer** in DO storage: last 100
chatter entries as `{ts, fromSeat, exprId, aim, targetSeat}`, purged with the DO at MATCH_END
unless a report has been filed against that match, in which case it is copied to a 7-day store.
No text is retained beyond the id, because the id resolves back to the catalogue and the
catalogue is versioned.

**Honest posture at P0.** DESIGN.md §5.3 defers report/moderation tooling to P1 open
registration, and PAGE-INVENTORY puts "report player" at P1. So at P0 there is no report button.
The P0 posture is: invite-only, host-kick exists, mute exists, the ring buffer exists so a
complaint raised in the group chat can actually be checked, and the aim rules make the worst
payloads unsendable rather than reportable. That is proportionate for ~20 known players. It is
**not** sufficient for open registration, and the P0→P1 work is a report button writing to the
7-day store plus a per-player chatter suspension — call it 0.3 wk, and put it in the P1 budget
now so it is not discovered later.

## 9. Architecture — the non-negotiable part

> **Expressions are presentation. They may ride the match socket. They must NEVER enter the game
> event log.**

This is the same rule DESIGN.md §5 states for cosmetics, and it binds here for the same reason.
The log records "tile 18 was discarded," never "tile 18 was discarded by the fox avatar in the
jade set." It must equally never record "and then seat 2 said 屌."

Why this is non-negotiable rather than tidiness:

1. **The log is a versioned research corpus** (§5.5), and every field in it is a permanent
   commitment. Chatter is high-volume, low-value, and entirely outside the domain the corpus
   exists to describe. It would be the single largest source of bytes in the archive while
   contributing nothing to a single analysis anyone plans to run.
2. **Replay is re-execution** (§5.1). The reducer is pure and total over game actions. An
   expression is not an action — it changes no state, so it has no place in a fold. Putting it in
   the stream means the reducer must ignore some events, and "the reducer ignores some events" is
   the end of the property that makes replay trustworthy.
3. **Retirement breaks replay.** Cosmetics get retired; so will expressions — §12 already flags
   two that may be cut. If a retired id is in the log, every hand containing it either fails to
   render or renders a hole. Same failure the cosmetics rule exists to prevent.
4. **It is a permanent moderation surface.** A tokenized public replay URL (§2) is
   unauthenticated. Chatter in the log means someone's 粗口 is served to strangers forever, with
   no takedown path short of rewriting an append-only archive.

### The ephemeral channel

**Same socket, separate message family, no `seq`.** A second socket would double the reconnect
and auth surface (§5.3) for a feature that does not need durability; the DO already holds the
connection. The isolation comes from the message family, not the transport:

```ts
// protocol/src/chatter.ts — NOT exported from events.ts, NOT in ServerToSeat

/** Brand mirroring Omniscient<T> in events.ts. A value carrying this
 *  brand cannot be assigned where a RedactedGameEvent is expected. */
type Ephemeral<T> = T & { readonly __chan: "ephemeral" };

interface SendExpressionPayload { exprId: string; targetSeat?: SeatIndex }
interface ExpressionSaidPayload {
  fromSeat: SeatIndex;
  /** ALREADY softened for this receiver. The raw id never crosses. */
  exprId: string;
  targetSeat?: SeatIndex;
  /** Repeat collapse — 2 renders one bubble with ×2. */
  repeat?: number;
}
// no seq. no ts beyond wall-clock for the collapse window. no persistence.
```

The properties, each of which is a rule someone will otherwise break:

| Property | Why |
|---|---|
| **No `seq`** | `seq` is the log's spine. Giving chatter one implies an ordering guarantee against game events, which implies it is part of history. It is not. |
| **Never in the outbox** | §5.3's outbox holds hand events until R2 and D1 both confirm. Chatter never enters it and is dropped at MATCH_END with the DO. |
| **Never in `restore`** | Reconnect (§5.3) delivers snapshot + actions-since and **zero chatter backlog**. You were away; you missed it; it is gone. That is correct behaviour for speech, and it is also what stops a reconnect from replaying nine bubbles at once. |
| **Never reaches the reducer** | The DO handles it in a branch that returns before `applyAction`. One `if`, at the top, with a comment pointing here. |
| **Best-effort and unordered** relative to game events | It is not queued behind `RENDERING.md` §4's animation queue. A bubble at the right *moment* beats a bubble in the right *order*, and the queue can be dropped wholesale on resync. |
| **Branded** | `Ephemeral<T>` mirrors the existing `Omniscient<T>` brand so smuggling chatter into a log writer is a compile error rather than a code-review catch. The repo already relies on this technique; use it again. |

**Bots emit chatter through the same channel**, generated server-side from engine events and
paced through the existing `botPace` deadline (§5.3) so a bot's reaction time never leaks
information. Bot chatter is never logged either — a bot cursing when it deals in is texture, not
data, and it must not contaminate gate-3 behavioural metrics.

**The tradeoff, stated:** replays are silent. Shared replay links reproduce the hand, not the
table talk. That is the right trade — the corpus stays clean and the public replay surface stays
moderation-free. If replays-with-talk ever becomes worth building, the answer is a **sidecar**:
its own store, its own retention policy, its own schema version, joined to the replay by
timestamp *at render time*, never merged into the event log's schema. Marked open in §12.

## 10. Effort and what to actually ship at P0

DESIGN.md §3 prices P0 at 9-12 FT weeks with **no line item for this**. So this is an addition,
and it should be accepted or cut on purpose rather than absorbed.

| Piece | Est. |
|---|---|
| `protocol/src/chatter.ts` + DO branch + token bucket + server-side soften/mute | 0.3 wk |
| Client: wheel, bubble render, settings screen, seat-aim licensing | 0.5-0.7 wk |
| Catalogue authoring | done (this file + `catalogue.ts`) |
| Native-speaker review pass (2 HK players, LA scene) | 0.1 wk + their time |
| Bot chatter policy table | 0.2 wk |
| VO (P1) | separate; a recording session, not engineering |
| **Total if shipped whole at P0** | **~1.1-1.3 wk** |

**Recommended cut for P0** — roughly 0.5 wk, and it gets ~90% of the §1 and §2 value:

- Text bubbles, no VO beyond the call audio Track A already scopes.
- The 8-entry starter wheel plus milestone unlocks (the unlock evaluator is a platform read over
  match summaries; it is cheap and it is the teaching mechanism).
- Tiers, send/receive settings, room cap, server-side softening. **Do not defer the tier model** —
  retrofitting consent onto a shipped chat system is how products end up with a bad one.
- Token bucket, repeat collapse, mute, aim rules.
- **Defer:** voice characters, the report button (P1 per §5.3), the acquisition-by-imitation tap,
  the wheel's per-moment context pages (ship one flat page first).

## 11. Where the files go

```
mjrc-game/
  EXPRESSIONS.md                          this document
  client/src/expressions/catalogue.ts     pure data + lookups. zero imports.
  client/src/expressions/wheel.tsx        (not written) input surface
  client/src/expressions/bubble.tsx       (not written) render surface
  protocol/src/chatter.ts                 (not written) §9. NOT re-exported from index.ts
```

`catalogue.ts` imports nothing — not the engine, not the protocol, not a UI library. That is
checked by reading the file, and it should stay checkable that way. `client/` has no
`package.json` or `tsconfig.json` yet; the catalogue typechecks standalone under
`tsconfig.base.json`'s options today, and `catalogueProblems()` should be wired into the vitest
run the moment `client/` becomes a workspace.

## 12. Open decisions

1. **Native-speaker review — blocking.** The characters are the safe part; register is not.
   Four entries are flagged `needsReview` in the catalogue and need a ruling:
   - `做人心抱甚艱難` — confirm it reads as comic long-suffering, not actual complaint; confirm
     心抱 vs 新抱.
   - `打牌唔係做功課` — tiered `salty` on edge rather than vocabulary. Right call, or is it clean?
   - `神經病` — literal reading is a slur on mental illness. **Ship, or cut?** Recommendation: cut.
     It is the least funny entry in the file and it is the only one carrying that liability.
   - `冚家鏟` — literally wishes a family dead, which is in tension with §8's aim rule, but in
     actual HK use it is a general oath. Ships hard-pinned to `luck` or does not ship. Do not
     compromise by softening it.
2. **Does 粗口 need an age posture at open registration?** At invite-only, no. At P1 open
   registration, "off by default for unverified accounts" is probably the answer, and it may
   need an attestation. Not inventing one here.
3. **Who sets the room cap** — host only, or a room role? Blocks on PAGE-INVENTORY §3's room-admin
   design (P1). Default `salty` works until then.
4. **Chatter sidecar for replays** — build, or never? §9 has the shape if the answer is ever yes.
   Recommendation: never, until someone asks twice.
5. **Do bots swear, and how much?** Recommendation: yes, capped at one tier below the room cap,
   never seat-aimed, on a lower send rate than a human's bucket. A bot that swears exactly as
   much as a person is uncanny; one that never does is furniture.
6. **Milestone unlocks need an evaluator.** It reads match summaries in D1, not the log, and it is
   not scoped anywhere yet. Small, but it is the mechanism §2 rests on — do not let it fall
   between the client and platform budgets.

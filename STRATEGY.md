# HK strategy — owner interview, transcribed

Source: Augustine, 2026-08-26, spoken. This is the human prior the bot search is
seeded with, and the eventual strategy content's first draft. Terminology per
TERMINOLOGY.md — English leads, Cantonese follows.

---

## 0. The governing principle: variance discipline

> "You learn a lot from losing. Big hands all the time will lose. Small hands
> all the time will lose."

No pure strategy survives. Always racing for cheap 3-faan hands loses; always
building limit hands loses. The skill is *mixing* — and the mix is conditioned
on the deal, the seat, and what the table is doing. This is the single most
important thing the optimizer must be able to express: **route choice is a
distribution, not a rule.**

A second reading, just as important for the product: losses are informative.
The review surface should treat lost hands as the primary study object, not
wins.

## 1. The opening read (first ~1 turn, in order)

1. **Position first.** What is my seat wind, what is the round wind — do winds
   mean anything to me this hand?
2. **Honours inventory.** Any dragon/wind pairs — potential cheap faan.
3. **Suit shape.** Which suit is long, which is short. This drives everything.
4. **Route sketch.** Given a 3-faan floor, what is the *cheapest realistic path*
   to legality? "Usually the easiest way there is half flush or all pungs."
5. Bad hand → bias to **half flush 混一色** (dump one suit and go).

The route plan exists from tile one — "usually from the very first moment there
is some rudimentary strategy on how to get 3 faan." Faan planning is an
*opening* activity, not a mid-hand repair. (The current bot already picks a
route at deal — this confirms that design; what it lacks is everything below.)

## 2. The routes actually played

| Route | When | Note |
|---|---|---|
| Half flush 混一色 | the default rescue; most flexible | "if my hand is really bad I bias toward a half flush" |
| All pungs 對對糊 | lots of pairs in the deal | also the *defensive pivot* — lets you hold an opponent's suit |
| All chows + flower + concealed | the minimal scrape | "you pray for one flower… get your last point" |
| Full flush 清一色 | long suit AND the left player is feeding it | committed late, hidden as long as possible |
| Dragons/winds add-ons | pairs of 中發白 or own wind | license to play "a little more aggressive" |
| **Thirteen Orphans 十三么** | **desperation**: 7–8 orphans in an otherwise fragmented deal | "the hand is so bad it's worth going all out" — bail path: all pungs / terminals / pure defense |

There is **no fixed default**: "it depends on what allows you to win the most
and lose the least given the circumstances." Route value includes *defensive*
value — all pungs is partly chosen because holding a dangerous suit is safe in
it.

## 3. Information warfare (the biggest gap vs the current bot)

The interview's dominant theme. Every discard is a *message*, and good play
manages both directions of the channel:

- **Discard-order bluffing.** Holding 1 character + 3 bamboo, sometimes throw
  the *bamboo* first — "so I can bluff longer… people don't know if I'm doing
  characters or circles."
- **Honours early as a triple move**: cleans the hand toward a flush, sheds the
  dangerous tiles while it's safe, and *hides* the flush plan — by the time the
  honours are gone, "people don't know where I'm at."
- **Reading the table from turn one**: the first discards tell you each seat's
  suit. Left player discarding your suit → shift toward taking from them.
  Right player collecting your suit → consider holding their tiles (all pungs
  pivot).
- **The left-player relationship is the axis of the whole game**: chows come
  only from the left, so "will my left feed me?" decides route viability — and
  its failure is the #1 bail trigger (§6).
- **Sharks hide big hands.** "The really good players hide if they're going for
  big hands… not displaying too much information unless they really have to."

Bot implication: none of this exists today. It needs (a) per-seat suit-intent
estimation from discard history, (b) a deception term in discard choice — value
of *not* revealing route — and (c) feed-awareness: expected chow supply from
the left seat. These are new features, not weight tunings.

## 4. Claim discipline (signaling cost, not just tempo cost)

- **Pung early is cheap information-wise** — "maybe you're going for that suit,
  maybe half flush, maybe all pungs. A lot of options."
- **Chow early is a confession** — it commits you, and it tells the table your
  hand is either flush-bound or weak. "Very rare to chow early unless the hand
  promises a half flush or full flush."
- **Kong refusal is real**: late game, a kong (a) adds no faan by itself,
  (b) *breaks a safe triple* you could discard from, (c) reveals information.
  "Sometimes I will refuse it."
- Beginners' error: claiming everything — inflexible hand + broadcast intent.

Bot implication: claim evaluation needs a *signal cost* term and a *late-game
kong-refusal* rule (keep the triple as ammunition). The current
`claimRouteTolerance` captures the commitment cost but not the information
cost.

## 5. Defense

- Push/fold is **hand-size conditioned**: "if my hand is 6–10 points I'll take
  more risk; if it's small I won't."
- Danger reading is weak-signal: adjacency inference ("they chowed 2-3-4 then
  threw a 6 — maybe they hold around there"). Owner's own words: "no real
  science" — so the bot should *not* pretend to precise deal-in probabilities;
  count-based safety plus route-of-opponent inference matches expert practice.

## 6. Bailing

Rare. The one hard trigger: **the left player will not feed you** — "if I'm
going for circles and the left player is also going for circles, I will bail
and start throwing my circles." Turn count and opponent melds matter, but the
feed relationship dominates.

## 7. Open sim questions from the interview

1. **Thirteen Orphans frequency**: if one seat commits at 7/8/9 orphans in the
   deal, how often does it complete? (Owner explicitly asked. Cheap to run.)
2. Half-flush-as-rescue: measured EV of the "dump a suit" rescue vs playing the
   fragmented hand straight.
3. The bamboo bluff: does discard-order deception measurably reduce deal-ins
   against inference-running opponents? (Needs §3's inference bot first.)
4. Optimal big/small hand mix under the payment table — the §0 question.

## 8. Mapping to the optimizer

| Interview finding | Today | Needed |
|---|---|---|
| Route from tile one | ✓ `assessRoutes` at deal | ✓ |
| Route mix, not rule | weights are static | per-deal-quality route priors (searchable) |
| Half flush as rescue | partially (route scoring) | explicit bad-hand bias term |
| 13 Orphans desperation route | ✗ no orphans template | new route template + bail path |
| Signal cost of claims | ✗ | new term |
| Discard-order deception | ✗ | new feature (post-inference) |
| Left-feed awareness | ✗ | new feature |
| Hand-size-conditioned defense | partial (`discardSafetyWeight`) | condition on own route faan |
| Late kong refusal | ✗ | new rule |

## Owner rulings — 2026-08-28 (score, folding, concealed threats)

1. **Chips are the objective, not placement.** "In practice placement does not matter in mj. The number of chips is how much you lose." Consequence: evolution's promotion fitness (placement points +3/+1/−1/−3) contradicts the owner's objective — switch to chips/match for era 3.
2. **Score-aware play** (approved as a capability): when LEADING — win fast OR take big swings, but above all try very hard not to lose (defense scales up with a lead). When LOSING — take bigger swings; losing matters slightly less (loss-aversion scales down).
3. **Concealed threat reading: deprioritized.** A concealed threat is either a super-rare massive hand (unreadable) or a concealed chow hand at minimum points (fast but small) — neither worth defending against. The correct response to a suspected concealed chow racer is TEMPO, not defense.
4. **Folding**: small hand vs a shown ~7-point threat → fold; a 7+ hand vs the same → maybe push. The owner is explicit that the mathematically correct threshold is unknown — this is exactly what evolution should be allowed to find (fold trigger as evolvable dials).

# Match 3729651 — the champion's best game, dissected

**Transcript:** `/Users/augustineliu/Local_Projects/mjrc/mjrc-game/tools/sim/best-game-champion.txt/match-3729651.txt`
**Setup:** champion (`hall-of-fame.json`, ★ in the transcript) vs three frozen `baseline-v0` bots. One wind round, 11 hands. Champion finishes **+432**.

**Selection disclosure:** this is the champion's best result out of 40 seeds scanned. It is deliberately a highlight reel, not a typical game (typical = +31 to +70 per match averaged over 160-match blocks).

---

## 1. Luck or mutation? — the control experiment

Same seed, same walls, same three baseline opponents, but with a **baseline bot swapped into the champion's chair**:

| chair-0 bot | result |
|---|---|
| baseline-v0 (control) | **−72** |
| champion (this transcript) | **+432** |

A 504-chip swing on identical tiles. The deals in hands 3 and 10 were genuinely favourable (that part is luck, and why this seed won the best-of-40 scan), but the baseline holding the same tiles *lost the match*. The conversion — route pivots, claimed pungs, staying at the table — is the mutations. (Caveat: after the first differing discard the two games diverge, so this isn't tile-for-tile; that divergence is precisely the point.)

## 2. Where the +432 came from

| hand | ★ seat | what happened | chips | running |
|---|---|---|---|---|
| 0 | East | wall exhausted 流局 | 0 | 0 |
| 1 | East | wall exhausted 流局 | 0 | 0 |
| 2 | East | baseline self-draws 3 faan, everyone pays | −8 | −8 |
| 3 | North | **★ self-draws 10 faan** 清一色+對對糊 | **+384** | +376 |
| 4 | West | ★ **deals in** to East's 7-faan 對對糊+混一色 | −96 | +280 |
| 5 | West | ★ **deals in** to North's 4-faan 對對糊 | −32 | +248 |
| 6 | South | baseline self-draws 3 faan | −8 | +240 |
| 7 | South | baseline wins off another baseline | 0 | +240 |
| 8 | South | wall exhausted 流局 | 0 | +240 |
| 9 | South | baseline wins off another baseline | 0 | +240 |
| 10 | South | **★ self-draws 8 faan** 清一色 | **+192** | **+432** |

Anatomy: **+576 won, −144 lost.** That is the champion's signature texture in one match — two huge converted hands swamp two moderate deal-ins. It is *not* a defensive bot; it wins the race more than it dodges.

## 3. Hand 3: the 384-chip hand

Dealt (as North★): `4萬 5萬 7萬 · 2| 3| 5| 7| · 8● 8● 9● 9● · 發` — a scattered three-suit hand whose only real asset is two circle pairs.

What the champion did with it:
- Pivoted its route to circles and **claimed relentlessly**: pung 8● (off West), pung 9● (off South), pung 7● (off South) — three exposed pungs built entirely from opponents' discards.
- The table *saw it coming*. East's think block reads: `North … collecting ● (1.00) · threat 0.68 · 3/4 melded`. The read fired perfectly.
- The baselines fed it anyway — `baseline-v0` has `threatSensitivity: 0` **by construction**. It can see the threat model's output but weighs it at zero. The champion's edge vs this opponent is partly "punish the threat-blind."
- Self-drew 1● to finish: `1●1●1● 5●5●` + three pungs = **All Pungs 3 + Full Flush 6 + Self-Draw 1 = 10 faan**, 128 from each seat.

The strategic content: converting a mediocre deal into 清一色 through claims is exactly what `aggression` (+65% over seed) and `faanWeight` (+70%) bought. The baseline's own think blocks in the same hand priced flush routes at −7 to −8 and sat on "balanced/chows" the whole game.

## 4. Hand 10: the closer

The champion's own thinking is on the record here (think blocks, correctly attributed after the seat-name fix):

- At discard 48: `pung-flush | score 5.39 · pays 9 faan · 2 away` chosen over `flush | score 3.34 · pays 6 faan · 1 away` — it deliberately ranked the bigger hand above the faster one.
- At discard 64 it was ready (`flush | … -1 away`) and holding the wait `2|2| 6|7| 8|8|8|` + pungs 1|, 3|. Drew-and-cut the dead 9萬, then self-drew 5| → **Full Flush 6 + Self-Draw 1 + No Flowers 1 = 8 faan**, 64 from each.
- Meanwhile the endgame was warped by the 3-faan floor: **five refused-win events** in this hand alone (North twice, West twice, East once — all holding 0–2 faan shapes). The champion was never below the floor; the baselines camped on unpayable hands.

## 5. The cost side — two deal-ins, honestly

The champion's weakness is on display in hands 4–5, and it matters because a human opponent would exploit it harder than the baseline does:

**Hand 4 (−96).** While chasing its own pung-flush 萬, the champion fed East *three* pungs from its own cuts (3|, 7|, 4|). East reached four exposed melds — 西西西 showing, an obvious 混一色/對對糊 — with the table read screaming `threat 0.74 · collecting | (1.00)`. The champion then drew a fresh lone 東 (East's own seat wind AND the round wind, the classic death tile against an exposed honour collector) and **cut it right back**. Single-wait pair completion, 7 faan, −96. A human never cuts that tile there.

**Hand 5 (−32).** North showed a kong of 9萬 and an added kong of 6●, read `collecting 萬`. The champion drew 2萬 and cut it right back into 對對糊.

Root cause: evolution *cut* `discardSafetyWeight` by 33% (0.45 → 0.30) because against threat-blind opponents, trading safety for speed is profitable on net (this very match proves it: −128 in deal-ins, +576 in wins). Against threat-aware or human opponents that trade gets worse.

**Improvement backlog from these two hands:**
1. Honour-tile danger should scale with an opponent's exposed honour pungs and double-wind status (the 東 blunder).
2. Feed-denial: the claim/discard model knows `leftFeed` for its own supply but never *withholds* tiles from a visible collector it has already fed.
3. A fold gate: opponent ≥3 melds + own distance ≥2 should bias hard toward safe cuts; race pressure currently only discounts distant plans, it doesn't stop the bleeding.

## 6. Side experiment: is MORE aggression better?

Asked and answered while this analysis ran — a `champ-aggro` variant (aggression 1.65→2.14, faanWeight +15%, claim speed +20%, safety −20%) vs the champion, both on the same fresh 160-match block:

| profile | chips/match vs baseline |
|---|---|
| champion | **+31.1** |
| champ-aggro | +26.7 |

More aggression overshoots. Evolution's +65% already sits at or past the sweet spot; keep the champion's dials. (Single block, modest margin — but the direction says don't hand-tune upward.)

## 7. Transcript tooling fixed during this analysis

- **Think-block seat names ignored wind rotation** — every block after hand 2 was attributed to the wrong seat (a hardcoded chair-name table). This initially looked like an engine suit bug; it was display-only. Fixed: blocks now use live wind names.
- **Hero identification:** ★ now marks the champion on every line, through all rotations.
- **Notation:** bamboo `N|` (sticks), circles `N●` (dots), characters keep `N萬`.
- **Per-move state:** every cut now shows the full resulting hand plus melds (`│ hand ‖ 碰8● 槓9萬`).
- Cosmetic open item: a ready 14-tile shape prints `-1 away` in think blocks; the distance convention for 3n+2 shapes should clamp to 0 for display.

## 8. Bottom line

Not luck. The same chair with the same tiles loses 72 chips under the old brain. The champion's mutations — value big hands, claim boldly, stay at the table — turned two good-but-unfinished deals into 576 chips of self-drawn flushes, and the cost of its known weakness (loose discards under visible threat) was 128. Against threat-blind baselines that trade is lopsidedly profitable; against humans, hands 4–5 are the tape to study.

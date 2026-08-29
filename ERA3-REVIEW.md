# Era 3 — retrospective (2026-08-28 → 08-29)

**The question it asked:** era 2 proved dial-*tuning* saturates against a defending enemy. Era 3 added
*capabilities* — score awareness (leadDefense / trailSwing / winFastLead), an evolvable hard fold
(foldThreshold), feed denial — switched fitness to **chips** (owner ruling: placement doesn't matter),
and asked whether new senses beat the wall that new weights couldn't.

**The headline answer: no — on chips.** 62 cycles, 26 admissions, exam scores vs baseline-v2:
mean **−9.1**, sd 18.7, range −61 to +28. The final 3-block tournament put the era-3 king at **+0.2
mean vs v2 — par**. Twenty-six kings were crowned and the throne went nowhere.

## But the dial journey is the real finding

What evolution did with the new capabilities, seeded → final:

| dial | seeded → final | evolution's verdict |
|---|---|---|
| foldThreshold | 0.5 → **0.90** | keep the hard fold, but as a rare emergency brake — nearly doubled the trigger |
| threatSensitivity | 0.81 → **0.20** | gutted the continuous fear apparatus (−76%) |
| feedDenial | 0.3 → **0.04** | rejected — withholding tiles isn't worth tempo vs bots |
| leadDefense / winFastLead | 0.3 → 0.15 / 0.21 | mildly trimmed |
| trailSwing | 0.3 → 0.30 | never touched — apparently neutral |
| discardRouteWeight | 1.29 → **4.35** | +236%: total route commitment — tunnel vision won |
| claimSpeedGain | 1.05 → **0.22** | claims taken far more freely |
| chipValuation | 0.87 → 0.45 | continued drift back toward linear faan |

Read as one sentence: **against bots, fear is mostly dead weight** — evolution kept a high-threshold
panic button and deleted the rest, three days before the persona experiment proved the same thing by
hand (fear removal costs ~3 chips). The owner's fold question ("small vs a shown 7 → fold; 7 vs 7 →
push; the correct line is unknown") got its empirical answer for bot-vs-bot play: *fold far less than
a human would — the table's threats are rarely worth respecting.* Whether that holds against humans
(who bluff, which bots never do) is explicitly untested and is the era-5 question.

## Why the chips result should be trusted only loosely

Era 3 was the least controlled experiment of the four eras. Mid-era: cycles cut 16 → 8 generations,
the mutation operator replaced (sparse hard kicks + wild candidate), adaptive sigma added, the
distance engine swapped (proven byte-identical), an era-label logging bug fixed with harness restarts
by a second session, and tournament/persona experiments sharing the CPU. The *conclusion* (par vs v2,
from the clean 3-block tournament) is solid; *attribution* of the stall to any one cause is not.

Also on the record: 26 same-block admissions with a +4 margin produced a chain whose exam mean sat
*below* par — the admission gate at that margin, re-rolled across 62 blocks, admits enough noise to
random-walk sideways. This directly motivated era 4's margin raise to 6.

## The salvage — era 3's actual products

1. **Evolution's fold ruling** (above) — the single most interpretable result of the whole project.
2. **The substrate for era 4's win.** Era 4 took this exact genome, changed only the *regime* (league
   exams vs {v3, v2, persona}, margin 6, CMA rotation), and gained **+17 league chips in 89 cycles**.
   Tellingly, the league partially *reversed* era 3: claimSpeedGain +307%, threatPushValue +147%,
   foldThreshold back down to 0.58, aggression +25%. Against a mixed field, some fear and much more
   claiming became valuable again. Era 3's dials weren't wrong — they were overfit to one enemy,
   which is precisely what the league was built to punish.
3. **Most of the measurement canon** was hardened during era 3: all-seats evaluation, the enemy-naming
   rule, block-luck discipline (the cycle-7 "+27.2 king" was later measured at true −34), the
   distance-engine speedup that made 2.5-minute cycles and cheap tournaments possible.

## Verdict

As a chips experiment: a null result, honestly earned and twice confirmed. As a research program:
the era that answered the fold question, exposed the admission gate's noise floor, and bred the
genome that — under the right selection regime — became the strongest bot of the project. Eras
should be judged by what they teach, and era 3 taught more per chip than any other.

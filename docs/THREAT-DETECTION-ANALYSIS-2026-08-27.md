# Threat Detection — Analysis (2026-08-27)

Read-only analysis. No sim/engine files touched (overnight run live, cycle 33).

## 1. What exists

| File | Role |
|---|---|
| `mjrc-game/engine/src/threat.ts` (203 lines) | Core model: `readDiscards`, `assessSeatThreat`, `tableThreat`, `feedsSeat` |
| `mjrc-game/engine/src/bots.ts:741` | **Second, older** threat heuristic `seatThreat()` feeding `discardDanger` |
| `mjrc-game/engine/test/threat.test.ts` | 13 tests: tells, dial gating, route economics |
| `mjrc-game/tools/sim/threat-audit.ts` | Empirical audit: detection/false-alarm/faan calibration over N matches |
| `mjrc-game/tools/sim/threat-audit.js` | Latest results (30 matches, 2026-08-27 16:56) |

The model is public-information-only (derives from `SeatView`), which is the right
constraint — bots see what a human in the chair sees.

**Signals per opponent seat** (`assessSeatThreat`):
- `exposure` = melds/4
- `intentSuit` + `intentStrength` — dominant melded suit, boosted by discard starvation
- `readyProxy` — middle-tile (3-7) share of last 6 discards minus first 6 (the
  "cutting fresh draws" tell)
- `DiscardRead` — four owner-interview tells: `suitPhasing` (one suit at a time = big),
  `earlySpread` (all 3 suits in first 6 = all-pungs lean), `lateHonours` (nearly ready),
  `earlyValueHonours` (hiding a big hand)
- `expectedFaan` → `chipsRel` through the ruleset's actual payment table — sizes the
  threat in chips, not faan. Correct given the exponential ladder.

**Consumption** (`rankDiscards`, bots.ts:844):
```
foldFactor = max(0, table.max − ownStrength × threatPushValue)      // push/fold
threatDanger = Σ threat × feedsSeat(tile) × min(chipsRel,16)/4
score −= threatDanger × foldFactor × threatSensitivity
```
Plus route-level consumers: `urgencyWeight` (race pressure discounts slow routes) and
`suitContestWeight` (contested-suit pricing via `suitDepletion`). All three dials are
ON in the current hall-of-fame profile (sens 0.96, push 0.76, urgency 0.42, contest 0.89)
— the mechanism survived selection and is active in the overnight run.

## 2. Measured performance (threat-audit, 30 matches / 166 wins)

| Metric | Value | Read |
|---|---|---|
| detectionRate (threat > 0.3 on winner) | **34.9%** | 2 of 3 winners unflagged |
| falseAlarmRate (threat > 0.5, non-winner) | **71.6%** | vs ~75% chance baseline* |
| faanBias | **+0.75** | systematic ~1.7× chip overestimate |
| faanMAE | **1.4** | ~2.6× chip error typical |

\* If strong flags were uninformative, ~3/4 of them would land on non-winners (one
winner among 4 read seats). 71.6% vs 75% means the >0.5 flag carries **only marginal
signal**. The composite score discriminates weakly at the top end; most of the working
value is coming through `feedsSeat`/suit-avoidance and route pricing, not the scalar.

Caveats on the audit itself:
- 30 matches / 166 wins is thin; falseAlarmRate is estimated from ~102 strong flags.
- Detection threshold (0.3) and false-alarm threshold (0.5) differ — not a single
  operating point, so the two numbers aren't a proper ROC pair.
- "False alarm" counts seats that didn't win *that hand*; a genuinely ready seat that
  lost the race is scored as a false alarm. The metric structurally overstates error —
  but the chance-baseline comparison above already accounts for that.
- No split by concealed vs exposed winners. Given finding #1 below, that's the one
  cut that would explain the 35% detection number.

## 2b. Addendum 2026-08-28 — finding #1 measured and confirmed

One-off scratchpad audit (`winner-exposure.ts`, 40 self-play matches per profile,
winner meld count captured at the win, detection = threat > 0.3 on the winner just
before the win):

**baseline-v0** (the overnight opponent) — 212 wins:

| winner melds | share of wins | mean faan | detection |
|---|---|---|---|
| 0 (concealed) | **47.2%** | 3.40 | **3%** |
| 1 | 19.3% | 3.90 | 56% |
| 2 | 25.0% | 4.02 | 96% |
| 3-4 | 8.4% | ~4.7 | 100% |

**hall-of-fame champion** — 217 wins: concealed share 33.6% at 5% detection; 1 meld
69%, 2+ melds 100%.

Reading: the threat scalar is, in practice, a meld counter. At 2+ melds detection is
~certain; at 0 melds it's ~zero. Since baseline-v0 wins **fully concealed almost half
the time**, roughly half of all baseline wins are invisible to any defender profile —
which both explains the 34.9% aggregate detection rate and caps how much chip value
`threatSensitivity` can ever earn against this opponent. It also means the false-alarm
number mostly measures "seats with 2 melds that didn't win," not bad reads.

Training-loop risk worth watching: in mirror cycles, evolution is playing against its
own threat model, so "win concealed" is a detection-evasion strategy the loop could
drift toward for free. The champion's concealed share (33.6%) is currently *below*
baseline's (47.2%) — the claim-supply credit pushed the other way — so no evasion drift
yet, but it's worth re-measuring across eras.

## 3. Findings, ranked

### 1. Concealed hands are near-invisible — likely the main detection hole
`threat = clamp01(exposure×0.5 + readyProxy×0.3 + lateHonours×0.3 + intentStrength×0.15)`.
With zero melds: `intentStrength` is unreachable (needs `topMelded ≥ 3`, melds only),
`readyProxy` needs a strong mid-tile shift, so a concealed seat realistically tops out
around 0.3–0.4 and usually sits far below the 0.3 detection threshold. The legacy
`seatThreat()` acknowledges exactly this with a 0.35 base rate ("a seat sitting fully
concealed is unreadable and gets the base rate"); `assessSeatThreat` has no floor.
Any bot that wins concealed — and the concealed scrape was historically the bots'
favourite road — is undetectable. Prediction: the audit split by winner exposure will
show detection heavily concentrated on 2+-meld winners.

### 2. Concealed flush collectors trigger no suit avoidance
`intentSuit` comes only from melds. `readDiscards.suitPhasing` *detects* a flush being
built from discards alone (and bumps `expectedFaan` +2), but never identifies **which**
suit — the starved suit is implied by the phasing (the one missing from their cuts) and
is never computed. `feedsSeat` returns 0 for every suited tile against a concealed
collector, so the bot knows "someone has a big hand" but not what's unsafe to cut.
The tell is half-wired: it raises the alarm volume but not the direction.

### 3. Two parallel threat systems double-count the same signal
`discardDanger` (bots.ts:790) has its own `seatThreat()` + `flushSuitOf()` and charges
`1.1 × threat` for feeding a 2-meld single-suit collector. `threatDanger` charges the
same event again via `feedsSeat × chipsRel`. Both enter the score
(`danger×discardSafetyWeight` + `threatDanger×foldFactor×threatSensitivity`). Not a
correctness bug — but the evolved weights (safetyWeight 0.30 vs default 0.45) are now
compensating for overlap, which makes every individual dial uninterpretable and lets
evolution silently trade one path against the other. Worth a deliberate merge decision
eventually: either `discardDanger` keeps only copy-counting/chow-exposure and all
seat-read logic moves to threat.ts, or document the split as intentional.

### 4. expectedFaan is miscalibrated high (+0.75 faan)
On a doubling ladder that's ~1.7× systematic chip overestimate, and it feeds directly
into `threatDanger` via `chipsRel`. The additive bumps (+2 flush trajectory, +2 early
value honours, +1 strong intent) were set by intuition, not fit. Since the audit
already logs per-win `(expectedFaan − actualFaan)`, fitting those three constants to
the residuals is nearly free. Bias matters less than it looks — chipsRel is capped at
16 and only sets *relative* fold pressure — but the cap being hit early compresses the
big-hand/small-hand distinction the whole design exists to make.

### 5. The "dials off = byte-identical" test is currently a tautology
`threat.test.ts:41` compares `DEFAULT_PROFILE` against `DEFAULT_PROFILE` with
`threatSensitivity: 0, threatPushValue: 0` — but the defaults are already 0/0, so both
sides are the same profile and the test can't fail on the property it names. It does
work as a canary (fails if someone flips the default on), which has value, but the
actual guarantee — "zeroing the dials on an otherwise-aware profile reproduces blind
ranking" — is untested. Note also `tableRead` gates on `urgencyWeight`/
`suitContestWeight` too (both non-zero in DEFAULT), so "blind" default still computes
the table read every decision; the zero-cost claim in the bots.ts comment holds for the
discard term but not for route choice.

### 6. feedsSeat honour handling is coarse
`isHonour → 0.6 if exposure ≥ 0.5 else 0.2`, flat. No copy counting: an honour with 3
copies visible (dead) prices the same as a live one. `discardDanger` does count copies,
so the combined score partly covers this — but only through the double-counted legacy
path (#3). Also `feedsSeat` ignores `DiscardRead` entirely.

### 7. Audit harness nits
- `reads[s]` is overwritten by whichever seat acts each step, so the "read of the
  winner" is from an arbitrary observer. Harmless today (all observers see identical
  public state) but it will silently break if `SeatView` ever gains observer-relative
  information.
- `readyProxy` folds `exposure×0.3` in, and `readiness` adds `exposure×0.5` again —
  exposure enters the composite twice with an effective weight of ~0.59.

## 4. What's deliberately absent (and correctly so)

- No "their own discard is safe against them" rule — HKOS has no furiten; the code
  comment (bots.ts:786) explicitly declines to reproduce the prototype's borrowed rule.
- No engine-internal peeking — everything derives from `SeatView`.
- Evolution can't turn the feature on/off itself (multiplicative mutation preserves 0)
  — feature enablement is a human decision. Good separation.

## 5. Cheapest next measurements (in order of information per effort)

1. Re-run `threat-audit.mjs 200` and split detection by winner meld count (0 / 1 / 2+).
   Confirms or kills finding #1 with one histogram.
2. Sweep the flag threshold (0.1–0.7) in the same run → actual ROC, replacing the
   mismatched 0.3/0.5 pair.
3. Fit the three `expectedFaan` bump constants to the logged residuals (least squares
   on ~166+ samples). Fixes #4 without touching structure.
4. Compute the starved suit in `readDiscards` (argmin of suited cut share when
   `suitPhasing > 0.55`) and let `feedsSeat` use it — closes #2, the biggest
   behavioural gap, with ~10 lines.
5. A/B `cand-defender.json` vs hall-of-fame after the overnight run finishes to
   check whether higher sensitivity (1.0/0.8) beats evolved (0.96/0.76) — the files
   are already staged for this.

None of these should run until the overnight series finishes (~5h remaining at last
status write).

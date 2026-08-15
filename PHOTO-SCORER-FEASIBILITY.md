# Photo → Digital → Score: HK Mahjong Hand Scorer — Feasibility Notes

Side-quest idea captured from a brainstorming session. Target ruleset: **Hong Kong (faan-based)**.
Goal: take a photo of a mahjong hand, convert it to a digital game state, and compute the score.

---

## The task is three separate problems (people conflate them)

### 1. Tile recognition (CV) — Medium, mostly solved, reuse don't rebuild
- Tiny fixed vocabulary (~34 core faces + honors). Object detection (YOLO-class) handles this well.
- Existing Riichi work is directly reusable — tile faces are near-identical:
  - RiichiCam (camera-based scorer): https://riichi-cam.vercel.app/
  - Raspberry Pi YOLO Riichi detector: https://github.com/Yanuk-K/Raspberry-Pi-YOLO-Riichi-Mahjong
  - Tile image recognizer backend: https://github.com/saki-rinshan/RiichiMahjongCalculatorBackend
  - Older segmentation approach: https://github.com/hlin117/mahjongCV
- **HK-specific change:** add ~8 flower/season tile classes and retrain. Minor but required.

### 2. Reconstructing game state from the photo — friendlier in HK than Riichi
- HK is **easier** here: exposed melds are physically laid down face-up, and the discarded
  (claimed) tile is rotated to show who it came from. So concealed vs. exposed is often
  literally visible in the layout — a photo carries more recoverable structure than Riichi.
- Still NOT in the photo (need tap-in fields):
  - Self-draw (自摸) vs. win-by-discard — changes faan and who pays
  - Wait type (邊張 / 坎張 / 單吊) if house rules score it
  - Flowers/seasons sitting off to the side

### 3. Scoring engine — simple logic, but you build it yourself
- HK is simpler than Riichi on logic: **no fu, no dora, no riichi/ippatsu.** Just pattern-match
  the hand against a faan table (清一色, 混一色, 對對糊, etc.) and sum.
- BUT open-source mahjong scoring is dominated by Riichi. For HK you'll likely **build the
  faan engine yourself.** It's a bounded pattern-matcher — not hard, but yours to own.
- Riichi scoring libs (for reference/architecture only, not directly usable):
  - mahc (Rust lib/CLI): https://github.com/DrCheeseFace/mahc
  - mahjong-utils app: https://github.com/ssttkkl/mahjong-utils-app

---

## The real blocker for HK: house-rule fragmentation

There is no single HK ruleset. This is the 80% of the actual work.
- "Old style" (heavy faan) vs. modern **3-faan-minimum** (起胡) tables score the same hand differently.
- Faan value of a given pattern varies table to table.
- Payout math is local convention: discarder-pays-double vs. all-pay, the faan→points doubling
  curve, and the 滿糊 cap (10 or 13 faan).

=> "The scorer" is only correct *relative to a config you pin down*. Get the config wrong and
you're confidently wrong at half the tables. **Decision needed:** whose HK rules are we encoding?

---

## Recommended MVP scope + build order

De-risking principle: **the CV is the fun part but the rules config is where it dies.**

1. **Build the faan engine FIRST as a pure function** — `(tiles + flags) → score`.
   Validate against a stack of known scored hands *before touching the camera*.
   Make the faan table + payout rules a config, not hardcoded.
2. Constrain input: top-down photo of a **declared winning hand** only (not mid-game).
3. Self-draw / flowers / wait-type = tap-in fields in the UI.
4. Fine-tune an existing Riichi detector; add flower classes.
5. Wire CV output → engine input.

Realistic estimate: a few weeks for ONE fixed ruleset. Multiplies with each ruleset variant supported.

---

## Open question that decides the whole shape

Is this a **personal toy** (one ruleset, single user) or something to **point mjrc players at**?
- Personal toy: hardcode one ruleset, ship fast.
- Community tool: forces the configurable-ruleset problem — that's the real project.

---

## Sources
- https://riichi-cam.vercel.app/
- https://github.com/Yanuk-K/Raspberry-Pi-YOLO-Riichi-Mahjong
- https://github.com/saki-rinshan/RiichiMahjongCalculatorBackend
- https://github.com/DrCheeseFace/mahc
- https://github.com/hlin117/mahjongCV

# Golden-hand review sheet

DESIGN.md §8 specifies two validation harnesses. **This is the human half of the
second one.**

> "Golden-hand suite — 100+ hand-authored canonical HKOS cases (exposed melds,
> all kong forms, flowers, winds, dealer double, subsumption edges), **answers
> validated by strong HK players.** This is the only validation source for the
> canonical extensions — the part that 'destroys credibility instantly' if
> wrong. **P0 exit requirement.**"

The fixtures in `engine/test/golden/` are TypeScript arrays of integers. A
strong HK player is not going to review 121 hands as integer arrays, which
means that as authored **the exit gate cannot be passed** — the sibling
`*.test.ts` files check that the fixtures are internally consistent, and
internal consistency is not the same thing as being right. `render.ts` turns
the fixtures into one HTML sheet with real tiles on it so the sign-off can
actually happen.

Nothing here scores anything. It renders.

---

## Running it

```sh
cd /Users/augustineliu/Local_Projects/mjrc/mjrc-game
node tools/validation/render.ts
```

Writes `tools/validation/golden-review.html` — one self-contained file, no
server, no assets, no network. Open it:

```sh
open -a "Google Chrome" /Users/augustineliu/Local_Projects/mjrc/mjrc-game/tools/validation/golden-review.html
```

`--out <path>` writes somewhere else, e.g. for emailing a copy:

```sh
node tools/validation/render.ts --out ~/Desktop/mjrc-golden-review.html
```

The run prints the per-family counts and, at the end, any case whose award list
does not price to its own stated faan. **A clean run says "No generator flags".**

### Requirements

Node 22.18 or newer, and nothing else — no packages, no build step, no
`npm install` beyond what the workspace already has.

Node is doing two things here that are worth knowing about:

- **Type stripping.** `render.ts`, the engine sources and the fixtures are all
  TypeScript. Node strips the types and runs them. Unflagged from Node 22.18.
- **A `.js` → `.ts` resolve hook.** House style puts `.js` on every relative
  import; Node does not rewrite that to the `.ts` file sitting beside it. The
  first twenty lines of `render.ts` register a hook that does, and only when
  the `.js` genuinely is not on disk. `registerHooks` landed in Node 22.15.

The generated HTML is a build artifact. It is byte-identical for identical
fixtures — no clock, no randomness — so regenerating it never churns a diff,
and a diff on it is always a real change to a case.

### Not type checked, and why

The root `npm run typecheck` enumerates `engine`, `protocol`, `rulesets` and
`worker` by name and does not reach `tools/`. `tools/replay/` is in the same
position for the same reason: there is no `@types/node` in this workspace and
DESIGN.md §8 keeps the engine dependency-free, so a file that touches
`node:fs` cannot be checked without adding a dependency. `tools/port-diff/`
carries its own `tsconfig.json` because its library half is pure and does no
I/O; this one is I/O end to end. Adding `@types/node` would fix it and is a
decision for whoever owns `package.json`.

---

## What the sheet shows, per case

| | |
|---|---|
| **手牌** | the concealed hand, sorted and split at every suit change |
| **食糊張** | the winning tile, called out on its own and marked 自摸 or 食糊 |
| **副露** | each meld separately, with 上 / 碰 / 明槓 / 暗槓 / 加槓 named, marked exposed or concealed, and the seat it was claimed from written out in words (上家 / 對家 / 下家) |
| **花** | bonus tiles, or 無花 |
| context | 門風 seat wind · 圈風 round wind · 莊家 or 閒家 · self-draw or discard · 搶槓 / 槓上開花 / 海底撈月 / 河底撈魚 / 天糊 / 地糊 where they apply · which ruleset preset the case assumes |
| the answer | the expected faan, whether the win may be taken at all, and every award in Cantonese with the English underneath and its price from that ruleset's own faan table |

Two things are computed rather than read off the fixture, and both are shown so
the reviewer can check them rather than trust them:

- **The arithmetic.** Each case's own award list is priced from the ruleset it
  names (`rulesets/src/presets.ts`), multiplicity preserved, then capped at
  that ruleset's 爆棚 limit. Where the result differs from the case's stated
  faan, the case gets a red **check the arithmetic** badge and the difference
  is spelled out. At the time of writing, all 121 cases agree.
- **Malformed fixtures.** Every case is put through `assertWellFormed` from
  `engine/test/golden/case.ts` — the shared contract, not a reimplementation of
  it — and any complaint is printed on the case.

`contested` cases carry an amber badge and the full text of the disagreement.
`refused` cases — the ones claiming the hand is under the 3-faan minimum and
may not be taken — carry a red one.

---

## The review protocol

### Who

A strong HK Old Style player. Ideally three, playing at different tables,
reviewing independently. Two reviewers who agree tell you very little when they
learned the game in the same room.

### What you are asking them

**One question, asked 121 times: is the printed faan the faan your table would
pay?**

Not "is this hand legal", not "is this a good hand". Everything else on the
sheet — the tiles, the melds, the winds — is there so the reviewer can answer
that question, and if any of it is wrong the case is wrong too and they should
say so.

Four things need saying out loud when you hand the sheet over, because a
reviewer who assumes otherwise will give you the wrong answer:

1. **Mark every case, including the obvious ones.** An unmarked case is an
   unvalidated case. "Obviously right" still needs a tick, because the whole
   value of the exercise is knowing which cases have been looked at.
2. **A disagreement is only useful with a number and a reason.** "混一色 is 3
   not 4 at my table" can be acted on. "Wrong" cannot. The sheet has a field
   for each.
3. **Contested cases are not errors — they are questions.** They are the ones
   where the six surveyed house systems already disagree. What is wanted there
   is which side the reviewer plays, not a verdict.
4. **The refused cases matter as much as the scoring ones.** A hand wrongly
   marked refused is a hand the engine will not let a player take, and that is
   the failure players notice fastest. Nobody checks these; ask for them to be
   checked.

### On screen or on paper

Both work, and the sheet is the same document either way.

- **On screen.** The marks are real form controls. Progress shows in the
  toolbar, "Contested only" and "Unmarked only" filter the page, and marks are
  saved in the browser as they are typed. **Chrome will not save anything for a
  page opened from a file** — the sheet says so at the top when that is the
  case. Press **Export marks** before closing the tab.
- **On paper.** Print it. The toolbar and the export panel drop out, cases
  never split across a page, and every mark box prints as an empty box. Expect
  roughly two cases to a page. Reviewing at a table with tiles in front of you
  is the better way to do this, and it is what the print stylesheet is for.

### What comes back

The **Export marks** button produces JSON. Ask for that, or for the marked-up
paper.

```json
{
  "suite": "mjrc-golden-hands",
  "reviewer": "…",
  "house": "…",
  "date": "…",
  "cases": 121,
  "marked": 121,
  "marks": [
    {
      "id": "basic-all-chows-melded-chicken",
      "family": "basic",
      "verdict": "disagree",
      "correctFaan": "2 — 平糊 pays 2 at my table",
      "note": "…"
    }
  ]
}
```

Nothing is uploaded anywhere. The button fills a text box; the reviewer copies
it out.

### What to do with it

The marks are evidence about the fixtures, not a patch to them. Work case by
case, and edit `engine/test/golden/*.ts` — never this directory.

| Verdict | What it means for the fixture |
|---|---|
| **agree**, from every reviewer | Flip `provisional: false` and record who signed it off in `source`. This is the only thing that retires a case, and it is the thing DESIGN.md §8 is asking for. |
| **disagree**, all reviewers giving the same answer | The case is wrong. Fix `expected`, and fix the ruleset preset if the disagreement is about a price rather than about this hand — `rulesets/src/presets.ts` is the faan table, and a price that is wrong is wrong for every case that uses it. |
| **disagree**, reviewers split | Not an error. Add a `contested:` note saying who plays it which way, keep the preset's answer as the expected value, and leave `provisional: true`. A split that the sheet did not already flag is a genuine finding — it means the six-system survey missed a live disagreement. |
| **unsure** | Chase it. An unsure from a strong player usually means the case is underspecified — some fact the scorer depends on is not stated on the sheet. Fix the fixture or the renderer, then re-ask. |

Two rules that keep this honest:

- **Never edit a case to match one reviewer.** Two independent agreements, or
  a `contested` note. Nothing in between.
- **The renderer never gets a special case.** If a hand cannot be rendered
  clearly, the fix goes in `render.ts` for every hand, or the fixture format
  gains the field it is missing. `limit.ts` already documents three facts
  `GoldenCase` cannot express (the uncapped total, which opening a hand won on,
  and 河底撈魚) — those are gaps in the contract, and they are rendered from
  `LimitCase` here rather than papered over.

### The gate

DESIGN.md §8's P0 exit requirement is met when **no case in
`engine/test/golden/` is still `provisional: true`** and every `contested` note
names the houses on both sides. Until then, a green `vitest` run means the
fixtures are self-consistent. It does not mean they are right.

---

## Terminology

Hong Kong Old Style only — `../../TERMINOLOGY.md`. That applies to the rendered
sheet as much as to the code: every label on the page leads with the Cantonese
characters and puts the English underneath, per DESIGN.md §7.

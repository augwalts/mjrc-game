/**
 * Port-diff harness, executable — DESIGN.md §8, harness 1.
 *
 * Replays the Python research engine's logged batches through this port and
 * diffs the results. READ README.md BEFORE READING A GREEN RUN: everything
 * here lives inside the CLOSED-HAND LIU SUBSET, which is all the Python engine
 * can generate. It cannot touch claims, kongs, flowers, wind faan or the dealer
 * — the canonical HKOS extensions — and those are the golden-hand suite's job
 * and the P0 exit requirement.
 *
 * ENGINE-AUDIT §3: the distance figures are diffed against an EXHAUSTIVE
 * reference recomputed by the fixture generator, never against the Python test
 * suite's expectations, whose 158 cases sit inside the ~94% the shipped cutoff
 * happens to get right.
 *
 * Terminology: ../../TERMINOLOGY.md.
 */
import { describe, expect, it } from "vitest";

import type { Ruleset } from "@mjrc/engine";
import { TILE_NAMES } from "@mjrc/engine";
import { LIU, LIU_BRACKET_PER_PLAYER } from "@mjrc/rulesets";
import { distanceToReady } from "../../engine/src/ready.js";
import { score } from "../../engine/src/scoring.js";

import fixtureJson from "./fixtures/liu-closed.json";
import sampleJson from "./fixtures/sample-batch.json";
import {
  assertTileSpacesAligned,
  compareDistance,
  compareFaanTable,
  comparePayments,
  compareScoring,
  extractScoringCases,
  formatReport,
  loadFixture,
  parseJsonl,
  PYTHON_SCORABLE,
  type ScoringCase,
} from "./compare.js";

/**
 * Both fixtures are imported rather than read off disk: the repo carries no
 * ambient node types and this harness adds no dependencies (DESIGN.md §8 —
 * engine/ is "pure TS, no deps" and the tools around it keep the same posture).
 */
const fixture = loadFixture(fixtureJson);
const { provenance, scoringCases, distanceCases } = fixture;

/**
 * The LIU preset is the one under test: DESIGN.md §4 keeps the Python engine's
 * house variant as a config preset, and it is the only preset the Python corpus
 * can speak to. hkos-standard is deliberately NOT exercised here — nothing in
 * this corpus would tell you anything about it.
 */
const UNDER_TEST: Ruleset = LIU;

/** The same price list, read with the settlement the Python engine implements. */
const LIU_PER_PLAYER: Ruleset = { ...LIU, payment: LIU_BRACKET_PER_PLAYER };

const scoringReport = compareScoring(scoringCases, score, UNDER_TEST);
const paymentReport = comparePayments(scoringCases, UNDER_TEST);
const perPlayerReport = comparePayments(scoringCases, LIU_PER_PLAYER);
const distanceReport = compareDistance(distanceCases, distanceToReady);

describe("port-diff — the closed-hand LIU subset, and only that", () => {
  it("carries a corpus with no claim, no kong, no flower and no meld in it", () => {
    // loadFixture already refuses a case holding a meld. This states the scope
    // out loud so a reader of a green run cannot miss what was NOT tested.
    expect(scoringCases.length).toBeGreaterThan(0);
    expect(provenance.handsWon).toBe(scoringCases.length);
    expect(provenance.scopeWarning).toMatch(/closed-hand liu subset only/i);
    for (const c of scoringCases) {
      expect(c.hand).toHaveLength(34);
      expect(c.hand.reduce((a, b) => a + b, 0)).toBe(14);
      expect(c.melds.every((m) => m.length === 0)).toBe(true);
    }
    // The Python model stops at 34 kinds, so a flower cannot appear at all.
    expect(Math.max(...scoringCases.map((c) => c.hand.length))).toBe(34);
  });

  it("shares the Python engine's tile numbering exactly, which the translation assumes", () => {
    assertTileSpacesAligned();
    // Spot-checks at every boundary. If either side ever renumbers, every hand
    // in the corpus silently becomes a different hand and nothing else catches it.
    expect(TILE_NAMES[0]).toBe("1萬");
    expect(TILE_NAMES[8]).toBe("9萬");
    expect(TILE_NAMES[9]).toBe("1索");
    expect(TILE_NAMES[17]).toBe("9索");
    expect(TILE_NAMES[18]).toBe("1筒");
    expect(TILE_NAMES[26]).toBe("9筒");
    expect(TILE_NAMES[27]).toBe("東");
    expect(TILE_NAMES[30]).toBe("北");
    expect(TILE_NAMES[31]).toBe("中");
    expect(TILE_NAMES[33]).toBe("白");
  });

  it("prices every pattern the Python engine can score at the same faan", () => {
    // Independent of any hand: catches a transcription slip in presets.ts that
    // no fixture happens to exercise. presets.ts claims this agreement in its
    // header; this is the claim under test.
    const { rows, disagreements } = compareFaanTable(UNDER_TEST);
    expect(rows).toHaveLength(PYTHON_SCORABLE.size);
    expect(
      disagreements.map((d) => `${d.id}: python ${d.python}, ${UNDER_TEST.id} ${d.ruleset}`),
    ).toEqual([]);
  });
});

describe("port-diff — final scores", () => {
  it("agrees with the Python engine on every hand it can express", () => {
    // "Explained" cases are hands the two engines genuinely play differently
    // (七對子 above all), each named in the divergence list. "Mismatch" is the
    // only verdict that means the port is wrong, so it is the only assertion.
    const failures = scoringReport.mismatches.map(
      (m) =>
        `${m.id}: python ${m.pythonFaan} vs port ${m.reconciledFaan ?? "-"}` +
        (m.onlyPython.length ? ` | python-only ${m.onlyPython.join(",")}` : "") +
        (m.onlyPort.length ? ` | port-only ${m.onlyPort.join(",")}` : "") +
        (m.error ? ` | ${m.error}` : "") +
        (m.note ? ` | ${m.note}` : ""),
    );
    expect(failures).toEqual([]);
  });

  it("reaches a verdict on every hand rather than skipping the awkward ones", () => {
    expect(scoringReport.agree + scoringReport.explained + scoringReport.mismatch).toBe(
      scoringCases.length,
    );
    // A run where nothing agrees would still pass the assertion above if every
    // case were "explained". It must not become a way to pass by explaining
    // everything away, so the corpus has to keep producing real agreements.
    expect(scoringReport.agree).toBeGreaterThan(0);
  });
});

describe("port-diff — chips", () => {
  it("reproduces the Python bracket table exactly under the per-player reading", () => {
    // Diffed against PYTHON's faan, so this measures the four-bracket
    // transcription in payment.ts alone (92/108 · 124/156 · 188/252 · 316/444)
    // and is undisturbed by any faan divergence.
    expect(perPlayerReport.disagreements.map((d) => d.id)).toEqual([]);
  });

  it("differs from the Python engine on self-draws only, and only by the settlement", () => {
    // DESIGN.md §9's open question, made concrete. The Python engine pays each
    // of the three losers the printed figure; payment.ts argues LIU prints a
    // pot and the shipped preset splits it three ways. Discard wins, where no
    // settlement question arises, must agree exactly.
    const byId = new Map(scoringCases.map((c) => [c.id, c]));
    for (const d of paymentReport.disagreements) {
      expect(byId.get(d.id)!.selfDraw).toBe(true);
      // The whole of the difference: the same printed figure, split three ways
      // (rounded up, because chips do not divide) instead of paid three times.
      expect(d.portChips).toBe(Math.ceil(d.pythonChips / 3));
    }
    const discardWins = scoringCases.filter((c) => !c.selfDraw).map((c) => c.id);
    for (const id of discardWins) {
      expect(paymentReport.disagreements.some((d) => d.id === id)).toBe(false);
    }
  });
});

describe("port-diff — distance to ready", () => {
  it("matches the exhaustive reference on every sampled hand", () => {
    // ENGINE-AUDIT §3's instruction, executed. The reference is recomputed
    // exhaustively by the fixture generator; the Python engine's own answer is
    // never the yardstick, because its cutoff is wrong on ~6-10% of hands.
    //
    // THIS ASSERTION IS CURRENTLY RED, and it is red for a real reason. See
    // README.md "Findings": engine/src/ready.ts searches for the split that
    // maximises `2 * sets + partials`, which is not the quantity the distance
    // formula minimises once the `sets + partials <= 4` cap is applied. On a
    // hand where one split has more complete sets and another has more
    // partials that the cap then truncates, it can keep the truncated one and
    // report a distance one too high. Verified against a third,
    // definition-only reference. Not fixed here: ready.ts belongs to another
    // agent, and a validation harness that edits the thing it validates is
    // worth nothing.
    const failures = distanceReport.disagreements.map(
      (d) =>
        `${d.id} (${d.tiles} tiles): exhaustive ${d.exhaustive}, port ${d.port}` +
        (d.port === d.shipped ? " — the same wrong answer the Python cutoff gives" : ""),
    );
    expect(failures).toEqual([]);
  });

  it("keeps a corpus that still reaches the Python cutoff's wrong answers", () => {
    // A corpus that stopped containing any of them would make the assertion
    // above vacuous without anything failing. A failure here means the sample
    // no longer covers the bug, not that the bug is gone.
    expect(distanceReport.cutoffWrong.all).toBeGreaterThan(0);
    expect(distanceReport.counts.thirteen).toBeGreaterThan(0);
    expect(distanceReport.counts.fourteen).toBeGreaterThan(0);
  });
});

describe("port-diff — the log parser", () => {
  it("extracts the same cases from a raw log as the fixture generator did", () => {
    // The committed sample is real log lines from one batch file — byte for
    // byte what the Python engine wrote, minus four fields the parser never
    // reads (README.md lists them). It pins the TypeScript extractor to the
    // Python one, which would otherwise drift the moment the format moves.
    const tag = provenance.sampleTag;
    expect(tag).toBeTruthy();
    expect(sampleJson.tag).toBe(tag);
    const extracted = extractScoringCases(parseJsonl(sampleJson.lines.join("\n")), tag!);
    expect(extracted.length).toBeGreaterThan(0);

    const byId = new Map<string, ScoringCase>(scoringCases.map((c) => [c.id, c]));
    for (const c of extracted) {
      const fromFixture = byId.get(c.id);
      expect(fromFixture, `${c.id} is in the raw sample but not in the fixture`).toBeDefined();
      expect(c).toEqual(fromFixture);
    }
  });

  it("refuses a log line that is not JSON rather than dropping it", () => {
    expect(() => parseJsonl('{"kind":"hand_footer"}\nnot json\n')).toThrow(/line 2/);
  });
});

describe("port-diff — the readout", () => {
  it("prints what was and was not validated", () => {
    const report = formatReport(
      provenance,
      UNDER_TEST,
      scoringReport,
      paymentReport,
      distanceReport,
    );
    expect(report).toContain("DESIGN.md §8 harness 1");
    expect(report).toContain("Closed-hand LIU subset only");
    console.log(`\n${report}\n`);
  });
});

/**
 * Structural guard over the settlement golden fixtures (DESIGN.md §4 — the
 * payment table is data — and §8, which makes this suite the P0 exit gate).
 * Nothing here runs the scorer. It runs the SHIPPED payment tables, which is
 * the part these fixtures are about.
 *
 * Three checks carry the family:
 *
 *   1. every case's four chip deltas SUM TO ZERO. Chips are conserved; a
 *      per-player figure paid as a total, a discard charged to three seats, or
 *      a dealer double credited but not debited all break the sum, so this one
 *      assertion catches most settlement bugs on its own.
 *   2. every declared chip figure is RE-DERIVED from the real PaymentTable in
 *      rulesets/src/payment.ts — `paymentTableById(c.paymentTable)`, not a
 *      hand-copied number. A fixture cannot drift from the shipping schedule
 *      without failing here, and a change to either schedule fails here too,
 *      which is the point of testing against the object rather than a mirror.
 *   3. the faan is re-added from the case's own award list, so a settlement
 *      case cannot quietly smuggle in a scoring claim.
 *
 * `winnerCollects` in payment.ts is asserted to be exactly right under the flat
 * dealer rule and wrong whenever the dealer is a party under the doubling rule.
 * That is not a defect in the helper — it is the boundary of what the current
 * PaymentTable contract can express, pinned so it stays visible.
 *
 * Terminology: ../../../TERMINOLOGY.md. HK only.
 */
import { describe, expect, it } from "vitest";
import { counts, flowerSeat, isRun } from "../../src/tiles.js";
import { isComplete } from "../../src/ready.js";
import { FLOWERS_START, SCORING_KINDS, type PaymentTable, type SeatIndex, type TileId } from "../../src/types.js";
import {
  HKOS_DOUBLING,
  HKOS_STANDARD,
  LIU,
  LIU_BRACKET_SCHEDULE,
  paymentTableById,
  winnerCollects,
} from "@mjrc/rulesets";
import { assertWellFormed } from "./case.js";
import { FAAN, LIMIT_FAAN, MINIMUM_FAAN, cases, type Deltas, type PaymentCase } from "./payments.js";

/** Every tile the winner can account for: concealed, the winning tile, melds. */
const allTiles = (c: PaymentCase): TileId[] => [
  ...c.concealed,
  c.winningTile,
  ...c.melds.flatMap((meld) => meld.tiles),
];

/** Seat index equals wind index in every golden family, so this is the winner. */
const winnerOf = (c: PaymentCase): SeatIndex => c.seatWind as SeatIndex;

const tableFor = (c: PaymentCase): PaymentTable => {
  const t = paymentTableById(c.paymentTable);
  if (!t) throw new Error(`${c.id}: no payment table "${c.paymentTable}" in rulesets/src/payment.ts`);
  return t;
};

/** What ONE payer owes before any dealer double. */
const baseFor = (c: PaymentCase, t: PaymentTable): number =>
  c.selfDraw ? t.onSelfDraw(c.expected.faan) : t.onDiscard(c.expected.faan);

/** True when 莊 is on one side of the payment and the house doubles it. */
const dealerIsParty = (c: PaymentCase): boolean =>
  c.dealerRule === "double" &&
  (winnerOf(c) === c.dealer || (c.selfDraw ? true : c.from === c.dealer));

/**
 * The settlement, derived from the shipping table rather than read off the
 * fixture. 全銃 on a discard — the discarder carries the whole hand — and the
 * dealer double applied to the per-payer figure AFTER the schedule is read.
 */
const settle = (c: PaymentCase, t: PaymentTable): Deltas => {
  const out: Deltas = [0, 0, 0, 0];
  if (!c.expected.legal) return out; // a refused win moves nothing at all
  const winner = winnerOf(c);
  const base = baseFor(c, t);
  const factor = (payer: SeatIndex): number =>
    c.dealerRule === "double" && (payer === c.dealer || winner === c.dealer) ? 2 : 1;
  const pay = (payer: SeatIndex): void => {
    const amount = base * factor(payer);
    out[payer] -= amount;
    out[winner] += amount;
  };
  if (c.selfDraw) {
    for (let i = 0 as SeatIndex; i < 4; i = (i + 1) as SeatIndex) if (i !== winner) pay(i);
  } else {
    pay(c.from as SeatIndex);
  }
  return out;
};

describe("golden hands — chip settlement", () => {
  it("has the agreed number of cases with unique, family-prefixed ids", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(25);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) expect(c.id).toMatch(/^payments-[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("stays honest about validation and names a real preset on every case", () => {
    for (const c of cases) {
      expect(c.provisional, c.id).toBe(true); // §8 — nothing ships unvalidated
      expect([HKOS_STANDARD.id, LIU.id], c.id).toContain(c.ruleset);
      if (c.ruleset === LIU.id) expect(c.description, c.id).toMatch(/LIU/);
      expect(c.description.length, c.id).toBeGreaterThan(40);
    }
  });

  for (const c of cases) {
    describe(c.id, () => {
      it("is well formed and holds only real tiles", () => {
        expect(() => assertWellFormed(c)).not.toThrow();
        for (const tile of allTiles(c)) {
          expect(tile).toBeGreaterThanOrEqual(0);
          expect(tile).toBeLessThan(SCORING_KINDS);
        }
        const seen = counts(allTiles(c));
        for (let i = 0; i < SCORING_KINDS; i++) expect(seen[i]!).toBeLessThanOrEqual(4);
        for (const f of c.flowers) {
          expect(f).toBeGreaterThanOrEqual(FLOWERS_START);
          expect(f).toBeLessThan(FLOWERS_START + 8);
        }
        expect(new Set(c.flowers).size).toBe(c.flowers.length); // flowers are singletons
        expect(c.concealed).toEqual([...c.concealed].sort((a, b) => a - b));
      });

      it("is a complete fourteen-tile winning shape with legal melds", () => {
        for (const meld of c.melds) {
          expect(meld.kind).not.toBe("kong"); // no kongs in this family
          expect(meld.tiles.length).toBe(3);
          expect(meld.tiles).toEqual([...meld.tiles].sort((a, b) => a - b));
          if (meld.kind === "chow") {
            const [a, b, d] = meld.tiles as [TileId, TileId, TileId];
            expect(isRun(a, b, d)).toBe(true);
            // 上家 only: a chow comes from the seat immediately before you.
            expect(meld.from).toBe((c.seatWind + 3) % 4);
          } else {
            expect(new Set(meld.tiles).size).toBe(1);
          }
          expect(meld.concealed).toBe(false);
          expect(meld.from).not.toBe(c.seatWind); // a claimed meld came from someone else
        }
        expect(isComplete(counts([...c.concealed, c.winningTile]), c.melds.length)).toBe(true);
      });

      it("agrees with itself about who won, from whom, and who is dealing", () => {
        // Seat index equals wind index across every golden family: 東 deals.
        expect(c.dealer).toBe(0);
        expect(c.isDealer).toBe(c.seatWind === c.dealer);
        if (c.selfDraw) {
          expect(c.from).toBeNull();
        } else {
          expect(c.from).not.toBeNull();
          expect(c.from).toBeGreaterThanOrEqual(0);
          expect(c.from).toBeLessThan(4);
          expect(c.from).not.toBe(c.seatWind); // you cannot win on your own discard
        }
        expect(c.expected.awards.includes("selfDraw")).toBe(c.selfDraw);
      });

      it("books the bonus-tile awards its flowers actually justify", () => {
        // 無花 fires exactly when no bonus tile was drawn all hand; 正花 once per
        // held bonus tile matching the seat wind. Both presets price them at 1.
        expect(c.expected.awards.includes("noFlowers")).toBe(c.flowers.length === 0);
        const own = c.flowers.filter((f) => flowerSeat(f) === c.seatWind).length;
        expect(c.expected.awards.filter((a) => a === "ownFlower").length).toBe(own);
      });

      it("adds up: rawFaan is the sum of the awards it lists", () => {
        for (const a of c.expected.awards) {
          expect(a, `${c.id}: ${a}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
          expect(FAAN[a], `${c.id}: ${a} is unpriced`).toBeTypeOf("number");
        }
        expect(new Set(c.expected.awards).size).toBe(c.expected.awards.length);
        // 四暗刻 swallows 對對糊 and 門前清 (rulesets/src/patterns.ts); a paid
        // list that still names them would double-count.
        if (c.expected.awards.includes("fourConcealedPungs")) {
          expect(c.expected.awards).not.toContain("allPungs");
          expect(c.expected.awards).not.toContain("concealedHand");
        }
        expect(c.rawFaan).toBe(c.expected.awards.reduce((n, a) => n + FAAN[a]!, 0));
      });

      it("applies 爆棚 to the faan before any chips are priced", () => {
        expect(c.expected.faan).toBe(Math.min(c.rawFaan, LIMIT_FAAN));
        expect(c.capped).toBe(c.rawFaan > LIMIT_FAAN);
        expect(c.expected.legal).toBe(c.expected.faan >= MINIMUM_FAAN);
      });

      it("names a payment table that exists and reads its own settlement", () => {
        const t = tableFor(c);
        expect(t.id).toBe(c.paymentTable);
        // The id encodes the reading, so the restated field cannot drift.
        expect(t.selfDraw).toBe(c.settlement);
        expect(c.paymentTable.endsWith(`-${c.settlement}`)).toBe(true);
        // A case crosses the SETTLEMENT freely but never the SCHEDULE: the
        // faan table and the chip schedule both belong to the house.
        const schedule = c.ruleset === LIU.id ? LIU_BRACKET_SCHEDULE.id : HKOS_DOUBLING.id;
        expect(c.paymentTable.startsWith(`${schedule}-`)).toBe(true);
      });

      it("quotes the base straight off the shipping schedule", () => {
        const t = tableFor(c);
        expect(c.expectedPayment.base).toBe(baseFor(c, t));
        // Quoted even for a refused hand — the refusal is a refusal, not a
        // price of zero. LIU alone prints an explicit 0 below the minimum.
        if (!c.expected.legal && c.ruleset === HKOS_STANDARD.id) {
          expect(c.expectedPayment.base).toBeGreaterThan(0);
        }
      });

      it("settles to exactly the deltas the shipping table derives", () => {
        expect(c.expectedPayment.deltas).toEqual(settle(c, tableFor(c)));
      });

      it("conserves chips — the four deltas sum to zero", () => {
        const d = c.expectedPayment.deltas;
        expect(d.length).toBe(4);
        expect(d.reduce((a, b) => a + b, 0)).toBe(0);
        for (const n of d) expect(Number.isInteger(n)).toBe(true);
      });

      it("moves chips out of the right seats and into the winner", () => {
        const d = c.expectedPayment.deltas;
        const winner = winnerOf(c);
        expect(c.expectedPayment.collects).toBe(d[winner]);
        if (!c.expected.legal) {
          // Below the floor nobody pays anything at all — every delta is zero,
          // not merely balanced.
          expect(d).toEqual([0, 0, 0, 0]);
          return;
        }
        expect(d[winner]).toBeGreaterThan(0);
        const payers = ([0, 1, 2, 3] as SeatIndex[]).filter((i) => i !== winner && d[i] !== 0);
        for (const i of payers) expect(d[i]).toBeLessThan(0);
        if (c.selfDraw) {
          // 自摸 — all three losers pay, whatever the settlement.
          expect(payers.length).toBe(3);
        } else {
          // 全銃 — the discarder carries the whole hand and the other two are
          // untouched. This is the check a "split the loss" bug fails.
          expect(payers).toEqual([c.from]);
          for (const i of [0, 1, 2, 3] as SeatIndex[]) {
            if (i !== winner && i !== c.from) expect(d[i]).toBe(0);
          }
        }
      });

      it("doubles the chips for 莊, never the faan, and only when 莊 is a party", () => {
        if (!c.expected.legal) return;
        const d = c.expectedPayment.deltas;
        const winner = winnerOf(c);
        const base = c.expectedPayment.base;
        for (const i of ([0, 1, 2, 3] as SeatIndex[])) {
          if (i === winner || d[i] === 0) continue;
          const expectFactor =
            c.dealerRule === "double" && (i === c.dealer || winner === c.dealer) ? 2 : 1;
          expect(-d[i]!, `seat ${i} of ${c.id}`).toBe(base * expectFactor);
        }
        // The faan is untouched by the dealer rule: it is a chip multiplier.
        expect(c.expected.faan).toBe(Math.min(c.rawFaan, LIMIT_FAAN));
      });

      it("pins where payment.ts's winnerCollects stops being right", () => {
        if (!c.expected.legal) return;
        const t = tableFor(c);
        // winnerCollects assumes 3 * onSelfDraw, i.e. three equal payers. That
        // is exact under the flat rule and under a doubling rule with no dealer
        // on either side, and wrong the moment 莊 is a party.
        const closedForm = winnerCollects(t, c.expected.faan, c.selfDraw);
        expect(closedForm === c.expectedPayment.collects).toBe(!dealerIsParty(c));
      });
    });
  }

  it("ships every payment table, both settlements and both dealer rules", () => {
    const used = new Set(cases.map((c) => c.paymentTable));
    for (const id of [
      "hkos-doubling-perPlayer",
      "hkos-doubling-total",
      "liu-brackets-total",
      "liu-brackets-perPlayer",
    ]) {
      expect(used.has(id), id).toBe(true);
    }
    // Both preset defaults are exercised, AND both departures from them —
    // rulesets are data (§4), so a house may pair schedule and settlement
    // however it likes and the suite has to cover the crossings.
    expect(used.has(HKOS_STANDARD.payment.id)).toBe(true);
    expect(used.has(LIU.payment.id)).toBe(true);
    expect(cases.some((c) => c.paymentTable !== (c.ruleset === LIU.id ? LIU : HKOS_STANDARD).payment.id))
      .toBe(true);

    expect(new Set(cases.map((c) => c.settlement))).toEqual(new Set(["perPlayer", "total"]));
    expect(new Set(cases.map((c) => c.dealerRule))).toEqual(new Set(["flat", "double"]));
    expect(cases.filter((c) => c.selfDraw).length).toBeGreaterThanOrEqual(8);
    expect(cases.filter((c) => !c.selfDraw).length).toBeGreaterThanOrEqual(8);
  });

  it("covers the floor, the limit and the refusal the brief asks for", () => {
    // Exactly at the 3-faan minimum, and legal.
    const atFloor = cases.filter((c) => c.expected.faan === MINIMUM_FAAN);
    expect(atFloor.length).toBeGreaterThanOrEqual(4);
    for (const c of atFloor) expect(c.expected.legal).toBe(true);
    // Just below it, refused, nothing moving.
    const refused = cases.filter((c) => !c.expected.legal);
    expect(refused.length).toBeGreaterThanOrEqual(2);
    for (const c of refused) {
      expect(c.expected.faan).toBe(MINIMUM_FAAN - 1);
      expect(c.expectedPayment.deltas).toEqual([0, 0, 0, 0]);
      expect(c.expectedPayment.collects).toBe(0);
    }
    // At the limit, both capped and landing exactly on it.
    expect(cases.some((c) => c.capped)).toBe(true);
    expect(cases.some((c) => !c.capped && c.expected.faan === LIMIT_FAAN)).toBe(true);
    for (const c of cases.filter((c) => c.expected.faan === LIMIT_FAAN)) {
      // The cap is applied to the faan, so the chips are the top row of the
      // schedule whether the raw total was 13 or 14.
      expect(c.expectedPayment.base).toBe(baseFor(c, tableFor(c)));
    }
  });

  it("holds the hand still across every contrast it draws", () => {
    // Cases only teach a settlement difference if the hand is the same, so the
    // grouping is asserted rather than described. Five shapes carry the family
    // and every one of them is reused. "The same hand" means the same fourteen
    // tiles AND the same exposure: 對對糊 and 四暗刻 below are the same tiles
    // melded and unmelded, and they are emphatically not the same hand.
    const tiles = (c: PaymentCase) => counts(allTiles(c)).join(",");
    const shape = (c: PaymentCase) =>
      `${tiles(c)}|${c.melds.map((meld) => `${meld.kind}:${meld.tiles.join(".")}`).join("+")}`;
    const groups = new Map<string, PaymentCase[]>();
    for (const c of cases) {
      const k = shape(c);
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    expect(groups.size).toBe(5);
    for (const [, group] of groups) {
      expect(group.length).toBeGreaterThanOrEqual(2);
      // A group that settled every case identically would prove nothing.
      const settlements = new Set(group.map((c) => c.expectedPayment.deltas.join("/")));
      expect(settlements.size).toBeGreaterThanOrEqual(2);
      // Nor would a group that drifted onto different tiles behind our backs.
      expect(new Set(group.map(tiles)).size).toBe(1);
    }
  });

  it("prices exposure: the same fourteen tiles melded and concealed", () => {
    // 對對糊 with two pungs claimed is 4 faan self-drawn; the identical
    // fourteen tiles with nothing claimed is 四暗刻 at the limit. Nothing about
    // the tiles changed — only whether they were claimed off a discard — and
    // the settlement moves by 24x. An engine that scores from the tile counts
    // alone and ignores the meld list fails this pair and looks right everywhere
    // else in the suite.
    const melded = cases.find((c) => c.id === "payments-self-draw-all-pungs-hkos-per-player")!;
    const concealed = cases.find((c) => c.id === "payments-limit-four-concealed-pungs-self-draw-hkos")!;
    expect(counts(allTiles(melded))).toEqual(counts(allTiles(concealed)));
    expect(melded.melds.length).toBe(2);
    expect(concealed.melds.length).toBe(0);
    expect(melded.paymentTable).toBe(concealed.paymentTable);
    expect(melded.expected.faan).toBe(4);
    expect(concealed.expected.faan).toBe(LIMIT_FAAN);
    expect(concealed.expectedPayment.collects).toBe(24 * melded.expectedPayment.collects);
  });

  it("proves the settlement column is irrelevant to a win from a discard", () => {
    // PaymentTable.onDiscard takes only the faan, so an engine that branched on
    // the settlement here would be wrong. Asserted on the pair that exists for
    // exactly this, and then on every discard case in the family.
    const a = cases.find((c) => c.id === "payments-discard-half-flush-floor-hkos")!;
    const b = cases.find((c) => c.id === "payments-discard-half-flush-floor-hkos-total")!;
    expect(a.settlement).not.toBe(b.settlement);
    expect(a.expectedPayment.deltas).toEqual(b.expectedPayment.deltas);
    for (const c of cases.filter((x) => !x.selfDraw && x.expected.legal)) {
      const t = tableFor(c);
      const other = paymentTableById(
        c.paymentTable.replace(/-(perPlayer|total)$/, c.settlement === "total" ? "-perPlayer" : "-total"),
      )!;
      expect(other.onDiscard(c.expected.faan)).toBe(t.onDiscard(c.expected.faan));
    }
  });

  it("makes the 3x between the settlements explicit on one self-drawn hand", () => {
    const perPlayer = cases.find((c) => c.id === "payments-self-draw-all-pungs-liu-per-player")!;
    const total = cases.find((c) => c.id === "payments-self-draw-all-pungs-liu-total")!;
    expect(perPlayer.expected.faan).toBe(total.expected.faan);
    // LIU's printed figures all divide by three, so the two readings are an
    // exact 3x apart with no rounding in the way. That is payment.ts's evidence
    // for reading the column as a total, restated as a fixture.
    expect(perPlayer.expectedPayment.base).toBe(3 * total.expectedPayment.base);
    expect(perPlayer.expectedPayment.collects).toBe(3 * total.expectedPayment.collects);
  });

  it("records what rounding the total settlement costs, rung by rung", () => {
    // On the total reading the pot is split with Math.ceil, so the winner
    // collects the printed figure when it divides by three and MORE when it
    // does not. Restricted to the flat rule, where the printed figure is the
    // right thing to compare against.
    for (const c of cases.filter((x) => x.selfDraw && x.settlement === "total" && x.dealerRule === "flat")) {
      const schedule = c.ruleset === LIU.id ? LIU_BRACKET_SCHEDULE : HKOS_DOUBLING;
      const printed = schedule.selfDrawFigure(c.expected.faan);
      expect(c.expectedPayment.collects).toBeGreaterThanOrEqual(printed);
      expect(c.expectedPayment.collects - printed).toBeLessThanOrEqual(2);
      expect(c.expectedPayment.collects === printed).toBe(printed % 3 === 0);
    }
    // Both outcomes are actually present, or the check is vacuous.
    const totals = cases.filter((x) => x.selfDraw && x.settlement === "total" && x.dealerRule === "flat");
    const exact = totals.filter((c) => {
      const schedule = c.ruleset === LIU.id ? LIU_BRACKET_SCHEDULE : HKOS_DOUBLING;
      return c.expectedPayment.collects === schedule.selfDrawFigure(c.expected.faan);
    });
    expect(exact.length).toBeGreaterThanOrEqual(1);
    expect(totals.length - exact.length).toBeGreaterThanOrEqual(1);
  });

  it("shows the dealer double from both sides and with 莊 out of it", () => {
    const flat = cases.find((c) => c.id === "payments-discard-dealer-wins-flat")!;
    const doubled = cases.find((c) => c.id === "payments-discard-dealer-wins-double")!;
    const dealerPays = cases.find((c) => c.id === "payments-discard-dealer-pays-double")!;
    const control = cases.find((c) => c.id === "payments-discard-no-dealer-party-double")!;

    // Dealer wins: the double is on the chips, so the faan is untouched.
    expect(doubled.expected.faan).toBe(flat.expected.faan);
    expect(doubled.expectedPayment.collects).toBe(2 * flat.expectedPayment.collects);
    // Dealer loses: the double still applies, out of the dealer's own stack.
    expect(dealerPays.expectedPayment.deltas[dealerPays.dealer]).toBe(-2 * dealerPays.expectedPayment.base);
    // 莊 not a party: the doubling house settles exactly like the flat one.
    expect(control.dealerRule).toBe("double");
    expect(control.expectedPayment.collects).toBe(flat.expectedPayment.collects);

    // A self-draw with the dealer as ONE OF THE PAYERS is the case that breaks
    // an engine multiplying a single figure by three: the payers are unequal.
    const unequal = cases.filter(
      (c) => c.selfDraw && c.dealerRule === "double" && !c.isDealer && c.expected.legal,
    );
    expect(unequal.length).toBeGreaterThanOrEqual(2);
    for (const c of unequal) {
      const d = c.expectedPayment.deltas;
      expect(d[c.dealer]).toBe(-2 * c.expectedPayment.base);
      const others = ([0, 1, 2, 3] as SeatIndex[]).filter((i) => i !== c.dealer && i !== winnerOf(c));
      for (const i of others) expect(d[i]).toBe(-c.expectedPayment.base);
      expect(new Set(others.map((i) => d[i])).size).toBe(1);
      expect(d[c.dealer]).not.toBe(d[others[0]!]);
    }
  });

  it("flags the contested rulings instead of hiding them", () => {
    const contested = cases.filter((c) => c.contested);
    // The dealer double, the rounding rule, the order of operations under the
    // double, the self-draw settlement itself, and 包 — all open (§8, §9).
    expect(contested.length).toBeGreaterThanOrEqual(6);
    for (const c of contested) expect(c.contested!.length, c.id).toBeGreaterThan(60);
  });

  it("prices nothing in its faan mirror that no case uses", () => {
    // FAAN is a hand-kept copy of rulesets/src/presets.ts. A dead entry is the
    // first sign it has drifted from the presets it mirrors.
    const used = new Set(cases.flatMap((c) => c.expected.awards));
    for (const id of used) expect(Object.keys(FAAN)).toContain(id);
    // Every award this family uses is priced IDENTICALLY by both presets, which
    // is what makes one mirror safe and what makes a chip difference between
    // two cases attributable to the payment table alone.
    for (const id of used) {
      expect(HKOS_STANDARD.faanTable[id], id).toBe(FAAN[id]);
      expect(LIU.faanTable[id], id).toBe(FAAN[id]);
    }
  });
});

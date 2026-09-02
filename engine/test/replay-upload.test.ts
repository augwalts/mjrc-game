import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { startMatch, startNextHand, applyAction } from "../src/reducer.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import type { Action } from "../src/types.js";

/**
 * `actions_gz` really does carry the whole game.
 *
 * The fixture is a REAL upload — the 7-hand match a tester called Auhie played
 * on 2026-09-01, pulled out of the live database and un-gzipped. It is here
 * because the claim that uploading actions is as good as uploading events is
 * the entire reason the event log is not stored server-side, and a claim that
 * load-bearing deserves a test against real traffic rather than a fixture we
 * generated ourselves.
 *
 * The per-hand detail that a stats page needs — faan, chip deltas, and the
 * running standings — is all in the regenerated handEnd payloads. Nothing has
 * to be added to the schema for a hand-distribution or score-progression chart;
 * they only need this replay.
 */
describe("a real uploaded action log", () => {
  const blob = JSON.parse(
    readFileSync(new URL("./fixtures/real-upload-auhie.json", import.meta.url), "utf8"),
  ) as { seed: number; rounds: number; rulesetId: string; actions: Action[] };

  function replay() {
    let { state, events } = startMatch({
      seed: blob.seed, ruleset: MJRC_STANDARD, matchLength: blob.rounds,
    } as never);
    const log = [...events];
    for (const a of blob.actions) {
      if (state.phase === "handEnd") {
        const n = startNextHand(state);
        state = n.state; log.push(...n.events);
      }
      const r = applyAction(state, a);
      state = r.state; log.push(...r.events);
    }
    return { state, log };
  }

  it("regenerates the match the server recorded", () => {
    const { log } = replay();
    const ends = log.filter((e) => e.type === "handEnd");
    // the row in game_match says hands = 7, chips = [-288, 0, 272, 16]
    expect(ends.length).toBe(7);
    const last = ends[ends.length - 1] as unknown as
      { payload: { standings: number[] } };
    expect(last.payload.standings).toEqual([-288, 0, 272, 16]);
  });

  it("yields the per-hand faan and chip totals a stats page needs", () => {
    const { log } = replay();
    const ends = (log.filter((e) => e.type === "handEnd") as unknown as Array<{
      payload: { outcome: string; faan: number | null; chipDeltas: number[]; standings: number[] };
    }>).map((e) => e.payload);

    // hand distribution: every win's faan
    const faans = ends.filter((p) => p.faan !== null).map((p) => p.faan);
    expect(faans).toEqual([5, 4, 8, 4, 7]);

    // score progression: a running total per seat after every hand
    expect(ends.map((p) => p.standings[0])).toEqual([0, 0, -32, -160, -160, -192, -288]);

    // and the draws are distinguishable, which a faan histogram must exclude
    expect(ends.filter((p) => p.outcome === "exhaustiveDraw")).toHaveLength(2);
  });

  it("is deterministic — the same actions give the same match twice", () => {
    const a = replay(), b = replay();
    expect(JSON.stringify(a.log)).toBe(JSON.stringify(b.log));
  });
});

import { describe, it, expect } from "vitest";
import { startMatch, startNextHand, applyAction, legalActions, previewWin } from "../src/reducer.js";
import { prng } from "../src/wall.js";
import { MJRC_STANDARD } from "../../rulesets/src/presets.js";
import type { Action, SeatIndex } from "../src/types.js";

/**
 * The client draws a DIFFERENT button for a winning shape that cannot pay —
 * amber, no rays, "winning shape · N faan · needs 3". That is only honest if
 * previewWin predicts exactly what the reducer is about to do, so this plays
 * real hands with a random policy and checks the prediction against the
 * outcome every single time a win is offered.
 */
describe("previewWin predicts the reducer's verdict", () => {
  it("agrees on every win the engine offers, over many played hands", () => {
    let offered = 0, payable = 0, short = 0;

    for (let seed = 1; seed <= 60; seed++) {
      let state = startMatch({ seed, ruleset: MJRC_STANDARD, matchLength: 1 } as never).state;
      const rnd = prng(seed ^ 0x5f3759df);
      let guard = 0;

      while (state.phase !== "matchEnd" && guard++ < 20000) {
        if (state.phase === "handEnd") { state = startNextHand(state).state; continue; }
        let acted = false;
        for (let seat = 0 as SeatIndex; seat < 4; seat = (seat + 1) as SeatIndex) {
          const options = legalActions(state, seat);
          if (options.length === 0) continue;

          const win = options.find(
            (o) => o.type === "declareWin" || (o.type === "claim" && o.option.kind === "win"),
          );
          if (win) {
            const selfDraw = win.type === "declareWin";
            const tile = selfDraw ? state.seats[seat]!.drawn : (state.lastDiscard?.tile ?? null);
            if (tile !== null && tile !== undefined) {
              offered++;
              const pred = previewWin(state, seat, {
                selfDraw, tile, from: selfDraw ? null : (state.lastDiscard?.from ?? null),
              });
              /* A claim window collects EVERY seat's answer before it
                 resolves, so applying the win alone emits nothing. Pass for
                 the other seats until the window settles, and judge on the
                 events from the whole resolution. */
              const applied = applyAction(state, win);
              let after = applied.state;
              const evs = [...applied.events];
              for (let k = 0; k < 8 && after.phase === "claimWindow"; k++) {
                let moved = false;
                for (let s2 = 0 as SeatIndex; s2 < 4; s2 = (s2 + 1) as SeatIndex) {
                  const o = legalActions(after, s2);
                  const pass = o.find((x) => x.type === "pass");
                  if (!pass) continue;
                  const step = applyAction(after, pass);
                  after = step.state; evs.push(...step.events); moved = true; break;
                }
                if (!moved) break;
              }
              const applied2 = { state: after, events: evs };
              /* The hand ENDING is not proof the win was taken: on the last
                 tile a refused win still ends the hand as a draw. Read the
                 events, which say which of the two happened. */
              const took = applied2.events.some(
                (e) => e.type === "selfDraw" || e.type === "winOnDiscard");
              const refused = applied2.events.some((e) => e.type === "refusedWin");
              if (!took && !refused) { state = after; acted = true; break; }
              if (pred.legal !== took) {
                console.log(JSON.stringify({ seed, seat, selfDraw, faan: pred.faan,
                  legal: pred.legal, took, refused, min: MJRC_STANDARD.minimumFaan,
                  awards: pred.awards, afterPhase: after.phase,
                  events: applied2.events.map((e) => e.type) }));
              }
              expect(pred.legal).toBe(took);
              if (pred.legal) payable++; else short++;
              state = after; acted = true; break;
            }
          }
          const choice: Action = options[Math.floor(rnd() * options.length)]!;
          state = applyAction(state, choice).state;
          acted = true; break;
        }
        if (!acted) break;
      }
    }

    console.log(`wins offered ${offered} · payable ${payable} · under the floor ${short}`);
    expect(offered).toBeGreaterThan(20);
    // the new button only earns its place if short hands actually occur
    expect(short).toBeGreaterThan(0);
  });
});

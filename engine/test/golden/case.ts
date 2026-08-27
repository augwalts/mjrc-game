/**
 * Golden-hand fixture format. DESIGN.md §8 makes this suite the P0 exit
 * requirement and the ONLY validation source for everything the Python engine
 * cannot generate (exposed melds, kongs, flowers, winds, dealer, situational).
 *
 * Every case states the ruleset preset it assumes. Rulesets are data (§4) and
 * BOTH self-draw settlements ship, so an untagged case is meaningless.
 */
import type { Meld, TileId, WindIndex } from "../../src/types.js";

export interface GoldenCase {
  /** Stable, unique, kebab-case. Prefix with the family: "flush-full-concealed". */
  id: string;
  /** One line, plain English, describing the hand and why it is interesting. */
  description: string;
  /** Ruleset preset id this case is scored under. */
  ruleset: string;
  /** Concealed tiles NOT including the winning tile. */
  concealed: TileId[];
  melds: Meld[];
  flowers: TileId[];
  winningTile: TileId;
  selfDraw: boolean;
  seatWind: WindIndex;
  roundWind: WindIndex;
  isDealer: boolean;
  robbedKong?: boolean;
  onKongReplacement?: boolean;
  onLastTile?: boolean;
  expected: {
    faan: number;
    /** Award ids expected, order-independent. */
    awards: string[];
    /** False when the hand is below the minimum and may not be taken. */
    legal: boolean;
  };
  /**
   * TRUE until a strong HK player has signed off. Nothing ships on the strength
   * of a provisional case — §8 requires human validation as the exit gate.
   */
  provisional: boolean;
  /** Where the ruling came from, if anywhere. */
  source?: string;
  /** Set when houses genuinely disagree; explain the split. */
  contested?: string;
}

export function assertWellFormed(c: GoldenCase): void {
  const tileCount =
    c.concealed.length + 1 + c.melds.reduce((n, m) => n + (m.kind === "kong" ? 3 : 3), 0);
  if (tileCount !== 14) {
    throw new Error(`${c.id}: ${tileCount} tiles counted, a winning hand must total 14 (kongs count as 3)`);
  }
  if (!c.id || !c.description || !c.ruleset) throw new Error(`${c.id}: missing required field`);
  if (c.expected.legal && c.expected.faan < 0) throw new Error(`${c.id}: negative faan`);
}

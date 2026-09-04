/**
 * Two pure adapters between the wire and the engine's analysis surface, shared
 * by the server's bots (gamepvp/src/bots.ts) and the client's coach. Both take
 * only what a seat may know: a `SeatSnapshot` is already redacted, and the
 * `SeatView` built from it can hold nothing the snapshot did not.
 *
 *   - `seatViewOf`: `SeatSnapshot` (per-seat objects) → `SeatView` (per-seat
 *     arrays). Same information, different shape.
 *   - `actionsOf`: `LegalRequests` (grouped by request type) → `Action[]`.
 *     The inverse of the table's `legalFor` projection.
 */
import type { Action, ClaimOption, Meld, SeatIndex, TileId } from "../../engine/src/types.js";
import type { SeatView } from "../../engine/src/bots.js";
import type { SeatSnapshot, SeatVisible, SeatVisibleMeld } from "./events.js";
import type { LegalRequests } from "./messages.js";

/** Hidden kongs carry no tiles and are dropped: the count they represent is
 *  already in `handCounts`. */
export function seatViewOf(v: SeatVisible<SeatSnapshot>): SeatView {
  const own = v.seats[v.seat];
  const hand = "hand" in own ? own.hand : [];
  const drawn = "drawn" in own ? own.drawn : null;
  return {
    seat: v.seat,
    dealer: v.dealer,
    roundWind: v.roundWind,
    seatWinds: v.seats.map((s) => s.wind),
    hand,
    drawn,
    melds: v.seats.map((s) =>
      (s.melds as readonly SeatVisibleMeld[]).filter((m): m is Meld => m.tiles !== null),
    ),
    flowers: v.seats.map((s) => s.flowers),
    discards: v.seats.map((s) => s.discards),
    handCounts: v.seats.map((s) => s.handCount),
    standings: v.standings,
    wallRemaining: v.wallRemaining,
    lastDiscard: v.lastDiscard,
  };
}

/** A claim window is answered with exactly one claim or a pass, so when one
 *  is open nothing else is offered. */
export function actionsOf(seat: SeatIndex, legal: LegalRequests): Action[] {
  const out: Action[] = [];
  if (legal.claims) {
    for (const option of legal.claims.options) out.push({ type: "claim", seat, option });
    out.push({ type: "pass", seat });
    return out;
  }
  if (legal.robKong) {
    const win: ClaimOption = { kind: "win" };
    out.push({ type: "claim", seat, option: win });
    out.push({ type: "pass", seat });
    return out;
  }
  if (legal.winOnSelfDraw) out.push({ type: "declareWin", seat, selfDraw: true });
  for (const tile of legal.concealedKong) out.push({ type: "concealedKong", seat, tile });
  for (const tile of legal.addedKong) out.push({ type: "addedKong", seat, tile });
  for (const tile of legal.discard) out.push({ type: "discard", seat, tile: tile as TileId });
  return out;
}

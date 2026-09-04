/**
 * The renderer boundary — the interface.
 * Spec: sketches/RENDERING.md §4 (animation architecture) and §7 (the interface
 * to fix now). Doctrine: DESIGN.md §5 — the client is disposable BY DESIGN
 * because the engine is a pure reducer holding all the logic.
 * Terminology: ../../../TERMINOLOGY.md — HK Old Style only.
 *
 * Two implementations over time: `DomScene` (P0, CSS 3D) and `PixiScene`
 * (later, sprite atlas with an owned painter's sort). Same interface, same
 * event stream, same log. That swap stays MECHANICAL only if nothing leaks
 * across this line, which is why the boundary is written before either
 * renderer exists rather than extracted from one afterwards.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE THREE HARD RULES (RENDERING.md §4). These are the ones people get wrong.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1. ANIMATION NEVER GATES INPUT.
 *    The claim window's 5s timer starts SERVER-SIDE the moment the discard
 *    commits. A client that animates the toss for 400ms and *then* shows the
 *    call buttons has silently taken 400ms — 8% — of the player's window, and
 *    the player cannot see that it happened. Show the affordance immediately;
 *    animate underneath it. Concretely, in this interface:
 *      · `applyEvent` ENQUEUES. It never awaits, never returns a promise, and
 *        the host must never gate a button on it.
 *      · The host binds input to the authoritative view it passed to
 *        `setView`, not to whatever the queue has drained so far.
 *      · Countdown rings are drawn against `deadlineTs` (server, absolute), so
 *        an event that arrives 300ms late shows a ring already 300ms in — not
 *        a fresh 5s.
 *      · `ClaimOfferedAnimation` is `serial: false` for the same reason.
 *
 * 2. RESYNC SNAPS.
 *    Reconnect is snapshot + actions-since (DESIGN.md §5.3). Apply it as a
 *    STATE REPLACEMENT: `flush()` then `setView(snapshot)`, or equivalently
 *    `setView` alone, which is specified to snap. Never feed the forty
 *    catch-up events to `applyEvent` — forty animations to arrive at a state
 *    you already have is a minute of the player watching history. The same
 *    path covers a backgrounded tab and replay scrubbing, and it is why the
 *    replay viewer is free: same renderer, same events, from a log instead of
 *    a socket.
 *
 * 3. EVERY CEREMONY IS SKIPPABLE.
 *    A player who has seen the win ceremony two hundred times must be able to
 *    dismiss it. Anything with `skippable: true` in `ANIMATION_PROFILE` ends on
 *    tap, lands on its final frame immediately, and reports through
 *    `onCeremonyFinished(kind, true)`. Skipping is never refused and never
 *    changes what is drawn at the end — only how long it took to get there.
 *
 * Presentation lags state; state never waits for presentation.
 */
import { prng } from "@mjrc/engine";
import type { SeatIndex, TileId } from "@mjrc/engine";
import { assertNever } from "@mjrc/protocol";
import { ANIMATION_PROFILE } from "./types.js";
import type {
  QueuedAnimation,
  SceneAnimation,
  SceneEvent,
  SceneOpts,
  SeatView,
} from "./types.js";

/**
 * The whole surface a match renderer exposes. Five methods, and the rest of the
 * client MUST NOT reach past them — no querying scene DOM, no reading a Pixi
 * display object, no "just this once" handle to the internals. A helper that
 * needs scene internals is a helper that belongs inside the scene.
 *
 * Lifecycle: `mount` once, then any number of `setView` / `applyEvent` /
 * `flush`, then `destroy`. Calling anything but `destroy` before `mount` is a
 * host bug.
 */
export interface MatchScene {
  /**
   * Attach to a container and take ownership of everything inside it.
   *
   * The scene may write to `el` however it likes — DOM nodes for `DomScene`, a
   * single canvas for `PixiScene`. That freedom is the point of the boundary:
   * the host promises never to look, so the two implementations can differ
   * completely below this line.
   *
   * Idempotence is NOT promised. Mounting twice without `destroy` is a bug.
   */
  mount(el: HTMLElement, opts: SceneOpts): void;

  /**
   * Replace presentation with the authoritative snapshot. SNAPS — no
   * animation, no tween, no easing, on the frame it is called.
   *
   * This is hard rule 2's mechanism and the queue's release valve. Call it:
   *   · after `welcome` and after every `restore` (reconnect),
   *   · whenever the queue is deeper than the player's patience,
   *   · on every replay scrub,
   *   · after any correction from the server that contradicts a prediction.
   *
   * It does NOT drop the queue on its own — `flush()` does that, and the two
   * are almost always called together. Kept separate because a scene may
   * legitimately want the new view while a non-blocking overlay finishes.
   */
  setView(v: SeatView): void;

  /**
   * Enqueue exactly ONE animation for one event. Returns immediately.
   *
   * Never awaits, never yields, never gates anything (hard rule 1). One event
   * in, one `QueuedAnimation` out — the mapping is `describeEvent`, and it is
   * pure so the same log always produces the same queue.
   *
   * The argument is `SceneEvent`, i.e. `SeatVisible<RedactedGameEvent>`. That
   * is the boundary, enforced by the compiler: an omniscient `GameEvent`
   * carries the wall seed and every seat's hand and will not typecheck here.
   *
   * `applyEvent` is NOT how the scene learns the truth. It is a hint about how
   * the truth just changed, for the purpose of moving pixels. The truth is
   * whatever `setView` was last given, and the scene must be able to draw a
   * correct table having received zero events.
   */
  applyEvent(e: SceneEvent): void;

  /**
   * Drop the queue and snap presentation to the current view.
   *
   * Drops, not fast-forwards: half-finished animations are abandoned at their
   * final state, not accelerated through their remaining frames. Safe to call
   * at any time, including with an empty queue.
   */
  flush(): void;

  /**
   * Tear down: cancel timers and animation frames, release textures and
   * listeners, empty the container. After this the instance is dead — mount a
   * new one rather than reusing it.
   */
  destroy(): void;
}

/* ── deterministic variation ───────────────────────────────────────────── */

/**
 * A pure hash of `(scatterSeed, key)` into [0, 1) — same inputs, same value,
 * forever. Uses the engine's seeded PRNG rather than a second generator: one
 * call on a freshly seeded stream IS a hash, and there is no shared stream
 * state to desynchronise.
 *
 * The stream property matters. A running generator would give the nth call a
 * value that depends on how many calls came before, so a queue drop or a
 * replay scrub would repaint the pile differently — §4a's "the pile visibly
 * reshuffles every tick", which is nauseating and destroys the countability
 * the whole layout exists to protect.
 *
 * Never `Math.random`, never `Date.now`.
 */
export const variantFor = (scatterSeed: number, key: number): number =>
  prng((scatterSeed + key) >>> 0)();

/**
 * The stable key for a tile's position in the centre pile: the seat, and the
 * index of the tile within THAT SEAT's discards.
 *
 * §4a says to seed the scatter from the event index, and that is right for a
 * live stream — but `seq` does not survive a resync. A `SeatSnapshot` carries
 * `seats[i].discards` as per-seat arrays with no `seq` attached, so a
 * reconnecting player keyed on `seq` would see the entire pile jump to new
 * positions. Keyed on `(seat, index)` the pile is bit-identical before and
 * after a reconnect, which is what a player means by "the table did not
 * change".
 *
 * The ordered, attributed sequence is not lost by this — it lives in the event
 * log, which is where §4a says the pile is rendered from and where the review
 * screen reads it. Only the SCATTER key changes.
 */
export const discardSlotKey = (seat: SeatIndex, indexWithinSeat: number): number =>
  seat * 1013 + indexWithinSeat;

/* ── event → animation ─────────────────────────────────────────────────── */

/**
 * The translation table: one redacted event to one queue entry. Pure, total,
 * and exhaustive — adding an event type without a case is a compile error at
 * `assertNever`.
 *
 * Every field copied here already passed through `redactEventFor`. This
 * function ADDS nothing and WIDENS nothing: where the payload says
 * `TileId | null`, so does the descriptor. It exists so the descriptors are
 * load-bearing rather than decorative, and so `tilesIn` can be checked against
 * real output in a test.
 */
export function describeEvent(e: SceneEvent, scatterSeed = 0): QueuedAnimation {
  const anim = toAnimation(e);
  const profile = ANIMATION_PROFILE[anim.kind];
  return {
    seq: e.seq,
    variant: variantFor(scatterSeed, e.seq),
    budgetMs: profile.budgetMs,
    skippable: profile.skippable,
    serial: profile.serial,
    anim,
  };
}

function toAnimation(e: SceneEvent): SceneAnimation {
  switch (e.type) {
    case "deal": {
      const p = e.payload;
      return {
        kind: "deal",
        dealer: p.dealer,
        roundWind: p.roundWind,
        seatWinds: p.seatWinds,
        hands: p.hands,
        handCounts: p.handCounts,
        wallRemaining: p.wallRemaining,
        // 13 tiles per seat inside the budget, four seats interleaved.
        staggerMs: ANIMATION_PROFILE.deal.budgetMs / 52,
      };
    }
    case "flowerReplacement": {
      const p = e.payload;
      return {
        kind: "flowerReplacement",
        seat: p.seat,
        flower: p.flower,
        replacement: p.replacement,
        wallRemaining: p.wallRemaining,
      };
    }
    case "draw": {
      const p = e.payload;
      return { kind: "draw", seat: p.seat, tile: p.tile, wallRemaining: p.wallRemaining };
    }
    case "discard": {
      const p = e.payload;
      return { kind: "discard", seat: p.seat, tile: p.tile, drawAndCut: p.drawAndCut };
    }
    case "claimOffered": {
      const p = e.payload;
      return {
        kind: "claimOffered",
        seat: p.seat,
        tile: p.tile,
        from: p.from,
        options: p.options,
        deadlineTs: p.deadlineTs,
      };
    }
    case "claimDeclined": {
      const p = e.payload;
      return {
        kind: "claimDeclined",
        seat: p.seat,
        tile: p.tile,
        from: p.from,
        reason: p.reason,
      };
    }
    case "claimed": {
      const p = e.payload;
      return {
        kind: "claimed",
        seat: p.seat,
        claim: p.kind,
        tile: p.tile,
        from: p.from,
        meld: p.meld,
      };
    }
    case "kongReplacement": {
      const p = e.payload;
      return {
        kind: "kongReplacement",
        seat: p.seat,
        tile: p.tile,
        kongKind: p.kongKind,
        wallRemaining: p.wallRemaining,
      };
    }
    case "concealedKong": {
      const p = e.payload;
      return { kind: "concealedKong", seat: p.seat, tile: p.tile, meld: p.meld };
    }
    case "addedKong": {
      const p = e.payload;
      return { kind: "addedKong", seat: p.seat, tile: p.tile, meld: p.meld };
    }
    case "robKongWindow": {
      const p = e.payload;
      return {
        kind: "robKongWindow",
        seat: p.seat,
        tile: p.tile,
        offeredToYou: p.offeredToYou,
        deadlineTs: p.deadlineTs,
      };
    }
    case "refusedWin": {
      const p = e.payload;
      return {
        kind: "refusedWin",
        seat: p.seat,
        winningTile: p.winningTile,
        selfDraw: p.selfDraw,
        from: p.from,
        minimumFaan: p.minimumFaan,
        reason: p.reason,
        melds: p.melds,
        flowers: p.flowers,
        score: p.score,
        concealed: p.concealed,
      };
    }
    case "winOnDiscard": {
      const p = e.payload;
      return {
        kind: "winOnDiscard",
        seat: p.context.seat,
        winningTile: p.context.winningTile,
        from: p.context.from,
        concealed: p.concealed,
        melds: p.melds,
        flowers: p.flowers,
        score: p.score,
      };
    }
    case "selfDraw": {
      const p = e.payload;
      return {
        kind: "selfDraw",
        seat: p.context.seat,
        winningTile: p.context.winningTile,
        concealed: p.concealed,
        melds: p.melds,
        flowers: p.flowers,
        score: p.score,
      };
    }
    case "exhaustiveDraw": {
      const p = e.payload;
      return {
        kind: "exhaustiveDraw",
        wallRemaining: p.wallRemaining,
        hands: p.hands,
        distanceToReady: p.distanceToReady,
      };
    }
    case "handEnd": {
      const p = e.payload;
      return {
        kind: "handEnd",
        outcome: p.outcome,
        winner: p.winner,
        loser: p.loser,
        faan: p.faan,
        chipDeltas: p.chipDeltas,
        standings: p.standings,
        dealerRepeats: p.dealerRepeats,
        nextDealer: p.nextDealer,
        nextRoundWind: p.nextRoundWind,
      };
    }
    case "matchEnd": {
      const p = e.payload;
      return {
        kind: "matchEnd",
        reason: p.reason,
        standings: p.standings,
        placements: p.placements,
        handsPlayed: p.handsPlayed,
      };
    }
  }
  return assertNever(e, "scene event");
}

/**
 * Every tile this descriptor would put on screen, face up.
 *
 * Exhaustive by construction: if a descriptor grows a tile-bearing field and
 * this function is not updated, that field is invisible to the boundary test
 * below — so treat adding a case here as part of adding a field there.
 *
 * A `null` tile is a face-down tile and contributes nothing, which is the whole
 * point: it means the renderer has a back to draw and no identity to leak.
 */
export function tilesIn(a: SceneAnimation): TileId[] {
  const out: TileId[] = [];
  const push = (t: TileId | null | undefined): void => {
    if (typeof t === "number") out.push(t);
  };
  const pushAll = (ts: readonly TileId[] | null | undefined): void => {
    if (ts) for (const t of ts) out.push(t);
  };
  const pushMelds = (
    ms: readonly { tiles: readonly TileId[] | null }[] | null | undefined,
  ): void => {
    if (ms) for (const m of ms) pushAll(m.tiles);
  };

  switch (a.kind) {
    case "deal":
      for (const h of a.hands) pushAll(h);
      return out;
    case "flowerReplacement":
      push(a.flower);
      push(a.replacement);
      return out;
    case "draw":
      push(a.tile);
      return out;
    case "discard":
      push(a.tile);
      return out;
    case "claimOffered":
      push(a.tile);
      for (const o of a.options) pushAll(o.with);
      return out;
    case "claimDeclined":
      push(a.tile);
      return out;
    case "claimed":
      push(a.tile);
      pushMelds([a.meld]);
      return out;
    case "kongReplacement":
      push(a.tile);
      return out;
    case "concealedKong":
      push(a.tile);
      pushMelds([a.meld]);
      return out;
    case "addedKong":
      push(a.tile);
      pushMelds([a.meld]);
      return out;
    case "robKongWindow":
      push(a.tile);
      return out;
    case "refusedWin":
      push(a.winningTile);
      pushAll(a.concealed);
      pushMelds(a.melds);
      pushAll(a.flowers);
      return out;
    case "winOnDiscard":
    case "selfDraw":
      push(a.winningTile);
      pushAll(a.concealed);
      pushMelds(a.melds);
      pushAll(a.flowers);
      return out;
    case "exhaustiveDraw":
      for (const h of a.hands) pushAll(h);
      return out;
    case "handEnd":
    case "matchEnd":
      return out;
  }
  return assertNever(a, "scene animation");
}

/* ── the null implementation ───────────────────────────────────────────── */

/**
 * A `MatchScene` that draws NOTHING.
 *
 * It exists so the boundary is testable and usable before either renderer is
 * written: the host, the socket plumbing and the replay driver can all be
 * built and exercised against it, and a headless replay fold needs no renderer
 * at all. It is not a stub to be replaced — it stays, as the scene you mount
 * when there is no screen.
 *
 * The one thing it does beyond nothing is RECORD what it was handed, in
 * `received`. That is bookkeeping, not rendering, and it is deliberate: a scene
 * that discarded its input could not be checked for leaks, and "no concealed
 * tile ever reaches a renderer" is a property that has to be asserted against
 * something. Treat `received` as test surface.
 */
export class NullScene implements MatchScene {
  readonly received: {
    views: SeatView[];
    events: SceneEvent[];
    queued: QueuedAnimation[];
    flushes: number;
  } = { views: [], events: [], queued: [], flushes: 0 };

  private opts: SceneOpts | null = null;
  private el: HTMLElement | null = null;
  private destroyed = false;

  mount(el: HTMLElement, opts: SceneOpts): void {
    this.el = el;
    this.opts = opts;
  }

  setView(v: SeatView): void {
    // Snaps, trivially: there is nothing to tween.
    this.received.views.push(v);
  }

  applyEvent(e: SceneEvent): void {
    this.received.events.push(e);
    // Runs the real translation so the queue contract is exercised, then drops
    // the result on the floor. Never awaits — hard rule 1 holds here too.
    this.received.queued.push(describeEvent(e, this.opts?.scatterSeed ?? 0));
  }

  flush(): void {
    this.received.queued.length = 0;
    this.received.flushes++;
  }

  destroy(): void {
    this.destroyed = true;
    this.el = null;
    this.opts = null;
  }

  /** For tests asserting lifecycle, not for the host to branch on. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }
}

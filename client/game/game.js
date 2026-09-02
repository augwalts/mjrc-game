"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all2) => {
    for (var name4 in all2)
      __defProp(target, name4, { get: all2[name4], enumerable: true });
  };

  // engine/src/types.ts
  var BAMBOO_START = 9;
  var CIRCLES_START = 18;
  var WINDS_START = 27;
  var DRAGONS_START = 31;
  var FLOWERS_START = 34;
  var SCORING_KINDS = 34;
  var WALL_SIZE = 144;
  var CLAIM_PRIORITY = ["win", "kong", "pung", "chow"];

  // engine/src/tiles.ts
  var TILE_NAMES = (() => {
    const n = [];
    for (let i = 1; i <= 9; i++) n.push(`${i}\u842C`);
    for (let i = 1; i <= 9; i++) n.push(`${i}\u7D22`);
    for (let i = 1; i <= 9; i++) n.push(`${i}\u7B52`);
    n.push("\u6771", "\u5357", "\u897F", "\u5317", "\u4E2D", "\u767C", "\u767D");
    n.push("\u6885", "\u862D", "\u83CA", "\u7AF9", "\u6625", "\u590F", "\u79CB", "\u51AC");
    return n;
  })();
  var isFlower = (t) => t >= FLOWERS_START;
  var isHonour = (t) => t >= WINDS_START && t < FLOWERS_START;
  var isWind = (t) => t >= WINDS_START && t < DRAGONS_START;
  var isDragon = (t) => t >= DRAGONS_START && t < FLOWERS_START;
  var isSuited = (t) => t < WINDS_START;
  var isTerminalOrHonour = (t) => isHonour(t) || isSuited(t) && (t % 9 === 0 || t % 9 === 8);
  function suitOf(t) {
    if (t < BAMBOO_START) return "chars";
    if (t < CIRCLES_START) return "bamboo";
    if (t < WINDS_START) return "circles";
    return "honours";
  }
  var rankOf = (t) => isSuited(t) ? t % 9 : -1;
  function isRun(a, b, c) {
    return isSuited(a) && suitOf(a) === suitOf(c) && b === a + 1 && c === a + 2 && rankOf(a) <= 6;
  }
  var flowerSeat = (t) => (t - FLOWERS_START) % 4;
  function counts(tiles) {
    const c = new Array(SCORING_KINDS).fill(0);
    for (const t of tiles) if (t < SCORING_KINDS) c[t]++;
    return c;
  }

  // engine/src/wall.ts
  function prng(seed2) {
    let a = seed2 >>> 0;
    return () => {
      a = a + 1831565813 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function buildWall(seed2, useFlowers = true) {
    const w = [];
    for (let i = 0; i < SCORING_KINDS; i++) for (let k = 0; k < 4; k++) w.push(i);
    if (useFlowers) for (let i = FLOWERS_START; i < FLOWERS_START + 8; i++) w.push(i);
    const rnd = prng(seed2);
    for (let i = w.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [w[i], w[j]] = [w[j], w[i]];
    }
    return w;
  }

  // engine/src/ready.ts
  var suitMemo = /* @__PURE__ */ new Map();
  var honourMemo = /* @__PURE__ */ new Map();
  function segmentCombos(v, suited, memo) {
    let key = 0;
    for (let i = 0; i < v.length; i++) key = key * 5 + v[i];
    const hit = memo.get(key);
    if (hit) return hit;
    const flags = new Uint8Array(50);
    const n = v.length;
    const rec2 = (i, s, p, e) => {
      while (i < n && v[i] === 0) i++;
      if (i >= n) {
        flags[s * 10 + p * 2 + e] = 1;
        return;
      }
      if (s < 4 && v[i] >= 3) {
        v[i] -= 3;
        rec2(i, s + 1, p, e);
        v[i] += 3;
      }
      if (s < 4 && suited && i <= 6 && v[i + 1] > 0 && v[i + 2] > 0) {
        v[i]--;
        v[i + 1]--;
        v[i + 2]--;
        rec2(i, s + 1, p, e);
        v[i]++;
        v[i + 1]++;
        v[i + 2]++;
      }
      if (v[i] >= 2) {
        if (p < 4) {
          v[i] -= 2;
          rec2(i, s, p + 1, e);
          v[i] += 2;
        }
        if (e === 0) {
          v[i] -= 2;
          rec2(i, s, p, 1);
          v[i] += 2;
        }
      }
      if (p < 4 && suited && i <= 7 && v[i + 1] > 0) {
        v[i]--;
        v[i + 1]--;
        rec2(i, s, p + 1, e);
        v[i]++;
        v[i + 1]++;
      }
      if (p < 4 && suited && i <= 6 && v[i + 2] > 0) {
        v[i]--;
        v[i + 2]--;
        rec2(i, s, p + 1, e);
        v[i]++;
        v[i + 2]++;
      }
      v[i]--;
      rec2(i, s, p, e);
      v[i]++;
    };
    rec2(0, 0, 0, 0);
    const pruned = new Uint8Array(50);
    for (let a = 0; a < 50; a++) {
      if (!flags[a]) continue;
      const s0 = a / 10 | 0, r0 = a % 10, p0 = r0 / 2 | 0, e0 = r0 % 2;
      let dominated = false;
      for (let b = 0; b < 50 && !dominated; b++) {
        if (!flags[b] || b === a) continue;
        const s1 = b / 10 | 0, r1 = b % 10, p1 = r1 / 2 | 0, e1 = r1 % 2;
        if (s1 >= s0 && p1 >= p0 && e1 >= e0 && (s1 > s0 || p1 > p0 || e1 > e0)) dominated = true;
      }
      if (!dominated) pruned[a] = 1;
    }
    memo.set(key, pruned);
    return pruned;
  }
  var seg = new Array(9);
  function groupCombos(c, g) {
    if (g < 3) {
      for (let r = 0; r < 9; r++) seg[r] = c[g * 9 + r];
      return segmentCombos(seg, true, suitMemo);
    }
    const h = new Array(7);
    for (let r = 0; r < 7; r++) h[r] = c[27 + r];
    return segmentCombos(h, false, honourMemo);
  }
  function fastRawDistance(c, melds) {
    let reach = new Uint8Array(50);
    reach[0] = 1;
    for (let g = 0; g < 4; g++) {
      const combos = groupCombos(c, g);
      const next = new Uint8Array(50);
      for (let st = 0; st < 50; st++) {
        if (!reach[st]) continue;
        const s0 = st / 10 | 0, rem = st % 10, p0 = rem / 2 | 0, e0 = rem % 2;
        for (let cb = 0; cb < 50; cb++) {
          if (!combos[cb]) continue;
          const s1 = cb / 10 | 0, rem1 = cb % 10, p1 = rem1 / 2 | 0, e1 = rem1 % 2;
          if (e0 + e1 > 1) continue;
          const s = Math.min(4, s0 + s1), pp = Math.min(4, p0 + p1);
          next[s * 10 + pp * 2 + (e0 + e1)] = 1;
        }
      }
      reach = next;
    }
    let best = 99;
    for (let st = 0; st < 50; st++) {
      if (!reach[st]) continue;
      const s = st / 10 | 0, rem = st % 10, p = rem / 2 | 0, e = rem % 2;
      const total = s + melds;
      const capped = total + p > 4 ? Math.max(0, 4 - total) : p;
      const d = 8 - 2 * total - capped - e;
      if (d < best) best = d;
    }
    return best;
  }
  function sevenPairsDistance(c) {
    let pairs = 0, kinds = 0;
    for (let i = 0; i < SCORING_KINDS; i++) {
      const n = c[i];
      if (n === 0) continue;
      kinds++;
      if (n >= 2) pairs++;
    }
    return 6 - pairs + Math.max(0, 7 - kinds);
  }
  function distanceToReady(c, melds = 0, sevenPairs = false) {
    let total = melds * 3;
    for (let i = 0; i < SCORING_KINDS; i++) total += c[i];
    const seven = sevenPairs && melds === 0 ? sevenPairsDistance(c) : 99;
    if (total % 3 !== 2) return Math.min(fastRawDistance(c, melds), seven);
    const raw = fastRawDistance(c, melds);
    if (raw < 0) return -1;
    if (seven < 0) return -1;
    const w = c.slice();
    let best = raw;
    for (let i = 0; i < SCORING_KINDS; i++) {
      if (w[i] > 0) {
        w[i]--;
        const d = fastRawDistance(w, melds);
        if (d < best) best = d;
        w[i]++;
      }
    }
    if (sevenPairs && melds === 0) best = Math.min(best, sevenPairsDistance(c));
    return best;
  }
  function liveTiles(c, melds = 0, visible, sevenPairs = false) {
    const w = c.slice();
    const base = distanceToReady(w, melds, sevenPairs);
    const tiles = [];
    let total = 0;
    for (let i = 0; i < SCORING_KINDS; i++) {
      if (w[i] >= 4) continue;
      w[i]++;
      const d = distanceToReady(w, melds, sevenPairs);
      w[i]--;
      if (d < base) {
        const unseen = 4 - Math.min(4, visible?.[i] ?? 0);
        if (unseen > 0) {
          tiles.push({ tile: i, unseen });
          total += unseen;
        }
      }
    }
    return { distance: base, tiles, total };
  }

  // engine/src/melds.ts
  var isSeat = (s) => Number.isInteger(s) && s >= 0 && s <= 3;
  var leftOf = (seat) => (seat + 3) % 4;
  function meldForm(m) {
    if (m.kind !== "kong") return m.kind;
    if (m.concealed) return "concealedKong";
    return m.addedToPung ? "addedKong" : "exposedKong";
  }
  var meldTileCount = (m) => m.kind === "kong" ? 4 : 3;
  var isConcealedSet = (m) => m.kind === "kong" && m.concealed;
  var name = (t) => TILE_NAMES[t] ?? `tile ${t}`;
  var names = (ts) => ts.map(name).join("");
  function tileError(tiles) {
    for (const t of tiles) {
      if (!Number.isInteger(t) || t < 0 || t >= SCORING_KINDS)
        return `tile ${t} cannot be melded \u2014 flowers \u82B1 are set aside, never melded`;
    }
    for (let i = 1; i < tiles.length; i++)
      if (tiles[i] < tiles[i - 1]) return `meld tiles must be ascending, got ${names(tiles)}`;
    return null;
  }
  function meldShapeError(m) {
    const t = m.tiles;
    const bad = tileError(t);
    if (bad) return bad;
    if (t.length !== meldTileCount(m))
      return `a ${m.kind} holds ${meldTileCount(m)} tiles, got ${t.length}`;
    switch (m.kind) {
      case "chow":
        if (!isRun(t[0], t[1], t[2])) return `${names(t)} is not a run`;
        if (m.concealed) return "a chow \u4E0A is always claimed from a discard, so it is never concealed";
        if (m.addedToPung) return "addedToPung \u52A0\u69D3 only applies to a kong";
        return null;
      case "pung":
        if (t[0] !== t[1] || t[1] !== t[2]) return `${names(t)} is not three of a kind`;
        if (m.concealed)
          return "a pung \u78B0 is always claimed; a triplet held in hand is not a meld until it is declared as a \u6697\u69D3";
        if (m.addedToPung) return "addedToPung \u52A0\u69D3 only applies to a kong";
        return null;
      case "kong":
        if (t[0] !== t[1] || t[1] !== t[2] || t[2] !== t[3])
          return `${names(t)} is not four of a kind`;
        if (m.concealed && m.addedToPung) return "a kong is either \u6697\u69D3 or \u52A0\u69D3, never both";
        return null;
    }
    return null;
  }
  function meldError(m, owner) {
    const shape = meldShapeError(m);
    if (shape) return shape;
    if (!isSeat(owner)) return `owner seat ${owner} is not a seat`;
    if (!isSeat(m.from)) return `source seat ${m.from} is not a seat`;
    if (m.kind === "chow" && m.from !== leftOf(owner))
      return `a chow \u4E0A may only be claimed from \u4E0A\u5BB6 (seat ${leftOf(owner)}), not seat ${m.from}`;
    if (m.concealed && m.from !== owner)
      return "a concealed kong \u6697\u69D3 claims nothing, so `from` must be the owner's own seat";
    if (!m.concealed && m.from === owner)
      return `an exposed ${m.kind} must name the seat the claimed tile came from`;
    return null;
  }
  function validateMeld(m, owner) {
    const e = meldError(m, owner);
    if (e) throw new Error(`illegal ${meldForm(m)}: ${e}`);
  }
  function makeChow(tiles, owner, from) {
    const m = { kind: "chow", tiles: [...tiles].sort((a, b) => a - b), from, concealed: false };
    validateMeld(m, owner);
    return m;
  }
  function makePung(tile, owner, from) {
    const m = { kind: "pung", tiles: [tile, tile, tile], from, concealed: false };
    validateMeld(m, owner);
    return m;
  }
  function makeExposedKong(tile, owner, from) {
    const m = { kind: "kong", tiles: [tile, tile, tile, tile], from, concealed: false };
    validateMeld(m, owner);
    return m;
  }
  function makeConcealedKong(tile, owner) {
    const m = { kind: "kong", tiles: [tile, tile, tile, tile], from: owner, concealed: true };
    validateMeld(m, owner);
    return m;
  }
  function makeAddedKong(pung, owner) {
    if (pung.kind !== "pung")
      throw new Error(`\u52A0\u69D3 must be added to a pung \u78B0, not a ${pung.kind}`);
    validateMeld(pung, owner);
    const t = pung.tiles[0];
    const m = {
      kind: "kong",
      tiles: [t, t, t, t],
      from: pung.from,
      concealed: false,
      addedToPung: true
    };
    validateMeld(m, owner);
    return m;
  }
  var copies = (hand, tile) => hand.reduce((n, t) => t === tile ? n + 1 : n, 0);
  var canPung = (hand, tile) => copies(hand, tile) >= 2;
  var canExposedKong = (hand, tile) => copies(hand, tile) >= 3;
  var canConcealedKong = (hand, tile) => copies(hand, tile) >= 4;
  var findExposedPung = (melds, tile) => melds.find((m) => m.kind === "pung" && m.tiles[0] === tile);
  var canAddedKong = (hand, melds, tile) => copies(hand, tile) >= 1 && findExposedPung(melds, tile) !== void 0;
  function chowOptions(hand, tile, owner, from) {
    if (from !== leftOf(owner) || !isSuited(tile)) return [];
    const r = rankOf(tile);
    const has = (t) => hand.includes(t);
    const out = [];
    if (r <= 6 && has(tile + 1) && has(tile + 2)) out.push([tile + 1, tile + 2]);
    if (r >= 1 && r <= 7 && has(tile - 1) && has(tile + 1)) out.push([tile - 1, tile + 1]);
    if (r >= 2 && has(tile - 2) && has(tile - 1)) out.push([tile - 2, tile - 1]);
    return out;
  }
  function upgradePungToKong(melds, tile, owner) {
    const i = melds.findIndex((m) => m.kind === "pung" && m.tiles[0] === tile);
    if (i < 0) throw new Error(`\u52A0\u69D3 needs an exposed pung \u78B0 of ${name(tile)}; there is none`);
    const out = melds.slice();
    out[i] = makeAddedKong(melds[i], owner);
    return out;
  }

  // engine/src/decompose.ts
  var setKey = (s) => `${s.kind}:${s.tiles.join(",")}:${s.concealed ? "c" : "o"}${s.hasWinningTile ? "*" : ""}`;
  var decompositionKey = (d) => `${d.sets.map(setKey).sort().join("|")}//${setKey(d.pair)}`;
  function enumerateSets(c, need, acc, out) {
    if (need === 0) {
      for (let i2 = 0; i2 < SCORING_KINDS; i2++) if (c[i2] > 0) return;
      out.push(acc.map((s) => ({ kind: s.kind, tiles: s.tiles.slice() })));
      return;
    }
    let i = 0;
    while (i < SCORING_KINDS && c[i] === 0) i++;
    if (i >= SCORING_KINDS) return;
    if (c[i] >= 3) {
      c[i] -= 3;
      acc.push({ kind: "pung", tiles: [i, i, i] });
      enumerateSets(c, need - 1, acc, out);
      acc.pop();
      c[i] += 3;
    }
    if (isSuited(i) && rankOf(i) <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--;
      c[i + 1]--;
      c[i + 2]--;
      acc.push({ kind: "chow", tiles: [i, i + 1, i + 2] });
      enumerateSets(c, need - 1, acc, out);
      acc.pop();
      c[i]++;
      c[i + 1]++;
      c[i + 2]++;
    }
  }
  var name2 = (t) => TILE_NAMES[t] ?? `tile ${t}`;
  function assertScoringTile(t) {
    if (!Number.isInteger(t) || t < 0 || t >= SCORING_KINDS)
      throw new Error(`tile ${t} is not a scoring tile \u2014 flowers \u82B1 are held apart from the hand`);
  }
  function decomposeWin(concealed, melds, winningTile) {
    if (melds.length > 4)
      throw new Error(`a hand holds at most four sets, got ${melds.length} melds`);
    for (const m of melds) {
      const e = meldShapeError(m);
      if (e) throw new Error(`illegal meld: ${e}`);
    }
    assertScoringTile(winningTile);
    for (const t of concealed) assertScoringTile(t);
    const needSets = 4 - melds.length;
    if (concealed.length !== needSets * 3 + 1)
      throw new Error(
        `${concealed.length} concealed tiles alongside ${melds.length} meld(s) cannot make a winning hand; expected ${needSets * 3 + 1} (the winning tile is passed separately)`
      );
    const c = counts([...concealed, winningTile]);
    const seenCopies = c.slice();
    for (const m of melds) for (const t of m.tiles) seenCopies[t]++;
    for (let i = 0; i < SCORING_KINDS; i++)
      if (seenCopies[i] > 4) throw new Error(`${seenCopies[i]} copies of ${name2(i)}; only four exist`);
    const fixed = melds.map((m) => ({
      kind: m.kind,
      tiles: m.tiles.slice(),
      concealed: isConcealedSet(m),
      meld: m,
      hasWinningTile: false
    }));
    const fullyConcealed = melds.every(isConcealedSet);
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (let p = 0; p < SCORING_KINDS; p++) {
      if (c[p] < 2) continue;
      c[p] -= 2;
      const partitions = [];
      enumerateSets(c, needSets, [], partitions);
      c[p] += 2;
      for (const parts of partitions) {
        const handSets = parts.map((s) => ({
          kind: s.kind,
          tiles: s.tiles,
          concealed: true,
          hasWinningTile: false
        })).sort((a, b) => a.tiles[0] - b.tiles[0] || a.kind.localeCompare(b.kind));
        const slots = [];
        if (p === winningTile) slots.push(-1);
        handSets.forEach((s, i) => {
          if (s.tiles.includes(winningTile)) slots.push(i);
        });
        for (const slot of slots) {
          const pair = {
            kind: "pair",
            tiles: [p, p],
            concealed: true,
            hasWinningTile: slot === -1
          };
          const sets = [
            ...fixed.map((s) => ({ ...s, tiles: s.tiles.slice() })),
            ...handSets.map((s, i) => ({ ...s, tiles: s.tiles.slice(), hasWinningTile: i === slot }))
          ];
          const d = { sets, pair, fullyConcealed, winningTile };
          const key = decompositionKey(d);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(d);
        }
      }
    }
    return out;
  }
  function isThirteenOrphansShape(concealed, melds, winningTile) {
    if (melds.length > 0 || concealed.length !== 13) return false;
    const c = counts([...concealed, winningTile]);
    let paired = 0;
    for (let t = 0; t < SCORING_KINDS; t++) {
      if (!isTerminalOrHonour(t)) continue;
      if (c[t] === 2) paired++;
      else if (c[t] !== 1) return false;
    }
    return paired === 1;
  }
  function isSevenPairsShape(concealed, melds, winningTile) {
    if (melds.length > 0 || concealed.length !== 13) return false;
    const c = counts([...concealed, winningTile]);
    let pairs = 0;
    for (let t = 0; t < SCORING_KINDS; t++) {
      const n = c[t];
      if (n === 0) continue;
      if (n !== 2) return false;
      pairs++;
    }
    return pairs === 7;
  }
  var hasWinningShape = (concealed, melds, winningTile, sevenPairs = false) => isThirteenOrphansShape(concealed, melds, winningTile) || sevenPairs && isSevenPairsShape(concealed, melds, winningTile) || decomposeWin(concealed, melds, winningTile).length > 0;
  function concealedTripletCount(d, winFromDiscard) {
    return d.sets.filter(
      (s) => (s.kind === "pung" || s.kind === "kong") && s.concealed && !(winFromDiscard && s.hasWinningTile)
    ).length;
  }

  // rulesets/src/patterns.ts
  var PATTERNS = [
    /* ── honour melds 番子 · 1 faan apiece ────────────────────────────────
       A kong of the same honour is worth exactly what the pung is worth in all
       six systems, so kongs get no ids of their own. The kong shape earns a
       replacement draw, not extra faan. */
    {
      id: "dragonPung",
      characters: "\u4E09\u5143\u724C",
      jyutping: "saam1 jyun4 paai2",
      label: "Pung of Dragons",
      family: "honourMeld",
      subsumes: [],
      note: "One id covers all three dragons and both set sizes \u2014 a kong of dragons is worth exactly what the pung is worth in all six surveyed systems, and each dragon scores separately, so the award simply repeats. Honours never form runs: \u4E2D\u767C\u767D in a row is three loose tiles."
    },
    {
      id: "seatWind",
      characters: "\u9580\u98A8",
      jyutping: "mun4 fung1",
      label: "Pung of Seat Wind",
      family: "honourMeld",
      subsumes: [],
      note: "Seat wind and round wind are separate awards; East in East round scores both."
    },
    {
      id: "roundWind",
      characters: "\u5708\u98A8",
      jyutping: "hyun1 fung1",
      label: "Pung of Round Wind",
      family: "honourMeld",
      subsumes: []
    },
    /* ── bonus tiles 花 ──────────────────────────────────────────────────── */
    {
      id: "ownFlower",
      characters: "\u6B63\u82B1",
      jyutping: "zing3 faa1",
      label: "Own Flower",
      family: "bonusTile",
      subsumes: [],
      note: "The flower matching the seat wind. A flower that is not yours scores nothing alone."
    },
    {
      id: "ownSeason",
      characters: "\u6B63\u82B1",
      jyutping: "zing3 faa1",
      label: "Own Season",
      family: "bonusTile",
      subsumes: []
    },
    {
      id: "allFlowers",
      characters: "\u4E00\u53F0\u82B1",
      jyutping: "jat1 toi4 faa1",
      label: "All Four Flowers",
      family: "bonusTile",
      subsumes: [],
      note: "Deliberately does NOT subsume ownFlower. Holding all four means holding your own, so 1 + 2 = 3 \u2014 which is the \u4E00\u53F0\u82B1 total HK tables actually quote."
    },
    {
      id: "allSeasons",
      characters: "\u4E00\u53F0\u82B1",
      jyutping: "jat1 toi4 faa1",
      label: "All Four Seasons",
      family: "bonusTile",
      subsumes: [],
      note: "Same arithmetic as allFlowers."
    },
    {
      id: "noFlowers",
      characters: "\u7121\u82B1",
      jyutping: "mou4 faa1",
      label: "No Flowers or Seasons",
      family: "bonusTile",
      subsumes: [],
      note: "Mutually exclusive with every other bonus-tile award, so no subsumption is needed."
    },
    /* ── winning conditions ──────────────────────────────────────────────── */
    {
      id: "selfDraw",
      characters: "\u81EA\u6478",
      jyutping: "zi6 mo1",
      label: "Self-Draw",
      family: "winCondition",
      subsumes: [],
      note: "Cantonese, not borrowed \u2014 kept per TERMINOLOGY.md."
    },
    {
      id: "concealedHand",
      characters: "\u9580\u524D\u6E05",
      jyutping: "mun4 cin4 cing1",
      label: "Fully Concealed",
      family: "winCondition",
      subsumes: [],
      note: "No meld claimed from a discard; the winning tile itself may still be a discard. Hands that are concealed by definition subsume this instead of stacking with it."
    },
    {
      id: "winOnLastTile",
      characters: "\u6D77\u5E95\u6488\u6708",
      jyutping: "hoi2 dai2 lau4 jyut6",
      label: "Out on the Last Tile",
      family: "winCondition",
      subsumes: []
    },
    {
      id: "winOnLastDiscard",
      characters: "\u6CB3\u5E95\u6488\u9B5A",
      jyutping: "ho4 dai2 lau4 jyu4",
      label: "Out on the Last Discard",
      family: "winCondition",
      subsumes: [],
      note: "The twin of \u6D77\u5E95\u6488\u6708, not the same award: \u6D77\u5E95 is the wall's final DRAW, \u6CB3\u5E95 the final DISCARD. Every surveyed system prices the pair as one row worth 1, so both ids carry 1 and no hand can ever earn both."
    },
    {
      id: "robbingKong",
      characters: "\u6436\u69D3",
      jyutping: "coeng2 gong3",
      label: "Rob a Kong",
      family: "winCondition",
      subsumes: [],
      note: "Won on the tile that would have turned an exposed pung into a \u52A0\u69D3."
    },
    {
      id: "winOnKongReplacement",
      characters: "\u69D3\u4E0A\u958B\u82B1",
      jyutping: "gong3 soeng5 hoi1 faa1",
      label: "Win on a Replacement Tile",
      family: "winCondition",
      subsumes: [],
      note: "The replacement is a wall draw, so selfDraw is collected on top \u2014 the two are additive, not alternatives."
    },
    {
      id: "winByDoubleKong",
      characters: "\u69D3\u4E0A\u69D3",
      jyutping: "gong3 soeng5 gong3",
      label: "Win by Double Kong",
      family: "winCondition",
      subsumes: ["winOnKongReplacement"],
      note: "The replacement made a second kong and THAT replacement won. Only Wikipedia's table prices it."
    },
    /* ── hand patterns ───────────────────────────────────────────────────── */
    {
      id: "allChows",
      characters: "\u5E73\u7CCA",
      jyutping: "ping4 wu4",
      label: "All Chows",
      aka: ["Common Hand", "Chow Hand"],
      family: "handPattern",
      subsumes: [],
      note: "A minority of houses disqualify an honour pair as the eyes. Not modelled \u2014 house rule."
    },
    {
      id: "allPungs",
      characters: "\u5C0D\u5C0D\u7CCA",
      jyutping: "deoi3 deoi3 wu4",
      label: "All Pungs",
      family: "handPattern",
      subsumes: []
    },
    {
      id: "halfFlush",
      characters: "\u6DF7\u4E00\u8272",
      jyutping: "wan6 jat1 sik1",
      label: "Half Flush",
      family: "handPattern",
      subsumes: []
    },
    {
      id: "fullFlush",
      characters: "\u6E05\u4E00\u8272",
      jyutping: "cing1 jat1 sik1",
      label: "Full Flush",
      aka: ["Pure Hand"],
      family: "handPattern",
      subsumes: ["halfFlush"],
      note: "A full flush holds no honours so it is not literally a half flush, but a detector written as 'one suit plus honours' fires on both. Subsumed for safety."
    },
    {
      id: "mixedTerminals",
      characters: "\u6DF7\u4E48\u4E5D",
      jyutping: "wan6 jiu1 gau2",
      label: "Mixed Terminals",
      aka: ["Mixed Orphans"],
      family: "handPattern",
      subsumes: [],
      note: "Does NOT subsume allPungs even though it implies it \u2014 every surveyed system prices \u6DF7\u4E48\u4E5D at 1 as a bonus stacked on \u5C0D\u5C0D\u7CCA's 3."
    },
    {
      id: "sevenPairs",
      characters: "\u4E03\u5C0D\u5B50",
      jyutping: "cat1 deoi3 zi2",
      label: "Seven Pairs",
      aka: ["Seven Sisters"],
      family: "handPattern",
      concealedOnly: true,
      houseRule: true,
      subsumes: ["concealedHand"],
      note: "NOT classic HK Old Style \u2014 it arrives from other rule families. Present only because the LIU preset the Python engine implements scores it at 4. hkos-standard leaves it out."
    },
    {
      id: "smallThreeDragons",
      characters: "\u5C0F\u4E09\u5143",
      jyutping: "siu2 saam1 jyun4",
      label: "Small Three Dragons",
      family: "handPattern",
      subsumes: ["dragonPung"],
      note: "Two dragon pungs plus a pair of the third. Its value already includes the two pungs \u2014 hk-scoring.ts states this outright \u2014 so every loose dragonPung award is dropped."
    },
    {
      id: "bigThreeDragons",
      characters: "\u5927\u4E09\u5143",
      jyutping: "daai6 saam1 jyun4",
      label: "Big Three Dragons",
      aka: ["Three Great Scholars"],
      family: "handPattern",
      subsumes: ["smallThreeDragons", "dragonPung"]
    },
    {
      id: "smallFourWinds",
      characters: "\u5C0F\u56DB\u559C",
      jyutping: "siu2 sei3 hei2",
      label: "Small Four Winds",
      family: "handPattern",
      // Owner ruling 2026-08-26: wind faan never stack on a Four Winds hand.
      subsumes: ["seatWind", "roundWind"],
      note: "Does NOT swallow \u9580\u98A8/\u5708\u98A8, unlike the way \u5C0F\u4E09\u5143 swallows its dragon pungs. Those are POSITIONAL faan \u2014 they depend on who you are and which round it is, not on the shape \u2014 whereas a dragon pung's faan is the shape itself. Ruling taken from engine/test/golden/honours.ts, which fixes it for the whole suite; every four-winds hand caps at 13 either way."
    },
    {
      id: "bigFourWinds",
      characters: "\u5927\u56DB\u559C",
      jyutping: "daai6 sei3 hei2",
      label: "Big Four Winds",
      family: "handPattern",
      subsumes: ["smallFourWinds", "seatWind", "roundWind"]
    },
    /* ── limit hands 爆棚 ─────────────────────────────────────────────────── */
    {
      id: "fourConcealedPungs",
      characters: "\u56DB\u6697\u523B",
      jyutping: "sei3 am3 hak1",
      label: "Four Concealed Pungs",
      aka: ["Hidden Treasure", "\u574E\u574E\u7CCA"],
      family: "limitHand",
      concealedOnly: true,
      subsumes: ["allPungs", "concealedHand"],
      note: "Classic form wins by self-draw. Winning on a discard requires all four pungs already complete, the discard finishing only the pair \u2014 houses conflict; the detector, not this catalogue, has to pick."
    },
    {
      id: "allHonours",
      characters: "\u5B57\u4E00\u8272",
      jyutping: "zi6 jat1 sik1",
      label: "All Honours",
      family: "limitHand",
      // Owner ruling 2026-08-26: an all-honours hand is all pungs by definition,
      // so 對對糊 is inside the pattern, not on top of it.
      subsumes: ["halfFlush", "mixedTerminals", "allPungs"],
      note: "Honours cannot run, so the hand is all pungs by construction \u2014 but \u5C0D\u5C0D\u7CCA is still paid on top, because \u5B57\u4E00\u8272 is a pattern about the CLASS of tile and takes no credit for the shape (the golden fixtures award both). It names no particular honour set either, so the dragon and wind faan survive too. Contrast \u5341\u516B\u7F85\u6F22, which IS the four-pung shape and does swallow it. The flush and \u6DF7\u4E48\u4E5D entries are detector safety: an honours-only hand satisfies both definitions read loosely, and neither is meant to fire."
    },
    {
      id: "allTerminals",
      characters: "\u4E48\u4E5D",
      jyutping: "jiu1 gau2",
      label: "All Terminals",
      family: "limitHand",
      // Owner ruling 2026-08-26: same logic as 字一色 — the shape implies all pungs.
      subsumes: ["mixedTerminals", "allPungs"],
      note: "Pungs of 1s and 9s only \u2014 no honours, so no honour-meld faan can arise, and \u6DF7\u4E48\u4E5D (which needs an honour) cannot legitimately fire; it is listed as detector safety. \u5C0D\u5C0D\u7CCA is paid on top, same reasoning as \u5B57\u4E00\u8272."
    },
    {
      id: "nineGates",
      characters: "\u4E5D\u84EE\u5BF6\u71C8",
      jyutping: "gau2 lin4 bou2 dang1",
      label: "Nine Gates",
      aka: ["\u4E5D\u5B50\u9023\u74B0"],
      family: "limitHand",
      concealedOnly: true,
      subsumes: ["fullFlush"],
      note: "The hand is one suit by definition, so it swallows \u6E05\u4E00\u8272. That pairs with pricing it as a flat limit hand: Wikipedia alone splits it 4 + the flush's 6 for 10 effective, and under that reading the flush would be additive instead. See presets.ts for which reading each table takes."
    },
    {
      id: "thirteenOrphans",
      characters: "\u5341\u4E09\u4E48",
      jyutping: "sap6 saam1 jiu1",
      label: "Thirteen Orphans",
      family: "limitHand",
      concealedOnly: true,
      subsumes: [],
      note: "Not \u6DF7\u4E48\u4E5D: that pattern wants pungs of terminals and honours, and this hand has none. \u9580\u524D\u6E05 is left additive \u2014 hk-scoring.ts says a hand concealed by definition should not also collect it, but the golden fixtures pay it and the limit absorbs the difference. Flagged, not silently resolved."
    },
    {
      id: "allKongs",
      characters: "\u5341\u516B\u7F85\u6F22",
      jyutping: "sap6 baat3 lo4 hon3",
      label: "All Kongs",
      aka: ["Four Kongs"],
      family: "limitHand",
      subsumes: ["allPungs"],
      note: "Four kongs plus a pair \u2014 18 tiles on the table, four sets in the shape. It IS the \u5C0D\u5C0D\u7CCA shape, so it swallows it (engine/test/golden/kongs.ts fixes this). Does NOT swallow \u56DB\u6697\u523B: houses split on whether concealed kongs count toward it, and the golden suite records a hand awarding both."
    },
    {
      id: "jadeDragon",
      characters: "\u7DA0\u4E00\u8272",
      jyutping: "luk6 jat1 sik1",
      label: "Jade Dragon",
      aka: ["All Green"],
      family: "limitHand",
      subsumes: ["halfFlush", "allPungs", "dragonPung"],
      note: "Bamboo pungs or kongs plus the green dragon pung \u2014 the suit and the dragon are both named in the definition, so both are inside the value. Some houses also play a small version worth a few faan; not modelled."
    },
    {
      id: "rubyDragon",
      characters: "\u7D05\u4E00\u8272",
      jyutping: "hung4 jat1 sik1",
      label: "Ruby Dragon",
      aka: ["All Red"],
      family: "limitHand",
      subsumes: ["halfFlush", "allPungs", "dragonPung"]
    },
    {
      id: "pearlDragon",
      characters: "\u767D\u4E00\u8272",
      jyutping: "baak6 jat1 sik1",
      label: "Pearl Dragon",
      aka: ["All White"],
      family: "limitHand",
      subsumes: ["halfFlush", "allPungs", "dragonPung"]
    },
    {
      id: "heavenlyHand",
      characters: "\u5929\u7CCA",
      jyutping: "tin1 wu4",
      label: "Heavenly Hand",
      family: "limitHand",
      concealedOnly: true,
      subsumes: [],
      note: "The dealer's dealt hand is already complete. Nothing is subsumed: at the limit \u81EA\u6478 and \u9580\u524D\u6E05 cost nothing to add, and the golden fixtures pay both."
    },
    {
      id: "earthlyHand",
      characters: "\u5730\u7CCA",
      jyutping: "dei6 wu4",
      label: "Earthly Hand",
      family: "limitHand",
      concealedOnly: true,
      subsumes: [],
      note: "A non-dealer wins on the dealer's very first discard \u2014 a discard, so never a self-draw. \u9580\u524D\u6E05 left additive, as for \u5929\u7CCA."
    }
  ];
  var PATTERN_IDS = PATTERNS.map((p) => p.id);
  var BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));
  function pattern(id) {
    const found = BY_ID.get(id);
    if (!found) throw new Error(`unknown pattern id "${id}"`);
    return found;
  }
  function subsumptionClosure(id) {
    const out = /* @__PURE__ */ new Set();
    const queue = [...pattern(id).subsumes];
    while (queue.length > 0) {
      const next = queue.pop();
      if (out.has(next)) continue;
      out.add(next);
      queue.push(...pattern(next).subsumes);
    }
    return out;
  }
  function applySubsumption(ids, enabled) {
    const present = [...ids];
    const active = new Set(present.filter((id) => !enabled || enabled.has(id)));
    const eaten = /* @__PURE__ */ new Set();
    for (const id of active) for (const s of subsumptionClosure(id)) eaten.add(s);
    return present.filter((id) => !eaten.has(id));
  }

  // rulesets/src/payment.ts
  var HKOS_BASE_CHIPS = [1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384];
  var DISCARD_MULTIPLE = 2;
  var LIU_BRACKETS = [
    { maxFaan: 2, onDiscard: 0, selfDrawFigure: 0 },
    { maxFaan: 3, onDiscard: 92, selfDrawFigure: 108 },
    { maxFaan: 6, onDiscard: 124, selfDrawFigure: 156 },
    { maxFaan: 9, onDiscard: 188, selfDrawFigure: 252 },
    { maxFaan: 13, onDiscard: 316, selfDrawFigure: 444 }
  ];
  var clamp = (faan, [lo, hi]) => faan < lo ? lo : faan > hi ? hi : faan;
  var splitThreeWays = (figure) => Math.ceil(figure / 3);
  var HKOS_DOUBLING = {
    id: "hkos-doubling",
    label: "HK Old Style doubling ladder",
    source: "mahjong.wikidot.com HKOS scoring table, faan 0-13",
    domain: [0, 13],
    onDiscard: (faan) => DISCARD_MULTIPLE * HKOS_BASE_CHIPS[clamp(Math.trunc(faan), [0, 13])],
    // The published column IS the per-player 自摸 figure, which is why
    // hkos-standard pairs this schedule with the perPlayer settlement.
    selfDrawFigure: (faan) => HKOS_BASE_CHIPS[clamp(Math.trunc(faan), [0, 13])]
  };
  var bracketFor = (faan) => {
    const capped = clamp(Math.trunc(faan), [0, 13]);
    for (const row of LIU_BRACKETS) if (capped <= row.maxFaan) return row;
    return LIU_BRACKETS[LIU_BRACKETS.length - 1];
  };
  var LIU_BRACKET_SCHEDULE = {
    id: "liu-brackets",
    label: "LIU flat bracket table",
    source: "mjrc-admin/research/probability/core/ruleset.py LIU_FAN_BRACKETS",
    domain: [3, 13],
    onDiscard: (faan) => bracketFor(faan).onDiscard,
    selfDrawFigure: (faan) => bracketFor(faan).selfDrawFigure
  };
  var TVB_LINEAR = {
    id: "tvb-linear",
    label: "TVB Championship linear",
    source: "mjrc-app rulesets.ts tvb_2026 / tvb-championship-2026 Appendix I",
    domain: [1, 10],
    onDiscard: (faan) => 10 * clamp(Math.trunc(faan), [1, 10]),
    selfDrawFigure: (faan) => 5 * clamp(Math.trunc(faan), [1, 10])
  };
  var TVB_LINEAR_PER_PLAYER = paymentTable(TVB_LINEAR, "perPlayer");
  var HK_LIABILITY = [
    "Feeding the third dragon to a hand already showing two dragon pungs (\u5927\u4E09\u5143\u5305).",
    "Feeding the fourth wind to a hand already showing three wind pungs (\u5927\u56DB\u559C\u5305).",
    "Discarding into a hand whose exposed melds are already all one suit (\u6E05\u4E00\u8272\u5305)."
  ];
  var LIU_LIABILITY = [
    "9-tile and 12-tile \u5305 penalties, per the family house rules."
  ];
  function paymentTable(schedule, selfDraw, liabilityRules) {
    return {
      id: `${schedule.id}-${selfDraw}`,
      selfDraw,
      onDiscard: (faan) => schedule.onDiscard(faan),
      onSelfDraw: (faan) => selfDraw === "perPlayer" ? schedule.selfDrawFigure(faan) : splitThreeWays(schedule.selfDrawFigure(faan)),
      ...liabilityRules ? { liabilityRules: [...liabilityRules] } : {}
    };
  }
  var HKOS_DOUBLING_PER_PLAYER = paymentTable(HKOS_DOUBLING, "perPlayer", HK_LIABILITY);
  var HKOS_DOUBLING_TOTAL = paymentTable(HKOS_DOUBLING, "total", HK_LIABILITY);
  var LIU_BRACKET_TOTAL = paymentTable(LIU_BRACKET_SCHEDULE, "total", LIU_LIABILITY);
  var LIU_BRACKET_PER_PLAYER = paymentTable(LIU_BRACKET_SCHEDULE, "perPlayer", LIU_LIABILITY);

  // rulesets/src/presets.ts
  var HKOS_STANDARD = {
    id: "hkos-standard",
    label: "\u9999\u6E2F\u820A\u7AE0 Hong Kong Old Style",
    minimumFaan: 3,
    limitFaan: 13,
    useFlowers: true,
    payment: HKOS_DOUBLING_PER_PLAYER,
    faanTable: {
      // honour melds — a kong of the same honour is worth what the pung is worth
      dragonPung: 1,
      seatWind: 1,
      roundWind: 1,
      // bonus tiles 花
      ownFlower: 1,
      ownSeason: 1,
      allFlowers: 2,
      allSeasons: 2,
      noFlowers: 1,
      // winning conditions
      selfDraw: 1,
      concealedHand: 1,
      winOnLastTile: 1,
      winOnLastDiscard: 1,
      robbingKong: 1,
      winOnKongReplacement: 1,
      winByDoubleKong: 8,
      // hand patterns
      allChows: 1,
      allPungs: 3,
      halfFlush: 3,
      fullFlush: 6,
      mixedTerminals: 1,
      smallThreeDragons: 5,
      bigThreeDragons: 8,
      smallFourWinds: 6,
      bigFourWinds: 10,
      // limit hands 爆棚
      // The one departure from the column, which renders this 10. Four of the six
      // surveyed systems star 四暗刻 as a limit hand rather than pricing it, and
      // the golden suite fixes it at the limit (engine/test/golden/kongs.ts calls
      // its two cases uncontested at 13, where a 10 would land on 11 and 12).
      // 十八羅漢 below stays at 10: that one the systems genuinely split on,
      // 7 · 7 · 10 · limit, so the column's answer stands.
      fourConcealedPungs: 13,
      allHonours: 10,
      // 7 is the column's own value and it is an OUTLIER — four of the six systems
      // star 清么九 as a limit hand. Kept because the golden flush family pins it
      // at 7 (its two cases total 8) while the limit family declares 10, and the
      // suite cannot be satisfied both ways. Open question, not a decision.
      allTerminals: 7,
      // Second named departure. The column prices 九蓮寶燈 4 and adds 清一色's 6
      // on top for 10 effective; the other four systems pay a flat limit, and the
      // golden limit family needs 13 (a 4 would land its cases on 6 and 8).
      // patterns.ts subsumes 清一色 to match the flat reading.
      nineGates: 13,
      thirteenOrphans: 13,
      allKongs: 10,
      heavenlyHand: 13,
      earthlyHand: 13
      // Absent on purpose:
      //   sevenPairs 七對子 — not classic HK Old Style, and the column has no
      //     value for it. mjrc-standard DOES play it (owner ruling 2026-08-31);
      //     that is a house addition made there, not a correction made here.
      //   jadeDragon / rubyDragon / pearlDragon — the column reads "—". MJ Time
      //     and MJB pay them as limit hands, so a house that plays them should
      //     add them rather than have a value invented here.
    }
  };
  var LIU = {
    id: "liu",
    label: "LIU \u5BB6\u6CD5 house variant",
    minimumFaan: 3,
    limitFaan: 13,
    useFlowers: true,
    payment: LIU_BRACKET_TOTAL,
    faanTable: {
      dragonPung: 1,
      seatWind: 1,
      roundWind: 1,
      ownFlower: 1,
      ownSeason: 1,
      allFlowers: 2,
      allSeasons: 2,
      noFlowers: 1,
      selfDraw: 1,
      concealedHand: 1,
      winOnLastTile: 1,
      winOnLastDiscard: 1,
      robbingKong: 1,
      winOnKongReplacement: 1,
      allChows: 1,
      allPungs: 3,
      halfFlush: 3,
      fullFlush: 7,
      mixedTerminals: 1,
      sevenPairs: 4,
      smallThreeDragons: 4,
      bigThreeDragons: 6,
      smallFourWinds: 10,
      bigFourWinds: 13,
      fourConcealedPungs: 13,
      allHonours: 13,
      allTerminals: 13,
      nineGates: 13,
      thirteenOrphans: 13,
      allKongs: 7,
      heavenlyHand: 13,
      earthlyHand: 13
      // Absent because the LIU column reads "—": winByDoubleKong 槓上槓 and the
      // three suit-dragon hands.
    }
  };
  var MJRC_STANDARD = {
    ...HKOS_STANDARD,
    id: "mjrc-standard",
    label: "MJRC \u6A19\u6E96 (3-10 faan)",
    limitFaan: 10,
    // Inherited values above the cap are clamped IN THE TABLE, not just at
    // scoring time: under a 10-cap house, "十三么 pays 10" is the price itself.
    // Scoring output is identical either way (any single award at the cap
    // saturates alone); what changes is that the table now tells the truth and
    // the bots' route pricing stops valuing limit hands above what they pay.
    faanTable: {
      ...Object.fromEntries(
        Object.entries(HKOS_STANDARD.faanTable).map(([id, faan]) => [id, Math.min(faan, 10)])
      ),
      /**
       * 清一色 — **7, ratified by the owner 2026-08-31.**
       *
       * The inherited 6 is a transcription error, not a house choice:
       * RULESET-STANDARDIZATION-PROPOSAL.md §10 checked the column labelled
       * "Wikipedia" in hk-scoring.ts against Wikipedia and found five of thirteen
       * values wrong, this among them. The published value is 7, and LIU prices it
       * at 7 as well (see FAAN_LIU in engine/test/golden/limit.ts).
       *
       * The correction lives HERE rather than in HKOS_STANDARD deliberately.
       * hkos-standard's job is to be a faithful reading of that one column, warts
       * included, and the golden suite mirrors it — so it keeps the 6 until the
       * source table is fixed by the team that owns it. mjrc-standard is the house
       * ruleset and is allowed its own prices, provided they are decisions. This
       * one is.
       *
       * Note for whoever retrains next: the shipped ladder was evolved against a
       * 6, so flush routes are now priced slightly under what they pay. Expected
       * to be small; measure it rather than assume it.
       */
      fullFlush: 7,
      /**
       * 么九 — **10, ratified by the owner 2026-08-31**, alongside 清一色.
       *
       * The same transcription error as the flush, from the same audit: the column
       * labelled "Wikipedia" in hk-scoring.ts carries 7 where Wikipedia prices it a
       * LIMIT hand at 10. Under this house's 10-cap that makes 么九 a limit hand,
       * which is what it is — every set built from terminals only, no honours to
       * fall back on.
       *
       * Kept out of HKOS_STANDARD for the same reason as the flush: that preset's
       * job is a faithful reading of one column, and the golden suite mirrors it.
       *
       * Behaviourally this is close to inert — 么九 did not occur once in a 500-hand
       * sample. It is corrected because leaving it would mean mjrc-standard still
       * carried an unratified slip, not because it changes play.
       */
      allTerminals: 10,
      /**
       * 七對子 — **4, owner ruling 2026-08-31: "enough people I know do play with
       * it."**
       *
       * Absent from the Wikipedia column, so `hkos-standard` does not play it and
       * this is a house ADDITION rather than a correction — the first departure
       * here that is not fixing a transcription slip.
       *
       * 4 is LIU's price, the only value this codebase has ever validated (it is
       * cross-checked against scoring.py and asserted by the golden fixtures).
       * HKOS sources more often say 5; the owner ruled 5 too high.
       *
       * This one needed an ENGINE change, not just a row. Seven pairs is a shape
       * that never reads as four sets and a pair, so decompose/ready/scoring each
       * needed a branch — before that, LIU had priced the pattern for as long as
       * it existed and could never award it.
       */
      sevenPairs: 4
    }
  };
  var TVB_2026 = {
    ...HKOS_STANDARD,
    id: "tvb-2026",
    label: "TVB Championship 2026",
    minimumFaan: 1,
    limitFaan: 10,
    useFlowers: false,
    payment: TVB_LINEAR_PER_PLAYER,
    // No flowers on the show's table, so no bonus-tile patterns either —
    // 無花 would be trivially always-on and 正花 unreachable.
    faanTable: Object.fromEntries(
      Object.entries(HKOS_STANDARD.faanTable).filter(([id]) => pattern(id).family !== "bonusTile").map(([id, faan]) => [id, Math.min(faan, 10)])
    )
  };
  var RULESETS = [HKOS_STANDARD, MJRC_STANDARD, TVB_2026, LIU];
  var DEFAULT_RULESET_ID = HKOS_STANDARD.id;
  var ruleset = (id) => RULESETS.find((r) => r.id === id);

  // engine/src/scoring.ts
  var SEASONS_START = FLOWERS_START + 4;
  var FLOWER_SET = [FLOWERS_START, FLOWERS_START + 1, FLOWERS_START + 2, FLOWERS_START + 3];
  var SEASON_SET = [SEASONS_START, SEASONS_START + 1, SEASONS_START + 2, SEASONS_START + 3];
  var isTripletSet = (s) => s.kind === "pung" || s.kind === "kong";
  var readingTiles = (d) => [
    ...d.pair.tiles,
    ...d.sets.flatMap((s) => s.tiles)
  ];
  function readingPatterns(d, ctx) {
    const ids = [];
    const tiles = readingTiles(d);
    const triplets = d.sets.filter(isTripletSet);
    const chows = d.sets.filter((s) => s.kind === "chow");
    const suits = new Set(tiles.filter(isSuited).map(suitOf));
    const anyHonour = tiles.some(isHonour);
    const pairTile = d.pair.tiles[0];
    for (const s of triplets) {
      const t = s.tiles[0];
      if (isDragon(t)) ids.push("dragonPung");
      else if (isWind(t)) {
        const wind = t - WINDS_START;
        if (wind === ctx.seatWind) ids.push("seatWind");
        if (wind === ctx.roundWind) ids.push("roundWind");
      }
    }
    const dragonSets = triplets.filter((s) => isDragon(s.tiles[0])).length;
    if (dragonSets === 3) ids.push("bigThreeDragons");
    else if (dragonSets === 2 && isDragon(pairTile)) ids.push("smallThreeDragons");
    const windSets = triplets.filter((s) => isWind(s.tiles[0])).length;
    if (windSets === 4) ids.push("bigFourWinds");
    else if (windSets === 3 && isWind(pairTile)) ids.push("smallFourWinds");
    if (chows.length === 4) ids.push("allChows");
    if (triplets.length === 4) ids.push("allPungs");
    if (d.sets.length === 4 && d.sets.every((s) => s.kind === "kong")) ids.push("allKongs");
    if (concealedTripletCount(d, !ctx.selfDraw) === 4) ids.push("fourConcealedPungs");
    if (suits.size === 0) ids.push("allHonours");
    else if (suits.size === 1) ids.push(anyHonour ? "halfFlush" : "fullFlush");
    if (triplets.length === 4 && tiles.every(isTerminalOrHonour) && suits.size > 0) {
      ids.push(anyHonour ? "mixedTerminals" : "allTerminals");
    }
    return ids;
  }
  function pairsTilePatterns(tiles) {
    const out = [];
    const suits = new Set(tiles.filter(isSuited).map(suitOf));
    const anyHonour = tiles.some(isHonour);
    if (suits.size === 0) out.push("allHonours");
    else if (suits.size === 1) out.push(anyHonour ? "halfFlush" : "fullFlush");
    if (tiles.every(isTerminalOrHonour)) out.push(anyHonour ? "mixedTerminals" : "allTerminals");
    return out;
  }
  var isThirteenOrphans = isThirteenOrphansShape;
  var isSevenPairs = isSevenPairsShape;
  function isNineGates(concealed, melds, winningTile) {
    if (melds.length > 0 || concealed.length !== 13) return false;
    const tiles = [...concealed, winningTile];
    if (!tiles.every(isSuited)) return false;
    if (new Set(tiles.map(suitOf)).size !== 1) return false;
    const base = Math.floor(tiles[0] / 9) * 9;
    const c = counts(tiles);
    if (c[base] < 3 || c[base + 8] < 3) return false;
    for (let r = 1; r <= 7; r++) if (c[base + r] < 1) return false;
    return true;
  }
  function situationalPatterns(ctx, melds) {
    const ids = [];
    if (ctx.selfDraw) ids.push("selfDraw");
    if (melds.every(isConcealedSet)) ids.push("concealedHand");
    if (ctx.robbedKong) ids.push("robbingKong");
    if (ctx.doubleKong) ids.push("winByDoubleKong");
    else if (ctx.onKongReplacement) ids.push("winOnKongReplacement");
    if (ctx.onLastTile) ids.push("winOnLastTile");
    else if (ctx.onLastDiscard) ids.push("winOnLastDiscard");
    if (ctx.heavenly && ctx.isDealer) ids.push("heavenlyHand");
    if (ctx.earthly && !ctx.isDealer && !ctx.selfDraw) ids.push("earthlyHand");
    return ids;
  }
  function bonusPatterns(flowers, ctx, ruleset2) {
    if (!ruleset2.useFlowers) return [];
    const ids = [];
    if (flowers.length === 0) return ["noFlowers"];
    for (const f of flowers) {
      if (flowerSeat(f) !== ctx.seatWind) continue;
      ids.push(f < SEASONS_START ? "ownFlower" : "ownSeason");
    }
    if (FLOWER_SET.every((f) => flowers.includes(f))) ids.push("allFlowers");
    if (SEASON_SET.every((f) => flowers.includes(f))) ids.push("allSeasons");
    return ids;
  }
  function price(ids, ruleset2) {
    const enabled = new Set(Object.keys(ruleset2.faanTable));
    const concealedByDefinition = ids.some((id) => enabled.has(id) && pattern(id).concealedOnly === true);
    const kept = concealedByDefinition ? ids.filter((id) => id !== "concealedHand") : [...ids];
    const awards = [];
    let rawFaan = 0;
    for (const id of applySubsumption(kept, enabled)) {
      const faan = ruleset2.faanTable[id];
      if (faan === void 0) continue;
      const subsumes = pattern(id).subsumes;
      awards.push(subsumes.length > 0 ? { id, faan, subsumes: [...subsumes] } : { id, faan });
      rawFaan += faan;
    }
    return { awards, rawFaan };
  }
  var settle = (p, ruleset2) => {
    const faan = Math.min(p.rawFaan, ruleset2.limitFaan);
    return {
      faan,
      rawFaan: p.rawFaan,
      capped: p.rawFaan > ruleset2.limitFaan,
      awards: p.awards,
      legal: faan >= ruleset2.minimumFaan
    };
  };
  function score(concealed, melds, flowers, winningTile, ctx, ruleset2) {
    const shared = [
      ...situationalPatterns(ctx, melds),
      ...bonusPatterns(flowers, ctx, ruleset2)
    ];
    if (isThirteenOrphans(concealed, melds, winningTile)) {
      return settle(price(["thirteenOrphans", ...shared], ruleset2), ruleset2);
    }
    const special = isNineGates(concealed, melds, winningTile) ? ["nineGates"] : [];
    const readings = decomposeWin(concealed, melds, winningTile);
    const sevenPairsReading = ruleset2.faanTable.sevenPairs !== void 0 && isSevenPairs(concealed, melds, winningTile) ? settle(price([
      "sevenPairs",
      ...pairsTilePatterns([...concealed, winningTile]),
      ...shared
    ], ruleset2), ruleset2) : null;
    if (readings.length === 0) {
      return sevenPairsReading ?? { faan: 0, rawFaan: 0, capped: false, awards: [], legal: false };
    }
    let bestResult = null;
    let bestKey = "";
    for (const d of readings) {
      const result = settle(price([...readingPatterns(d, ctx), ...special, ...shared], ruleset2), ruleset2);
      const key = decompositionKey(d);
      if (bestResult === null || result.faan > bestResult.faan || result.faan === bestResult.faan && result.rawFaan > bestResult.rawFaan || result.faan === bestResult.faan && result.rawFaan === bestResult.rawFaan && key < bestKey) {
        bestResult = result;
        bestKey = key;
      }
    }
    if (sevenPairsReading && sevenPairsReading.faan > bestResult.faan) return sevenPairsReading;
    return bestResult;
  }

  // protocol/src/events.ts
  var EVENT_SCHEMA_VERSION = 1;

  // engine/src/reducer.ts
  var ENGINE_VERSION = "mjrc-engine/1.0.0";
  var TICK_MS = 1;
  var CLAIM_WINDOW_MS = 3e3;
  var roundsOf = (m) => m === "oneWindRound" ? 1 : m === "fourWindRounds" ? 4 : m;
  var asc = (a, b) => a - b;
  var nextSeat = (s) => (s + 1) % 4;
  var isSeat2 = (s) => Number.isInteger(s) && s >= 0 && s <= 3;
  function four(f) {
    return [f(0), f(1), f(2), f(3)];
  }
  function clockwiseFrom(from) {
    return [1, 2, 3].map((n) => (from + n) % 4);
  }
  var handSeedFor = (matchSeed, handIndex) => Math.imul(matchSeed ^ handIndex + 1, 2654435761) >>> 0;
  function removeOne(hand, tile) {
    const i = hand.indexOf(tile);
    if (i < 0) throw new Error(`tile ${tile} is not in hand`);
    hand.splice(i, 1);
  }
  function insertSorted(hand, tile) {
    let i = 0;
    while (i < hand.length && hand[i] <= tile) i++;
    hand.splice(i, 0, tile);
  }
  var cloneSeat = (s) => ({
    seat: s.seat,
    wind: s.wind,
    hand: s.hand.slice(),
    drawn: s.drawn,
    melds: s.melds.slice(),
    flowers: s.flowers.slice(),
    discards: s.discards.slice(),
    chips: s.chips,
    connected: s.connected
  });
  var cloneOffer = (o) => ({
    seat: o.seat,
    options: o.options.map((x) => ({ kind: x.kind, ...x.with ? { with: x.with.slice() } : {} })),
    answer: o.answer === null ? null : o.answer.kind === "pass" ? { kind: "pass" } : { kind: "claim", option: { kind: o.answer.option.kind, ...o.answer.option.with ? { with: o.answer.option.with.slice() } : {} } }
  });
  function cloneState(s) {
    return {
      ...s,
      seats: [cloneSeat(s.seats[0]), cloneSeat(s.seats[1]), cloneSeat(s.seats[2]), cloneSeat(s.seats[3])],
      wall: s.wall,
      startingChips: [...s.startingChips],
      lastDiscard: s.lastDiscard === null ? null : { ...s.lastDiscard },
      refusedSelfDraw: s.refusedSelfDraw === null ? null : { ...s.refusedSelfDraw },
      claim: s.claim === null ? null : { ...s.claim, offers: s.claim.offers.map(cloneOffer) },
      result: s.result === null ? null : { ...s.result, chipDeltas: [...s.result.chipDeltas] }
    };
  }
  function emit(d, actor, type, payload) {
    d.s.ts += TICK_MS;
    d.events.push({
      v: EVENT_SCHEMA_VERSION,
      matchId: d.s.matchId,
      handIndex: d.s.handIndex,
      seq: d.s.seq++,
      ts: d.s.ts,
      actor,
      type,
      payload
    });
  }
  function resolveRuleset(id) {
    const r = ruleset(id) ?? ruleset(DEFAULT_RULESET_ID);
    if (!r) throw new Error(`no ruleset "${id}" and no default ruleset`);
    return r;
  }
  var liveTilesLeft = (s) => s.wallEnd - s.wallIndex;
  function takeHead(s) {
    if (s.wallIndex >= s.wallEnd) return null;
    return s.wall[s.wallIndex++];
  }
  function takeTail(s) {
    if (s.wallIndex >= s.wallEnd) return null;
    return s.wall[--s.wallEnd];
  }
  function replaceHandFlowers(d, seat) {
    const st = d.s.seats[seat];
    for (; ; ) {
      let at = -1;
      for (let i = 0; i < st.hand.length; i++) {
        if (isFlower(st.hand[i])) {
          at = i;
          break;
        }
      }
      if (at < 0) return true;
      const flower = st.hand[at];
      const replacement = takeTail(d.s);
      if (replacement === null) return false;
      st.hand.splice(at, 1);
      st.flowers.push(flower);
      insertSorted(st.hand, replacement);
      emit(d, "server", "flowerReplacement", {
        seat,
        flower,
        replacement,
        wallIndex: d.s.wallIndex,
        wallRemaining: liveTilesLeft(d.s)
      });
    }
  }
  function replaceDrawnFlowers(d, seat) {
    const st = d.s.seats[seat];
    while (st.drawn !== null && isFlower(st.drawn)) {
      const flower = st.drawn;
      const replacement = takeTail(d.s);
      if (replacement === null) {
        st.drawn = null;
        return false;
      }
      st.flowers.push(flower);
      st.drawn = replacement;
      d.s.refusedSelfDraw = null;
      emit(d, "server", "flowerReplacement", {
        seat,
        flower,
        replacement,
        wallIndex: d.s.wallIndex,
        wallRemaining: liveTilesLeft(d.s)
      });
    }
    return true;
  }
  function drawForTurn(d, seat) {
    const tile = takeHead(d.s);
    if (tile === null) return false;
    d.s.seats[seat].drawn = tile;
    d.s.onKongReplacement = false;
    d.s.refusedSelfDraw = null;
    emit(d, "server", "draw", {
      seat,
      tile,
      wallIndex: d.s.wallIndex,
      wallRemaining: liveTilesLeft(d.s)
    });
    return replaceDrawnFlowers(d, seat);
  }
  function drawKongReplacement(d, seat, kongKind) {
    const tile = takeTail(d.s);
    if (tile === null) return false;
    d.s.seats[seat].drawn = tile;
    d.s.onKongReplacement = true;
    d.s.refusedSelfDraw = null;
    emit(d, "server", "kongReplacement", {
      seat,
      tile,
      kongKind,
      wallIndex: d.s.wallIndex,
      wallRemaining: liveTilesLeft(d.s)
    });
    return replaceDrawnFlowers(d, seat);
  }
  var waitingCount = (st) => 13 - 3 * st.melds.length;
  var playsSevenPairs = (r) => r.faanTable.sevenPairs !== void 0;
  function shapeWins(st, tile, sevenPairs) {
    if (isFlower(tile)) return false;
    if (st.melds.length > 4) return false;
    if (st.hand.length !== waitingCount(st)) return false;
    return hasWinningShape(st.hand, st.melds, tile, sevenPairs);
  }
  function claimOptionsFor(st, tile, from, sevenPairs) {
    const out = [];
    if (shapeWins(st, tile, sevenPairs)) out.push({ kind: "win" });
    if (canExposedKong(st.hand, tile)) out.push({ kind: "kong" });
    if (canPung(st.hand, tile)) out.push({ kind: "pung" });
    for (const pair of chowOptions(st.hand, tile, st.seat, from)) out.push({ kind: "chow", with: pair });
    return out;
  }
  function openClaimWindow(d, tile, from, robKong) {
    const offers = [];
    for (const seat of clockwiseFrom(from)) {
      const st = d.s.seats[seat];
      const sevenPairs = playsSevenPairs(d.ruleset);
      const options = robKong ? shapeWins(st, tile, sevenPairs) ? [{ kind: "win" }] : [] : claimOptionsFor(st, tile, from, sevenPairs);
      if (options.length > 0) offers.push({ seat, options, answer: null });
    }
    if (offers.length === 0) return false;
    const deadlineTs = d.s.ts + CLAIM_WINDOW_MS;
    d.s.claim = { tile, from, robKong, deadlineTs, offers };
    d.s.phase = robKong ? "robKongWindow" : "claimWindow";
    if (robKong) {
      emit(d, "server", "robKongWindow", {
        seat: from,
        tile,
        offeredTo: offers.map((o) => o.seat),
        deadlineTs
      });
    } else {
      for (const o of offers) {
        emit(d, "server", "claimOffered", {
          seat: o.seat,
          tile,
          from,
          options: o.options.map((x) => ({ kind: x.kind, ...x.with ? { with: x.with.slice() } : {} })),
          deadlineTs
        });
      }
    }
    return true;
  }
  var priorityOf = (k) => CLAIM_PRIORITY.indexOf(k);
  function bestClaim(live) {
    let best = live[0];
    for (const o of live) {
      const a = o.answer;
      const b = best.answer;
      if (a === null || a.kind !== "claim" || b === null || b.kind !== "claim") continue;
      if (priorityOf(a.option.kind) < priorityOf(b.option.kind)) best = o;
    }
    return best;
  }
  function consumeDiscard(d, from, tile) {
    const pile = d.s.seats[from].discards;
    const i = pile.lastIndexOf(tile);
    if (i >= 0) pile.splice(i, 1);
    d.s.lastDiscard = null;
  }
  function winContext(s, seat, winningTile, selfDraw, from, extra) {
    return {
      seat,
      selfDraw,
      from,
      winningTile,
      roundWind: s.roundWind,
      seatWind: s.seats[seat].wind,
      isDealer: seat === s.dealer,
      ...extra.robbedKong ? { robbedKong: true } : {},
      ...extra.onKongReplacement ? { onKongReplacement: true } : {},
      ...extra.onLastTile ? { onLastTile: true } : {},
      wallEmpty: liveTilesLeft(s) === 0
    };
  }
  function previewWin(state2, seat, win) {
    const st = state2.seats[seat];
    const ctx = win.selfDraw ? winContext(state2, seat, win.tile, true, null, {
      onKongReplacement: state2.onKongReplacement,
      onLastTile: liveTilesLeft(state2) === 0
    }) : winContext(state2, seat, win.tile, false, win.from, {
      ...win.robbedKong ? { robbedKong: true } : {},
      onLastTile: false
    });
    return score(
      st.hand.slice(),
      st.melds.slice(),
      st.flowers.slice(),
      win.tile,
      ctx,
      resolveRuleset(state2.rulesetId)
    );
  }
  function scoreDeclaration(d, seat, ctx) {
    const st = d.s.seats[seat];
    return score(st.hand.slice(), st.melds.slice(), st.flowers.slice(), ctx.winningTile, ctx, d.ruleset);
  }
  function emitRefusedWin(d, seat, ctx, result) {
    const st = d.s.seats[seat];
    emit(d, seat, "refusedWin", {
      context: ctx,
      concealed: st.hand.slice(),
      melds: st.melds.slice(),
      flowers: st.flowers.slice(),
      score: result,
      minimumFaan: d.ruleset.minimumFaan,
      reason: "belowMinimum"
    });
  }
  function settle2(d, ctx, faan) {
    const t = d.ruleset.payment;
    const deltas = [0, 0, 0, 0];
    if (ctx.selfDraw) {
      const each = t.onSelfDraw(faan);
      for (let i = 0; i < 4; i = i + 1) {
        if (i === ctx.seat) continue;
        deltas[i] -= each;
        deltas[ctx.seat] += each;
      }
    } else {
      const amount = t.onDiscard(faan);
      const loser = ctx.from;
      deltas[loser] -= amount;
      deltas[ctx.seat] += amount;
    }
    return deltas;
  }
  function endHand(d, outcome, winner, loser, faan, result, chipDeltas) {
    const s = d.s;
    for (let i = 0; i < 4; i = i + 1) s.seats[i].chips += chipDeltas[i];
    const dealerRepeats = outcome === "exhaustiveDraw" || winner === s.dealer;
    const nextDealer = dealerRepeats ? s.dealer : nextSeat(s.dealer);
    const cycleComplete = !dealerRepeats && nextDealer === s.startingDealer;
    const nextRoundWind = cycleComplete ? (s.roundWind + 1) % 4 : s.roundWind;
    const roundsCompleted = s.roundsCompleted + (cycleComplete ? 1 : 0);
    const target = s.rounds;
    const matchOver = roundsCompleted >= target;
    s.claim = null;
    s.phase = "handEnd";
    s.handsPlayed += 1;
    s.dealerStreak = dealerRepeats ? s.dealerStreak + 1 : 0;
    s.roundsCompleted = roundsCompleted;
    s.matchOver = matchOver;
    s.result = {
      outcome,
      winner,
      loser,
      faan,
      score: result,
      chipDeltas,
      dealerRepeats,
      nextDealer,
      nextRoundWind,
      matchOver
    };
    emit(d, "server", "handEnd", {
      outcome,
      winner,
      loser,
      faan,
      chipDeltas: [...chipDeltas],
      standings: four((i) => s.seats[i].chips),
      dealerRepeats,
      nextDealer,
      nextRoundWind
    });
  }
  function takeWin(d, ctx, result) {
    const st = d.s.seats[ctx.seat];
    const payload = {
      context: ctx,
      concealed: st.hand.slice(),
      melds: st.melds.slice(),
      flowers: st.flowers.slice(),
      score: result
    };
    const deltas = settle2(d, ctx, result.faan);
    if (ctx.selfDraw) {
      emit(d, ctx.seat, "selfDraw", payload);
      endHand(d, "selfDraw", ctx.seat, null, result.faan, result, deltas);
    } else {
      emit(d, ctx.seat, "winOnDiscard", payload);
      endHand(d, "winOnDiscard", ctx.seat, ctx.from, result.faan, result, deltas);
    }
  }
  function exhaustiveDraw(d) {
    const s = d.s;
    for (let i = 0; i < 4; i = i + 1) {
      const st = s.seats[i];
      if (st.drawn !== null) {
        insertSorted(st.hand, st.drawn);
        st.drawn = null;
      }
    }
    emit(d, "server", "exhaustiveDraw", {
      wallRemaining: liveTilesLeft(s),
      hands: four((i) => s.seats[i].hand.slice()),
      distanceToReady: four(
        (i) => distanceToReady(counts(s.seats[i].hand), s.seats[i].melds.length)
      )
    });
    endHand(d, "exhaustiveDraw", null, null, null, null, [0, 0, 0, 0]);
  }
  function advanceTurn(d, from) {
    const seat = nextSeat(from);
    d.s.turn = seat;
    d.s.phase = "awaitDiscard";
    if (!drawForTurn(d, seat)) exhaustiveDraw(d);
  }
  function resolveWindow(d) {
    const w = d.s.claim;
    if (!w) throw new Error("no claim window to resolve");
    const passed = [];
    let live = [];
    for (const o of w.offers) {
      if (o.answer !== null && o.answer.kind === "claim") live.push(o);
      else passed.push(o.seat);
    }
    let winner = null;
    const refused = [];
    while (live.length > 0) {
      const best = bestClaim(live);
      const option2 = best.answer.option;
      if (option2.kind !== "win") {
        winner = { offer: best, option: option2 };
        break;
      }
      const ctx = winContext(d.s, best.seat, w.tile, false, w.from, {
        robbedKong: w.robKong,
        onLastTile: false
      });
      const result = scoreDeclaration(d, best.seat, ctx);
      if (result.legal) {
        winner = { offer: best, option: option2 };
        break;
      }
      emitRefusedWin(d, best.seat, ctx, result);
      refused.push(best.seat);
      live = live.filter((o) => o !== best);
    }
    for (const o of w.offers) {
      if (winner && o.seat === winner.offer.seat) continue;
      if (refused.includes(o.seat)) continue;
      emit(d, passed.includes(o.seat) ? o.seat : "server", "claimDeclined", {
        seat: o.seat,
        tile: w.tile,
        from: w.from,
        reason: passed.includes(o.seat) ? "pass" : "outranked"
      });
    }
    const { tile, from, robKong } = w;
    d.s.claim = null;
    if (!winner) {
      if (robKong) completeAddedKong(d, from);
      else advanceTurn(d, from);
      return;
    }
    const seat = winner.offer.seat;
    const option = winner.option;
    if (option.kind === "win") {
      if (robKong) revertAddedKong(d, from, tile);
      else consumeDiscard(d, from, tile);
      const ctx = winContext(d.s, seat, tile, false, from, {
        robbedKong: robKong,
        onLastTile: false
      });
      takeWin(d, ctx, scoreDeclaration(d, seat, ctx));
      return;
    }
    consumeDiscard(d, from, tile);
    const st = d.s.seats[seat];
    let meld;
    if (option.kind === "chow") {
      const withTiles = option.with ?? [];
      meld = makeChow([tile, ...withTiles], seat, from);
      for (const t of withTiles) removeOne(st.hand, t);
    } else if (option.kind === "pung") {
      meld = makePung(tile, seat, from);
      removeOne(st.hand, tile);
      removeOne(st.hand, tile);
    } else {
      meld = makeExposedKong(tile, seat, from);
      removeOne(st.hand, tile);
      removeOne(st.hand, tile);
      removeOne(st.hand, tile);
    }
    st.melds.push(meld);
    emit(d, seat, "claimed", { seat, kind: option.kind, tile, from, meld });
    d.s.turn = seat;
    d.s.phase = "awaitDiscard";
    st.drawn = null;
    d.s.onKongReplacement = false;
    if (option.kind === "kong") {
      if (!drawKongReplacement(d, seat, "exposed")) exhaustiveDraw(d);
    }
  }
  function completeAddedKong(d, seat) {
    d.s.turn = seat;
    d.s.phase = "awaitDiscard";
    if (!drawKongReplacement(d, seat, "added")) exhaustiveDraw(d);
  }
  function revertAddedKong(d, seat, tile) {
    const st = d.s.seats[seat];
    const i = st.melds.findIndex(
      (m) => m.kind === "kong" && m.addedToPung === true && m.tiles[0] === tile
    );
    if (i < 0) throw new Error(`no \u52A0\u69D3 of tile ${tile} to rob at seat ${seat}`);
    const kong = st.melds[i];
    st.melds = st.melds.slice();
    st.melds[i] = { kind: "pung", tiles: [tile, tile, tile], from: kong.from, concealed: false };
  }
  function dealHand(d) {
    const s = d.s;
    s.phase = "deal";
    s.handSeed = handSeedFor(s.matchSeed, s.handIndex);
    s.wall = buildWall(s.handSeed, d.ruleset.useFlowers);
    s.wallIndex = 0;
    s.wallEnd = s.wall.length;
    s.lastDiscard = null;
    s.claim = null;
    s.result = null;
    s.onKongReplacement = false;
    s.refusedSelfDraw = null;
    for (let i = 0; i < 4; i = i + 1) {
      const st = s.seats[i];
      st.hand = [];
      st.drawn = null;
      st.melds = [];
      st.flowers = [];
      st.discards = [];
      st.wind = (i - s.dealer + 4) % 4;
    }
    const order = [0, 1, 2, 3].map((n) => (s.dealer + n) % 4);
    for (let block = 0; block < 3; block++) {
      for (const seat of order) {
        for (let n = 0; n < 4; n++) s.seats[seat].hand.push(s.wall[s.wallIndex++]);
      }
    }
    for (const seat of order) s.seats[seat].hand.push(s.wall[s.wallIndex++]);
    for (const seat of order) s.seats[seat].hand.sort(asc);
    emit(d, "server", "deal", {
      seed: s.handSeed,
      dealer: s.dealer,
      roundWind: s.roundWind,
      seatWinds: four((i) => s.seats[i].wind),
      hands: four((i) => s.seats[i].hand.slice()),
      wallIndex: s.wallIndex,
      wallRemaining: liveTilesLeft(s)
    });
    s.phase = "flowerReplacement";
    for (const seat of order) {
      if (!replaceHandFlowers(d, seat)) {
        exhaustiveDraw(d);
        return;
      }
    }
    s.phase = "awaitDiscard";
    s.turn = s.dealer;
    if (!drawForTurn(d, s.dealer)) exhaustiveDraw(d);
  }
  function startMatch(config) {
    const dealer = config.dealer ?? 0;
    if (!isSeat2(dealer)) throw new Error(`dealer ${dealer} is not a seat`);
    const chips = config.startingChips ?? 0;
    const rulesetId = config.rulesetId ?? config.ruleset?.id ?? DEFAULT_RULESET_ID;
    if (!ruleset(rulesetId)) throw new Error(`unknown ruleset ${rulesetId} \u2014 register it in @mjrc/rulesets`);
    const state2 = {
      phase: "deal",
      seats: four((i) => ({
        seat: i,
        wind: (i - dealer + 4) % 4,
        hand: [],
        drawn: null,
        melds: [],
        flowers: [],
        discards: [],
        chips,
        connected: true
      })),
      roundWind: 0,
      dealer,
      turn: dealer,
      handIndex: 0,
      wall: [],
      wallIndex: 0,
      lastDiscard: null,
      rulesetId,
      engineVersion: ENGINE_VERSION,
      matchId: config.matchId,
      seq: 0,
      ts: config.startedAt ?? 0,
      matchSeed: config.seed >>> 0,
      handSeed: 0,
      wallEnd: WALL_SIZE,
      rounds: config.matchLength === void 0 ? 1 : roundsOf(config.matchLength),
      startingDealer: dealer,
      startingChips: four(() => chips),
      handsPlayed: 0,
      dealerStreak: 0,
      roundsCompleted: 0,
      claim: null,
      onKongReplacement: false,
      refusedSelfDraw: null,
      result: null,
      matchOver: false
    };
    const d = { s: state2, events: [], ruleset: resolveRuleset(rulesetId) };
    dealHand(d);
    return { state: d.s, events: d.events };
  }
  function startNextHand(state2) {
    if (state2.phase !== "handEnd") {
      throw new Error(`startNextHand needs phase "handEnd", got "${state2.phase}"`);
    }
    const d = {
      s: cloneState(state2),
      events: [],
      ruleset: resolveRuleset(state2.rulesetId)
    };
    const result = d.s.result;
    if (!result) throw new Error("hand ended with no result");
    if (result.matchOver) {
      d.s.phase = "matchEnd";
      const byStart = [0, 1, 2, 3].map(
        (n) => (d.s.startingDealer + n) % 4
      );
      const ranked = byStart.slice().sort((a, b) => d.s.seats[b].chips - d.s.seats[a].chips);
      const placements = [1, 1, 1, 1];
      ranked.forEach((seat, i) => {
        placements[seat] = i + 1;
      });
      emit(d, "server", "matchEnd", {
        reason: d.s.rounds === 1 ? "windRoundComplete" : "allRoundsComplete",
        standings: four((i) => d.s.seats[i].chips),
        placements,
        handsPlayed: d.s.handsPlayed
      });
      return { state: d.s, events: d.events };
    }
    d.s.dealer = result.nextDealer;
    d.s.roundWind = result.nextRoundWind;
    d.s.handIndex += 1;
    d.s.result = null;
    dealHand(d);
    return { state: d.s, events: d.events };
  }
  function legalActions(state2, seat) {
    const out = [];
    if (!isSeat2(seat)) return out;
    if (state2.phase === "claimWindow" || state2.phase === "robKongWindow") {
      const w = state2.claim;
      if (!w) return out;
      const offer = w.offers.find((o) => o.seat === seat);
      if (!offer || offer.answer !== null) return out;
      for (const option of offer.options) {
        out.push({
          type: "claim",
          seat,
          option: { kind: option.kind, ...option.with ? { with: option.with.slice() } : {} }
        });
      }
      out.push({ type: "pass", seat });
      return out;
    }
    if (state2.phase !== "awaitDiscard" || state2.turn !== seat) return out;
    const st = state2.seats[seat];
    const drawn = st.drawn;
    const alreadyRefused = state2.refusedSelfDraw !== null && state2.refusedSelfDraw.seat === seat && state2.refusedSelfDraw.tile === drawn;
    if (drawn !== null && !alreadyRefused && shapeWins(st, drawn, playsSevenPairs(resolveRuleset(state2.rulesetId)))) {
      out.push({ type: "declareWin", seat, selfDraw: true });
    }
    const all2 = drawn === null ? st.hand : [...st.hand, drawn];
    const seen = [];
    const distinct = [];
    for (const t of all2.slice().sort(asc)) {
      if (!seen[t]) {
        seen[t] = true;
        distinct.push(t);
      }
    }
    for (const tile of distinct) {
      if (canConcealedKong(all2, tile)) out.push({ type: "concealedKong", seat, tile });
    }
    for (const tile of distinct) {
      if (canAddedKong(all2, st.melds, tile)) out.push({ type: "addedKong", seat, tile });
    }
    for (const tile of distinct) out.push({ type: "discard", seat, tile });
    return out;
  }
  function requireTurn(state2, seat) {
    if (state2.phase !== "awaitDiscard") {
      throw new Error(`seat ${seat} acted in phase "${state2.phase}", expected "awaitDiscard"`);
    }
    if (state2.turn !== seat) throw new Error(`seat ${seat} acted out of turn (turn is ${state2.turn})`);
  }
  function absorbDrawn(st) {
    if (st.drawn === null) return;
    insertSorted(st.hand, st.drawn);
    st.drawn = null;
  }
  function doDiscard(d, seat, tile) {
    const st = d.s.seats[seat];
    const drawAndCut = st.drawn === tile;
    if (drawAndCut) {
      st.drawn = null;
    } else {
      absorbDrawn(st);
      removeOne(st.hand, tile);
    }
    st.discards.push(tile);
    d.s.lastDiscard = { tile, from: seat };
    d.s.onKongReplacement = false;
    d.s.refusedSelfDraw = null;
    emit(d, seat, "discard", { seat, tile, drawAndCut });
    if (!openClaimWindow(d, tile, seat, false)) advanceTurn(d, seat);
  }
  function doConcealedKong(d, seat, tile) {
    const st = d.s.seats[seat];
    absorbDrawn(st);
    if (!canConcealedKong(st.hand, tile)) {
      throw new Error(`seat ${seat} cannot declare \u6697\u69D3 of tile ${tile}`);
    }
    for (let n = 0; n < 4; n++) removeOne(st.hand, tile);
    const meld = makeConcealedKong(tile, seat);
    st.melds.push(meld);
    emit(d, seat, "concealedKong", { seat, tile, meld });
    d.s.phase = "awaitDiscard";
    if (!drawKongReplacement(d, seat, "concealed")) exhaustiveDraw(d);
  }
  function doAddedKong(d, seat, tile) {
    const st = d.s.seats[seat];
    absorbDrawn(st);
    if (!canAddedKong(st.hand, st.melds, tile)) {
      throw new Error(`seat ${seat} cannot declare \u52A0\u69D3 of tile ${tile}`);
    }
    st.melds = upgradePungToKong(st.melds, tile, seat);
    removeOne(st.hand, tile);
    const meld = st.melds.find((m) => m.kind === "kong" && m.tiles[0] === tile);
    emit(d, seat, "addedKong", { seat, tile, meld });
    if (!openClaimWindow(d, tile, seat, true)) completeAddedKong(d, seat);
  }
  function doDeclareWin(d, seat) {
    const st = d.s.seats[seat];
    if (st.drawn === null) throw new Error(`seat ${seat} has no drawn tile to win on`);
    if (!shapeWins(st, st.drawn, playsSevenPairs(d.ruleset))) {
      throw new Error(`seat ${seat} has no winning shape`);
    }
    const ctx = winContext(d.s, seat, st.drawn, true, null, {
      onKongReplacement: d.s.onKongReplacement,
      onLastTile: liveTilesLeft(d.s) === 0
    });
    const result = scoreDeclaration(d, seat, ctx);
    if (!result.legal) {
      emitRefusedWin(d, seat, ctx, result);
      d.s.refusedSelfDraw = { seat, tile: ctx.winningTile };
      return;
    }
    takeWin(d, ctx, result);
  }
  function doClaimOrPass(d, seat, answer) {
    const w = d.s.claim;
    if (!w) throw new Error(`seat ${seat} answered a claim window that is not open`);
    const offer = w.offers.find((o) => o.seat === seat);
    if (!offer) throw new Error(`seat ${seat} was not prompted on tile ${w.tile}`);
    if (offer.answer !== null) throw new Error(`seat ${seat} has already answered`);
    if (answer && answer.kind === "claim") {
      const want = answer.option;
      const wantPair = want.with ? [...want.with].sort(asc).join(",") : "";
      const match = offer.options.find(
        (o) => o.kind === want.kind && (o.kind !== "chow" || o.with !== void 0 && o.with.slice().sort(asc).join(",") === wantPair)
      );
      if (!match) throw new Error(`seat ${seat} claimed ${want.kind}, which it was not offered`);
      offer.answer = { kind: "claim", option: { kind: match.kind, ...match.with ? { with: match.with.slice() } : {} } };
    } else {
      offer.answer = { kind: "pass" };
    }
    if (w.offers.every((o) => o.answer !== null)) resolveWindow(d);
  }
  function applyAction(state2, action) {
    const d = {
      s: cloneState(state2),
      events: [],
      ruleset: resolveRuleset(state2.rulesetId)
    };
    if (!isSeat2(action.seat)) throw new Error(`seat ${action.seat} is not a seat`);
    switch (action.type) {
      case "discard": {
        requireTurn(d.s, action.seat);
        const st = d.s.seats[action.seat];
        if (st.drawn !== action.tile && !st.hand.includes(action.tile)) {
          throw new Error(`seat ${action.seat} does not hold tile ${action.tile}`);
        }
        doDiscard(d, action.seat, action.tile);
        break;
      }
      case "concealedKong":
        requireTurn(d.s, action.seat);
        doConcealedKong(d, action.seat, action.tile);
        break;
      case "addedKong":
        requireTurn(d.s, action.seat);
        doAddedKong(d, action.seat, action.tile);
        break;
      case "declareWin":
        requireTurn(d.s, action.seat);
        if (!action.selfDraw) {
          throw new Error('a win on a discard is a claim, not a declaration \u2014 send { type: "claim" }');
        }
        doDeclareWin(d, action.seat);
        break;
      case "claim":
        if (d.s.phase !== "claimWindow" && d.s.phase !== "robKongWindow") {
          throw new Error(`claims are only legal in a claim window, not "${d.s.phase}"`);
        }
        doClaimOrPass(d, action.seat, { kind: "claim", option: action.option });
        break;
      case "pass":
        if (d.s.phase !== "claimWindow" && d.s.phase !== "robKongWindow") {
          throw new Error(`a pass is only legal in a claim window, not "${d.s.phase}"`);
        }
        doClaimOrPass(d, action.seat, { kind: "pass" });
        break;
    }
    return { state: d.s, events: d.events };
  }

  // engine/src/threat.ts
  var suitIx = (t) => t < 9 ? 0 : t < 18 ? 1 : 2;
  function readDiscards(discards, theirWind, roundWind) {
    const n = discards.length;
    const suited = discards.filter(isSuited);
    let suitPhasing = 0;
    if (suited.length >= 4) {
      const share = (a) => {
        const c = [0, 0, 0];
        for (const t of a) c[suitIx(t)]++;
        return Math.max(...c) / a.length;
      };
      const half = Math.floor(suited.length / 2);
      suitPhasing = clamp01((share(suited.slice(0, half)) + share(suited.slice(half))) / 2 * 1.25 - 0.45);
    }
    const firstSix = discards.slice(0, 6);
    const suitsSeen = new Set(firstSix.filter(isSuited).map(suitIx));
    const earlySpread = suitsSeen.size === 3;
    const honourIdx = discards.map((t, i) => isHonour(t) ? i : -1).filter((i) => i >= 0);
    let lateHonours = 0;
    if (n >= 6 && honourIdx.length > 0) {
      lateHonours = clamp01(honourIdx.filter((i) => i >= n * 2 / 3).length / honourIdx.length);
    }
    const valueHonour = (t) => t >= 31 || t === 27 + theirWind || t === 27 + roundWind;
    let earlyValueHonours = 0;
    if (n >= 3) {
      const early = discards.slice(0, Math.max(3, Math.floor(n / 3)));
      earlyValueHonours = clamp01(early.filter((t) => isHonour(t) && valueHonour(t)).length / 2);
    }
    return { suitPhasing, earlySpread, lateHonours, earlyValueHonours };
  }
  var clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
  var isMiddle = (t) => isSuited(t) && rankOf(t) >= 2 && rankOf(t) <= 6;
  function assessSeatThreat(v, seat, rules2) {
    const melds = v.melds[seat];
    const discards = v.discards[seat];
    const exposure = melds.length / 4;
    const meldedPerSuit = [0, 0, 0];
    let meldedHonours = 0;
    for (const m of melds) {
      for (const t of m.tiles) {
        if (isHonour(t)) meldedHonours++;
        else if (isSuited(t)) meldedPerSuit[suitOf(t) === "chars" ? 0 : suitOf(t) === "bamboo" ? 1 : 2]++;
      }
    }
    const cutsPerSuit = [0, 0, 0];
    for (const t of discards) {
      if (isSuited(t)) cutsPerSuit[suitOf(t) === "chars" ? 0 : suitOf(t) === "bamboo" ? 1 : 2]++;
    }
    let intentSuit = null;
    let intentStrength = 0;
    const topMelded = Math.max(...meldedPerSuit);
    if (topMelded >= 3) {
      const s = meldedPerSuit.indexOf(topMelded);
      const starving = discards.length >= 4 ? 1 - clamp01(cutsPerSuit[s] / discards.length * 3) : 0.5;
      intentSuit = s;
      intentStrength = clamp01(topMelded / 9 + starving * 0.5);
    }
    let readyProxy = 0;
    if (discards.length >= 6) {
      const late = discards.slice(-6);
      const early = discards.slice(0, 6);
      const share = (a) => a.filter(isMiddle).length / a.length;
      readyProxy = clamp01((share(late) - share(early)) * 1.5 + exposure * 0.3);
    } else {
      readyProxy = exposure * 0.3;
    }
    const read = readDiscards(discards, v.seatWinds[seat], v.roundWind);
    const floor = rules2?.minimumFaan ?? 3;
    let expectedFaan = floor;
    if (read.suitPhasing > 0.55) expectedFaan += 2;
    if (read.earlyValueHonours > 0) expectedFaan += 2;
    if (intentSuit !== null && intentStrength > 0.6) expectedFaan += 1;
    if (read.earlySpread) expectedFaan = Math.max(floor, expectedFaan - 1);
    expectedFaan = Math.min(expectedFaan, rules2?.limitFaan ?? 13);
    const chipsRel = rules2 ? Math.max(1, rules2.payment.onDiscard(expectedFaan) / Math.max(1, rules2.payment.onDiscard(floor))) : Math.pow(2, expectedFaan - floor);
    const readiness = clamp01(
      exposure * 0.5 + readyProxy * 0.3 + read.lateHonours * 0.3 + intentStrength * 0.15
    );
    const threat = clamp01(readiness);
    return { seat, exposure, intentSuit, intentStrength, readyProxy, threat, read, expectedFaan, chipsRel };
  }
  function tableThreat(v, rules2) {
    const seats = [];
    for (let s = 0; s < 4; s = s + 1) {
      if (s === v.seat) continue;
      seats.push(assessSeatThreat(v, s, rules2));
    }
    const suitDepletion = [0, 0, 0];
    for (let s = 0; s < 4; s++) {
      for (const t of v.discards[s]) if (isSuited(t)) suitDepletion[suitIx(t)]++;
      for (const m of v.melds[s]) for (const t of m.tiles) if (isSuited(t)) suitDepletion[suitIx(t)]++;
    }
    return { seats, max: Math.max(0, ...seats.map((t) => t.threat)), suitDepletion };
  }
  function feedsSeat(tile, t) {
    if (isHonour(tile)) return t.exposure >= 0.5 ? 0.6 : 0.2;
    if (t.intentSuit === null) return 0;
    const s = suitOf(tile) === "chars" ? 0 : suitOf(tile) === "bamboo" ? 1 : 2;
    return s === t.intentSuit ? t.intentStrength : 0;
  }

  // engine/src/bots.ts
  var DEFAULT_PROFILE = {
    faanWeight: 0.6,
    routeDistanceWeight: 1,
    offRouteWeight: 1.2,
    belowMinimumPenalty: 5,
    discardDistanceWeight: 3,
    discardRouteWeight: 1.15,
    discardSafetyWeight: 0.45,
    discardOutsWeight: 0.055,
    claimSpeedGain: 1,
    claimRouteTolerance: 1.6,
    aggression: 1,
    threatSensitivity: 0,
    threatPushValue: 0,
    leadDefense: 0,
    trailSwing: 0,
    winFastLead: 0,
    foldThreshold: 0,
    feedDenial: 0,
    foldSizeBias: 0,
    claimFallbackWeight: 0,
    keepPayableWeight: 0,
    chipValuation: 1,
    // 0.45, not 0.55: on the doubling ladder a claim costs 門前清 (÷2 payout), so
    // a tile of speed must be worth MORE than 2× (1/0.45 ≈ 2.2) or no bot ever
    // claims and the table goes alien-quiet — the texture gate caught exactly
    // that at 0.55. Evolution owns fine-tuning; the default must pass the gate.
    routeDecay: 0.45,
    leftFeedWeight: 0.8,
    urgencyWeight: 0.5,
    suitContestWeight: 0.8,
    claimSupplyWeight: 0.6
  };
  var profileOf = (cfg) => cfg.profile ?? DEFAULT_PROFILE;
  function tableRead(v, cfg) {
    const p = profileOf(cfg);
    return p.threatSensitivity > 0 || p.urgencyWeight > 0 || p.suitContestWeight > 0 ? tableThreat(v, cfg.ruleset) : null;
  }
  var faanFor = (r, id) => r.faanTable[id] ?? 0;
  function pickOne(ties, rnd) {
    const r = rnd();
    const i = Math.min(ties.length - 1, Math.floor(r * ties.length));
    return ties[i];
  }
  function ownTiles(v) {
    return v.drawn === null ? [...v.hand] : [...v.hand, v.drawn];
  }
  function shapeOf(v) {
    return {
      concealed: ownTiles(v),
      melds: v.melds[v.seat],
      flowers: v.flowers[v.seat],
      seatWind: v.seatWinds[v.seat],
      roundWind: v.roundWind,
      leftDiscards: v.discards[(v.seat + 3) % 4]
    };
  }
  function suitContest(suit, table2) {
    const ix = suit === "chars" ? 0 : suit === "bamboo" ? 1 : 2;
    let collector = 0;
    for (const t of table2.seats) {
      if (t.intentSuit === ix) collector = Math.max(collector, t.intentStrength);
    }
    const depletion = Math.min(1, table2.suitDepletion[ix] / 18);
    return collector * 0.7 + depletion * 0.5;
  }
  function leftFeed(shape, suit) {
    const suited = (shape.leftDiscards ?? []).filter((t) => t < 27);
    if (suited.length < 3) return 0;
    const ix = suit === "chars" ? 0 : suit === "bamboo" ? 1 : 2;
    const share = suited.filter((t) => Math.floor(t / 9) === ix).length / suited.length;
    return Math.max(-1, Math.min(1, (share - 1 / 3) * 3));
  }
  function visibleCounts(v) {
    const c = counts(ownTiles(v));
    for (let s = 0; s < 4; s++) {
      for (const t of v.discards[s]) if (t < SCORING_KINDS) c[t]++;
      for (const m of v.melds[s]) for (const t of m.tiles) c[t]++;
    }
    return c;
  }
  var SUITS = ["chars", "bamboo", "circles"];
  var ROUTES = [
    { id: "balanced", suit: null, pungs: false, honoursOnly: false, orphans: false },
    { id: "allPungs", suit: null, pungs: true, honoursOnly: false, orphans: false },
    ...SUITS.map((s) => ({ id: "flush", suit: s, pungs: false, honoursOnly: false, orphans: false })),
    ...SUITS.map((s) => ({ id: "flushPungs", suit: s, pungs: true, honoursOnly: false, orphans: false })),
    { id: "honours", suit: null, pungs: true, honoursOnly: true, orphans: false },
    { id: "orphans", suit: null, pungs: false, honoursOnly: false, orphans: true }
  ];
  var routeKey = (r) => r.suit === null ? r.id : `${r.id}:${r.suit}`;
  function onRoute(r, t) {
    if (isFlower(t)) return true;
    if (r.orphans) return isTerminalOrHonour(t);
    if (r.honoursOnly) return isHonour(t);
    if (r.suit === null) return true;
    return isHonour(t) || suitOf(t) === r.suit;
  }
  function meldsFit(r, melds) {
    if (r.orphans && melds.length > 0) return false;
    for (const m of melds) {
      if (r.pungs && m.kind === "chow") return false;
      for (const t of m.tiles) if (!onRoute(r, t)) return false;
    }
    return true;
  }
  function pungDistance(c, melds = 0) {
    let triplets = 0;
    let pairs = 0;
    for (let i = 0; i < SCORING_KINDS; i++) {
      const n = c[i];
      if (n >= 3) triplets++;
      else if (n === 2) pairs++;
    }
    let sets = melds + triplets;
    if (sets > 4) {
      pairs += sets - 4;
      sets = 4;
    }
    const hasPair = pairs > 0;
    const spare = hasPair ? pairs - 1 : 0;
    const parts = Math.max(0, Math.min(spare, 4 - sets));
    return 8 - 2 * sets - parts - (hasPair ? 1 : 0);
  }
  var ORPHAN_KINDS = (() => {
    const out = [];
    for (let t = 0; t < SCORING_KINDS; t++) if (isTerminalOrHonour(t)) out.push(t);
    return out;
  })();
  function orphansDistance(c) {
    let kinds = 0;
    let hasPair = false;
    for (const k of ORPHAN_KINDS) {
      const n = c[k];
      if (n > 0) kinds++;
      if (n >= 2) hasPair = true;
    }
    return 13 - kinds - (hasPair ? 1 : 0);
  }
  function bonusFaan(shape, r) {
    if (!r.useFlowers) return 0;
    let n = 0;
    let flowers = 0;
    let seasons = 0;
    for (const t of shape.flowers) {
      if (t < FLOWERS_START) continue;
      const season = t >= FLOWERS_START + 4;
      if (season) seasons++;
      else flowers++;
      if (flowerSeat(t) === shape.seatWind) n += faanFor(r, season ? "ownSeason" : "ownFlower");
    }
    if (flowers === 4) n += faanFor(r, "allFlowers");
    if (seasons === 4) n += faanFor(r, "allSeasons");
    return n;
  }
  function meldedTriplet(melds, tile) {
    for (const m of melds) if (m.kind !== "chow" && m.tiles[0] === tile) return true;
    return false;
  }
  function honourMeldFaan(r, shape, rules2, c) {
    let n = 0;
    const reachable = (tile) => onRoute(r, tile) && (meldedTriplet(shape.melds, tile) || c[tile] >= 2);
    const seatTile = WINDS_START + shape.seatWind;
    const roundTile = WINDS_START + shape.roundWind;
    if (reachable(seatTile)) n += faanFor(rules2, "seatWind");
    if (reachable(roundTile)) n += faanFor(rules2, "roundWind");
    for (let d = DRAGONS_START; d < FLOWERS_START; d++) {
      if (reachable(d)) n += faanFor(rules2, "dragonPung");
    }
    return n;
  }
  function honoursHeld(shape, c) {
    let n = 0;
    for (let i = WINDS_START; i < SCORING_KINDS; i++) n += c[i];
    for (const m of shape.melds) for (const t of m.tiles) if (isHonour(t)) n++;
    return n;
  }
  var isConcealedHand = (melds) => melds.every((m) => m.kind === "kong" && m.concealed);
  function convertiblePairs(c) {
    let n = 0;
    for (let i = 0; i < SCORING_KINDS; i++) if (c[i] === 2) n++;
    return n;
  }
  function claimSupplyCredit(route, pairs, profile) {
    if (route.orphans) return 0;
    const rate = route.pungs || route.honoursOnly ? 1 : route.suit !== null ? 0.5 : 0.25;
    return profile.claimSupplyWeight * rate * pairs;
  }
  function routeValue(faan, distance, rules2, profile, urgency) {
    const cv = profile.chipValuation;
    if (cv <= 0) return faan;
    const floor = rules2.minimumFaan;
    const floorPay = Math.max(1, rules2.payment.onDiscard(floor));
    const rel = Math.max(0, rules2.payment.onDiscard(Math.min(faan, rules2.limitFaan))) / floorPay;
    const decay = Math.max(0.15, profile.routeDecay * (1 - profile.urgencyWeight * urgency));
    const chipEV = floor * rel * Math.pow(decay, Math.max(0, distance));
    return (1 - cv) * faan + cv * chipEV;
  }
  function routeFaan(r, shape, rules2, c) {
    if (r.orphans) return faanFor(rules2, "thirteenOrphans");
    let n = bonusFaan(shape, rules2) + honourMeldFaan(r, shape, rules2, c);
    if (isConcealedHand(shape.melds)) n += faanFor(rules2, "concealedHand");
    if (r.honoursOnly) {
      return n + faanFor(rules2, "allHonours");
    }
    if (r.suit !== null) {
      n += honoursHeld(shape, c) <= 1 ? faanFor(rules2, "fullFlush") : faanFor(rules2, "halfFlush");
    }
    if (r.pungs) n += faanFor(rules2, "allPungs");
    else if (r.suit === null && !shape.melds.some((m) => m.kind !== "chow")) {
      n += faanFor(rules2, "allChows");
    }
    return n;
  }
  function fallbackFaan(shape, rules2) {
    let n = bonusFaan(shape, rules2);
    const seatTile = WINDS_START + shape.seatWind;
    const roundTile = WINDS_START + shape.roundWind;
    if (meldedTriplet(shape.melds, seatTile)) n += faanFor(rules2, "seatWind");
    if (meldedTriplet(shape.melds, roundTile)) n += faanFor(rules2, "roundWind");
    for (let d = DRAGONS_START; d < FLOWERS_START; d++) {
      if (meldedTriplet(shape.melds, d)) n += faanFor(rules2, "dragonPung");
    }
    if (isConcealedHand(shape.melds)) n += faanFor(rules2, "concealedHand");
    return n;
  }
  function assessRoutes(shape, rules2, profile = DEFAULT_PROFILE, table2 = null) {
    const urgency = table2?.max ?? 0;
    const c = counts(shape.concealed);
    const melds = shape.melds.length;
    const out = [];
    for (const route of ROUTES) {
      let feasible = meldsFit(route, shape.melds);
      let offRoute = 0;
      let keptTiles = 0;
      const kept = new Array(SCORING_KINDS).fill(0);
      for (let i = 0; i < SCORING_KINDS; i++) {
        if (c[i] === 0) continue;
        if (onRoute(route, i)) {
          kept[i] = c[i];
          keptTiles += c[i];
        } else {
          offRoute += c[i];
        }
      }
      let distance;
      if (route.orphans) {
        let kinds = 0;
        let orphanTiles = 0;
        for (const k of ORPHAN_KINDS) {
          if (c[k] > 0) kinds++;
          orphanTiles += c[k];
        }
        offRoute += Math.max(0, orphanTiles - kinds - 1);
        distance = orphansDistance(c);
        if (kinds < ORPHANS_MIN_KINDS) feasible = false;
      } else {
        distance = route.pungs ? pungDistance(kept, melds) : keptTiles < MIN_ROUTE_TILES ? MAX_DISTANCE : distanceToReady(kept, melds);
      }
      const surplus = Math.max(0, offRoute - Math.max(0, distance));
      const faan = routeFaan(route, shape, rules2, c);
      const attainable = faan + faanFor(rules2, "selfDraw");
      const credit = Math.min(
        Math.max(0, distance) / 2,
        claimSupplyCredit(route, convertiblePairs(routeCounts(route, c)), profile)
      );
      const effDistance = Math.max(0, distance) - credit;
      let score2 = routeValue(faan, effDistance, rules2, profile, urgency) * profile.faanWeight - effDistance * profile.routeDistanceWeight * (route.orphans ? ORPHANS_DISTANCE_TAX : 1) - surplus * profile.offRouteWeight + // 上家 as supply line (owner, 2026-08-27): a suit route lives or dies on
      // whether the seat before you is feeding that suit or hoarding it.
      (route.suit !== null ? leftFeed(shape, route.suit) * profile.leftFeedWeight : 0) - // SUIT SUPPLY: a route into a suit the table is eating — a collector
      // declared on it, or a third of its copies already visible — is priced
      // down before any tile is thrown at it.
      (route.suit !== null && table2 !== null ? suitContest(route.suit, table2) * profile.suitContestWeight : 0);
      if (attainable < rules2.minimumFaan) score2 -= profile.belowMinimumPenalty;
      else if (faan < rules2.minimumFaan) {
        score2 -= profile.belowMinimumPenalty * DISCARD_WIN_SHARE;
      }
      if (!feasible) score2 = Number.NEGATIVE_INFINITY;
      out.push({
        route,
        key: routeKey(route),
        feasible,
        faan,
        attainable,
        offRoute,
        surplus,
        distance,
        score: score2
      });
    }
    return out;
  }
  function chooseRoute(shape, rules2, profile = DEFAULT_PROFILE, table2 = null) {
    const all2 = assessRoutes(shape, rules2, profile, table2);
    let best = all2[0];
    for (const a of all2) if (a.score > best.score) best = a;
    return best;
  }
  function faanCeiling(shape, rules2) {
    const c = counts(shape.concealed);
    let best = 0;
    for (const route of ROUTES) {
      if (route.orphans) continue;
      if (!meldsFit(route, shape.melds)) continue;
      const f = routeFaan(route, shape, rules2, c);
      if (f > best) best = f;
    }
    return best + faanFor(rules2, "selfDraw");
  }
  var hasFaanPath = (shape, rules2) => faanCeiling(shape, rules2) >= rules2.minimumFaan;
  function seatThreat(v, s) {
    const melds = v.melds[s].length;
    const late = v.wallRemaining < 30 ? 0.2 : 0;
    return 0.35 + 0.45 * melds + late;
  }
  function flushSuitOf(v, s) {
    const melds = v.melds[s];
    if (melds.length < 2) return null;
    let suit = null;
    for (const m of melds) {
      for (const t of m.tiles) {
        const st = suitOf(t);
        if (st === "honours") continue;
        if (suit === null) suit = st;
        else if (suit !== st) return null;
      }
    }
    return suit;
  }
  function chowExposure(t, visible) {
    if (!isSuited(t)) return 0;
    const rank = t % 9;
    let n = 0;
    for (let d = -2; d <= 2; d++) {
      if (d === 0) continue;
      const r = rank + d;
      if (r < 0 || r > 8) continue;
      n += Math.max(0, 4 - visible[t + d]);
    }
    return n / 8;
  }
  function discardDanger(v, t, visible) {
    if (isFlower(t)) return 0;
    const unaccounted = Math.max(0, 4 - visible[t]);
    let danger = 0;
    const rightHand = (v.seat + 1) % 4;
    for (let i = 0; i < 4; i++) {
      const s = i;
      if (s === v.seat) continue;
      const threat = seatThreat(v, s);
      if (unaccounted >= 2) danger += (unaccounted - 1) * 0.5 * threat;
      if (s === rightHand && isSuited(t)) danger += chowExposure(t, visible) * 0.5 * threat;
      const fs = flushSuitOf(v, s);
      if (fs !== null && (suitOf(t) === fs || isHonour(t))) danger += 1.1 * threat;
    }
    if (isTerminalOrHonour(t)) danger *= 0.8;
    return danger;
  }
  var distinctAscending = (tiles) => {
    const seen = new Array(SCORING_KINDS).fill(false);
    for (const t of tiles) if (t < SCORING_KINDS) seen[t] = true;
    const out = [];
    for (let i = 0; i < SCORING_KINDS; i++) if (seen[i]) out.push(i);
    return out;
  };
  function rankDiscards(v, cfg) {
    const profile = profileOf(cfg);
    const shape = shapeOf(v);
    const threats = tableRead(v, cfg);
    const chosen = chooseRoute(shape, cfg.ruleset, profile, threats);
    const visible = visibleCounts(v);
    let foldFactor = 0;
    if (profile.threatSensitivity > 0 && threats !== null) {
      const ownStrength = Math.max(0, 1 - chosen.distance / 4);
      let sized = 0;
      for (const t of threats.seats) {
        const cost = t.threat * Math.min(t.chipsRel, 12) / 4;
        if (cost > sized) sized = cost;
      }
      const pressure = threats.max + profile.foldSizeBias * (sized - threats.max);
      foldFactor = Math.max(0, pressure - ownStrength * profile.threatPushValue);
    }
    const folding = profile.foldThreshold > 0 && foldFactor > profile.foldThreshold;
    const melds = shape.melds.length;
    const c = counts(shape.concealed);
    const candidates = distinctAscending(shape.concealed);
    const restricts = chosen.route.suit !== null || chosen.route.pungs || chosen.route.honoursOnly || chosen.route.orphans;
    const offRouteDistance = restricts ? chosen.distance : 0;
    const bankedShort = profile.keepPayableWeight > 0 ? Math.max(0, cfg.ruleset.minimumFaan - fallbackFaan(shape, cfg.ruleset)) : 0;
    const paysIfPunged = (t) => isDragon(t) || t === WINDS_START + shape.seatWind || t === WINDS_START + shape.roundWind;
    const scored = candidates.map((tile) => {
      const fitsRoute = onRoute(chosen.route, tile);
      c[tile]--;
      const distance = distanceToReady(c, melds);
      const routeDistance = !restricts ? distance : !fitsRoute ? offRouteDistance : chosen.route.orphans ? orphansDistance(c) : chosen.route.pungs ? pungDistance(routeCounts(chosen.route, c), melds) : distanceToReady(routeCounts(chosen.route, c), melds);
      c[tile]++;
      const fits = fitsRoute;
      const danger = discardDanger(v, tile, visible);
      let threatDanger = 0;
      if (threats !== null && foldFactor > 0) {
        for (const t of threats.seats) {
          threatDanger += t.threat * feedsSeat(tile, t) * (Math.min(t.chipsRel, 16) / 4);
        }
      }
      const speedDistance = chosen.route.orphans ? routeDistance : distance;
      let denial = 0;
      if (profile.feedDenial > 0 && Math.max(0, 4 - visible[tile]) >= 2) {
        for (let si = 0; si < 4; si++) {
          if (si === v.seat) continue;
          const pungish = v.melds[si].filter((m) => m.kind !== "chow").length;
          if (pungish >= 2) denial += 0.5 * pungish;
        }
      }
      const payGuard = bankedShort > 0 && c[tile] >= 2 && paysIfPunged(tile) ? bankedShort * profile.keepPayableWeight : 0;
      const score2 = folding ? -danger * (1 + profile.discardSafetyWeight) - denial * profile.feedDenial - threatDanger * foldFactor * profile.threatSensitivity : -speedDistance * profile.discardDistanceWeight - routeDistance * profile.discardRouteWeight * 0.5 + (restricts ? fits ? -profile.discardRouteWeight : profile.discardRouteWeight : 0) - danger * profile.discardSafetyWeight - denial * profile.feedDenial - payGuard - threatDanger * foldFactor * profile.threatSensitivity;
      return { tile, distance, outs: -1, danger, onRoute: fits, score: score2 };
    });
    scored.sort((a, b) => b.score - a.score || a.tile - b.tile);
    const top = scored[0].score;
    const tied = scored.filter((d) => top - d.score < TIE_EPSILON);
    if (tied.length > 1) {
      for (const d of tied) {
        c[d.tile]--;
        d.outs = liveTiles(c, melds, visible).total;
        c[d.tile]++;
        d.score += d.outs * profile.discardOutsWeight;
      }
      scored.sort((a, b) => b.score - a.score || a.tile - b.tile);
    }
    return scored;
  }
  var TIE_EPSILON = 1e-9;
  var MAX_DISTANCE = 8;
  var MIN_ROUTE_TILES = 7;
  var ORPHANS_MIN_KINDS = 6;
  var DISCARD_WIN_SHARE = 0.6;
  var ORPHANS_DISTANCE_TAX = 2;
  function routeDistanceOf(shape, route) {
    const c = routeCounts(route, counts(shape.concealed));
    return route.orphans ? orphansDistance(c) : route.pungs ? pungDistance(c, shape.melds.length) : distanceToReady(c, shape.melds.length);
  }
  function routeCounts(r, c) {
    const kept = new Array(SCORING_KINDS).fill(0);
    for (let i = 0; i < SCORING_KINDS; i++) if (c[i] > 0 && onRoute(r, i)) kept[i] = c[i];
    return kept;
  }
  function chooseDiscard(v, cfg) {
    const ranked = rankDiscards(v, cfg);
    const top = ranked[0].score;
    const ties = ranked.filter((r) => top - r.score < TIE_EPSILON);
    return pickOne(ties, cfg.rnd).tile;
  }
  function shapeAfterClaim(v, option, tile, from) {
    const hand = [...v.hand];
    const take = (t) => {
      const i = hand.indexOf(t);
      if (i < 0) return false;
      hand.splice(i, 1);
      return true;
    };
    let meld;
    try {
      switch (option.kind) {
        case "chow": {
          const withTiles = option.with ?? [];
          if (withTiles.length !== 2) return null;
          for (const t of withTiles) if (!take(t)) return null;
          meld = makeChow([tile, ...withTiles], v.seat, from);
          break;
        }
        case "pung": {
          if (!take(tile) || !take(tile)) return null;
          meld = makePung(tile, v.seat, from);
          break;
        }
        case "kong": {
          if (!take(tile) || !take(tile) || !take(tile)) return null;
          meld = makeExposedKong(tile, v.seat, from);
          break;
        }
        default:
          return null;
      }
    } catch {
      return null;
    }
    return {
      concealed: hand,
      melds: [...v.melds[v.seat], meld],
      flowers: v.flowers[v.seat],
      seatWind: v.seatWinds[v.seat],
      roundWind: v.roundWind
    };
  }
  function bestDistanceAfterDiscard(shape, route) {
    const full = counts(shape.concealed);
    const c = routeCounts(route, full);
    const melds = shape.melds.length;
    const measure = () => route.orphans ? orphansDistance(c) : route.pungs ? pungDistance(c, melds) : distanceToReady(c, melds);
    let best = Number.POSITIVE_INFINITY;
    let offRouteDone = false;
    for (let t = 0; t < SCORING_KINDS; t++) {
      if (full[t] === 0) continue;
      if (c[t] === 0) {
        if (offRouteDone) continue;
        offRouteDone = true;
        const d2 = measure();
        if (d2 < best) best = d2;
        continue;
      }
      c[t]--;
      const d = measure();
      c[t]++;
      if (d < best) best = d;
    }
    return best === Number.POSITIVE_INFINITY ? 8 : best;
  }
  function claimContext(v, cfg) {
    const profile = profileOf(cfg);
    const shape = shapeOf(v);
    const route = chooseRoute(shape, cfg.ruleset, profile, tableRead(v, cfg));
    return { shape, route, distance: route.distance };
  }
  function assessClaim(v, option, cfg, context) {
    const profile = profileOf(cfg);
    const last = v.lastDiscard;
    const before = context ?? claimContext(v, cfg);
    const distanceBefore = before.distance;
    const dead = {
      option,
      reason: "faanFloor",
      faanCeiling: 0,
      distanceBefore,
      distanceAfter: distanceBefore,
      score: Number.NEGATIVE_INFINITY
    };
    if (last === null) return dead;
    if (before.route.route.orphans && option.kind !== "win") {
      return { ...dead, reason: "concealedRoute" };
    }
    const after = shapeAfterClaim(v, option, last.tile, last.from);
    if (after === null) return dead;
    const ceiling = faanCeiling(after, cfg.ruleset);
    if (ceiling < cfg.ruleset.minimumFaan) return { ...dead, faanCeiling: ceiling };
    const shapeProfile = { ...profile, chipValuation: 0 };
    const beforeRoute = chooseRoute(before.shape, cfg.ruleset, shapeProfile);
    const afterRoute = chooseRoute(after, cfg.ruleset, shapeProfile);
    if (!afterRoute.feasible || afterRoute.faan < cfg.ruleset.minimumFaan) {
      return { ...dead, reason: "offRoute", faanCeiling: ceiling };
    }
    if (afterRoute.score < beforeRoute.score - profile.claimRouteTolerance) {
      return { ...dead, reason: "offRoute", faanCeiling: ceiling };
    }
    const onRouteBefore = routeDistanceOf(before.shape, afterRoute.route);
    const distanceAfter = bestDistanceAfterDiscard(after, afterRoute.route);
    const gain = onRouteBefore - distanceAfter;
    const shortfall = Math.max(0, cfg.ruleset.minimumFaan - fallbackFaan(after, cfg.ruleset));
    const speedBar = (option.kind === "kong" ? 0 : profile.claimSpeedGain) * (2 - profile.aggression);
    const riskBar = shortfall * profile.claimFallbackWeight;
    if (gain < speedBar + riskBar) {
      return {
        option,
        reason: "tooSlow",
        faanCeiling: ceiling,
        distanceBefore,
        distanceAfter,
        score: Number.NEGATIVE_INFINITY
      };
    }
    const score2 = afterRoute.score - before.route.score + gain * 1.4 * profile.aggression + (option.kind === "kong" ? 0.6 : 0) + (afterRoute.attainable - cfg.ruleset.minimumFaan) * 0.15 - shortfall * profile.claimFallbackWeight;
    return {
      option,
      reason: "accepted",
      faanCeiling: ceiling,
      distanceBefore: onRouteBefore,
      distanceAfter,
      score: score2
    };
  }
  function claimDecision(v, options, cfg) {
    const context = claimContext(v, cfg);
    const profile = cfg.profile ?? DEFAULT_PROFILE;
    if (profile.foldThreshold > 0 && profile.threatSensitivity > 0) {
      const threats = tableRead(v, cfg);
      if (threats !== null) {
        const cc = counts(v.hand);
        const ownStrength = Math.max(0, 1 - distanceToReady(cc, v.melds[v.seat].length) / 4);
        if (Math.max(0, threats.max - ownStrength * profile.threatPushValue) > profile.foldThreshold) {
          cfg.rnd();
          return null;
        }
      }
    }
    const assessed = options.filter((o) => o.kind !== "win").map((o) => assessClaim(v, o, cfg, context)).filter((a) => a.reason === "accepted");
    if (assessed.length === 0) {
      cfg.rnd();
      return null;
    }
    assessed.sort((a, b) => b.score - a.score || claimRank(a.option) - claimRank(b.option));
    const top = assessed[0].score;
    const ties = assessed.filter((a) => top - a.score < TIE_EPSILON);
    return pickOne(ties, cfg.rnd).option;
  }
  var claimRank = (o) => o.kind === "kong" ? 0 : o.kind === "pung" ? 1 : o.kind === "chow" ? 2 : 3;
  function shouldKong(v, tile, form, cfg) {
    const shape = shapeOf(v);
    if (!hasFaanPath(shape, cfg.ruleset)) return false;
    const route = chooseRoute(shape, cfg.ruleset, profileOf(cfg), tableRead(v, cfg));
    if (route.route.orphans) return false;
    if (!onRoute(route.route, tile)) return false;
    const melds = shape.melds.length;
    const c = counts(shape.concealed);
    const before = distanceToReady(c, melds);
    if (form === "concealed") {
      c[tile] -= 4;
      const after = distanceToReady(c, melds + 1);
      c[tile] += 4;
      if (after > before) return false;
    } else {
      const exposed = Math.max(...v.melds.map((m, s) => s === v.seat ? 0 : m.length));
      if (exposed >= 2 && v.wallRemaining < 60) return false;
    }
    return true;
  }
  function chipLead(v) {
    const st = v.standings;
    if (!st) return 0;
    const mine = st[v.seat];
    let best = -Infinity;
    for (let i = 0; i < st.length; i++) if (i !== v.seat && st[i] > best) best = st[i];
    const lead = (mine - best) / 128;
    return lead > 1 ? 1 : lead < -1 ? -1 : lead;
  }
  function scoreAdjust(profile, v) {
    if (profile.leadDefense === 0 && profile.trailSwing === 0 && profile.winFastLead === 0) return profile;
    const L = chipLead(v);
    if (L === 0) return profile;
    if (L > 0) {
      return {
        ...profile,
        discardSafetyWeight: profile.discardSafetyWeight * (1 + profile.leadDefense * L),
        threatSensitivity: profile.threatSensitivity * (1 + profile.leadDefense * L),
        // easier hard-fold when protecting a lead
        foldThreshold: profile.foldThreshold > 0 ? profile.foldThreshold / (1 + profile.leadDefense * L) : 0,
        discardDistanceWeight: profile.discardDistanceWeight * (1 + profile.winFastLead * L),
        routeDistanceWeight: profile.routeDistanceWeight * (1 + profile.winFastLead * L)
      };
    }
    return {
      ...profile,
      faanWeight: profile.faanWeight * (1 + profile.trailSwing * -L),
      aggression: profile.aggression * (1 + profile.trailSwing * -L)
    };
  }
  function decideAction(v, legal, cfg) {
    if (legal.length === 0) throw new Error(`seat ${v.seat} was asked to act with no legal action`);
    if (cfg.profile) {
      const adj = scoreAdjust(cfg.profile, v);
      if (adj !== cfg.profile) cfg = { ...cfg, profile: adj };
    }
    for (const a of legal) if (a.type === "declareWin") return a;
    for (const a of legal) if (a.type === "claim" && a.option.kind === "win") return a;
    const claims = legal.filter(
      (a) => a.type === "claim"
    );
    if (claims.length > 0) {
      const picked = claimDecision(v, claims.map((a) => a.option), cfg);
      if (picked !== null) {
        const match = claims.find(
          (a) => a.option.kind === picked.kind && sameWith(a.option, picked)
        );
        if (match) return match;
      }
      const pass2 = legal.find((a) => a.type === "pass");
      if (pass2) return pass2;
    }
    for (const a of legal) {
      if (a.type === "concealedKong" && shouldKong(v, a.tile, "concealed", cfg)) return a;
    }
    for (const a of legal) {
      if (a.type === "addedKong" && shouldKong(v, a.tile, "added", cfg)) return a;
    }
    const discards = legal.filter(
      (a) => a.type === "discard"
    );
    if (discards.length > 0) {
      const tile = chooseDiscard(v, cfg);
      const kongInstead = legal.find(
        (a) => a.type === "addedKong" && a.tile === tile
      );
      if (kongInstead) return kongInstead;
      const match = discards.find((a) => a.tile === tile);
      if (match) return match;
      return discards[0];
    }
    const pass = legal.find((a) => a.type === "pass");
    if (pass) return pass;
    return legal[0];
  }
  var sameWith = (a, b) => {
    const x = a.with ?? [];
    const y = b.with ?? [];
    return x.length === y.length && x.every((t, i) => t === y[i]);
  };

  // tools/sim/driver.ts
  function viewFor(state2, seat) {
    const me = state2.seats[seat];
    const offered = state2.claim;
    return {
      seat,
      dealer: state2.dealer,
      roundWind: state2.roundWind,
      seatWinds: state2.seats.map((s) => s.wind),
      hand: me.hand,
      drawn: me.drawn,
      melds: state2.seats.map((s) => s.melds),
      flowers: state2.seats.map((s) => s.flowers),
      discards: state2.seats.map((s) => s.discards),
      handCounts: state2.seats.map((s) => s.hand.length),
      standings: state2.seats.map((s) => s.chips),
      dealershipsDone: Math.max(0, state2.seats.findIndex((s) => s.wind === 0)),
      wallRemaining: Math.max(0, state2.wallEnd - state2.wallIndex),
      lastDiscard: offered === null ? state2.lastDiscard : { tile: offered.tile, from: offered.from }
    };
  }

  // client/game/store.ts
  var store_exports = {};
  __export(store_exports, {
    allFeedback: () => allFeedback,
    allMatches: () => allMatches,
    available: () => available,
    exportAll: () => exportAll,
    getPlayer: () => getPlayer,
    movesFor: () => movesFor,
    putFeedback: () => putFeedback,
    putMatch: () => putMatch,
    putMoves: () => putMoves,
    setPlayerName: () => setPlayerName,
    usage: () => usage
  });
  var DB_NAME = "mjrc-game";
  var DB_VERSION = 1;
  var dbPromise = null;
  var unavailableReason = "";
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        unavailableReason = String(e);
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("player")) db.createObjectStore("player", { keyPath: "id" });
        if (!db.objectStoreNames.contains("match")) {
          const m = db.createObjectStore("match", { keyPath: "id" });
          m.createIndex("playerId", "playerId");
          m.createIndex("finishedAt", "finishedAt");
        }
        if (!db.objectStoreNames.contains("move")) {
          const mv = db.createObjectStore("move", { autoIncrement: true });
          mv.createIndex("matchId", "matchId");
        }
        if (!db.objectStoreNames.contains("feedback")) {
          db.createObjectStore("feedback", { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        unavailableReason = String(req.error);
        resolve(null);
      };
      req.onblocked = () => {
        unavailableReason = "another tab holds an older version open";
        resolve(null);
      };
    });
    return dbPromise;
  }
  async function available() {
    const db = await open();
    return { ok: db !== null, why: unavailableReason };
  }
  async function tx(store, mode, run2) {
    const db = await open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const t = db.transaction(store, mode);
        const req = run2(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  async function all(store) {
    const r = await tx(store, "readonly", (s) => s.getAll());
    return r ?? [];
  }
  async function getPlayer() {
    const rows = await all("player");
    return rows[0] ?? null;
  }
  async function setPlayerName(name4) {
    const now = Date.now();
    const existing = await getPlayer();
    const rec2 = existing ? { ...existing, name: name4, lastSeen: now } : { id: crypto.randomUUID(), name: name4, firstSeen: now, lastSeen: now };
    await tx("player", "readwrite", (s) => s.put(rec2));
    return rec2;
  }
  async function putMatch(m) {
    await tx("match", "readwrite", (s) => s.put(m));
  }
  async function putMoves(moves) {
    if (moves.length === 0) return;
    const db = await open();
    if (!db) return;
    try {
      const t = db.transaction("move", "readwrite");
      const s = t.objectStore("move");
      for (const mv of moves) s.put(mv);
    } catch {
    }
  }
  var allMatches = () => all("match");
  async function movesFor(matchId) {
    const db = await open();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const req = db.transaction("move", "readonly").objectStore("move").index("matchId").getAll(matchId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }
  async function putFeedback(f) {
    await tx("feedback", "readwrite", (s) => s.put(f));
  }
  var allFeedback = () => all("feedback");
  async function exportAll() {
    const [player2, matches, feedback] = await Promise.all([
      getPlayer(),
      allMatches(),
      allFeedback()
    ]);
    const moves = await all("move");
    return JSON.stringify({
      exportedAt: Date.now(),
      schema: DB_VERSION,
      player: player2,
      matches,
      moves,
      feedback
    });
  }
  async function usage() {
    const matches = await allMatches();
    let bytes = 0;
    for (const m of matches) bytes += JSON.stringify(m).length;
    return { matches: matches.length, approxBytes: bytes };
  }

  // client/game/sync.ts
  var BASE = new URL("api/", new URL(".", location.href)).toString();
  var POST_TIMEOUT_MS = 12e3;
  async function gzipB64(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const cs = new CompressionStream("gzip");
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 32768) {
      s += String.fromCharCode(...buf.subarray(i, i + 32768));
    }
    return btoa(s);
  }
  async function post(path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
    try {
      return await fetch(BASE + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // the page is behind Basic Auth; send what the browser already holds
        credentials: "same-origin",
        signal: ctl.signal
      });
    } finally {
      clearTimeout(t);
    }
  }
  async function matchPayload(m, moves) {
    return {
      id: m.id,
      playerId: m.playerId,
      playerName: m.playerName,
      rounds: m.rounds,
      rulesetId: m.rulesetId,
      tableId: m.tableId,
      seats: m.seats,
      seed: m.seed,
      recorded: m.recorded,
      abandoned: m.abandoned,
      startedAt: m.startedAt,
      finishedAt: m.finishedAt,
      chips: m.chips,
      hands: m.hands,
      won: m.won,
      selfDrawn: m.selfDrawn,
      fed: m.fed,
      drawnHands: m.drawnHands,
      seatWins: m.seatWins,
      matchRate: m.matchRate,
      meanGap: m.meanGap,
      movesGraded: m.movesGraded,
      client: { ua: navigator.userAgent, tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
      // the replay, gzipped — see the header for why it is actions and not events
      actionsGz: await gzipB64({ seed: m.seed, rulesetId: m.rulesetId, rounds: m.rounds, actions: m.actions }),
      moves: moves.map((v) => ({
        hand: v.hand,
        turn: v.turn,
        kind: v.kind,
        played: v.played,
        enginePick: v.enginePick,
        gap: v.gap,
        top1MinusTop2: v.top1MinusTop2,
        reason: v.reason
      }))
    };
  }
  var inflight = null;
  function drain(store) {
    inflight ??= run(store).finally(() => {
      inflight = null;
    });
    return inflight;
  }
  async function run(store) {
    const out = { matches: 0, feedback: 0, failed: 0, why: null };
    {
      const matches = (await store.allMatches()).filter((m) => !m.uploadedAt && m.finishedAt !== null);
      for (const m of matches) {
        try {
          const moves = await store.movesFor(m.id);
          const r = await post("match", await matchPayload(m, moves));
          if (!r.ok) {
            out.failed++;
            out.why ??= `match ${r.status}`;
            continue;
          }
          await store.putMatch({ ...m, uploadedAt: Date.now() });
          out.matches++;
        } catch (e) {
          out.failed++;
          out.why ??= String(e).slice(0, 80);
        }
      }
      const fb = (await store.allFeedback()).filter((f) => !f.uploadedAt);
      for (const f of fb) {
        try {
          const r = await post("feedback", {
            id: f.id,
            matchId: f.matchId,
            hand: f.hand,
            text: f.text,
            createdAt: f.createdAt,
            context: f.context
          });
          if (!r.ok) {
            out.failed++;
            out.why ??= `feedback ${r.status}`;
            continue;
          }
          await store.putFeedback({ ...f, uploadedAt: Date.now() });
          out.feedback++;
        } catch (e) {
          out.failed++;
          out.why ??= String(e).slice(0, 80);
        }
      }
    }
    return out;
  }
  async function pending(store) {
    const [m, f] = await Promise.all([store.allMatches(), store.allFeedback()]);
    return m.filter((x) => !x.uploadedAt && x.finishedAt !== null).length + f.filter((x) => !x.uploadedAt).length;
  }

  // client/game/game.ts
  SHOW_MEASURE = false;
  var faceCache = /* @__PURE__ */ new Map();
  function face(t) {
    const hit = faceCache.get(t);
    if (hit !== void 0) return hit;
    let svg;
    if (t < 9) svg = tileWan(t + 1);
    else if (t < 18) svg = tileSuo(t - 8);
    else if (t < 27) svg = tileTong(t - 17);
    else if (t < 31) svg = tileWind(["\u6771", "\u5357", "\u897F", "\u5317"][t - 27]);
    else if (t < 34) svg = tileDragon(["red", "green", "white"][t - 31]);
    else {
      const ch = TILE_NAMES[t];
      const all2 = [...FLOWER_TILES, ...SEASON_TILES];
      const hitF = all2.find(([label]) => label.includes(ch));
      svg = hitF ? hitF[1]() : "";
    }
    faceCache.set(t, svg);
    return svg;
  }
  var HONOUR_NAMES = [
    "East",
    "South",
    "West",
    "North",
    "Red",
    "Green",
    "White",
    "Plum",
    "Orchid",
    "Chrysanth",
    "Bamboo",
    "Spring",
    "Summer",
    "Autumn",
    "Winter"
  ];
  var name3 = (t) => t < 9 ? `${t + 1}\u842C` : t < 18 ? `${t - 8}\u25AE` : t < 27 ? `${t - 17}\u25CF` : HONOUR_NAMES[t - 27] ?? "?";
  var tileHtml = (t, cls = "", attrs = "") => `<span class="tile ${cls}" data-t="${t}" ${attrs}><svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet">${face(t)}</svg></span>`;
  var WIND_CH = ["\u6771", "\u5357", "\u897F", "\u5317"];
  var AWARDS = {
    selfDraw: "\u81EA\u6478 Self-Draw",
    allChows: "\u5E73\u7CCA All Chows",
    allPungs: "\u5C0D\u5C0D\u7CCA All Pungs",
    halfFlush: "\u6DF7\u4E00\u8272 Half Flush",
    fullFlush: "\u6E05\u4E00\u8272 Full Flush",
    dragonPung: "\u4E09\u5143\u724C Dragon Pung",
    seatWind: "\u9580\u98A8 Seat Wind",
    roundWind: "\u5708\u98A8 Round Wind",
    ownFlower: "\u6B63\u82B1 Own Flower",
    ownSeason: "\u6B63\u82B1 Own Season",
    noFlowers: "\u7121\u82B1 No Flowers",
    concealedHand: "\u9580\u524D\u6E05 Concealed",
    winOnKongReplacement: "\u69D3\u4E0A\u958B\u82B1 Kong Flower",
    winOnLastTile: "\u6D77\u5E95\u6488\u6708 Last Tile",
    winOnLastDiscard: "\u6CB3\u5E95\u6488\u9B5A Last Discard",
    robbingKong: "\u6436\u69D3 Robbing the Kong",
    smallThreeDragons: "\u5C0F\u4E09\u5143 Small 3 Dragons",
    bigThreeDragons: "\u5927\u4E09\u5143 Big 3 Dragons",
    allTerminals: "\u6E05\u4E48\u4E5D All Terminals",
    allHonours: "\u5B57\u4E00\u8272 All Honours",
    mixedTerminals: "\u6DF7\u4E48\u4E5D Mixed Terminals",
    fourConcealedPungs: "\u56DB\u6697\u523B 4 Concealed Pungs",
    nineGates: "\u4E5D\u84EE\u5BF6\u71C8 Nine Gates",
    thirteenOrphans: "\u5341\u4E09\u4E48 13 Orphans",
    allKongs: "\u5341\u516B\u7F85\u6F22 All Kongs",
    bigFourWinds: "\u5927\u56DB\u559C Big 4 Winds",
    smallFourWinds: "\u5C0F\u56DB\u559C Small 4 Winds",
    allFlowers: "\u9F4A\u56DB\u82B1 All Flowers",
    allSeasons: "\u9F4A\u56DB\u5B63 All Seasons",
    winByDoubleKong: "\u69D3\u4E0A\u69D3 Double Kong"
  };
  var TABLES = [
    {
      id: "friendly",
      label: "Friendly table",
      seats: ["v0", "v0", "v1"],
      blurb: "Two beginners who never defend, and one loose claimer. Good for learning the flow."
    },
    {
      id: "mixed",
      label: "Mixed table",
      seats: ["v1", "persona", "v2"],
      blurb: "A maniac, an action player and a disciplined bot. The liveliest game."
    },
    {
      id: "sharks",
      label: "Sharks",
      seats: ["v4", "v4", "v4"],
      blurb: "Three copies of the strongest bot the training programme produced. It defends hard."
    },
    {
      id: "boss",
      label: "The champion + friends",
      seats: ["v4", "persona", "v2"],
      blurb: "The champion, an action player and a disciplined bot \u2014 the most human-feeling table."
    }
  ];
  var profileOf2 = (key) => ({ ...DEFAULT_PROFILE, ...window.BOTS?.[key] ?? {} });
  var BOT_NAMES = {
    v0: "Bo",
    v1: "Kwan",
    v2: "Ling",
    v3: "Fai",
    v4: "Sifu",
    persona: "Ming"
  };
  var HUMAN = 0;
  var TOSS_MS = 1300;
  var DRAW_MS = 900;
  var TOSS_SETTLED = 0.64;
  var AFTER_TOSS_MS = TOSS_MS * TOSS_SETTLED;
  var lastTossAt = -1e9;
  var queueBehindToss = () => Math.max(0, Math.round(lastTossAt + AFTER_TOSS_MS - performance.now()));
  var $ = (id) => document.getElementById(id);
  var state;
  var cfgs;
  var table = TABLES[1];
  var seed = 0;
  var pending2 = null;
  var busy = false;
  var feed = [];
  var pileTiles = [];
  var pileSeq = 0;
  var handSig = "";
  function rectCorners(p, w, h) {
    const c = Math.cos(p.rot * Math.PI / 180), s2 = Math.sin(p.rot * Math.PI / 180);
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({ x: p.x + x * c - y * s2, y: p.y + x * s2 + y * c }));
  }
  function hits(a, b, w, h) {
    const A = rectCorners(a, w, h), B = rectCorners(b, w, h);
    for (const poly of [A, B]) {
      for (let i = 0; i < 4; i++) {
        const p1 = poly[i], p2 = poly[(i + 1) % 4];
        const ax = -(p2.y - p1.y), ay = p2.x - p1.x;
        const pa = A.map((p) => p.x * ax + p.y * ay), pb = B.map((p) => p.x * ax + p.y * ay);
        if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
      }
    }
    return true;
  }
  var rec = JSON.parse(localStorage.getItem("mjrc.record") ?? '{"played":0,"won":0,"chips":0}');
  var SETTINGS = {
    rulesetId: "mjrc-standard",
    tileScale: 1,
    botMs: 420,
    dev: false,
    rounds: 1,
    recorded: true,
    hcCount: false,
    hcCalling: false,
    hcWhatIf: false,
    ...JSON.parse(localStorage.getItem("mjrc.settings") ?? "{}")
  };
  var saveSettings = () => {
    localStorage.setItem("mjrc.settings", JSON.stringify(SETTINGS));
    document.documentElement.style.setProperty("--tscale", String(SETTINGS.tileScale));
    document.body.classList.toggle("devmode", SETTINGS.dev);
  };
  var rules = () => ruleset(SETTINGS.rulesetId) ?? MJRC_STANDARD;
  var LENGTHS = [
    [1, "\u6771\u5708", "one wind", "~8 hands \xB7 10\u201315 min"],
    [2, "\u6771\u5357", "two winds", "~16 hands \xB7 20\u201330 min"],
    [3, "\u6771\u5357\u897F", "three winds", "~25 hands \xB7 35\u201350 min"],
    [4, "\u5168\u838A", "four winds", "~35 hands \xB7 50\u201370 min \xB7 a full sitting"]
  ];
  var RULE_PICKS = [
    ["mjrc-standard", "MJRC standard", "3\u201310 faan \xB7 flowers \xB7 doubling payments. The house game."],
    ["tvb-2026", "TVB Championship 2026", "1 faan minimum \xB7 no flowers \xB7 linear payments. Every hand is payable, and big hands barely out-earn small ones."]
  ];
  function readHand(without) {
    if (!state) return null;
    const v = viewFor(state, HUMAN);
    const R = rules();
    const tiles = [...v.hand, ...v.drawn !== null ? [v.drawn] : []];
    if (without !== void 0) {
      const k = tiles.indexOf(without);
      if (k < 0) return null;
      tiles.splice(k, 1);
    }
    const c = counts(tiles);
    const melds = v.melds[HUMAN].length;
    const seven = R.faanTable.sevenPairs !== void 0;
    const lt = liveTiles(c, melds, visibleCounts(v), seven);
    const ceiling = Math.min(faanCeiling(shapeOf(v), R), R.limitFaan);
    return {
      distance: lt.distance,
      calling: lt.distance <= 0,
      waits: lt.tiles.map((x) => ({ tile: x.tile, unseen: x.unseen })),
      total: lt.total,
      ceiling,
      payable: ceiling >= R.minimumFaan
    };
  }
  var WAIT_LIST_MAX = 6;
  var waitList = (r) => {
    if (r.waits.length === 0) return "nothing live";
    if (r.waits.length > WAIT_LIST_MAX) return `<b>${r.waits.length}</b> different tiles help`;
    return r.waits.map((w) => `<b>${name3(w.tile)}</b>&thinsp;<span class="n">${w.unseen}</span>`).join(" ");
  };
  function callingBar() {
    if (!SETTINGS.hcCalling || !state || overlay) return "";
    const r = readHand();
    if (!r) return "";
    const faan = r.payable ? `<span class="ok">can reach ${r.ceiling} faan</span>` : `<span class="warn">only ${r.ceiling} faan \u2014 under the ${rules().minimumFaan} minimum,
       this hand cannot be taken yet</span>`;
    return `<div id="callbar" class="${r.calling ? "calling" : ""}">
    ${r.calling ? `<b class="lead">CALLING \u807D\u724C</b> waiting on ${waitList(r)}
         <span class="tot">${r.total} live</span>` : `<b class="lead">${r.distance} away</b> from calling \xB7 helps: ${waitList(r)}
         <span class="tot">${r.total} live</span>`}
    <span class="faan">${faan}</span></div>`;
  }
  function whatIf(tile) {
    const r = readHand(tile);
    if (!r) return "";
    return r.calling ? `<b class="lead">cut ${name3(tile)} \u2192 CALLING</b> on ${waitList(r)}
       <span class="tot">${r.total} live</span>` : `<b class="lead">cut ${name3(tile)} \u2192 ${r.distance} away</b> \xB7 helps: ${waitList(r)}
       <span class="tot">${r.total} live</span>`;
  }
  function wireHover() {
    document.addEventListener("mouseover", (e) => {
      const el = e.target?.closest?.(".tile");
      if (!el?.dataset.t) return;
      const t = Number(el.dataset.t);
      if (SETTINGS.hcCount) {
        document.body.classList.add("counting");
        for (const o of Array.from(document.querySelectorAll(`.tile[data-t="${t}"]`))) {
          o.classList.add("samet");
        }
      }
      if (SETTINGS.hcWhatIf && el.closest("#myhand") && !overlay) {
        const bar = document.getElementById("callbar");
        if (bar) {
          bar.dataset.saved ??= bar.innerHTML;
          bar.innerHTML = whatIf(t);
          bar.classList.add("whatif");
        }
      }
    });
    document.addEventListener("mouseout", (e) => {
      const el = e.target?.closest?.(".tile");
      if (!el) return;
      document.body.classList.remove("counting");
      for (const o of Array.from(document.querySelectorAll(".tile.samet"))) {
        o.classList.remove("samet");
      }
      const bar = document.getElementById("callbar");
      if (bar?.dataset.saved) {
        bar.innerHTML = bar.dataset.saved;
        delete bar.dataset.saved;
        bar.classList.remove("whatif");
      }
    });
  }
  function deriveMatchStats(m) {
    const blank = () => ({ discards: 0, claims: 0, kongs: 0, flowers: 0, wins: 0, selfDraws: 0, fed: 0, faan: 0, best: 0 });
    const st = { seats: [blank(), blank(), blank(), blank()], hands: [], discards: 0, draws: 0 };
    let pending3 = { winner: null, selfDraw: false, from: null, faan: 0 };
    for (const raw of m.events) {
      const p = raw?.payload ?? {};
      switch (raw?.type) {
        case "discard": {
          const s2 = p.seat;
          st.seats[s2].discards++;
          st.discards++;
          break;
        }
        case "claimed": {
          const s2 = p.seat;
          st.seats[s2].claims++;
          if (p.kind === "kong") st.seats[s2].kongs++;
          break;
        }
        case "concealedKong":
        case "addedKong":
          st.seats[p.seat].kongs++;
          break;
        case "flowerReplacement":
          st.seats[p.seat].flowers++;
          break;
        case "winOnDiscard":
        case "selfDraw": {
          const ctx = p.context;
          const sc = p.score;
          const w = st.seats[ctx.seat];
          w.wins++;
          w.faan += sc.faan;
          w.best = Math.max(w.best, sc.faan);
          if (ctx.selfDraw) w.selfDraws++;
          else if (ctx.from !== null && ctx.from !== void 0) st.seats[ctx.from].fed++;
          pending3 = { winner: ctx.seat, selfDraw: ctx.selfDraw, from: ctx.from ?? null, faan: sc.faan };
          break;
        }
        case "exhaustiveDraw":
          st.draws++;
          break;
        case "handEnd":
          st.hands.push({ n: st.hands.length + 1, ...pending3, deltas: p.chipDeltas ?? [0, 0, 0, 0] });
          pending3 = { winner: null, selfDraw: false, from: null, faan: 0 };
          break;
      }
    }
    return st;
  }
  var seatNamesOf = (m) => ["You", ...m.seats.map((k) => BOT_NAMES[k] ?? k)];
  function matchScreen(m, back) {
    $("veil").style.display = "flex";
    const s2 = deriveMatchStats(m);
    const names2 = seatNamesOf(m);
    const chips = m.chips ?? [0, 0, 0, 0];
    const order = [0, 1, 2, 3].sort((a, b) => (chips[b] ?? 0) - (chips[a] ?? 0));
    const place = order.indexOf(HUMAN) + 1;
    const mins = m.finishedAt ? Math.round((m.finishedAt - m.startedAt) / 6e4) : null;
    $("panel").innerHTML = `
    <h1>${m.abandoned ? "Forfeited" : place === 1 ? "\u{1F3C6} You win" : `You finish ${place}${["st", "nd", "rd", "th"][place - 1]}`}</h1>
    <p class="mut">${m.rounds}-wind \xB7 ${m.tableId} table \xB7 ${m.rulesetId} \xB7
      ${m.hands} hands${mins !== null ? ` \xB7 ${mins} min` : ""} \xB7
      ${new Date(m.finishedAt ?? m.startedAt).toLocaleString()}</p>

    <h2 style="margin-top:14px">Final score</h2>
    <div class="rows head"><span class="c1">player</span><span class="c2">chips</span>
      <span class="c2">hands won</span><span class="c2">self-draw</span>
      <span class="c2">fed</span><span class="c2">best</span></div>
    <div class="rows">${order.map((i, r) => {
      const q = s2.seats[i];
      return `<div class="row ${i === HUMAN ? "me" : ""}">
        <span class="c1">${r + 1}. ${names2[i]}</span>
        <span class="c2 ${(chips[i] ?? 0) > 0 ? "up" : (chips[i] ?? 0) < 0 ? "down" : ""}">${fmtChips(chips[i] ?? 0)}</span>
        <span class="c2">${q.wins}</span><span class="c2">${q.selfDraws}</span>
        <span class="c2">${q.fed}</span><span class="c2">${q.best || "\u2014"}</span></div>`;
    }).join("")}</div>

    <h2 style="margin-top:14px">At the table</h2>
    <div class="rows head"><span class="c1">player</span><span class="c2">discards</span>
      <span class="c2">claims</span><span class="c2">kongs</span><span class="c2">flowers</span></div>
    <div class="rows">${[0, 1, 2, 3].map((i) => {
      const q = s2.seats[i];
      return `<div class="row ${i === HUMAN ? "me" : ""}"><span class="c1">${names2[i]}</span>
        <span class="c2">${q.discards}</span><span class="c2">${q.claims}</span>
        <span class="c2">${q.kongs}</span><span class="c2">${q.flowers}</span></div>`;
    }).join("")}</div>
    <p class="mut">${s2.discards} tiles thrown in all \xB7 ${s2.draws} hand${s2.draws === 1 ? "" : "s"} ended \u6D41\u5C40.</p>

    ${s2.hands.length === 0 ? "" : `
    <h2 style="margin-top:14px">Hand by hand</h2>
    <div class="rows">${s2.hands.map((h) => `
      <div class="row"><span class="c1">${h.n}. ${h.winner === null ? '<span class="mut">\u6D41\u5C40 \u2014 nobody wins</span>' : `${names2[h.winner]} ${h.selfDraw ? "\u81EA\u6478" : h.from === HUMAN ? "on YOUR discard" : h.from !== null ? `off ${names2[h.from]}` : "\u98DF\u7CCA"} \xB7 <b>${h.faan} faan</b>`}</span>
        <span class="c2 ${(h.deltas[0] ?? 0) > 0 ? "up" : (h.deltas[0] ?? 0) < 0 ? "down" : ""}">${h.deltas[0] ? fmtChips(h.deltas[0]) : "\u2014"}</span></div>`).join("")}</div>`}

    ${m.movesGraded === 0 ? "" : `
    <h2 style="margin-top:14px">How you played it</h2>
    <div class="statgrid">
      <div><span>${fmtPct(m.matchRate)}</span>engine agreement</div>
      <div><span>${m.meanGap === null ? "\u2014" : m.meanGap.toFixed(2)}</span>mean gap</div>
      <div><span>${m.movesGraded}</span>decisions graded</div>
    </div>`}
    ${backRow(back)}`;
    wireBack(back);
  }
  async function showSync() {
    const el = document.getElementById("syncLine");
    if (!el) return;
    const left = await pending(store_exports);
    el.textContent = left === 0 ? "all games sent" : `${left} waiting to send\u2026`;
    if (left === 0) return;
    const r = await drain(store_exports);
    const now = await pending(store_exports);
    el.textContent = now === 0 ? `sent ${r.matches + r.feedback}` : `${now} still to send${r.why ? ` (${r.why})` : ""} \u2014 they will go next time`;
  }
  var fmtPct = (x) => x === null ? "\u2014" : `${Math.round(x * 100)}%`;
  var fmtChips = (n) => `${n > 0 ? "+" : ""}${n}`;
  function aggregate(rows) {
    const a = {
      matches: 0,
      finished: 0,
      abandoned: 0,
      hands: 0,
      won: 0,
      selfDrawn: 0,
      fed: 0,
      drawnHands: 0,
      chips: 0,
      graded: 0,
      matched: 0,
      gapSum: 0,
      seatWins: [0, 0, 0, 0],
      seatGames: 0
    };
    for (const m of rows) {
      a.matches++;
      if (m.abandoned) a.abandoned++;
      else if (m.finishedAt) a.finished++;
      a.hands += m.hands;
      a.won += m.won;
      a.selfDrawn += m.selfDrawn;
      a.fed += m.fed;
      a.drawnHands += m.drawnHands;
      a.chips += m.chips[0] ?? 0;
      a.graded += m.movesGraded;
      if (m.matchRate !== null) a.matched += m.matchRate * m.movesGraded;
      if (m.meanGap !== null) a.gapSum += m.meanGap * m.movesGraded;
      for (let i = 0; i < 4; i++) a.seatWins[i] += m.seatWins[i] ?? 0;
      a.seatGames++;
    }
    return a;
  }
  function aboutScreen(back) {
    $("veil").style.display = "flex";
    $("panel").classList.add("about");
    $("panel").innerHTML = `
    <h1>A demo, not a game yet</h1>
    <p>A playable Hong Kong Old Style table against three bots. It exists so we
    can find out what breaks before any of it is finished \u2014 so play a hand or
    two and tell us what felt wrong.</p>

    <h2>What we are testing</h2>
    <ul class="about">
      <li><b>The bots</b> \u2014 do they play like people, and can you beat them?</li>
      <li><b>The rules</b> \u2014 legality, scoring, the 3-faan floor, the calls.</li>
      <li><b>The feel</b> \u2014 pacing, animation, whether a turn reads clearly.</li>
    </ul>

    <h2>The bots are the part we have spent the most time on</h2>
    <p>They came out of a long training programme: five eras of evolution, each
    era's champion frozen and made the next era's opponent, so the difficulty on
    the table picker is a <b>measured</b> quantity rather than a guess. Sifu is
    the strongest one that programme produced.</p>
    <p class="mut">They still have gaps we know about \u2014 they will not chase
    \u4E03\u5C0D\u5B50, for one. If one plays a hand that looks foolish, that is worth
    telling us about.</p>

    <h2>The look will change</h2>
    <p>Treat the interface as a sketch. Notes on it are welcome, but expect most
    of it to be redrawn.</p>

    <h2>Later</h2>
    <p>Playing against each other rather than against bots.</p>

    <h2>Your games are recorded</h2>
    <p>Every match, every decision we grade, and every note you send goes to our
    server. That is the point of the demo: we want to know how the bots hold up
    against real people, and the whole training programme was bots against bots
    \u2014 the comparison has never been made.</p>
    <p class="mut">No account and no email. Just the name you typed, which you
    can change whenever you like.</p>

    <p>The <b>\u270E feedback</b> button is on every screen, and it attaches whatever
    you were looking at \u2014 the hand, the seed, the last few plays \u2014 so a report
    can be replayed rather than guessed at.</p>
    <button id="btnAbout">got it \u25B8</button>`;
    $("btnAbout").onclick = () => {
      $("panel").classList.remove("about");
      $("veil").style.display = "none";
      back();
    };
  }
  function lobbyScreen() {
    overlay = null;
    $("veil").style.display = "flex";
    $("panel").innerHTML = `
    <h1>\u9999\u6E2F\u9EBB\u96C0 \xB7 MJRC</h1>
    <p class="mut">Playing as <b>${player?.name ?? "\u2014"}</b> \xB7
      <a href="#" id="btnRename" style="color:var(--gold)">change name</a></p>
    <div class="choices lobby" style="margin-top:16px">
      <div class="choice" id="goPlay"><b>Play \u25B8</b><span>Pick a length and a table, then sit down.</span></div>
      <div class="choice" id="goStats"><b>Your games</b><span>Every match you have played, and how close to the engine you played it.</span></div>
      <div class="choice" id="goBoard"><b>Leaderboard</b><span>How your games compare.</span></div>
    </div>
    <div id="lobbySum" class="mut" style="margin-top:14px">\u2026</div>
    <p class="mut"><a href="#" id="btnAbout2" style="color:var(--gold)">what is this?</a>
      \xB7 <span id="syncLine">\u2026</span></p>`;
    $("goPlay").onclick = () => startScreen();
    $("goStats").onclick = () => statsScreen();
    $("goBoard").onclick = () => boardScreen();
    $("btnRename").onclick = (e) => {
      e.preventDefault();
      nameScreen(lobbyScreen);
    };
    $("btnAbout2").onclick = (e) => {
      e.preventDefault();
      aboutScreen(lobbyScreen);
    };
    void showSync();
    void allMatches().then((rows) => {
      const mine = rows.filter((m) => m.playerId === player?.id);
      const a = aggregate(mine);
      const el = document.getElementById("lobbySum");
      if (!el) return;
      el.innerHTML = a.matches === 0 ? "No games yet. Everything you play is recorded so we can see how the bots hold up." : `<b>${a.matches}</b> games \xB7 <b>${a.hands}</b> hands \xB7 <b>${a.won}</b> hands won \xB7
         lifetime <b>${fmtChips(a.chips)}</b> chips \xB7
         engine agreement <b>${fmtPct(a.graded ? a.matched / a.graded : null)}</b>`;
    });
  }
  function backRow(to) {
    return `<button id="btnLobby" style="margin-top:16px">\u25C2 back to lobby</button>`;
  }
  var wireBack = (to) => {
    const b = document.getElementById("btnLobby");
    if (b) b.onclick = () => to();
  };
  function statsScreen() {
    $("veil").style.display = "flex";
    $("panel").innerHTML = `<h1>Your games</h1><p class="mut">reading\u2026</p>`;
    void Promise.all([allMatches(), usage()]).then(([rows, use]) => {
      const mine = rows.filter((m) => m.playerId === player?.id).sort((x, y) => (y.finishedAt ?? y.startedAt) - (x.finishedAt ?? x.startedAt));
      const a = aggregate(mine);
      const rate = a.graded ? a.matched / a.graded : null;
      const gap = a.graded ? a.gapSum / a.graded : null;
      $("panel").innerHTML = `
      <h1>Your games</h1>
      ${mine.length === 0 ? "<p>Nothing recorded yet.</p>" : `
      <div class="statgrid">
        <div><span>${a.matches}</span>games</div>
        <div><span>${a.hands}</span>hands</div>
        <div><span>${a.won}</span>hands won</div>
        <div><span>${fmtChips(a.chips)}</span>chips</div>
        <div><span>${fmtPct(rate)}</span>engine agreement</div>
        <div><span>${gap === null ? "\u2014" : gap.toFixed(2)}</span>mean gap</div>
      </div>
      <p class="mut" style="margin-top:8px">
        <b>Engine agreement</b> is how often you played the champion's own top choice \u2014
        ${a.graded} decisions graded. It measures closeness to the bot, not correctness:
        the bot is the strongest one the training programme produced, not a solved game.
        <b>Mean gap</b> is what your choices cost in its scoring units; lower is closer.</p>
      <p class="mut">You fed ${a.fed} winning discards \xB7 self-drew ${a.selfDrawn} \xB7
        ${a.drawnHands} hands ended \u6D41\u5C40 \xB7 ${a.abandoned} game(s) abandoned.</p>
      <h2 style="margin-top:14px">Match by match</h2>
      <div class="rows">${mine.slice(0, 40).map((m, k) => `
        <div class="row click" data-k="${k}">
          <span class="c1">${new Date(m.finishedAt ?? m.startedAt).toLocaleDateString()} \xB7
            ${m.rounds}-wind \xB7 ${m.tableId}${m.abandoned ? ' \xB7 <b style="color:var(--danger)">forfeit</b>' : ""}</span>
          <span class="c2">${m.hands}h</span>
          <span class="c2 ${(m.chips[0] ?? 0) > 0 ? "up" : (m.chips[0] ?? 0) < 0 ? "down" : ""}">${fmtChips(m.chips[0] ?? 0)}</span>
          <span class="c2">${fmtPct(m.matchRate)}</span>
        </div>`).join("")}</div>
      <p class="mut" style="margin-top:10px">Tap a match to see how it went.
        ${use.matches} matches stored, about ${Math.round(use.approxBytes / 1024)} KB.
        Sent to us as you play, so we can see how the bots do against real people.</p>`}
      ${backRow(lobbyScreen)}`;
      for (const el of Array.from($("panel").querySelectorAll(".row.click"))) {
        el.onclick = () => {
          const m = mine[Number(el.dataset.k)];
          if (m) matchScreen(m, statsScreen);
        };
      }
      wireBack(lobbyScreen);
    });
  }
  var boardSort = "wins";
  function localStandings(rows) {
    const counted = rows.filter((m) => m.recorded && !m.abandoned && m.finishedAt !== null);
    const byPlayer = /* @__PURE__ */ new Map();
    for (const m of counted) {
      const e = byPlayer.get(m.playerId) ?? { name: m.playerName, rows: [] };
      e.name = m.playerName;
      e.rows.push(m);
      byPlayer.set(m.playerId, e);
    }
    return [...byPlayer.values()].map((e) => {
      const a = aggregate(e.rows);
      const wins = e.rows.filter((m) => {
        const c = m.chips ?? [0, 0, 0, 0];
        return (c[0] ?? 0) >= Math.max(...c.slice(1).map((x) => x ?? 0));
      }).length;
      return {
        name: e.name,
        games: a.matches,
        wins,
        hands: a.hands,
        handsWon: a.won,
        chips: a.chips,
        net: a.hands ? a.chips / a.hands : 0,
        rate: a.graded ? a.matched / a.graded : null
      };
    });
  }
  async function fetchStandings() {
    try {
      const url = new URL("api/board", new URL(".", location.href)).toString();
      const r = await fetch(url, { credentials: "same-origin" });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      if (!Array.isArray(body.players)) throw new Error("shape");
      return { table: body.players, games: body.games ?? [], shared: true };
    } catch {
      return { table: localStandings(await allMatches()), games: [], shared: false };
    }
  }
  function boardScreen() {
    $("veil").style.display = "flex";
    $("panel").innerHTML = `<h1>Leaderboard</h1><p class="mut">reading\u2026</p>`;
    void fetchStandings().then(({ table: table2, games, shared }) => {
      const key = (r) => boardSort === "wins" ? r.wins : boardSort === "hands" ? r.hands : boardSort === "chips" ? r.chips : boardSort === "net" ? r.net : r.rate ?? -1;
      table2.sort((x, y) => key(y) - key(x) || y.hands - x.hands);
      const COLS = [
        ["wins", "wins"],
        ["hands", "hands"],
        ["chips", "chips"],
        ["net", "net/hd"],
        ["rate", "agree"]
      ];
      $("panel").innerHTML = `
      <h1>Leaderboard</h1>
      <p class="mut">Sorted by <b>${COLS.find((c) => c[0] === boardSort)[1]}</b> \u2014
        tap a heading to change it. None of these is the whole picture: wins and
        chips are what you feel but carry most of the luck (\xB116 chips of noise in a
        single block), while agreement scores every decision rather than the few
        that ended in a payout.</p>
      ${table2.length === 0 ? "<p>No completed recorded games yet.</p>" : `
      <div class="rows head"><span class="c1">player</span>${COLS.map(([k, label]) => `<span class="c2 sortable ${boardSort === k ? "on" : ""}" data-k="${k}">${label}</span>`).join("")}</div>
      <div class="rows">${table2.map((r, i) => `
        <div class="row ${r.name === player?.name ? "me" : ""}">
          <span class="c1">${i + 1}. ${r.name} <span class="mut">\xB7 ${r.games}g</span></span>
          <span class="c2">${r.wins}</span>
          <span class="c2">${r.hands}</span>
          <span class="c2 ${r.chips > 0 ? "up" : r.chips < 0 ? "down" : ""}">${fmtChips(r.chips)}</span>
          <span class="c2 ${r.net > 0 ? "up" : r.net < 0 ? "down" : ""}">${r.net.toFixed(1)}</span>
          <span class="c2">${fmtPct(r.rate)}</span>
        </div>`).join("")}</div>`}
      <p class="mut" style="margin-top:10px">The standings exclude forfeits and casual games.
        ${shared ? "Counted on the server across every tester \u2014 your last match appears once it has uploaded." : "<b>Offline</b> \u2014 showing only what this device has played. The shared board needs a connection."}</p>
      ${games.length === 0 ? "" : `
      <h2 style="margin-top:16px">Every game played</h2>
      <p class="mut">All of them, including the ones the standings leave out \u2014 a
        quit match is still data, and it is usually the most interesting kind.</p>
      <div class="rows">${games.map((g) => `
        <div class="row ${g.name === player?.name ? "me" : ""}">
          <span class="c1">${g.name}
            <span class="mut">\xB7 ${g.rounds}-wind \xB7 ${g.hands} hand${g.hands === 1 ? "" : "s"}${g.quit ? " \xB7 <b>quit</b>" : ""}${g.casual ? " \xB7 casual" : ""}</span></span>
          <span class="c2">${g.won}w</span>
          <span class="c2 ${g.chips > 0 ? "up" : g.chips < 0 ? "down" : ""}">${fmtChips(g.chips)}</span>
          <span class="c2">${fmtPct(g.rate)}</span>
        </div>`).join("")}</div>`}
      ${backRow(lobbyScreen)}`;
      for (const h of Array.from($("panel").querySelectorAll(".sortable"))) {
        h.onclick = () => {
          boardSort = h.dataset.k;
          boardScreen();
        };
      }
      wireBack(lobbyScreen);
    });
  }
  function nameScreen(then) {
    $("veil").style.display = "flex";
    $("panel").innerHTML = `
    <h1>\u9999\u6E2F\u9EBB\u96C0 \xB7 MJRC</h1>
    <p>What should we call you? This is a private beta \u2014 every game you play is
    recorded and sent to us, so we can see how the bots hold up against real
    people. That comparison has never been made: the bots were trained entirely
    against each other.</p>
    <div class="setrow" style="margin-top:14px">
      <input id="nameIn" type="text" maxlength="24" placeholder="your name"
        value="${(player?.name ?? "").replace(/"/g, "&quot;")}"
        style="flex:1;padding:9px 12px;font-size:16px;border-radius:9px;
               background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);color:var(--ink)">
    </div>
    <p class="mut" id="nameNote">Your games are sent to us so we can see how the bots hold up
      against real people. No account, no email \u2014 just this name.</p>
    <button id="btnName">continue \u25B8</button>`;
    const input = document.getElementById("nameIn");
    const go = async () => {
      const nm = input.value.trim();
      if (!nm) {
        input.focus();
        return;
      }
      player = await setPlayerName(nm);
      then();
    };
    $("btnName").onclick = () => void go();
    input.onkeydown = (e) => {
      if (e.key === "Enter") void go();
    };
    input.focus();
    void available().then((a) => {
      if (!a.ok) $("nameNote").innerHTML = `<b style="color:var(--danger)">This browser will not let us store anything</b>, so nothing
       can be recorded \u2014 the game still plays. (${a.why || "IndexedDB unavailable"})`;
    });
  }
  function startScreen() {
    $("veil").style.display = "flex";
    $("panel").innerHTML = `
    <h1>Sit down</h1>

    <h2>Length</h2>
    <div class="seg">${LENGTHS.map(([n, ch, en]) => `
      <button class="${SETTINGS.rounds === n ? "on" : ""}" data-len="${n}">
        <b>${ch}</b><span>${en}</span></button>`).join("")}</div>
    <p class="segcap">${LENGTHS.find(([n]) => n === SETTINGS.rounds)?.[3] ?? ""}</p>

    <h2>Rules</h2>
    <div class="choices two">${RULE_PICKS.map(([id, label, blurb]) => `
      <div class="choice ${SETTINGS.rulesetId === id ? "sel" : ""}" data-r="${id}">
        <b>${label}</b><span>${blurb}</span></div>`).join("")}</div>

    <h2>Table</h2>
    <div class="choices two">${TABLES.map((t) => `
      <div class="choice ${t.id === table.id ? "sel" : ""}" data-t="${t.id}">
        <b>${t.label}</b><span>${t.blurb}</span>
        <span class="seats">${t.seats.map((x) => BOT_NAMES[x] ?? x).join(" \xB7 ")}</span>
      </div>`).join("")}</div>

    <div class="setrow" style="margin-top:12px">
      <label>Record this game</label>
      <input type="checkbox" id="setRec" ${SETTINGS.recorded ? "checked" : ""}>
      <span class="mut">counts for your stats \xB7 quitting is recorded as a forfeit</span>
    </div>
    <p class="mut">Playing as <b>${player?.name ?? "\u2014"}</b> \xB7
      <a href="#" id="btnRename" style="color:var(--gold)">change name</a></p>
    <button id="btnStart">sit down \u25B8</button>
    <button id="btnLobby" style="margin-left:8px;background:rgba(255,255,255,.08)">\u25C2 lobby</button>`;
    for (const el of Array.from($("panel").querySelectorAll(".seg button"))) {
      el.onclick = () => {
        SETTINGS.rounds = Number(el.dataset.len);
        saveSettings();
        startScreen();
      };
    }
    for (const el of Array.from($("panel").querySelectorAll(".choice"))) {
      el.onclick = () => {
        if (el.dataset.r) SETTINGS.rulesetId = el.dataset.r;
        else table = TABLES.find((t) => t.id === el.dataset.t);
        saveSettings();
        startScreen();
      };
    }
    const rcx = document.getElementById("setRec");
    if (rcx) rcx.onchange = () => {
      SETTINGS.recorded = rcx.checked;
      saveSettings();
    };
    const ren = document.getElementById("btnRename");
    if (ren) ren.onclick = (e) => {
      e.preventDefault();
      nameScreen(startScreen);
    };
    wireBack(lobbyScreen);
    $("btnStart").onclick = () => newMatch();
  }
  function newMatch() {
    seed = Math.floor(Math.random() * 2 ** 31);
    const R = rules();
    beginRecord();
    const r = startMatch({ seed, ruleset: R, matchLength: SETTINGS.rounds });
    state = r.state;
    cfgs = [0, 1, 2, 3].map((i) => ({
      ruleset: R,
      profile: i === HUMAN ? DEFAULT_PROFILE : profileOf2(table.seats[i - 1]),
      rnd: prng((seed ^ (i + 1) * 2654435761) >>> 0)
    }));
    feed.length = 0;
    pileTiles = [];
    handSig = "";
    devBotLines = [];
    $("say").className = "";
    coachLog.length = 0;
    $("veil").style.display = "none";
    $("hudTable").textContent = table.label + " \u2014 " + table.seats.map((s) => BOT_NAMES[s] ?? s).join(", ");
    consume(r.events);
    advance();
    buildWall2();
  }
  var player = null;
  var rc = null;
  var lastMatch = null;
  var rcMoves = [];
  var rcGraded = 0;
  var rcMatched = 0;
  var rcGapSum = 0;
  var humanTurns = 0;
  function beginRecord() {
    humanTurns = 0;
    rcMoves = [];
    rcGraded = 0;
    rcMatched = 0;
    rcGapSum = 0;
    const id = crypto.randomUUID();
    rc = {
      id,
      playerId: player?.id ?? "anonymous",
      playerName: player?.name ?? "anonymous",
      rounds: SETTINGS.rounds,
      rulesetId: rules().id,
      seats: [...table.seats],
      tableId: table.id,
      seed,
      recorded: SETTINGS.recorded,
      abandoned: false,
      startedAt: Date.now(),
      finishedAt: null,
      chips: [0, 0, 0, 0],
      hands: 0,
      won: 0,
      selfDrawn: 0,
      fed: 0,
      drawnHands: 0,
      seatWins: [0, 0, 0, 0],
      matchRate: null,
      meanGap: null,
      movesGraded: 0,
      events: [],
      actions: []
    };
    lastMatch = { id, hand: 0, label: `${SETTINGS.rounds}-wind game vs ${table.label}` };
  }
  function recordMove(m) {
    rcMoves.push(m);
    rcGraded++;
    if (m.gap <= 1e-4) rcMatched++;
    rcGapSum += m.gap;
  }
  function summariseMoves() {
    if (!rc) return;
    rc.movesGraded = rcGraded;
    if (rcGraded === 0) {
      rc.matchRate = null;
      rc.meanGap = null;
      return;
    }
    rc.matchRate = rcMatched / rcGraded;
    rc.meanGap = rcGapSum / rcGraded;
  }
  function flushRecord() {
    if (!rc) return;
    summariseMoves();
    rc.chips = [0, 1, 2, 3].map((i) => state?.seats[i]?.chips ?? 0);
    void putMatch({ ...rc, events: [...rc.events], actions: [...rc.actions] });
    void putMoves(rcMoves.splice(0));
  }
  var overlay = null;
  function consume(events) {
    if (rc) rc.events.push(...events);
    for (const e of events) {
      const p = e.payload ?? {};
      const who = (s) => s === HUMAN ? "You" : BOT_NAMES[table.seats[s - 1]] ?? "Bot";
      switch (e.type) {
        case "discard":
          pileTiles.push({ id: ++pileSeq, tile: p.tile, seat: p.seat });
          feed.push(`${who(p.seat)} discards ${name3(p.tile)}`);
          sayDiscard(p.tile, p.seat);
          break;
        case "claimed": {
          armGrab(
            p.tile,
            p.seat,
            pileTiles[pileTiles.length - 1]?.pos?.rot ?? 0
          );
          landingMeld = { seat: p.seat, index: state.seats[p.seat].melds.length - 1 };
          pileTiles.pop();
          const verb = p.kind === "chow" ? "chows \u4E0A" : p.kind === "pung" ? "pungs \u78B0" : "kongs \u69D3";
          feed.push(`${who(p.seat)} ${verb} ${name3(p.tile)}`);
          announce(p.kind, who(p.seat), name3(p.tile), p.seat);
          break;
        }
        case "concealedKong":
          feed.push(`${who(p.seat)} declares a concealed kong \u6697\u69D3`);
          announce("concealedKong", who(p.seat), "", p.seat);
          break;
        case "addedKong":
          feed.push(`${who(p.seat)} adds a kong \u52A0\u69D3`);
          announce("addedKong", who(p.seat), "", p.seat);
          break;
        case "flowerReplacement":
          feed.push(`${who(p.seat)} reveals ${name3(p.flower)} \u82B1`);
          if (state.handsPlayed !== void 0 && pileTiles.length > 0) announce("flower", who(p.seat), name3(p.flower), p.seat);
          break;
        case "refusedWin":
          if (p.context.seat === HUMAN)
            feed.push(`Your hand completes but holds only ${p.score.faan} faan \u2014 under the 3-faan floor`);
          break;
        case "winOnDiscard":
        case "selfDraw": {
          const ctx = p.context;
          if (rc) {
            rc.seatWins[ctx.seat]++;
            if (ctx.seat === HUMAN) {
              rc.won++;
              if (ctx.selfDraw) rc.selfDrawn++;
            } else if (ctx.from === HUMAN) rc.fed++;
          }
          const sc = p.score;
          const mine = ctx.seat === HUMAN;
          announce(ctx.selfDraw ? "selfDraw" : "win", mine ? "You" : who(ctx.seat), `${sc.faan} faan`, ctx.seat);
          const tiles = [...p.concealed ?? []].sort((a, b) => a - b);
          const melds = p.melds ?? [];
          overlay = `<h1>${mine ? "You win! \u98DF\u7CCA" : who(ctx.seat) + " wins"}</h1>
          <h2>${sc.faan} faan \xB7 ${ctx.selfDraw ? "\u81EA\u6478 self-draw" : ctx.from === HUMAN ? "off YOUR discard" : "\u98DF\u7CCA on a discard"}</h2>
          <div class="tiles">${tiles.map((t) => tileHtml(t, "sm")).join("")}
            ${melds.map((m) => `<span style="width:8px"></span>` + m.tiles.map((t) => tileHtml(t, "sm")).join("")).join("")}</div>
          <div class="awards">${sc.awards.map((a) => `${AWARDS[a.id] ?? a.id} <b>${a.faan}</b>`).join(" &nbsp;\xB7&nbsp; ")}</div>`;
          break;
        }
        case "exhaustiveDraw":
          if (rc) rc.drawnHands++;
          overlay = `<h1>\u6D41\u5C40</h1><h2>The wall ran out \u2014 nobody wins</h2>`;
          break;
        case "handEnd": {
          if (rc) {
            rc.hands++;
            flushRecord();
          }
          if (lastMatch) lastMatch.hand = state.handIndex;
          const st = p.standings;
          const d = p.chipDeltas;
          overlay = (overlay ?? "") + `<div class="pay">${[0, 1, 2, 3].map((i) => `
          <div>${i === HUMAN ? "You" : who(i)}<br>
            <span class="d ${d && d[i] > 0 ? "up" : d && d[i] < 0 ? "down" : ""}">${d ? (d[i] > 0 ? "+" : "") + d[i] : ""}</span>
            <span style="opacity:.6"> \u2192 ${st[i]}</span></div>`).join("")}</div>
          <button id="btnNext">next hand \u25B8</button>`;
          break;
        }
        case "matchEnd": {
          const st = p.standings;
          const order = [0, 1, 2, 3].sort((a, b) => st[b] - st[a]);
          const place = order.indexOf(HUMAN) + 1;
          rec.played++;
          if (place === 1) rec.won++;
          rec.chips += st[HUMAN];
          localStorage.setItem("mjrc.record", JSON.stringify(rec));
          if (rc) {
            rc.finishedAt = Date.now();
            flushRecord();
            endedMatch = { ...rc, chips: [...rc.chips], events: [...rc.events] };
            void drain(store_exports);
          }
          break;
        }
      }
    }
    if (feed.length > 8) feed.splice(0, feed.length - 8);
  }
  var SUITG = ["\u842C", "\u7D22", "\u7B52"];
  function routeName(r) {
    if (r.orphans) return "13 orphans";
    if (r.honoursOnly) return "all honours";
    if (r.suit !== null) return (r.pungs ? "pung-flush " : "flush ") + (r.suit === "chars" ? "\u842C" : r.suit === "bamboo" ? "\u7D22" : "\u7B52");
    return r.pungs ? "all pungs" : "balanced";
  }
  var devBotLines = [];
  function noteBotThinking(seat) {
    if (!SETTINGS.dev) return;
    const v = viewFor(state, seat);
    const R = rules();
    const threats = tableThreat(v, R);
    const routes = assessRoutes(shapeOf(v), R, cfgs[seat].profile, threats).filter((r) => r.feasible && Number.isFinite(r.score)).sort((a, b) => b.score - a.score).slice(0, 2);
    const who = BOT_NAMES[table.seats[seat - 1]] ?? "Bot";
    const reads = threats.seats.filter((t) => t.threat > 0.25).sort((a, b) => b.threat - a.threat).slice(0, 2).map((t) => `${t.seat === HUMAN ? "YOU" : BOT_NAMES[table.seats[t.seat - 1]] ?? "?"} ${t.threat.toFixed(2)}` + (t.intentSuit !== null ? `/${SUITG[t.intentSuit]}` : ""));
    devBotLines.unshift(`<b>${who}</b> ${routes.map((r, i) => `${i === 0 ? "\u25B8" : ""}${routeName(r.route)} <span class="mut">${Math.min(r.faan, 13)}f \xB7 ${Math.max(0, r.distance)} away</span>`).join(" \xB7 ")}` + (reads.length ? `<div class="mut">fears ${reads.join(" \xB7 ")}</div>` : ""));
    if (devBotLines.length > 5) devBotLines.length = 5;
  }
  var coachLog = [];
  var coachCfg = (v) => ({ ruleset: rules(), profile: scoreAdjust(profileOf2("v4"), v), rnd: prng(7) });
  var verdictHtml = (cls, grade, head, why = "") => `<div class="ce ${cls}"><span class="g">${grade}</span>${head}${why ? `<div class="mut">${why}</div>` : ""}</div>`;
  function gradeMyDiscard(tile) {
    const v = viewFor(state, HUMAN);
    const cfg = coachCfg(v);
    const ranked = [...rankDiscards(v, cfg)].sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const mine = ranked.find((d) => d.tile === tile);
    if (!best || !mine) return;
    const gap = best.score - mine.score;
    const rank = ranked.indexOf(mine) + 1;
    const cls = tile === best.tile || gap < 0.6 ? "good" : gap < 2.2 ? "ok" : "bad";
    const verdict = tile === best.tile ? "best discard" : gap < 0.6 ? "fine \u2014 within a hair of the best" : gap < 2.2 ? `#${rank} of ${ranked.length} \u2014 champion cuts ${name3(best.tile)}` : `costly \u2014 champion cuts ${name3(best.tile)}`;
    const why = mine.distance > best.distance ? `slower: ${mine.distance} away vs ${best.distance}` : mine.danger - best.danger > 0.8 ? `riskier: danger ${mine.danger.toFixed(1)} vs ${best.danger.toFixed(1)}` : !mine.onRoute && best.onRoute ? "off your best route" : "";
    recordMove({
      matchId: rc?.id ?? "",
      hand: state.handIndex,
      turn: humanTurns++,
      kind: "discard",
      played: name3(tile),
      enginePick: name3(best.tile),
      gap,
      top1MinusTop2: ranked.length > 1 ? best.score - ranked[1].score : 0,
      reason: why
    });
    if (!SETTINGS.dev) return;
    coachLog.unshift(verdictHtml(
      cls,
      cls === "good" ? "GOOD" : cls === "ok" ? "OK" : "BAD",
      `<b>${name3(tile)}</b> \u2014 ${verdict}`,
      why
    ));
    if (coachLog.length > 24) coachLog.length = 24;
  }
  var CLAIM_LABEL = (o) => o.kind === "pung" ? "pung \u78B0" : o.kind === "kong" ? "kong \u69D3" : `chow \u4E0A ${(o.with ?? []).map(name3).join("+")}`;
  var REFUSAL = {
    faanFloor: "it leaves no path to the faan floor \u2014 an unpayable hand is a dead one",
    offRoute: "it is off the route your hand is playing",
    concealedRoute: "it kills the concealed hand you are building",
    tooSlow: "it buys too little speed for what it exposes"
  };
  var sameClaim = (a, b) => a.kind === b.kind && (a.with ?? []).join() === (b.with ?? []).join();
  var myClaims = () => (pending2 ?? []).flatMap((a) => a.type === "claim" && a.option.kind !== "win" ? [a.option] : []);
  function claimAdvice() {
    const options = myClaims();
    if (options.length === 0) return "";
    const v = viewFor(state, HUMAN);
    const cfg = coachCfg(v);
    const ctx = claimContext(v, cfg);
    const want = claimDecision(v, options, coachCfg(v));
    const rows = options.map((o) => {
      const a = assessClaim(v, o, cfg, ctx);
      const take = want !== null && sameClaim(want, o);
      return verdictHtml(
        take ? "good" : "bad",
        take ? "TAKE" : "SKIP",
        `<b>${CLAIM_LABEL(o)}</b>`,
        a.reason === "accepted" ? `${a.distanceBefore} \u2192 ${a.distanceAfter} from ready, worth up to ${a.faanCeiling} faan` : REFUSAL[a.reason] ?? a.reason
      );
    });
    if (want === null) rows.push(verdictHtml("good", "TAKE", "<b>pass</b>", "the champion claims nothing here"));
    return rows.join("");
  }
  function gradeMyClaim(action) {
    const v = viewFor(state, HUMAN);
    const cfg = coachCfg(v);
    if (action.type === "concealedKong" || action.type === "addedKong") {
      const form = action.type === "concealedKong" ? "concealed" : "added";
      const yes = shouldKong(v, action.tile, form, coachCfg(v));
      recordMove({
        matchId: rc?.id ?? "",
        hand: state.handIndex,
        turn: humanTurns++,
        kind: "kong",
        played: `kong ${name3(action.tile)}`,
        enginePick: yes ? `kong ${name3(action.tile)}` : "hold",
        gap: yes ? 0 : 1,
        top1MinusTop2: 0,
        reason: yes ? "" : "the champion holds it"
      });
      if (!SETTINGS.dev) return;
      coachLog.unshift(verdictHtml(
        yes ? "good" : "ok",
        yes ? "GOOD" : "OK",
        `<b>kong ${name3(action.tile)}</b> \u2014 ${yes ? "the champion lays this too" : "the champion holds it"}`,
        yes ? "" : "a kong fixes four tiles into one set slot, and an added kong opens a \u6436\u69D3 window"
      ));
      if (coachLog.length > 24) coachLog.length = 24;
      return;
    }
    const options = myClaims();
    if (options.length === 0) return;
    if (action.type === "declareWin" || action.type === "claim" && action.option.kind === "win") return;
    const ctx = claimContext(v, cfg);
    const want = claimDecision(v, options, coachCfg(v));
    const took = action.type === "claim" ? action.option : null;
    let cls = "ok", grade = "OK", head = "", why = "";
    if (took === null && want === null) {
      cls = "good";
      grade = "GOOD";
      head = "<b>pass</b> \u2014 the champion passes too";
      why = "nothing on offer was worth the exposure";
    } else if (took === null) {
      const w = assessClaim(v, want, cfg, ctx);
      cls = "bad";
      grade = "BAD";
      head = `<b>passed ${CLAIM_LABEL(want)}</b> \u2014 the champion takes it`;
      why = `it would have moved you ${w.distanceBefore} \u2192 ${w.distanceAfter} from ready, worth up to ${w.faanCeiling} faan`;
    } else if (want === null) {
      const t = assessClaim(v, took, cfg, ctx);
      cls = "bad";
      grade = "BAD";
      head = `<b>${CLAIM_LABEL(took)}</b> \u2014 the champion refuses this`;
      why = REFUSAL[t.reason] ?? "";
    } else if (sameClaim(took, want)) {
      const t = assessClaim(v, took, cfg, ctx);
      cls = "good";
      grade = "GOOD";
      head = `<b>${CLAIM_LABEL(took)}</b> \u2014 what the champion takes`;
      why = `${t.distanceBefore} \u2192 ${t.distanceAfter} from ready, worth up to ${t.faanCeiling} faan`;
    } else {
      head = `<b>${CLAIM_LABEL(took)}</b> \u2014 playable, but the champion prefers ${CLAIM_LABEL(want)}`;
    }
    recordMove({
      matchId: rc?.id ?? "",
      hand: state.handIndex,
      turn: humanTurns++,
      kind: took === null ? "pass" : "claim",
      played: took === null ? "pass" : CLAIM_LABEL(took),
      enginePick: want === null ? "pass" : CLAIM_LABEL(want),
      gap: cls === "good" ? 0 : 1,
      top1MinusTop2: 0,
      reason: why
    });
    if (!SETTINGS.dev) return;
    coachLog.unshift(verdictHtml(cls, grade, head, why));
    if (coachLog.length > 24) coachLog.length = 24;
  }
  function devPanel() {
    if (!SETTINGS.dev) return "";
    let upcoming = claimAdvice();
    if (pending2?.some((a) => a.type === "discard")) {
      const v = viewFor(state, HUMAN);
      const ranked = [...rankDiscards(v, coachCfg(v))].sort((a, b) => b.score - a.score).slice(0, 4);
      upcoming += `<div class="sug">champion would cut ${ranked.map((d, i) => `<span class="${i === 0 ? "best" : ""}">${name3(d.tile)}</span>`).join(" \u203A ")}</div>`;
    }
    return `<div id="dev">
    <div class="devbox"><b>what the bots are thinking</b>
      <div class="scroll">${devBotLines.join("") || '<div class="mut">\u2026</div>'}</div></div>
    <div class="devbox"><b>discard helper</b>${upcoming}
      <div class="scroll">${coachLog.join("") || '<div class="mut">your discards get graded here, and the grades stay</div>'}</div></div>
  </div>`;
  }
  var CALLS = {
    pung: ["\u78B0", "pung"],
    chow: ["\u4E0A", "chow"],
    kong: ["\u69D3", "kong"],
    concealedKong: ["\u6697\u69D3", "concealed kong"],
    addedKong: ["\u52A0\u69D3", "added kong"],
    win: ["\u98DF\u7CCA", "win"],
    selfDraw: ["\u81EA\u6478", "self-draw"],
    robbingKong: ["\u6436\u69D3", "robbed the kong"],
    flower: ["\u82B1", "flower"]
  };
  var SAY_MS = 640;
  var sayTimer = 0;
  function sayDiscard(tile, seat) {
    const el = $("say");
    el.innerHTML = `<div class="inner">${name3(tile)}</div>`;
    el.className = "";
    void el.offsetWidth;
    el.style.setProperty("--sayms", `${SAY_MS}ms`);
    el.className = `show s${seat}`;
    clearTimeout(sayTimer);
    sayTimer = window.setTimeout(() => {
      el.className = "";
    }, SAY_MS);
  }
  var callTimer = 0;
  var GRAB_MS = 760;
  var pendingGrab = null;
  var landingMeld = null;
  var endedMatch = null;
  function centreOf(el) {
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: el.offsetWidth, h: el.offsetHeight };
  }
  function armGrab(tile, seat, rot) {
    const last = $("pile").lastElementChild;
    if (!last) return;
    pendingGrab = { tile, seat, rot, ...centreOf(last) };
  }
  function launchGrab() {
    const g = pendingGrab;
    if (!g) return;
    pendingGrab = null;
    const row = g.seat === HUMAN ? $("mymelds") : document.querySelector(`.seat.${["", "e", "n", "w"][g.seat]} .meldrow`);
    const target = row?.querySelector(".tile.claimed") ?? row;
    if (!target || g.w === 0) return;
    const t = centreOf(target);
    if (t.w === 0) return;
    const el = document.createElement("span");
    el.className = "tile";
    el.innerHTML = `<svg viewBox="0 0 100 140" preserveAspectRatio="xMidYMid meet">${face(g.tile)}</svg>`;
    el.setAttribute(
      "style",
      `left:${(g.cx - g.w / 2).toFixed(1)}px;top:${(g.cy - g.h / 2).toFixed(1)}px;width:${g.w}px;height:${g.h}px;--dx:${(t.cx - g.cx).toFixed(1)}px;--dy:${(t.cy - g.cy).toFixed(1)}px;--ds:${(t.w / g.w).toFixed(3)};--r0:${g.rot.toFixed(0)}deg;--grabms:${GRAB_MS}ms`
    );
    $("fly").appendChild(el);
    window.setTimeout(() => {
      el.remove();
      landingMeld = null;
    }, GRAB_MS + 40);
  }
  var CLAIM_HOLD_MS = GRAB_MS + 260;
  var FLOWER_HOLD_MS = 500;
  var holdMs = 0;
  var takeHold = () => {
    const h = holdMs;
    holdMs = 0;
    return h;
  };
  function announce(kind, who, extra = "", seat = HUMAN) {
    const [ch, en] = CALLS[kind] ?? [kind, ""];
    const el = $("call");
    el.innerHTML = `<div class="inner"><div class="cw">${who}</div><div class="cc${ch.length > 1 ? " two" : ""}">${ch}</div><div class="ce">${en}${extra ? ` \xB7 ${extra}` : ""}</div></div>`;
    el.className = `show s${seat} k-${kind} ` + (kind === "win" || kind === "selfDraw" ? "big" : "");
    clearTimeout(callTimer);
    callTimer = window.setTimeout(() => {
      el.className = "";
    }, kind === "win" || kind === "selfDraw" ? 3200 : 2200);
    holdMs = kind === "win" || kind === "selfDraw" ? 0 : kind === "flower" ? FLOWER_HOLD_MS : CLAIM_HOLD_MS;
  }
  var TURN_MS = 3e4;
  var turnStart = 0;
  var turnRaf = 0;
  function startTurnClock() {
    turnStart = performance.now();
    cancelAnimationFrame(turnRaf);
    const tick = () => {
      if (!pending2) {
        $("clock").style.width = "0%";
        return;
      }
      const frac = Math.min(1, (performance.now() - turnStart) / TURN_MS);
      $("clock").style.width = `${(1 - frac) * 100}%`;
      $("clock").className = frac > 0.8 ? "low" : "";
      turnRaf = requestAnimationFrame(tick);
    };
    turnRaf = requestAnimationFrame(tick);
  }
  function advance() {
    render();
    if (endedMatch) {
      const m = endedMatch;
      matchScreen(m, () => {
        endedMatch = null;
        rc = null;
        overlay = null;
        lobbyScreen();
      });
      return;
    }
    if (overlay) {
      showOverlay();
      return;
    }
    if (state.phase === "matchEnd" || state.phase === "handEnd") return;
    const mine = legalActions(state, HUMAN);
    if (mine.length > 0) {
      holdMs = 0;
      pending2 = mine;
      startTurnClock();
      render();
      return;
    }
    const hold = takeHold();
    if (hold > 0) {
      busy = true;
      setTimeout(() => {
        busy = false;
        advance();
      }, hold);
      return;
    }
    for (const seat of [1, 2, 3]) {
      const options = legalActions(state, seat);
      if (options.length === 0) continue;
      busy = true;
      if (options.some((o) => o.type === "discard")) noteBotThinking(seat);
      setTimeout(() => {
        const a = decideAction(viewFor(state, seat), options, cfgs[seat]);
        if (rc) rc.actions.push(a);
        const r = applyAction(state, a);
        state = r.state;
        consume(r.events);
        busy = false;
        advance();
      }, SETTINGS.botMs);
      return;
    }
  }
  function act(a) {
    pending2 = null;
    cancelAnimationFrame(turnRaf);
    $("clock").style.width = "0%";
    if (rc) rc.actions.push(a);
    const r = applyAction(state, a);
    state = r.state;
    consume(r.events);
    advance();
  }
  function showOverlay() {
    $("veil").style.display = "flex";
    $("panel").innerHTML = overlay;
    const next = document.getElementById("btnNext");
    if (next) next.onclick = () => {
      overlay = null;
      $("veil").style.display = "none";
      const r = startNextHand(state);
      state = r.state;
      pileTiles = [];
      handSig = "";
      landingMeld = null;
      devBotLines = [];
      $("say").className = "";
      consume(r.events);
      advance();
      buildWall2();
    };
    const again = document.getElementById("btnAgain");
    if (again) again.onclick = () => {
      rc = null;
      overlay = null;
      lobbyScreen();
    };
  }
  var buildAnim = false;
  function renderWall() {
    const left = Math.max(0, state.wallEnd - state.wallIndex);
    const total = rules().useFlowers ? 144 : 136;
    const stacks = total / 2;
    const perSide = Math.ceil(stacks / 4);
    const liveStacks = Math.ceil(left / 2);
    const wallEl = $("wall");
    const bw = wallEl.clientWidth || 480, bh = wallEl.clientHeight || 300;
    const fitW = (bw / perSide - 2) / 17;
    const fitH = (bh / perSide - 2) / 15;
    const ws = Math.max(0.4, Math.min(1, fitW, fitH));
    wallEl.style.setProperty("--ws", ws.toFixed(3));
    const jr = prng((seed ^ 48879) >>> 0);
    wallEl.className = buildAnim ? "building" : "";
    wallEl.innerHTML = ["top", "right", "bottom", "left"].map((side, si) => {
      const share = Math.floor(liveStacks / 4) + (si < liveStacks % 4 ? 1 : 0);
      return `<div class="side ${side}">${Array.from({ length: perSide }, (_, i) => {
        const gone = i >= share;
        const dead = !gone && si === 3 && i >= share - 4;
        const d = buildAnim ? ` style="--ax:${(jr() * 150 - 75).toFixed(0)}px;--ay:${(jr() * -130 - 30).toFixed(0)}px;--ar:${(jr() * 70 - 35).toFixed(0)}deg;animation-delay:${si * 70 + i * 12}ms"` : "";
        return `<span class="wt${gone ? " gone" : ""}${dead ? " dead" : ""}"${d}></span>`;
      }).join("")}</div>`;
    }).join("");
  }
  function buildWall2() {
    buildAnim = true;
    renderWall();
    setTimeout(() => {
      buildAnim = false;
      renderWall();
    }, 1450);
  }
  function plate(seat, who, initial) {
    const s = state.seats[seat];
    const sign = s.chips > 0 ? "up" : s.chips < 0 ? "down" : "";
    return `<div class="nameplate ${state.turn === seat && !overlay ? "turn" : ""}">
      <span class="avatar">${initial}</span><span>${who}</span>
      <span class="wind">${WIND_CH[s.wind]}</span>
      ${state.dealer === seat ? '<span class="dealer">\u838A</span>' : ""}
      <span class="chips ${sign}">${s.chips > 0 ? "+" : ""}${s.chips}</span></div>`;
  }
  var myPlate = () => plate(HUMAN, "You", "Y");
  function seatBox(seat) {
    const s = state.seats[seat];
    const nm = BOT_NAMES[table.seats[seat - 1]] ?? "Bot";
    const hidden = s.hand.length + (s.drawn !== null ? 1 : 0);
    return plate(seat, nm, nm[0]) + `
    <div class="backrow">${Array.from({ length: Math.min(hidden, 14) }, (_, i) => `<span class="back ${i === hidden - 1 && s.drawn !== null ? "wtnew" : ""}"
         style="--drawdelay:${queueBehindToss()}ms"></span>`).join("")}</div>
    <div class="meldrow">${s.melds.map((m, i) => m.tiles.map((t) => tileHtml(
      t,
      `sm ${landingMeld && landingMeld.seat === seat && landingMeld.index === i ? "claimed" : ""}`
    )).join("")).join('<span style="width:6px"></span>')}
      ${/* `sm` so a flower is the same size as the melds beside it — the
       tiles in this row carry it, and a flower without it came out a
       quarter larger than its neighbours. */
    ""}
      ${s.flowers.map((t) => tileHtml(t, "fl sm")).join("")}</div>`;
  }
  function render() {
    const me = state.seats[HUMAN];
    const left = Math.max(0, state.wallEnd - state.wallIndex);
    const stateEl = $("state");
    stateEl.className = left <= 16 ? "low" : "";
    stateEl.innerHTML = `<div class="r1"><span class="wind">${WIND_CH[state.roundWind]}</span><span>hand <b>${state.handIndex + 1}</b></span></div><div class="r2">wall <b>${left}</b> left</div>`;
    $("seatE").innerHTML = seatBox(1);
    $("seatN").innerHTML = seatBox(2);
    $("seatW").innerHTML = seatBox(3);
    $("seatS").innerHTML = myPlate();
    renderWall();
    const pileEl = $("pile");
    const boxW = pileEl.clientWidth || 420, boxH = pileEl.clientHeight || 240;
    pileEl.style.setProperty(
      "--pileth",
      `${Math.round(Math.min(46, Math.max(21, boxW / 14.3)))}px`
    );
    const probe = pileEl.querySelector(".tile");
    const th = probe?.offsetHeight || 36 * SETTINGS.tileScale;
    const tw = probe?.offsetWidth || th * 0.714;
    const jr = prng((seed ^ 20973) >>> 0);
    pileTiles.forEach((d) => {
      if (d.pos) return;
      const placed = pileTiles.filter((o) => o.pos).map((o) => o.pos);
      const ax = boxW / 2 + [0, tw * 1.7, 0, -tw * 1.7][d.seat];
      const ay = boxH / 2 + [th * 0.75, 0, -th * 0.75, 0][d.seat];
      const CLEAR = 0.3;
      const squash = Math.min(0.9, Math.max(0.5, boxH / boxW));
      const fits = (c) => !placed.some((o) => hits(c, o, tw + CLEAR, th + CLEAR));
      let best = null;
      const step = Math.max(0.8, th * 0.028);
      for (let r = 0; r < 320 && !best; r += step) {
        const off = jr() * Math.PI * 2;
        for (let k = 0; k < 40 && !best; k++) {
          const a = off + k / 40 * Math.PI * 2;
          for (let t = 0; t < 4 && !best; t++) {
            const rot = jr() < 0.24 ? (jr() < 0.5 ? 90 : -90) + (jr() - 0.5) * 22 : (jr() - 0.5) * 74;
            const c = { x: ax + Math.cos(a) * r, y: ay + Math.sin(a) * r * squash, rot, spin: 0 };
            if (fits(c)) best = c;
          }
        }
      }
      const drop = (c) => {
        const dx = ax - c.x, dy = ay - c.y, dist = Math.hypot(dx, dy);
        if (dist < 0.01) return c;
        const ux = dx / dist * 0.5, uy = dy / dist * 0.5;
        for (let moved = 0; moved < dist; moved += 0.5) {
          const n = { ...c, x: c.x + ux, y: c.y + uy };
          if (!fits(n)) break;
          c = n;
        }
        return c;
      };
      if (best) {
        const far = (c) => (c.x - ax) ** 2 + (c.y - ay) ** 2;
        best = drop(best);
        for (let i = 0; i < 220; i++) {
          const c = {
            x: best.x + (jr() - 0.5) * 14,
            y: best.y + (jr() - 0.5) * 14,
            rot: best.rot + (jr() - 0.5) * 22,
            spin: 0
          };
          if (!fits(c)) continue;
          const settled = drop(c);
          if (far(settled) < far(best)) best = settled;
        }
      }
      d.pos = best ?? { x: boxW / 2, y: boxH / 2, rot: 0, spin: 0 };
      d.pos.spin = jr() * 220 - 110;
    });
    const live = new Set(pileTiles.map((d) => d.id));
    const pid = (el) => Number(el.dataset.pid);
    for (const el of Array.from(pileEl.children)) if (!live.has(pid(el))) el.remove();
    const have = new Set(Array.from(pileEl.children).map(pid));
    for (const d of pileTiles) {
      if (have.has(d.id)) continue;
      const from = [[0, 190], [230, 0], [0, -190], [-230, 0]][d.seat] ?? [0, 190];
      const lx = from[0] * 0.3, ly = from[1] * 0.3;
      const lr = d.pos.rot + (d.pos.spin - d.pos.rot) * 0.22;
      lastTossAt = performance.now();
      for (const el of Array.from(pileEl.children)) el.classList.remove("hot");
      pileEl.insertAdjacentHTML("beforeend", tileHtml(
        d.tile,
        "pt fresh hot",
        `data-pid="${d.id}" style="left:${d.pos.x.toFixed(1)}px;top:${d.pos.y.toFixed(1)}px;--fx:${from[0]}px;--fy:${from[1]}px;--fr:${d.pos.spin.toFixed(0)}deg;--lx:${lx.toFixed(0)}px;--ly:${ly.toFixed(0)}px;--lr:${lr.toFixed(1)}deg;--rot:${d.pos.rot.toFixed(1)}deg;--tossms:${TOSS_MS}ms;transform:translate(-50%,-50%) rotate(${d.pos.rot.toFixed(1)}deg)"`
      ));
    }
    const mine = (i) => landingMeld && landingMeld.seat === HUMAN && landingMeld.index === i ? "claimed" : "";
    $("mymelds").innerHTML = me.melds.map((m, i) => m.tiles.map((t) => tileHtml(t, mine(i))).join("")).join('<span style="width:10px"></span>') + me.flowers.map((t) => tileHtml(t, "fl")).join("");
    const canDiscard = !!pending2?.some((a) => a.type === "discard");
    const hand = [...me.hand].sort((a, b) => a - b);
    $("myhand").className = canDiscard ? "" : "locked";
    const sig = `${hand.join(",")}|${me.drawn ?? "-"}|${canDiscard}`;
    if (sig !== handSig) {
      handSig = sig;
      const delay = queueBehindToss();
      $("myhand").innerHTML = hand.map((t) => tileHtml(t, "", `data-t="${t}"`)).join("") + (me.drawn !== null ? tileHtml(
        me.drawn,
        "drawn",
        `data-t="${me.drawn}" style="--drawms:${DRAW_MS}ms;--drawdelay:${delay}ms;--wx:${(120 - hand.length * 9).toFixed(0)}px;--wy:-190px"`
      ) : "");
    }
    if (canDiscard) {
      for (const el of Array.from($("myhand").querySelectorAll(".tile"))) {
        el.onclick = () => {
          const t = Number(el.dataset.t);
          const a = pending2?.find((x) => x.type === "discard" && x.tile === t);
          if (a) {
            gradeMyDiscard(t);
            act(a);
          }
        };
      }
    }
    let bar = "";
    if (pending2) {
      const btns = [];
      const strip = (tiles, thrown) => {
        const parts = tiles.map((t) => ({ t, got: false }));
        if (thrown !== null) parts.push({ t: thrown, got: true });
        parts.sort((x, y) => x.t - y.t);
        return `<span class="tw">` + parts.map((p) => tileHtml(p.t, p.got ? "got" : "")).join("") + `</span>`;
      };
      const inPlay = state.lastDiscard?.tile ?? null;
      const winButton = (i, selfDraw) => {
        const tile = selfDraw ? state.seats[HUMAN].drawn : inPlay;
        const r = tile === null || tile === void 0 ? null : previewWin(state, HUMAN, {
          selfDraw,
          tile,
          from: selfDraw ? null : state.lastDiscard?.from ?? null
        });
        if (r && !r.legal) {
          const min = rules().minimumFaan;
          btns.push(`<button class="short" data-i="${i}"><span class="lb">winning shape</span><span class="sb">${r.faan} faan \xB7 needs ${min}</span></button>`);
          return;
        }
        btns.push(`<button class="win" data-i="${i}"><span class="lb">WIN \u98DF\u7CCA</span>` + (r ? `<span class="sb">${r.faan} faan</span>` : "") + `</button>`);
      };
      pending2.forEach((a, i) => {
        if (a.type === "discard") return;
        const mk = (label, cls = "", tiles = "") => btns.push(`<button class="${cls}" data-i="${i}"><span class="lb">${label}</span>${tiles}</button>`);
        if (a.type === "declareWin") winButton(i, a.selfDraw);
        else if (a.type === "pass") mk("pass", "pass");
        else if (a.type === "concealedKong") mk("kong \u6697\u69D3", "kong", strip([a.tile, a.tile, a.tile, a.tile], null));
        else if (a.type === "addedKong") mk("kong \u52A0\u69D3", "kong", strip([a.tile, a.tile, a.tile, a.tile], null));
        else if (a.type === "claim") {
          const o = a.option;
          if (o.kind === "win") winButton(i, false);
          else if (o.kind === "chow") mk("chow \u4E0A", "chow", strip(o.with ?? [], inPlay));
          else if (o.kind === "pung") mk(
            "pung \u78B0",
            "pung",
            inPlay === null ? "" : strip([inPlay, inPlay], inPlay)
          );
          else mk("kong \u69D3", "kong", inPlay === null ? "" : strip([inPlay, inPlay, inPlay], inPlay));
        }
      });
      bar = btns.join("") || (canDiscard ? `<span class="hint">your turn \u2014 tap a tile to discard</span>` : "");
      if (btns.length && canDiscard) bar += `<span class="hint">or tap a tile to discard</span>`;
    } else if (!overlay && busy) bar = `<span class="hint">\u2026</span>`;
    $("actions").innerHTML = bar;
    for (const el of Array.from($("actions").querySelectorAll("button"))) {
      el.onclick = () => {
        const a = pending2?.[Number(el.dataset.i)];
        if (a) {
          gradeMyClaim(a);
          act(a);
        }
      };
    }
    $("log").innerHTML = feed.map((l) => `<div>${l}</div>`).join("");
    $("callwrap").innerHTML = callingBar();
    $("devwrap").innerHTML = devPanel();
    recenterGlyphs(document);
    launchGrab();
  }
  function settingsScreen(back) {
    $("veil").style.display = "flex";
    $("panel").innerHTML = `
    <h1>Settings</h1>
    <h2 style="margin-top:14px">Table</h2>
    <div class="setrow"><label>Tile size</label>
      <input type="range" id="setScale" min="0.8" max="2" step="0.05" value="${SETTINGS.tileScale}">
      <span id="setScaleV">${Math.round(SETTINGS.tileScale * 100)}%</span></div>
    <div class="setrow"><label>Bot speed</label>
      <input type="range" id="setSpeed" min="0" max="1200" step="60" value="${SETTINGS.botMs}">
      <span id="setSpeedV">${SETTINGS.botMs === 0 ? "instant" : SETTINGS.botMs + "ms"}</span></div>
    <h2 style="margin-top:14px">Handicaps</h2>
    <p class="mut">Training wheels. Each only tells you what a careful player could
      work out from the table \u2014 nothing hidden is revealed.</p>
    <div class="setrow"><label>Count tiles</label>
      <input type="checkbox" id="hcCount" ${SETTINGS.hcCount ? "checked" : ""}>
      <span class="mut">hover any tile to light up every copy of it on the table</span></div>
    <div class="setrow"><label>Calling read</label>
      <input type="checkbox" id="hcCalling" ${SETTINGS.hcCalling ? "checked" : ""}>
      <span class="mut">whether you are \u807D\u724C, what you wait on, how many are live, and
        whether the hand can pay</span></div>
    <div class="setrow"><label>What-if</label>
      <input type="checkbox" id="hcWhatIf" ${SETTINGS.hcWhatIf ? "checked" : ""}>
      <span class="mut">hover a tile in your hand to see what cutting it would leave you
        waiting on (needs the calling read)</span></div>
    <div class="setrow"><label>Dev mode</label>
      <input type="checkbox" id="setDev" ${SETTINGS.dev ? "checked" : ""}>
      <span class="mut">show what each bot is planning, and how the champion would rank your discards</span></div>
    <button id="btnBack">done \u25B8</button>`;
    const sc = document.getElementById("setScale");
    sc.oninput = () => {
      SETTINGS.tileScale = Number(sc.value);
      $("setScaleV").textContent = Math.round(SETTINGS.tileScale * 100) + "%";
      saveSettings();
      render();
    };
    const sp = document.getElementById("setSpeed");
    sp.oninput = () => {
      SETTINGS.botMs = Number(sp.value);
      $("setSpeedV").textContent = SETTINGS.botMs === 0 ? "instant" : SETTINGS.botMs + "ms";
      saveSettings();
    };
    const dv = document.getElementById("setDev");
    dv.onchange = () => {
      SETTINGS.dev = dv.checked;
      saveSettings();
      render();
    };
    for (const [id, key] of [["hcCount", "hcCount"], ["hcCalling", "hcCalling"], ["hcWhatIf", "hcWhatIf"]]) {
      const box = document.getElementById(id);
      if (box) box.onchange = () => {
        SETTINGS[key] = box.checked;
        saveSettings();
        if (state) render();
      };
    }
    $("btnBack").onclick = () => {
      $("veil").style.display = "none";
      back();
    };
  }
  function feedbackScreen(back) {
    $("veil").style.display = "flex";
    const live = rc !== null;
    const where = live ? `hand ${state.handIndex + 1} of your ${SETTINGS.rounds}-wind game vs ${table.label}` : lastMatch ? `your last game \u2014 hand ${lastMatch.hand + 1} of the ${lastMatch.label}` : "not in a game";
    $("panel").innerHTML = `
    <h1>Tell us what you saw</h1>
    <p class="mut">Bugs, rules that looked wrong, animations that felt off, anything.
    We attach where you were \u2014 <b>${where}</b> \u2014 so we can replay it.</p>
    <textarea id="fbText" placeholder="What happened? What did you expect instead?"></textarea>
    <div class="setrow" style="margin-top:10px">
      <button id="btnFbSend">send \u25B8</button>
      <button id="btnFbBack" style="background:rgba(255,255,255,.08)">cancel</button>
    </div>`;
    const ta = document.getElementById("fbText");
    ta.focus();
    $("btnFbSend").onclick = () => {
      const text = ta.value.trim();
      if (!text) {
        ta.focus();
        return;
      }
      void putFeedback({
        id: crypto.randomUUID(),
        matchId: rc?.id ?? lastMatch?.id ?? null,
        hand: rc ? state.handIndex : lastMatch?.hand ?? null,
        text,
        createdAt: Date.now(),
        context: {
          player: player?.name,
          rounds: SETTINGS.rounds,
          ruleset: SETTINGS.rulesetId,
          table: table.id,
          seats: [...table.seats],
          seed,
          live,
          wall: live && state ? state.wallEnd - state.wallIndex : null,
          chips: state ? [0, 1, 2, 3].map((i) => state.seats[i].chips) : null,
          recentLog: feed.slice(-8),
          ua: navigator.userAgent,
          viewport: [innerWidth, innerHeight]
        }
      });
      void drain(store_exports);
      $("panel").innerHTML = `<h1>Thank you</h1>
      <p>Filed against ${where} and sent to us with the game it came from \u2014 the
      seed, the hand, the last few plays \u2014 so we can replay exactly what you saw.</p>
      <button id="btnFbBack2">back to the game \u25B8</button>`;
      $("btnFbBack2").onclick = () => {
        $("veil").style.display = "none";
        back();
      };
    };
    $("btnFbBack").onclick = () => {
      $("veil").style.display = "none";
      back();
    };
  }
  $("btnFeedback").onclick = () => feedbackScreen(() => {
    if (!state) startScreen();
    else render();
  });
  $("btnSettings").onclick = () => settingsScreen(() => {
    if (!state) startScreen();
    else render();
  });
  $("btnQuit").onclick = () => {
    if (rc && rc.finishedAt === null) {
      rc.abandoned = true;
      rc.finishedAt = Date.now();
      flushRecord();
      void drain(store_exports);
    }
    rc = null;
    endedMatch = null;
    overlay = null;
    lobbyScreen();
  };
  saveSettings();
  wireHover();
  void getPlayer().then((p) => {
    player = p;
    if (p) lobbyScreen();
    else nameScreen(() => aboutScreen(lobbyScreen));
  });
})();

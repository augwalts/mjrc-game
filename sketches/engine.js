/* MJRC Game — P0 sketch engine.
 * Implements DESIGN.md §5.2 state machine faithfully (claims, kongs, flowers,
 * priority, dealer repeat). Scoring is a STUB — see faanFor(). Shanten/route
 * evaluation is absent by design (DESIGN.md §7 defers it).
 *
 * Deliberate fidelity choices, each annotated where it happens:
 *  - single named-deadline map + one timer  (§5.3 deadline multiplexer)
 *  - bots answer on a paced delay           (§5.3 botPace / no timing leak)
 *  - every transition emits an event        (§5.5 log schema v1)
 *  - seeded wall                            (§5.1 deterministic replay)
 */
(function (root) {
  "use strict";

  /* ─────────── tiles ─────────── */
  // 0-8 萬 · 9-17 索 · 18-26 筒 · 27-30 東南西北 · 31-33 中發白 · 34-41 flowers
  var FLOWER_START = 34, HONOR_START = 27;
  var NAMES = (function () {
    var n = [], i;
    for (i = 1; i <= 9; i++) n.push(i + "萬");
    for (i = 1; i <= 9; i++) n.push(i + "索");
    for (i = 1; i <= 9; i++) n.push(i + "筒");
    ["東", "南", "西", "北", "中", "發", "白"].forEach(function (s) { n.push(s); });
    ["梅", "蘭", "竹", "菊", "春", "夏", "秋", "冬"].forEach(function (s) { n.push(s); });
    return n;
  })();
  function isFlower(t) { return t >= FLOWER_START; }
  function isHonor(t) { return t >= HONOR_START && t < FLOWER_START; }
  function suitOf(t) { return t < 9 ? 0 : t < 18 ? 1 : t < 27 ? 2 : 3; }
  function rankOf(t) { return t < 27 ? t % 9 : -1; }
  var WINDS = ["東", "南", "西", "北"];

  /* ─────────── seeded wall (§5.1) ─────────── */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function buildWall(seed) {
    var w = [], i, k, rnd = mulberry32(seed);
    for (i = 0; i < 34; i++) for (k = 0; k < 4; k++) w.push(i);   // 136
    for (i = FLOWER_START; i < FLOWER_START + 8; i++) w.push(i);  // + 8 flowers = 144
    for (i = w.length - 1; i > 0; i--) {                          // Fisher-Yates
      var j = Math.floor(rnd() * (i + 1)), t = w[i]; w[i] = w[j]; w[j] = t;
    }
    return w;
  }

  /* ─────────── hand math ─────────── */
  function countsOf(hand) {
    var c = new Array(34).fill(0);
    hand.forEach(function (t) { if (t < 34) c[t]++; });
    return c;
  }
  function meldsOk(c, need) {
    if (need === 0) return true;
    var i = 0; while (i < 34 && c[i] === 0) i++;
    if (i === 34) return false;
    if (c[i] >= 3) { c[i] -= 3; if (meldsOk(c, need - 1)) { c[i] += 3; return true; } c[i] += 3; }
    if (i < 27 && rankOf(i) <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      if (meldsOk(c, need - 1)) { c[i]++; c[i + 1]++; c[i + 2]++; return true; }
      c[i]++; c[i + 1]++; c[i + 2]++;
    }
    return false;
  }
  // needMelds = 4 - (exposed melds). Seven pairs only valid with zero melds.
  function canWin(c, needMelds) {
    var i, pairs = 0, ok7 = needMelds === 4;
    if (ok7) {
      for (i = 0; i < 34; i++) {
        if (c[i] === 0) continue;
        if (c[i] === 2) pairs++; else { ok7 = false; break; }
      }
      if (ok7 && pairs === 7) return true;
    }
    for (i = 0; i < 34; i++) {
      if (c[i] >= 2) {
        c[i] -= 2;
        if (meldsOk(c.slice(), needMelds)) { c[i] += 2; return true; }
        c[i] += 2;
      }
    }
    return false;
  }

  /* ─────────── readiness & liveTiles — EXACT, no theory required ───────────
   * Unpruned recursive decomposition. The Python reference's branch-and-bound
   * prune is wrong on 6-10% of hands (ENGINE-AUDIT §3) — do not port it.
   * No seven-pairs branch: not a hand in classic HKOS.                      */
  // Best (sets, partials) decomposition of the concealed tiles.
  function maxBlocks(c, i, sets, parts) {
    while (i < 34 && c[i] === 0) i++;
    if (i >= 34) return [sets, parts];
    var best = [sets, parts];
    var take = function (r) { if (r[0] * 2 + r[1] > best[0] * 2 + best[1]) best = r; };
    if (c[i] >= 3) { c[i] -= 3; take(maxBlocks(c, i, sets + 1, parts)); c[i] += 3; }
    if (i < 27 && i % 9 <= 6 && c[i + 1] && c[i + 2]) {
      c[i]--; c[i + 1]--; c[i + 2]--; take(maxBlocks(c, i, sets + 1, parts));
      c[i]++; c[i + 1]++; c[i + 2]++;
    }
    if (c[i] >= 2) { c[i] -= 2; take(maxBlocks(c, i, sets, parts + 1)); c[i] += 2; }
    if (i < 27 && i % 9 <= 7 && c[i + 1]) {
      c[i]--; c[i + 1]--; take(maxBlocks(c, i, sets, parts + 1)); c[i]++; c[i + 1]++;
    }
    if (i < 27 && i % 9 <= 6 && c[i + 2]) {
      c[i]--; c[i + 2]--; take(maxBlocks(c, i, sets, parts + 1)); c[i]++; c[i + 2]++;
    }
    c[i]--; take(maxBlocks(c, i, sets, parts)); c[i]++;   // leave this tile isolated
    return best;
  }
  function _calc(c, melds, hasPair) {
    var r = maxBlocks(c, 0, 0, 0), sets = r[0] + melds, parts = r[1];
    if (sets + parts > 4) parts = 4 - sets;
    return 8 - 2 * sets - parts - (hasPair ? 1 : 0);
  }
  // Try every candidate pair explicitly, plus the no-pair decomposition.
  function distanceToReady(counts, melds) {
    var c = counts.slice(), m = melds || 0, best = _calc(c, m, false), i;
    for (i = 0; i < 34; i++) {
      if (c[i] >= 2) { c[i] -= 2; best = Math.min(best, _calc(c, m, true)); c[i] += 2; }
    }
    return best;
  }

  /** Tiles that reduce distanceToReady, with how many copies remain unseen.
   *  `visible` = every tile this seat can account for: own hand, all discards,
   *  all melds, all flowers. Exact — no estimation anywhere. */
  function liveTiles(counts, melds, visible) {
    var base = distanceToReady(counts, melds), tiles = [], total = 0, i;
    for (i = 0; i < 34; i++) {
      if (counts[i] >= 4) continue;
      counts[i]++;
      var sh = distanceToReady(counts, melds);
      counts[i]--;
      if (sh < base) {
        var unseen = 4 - Math.min(4, (visible && visible[i]) || 0);
        if (unseen > 0) { tiles.push({ tile: i, unseen: unseen }); total += unseen; }
      }
    }
    return { distance: base, tiles: tiles, total: total };
  }

  /* ─────────── faan — STUB (real engine is DESIGN.md §5.1, 2-3 wk) ─────────
   * Enough of canonical HKOS to make the 3-faan floor actually bite, which is
   * the whole texture of HK play. Not a scoring engine. Do not port.        */
  function faanFor(seat, S, opts) {
    opts = opts || {};
    var all = seat.hand.concat(), det = [], f = 0;
    seat.melds.forEach(function (m) { all = all.concat(m.tiles); });
    var c = countsOf(all), i;

    for (i = HONOR_START; i < FLOWER_START; i++) {
      if (c[i] >= 3) {
        if (i >= 31) { f += 1; det.push(NAMES[i] + " pung +1"); }
        else if (i - HONOR_START === seat.windIdx) { f += 1; det.push("Seat wind " + NAMES[i] + " +1"); }
        else if (i - HONOR_START === S.roundWind) { f += 1; det.push("Round wind " + NAMES[i] + " +1"); }
      }
    }
    var suits = {}, honors = false;
    all.forEach(function (t) {
      if (t >= FLOWER_START) return;
      if (isHonor(t)) honors = true; else suits[suitOf(t)] = 1;
    });
    var nSuits = Object.keys(suits).length;
    if (nSuits === 1 && !honors) { f += 7; det.push("Full flush 清一色 +7"); }
    else if (nSuits === 1 && honors) { f += 3; det.push("Half flush 混一色 +3"); }

    var allPungs = seat.melds.every(function (m) { return m.type !== "chow"; });
    if (allPungs && seat.melds.length > 0) {
      var runs = false, cc = countsOf(seat.hand);
      for (i = 0; i < 27 && !runs; i++)
        if (rankOf(i) <= 6 && cc[i] && cc[i + 1] && cc[i + 2]) runs = true;
      if (!runs) { f += 3; det.push("All pungs 對對糊 +3"); }
    }
    if (opts.selfDraw) { f += 1; det.push("Self-draw 自摸 +1"); }
    seat.flowers.forEach(function (t) {
      var idx = (t - FLOWER_START) % 4;
      if (idx === seat.windIdx) { f += 1; det.push("Own flower " + NAMES[t] + " +1"); }
    });
    if (f === 0) det.push("Chicken hand 雞糊 — 0 faan");
    return { faan: Math.min(f, 13), detail: det, capped: f > 13 };
  }

  /* ─────────── state machine ─────────── */
  function Game(opts) {
    this.seed = opts.seed || 12345;
    this.onChange = opts.onChange || function () {};
    this.onHandEnd = opts.onHandEnd || function () {};
    this.matchId = opts.matchId || "m_sketch";
    this.speed = opts.speed || 1;
    this.autoPass = false;
    this.forceFloorWarning = false;
    this.handIdx = 0;
    this.roundWind = 0;      // 東
    this.dealer = 0;
    this.log = [];
    this.seq = 0;
    this.deadlines = {};     // §5.3 — ONE timer, many named deadlines
    this.timer = null;
    this.seats = [0, 1, 2, 3].map(function (i) {
      return {
        idx: i, name: i === 0 ? "You" : ["", "Ah Ming", "Kai", "Suki"][i],
        isYou: i === 0, hand: [], melds: [], flowers: [], discards: [],
        chips: 0, windIdx: 0, drawn: null, connected: true
      };
    });
  }

  Game.prototype.emit = function (type, actor, payload) {
    this.log.push({
      v: 1, match_id: this.matchId, hand_idx: this.handIdx, seq: this.seq++,
      ts: this.log.length, actor: actor, type: type, payload: payload || {}
    });
  };

  /* --- deadline multiplexer: mirrors the DO's single-alarm constraint --- */
  Game.prototype.setDeadline = function (name, ms) {
    this.deadlines[name] = Date.now() + ms / this.speed;
    this.arm();
  };
  Game.prototype.clearDeadline = function (name) { delete this.deadlines[name]; };
  Game.prototype.arm = function () {
    var self = this;
    if (this.timer) return;
    this.timer = setInterval(function () {
      var now = Date.now(), due = [], k;
      for (k in self.deadlines) if (self.deadlines[k] <= now) due.push(k);
      due.forEach(function (name) { delete self.deadlines[name]; self.fire(name); });
      if (due.length) self.onChange();
      else if (self.phase === "CLAIM_WINDOW" || self.phase === "AWAIT_DISCARD") self.onChange();
    }, 100);
  };
  Game.prototype.stop = function () { clearInterval(this.timer); this.timer = null; this.deadlines = {}; };
  Game.prototype.remaining = function (name) {
    if (!this.deadlines[name]) return 0;
    return Math.max(0, this.deadlines[name] - Date.now());
  };
  Game.prototype.fire = function (name) {
    if (name === "claimWindow") this.resolveClaims();
    else if (name === "turnClock") this.autoDiscard();
    else if (name.indexOf("botPace:") === 0) this.botDiscard(+name.split(":")[1]);
    else if (name === "botClaims") this.collectBotClaims();
  };

  /* --- DEAL → FLOWER_REPLACEMENT → AWAIT_DISCARD(dealer) --- */
  Game.prototype.startHand = function () {
    var self = this;
    this.wall = buildWall(this.seed + this.handIdx);
    this.wallIdx = 0;
    this.phase = "DEAL";
    this.pendingClaims = null;
    this.lastDiscard = null;
    this.seats.forEach(function (s, i) {
      s.hand = []; s.melds = []; s.flowers = []; s.discards = []; s.drawn = null;
      s.windIdx = (i - self.dealer + 4) % 4;
    });
    this.emit("deal", null, { seed: this.seed + this.handIdx, dealer: this.dealer, round_wind: this.roundWind });
    var dealEv = this.log[this.log.length - 1];
    var k, i;
    for (k = 0; k < 13; k++) for (i = 0; i < 4; i++) this.seats[i].hand.push(this.wall[this.wallIdx++]);
    // FLOWER_REPLACEMENT — seat order, recursive; strictly ordered so replay
    // re-execution is deterministic (§5.2).
    for (i = 0; i < 4; i++) this.replaceFlowers(i);
    this.seats.forEach(function (s) { s.hand.sort(function (a, b) { return a - b; }); });
    this.assignRoutes();
    dealEv.payload.hands = this.seats.map(function (s) { return s.hand.concat(); });
    dealEv.payload.flowers = this.seats.map(function (s) { return s.flowers.concat(); });
    this.drawFor(this.dealer);
    this.awaitDiscard(this.dealer);
  };
  Game.prototype.replaceFlowers = function (i) {
    var s = this.seats[i], moved = true;
    while (moved) {
      moved = false;
      for (var k = 0; k < s.hand.length; k++) {
        if (isFlower(s.hand[k])) {
          var t = s.hand.splice(k, 1)[0];
          s.flowers.push(t);
          var r = this.wall[this.wallIdx++];
          s.hand.push(r);
          this.emit("flower_replace", i, { flower: t, replacement: r, initial: true });
          moved = true; break;
        }
      }
    }
  };

  // Crude faan-route steering. DESIGN.md §6 priority (2). A real bot evaluates
  // routes continuously; this picks one at deal and never revises.
  Game.prototype.assignRoutes = function () {
    this.seats.forEach(function (s) {
      var c = [0, 0, 0], hon = 0;
      s.hand.forEach(function (t) { if (t < 27) c[suitOf(t)]++; else if (t < 34) hon++; });
      var best = 0, i;
      for (i = 1; i < 3; i++) if (c[i] > c[best]) best = i;
      s.route = c[best] >= 6 ? { type: "flush", suit: best } : { type: "pungs" };
    });
  };

  // Draw one tile; flowers replace recursively and never enter the hand.
  Game.prototype.drawFor = function (seat, evType) {
    var s = this.seats[seat];
    s.drawn = this.wall[this.wallIdx++];
    this.emit(evType || "draw", seat, { tile: s.drawn });
    while (isFlower(s.drawn)) {
      s.flowers.push(s.drawn);
      this.emit("flower_replace", seat, { flower: s.drawn });
      s.drawn = this.wall[this.wallIdx++];
      this.emit("draw", seat, { tile: s.drawn });
    }
  };

  Game.prototype.awaitDiscard = function (seat) {
    this.phase = "AWAIT_DISCARD";
    this.turn = seat;
    this.pendingClaims = null;
    this.clearDeadline("claimWindow");
    var s = this.seats[seat];
    if (s.isYou) this.setDeadline("turnClock", 10000);
    else this.setDeadline("botPace:" + seat, 700 + Math.random() * 700);
    this.onChange();
  };

  Game.prototype.handTiles = function (seat) {
    var s = this.seats[seat];
    return s.drawn === null ? s.hand.concat() : s.hand.concat([s.drawn]);
  };

  /* --- discard → CLAIM_WINDOW --- */
  Game.prototype.discard = function (seat, tile) {
    var s = this.seats[seat];
    this.clearDeadline("turnClock");
    this.clearDeadline("botPace:" + seat);
    if (s.drawn === tile) s.drawn = null;
    else {
      var i = s.hand.indexOf(tile);
      if (i < 0) return;
      s.hand.splice(i, 1);
      if (s.drawn !== null) { s.hand.push(s.drawn); s.drawn = null; }
    }
    s.hand.sort(function (a, b) { return a - b; });
    s.discards.push(tile);
    this.emit("discard", seat, { tile: tile });
    this.openClaimWindow(tile, seat);
  };
  Game.prototype.autoDiscard = function () {
    // Safe default on timeout (§2 — auto-pass/auto-discard, not a hang).
    var s = this.seats[this.turn];
    this.discard(this.turn, s.drawn !== null ? s.drawn : s.hand[s.hand.length - 1]);
  };
  Game.prototype.botDiscard = function (seat) {
    var t = this.pickBotDiscard(seat);
    this.discard(seat, t);
  };
  Game.prototype.pickBotDiscard = function (seat) {
    // Shape value + route bias. Lowest score is discarded. Still not a real
    // bot — no liveTiles, no safety, no defence. DESIGN.md §6 is the real spec.
    var route = this.seats[seat].route || { type: "pungs" };
    var tiles = this.handTiles(seat), c = countsOf(tiles), best = tiles[0], bestScore = 1e9;
    tiles.forEach(function (t) {
      if (t >= 34) return;
      var score = c[t] * 12;
      if (!isHonor(t)) {
        var r = rankOf(t), su = suitOf(t);
        [-2, -1, 1, 2].forEach(function (d) {
          var rr = r + d;
          if (rr >= 0 && rr <= 8) score += c[su * 9 + rr] * (Math.abs(d) === 1 ? 5 : 2);
        });
      }
      if (route.type === "flush") score += suitOf(t) === route.suit ? 45 : (isHonor(t) ? 8 : 0);
      else if (isHonor(t)) score += c[t] >= 2 ? 30 : 6;
      if (score < bestScore) { bestScore = score; best = t; }
    });
    return best;
  };
  Game.prototype.onRoute = function (seat, tile) {
    var r = this.seats[seat].route || { type: "pungs" };
    if (r.type === "flush") return suitOf(tile) === r.suit || isHonor(tile);
    return isHonor(tile) || true;
  };

  // own-turn declaration: concealed kong 暗槓 (§5.2)
  Game.prototype.concealedKongOptions = function (seat) {
    var c = countsOf(this.handTiles(seat)), out = [], i;
    for (i = 0; i < 34; i++) if (c[i] === 4) out.push(i);
    return out;
  };
  Game.prototype.concealedKong = function (seat, tile) {
    var s = this.seats[seat], k;
    this.clearDeadline("turnClock");
    if (s.drawn !== null) { s.hand.push(s.drawn); s.drawn = null; }
    for (k = 0; k < 4; k++) { var i = s.hand.indexOf(tile); if (i >= 0) s.hand.splice(i, 1); }
    s.melds.push({ type: "kong", tiles: [tile, tile, tile, tile], from: seat, concealed: true });
    this.emit("claimed", seat, { type: "kong", tile: tile, concealed: true });
    this.drawFor(seat, "kong_replace");
    this.awaitDiscard(seat);
  };

  Game.prototype.legalClaims = function (seat, tile, from) {
    if (seat === from) return [];
    var s = this.seats[seat], c = countsOf(s.hand), out = [];
    var need = 4 - s.melds.length;
    var c2 = c.slice(); c2[tile]++;
    if (canWin(c2, need)) out.push({ type: "winOnDiscard" });
    if (c[tile] >= 3) out.push({ type: "kong" });
    if (c[tile] >= 2) out.push({ type: "pong" });
    if (!isHonor(tile) && tile < 27 && (from + 1) % 4 === seat) {
      var r = rankOf(tile), su = suitOf(tile);
      var at = function (d) { var rr = r + d; return rr >= 0 && rr <= 8 ? su * 9 + rr : -1; };
      var has = function (id) { return id >= 0 && c[id] > 0; };
      [[-2, -1], [-1, 1], [1, 2]].forEach(function (p) {
        var a = at(p[0]), b = at(p[1]);
        if (has(a) && has(b)) out.push({ type: "chow", with: [a, b] });
      });
    }
    return out;
  };

  Game.prototype.openClaimWindow = function (tile, from) {
    this.phase = "CLAIM_WINDOW";
    this.lastDiscard = { tile: tile, from: from };
    this.pendingClaims = { tile: tile, from: from, offers: {}, answers: {} };
    var self = this, any = false;
    this.seats.forEach(function (s) {
      var cl = self.legalClaims(s.idx, tile, from);
      if (cl.length) {
        self.pendingClaims.offers[s.idx] = cl;
        self.emit("claim_offered", s.idx, { tile: tile, options: cl.map(function (c) { return c.type; }) });
        any = true;
      }
    });
    if (!any) { this.afterClaims(); return; }
    if (this.autoPass && this.pendingClaims.offers[0] &&
        !this.pendingClaims.offers[0].some(function (c) { return c.type === "winOnDiscard"; })) {
      this.pendingClaims.answers[0] = null;
    }
    // Fixed minimum window so timing never leaks a held claim (§5.2), and bots
    // reply through a paced deadline rather than synchronously (§5.3).
    this.setDeadline("claimWindow", 5000);
    this.setDeadline("botClaims", 900 + Math.random() * 900);
    this.onChange();
  };
  Game.prototype.collectBotClaims = function () {
    var p = this.pendingClaims, self = this;
    if (!p) return;
    Object.keys(p.offers).forEach(function (k) {
      var i = +k;
      if (i === 0) return;
      var opts = p.offers[i];
      var winOnDiscard = opts.find(function (o) { return o.type === "winOnDiscard"; });
      if (winOnDiscard) { p.answers[i] = winOnDiscard; return; }
      var pk = opts.find(function (o) { return o.type === "pong" || o.type === "kong"; });
      var ch = opts.find(function (o) { return o.type === "chow"; });
      var onRoute = self.onRoute(i, p.tile);
      if (pk && onRoute && Math.random() < 0.85) p.answers[i] = pk;
      else if (ch && onRoute && Math.random() < 0.5) p.answers[i] = ch;
      else p.answers[i] = null;
    });
    if (Object.keys(p.offers).every(function (k) { return k in p.answers; })) {
      self.clearDeadline("claimWindow");
      self.resolveClaims();
    }
  };
  Game.prototype.answerClaim = function (seat, choice) {
    if (!this.pendingClaims) return;
    this.pendingClaims.answers[seat] = choice;
    if (!choice) this.emit("claim_declined", seat, { tile: this.pendingClaims.tile });
    var p = this.pendingClaims;
    if (Object.keys(p.offers).every(function (k) { return k in p.answers; })) {
      this.clearDeadline("claimWindow");
      this.resolveClaims();
    }
    this.onChange();
  };

  /* --- priority: winOnDiscard > kong/pong > chow, ties nearest seat (§5.2) --- */
  Game.prototype.resolveClaims = function () {
    var p = this.pendingClaims;
    this.clearDeadline("botClaims");
    if (!p) return;
    var order = ["winOnDiscard", "kong", "pong", "chow"], self = this, winner = null;
    order.forEach(function (type) {
      if (winner) return;
      for (var d = 1; d <= 3; d++) {
        var seat = (p.from + d) % 4;
        var a = p.answers[seat];
        if (a && a.type === type) { winner = { seat: seat, claim: a }; return; }
      }
    });
    if (!winner) { this.afterClaims(); return; }
    var seat = winner.seat, claim = winner.claim, tile = p.tile;
    this.pendingClaims = null;
    if (claim.type === "winOnDiscard") return this.tryWin(seat, tile, false, p.from);
    var s = this.seats[seat], take = [];
    if (claim.type === "chow") take = claim.with.slice();
    else take = [tile, tile].concat(claim.type === "kong" ? [tile] : []);
    take.forEach(function (t) { var i = s.hand.indexOf(t); if (i >= 0) s.hand.splice(i, 1); });
    s.melds.push({ type: claim.type, tiles: take.concat([tile]), from: p.from, concealed: false });
    this.seats[p.from].discards.pop();
    this.emit("claimed", seat, { type: claim.type, tile: tile, from: p.from });
    if (claim.type === "kong") this.drawFor(seat, "kong_replace");
    this.awaitDiscard(seat);   // pong/chow → claimant discards, no draw
  };

  Game.prototype.afterClaims = function () {
    this.pendingClaims = null;
    var next = (this.lastDiscard.from + 1) % 4;
    if (this.wallIdx >= this.wall.length - 14) return this.endHand({ outcome: "exhaustive_draw" });
    var s = this.seats[next];
    this.drawFor(next);
    var c = countsOf(this.handTiles(next));
    if (canWin(c, 4 - s.melds.length)) {
      if (!s.isYou) return this.tryWin(next, s.drawn, true, null);
      this.selfDrawAvailable = true;
    } else this.selfDrawAvailable = false;
    this.awaitDiscard(next);
  };

  /* --- refused below-minimum wins emit visible events (§5.2) --- */
  Game.prototype.tryWin = function (seat, tile, selfDraw, from) {
    var s = this.seats[seat];
    var probe = { hand: this.handTiles(seat).concat(selfDraw ? [] : [tile]), melds: s.melds, flowers: s.flowers, windIdx: s.windIdx };
    if (!selfDraw) probe.hand = s.hand.concat([tile]);
    var sc = faanFor(probe, this, { selfDraw: selfDraw });
    if (sc.faan < 3) {
      this.emit("refused_win", seat, { tile: tile, faan: sc.faan, reason: "below 3-faan minimum" });
      this.lastRefusal = { seat: seat, tile: tile, faan: sc.faan, at: Date.now() };
      if (selfDraw) { this.selfDrawAvailable = false; return this.awaitDiscard(seat); }
      return this.afterClaims();
    }
    this.emit(selfDraw ? "tsumo" : "winOnDiscard", seat, { tile: tile, faan: sc.faan, from: from });
    this.endHand({ outcome: selfDraw ? "tsumo" : "winOnDiscard", winner: seat, from: from, score: sc, tile: tile });
  };

  Game.prototype.endHand = function (res) {
    this.phase = "HAND_END";
    this.stop();
    var chips = [0, 0, 0, 0];
    if (res.winner != null) {
      var base = Math.pow(2, Math.min(res.score.faan, 10)) * 2;
      if (res.outcome === "tsumo") {
        for (var i = 0; i < 4; i++) if (i !== res.winner) { chips[i] -= base; chips[res.winner] += base; }
      } else { chips[res.from] -= base * 3; chips[res.winner] += base * 3; }
    }
    res.chips = chips;
    this.seats.forEach(function (s, i) { s.chips += chips[i]; });
    this.emit("hand_end", null, { outcome: res.outcome, winner: res.winner, chips: chips });
    this.result = res;
    this.onHandEnd(res);
    this.onChange();
  };

  root.MJEngine = {
    Game: Game, NAMES: NAMES, WINDS: WINDS, isFlower: isFlower, isHonor: isHonor,
    suitOf: suitOf, rankOf: rankOf, countsOf: countsOf, canWin: canWin,
    distanceToReady: distanceToReady, liveTiles: liveTiles,
    faanFor: faanFor, buildWall: buildWall, FLOWER_START: FLOWER_START
  };
})(window);

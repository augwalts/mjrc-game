/* MJRC Game — P0 sketch UI.
 * Screens per DESIGN.md §2 screen map, extended with the menu/IA skeleton.
 * Interaction grammar borrowed from Mahjong Soul / Riichi City: separated draw
 * tile, bottom-right call buttons with countdown ring, base clock + time bank,
 * auto-pass, per-seat discard pools, melds rotated to show claim source.
 */
(function () {
"use strict";
var E = window.MJEngine, T = window.MJTiles;
var $ = function (s, r) { return (r || document).querySelector(s); };

var S = {
  screen: "landing", room: null, reviewIx: 0, obs: null, keys: false, chowIx: 0,
  turn: null, reveal: false, toss: { seq: -1, at: 0 }, tossSalt: 0, tossOverride: null,
  ritual: null, ritualTimer: null, diceCount: 3, tab: "play", game: null, result: null, matches: [],
  replay: { log: [], idx: 0, playing: false, shared: false },
  resTab: 0, sel: null, toast: null, sig: "",
  dev: "phone",
  opts: { labels: true, autoPass: false, floor: false, omni: false, notes: true,
          riichi: false, attrib: false, safe: false },
  me: { name: "You", rating: 1500, provisional: true, played: 0, signedIn: false, handle: "augustine" }
};

/* ─────────── tile helpers ─────────── */
function tile(id, cls) {
  return '<span class="t ' + (cls || "") + '">' + T.tileSVG(id, { labels: S.opts.labels && typeof id === "number" && id < 34 }) + "</span>";
}
function back() { return '<span class="t">' + T.tileSVG("back") + "</span>"; }
function tiles(arr, cls) { return arr.map(function (t) { return tile(t, cls); }).join(""); }
function nm(t) { return E.NAMES[t] || "?"; }

/* ─────────── shell ─────────── */
function appbar(title, backTo, right) {
  return '<div class="appbar">' +
    (backTo ? '<span class="back" data-nav="' + backTo + '">‹ Back</span>' : "") +
    '<span class="ttl">' + title + "</span>" + (right || "") + "</div>";
}
function header() {
  var nav = [["play", "Play", "lobby"], ["review", "Review", "matches"], ["learn", "Learn", "learn"]];
  return '<div class="hdr">' +
    '<div class="brand" data-nav="lobby">\u96C0</div>' +
    '<div class="hnav">' + nav.map(function (x) {
      return '<span class="' + (S.tab === x[0] ? "on" : "") + '" data-nav="' + x[2] + '" data-tab="' + x[0] + '">' + x[1] + "</span>";
    }).join("") + "</div>" +
    '<div class="spacer"></div>' +
    (S.room ? '<span class="roomchip" data-nav="room">\u25C9 ' + S.room + "</span>" : "") +
    '<span class="rat">' + S.me.rating + '<i>prov</i></span>' +
    '<span class="who" data-nav="profile">' + (S.me.signedIn ? "@" + S.me.handle : "Guest") + "</span>" +
    '<span class="gear" data-nav="settings">\u2699</span></div>';
}

/* ─────────── screens: onboarding / lobby / menus ─────────── */
function scLanding() {
  return '<div class="body" style="padding:0"><div class="hero">' +
    '<div class="big" style="margin-bottom:14px">' + tiles([31, 0, 9, 18], "") + "</div>" +
    '<h1 style="margin:0 0 6px;font-size:26px">Hong Kong mahjong</h1>' +
    '<div class="mut" style="margin-bottom:20px">Ranked, logged, reviewable. English-first. No gacha.</div>' +
    '<div style="width:min(320px,90%)">' +
      '<button class="btn" data-act="signin">Sign in with Google</button>' +
      '<button class="btn ghost" data-act="guest">Play as guest</button>' +
      '<div class="tiny mut" style="margin-top:10px">Guest play uses a device token. Sign in later and ' +
      "your hands come with you.</div></div></div></div>";
}
function scSignin() {
  return appbar("Sign in", "landing") + '<div class="body">' +
    '<div class="card" style="text-align:center;padding:22px">' +
      '<div style="font-size:30px;margin-bottom:8px">\u{1F510}</div>' +
      "<b>Continue with Google</b>" +
      '<div class="tiny mut" style="margin:6px 0 16px">The only sign-in path. One account, ' +
      "used by both the game and the Almanac.</div>" +
      '<button class="btn" data-act="dosignin">Continue</button></div>' +
    '<div class="card tiny mut">By continuing you accept the privacy policy. ' +
    '<span class="pill stub">D8 \u2014 Augustine writes this, blocks Phase 2</span></div></div>';
}
function scHandle() {
  return appbar("Choose a handle") + '<div class="body">' +
    '<div class="card"><div class="tiny mut" style="margin-bottom:7px">Handle</div>' +
      '<input type="text" value="' + S.me.handle + '" data-act="sethandle">' +
      '<div class="tiny mut" style="margin-top:7px">Changeable later; the old handle is kept and ' +
      "not reusable by anyone else (D7).</div></div>" +
    '<div class="card"><div class="row tiny"><b>Keep your guest hands?</b><div class="spacer"></div>' +
      '<span class="pill stub">needs a decision</span></div>' +
      '<div class="tiny mut" style="margin-top:5px">You played <b>' + S.me.played + " hands</b> as a guest. " +
      "\u00A76.6 makes merge-on-first-sign-in mandatory, but D2 forbids adopting a legacy Almanac session. " +
      "Game history is machine-witnessed, so it is a different case \u2014 decide it explicitly.</div></div>" +
    '<button class="btn" data-nav="lobby">Continue</button></div>';
}
function scOnboarding() {
  return appbar("Welcome") + '<div class="body">' +
    '<div class="card" style="text-align:center;padding:22px 12px">' +
      '<div class="big">' + tiles([31, 0, 9, 18], "") + "</div>" +
      '<h2 style="margin:14px 0 4px;font-size:17px">Hong Kong mahjong</h2>' +
      '<div class="mut tiny">Ranked, logged, replayable. English-first.</div></div>' +
    '<div class="card"><div class="tiny mut" style="margin-bottom:6px">Display name</div>' +
      '<input type="text" value="You" style="letter-spacing:0"></div>' +
    '<button class="btn" data-nav="lobby">Start playing</button>' +
    '<div class="tiny mut" style="text-align:center;margin-top:6px">' +
      'No account needed. A device token identifies you until you add passkeys ' +
      '<span class="pill p1">P1</span></div></div>';
}

function scLobby() {
  S.tab = "play";
  var stat = function (v, l) { return '<div class="st"><b>' + v + "</b><span>" + l + "</span></div>"; };
  var upd = [["2026-08-26", "Claim priority now resolves ties to the nearest seat."],
             ["2026-08-24", "Flower replacement is strictly ordered \u2014 replays re-execute deterministically."],
             ["2026-08-21", "Concealed kong \u6697\u69D3 added to the own-turn declaration path."]];
  return header() + '<div class="body"><div class="col wide">' +
    '<div class="card"><div class="row">' +
      '<div><div class="tiny mut">Provisional rating</div>' +
      '<div style="font-size:30px;font-weight:700;line-height:1.1">' + S.me.rating + "</div></div>" +
      '<div class="spacer"></div><div class="stats">' +
        stat(S.me.played, "hands") + stat("26%", "win rate") + stat("4.4", "mean faan") +
      "</div></div></div>" +
    '<div class="grid2" style="align-items:start"><div>' +
      '<button class="btn" data-act="quick">Quick match <span style="opacity:.75;font-weight:400">\u00B7 vs bots</span></button>' +
      '<button class="btn ghost" data-act="quick">Quick match \u00B7 vs players <span class="pill p1">P1</span></button>' +
      '<button class="btn ghost" data-nav="create">Create a table</button>' +
      '<button class="btn ghost" data-nav="join">Join with code</button>' +
      '<button class="btn ghost" data-nav="rooms">My rooms</button>' +
    "</div><div>" +
      '<div class="card"><div class="row tiny" style="margin-bottom:8px"><b>Updates</b></div>' +
      upd.map(function (u) {
        return '<div style="padding:6px 0;border-bottom:1px solid #f0f0f2">' +
          '<div class="tiny mut">' + u[0] + "</div><div>" + u[1] + "</div></div>";
      }).join("") + "</div>" +
    "</div></div></div></div>";
}

function scCreate() {
  var opt = function (label, val, note) {
    return '<div class="row" style="padding:8px 0;border-bottom:1px solid #eee">' +
      "<div><div>" + label + '</div><div class="tiny mut">' + (note || "") + "</div></div>" +
      '<div class="spacer"></div><b class="tiny">' + val + "</b></div>";
  };
  return appbar("Create table", "lobby") + '<div class="body">' +
    '<div class="card" style="padding:2px 12px">' +
      opt("Ruleset", "Canonical HKOS", "§4 — 3 faan min, 13 cap, flowers, wind faan") +
      opt("Match length", "One wind round 東圈", "4 rotations + repeats · ~20-35 min") +
      opt("Claim window", "5s fixed", "Fixed minimum so timing never leaks a claim") +
      opt("Seats", "1 human + 3 bots", "Bots fill empty seats") +
    "</div>" +
    '<div class="card"><div class="row tiny"><b>House rule presets</b>' +
      '<div class="spacer"></div><span class="pill">config, not code</span></div>' +
      '<div class="tiny mut" style="margin-top:5px">LIU variant · Taiwanese 16-tile ' +
      '<span class="pill p1">later</span> — §4 loads faan and payment tables from config.</div></div>' +
    '<button class="btn" data-act="quick">Create &amp; start</button></div>';
}

function scRooms() {
  var rooms = [["Sunday Set", "SUNSET", 8, "Canonical HKOS", "3 online \u00B7 41 offline"],
               ["TVB 2026 study group", "TVB26", 12, "Canonical HKOS", "0 online \u00B7 96 offline"],
               ["LA scene", "LASCN", 21, "LIU house preset", "6 online \u00B7 12 offline"]];
  return header() + '<div class="body"><div class="col wide">' +
    '<div class="banner info" style="margin-bottom:10px">A room is a join code + a pinned ruleset + ' +
    "a roster + N tables. It already exists in the Almanac \u2014 the game reuses it rather than " +
    "forking a second one.</div>" +
    '<div class="card">' + rooms.map(function (r) {
      return '<div class="mrow" data-nav="room" data-room="' + r[1] + '">' +
        '<div class="res" style="background:#4a5a7a">' + r[0].slice(0, 1) + "</div>" +
        "<div><div><b>" + r[0] + '</b></div><div class="tiny mut">' + r[1] + " \u00B7 " + r[2] +
        " players \u00B7 " + r[3] + "</div></div>" +
        '<div class="spacer"></div><div class="tiny mut">' + r[4] + "</div></div>";
    }).join("") + "</div>" +
    '<button class="btn ghost" data-nav="join">Join a room by code</button></div></div>';
}
function scRoom() {
  var roster = [["Augustine", 1512, "42 / 12"], ["Ah Ming", 1488, "38 / 0"], ["Kai", 1502, "31 / 6"],
                ["Suki", 1470, "29 / 3"], ["Wing", "\u2014", "18 / 0"]];
  var sessions = [["online", "Match \u00B7 \u6771\u570F", "26 Aug", "4 hands"],
                  ["offline", "Table 2 \u00B7 Almanac", "24 Aug", "11 hands"],
                  ["offline", "Table 1 \u00B7 Almanac", "24 Aug", "9 hands"],
                  ["online", "Match \u00B7 \u6771\u570F", "22 Aug", "6 hands"]];
  return appbar("Sunday Set", "rooms", '<span class="pill">SUNSET</span>') +
    '<div class="body"><div class="col wide"><div class="grid2" style="align-items:start"><div>' +
      '<div class="card"><div class="row tiny" style="margin-bottom:7px"><b>Roster</b>' +
      '<div class="spacer"></div><span class="pill" style="background:#e2efe6;color:#1A8B3A">exact by construction</span></div>' +
      '<table><tr><th>Player</th><th>Rating</th><th>Hands off/on</th></tr>' +
      roster.map(function (r) {
        return "<tr><td>" + r[0] + "</td><td>" + r[1] + '</td><td style="text-align:right">' + r[2] + "</td></tr>";
      }).join("") + "</table>" +
      '<div class="tiny mut" style="margin-top:7px">Roster identity is why this room can compare ' +
      "offline and online at all. Ad-hoc sessions stay name-only.</div></div>" +
    "</div><div>" +
      '<div class="card"><div class="row tiny" style="margin-bottom:7px"><b>Pinned ruleset</b>' +
      '<div class="spacer"></div><span class="pill">admin-set</span></div>' +
      '<div class="tiny mut">Canonical HKOS \u00B7 3 faan min \u00B7 13 cap \u00B7 flowers on \u00B7 one wind round</div></div>' +
      '<div class="card"><div class="row tiny" style="margin-bottom:7px"><b>Recent sessions</b></div>' +
      sessions.map(function (x) {
        var on = x[0] === "online";
        return '<div class="row" style="padding:5px 0;border-bottom:1px solid #f0f0f2">' +
          '<span class="pill" style="background:' + (on ? "#e2efe6;color:#1A8B3A" : "#ececed;color:#6b6b76") + '">' +
          x[0] + "</span><span>" + x[1] + '</span><div class="spacer"></div>' +
          '<span class="tiny mut">' + x[2] + " \u00B7 " + x[3] + "</span></div>";
      }).join("") + "</div>" +
    "</div></div></div></div>";
}

function scJoin() {
  return appbar("Join table", "lobby") + '<div class="body">' +
    '<div class="card"><div class="tiny mut" style="margin-bottom:7px">6-character table code</div>' +
      '<input type="text" placeholder="A7K2QM" maxlength="6" style="text-align:center;font-size:22px;font-weight:700"></div>' +
    '<button class="btn" data-act="quick">Join</button>' +
    '<div class="tiny mut" style="text-align:center">Codes are ≥6 chars with a per-IP join rate limit — ' +
      'the minimum abuse posture for an invite-only alpha (§5.3).</div></div>';
}

/* ─────────── match scene ─────────── */
function melds(s) {
  return '<div class="meld">' + s.melds.map(function (m) {
    return '<div class="set' + (m.concealed ? " conc" : "") + '">' + tiles(m.tiles) + "</div>";
  }).join("") + "</div>";
}
function seatCard(i, pos) {
  var g = S.game, s = g.seats[i], isTurn = g.turn === i && g.phase === "AWAIT_DISCARD";
  var conceal = s.hand.length + (s.drawn !== null ? 1 : 0), side = pos === "left" || pos === "right", k;
  var h = '<div class="seat ' + (side ? "side " : "") + (isTurn ? "turn " : "") + pos + '">' +
    '<div class="hd"><span class="wd">' + E.WINDS[s.windIdx] + '</span>' +
    '<span class="nm">' + s.name + '</span>' +
    '<span class="ch">' + (s.chips >= 0 ? "+" : "") + s.chips + "</span></div>";
  if (S.opts.omni) h += '<div class="pool">' + tiles(s.hand.concat(s.drawn !== null ? [s.drawn] : [])) + "</div>";
  else if (side) { h += '<div class="edges">'; for (k = 0; k < conceal; k++) h += "<i></i>"; h += "</div>"; }
  else { h += '<div class="back-strip">'; for (k = 0; k < conceal; k++) h += back(); h += "</div>"; }
  if (s.melds.length) h += melds(s);
  if (s.flowers.length) h += '<div class="flow">' + tiles(s.flowers) + "</div>";
  return h + "</div>";
}

function callButtons() {
  var g = S.game, p = g.pendingClaims, out = [];
  if (g.phase === "AWAIT_DISCARD" && g.turn === 0) {
    if (g.selfDrawAvailable) out.push('<button class="cbtn win" data-act="tsumo">Self-draw<small>\u81EA\u6478 zi mo</small></button>');
    g.concealedKongOptions(0).forEach(function (t) {
      out.push('<button class="cbtn" data-act="ckong" data-t="' + t + '">Kong<small>\u69D3 gong</small></button>');
    });
  }
  if (p && p.offers[0] && !(0 in p.answers)) {
    var frac = g.remaining("claimWindow") / 5000;
    p.offers[0].forEach(function (c, ix) {
      var lbl = { winOnDiscard: "\u98DF\u7CCA<small>Ron</small>", kong: "\u69D3<small>Kong</small>",
                  pong: "\u78B0<small>Pong</small>", chow: "\u4E0A<small>Chow</small>" }[c.type];
      out.push('<button class="cbtn' + (c.type === "winOnDiscard" ? " win" : "") + '" data-act="claim" data-i="' + ix + '">' + lbl + "</button>");
    });
    out.push('<button class="cbtn pass" data-act="pass">Pass' + ring(frac) + "</button>");
  }
  return '<div class="calls">' + out.join("") + "</div>";
}
function ring(frac) {
  var r = 26, c = 2 * Math.PI * r;
  return '<svg class="ring" viewBox="0 0 60 60"><circle cx="30" cy="30" r="' + r + '" stroke="rgba(255,255,255,.3)"/>' +
    '<circle cx="30" cy="30" r="' + r + '" stroke="#fff" stroke-dasharray="' + c + '" ' +
    'stroke-dashoffset="' + (c * (1 - frac)) + '" stroke-linecap="round"/></svg>';
}

/* ─────────── the pre-hand ritual ───────────
 * 洗牌 shuffle · 砌牌 build the walls · 擲骰 throw the dice · 開牌 break the wall.
 *
 * This is not decoration. The dice decide WHERE the wall is broken, which is
 * real state, and both the wall order and the dice come from the same seed —
 * so the whole deal is determined before a tile moves. That makes it verifiable:
 * publish a hash of the seed before the hand, reveal the seed after, and anyone
 * can recompute the wall and confirm nothing was rigged. A digital mahjong game
 * has to answer "is this dealt fairly", and the dice are where you answer it.
 *
 * [NEEDS VALIDATION] Dice count is a house variant — HK sets ship two or three.
 * Configurable; defaulting to three.
 */
var RITUAL = [
  { phase: "shuffle", ms: 950,  label: "Shuffling \u00B7 \u6D17\u724C sai paai" },
  { phase: "build",   ms: 800,  label: "Building the walls \u00B7 \u780C\u724C cai paai" },
  { phase: "dice",    ms: 900,  label: "Throwing the dice \u00B7 \u64F2\u9AB0 zaak sik" },
  { phase: "break",   ms: 550,  label: "Breaking the wall \u00B7 \u958B\u724C hoi paai" },
];

function startRitual(g) {
  var rnd = E.prng ? E.prng(g.seed) : null;
  var dice = [], i;
  for (i = 0; i < (S.diceCount || 3); i++) {
    dice.push(rnd ? 1 + Math.floor(rnd() * 6) : 1 + ((g.seed >> (i * 3)) % 6));
  }
  var sum = dice.reduce(function (a, b) { return a + b; }, 0);
  S.ritual = {
    step: 0, at: Date.now(), dice: dice, sum: sum,
    // counted anticlockwise from the dealer, then that many stacks along
    breakWall: (g.dealer + sum - 1) % 4,
    breakStack: ((sum - 1) % 18),
  };
  clearInterval(S.ritualTimer);
  S.ritualTimer = setInterval(function () {
    var r = S.ritual;
    if (!r || r.step >= RITUAL.length) { clearInterval(S.ritualTimer); return; }
    if (Date.now() - r.at >= RITUAL[r.step].ms) {
      r.step++; r.at = Date.now();
      if (r.step >= RITUAL.length) { clearInterval(S.ritualTimer); S.ritual = null; }
      S.sig = ""; render();
    }
  }, 60);
}
function skipRitual() {
  clearInterval(S.ritualTimer);
  S.ritual = null; S.sig = ""; render();
}

function ritualView(g) {
  var r = S.ritual;
  if (!r || r.step >= RITUAL.length) return "";
  var step = RITUAL[r.step], geo = wallGeometry();
  var building = r.step >= 1;
  var tiles = geo.map(function (c, i) {
    // before the walls are built the tiles are a loose heap in the middle
    var jx = (jit(i, 11) - 0.5) * 118, jy = (jit(i, 12) - 0.5) * 88;
    var jr = (jit(i, 13) - 0.5) * 300;
    var x = building ? c.x : jx, y = building ? c.y : jy, rot = building ? c.rot : jr;
    // 開牌 — the break opens a visible gap at the dice-chosen spot
    var broken = r.step >= 3 && c.wall === r.breakWall && Math.abs(c.idx - r.breakStack) < 2;
    return '<i class="rstk' + (broken ? " broken" : "") + '" style="left:' + x.toFixed(1) +
      "px;top:" + y.toFixed(1) + "px;width:" + c.sw + "px;height:" + c.sh.toFixed(1) +
      "px;transform:translate(-50%,-50%) rotate(" + rot.toFixed(0) + "deg);transition-delay:" +
      (building ? (i % 18) * 9 : 0) + 'ms"></i>';
  }).join("");

  var dice = r.step >= 2
    ? '<div class="dice">' + r.dice.map(function (d, i) {
        return '<b class="die" style="animation-delay:' + i * 70 + 'ms">' + d + "</b>";
      }).join("") + "</div>"
    : "";

  return '<div class="ritual" data-act="skipritual">' +
    '<div class="rwalls">' + tiles + dice + "</div>" +
    '<div class="rlabel">' + step.label +
      (r.step >= 2 ? ' \u00B7 <b>' + r.sum + "</b>" : "") +
      '<span>tap to skip</span></div></div>";'.replace('";', '"');
}

function scMatch() {
  var g = S.game;
  if (!g) { startGame(); g = S.game; }
  var me = g.seats[0], myTurn = g.phase === "AWAIT_DISCARD" && g.turn === 0;
  var rem = g.wall.length - g.wallIdx;
  var POS = { 2: "top", 1: "left", 3: "right" };
  var badges = "", pools = "";
  [1, 2, 3].forEach(function (i) { badges += seatBadge(i, POS[i]); });
  if (S.opts.riichi)
    [[0, "db"], [2, "dt"], [1, "dl"], [3, "dr"]].forEach(function (x) { pools += discardPool(g, x[0], x[1]); });
  else pools = pileView(g);

  var ritual = ritualView(g);
  return '<div class="match"><div class="arena">' + ritual +
    // match info lives top-left so the top-centre stays clear for the across seat
    '<div class="corner tl"><b>' + E.WINDS[g.roundWind] + "\u5708</b> \u00B7 hand " +
      (g.handIdx + 1) + " \u00B7 <b>" + rem + '</b> tiles<br><span style="opacity:.65">4P \u00B7 vs bots \u00B7 ' +
      (S.room ? S.room : "casual") + "</span></div>" +
    '<div class="rnd">' + (g.phase === "CLAIM_WINDOW" ? "claim window"
      : g.turn === 0 ? "your turn" : g.seats[g.turn].name + " thinking\u2026") + "</div>" +
    '<div class="corner tr"><button class="iconbtn" data-act="showkeys">?</button>' +
      '<button class="iconbtn" data-nav="settings">\u2699</button></div>' +
    '<div class="autos">' +
      '<b class="' + (S.opts.autoPass ? "on" : "") + '" data-act="toggleauto" title="auto-pass">A</b>' +
      '<b title="auto-win">W</b><b title="auto-call off">C</b><b title="auto-discard">D</b></div>' +
    '<div class="corner br"><button class="iconbtn">\u{1F4AC}</button></div>' +
    '<div class="surface">' + wallStacks(rem) + pools + "</div>" +
    (S.opts.riichi ? centreBox(g, rem) : "") + badges +
  "</div>" + youBar(g, me, myTurn) + "</div>";
}

// The wall as a physical, depleting object. Wall count drives push/fold in HK
// more than in Riichi, so it should be a thing that shrinks, not a number.
// Deterministic per-tile scatter. Must not change between renders or the pile
// visibly reshuffles every tick.
function jit(i, salt) {
  var x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// The true discard sequence, folded out of the event log: pushed on `discard`,
// popped on a non-concealed `claimed` (the tile left the table into a meld).
function globalPile(g) {
  var out = [];
  g.log.forEach(function (e) {
    if (e.type === "discard") out.push({ tile: e.payload.tile, from: e.actor, seq: e.seq });
    else if (e.type === "claimed" && !e.payload.concealed) {
      for (var i = out.length - 1; i >= 0; i--)
        if (out[i].tile === e.payload.tile) { out.splice(i, 1); break; }
    }
  });
  return out;
}

/* Non-overlapping scatter.
 *
 * A tile thrown onto a table lands flat, at some angle, NEXT TO the others —
 * it does not stack on them. So the pile must be messy but fully countable.
 *
 * Guarantee: cells are square with side = the tile's DIAGONAL (times a margin).
 * A rectangle rotated by any angle whatsoever fits inside a square of its own
 * diagonal, so no two tiles can overlap at any rotation. Rows are staggered by
 * half a cell to kill the grid read; nearest-centre distance across a staggered
 * row is 1.047 * cell, so the guarantee survives the stagger and the jitter.
 */
function scatterLayout(n, tileW) {
  var h = tileW * 1.4;                                  // tile viewBox is 100x140
  var diag = Math.sqrt(tileW * tileW + h * h);
  var cell = diag * 1.15;                               // margin absorbs the jitter
  var R = Math.ceil(Math.sqrt(n)) + 2, cells = [], gx, gy;
  for (gy = -R; gy <= R; gy++) {
    for (gx = -R; gx <= R; gx++) {
      var x = gx * cell + (gy & 1 ? cell * 0.5 : 0);
      var y = gy * cell * 0.92;
      cells.push({ x: x, y: y, d: x * x + y * y * 1.35 });   // grow wider than tall
    }
  }
  cells.sort(function (a, b) { return a.d - b.d; });
  return cells.slice(0, n).map(function (c, i) {
    return {
      x: c.x + (jit(i, 5) - 0.5) * cell * 0.10,
      y: c.y + (jit(i, 6) - 0.5) * cell * 0.10,
      rot: (jit(i, 1) - 0.5) * 100                      // +-50 deg: messy, still readable
    };
  });
}

var PILE_W = { phone: 10, phonesm: 8.5, ipad: 15, desktop: 17 };

/* How a seat throws is a personality trait, so it must be STABLE for a player
   across the whole match — not random per discard. Eventually this comes from
   the hand model; for now it is derived from the seat so each bot reads
   consistently. */
var TOSS_STYLES = ["fling", "place", "slide", "slam"];
function tossStyleFor(seat) {
  return S.tossOverride || TOSS_STYLES[(seat + (S.tossSalt || 0)) % TOSS_STYLES.length];
}

/** Called when a new discard event is observed. Pure bookkeeping, no render. */
function noteToss(g) {
  if (!g || !g.log) return;
  for (var i = g.log.length - 1; i >= 0; i--) {
    if (g.log[i].type === "discard") {
      if (g.log[i].seq !== S.toss.seq) S.toss = { seq: g.log[i].seq, at: Date.now() };
      return;
    }
  }
}

function pileView(g) {
  var pile = globalPile(g), last = pile.length - 1;
  var SEATC = ["#ffd479", "#8fd0ff", "#ff9f9f", "#a5e8b0"];
  var w = PILE_W[S.dev] || 12;
  var pos = scatterLayout(pile.length, w);
  return '<div class="pile">' + pile.map(function (d, i) {
    var p = pos[i];
    var ring = S.opts.attrib
      ? ";box-shadow:0 0 0 1.5px " + SEATC[d.from] + ";border-radius:2px" : "";
    // Toss state is set when the discard EVENT is seen (see noteToss), never
    // mutated here — a render must be a pure function of state or the class is
    // consumed by whichever render happens to run first.
    var fresh = i === last && d.seq === S.toss.seq && Date.now() - S.toss.at < 600;
    var style = fresh ? " toss toss-" + tossStyleFor(d.from) : "";
    // thrown in from the discarder's own side of the table
    var FROM = [[0, 95], [-110, 10], [0, -95], [110, 10]][d.from] || [0, 95];
    return '<span class="t' + (i === last ? " last" : "") + style +
      '" style="width:' + w + "px;left:" + p.x.toFixed(1) + "px;top:" + p.y.toFixed(1) +
      "px;--rot:" + p.rot.toFixed(1) + "deg;--fx:" + FROM[0] + "px;--fy:" + FROM[1] + "px" +
      ring + '">' + T.tileSVG(d.tile, { labels: false }) + "</span>";
  }).join("") + "</div>";
}

/* A real wall: four walls of 18 stacks, two tiles high = 36 each, 144 total,
 * laid out as a diamond so the corners point at the players.
 *
 * Positions are computed here rather than composed in CSS: build the square in
 * its own space, then rotate every stack 45 deg about the centre. Deterministic,
 * and immune to transform-order surprises.
 */
var STACK_W = { phone: 6.5, phonesm: 5.5, ipad: 11, desktop: 12 };

/** Positions of all 72 stacks, in the same space wallStacks renders into. */
function wallGeometry() {
  var sw = STACK_W[S.dev] || 8, sh = sw * 1.4, pitch = sw + 1, half = 18 * pitch / 2;
  var C = Math.cos(Math.PI / 4), Sn = Math.sin(Math.PI / 4), out = [], w, i;
  var edge = [
    [-half, -half, half, -half], [half, -half, half, half],
    [half, half, -half, half], [-half, half, -half, -half]
  ];
  for (w = 0; w < 4; w++) {
    var e = edge[w];
    for (i = 0; i < 18; i++) {
      var f = (i + 0.5) / 18;
      var px = e[0] + (e[2] - e[0]) * f, py = e[1] + (e[3] - e[1]) * f;
      out.push({ wall: w, idx: i, sw: sw, sh: sh,
                 x: px * C - py * Sn, y: px * Sn + py * C, rot: w * 90 + 45 });
    }
  }
  return out;
}

function wallStacks(rem) {
  var sw = STACK_W[S.dev] || 8, sh = sw * 1.4, gap = 1;
  var pitch = sw + gap, L = 18 * pitch, half = L / 2;
  var total = 72, live = Math.ceil(rem / 2), used = total - live;
  var C = Math.cos(Math.PI / 4), Sn = Math.sin(Math.PI / 4);
  var out = "", w, i;
  // edges of the square, clockwise from the top
  var edge = [
    [-half, -half, half, -half], [half, -half, half, half],
    [half, half, -half, half], [-half, half, -half, -half]
  ];
  for (w = 0; w < 4; w++) {
    var e = edge[w], ang = w * 90;
    for (i = 0; i < 18; i++) {
      var n = w * 18 + i;
      if (n < used) continue;                       // consumed in order around the diamond
      var f = (i + 0.5) / 18;
      var px = e[0] + (e[2] - e[0]) * f, py = e[1] + (e[3] - e[1]) * f;
      var rx = px * C - py * Sn, ry = px * Sn + py * C;   // rotate the whole square 45 deg
      out += '<i class="stk" style="left:' + rx.toFixed(1) + "px;top:" + ry.toFixed(1) +
        "px;width:" + sw + "px;height:" + sh.toFixed(1) +
        "px;transform:translate(-50%,-50%) rotate(" + (ang + 45) + 'deg)"><b></b></i>';
    }
  }
  return '<div class="walls">' + out + "</div>";
}

function discardPool(g, i, cls) {
  var last = g.lastDiscard && g.lastDiscard.from === i ? g.seats[i].discards.length - 1 : -1;
  return '<div class="dpool ' + cls + '">' + g.seats[i].discards.map(function (t, ix) {
    return '<span class="t' + (ix === last ? " last" : "") + '">' + T.tileSVG(t, { labels: false }) + "</span>";
  }).join("") + "</div>";
}

function centreBox(g, rem) {
  var sc = function (i, cls) {
    var s = g.seats[i];
    return '<div class="sc ' + cls + '">' + E.WINDS[s.windIdx] + " " + (s.chips >= 0 ? "+" : "") + s.chips + "</div>";
  };
  var mid = g.phase === "CLAIM_WINDOW" ? "claim" :
    g.turn === 0 ? "your turn" : g.seats[g.turn].name;
  return '<div class="ctrbox">' + sc(2, "top") + sc(1, "left") + sc(3, "right") + sc(0, "bot") +
    '<div class="mid"><b>' + rem + "</b><span>tiles</span>" +
    '<span style="margin-top:2px;display:block;color:#cfe3dc">' + mid + "</span></div></div>";
}

function seatBadge(i, pos) {
  var g = S.game, s = g.seats[i];
  var isTurn = (g.turn === i && g.phase === "AWAIT_DISCARD");
  var conceal = s.hand.length + (s.drawn !== null ? 1 : 0);
  var h = '<div class="sb ' + pos + (isTurn ? " turn" : "") + '">' +
    '<div class="av">' + E.WINDS[s.windIdx] + "</div>" +
    '<div class="nmw"><b>' + s.name + "</b><span>" + conceal + " tiles \u00B7 " +
    (s.chips >= 0 ? "+" : "") + s.chips + "</span></div></div>";
  var extra = s.melds.concat();
  if (extra.length || s.flowers.length) {
    h += '<div class="sbmeld ' + pos + '">' + extra.map(function (m) {
      return '<div class="set' + (m.concealed ? " conc" : "") + '">' + tiles(m.tiles) + "</div>";
    }).join("") + (s.flowers.length ? '<div class="set">' + tiles(s.flowers) + "</div>" : "") + "</div>";
  }
  if (S.opts.omni) h += '<div class="sbmeld ' + pos + '" style="top:auto;bottom:6px">' +
    '<div class="set">' + tiles(s.hand) + "</div></div>";
  return h;
}

function youBar(g, me, myTurn) {
  var clock = myTurn ? g.remaining("turnClock") / 10000 : 0;
  var meta = '<div class="youmeta"><div class="row tiny" style="gap:5px">' +
    '<b style="font-size:14px">' + E.WINDS[me.windIdx] + "</b><span>You</span></div>" +
    '<div class="tiny mut">' + (me.chips >= 0 ? "+" : "") + me.chips + "</div></div>";
  var mrow = (me.melds.length || me.flowers.length)
    ? '<div class="youmelds">' + me.melds.map(function (m) {
        return '<div class="set' + (m.concealed ? " conc" : "") + '">' + tiles(m.tiles) + "</div>";
      }).join("") + (me.flowers.length ? '<div class="set">' + tiles(me.flowers) + "</div>" : "") + "</div>"
    : "";

  var ban = "";
  if (S.opts.floor) ban += '<div class="banner warn">\u26A0 No legal path to 3 faan \u2014 this hand cannot be won as it stands.</div>';
  if (g.lastRefusal && Date.now() - g.lastRefusal.at < 4000) {
    var r = g.lastRefusal;
    ban += '<div class="banner info">' + g.seats[r.seat].name + " hit " + nm(r.tile) +
      " but held only " + r.faan + " faan \u2014 below the 3-faan minimum.</div>";
  }
  var hand = '<div class="handwrap">' + ban + '<div class="hand">' +
    me.hand.map(function (t, ix) {
      return '<span class="t' + (S.sel === ix ? " sel" : "") + '" data-act="tap" data-ix="' + ix + '">' +
        T.tileSVG(t, { labels: S.opts.labels }) + "</span>";
    }).join("") +
    (me.drawn !== null ? '<span class="gap"></span><span class="t' + (S.sel === -1 ? " sel" : "") +
      '" data-act="tap" data-ix="-1">' + T.tileSVG(me.drawn, { labels: S.opts.labels }) + "</span>" : "") +
    "</div>" +
    (myTurn ? '<div class="clock"><i style="width:' + (clock * 100) + '%"></i></div>' : "") + "</div>";

  return mrow + '<div class="youbar">' + meta + hand + callButtons() + "</div>";
}

/* ─────────── results ─────────── */
function resProgression(r, g) {
  var won = r.winner === 0, d = won ? 18 : r.outcome === "exhaustive_draw" ? 0 : -9, h = "";
  h += '<div class="card" style="text-align:center">' +
    '<div class="tiny mut">Provisional rating</div>' +
    '<div class="delta ' + (d > 0 ? "up" : d < 0 ? "down" : "") + '">' + (d > 0 ? "+" : "") + d + "</div>" +
    '<div class="tiny mut">' + S.me.rating + " \u2192 " + (S.me.rating + d) + "</div></div>";
  if (r.winner != null) {
    var w = g.seats[r.winner];
    h += '<div class="card"><div class="row tiny" style="margin-bottom:7px"><b>' + w.name +
      " won \u00B7 " + r.score.faan + ' faan</b><div class="spacer"></div>' +
      '<span class="pill stub">scoring stubbed</span></div>' +
      '<div class="pool" style="gap:2px">' + tiles(w.hand) +
      (r.tile != null ? '<span style="width:7px"></span>' + tile(r.tile) : "") + "</div>" +
      (w.melds.length ? melds(w) : "") +
      '<div style="margin-top:9px">' + r.score.detail.map(function (x) {
        var parts = x.split(/(\+\d+|\u2014 0 faan)/);
        return '<div class="faan-line"><span>' + parts[0] + "</span><b>" + (parts[1] || "") + "</b></div>";
      }).join("") + "</div></div>";
  } else h += '<div class="card" style="text-align:center"><b>Exhaustive draw \u6D41\u5C40</b>' +
    '<div class="tiny mut" style="margin-top:4px">Dealer repeats.</div></div>';
  return h;
}
function resScoreboard(r, g) {
  return '<div class="card"><table><tr><th>Seat</th><th>Player</th><th>Chips</th><th>Total</th></tr>' +
    g.seats.map(function (s, i) {
      return "<tr><td><b>" + E.WINDS[s.windIdx] + "</b></td><td>" + s.name + "</td><td>" +
        (r.chips[i] > 0 ? "+" : "") + r.chips[i] + "</td><td>" + (s.chips >= 0 ? "+" : "") + s.chips + "</td></tr>";
    }).join("") + "</table></div>" +
    '<div class="card tiny mut">Match is one wind round (\u00A74). Standings carry across hands; ' +
    "the dealer repeats on a dealer win or a draw.</div>";
}
function scResults() {
  var r = S.result, g = S.game;
  if (!r) return appbar("Results", "lobby") + '<div class="body"><div class="card mut">No completed hand yet.</div></div>';
  var wide = S.dev === "desktop" || S.dev === "ipad";
  var actions = '<div class="row"><button class="btn" data-act="share" style="margin:0">Share</button>' +
    '<button class="btn ghost" data-act="watch" style="margin:0">Watch replay</button></div>' +
    '<button class="btn ghost" data-act="nexthand">Next hand</button>';
  if (wide) {
    // Enough width for both panels — the phone's tab split is a space constraint,
    // not an information architecture. Ceremony still reads first (left).
    return appbar("Hand result", "lobby") + '<div class="body"><div class="col wide">' +
      '<div class="grid2" style="align-items:start"><div>' + resProgression(r, g) + actions + "</div>" +
      "<div>" + resScoreboard(r, g) + "</div></div></div></div>";
  }
  return appbar("Hand result", "lobby") +
    '<div class="tabs"><div class="' + (S.resTab === 0 ? "on" : "") + '" data-act="restab" data-i="0">Progression</div>' +
    '<div class="' + (S.resTab === 1 ? "on" : "") + '" data-act="restab" data-i="1">Scoreboard</div></div>' +
    '<div class="body">' + (S.resTab === 0 ? resProgression(r, g) + actions : resScoreboard(r, g)) + "</div>";
}

/* ─────────── match list / replay ─────────── */
// Every annotation here is a RULE-DERIVED FACT read out of the event log.
// No route evaluator, no theory, nothing that can be wrong. The judgement layer
// ("this discard was the wrong one") is deliberately absent — see §7.
function keyMoments(log, seat) {
  var out = [], seen = {}, ronOffered = null, i, j, e;
  var bump = function (t, n) { seen[t] = (seen[t] || 0) + (n || 1); };
  for (i = 0; i < log.length; i++) {
    e = log[i];
    if (e.type === "discard") ronOffered = null;
    if (e.type === "claim_offered" && e.actor === seat &&
        (e.payload.options || []).indexOf("winOnDiscard") >= 0) ronOffered = e.payload.tile;
    if (e.type === "claim_declined" && e.actor === seat && ronOffered === e.payload.tile) {
      out.push({ seq: e.seq, kind: "bad", text: "Passed a legal winning claim on " + nm(e.payload.tile) + "." });
      ronOffered = null;
    }
    if (e.type === "refused_win" && e.actor === seat)
      out.push({ seq: e.seq, kind: "warn", text: "Reached a winning shape at " + e.payload.faan +
        " faan \u2014 below the 3-faan floor, so it could not be taken." });
    if (e.type === "claimed" && e.actor === seat && !e.payload.concealed)
      out.push({ seq: e.seq, kind: "note", text: "Melded " + e.payload.type + " on " + nm(e.payload.tile) +
        " \u2014 hand is now exposed." });
    if (e.type === "discard") {
      var t = e.payload.tile;
      if (e.actor === seat) {
        // 4 copies exist. If 2+ were already visible, nobody can be holding the
        // two needed to pung. Says nothing about a chow wait — do not call it "safe".
        var vis = seen[t] || 0;
        if (vis >= 2 && !isHonorId(t))
          out.push({ seq: e.seq, kind: "note", text: "Discarded " + nm(t) + " with " + vis +
            " of 4 already visible \u2014 no pung or kong wait possible. A chow wait still is." });
        else if (vis >= 2)
          out.push({ seq: e.seq, kind: "note", text: "Discarded " + nm(t) + " with " + vis +
            " of 4 already visible \u2014 cannot be claimed at all (honours do not chow)." });
        for (j = i + 1; j < Math.min(i + 8, log.length); j++) {
          if (log[j].type === "winOnDiscard" && log[j].payload.tile === t) {
            out.push({ seq: e.seq, kind: "bad", text: "Dealt in \u2014 " + nm(t) + " won for " +
              log[j].payload.faan + " faan." });
            break;
          }
          if (log[j].type === "discard") break;
        }
      }
      bump(t);
    }
    // the claimed tile was already counted at its discard; only add what came out of hand
    if (e.type === "claimed") {
      if (e.payload.concealed) bump(e.payload.tile, 4);
      else if (e.payload.type === "kong") bump(e.payload.tile, 3);
      else if (e.payload.type === "pong") bump(e.payload.tile, 2);
      // chow melds are three different tiles; payload carries only the claimed one
    }
  }
  return out;
}
function isHonorId(t) { return t >= 27 && t < 34; }

// Per-decision readout. distance + liveTiles are EXACT and need no theory.
// Everything probabilistic is deliberately absent — see the panel in the UI.
function reviewSeries(m) {
  var log = m.log, out = [], i, j, incoming = null, incomingKind = "draw";
  for (i = 0; i < log.length; i++) {
    var e = log[i];
    if (e.actor !== 0) continue;
    if (e.type === "draw" || e.type === "kong_replace") { incoming = e.payload.tile; incomingKind = "draw"; }
    else if (e.type === "claimed") { incoming = e.payload.tile; incomingKind = e.payload.type; }
    else if (e.type === "discard") {
      // state immediately BEFORE the discard: hand still holds the drawn tile
      var st = foldTo(log, i);
      var me = st.seats[0];
      var vis = new Array(34).fill(0);
      st.seats.forEach(function (sx, si) {
        sx.discards.forEach(function (t) { if (t < 34) vis[t]++; });
        sx.melds.forEach(function (md) { md.tiles.forEach(function (t) { if (t < 34) vis[t]++; }); });
        if (si === 0) sx.hand.forEach(function (t) { if (t < 34) vis[t]++; });
      });
      var after = me.hand.slice();
      var k = after.indexOf(e.payload.tile);
      if (k >= 0) after.splice(k, 1);
      var u = E.liveTiles(E.countsOf(after), me.melds.length, vis);
      var before = E.distanceToReady(E.countsOf(me.hand), me.melds.length);
      out.push({
        seq: e.seq, hand: me.hand.slice(), melds: me.melds.slice(),
        inTile: incoming, inKind: incomingKind, outTile: e.payload.tile,
        distance: u.distance, distBefore: before, total: u.total, tiles: u.tiles.slice(0, 8)
      });
      incoming = null;
    }
  }
  return out;
}

function readyChart(series, curTurn) {
  if (!series.length) return "";
  var W = 100, H = 30, pad = 2;
  var maxSh = Math.max(3, Math.max.apply(null, series.map(function (p) { return p.distance; })));
  var x = function (i) { return pad + (i / Math.max(1, series.length - 1)) * (W - pad * 2); };
  var y = function (v) { return pad + (v / maxSh) * (H - pad * 2); };   // 0 distance at top
  var pts = series.map(function (p, i) { return x(i).toFixed(1) + "," + y(p.distance).toFixed(1); }).join(" ");
  var dots = series.map(function (p, i) {
    var col = p.distance <= 0 ? "#1A8B3A" : p.distance === 1 ? "#7a6a2a" : "#8a8a94";
    return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.distance).toFixed(1) +
      '" r="0.9" fill="' + col + '"/>';
  }).join("");
  var mark = curTurn != null && series[curTurn]
    ? '<line x1="' + x(curTurn).toFixed(1) + '" y1="0" x2="' + x(curTurn).toFixed(1) + '" y2="' + H +
      '" stroke="#2a2a32" stroke-width="0.5" vector-effect="non-scaling-stroke"/>' : "";
  return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" ' +
    'style="width:100%;height:96px;display:block">' +
    '<rect x="0" y="0" width="' + W + '" height="' + y(0.5).toFixed(1) +
      '" fill="#e6f2e9"/>' + mark +
    '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="0.7" ' +
      'stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' + dots + "</svg>";
}

// Review is YOUR seat, not the omniscient view. Opponents' concealed hands stay
// hidden by default so you judge your decisions against what you could actually
// have known — seeing their hands first is hindsight poisoning. "Reveal" exists
// because it is genuinely instructive, but it is opt-in.
function opponentPanel(st, log, idx, reveal) {
  var vis = new Array(34).fill(0);
  st.seats.forEach(function (sx) {
    sx.discards.forEach(function (t) { if (t < 34) vis[t]++; });
    sx.melds.forEach(function (md) { md.tiles.forEach(function (t) { if (t < 34) vis[t]++; }); });
  });
  return [1, 2, 3].map(function (i) {
    var sx = st.seats[i], nm2 = ["You", "Ah Ming", "Kai", "Suki"][i];
    var head = '<div class="row tiny" style="margin-bottom:2px">' +
      '<b style="color:' + SEATCOL[i] + '">' + E.WINDS[(i - st.dealer + 4) % 4] + "</b><b>" + nm2 + "</b>" +
      '<div class="spacer"></div><span class="mut">' + sx.discards.length + " discards \u00B7 " +
      sx.melds.length + " melds</span></div>";
    var pub = (sx.melds.length || sx.flowers.length)
      ? '<div class="pool" style="margin-bottom:3px">' + sx.melds.map(function (m) {
          return '<span class="set" style="display:inline-flex;gap:1px;background:rgba(0,0,0,.05);' +
            'border-radius:3px;padding:1px">' + tiles(m.tiles) + "</span>"; }).join("") +
          (sx.flowers.length ? '<span style="width:6px;display:inline-block"></span>' + tiles(sx.flowers) : "") +
        "</div>"
      : '<div class="tiny mut" style="margin-bottom:3px">nothing exposed</div>';
    var hidden = "";
    if (reveal) {
      var u = E.liveTiles(E.countsOf(sx.hand), sx.melds.length, vis);
      hidden = '<div class="pool" style="margin-bottom:2px">' + tiles(sx.hand) + "</div>" +
        '<div class="tiny" style="color:' + (u.distance <= 0 ? "var(--ok)" : "var(--dim)") + '">' +
        (u.distance <= 0
          ? "ready \u8074\u724C \u2014 waiting on " + u.tiles.map(function (w) { return nm(w.tile) + "\u00D7" + w.unseen; }).join(" \u00B7 ")
          : u.distance + " away") + "</div>";
    }
    return '<div style="padding:6px 0;border-bottom:1px solid #f0f0f2">' + head + pub + hidden + "</div>";
  }).join("");
}

function scHandReview() {
  var m = S.matches[S.reviewIx || 0];
  if (!m) return appbar("Review", "matches") + '<div class="body"><div class="card mut">No hands yet.</div></div>';
  var log = m.log, moments = keyMoments(log, 0), series = reviewSeries(m);
  if (!series.length) return appbar("Hand review", "matches") +
    '<div class="body"><div class="card mut">No decisions recorded this hand.</div></div>';
  if (S.turn == null || S.turn >= series.length) S.turn = series.length - 1;
  var cur = series[S.turn], idx = cur.seq + 1;
  var st = foldTo(log, idx);
  var colour = { bad: "var(--warn)", warn: "#7a6a2a", note: "var(--dim)" };

  var turns = series.map(function (p, i) {
    var prev = i > 0 ? series[i - 1].distance : null;
    var moved = prev === null ? "" : p.distance < prev
      ? '<span style="color:var(--ok)">\u2193 closer</span>'
      : p.distance > prev ? '<span style="color:var(--warn)">\u2191 further</span>'
      : '<span class="mut">\u2192 same</span>';
    var drawAndCut = p.inTile != null && p.inTile === p.outTile && p.inKind === "draw";
    var inDone = false, outDone = false;
    var handHtml = p.hand.map(function (t) {
      var cls = "";
      if (drawAndCut && !outDone && t === p.outTile) { cls = " thru"; outDone = true; }
      else if (!drawAndCut && !inDone && t === p.inTile) { cls = " in"; inDone = true; }
      else if (!outDone && t === p.outTile) { cls = " out"; outDone = true; }
      return '<span class="t' + cls + '">' + T.tileSVG(t, { labels: S.opts.labels }) + "</span>";
    }).join("");
    var melded = p.melds.length
      ? '<span style="width:7px;display:inline-block"></span>' + p.melds.map(function (mm) {
          return '<span class="set" style="display:inline-flex;gap:1px;background:rgba(0,0,0,.05);' +
            'border-radius:3px;padding:1px">' + tiles(mm.tiles) + "</span>"; }).join("")
      : "";
    return '<div class="turn' + (i === S.turn ? " on" : "") + '" data-act="selturn" data-i="' + i + '">' +
      '<div class="row tiny" style="margin-bottom:3px">' +
        '<span class="mut" style="width:24px">' + (i + 1) + "</span>" +
        (drawAndCut
          ? '<span class="io thru">\u21BA drew and cut ' + nm(p.outTile) + "</span>"
          : '<span class="io in">+ ' + (p.inKind === "draw" ? "drew" : p.inKind) + " " +
            (p.inTile != null ? nm(p.inTile) : "\u2014") + "</span>" +
            '<span class="io out">\u2212 cut ' + nm(p.outTile) + "</span>") +
        '<div class="spacer"></div>' + moved +
        '<span class="mut" style="margin-left:8px">' +
          (p.distance <= 0 ? "ready" : p.distance + " away") + " \u00B7 " + p.total + " live</span></div>" +
      '<div class="hand-strip">' + handHtml + melded + "</div>" +
      (p.distance <= 0 && p.tiles.length
        ? '<div class="tiny mut" style="margin-top:3px">waiting on ' +
          p.tiles.map(function (w) { return nm(w.tile) + "\u00D7" + w.unseen; }).join(" \u00B7 ") + "</div>"
        : "") + "</div>";
  }).join("");

  return appbar("Hand review", "matches",
      '<span class="pill">your seat</span>') +
    '<div class="body"><div class="col wide">' +
    '<div class="card"><div class="row tiny" style="margin-bottom:6px"><b>Distance to a winning hand</b>' +
    '<div class="spacer"></div><span class="tiny mut">turn ' + (S.turn + 1) + " of " + series.length +
    " \u00B7 green band = ready \u8074\u724C</span></div>" + readyChart(series, S.turn) + "</div>" +

    '<div class="grid2" style="align-items:start"><div>' +
      '<div class="card"><div class="row tiny" style="margin-bottom:6px"><b>How your hand evolved</b>' +
      '<div class="spacer"></div><span class="tiny mut">click a turn</span></div>' +
      '<div style="max-height:380px;overflow-y:auto">' + turns + "</div>" +
      '<div class="tiny mut" style="margin-top:7px">' +
      '<span class="io in">green</span> came in, <span class="io out">red</span> went out, ' +
      '<span class="io thru">amber</span> means you cut the tile you just drew. ' +
      "Shanten and live counts are exact for what was visible at that moment.</div></div>" +
    "</div><div>" +

      '<div class="card"><div class="row tiny" style="margin-bottom:6px"><b>The table at turn ' +
      (S.turn + 1) + "</b><div class=\"spacer\"></div>" +
      '<span class="tiny" data-act="reveal" style="cursor:pointer;color:var(--accent)">' +
      (S.reveal ? "hide hands" : "reveal hands") + "</span></div>" +
      miniTable(st, log, idx) + "</div>" +

      '<div class="card"><div class="row tiny" style="margin-bottom:4px"><b>Opponents</b>' +
      '<div class="spacer"></div><span class="tiny mut">' +
      (S.reveal ? "revealed \u2014 hindsight" : "what you could see") + "</span></div>" +
      opponentPanel(st, log, idx, S.reveal) + "</div>" +

      '<div class="card"><div class="row tiny" style="margin-bottom:6px"><b>Key moments</b>' +
      '<div class="spacer"></div><span class="tiny mut">' + moments.length + "</span></div>" +
      (moments.length ? moments.map(function (x) {
        return '<div style="padding:5px 0 5px 8px;border-left:2px solid ' + colour[x.kind] + ';margin-bottom:3px">' +
          '<div class="tiny mut">event ' + x.seq + "</div>" + x.text + "</div>";
      }).join("") : '<div class="tiny mut">Nothing flagged this hand.</div>') + "</div>" +

      '<button class="btn ghost" data-nav="observer">Observer mode \u2014 all four hands</button>' +
    "</div></div></div></div>";
}

/* ─────────── observer mode ───────────
 * Watching after the fact is a different job from playing. You are not trying to
 * pick a discard; you are trying to see who was close, who was pushing, and what
 * the danger was. So this is not the table with the hands flipped over — it is
 * four seats aligned on one timeline.
 *
 * NOTE: this uses the OMNISCIENT serializer (§5.5), which is legitimate here
 * precisely because the hand is over. Live spectating may not — a spectator
 * relaying hands to a player is a cheating vector, so live must be delayed or
 * redacted. Post-hoc and live are different products.
 */
var SEATCOL = ["#1845A5", "#a8341f", "#1A8B3A", "#7a3ea8"];

function observerSeries(log) {
  var out = [];
  for (var i = 0; i <= log.length; i++) {
    var t = log[i - 1] && log[i - 1].type;
    if (i && t !== "discard" && t !== "draw" && t !== "claimed" && t !== "flower_replace") continue;
    var st = foldTo(log, i);
    out.push({ i: i, dist: st.seats.map(function (sx) {
      return E.distanceToReady(E.countsOf(sx.hand), sx.melds.length);
    }) });
  }
  return out;
}

function raceChart(series, curIdx) {
  if (series.length < 2) return "";
  var W = 100, H = 26, pad = 1.5;
  var maxSh = 6;
  var x = function (k) { return pad + (k / (series.length - 1)) * (W - pad * 2); };
  var y = function (v) { return pad + (Math.max(-1, Math.min(maxSh, v)) + 1) / (maxSh + 1) * (H - pad * 2); };
  var lines = [0, 1, 2, 3].map(function (seat) {
    var pts = series.map(function (p, k) { return x(k).toFixed(1) + "," + y(p.dist[seat]).toFixed(1); }).join(" ");
    return '<polyline points="' + pts + '" fill="none" stroke="' + SEATCOL[seat] +
      '" stroke-width="0.7" stroke-linejoin="round" vector-effect="non-scaling-stroke" opacity="0.9"/>';
  }).join("");
  var near = 0;
  series.forEach(function (p, k) { if (Math.abs(p.i - curIdx) < Math.abs(series[near].i - curIdx)) near = k; });
  return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" style="width:100%;height:104px;display:block">' +
    '<rect x="0" y="' + y(-1).toFixed(1) + '" width="' + W + '" height="' + (y(0) - y(-1)).toFixed(1) +
      '" fill="#e6f2e9"/>' +
    '<line x1="' + x(near).toFixed(1) + '" y1="0" x2="' + x(near).toFixed(1) + '" y2="' + H +
      '" stroke="#2a2a32" stroke-width="0.5" vector-effect="non-scaling-stroke"/>' + lines + "</svg>";
}

function wallLeft(log, idx) {
  var used = 52, i;
  for (i = 0; i < idx && i < log.length; i++) {
    var t = log[i].type;
    if (t === "draw" || t === "kong_replace") used++;
    else if (t === "flower_replace" && log[i].payload.initial) used++;
  }
  return Math.max(0, 144 - used);
}

// A diagram of the table, not a second copy of the match UI: seats, melds,
// whose turn, the pile, and the wall. No hands — those live in the lanes.
function miniTable(st, log, idx) {
  var names = ["You", "Ah Ming", "Kai", "Suki"], POS = ["mb", "ml", "mt", "mr"];
  var turn = null;
  for (var i = idx - 1; i >= 0; i--) {
    if (log[i].type === "discard") { turn = (log[i].actor + 1) % 4; break; }
  }
  var pile = [], seen = {};
  st.seats.forEach(function (sx, si) {
    sx.discards.forEach(function (t) { pile.push({ tile: t, from: si }); });
  });
  // stable order for the scatter: use the log sequence rather than seat order
  var ordered = [];
  log.slice(0, idx).forEach(function (e) {
    if (e.type === "discard") ordered.push({ tile: e.payload.tile, from: e.actor });
    else if (e.type === "claimed" && !e.payload.concealed) {
      for (var k = ordered.length - 1; k >= 0; k--)
        if (ordered[k].tile === e.payload.tile) { ordered.splice(k, 1); break; }
    }
  });

  var seats = [0, 1, 2, 3].map(function (i) {
    var sx = st.seats[i];
    var meld = sx.melds.length || sx.flowers.length
      ? '<div class="mmeld">' + sx.melds.map(function (m) {
          return '<div class="set">' + tiles(m.tiles) + "</div>";
        }).join("") + (sx.flowers.length ? '<div class="set">' + tiles(sx.flowers) + "</div>" : "") + "</div>"
      : "";
    return '<div class="mseat ' + POS[i] + (turn === i ? " turn" : "") + '">' +
      '<span class="dot"></span><b style="color:' + SEATCOL[i] + '">' +
      E.WINDS[(i - st.dealer + 4) % 4] + "</b><span>" + names[i] + "</span>" + meld + "</div>";
  }).join("");

  var last = ordered.length - 1, mw = 8;
  var mpos = scatterLayout(ordered.length, mw);
  var pileHtml = '<div class="mpile">' + ordered.map(function (d, i) {
    var q = mpos[i];
    return '<span class="t' + (i === last ? " last" : "") + '" style="width:' + mw + "px;left:" +
      q.x.toFixed(1) + "px;top:" + q.y.toFixed(1) + "px;transform:translate(-50%,-50%) rotate(" +
      q.rot.toFixed(1) + 'deg)">' + T.tileSVG(d.tile, { labels: false }) + "</span>";
  }).join("") + "</div>";

  return '<div class="mini">' + seats +
    '<div class="mfelt">' + pileHtml + "</div>" +
    '<div class="mwall">' + wallLeft(log, idx) + " in wall</div></div>";
}

function scObserver() {
  var m = S.matches[S.reviewIx || 0];
  if (!m) return appbar("Observer", "matches") + '<div class="body"><div class="card mut">No hands yet.</div></div>';
  var log = m.log;
  if (S.obs == null) S.obs = log.length;
  var idx = Math.max(0, Math.min(log.length, S.obs));
  var st = foldTo(log, idx), series = observerSeries(log);
  var vis = new Array(34).fill(0);
  st.seats.forEach(function (sx) {
    sx.discards.forEach(function (t) { if (t < 34) vis[t]++; });
    sx.melds.forEach(function (md) { md.tiles.forEach(function (t) { if (t < 34) vis[t]++; }); });
  });

  var lanes = [0, 1, 2, 3].map(function (i) {
    var sx = st.seats[i], nm2 = ["You", "Ah Ming", "Kai", "Suki"][i];
    var c = E.countsOf(sx.hand);
    var u = E.liveTiles(c, sx.melds.length, vis);
    var ready = u.distance <= 0;
    var wait = ready
      ? '<span class="tiny" style="color:var(--ok)">waiting on ' +
        u.tiles.map(function (w) { return nm(w.tile) + "\u00D7" + w.unseen; }).join(" \u00B7 ") + "</span>"
      : '<span class="tiny mut">' + u.distance + " away \u00B7 " + u.total + " live tiles</span>";
    return '<div class="lane" style="border-left:3px solid ' + SEATCOL[i] + '">' +
      '<div class="row tiny" style="margin-bottom:3px">' +
        '<b style="font-size:13px">' + E.WINDS[(i - st.dealer + 4) % 4] + "</b>" +
        "<b>" + nm2 + "</b>" +
        '<span class="pill" style="background:' + (ready ? "#e2efe6;color:#1A8B3A" : "#ececed;color:#6b6b76") +
          '">' + (ready ? "ready" : u.distance + "-away") + "</span>" +
        '<div class="spacer"></div>' + wait + "</div>" +
      '<div class="pool" style="margin-bottom:3px">' + tiles(sx.hand) +
        (sx.melds.length ? '<span style="width:8px"></span>' + sx.melds.map(function (md) {
          return '<span class="set" style="display:inline-flex;gap:1px;background:rgba(0,0,0,.05);' +
            'border-radius:3px;padding:1px">' + tiles(md.tiles) + "</span>"; }).join("") : "") +
        (sx.flowers.length ? '<span style="width:8px"></span>' + tiles(sx.flowers) : "") + "</div>" +
      '<div class="row" style="gap:5px"><span class="tiny mut" style="width:44px">discards</span>' +
        '<div class="pool" style="margin:0">' + tiles(sx.discards) + "</div></div>" +
    "</div>";
  }).join("");

  return appbar("Observer", "matches", '<span class="pill">omniscient \u00B7 post-hoc</span>') +
    '<div class="body"><div class="col wide">' +
    '<div class="grid2" style="align-items:start"><div class="card">' +
      '<div class="row tiny" style="margin-bottom:6px"><b>Table</b><div class="spacer"></div>' +
      '<span class="tiny mut">event ' + idx + "</span></div>" +
      miniTable(st, log, idx) +
      '<div class="tiny mut" style="margin-top:6px">Diagram, not a second match UI \u2014 seats, ' +
      "melds, whose turn, the pile and the wall. Hands are in the lanes below.</div></div>" +
    '<div class="card"><div class="row tiny" style="margin-bottom:6px"><b>Who was close</b>' +
      '<div class="spacer"></div>' + [0, 1, 2, 3].map(function (i) {
        return '<span class="tiny" style="color:' + SEATCOL[i] + ';font-weight:600">' +
          ["You", "Ah Ming", "Kai", "Suki"][i] + "</span>";
      }).join(" ") + "</div>" +
      raceChart(series, idx) +
      '<div class="tiny mut" style="margin-top:5px">Shanten for all four seats on one axis. ' +
      "The green band is ready. Two lines entering it together is the whole drama of a hand.</div></div></div>" +
    '<div class="scrub"><button data-act="obs" data-d="-1">\u25C0</button>' +
      '<input type="range" min="0" max="' + log.length + '" value="' + idx + '" data-act="obsscrub">' +
      '<button data-act="obs" data-d="1">\u25B6</button>' +
      '<span class="tiny mut" style="width:78px;text-align:right">event ' + idx + " / " + log.length + "</span></div>" +
    lanes + "</div></div>";
}

function scMatches() {
  S.tab = "review";
  var rows = S.matches.length ? S.matches.map(function (m, i) {
    var c = m.won ? "var(--ok)" : m.draw ? "#8a8a94" : "var(--warn)";
    return '<div class="mrow" data-act="openreview" data-i="' + i + '">' +
      '<div class="res" style="background:' + c + '">' + (m.won ? "W" : m.draw ? "—" : "L") + "</div>" +
      "<div><div><b>" + m.title + '</b></div><div class="tiny mut">' + m.sub + "</div></div>" +
      '<div class="spacer"></div><div class="tiny mut">' + m.events + " events</div></div>";
  }).join("") : '<div class="mut tiny">No matches yet — play a hand.</div>';
  return header() + '<div class="body"><div class="col wide">' +
    '<div class="row" style="margin-bottom:9px"><b>Match history</b><div class="spacer"></div>' +
    '<span class="tiny mut">' + S.matches.length + " recorded</span></div>" +
    '<div class="card">' + rows + "</div>" +
    '<div class="card tiny mut">Every completed hand writes an append-only event log (\u00A75.5). ' +
    "Open one to review it move by move.</div></div></div>";
}

function foldTo(log, n) {
  var st = { seats: [0,1,2,3].map(function(){ return {hand:[],melds:[],flowers:[],discards:[]}; }),
             wind: 0, dealer: 0, last: null, note: "" };
  for (var i = 0; i < n && i < log.length; i++) {
    var e = log[i], p = e.payload, s = e.actor != null ? st.seats[e.actor] : null;
    if (e.type === "deal") {
      st.dealer = p.dealer; st.wind = p.round_wind;
      if (p.hands) st.seats.forEach(function (x, ix) { x.hand = p.hands[ix].concat(); x.flowers = (p.flowers[ix]||[]).concat(); });
    } else if (e.type === "flower_replace") {
      // initial deal swaps are already baked into the deal snapshot
      if (!p.initial && s) {
        var fk = s.hand.indexOf(p.flower);
        if (fk >= 0) s.hand.splice(fk, 1);
        s.flowers.push(p.flower);
      }
    }
    else if (e.type === "draw") { if (s) s.hand.push(p.tile); }
    else if (e.type === "kong_replace") { if (s) s.hand.push(p.tile); }
    else if (e.type === "discard") {
      if (s) { var ix2 = s.hand.indexOf(p.tile); if (ix2 >= 0) s.hand.splice(ix2, 1); s.discards.push(p.tile); }
      st.last = { tile: p.tile, from: e.actor };
    } else if (e.type === "claimed") {
      if (s) {
        var take = p.concealed ? [p.tile,p.tile,p.tile,p.tile] : [p.tile,p.tile].concat(p.type==="kong"?[p.tile]:[]);
        take.forEach(function (t) { var k = s.hand.indexOf(t); if (k >= 0) s.hand.splice(k, 1); });
        s.melds.push({ type: p.type, tiles: take, concealed: !!p.concealed });
        if (!p.concealed && p.from != null) st.seats[p.from].discards.pop();
      }
    } else if (e.type === "refused_win") st.note = "refused: " + p.faan + " faan, below minimum";
  }
  st.seats.forEach(function (x) { x.hand.sort(function (a, b) { return a - b; }); });
  return st;
}

function scReplay(shared) {
  var R = S.replay, st = foldTo(R.log, R.idx);
  var h = shared
    ? '<div class="appbar"><span class="ttl">Shared replay</span><span class="pill">public link</span></div>'
    : appbar("Replay", "matches");
  h += '<div class="body" style="padding:10px">';
  if (shared) h += '<div class="banner info" style="margin-bottom:9px">Viewing a shared hand — no account needed. ' +
    "<b>Sign up</b> to play.</div>";
  h += '<div class="card" style="padding:9px">';
  [2, 1, 3].forEach(function (i) {
    var s = st.seats[i];
    h += '<div class="row tiny" style="margin-bottom:3px"><b>' + E.WINDS[(i - st.dealer + 4) % 4] + "</b>" +
      "<span>" + ["You","Ah Ming","Kai","Suki"][i] + "</span></div>" +
      '<div class="pool" style="max-width:100%;margin-bottom:6px">' + tiles(s.hand) +
      (s.melds.length ? '<span style="width:8px"></span>' + s.melds.map(function(m){
        return '<span class="set" style="display:inline-flex;gap:1px">'+tiles(m.tiles)+"</span>"; }).join("") : "") + "</div>";
  });
  h += '<div class="row tiny" style="margin:7px 0 3px"><b>' + E.WINDS[(0 - st.dealer + 4) % 4] + "</b><span>You</span></div>" +
    '<div class="pool" style="max-width:100%">' + tiles(st.seats[0].hand) + "</div>";
  h += "</div>";
  h += '<div class="card" style="padding:9px"><div class="tiny mut" style="margin-bottom:5px">Discards</div>' +
    st.seats.map(function (s, i) {
      return '<div class="row" style="gap:6px;margin-bottom:3px"><b class="tiny" style="width:14px">' +
        E.WINDS[(i - st.dealer + 4) % 4] + '</b><div class="pool" style="max-width:100%;margin:0">' +
        tiles(s.discards) + "</div></div>";
    }).join("") + "</div>";
  h += '<div class="scrub"><button data-act="step" data-d="-1">◀</button>' +
    '<button data-act="play">' + (R.playing ? "⏸" : "▶") + "</button>" +
    '<input type="range" min="0" max="' + R.log.length + '" value="' + R.idx + '" data-act="scrub">' +
    '<button data-act="step" data-d="1">▶</button></div>' +
    '<div class="tiny mut" style="text-align:center;margin-bottom:7px">event ' + R.idx + " / " + R.log.length + "</div>";
  h += '<div class="evlog" id="evlog">' + R.log.map(function (e, i) {
    return '<div class="' + (i === R.idx - 1 ? "cur" : "") + '">' + String(i).padStart(3, "0") +
      ' <span class="ty">' + e.type + "</span> " + (e.actor != null ? "s" + e.actor : "--") + " " +
      JSON.stringify(e.payload).slice(0, 46) + "</div>";
  }).join("") + "</div>";
  h += '<div class="card tiny mut" style="margin-top:9px">Replay is a fold over the event log — ' +
    'the same stream the server wrote. Forward-step only, omniscient view at P0.</div>';
  return h + "</div>";
}

/* ─────────── P1 / reference / settings / IA ─────────── */
function stub(title, backTo, badge, lines) {
  var h = appbar(title, backTo) + '<div class="body">' +
    '<div class="card"><div class="row"><b>' + title + '</b><div class="spacer"></div>' + badge + "</div>" +
    '<div class="tiny mut" style="margin-top:6px">' + lines + "</div></div></div>";
  return tab ? h : h;
}
function scProfile() {
  return header() + '<div class="body"><div class="col">' +
    '<div class="card"><div class="row"><div><b>You</b><div class="tiny mut">device token · no account</div></div>' +
    '<div class="spacer"></div><div style="text-align:right"><div style="font-size:22px;font-weight:700">' +
    S.me.rating + '</div><div class="tiny mut">provisional</div></div></div></div>' +
    '<div class="card"><div class="row tiny"><b>Stat dashboard</b><div class="spacer"></div>' +
    '<span class="pill p1">P1</span></div><div class="tiny mut" style="margin-top:5px">' +
    'Win rate, deal-in rate, mean winning faan, call rate — the same four metrics gate 3 ' +
    'measures for bot parity (§3).</div></div>' +
    '<div class="card"><div class="row tiny"><b>Account &amp; passkeys</b><div class="spacer"></div>' +
    '<span class="pill p1">P1</span></div></div>' +
    '<button class="btn ghost" data-nav="stats">Stats \u2014 offline vs online</button>' +
    '<button class="btn ghost" data-nav="rules">Rules &amp; faan table</button>' +
    '<button class="btn ghost" data-nav="settings">Settings</button></div></div>';
}
function scLearn() {
  S.tab = "learn";
  return header() + '<div class="body"><div class="col">' +
    '<div class="card"><div class="row tiny"><b>In-app Learn tab</b><div class="spacer"></div>' +
    '<span class="pill p1">P1</span></div><div class="tiny mut" style="margin-top:5px">' +
    'At P0 the ten seed WWYD problems publish on mahjongresearch.com instead — same content, ' +
    'zero client work (§7).</div></div>' +
    '<div class="card"><b class="tiny">Shipping at P0, in-game</b>' +
    '<div class="tiny mut" style="margin-top:5px">· Faan-floor warning — "no legal path to 3 faan"<br>' +
    '· Current-faan display<br>· Cantonese terminology as the label vocabulary</div></div>' +
    '<div class="card"><b class="tiny">Deferred on purpose</b>' +
    '<div class="tiny mut" style="margin-top:5px">The best-route HUD needs a partial-hand route ' +
    'evaluator that exists nowhere. §7 defers it rather than ship a recommendation a strong ' +
    'player can screenshot being wrong.</div></div>' + "</div></div>";
}
// Offline (Almanac scorekeeper) and online (game) stats share ONE identity and
// stay in separate fact tables. The bridge is ACCOUNTS-BUILD-SPEC §8.2's
// trust-ranked player_links; the game is simply a new source at the top of it.
function scStats() {
  var col = function (title, badge, trust, rows, note) {
    return '<div class="card"><div class="row"><b>' + title + '</b><div class="spacer"></div>' + badge + "</div>" +
      '<div class="tiny mut" style="margin:4px 0 8px">' + trust + "</div><table>" +
      rows.map(function (r) {
        return "<tr><td>" + r[0] + '</td><td style="text-align:right"><b>' + r[1] + "</b></td></tr>";
      }).join("") + "</table>" +
      '<div class="tiny mut" style="margin-top:8px">' + note + "</div></div>";
  };
  var offline = col("Offline \u00B7 Almanac", '<span class="pill">scorekeeper</span>',
    "Human-entered at the table. Honestly fuzzy.",
    [["Sessions", "48"], ["Hands recorded", "612"], ["Win rate", "23%"], ["Mean winning faan", "4.8"],
     ["Deal-in rate", "\u2014"], ["Discard-level detail", "none"]],
    "Outcomes only: who won, faan, chips. Nobody logs the discards at a real table.");
  var online = col("Online \u00B7 Game", '<span class="pill" style="background:#e2efe6;color:#1A8B3A">machine-witnessed</span>',
    "Server-emitted event stream. Complete.",
    [["Matches", "31"], ["Hands recorded", "289"], ["Win rate", "26%"], ["Mean winning faan", "4.4"],
     ["Deal-in rate", "18%"], ["Discard-level detail", "every tile"]],
    "Every draw, discard, claim and refusal, with timestamps and a pinned engine version.");
  return appbar("Stats", "profile") + '<div class="body"><div class="col wide">' +
    '<div class="banner info" style="margin-bottom:10px">Shown side by side, never blended. ' +
    'The two sources have different fidelity \u2014 averaging them turns honestly fuzzy numbers into ' +
    "confidently wrong ones.</div>" +
    '<div class="grid2" style="align-items:start">' + offline + online + "</div>" +
    '<div class="card"><div class="row tiny"><b>What the online log makes possible</b>' +
    '<div class="spacer"></div><span class="pill p1">later</span></div>' +
    '<div class="tiny mut" style="margin-top:6px">' +
    '<b>Detectable at P0, no theory needed</b> \u2014 rule-derived facts straight from the log: ' +
    "dealt into a win, melded into a hand below the 3-faan floor, passed on a legal winning claim, " +
    "discarded a tile already seen three times.<br><br>" +
    '<b>Needs the route evaluator that does not exist yet</b> \u2014 \u201Cthis discard was the wrong one.\u201D ' +
    "Same missing component that defers the best-route HUD (\u00A77). Build it later and run it back over " +
    "every hand ever logged \u2014 that is the point of event sourcing.</div></div></div></div>";
}

function scRules() {
  var rows = [["Seat / round wind pung", "1"], ["Dragon pung 三元", "1"], ["Own flower", "1"],
    ["All pungs 對對糊", "3"], ["Half flush 混一色", "3"], ["Full flush 清一色", "7"],
    ["Self-draw 自摸", "1"], ["Minimum to win", "3"], ["Limit 爆棚", "13"]];
  return appbar("Rules & faan", "profile") + '<div class="body">' +
    '<div class="card"><div class="row tiny"><b>Canonical HK Old Style</b><div class="spacer"></div>' +
    '<span class="pill stub">subset — sketch only</span></div>' +
    '<table style="margin-top:7px">' + rows.map(function (r) {
      return "<tr><td>" + r[0] + '</td><td style="text-align:right"><b>' + r[1] + "</b></td></tr>";
    }).join("") + "</table></div>" +
    '<div class="card tiny mut">The real faan table, payment table and house-rule presets load ' +
    'from config, not code (§4). The tsumo per-player-vs-total ambiguity is still unsettled — ' +
    'an open action in §9.</div></div>';
}
function scSettings() {
  var sw = function (label, on, note) {
    return '<div class="row" style="padding:9px 0;border-bottom:1px solid #eee">' +
      "<div><div>" + label + '</div><div class="tiny mut">' + (note || "") + "</div></div>" +
      '<div class="spacer"></div><b class="tiny">' + (on ? "On" : "Off") + "</b></div>";
  };
  return appbar("Settings", "lobby") + '<div class="body">' +
    '<div class="card" style="padding:2px 12px">' +
      sw("Learner labels on tiles", S.opts.labels, "1-9 / ESWN / CFB overlay") +
      sw("Auto-pass non-win claims", S.opts.autoPass, "Safe default on poor signal (§2)") +
      sw("Cantonese call audio", false, "Track A — parity feature, not a differentiator") +
      sw("Reduce motion", false, "") +
    "</div>" +
    '<div class="card" style="padding:2px 12px">' +
      sw("Sound", true, "") + sw("Haptics", true, "") +
    "</div>" +
    '<div class="card tiny mut">Toggles here are display-only in the sketch — drive them from ' +
    'the left rail instead.</div></div>';
}
function scIA() {
  var tree = [
    ["Onboarding", "P0", "device token + display name", 0],
    ["Lobby (home)", "P0", "rating chip, quick match, create, join", 0],
    ["Create table", "P0", "ruleset preset, match length", 1],
    ["Join with code", "P0", "6-char code", 1],
    ["Match scene", "P0", "the §5.2 state machine", 0],
    ["Results — Progression", "P0", "rating delta, hand, faan", 1],
    ["Results — Scoreboard", "P0", "chips, standings", 1],
    ["Replays (match list)", "P0", "history rows", 0],
    ["Replay viewer", "P0", "forward-step, omniscient", 1],
    ["Shared replay (logged out)", "P0", "the only P0 viral loop", 1],
    ["Settings", "P0", "labels, auto-pass, sound", 0],
    ["Rules &amp; faan table", "P0", "static reference", 1],
    ["Profile", "P0", "device token, then account", 0],
    ["Stats \u2014 offline vs online", "P1", "one identity, two fact tables", 1],
    ["Blunder feed (rule-derived)", "P1", "deal-ins, sub-floor melds \u2014 no theory needed", 1],
    ["Blunder feed (route-judged)", "P2", "blocked on the route evaluator", 1],
    ["Leaderboard", "P1", "seasonal ladder", 0],
    ["Learn tab", "P1", "WWYD in-app", 0],
    ["Rated queue", "P1", "matchmaking", 0],
    ["Account / passkeys", "P1", "real identity", 0],
    ["Spectator mode", "P1", "live watching", 0],
    ["Friends / social graph", "P1", "", 0],
    ["Shop / gacha / characters", "NEVER", "§1 — explicitly not building", 0],
    ["Real-money anything", "NEVER", "gambling adjacency, hard no", 0]
  ];
  return appbar("IA map (not a product screen)") + '<div class="body">' +
    '<div class="card" style="padding:6px 12px">' + tree.map(function (r) {
      var col = r[1] === "P0" ? "var(--ok)" : r[1] === "P1" ? "#7a6a2a" : "var(--warn)";
      return '<div class="row" style="padding:6px 0;border-bottom:1px solid #f0f0f2">' +
        '<div style="padding-left:' + (r[3] * 14) + 'px">' + (r[3] ? "└ " : "") + r[0] +
        '<div class="tiny mut">' + r[2] + "</div></div>" +
        '<div class="spacer"></div><span class="pill" style="background:transparent;color:' + col +
        ';border:1px solid ' + col + '">' + r[1] + "</span></div>";
    }).join("") + "</div></div>";
}

/* ─────────── notes panel ─────────── */
var NOTES = {
  match: [["", "<b>Interaction grammar is Mahjong Soul's</b>, HK rules underneath: drawn tile separated by a gap, call buttons bottom-right with a countdown ring, fixed claim window, auto-pass."],
    ["", "<b>Claim window</b> prompts only seats with legal claims, privately. Priority <code>winOnDiscard &gt; kong/pong &gt; chow</code>, ties to nearest seat. §5.2"],
    ["", "<b>Bots answer on a paced delay</b> — never synchronously, or response timing leaks who is holding a claim. §5.3"],
    ["warn", "<b>3-faan minimum is live.</b> Wins below it are refused and emit a visible event, not a silent rollback — the teaching moment. §5.2"],
    ["todo", "<b>Scoring is stubbed.</b> Real exposed-meld decomposition is the 2-3 week core of P0. §5.1"],
    ["todo", "<b>Bots are placeholder</b> — crude route steering only. No liveTiles, no defence. §6 calls this a product blocker, not polish."]],
  lobby: [["", "<b>Provisional rating ships at P0</b>, labelled unofficial. v1.0 deferred it to P1 and then gated P1 on retention — circular, since the thesis says rating <i>produces</i> retention. §3"],
    ["", "P0 lobby is one DO handing out join codes. Rated matchmaking is P1."]],
  results: [["", "<b>The results screen is the product.</b> Ceremony first, detail second — tab 1 rating delta + hand + faan, tab 2 scoreboard. §2"],
    ["", "<b>Share works at P0</b> via a tokenized public replay URL. An invite-only alpha's only viral loop; it cannot be deferred."]],
  replay: [["", "<b>Replay is a fold over the event log</b> — literally the stream the server wrote, re-rendered client-side. Same shape Mahjong Soul uses. §5.5"],
    ["", "Event header pins <code>engine_version</code>, so a scoring bugfix can't silently rewrite history."],
    ["todo", "Per-seat replay perspectives are cut from P0 — omniscient viewer only."]],
  stats: [["", "<b>One identity, two fact tables.</b> The bridge already exists in ACCOUNTS-BUILD-SPEC \u00A78.2 \u2014 <code>player_links</code> maps a seat to a <code>user_id</code> with sources ranked by trust. The game is a new source at the top of that ranking."],
    ["warn", "<b>Never union them.</b> \u00A78.3's own words: unverified linking turns <i>honestly fuzzy</i> stats into <i>confidently wrong</i> ones. The same logic forbids averaging offline and online."],
    ["todo", "<b>Collect now, analyse later.</b> A pinned <code>engine_version</code> means a blunder detector built in 2028 can run over every hand logged in 2026."]],
  ia: [["", "<b>P0 is 12 screens.</b> Everything green is on the critical path to a rated, logged, replayable hand."],
    ["warn", "<b>Shop / gacha / characters are not a later phase</b> — §1 rules them out permanently. The anti-gacha stance is a positioning leg, not a scope cut."]],
  default: [["", "Screens follow the §2 map. Chrome is deliberately plain — style comes later; this is for judging flow and information density."]]
};
function renderNotes() {
  var el = $("#notes");
  if (!S.opts.notes) { el.innerHTML = ""; return; }
  var key = S.screen === "shared" ? "replay" : S.screen;
  var list = NOTES[key] || NOTES.default;
  el.innerHTML = "<h2>Spec notes — " + S.screen + "</h2>" +
    list.map(function (n) { return '<div class="n ' + n[0] + '">' + n[1] + "</div>"; }).join("");
}

/* ─────────── game wiring ─────────── */
function startGame() {
  if (S.game) S.game.stop();
  var g = new E.Game({ seed: Math.floor(Math.random() * 1e6), onChange: onChange, onHandEnd: onHandEnd });
  g.autoPass = S.opts.autoPass;
  S.game = g; S.sel = null;
  g.startHand();
}
function onChange() {
  if (S.screen !== "match") return;
  var g = S.game;
  noteToss(g);
  var sig = [g.phase, g.turn, g.seq, g.selfDrawAvailable,
    g.pendingClaims ? Object.keys(g.pendingClaims.answers).length : -1, S.sel].join("|");
  if (sig !== S.sig) { S.sig = sig; render(); }
  else updateTimers();
}
function updateTimers() {
  var g = S.game;
  var bar = $(".clock i");
  if (g.phase === "AWAIT_DISCARD" && g.turn === 0 && bar) {
    var f = g.remaining("turnClock") / 10000;
    bar.style.width = (f * 100) + "%";
    bar.style.background = f < .3 ? "var(--warn)" : "var(--accent)";
  }
  var ring = $(".cbtn.pass .ring circle:last-child");
  if (ring && g.phase === "CLAIM_WINDOW") {
    var c = 2 * Math.PI * 26, fr = g.remaining("claimWindow") / 5000;
    ring.setAttribute("stroke-dashoffset", c * (1 - fr));
  }
}
function onHandEnd(r) {
  S.result = r; S.resTab = 0; S.me.played++;
  S.me.rating += r.winner === 0 ? 18 : r.outcome === "exhaustive_draw" ? 0 : -9;
  S.matches.unshift({
    won: r.winner === 0, draw: r.outcome === "exhaustive_draw",
    title: r.outcome === "exhaustive_draw" ? "Exhaustive draw" :
      (r.winner === 0 ? "Won " + r.score.faan + " faan" : S.game.seats[r.winner].name + " won " + r.score.faan + " faan"),
    sub: "東圈 · hand " + (S.game.handIdx + 1) + " · " + S.game.seats.map(function (s) {
      return (s.chips >= 0 ? "+" : "") + s.chips; }).join(" / "),
    events: S.game.log.length, log: S.game.log.concat()
  });
  go("results");
}

/* ─────────── render / route ─────────── */
var SCREENS = {
  onboarding: scOnboarding, lobby: scLobby, create: scCreate, join: scJoin, match: scMatch,
  results: scResults, matches: scMatches, replay: function () { return scReplay(false); },
  shared: function () { return scReplay(true); }, profile: scProfile, learn: scLearn,
  rules: scRules, stats: scStats, settings: scSettings, ia: scIA, observer: scObserver,
  landing: scLanding, signin: scSignin, handle: scHandle, rooms: scRooms, room: scRoom,
  handreview: scHandReview,
  leaderboard: function () { return stub("Leaderboard", "profile", '<span class="pill p1">P1</span>',
    "Seasonal ladder with a Glicko-2-family official rating, aligned with HKMA's emerging HK standard (§1)."); }
};
var NAV_SCREENS = ["lobby", "matches", "learn", "profile"];
function fitFrame() {
  var fr = $("#frame"), wrap = $("#framewrap"), stage = $(".stage");
  var w = fr.offsetWidth, h = fr.offsetHeight;
  var k = Math.min(1, (stage.clientWidth - 4) / w);
  wrap.style.transform = "scale(" + k + ")";
  wrap.style.height = (h * k) + "px";
  $("#devcap").textContent = w + " \u00D7 " + h + (k < 1 ? "  \u00B7 shown at " + Math.round(k * 100) + "%" : "");
}
function render() {
  var inner = (SCREENS[S.screen] || SCREENS.lobby)();
  $("#screen").innerHTML = '<div class="shell"><div class="pane">' + inner + "</div></div>" +
    (S.keys ? hotkeyOverlay() : "");
  try { T.recenterGlyphs($("#screen")); } catch (e) {}
  document.querySelectorAll(".rail button[data-nav]").forEach(function (b) {
    b.classList.toggle("on", b.dataset.nav === S.screen);
  });
  document.querySelectorAll(".rail button[data-dev]").forEach(function (b) {
    b.classList.toggle("on", b.dataset.dev === S.dev);
  });
  fitFrame();
  renderNotes();
  var ev = $("#evlog"); if (ev) { var c = $(".cur", ev); if (c) c.scrollIntoView({ block: "nearest" }); }
}
function go(s) {
  if (S.screen === "match" && s !== "match" && S.game) S.game.stop();
  S.screen = s;
  if (s === "match" && (!S.game || S.game.phase === "HAND_END")) { startGame(); startRitual(S.game); }
  render();
}
function toast(msg) {
  S.toast = msg; render();
  var d = document.createElement("div");
  d.className = "toast"; d.innerHTML = msg;
  $("#frame").appendChild(d);
  setTimeout(function () { d.remove(); }, 2600);
}

/* ─────────── hotkeys ───────────
 * Two rules that matter more than the specific bindings:
 *
 * 1. ACTION-BOUND, NEVER POSITION-BOUND. Call buttons appear and disappear
 *    depending on what is legal, so "key 1 = leftmost button" would mean a
 *    different action every window. P is always pong, whether or not pong is
 *    on offer. A key with no legal action does nothing — it never falls through
 *    to something else.
 * 2. THE WIN KEYS ARE NOWHERE NEAR THE PASS KEY. Under a 5s claim window,
 *    fumbling Pass when you meant Ron is unrecoverable. R/T sit far from
 *    Space/Esc on every keyboard layout.
 *
 * Space is "do the neutral thing" in every context: on your turn it discards
 * the tile you just drew; in a claim window it passes. Both are the no-change
 * action, so the mental model stays constant.
 */
var HOTKEYS = [
  ["Match", [
    ["Space", "Discard drawn tile \u00B7 or pass a claim", "the no-change action, always"],
    ["\u2190 \u2192", "Move hand selection", ""],
    ["Enter", "Discard selected tile", ""],
    ["1-9", "Jump to hand position", "arrows reach 10-13"],
    ["C", "Chow \u4E0A", "press again to cycle variants"],
    ["P", "Pong \u78B0", ""],
    ["K", "Kong \u69D3", "concealed on your turn, claimed in a window"],
    ["R", "Ron \u98DF\u7CCA", "deliberately far from Space"],
    ["T", "Tsumo \u81EA\u6478", ""],
    ["Esc", "Pass", "secondary to Space"],
    ["A", "Toggle auto-pass", ""]
  ]],
  ["Review, replay & observer", [
    ["\u2190 \u2192", "Step one event", ""],
    ["Shift + \u2190 \u2192", "Step ten events", ""],
    ["Space", "Play / pause", ""],
    ["Home / End", "Jump to start / end", ""]
  ]],
  ["Anywhere", [["?", "Show this panel", ""], ["Esc", "Back / close", ""]]]
];

function hotkeyOverlay() {
  return '<div class="keys" data-act="closekeys"><div class="keysbox">' +
    '<div class="row" style="margin-bottom:10px"><b>Keyboard</b><div class="spacer"></div>' +
    '<span class="tiny mut">? or Esc to close</span></div>' +
    HOTKEYS.map(function (grp) {
      return '<div class="tiny mut" style="margin:9px 0 4px;text-transform:uppercase;' +
        'letter-spacing:.07em;font-weight:600">' + grp[0] + "</div>" +
        grp[1].map(function (k) {
          return '<div class="row" style="padding:2px 0">' +
            '<kbd>' + k[0] + "</kbd><span>" + k[1] + "</span>" +
            (k[2] ? '<div class="spacer"></div><span class="tiny mut">' + k[2] + "</span>" : "") + "</div>";
        }).join("");
    }).join("") + "</div></div>";
}

function handOrder(me) {
  var ord = [], i;
  for (i = 0; i < me.hand.length; i++) ord.push(i);
  if (me.drawn !== null) ord.push(-1);
  return ord;
}

function matchKey(k, e) {
  var g = S.game;
  if (!g) return false;
  var me = g.seats[0], p = g.pendingClaims;
  var claimOf = function (type) {
    if (!p || !p.offers[0] || (0 in p.answers)) return null;
    var opts = p.offers[0].filter(function (c) { return c.type === type; });
    return opts.length ? opts : null;
  };
  var fire = function (type) {
    var opts = claimOf(type);
    if (!opts) return false;
    if (type === "chow" && opts.length > 1) {
      S.chowIx = ((S.chowIx || 0) + 1) % opts.length;
      g.answerClaim(0, opts[S.chowIx]);
    } else g.answerClaim(0, opts[0]);
    S.sig = ""; render(); return true;
  };

  if (k === " ") {
    if (p && p.offers[0] && !(0 in p.answers)) { g.answerClaim(0, null); S.sig = ""; render(); return true; }
    if (g.phase === "AWAIT_DISCARD" && g.turn === 0 && me.drawn !== null) {
      g.discard(0, me.drawn); S.sel = null; S.sig = ""; render(); return true;
    }
    return false;
  }
  if (k === "escape") {
    if (p && p.offers[0] && !(0 in p.answers)) { g.answerClaim(0, null); S.sig = ""; render(); return true; }
    return false;
  }
  if (k === "c") return fire("chow");
  if (k === "p") return fire("pong");
  if (k === "k") {
    if (fire("kong")) return true;
    if (g.phase === "AWAIT_DISCARD" && g.turn === 0) {
      var ck = g.concealedKongOptions(0);
      if (ck.length) { g.concealedKong(0, ck[0]); S.sig = ""; render(); return true; }
    }
    return false;
  }
  if (k === "r") return fire("winOnDiscard");
  if (k === "t") {
    if (g.phase === "AWAIT_DISCARD" && g.turn === 0 && g.selfDrawAvailable) {
      g.tryWin(0, me.drawn, true, null); return true;
    }
    return false;
  }
  if (k === "a") {
    S.opts.autoPass = !S.opts.autoPass; g.autoPass = S.opts.autoPass;
    document.getElementById("ck-autopass").checked = S.opts.autoPass;
    S.sig = ""; render(); return true;
  }
  // selection + discard: only meaningful on your own turn
  if (g.phase !== "AWAIT_DISCARD" || g.turn !== 0) return false;
  var ord = handOrder(me);
  if (!ord.length) return false;
  var cur = ord.indexOf(S.sel);
  if (k === "arrowleft" || k === "arrowright") {
    var d = k === "arrowleft" ? -1 : 1;
    cur = cur < 0 ? (d > 0 ? 0 : ord.length - 1) : (cur + d + ord.length) % ord.length;
    S.sel = ord[cur]; S.sig = ""; render(); return true;
  }
  if (k === "home") { S.sel = ord[0]; S.sig = ""; render(); return true; }
  if (k === "end") { S.sel = ord[ord.length - 1]; S.sig = ""; render(); return true; }
  if (k === "enter" && S.sel !== null) {
    g.discard(0, S.sel === -1 ? me.drawn : me.hand[S.sel]);
    S.sel = null; S.sig = ""; render(); return true;
  }
  if (k >= "1" && k <= "9") {
    var ix = +k - 1;
    if (ix < me.hand.length) { S.sel = ix; S.sig = ""; render(); return true; }
  }
  return false;
}

function scrubKey(k, shift) {
  var step = shift ? 10 : 1;
  if (S.screen === "handreview") {
    var m = S.matches[S.reviewIx || 0];
    if (!m) return false;
    var n = reviewSeries(m).length;
    if (k === "arrowleft") { S.turn = Math.max(0, (S.turn || 0) - step); render(); return true; }
    if (k === "arrowright") { S.turn = Math.min(n - 1, (S.turn || 0) + step); render(); return true; }
    if (k === "home") { S.turn = 0; render(); return true; }
    if (k === "end") { S.turn = n - 1; render(); return true; }
  }
  if (S.screen === "observer") {
    var L = S.matches[S.reviewIx || 0].log.length;
    if (k === "arrowleft") { S.obs = Math.max(0, (S.obs || 0) - step); render(); return true; }
    if (k === "arrowright") { S.obs = Math.min(L, (S.obs || 0) + step); render(); return true; }
    if (k === "home") { S.obs = 0; render(); return true; }
    if (k === "end") { S.obs = L; render(); return true; }
  }
  if (S.screen === "replay" || S.screen === "shared") {
    var R = S.replay;
    if (k === "arrowleft") { R.idx = Math.max(0, R.idx - step); render(); return true; }
    if (k === "arrowright") { R.idx = Math.min(R.log.length, R.idx + step); render(); return true; }
    if (k === "home") { R.idx = 0; render(); return true; }
    if (k === "end") { R.idx = R.log.length; render(); return true; }
  }
  return false;
}

document.addEventListener("keydown", function (e) {
  if (/^(input|textarea|select)$/i.test(e.target.tagName)) return;
  var k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (k === "?") { S.keys = !S.keys; render(); e.preventDefault(); return; }
  if (S.keys && (k === "escape" || k === "?")) { S.keys = false; render(); e.preventDefault(); return; }
  var handled = false;
  if (S.screen === "match") handled = matchKey(k, e);
  else handled = scrubKey(k, e.shiftKey);
  if (!handled && k === "escape") { S.keys = false; render(); handled = true; }
  if (handled) e.preventDefault();
});

/* ─────────── events ─────────── */
document.addEventListener("click", function (e) {
  var el = e.target.closest("[data-nav],[data-act],[data-dev],[data-toss]");
  if (!el) return;
  var g = S.game;
  if (el.dataset.tab) S.tab = el.dataset.tab;
  var act = el.dataset.act;

  if (act === "closekeys" && el === e.target) { S.keys = false; render(); return; }
  if (act === "toggleauto") { S.opts.autoPass = !S.opts.autoPass; if (g) g.autoPass = S.opts.autoPass;
    document.getElementById("ck-autopass").checked = S.opts.autoPass; S.sig = ""; render(); return; }
  if (act === "showkeys") { S.keys = true; render(); return; }
  if (act === "signin") { go("signin"); return; }
  if (act === "dosignin") { S.me.signedIn = true; go("handle"); return; }
  if (act === "guest") { go("lobby"); return; }
  if (act === "openreview") { S.reviewIx = +el.dataset.i; S.obs = null; S.turn = null; go("handreview"); return; }
  if (act === "selturn") { S.turn = +el.dataset.i; render(); return; }
  if (act === "reveal") { S.reveal = !S.reveal; render(); return; }
  if (act === "obs") { S.obs = Math.max(0, Math.min(S.matches[S.reviewIx || 0].log.length,
    (S.obs || 0) + (+el.dataset.d))); render(); return; }
  if (act === "quick") { go("match"); return; }
  if (act === "newhand") { S.game && S.game.stop(); S.game = null; go("match"); startRitual(S.game); return; }
  if (act === "skipritual") { skipRitual(); return; }
  if (act === "nexthand") {
    if (g) { g.handIdx++; if (g.result && g.result.winner !== g.dealer && g.result.outcome !== "exhaustive_draw") g.dealer = (g.dealer + 1) % 4;
      g.result = null; g.arm(); g.startHand(); }
    go("match"); return;
  }
  if (act === "restab") { S.resTab = +el.dataset.i; render(); return; }
  if (act === "share") { toast("Copied a public replay link.<br><span style='opacity:.7;font-size:11px'>mahjongresearch.com/r/9f3a2c — no account needed to view</span>"); return; }
  if (act === "watch" || act === "openreplay") {
    var m = act === "watch" ? S.matches[0] : S.matches[+el.dataset.i];
    if (!m) return;
    S.replay = { log: m.log, idx: m.log.length, playing: false };
    go(act === "watch" ? "replay" : "replay"); return;
  }
  if (act === "step") { S.replay.idx = Math.max(0, Math.min(S.replay.log.length, S.replay.idx + (+el.dataset.d))); render(); return; }
  if (act === "play") {
    S.replay.playing = !S.replay.playing;
    if (S.replay.playing) {
      S.replay.idx = 0;
      S.replay.t = setInterval(function () {
        if (S.replay.idx >= S.replay.log.length || !S.replay.playing) { clearInterval(S.replay.t); S.replay.playing = false; }
        else S.replay.idx++;
        render();
      }, 420);
    } else clearInterval(S.replay.t);
    render(); return;
  }
  // match interactions
  if (act === "tap" && g) {
    var ix = +el.dataset.ix;
    if (g.phase !== "AWAIT_DISCARD" || g.turn !== 0) return;
    if (S.sel === ix) { g.discard(0, ix === -1 ? g.seats[0].drawn : g.seats[0].hand[ix]); S.sel = null; }
    else S.sel = ix;
    onChange(); render(); return;
  }
  if (act === "claim" && g && g.pendingClaims) { g.answerClaim(0, g.pendingClaims.offers[0][+el.dataset.i]); render(); return; }
  if (act === "pass" && g) { g.answerClaim(0, null); render(); return; }
  if (act === "tsumo" && g) { g.tryWin(0, g.seats[0].drawn, true, null); return; }
  if (act === "ckong" && g) { g.concealedKong(0, +el.dataset.t); render(); return; }
  if (el.dataset.room) { S.room = el.dataset.room; }
  if (el.dataset.toss !== undefined) {
    S.tossOverride = el.dataset.toss || null;
    document.querySelectorAll(".rail button[data-toss]").forEach(function (b) {
      b.classList.toggle("on", b.dataset.toss === (S.tossOverride || ""));
    });
    return;
  }
  if (el.dataset.dev) { S.dev = el.dataset.dev; $("#frame").dataset.dev = S.dev; S.sig = ""; render(); return; }
  if (el.dataset.nav) go(el.dataset.nav);
});
document.addEventListener("input", function (e) {
  if (e.target.dataset.act === "scrub") { S.replay.idx = +e.target.value; render(); }
  if (e.target.dataset.act === "obsscrub") { S.obs = +e.target.value; render(); }
});
["labels", "autopass", "floor", "omni", "notes", "riichi", "attrib", "safe"].forEach(function (k) {
  var id = { labels: "labels", autopass: "autoPass", floor: "floor", omni: "omni",
             notes: "notes", riichi: "riichi", attrib: "attrib", safe: "safe" }[k];
  document.getElementById("ck-" + k).addEventListener("change", function (e) {
    S.opts[id] = e.target.checked;
    if (id === "autoPass" && S.game) S.game.autoPass = e.target.checked;
    if (id === "safe") $("#frame").classList.toggle("showsafe", e.target.checked);
    S.sig = ""; render();
  });
});

/* bot texture readout — makes §6's "bots are a blocker" concrete */
setTimeout(function () {
  var out = {}, refused = 0, faans = [], claims = 0, N = 120;
  for (var s = 0; s < N; s++) {
    var g = new E.Game({ seed: 5000 + s });
    g.setDeadline = function () {}; g.arm = function () {};
    var ended = null; g.onHandEnd = function (r) { ended = r; };
    g.startHand();
    var guard = 0;
    while (!ended && guard++ < 3000) {
      if (g.phase === "AWAIT_DISCARD") g.botDiscard(g.turn);
      else if (g.phase === "CLAIM_WINDOW") { g.collectBotClaims(); if (g.pendingClaims) g.resolveClaims(); }
      else break;
    }
    refused += g.log.filter(function (e) { return e.type === "refused_win"; }).length;
    claims += g.log.filter(function (e) { return e.type === "claimed"; }).length;
    if (ended) { out[ended.outcome] = (out[ended.outcome] || 0) + 1; if (ended.score) faans.push(ended.score.faan); }
  }
  var dr = (out.exhaustive_draw || 0) / N;
  document.getElementById("texture").innerHTML =
    "<b>" + (dr * 100).toFixed(0) + "%</b> exhaustive draws<br>" +
    "<b>" + (faans.reduce(function (a, b) { return a + b; }, 0) / faans.length).toFixed(1) + "</b> mean winning faan<br>" +
    "<b>" + (claims / N).toFixed(1) + "</b> claims / hand<br>" +
    "<b>" + (refused / N).toFixed(1) + "</b> refused wins / hand<br>" +
    '<span style="color:#8b8b96">' + N + " simulated hands. Gate 3 measures<br>these four against humans.</span>";
}, 60);

window.addEventListener('resize', fitFrame);
render();
window.__mj = { S: S, render: render, E: E };   // dev hook, set only after init
})();

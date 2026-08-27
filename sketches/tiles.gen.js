"use strict";
var MJTiles = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/features/tiles/render.ts
  var render_exports = {};
  __export(render_exports, {
    PAL: () => PAL,
    labelOverlay: () => labelOverlay,
    recenterGlyphs: () => recenterGlyphs,
    tileArt: () => tileArt,
    tileBack: () => tileBack,
    tileBody: () => tileBody,
    tileDragon: () => tileDragon,
    tileFlower: () => tileFlower,
    tileSVG: () => tileSVG,
    tileSuo: () => tileSuo,
    tileTong: () => tileTong,
    tileWan: () => tileWan,
    tileWind: () => tileWind
  });
  var PAL = { face: "#FAFAF8", border: "#CCCCCC", blue: "#1845A5", green: "#1A8B3A", red: "#D42222" };
  var B = "blue";
  var G = "green";
  var R = "red";
  var fx = (v) => (+v).toFixed(2);
  function tileBody() {
    return `<rect x="1" y="1" width="98" height="138" rx="7" ry="7" fill="${PAL.face}" stroke="${PAL.border}" stroke-width="1.5"/>`;
  }
  var RULES = {
    W: 100,
    H: 140,
    marginNat: 11,
    marginMin: 7,
    gutterMin: 1,
    gapRatio2: 0.275,
    tentAngle: 25,
    squishBeadRy: 0.8,
    squishSpacing: 1.1,
    tierCap(count, nat, grow = true) {
      if (count === 1) return Infinity;
      if (!grow) return nat;
      if (count === 2) return RULES.H / (2 + 3 * RULES.gapRatio2);
      if (count === 3) return nat * 1.1;
      return nat;
    }
  };
  function solveLayout(bands, prim, count, opts = {}) {
    const Rn = bands.length;
    const gm = prim.gutterMin ?? RULES.gutterMin;
    const Cmax = Math.max(1, ...bands.map((b) => b.cols ? b.of : b.anchor3 || b.vrow ? 3 : !b.colOf && !b.dy && !b.block && !b.tent ? b.n : 1));
    const dyRange = (b) => b.dy ? Math.max(...b.dy) - Math.min(...b.dy) : 0;
    const sinT = Math.sin(RULES.tentAngle * Math.PI / 180), cosT = Math.cos(RULES.tentAngle * Math.PI / 180);
    const hFactor = (b) => b.block ? b.block.rows : b.tent ? cosT + prim.aspect * sinT : 1 + dyRange(b) + (b.pad || 0);
    const totalFactor = bands.reduce((s, b) => s + hFactor(b), 0);
    const fixedGaps = bands.reduce((s, b) => s + (b.block ? (b.block.rows - 1) * b.block.gap : 0), 0);
    let m = RULES.marginNat, size = 0, my = 0;
    while (true) {
      my = opts.my ?? (opts.tightV ? RULES.marginMin : m);
      const Wc2 = RULES.W - 2 * m, Hc2 = RULES.H - 2 * my;
      const gapCount = opts.distV === "between" ? Math.max(Rn - 1, 0) : Rn;
      const fitV = (Hc2 - gapCount * gm - fixedGaps) / totalFactor;
      let fitH = (Wc2 / Cmax - gm) / prim.aspect;
      bands.forEach((b) => {
        if (b.dy && b.n > 1) fitH = Math.min(fitH, Wc2 / ((1 + 0.8 * (b.n - 1)) * prim.aspect));
        if (b.block) fitH = Math.min(fitH, (Wc2 - (b.block.cols - 1) * b.block.gap - gm) / (b.block.cols * prim.aspect));
        if (b.tent) {
          const targetSpan = 2 * Wc2 / 3 + prim.aspect * prim.nat;
          fitH = Math.min(fitH, targetSpan / (4 * sinT + prim.aspect * cosT));
        }
        if (b.anchor3 && b.n > 1)
          fitH = Math.min(fitH, (2 * Wc2 / 3 / (b.n - 1) - RULES.gutterMin) / prim.aspect);
      });
      size = Math.min(RULES.tierCap(count, prim.nat, prim.grow ?? true), fitV, fitH);
      if (size >= prim.min || m <= RULES.marginMin) break;
      m -= 1;
    }
    size = Math.max(size, prim.min);
    const Wc = RULES.W - 2 * m, Hc = RULES.H - 2 * my;
    const w = prim.aspect * size;
    const bandH = (b) => size * hFactor(b) + (b.block ? (b.block.rows - 1) * b.block.gap : 0);
    const totalH = bands.reduce((s, b) => s + bandH(b), 0);
    let g, yStart;
    if (opts.distV === "even") {
      g = (RULES.H - totalH) / (Rn + 1);
      yStart = g;
    } else if (opts.distV === "between") {
      g = Rn > 1 ? (Hc - totalH) / (Rn - 1) : 0;
      yStart = Rn > 1 ? my : my + (Hc - totalH) / 2;
    } else {
      g = (Hc - totalH) / Rn;
      yStart = my + g / 2;
    }
    const spreadX = (f) => m + w / 2 + (Wc - w) * f;
    const blockBand = bands.find((b) => b.block);
    const blockXs = blockBand ? Array.from({ length: blockBand.block.cols }, (_, c) => 50 + (c - (blockBand.block.cols - 1) / 2) * (w + blockBand.block.gap)) : null;
    const slots = [];
    let y = yStart;
    bands.forEach((band) => {
      const cyPlain = y + bandH(band) / 2;
      if (band.block) {
        const { cols, rows, gap } = band.block;
        for (let r2 = 0; r2 < rows; r2++) {
          const cy = y + size / 2 + r2 * (size + gap);
          for (let c = 0; c < cols; c++) slots.push([50 + (c - (cols - 1) / 2) * (w + gap), cy]);
        }
      } else if (band.colOf) {
        const [idx, total] = band.colOf;
        slots.push([spreadX(total > 1 ? idx / (total - 1) : 0.5), cyPlain]);
      } else if (band.dy) {
        const cy = y + bandH(band) / 2;
        for (let k = 0; k < band.n; k++)
          slots.push([spreadX(band.n > 1 ? k / (band.n - 1) : 0.5), cy + band.dy[k] * size]);
      } else if (band.tent) {
        const deg = RULES.tentAngle;
        const dx = size * sinT;
        const hwRot = (size * sinT + w * cosT) / 2;
        const span = 3 * dx + 2 * hwRot;
        const cy = y + bandH(band) / 2;
        const x1 = m + (Wc - span) / 2 + hwRot;
        for (let k = 0; k < 4; k++) {
          const sign = k % 2 === 0 === (band.tent === "up") ? 1 : -1;
          slots.push([x1 + k * dx, cy, sign * deg]);
        }
      } else if (band.cols) {
        const gH = (Wc - band.of * w) / band.of;
        band.cols.forEach((ci) => slots.push([m + gH / 2 + w / 2 + ci * (w + gH), cyPlain]));
      } else if (band.vrow) {
        const cy = y + bandH(band) / 2;
        const gH3 = (Wc - 3 * w) / 3;
        const xL = m + gH3 / 2 + w / 2, xR = xL + 2 * (w + gH3);
        slots.push([xL, cy, 0], [xR, cy, 0]);
        const endOff = (prim.endBeadFrac ?? 0.316) * size;
        const q = prim.beadQ ?? 1;
        const span = 2 * endOff;
        const dx = 50 - xL;
        const dyv = Math.sqrt(Math.max(span * span - dx * dx, 0.01));
        const deg = Math.atan2(dx, dyv) * 180 / Math.PI;
        const rad = Math.abs(deg) * Math.PI / 180;
        const hwv = endOff * Math.sin(rad) + w / 2;
        const hhv = endOff * Math.cos(rad) + w / 2 * q;
        if (band.vrow === "up") {
          const ay = cy + endOff, py = ay - dyv;
          slots.push(
            [(xL + 50) / 2, (ay + py) / 2, deg, 1, hwv, hhv],
            [(xR + 50) / 2, (ay + py) / 2, -deg, 1, hwv, hhv]
          );
        } else {
          const ay = cy - endOff, vy = ay + dyv;
          slots.push(
            [(xL + 50) / 2, (ay + vy) / 2, -deg, 1, hwv, hhv],
            [(xR + 50) / 2, (ay + vy) / 2, deg, 1, hwv, hhv]
          );
        }
      } else if (band.anchor3) {
        const gH3 = (Wc - 3 * w) / 3;
        const c0 = m + gH3 / 2 + w / 2, c2 = c0 + 2 * (w + gH3);
        for (let k = 0; k < band.n; k++)
          slots.push([c0 + (c2 - c0) * k / (band.n - 1), cyPlain]);
      } else if (band.align === "block" && blockXs && blockXs.length === band.n) {
        blockXs.forEach((bx) => slots.push([bx, cyPlain]));
      } else {
        const gH = (Wc - band.n * w) / band.n;
        for (let k = 0; k < band.n; k++)
          slots.push([m + gH / 2 + w / 2 + k * (w + gH), cyPlain]);
      }
      y += bandH(band) + g;
    });
    return { slots, size, margin: m, marginY: my };
  }
  var GLYPH = { font: "FandolKai, 'Noto Serif SC', 'Songti SC', STSong, serif", weight: 0.6, stretchX: 1.15, stretchY: 1.18, fontLift: 0.04 };
  function glyph({ ch, cx, cy, size, color }) {
    const dy = -size * GLYPH.fontLift;
    return `<g transform="translate(${cx} ${cy + dy}) scale(${GLYPH.stretchX} ${GLYPH.stretchY})" class="glyph"><text x="0" y="0" text-anchor="middle" dominant-baseline="central" font-family="${GLYPH.font}" font-size="${size}" fill="${PAL[color]}" stroke="${PAL[color]}" stroke-width="${GLYPH.weight}" stroke-linejoin="round" paint-order="stroke">${ch}</text></g>`;
  }
  var NUMERALS = ["\u4E00", "\u4E8C", "\u4E09", "\u56DB", "\u4F0D", "\u516D", "\u4E03", "\u516B", "\u4E5D"];
  function tileWan(n) {
    return tileBody() + glyph({ ch: NUMERALS[n - 1], cx: 50, cy: 38, size: 44, color: "blue" }) + glyph({ ch: "\u842C", cx: 50, cy: 96, size: 60, color: "red" });
  }
  var WINDCH = ["\u6771", "\u5357", "\u897F", "\u5317"];
  function tileWind(k) {
    return tileBody() + glyph({ ch: WINDCH[k], cx: 50, cy: 70, size: 70, color: "blue" });
  }
  function tileDragon(k) {
    if (k === 0) return tileBody() + glyph({ ch: "\u4E2D", cx: 50, cy: 70, size: 78, color: "red" });
    if (k === 1) return tileBody() + glyph({ ch: "\u767C", cx: 50, cy: 70, size: 68, color: "green" });
    return tileBody() + `<rect x="22" y="31" width="56" height="78" rx="2" fill="none" stroke="${PAL.blue}" stroke-width="2.6"/><rect x="27" y="36" width="46" height="68" rx="1.5" fill="none" stroke="${PAL.blue}" stroke-width="1.4"/>`;
  }
  function recenterGlyphs(root) {
    root.querySelectorAll("g.glyph").forEach((g) => {
      const t = g.querySelector("text");
      if (!t) return;
      let bb;
      try {
        bb = t.getBBox();
      } catch {
        return;
      }
      if (!bb || bb.width === 0) return;
      const curX = parseFloat(t.getAttribute("x") || "0") || 0;
      const curY = parseFloat(t.getAttribute("y") || "0") || 0;
      t.setAttribute("x", String(curX - (bb.x + bb.width / 2)));
      t.setAttribute("y", String(curY - (bb.y + bb.height / 2)));
    });
  }
  function pipBullseye(cx, cy, d, color, P) {
    const Rr = d / 2, b = P.whiteBoost ?? 1.1, n = P.innerRings, k = P.dotBoost ?? 1.2;
    const wo = P.outerFrac * Rr;
    const rd = (Rr - wo) / (1 + 2 / k * (n * (1 + b) + b));
    const wg = 2 * rd / k;
    const ww = b * wg;
    const parts = [`<circle cx="${fx(cx)}" cy="${fx(cy)}" r="${fx(rd)}" fill="${PAL[color]}"/>`];
    for (let i = 1; i <= n; i++) {
      const rInner = rd + i * ww + (i - 1) * wg;
      parts.push(`<circle cx="${fx(cx)}" cy="${fx(cy)}" r="${fx(rInner + wg / 2)}" fill="none" stroke="${PAL[color]}" stroke-width="${fx(wg)}"/>`);
    }
    parts.push(`<circle cx="${fx(cx)}" cy="${fx(cy)}" r="${fx(Rr - wo / 2)}" fill="none" stroke="${PAL[color]}" stroke-width="${fx(wo)}"/>`);
    return parts.join("");
  }
  var P_BULL_1 = { innerRings: 1, outerFrac: 0.29, whiteBoost: 1.1, dotBoost: 2.4 };
  var P_BULL_2 = { innerRings: 2, outerFrac: 0.24, whiteBoost: 1.1, dotBoost: 2.4 };
  function rosette(cx, cy, d, centerDraw) {
    const Rr = d / 2, F = PAL.face;
    const parts = [];
    const bandR = Rr * 0.88, bandW = Rr * 0.24;
    parts.push(`<circle cx="${fx(cx)}" cy="${fx(cy)}" r="${fx(bandR)}" fill="none" stroke="${PAL.green}" stroke-width="${fx(bandW)}"/>`);
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      parts.push(`<circle cx="${fx(cx + Math.cos(a) * bandR)}" cy="${fx(cy + Math.sin(a) * bandR)}" r="${fx(Rr * 0.055)}" fill="${F}"/>`);
    }
    for (let i = 0; i < 10; i++) {
      const a = i * 36, rad = a * Math.PI / 180;
      const px = cx + Math.cos(rad) * Rr * 0.55, py = cy + Math.sin(rad) * Rr * 0.55;
      parts.push(`<ellipse cx="${fx(px)}" cy="${fx(py)}" rx="${fx(Rr * 0.18)}" ry="${fx(Rr * 0.11)}" fill="${PAL.blue}" transform="rotate(${a} ${fx(px)} ${fx(py)})"/>`);
    }
    parts.push(`<circle cx="${fx(cx)}" cy="${fx(cy)}" r="${fx(Rr * 0.37)}" fill="${F}"/>`);
    parts.push(centerDraw(cx, cy, Rr * 0.66));
    return parts.join("");
  }
  var PIP_PRIM = { nat: 30, min: 28, aspect: 1 };
  function caneAspect(P) {
    return 2 / (2 * (P.beadRy ?? 1) + (P.beads - 1) * P.spacing);
  }
  function caneGeom(H, P) {
    const q = P.beadRy ?? 1;
    const r = H / (2 * q + (P.beads - 1) * P.spacing);
    return { q, r, step: P.spacing * r };
  }
  function caneBeads(cx, cy, H, color, P) {
    const { q, r, step } = caneGeom(H, P);
    const y0 = cy - (P.beads - 1) / 2 * step;
    const parts = [];
    for (let i = 0; i < P.beads; i++)
      parts.push(`<ellipse cx="${fx(cx)}" cy="${fx(y0 + i * step)}" rx="${fx(r)}" ry="${fx(r * q)}" fill="${PAL[color]}"/>`);
    return parts.join("");
  }
  function caneSlit(cx, cy, H, _color, P) {
    if (!(P.slit > 0)) return "";
    const { q, r, step } = caneGeom(H, P);
    const y0 = cy - (P.beads - 1) / 2 * step;
    const over = r * q * (P.slitOver ?? 0.18);
    const yTop = y0 - over, yBot = y0 + (P.beads - 1) * step + over;
    return `<line x1="${fx(cx)}" y1="${fx(yTop)}" x2="${fx(cx)}" y2="${fx(yBot)}" stroke="${PAL.face}" stroke-width="${fx(r * P.slit)}" stroke-linecap="round"/>`;
  }
  var CANE_PRIM = { nat: 52, min: 36, aspect: 1, gutterMin: 6, grow: false };
  var CANE_C2 = { beads: 3, spacing: 1.72, slit: 0.35 };
  function squishCaneP(P) {
    return {
      ...P,
      beadRy: RULES.squishBeadRy,
      spacing: RULES.squishSpacing,
      slit: P.slit > 0 ? 0.38 : 0,
      slitOver: 0.12
    };
  }
  function caneSetup(n) {
    const P = BAMBOO_SPECS[n] && BAMBOO_SPECS[n].squish ? squishCaneP(CANE_C2) : CANE_C2;
    const q = P.beadRy ?? 1;
    const denom = 2 * q + (P.beads - 1) * P.spacing;
    return { prim: {
      ...CANE_PRIM,
      aspect: caneAspect(P),
      endBeadFrac: (P.beads - 1) / 2 * P.spacing / denom,
      beadQ: q
    }, P };
  }
  var GRID_2x2 = [{ n: 2 }, { n: 2 }];
  var RED_QUAD = { block: { cols: 2, rows: 2, gap: 2 } };
  var STAG = 0.35;
  var CIRCLE_SPECS = {
    2: { bands: [{ n: 1 }, { n: 1 }], colors: [G, B], distV: "even" },
    3: { bands: [{ colOf: [0, 3] }, { colOf: [1, 3] }, { colOf: [2, 3] }], colors: [B, R, G] },
    4: { bands: GRID_2x2, colors: [G, B, B, G] },
    5: { bands: GRID_2x2, colors: [G, B, B, G], center: R },
    6: { bands: [{ n: 2, align: "block", pad: 2 * STAG }, RED_QUAD], colors: [G, G, R, R, R, R], tightV: true },
    7: { bands: [{ n: 3, dy: [-STAG, 0, STAG] }, RED_QUAD], colors: [G, G, G, R, R, R, R], tightV: true },
    8: { bands: [{ block: { cols: 2, rows: 4, gap: 2 } }], colors: [B, B, B, B, B, B, B, B] },
    9: { bands: [{ n: 3 }, { n: 3 }, { n: 3 }], colors: [G, G, G, R, R, R, B, B, B] }
  };
  var B_OUT3 = { cols: [0, 2], of: 3 };
  var BAMBOO_3x2 = [{ n: 3 }, { n: 3 }];
  var BAMBOO_SPECS = {
    2: { bands: [{ n: 1 }, { n: 1 }], colors: [G, G] },
    3: { bands: [{ n: 1 }, B_OUT3], colors: [G, G, G] },
    4: { bands: [{ n: 2 }, { n: 2 }], colors: [G, G, G, G] },
    5: { bands: [B_OUT3, B_OUT3], colors: [G, G, G, G], center: R },
    6: { bands: BAMBOO_3x2, colors: [G, G, G, G, G, G] },
    7: { bands: [{ n: 1 }, ...BAMBOO_3x2], colors: [R, G, G, G, G, G, G], squish: true },
    8: { bands: [{ vrow: "up" }, { vrow: "down" }], colors: [G, G, G, G, G, G, G, G] },
    9: { bands: [{ n: 3 }, { n: 3 }, { n: 3 }], colors: [G, R, G, G, R, G, G, R, G], squish: true }
  };
  Object.values(BAMBOO_SPECS).forEach((sp) => {
    sp.distV = "between";
    sp.my = 12;
  });
  function renderSpec(spec, prim, drawFn, P, drawFn2) {
    const count = spec.colors.length + (spec.center ? 1 : 0);
    const { slots, size } = solveLayout(spec.bands, prim, count, { tightV: spec.tightV, distV: spec.distV, my: spec.my });
    const pass = (fn) => slots.map(([x, y, rot, sc], i) => {
      const piece = fn(x, y, size * (sc || 1), spec.colors[i], P);
      return rot ? `<g transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})">${piece}</g>` : piece;
    }).join("") + (spec.center ? fn(50, 70, size, spec.center, P) : "");
    return pass(drawFn) + (drawFn2 ? pass(drawFn2) : "");
  }
  var pipN = (cx, cy, d, c) => pipBullseye(cx, cy, d, c, P_BULL_1);
  function tileTong(n) {
    if (n === 1) {
      const D = RULES.W - 2 * RULES.marginNat;
      return tileBody() + rosette(50, 70, D, (cx, cy, d) => pipN(cx, cy, d, R));
    }
    if (n === 2) {
      const spec = CIRCLE_SPECS[2];
      const { slots, size } = solveLayout(spec.bands, PIP_PRIM, 2, { distV: spec.distV });
      return tileBody() + slots.map(([x, y], i) => pipBullseye(x, y, size, spec.colors[i], P_BULL_2)).join("");
    }
    return tileBody() + renderSpec(CIRCLE_SPECS[n], PIP_PRIM, pipN, null);
  }
  var BIRD_ART = `<g transform="translate(3.68 10.56) scale(0.08492)"><path d="M 590.0 207.5 C 590.0 201.8 585.8 224.0 591.5 224.0 C 592.0 229.5 604.0 225.0 608.5 224.0 C 613.0 223.0 612.7 220.3 618.5 218.0 C 624.3 215.7 633.7 211.2 643.5 210.0 C 653.3 208.8 667.0 209.0 677.5 211.0 C 688.0 213.0 697.4 216.6 706.5 222.0 C 715.6 227.4 724.9 235.9 732.0 243.5 C 739.1 251.1 744.0 259.0 749.0 267.5 C 754.0 276.0 758.0 284.3 762.0 294.5 C 766.0 304.7 769.8 315.2 773.0 328.5 C 776.2 341.8 779.7 358.5 781.0 374.5 C 782.3 390.5 782.5 406.8 781.0 424.5 C 779.5 442.2 775.7 464.7 772.0 480.5 C 768.3 496.3 763.8 507.3 759.0 519.5 C 754.2 531.7 748.5 543.2 743.0 553.5 C 737.5 563.8 733.1 571.4 726.0 581.5 C 718.9 591.6 689.8 621.3 700.5 614.0 C 692.0 624.8 720.2 601.3 732.5 592.0 C 744.8 582.7 756.0 574.8 774.5 558.0 C 793.0 541.2 824.7 508.5 843.5 491.0 C 862.3 473.5 877.5 459.3 887.5 453.0 C 897.5 446.7 903.3 447.5 903.5 453.0 C 908.8 453.0 907.6 462.2 904.0 469.5 C 900.4 476.8 877.5 500.0 882.0 496.5 C 874.7 505.5 890.5 487.7 895.5 486.0 C 900.5 484.3 912.0 481.2 912.0 486.5 C 917.5 486.7 922.6 489.8 912.0 502.5 C 901.4 515.2 862.8 552.9 848.5 563.0 C 834.2 573.1 831.5 561.3 826.5 563.0 C 821.5 564.7 828.2 564.8 818.5 573.0 C 808.8 581.2 776.4 602.9 768.0 612.5 C 759.6 622.1 768.6 626.9 768.0 630.5 C 767.4 634.1 770.8 629.6 764.5 634.0 C 758.2 638.4 743.8 648.8 730.5 657.0 C 717.2 665.2 695.1 678.8 684.5 683.0 C 673.9 687.2 667.3 686.2 667.0 682.5 C 661.2 682.3 667.7 675.3 666.0 671.5 C 664.3 667.7 658.5 663.3 657.0 659.5 C 655.5 655.7 661.7 648.8 657.0 648.5 C 657.0 644.8 643.0 653.5 643.0 647.5 C 638.3 647.2 639.7 636.5 643.0 629.5 C 646.3 622.5 655.7 615.7 663.0 605.5 C 670.3 595.3 680.3 579.8 687.0 568.5 C 693.7 557.2 697.7 549.7 703.0 537.5 C 708.3 525.3 714.8 508.0 719.0 495.5 C 723.2 483.0 725.5 473.8 728.0 462.5 C 730.5 451.2 732.8 440.8 734.0 427.5 C 735.2 414.2 735.3 393.7 735.0 382.5 C 734.7 371.3 734.2 370.5 732.0 360.5 C 729.8 350.5 725.7 333.3 722.0 322.5 C 718.3 311.7 714.3 303.5 710.0 295.5 C 705.7 287.5 702.2 281.4 696.0 274.5 C 689.8 267.6 679.8 258.9 672.5 254.0 C 665.2 249.1 658.7 246.5 652.5 245.0 C 646.3 243.5 641.5 243.8 635.5 245.0 C 629.5 246.2 620.8 250.0 616.5 252.0 C 612.2 254.0 612.2 254.8 609.5 257.0 C 606.8 259.2 603.0 262.0 600.0 265.5 C 597.0 269.0 595.7 276.0 591.5 278.0 C 587.3 280.0 574.3 285.2 575.0 277.5 C 569.5 277.3 575.2 260.8 577.0 254.5 C 578.8 248.2 582.0 244.3 586.0 239.5 C 590.0 234.7 604.7 225.8 601.0 225.5 C 606.0 220.8 590.0 230.2 590.0 224.5 C 586.3 224.2 589.5 202.0 590.0 207.5 Z M 619.0 256.5 C 625.3 255.8 639.2 255.9 645.5 257.0 C 651.8 258.1 653.8 260.8 656.5 263.0 C 659.2 265.2 660.8 268.2 662.0 270.5 C 663.2 272.8 663.7 270.8 664.0 276.5 C 664.3 282.2 664.8 298.2 664.0 304.5 C 663.2 310.8 661.8 311.4 659.0 314.5 C 656.2 317.6 654.6 321.4 647.5 323.0 C 640.4 324.6 623.3 324.7 616.5 324.0 C 609.7 323.3 609.6 321.8 606.5 319.0 C 603.4 316.2 599.6 314.6 598.0 307.5 C 596.4 300.4 596.8 282.7 597.0 276.5 C 597.2 270.3 597.2 273.1 599.0 270.5 C 600.8 267.9 604.2 263.3 607.5 261.0 C 610.8 258.7 612.7 257.2 619.0 256.5 Z M 548.0 290.5 C 548.2 286.7 545.8 293.1 549.5 294.0 C 553.2 294.9 565.2 294.2 570.5 296.0 C 575.8 297.8 577.8 298.9 581.0 304.5 C 584.2 310.1 588.8 320.3 590.0 329.5 C 591.2 338.7 586.1 353.6 588.0 359.5 C 589.9 365.4 596.9 362.4 601.5 365.0 C 606.1 367.6 611.6 371.6 615.5 375.0 C 619.4 378.4 621.6 380.4 625.0 385.5 C 628.4 390.6 633.0 397.2 636.0 405.5 C 639.0 413.8 641.8 423.3 643.0 435.5 C 644.2 447.7 643.7 467.0 643.0 478.5 C 642.3 490.0 641.3 494.7 639.0 504.5 C 636.7 514.3 633.3 526.2 629.0 537.5 C 624.7 548.8 618.0 562.7 613.0 572.5 C 608.0 582.3 602.3 592.2 599.0 596.5 C 595.7 600.8 594.0 597.0 593.0 598.5 C 592.0 600.0 597.7 598.0 593.0 605.5 C 588.3 613.0 575.3 630.7 565.0 643.5 C 554.7 656.3 541.9 670.9 531.0 682.5 C 520.1 694.1 509.9 703.8 499.5 713.0 C 489.1 722.2 479.8 729.9 468.5 738.0 C 457.2 746.1 424.5 765.3 432.0 761.5 C 419.8 769.3 449.9 751.9 454.5 750.0 C 459.1 748.1 455.8 752.0 459.5 750.0 C 463.2 748.0 461.8 746.0 476.5 738.0 C 491.2 730.0 532.9 707.9 547.5 702.0 C 562.1 696.1 560.1 699.2 564.0 702.5 C 567.9 705.8 569.2 717.8 571.0 721.5 C 572.8 725.2 574.3 721.2 575.0 724.5 C 575.7 727.8 575.8 738.2 575.0 741.5 C 574.2 744.8 566.0 744.2 570.0 744.5 C 568.3 745.5 582.2 740.0 582.0 745.5 C 586.0 745.8 586.8 762.0 581.5 762.0 C 581.3 767.5 566.2 766.7 565.5 762.0 C 560.2 762.0 572.3 742.5 563.5 748.0 C 562.8 743.3 541.4 760.1 537.0 764.5 C 532.6 768.9 538.8 768.3 537.0 774.5 C 535.2 780.7 529.7 790.2 526.0 801.5 C 522.3 812.8 518.3 824.0 515.0 842.5 C 511.7 861.0 506.8 890.5 506.0 912.5 C 505.2 934.5 507.7 956.0 510.0 974.5 C 512.3 993.0 515.3 1006.0 520.0 1023.5 C 524.7 1041.0 529.0 1055.2 538.0 1079.5 C 547.0 1103.8 566.2 1148.8 574.0 1169.5 C 581.8 1190.2 581.8 1191.3 585.0 1203.5 C 588.2 1215.7 591.3 1232.0 593.0 1242.5 C 594.7 1253.0 595.0 1254.0 595.0 1266.5 C 595.0 1279.0 595.0 1302.5 593.0 1317.5 C 591.0 1332.5 587.1 1345.4 583.0 1356.5 C 578.9 1367.6 573.7 1379.5 568.5 1384.0 C 563.3 1388.5 552.0 1389.5 552.0 1383.5 C 546.5 1383.3 551.0 1371.7 552.0 1365.5 C 553.0 1359.3 556.3 1354.5 558.0 1346.5 C 559.7 1338.5 562.5 1330.8 562.0 1317.5 C 561.5 1304.2 558.8 1283.0 555.0 1266.5 C 551.2 1250.0 547.5 1238.8 539.0 1218.5 C 530.5 1198.2 513.0 1164.7 504.0 1144.5 C 495.0 1124.3 490.2 1111.7 485.0 1097.5 C 479.8 1083.3 476.7 1074.2 473.0 1059.5 C 469.3 1044.8 465.2 1022.8 463.0 1009.5 C 460.8 996.2 460.2 998.7 460.0 979.5 C 459.8 960.3 459.8 917.2 462.0 894.5 C 464.2 871.8 469.2 857.5 473.0 843.5 C 476.8 829.5 481.0 819.8 485.0 810.5 C 489.0 801.2 500.2 786.3 497.0 787.5 C 501.0 779.8 499.4 784.2 487.5 791.0 C 475.6 797.8 438.5 821.8 425.5 828.0 C 412.5 834.2 409.8 832.3 409.5 828.0 C 404.2 828.0 426.5 800.7 408.5 815.0 C 408.2 810.7 371.4 850.9 354.5 858.0 C 337.6 865.1 306.8 863.0 307.0 857.5 C 291.2 857.3 299.1 849.4 307.5 841.0 C 315.9 832.6 338.1 819.2 357.5 807.0 C 376.9 794.8 425.8 767.7 424.0 767.5 C 446.2 754.3 421.9 765.4 418.5 767.0 C 415.1 768.6 411.0 773.2 403.5 777.0 C 396.0 780.8 386.0 786.0 373.5 790.0 C 361.0 794.0 339.3 799.2 328.5 801.0 C 317.7 802.8 308.7 806.8 308.5 801.0 C 301.8 801.0 304.8 784.3 308.0 783.5 C 307.8 777.7 312.6 783.4 317.5 781.0 C 322.4 778.6 330.9 774.1 337.5 769.0 C 344.1 763.9 349.9 758.8 357.0 750.5 C 364.1 742.2 372.7 731.5 380.0 719.5 C 387.3 707.5 395.2 692.2 401.0 678.5 C 406.8 664.8 411.2 651.7 415.0 637.5 C 418.8 623.3 421.3 616.7 424.0 593.5 C 426.7 570.3 429.0 519.5 431.0 498.5 C 433.0 477.5 434.0 476.7 436.0 467.5 C 438.0 458.3 440.2 451.0 443.0 443.5 C 445.8 436.0 449.0 429.3 453.0 422.5 C 457.0 415.7 460.1 409.9 467.0 402.5 C 473.9 395.1 485.1 384.1 494.5 378.0 C 503.9 371.9 513.0 368.2 523.5 366.0 C 534.0 363.8 557.3 367.5 557.5 365.0 C 568.8 364.7 557.1 358.9 558.0 357.5 C 558.9 356.1 564.8 359.3 563.0 356.5 C 564.7 356.2 560.2 350.4 557.5 348.0 C 554.8 345.6 550.5 342.0 546.5 342.0 C 542.5 342.0 536.9 345.8 533.5 348.0 C 530.1 350.2 528.0 352.7 526.0 355.5 C 524.0 358.3 525.2 363.5 521.5 365.0 C 517.8 366.5 504.3 375.2 504.0 364.5 C 498.2 364.3 502.2 340.8 503.0 332.5 C 503.8 324.2 505.8 319.9 509.0 314.5 C 512.2 309.1 519.8 297.7 522.5 300.0 C 527.0 295.2 526.3 306.7 530.5 307.0 C 534.7 307.3 544.6 304.8 547.5 302.0 C 550.4 299.2 547.5 289.3 548.0 290.5 Z M 570.5 381.0 C 566.3 377.5 573.2 383.8 569.5 385.0 C 565.8 386.2 556.5 384.5 548.5 388.0 C 540.5 391.5 529.2 399.4 521.5 406.0 C 513.8 412.6 508.1 418.9 502.0 427.5 C 495.9 436.1 490.0 445.3 485.0 457.5 C 480.0 469.7 475.0 484.5 472.0 500.5 C 469.0 516.5 461.2 561.7 467.0 553.5 C 465.3 571.2 478.8 533.0 484.5 529.0 C 490.2 525.0 501.0 523.5 501.0 529.5 C 506.5 529.7 505.5 536.3 501.0 547.5 C 496.5 558.7 481.0 585.2 474.0 596.5 C 467.0 607.8 462.2 608.7 459.0 615.5 C 455.8 622.3 457.8 627.5 455.0 637.5 C 452.2 647.5 449.2 659.8 442.0 675.5 C 434.8 691.2 400.5 741.0 411.5 732.0 C 401.3 750.8 427.1 721.9 444.5 705.0 C 461.9 688.1 497.1 652.1 516.0 630.5 C 534.9 608.9 546.8 592.2 558.0 575.5 C 569.2 558.8 575.8 547.0 583.0 530.5 C 590.2 514.0 597.5 489.3 601.0 476.5 C 604.5 463.7 603.7 459.7 604.0 453.5 C 604.3 447.3 603.7 444.3 603.0 439.5 C 602.3 434.7 601.8 430.3 600.0 424.5 C 598.2 418.7 594.8 410.0 592.0 404.5 C 589.2 399.0 586.6 395.4 583.0 391.5 C 579.4 387.6 570.8 379.7 570.5 381.0 Z M 571.0 410.5 C 571.0 404.2 586.0 401.5 588.0 410.5 C 593.7 410.5 593.3 425.2 594.0 437.5 C 594.7 449.8 594.8 469.0 592.0 484.5 C 589.2 500.0 583.7 515.5 577.0 530.5 C 570.3 545.5 562.7 559.2 552.0 574.5 C 541.3 589.8 526.6 607.8 513.0 622.5 C 499.4 637.2 480.2 656.2 470.5 663.0 C 460.8 669.8 454.3 669.2 454.5 663.0 C 449.2 663.0 446.4 658.6 455.0 644.5 C 463.6 630.4 490.8 600.7 506.0 578.5 C 521.2 556.3 537.0 528.2 546.0 511.5 C 555.0 494.8 556.5 488.0 560.0 478.5 C 563.5 469.0 565.2 462.7 567.0 454.5 C 568.8 446.3 570.3 436.8 571.0 429.5 C 571.7 422.2 565.3 410.5 571.0 410.5 Z M 633.0 663.5 C 633.2 658.7 646.3 661.8 649.5 663.0 C 652.7 664.2 650.4 668.9 652.0 670.5 C 653.6 672.1 657.5 671.3 659.0 672.5 C 660.5 673.7 660.8 673.7 661.0 677.5 C 661.2 681.3 657.0 695.2 660.0 695.5 C 659.7 701.5 669.0 691.2 669.0 696.5 C 672.0 696.8 674.5 712.3 669.0 712.5 C 669.0 717.8 652.7 718.5 652.5 713.0 C 647.0 713.2 655.5 696.7 652.0 696.5 C 651.8 691.0 641.7 699.8 641.5 696.0 C 638.0 695.8 642.5 684.7 641.0 684.5 C 640.8 680.7 635.7 682.5 636.5 684.0 C 635.0 683.8 638.8 684.7 639.0 688.5 C 639.2 692.3 641.2 701.9 637.5 707.0 C 633.8 712.1 622.7 717.0 616.5 719.0 C 610.3 721.0 601.0 724.8 600.5 719.0 C 595.2 719.0 600.1 705.4 599.0 701.5 C 597.9 697.6 594.8 699.3 594.0 695.5 C 593.2 691.7 591.2 682.9 594.0 678.5 C 596.8 674.1 604.9 670.6 610.5 669.0 C 616.1 667.4 623.8 667.5 627.5 669.0 C 631.2 670.5 632.3 682.8 632.5 678.0 C 634.2 681.0 627.5 663.7 633.0 663.5 Z M 550.0 925.5 C 552.0 913.2 565.3 901.8 567.0 925.5 C 572.7 925.5 569.0 974.3 572.0 996.5 C 575.0 1018.7 581.8 1044.5 585.0 1058.5 C 588.2 1072.5 587.5 1070.5 591.0 1080.5 C 594.5 1090.5 600.0 1105.2 606.0 1118.5 C 612.0 1131.8 618.7 1145.2 627.0 1160.5 C 635.3 1175.8 644.7 1193.2 656.0 1210.5 C 667.3 1227.8 679.4 1245.6 695.0 1264.5 C 710.6 1283.4 733.8 1308.8 749.5 1324.0 C 765.2 1339.2 782.5 1347.5 789.0 1355.5 C 795.5 1363.5 794.2 1372.0 788.5 1372.0 C 788.3 1377.5 776.8 1373.3 771.5 1372.0 C 766.2 1370.7 765.3 1369.5 756.5 1364.0 C 747.7 1358.5 730.0 1347.5 718.5 1339.0 C 707.0 1330.5 697.6 1322.2 687.5 1313.0 C 677.4 1303.8 667.2 1293.6 658.0 1283.5 C 648.8 1273.4 643.5 1268.5 632.0 1252.5 C 620.5 1236.5 600.7 1208.7 589.0 1187.5 C 577.3 1166.3 569.2 1146.3 562.0 1125.5 C 554.8 1104.7 549.3 1083.3 546.0 1062.5 C 542.7 1041.7 542.3 1017.2 542.0 1000.5 C 541.7 983.8 542.7 975.0 544.0 962.5 C 545.3 950.0 544.3 925.5 550.0 925.5 Z" fill="#1A8B3A" fill-rule="evenodd"/>
<path d="M 687.0 17.5 C 692.0 11.7 704.0 7.5 704.0 17.5 C 709.7 17.5 704.7 38.2 704.0 47.5 C 703.3 56.8 702.0 65.3 700.0 73.5 C 698.0 81.7 694.5 90.7 692.0 96.5 C 689.5 102.3 679.3 107.8 685.0 108.5 C 682.7 112.5 702.3 101.8 702.0 110.5 C 707.7 111.2 702.8 126.8 701.0 136.5 C 699.2 146.2 694.7 160.2 691.0 168.5 C 687.3 176.8 684.2 180.8 679.0 186.5 C 673.8 192.2 665.1 199.1 659.5 203.0 C 653.9 206.9 652.3 207.5 645.5 210.0 C 638.7 212.5 624.7 215.7 618.5 218.0 C 612.3 220.3 613.1 223.1 608.5 224.0 C 603.9 224.9 591.0 229.2 591.0 223.5 C 585.2 223.3 588.4 211.8 591.0 206.5 C 593.6 201.2 597.4 199.1 606.5 192.0 C 615.6 184.9 636.1 171.4 645.5 164.0 C 654.9 156.6 657.6 153.8 663.0 147.5 C 668.4 141.2 674.8 132.1 678.0 126.5 C 681.2 120.9 691.8 102.7 682.5 114.0 C 684.0 109.8 669.8 134.0 654.5 148.0 C 639.2 162.0 606.1 184.6 590.5 198.0 C 574.9 211.4 567.8 220.2 561.0 228.5 C 554.2 236.8 552.8 241.3 550.0 247.5 C 547.2 253.7 545.0 260.3 544.0 265.5 C 543.0 270.7 543.3 274.7 544.0 278.5 C 544.7 282.3 547.3 283.8 548.0 288.5 C 548.7 293.2 553.8 306.3 548.0 306.5 C 548.0 312.5 535.7 310.0 530.5 307.0 C 525.3 304.0 520.1 295.1 517.0 288.5 C 513.9 281.9 512.7 277.3 512.0 267.5 C 511.3 257.7 511.2 240.3 513.0 229.5 C 514.8 218.7 518.5 211.0 523.0 202.5 C 527.5 194.0 534.1 185.6 540.0 178.5 C 545.9 171.4 544.4 171.4 558.5 160.0 C 572.6 148.6 609.2 122.4 624.5 110.0 C 639.8 97.6 641.8 95.1 650.0 85.5 C 658.2 75.9 667.8 63.8 674.0 52.5 C 680.2 41.2 682.0 23.3 687.0 17.5 Z M 596.0 777.5 C 600.0 758.8 626.0 770.8 626.0 777.5 C 636.0 777.5 627.3 784.8 626.0 797.5 C 624.7 810.2 619.7 835.8 618.0 853.5 C 616.3 871.2 615.7 887.2 616.0 903.5 C 616.3 919.8 617.8 936.2 620.0 951.5 C 622.2 966.8 625.8 983.3 629.0 995.5 C 632.2 1007.7 634.3 1013.8 639.0 1024.5 C 643.7 1035.2 650.7 1049.2 657.0 1059.5 C 663.3 1069.8 669.2 1078.2 677.0 1086.5 C 684.8 1094.8 699.6 1102.9 704.0 1109.5 C 708.4 1116.1 708.8 1126.0 703.5 1126.0 C 703.3 1131.5 691.8 1126.7 687.5 1126.0 C 683.2 1125.3 681.2 1123.7 677.5 1122.0 C 673.8 1120.3 672.0 1120.3 665.5 1116.0 C 659.0 1111.7 647.8 1105.4 638.5 1096.0 C 629.2 1086.6 618.1 1073.2 610.0 1059.5 C 601.9 1045.8 595.0 1030.2 590.0 1013.5 C 585.0 996.8 581.8 981.3 580.0 959.5 C 578.2 937.7 578.3 903.5 579.0 882.5 C 579.7 861.5 581.2 851.0 584.0 833.5 C 586.8 816.0 586.0 777.5 596.0 777.5 Z" fill="#D42222" fill-rule="evenodd"/>
<path d="M 628 717 Q 628 669 583 660" fill="none" stroke="#D42222" stroke-width="15" stroke-linecap="round"/>
<path d="M 603 737 Q 603 688 558 680" fill="none" stroke="#D42222" stroke-width="15" stroke-linecap="round"/>
<path d="M 577 757 Q 578 708 533 700" fill="none" stroke="#D42222" stroke-width="15" stroke-linecap="round"/>
<path d="M 552 776 Q 552 728 508 720" fill="none" stroke="#D42222" stroke-width="15" stroke-linecap="round"/>
<line x1="701" y1="645" x2="669" y2="604" stroke="#FAFAF8" stroke-width="9" stroke-linecap="round"/></g>`;
  function tileSuo(n) {
    if (n === 1) return tileBody() + BIRD_ART;
    const { prim, P } = caneSetup(n);
    return tileBody() + renderSpec(BAMBOO_SPECS[n], prim, caneBeads, P, caneSlit);
  }
  function fIndexNum(n, color) {
    return `<text x="12" y="20" font-family="Helvetica,Arial" font-weight="bold" font-size="17" fill="${PAL[color]}">${n}</text>`;
  }
  function fBloom(cx, cy, r, k, color, ctr) {
    const parts = [];
    for (let i = 0; i < k; i++) {
      const a = i * (360 / k) - 90, rad = a * Math.PI / 180;
      const px = cx + Math.cos(rad) * r * 0.62, py = cy + Math.sin(rad) * r * 0.62;
      parts.push(`<ellipse cx="${fx(px)}" cy="${fx(py)}" rx="${fx(r * 0.42)}" ry="${fx(r * 0.3)}" fill="${PAL[color]}" transform="rotate(${a} ${fx(px)} ${fx(py)})"/>`);
    }
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${fx(r * 0.2)}" fill="${PAL[ctr]}"/>`);
    return parts.join("");
  }
  function fStroke(x1, y1, qx, qy, x2, y2, color, w) {
    return `<path d="M ${x1} ${y1} Q ${qx} ${qy} ${x2} ${y2}" fill="none" stroke="${PAL[color]}" stroke-width="${w}" stroke-linecap="round"/>`;
  }
  function fBlade(cx, cy, len, ang, color) {
    return `<ellipse cx="${cx}" cy="${cy}" rx="${fx(len / 2)}" ry="${fx(len * 0.13)}" fill="${PAL[color]}" transform="rotate(${ang} ${cx} ${cy})"/>`;
  }
  function fMum(cx, cy, r) {
    let parts = "";
    for (let i = 0; i < 12; i++) {
      const a = i * 30, rad = a * Math.PI / 180;
      const px = cx + Math.cos(rad) * r * 0.72, py = cy + Math.sin(rad) * r * 0.72;
      parts += `<ellipse cx="${fx(px)}" cy="${fx(py)}" rx="${fx(r * 0.34)}" ry="${fx(r * 0.14)}" fill="${PAL.red}" transform="rotate(${a} ${fx(px)} ${fx(py)})"/>`;
    }
    for (let i = 0; i < 8; i++) {
      const a = i * 45 + 22.5, rad = a * Math.PI / 180;
      const px = cx + Math.cos(rad) * r * 0.4, py = cy + Math.sin(rad) * r * 0.4;
      parts += `<ellipse cx="${fx(px)}" cy="${fx(py)}" rx="${fx(r * 0.26)}" ry="${fx(r * 0.12)}" fill="${PAL.blue}" transform="rotate(${a} ${fx(px)} ${fx(py)})"/>`;
    }
    parts += `<circle cx="${cx}" cy="${cy}" r="${fx(r * 0.16)}" fill="${PAL.green}"/>`;
    return parts;
  }
  function fStalk(cx, cy, h) {
    const w2 = h * 0.16;
    return `<line x1="${cx}" y1="${cy - h / 2}" x2="${cx}" y2="${cy + h / 2}" stroke="${PAL.green}" stroke-width="${fx(w2)}" stroke-linecap="round"/><line x1="${fx(cx - w2 * 0.8)}" y1="${cy}" x2="${fx(cx + w2 * 0.8)}" y2="${cy}" stroke="${PAL.face}" stroke-width="${fx(w2 * 0.32)}"/>`;
  }
  var FLOWER_ARTS = [
    () => fIndexNum(1, "red") + glyph({ ch: "\u6885", cx: 82, cy: 18, size: 24, color: "green" }) + fStroke(22, 122, 40, 84, 46, 44, "blue", 5) + fStroke(42, 68, 58, 62, 72, 68, "blue", 4) + fBlade(36, 78, 16, -55, "green") + fBlade(58, 92, 14, 30, "green") + fBloom(50, 40, 13, 5, "red", "blue") + fBloom(76, 72, 11, 5, "red", "green") + fBloom(30, 96, 10, 5, "red", "blue"),
    () => fIndexNum(2, "red") + glyph({ ch: "\u862D", cx: 82, cy: 18, size: 24, color: "green" }) + `<ellipse cx="44" cy="126" rx="16" ry="8" fill="${PAL.blue}"/><ellipse cx="60" cy="130" rx="11" ry="6" fill="${PAL.blue}"/>` + fStroke(48, 122, 30, 84, 22, 46, "green", 4) + fStroke(50, 122, 52, 80, 66, 42, "green", 4) + fStroke(52, 122, 74, 96, 86, 78, "green", 3.5) + fStroke(46, 122, 40, 100, 30, 92, "green", 3) + fBloom(24, 42, 11, 3, "red", "blue") + fBloom(68, 38, 10, 3, "blue", "red") + fBloom(86, 72, 8, 3, "red", "blue"),
    () => fIndexNum(3, "red") + glyph({ ch: "\u7AF9", cx: 82, cy: 18, size: 24, color: "green" }) + fStalk(38, 88, 68) + fStalk(60, 96, 52) + fBlade(30, 48, 26, -35, "blue") + fBlade(48, 42, 26, 15, "green") + fBlade(40, 36, 24, -8, "green") + fBlade(66, 62, 22, -25, "blue") + fBlade(74, 70, 20, 20, "green"),
    () => fIndexNum(4, "red") + glyph({ ch: "\u83CA", cx: 82, cy: 18, size: 24, color: "green" }) + fStroke(52, 128, 50, 104, 52, 84, "green", 4.5) + fBlade(38, 104, 22, 35, "green") + fBlade(66, 112, 22, -30, "blue") + fMum(52, 60, 22)
  ];
  var SEASON_ARTS = [
    () => fIndexNum(1, "blue") + glyph({ ch: "\u6625", cx: 80, cy: 19, size: 26, color: "green" }) + fStroke(50, 130, 44, 100, 36, 66, "green", 4.5) + fStroke(52, 130, 60, 98, 70, 74, "green", 4) + fBlade(30, 92, 22, -60, "green") + fBlade(66, 104, 20, 55, "green") + fBloom(34, 58, 10, 5, "red", "blue") + fBloom(74, 66, 9, 5, "blue", "red") + fBloom(52, 46, 8, 5, "red", "green"),
    () => {
      const petals = [[-64, 16], [-32, 19], [0, 20], [32, 19], [64, 16]].map(([a, r]) => {
        const rad = (a - 90) * Math.PI / 180;
        const px = 50 + Math.cos(rad) * r, py = 66 + Math.sin(rad) * r;
        return `<ellipse cx="${fx(px)}" cy="${fx(py)}" rx="7.5" ry="13" fill="${PAL.red}" transform="rotate(${a} ${fx(px)} ${fx(py)})"/>`;
      }).join("");
      return fIndexNum(2, "blue") + glyph({ ch: "\u590F", cx: 80, cy: 19, size: 26, color: "green" }) + petals + `<ellipse cx="50" cy="72" rx="14" ry="7" fill="${PAL.green}"/>` + fStroke(50, 100, 50, 88, 50, 78, "green", 4) + `<ellipse cx="30" cy="104" rx="17" ry="6" fill="${PAL.green}"/>` + fStroke(12, 118, 30, 110, 48, 118, "blue", 3.5) + fStroke(30, 128, 50, 120, 70, 128, "blue", 3.5) + fStroke(52, 116, 70, 108, 88, 116, "blue", 3.5);
    },
    () => fIndexNum(3, "blue") + glyph({ ch: "\u79CB", cx: 80, cy: 19, size: 26, color: "green" }) + fStroke(14, 56, 44, 48, 78, 60, "blue", 5) + fStroke(38, 51, 50, 40, 62, 36, "blue", 3.5) + fBlade(30, 82, 27, 25, "red") + fBlade(62, 92, 26, -35, "green") + fBlade(40, 110, 25, 10, "red") + fBlade(72, 122, 23, 40, "blue") + fBlade(22, 126, 21, -20, "green"),
    () => {
      const snow = (cx, cy, r) => {
        let o = "";
        for (let i = 0; i < 3; i++) {
          const a = i * 60, rad = a * Math.PI / 180;
          o += `<line x1="${fx(cx - Math.cos(rad) * r)}" y1="${fx(cy - Math.sin(rad) * r)}" x2="${fx(cx + Math.cos(rad) * r)}" y2="${fx(cy + Math.sin(rad) * r)}" stroke="${PAL.blue}" stroke-width="2.4" stroke-linecap="round"/>`;
        }
        return o;
      };
      return fIndexNum(4, "blue") + glyph({ ch: "\u51AC", cx: 80, cy: 19, size: 26, color: "green" }) + fStroke(16, 122, 40, 104, 66, 100, "green", 5) + fBlade(30, 104, 20, -50, "green") + fBlade(44, 98, 20, -70, "green") + fBlade(58, 94, 18, -55, "green") + fBlade(38, 120, 18, 55, "green") + fBloom(70, 96, 8, 5, "red", "green") + snow(30, 48, 7) + snow(58, 36, 6) + snow(78, 60, 5.5);
    }
  ];
  function tileFlower(i) {
    const fn = i < 4 ? FLOWER_ARTS[i] : SEASON_ARTS[i - 4];
    return tileBody() + fn();
  }
  function tileBack() {
    return `
 <rect x="1" y="1" width="98" height="138" rx="7" fill="#2c7a52" stroke="#1e5c3d" stroke-width="1.5"/>
 <rect x="8.5" y="8.5" width="83" height="123" rx="5" fill="#256b47" stroke="#4aa878" stroke-width="1.3"/>
 <g stroke="#4aa878" stroke-width="1.3" fill="none" opacity=".9">
  <path d="M50 44 L70 70 L50 96 L30 70 Z"/><path d="M50 58 L60 70 L50 82 L40 70 Z"/></g>`;
  }
  function labelOverlay(id) {
    const t = id < 27 ? String(id % 9 + 1) : id < 31 ? "ESWN"[id - 27] : "CFB"[id - 31];
    const f = `font-family="Inter,system-ui,sans-serif" font-weight="700" fill="#33333c" stroke="#FAFAF8" stroke-width="3.4" stroke-linejoin="round" paint-order="stroke"`;
    return `<text x="10" y="22" font-size="19" text-anchor="start" ${f}>${t}</text>`;
  }
  function tileArt(id, opts = {}) {
    if (id === "back") return tileBack();
    if (typeof id === "object") return tileFlower(id.flower);
    let a;
    if (id < 9) a = tileWan(id + 1);
    else if (id < 18) a = tileSuo(id - 8);
    else if (id < 27) a = tileTong(id - 17);
    else if (id < 31) a = tileWind(id - 27);
    else if (id < 34) a = tileDragon(id - 31);
    else return tileFlower(id - 34);
    return a + (opts.labels ? labelOverlay(id) : "");
  }
  function tileSVG(id, opts = {}) {
    return `<svg viewBox="0 0 100 140">${tileArt(id, opts)}</svg>`;
  }
  return __toCommonJS(render_exports);
})();

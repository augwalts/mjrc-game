/**
 * `render` — turns the golden-hand suite into a sheet a mahjong player can
 * actually review. DESIGN.md §8 makes the golden suite the P0 exit requirement
 * and says its answers must be "validated by strong HK players". The fixtures
 * are TypeScript arrays of integers, so as authored the gate cannot be passed
 * by anyone who does not read the repo. This emits one self-contained HTML
 * file instead: real tiles, plain-language context, and a mark-up box per case.
 *
 *   node tools/validation/render.ts [--out <path>]
 *
 * See ./README.md for the review protocol — what the reviewer is being asked
 * and what to do with the marked-up result.
 *
 * ── nothing is judged here ───────────────────────────────────────────────
 *
 * This file renders fixtures; it never decides a ruling. The one number it
 * computes is the sum of each case's own award list priced from the ruleset
 * the case names (rulesets/src/presets.ts) and capped at that ruleset's limit
 * 爆棚 — shown beside `expected.faan` so a reviewer can see the arithmetic
 * rather than take it on trust. Where the two disagree the case is FLAGGED,
 * not corrected.
 *
 * ── determinism (DESIGN.md §5.5) ─────────────────────────────────────────
 *
 * No clock, no randomness, no unordered iteration: the same fixtures produce a
 * byte-identical file, so regenerating never churns a diff. That is also why
 * there is no "generated at" line in the output.
 *
 * ── dependency-free, and the one piece of Node machinery ─────────────────
 *
 * No packages beyond the workspace. The golden families and engine/src are
 * TypeScript, and Node strips types from a `.ts` file it is handed but does
 * NOT rewrite a `.js` specifier to the `.ts` file beside it — which every
 * relative import in this repo is, by house style. `registerHooks` below adds
 * that one rewrite, and only when the `.js` genuinely does not exist. Needs
 * Node 22.18+ (type stripping on by default; `registerHooks` from 22.15).
 *
 * Terminology: ../../TERMINOLOGY.md. Hong Kong Old Style only.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { Meld, SeatIndex, TileId, WindIndex } from "../../engine/src/types.js";
import type { GoldenCase } from "../../engine/test/golden/case.js";

/* ── resolve "./x.js" to "./x.ts" when only the TypeScript file is on disk ── */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const asWritten = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(asWritten))) {
        const asTypeScript = `${specifier.slice(0, -3)}.ts`;
        if (existsSync(fileURLToPath(new URL(asTypeScript, context.parentURL)))) {
          return nextResolve(asTypeScript, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

/* ── the fixtures, and the data that explains them ─────────────────────────
 * Dynamic so they load after the hook above is registered. Static imports are
 * resolved before this module's body runs, which is too early.               */

const { TILE_NAMES, WIND_NAMES, isFlower, suitOf } =
  await import("../../engine/src/tiles.js");
const { assertWellFormed } = await import("../../engine/test/golden/case.js");
const { isPattern, pattern, ruleset } = await import("@mjrc/rulesets");

const basic = await import("../../engine/test/golden/basic.js");
const flush = await import("../../engine/test/golden/flush.js");
const honours = await import("../../engine/test/golden/honours.js");
const kongs = await import("../../engine/test/golden/kongs.js");
const limit = await import("../../engine/test/golden/limit.js");

/**
 * `limit.ts` widens GoldenCase with four fields the shared contract cannot
 * express (its own header explains why). They are optional here so one
 * renderer covers every family without the families having to agree.
 */
interface ReviewCase extends GoldenCase {
  /** Uncapped sum of the award list, before 爆棚. */
  rawFaan?: number;
  capped?: boolean;
  /** 天糊 dealt complete · 地糊 won on the dealer's opening discard. */
  opening?: "heavenly" | "earthly";
  /** 河底撈魚 — won on the very last discard rather than the last draw. */
  onLastDiscard?: boolean;
}

interface Family {
  key: string;
  characters: string;
  title: string;
  /** One paragraph: what a reviewer should be looking for in this family. */
  brief: string;
  cases: readonly ReviewCase[];
}

const FAMILIES: readonly Family[] = [
  {
    key: "basic",
    characters: "基本",
    title: "Basic patterns and the 3-faan floor",
    brief:
      "平糊 · 對對糊 · the flush pair · 門前清, and the point of the family — 雞糊 chicken " +
      "hands: complete fourteen-tile shapes that score under 3 faan and therefore MAY NOT BE " +
      "TAKEN. Several pairs of cases are the same fourteen tiles won in different ways.",
    cases: basic.cases,
  },
  {
    key: "flush",
    characters: "一色",
    title: "Half flush, full flush and the purity limit hands",
    brief:
      "混一色 and 清一色 in all three suits, concealed and melded; 字一色 and 清么九; and the " +
      "boundaries that decide between them — one honour tile away from a full flush, the same " +
      "four melds where only the eyes decide half against full, and a hand whose best " +
      "decomposition is not its obvious one.",
    cases: flush.cases,
  },
  {
    key: "honours",
    characters: "字花",
    title: "Winds, dragons, dealer and bonus tiles",
    brief:
      "門風 and 圈風, including the doubled wind where a seat sits in its own round; 三元牌 and " +
      "the 小三元 / 大三元 pair; 小四喜 / 大四喜; and 花 — own flower, other seats' flowers, a " +
      "full set of four, and 無花. Nothing in the Python reference engine can check any of this.",
    cases: honours.cases,
  },
  {
    key: "kongs",
    characters: "槓",
    title: "All three kong forms and their replacement draws",
    brief:
      "明槓 exposed, 暗槓 concealed and 加槓 added, plus what the added kong opens: 搶槓. Also " +
      "槓上開花 on a replacement tile, 十八羅漢, and 四暗刻 — where houses split on whether " +
      "concealed kongs count toward it.",
    cases: kongs.cases,
  },
  {
    key: "limit",
    characters: "爆棚",
    title: "Limit hands and situational faan",
    brief:
      "The cap is the point. Every case records the uncapped total beside the paid one, and " +
      "the crossings are varied on purpose — two limit patterns stacking, a limit pattern plus " +
      "nothing but situational faan, and the same fourteen tiles under two presets where only " +
      "one of them caps. Three cases land exactly on 13 and are NOT capped.",
    cases: limit.cases,
  },
];

/* ── small helpers ─────────────────────────────────────────────────────── */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** 東 (seat 0). Seat index and wind index are the same thing in these fixtures. */
const seatLabel = (w: WindIndex | SeatIndex): string =>
  `${WIND_NAMES[w as WindIndex]} <span class="muted">(seat ${w})</span>`;

/**
 * Where a claimed tile came from, relative to the winner. Turn order is
 * 東→南→西→北, so the seat playing immediately before you is (seat + 3) % 4 —
 * 上家, on your left, and the only seat a 上 chow may be claimed from.
 */
function relativeSeat(from: SeatIndex, seat: SeatIndex): string {
  const offset = (from - seat + 4) % 4;
  if (offset === 0) return "your own hand";
  if (offset === 1) return "下家 the seat after you, on your right";
  if (offset === 2) return "對家 the seat across from you";
  return "上家 the seat before you, on your left";
}

/* ── tiles ─────────────────────────────────────────────────────────────── */

/**
 * One tile face. TILE_NAMES is the only source of tile identity here — a
 * suited name is rank + suit character ("1萬"), an honour or flower is the
 * character alone, so the split is positional and nothing is transcribed.
 */
function tileFace(t: TileId, extra = ""): string {
  const name = TILE_NAMES[t];
  const rank = name.length > 1 ? name.slice(0, -1) : "";
  const glyph = name.slice(-1);
  const kind = isFlower(t) ? "flower" : suitOf(t);
  const classes = `tile tile-${kind}${extra ? ` ${extra}` : ""}`;
  const rankHtml = rank ? `<b>${esc(rank)}</b>` : "";
  return `<span class="${classes}" title="${esc(name)}">${rankHtml}<i>${esc(glyph)}</i></span>`;
}

const tileRow = (tiles: readonly TileId[], extra = ""): string =>
  tiles.map((t) => tileFace(t, extra)).join("");

/** Ascending, split wherever the suit changes, so a long hand reads at a glance. */
function groupedBySuit(tiles: readonly TileId[]): TileId[][] {
  const groups: TileId[][] = [];
  for (const t of [...tiles].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && suitOf(last[0]) === suitOf(t)) last.push(t);
    else groups.push([t]);
  }
  return groups;
}

/* ── melds ─────────────────────────────────────────────────────────────── */

interface MeldLabel {
  characters: string;
  english: string;
  /** "exposed" or "concealed" — the distinction the reviewer is checking. */
  exposure: string;
  provenance: string;
}

function meldLabel(meld: Meld, seat: SeatIndex): MeldLabel {
  const source = relativeSeat(meld.from, seat);
  if (meld.kind === "chow") {
    return {
      characters: "上",
      english: "Chow",
      exposure: "exposed",
      provenance: `claimed from ${source}`,
    };
  }
  if (meld.kind === "pung") {
    return {
      characters: "碰",
      english: "Pung",
      exposure: "exposed",
      provenance: `claimed from ${source}`,
    };
  }
  if (meld.concealed) {
    return {
      characters: "暗槓",
      english: "Concealed Kong",
      exposure: "concealed",
      provenance: "all four drawn — nothing was claimed",
    };
  }
  if (meld.addedToPung) {
    return {
      characters: "加槓",
      english: "Added Kong",
      exposure: "exposed",
      provenance:
        `the 碰 pung was claimed from ${source}; the fourth tile was added from hand, ` +
        "which opens the 搶槓 rob-the-kong window",
    };
  }
  return {
    characters: "明槓",
    english: "Exposed Kong",
    exposure: "exposed",
    provenance: `claimed from ${source}`,
  };
}

function meldBlock(meld: Meld, seat: SeatIndex): string {
  const label = meldLabel(meld, seat);
  const faces =
    meld.kind === "kong" && meld.concealed
      // 暗槓 sits face down but for the two ends. Rendered whole, marked instead.
      ? tileRow(meld.tiles, "face-down")
      : tileRow(meld.tiles);
  return `
        <div class="meld meld-${label.exposure}">
          <div class="meld-tiles">${faces}</div>
          <div class="meld-caption">
            <span class="meld-name">${esc(label.characters)}</span>
            <span class="meld-en">${esc(label.english)}</span>
            <span class="pill pill-${label.exposure}">${esc(label.exposure)}</span>
            <span class="meld-from">${label.provenance}</span>
          </div>
        </div>`;
}

/* ── the situation, stated plainly ─────────────────────────────────────── */

function contextRows(c: ReviewCase): string {
  const rows: [string, string][] = [];

  rows.push(["門風 seat wind", seatLabel(c.seatWind)]);
  rows.push(["圈風 round wind", seatLabel(c.roundWind)]);
  rows.push([
    "莊 / 閒 dealer",
    c.isDealer
      ? "莊家 <strong>dealer</strong>"
      : "閒家 <strong>not the dealer</strong>",
  ]);
  rows.push([
    "how it was won",
    c.selfDraw
      ? "自摸 <strong>self-draw</strong> — the winner drew the tile"
      : "食糊 <strong>won on a discard</strong> — another seat threw the tile",
  ]);

  const situational: string[] = [];
  if (c.opening === "heavenly") {
    situational.push("天糊 — the dealer's dealt fourteen tiles were already complete");
  }
  if (c.opening === "earthly") {
    situational.push("地糊 — won on the dealer's very first discard");
  }
  if (c.robbedKong) {
    situational.push("搶槓 — won on the tile a seat was adding to an exposed pung");
  }
  if (c.onKongReplacement) {
    situational.push("槓上開花 — won on the replacement drawn after a kong");
  }
  if (c.onLastTile) {
    situational.push("海底撈月 — won on the last tile drawn from the wall");
  }
  if (c.onLastDiscard) {
    situational.push("河底撈魚 — won on the very last discard of the hand");
  }
  if (situational.length > 0) {
    rows.push([
      "situational",
      situational.map((s) => `<div class="situational">${esc(s)}</div>`).join(""),
    ]);
  }

  const r = ruleset(c.ruleset);
  rows.push([
    "ruleset",
    `${esc(r ? r.label : c.ruleset)} <span class="muted">(${esc(c.ruleset)})</span>`,
  ]);

  return rows
    .map(([k, v]) => `
          <div class="ctx-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
    .join("");
}

/* ── the expected answer ───────────────────────────────────────────────── */

interface PricedAward {
  id: string;
  characters: string;
  english: string;
  jyutping: string;
  count: number;
  each: number | null;
  subtotal: number;
  problem: string;
}

/**
 * Price the case's own award list from the ruleset the case names, preserving
 * multiplicity and first-appearance order (two dragon pungs are two awards,
 * not one). `null` for `each` means the named ruleset does not play the
 * pattern at all, which is a finding rather than a zero.
 */
function priceAwards(c: ReviewCase): { awards: PricedAward[]; total: number; capped: boolean } {
  const r = ruleset(c.ruleset);
  const table = r ? r.faanTable : {};
  const order: string[] = [];
  const seen = new Map<string, number>();
  for (const id of c.expected.awards) {
    if (!seen.has(id)) order.push(id);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }

  let total = 0;
  const awards = order.map((id): PricedAward => {
    const count = seen.get(id) ?? 0;
    const known = isPattern(id);
    const def = known ? pattern(id) : null;
    const each = known && id in table ? table[id] : null;
    const subtotal = each === null ? 0 : each * count;
    total += subtotal;
    let problem = "";
    if (!known) problem = "not in the pattern catalogue";
    else if (each === null) problem = `${c.ruleset} does not price this pattern`;
    return {
      id,
      characters: def ? def.characters : "？",
      english: def ? def.label : id,
      jyutping: def ? def.jyutping : "",
      count,
      each,
      subtotal,
      problem,
    };
  });

  const cap = r ? r.limitFaan : 13;
  return { awards, total, capped: total > cap };
}

/* ── per-case flags a reviewer should see before they read anything ────── */

function flagsFor(c: ReviewCase): string[] {
  const flags: string[] = [];
  const r = ruleset(c.ruleset);
  const priced = priceAwards(c);
  const paid = Math.min(priced.total, r ? r.limitFaan : 13);

  try {
    assertWellFormed(c);
  } catch (err) {
    flags.push(`fixture is malformed: ${(err as Error).message}`);
  }
  for (const a of priced.awards) {
    if (a.problem) flags.push(`award "${a.id}" — ${a.problem}`);
  }
  if (paid !== c.expected.faan) {
    flags.push(
      `the award list prices to ${paid} faan under ${c.ruleset}, but the case expects ` +
        `${c.expected.faan}`,
    );
  }
  if (c.expected.legal !== (c.expected.faan >= (r ? r.minimumFaan : 3))) {
    flags.push(
      `legal is ${c.expected.legal} at ${c.expected.faan} faan against a ` +
        `${r ? r.minimumFaan : 3}-faan minimum`,
    );
  }
  if (c.rawFaan !== undefined && c.rawFaan !== priced.total) {
    flags.push(`the case states rawFaan ${c.rawFaan}; its award list sums to ${priced.total}`);
  }
  return flags;
}

/* ── one case ──────────────────────────────────────────────────────────── */

function renderCase(c: ReviewCase, family: Family, index: number): string {
  const seat = c.seatWind as unknown as SeatIndex;
  const priced = priceAwards(c);
  const r = ruleset(c.ruleset);
  const cap = r ? r.limitFaan : 13;
  const flags = flagsFor(c);

  const badges: string[] = [];
  if (c.contested) badges.push(`<span class="badge badge-contested">contested 有爭議</span>`);
  if (!c.expected.legal) badges.push(`<span class="badge badge-refused">refused 唔夠糊</span>`);
  if (priced.capped) badges.push(`<span class="badge badge-capped">capped 爆棚</span>`);
  if (c.ruleset !== "hkos-standard") {
    badges.push(`<span class="badge badge-ruleset">${esc(c.ruleset)}</span>`);
  }
  if (flags.length > 0) badges.push(`<span class="badge badge-flag">check the arithmetic</span>`);

  const concealedGroups = groupedBySuit(c.concealed)
    .map((g) => `<span class="suit-group">${tileRow(g)}</span>`)
    .join("");

  const melds =
    c.melds.length > 0
      ? c.melds.map((m) => meldBlock(m, seat)).join("")
      : `<div class="none">none — the hand is fully concealed 門前清</div>`;

  const flowers =
    c.flowers.length > 0
      ? `<div class="flower-tiles">${tileRow(c.flowers)}</div>`
      : `<div class="none">none — 無花</div>`;

  const awardRows = priced.awards
    .map((a) => `
              <tr${a.problem ? ' class="award-problem"' : ""}>
                <th scope="row">
                  <span class="award-cn">${esc(a.characters)}</span>
                  <span class="award-en">${esc(a.english)}</span>
                  ${a.jyutping ? `<span class="award-jp">${esc(a.jyutping)}</span>` : ""}
                </th>
                <td class="num">${a.count > 1 ? `×${a.count}` : ""}</td>
                <td class="num">${a.each === null ? "—" : `${a.each} faan`}</td>
                <td class="num">${a.each === null ? "—" : a.subtotal}</td>
              </tr>`)
    .join("");

  const rawLine =
    priced.total === c.expected.faan
      ? `<div class="sum-line">總計 total <strong>${priced.total}</strong> faan</div>`
      : `<div class="sum-line">
              未封頂 uncapped <strong>${priced.total}</strong> faan
              → 爆棚 capped at ${cap}
            </div>`;

  const flagBlock =
    flags.length > 0
      ? `
          <div class="flagbox">
            <strong>Generator flags — read before you mark this case</strong>
            <ul>${flags.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
          </div>`
      : "";

  const contestedBlock = c.contested
    ? `
          <div class="contested">
            <strong>有爭議 Houses disagree</strong>
            <p>${esc(c.contested)}</p>
          </div>`
    : "";

  return `
      <article class="case" id="${esc(c.id)}" data-family="${esc(family.key)}"
               data-contested="${c.contested ? "1" : "0"}" data-marked="0">
        <header class="case-head">
          <span class="case-no">${family.characters} ${index + 1}</span>
          <h3>${esc(c.id)}</h3>
          <div class="badges">${badges.join("")}</div>
        </header>
        <p class="case-desc">${esc(c.description)}</p>

        <div class="board">
          <div class="board-main">
            <div class="board-label">手牌 concealed hand
              <span class="muted">${plural(c.concealed.length, "tile", "tiles")}</span>
            </div>
            <div class="hand">${concealedGroups}</div>

            <div class="board-label">食糊張 the winning tile</div>
            <div class="hand winning">
              ${tileFace(c.winningTile, "tile-winning")}
              <span class="winning-note">${
                c.selfDraw ? "自摸 drawn by the winner" : "食糊 thrown by another seat"
              }</span>
            </div>

            <div class="board-label">花 flowers</div>
            ${flowers}
          </div>

          <div class="board-melds">
            <div class="board-label">副露 melds
              <span class="muted">${plural(c.melds.length, "meld", "melds")}</span>
            </div>
            ${melds}
          </div>
        </div>

        <div class="lower">
          <dl class="ctx">${contextRows(c)}</dl>

          <div class="expected">
            <div class="faan-headline ${c.expected.legal ? "" : "faan-refused"}">
              <span class="faan-number">${c.expected.faan}</span>
              <span class="faan-unit">番 faan</span>
              <span class="faan-legal">${
                c.expected.legal
                  ? "可以食 — the win may be taken"
                  : `唔夠糊 — below the ${r ? r.minimumFaan : 3}-faan minimum, may NOT be taken`
              }</span>
            </div>
            <table class="awards">
              <thead>
                <tr><th scope="col">牌型 pattern</th><th scope="col"></th>
                    <th scope="col">each</th><th scope="col">total</th></tr>
              </thead>
              <tbody>${awardRows || `
              <tr><th scope="row" colspan="4">no awards — the hand scores nothing</th></tr>`}</tbody>
            </table>
            ${rawLine}
          </div>
        </div>

        ${flagBlock}
        ${contestedBlock}

        <div class="review" data-case="${esc(c.id)}">
          <div class="verdicts">
            <label><input type="radio" name="v-${esc(c.id)}" value="agree"><span>同意 <em>agree</em></span></label>
            <label><input type="radio" name="v-${esc(c.id)}" value="disagree"><span>不同意 <em>disagree</em></span></label>
            <label><input type="radio" name="v-${esc(c.id)}" value="unsure"><span>存疑 <em>unsure</em></span></label>
          </div>
          <label class="correct">
            <span>If you disagree — the correct faan / awards</span>
            <input type="text" class="correct-input" autocomplete="off">
          </label>
          <label class="note">
            <span>Why? Name the rule, and the house you play it in.</span>
            <textarea rows="2"></textarea>
          </label>
        </div>
        <div class="source">${
          c.source ? `source: ${esc(c.source)}` : "no source recorded"
        }${c.provisional ? " · <strong>provisional — unvalidated</strong>" : ""}</div>
      </article>`;
}

/* ── contents ──────────────────────────────────────────────────────────── */

function contents(): string {
  const rows = FAMILIES.map((f) => {
    const contested = f.cases.filter((c) => c.contested).length;
    const refused = f.cases.filter((c) => !c.expected.legal).length;
    const flagged = f.cases.filter((c) => flagsFor(c).length > 0).length;
    return `
            <tr>
              <th scope="row"><a href="#family-${esc(f.key)}">${esc(f.characters)} ${esc(f.key)}</a></th>
              <td>${esc(f.title)}</td>
              <td class="num">${f.cases.length}</td>
              <td class="num">${contested || "—"}</td>
              <td class="num">${refused || "—"}</td>
              <td class="num">${flagged || "—"}</td>
            </tr>`;
  }).join("");

  const all = FAMILIES.flatMap((f) => f.cases);
  return `
        <table class="contents">
          <thead>
            <tr><th scope="col">family</th><th scope="col">what it covers</th>
                <th scope="col">cases</th><th scope="col">contested</th>
                <th scope="col">refused</th><th scope="col">flagged</th></tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr><th scope="row">total</th><td></td>
                <td class="num">${all.length}</td>
                <td class="num">${all.filter((c) => c.contested).length}</td>
                <td class="num">${all.filter((c) => !c.expected.legal).length}</td>
                <td class="num">${all.filter((c) => flagsFor(c).length > 0).length}</td></tr>
          </tfoot>
        </table>`;
}

/* ── styles ────────────────────────────────────────────────────────────── */

const CSS = `
  :root {
    --ink: #16130f;
    --ink-soft: #5b5348;
    --paper: #faf7f1;
    --card: #ffffff;
    --rule: #ddd5c7;
    --rule-strong: #b6ab97;
    --accent: #7a1f1f;
    --contest: #8a5a06;
    --refuse: #7a1f1f;
    --ok: #2b5c3a;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font: 15px/1.5 ui-sans-serif, "Helvetica Neue", Helvetica, Arial,
          "PingFang HK", "Hiragino Sans", "Heiti TC", "Microsoft JhengHei",
          "Noto Sans CJK TC", sans-serif;
  }
  .wrap { max-width: 62rem; margin: 0 auto; padding: 1.5rem 1.25rem 6rem; }
  h1, h2, h3 { font-weight: 650; letter-spacing: -0.01em; }
  h1 { font-size: 1.75rem; margin: 0 0 0.25rem; }
  h2 { font-size: 1.25rem; margin: 0; }
  h3 { font-size: 0.95rem; margin: 0; font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-weight: 600; }
  a { color: var(--accent); }
  .muted { color: var(--ink-soft); font-weight: 400; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  /* ── masthead ─────────────────────────────────────────────────────── */
  .masthead { border-bottom: 3px double var(--rule-strong); padding-bottom: 1rem; margin-bottom: 1.25rem; }
  .masthead .cn { font-size: 1.1rem; color: var(--accent); letter-spacing: 0.2em; }
  .masthead p { margin: 0.5rem 0 0; max-width: 46rem; color: var(--ink-soft); }
  .ask { background: var(--card); border: 1px solid var(--rule); border-left: 4px solid var(--accent);
         padding: 0.9rem 1.1rem; margin: 1.25rem 0; border-radius: 3px; }
  .ask h2 { font-size: 1rem; margin-bottom: 0.4rem; }
  .ask ol { margin: 0.4rem 0 0; padding-left: 1.2rem; }
  .ask li { margin: 0.25rem 0; }
  .ident { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; margin: 0 0 1rem; }
  .ident label { display: flex; align-items: baseline; gap: 0.5rem; flex: 1 1 12rem; }
  .ident span { font-size: 0.75rem; color: var(--ink-soft); white-space: nowrap; }
  .ident input { flex: 1 1 auto; min-width: 6rem; font: inherit; font-size: 0.9rem;
                 padding: 0.2rem 0.3rem; background: transparent; border: none;
                 border-bottom: 1px solid var(--rule-strong); color: var(--ink); }

  /* ── contents ─────────────────────────────────────────────────────── */
  table.contents { width: 100%; border-collapse: collapse; margin: 1rem 0 2rem; font-size: 0.9rem; }
  table.contents th, table.contents td { padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--rule); text-align: left; }
  table.contents thead th { border-bottom: 2px solid var(--rule-strong); font-size: 0.75rem;
                            text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); }
  table.contents tfoot th, table.contents tfoot td { border-top: 2px solid var(--rule-strong); border-bottom: none; font-weight: 650; }
  table.contents tbody th a { text-decoration: none; font-weight: 650; }

  /* ── toolbar ──────────────────────────────────────────────────────── */
  .toolbar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 0.5rem;
             align-items: center; background: var(--paper); border-bottom: 1px solid var(--rule);
             padding: 0.5rem 0; margin-bottom: 1rem; }
  .toolbar button { font: inherit; font-size: 0.85rem; padding: 0.3rem 0.7rem; cursor: pointer;
                    background: var(--card); border: 1px solid var(--rule-strong); border-radius: 3px; color: var(--ink); }
  .toolbar button[aria-pressed="true"] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .toolbar .progress { margin-left: auto; font-size: 0.85rem; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
  .storage-warning { font-size: 0.8rem; color: var(--contest); flex-basis: 100%; }
  #export-panel { display: none; margin: 0 0 1.5rem; }
  #export-panel textarea { width: 100%; height: 14rem; font: 12px/1.45 ui-monospace, Menlo, monospace;
                           border: 1px solid var(--rule-strong); border-radius: 3px; padding: 0.6rem; }

  /* ── families ─────────────────────────────────────────────────────── */
  .family { margin: 2.5rem 0 0; scroll-margin-top: 4rem; }
  .family-head { border-top: 3px double var(--rule-strong); padding-top: 0.9rem; margin-bottom: 0.5rem; }
  .family-head .cn { color: var(--accent); font-size: 1.35rem; margin-right: 0.5rem; }
  .family-head .count { float: right; color: var(--ink-soft); font-size: 0.85rem; padding-top: 0.35rem; }
  .family-brief { color: var(--ink-soft); margin: 0.4rem 0 1.2rem; max-width: 50rem; }

  /* ── a case ───────────────────────────────────────────────────────── */
  .case { background: var(--card); border: 1px solid var(--rule); border-radius: 4px;
          padding: 0.9rem 1rem 0.75rem; margin: 0 0 1.1rem; scroll-margin-top: 4rem; }
  .case-head { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
  .case-no { font-size: 0.8rem; color: var(--accent); font-weight: 650; white-space: nowrap; }
  .case-desc { margin: 0.45rem 0 0.8rem; }
  .badges { margin-left: auto; display: flex; gap: 0.3rem; flex-wrap: wrap; }
  .badge { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 2px; border: 1px solid currentColor;
           text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
  .badge-contested { color: var(--contest); background: #fdf4e0; }
  .badge-refused { color: var(--refuse); background: #fbeceb; }
  .badge-capped { color: var(--ok); background: #ecf5ee; }
  .badge-ruleset { color: var(--ink-soft); background: #f2efe9; }
  .badge-flag { color: #fff; background: var(--refuse); border-color: var(--refuse); }

  /* ── tiles ────────────────────────────────────────────────────────── */
  .tile { display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
          width: 2.05rem; height: 2.7rem; margin: 0 1px; padding-top: 1px;
          border: 1px solid #9a9384; border-bottom-width: 3px; border-radius: 4px;
          background: #fffdf8; line-height: 1.05; vertical-align: middle; }
  .tile b { font-size: 0.78rem; font-weight: 700; }
  .tile i { font-style: normal; font-size: 1.05rem;
            font-family: "PingFang HK", "Hiragino Sans", "Heiti TC", "Microsoft JhengHei",
                         "Noto Sans CJK TC", serif; }
  .tile-chars   { color: #1d1a16; }
  .tile-bamboo  { color: #1d5b32; }
  .tile-circles { color: #1b3f72; }
  .tile-honours { color: #7a1f1f; }
  .tile-flower  { color: #6b4a12; background: #fdf7e6; }
  .tile-winning { border-color: var(--accent); border-width: 2px; border-bottom-width: 4px;
                  box-shadow: 0 0 0 2px #f3d9d9; }
  .tile.face-down { background: repeating-linear-gradient(135deg, #eee9df 0 4px, #f7f3ea 4px 8px); }

  .board { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
           gap: 1rem 1.5rem; align-items: start; }
  .board-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em;
                 color: var(--ink-soft); margin: 0.7rem 0 0.25rem; font-weight: 650; }
  .board-main .board-label:first-child { margin-top: 0; }
  .hand { display: flex; flex-wrap: wrap; align-items: center; gap: 0.15rem 0; }
  .suit-group { display: inline-flex; margin-right: 0.55rem; }
  .hand.winning { gap: 0.6rem; }
  .winning-note { font-size: 0.8rem; color: var(--ink-soft); }
  .none { font-size: 0.85rem; color: var(--ink-soft); font-style: italic; }
  .flower-tiles { display: flex; flex-wrap: wrap; }

  .meld { border: 1px solid var(--rule); border-radius: 3px; padding: 0.4rem 0.5rem; margin-bottom: 0.4rem; }
  .meld-concealed { border-style: dashed; }
  .meld-tiles { display: flex; flex-wrap: wrap; }
  .meld-caption { margin-top: 0.25rem; font-size: 0.78rem; color: var(--ink-soft); display: flex;
                  flex-wrap: wrap; align-items: baseline; gap: 0.35rem; }
  .meld-name { color: var(--ink); font-weight: 650; font-size: 0.95rem; }
  .meld-en { color: var(--ink); }
  .pill { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em;
          border: 1px solid currentColor; border-radius: 2px; padding: 0 0.3rem; }
  .pill-exposed { color: var(--accent); }
  .pill-concealed { color: var(--ok); }
  .meld-from { flex-basis: 100%; }

  /* ── context + expected ───────────────────────────────────────────── */
  .lower { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
           gap: 1rem 1.5rem; margin-top: 1rem; align-items: start; }
  dl.ctx { margin: 0; }
  .ctx-row { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); gap: 0.5rem;
             padding: 0.22rem 0; border-bottom: 1px dotted var(--rule); }
  .ctx-row dt { color: var(--ink-soft); font-size: 0.82rem; }
  .ctx-row dd { margin: 0; font-size: 0.88rem; }
  .situational { color: var(--accent); font-weight: 600; }

  .faan-headline { display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap;
                   border-bottom: 2px solid var(--rule-strong); padding-bottom: 0.35rem; }
  .faan-number { font-size: 2rem; font-weight: 700; line-height: 1; }
  .faan-unit { font-size: 0.9rem; color: var(--ink-soft); }
  .faan-legal { font-size: 0.8rem; color: var(--ok); margin-left: auto; }
  .faan-refused .faan-number { color: var(--refuse); }
  .faan-refused .faan-legal { color: var(--refuse); font-weight: 650; }

  table.awards { width: 100%; border-collapse: collapse; margin-top: 0.4rem; font-size: 0.85rem; }
  table.awards th[scope="col"] { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em;
                                 color: var(--ink-soft); text-align: right; font-weight: 600; padding-bottom: 0.2rem; }
  table.awards th[scope="col"]:first-child { text-align: left; }
  table.awards td, table.awards th[scope="row"] { padding: 0.22rem 0.3rem; border-bottom: 1px dotted var(--rule); text-align: left; font-weight: 400; }
  table.awards td { text-align: right; white-space: nowrap; }
  .award-cn { font-weight: 650; margin-right: 0.35rem; }
  .award-en { color: var(--ink-soft); }
  .award-jp { color: var(--ink-soft); font-size: 0.75rem; font-style: italic; margin-left: 0.3rem; }
  .award-problem { background: #fbeceb; }
  .sum-line { margin-top: 0.4rem; font-size: 0.85rem; text-align: right; color: var(--ink-soft); }
  .sum-line strong { color: var(--ink); font-size: 1rem; }

  .flagbox { border: 1px solid var(--refuse); background: #fbeceb; border-radius: 3px;
             padding: 0.5rem 0.7rem; margin-top: 0.8rem; font-size: 0.85rem; }
  .flagbox ul { margin: 0.3rem 0 0; padding-left: 1.1rem; }
  .contested { border-left: 4px solid var(--contest); background: #fdf7e9; border-radius: 0 3px 3px 0;
               padding: 0.5rem 0.7rem; margin-top: 0.8rem; font-size: 0.85rem; }
  .contested strong { color: var(--contest); }
  .contested p { margin: 0.25rem 0 0; }

  /* ── the review box ───────────────────────────────────────────────── */
  .review { margin-top: 0.9rem; border-top: 2px solid var(--rule-strong); padding-top: 0.6rem;
            display: grid; grid-template-columns: auto minmax(10rem, 1fr); gap: 0.4rem 1rem; align-items: start; }
  .verdicts { display: flex; gap: 0.9rem; align-items: center; }
  .verdicts label { display: inline-flex; align-items: center; gap: 0.35rem; cursor: pointer; font-size: 0.88rem; }
  .verdicts em { font-style: normal; color: var(--ink-soft); font-size: 0.8rem; }
  .verdicts input[type="radio"] {
    appearance: none; -webkit-appearance: none; margin: 0;
    width: 1.05rem; height: 1.05rem; border: 1.5px solid var(--ink); border-radius: 2px;
    background: #fff; display: inline-block; position: relative; cursor: pointer;
  }
  .verdicts input[type="radio"]:checked::after {
    content: "✓"; position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; font-size: 0.85rem; font-weight: 700; color: var(--accent);
  }
  .correct { grid-column: 1 / -1; display: grid; grid-template-columns: auto minmax(8rem, 1fr);
             gap: 0.5rem; align-items: center; }
  .correct span, .note span { font-size: 0.75rem; color: var(--ink-soft); }
  .correct input { font: inherit; font-size: 0.85rem; padding: 0.25rem 0.4rem;
                   border: 1px solid var(--rule-strong); border-radius: 2px; background: #fff; }
  .note { grid-column: 1 / -1; display: block; }
  .note textarea { width: 100%; font: inherit; font-size: 0.85rem; padding: 0.3rem 0.45rem;
                   border: 1px solid var(--rule-strong); border-radius: 2px; background: #fff;
                   resize: vertical; margin-top: 0.15rem; }
  .source { margin-top: 0.5rem; font-size: 0.7rem; color: var(--ink-soft); word-break: break-word; }

  /* ── filters ──────────────────────────────────────────────────────── */
  body[data-filter="contested"] .case[data-contested="0"] { display: none; }
  body[data-filter="unmarked"] .case[data-marked="1"] { display: none; }

  @media (max-width: 44rem) {
    .board, .lower { grid-template-columns: minmax(0, 1fr); }
    .badges { margin-left: 0; flex-basis: 100%; }
  }

  /* ── print ────────────────────────────────────────────────────────── */
  @media print {
    @page { margin: 12mm 10mm; }
    body { background: #fff; font-size: 10.5pt; }
    .wrap { max-width: none; padding: 0; }
    .toolbar, #export-panel, .no-print { display: none !important; }
    .case { break-inside: avoid; page-break-inside: avoid; border: 1px solid #999; box-shadow: none; }
    .family-head { break-after: avoid; page-break-after: avoid; }
    .ask, .masthead { break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
    .tile, .badge, .contested, .flagbox, .award-problem, .tile.face-down {
      -webkit-print-color-adjust: exact; print-color-adjust: exact;
    }
    .note textarea { height: 3.2rem; }
  }
`;

/* ── behaviour ─────────────────────────────────────────────────────────
 * Everything below is a convenience. The page is complete and reviewable with
 * scripting off — the marks are real form controls and print as empty boxes.  */

const JS = `
  (function () {
    "use strict";
    var KEY = "mjrc-golden-review";
    var body = document.body;
    var store = null;
    try {
      window.localStorage.setItem(KEY + "-probe", "1");
      window.localStorage.removeItem(KEY + "-probe");
      store = window.localStorage;
    } catch (e) {
      var warn = document.getElementById("storage-warning");
      if (warn) {
        warn.textContent =
          "This browser will not save marks for a page opened from a file. " +
          "Nothing is lost while the tab stays open — press Export before you close it.";
      }
    }

    // Cached: there are over a hundred cases and this runs on every keystroke.
    var CASES = Array.prototype.slice.call(document.querySelectorAll(".case"));
    function cases() { return CASES; }

    var identFields = ["ident-name", "ident-house", "ident-date"];
    function ident() {
      return {
        reviewer: (document.getElementById("ident-name") || {}).value || "",
        house: (document.getElementById("ident-house") || {}).value || "",
        date: (document.getElementById("ident-date") || {}).value || ""
      };
    }

    function read(el) {
      var checked = el.querySelector('.verdicts input:checked');
      return {
        id: el.id,
        family: el.getAttribute("data-family"),
        verdict: checked ? checked.value : "",
        correctFaan: el.querySelector(".correct-input").value.trim(),
        note: el.querySelector(".note textarea").value.trim()
      };
    }

    function marked(m) { return m.verdict !== "" || m.correctFaan !== "" || m.note !== ""; }

    function refresh() {
      var total = 0, done = 0, disagreed = 0;
      cases().forEach(function (el) {
        var m = read(el);
        total++;
        if (marked(m)) { done++; el.setAttribute("data-marked", "1"); }
        else { el.setAttribute("data-marked", "0"); }
        if (m.verdict === "disagree") disagreed++;
      });
      var p = document.getElementById("progress");
      if (p) {
        p.textContent = done + " / " + total + " marked · " + disagreed + " disagreed";
      }
    }

    function save() {
      if (!store) return;
      var out = {};
      cases().forEach(function (el) {
        var m = read(el);
        if (marked(m)) out[m.id] = m;
      });
      try {
        store.setItem(KEY, JSON.stringify(out));
        store.setItem(KEY + "-who", JSON.stringify(ident()));
      } catch (e) { /* quota — ignore */ }
    }

    function restore() {
      if (!store) return;
      var raw = null;
      try {
        var who = store.getItem(KEY + "-who");
        if (who) {
          var w = JSON.parse(who);
          var pairs = [["ident-name", w.reviewer], ["ident-house", w.house], ["ident-date", w.date]];
          pairs.forEach(function (pair) {
            var el = document.getElementById(pair[0]);
            if (el && pair[1]) el.value = pair[1];
          });
        }
        raw = store.getItem(KEY);
      } catch (e) { return; }
      if (!raw) return;
      var saved;
      try { saved = JSON.parse(raw); } catch (e) { return; }
      cases().forEach(function (el) {
        var m = saved[el.id];
        if (!m) return;
        if (m.verdict) {
          var input = el.querySelector('.verdicts input[value="' + m.verdict + '"]');
          if (input) input.checked = true;
        }
        if (m.correctFaan) el.querySelector(".correct-input").value = m.correctFaan;
        if (m.note) el.querySelector(".note textarea").value = m.note;
      });
    }

    function touched(e) {
      if (!e.target.closest) return false;
      if (e.target.closest(".review")) return true;
      return identFields.indexOf(e.target.id) !== -1;
    }
    // Coalesced so that typing a paragraph into a note does not re-walk every
    // case and re-serialise the whole sheet on each character.
    var pending = 0;
    function schedule() {
      if (pending) window.clearTimeout(pending);
      pending = window.setTimeout(function () { pending = 0; refresh(); save(); }, 200);
    }
    document.addEventListener("input", function (e) { if (touched(e)) schedule(); });
    document.addEventListener("change", function (e) { if (touched(e)) schedule(); });

    var filters = Array.prototype.slice.call(document.querySelectorAll("[data-filter-value]"));
    filters.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var value = btn.getAttribute("data-filter-value");
        body.setAttribute("data-filter", value);
        filters.forEach(function (b) {
          b.setAttribute("aria-pressed", String(b === btn));
        });
      });
    });

    var exportBtn = document.getElementById("export");
    var panel = document.getElementById("export-panel");
    if (exportBtn && panel) {
      exportBtn.addEventListener("click", function () {
        if (pending) { window.clearTimeout(pending); pending = 0; refresh(); save(); }
        var marks = [];
        cases().forEach(function (el) {
          var m = read(el);
          if (marked(m)) marks.push(m);
        });
        var who = ident();
        var payload = {
          suite: "mjrc-golden-hands",
          reviewer: who.reviewer,
          house: who.house,
          date: who.date,
          cases: cases().length,
          marked: marks.length,
          marks: marks
        };
        panel.style.display = "block";
        var area = panel.querySelector("textarea");
        area.value = JSON.stringify(payload, null, 2);
        panel.scrollIntoView({ block: "start" });
        area.focus();
        area.select();
      });
    }

    restore();
    refresh();
  })();
`;

/* ── the page ──────────────────────────────────────────────────────────── */

function renderDocument(): string {
  const all = FAMILIES.flatMap((f) => f.cases);
  const contested = all.filter((c) => c.contested).length;

  const families = FAMILIES.map((f) => `
      <section class="family" id="family-${esc(f.key)}">
        <div class="family-head">
          <span class="count">${plural(f.cases.length, "case", "cases")}</span>
          <h2><span class="cn">${esc(f.characters)}</span>${esc(f.title)}</h2>
        </div>
        <p class="family-brief">${esc(f.brief)}</p>
${f.cases.map((c, i) => renderCase(c, f, i)).join("\n")}
      </section>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MJRC golden-hand review — ${all.length} Hong Kong Old Style cases</title>
<style>${CSS}</style>
</head>
<body data-filter="all">
<div class="wrap">

  <header class="masthead">
    <div class="cn">香港舊章 · 標準牌局校對</div>
    <h1>Golden-hand review sheet</h1>
    <p>
      ${all.length} hand-authored Hong Kong Old Style cases, ${contested} of them already known to
      split between houses. These are the answers the MJRC scoring engine will be held to. Every
      one is <strong>provisional</strong> until a strong HK player has signed it off — that
      sign-off is the exit requirement, and this sheet is how it gets done.
    </p>
  </header>

  <section class="ask">
    <h2>What you are being asked</h2>
    <ol>
      <li>Read the tiles, the melds and the situation. <strong>Is the printed faan the faan
          your table would pay?</strong> That is the whole question.</li>
      <li>Mark 同意 / 不同意 / 存疑 on every case. An unmarked case counts as unvalidated,
          so "obviously right" still needs a tick.</li>
      <li>If you disagree, write the number <em>you</em> would pay and name the rule. "混一色 is 3
          not 4 at my table" is worth more than "wrong".</li>
      <li>Cases flagged <span class="badge badge-contested">contested</span> are ones we already
          know houses split on. Tell us which side you play — that is the point of the flag.</li>
      <li>A case marked <span class="badge badge-refused">refused</span> claims the hand is under
          the 3-faan minimum and <em>may not be taken at all</em>. Check that as carefully as the
          scoring hands; it is the one nobody checks.</li>
    </ol>
  </section>

  <div class="ident">
    <label><span>Reviewed by</span><input type="text" id="ident-name" autocomplete="off"></label>
    <label><span>House / table you play</span><input type="text" id="ident-house" autocomplete="off"></label>
    <label><span>Date</span><input type="text" id="ident-date" autocomplete="off"></label>
  </div>

  <div class="toolbar no-print">
    <button type="button" data-filter-value="all" aria-pressed="true">All cases</button>
    <button type="button" data-filter-value="contested" aria-pressed="false">Contested only</button>
    <button type="button" data-filter-value="unmarked" aria-pressed="false">Unmarked only</button>
    <button type="button" id="export">Export marks</button>
    <span class="progress" id="progress">0 / ${all.length} marked</span>
    <span class="storage-warning" id="storage-warning"></span>
  </div>

  <div id="export-panel">
    <p class="muted">Select all, copy, and send this back. Nothing leaves your machine on its own.</p>
    <textarea readonly></textarea>
  </div>

${contents()}

${families}

</div>
<script>${JS}</script>
</body>
</html>
`;
}

/* ── entry point ───────────────────────────────────────────────────────── */

function outputPath(argv: readonly string[]): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const flag = argv.indexOf("--out");
  if (flag !== -1) {
    const value = argv[flag + 1];
    if (!value) throw new Error("--out needs a path");
    return resolve(process.cwd(), value);
  }
  return resolve(here, "golden-review.html");
}

const target = outputPath(process.argv.slice(2));
const html = renderDocument();
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, html, "utf8");

const all = FAMILIES.flatMap((f) => f.cases);
const flagged = all.filter((c) => flagsFor(c).length > 0);
for (const f of FAMILIES) {
  process.stdout.write(`  ${f.key.padEnd(8)} ${String(f.cases.length).padStart(3)} cases\n`);
}
process.stdout.write(`  ${"total".padEnd(8)} ${String(all.length).padStart(3)} cases · `);
process.stdout.write(`${all.filter((c) => c.contested).length} contested · `);
process.stdout.write(`${all.filter((c) => !c.expected.legal).length} refused\n`);
if (flagged.length > 0) {
  process.stdout.write(`\n  ${flagged.length} case(s) flagged for the reviewer:\n`);
  for (const c of flagged) {
    for (const flag of flagsFor(c)) process.stdout.write(`    ${c.id}: ${flag}\n`);
  }
} else {
  process.stdout.write("\n  No generator flags: every award list prices to its stated faan.\n");
}
process.stdout.write(`\n  ${target}\n`);

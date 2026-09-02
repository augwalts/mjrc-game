/**
 * Hand-rolled inline SVG charts — the standard set (PVP-LOBBY-PROPOSAL §10):
 * "hand-rolled inline SVG, one y-scale, faint per-game lines with the bold
 * aggregate on top, densified time axes." Ported from lobby-lab.html's own
 * `bars()`/`lineChart()`, reading colours off `#shell`'s CSS custom
 * properties (never hard-coded) so both themes render correctly.
 */
function themeColor(name: string, fallback = ""): string {
  const el = document.getElementById("shell");
  if (!el) return fallback;
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}
export const chartTokens = () => ({
  gold: themeColor("--gold", "#1845a5"), green: themeColor("--green", "#127a30"),
  red: themeColor("--red", "#c1272d"), blue: themeColor("--blue", "#1845a5"),
  dim: themeColor("--dim", "#777770"), ink: themeColor("--ink", "#1a1a18"),
  grid: themeColor("--grid", "rgba(0,0,0,.12)"), series2: themeColor("--series2", "#9a7318"),
  series3: themeColor("--series3", "#127a30"),
});

/** A signed or unsigned bar chart — `vals` may be a plain number or a
 *  `[a,b]` stacked pair (used nowhere here yet, kept for parity with the
 *  lab's own helper). */
export function barsChart(vals: number[], labels: string[], color?: string): string {
  const W = 300, H = 90, n = Math.max(vals.length, 1), bw = W / n - 4;
  const signed = vals.some((v) => v < 0);
  const max = Math.max(...vals.map(Math.abs), 1);
  const base = signed ? H / 2 : H;
  const T = chartTokens();
  const c = color ?? T.gold;
  return `<svg viewBox="0 0 ${W} ${H + 16}" width="100%">${signed ? `<line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="${T.grid}"/>` : ""}${
    vals.map((v, i) => {
      const x = i * (W / n) + 2;
      const h = Math.abs(v) / max * (signed ? H / 2 : H);
      const y = v >= 0 ? base - h : base;
      return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${v >= 0 ? c : T.red}" rx="2"/>`;
    }).join("")
  }${labels.map((l, i) => `<text x="${i * (W / n) + W / n / 2}" y="${H + 12}" text-anchor="middle" fill="${T.dim}" font-size="9">${l}</text>`).join("")}</svg>`;
}

export interface LineSeries { v: number[]; c: string; w?: number; o?: number; dots?: boolean; }
export function lineChartSvg(series: LineSeries[], labels: string[]): string {
  const W = 300, H = 90;
  const max = Math.max(...series.flatMap((sr) => sr.v.map(Math.abs)), 1);
  const T = chartTokens();
  const pts = (arr: number[]): string => arr.map((v, i) => `${arr.length > 1 ? i / (arr.length - 1) * W : 0},${H - v / max * H}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H + 16}" width="100%">${[0.5, 1].map((f) => `<line x1="0" x2="${W}" y1="${H - f * H}" y2="${H - f * H}" stroke="${T.grid}"/>`).join("")}${
    series.map((sr) => `<polyline fill="none" stroke="${sr.c}" stroke-width="${sr.w ?? 2}" stroke-opacity="${sr.o ?? 1}" stroke-linejoin="round" points="${pts(sr.v)}"/>`).join("")
  }${series.filter((sr) => sr.dots).map((sr) => sr.v.map((v, i) => `<circle cx="${sr.v.length > 1 ? i / (sr.v.length - 1) * W : 0}" cy="${H - v / max * H}" r="2.5" fill="${sr.c}"/>`).join("")).join("")
  }${labels.map((l, i) => `<text x="${labels.length > 1 ? i / (labels.length - 1) * W : 0}" y="${H + 12}" text-anchor="middle" fill="${T.dim}" font-size="9">${l}</text>`).join("")}</svg>`;
}

/** Score-progression shape: a zero line, faint per-game polylines, one bold
 *  aggregate/average on top. `games` are the faint lines, `avg` the bold
 *  one; x = hand index, y = signed points, both auto-scaled. */
export function progressionSvg(games: number[][], avg: number[], boldColor: string): string {
  const W = 300, H = 90;
  const max = Math.max(1, ...games.flatMap((g) => g.map(Math.abs)), ...avg.map(Math.abs));
  const T = chartTokens();
  const pts = (arr: number[]): string => arr.map((v, i) => `${arr.length > 1 ? i / (arr.length - 1) * W : 0},${H / 2 - v / max * (H / 2)}`).join(" ");
  const hands = Math.max(avg.length, ...games.map((g) => g.length), 1);
  return `<svg viewBox="0 0 ${W} ${H + 14}" width="100%"><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="${T.grid}"/>${
    games.map((g) => `<polyline fill="none" stroke="${boldColor}" stroke-opacity=".28" stroke-width="1" points="${pts(g)}"/>`).join("")
  }${avg.length > 0 ? `<polyline fill="none" stroke="${boldColor}" stroke-width="2.4" points="${pts(avg)}"/>` : ""}${
    Array.from({ length: hands }, (_, i) => i + 1).map((h, i) => `<text x="${hands > 1 ? i / (hands - 1) * W : 0}" y="${H + 12}" text-anchor="middle" fill="${T.dim}" font-size="9">${h}</text>`).join("")
  }</svg>`;
}

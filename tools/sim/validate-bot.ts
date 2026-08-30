/**
 * Behavioral census of a bot — the owner's validation view (2026-08-28):
 * claims (chows/pungs/kongs), wins by kind, hand types, faan sizes, draws,
 * refusals, threat detection. Run as a PURE MIRROR (all four seats the same
 * profile) so every action at the table belongs to the bot under test.
 *
 *   node tools/sim/validate-bot.mjs <profile.json> [matches=40] [seedBase]
 */
import { readFileSync } from "node:fs";
import { DEFAULT_PROFILE, type BotProfile } from "../../engine/src/bots.js";
import { evaluate, setSimRuleset } from "./evalcore.js";

const load = (p: string): BotProfile => ({ ...DEFAULT_PROFILE, ...JSON.parse(readFileSync(p, "utf8")) });
const prof = load(process.argv[2]!);
const N = Number(process.argv[3] ?? 40);
const base = Number(process.argv[4] ?? 12_345_678);
if (process.argv[5]) setSimRuleset(process.argv[5]!);
const seeds = Array.from({ length: N }, (_, i) => base + i * 7919);
const r = evaluate(prof, prof, seeds, undefined, { allSeats: true });

const a = r.activity;
const per = (n: number) => +(n / a.hands).toFixed(2);
const wins = a.winsOnDiscard + a.selfDraws;
const pct = (n: number, d: number) => `${(100 * n / Math.max(1, d)).toFixed(0)}%`;
console.log(`games ${N * 4} (all-seats) · hands ${a.hands} · chips/match ${r.chipsPerMatch} (mirror: must be 0)`);
console.log(`wins ${wins} (${pct(wins, a.hands)} of hands) — on discard 食糊 ${a.winsOnDiscard} (${pct(a.winsOnDiscard, wins)}) · self-draw 自摸 ${a.selfDraws} (${pct(a.selfDraws, wins)})`);
console.log(`draws 流局 ${pct(Math.round(r.drawRate * a.hands), a.hands)} · refused wins ${r.refusedPerHand}/hand · threat detection ${Math.round(r.threatDetection * 100)}%`);
console.log(`claims/hand ${r.claimsPerHand} — chows 上 ${per(a.chows)} · pungs 碰 ${per(a.pungs)} · kongs 槓 ${per(a.kongs)}`);
console.log(`mean winning faan ${r.meanFaan}`);
const fh = a.faanHist;
const tot = fh.reduce((x: number, y: number) => x + y, 0) || 1;
console.log("faan sizes: " + [3, 4, 5, 6, 7, 8, 9].map((f) => `${f}:${pct(fh[f]!, tot)}`).join(" ") +
  ` 10+:${pct(fh.slice(10).reduce((x: number, y: number) => x + y, 0), tot)}`);
const pats = Object.entries(a.patterns).sort((x, y) => (y[1] as number) - (x[1] as number)).slice(0, 14);
console.log("hand types (% of wins): " + pats.map(([k, n]) => `${k} ${pct(n as number, wins)}`).join(" · "));

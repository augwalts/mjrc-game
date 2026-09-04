#!/usr/bin/env node
/**
 * Stitch the per-hand log blobs a LOCAL `wrangler dev` wrote to miniflare's R2
 * store into one whole-match log per match, so `tools/replay/cli.ts --verify`
 * (gate 2: the log re-executes to itself) can run over what the table actually
 * archived. Development only: production logs are read through the API.
 *
 *   node gamepvp/test/assemble-log.mjs [outDir] [matchId ...]
 *
 * Then, per match:
 *   ./node_modules/.bin/vite-node tools/replay/cli.ts -- <outDir>/<matchId>.json --verify
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const blobs = join(here, "..", ".wrangler", "state", "v3", "r2", "mjrc-game-logs", "blobs");
const [outDir = join(here, "..", ".wrangler", "logs"), ...only] = process.argv.slice(2);

const byMatch = new Map();
for (const name of readdirSync(blobs)) {
  let log;
  try {
    log = JSON.parse(readFileSync(join(blobs, name), "utf8"));
  } catch {
    continue; // not one of ours
  }
  if (!log || !log.header || !Array.isArray(log.events)) continue;
  const id = log.header.matchId;
  if (only.length > 0 && !only.includes(id)) continue;
  const m = byMatch.get(id) ?? { header: log.header, events: [] };
  m.header = log.header; // the latest hand's header carries the final player names
  m.events.push(...log.events);
  byMatch.set(id, m);
}

mkdirSync(outDir, { recursive: true });
for (const [id, m] of byMatch) {
  m.events.sort((a, b) => a.seq - b.seq);
  // Drop duplicate seqs (a hand blob rewritten by an outbox retry).
  m.events = m.events.filter((e, i, all) => i === 0 || e.seq !== all[i - 1].seq);
  const hands = new Set(m.events.map((e) => e.handIndex)).size;
  const complete = m.events[m.events.length - 1]?.type === "matchEnd";
  const file = join(outDir, `${id}.json`);
  writeFileSync(file, JSON.stringify(m));
  console.log(`${id}  hands=${hands}  events=${m.events.length}  ${complete ? "complete" : "partial"}  -> ${file}`);
}
if (byMatch.size === 0) console.log("no logs found under", blobs);

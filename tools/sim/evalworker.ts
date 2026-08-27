/**
 * One evaluation in a child process. Job JSON on stdin:
 *   { candidate: BotProfile, incumbent: BotProfile, seeds: number[] }
 * EvalResult JSON on stdout. Deterministic: identical job → identical result,
 * so the parallel path must byte-match the serial one (tested).
 */
import { evaluate } from "./evalcore.js";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const job = JSON.parse(raw);
  const sample: import("./evalcore.js").SampleMatch[] | undefined = job.collect ? [] : undefined;
  const result = evaluate(job.candidate, job.incumbent, job.seeds, sample);
  process.stdout.write(JSON.stringify({ result, sample }));
});

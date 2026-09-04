/**
 * Local runner for the port-diff harness (DESIGN.md §8, harness 1).
 *
 * The root vitest.config.ts already collects tools/**, so `npm test` runs this
 * harness. This config exists to run ONLY the harness, without waiting on the
 * rest of the suite:
 *
 *   ./node_modules/.bin/vitest run --config tools/port-diff/vitest.config.ts
 *
 * `root` stays the repo root so relative imports into engine/ resolve the same
 * way they do everywhere else.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  test: {
    include: ["tools/port-diff/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Source of truth is TypeScript. Never collect emitted .js — doing so runs
    // every suite twice and silently doubles the reported test count.
    // tools/ keeps its tests beside the code it exercises rather than in a
    // test/ folder, so it needs its own pattern.
    include: ["{client,engine,protocol,rulesets,worker}/test/**/*.test.ts", "tools/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});

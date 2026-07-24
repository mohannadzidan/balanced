import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tests arrive in Phase 2 (T009); keeps the per-task gate green until then.
    passWithNoTests: true,
  },
});

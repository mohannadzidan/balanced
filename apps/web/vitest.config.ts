import { fileURLToPath } from "node:url"

import { mergeConfig } from "vitest/config"

import { baseConfig } from "@balanced/vitest-config/base"

export default mergeConfig(baseConfig, {
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
})

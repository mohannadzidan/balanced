import { mergeConfig } from "vitest/config"

import { baseConfig } from "@balanced/vitest-config/base"

export default mergeConfig(baseConfig, {
  test: {
    include: ["tests/**/*.test.ts"],
  },
})

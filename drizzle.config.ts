// eslint-disable-next-line @typescript-eslint/no-require-imports
require("dotenv").config();

import type { Config } from "drizzle-kit";

export default {
  schema: "./lib/db/schema.ts",
  out: "./migrations",
  dialect: "turso",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
} satisfies Config;
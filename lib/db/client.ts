import { createClient, type Client } from "@libsql/client"

/**
 * The single libSQL (Turso) client for the whole app — the only place a
 * database connection is opened (Constitution III). Everything else goes
 * through the typed functions in `lib/db/queries.ts`; no route, component, or
 * server action may create its own client or issue SQL directly.
 *
 * `TURSO_DATABASE_URL` may be a local file DB (`file:local.db`) for
 * development, in which case `TURSO_AUTH_TOKEN` is not needed.
 */

const url = process.env.TURSO_DATABASE_URL

if (!url) {
  throw new Error(
    "TURSO_DATABASE_URL is not set. Copy .env.example to .env.local and fill it in."
  )
}

const authToken = process.env.TURSO_AUTH_TOKEN

export const db: Client = createClient({
  url,
  ...(authToken ? { authToken } : {}),
})

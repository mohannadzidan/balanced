/**
 * Applies pending SQL migrations to the configured Turso/libSQL database.
 *
 * Schema changes go through checked-in migration files, never manual edits to
 * a live database (Constitution III). Files in `lib/db/migrations/` are applied
 * in filename order; each applied file is recorded in `_migration` so re-runs
 * are a no-op.
 *
 * Run with: pnpm db:migrate
 */

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { db } from "@/lib/db/client"

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../lib/db/migrations"
)

async function main() {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS _migration (
       name       TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`
  )

  const applied = await db.execute("SELECT name FROM _migration")
  const alreadyApplied = new Set(applied.rows.map((row) => String(row.name)))

  const entries = await readdir(MIGRATIONS_DIR)
  const migrations = entries.filter((name) => name.endsWith(".sql")).sort()

  let pending = 0
  for (const name of migrations) {
    if (alreadyApplied.has(name)) continue

    const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8")
    await db.executeMultiple(sql)
    await db.execute({
      sql: "INSERT INTO _migration (name, applied_at) VALUES (?, ?)",
      args: [name, new Date().toISOString()],
    })

    console.log(`applied ${name}`)
    pending += 1
  }

  console.log(
    pending === 0
      ? `no pending migrations (${migrations.length} already applied)`
      : `applied ${pending} migration(s)`
  )
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("migration failed:", error)
    process.exit(1)
  })

// One-off migration: normalize legacy <p><img></p><p>图：…</p> content in the
// SQLite database. Dry-run by default; pass --apply to write.
//
//   npm run normalize:figures -- --db /opt/MultiPush/.data/multipush.sqlite --report
//   npm run normalize:figures -- --db /opt/MultiPush/.data/multipush.sqlite --apply
//
// The script only changes block structure. content_json is left untouched and
// marked stale, so the editor loads the normalized HTML and rewrites JSON on the
// next save. Existing render records are not deleted.
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { normalizeFigureCaptionsHtml } from '../server/src/renderers/figure-captions'

interface Options {
  db: string
  apply: boolean
  report: boolean
}

function parseArgs(argv: string[]): Options {
  let db = process.env.MULTIPUSH_DB || path.join(process.env.DATA_DIR || '.data', 'multipush.sqlite')
  let apply = false
  let report = false
  for (const arg of argv) {
    if (arg === '--apply') apply = true
    else if (arg === '--report') report = true
    else if (arg.startsWith('--db=')) db = arg.slice('--db='.length)
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run normalize:figures -- [--db=path] [--apply] [--report]')
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { db, apply, report }
}

const options = parseArgs(process.argv.slice(2))
if (!existsSync(options.db)) {
  console.error(`Database not found: ${options.db}`)
  process.exit(1)
}

const database = new DatabaseSync(options.db)
database.exec('PRAGMA busy_timeout = 5000')
const columns = new Set(
  (database.prepare('PRAGMA table_info(contents)').all() as { name: string }[]).map((row) => row.name),
)
if (!columns.has('content_json_stale')) {
  database.exec('ALTER TABLE contents ADD COLUMN content_json_stale INTEGER NOT NULL DEFAULT 0')
}

if (options.apply) {
  // Merge WAL pages into the main file before copying so the backup is complete.
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const backup = `${options.db}.before-figure-normalize-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
  copyFileSync(options.db, backup)
  console.log(`Backup written: ${backup}`)
}
const rows = database.prepare(
  `SELECT id, title, content_html
   FROM contents
   WHERE content_html LIKE '%<img%'
   ORDER BY updated_at DESC`,
).all() as { id: string; title: string; content_html: string }[]

const changed: { id: string; title: string; before: string; after: string }[] = []
for (const row of rows) {
  const after = normalizeFigureCaptionsHtml(row.content_html)
  if (after !== row.content_html) changed.push({ id: row.id, title: row.title, before: row.content_html, after })
}

console.log(`Scanned ${rows.length} documents; ${changed.length} need figure normalization.`)
if (options.report || !options.apply) {
  for (const item of changed) {
    console.log(`- ${item.id} ${JSON.stringify(item.title)} (${item.before.length} -> ${item.after.length} bytes)`)
  }
}

if (options.apply && changed.length > 0) {
  const update = database.prepare(
    `UPDATE contents
     SET content_html = ?, content_json_stale = 1
     WHERE id = ?`,
  )
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const item of changed) update.run(item.after, item.id)
    database.exec('COMMIT')
    console.log(`Applied ${changed.length} updates. content_json_stale=1; next editor save rebuilds JSON.`)
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
} else if (!options.apply) {
  console.log('Dry-run only. Re-run with --apply to write the changes.')
}

database.close()

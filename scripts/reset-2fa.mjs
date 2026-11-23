#!/usr/bin/env node
/**
 * Emergency reset for a lost TOTP device / recovery codes.
 *
 * Usage:
 *   node scripts/reset-2fa.mjs --data-dir /opt/MultiPush/.data --username yuanxin
 *
 * Stop multipush.service first when possible. The script only deletes the
 * user_totp row for the named account; passwords and other data stay intact.
 */
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
function option(name, fallback = '') {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const dataDir = option('--data-dir', process.env.DATA_DIR || '')
const username = option('--username', '')
if (!dataDir || !username) {
  console.error('用法：node scripts/reset-2fa.mjs --data-dir /opt/MultiPush/.data --username <用户名>')
  process.exit(2)
}

const dbPath = path.join(path.resolve(dataDir), 'multipush.sqlite')
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')
try {
  const user = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(username)
  if (!user) {
    console.error(`账号不存在：${username}`)
    process.exit(1)
  }
  const result = db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(user.id)
  if (result.changes === 0) {
    console.log(`账号 ${user.username} 未开启两步验证，无需重置。`)
  } else {
    console.log(`已清除账号 ${user.username} 的两步验证配置，请使用密码重新登录并在设置中重新开启。`)
  }
} finally {
  db.close()
}

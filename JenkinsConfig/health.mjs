#!/usr/bin/env node
//
// MultiPush post-deploy health check.
//
// Polls /api/health (default http://127.0.0.1:34080/api/health) up to 30 times
// at 1 second intervals, then validates the response identity. Requires
// Node.js 18+ (global fetch / AbortSignal.timeout).
//
// Optional environment variables:
//   HEALTH_URL            health endpoint URL
//   HEALTH_ATTEMPTS       maximum attempts (default 30)
//   HEALTH_INTERVAL_MS    delay between attempts in ms (default 1000)
//   HEALTH_TIMEOUT_MS     per-request timeout in ms (default 3000)

const HEALTH_URL = process.env.HEALTH_URL ?? 'http://127.0.0.1:34080/api/health'
const MAX_ATTEMPTS = Number.parseInt(process.env.HEALTH_ATTEMPTS ?? '30', 10)
const INTERVAL_MS = Number.parseInt(process.env.HEALTH_INTERVAL_MS ?? '1000', 10)
const TIMEOUT_MS = Number.parseInt(process.env.HEALTH_TIMEOUT_MS ?? '3000', 10)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function describeError(error) {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const cause = error.cause
  if (cause && typeof cause === 'object') {
    const code = typeof cause.code === 'string' ? cause.code : null
    const message = typeof cause.message === 'string' ? cause.message : null
    if (code && message) return `${error.message} (${code}: ${message})`
    if (code) return `${error.message} (${code})`
    if (message) return `${error.message} (${message})`
  }
  return error.message
}

let lastError = '尚未发起请求'
let lastBody = null

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  try {
    const response = await fetch(HEALTH_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await response.text()

    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`HTTP ${response.status}，响应不是 JSON: ${text.slice(0, 200)}`)
    }

    lastBody = body

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
    if (body?.status !== 'ok') {
      throw new Error(`status 期望 "ok"，实际为 ${JSON.stringify(body?.status)}`)
    }
    if (body?.service !== 'multipush') {
      throw new Error(`service 期望 "multipush"，实际为 ${JSON.stringify(body?.service)}`)
    }

    console.log(JSON.stringify(body))
    process.exit(0)
  } catch (error) {
    lastError = describeError(error)
    if (attempt < MAX_ATTEMPTS) {
      console.error(`[health] ${attempt}/${MAX_ATTEMPTS} 失败: ${lastError}；${INTERVAL_MS}ms 后重试`)
      await sleep(INTERVAL_MS)
    }
  }
}

console.error(`[health] ${MAX_ATTEMPTS} 次尝试均失败，最后错误: ${lastError}`)
if (lastBody !== null) {
  console.error(`[health] 最后一次响应: ${JSON.stringify(lastBody)}`)
}
console.error(`[health] 地址: ${HEALTH_URL}`)
console.error('[health] 排查建议:')
console.error('  sudo systemctl status multipush.service --no-pager -l')
console.error('  sudo journalctl -u multipush.service -n 100 --no-pager')
console.error('  curl -v http://127.0.0.1:34080/api/health')
console.error('  ss -ltn | grep 34080')
process.exit(1)

#!/usr/bin/env node
/**
 * Install (or update) a Cloudflare rate-limiting rule for MultiPush auth
 * endpoints. This is defense-in-depth on top of the application-level login
 * throttle in server/src/login-guard.ts.
 *
 * Required environment:
 *   CLOUDFLARE_API_TOKEN  token with "Zone WAF Edit" (and Zone Read)
 *   CLOUDFLARE_ZONE_ID    zone id for the public domain
 * Optional:
 *   MULTIPUSH_PUBLIC_HOST default publish.yuan-xin.top
 *   LOGIN_LIMIT_REQUESTS  default 5 requests
 *   LOGIN_LIMIT_PERIOD    default 10 seconds (free plan minimum)
 *   LOGIN_LIMIT_BLOCK     default 10 seconds (free plan maximum)
 *
 * Usage:
 *   node scripts/cloudflare-login-ratelimit.mjs --dry-run
 *   node scripts/cloudflare-login-ratelimit.mjs --apply
 */
const DESCRIPTION = 'MultiPush auth brute-force rate limit'
const PHASE_PATH = 'http_ratelimit/entrypoint'

function env(name, fallback) {
  const value = process.env[name]?.trim()
  return value ? value : fallback
}

const token = env('CLOUDFLARE_API_TOKEN', '')
const zoneId = env('CLOUDFLARE_ZONE_ID', '')
const host = env('MULTIPUSH_PUBLIC_HOST', 'publish.yuan-xin.top')
const requestsPerPeriod = Number(env('LOGIN_LIMIT_REQUESTS', '5'))
const period = Number(env('LOGIN_LIMIT_PERIOD', '10'))
const mitigationTimeout = Number(env('LOGIN_LIMIT_BLOCK', '10'))
const apply = process.argv.includes('--apply')
const dryRun = !apply || process.argv.includes('--dry-run')

if (!token || !zoneId) {
  console.error('缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ZONE_ID；请只在本地环境注入，不要把令牌写进仓库。')
  process.exit(2)
}

const base = `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/phases/${PHASE_PATH}`
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const expression = [
  `(http.host eq "${host}")`,
  '(http.request.method eq "POST")',
  '(http.request.uri.path in {"/api/auth/login" "/api/auth/2fa/verify" "/api/auth/reset-password" "/api/auth/email-code"})',
].join(' and ')

const rule = {
  action: 'block',
  description: DESCRIPTION,
  expression,
  ratelimit: {
    characteristics: ['ip.src', 'cf.colo.id'],
    period,
    requests_per_period: requestsPerPeriod,
    mitigation_timeout: mitigationTimeout,
  },
}

async function request(method, body) {
  const response = await fetch(base, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

async function main() {
  const current = await request('GET')
  if (current.response.status === 403) {
    console.error('当前令牌没有 Zone WAF Edit 权限，无法读取/修改限流规则。请换用具备「Zone → WAF → Edit」的令牌。')
    process.exit(3)
  }
  const existing = current.response.status === 404 || !current.payload?.result?.rules
    ? []
    : current.payload.result.rules
  const rules = [...existing.filter(item => item.description !== DESCRIPTION), rule]
  console.log(`规则预览（${dryRun ? 'dry-run' : 'apply'}）：`)
  console.log(JSON.stringify(rule, null, 2))
  if (dryRun) {
    console.log('未写入。确认后运行 `node scripts/cloudflare-login-ratelimit.mjs --apply`。')
    return
  }
  const result = await request('PUT', { rules })
  if (!result.response.ok || !result.payload.success) {
    console.error('写入失败：', JSON.stringify(result.payload.errors ?? result.payload, null, 2))
    process.exit(1)
  }
  const installed = result.payload.result?.rules?.find(item => item.description === DESCRIPTION)
  console.log(`已写入规则，id=${installed?.id ?? '（未返回）'}，共 ${result.payload.result?.rules?.length ?? 0} 条限流规则。`)
}

main().catch((error) => {
  console.error('执行失败：', error instanceof Error ? error.message : error)
  process.exit(1)
})

#!/usr/bin/env node
/**
 * Video content smoke test.
 *
 * Verifies the video-content flow end to end against a running MultiPush
 * server (local dev, local production build, or a deployed instance):
 *
 *   node scripts/smoke-video.mjs
 *   MULTIPUSH_BASE_URL=http://192.168.0.111:34080 QA_ACCOUNT_A=... QA_PASSWORD_A=... node scripts/smoke-video.mjs
 *
 * Set SMOKE_DESKTOP=1 to register a fresh local account (requires the server
 * to run in desktop mode, e.g. MULTIPUSH_DESKTOP=1 npm start).
 */

const base = (process.env.MULTIPUSH_BASE_URL || 'http://127.0.0.1:34080').replace(/\/$/, '')
const stamp = Date.now().toString(36)

let failures = 0
function check(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: response.status, data }
}

async function registerAccount() {
  const username = `video_smoke_${stamp}`
  const password = `VideoSmoke-${stamp}`
  if (process.env.SMOKE_DESKTOP === '1') {
    const result = await request('/api/auth/register', {
      method: 'POST',
      body: { username, email: `${username}@example.com`, password, displayName: '视频冒烟' },
    })
    if (result.status !== 200 && result.status !== 201) {
      throw new Error(`desktop register failed: ${result.status} ${JSON.stringify(result.data)}`)
    }
    return result.data
  }
  const account = process.env.QA_ACCOUNT_A
  const accountPassword = process.env.QA_PASSWORD_A
  if (!account || !accountPassword) {
    throw new Error('Set QA_ACCOUNT_A / QA_PASSWORD_A (verified accounts) or use SMOKE_DESKTOP=1')
  }
  const result = await request('/api/auth/login', { method: 'POST', body: { account, password: accountPassword } })
  if (result.status !== 200) {
    throw new Error(`login failed: ${result.status} ${JSON.stringify(result.data)}`)
  }
  return result.data
}

async function main() {
  console.log(`MultiPush video smoke → ${base}`)
  const health = await request('/api/health')
  check(health.status === 200, `健康检查 ${JSON.stringify(health.data?.status)}`)

  const auth = await registerAccount()
  const token = auth.token

  // 1. Create a video content.
  const created = await request('/api/contents', {
    method: 'POST',
    token,
    body: { title: `冒烟视频 ${stamp}`, kind: 'video', contentHtml: '<p>冒烟正文</p>', tags: ['冒烟'] },
  })
  check(created.status === 200 && created.data.content?.kind === 'video', '创建视频内容 kind=video')
  const contentId = created.data.content.id

  // 2. Upload two video segments (fixtures live in server/test/fixtures).
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const fixturesDir = path.default.resolve(path.default.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'test', 'fixtures')
  const files = ['clip_a.mp4', 'clip_b.mp4'].map((name) => {
    const buffer = readFileSync(path.default.join(fixturesDir, name))
    return new File([buffer], name, { type: 'video/mp4' })
  })
  const mediaIds = []
  for (const file of files) {
    const form = new FormData()
    form.append('file', file, file.name)
    const response = await fetch(`${base}/api/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    const media = await response.json().catch(() => null)
    check(response.status === 200 && media?.media?.id, `上传片段 ${file.name}${media?.media?.duration ? `（时长 ${media.media.duration}s）` : ''}`)
    mediaIds.push(media.media.id)
  }

  // 3. Replace the timeline: trim clip A to [0.5, 1.5], keep clip B full.
  const timeline = await request(`/api/contents/${contentId}/video/timeline`, {
    method: 'PUT',
    token,
    body: {
      clips: [
        { mediaId: mediaIds[0], trimStart: 0.5, trimEnd: 1.5 },
        { mediaId: mediaIds[1] },
      ],
    },
  })
  check(timeline.status === 200 && timeline.data.project?.clips?.length === 2, '保存剪辑时间线（2 段）')
  check(Math.abs((timeline.data.project?.totalDuration ?? 0) - 3) < 0.3, `总时长 ≈3s（实际 ${timeline.data.project?.totalDuration?.toFixed(2)}s）`)

  const project = await request(`/api/contents/${contentId}/video`, { token })
  check(project.status === 200 && project.data.project?.clips?.[0]?.media?.url?.startsWith('/uploads/'), '读取时间线并携带素材信息')
  check(typeof project.data.capability?.ffmpeg === 'boolean', `服务器 ffmpeg 能力：${project.data.capability?.ffmpeg ? '可用' : '未安装'}`)

  const summary = await request(`/api/contents/${contentId}`, { token })
  check(summary.data.content?.videoCount === 2, `内容 video_count=${summary.data.content?.videoCount}`)

  // 4. Article contents must reject timeline editing.
  const article = await request('/api/contents', { method: 'POST', token, body: { title: `冒烟图文 ${stamp}`, kind: 'article' } })
  const rejected = await request(`/api/contents/${article.data.content.id}/video/timeline`, {
    method: 'PUT',
    token,
    body: { clips: [{ mediaId: mediaIds[0] }] },
  })
  check(rejected.status === 400, '图文内容拒绝剪辑时间线')

  // 5. Export the merged clip (async job).
  const exportStart = await request(`/api/contents/${contentId}/video/export`, { method: 'POST', token })
  if (exportStart.status === 200 && exportStart.data.export?.id) {
    let finished = null
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const status = await request(`/api/video-exports/${exportStart.data.export.id}`, { token })
      if (['completed', 'failed'].includes(status.data.export?.status)) {
        finished = status.data.export
        break
      }
    }
    check(finished?.status === 'completed', `导出成片完成（进度 ${finished?.progress ?? '-'}%）`)
    if (finished?.status === 'completed' && finished.outputMedia?.url) {
      const output = await fetch(`${base}${finished.outputMedia.url}`, { headers: { Range: 'bytes=0-1023' } })
      check(output.status === 200 || output.status === 206, '成片可通过 /uploads 访问（Range）')
      const size = Number(finished.outputMedia.size ?? 0)
      check(size > 10_000, `成片大小 ${Math.round(size / 1024)}KB`)
    }
    if (finished?.status === 'failed') {
      console.error(`  导出失败原因：${finished.message}`)
      failures += 1
    }
  } else {
    // Local dev without ffmpeg: the API must explain itself.
    check(
      exportStart.status === 503 && /ffmpeg/i.test(exportStart.data?.message ?? ''),
      `未安装 ffmpeg 时导出返回明确提示（${exportStart.status}）`,
    )
  }

  // 6. Cross-tenant isolation: another account cannot read the timeline.
  const otherAuth = await request('/api/auth/login', {
    method: 'POST',
    body: { account: process.env.QA_ACCOUNT_B ?? '', password: process.env.QA_PASSWORD_B ?? '' },
  })
  if (otherAuth.status === 200 && otherAuth.data.token) {
    const foreign = await request(`/api/contents/${contentId}/video`, { token: otherAuth.data.token })
    check(foreign.data?.project?.clips?.length === 0, '其他用户读不到该时间线')
  } else {
    console.log('  - 未配置 QA_ACCOUNT_B，跳过跨用户隔离检查')
  }

  // Cleanup: remove created contents and uploaded media to keep the account tidy.
  await request(`/api/contents/${contentId}?permanent=true`, { method: 'DELETE', token })
  await request(`/api/contents/${article.data.content.id}?permanent=true`, { method: 'DELETE', token })
  for (const mediaId of mediaIds) {
    await request(`/api/media/${mediaId}`, { method: 'DELETE', token })
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures} 项未通过`)
    process.exit(1)
  }
  console.log('\n✓ 视频内容冒烟全部通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

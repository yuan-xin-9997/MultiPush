import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.join(root, 'desktop')
const serverOut = path.join(desktop, 'server')
const webOut = path.join(desktop, 'web-dist')

await rm(serverOut, { recursive: true, force: true })
await rm(webOut, { recursive: true, force: true })
await mkdir(serverOut, { recursive: true })

await build({
  entryPoints: [path.join(root, 'server', 'src', 'server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: path.join(serverOut, 'index.cjs'),
  external: ['playwright-core'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})

const webDist = path.join(root, 'web', 'dist')
try {
  await cp(webDist, webOut, { recursive: true })
} catch (error) {
  throw new Error(`无法复制前端构建产物 ${webDist}，请先运行 npm run build:web：${error instanceof Error ? error.message : error}`)
}

console.log('[multipush] desktop assets ready: desktop/server/index.cjs, desktop/web-dist')

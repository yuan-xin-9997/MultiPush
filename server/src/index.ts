import 'dotenv/config'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { createApp } from './app'

const config = loadConfig()
const database = openDatabase(config.dbPath)
const app = createApp(config, database)

const server = app.listen(config.port, config.host, () => {
  console.log(`[multipush] listening on http://${config.host}:${config.port}`)
  console.log(`[multipush] environment=${config.nodeEnv} data=${config.dataDir}`)
  if (config.isProduction) console.log(`[multipush] web=${config.webDist}`)
})

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error('[multipush] failed to start server:', error.message)
  try {
    database.close()
  } catch {
    // ignore
  }
  process.exitCode = 1
})

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[multipush] received ${signal}, shutting down…`)
  const forceTimer = setTimeout(() => {
    console.error('[multipush] forced shutdown after timeout')
    process.exit(1)
  }, 10_000)
  forceTimer.unref()

  server.close(async (error) => {
    if (error) console.error('[multipush] server close error:', error)
    try { await app.locals.wechat.close() }
    catch { console.error('[multipush] failed to close the WeChat browser') }
    try { await app.locals.xiaohongshu.close() }
    catch { console.error('[multipush] failed to close the Xiaohongshu browser') }
    try { await app.locals.zhihu.close() }
    catch { console.error('[multipush] failed to close the Zhihu browser') }
    try {
      database.close()
    } catch (dbError) {
      console.error('[multipush] database close error:', dbError)
    }
    clearTimeout(forceTimer)
    process.exit(error ? 1 : 0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (error) => {
  console.error('[multipush] uncaught exception:', error)
  shutdown('uncaughtException')
})
process.on('unhandledRejection', (reason) => {
  console.error('[multipush] unhandled rejection:', reason)
})

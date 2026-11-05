import 'dotenv/config'
import { startMultiPushServer, type StartedMultiPushServer } from './server'

let running: StartedMultiPushServer | null = null
let shuttingDown = false

startMultiPushServer()
  .then((instance) => {
    running = instance
    console.log(`[multipush] listening on ${instance.url}`)
    console.log(`[multipush] environment=${instance.config.nodeEnv} data=${instance.config.dataDir}`)
    if (instance.config.isProduction) console.log(`[multipush] web=${instance.config.webDist}`)
  })
  .catch((error: unknown) => {
    console.error('[multipush] failed to start server:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[multipush] received ${signal}, shutting down…`)
  const forceTimer = setTimeout(() => {
    console.error('[multipush] forced shutdown after timeout')
    process.exit(1)
  }, 12_000)
  forceTimer.unref()
  try {
    await running?.close()
  } catch (error) {
    console.error('[multipush] shutdown error:', error)
  }
  clearTimeout(forceTimer)
  process.exit(exitCode)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('uncaughtException', (error) => {
  console.error('[multipush] uncaught exception:', error)
  void shutdown('uncaughtException', 1)
})
process.on('unhandledRejection', (reason) => {
  console.error('[multipush] unhandled rejection:', reason)
})

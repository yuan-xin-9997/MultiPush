import type { Express } from 'express'
import type { Server } from 'node:http'
import { loadConfig, type AppConfig, type ConfigOverrides } from './config'
import { openDatabase, type Database } from './db'
import { createApp } from './app'

export interface StartedMultiPushServer {
  config: AppConfig
  database: Database
  app: Express
  server: Server
  url: string
  close(): Promise<void>
}

/**
 * Start the API and (in production) the built web app on a single HTTP
 * listener. The desktop client uses this with port 0 and a loopback host so
 * the whole product runs locally without an external service.
 */
export async function startMultiPushServer(overrides: ConfigOverrides = {}): Promise<StartedMultiPushServer> {
  const config = loadConfig(overrides)
  const database = openDatabase(config.dbPath)
  let app: Express
  try {
    app = createApp(config, database)
  } catch (error) {
    database.close()
    throw error
  }

  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(config.port, config.host)
    const onError = (error: Error) => {
      listener.removeListener('listening', onListening)
      try { database.close() } catch { /* ignore */ }
      reject(error)
    }
    const onListening = () => {
      listener.removeListener('error', onError)
      resolve(listener)
    }
    listener.once('error', onError)
    listener.once('listening', onListening)
  })

  const address = server.address()
  const actualPort = address && typeof address === 'object' ? address.port : config.port
  const displayHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host
  const url = config.publicBaseUrl ?? `http://${displayHost}:${actualPort}`

  let closed = false
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        server.closeAllConnections?.()
        resolve()
      }, 8_000)
      timer.unref()
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    try { await app.locals.wechat.close() } catch { /* ignore */ }
    try { await app.locals.douyin.close() } catch { /* ignore */ }
    try { await app.locals.zhihu.close() } catch { /* ignore */ }
    try { database.close() } catch { /* ignore */ }
  }

  return { config, database, app, server, url, close }
}

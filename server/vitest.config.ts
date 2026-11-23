import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: { setupFiles: ['./test/setup.ts'] },
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared'), '@': path.resolve(__dirname, '../web/src') } },
})

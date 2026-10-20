import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // Keep the browser's Host header so rendered media URLs stay reachable
      // through the Vite proxy during development (including LAN access).
      '/api': { target: 'http://127.0.0.1:34080', changeOrigin: false },
      '/uploads': { target: 'http://127.0.0.1:34080', changeOrigin: false },
    },
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
})

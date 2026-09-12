import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '@turbopush/engine';

// Development-only bridge. Production uses Rust -> stdin/stdout, with no listening port.
function localRpc(): Plugin {
  return {
    name: 'local-engine-rpc',
    configureServer(server) {
      const directory = resolve(process.env.TURBOPUSH_DATA_DIR ?? fileURLToPath(new URL('../../.data', import.meta.url)));
      // Native development owns its own sidecar/database; do not open a second Store.
      const service = process.env.TAURI_ENV_PLATFORM ? undefined : new Service(directory);
      server.httpServer?.once('close', () => { void service?.close(); });
      server.middlewares.use('/__rpc', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        const hosts = ['127.0.0.1:1420', 'localhost:1420'];
        if (!hosts.includes(req.headers.host ?? '') || req.headers.origin !== `http://${req.headers.host}` || req.method !== 'POST'
          || req.headers['content-type'] !== 'application/json') {
          res.statusCode = 403; res.end(JSON.stringify({ error: { message: '仅接受本机开发界面的同源JSON请求' } })); return;
        }
        if (!service) { res.statusCode = 503; res.end(JSON.stringify({ error: { message: '请在桌面客户端中使用此功能' } })); return; }
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 1_000_000) throw new Error('请求超过1MB限制');
            chunks.push(Buffer.from(chunk));
          }
          res.end(JSON.stringify(await service.dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: '无效请求或请求超过1MB限制' } }));
        }
      });
    },
  };
}
export default defineConfig({
  plugins: [react(), localRpc()],
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  clearScreen: false,
});

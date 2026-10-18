import { defineConfig, type Plugin, type ViteDevServer, type PreviewServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { Service } from '@turbopush/engine';
import { importImages } from '../../packages/publisher-engine/src/assets.ts';

export function webPort(value = process.env.TURBOPUSH_PORT): number {
  const port = value === undefined ? 34080 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TURBOPUSH_PORT 必须为1至65535的整数');
  return port;
}

function localRpc(): Plugin {
  const install = (server: ViteDevServer | PreviewServer) => {
    const directory = resolve(process.env.TURBOPUSH_DATA_DIR ?? fileURLToPath(new URL('../../.data', import.meta.url)));
    const service = process.env.TAURI_ENV_PLATFORM ? undefined : new Service(directory);
    server.httpServer?.once('close', () => { void service?.close(); });
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__rpc' && req.url !== '/__upload') return next();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      const port = server.httpServer?.address();
      const actualPort = port && typeof port === 'object' ? port.port : webPort();
      const hosts = ["localhost", ...Object.values(networkInterfaces()).flatMap(interfaces => (interfaces ?? []).filter(address => address.family === "IPv4").map(address => address.address))].map(host => `${host}:${actualPort}`);
      const upload = req.url === '/__upload';
      if (!hosts.includes(req.headers.host ?? '') || req.headers.origin !== `http://${req.headers.host}` || req.method !== 'POST'
        || req.headers['content-type'] !== (upload ? 'application/octet-stream' : 'application/json')) {
        res.statusCode = 403; res.end(JSON.stringify({ error: { message: '仅接受本服务Web界面的同源请求' } })); return;
      }
      if (!service) { res.statusCode = 503; res.end(JSON.stringify({ error: { message: '请在桌面客户端中使用此功能' } })); return; }
      let temporary: string | undefined;
      try {
        const chunks: Buffer[] = []; let size = 0;
        const limit = upload ? 10 * 1024 * 1024 : 72 * 1024 * 1024;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > limit) throw new Error('请求超过大小限制');
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        if (upload) {
          temporary = await mkdtemp(join(tmpdir(), 'turbopush-upload-'));
          const png = body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
          const path = join(temporary, png ? 'image.png' : 'image.jpg');
          await writeFile(path, body);
          res.end(JSON.stringify({ result: (await importImages(directory, [path]))[0] }));
        } else {
          res.end(JSON.stringify(await service.dispatch(JSON.parse(body.toString('utf8')))));
        }
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: '无效请求、图片格式错误或超过大小限制' } }));
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    });
  };
  return { name: 'local-engine-rpc', configureServer: install, configurePreviewServer: install };
}
export default defineConfig({
  plugins: [react(), localRpc()],
  server: { port: process.env.TAURI_ENV_PLATFORM ? 1420 : webPort(), strictPort: true, host: process.env.TAURI_ENV_PLATFORM ? '127.0.0.1' : '0.0.0.0' },
  preview: { port: webPort(), strictPort: true, host: '0.0.0.0' },
  clearScreen: false,
});

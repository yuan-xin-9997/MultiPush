import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const env = await readFile('/opt/MultiPush/.env', 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const port = Number(env.match(/^TURBOPUSH_PORT=(\d+)\s*$/m)?.[1] ?? 34080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TURBOPUSH_PORT');
const base = `http://127.0.0.1:${port}`;
let failure;
for (let attempt = 0; attempt < 45; attempt++) {
  try {
    const response = await fetch(base, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`Static HTTP ${response.status}`);
    const rpc = await fetch(`${base}/__rpc`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'jenkins-health', method: 'snapshot' }),
      signal: AbortSignal.timeout(3000),
    });
    const data = await rpc.json();
    if (!rpc.ok || data.error || !Array.isArray(data.result?.accounts)) throw new Error('RPC health check failed');
    console.log(`PASS: MultiPush static page and read-only RPC on port ${port}`);
    process.exit(0);
  } catch (error) { failure = error; await setTimeout(1000); }
}
throw failure;

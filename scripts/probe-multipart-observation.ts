import { chromium } from 'playwright';
import { createServer } from 'node:http';
const server = createServer((request, response) => {
  if (request.method === 'POST') { request.resume(); request.on('end', () => response.end('ok')); }
  else { response.setHeader('Content-Type', 'text/html'); response.end(`<input type="file" id="f"><script>f.onchange=()=>{const d=new FormData();d.append('file',f.files[0]);fetch('/upload',{method:'POST',body:d})}</script>`); }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage();
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable', { maxPostDataSize: 200000 });
  session.on('Network.requestWillBeSent', event => {
    if (event.request.method === 'POST') console.log('cdp', JSON.stringify({ has: event.request.hasPostData, entries: event.request.postDataEntries?.map(entry => ({ bytes: entry.bytes ? Buffer.from(entry.bytes, 'base64').length : null })), raw: event.request.postData?.length }));
  });
  page.on('request', request => { if (request.method() === 'POST') console.log('playwright', request.postDataBuffer()?.length ?? null); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  await page.goto(`http://127.0.0.1:${address.port}`);
  const done = page.waitForResponse(response => response.url().endsWith('/upload'));
  await page.locator('input').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from('binary-file-payload') });
  await done;
} finally { await browser.close(); await new Promise<void>(done => server.close(() => done())); }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { xiaohongshuActionPoint } from '../packages/publisher-engine/src/platforms/xiaohongshu/actions.ts';

test('小红书闭合控件通过真实无障碍按钮名称定位，禁用、重名或遮挡时拒绝', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const mode of ['normal', 'disabled', 'duplicate', 'covered']) {
      const context = await browser.newContext();
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<xhs-publish-btn style="display:block;position:fixed;left:200px;top:200px;width:400px;height:80px"></xhs-publish-btn><script>window.published=0;customElements.define('xhs-publish-btn',class extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:'closed'});root.innerHTML='<button>暂存离开</button><button ${mode === 'disabled' ? 'disabled' : ''}>发布</button>${mode === 'duplicate' ? '<button>发布</button>' : ''}';root.querySelectorAll('button')[1].onclick=()=>window.published++;}});</script>${mode === 'covered' ? '<div style="position:fixed;inset:0;background:white"></div>' : ''}` }));
      const page = await context.newPage();
      await page.goto('https://creator.xiaohongshu.com/publish/publish');
      if (mode === 'normal') {
        const point = await xiaohongshuActionPoint(page, '发布');
        await page.mouse.click(point.x, point.y);
        assert.equal(await page.evaluate('window.published'), 1);
      } else {
        await assert.rejects(xiaohongshuActionPoint(page, '发布'));
        assert.equal(await page.evaluate('window.published'), 0);
      }
      await context.close();
    }
  } finally { await browser.close(); }
});

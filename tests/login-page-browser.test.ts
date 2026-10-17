import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { detectPlatformLogin } from '../packages/publisher-engine/src/platforms/login-status.ts';

test('新版知乎可见头像识别登录；隐藏头像不算登录；小红书短信登录不误报安全验证', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const visible of [true, false]) {
      const context = await browser.newContext();
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<button class="AppHeader-profileEntry" ${visible ? '' : 'style="display:none"'}><img class="AppHeader-profileAvatar" alt="点击打开测试用户的主页"></button>` }));
      const result = await detectPlatformLogin(await context.newPage(), 'zhihu');
      assert.equal(result.status, visible ? 'authenticated' : 'intervention_required');
      await context.close();
    }
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<input placeholder="手机号"><input placeholder="验证码"><button>登 录</button><a>收不到验证码?</a>' }));
    assert.equal((await detectPlatformLogin(await context.newPage(), 'xiaohongshu')).status, 'expired');
    await context.close();
  } finally { await browser.close(); }
});

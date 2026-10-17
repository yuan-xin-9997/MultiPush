import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { confirmWechatPublication } from "../packages/publisher-engine/src/platforms/wechat/publish.ts";

test("公众号等待异步第二次确认并关闭群发通知，各发表按钮仅点击一次", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<div id="root"><div class="weui-desktop-dialog"><div><span>群发通知</span><label><input type="checkbox" checked></label></div><button onclick="first()">发表</button></div></div><script>window.clicks=[];function first(){if(document.querySelector('input').checked)throw Error('notification still on');clicks.push('发表');document.querySelector('#root').innerHTML='';setTimeout(()=>document.querySelector('#root').innerHTML='<div class="weui-desktop-dialog">未开启群发通知<button onclick="second()">继续发表</button></div>',300)}function second(){clicks.push('继续发表');document.querySelector('#root').innerHTML=''}</script>`,
    );
    await confirmWechatPublication(page);
    assert.deepEqual(await page.evaluate("window.clicks"), [
      "发表",
      "继续发表",
    ]);
    await page.setContent(
      '<div class="weui-desktop-dialog"><button>继续发表</button><button>继续发表</button></div>',
    );
    await assert.rejects(confirmWechatPublication(page), /需要人工核对/);
  } finally {
    await browser.close();
  }
});
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWechatPublishedPage } from "../packages/publisher-engine/src/platforms/wechat/publish.ts";
import type { Task } from "../packages/shared/src/index.ts";

test("公众号公开页逐图滚动加载并回读平台转换的 WebP 图片", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  const directory = await mkdtemp(join(tmpdir(), "wechat-public-media-"));
  try {
    const page = await browser.newPage();
    const assets = await page.evaluate(() =>
      ["#125ac5", "#23852d", "#c43b27"].map((color) => {
        const canvas = document.createElement("canvas");
        canvas.width = 120;
        canvas.height = 80;
        const context = canvas.getContext("2d")!;
        context.fillStyle = color;
        context.fillRect(0, 0, 120, 80);
        return {
          png: canvas.toDataURL("image/png").split(",")[1],
          webp: canvas.toDataURL("image/webp").split(",")[1],
        };
      }),
    );
    const paths = await Promise.all(
      assets.map(async (asset, index) => {
        const path = join(directory, `${index}.png`);
        await writeFile(path, Buffer.from(asset.png, "base64"));
        return path;
      }),
    );
    const request = page.context().request;
    Object.defineProperty(request, "get", {
      value: async (value: string) => {
        const url = String(value);
        const asset = assets[Number(new URL(url).pathname.slice(1))];
        return {
          ok: () => true,
          url: () => url,
          headers: () => ({ "content-type": "image/webp" }),
          body: async () => Buffer.from(asset.webp, "base64"),
        };
      },
    });
    await page.route("https://mmbiz.qpic.cn/**", (route) =>
      route.fulfill({
        contentType: "image/webp",
        body: Buffer.from(
          assets[Number(new URL(route.request().url()).pathname.slice(1))].webp,
          "base64",
        ),
      }),
    );
    await page.route("https://mp.weixin.qq.com/s/test", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<h1 id="activity-name">开发测试</h1><div id="js_content">正文${paths.map((_, index) => `<img style="display:block;width:600px;height:400px;margin-top:800px" data-src="https://mmbiz.qpic.cn/${index}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">`).join("")}</div><script>const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting)entry.target.src=entry.target.dataset.src}));document.querySelectorAll('img').forEach(image=>observer.observe(image));</script>`,
      }),
    );
    await page.goto("https://mp.weixin.qq.com/s/test");
    await verifyWechatPublishedPage(page, {
      content: { title: "开发测试", body: "正文", images: paths },
    } as Task);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

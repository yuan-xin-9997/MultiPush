import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { Task } from "../packages/shared/src/index.ts";
import { publishZhihuArticle } from "../packages/publisher-engine/src/platforms/zhihu/publish.ts";

test("知乎实验发布在拦截页面验证：提交、跳转、刷新回读；正文不一致不能成功", async () => {
  const previous = process.env.TURBOPUSH_EXPERIMENTAL_PUBLISH;
  process.env.TURBOPUSH_EXPERIMENTAL_PUBLISH = "1";
  const browser = await chromium.launch({
    headless: true,
    ...((process.env.TURBOPUSH_BROWSER_CHANNEL ??
    (process.platform === "win32" ? "msedge" : undefined))
      ? { channel: process.env.TURBOPUSH_BROWSER_CHANNEL ?? "msedge" }
      : {}),
  });
  try {
    for (const matches of [true, false]) {
      const context = await browser.newContext();
      try {
        let publicReads = 0;
        await context.route("**/*", async (route) => {
          const url = route.request().url();
          if (url === "https://zhuanlan.zhihu.com/p/12345/edit") {
            await route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: '<textarea placeholder="请输入标题（最多 100 个字）">开发测试</textarea><div contenteditable="true" role="textbox">开发测试正文</div><button onclick="location.href=\'/p/12345\'">发布</button>',
            });
          } else if (url === "https://zhuanlan.zhihu.com/p/12345") {
            publicReads++;
            await route.fulfill({
              contentType: "text/html; charset=utf-8",
              body: `<h1 class="Post-Title">开发测试</h1><article class="Post-RichTextContainer">${matches ? "开发测试正文" : "错误正文"}</article>`,
            });
          } else await route.abort();
        });
        const task = {
          resultUrl: "https://zhuanlan.zhihu.com/p/12345/edit",
          content: {
            type: "article",
            title: "开发测试",
            body: "开发测试正文",
            images: [],
            tags: [],
          },
        } as unknown as Task;
        let submitted = 0;
        const action = publishZhihuArticle(context, task, () => {
          submitted++;
        });
        if (matches)
          assert.equal(
            (await action).url,
            "https://zhuanlan.zhihu.com/p/12345",
          );
        else await assert.rejects(action, /正文不一致/);
        assert.equal(submitted, 1);
        assert.equal(publicReads, 2, "必须刷新发布页后核对");
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    if (previous === undefined)
      delete process.env.TURBOPUSH_EXPERIMENTAL_PUBLISH;
    else process.env.TURBOPUSH_EXPERIMENTAL_PUBLISH = previous;
  }
});

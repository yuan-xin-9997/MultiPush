import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Service } from "../packages/publisher-engine/src/service.ts";

if (process.env.TURBOPUSH_LIVE_DRAFT_TEST !== "1")
  throw new Error(
    "此脚本写入真实公众号测试草稿，需要 TURBOPUSH_LIVE_DRAFT_TEST=1",
  );
const service = new Service(resolve(process.env.TURBOPUSH_DATA_DIR ?? ".data"));
try {
  const account = service.store
    .accounts()
    .find((a) => a.platform === "wechat-official");
  if (!account) throw new Error("请先登录公众号验证账号");
  const media = process.env.TURBOPUSH_TEST_MEDIA === "1";
  const markdown = process.env.TURBOPUSH_TEST_MARKDOWN === "1";
  const title = markdown
    ? "TurboPushForked 公众号Markdown草稿集成验证"
    : media
      ? "TurboPushForked 公众号图文草稿集成验证"
      : "TurboPushForked 公众号草稿集成验证";
  const content =
    service.store.contents().find((c) => c.title === title) ??
    service.store.createContent({
      type: "article",
      ...(media
        ? {
            images: [resolve("apps/desktop/src-tauri/icons/icon.png")],
            cover: resolve("apps/desktop/src-tauri/icons/icon.png"),
          }
        : {}),
      title,
      author: "开发验证",
      summary: "仅测试草稿保存与回读，不公开发布。",
      body: "这是 TurboPushForked 开发测试草稿。\n\n验证任务接口、标题、作者、摘要、正文、保存确认与远端回读。\n\n不公开发布，不群发。",
      ...(markdown
        ? {
            bodyFormat: "markdown" as const,
            body: "## 排版验证\n\n这是 **加粗** 和 *斜体*。\n\n- 第一项\n- 第二项\n\n> 仅保存草稿，不公开发布。\n\n```js\nconst draft = true;\n```",
          }
        : {}),
    });
  const task =
    service.store
      .tasks()
      .find((t) => t.content.id === content.id && t.accountId === account.id) ??
    service.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0];
  if (task.status !== "draft_saved") {
    const response = await service.dispatch({
      id: "save",
      method: "task.saveDraft",
      params: { id: task.id },
    });
    assert.equal(response.error, undefined, response.error?.message);
  }
  const saved = service.store.task(task.id);
  assert.equal(saved.status, "draft_saved");
  assert.ok(saved.resultUrl && !saved.resultUrl.includes("token"));
  assert.equal(
    (
      await service.dispatch({
        id: "duplicate",
        method: "task.saveDraft",
        params: { id: task.id },
      })
    ).error?.code,
    "OPERATION_FAILED",
  );
  assert.equal(
    (
      await service.dispatch({
        id: "open",
        method: "task.openDraft",
        params: { id: task.id },
      })
    ).error,
    undefined,
  );
  console.log(
    JSON.stringify({
      status: saved.status,
      url: saved.resultUrl,
      duplicateBlocked: true,
      reopened: true,
    }),
  );
  if (markdown) {
    const context = await service.browsers.open(account);
    const page = context.pages().at(-1)!;
    const structure = await page
      .locator(".rich_media_content .ProseMirror")
      .evaluate((el) => ({
        headings: el.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
        strong: el.querySelectorAll("strong,b").length,
        emphasis: el.querySelectorAll("em,i").length,
        items: el.querySelectorAll("li").length,
        quotes: el.querySelectorAll("blockquote").length,
        code: el.querySelectorAll("pre,code").length,
      }));
    console.log(JSON.stringify({ markdownStructure: structure }));
    assert.ok(
      structure.headings &&
        structure.strong &&
        structure.emphasis &&
        structure.items === 2 &&
        structure.quotes &&
        structure.code,
    );
    console.log(JSON.stringify(await service.browsers.capture(account.id)));
  }
} finally {
  await service.close();
}

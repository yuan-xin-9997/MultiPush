import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Service } from "../packages/publisher-engine/src/service.ts";
import type { Task } from "../packages/shared/src/index.ts";

if (process.env.TURBOPUSH_LIVE_DRAFT_TEST !== "1")
  throw new Error(
    "此脚本会写入真实知乎草稿，请显式设置 TURBOPUSH_LIVE_DRAFT_TEST=1 后运行",
  );
const service = new Service(resolve(process.env.TURBOPUSH_DATA_DIR ?? ".data"));
try {
  const account = service.store.accounts().find((a) => a.platform === "zhihu");
  if (!account) throw new Error("请先创建并登录知乎账号");
  const markdown = process.env.TURBOPUSH_TEST_MARKDOWN === "1";
  const media = process.env.TURBOPUSH_TEST_MEDIA === "1";
  const topics = process.env.TURBOPUSH_TEST_TOPICS === "1";
  const title = topics
    ? "TurboPushForked 知乎话题草稿集成验证"
    : media
      ? "TurboPushForked 知乎图文草稿集成验证"
      : markdown
        ? "TurboPushForked 知乎Markdown草稿集成验证"
        : "TurboPushForked 知乎草稿集成验证";
  const content =
    service.store.contents().find((c) => c.title === title) ??
    service.store.createContent({
      type: "article",
      ...(topics ? { tags: ["软件开发", "软件测试"] } : {}),
      ...(media
        ? {
            images: [resolve("apps/desktop/src-tauri/icons/icon.png")],
            cover: resolve("apps/desktop/src-tauri/icons/icon.png"),
          }
        : {}),
      ...(markdown ? { bodyFormat: "markdown" as const } : {}),
      title,
      body: markdown
        ? "## Markdown排版验证\n\n这是 **加粗** 和 *斜体*。\n\n- 第一项\n- 第二项\n\n> 仅保存草稿，不公开发布。\n\n```js\nconst draft = true;\n```"
        : "这是 TurboPushForked 的开发验证草稿。\n\n本次验证覆盖任务创建、独立账号浏览器、标题与正文分别保存、刷新回读和数据库记录。\n\n不会公开发布，测试完成后可以手动删除。",
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
      id: "live-draft",
      method: "task.saveDraft",
      params: { id: task.id },
    });
    assert.equal(response.error, undefined, response.error?.message);
    assert.equal((response.result as Task).status, "draft_saved");
  }
  const saved = service.store.task(task.id);
  assert.ok(saved.resultUrl);
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
  const screenshot = await service.browsers
    .capture(account.id)
    .catch(() => undefined);
  console.log(
    JSON.stringify({
      taskId: saved.id,
      status: saved.status,
      url: saved.resultUrl,
      duplicateBlocked: true,
      screenshot,
    }),
  );
} finally {
  await service.close();
}

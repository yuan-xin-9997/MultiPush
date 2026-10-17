import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../packages/publisher-engine/src/service.ts";

test("小红书图文通过已验证能力门进入独立异步草稿执行路径", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-xhs-contract-"));
  const image = join(dir, "image.png");
  const secondImage = join(dir, "image-2.png");
  await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(
    secondImage,
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
  );
  let executedPlatform = "";
  const service = new Service(dir, {
    draftExecutor: async (task, { markExternalWrite }) => {
      executedPlatform = task.platform;
      markExternalWrite();
      return { url: "https://creator.xiaohongshu.com/publish/publish" };
    },
  });
  try {
    const account = service.store.createAccount({
      platform: "xiaohongshu",
      name: "安全契约",
    });
    const content = service.store.createContent({
      type: "gallery",
      title: "只读验证",
      body: "不得写入平台",
      images: [image, secondImage],
    });
    const preflightTask = service.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0];
    const task = service.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0];
    const preflight = await service.dispatch({
      id: "preflight",
      method: "task.preflight",
      params: { id: preflightTask.id },
    });
    assert.equal(preflight.error, undefined);
    assert.match(
      service.store.task(preflightTask.id).message,
      /小红书图文本地检查通过/,
    );
    const response = await service.dispatch({
      id: "enqueue",
      method: "task.enqueueDraft",
      params: { id: task.id },
    });
    assert.equal(response.error, undefined);
    assert.equal((response.result as { queued: boolean }).queued, true);
    for (let index = 0; index < 100; index += 1) {
      if (service.store.task(task.id).status === "draft_saved") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(executedPlatform, "xiaohongshu");
    assert.equal(service.store.task(task.id).status, "draft_saved");
    assert.equal(
      service.store.task(task.id).resultUrl,
      "https://creator.xiaohongshu.com/publish/publish",
    );
    assert.match(service.store.task(task.id).message, /草稿已保存并回读一致/);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("小红书暂存后逐图身份未知时异步任务不得标为 draft_saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-xhs-unknown-"));
  const first = join(dir, "first.png");
  const second = join(dir, "second.png");
  await writeFile(first, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  await writeFile(second, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const service = new Service(dir, {
    draftExecutor: async (_task, { markExternalWrite }) => {
      markExternalWrite();
      throw new Error("已执行暂存但无法核验远端逐图身份");
    },
  });
  try {
    const account = service.store.createAccount({
      platform: "xiaohongshu", name: "结果未知契约",
    });
    const content = service.store.createContent({
      type: "gallery", title: "身份未知", body: "正文", images: [first, second],
    });
    const task = service.store.createCampaign({
      contentId: content.id, accountIds: [account.id],
    })[0];
    const response = await service.dispatch({
      id: "enqueue-unknown", method: "task.enqueueDraft", params: { id: task.id },
    });
    assert.equal(response.error, undefined);
    for (let index = 0; index < 100; index += 1) {
      if (service.store.task(task.id).status === "intervention_required") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(service.store.task(task.id).status, "intervention_required");
    assert.notEqual(service.store.task(task.id).status, "draft_saved");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

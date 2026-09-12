import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../packages/publisher-engine/src/service.ts";
import {
  douyinVideoPolicy,
  validateDouyinVideo,
} from "../packages/publisher-engine/src/platforms/douyin/schema.ts";
import {
  QueueFailure,
  TaskQueue,
} from "../packages/publisher-engine/src/task-queue.ts";

const input = (video: string) => ({
  id: "content",
  createdAt: new Date(0).toISOString(),
  type: "video" as const,
  title: "纯本地契约",
  body: "禁止公开发布",
  images: [],
  video,
  summary: "",
  author: "",
  tags: [],
});

async function videoFile(path: string, brand = "isom", size = 32) {
  const handle = await open(path, "w");
  await handle.write(Buffer.from(`\0\0\0\u0018ftyp${brand}`, "binary"), 0);
  await handle.truncate(size);
  await handle.close();
}

test("MP4/MOV必须为签名匹配的真实绝对文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-video-"));
  try {
    const mp4 = join(dir, "video.mp4");
    const mov = join(dir, "video.mov");
    await videoFile(mp4, "isom");
    await videoFile(mov, "qt  ");
    assert.equal(
      (await validateDouyinVideo(input(mp4))).video.extension,
      ".mp4",
    );
    assert.equal(
      (await validateDouyinVideo(input(mov))).video.extension,
      ".mov",
    );
    await assert.rejects(
      validateDouyinVideo(input("relative.mp4")),
      /绝对路径/,
    );
    await assert.rejects(
      validateDouyinVideo(input(join(dir, "missing.mp4"))),
      /真实本地文件/,
    );
    await assert.rejects(
      validateDouyinVideo(input(dir)),
      /MP4\/MOV|真实本地文件/,
    );
    const fake = join(dir, "fake.mp4");
    await writeFile(fake, "not a video file");
    await assert.rejects(validateDouyinVideo(input(fake)), /文件签名/);
    const mismatch = join(dir, "mismatch.mov");
    await videoFile(mismatch, "isom");
    await assert.rejects(
      validateDouyinVideo(input(mismatch)),
      /扩展名.*不一致/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("1GB精确边界接受，超过1字节立即拒绝且不读取整文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-size-"));
  try {
    const exact = join(dir, "exact.mp4");
    const oversized = join(dir, "oversized.mp4");
    await videoFile(exact, "isom", douyinVideoPolicy.maxVideoBytes);
    await videoFile(oversized, "isom", douyinVideoPolicy.maxVideoBytes + 1);
    assert.equal(
      (await validateDouyinVideo(input(exact))).video.size,
      douyinVideoPolicy.maxVideoBytes,
    );
    await assert.rejects(validateDouyinVideo(input(oversized)), /1GB安全上限/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("抖音已验证私密草稿能力可进入异步执行且注入执行器不打开浏览器", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-disabled-"));
  const video = join(dir, "video.mp4");
  await videoFile(video);
  let executed = 0;
  const service = new Service(dir, { draftExecutor: async (_task, context) => {
    executed += 1;
    context.markExternalWrite();
    return { url: "https://creator.douyin.com/creator-micro/content/upload" };
  }});
  try {
    const account = service.store.createAccount({
      platform: "douyin",
      name: "契约",
    });
    const content = service.store.createContent({
      type: "video",
      title: "纯本地契约",
      body: "禁止公开发布",
      video,
    });
    const task = service.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0];
    let opened = false;
    service.browsers.open = async () => {
      opened = true;
      throw new Error("不得打开浏览器");
    };
    const response = await service.dispatch({ id: 1, method: "task.enqueueDraft", params: { id: task.id } });
    assert.equal(response.error, undefined);
    for (let attempt = 0; attempt < 50 && service.store.task(task.id).status !== "draft_saved"; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(executed, 1);
    assert.equal(opened, false);
    assert.equal(service.store.task(task.id).status, "draft_saved");
    assert.equal(service.store.hasDraftAttempt(task.id), true);
    assert.equal(douyinVideoPolicy.delivery, "draft_only");
    assert.equal(douyinVideoPolicy.publicPublish, false);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("外部草稿结果未知时TaskQueue绝不自动重试", async () => {
  let attempts = 0;
  const queue = new TaskQueue();
  queue.start();
  const outcome = await queue.enqueue({
    id: "douyin-unknown",
    accountId: "douyin-account",
    run: async () => {
      attempts += 1;
      throw new QueueFailure("视频草稿结果未知", "unknown");
    },
  });
  assert.equal(outcome.state, "failed");
  if (outcome.state === "failed") assert.equal(outcome.kind, "unknown");
  assert.equal(attempts, 1);
});

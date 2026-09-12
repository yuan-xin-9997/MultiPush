import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  douyinVideoContent,
  douyinVideoPolicy,
  validateDouyinVideo,
} from "../packages/publisher-engine/src/platforms/douyin/schema.ts";
import { Service } from "../packages/publisher-engine/src/service.ts";

const mp4Header = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);

function videoContent(video: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    createdAt: "2030-01-01T00:00:00.000Z",
    type: "video",
    title: "抖音本地预检",
    body: "正文",
    bodyFormat: "plain",
    images: [],
    video,
    summary: "",
    author: "",
    tags: ["测试"],
    ...overrides,
  } as any;
}

test("抖音首版接受签名与扩展名一致的本地MP4且明确禁止公开发布", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-"));
  try {
    const path = join(dir, "video.mp4");
    await writeFile(path, mp4Header);
    const result = await validateDouyinVideo(videoContent(path));
    assert.equal(result.content.video, path);
    assert.match(result.message, /未来保存私有草稿.*禁止公开发布/);
    assert.equal(douyinVideoPolicy.delivery, "draft_only");
    assert.equal(douyinVideoPolicy.publicPublish, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("抖音视频schema拒绝图文混入、独立封面和Markdown", () => {
  assert.throws(() => douyinVideoContent.parse(videoContent("x", { images: ["a.png"] })));
  assert.throws(() => douyinVideoContent.parse(videoContent("x", { cover: "cover.png" })));
  assert.throws(() => douyinVideoContent.parse(videoContent("x", { bodyFormat: "markdown" })));
});

test("抖音视频预检拒绝相对路径、伪装容器和超过1GB的普通文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-guard-"));
  try {
    await assert.rejects(validateDouyinVideo(videoContent("relative.mp4")), /绝对路径/);
    const fake = join(dir, "fake.mp4");
    await writeFile(fake, "not-an-mp4");
    await assert.rejects(validateDouyinVideo(videoContent(fake)), /MP4\/MOV文件签名/);
    const oversized = join(dir, "oversized.mp4");
    await writeFile(oversized, mp4Header);
    await truncate(oversized, 1024 * 1024 * 1024 + 1);
    await assert.rejects(validateDouyinVideo(videoContent(oversized)), /1GB/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Service执行抖音本地预检，已验证能力门允许队列私密草稿", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-service-"));
  const video = join(dir, "video.mp4");
  await writeFile(video, mp4Header);
  let executed = false;
  const service = new Service(dir, { draftExecutor: async (task, context) => {
    executed = true;
    assert.equal(task.platform, "douyin");
    context.markExternalWrite();
    return { url: "https://creator.douyin.com/creator-micro/content/upload" };
  }});
  try {
    const account = service.store.createAccount({ platform: "douyin", name: "抖音" });
    const content = service.store.createContent({
      type: "video",
      title: "抖音骨架",
      body: "正文",
      video,
    });
    const preflightTask = service.store.createCampaign({ contentId: content.id, accountIds: [account.id] })[0];
    const queuedTask = service.store.createCampaign({ contentId: content.id, accountIds: [account.id] })[0];
    let opened = false;
    service.browsers.open = async () => {
      opened = true;
      throw new Error("不应打开浏览器");
    };
    const preflight = await service.dispatch({ id: 1, method: "task.preflight", params: { id: preflightTask.id } });
    assert.equal(preflight.error, undefined);
    assert.match(service.store.task(preflightTask.id).message, /抖音视频本地检查通过/);
    const response = await service.dispatch({ id: 2, method: "task.enqueueDraft", params: { id: queuedTask.id } });
    assert.equal(response.error, undefined);
    for (let attempt = 0; attempt < 50 && service.store.task(queuedTask.id).status !== "draft_saved"; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(executed, true);
    assert.equal(service.store.task(queuedTask.id).status, "draft_saved");
    assert.equal(opened, false);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

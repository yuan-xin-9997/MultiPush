import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imagePayload } from "../packages/publisher-engine/src/platforms/wechat/media.ts";
import { validateWechatContent } from "../packages/publisher-engine/src/platforms/wechat/draft.ts";
import { validateZhihuContent } from "../packages/publisher-engine/src/platforms/zhihu/draft.ts";
import {
  sequentialUploadTimeoutRisk,
  uploadImagesSequentially,
} from "../packages/publisher-engine/src/platforms/upload-sequence.ts";

const article = (images: string[]) => ({
  type: "article" as const,
  title: "专项测试",
  body: "正文",
  bodyFormat: "plain" as const,
  images,
  video: undefined,
  cover: undefined,
  author: "",
  summary: "",
});

test("公众号和知乎接受0/1/多张/20张并在21张时同步拒绝", () => {
  for (const count of [0, 1, 3, 20]) {
    const content = article(Array.from({ length: count }, (_, i) => `${i}.png`));
    assert.doesNotThrow(() => validateWechatContent(content));
    assert.doesNotThrow(() => validateZhihuContent(content));
  }
  const tooMany = article(Array.from({ length: 21 }, (_, i) => `${i}.png`));
  assert.throws(() => validateWechatContent(tooMany), /最多20张/);
  assert.throws(() => validateZhihuContent(tooMany), /最多20张/);
});

test("图片格式按文件签名识别，10MB边界接受而超1字节拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-image-boundary-"));
  try {
    const png = join(dir, "valid.bin");
    await writeFile(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal((await imagePayload(png)).mimeType, "image/png");

    const jpeg = join(dir, "valid.dat");
    await writeFile(jpeg, Buffer.from([255, 216, 255, 0]));
    assert.equal((await imagePayload(jpeg)).mimeType, "image/jpeg");

    const exact = join(dir, "exact.png");
    const exactHandle = await open(exact, "w");
    await exactHandle.write(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 0);
    await exactHandle.truncate(10 * 1024 * 1024);
    await exactHandle.close();
    assert.equal((await imagePayload(exact)).buffer.length, 10 * 1024 * 1024);

    const oversized = join(dir, "oversized.jpg");
    const largeHandle = await open(oversized, "w");
    await largeHandle.write(Buffer.from([255, 216, 255]), 0);
    await largeHandle.truncate(10 * 1024 * 1024 + 1);
    await largeHandle.close();
    await assert.rejects(imagePayload(oversized), /10MB以内/);

    const disguised = join(dir, "disguised.png");
    await writeFile(disguised, "not an image");
    await assert.rejects(imagePayload(disguised), /仅支持PNG\/JPEG/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("慢响应快速模拟仍逐张等待并保持20张顺序", async () => {
  const seen: number[] = [];
  let concurrent = 0;
  let peak = 0;
  await uploadImagesSequentially(
    Array.from({ length: 20 }, (_, i) => i),
    async (image) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 2));
      seen.push(image);
      concurrent -= 1;
    },
  );
  assert.deepEqual(seen, Array.from({ length: 20 }, (_, i) => i));
  assert.equal(peak, 1);
});

test("150秒RPC窗口风险按逐张45秒等待快速建模", () => {
  assert.deepEqual(sequentialUploadTimeoutRisk(1), {
    worstCaseMs: 45_000,
    exceedsRpcTimeout: false,
  });
  assert.equal(sequentialUploadTimeoutRisk(3).exceedsRpcTimeout, false);
  assert.deepEqual(sequentialUploadTimeoutRisk(20), {
    worstCaseMs: 900_000,
    exceedsRpcTimeout: true,
  });
});

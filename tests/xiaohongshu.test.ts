import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateXiaohongshuGallery,
  xiaohongshuGalleryContent,
  xiaohongshuGalleryPolicy,
} from "../packages/publisher-engine/src/platforms/xiaohongshu/schema.ts";
import { importImages } from "../packages/publisher-engine/src/assets.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const jpeg = Buffer.from([255, 216, 255, 0]);

function content(images: string[], overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    createdAt: "2030-01-01T00:00:00.000Z",
    type: "gallery",
    title: "本地草稿测试",
    body: "正文",
    bodyFormat: "plain",
    images,
    summary: "",
    author: "",
    tags: ["旅行", "摄影"],
    ...overrides,
  } as any;
}

test("小红书图文接受2到18张本地PNG/JPEG，公开发布必须单独确认", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-xhs-"));
  try {
    const pngPath = join(directory, "one.png");
    const jpgPath = join(directory, "two.jpg");
    await writeFile(pngPath, png);
    await writeFile(jpgPath, jpeg);
    const minimum = await validateXiaohongshuGallery(content([pngPath, jpgPath]));
    assert.equal(minimum.images.length, 2);
    assert.match(minimum.message, /公开发布需要单独确认/);
    assert.equal(xiaohongshuGalleryPolicy.delivery, "manual_publication_experimental");

    const maximumPaths = [];
    for (let index = 0; index < 18; index += 1) {
      const path = join(directory, `unique-${index}.png`);
      await writeFile(path, Buffer.concat([png, Buffer.from([index])]));
      maximumPaths.push(path);
    }
    const maximum = await validateXiaohongshuGallery(content(maximumPaths));
    assert.equal(maximum.images.length, 18);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("校验保持图片顺序、按magic识别MIME并拒绝重复字节", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-xhs-order-"));
  try {
    const jpegNamedPng = join(directory, "first.png");
    const pngNamedJpeg = join(directory, "second.jpg");
    await writeFile(jpegNamedPng, jpeg);
    await writeFile(pngNamedJpeg, png);
    const checked = await validateXiaohongshuGallery(
      content([jpegNamedPng, pngNamedJpeg]),
    );
    assert.deepEqual(
      checked.images.map((image) => image.mimeType),
      ["image/jpeg", "image/png"],
    );
    await assert.rejects(
      validateXiaohongshuGallery(content([jpegNamedPng, jpegNamedPng])),
      /图片内容不能重复/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("托管素材删除源文件后仍可按原顺序验证，旧机器路径保守失败", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-xhs-managed-"));
  try {
    const first = join(directory, "source-a.png");
    const second = join(directory, "source-b.jpg");
    await writeFile(first, png);
    await writeFile(second, jpeg);
    const managed = await importImages(directory, [second, first]);
    await rm(first);
    await rm(second);
    const checked = await validateXiaohongshuGallery(content(managed));
    assert.deepEqual(
      checked.images.map((image) => image.mimeType),
      ["image/jpeg", "image/png"],
    );
    const foreignPath = process.platform === "win32" ? "/old-machine/image.png" : "C:\\old-machine\\image.png";
    await assert.rejects(
      validateXiaohongshuGallery(content([managed[0]!, foreignPath])),
      /第2张图片本地验证失败/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("图片组总大小受本项目50MB安全上限约束", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-xhs-total-"));
  try {
    const paths = [];
    for (let index = 0; index < 6; index += 1) {
      const bytes = Buffer.alloc(9 * 1024 * 1024, index);
      png.copy(bytes, 0);
      const path = join(directory, `large-${index}.png`);
      await writeFile(path, bytes);
      paths.push(path);
    }
    await assert.rejects(
      validateXiaohongshuGallery(content(paths)),
      /图片总大小超过.*50MB/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("首版项目安全上限拒绝图片数量、文本、标签和混入视频", () => {
  assert.throws(() => xiaohongshuGalleryContent.parse(content(["a"])), /至少需要2张/);
  assert.throws(
    () => xiaohongshuGalleryContent.parse(content(Array(19).fill("a"))),
    /最多接受18张/,
  );
  assert.throws(
    () => xiaohongshuGalleryContent.parse(content(["a", "b"], { title: "题".repeat(51) })),
    /20字安全上限/,
  );
  assert.throws(
    () => xiaohongshuGalleryContent.parse(content(["a", "b"], { body: "文".repeat(3001) })),
    /1000字安全上限/,
  );
  assert.throws(
    () => xiaohongshuGalleryContent.parse(content(["a", "b"], { tags: ["旅行", "旅行"] })),
    /不能重复/,
  );
  assert.throws(
    () => xiaohongshuGalleryContent.parse(content(["a", "b"], { video: "clip.mp4" })),
  );
  assert.throws(
    () => xiaohongshuGalleryContent.parse(content(["a", "b"], { bodyFormat: "markdown" })),
  );
});

test("非法素材在调用方打开浏览器之前失败", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-xhs-"));
  try {
    const valid = join(directory, "valid.png");
    const fake = join(directory, "fake.jpg");
    await writeFile(valid, png);
    await writeFile(fake, "not-an-image");
    let browserOpened = false;
    const validateThenOpen = async (value: ReturnType<typeof content>) => {
      await validateXiaohongshuGallery(value);
      browserOpened = true;
    };
    await assert.rejects(validateThenOpen(content([valid, fake])), /PNG\/JPEG/);
    assert.equal(browserOpened, false);
    await assert.rejects(validateThenOpen(content([valid, "relative.jpg"])), /绝对路径/);
    assert.equal(browserOpened, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

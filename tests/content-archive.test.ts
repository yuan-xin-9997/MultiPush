import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../packages/publisher-engine/src/service.ts";

const png = (size = 32, marker = 0) => {
  const buffer = Buffer.alloc(size, marker);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  return buffer;
};
const asset = (buffer: Buffer, mimeType: "image/png" | "image/jpeg" = "image/png") => ({
  hash: createHash("sha256").update(buffer).digest("hex"),
  mimeType,
  data: buffer.toString("base64"),
});
const content = (references: string[] = []) => ({
  type: "article" as const,
  title: "迁移测试",
  body: "正文",
  images: references,
});
const files = async (directory: string) =>
  readdir(join(directory, "assets")).catch(() => [] as string[]);

test("跨data目录导出、删除源目录后导入会重建素材且保持字节", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "turbopush-archive-source-"));
  const targetDir = await mkdtemp(join(tmpdir(), "turbopush-archive-target-"));
  const original = png(128, 7);
  const sourceImage = join(sourceDir, "source.png");
  await writeFile(sourceImage, original);
  const source = new Service(sourceDir);
  const created = source.store.createContent({
    ...content([sourceImage, sourceImage]),
    cover: sourceImage,
  });
  const exported = await source.dispatch({
    id: 1,
    method: "content.exportPortable",
    params: { ids: [created.id] },
  });
  assert.equal(exported.error, undefined);
  const archive = exported.result as {
    version: 2;
    contents: Array<{ images: string[]; cover?: string }>;
    assets: Array<{ hash: string }>;
  };
  assert.equal(archive.assets.length, 1, "重复正文图和封面只打包一份");
  assert.equal(new Set([...archive.contents[0]!.images, archive.contents[0]!.cover]).size, 1);
  await source.close();
  await rm(sourceDir, { recursive: true, force: true });

  const target = new Service(targetDir);
  try {
    const imported = await target.dispatch({
      id: 2,
      method: "content.import",
      params: archive,
    });
    assert.equal(imported.error, undefined);
    const restored = target.store.contents()[0]!;
    assert.notEqual(restored.images[0], sourceImage);
    assert.equal(restored.images[0], restored.images[1]);
    assert.equal(restored.images[0], restored.cover);
    assert.deepEqual(await readFile(restored.images[0]!), original);
  } finally {
    await target.close();
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("篡改哈希、伪装MIME、缺失素材及非法路径全部整批失败", async () => {
  const good = asset(png(32, 1));
  const badCases = [
    {
      name: "篡改hash",
      archive: { version: 2, contents: [content([`asset:${"0".repeat(64)}`])], assets: [{ ...good, hash: "0".repeat(64) }] },
    },
    {
      name: "伪装MIME",
      archive: { version: 2, contents: [content([`asset:${good.hash}`])], assets: [{ ...good, mimeType: "image/jpeg" }] },
    },
    {
      name: "缺失素材",
      archive: { version: 2, contents: [content([`asset:${good.hash}`])], assets: [] },
    },
    {
      name: "相对路径",
      archive: { version: 2, contents: [content(["../relative.png"])], assets: [good] },
    },
    {
      name: "绝对逃逸路径",
      archive: { version: 2, contents: [content(["C:\\outside.png"])], assets: [good] },
    },
  ];
  for (const { name, archive } of badCases) {
    const dir = await mkdtemp(join(tmpdir(), "turbopush-archive-invalid-"));
    const service = new Service(dir);
    try {
      const response = await service.dispatch({ id: name, method: "content.import", params: archive });
      assert.ok(response.error, name);
      assert.equal(service.store.contents().length, 0, name);
      assert.deepEqual(await files(dir), [], name);
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("单文件、总包及内容数量上限越界均无部分导入", async () => {
  const oversized = asset(png(10 * 1024 * 1024 + 1, 2));
  const totalAssets = Array.from({ length: 6 }, (_, index) => asset(png(9 * 1024 * 1024, index + 1)));
  const cases = [
    {
      version: 2,
      contents: [content([`asset:${oversized.hash}`])],
      assets: [oversized],
    },
    {
      version: 2,
      contents: [content(totalAssets.map((item) => `asset:${item.hash}`))],
      assets: totalAssets,
    },
    {
      version: 2,
      contents: Array.from({ length: 101 }, () => content()),
      assets: [],
    },
  ];
  for (const archive of cases) {
    const dir = await mkdtemp(join(tmpdir(), "turbopush-archive-limit-"));
    const service = new Service(dir);
    try {
      const response = await service.dispatch({ id: 1, method: "content.import", params: archive });
      assert.ok(response.error);
      assert.equal(service.store.contents().length, 0);
      assert.deepEqual(await files(dir), []);
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("version1兼容导入仅保留路径，不创建或打包素材", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-archive-v1-"));
  const service = new Service(dir);
  try {
    const response = await service.dispatch({
      id: 1,
      method: "content.import",
      params: { version: 1, contents: [content(["D:\\legacy\\image.png"])] },
    });
    assert.equal(response.error, undefined);
    assert.deepEqual(service.store.contents()[0]?.images, ["D:\\legacy\\image.png"]);
    assert.deepEqual(await files(dir), []);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Service } from "../packages/publisher-engine/src/service.ts";

test("invalid article image is rejected before browser open or write-attempt checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-media-guard-"));
  const service = new Service(dir);
  try {
    for (const platform of ["zhihu", "wechat-official"]) {
      const account = service.store.createAccount({ platform, name: "测试" });
      const content = service.store.createContent({
        type: "article",
        title: "测试",
        body: "正文",
        images: [join(dir, "missing.png")],
      });
      const task = service.store.createCampaign({
        contentId: content.id,
        accountIds: [account.id],
      })[0];
      let opened = false;
      service.browsers.open = async () => {
        opened = true;
        throw new Error("不应打开浏览器");
      };
      const response = await service.dispatch({
        id: 1,
        method: "task.saveDraft",
        params: { id: task.id },
      });
      assert.ok(response.error);
      assert.equal(opened, false);
      assert.equal(service.store.hasDraftAttempt(task.id), false);
      assert.equal(service.store.task(task.id).status, "pending");
    }
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("content import is atomic, preserves Markdown, and does not create tasks or accounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-import-"));
  const service = new Service(dir);
  try {
    const valid = {
      type: "article",
      title: "导入测试",
      body: "**正文**",
      bodyFormat: "markdown",
    };
    const bad = await service.dispatch({
      id: 1,
      method: "content.import",
      params: { version: 1, contents: [valid, { ...valid, title: "" }] },
    });
    assert.equal(bad.error?.code, "VALIDATION_ERROR");
    assert.equal(service.store.contents().length, 0);
    const good = await service.dispatch({
      id: 2,
      method: "content.import",
      params: { version: 1, contents: [valid] },
    });
    assert.equal(good.error, undefined);
    const content = service.store.contents()[0];
    assert.equal(content.bodyFormat, "markdown");
    const updated = await service.dispatch({
      id: 3,
      method: "content.update",
      params: { id: content.id, content: { ...valid, title: "修改后" } },
    });
    assert.equal(updated.error, undefined);
    assert.equal(service.store.contents()[0].title, "修改后");
    assert.equal(service.store.tasks().length, 0);
    assert.equal(service.store.accounts().length, 0);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("portable v2 archive deduplicates images and rewrites them into the importing data directory", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "turbopush-export-v2-"));
  const targetDir = await mkdtemp(join(tmpdir(), "turbopush-import-v2-"));
  const sourceService = new Service(sourceDir);
  const targetService = new Service(targetDir);
  try {
    const bytes = await readFile(
      join(process.cwd(), "apps/desktop/src-tauri/icons/icon.png"),
    );
    const selected = join(sourceDir, "selected.png");
    await writeFile(selected, bytes);
    const first = sourceService.store.createContent({
      type: "article",
      title: "跨机器一",
      body: "正文",
      images: [selected, selected],
      cover: selected,
    });
    const second = sourceService.store.createContent({
      type: "article",
      title: "跨机器二",
      body: "正文",
      images: [selected],
    });
    const exported = await sourceService.dispatch({
      id: 1,
      method: "content.exportPortable",
      params: { ids: [first.id, second.id] },
    });
    assert.equal(exported.error, undefined);
    const archive = exported.result as {
      version: 2;
      contents: Array<{ images: string[]; cover?: string }>;
      assets: Array<{ hash: string; mimeType: string; data: string }>;
    };
    assert.equal(archive.version, 2);
    assert.equal(archive.assets.length, 1);
    assert.equal(
      archive.contents[0]!.images[0],
      archive.contents[1]!.images[0],
    );
    assert.match(archive.contents[0]!.images[0]!, /^asset:[a-f0-9]{64}$/);

    await rm(selected);
    const imported = await targetService.dispatch({
      id: 2,
      method: "content.import",
      params: archive,
    });
    assert.equal(imported.error, undefined);
    const contents = targetService.store.contents();
    assert.equal(contents.length, 2);
    assert.equal(contents[0]!.images[0], contents[1]!.images[0]);
    assert.equal(
      contents.find((item) => item.title === "跨机器一")!.cover,
      contents[0]!.images[0],
    );
    assert.deepEqual(await readFile(contents[0]!.images[0]!), bytes);
    assert.match(contents[0]!.images[0]!, /[\\/]assets[\\/][a-f0-9]{64}\.png$/);
    assert.equal(targetService.store.accounts().length, 0);
    assert.equal(targetService.store.tasks().length, 0);
  } finally {
    await sourceService.close();
    await targetService.close();
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("portable v2 import rejects tampering, duplicate hashes and unsafe references atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-import-v2-guard-"));
  const service = new Service(dir);
  try {
    const bytes = await readFile(
      join(process.cwd(), "apps/desktop/src-tauri/icons/icon.png"),
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const valid = {
      version: 2,
      contents: [
        {
          type: "article",
          title: "安全导入",
          body: "正文",
          images: [`asset:${hash}`],
        },
      ],
      assets: [{ hash, mimeType: "image/png", data: bytes.toString("base64") }],
    };
    for (const archive of [
      {
        ...valid,
        assets: [
          {
            ...valid.assets[0]!,
            data: Buffer.from("tampered").toString("base64"),
          },
        ],
      },
      { ...valid, assets: [valid.assets[0], valid.assets[0]] },
      {
        ...valid,
        contents: [{ ...valid.contents[0]!, images: ["../../escape.png"] }],
      },
      { ...valid, assets: [{ ...valid.assets[0]!, mimeType: "image/jpeg" }] },
    ]) {
      const response = await service.dispatch({
        id: 1,
        method: "content.import",
        params: archive,
      });
      assert.ok(response.error);
      assert.equal(service.store.contents().length, 0);
    }
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("portable file RPC round-trips content and managed images without inline transfer", async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), "turbopush-file-export-"));
  const targetDir = await mkdtemp(join(tmpdir(), "turbopush-file-import-"));
  const archivePath = join(sourceDir, "portable.turbopush.json");
  const sourceService = new Service(sourceDir);
  const targetService = new Service(targetDir);
  try {
    const image = join(process.cwd(), "apps/desktop/src-tauri/icons/icon.png");
    const content = sourceService.store.createContent({
      type: "article",
      title: "文件归档",
      body: "**正文**",
      bodyFormat: "markdown",
      images: [image],
    });
    const exported = await sourceService.dispatch({
      id: 1,
      method: "content.exportPortableFile",
      params: { path: archivePath, ids: [content.id] },
    });
    assert.equal(exported.error, undefined);
    assert.ok((exported.result as { size: number }).size > 0);
    const imported = await targetService.dispatch({
      id: 2,
      method: "content.importPortableFile",
      params: { path: archivePath },
    });
    assert.equal(imported.error, undefined);
    const restored = targetService.store.contents()[0]!;
    assert.equal(restored.title, "文件归档");
    assert.equal(restored.bodyFormat, "markdown");
    assert.match(restored.images[0]!, /[\\/]assets[\\/][a-f0-9]{64}\.png$/);
  } finally {
    await sourceService.close();
    await targetService.close();
    await rm(sourceDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("portable file RPC rejects oversized, relative, and existing targets safely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-file-guard-"));
  const service = new Service(dir);
  try {
    const content = service.store.createContent({
      type: "article",
      title: "文件保护",
      body: "正文",
    });
    for (const method of [
      "content.importPortableFile",
      "content.exportPortableFile",
    ]) {
      const response = await service.dispatch({
        id: 1,
        method,
        params:
          method === "content.importPortableFile"
            ? { path: "relative.json" }
            : { path: "relative.json", ids: [content.id] },
      });
      assert.match(response.error!.message, /绝对路径/);
    }

    const oversized = join(dir, "oversized.json");
    await writeFile(oversized, "");
    await truncate(oversized, 70 * 1024 * 1024 + 1);
    const tooLarge = await service.dispatch({
      id: 2,
      method: "content.importPortableFile",
      params: { path: oversized },
    });
    assert.match(tooLarge.error!.message, /70MB/);

    const existing = join(dir, "existing.json");
    await writeFile(existing, "do-not-overwrite");
    const overwrite = await service.dispatch({
      id: 3,
      method: "content.exportPortableFile",
      params: { path: existing, ids: [content.id] },
    });
    assert.match(overwrite.error!.message, /拒绝覆盖/);
    assert.equal(await readFile(existing, "utf8"), "do-not-overwrite");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("asset RPC returns managed paths that content can persist after source removal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-managed-content-"));
  const service = new Service(dir);
  try {
    const sourceBytes = await readFile(
      join(process.cwd(), "apps/desktop/src-tauri/icons/icon.png"),
    );
    const source = join(dir, "selected.png");
    await writeFile(source, sourceBytes);
    const imported = await service.dispatch({
      id: 1,
      method: "assets.importImages",
      params: { paths: [source] },
    });
    assert.equal(imported.error, undefined);
    const [managed] = imported.result as string[];
    assert.match(managed, /[\\/]assets[\\/][a-f0-9]{64}\.png$/);

    const created = await service.dispatch({
      id: 2,
      method: "content.create",
      params: {
        type: "article",
        title: "托管素材",
        body: "正文",
        images: [managed],
        cover: managed,
      },
    });
    assert.equal(created.error, undefined);
    await rm(source);
    const stored = service.store.contents()[0];
    assert.deepEqual(stored.images, [managed]);
    assert.equal(stored.cover, managed);
    assert.deepEqual(await readFile(managed), sourceBytes);

    const account = service.store.createAccount({
      platform: "wechat-official",
      name: "测试",
    });
    const task = service.store.createCampaign({
      contentId: stored.id,
      accountIds: [account.id],
    })[0];
    const preflight = await service.dispatch({
      id: 3,
      method: "task.preflight",
      params: { id: task.id },
    });
    assert.equal(preflight.error, undefined);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RPC rejects unknown methods and preflight never marks a platform task successful", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-"));
  const service = new Service(dir);
  try {
    assert.equal(
      (await service.dispatch({ id: 1, method: "shell.run", params: {} })).error
        ?.code,
      "VALIDATION_ERROR",
    );
    const a = service.store.createAccount({
      platform: "wechat-official",
      name: "测试",
    });
    const c = service.store.createContent({
      type: "article",
      title: "测试",
      body: "正文",
    });
    const task = service.store.createCampaign({
      contentId: c.id,
      accountIds: [a.id],
    })[0];
    assert.equal(
      (
        await service.dispatch({
          id: 2,
          method: "task.preflight",
          params: { id: task.id },
        })
      ).error,
      undefined,
    );
    assert.equal(service.store.task(task.id).status, "intervention_required");
    service.store.cancel(task.id);
    assert.match(
      (
        await service.dispatch({
          id: 3,
          method: "task.preflight",
          params: { id: task.id },
        })
      ).error!.message,
      /不能/,
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("missing assets fail preflight and account profile paths cannot escape the data directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-service-"));
  const service = new Service(dir);
  try {
    const a = service.store.createAccount({ platform: "douyin", name: "测试" });
    const c = service.store.createContent({
      type: "video",
      title: "测试",
      video: join(dir, "missing.mp4"),
    });
    const task = service.store.createCampaign({
      contentId: c.id,
      accountIds: [a.id],
    })[0];
    assert.match(
      (
        await service.dispatch({
          id: 1,
          method: "task.preflight",
          params: { id: task.id },
        })
      ).error!.message,
      /素材不存在/,
    );
    assert.equal(service.store.task(task.id).status, "pending");
    assert.throws(() => service.browsers.profilePath("../../outside"));
    assert.notEqual(
      service.browsers.profilePath(a.id),
      service.browsers.profilePath(randomUUID()),
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown draft outcomes without a URL are not retried; completed drafts cannot be submitted twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-draft-guard-"));
  const service = new Service(dir);
  try {
    const a = service.store.createAccount({ platform: "zhihu", name: "测试" });
    const c = service.store.createContent({
      type: "article",
      title: "测试",
      body: "正文",
    });
    const task = service.store.createCampaign({
      contentId: c.id,
      accountIds: [a.id],
    })[0];
    service.store.transition(task.id, "publishing", "保存草稿");
    service.store.transition(task.id, "intervention_required", "结果未知");
    let opened = false;
    service.browsers.open = async () => {
      opened = true;
      throw new Error("Browser must not open");
    };
    assert.match(
      (
        await service.dispatch({
          id: 1,
          method: "task.saveDraft",
          params: { id: task.id },
        })
      ).error!.message,
      /避免重复/,
    );
    service.store.transition(task.id, "draft_saved", "已保存");
    assert.match(
      (
        await service.dispatch({
          id: 2,
          method: "task.saveDraft",
          params: { id: task.id },
        })
      ).error!.message,
      /不能保存/,
    );
    assert.equal(opened, false);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("抖音草稿结果可通过严格的账号隔离上下文打开", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-open-"));
  const service = new Service(dir);
  try {
    const account = service.store.createAccount({
      platform: "douyin",
      name: "测试",
    });
    const content = service.store.createContent({
      type: "video",
      title: "测试",
      video: "C:\\video.mp4",
    });
    const task = service.store.createCampaign({
      contentId: content.id,
      accountIds: [account.id],
    })[0];
    const draftUrl = "https://creator.douyin.com/creator-micro/content/upload";
    service.store.checkpointDraft(task.id, draftUrl);
    const visits: string[] = [];
    service.browsers.open = async (openedAccount) => {
      assert.equal(openedAccount.id, account.id);
      return {
        newPage: async () => ({
          goto: async (url: string) => {
            visits.push(url);
          },
        }),
      } as never;
    };
    const response = await service.dispatch({
      id: 1,
      method: "task.openDraft",
      params: { id: task.id },
    });
    assert.equal(response.error, undefined);
    assert.deepEqual(response.result, { opened: true });
    assert.deepEqual(visits, [draftUrl]);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

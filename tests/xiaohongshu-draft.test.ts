import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clickVerifiedXiaohongshuDraftPoint,
  validateXiaohongshuDraftLayout,
  xiaohongshuDraftLayoutVersion,
  validateXiaohongshuPublishUrl,
  xiaohongshuGallerySelectors,
  xiaohongshuPublishUrl,
  saveXiaohongshuDraft,
} from "../packages/publisher-engine/src/platforms/xiaohongshu/draft.ts";

test("小红书图文适配器只信任无凭据无参数的创作入口", () => {
  assert.equal(
    validateXiaohongshuPublishUrl(xiaohongshuPublishUrl),
    xiaohongshuPublishUrl,
  );
  for (const value of [
    "https://creator.xiaohongshu.com.evil.example/publish/publish",
    "https://user:secret@creator.xiaohongshu.com/publish/publish",
    "https://creator.xiaohongshu.com/publish/publish?token=secret",
    "https://creator.xiaohongshu.com/publish",
  ])
    assert.throws(() => validateXiaohongshuPublishUrl(value));
});

async function draftFixture() {
  const directory = await mkdtemp(join(tmpdir(), "turbopush-xhs-draft-"));
  const one = join(directory, "one.png");
  const two = join(directory, "two.png");
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  await writeFile(one, png);
  await writeFile(two, Buffer.concat([png, Buffer.from([1])]));
  return {
    directory,
    content: {
      type: "gallery",
      title: "同标题",
      body: "完整正文",
      bodyFormat: "plain",
      images: [one, two],
      tags: [],
    },
  } as const;
}

test("正式适配器全字段匹配时复用且不上传或暂存", async () => {
  const fixture = await draftFixture();
  const events: string[] = [];
  try {
    const result = await saveXiaohongshuDraft(
      { newPage: async () => ({}) } as any,
      fixture.content as any,
      {
        find: async () => {
          events.push("find");
          return true;
        },
        populate: async () => {
          events.push("populate");
        },
        save: async () => {
          events.push("save");
        },
        settle: async () => {
          events.push("settle");
        },
      },
    );
    assert.equal(result.reused, true);
    assert.deepEqual(events, ["find"]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("小红书适配器统一上报会话、上传、字段、暂存和回读进度", async () => {
  const fixture = await draftFixture();
  const progress: Array<{ stage: string; current?: number; total?: number }> =
    [];
  let finds = 0;
  try {
    await saveXiaohongshuDraft(
      { newPage: async () => ({}) } as any,
      fixture.content as any,
      {
        find: async () => ++finds === 2,
        populate: async () => undefined,
        save: async () => undefined,
        settle: async () => undefined,
      },
      (event) =>
        progress.push({
          stage: event.stage,
          ...(event.current === undefined ? {} : { current: event.current }),
          ...(event.total === undefined ? {} : { total: event.total }),
        }),
    );
    assert.deepEqual(progress, [
      { stage: "session" },
      { stage: "upload", current: 2, total: 2 },
      { stage: "fields" },
      { stage: "save" },
      { stage: "verify" },
    ]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("正式适配器暂存后回读失败报告结果未知且不自行重试", async () => {
  const fixture = await draftFixture();
  const events: string[] = [];
  let finds = 0;
  try {
    await assert.rejects(
      saveXiaohongshuDraft(
        { newPage: async () => ({}) } as any,
        fixture.content as any,
        {
          find: async () => {
            finds += 1;
            events.push("find");
            return false;
          },
          populate: async () => {
            events.push("populate");
          },
          save: async () => {
            events.push("save");
          },
          settle: async () => {
            events.push("settle");
          },
        },
      ),
      /结果未知；禁止自动重试/,
    );
    assert.equal(finds, 2);
    assert.deepEqual(events, ["find", "populate", "save", "settle", "find"]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("已确认结构要求多文件输入、标题信号与可编辑正文", () => {
  assert.equal(
    xiaohongshuGallerySelectors.images,
    'input[type="file"][multiple]',
  );
  assert.match(xiaohongshuGallerySelectors.title, /placeholder\*=/);
  assert.equal(
    xiaohongshuGallerySelectors.body,
    '[role="textbox"][contenteditable="true"]',
  );
});

test("暂存只点击命中闭合shadow host后的左侧安全坐标", async () => {
  let clicks = 0;
  const evidence = {
    layoutVersion: xiaohongshuDraftLayoutVersion,
    viewport: { width: 1000, height: 800 },
    draftPoint: { x: 430, y: 755 },
    publishPoint: { x: 540, y: 755 },
    host: {
      count: 1,
      tag: "xhs-publish-btn",
      left: 400,
      right: 570,
      top: 730,
      bottom: 790,
    },
    draftHitTag: "xhs-publish-btn",
    publishHitTag: "xhs-publish-btn",
  };
  assert.equal(validateXiaohongshuDraftLayout(evidence), true);
  const page = {
    url: () => xiaohongshuPublishUrl,
    evaluate: async () => evidence,
    mouse: {
      click: async (x: number, y: number) => {
        assert.deepEqual({ x, y }, { x: 430, y: 755 });
        clicks += 1;
      },
    },
  } as any;
  await clickVerifiedXiaohongshuDraftPoint(page);
  assert.equal(clicks, 1);
});

test("host命中验证失败时鼠标绝不点击", async () => {
  let clicks = 0;
  const page = {
    url: () => xiaohongshuPublishUrl,
    evaluate: async () => {
      throw new Error("暂存坐标未命中已确认的xhs-publish-btn，拒绝点击");
    },
    mouse: {
      click: async () => {
        clicks += 1;
      },
    },
  } as any;
  await assert.rejects(clickVerifiedXiaohongshuDraftPoint(page), /拒绝点击/);
  assert.equal(clicks, 0);
});

test("布局版本、视口、host边界或左右命中漂移均拒绝且零点击", async () => {
  const valid = {
    layoutVersion: xiaohongshuDraftLayoutVersion,
    viewport: { width: 1000, height: 800 },
    draftPoint: { x: 430, y: 755 },
    publishPoint: { x: 540, y: 755 },
    host: {
      count: 1,
      tag: "xhs-publish-btn",
      left: 400,
      right: 570,
      top: 730,
      bottom: 790,
    },
    draftHitTag: "xhs-publish-btn",
    publishHitTag: "xhs-publish-btn",
  };
  const invalid = [
    { ...valid, layoutVersion: "changed-layout" },
    { ...valid, viewport: { width: 700, height: 800 } },
    { ...valid, host: { ...valid.host, count: 2 } },
    { ...valid, host: { ...valid.host, right: 500 } },
    { ...valid, draftPoint: { x: 460, y: 755 } },
    { ...valid, draftHitTag: "div" },
    { ...valid, publishHitTag: "button" },
  ];
  for (const evidence of invalid)
    assert.throws(() => validateXiaohongshuDraftLayout(evidence));

  let clicks = 0;
  const page = {
    url: () => xiaohongshuPublishUrl,
    evaluate: async () => invalid[0],
    mouse: {
      click: async () => {
        clicks += 1;
      },
    },
  } as any;
  await assert.rejects(clickVerifiedXiaohongshuDraftPoint(page), /拒绝点击/);
  assert.equal(clicks, 0);
});

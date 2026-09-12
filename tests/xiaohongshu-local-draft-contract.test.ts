import test from "node:test";
import assert from "node:assert/strict";
import {
  saveLocalDraftIdempotently,
  validateClosedShadowCoordinate,
  type ExpectedLocalDraft,
  type XiaohongshuLocalDraftAdapter,
} from "./support/xiaohongshu-local-draft-contract.ts";

class LocalDraftFixture implements XiaohongshuLocalDraftAdapter {
  events: string[] = [];
  constructor(public drafts: ExpectedLocalDraft[]) {}
  async listDraftCandidates() {
    this.events.push("list");
    return this.drafts.map((draft, index) => ({ index, title: draft.title }));
  }
  async readDraftCandidate(candidate: { index: number; title: string }) {
    this.events.push(`read:${candidate.index}`);
    return this.drafts[candidate.index]!;
  }
  async uploadImages(images: readonly string[]) {
    for (const image of images) this.events.push(`upload:${image}`);
  }
  async saveToLocalDrafts(expected: ExpectedLocalDraft) {
    this.events.push("save-local-draft");
    this.drafts.push(expected);
  }
}

const expected = { title: "同标题", body: "目标正文", imageCount: 3 };

test("保存前逐一回读同标题候选，完全匹配时不上传也不暂存", async () => {
  const adapter = new LocalDraftFixture([
    { title: "其他", body: "正文", imageCount: 1 },
    { title: "同标题", body: "不同正文", imageCount: 3 },
    expected,
  ]);
  const result = await saveLocalDraftIdempotently(adapter, expected, [
    "1",
    "2",
    "3",
  ]);
  assert.equal(result.reused, true);
  assert.deepEqual(adapter.events, ["list", "read:1", "read:2"]);
  assert.equal(
    adapter.events.some((event) => event.startsWith("upload:")),
    false,
  );
  assert.equal(adapter.events.includes("save-local-draft"), false);
  assert.equal(adapter.events.includes("click:publish"), false);
});

test("仅标题相同但正文或图片数不同不能误判，暂存后必须再次回读", async () => {
  const adapter = new LocalDraftFixture([
    { title: "同标题", body: "不同正文", imageCount: 3 },
    { title: "同标题", body: "目标正文", imageCount: 2 },
  ]);
  const result = await saveLocalDraftIdempotently(adapter, expected, [
    "1",
    "2",
    "3",
  ]);
  assert.equal(result.reused, false);
  assert.deepEqual(adapter.events, [
    "list",
    "read:0",
    "read:1",
    "upload:1",
    "upload:2",
    "upload:3",
    "save-local-draft",
    "list",
    "read:0",
    "read:1",
    "read:2",
  ]);
  assert.equal(adapter.events.includes("click:publish"), false);
});

test("暂存后回读不匹配必须失败，不能把操作报告为成功", async () => {
  class BrokenSave extends LocalDraftFixture {
    override async saveToLocalDrafts() {
      this.events.push("save-local-draft");
    }
  }
  const adapter = new BrokenSave([]);
  await assert.rejects(
    saveLocalDraftIdempotently(adapter, expected, ["1", "2", "3"]),
    /回读.*完全匹配/,
  );
  assert.equal(adapter.events.includes("click:publish"), false);
});

test("closed-shadow坐标动作校验受信host、相对坐标、唯一命中与布局版本", () => {
  const valid = {
    url: "https://creator.xiaohongshu.com/new/home",
    viewport: { width: 1200, height: 800 },
    point: { x: 516, y: 755 },
    elementFromPoint: {
      hostMarker: "xhs-publish-btn",
      matchingHostCount: 1,
    },
    layoutVersion: "xhs-new-home-2026-09",
    expectedLayoutVersion: "xhs-new-home-2026-09",
  };
  assert.equal(validateClosedShadowCoordinate(valid), true);
  assert.equal(
    validateClosedShadowCoordinate({
      ...valid,
      viewport: { width: 1600, height: 1000 },
      point: { x: 688, y: 955 },
    }),
    true,
  );
  for (const invalid of [
    { ...valid, url: "https://evil.example/new/home" },
    { ...valid, url: "https://creator.xiaohongshu.com.evil.example/new/home" },
    { ...valid, point: { x: 468, y: 755 } },
    { ...valid, point: { x: 564, y: 755 } },
    { ...valid, point: { x: 516, y: 771 } },
    { ...valid, point: { x: 516, y: 739 } },
    {
      ...valid,
      elementFromPoint: { hostMarker: "other-host", matchingHostCount: 1 },
    },
    {
      ...valid,
      elementFromPoint: {
        hostMarker: "xhs-publish-btn",
        matchingHostCount: 2,
      },
    },
    { ...valid, layoutVersion: "unverified-layout" },
  ])
    assert.throws(() => validateClosedShadowCoordinate(invalid));
});

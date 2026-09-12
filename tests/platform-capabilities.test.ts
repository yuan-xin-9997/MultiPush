import { test } from "node:test";
import assert from "node:assert/strict";
import { taskCapability } from "../apps/desktop/src/platform-capabilities.ts";
import {
  douyinVideoDraftVerified,
  xiaohongshuGalleryDraftVerified,
} from "../packages/shared/src/index.ts";

test("小红书图文adapter验收后开放草稿保存与队列", () => {
  const capability = taskCapability("xiaohongshu", "gallery");
  assert.equal(capability.preflight, true);
  assert.equal(capability.saveDraft, true);
  assert.equal(capability.enqueueDraft, true);
  assert.equal(capability.draftUnavailableReason, undefined);
  assert.equal(xiaohongshuGalleryDraftVerified, true);
});

test("小红书视频适配器仍保持禁用", () => {
  const capability = taskCapability("xiaohongshu", "video");
  assert.equal(capability.preflight, true);
  assert.equal(capability.saveDraft, false);
  assert.equal(capability.enqueueDraft, false);
  assert.match(capability.draftUnavailableReason ?? "", /尚未验证/);
});

test("抖音私密视频草稿验收后开放保存与队列", () => {
  const capability = taskCapability("douyin", "video");
  assert.equal(douyinVideoDraftVerified, true);
  assert.equal(capability.preflight, true);
  assert.equal(capability.saveDraft, true);
  assert.equal(capability.enqueueDraft, true);
  assert.equal(capability.draftUnavailableReason, undefined);
});

test("已验证的公众号和知乎文章保留草稿能力", () => {
  for (const platform of ["wechat-official", "zhihu"] as const) {
    const capability = taskCapability(platform, "article");
    assert.equal(capability.saveDraft, true);
    assert.equal(capability.enqueueDraft, true);
  }
});

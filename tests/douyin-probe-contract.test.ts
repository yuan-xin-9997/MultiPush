import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { probeDouyinVideoStructure } from "../scripts/douyin-probe.ts";
import { douyinCreatorHomeUrl } from "../packages/publisher-engine/src/platforms/douyin/login.ts";

function probePage(
  destination = "https://creator.douyin.com/creator-micro/content/upload",
  start = douyinCreatorHomeUrl,
) {
  let url = start;
  const events: string[] = [];
  const page = {
    url: () => url,
    getByText: (text: string, options: { exact: boolean }) => {
      assert.equal(text, "发布高清视频");
      assert.equal(options.exact, true);
      return {
        count: async () => 1,
        first: () => ({
          click: async () => {
            events.push("click:navigate-publish-video");
            url = destination;
          },
        }),
      };
    },
    locator: (selector: string) => {
      return {
        evaluateAll: async () =>
          selector === "input[type='file']"
            ? [{ accept: "video/mp4", multiple: false }]
            : { title: 1, body: 1, draft: 1, publish: 1 },
      };
    },
    waitForLoadState: async () => events.push("wait:networkidle"),
    waitForFunction: async () => events.push("wait:controls"),
    waitForTimeout: async () => events.push("wait:stable"),
  } as unknown as Page;
  return { page, events };
}

test("video-structure只点击唯一导航控件且输出严格脱敏", async () => {
  const fixture = probePage();
  const result = await probeDouyinVideoStructure(fixture.page);
  assert.deepEqual(fixture.events, [
    "click:navigate-publish-video",
    "wait:networkidle",
    "wait:controls",
    "wait:stable",
  ]);
  assert.deepEqual(result.page, {
    pathname: "/creator-micro/content/upload",
  });
  const serialized = JSON.stringify(result);
  for (const secret of ["nickname-secret", "token=", "cookie-secret"])
    assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(result.note, /未选择文件、填写、保存或发布/);
});

test("video-structure拒绝非受信、带凭据、query或hash的起点和终点", async () => {
  for (const start of [
    "https://evil.example/creator-micro/home",
    "https://creator.douyin.com.evil.example/creator-micro/home",
    "https://user:secret@creator.douyin.com/creator-micro/home",
    `${douyinCreatorHomeUrl}?token=secret`,
    `${douyinCreatorHomeUrl}#fragment`,
  ]) {
    const fixture = probePage(undefined, start);
    await assert.rejects(probeDouyinVideoStructure(fixture.page), /必须从/);
    assert.deepEqual(fixture.events, []);
  }
  for (const destination of [
    "https://evil.example/creator-micro/content/upload",
    "https://creator.douyin.com.evil.example/creator-micro/content/upload",
    "https://creator.douyin.com/creator-micro/content/upload?token=secret",
    "https://creator.douyin.com/creator-micro/content/upload#fragment",
  ]) {
    const fixture = probePage(destination);
    await assert.rejects(
      probeDouyinVideoStructure(fixture.page),
      /未稳定在可信/,
    );
    assert.equal(fixture.events[0], "click:navigate-publish-video");
  }
});

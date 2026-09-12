import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { probeDouyinVideoStructure } from "../scripts/douyin-probe.ts";

function probePage(
  destination = "https://creator.douyin.com/creator-micro/content/upload",
) {
  let url = "https://creator.douyin.com/creator-micro/home";
  const calls: string[] = [];
  const navigation = {
    count: async () => 1,
    first: () => navigation,
    click: async () => {
      calls.push("click:发布高清视频");
      url = destination;
    },
  };
  const page = {
    url: () => url,
    getByText: (text: string, options: { exact: boolean }) => {
      assert.equal(text, "发布高清视频");
      assert.equal(options.exact, true);
      return navigation;
    },
    locator: (selector: string) => {
      calls.push(`locator:${selector}`);
      if (selector === "input[type='file']")
        return {
          evaluateAll: async () => [
            { accept: "video/mp4,video/quicktime", multiple: false },
          ],
        };
      return {
        evaluateAll: async () => ({ title: 1, body: 1, draft: 1, publish: 1 }),
      };
    },
    waitForLoadState: async () => {
      calls.push("waitForLoadState");
    },
    waitForFunction: async () => {
      calls.push("waitForFunction");
    },
    waitForTimeout: async () => {
      calls.push("waitForTimeout");
    },
  } as unknown as Page;
  return { page, calls };
}

test("video-structure只导航并输出脱敏的视频控件结构", async () => {
  const { page, calls } = probePage();
  const result = await probeDouyinVideoStructure(page);

  assert.deepEqual(result.page, { pathname: "/creator-micro/content/upload" });
  assert.deepEqual(result.fileInputs, [
    { accept: "video/mp4,video/quicktime", multiple: false },
  ]);
  assert.deepEqual(result.knownControlCounts, {
    title: 1,
    body: 1,
    draft: 1,
    publish: 1,
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("click:")),
    ["click:发布高清视频"],
  );
  assert.equal(
    calls.some((call) => /setInputFiles|fill\(|press|mouse/i.test(call)),
    false,
  );
});

test("video-structure拒绝带参数或错误路径的创作页", async () => {
  for (const destination of [
    "https://creator.douyin.com/creator-micro/content/upload?token=secret",
    "https://creator.douyin.com/creator-micro/content/upload#publish",
    "https://creator.douyin.com/creator-micro/home",
  ]) {
    const { page } = probePage(destination);
    await assert.rejects(
      () => probeDouyinVideoStructure(page),
      /可信创作平台地址/,
    );
  }
});

test("video-structure拒绝离站导航且不继续读取控件", async () => {
  const { page, calls } = probePage(
    "https://evil.example/upload?cookie=secret",
  );
  await assert.rejects(
    () => probeDouyinVideoStructure(page),
    /可信创作平台地址/,
  );
  assert.equal(calls.includes("locator:input[type='file']"), false);
});

test("video-structure必须从抖音创作首页开始", async () => {
  const { page, calls } = probePage();
  Object.assign(page, {
    url: () => "https://creator.douyin.com/creator-micro/login",
  });
  await assert.rejects(
    () => probeDouyinVideoStructure(page),
    /已认证的抖音创作首页/,
  );
  assert.deepEqual(calls, []);
});

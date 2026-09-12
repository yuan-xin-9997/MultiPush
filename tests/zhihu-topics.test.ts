import test from "node:test";
import assert from "node:assert/strict";
import { validateZhihuTopics } from "../packages/publisher-engine/src/platforms/zhihu/topics.ts";
import { verifyZhihuDraftList } from "../packages/publisher-engine/src/platforms/zhihu/draft-list.ts";
import type { BrowserContext } from "playwright";
test("知乎话题拒绝空白、重复及超过5项", () => {
  assert.deepEqual(validateZhihuTopics(["软件开发"]), ["软件开发"]);
  for (const tags of [
    [""],
    [" 软件开发"],
    ["软件开发", "软件开发"],
    Array(6).fill("a"),
  ])
    assert.throws(() => validateZhihuTopics(tags));
});
test("知乎草稿列表核对拒绝非编辑链接和凭据参数，且不打开浏览器", async () => {
  const context = {
    newPage: () => {
      throw new Error("unexpected browser open");
    },
  } as unknown as BrowserContext;
  for (const url of [
    "https://evil.example/p/123/edit",
    "https://zhuanlan.zhihu.com/p/123/edit?token=x",
    "https://user@zhuanlan.zhihu.com/p/123/edit",
  ])
    await assert.rejects(verifyZhihuDraftList(context, url, "测试"), /无效/);
});

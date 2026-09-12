import { test } from "node:test";
import assert from "node:assert/strict";
import {
  draftPayloadMatches,
  validateDraftUrl,
} from "../packages/publisher-engine/src/platforms/zhihu/draft.ts";

test("Zhihu title-only acknowledgement cannot be mistaken for body autosave", () => {
  assert.equal(draftPayloadMatches({ title: "标题" }, "title", "标题"), true);
  assert.equal(
    draftPayloadMatches({ title: "标题" }, "content", "正文"),
    false,
  );
  assert.equal(
    draftPayloadMatches({ content: "<p>旧正文</p>" }, "content", "新正文"),
    false,
  );
  assert.equal(
    draftPayloadMatches(
      { content: "<p>第一行<br/><br/>第二行 &amp; &lt;标签&gt;</p>" },
      "content",
      "第一行\n\n第二行 & <标签>",
    ),
    true,
  );
});
test("draft links must point to a concrete Zhihu draft, without redirects or credentials", () => {
  assert.equal(
    validateDraftUrl("https://zhuanlan.zhihu.com/p/123456/edit"),
    "https://zhuanlan.zhihu.com/p/123456/edit",
  );
  for (const url of [
    "https://evil.example/p/123/edit",
    "https://user:secret@zhuanlan.zhihu.com/p/123/edit",
    "https://zhuanlan.zhihu.com.evil.example/p/123/edit",
    "https://zhuanlan.zhihu.com/write",
    "https://zhuanlan.zhihu.com/p/123/edit?redirect=https://evil.example",
  ])
    assert.throws(() => validateDraftUrl(url));
});

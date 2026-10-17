import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateXiaohongshuPublishedUrl,
  xiaohongshuPublishedId,
} from "../packages/publisher-engine/src/platforms/xiaohongshu/publish.ts";
test("小红书公开结果必须来自成功响应的唯一笔记ID", () => {
  const id = "1234567890abcdef12345678";
  assert.equal(xiaohongshuPublishedId({ code: 0, data: { note_id: id } }), id);
  for (const value of [
    { code: 1, data: { note_id: id } },
    { code: 0, success: false, data: { id } },
    { code: 0, data: {} },
    { code: 0, data: { id, note_id: "abcdef1234567890abcdef12" } },
  ])
    assert.throws(() => xiaohongshuPublishedId(value));
  assert.equal(
    validateXiaohongshuPublishedUrl(
      `https://www.xiaohongshu.com/explore/${id}#x`,
    ),
    `https://www.xiaohongshu.com/explore/${id}`,
  );
  for (const value of [
    `http://www.xiaohongshu.com/explore/${id}`,
    `https://evil.com/explore/${id}`,
    `https://www.xiaohongshu.com/explore/${id}?token=secret`,
    `https://u:p@www.xiaohongshu.com/explore/${id}`,
  ])
    assert.throws(() => validateXiaohongshuPublishedUrl(value));
});

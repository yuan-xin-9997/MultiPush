import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { imagePayload } from "../packages/publisher-engine/src/platforms/wechat/media.ts";
import { renderMarkdown } from "../packages/publisher-engine/src/markdown.ts";
import {
  validateWechatContent,
  validateWechatDraftUrl,
  wechatDraftUrl,
} from "../packages/publisher-engine/src/platforms/wechat/draft.ts";

test("公众号草稿链接只接受规范化无凭据地址", () => {
  const url = wechatDraftUrl("123");
  assert.equal(validateWechatDraftUrl(url), url);
  for (const bad of [
    url + "&token=secret",
    url + "#secret",
    url.replace("mp.weixin.qq.com", "evil.example"),
    url + "&appmsgid=456",
  ])
    assert.throws(() => validateWechatDraftUrl(bad));
  assert.throws(() => wechatDraftUrl("../1"));
});

test("公众号字段与图片数量限制", () => {
  const content = {
    type: "article" as const,
    title: "测试",
    body: "正文",
    images: [],
    author: "",
    summary: "",
  };
  assert.doesNotThrow(() => validateWechatContent(content));
  for (const extra of [
    { title: "测".repeat(65) },
    { author: "测".repeat(9) },
    { summary: "测".repeat(121) },
    { video: "video.mp4" },
    { images: Array(21).fill("a.png") },
    { body: " " },
  ])
    assert.throws(() => validateWechatContent({ ...content, ...extra }));
});

test("图片必须为本地PNG/JPEG，不能把任意文件作为图片上传", async () => {
  await assert.rejects(imagePayload("relative.png"));
  await assert.rejects(imagePayload(resolve("package.json")));
  const payload = await imagePayload(
    resolve("apps/desktop/src-tauri/icons/icon.png"),
  );
  assert.equal(payload.mimeType, "image/png");
  assert.match(payload.name, /^turbopush-.*\.png$/);
});

test("Markdown转换保留结构并拒绝隐式素材上传和原始HTML", () => {
  const html = renderMarkdown("## 标题\n\n**加粗**\n\n- 一\n- 二");
  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<li>一<\/li>/);
  assert.throws(() => renderMarkdown("![图片](file:///private.png)"));
  assert.throws(() => renderMarkdown("<script>alert(1)</script>"));
  assert.doesNotMatch(
    renderMarkdown("[危险](javascript:alert%281%29)"),
    /href=/,
  );
});

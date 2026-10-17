import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { validateWechatPublishedUrl } from "../packages/publisher-engine/src/platforms/wechat/publish.ts";
import { verifyZhihuImageOrder } from "../packages/publisher-engine/src/platforms/zhihu/media.ts";

test("公众号公开链接仅接受文章地址，拒绝管理页、凭据和域名混淆", () => {
  assert.equal(
    validateWechatPublishedUrl("https://mp.weixin.qq.com/s/development-test"),
    "https://mp.weixin.qq.com/s/development-test",
  );
  assert.equal(
    validateWechatPublishedUrl(
      "https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=xyz&scene=1#rd",
    ),
    "https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=xyz",
  );
  for (const url of [
    "https://mp.weixin.qq.com/cgi-bin/home?token=secret",
    "https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=xyz&access_token=secret",
    "https://mp.weixin.qq.com.evil.example/s/test",
    "http://mp.weixin.qq.com/s/test",
    "https://user:pass@mp.weixin.qq.com/s/test",
  ])
    assert.throws(() => validateWechatPublishedUrl(url));
});

test("知乎三次逐图回读拒绝01→03→02、重复内容及非受信图片", async () => {
  const fingerprints = [
    { differenceHash: "0000000000000000", averageRgb: [255, 0, 0] },
    { differenceHash: "0000000000000000", averageRgb: [0, 255, 0] },
    { differenceHash: "0000000000000000", averageRgb: [0, 0, 255] },
  ];
  const expected = ["0", "1", "2"].map((name) => ({
    name,
    mimeType: "image/png",
    buffer: Buffer.from(name),
  }));
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [0, 1, 1],
    [-1, 1, 2],
  ]) {
    let reads = 0;
    const page = {
      locator: () => ({
        count: async () => order.length,
        nth: (index: number) => ({
          scrollIntoViewIfNeeded: async () => {},
          evaluate: async (fn: (element: unknown) => unknown) =>
            fn({
              currentSrc:
                order[index] < 0
                  ? "https://evil.example/image"
                  : `https://pic.zhimg.com/${order[index]}`,
              decode: async () => {},
            }),
        }),
      }),
      evaluate: async (_fn: unknown, args: { source: string }) => ({
        fingerprint:
          fingerprints[Number(Buffer.from(args.source, "base64").toString())],
      }),
      context: () => ({
        request: {
          get: async (url: string, options: { maxRedirects: number }) => {
            reads++;
            assert.equal(options.maxRedirects, 0);
            return {
              ok: () => true,
              headers: () => ({ "content-type": "image/png" }),
              body: async () => Buffer.from(new URL(url).pathname.slice(1)),
            };
          },
        },
      }),
      waitForTimeout: async () => {},
    } as unknown as Page;
    if (order.join() === "0,1,2") {
      await verifyZhihuImageOrder(page, expected);
      assert.equal(reads, 9);
    } else
      await assert.rejects(
        verifyZhihuImageOrder(page, expected),
        /第[123]张图片/,
      );
  }
});

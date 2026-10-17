import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyXiaohongshuImagesInOrder,
  type XiaohongshuImageEvidence,
} from "../packages/publisher-engine/src/platforms/xiaohongshu/image-verification.ts";

const valid: XiaohongshuImageEvidence<string> = {
  local: ["image-01", "image-02"],
  uploads: [
    {
      localIndex: 0,
      requestFingerprint: "image-01",
      uniquePayload: true,
      uniqueSuccessfulResponse: true,
    },
    {
      localIndex: 1,
      requestFingerprint: "image-02",
      uniquePayload: true,
      uniqueSuccessfulResponse: true,
    },
  ],
  remoteSamples: [
    ["image-01", "image-02"],
    ["image-01", "image-02"],
    ["image-01", "image-02"],
  ],
};

test("逐图证明、远端顺序及三次稳定采样齐备才通过", () => {
  assert.equal(verifyXiaohongshuImagesInOrder(valid), true);
});

test("缺失、重复或无唯一成功响应的上传证明全部拒绝", () => {
  for (const uploads of [
    valid.uploads.slice(0, 1),
    [...valid.uploads].reverse(),
    [valid.uploads[0]!, valid.uploads[0]!],
    [{ ...valid.uploads[0]!, uniquePayload: false }, valid.uploads[1]!],
    [
      valid.uploads[0]!,
      { ...valid.uploads[1]!, uniqueSuccessfulResponse: false },
    ],
    [
      valid.uploads[0]!,
      { ...valid.uploads[1]!, requestFingerprint: "image-01" },
    ],
  ])
    assert.throws(() => verifyXiaohongshuImagesInOrder({ ...valid, uploads }));
});

test("远端错序、交叉归因、重复、缺图及多图全部拒绝", () => {
  for (const sample of [
    ["image-02", "image-01"],
    ["image-01", "image-01"],
    ["image-01"],
    ["image-01", "image-02", "image-03"],
    ["image-01", "unrelated"],
  ])
    assert.throws(() =>
      verifyXiaohongshuImagesInOrder({
        ...valid,
        remoteSamples: [sample, ...valid.remoteSamples.slice(1)],
      }),
    );
});

test("本地重复、采样不足与后续指纹漂移均拒绝", () => {
  assert.throws(() =>
    verifyXiaohongshuImagesInOrder({
      ...valid,
      local: ["image-01", "image-01"],
    }),
  );
  assert.throws(() =>
    verifyXiaohongshuImagesInOrder({
      ...valid,
      remoteSamples: valid.remoteSamples.slice(0, 2),
    }),
  );
  const samples = [
    ["image-01#a", "image-02#a"],
    ["image-01#b", "image-02#a"],
    ["image-01#b", "image-02#a"],
  ];
  const matches = (left: string, right: string) =>
    left.split("#")[0] === right.split("#")[0];
  // A permissive local-vs-remote comparator cannot make drifting remote
  // fingerprints stable; exact sample identity must also be established.
  assert.throws(() =>
    verifyXiaohongshuImagesInOrder(
      {
        ...valid,
        remoteSamples: samples,
      },
      matches,
    ),
  );
});

test("模糊匹配造成交叉命中时即使位置相同也拒绝", () => {
  const matches = (left: string, right: string) =>
    left === right || (left.startsWith("image") && right.startsWith("image"));
  assert.throws(() => verifyXiaohongshuImagesInOrder(valid, matches));
});

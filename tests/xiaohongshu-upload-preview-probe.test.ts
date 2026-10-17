import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { parseXiaohongshuUploadPreviewOptions } from "../scripts/xiaohongshu-upload-preview-probe.ts";

const args = [
  "--data-dir",
  resolve(".data"),
  "--account-id",
  "01234567-89ab-4cde-8fab-0123456789ab",
  "--image",
  resolve("first.png"),
  "--image",
  resolve("second.png"),
];

test("小红书预览探测要求显式授权、账号和恰好两张本地图片", () => {
  assert.throws(() => parseXiaohongshuUploadPreviewOptions(args, {}));
  assert.deepEqual(
    parseXiaohongshuUploadPreviewOptions(args, {
      TURBOPUSH_LIVE_DRAFT_TEST: "1",
    }),
    {
      dataDir: resolve(".data"),
      accountId: "01234567-89ab-4cde-8fab-0123456789ab",
      images: [resolve("first.png"), resolve("second.png")],
      manualEditor: false,
    },
  );
  const authorized = { TURBOPUSH_LIVE_DRAFT_TEST: "1" };
  assert.equal(
    parseXiaohongshuUploadPreviewOptions(
      [...args, "--manual-editor"],
      authorized,
    ).manualEditor,
    true,
  );
  for (const invalid of [
    args.slice(0, -2),
    [...args, "--image", resolve("third.png")],
    [...args, "--publish", "1"],
    ["--data-dir", ".data", ...args.slice(2)],
    [...args, "--account-id", "01234567-89ab-4cde-8fab-0123456789ab"],
    [...args, "--manual-editor", "--manual-editor"],
  ])
    assert.throws(() =>
      parseXiaohongshuUploadPreviewOptions(invalid, authorized),
    );
});

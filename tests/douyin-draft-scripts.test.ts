import test from "node:test";
import assert from "node:assert/strict";
import { parseDouyinSpikeConfig } from "../scripts/douyin-draft-spike-policy.ts";
import { parseDouyinVerifyConfig } from "../scripts/douyin-draft-verify-policy.ts";

test("抖音spike默认structure严格只读且不需要视频", () => {
  assert.deepEqual(
    parseDouyinSpikeConfig({ TURBOPUSH_ACCOUNT_ID: "account" }),
    {
      accountId: "account",
      mode: "structure",
      video: undefined,
      uploadsVideo: false,
    },
  );
});

test("抖音回验脚本拒绝默认选择账号并要求显式期望内容", () => {
  assert.throws(() => parseDouyinVerifyConfig({}), /必须显式设置/);
  assert.throws(
    () => parseDouyinVerifyConfig({ TURBOPUSH_ACCOUNT_ID: "account" }),
    /必须显式设置/,
  );
  assert.deepEqual(
    parseDouyinVerifyConfig({
      TURBOPUSH_ACCOUNT_ID: "account",
      TURBOPUSH_EXPECTED_TITLE: "标题",
      TURBOPUSH_EXPECTED_BODY: "",
    }),
    { accountId: "account", expectedTitle: "标题", expectedBody: "" },
  );
});

test("抖音spike所有写入模式均要求显式账号和视频", () => {
  assert.throws(
    () => parseDouyinSpikeConfig({}),
    /显式设置 TURBOPUSH_ACCOUNT_ID/,
  );
  for (const mode of ["upload-structure", "fill-structure", "save"])
    assert.throws(
      () =>
        parseDouyinSpikeConfig({
          TURBOPUSH_ACCOUNT_ID: "account",
          TURBOPUSH_MODE: mode,
        }),
      /上传模式需要显式设置 TURBOPUSH_VIDEO/,
    );
  assert.equal(
    parseDouyinSpikeConfig({
      TURBOPUSH_ACCOUNT_ID: "account",
      TURBOPUSH_MODE: "upload-structure",
      TURBOPUSH_VIDEO: "video.mp4",
    }).uploadsVideo,
    true,
  );
});

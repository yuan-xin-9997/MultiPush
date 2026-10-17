import { test } from "node:test";
import assert from "node:assert/strict";
import { publicationCommand } from "../scripts/live-publication-smoke.ts";
test("公开验收脚本要求明确模式平台和写入开关，不接受默认账号或模糊授权", () => {
  assert.deepEqual(publicationCommand(["inspect", "zhihu"], undefined), {
    mode: "inspect",
    platform: "zhihu",
  });
  for (const mode of [
    "prepare",
    "stage",
    "restage",
    "verify",
    "review",
    "draft",
    "repair",
    "publish",
  ]) {
    assert.throws(() => publicationCommand([mode, "zhihu"], undefined));
    assert.throws(() => publicationCommand([mode, "zhihu"], "true"));
    assert.equal(publicationCommand([mode, "zhihu"], "1").mode, mode);
  }
  for (const args of [
    [],
    ["publish"],
    ["publish", "douyin"],
    ["publish", "zhihu", "extra"],
    ["delete", "zhihu"],
  ])
    assert.throws(() => publicationCommand(args, "1"));
});

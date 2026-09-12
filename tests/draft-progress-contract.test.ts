import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { reportDraftProgress } from "../packages/publisher-engine/src/draft-progress.ts";

async function adapterStages(relativePath: string) {
  const source = await readFile(resolve(relativePath), "utf8");
  return [
    ...source.matchAll(
      /reportDraftProgress\(options\.onProgress,\s*\{\s*stage:\s*"([^"]+)"/g,
    ),
  ].map((match) => match[1]);
}

test("公众号适配器声明会话、字段、上传、保存与回读进度", async () => {
  const stages = await adapterStages(
    "packages/publisher-engine/src/platforms/wechat/draft.ts",
  );
  for (const required of ["session", "fields", "upload", "save", "verify"])
    assert.equal(stages.includes(required), true, `缺少 ${required} 进度`);
});

test("知乎适配器声明会话、字段、上传、保存与回读进度", async () => {
  const stages = await adapterStages(
    "packages/publisher-engine/src/platforms/zhihu/draft.ts",
  );
  for (const required of ["session", "fields", "upload", "save", "verify"])
    assert.equal(stages.includes(required), true, `缺少 ${required} 进度`);
});

test("进度观察器抛错不会改变平台主流程", () => {
  assert.doesNotThrow(() =>
    reportDraftProgress(
      () => {
        throw new Error("event store unavailable after remote action");
      },
      { stage: "verify", message: "远端回读已经完成" },
    ),
  );
});

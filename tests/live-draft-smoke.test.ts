import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import type {
  Account,
  RpcRequest,
  RpcResponse,
  Task,
  TaskEvent,
} from "../packages/shared/src/index.ts";
import {
  assertNoExistingLiveDraft,
  parseLiveDraftOptions,
  redactLiveOutput,
  validateLiveDraftAccount,
  waitForDraftTerminal,
} from "../scripts/live-draft-smoke-lib.ts";

const uuid = "11111111-1111-4111-8111-111111111111";
const absolute = (name: string) => resolve(".live-smoke-fixture", name);
const validArgs = [
  "--platform",
  "zhihu",
  "--account-id",
  uuid,
  "--data-dir",
  absolute("data"),
  "--title",
  "多图慢网",
  "--body-file",
  absolute("body.md"),
  "--image",
  absolute("one.png"),
  "--image",
  absolute("two.png"),
  "--network-delay-ms",
  "500",
];

test("真实草稿参数要求显式授权、平台、账号和至少两张素材", () => {
  assert.throws(
    () => parseLiveDraftOptions(validArgs, {}),
    /TURBOPUSH_LIVE_DRAFT_TEST=1/,
  );
  assert.throws(
    () =>
      parseLiveDraftOptions(
        validArgs.filter(
          (value, index) =>
            !(
              value === "--account-id" ||
              index === validArgs.indexOf("--account-id") + 1
            ),
        ),
        { TURBOPUSH_LIVE_DRAFT_TEST: "1" },
      ),
    /--account-id/,
  );
  assert.throws(
    () =>
      parseLiveDraftOptions(
        validArgs.filter((_, index) => index !== 12 && index !== 13),
        { TURBOPUSH_LIVE_DRAFT_TEST: "1" },
      ),
    /2..20/,
  );
  const parsed = parseLiveDraftOptions(validArgs, {
    TURBOPUSH_LIVE_DRAFT_TEST: "1",
  });
  assert.equal(parsed.platform, "zhihu");
  assert.equal(parsed.accountId, uuid);
  assert.equal(parsed.images.length, 2);
  assert.equal(parsed.networkDelayMs, 500);
  assert.equal(parsed.timeoutMs, 1_200_000);
});

test("真实草稿账号必须精确匹配显式 ID、平台和 authenticated 登录态", () => {
  const account: Account = {
    id: uuid,
    platform: "zhihu",
    name: "专项账号",
    loginStatus: "authenticated",
    checkedAt: new Date(0).toISOString(),
    message: "已登录",
    createdAt: new Date(0).toISOString(),
  };
  assert.doesNotThrow(() =>
    validateLiveDraftAccount(account, { accountId: uuid, platform: "zhihu" }),
  );
  assert.throws(
    () =>
      validateLiveDraftAccount(
        { ...account, loginStatus: "expired" },
        { accountId: uuid, platform: "zhihu" },
      ),
    /authenticated/,
  );
  assert.throws(
    () =>
      validateLiveDraftAccount(account, {
        accountId: uuid,
        platform: "wechat-official",
      }),
    /--platform/,
  );
  assert.throws(
    () =>
      validateLiveDraftAccount(account, {
        accountId: "22222222-2222-4222-8222-222222222222",
        platform: "zhihu",
      }),
    /--account-id/,
  );
});

test("同账号同测试标题的进行中、需人工介入或已保存任务一律禁止重跑", () => {
  const title = "[TurboPush LIVE DRAFT] 多图慢网";
  const base = {
    id: uuid,
    accountId: uuid,
    content: { title },
  } as Task;
  for (const status of [
    "publishing",
    "intervention_required",
    "draft_saved",
  ] as const) {
    assert.throws(
      () => assertNoExistingLiveDraft([{ ...base, status }], uuid, title),
      new RegExp(`${status}.*禁止自动重跑`),
    );
  }
  assert.doesNotThrow(() =>
    assertNoExistingLiveDraft(
      [{ ...base, status: "draft_saved", accountId: "other-account" }],
      uuid,
      title,
    ),
  );
  assert.doesNotThrow(() =>
    assertNoExistingLiveDraft(
      [
        {
          ...base,
          status: "draft_saved",
          content: { title: `${title}-new` },
        } as Task,
      ],
      uuid,
      title,
    ),
  );
});

test("真实草稿输出移除本地路径、完整 UUID、查询参数与令牌", () => {
  const local = absolute("private.png");
  const output = redactLiveOutput(
    {
      id: uuid,
      path: local,
      url: "https://example.com/draft/1?token=secret",
      message: "access_token=abc",
    },
    [local],
  );
  assert.doesNotMatch(
    output,
    /private\.png|11111111-1111-4111|secret|access_token=abc/,
  );
  assert.match(output, /https:\/\/example\.com\/draft\/1/);
});

test("异步等待只轮询 task.events 和 snapshot，直到草稿终态", async () => {
  let cycle = 0;
  const methods: string[] = [];
  const event: TaskEvent = {
    id: 1,
    taskId: uuid,
    status: "publishing",
    message: "上传 2/2",
    createdAt: new Date(0).toISOString(),
    progressStage: "upload",
    progressCurrent: 2,
    progressTotal: 2,
  };
  const task = { id: uuid, status: "draft_saved" } as Task;
  const dispatch = async (request: RpcRequest): Promise<RpcResponse> => {
    methods.push(request.method);
    if (request.method === "task.events")
      return { id: request.id, result: [event] };
    cycle += 1;
    return {
      id: request.id,
      result: {
        tasks: [
          { ...task, status: cycle === 1 ? "publishing" : "draft_saved" },
        ],
      },
    };
  };
  const result = await waitForDraftTerminal(dispatch, uuid, {
    pollMs: 250,
    timeoutMs: 30_000,
    sleep: async () => {},
    now: (() => {
      let time = 0;
      return () => ++time;
    })(),
  });
  assert.equal(result.task.status, "draft_saved");
  assert.deepEqual(methods, [
    "task.events",
    "snapshot",
    "task.events",
    "snapshot",
  ]);
});

test("真实入口合同禁止同步保存和发布调用", async () => {
  const source = await readFile(resolve("scripts/live-draft-smoke.ts"), "utf8");
  assert.match(source, /validateLiveDraftAccount\(account, options\)/);
  assert.match(source, /assertNoExistingLiveDraft\(/);
  assert.match(source, /method: "task\.enqueueDraft"/);
  assert.doesNotMatch(
    source,
    /method: "task\.saveDraft"|task\.publish|publishDraft/,
  );
  assert.match(
    source,
    /new Service\(options\.dataDir,\s*\{\s*pollIntervalMs: ISOLATED_SMOKE_POLL_MS,/,
    "专项入口必须禁用常规到期任务轮询，避免连带执行数据目录中的其他任务",
  );
  assert.ok(
    source.indexOf('context.route("**/*"') <
      source.indexOf('method: "task.enqueueDraft"'),
    "慢网络路由必须在异步入队前安装",
  );
});

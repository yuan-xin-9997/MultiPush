import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  classifyXiaohongshuMediaSource,
  parseXiaohongshuMediaProbeOptions,
  runXiaohongshuInspectionStage,
  waitForXiaohongshuInteractiveLogin,
} from "../scripts/xiaohongshu-media-probe.ts";

const uuid = "01234567-89ab-4cde-8fab-0123456789ab";

test("只读导航失败只暴露七类脱敏阶段，不透传页面异常", async () => {
  for (const stage of [
    "publish-page",
    "draft-box",
    "gallery-tab",
    "title-candidate",
    "edit-control",
    "body-signal",
    "media-structure",
  ] as const) {
    await assert.rejects(
      runXiaohongshuInspectionStage(stage, async () => {
        throw new Error("private URL https://example.test/?token=secret");
      }),
      (error: unknown) => {
        assert.equal((error as { stage: string }).stage, stage);
        assert.equal((error as Error).message.includes("secret"), false);
        return true;
      },
    );
  }
  assert.equal(
    await runXiaohongshuInspectionStage("media-structure", async () => 7),
    7,
  );
});

test("小红书只读媒体探测要求显式目录、账号和精确标题", () => {
  const args = [
    "--data-dir",
    resolve(".data"),
    "--account-id",
    uuid,
    "--draft-title",
    "  已有测试草稿  ",
  ];
  assert.deepEqual(parseXiaohongshuMediaProbeOptions(args), {
    dataDir: resolve(".data"),
    accountId: uuid,
    draftTitle: "已有测试草稿",
    interactiveLogin: false,
    loginTimeoutMs: 300000,
  });
  assert.deepEqual(
    parseXiaohongshuMediaProbeOptions([
      ...args,
      "--interactive-login",
      "--login-timeout-ms",
      "60000",
    ]),
    {
      dataDir: resolve(".data"),
      accountId: uuid,
      draftTitle: "已有测试草稿",
      interactiveLogin: true,
      loginTimeoutMs: 60000,
    },
  );
  for (const invalid of [
    args.slice(0, 4),
    [...args, "--draft-title", "重复"],
    [...args, "--write", "1"],
    ["--data-dir", ".data", ...args.slice(2)],
    ["--data-dir", resolve(".data"), "--account-id", "wrong", ...args.slice(4)],
    [...args, "--interactive-login", "--interactive-login"],
    [...args, "--login-timeout-ms", "30000"],
    [...args, "--interactive-login", "--login-timeout-ms", "999999"],
  ])
    assert.throws(() => parseXiaohongshuMediaProbeOptions(invalid));
});

test("交互登录保持同一页面等待，并要求两次稳定首页信号", async () => {
  let now = 0;
  let navigations = 0;
  const page = {
    url: () =>
      now < 1000
        ? "https://creator.xiaohongshu.com/"
        : now < 2000
          ? "https://creator.xiaohongshu.com/login?token=private"
          : "https://creator.xiaohongshu.com/new/home",
    getByText: () => ({ count: async () => 0 }),
    locator: () => ({ innerText: async () => "创作服务平台 发布笔记" }),
    goto: () => {
      navigations += 1;
    },
  } as any;
  await assert.doesNotReject(
    waitForXiaohongshuInteractiveLogin(page, 10000, {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    }),
  );
  assert.equal(now, 3000);
  assert.equal(navigations, 0);
});

test("交互登录拒绝离站、安全挑战和有界超时", async () => {
  let now = 0;
  const page = (url: string, challenge = false) =>
    ({
      url: () => url,
      getByText: () => ({
        count: async () => (challenge ? 1 : 0),
        nth: () => ({ isVisible: async () => challenge }),
      }),
      locator: () => ({ innerText: async () => "" }),
    }) as any;
  const clock = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  await assert.rejects(
    waitForXiaohongshuInteractiveLogin(
      page("https://evil.example/login"),
      30000,
      clock,
    ),
    /可信小红书/,
  );
  await assert.rejects(
    waitForXiaohongshuInteractiveLogin(
      page("https://creator.xiaohongshu.com/unverified/route"),
      30000,
      clock,
    ),
    /可信小红书/,
  );
  await assert.rejects(
    waitForXiaohongshuInteractiveLogin(
      page("https://creator.xiaohongshu.com/login", true),
      30000,
      clock,
    ),
    /安全验证/,
  );
  await assert.rejects(
    waitForXiaohongshuInteractiveLogin(
      page("https://creator.xiaohongshu.com/"),
      3000,
      clock,
    ),
    /等待超时/,
  );
  assert.equal(now, 3000);
});

test("媒体资源只输出类型，不输出跨域 URL、查询参数或令牌", () => {
  const origin = "https://creator.xiaohongshu.com";
  const secret = "https://cdn.example/private/image.png?token=secret";
  assert.equal(
    classifyXiaohongshuMediaSource(secret, origin),
    "cross-origin-https",
  );
  assert.equal(
    classifyXiaohongshuMediaSource("/image?token=secret", origin),
    "same-origin-https",
  );
  assert.equal(classifyXiaohongshuMediaSource("blob:private", origin), "blob");
  assert.equal(
    classifyXiaohongshuMediaSource("data:image/png;base64,secret", origin),
    "data",
  );
  assert.equal(
    classifyXiaohongshuMediaSource("http://unsafe.example/image", origin),
    "other",
  );
  assert.equal(classifyXiaohongshuMediaSource("", origin), "none");
  assert.equal(
    classifyXiaohongshuMediaSource(secret, origin).includes("secret"),
    false,
  );
});

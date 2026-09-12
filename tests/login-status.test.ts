import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/database/src/index.ts";
import { Service } from "../packages/publisher-engine/src/service.ts";
import {
  classifyLoginPage,
  detectPlatformLogin,
  isXiaohongshuAuthenticatedPage,
  type LoginCheckResult,
} from "../packages/publisher-engine/src/platforms/login-status.ts";
import {
  douyinCreatorHomeUrl,
  isDouyinAuthenticatedPage,
  validateDouyinCreatorUrl,
  waitForDouyinStablePage,
} from "../packages/publisher-engine/src/platforms/douyin/login.ts";
import type { Page } from "playwright";

const none = {
  authenticated: false,
  loginPrompt: false,
  securityChallenge: false,
};

test("登录页判定只信任平台域名和明确页面信号", () => {
  assert.equal(
    classifyLoginPage(
      "wechat-official",
      "https://mp.weixin.qq.com/cgi-bin/home",
      {
        ...none,
        authenticated: true,
      },
    ).status,
    "authenticated",
  );
  assert.equal(
    classifyLoginPage("zhihu", "https://www.zhihu.com/signin", none).status,
    "expired",
  );
  assert.equal(
    classifyLoginPage("wechat-official", "https://mp.weixin.qq.com/", {
      ...none,
      loginPrompt: true,
    }).status,
    "expired",
  );
  for (const result of [
    classifyLoginPage("zhihu", "https://evil.example/signin", {
      ...none,
      loginPrompt: true,
    }),
    classifyLoginPage("zhihu", "https://www.zhihu.com/", {
      ...none,
      securityChallenge: true,
    }),
    classifyLoginPage("wechat-official", "https://mp.weixin.qq.com/", none),
  ])
    assert.equal(result.status, "intervention_required");
});

test("小红书仅信任创作平台域名并保守处理登录与安全验证", () => {
  assert.equal(
    isXiaohongshuAuthenticatedPage(
      "https://creator.xiaohongshu.com/new/home",
      "创作服务平台\n发布笔记",
    ),
    true,
  );
  for (const [url, text] of [
    ["https://creator.xiaohongshu.com/new/home", "创作服务平台"],
    ["https://creator.xiaohongshu.com/home", "创作服务平台 发布笔记"],
    ["https://evil.example/new/home", "创作服务平台 发布笔记"],
  ])
    assert.equal(isXiaohongshuAuthenticatedPage(url!, text!), false);
  assert.equal(
    classifyLoginPage(
      "xiaohongshu",
      "https://creator.xiaohongshu.com/new/home",
      { ...none, authenticated: true },
    ).status,
    "authenticated",
  );
  assert.equal(
    classifyLoginPage("xiaohongshu", "https://creator.xiaohongshu.com/login", {
      ...none,
      loginPrompt: true,
    }).status,
    "expired",
  );
  for (const result of [
    classifyLoginPage("xiaohongshu", "https://evil.example/login", {
      ...none,
      loginPrompt: true,
    }),
    classifyLoginPage("xiaohongshu", "https://creator.xiaohongshu.com/", {
      ...none,
      securityChallenge: true,
    }),
    classifyLoginPage("xiaohongshu", "https://creator.xiaohongshu.com/", none),
  ])
    assert.equal(result.status, "intervention_required");
});

test("小红书页面加载超时不会被误判为登录过期", async () => {
  const page = {
    goto: async () => {
      throw new Error("Timeout 30000ms with secret URL parameters");
    },
  } as unknown as Page;
  const result = await detectPlatformLogin(page, "xiaohongshu");
  assert.equal(result.status, "intervention_required");
  assert.match(result.message, /超时或网络异常/);
  assert.doesNotMatch(result.message, /secret|URL/);
});

test("抖音创作平台URL和登录判定均使用严格白名单", () => {
  assert.equal(
    validateDouyinCreatorUrl(douyinCreatorHomeUrl),
    douyinCreatorHomeUrl,
  );
  assert.equal(
    isDouyinAuthenticatedPage(douyinCreatorHomeUrl, "发布视频 作品管理"),
    true,
  );
  for (const value of [
    "http://creator.douyin.com/creator-micro/home",
    "https://creator.douyin.com.evil.example/creator-micro/home",
    "https://user:secret@creator.douyin.com/creator-micro/home",
    "https://creator.douyin.com/creator-micro/home?token=secret",
    "https://creator.douyin.com/creator-micro/content/post/video",
  ])
    assert.throws(() => validateDouyinCreatorUrl(value));
  assert.equal(
    isDouyinAuthenticatedPage(douyinCreatorHomeUrl, "发布视频"),
    false,
  );
  assert.equal(
    classifyLoginPage("douyin", douyinCreatorHomeUrl, {
      ...none,
      authenticated: true,
    }).status,
    "authenticated",
  );
  assert.equal(
    classifyLoginPage(
      "douyin",
      "https://creator.douyin.com/creator-micro/login",
      { ...none, loginPrompt: true },
    ).status,
    "expired",
  );
  assert.equal(
    classifyLoginPage("douyin", "https://evil.example/creator-micro/login", {
      ...none,
      loginPrompt: true,
    }).status,
    "intervention_required",
  );
  assert.equal(
    classifyLoginPage("douyin", `${douyinCreatorHomeUrl}?token=secret`, {
      ...none,
      authenticated: true,
    }).status,
    "intervention_required",
  );
});

test("抖音只读检测加载异常保守进入人工介入", async () => {
  const page = {
    goto: async () => {
      throw new Error("secret network detail");
    },
  } as unknown as Page;
  const result = await detectPlatformLogin(page, "douyin");
  assert.equal(result.status, "intervention_required");
  assert.doesNotMatch(result.message, /secret/);
});

function douyinSpaPage(mode: "delayed-auth" | "timeout") {
  let body = "";
  let controls = 0;
  const calls: string[] = [];
  const page = {
    goto: async (url: string) => calls.push(`goto:${url}`),
    waitForLoadState: async () => calls.push("networkidle"),
    waitForFunction: async () => {
      calls.push("wait-for-spa-signal");
      if (mode === "timeout") throw new Error("SPA timeout with secret detail");
      body = "发布视频 作品管理";
      controls = 2;
    },
    waitForTimeout: async (ms: number) => calls.push(`stability-delay:${ms}`),
    url: () => douyinCreatorHomeUrl,
    locator: (selector: string) => ({
      count: async () => (selector === "body" ? 1 : controls),
      innerText: async () => body,
    }),
    getByText: () => ({
      count: async () => 0,
      nth: () => ({ isVisible: async () => false }),
    }),
  } as unknown as Page;
  return { page, calls };
}

test("抖音SPA延迟出现稳定认证信号仍可识别且无写操作", async () => {
  const fixture = douyinSpaPage("delayed-auth");
  const result = await detectPlatformLogin(fixture.page, "douyin");
  assert.equal(result.status, "authenticated");
  assert.deepEqual(fixture.calls, [
    `goto:${douyinCreatorHomeUrl}`,
    "networkidle",
    "wait-for-spa-signal",
    "stability-delay:750",
  ]);
});

test("抖音SPA等待超时保守进入人工介入且错误脱敏", async () => {
  const fixture = douyinSpaPage("timeout");
  const result = await detectPlatformLogin(fixture.page, "douyin");
  assert.equal(result.status, "intervention_required");
  assert.match(result.message, /超时或网络异常/);
  assert.doesNotMatch(result.message, /secret|SPA/);
  assert.deepEqual(fixture.calls, [
    `goto:${douyinCreatorHomeUrl}`,
    "networkidle",
    "wait-for-spa-signal",
  ]);
});

test("抖音SPA等待网络和已知DOM信号后再判定，瞬态页面拒绝", async () => {
  const calls: string[] = [];
  let path = "/creator-micro/home";
  const page = {
    waitForLoadState: async () => {
      calls.push("networkidle");
    },
    waitForFunction: async () => {
      calls.push("known-signal");
    },
    url: () => `https://creator.douyin.com${path}`,
    locator: () => ({ count: async () => 3 }),
    waitForTimeout: async () => {
      calls.push("stability-window");
    },
  } as unknown as Page;
  await waitForDouyinStablePage(page);
  assert.deepEqual(calls, ["networkidle", "known-signal", "stability-window"]);

  const transient = {
    ...page,
    waitForTimeout: async () => {
      path = "/creator-micro/login";
    },
  } as unknown as Page;
  path = "/creator-micro/home";
  await assert.rejects(waitForDouyinStablePage(transient), /SPA仍在切换/);
});

test("account.checkLogin使用注入检测器且持久化结果，不打开浏览器", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-login-check-"));
  let checks = 0;
  const service = new Service(dir, {
    loginDetector: async () => {
      checks += 1;
      return { status: "authenticated", message: "只读检测通过" };
    },
  });
  try {
    const account = service.store.createAccount({
      platform: "zhihu",
      name: "登录",
    });
    service.browsers.open = async () => assert.fail("注入检测不应打开浏览器");
    const response = await service.dispatch({
      id: 1,
      method: "account.checkLogin",
      params: { id: account.id },
    });
    assert.equal(response.error, undefined);
    assert.equal(checks, 1);
    const checked = response.result as {
      loginStatus: string;
      checkedAt: string;
      message: string;
    };
    assert.equal(checked.loginStatus, "authenticated");
    assert.equal(checked.message, "只读检测通过");
    assert.ok(checked.checkedAt);
  } finally {
    await service.close();
  }
  const reopened = new Store(dir);
  try {
    assert.equal(reopened.accounts()[0]?.loginStatus, "authenticated");
    assert.equal(reopened.accounts()[0]?.message, "只读检测通过");
  } finally {
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("检测器网络错误保守映射人工介入而不是登录过期", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-login-error-"));
  const service = new Service(dir, {
    loginDetector: async () => {
      throw new Error("ETIMEDOUT with sensitive details");
    },
  });
  try {
    const account = service.store.createAccount({
      platform: "wechat-official",
      name: "网络异常",
    });
    const response = await service.dispatch({
      id: 1,
      method: "account.checkLogin",
      params: { id: account.id },
    });
    const checked = response.result as { loginStatus: string; message: string };
    assert.equal(checked.loginStatus, "intervention_required");
    assert.match(checked.message, /超时或网络异常/);
    assert.doesNotMatch(checked.message, /sensitive/);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("抖音account.checkLogin经过checking后将只读探测结果持久化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-login-"));
  let finish!: (value: LoginCheckResult) => void;
  const service = new Service(dir, {
    loginDetector: async (account) => {
      assert.equal(account.platform, "douyin");
      return await new Promise<LoginCheckResult>(
        (resolve) => (finish = resolve),
      );
    },
  });
  try {
    const account = service.store.createAccount({
      platform: "douyin",
      name: "抖音只读检测",
    });
    service.browsers.open = async () =>
      assert.fail("注入只读检测不应打开浏览器");
    const pending = service.dispatch({
      id: "douyin-login",
      method: "account.checkLogin",
      params: { id: account.id },
    });
    assert.equal(service.store.account(account.id).loginStatus, "checking");
    assert.match(service.store.account(account.id).message, /只读检测/);
    finish({ status: "authenticated", message: "抖音创作中心登录有效" });
    const response = await pending;
    assert.equal(response.error, undefined);
    assert.equal(
      service.store.account(account.id).loginStatus,
      "authenticated",
    );
    assert.equal(
      service.store.account(account.id).message,
      "抖音创作中心登录有效",
    );
  } finally {
    await service.close();
  }
  const reopened = new Store(dir);
  try {
    assert.equal(reopened.accounts()[0]?.loginStatus, "authenticated");
    assert.equal(reopened.accounts()[0]?.message, "抖音创作中心登录有效");
  } finally {
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("抖音account.checkLogin探测异常不会误判为过期或泄露错误", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turbopush-douyin-login-error-"));
  const service = new Service(dir, {
    loginDetector: async (account) => {
      assert.equal(account.platform, "douyin");
      throw new Error("secret cookie=DO_NOT_LEAK ETIMEDOUT");
    },
  });
  try {
    const account = service.store.createAccount({
      platform: "douyin",
      name: "抖音异常检测",
    });
    const response = await service.dispatch({
      id: "douyin-error",
      method: "account.checkLogin",
      params: { id: account.id },
    });
    assert.equal(response.error, undefined);
    const checked = response.result as { loginStatus: string; message: string };
    assert.equal(checked.loginStatus, "intervention_required");
    assert.notEqual(checked.loginStatus, "expired");
    assert.match(checked.message, /超时或网络异常/);
    assert.doesNotMatch(checked.message, /secret|cookie|DO_NOT_LEAK/);
    assert.equal(
      service.store.account(account.id).loginStatus,
      "intervention_required",
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

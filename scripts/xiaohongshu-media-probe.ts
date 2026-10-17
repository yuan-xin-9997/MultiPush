import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import type { Account } from "../packages/shared/src/index.ts";
import { BrowserManager } from "../packages/publisher-engine/src/browser-manager.ts";
import { acquireInstanceLock } from "../packages/publisher-engine/src/instance-lock.ts";
import { detectPlatformLogin } from "../packages/publisher-engine/src/platforms/login-status.ts";
import { isXiaohongshuAuthenticatedPage } from "../packages/publisher-engine/src/platforms/login-status.ts";
import {
  validateXiaohongshuPublishUrl,
  xiaohongshuGallerySelectors,
  xiaohongshuPublishUrl,
} from "../packages/publisher-engine/src/platforms/xiaohongshu/draft.ts";

export interface XiaohongshuMediaProbeOptions {
  dataDir: string;
  accountId: string;
  draftTitle: string;
  interactiveLogin: boolean;
  loginTimeoutMs: number;
}

class ProbeFailure extends Error {
  constructor(readonly stage: string) {
    super("只读探测失败");
  }
}

export type XiaohongshuInspectionStage =
  | "publish-page"
  | "draft-box"
  | "gallery-tab"
  | "title-candidate"
  | "edit-control"
  | "body-signal"
  | "media-structure";

export async function runXiaohongshuInspectionStage<T>(
  stage: XiaohongshuInspectionStage,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch {
    throw new ProbeFailure(stage);
  }
}

export function parseXiaohongshuMediaProbeOptions(args: string[]) {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--data-dir",
    "--account-id",
    "--draft-title",
    "--login-timeout-ms",
  ]);
  let interactiveLogin = false;
  for (let index = 0; index < args.length;) {
    const key = args[index];
    if (key === "--interactive-login") {
      if (interactiveLogin) throw new Error("--interactive-login 不能重复");
      interactiveLogin = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (
      !key ||
      !allowed.has(key) ||
      !value ||
      value.startsWith("--") ||
      values.has(key)
    )
      throw new Error(
        "参数必须唯一且仅含 --data-dir、--account-id、--draft-title",
      );
    values.set(key, value);
    index += 2;
  }
  const dataDir = values.get("--data-dir");
  const accountId = values.get("--account-id");
  const draftTitle = values.get("--draft-title")?.trim();
  if (!dataDir || !isAbsolute(dataDir))
    throw new Error("--data-dir 必须是显式绝对路径");
  if (!accountId || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(accountId))
    throw new Error("--account-id 必须是显式 UUID");
  if (!draftTitle) throw new Error("--draft-title 必须是非空的精确标题");
  const loginTimeoutMs = Number(values.get("--login-timeout-ms") ?? "300000");
  if (
    !Number.isInteger(loginTimeoutMs) ||
    loginTimeoutMs < 30000 ||
    loginTimeoutMs > 600000
  )
    throw new Error("--login-timeout-ms 必须为 30000..600000");
  if (!interactiveLogin && values.has("--login-timeout-ms"))
    throw new Error("--login-timeout-ms 仅用于显式交互登录模式");
  return {
    dataDir: resolve(dataDir),
    accountId,
    draftTitle,
    interactiveLogin,
    loginTimeoutMs,
  };
}

export async function waitForXiaohongshuInteractiveLogin(
  page: Page,
  timeoutMs: number,
  clock = { now: Date.now, sleep: (ms: number) => page.waitForTimeout(ms) },
) {
  const deadline = clock.now() + timeoutMs;
  let consecutive = 0;
  while (clock.now() < deadline) {
    const url = new URL(page.url());
    if (
      url.origin !== "https://creator.xiaohongshu.com" ||
      url.username ||
      url.password ||
      !["/", "/login", "/login/", "/new/home"].includes(url.pathname)
    )
      throw new Error("交互登录期间离开可信小红书登录或首页路由");
    const challenges = page.getByText(/验证码|安全验证|环境异常|异常流量/);
    for (
      let index = 0;
      index < Math.min(await challenges.count(), 20);
      index += 1
    )
      if (await challenges.nth(index).isVisible())
        throw new Error("平台要求安全验证，停止自动探测");
    let authenticated = false;
    if (url.pathname === "/new/home") {
      try {
        authenticated = isXiaohongshuAuthenticatedPage(
          page.url(),
          await page.locator("body").innerText(),
        );
      } catch {
        /* A navigation in flight is not an authenticated signal. */
      }
    }
    consecutive = authenticated ? consecutive + 1 : 0;
    if (consecutive >= 2) return true;
    await clock.sleep(Math.min(1000, Math.max(0, deadline - clock.now())));
  }
  throw new Error("交互登录等待超时，未得到稳定已登录信号");
}

export function classifyXiaohongshuMediaSource(
  raw: string,
  pageOrigin: string,
) {
  if (!raw) return "none";
  if (raw.startsWith("blob:")) return "blob";
  if (raw.startsWith("data:")) return "data";
  try {
    const url = new URL(raw, pageOrigin);
    if (url.protocol !== "https:") return "other";
    return url.origin === pageOrigin
      ? "same-origin-https"
      : "cross-origin-https";
  } catch {
    return "other";
  }
}

function assertTrustedPage(page: Page) {
  const url = new URL(page.url());
  if (
    url.origin !== "https://creator.xiaohongshu.com" ||
    url.username ||
    url.password
  )
    throw new Error("已离开小红书可信创作域名，停止只读探测");
}

async function uniqueVisible(
  page: Page,
  locator: ReturnType<Page["getByText"]>,
) {
  await locator.first().waitFor({ state: "visible", timeout: 15_000 });
  const matches = [];
  for (let index = 0; index < (await locator.count()); index += 1)
    if (await locator.nth(index).isVisible()) matches.push(locator.nth(index));
  if (matches.length !== 1)
    throw new Error("只读导航控件不唯一或不存在，未进入编辑页");
  assertTrustedPage(page);
  return matches[0]!;
}

/** Navigation only: never select files, fill a field, save, or publish. */
export async function inspectXiaohongshuDraftMedia(
  page: Page,
  draftTitle: string,
) {
  await runXiaohongshuInspectionStage("publish-page", async () => {
    await page.goto(validateXiaohongshuPublishUrl(xiaohongshuPublishUrl), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    assertTrustedPage(page);
  });
  await runXiaohongshuInspectionStage("draft-box", async () => {
    await (await uniqueVisible(page, page.getByText(/草稿箱/))).click();
    assertTrustedPage(page);
  });
  await runXiaohongshuInspectionStage("gallery-tab", async () => {
    await (
      await uniqueVisible(page, page.getByText(/^图文笔记\(\d+\)$/))
    ).click();
    assertTrustedPage(page);
  });
  const title = await runXiaohongshuInspectionStage("title-candidate", () =>
    uniqueVisible(page, page.getByText(draftTitle, { exact: true })),
  );
  await runXiaohongshuInspectionStage("edit-control", async () => {
    const edit = title.locator(
      "xpath=ancestor::*[.//*[normalize-space(text())='编辑']][1]//*[normalize-space(text())='编辑']",
    );
    await (await uniqueVisible(page, edit)).click();
    assertTrustedPage(page);
  });
  await runXiaohongshuInspectionStage("body-signal", async () => {
    await page.locator(xiaohongshuGallerySelectors.body).first().waitFor({
      state: "visible",
      timeout: 15_000,
    });
  });
  // Enumerate standard HTML media elements. No XHS-specific media selector is
  // assumed; the output is structural evidence, not an identity verdict.
  return runXiaohongshuInspectionStage("media-structure", async () => {
    const raw = await page.evaluate(() => {
      const sourceKind = (raw: string) => {
        if (!raw) return "none";
        if (raw.startsWith("blob:")) return "blob";
        if (raw.startsWith("data:")) return "data";
        try {
          const url = new URL(raw, location.origin);
          if (url.protocol !== "https:") return "other";
          return url.origin === location.origin
            ? "same-origin-https"
            : "cross-origin-https";
        } catch {
          return "other";
        }
      };
      return {
        images: [...document.images]
          .filter((image) => {
            const box = image.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          })
          .slice(0, 60)
          .map((image) => {
            const box = image.getBoundingClientRect();
            return {
              width: Math.round(box.width),
              height: Math.round(box.height),
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              complete: image.complete,
              sourceKind: sourceKind(image.currentSrc || image.src),
              parentTags: [
                image.parentElement,
                image.parentElement?.parentElement,
              ].map((element) => element?.tagName.toLowerCase() ?? "none"),
            };
          }),
        imageElementTotal: document.images.length,
      };
    });
    assertTrustedPage(page);
    return {
      editorOnTrustedOrigin: true,
      titleFieldPresent:
        (await page.locator(xiaohongshuGallerySelectors.title).count()) > 0,
      bodyFieldPresent: true,
      imageCountSignalPresent:
        (await page.getByText(/^\d+\s*\/\s*18$/).count()) > 0,
      ...raw,
      identityVerified: false,
      note: "仅脱敏结构；未读取或输出图片 URL、token、页面文本或图片字节",
    };
  });
}

export async function runXiaohongshuMediaProbe(args = process.argv.slice(2)) {
  let stage = "arguments";
  try {
    const options = parseXiaohongshuMediaProbeOptions(args);
    stage = "database-file";
    await access(join(options.dataDir, "turbopush.sqlite"));
    stage = "instance-lock";
    const lock = acquireInstanceLock(options.dataDir);
    let db: DatabaseSync | undefined;
    const browsers = new BrowserManager(options.dataDir);
    try {
      stage = "database-open";
      db = new DatabaseSync(join(options.dataDir, "turbopush.sqlite"), {
        readOnly: true,
      });
      stage = "account-check";
      const account = db
        .prepare(
          `SELECT id, platform, name, created_at AS createdAt,
       login_status AS loginStatus, login_checked_at AS checkedAt,
       login_message AS message FROM accounts WHERE id = ?`,
        )
        .get(options.accountId) as Account | undefined;
      if (!account || account.platform !== "xiaohongshu")
        throw new Error("指定账号不存在或平台不符");
      stage = "browser-open";
      const context = await browsers.open(account);
      const page = context.pages()[0] ?? (await context.newPage());
      stage = "login-check";
      if (options.interactiveLogin) {
        console.log(
          JSON.stringify({
            stage: "waiting-for-scan",
            timeoutMs: options.loginTimeoutMs,
          }),
        );
        stage = "interactive-login";
        await waitForXiaohongshuInteractiveLogin(page, options.loginTimeoutMs);
      }
      const login = options.interactiveLogin
        ? { status: "authenticated" as const }
        : await detectPlatformLogin(page, "xiaohongshu");
      if (login.status !== "authenticated") {
        let route = "other";
        try {
          const url = new URL(page.url());
          if (url.origin === "https://creator.xiaohongshu.com")
            route = /^\/login\/?$/.test(url.pathname)
              ? "login"
              : url.pathname === "/new/home"
                ? "new-home"
                : "creator-other";
        } catch {
          /* URL is untrusted: keep a fixed enum. */
        }
        stage = `login-check-${login.status}-${route}`;
        throw new Error("当前页面未通过小红书只读登录检测");
      }
      stage = "draft-inspection";
      const result = await inspectXiaohongshuDraftMedia(
        page,
        options.draftTitle,
      );
      console.log(JSON.stringify({ loginStatus: login.status, ...result }));
    } finally {
      await browsers.shutdown();
      db?.close();
      lock.release();
    }
  } catch (error) {
    throw error instanceof ProbeFailure ? error : new ProbeFailure(stage);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runXiaohongshuMediaProbe().catch((error) => {
    console.error(
      JSON.stringify({
        error: "只读探测失败；未输出页面或账号数据",
        stage: error instanceof ProbeFailure ? error.stage : "unknown",
      }),
    );
    process.exitCode = 1;
  });

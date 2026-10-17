import type { Page } from "playwright";
import type { AccountLoginStatus, PlatformId } from "@turbopush/shared";
import {
  douyinCreatorHomeUrl,
  isDouyinAuthenticatedPage,
  validateDouyinCreatorUrl,
  waitForDouyinStablePage,
} from "./douyin/login.ts";

export type CheckedLoginStatus = Exclude<
  AccountLoginStatus,
  "unknown" | "checking"
>;
export interface LoginPageSignals {
  authenticated: boolean;
  loginPrompt: boolean;
  securityChallenge: boolean;
}
export interface LoginCheckResult {
  status: CheckedLoginStatus;
  message: string;
}

async function hasVisibleText(page: Page, pattern: RegExp) {
  const matches = page.getByText(pattern);
  const count = Math.min(await matches.count(), 20);
  for (let index = 0; index < count; index += 1)
    if (await matches.nth(index).isVisible()) return true;
  return false;
}

export function isXiaohongshuAuthenticatedPage(url: string, bodyText: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "creator.xiaohongshu.com" &&
      parsed.pathname === "/new/home" &&
      bodyText.includes("创作服务平台") &&
      bodyText.includes("发布笔记")
    );
  } catch {
    return false;
  }
}

export function classifyLoginPage(
  platform: "wechat-official" | "zhihu" | "xiaohongshu" | "douyin",
  url: string,
  signals: LoginPageSignals,
): LoginCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { status: "intervention_required", message: "页面地址无法确认" };
  }
  let trusted =
    parsed.protocol === "https:" &&
    (platform === "wechat-official"
      ? parsed.hostname === "mp.weixin.qq.com"
      : platform === "xiaohongshu"
        ? parsed.hostname === "creator.xiaohongshu.com"
        : platform === "douyin"
          ? parsed.hostname === "creator.douyin.com"
          : ["www.zhihu.com", "zhuanlan.zhihu.com"].includes(parsed.hostname));
  if (platform === "douyin") {
    try {
      validateDouyinCreatorUrl(url);
      trusted = true;
    } catch {
      trusted = false;
    }
  }
  if (!trusted)
    return { status: "intervention_required", message: "跳转到非受信平台页面" };
  if (signals.authenticated && signals.loginPrompt)
    return {
      status: "intervention_required",
      message: "页面登录信号冲突，请人工确认",
    };
  if (signals.authenticated)
    return { status: "authenticated", message: "检测到稳定的已登录页面信号" };
  if (signals.securityChallenge)
    return {
      status: "intervention_required",
      message: "平台要求验证码或安全验证",
    };
  if (
    signals.loginPrompt ||
    (platform === "zhihu" && /^\/signin\/?$/.test(parsed.pathname))
  )
    return { status: "expired", message: "检测到明确的登录页面信号" };
  return {
    status: "intervention_required",
    message: "页面状态不明确，请人工确认",
  };
}

export async function detectPlatformLogin(
  page: Page,
  platform: PlatformId,
): Promise<LoginCheckResult> {
  if (
    platform !== "wechat-official" &&
    platform !== "zhihu" &&
    platform !== "xiaohongshu" &&
    platform !== "douyin"
  )
    return {
      status: "intervention_required",
      message: "该平台尚未支持登录检测",
    };
  try {
    await page.goto(
      platform === "wechat-official"
        ? "https://mp.weixin.qq.com/"
        : platform === "xiaohongshu"
          ? "https://creator.xiaohongshu.com/"
          : platform === "douyin"
            ? douyinCreatorHomeUrl
            : "https://www.zhihu.com/",
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    if (platform === "douyin") await waitForDouyinStablePage(page);
    if (platform === "xiaohongshu")
      await page
        .waitForFunction(
          () => {
            const text = document.body?.innerText ?? "";
            return (
              /\/login\/?$/.test(location.pathname) ||
              (location.pathname === "/new/home" &&
                text.includes("创作服务平台") &&
                text.includes("发布笔记")) ||
              (location.pathname === "/creator-micro/home" &&
                /发布视频|发布高清视频|作品发布/.test(text) &&
                /作品管理|内容管理/.test(text)) ||
              /验证码|安全验证|环境异常|异常流量|扫码登录|手机号登录/.test(text)
            );
          },
          undefined,
          { timeout: 10_000 },
        )
        .catch(() => undefined);
    // Creator pages may preload hidden help/dialog text containing these words.
    // Hidden matches are not an active challenge and must not override a stable
    // authenticated page signal.
    const securityChallenge = await hasVisibleText(
      page,
      /安全验证|环境异常|异常流量|拖动滑块|滑块验证|完成验证/,
    );
    const signals: LoginPageSignals =
      platform === "wechat-official"
        ? {
            authenticated:
              new URL(page.url()).pathname === "/cgi-bin/home" &&
              (await page
                .locator("#js_container, .weui-desktop-layout")
                .count()) > 0,
            loginPrompt:
              (await page.locator(".login__type__container, .qrcode").count()) >
              0,
            securityChallenge,
          }
        : platform === "xiaohongshu"
          ? {
              authenticated: isXiaohongshuAuthenticatedPage(
                page.url(),
                await page.locator("body").innerText(),
              ),
              loginPrompt:
                /^\/login\/?$/.test(new URL(page.url()).pathname) ||
                (await page.getByText(/扫码登录|手机号登录/).filter({ visible: true }).count()) > 0 ||
                (await page.locator('input[placeholder="手机号"]:visible').count()) > 0,
              securityChallenge,
            }
          : platform === "douyin"
            ? {
                authenticated: isDouyinAuthenticatedPage(
                  page.url(),
                  await page.locator("body").innerText(),
                ),
                loginPrompt:
                  /\/login\/?$/.test(new URL(page.url()).pathname) ||
                  (await page.getByText(/扫码登录|手机号登录/).count()) > 0,
                securityChallenge,
              }
            : {
                authenticated:
                  (await page
                    .locator(
                      ".AppHeader-profile:visible, .AppHeader-profileEntry:visible .AppHeader-profileAvatar:visible, [data-za-detail-view-element_name='头像']:visible",
                    )
                    .count()) > 0,
                loginPrompt:
                  (await page
                    .getByRole("button", { name: /登录/ })
                    .filter({ visible: true })
                    .count()) > 0,
                securityChallenge,
              };
    return classifyLoginPage(platform, page.url(), signals);
  } catch {
    return {
      status: "intervention_required",
      message: "页面加载超时或网络异常，无法确认登录是否过期",
    };
  }
}

export const douyinCreatorHomeUrl =
  "https://creator.douyin.com/creator-micro/home";

const allowedCreatorPaths = new Set([
  "/creator-micro/home",
  "/creator-micro/login",
]);

/** Strict URLs used by read-only login probing; no credentials or parameters. */
export function validateDouyinCreatorUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "creator.douyin.com" ||
    !allowedCreatorPaths.has(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("无效的抖音创作平台地址");
  return url.href;
}

export function isDouyinAuthenticatedPage(url: string, bodyText: string) {
  try {
    return (
      validateDouyinCreatorUrl(url) === douyinCreatorHomeUrl &&
      /发布视频|发布高清视频|作品发布/.test(bodyText) &&
      /作品管理|内容管理/.test(bodyText)
    );
  } catch {
    return false;
  }
}

/** Wait for the client-rendered shell without reading or returning account data. */
export async function waitForDouyinStablePage(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForFunction(
    () => {
      const path = location.pathname;
      const text = document.body?.innerText ?? "";
      const controls = document.querySelectorAll("button,input,[role='button'],[role='textbox']").length;
      const knownSignal =
        /\/login\/?$/.test(path) ||
        (path === "/creator-micro/home" && /发布视频|发布高清视频|作品发布/.test(text) && /作品管理|内容管理/.test(text)) ||
        /扫码登录|手机号登录|验证码|安全验证|环境异常|异常流量/.test(text);
      return document.readyState === "complete" && controls > 0 && knownSignal;
    },
    undefined,
    { timeout: 20_000, polling: 250 },
  );
  // Reject a transient first paint: the same trusted path and a non-empty
  // control shell must survive a second observation.
  const firstPath = new URL(page.url()).pathname;
  const firstCount = await page.locator("button,input,[role='button'],[role='textbox']").count();
  await page.waitForTimeout(750);
  const stable =
    new URL(page.url()).pathname === firstPath &&
    firstCount > 0 &&
    (await page.locator("button,input,[role='button'],[role='textbox']").count()) > 0;
  if (!stable) throw new Error("抖音SPA仍在切换，无法确认稳定页面状态");
}
import type { Page } from "playwright";

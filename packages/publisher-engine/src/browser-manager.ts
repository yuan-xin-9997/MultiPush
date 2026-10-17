import { chromium, type BrowserContext } from "playwright";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { platforms, type Account } from "@turbopush/shared";

export interface BrowserNetworkDiagnostic {
  host: string;
  method: string;
  pathShape: string;
  contentType: string;
  bodyBytes: number | null;
  status: number | null;
  error?: string;
}
export function networkDiagnostic(
  method: string,
  value: string,
  contentType: string,
  bodyBytes: number | null,
): BrowserNetworkDiagnostic {
  const url = new URL(value);
  const known = new Set([
    "api",
    "articles",
    "draft",
    "images",
    "image",
    "upload",
    "cgi-bin",
    "filetransfer",
    "appmsgpublish",
    "notes",
    "sns",
    "web",
    "v1",
    "v2",
  ]);
  return {
    host: url.hostname,
    method,
    pathShape: url.pathname
      .split("/")
      .map((part) => (!part || known.has(part) ? part : "_"))
      .join("/"),
    contentType: contentType.split(";")[0],
    bodyBytes,
    status: null,
  };
}

export class BrowserManager {
  private contexts = new Map<string, BrowserContext>();
  private opening = new Map<string, Promise<BrowserContext>>();
  private directory: string;
  private networkEvidence = new Map<string, BrowserNetworkDiagnostic[]>();
  network(accountId: string) {
    return this.networkEvidence.get(accountId) ?? [];
  }
  constructor(directory: string) {
    this.directory = directory;
  }
  profilePath(accountId: string) {
    return join(this.directory, "browser-profiles", z.uuid().parse(accountId));
  }
  async open(account: Account): Promise<BrowserContext> {
    const current = this.contexts.get(account.id);
    if (current) {
      await current.pages().at(-1)?.bringToFront();
      return current;
    }
    const pending = this.opening.get(account.id);
    if (pending) return pending;
    const launch = this.launch(account);
    this.opening.set(account.id, launch);
    try {
      return await launch;
    } finally {
      this.opening.delete(account.id);
    }
  }
  private async launch(account: Account) {
    const profile = this.profilePath(account.id);
    await mkdir(profile, { recursive: true });
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profile, {
        headless: false,
        viewport: null,
        ...(process.env.TURBOPUSH_BROWSER_CHANNEL
          ? { channel: process.env.TURBOPUSH_BROWSER_CHANNEL }
          : {}),
      });
    } catch {
      throw new Error(
        "无法启动浏览器。请执行 pnpm browser:install，或设置 TURBOPUSH_BROWSER_CHANNEL=msedge 使用本机 Edge。",
      );
    }
    const network: BrowserNetworkDiagnostic[] = [];
    const requests = new WeakMap<
      import("playwright").Request,
      BrowserNetworkDiagnostic
    >();
    this.networkEvidence.set(account.id, network);
    context.on("request", (request) => {
      if (!["POST", "PUT", "PATCH"].includes(request.method())) return;
      try {
        const row = networkDiagnostic(
          request.method(),
          request.url(),
          request.headers()["content-type"] ?? "",
          request.postDataBuffer()?.length ?? null,
        );
        requests.set(request, row);
        network.push(row);
        if (network.length > 40) network.shift();
      } catch {
        /* Network diagnostics must never interfere with a platform request. */
      }
    });
    context.on("response", (response) => {
      const row = requests.get(response.request());
      if (row) row.status = response.status();
    });
    context.on("requestfailed", (request) => {
      const row = requests.get(request);
      if (row) {
        const error = request.failure()?.errorText ?? "";
        row.error = /^net::ERR_[A-Z_]+$/.test(error) ? error : "REQUEST_FAILED";
      }
    });
    this.contexts.set(account.id, context);
    context.on("close", () => this.contexts.delete(account.id));
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(
        platforms.find((p) => p.id === account.platform)!.loginUrl,
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      );
    } catch {
      // Leave the window open for network diagnosis and manual login.
      throw new Error(
        "浏览器已打开，但平台页面加载失败，请在窗口中检查网络后重试。",
      );
    }
    return context;
  }
  async inspect(account: Account) {
    const context = this.contexts.get(account.id);
    if (!context) throw new Error("请先打开账号浏览器");
    const expectedHost = new URL(
      platforms.find((platform) => platform.id === account.platform)!.loginUrl,
    ).hostname;
    const result = [];
    for (const [index, page] of context.pages().entries()) {
      const url = new URL(page.url());
      if (
        url.hostname !== expectedHost &&
        !(
          account.platform === "zhihu" && url.hostname === "zhuanlan.zhihu.com"
        ) &&
        !(
          account.platform === "xiaohongshu" &&
          url.hostname === "www.xiaohongshu.com"
        )
      )
        continue;
      const controls = await page.locator("body").evaluate((body) =>
        [
          ...body.querySelectorAll(
            'button,input,textarea,[contenteditable=true],[role=button],header img,[class*=Header] img,[class*=Nav] img,.AppHeader-profileAvatar,a[href*="/creator"]',
          ),
        ]
          .filter(
            (element) =>
              element.getClientRects().length &&
              getComputedStyle(element).visibility !== "hidden",
          )
          .slice(0, 100)
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            classes: element.className,
            role: element.getAttribute("role"),
            text:
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement
                ? ""
                : (element.textContent ?? "").trim().slice(0, 100),
            placeholder: element.getAttribute("placeholder"),
            label: element.getAttribute("aria-label"),
            alt: element.getAttribute("alt"),
          })),
      );
      result.push({
        index,
        origin: url.origin,
        path: url.pathname,
        queryKeys: [...url.searchParams.keys()],
        title: await page.title(),
        controls,
        images: await page.locator("img").evaluateAll((images) =>
          images.map((element, index) => {
            const image = element as HTMLImageElement;
            const box = image.getBoundingClientRect();
            const src = image.currentSrc || image.src;
            return {
              index,
              classes: image.className,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
              width: box.width,
              height: box.height,
              source: src.startsWith("blob:")
                ? "blob"
                : src.startsWith("data:")
                  ? "data"
                  : src.startsWith("https:")
                    ? new URL(src).hostname
                    : "other",
            };
          }),
        ),
      });
    }
    return result;
  }
  async capture(accountId: string) {
    const pages = this.contexts.get(accountId)?.pages() ?? [];
    let page = pages.at(-1);
    for (const candidate of pages) {
      if (
        await candidate
          .evaluate(() => document.visibilityState === "visible")
          .catch(() => false)
      )
        page = candidate;
    }
    if (!page) throw new Error("请先打开账号浏览器");
    const directory = join(this.directory, "screenshots");
    await mkdir(directory, { recursive: true });
    const file = join(
      directory,
      `${z.uuid().parse(accountId)}-${Date.now()}.png`,
    );
    await page.screenshot({ path: file, fullPage: false, timeout: 10_000 });
    return { file, message: "截图已保存在本机，可能含账号信息，请勿公开上传" };
  }
  async close(accountId: string) {
    await this.contexts.get(accountId)?.close();
  }
  async shutdown() {
    await Promise.allSettled(this.opening.values());
    await Promise.allSettled([...this.contexts.values()].map((c) => c.close()));
  }
}

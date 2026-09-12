import { chromium, type BrowserContext } from "playwright";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { platforms, type Account } from "@turbopush/shared";

export class BrowserManager {
  private contexts = new Map<string, BrowserContext>();
  private opening = new Map<string, Promise<BrowserContext>>();
  private directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  profilePath(accountId: string) {
    return join(this.directory, "browser-profiles", z.uuid().parse(accountId));
  }
  async open(account: Account): Promise<BrowserContext> {
    const current = this.contexts.get(account.id);
    if (current) {
      await current.pages()[0]?.bringToFront();
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
  async capture(accountId: string) {
    const page = this.contexts.get(accountId)?.pages().at(-1);
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

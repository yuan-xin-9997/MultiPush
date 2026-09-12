import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Store } from "../packages/database/src/index.ts";
import { BrowserManager } from "../packages/publisher-engine/src/browser-manager.ts";

// Interactive development harness: all navigation uses this app's isolated account Profile.
const directory = resolve(process.env.TURBOPUSH_DATA_DIR ?? ".data");
const store = new Store(directory);
const account =
  store.accounts().find((a) => a.platform === "zhihu") ??
  store.createAccount({ platform: "zhihu", name: "知乎验证账号" });
const browsers = new BrowserManager(directory);
const context = await browsers.open(account);
let page = context.pages()[0];
console.log("知乎独立浏览器已打开，请在窗口中登录。此过程不会发布文章。");
async function inspect() {
  page = context.pages().at(-1)!;
  const result = await page.evaluate(() => ({
    title: document.title,
    path: location.origin + location.pathname,
    inputs: [
      ...document.querySelectorAll('input,textarea,[contenteditable="true"]'),
    ].map((el) => ({
      tag: el.tagName,
      placeholder: el.getAttribute("placeholder"),
      role: el.getAttribute("role"),
      className: el.className,
      editable: el.getAttribute("contenteditable"),
    })),
    buttons: [...document.querySelectorAll("button")]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => el.innerText)
      .filter(Boolean)
      .slice(0, 35),
    headings: [...document.querySelectorAll("h1,h2,h3")]
      .map((el) => el.textContent)
      .slice(0, 10),
  }));
  console.log(JSON.stringify(result));
}
await inspect();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of input) {
    try {
      const command = JSON.parse(line);
      if (command.action === "close") break;
      if (command.action === "editor") {
        await page.goto("https://zhuanlan.zhihu.com/write", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await inspect();
      }
      if (command.action === "inspect") await inspect();
      if (command.action === 'media-probe') {
        const {probe} = await import(`./zhihu-media-probe.ts?revision=${Date.now()}`);
        await probe(context, command.step);
      }
      if (command.action === "draft") {
        const { runDraftProbe } = await import("./zhihu-draft-probe.ts");
        await runDraftProbe(page, directory, command.run ?? 1);
      }
      if (command.action === "text") {
        console.log(
          JSON.stringify({
            text: (await page.locator("body").innerText()).slice(0, 6000),
          }),
        );
      }
      if (command.action === "links") {
        console.log(
          JSON.stringify(
            await page.locator("a[href]").evaluateAll((elements) =>
              elements
                .map((el) => ({
                  text: (el as HTMLElement).innerText,
                  href: (el as HTMLAnchorElement).href,
                }))
                .filter((el) => el.text)
                .slice(0, 40),
            ),
          ),
        );
      }
      if (command.action === "verify-draft") {
        const { saveZhihuDraft } = await import(
          `../packages/publisher-engine/src/platforms/zhihu/draft.ts?revision=${Date.now()}`
        );
        const run = Number(command.run ?? 1);
        const title = `TurboPushForked 开发验证草稿 ${new Date().toISOString().slice(0, 10)}-${run}`;
        const body = `这是一篇由 TurboPushForked 开发验证生成的测试草稿（第 ${run} 次）。\n\n仅用于验证标题、正文与自动保存，不进行公开发布。\n\n测试完成后可以手动删除。`;
        const result = await saveZhihuDraft(
          context,
          { type: "article", title, body, images: [] },
          { draftUrl: command.url },
        );
        console.log(JSON.stringify({ run, ...result }));
      }
      if (command.action === "screenshot") {
        await mkdir(join(directory, "screenshots"), { recursive: true });
        const path = join(directory, "screenshots", "zhihu-spike.png");
        await page.screenshot({ path });
        console.log(JSON.stringify({ screenshot: path }));
      }
    } catch (error) {
      console.log(
        JSON.stringify({
          error: error instanceof Error ? error.message : "操作失败",
        }),
      );
    }
  }
} finally {
  await browsers.shutdown();
  store.close();
}

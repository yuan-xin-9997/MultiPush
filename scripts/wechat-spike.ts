import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { Store } from "../packages/database/src/index.ts";
import { BrowserManager } from "../packages/publisher-engine/src/browser-manager.ts";

// Explicit probe actions may save development drafts, but never publish them.
// Never log authenticated URL parameters.
const directory = resolve(process.env.TURBOPUSH_DATA_DIR ?? ".data");
const store = new Store(directory);
const account =
  store.accounts().find((a) => a.platform === "wechat-official") ??
  store.createAccount({ platform: "wechat-official", name: "公众号验证账号" });
const browsers = new BrowserManager(directory);
try {
  const context = await browsers.open(account);
  async function inspect() {
    const page = context.pages().at(-1)!;
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          title: document.title,
          path: location.origin + location.pathname,
          inputs: [
            ...document.querySelectorAll(
              'input,textarea,[contenteditable="true"]',
            ),
          ]
            .filter((el) => el.getBoundingClientRect().width > 0)
            .map((el) => ({
              tag: el.tagName,
              id: el.id,
              placeholder: el.getAttribute("placeholder"),
              role: el.getAttribute("role"),
              editable: el.getAttribute("contenteditable"),
            })),
          controls: [...document.querySelectorAll('a,button,[role="button"]')]
            .filter((el) => el.getBoundingClientRect().width > 0)
            .map((el) => ({
              tag: el.tagName,
              text: (el as HTMLElement).innerText.trim(),
            }))
            .filter((el) => el.text)
            .slice(0, 70),
          frames: [...document.querySelectorAll("iframe")].map((el) => ({
            id: el.id,
            title: el.title,
          })),
        })),
      ),
    );
  }
  console.log("公众号独立浏览器已打开；检查命令只读，显式测试命令可保存开发草稿，不公开发布。");
  await inspect();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    try {
      const command = JSON.parse(line);
      if (command.action === "close") break;
      if (command.action === "inspect") await inspect();
      if (command.action === "probe") {
        const { probe } = await import(
          `./wechat-probe.ts?revision=${Date.now()}`
        );
        await probe(context, command);
      }
      if (command.action === "screenshot")
        console.log(JSON.stringify(await browsers.capture(account.id)));
    } catch {
      // Playwright error messages may contain token-bearing URLs.
      console.log(
        JSON.stringify({
          error: "检查失败，请确认浏览器仍打开且命令有效；未输出敏感页面地址。",
        }),
      );
    }
  }
} finally {
  await browsers.shutdown();
  store.close();
}

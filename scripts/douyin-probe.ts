import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { Service } from "../packages/publisher-engine/src/service.ts";
import { detectPlatformLogin } from "../packages/publisher-engine/src/platforms/login-status.ts";
import {
  douyinCreatorHomeUrl,
  waitForDouyinStablePage,
} from "../packages/publisher-engine/src/platforms/douyin/login.ts";

const commands = [
  "inspect",
  "structure",
  "video-structure",
  "login-status",
  "close",
] as const;

const safeLabels = [
  "发布视频",
  "发布高清视频",
  "上传视频",
  "作品发布",
  "作品管理",
  "内容管理",
] as const;
const safeLocation = (raw: string) => {
  const url = new URL(raw);
  return { origin: url.origin, pathname: url.pathname };
};

export async function probeDouyinVideoStructure(page: Page) {
  const current = new URL(page.url());
  if (
    current.protocol !== "https:" ||
    current.hostname !== "creator.douyin.com" ||
    current.pathname !== "/creator-micro/home" ||
    current.username ||
    current.password ||
    current.search ||
    current.hash
  )
    throw new Error("必须从已认证的抖音创作首页开始只读探测");

  const targets = page.getByText("发布高清视频", { exact: true });
  if ((await targets.count()) !== 1)
    throw new Error("未找到唯一的“发布高清视频”导航控件");
  await targets.first().click();
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await page.waitForFunction(
    () =>
      document.readyState === "complete" &&
      document.querySelectorAll(
        "input,textarea,button,[role='button'],[contenteditable='true']",
      ).length > 0,
    undefined,
    { timeout: 20_000, polling: 250 },
  );
  const firstPath = new URL(page.url()).pathname;
  await page.waitForTimeout(750);
  const destination = new URL(page.url());
  if (
    destination.protocol !== "https:" ||
    destination.hostname !== "creator.douyin.com" ||
    destination.username ||
    destination.password ||
    destination.search ||
    destination.hash ||
    destination.pathname !== "/creator-micro/content/upload" ||
    destination.pathname !== firstPath
  )
    throw new Error("抖音视频发布页未稳定在可信创作平台地址");

  const fileInputs = await page
    .locator("input[type='file']")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        accept: node instanceof HTMLInputElement ? node.accept : "",
        multiple: node instanceof HTMLInputElement && node.multiple,
      })),
    );
  const counts = await page
    .locator(
      "input,textarea,button,[role='button'],[role='textbox'],[contenteditable='true']",
    )
    .evaluateAll((nodes) => {
      const visible = nodes.filter((node) =>
        Boolean(
          (node as HTMLElement).offsetWidth ||
          (node as HTMLElement).offsetHeight,
        ),
      );
      const signals = visible.map((node) =>
        [
          node.getAttribute("placeholder") ?? "",
          node.getAttribute("aria-label") ?? "",
          node.textContent ?? "",
        ]
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      );
      return {
        title: signals.filter((value) => /标题/.test(value)).length,
        body: signals.filter((value) => /正文|描述|简介/.test(value)).length,
        draft: signals.filter((value) => /草稿|暂存/.test(value)).length,
        publish: signals.filter((value) => /发布/.test(value)).length,
      };
    });
  return {
    page: { pathname: destination.pathname },
    fileInputs,
    knownControlCounts: counts,
    note: "严格脱敏只读结构；未选择文件、填写、保存或发布，不输出文本、账号信息、query、Cookie、token、请求头或请求体",
  };
}

export async function main() {
  const command = process.argv[2] ?? "inspect";
  if (!commands.includes(command as (typeof commands)[number]))
    throw new Error(`用法: tsx scripts/douyin-probe.ts ${commands.join("|")}`);
  const service = new Service(
    resolve(process.env.TURBOPUSH_DATA_DIR ?? ".data"),
  );
  try {
    const requestedId = process.env.TURBOPUSH_ACCOUNT_ID;
    const account = service.store
      .accounts()
      .find(
        (item) =>
          item.platform === "douyin" &&
          (!requestedId || item.id === requestedId),
      );
    if (!account) throw new Error("未找到抖音账号，请先在桌面端创建账号");
    if (command === "close") {
      await service.browsers.close(account.id);
      console.log(JSON.stringify({ closed: true }));
    } else {
      const context = await service.browsers.open(account);
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(douyinCreatorHomeUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      try {
        await waitForDouyinStablePage(page);
      } catch {
        console.log(
          JSON.stringify({
            page: safeLocation(page.url()),
            status: "intervention_required",
            reason: "SPA在等待窗口内未出现稳定的已知页面信号",
            controlsReady: false,
          }),
        );
        throw new Error("抖音SPA稳定信号等待超时");
      }
      if (command === "login-status") {
        console.log(JSON.stringify(await detectPlatformLogin(page, "douyin")));
      } else if (command === "video-structure") {
        console.log(JSON.stringify(await probeDouyinVideoStructure(page)));
      } else if (command === "structure") {
        const raw = await page
          .locator("button,input,textarea,[role],[contenteditable='true']")
          .evaluateAll((nodes) =>
            nodes.slice(0, 120).map((node, ordinal) => ({
              ordinal,
              tag: node.tagName.toLowerCase(),
              role: node.getAttribute("role") ?? "",
              type: node instanceof HTMLInputElement ? node.type : "",
              text: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
              visible: Boolean(
                (node as HTMLElement).offsetWidth ||
                (node as HTMLElement).offsetHeight,
              ),
              disabled:
                node.getAttribute("aria-disabled") === "true" ||
                ("disabled" in node &&
                  Boolean((node as HTMLButtonElement).disabled)),
            })),
          );
        const controls = raw.map(({ text, ...item }) => ({
          ...item,
          knownLabel: safeLabels.find((label) => text.includes(label)) ?? null,
        }));
        console.log(
          JSON.stringify({
            page: safeLocation(page.url()),
            controls,
            knownControlCounts: Object.fromEntries(
              safeLabels.map((label) => [
                label,
                controls.filter((item) => item.knownLabel === label).length,
              ]),
            ),
            note: "严格脱敏只读结构；不输出正文、昵称、账号ID、任意文本、query、Cookie、token、请求头或请求体",
          }),
        );
      } else {
        console.log(
          JSON.stringify({
            platform: "douyin",
            page: safeLocation(page.url()),
            capability: "unverified-read-only",
          }),
        );
      }
    }
  } finally {
    await service.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();

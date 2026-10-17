import { createServer } from "vite";
import { chromium } from "playwright";
import { mkdtemp, rm, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const directory = await mkdtemp(join(tmpdir(), "turbopush-ui-"));
process.env.TURBOPUSH_DATA_DIR = directory;
const sourceImage = join(directory, "picker-source.png");
await writeFile(
  sourceImage,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const server = await createServer({
  root: resolve("apps/desktop"),
  configFile: resolve("apps/desktop/vite.config.ts"),
});
await server.listen();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TURBOPUSH_BROWSER_CHANNEL
    ? { channel: process.env.TURBOPUSH_BROWSER_CHANNEL }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors: string[] = [];
  let snapshotRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      request.url().endsWith("/__rpc") &&
      request.postDataJSON()?.method === "snapshot"
    )
      snapshotRequests += 1;
  });
  await page.goto(`http://127.0.0.1:${process.env.TURBOPUSH_PORT ?? 34080}`);
  await page.getByText("本地引擎已连接").waitFor();
  await page.waitForTimeout(2200);
  assert.ok(snapshotRequests >= 2, "snapshot should refresh periodically");
  await mkdir(resolve("test-results"), { recursive: true });
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
  await page.getByRole("button", { name: "账号管理", exact: false }).click();
  await page.getByLabel("账号备注").fill("公众号测试账号");
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page.getByText("公众号测试账号", { exact: true }).waitFor();
  await page.getByText("未检查", { exact: true }).waitFor();
  let checkedAccountId = "";
  await page.route("**/__rpc", async (route) => {
    const request = route.request().postDataJSON() as {
      id: string;
      method?: string;
      params?: { id?: string };
    };
    if (request.method === "account.checkLogin") {
      checkedAccountId = request.params?.id ?? "";
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: request.id, result: { status: "expired" } }),
      });
    }
    if (request.method === "snapshot" && checkedAccountId) {
      const response = await route.fetch();
      const body = (await response.json()) as {
        id: string;
        result: { accounts: Array<Record<string, unknown>> };
      };
      const account = body.result.accounts.find(
        (item) => item.id === checkedAccountId,
      );
      if (account) {
        account.loginStatus = "expired";
        account.checkedAt = "2099-01-02T03:04:00.000Z";
        account.message = "登录凭据已过期，请重新认证";
      }
      return route.fulfill({ response, json: body });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "检查登录状态" }).click();
  assert.ok(checkedAccountId);
  await page.getByText("登录已过期", { exact: true }).waitFor();
  await page.getByText("最近检查：", { exact: false }).waitFor();
  await page.getByText("登录凭据已过期，请重新认证", { exact: true }).waitFor();
  await page.getByRole("button", { name: "打开登录窗口 / 重新认证" }).waitFor();
  await page.unroute("**/__rpc");
  await page.getByLabel("平台").selectOption("xiaohongshu");
  await page.getByLabel("账号备注").fill("小红书测试账号");
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page.getByText("小红书测试账号", { exact: true }).waitFor();
  await page
    .getByText("小红书", { exact: true })
    .locator("..")
    .getByText("未检查", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "内容中心", exact: false }).click();
  await page.getByLabel("标题", { exact: true }).fill("我的第一篇测试文章");
  await page
    .getByLabel("正文 / Markdown")
    .fill("# 测试文章\n\n这是本地预检测试，不会发布到平台。");
  await page.getByRole("button", { name: "保存内容", exact: true }).click();
  await page.getByRole("heading", { name: "我的第一篇测试文章" }).waitFor();
  await page
    .getByRole("button", { name: "创建发布计划 →", exact: true })
    .click();
  await page.getByRole("checkbox").check();
  await page.getByLabel("草稿队列执行时间").fill("2099-01-01T12:00");
  await page.getByRole("button", { name: "加入草稿队列" }).click();
  await page.getByText("等待草稿队列", { exact: true }).waitFor();
  await page.getByText("只保存草稿，不公开发布", { exact: false }).waitFor();
  await page.getByRole("button", { name: "本地预检", exact: true }).click();
  await page.getByText("待人工验证", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("本地引擎已连接").waitFor();
  await page.getByRole("button", { name: "批量任务", exact: false }).click();
  await page.getByText("待人工验证", { exact: true }).waitFor();
  await page
    .getByLabel("草稿队列汇总")
    .getByText("需处理", { exact: true })
    .waitFor();
  await page
    .getByLabel("草稿队列汇总")
    .getByText("1", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "查看事件记录", exact: true }).click();
  await page.getByLabel("任务事件时间线").waitFor();
  await page
    .getByLabel("任务事件时间线")
    .getByText("本地字段与素材检查通过", { exact: false })
    .first()
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "收起事件记录", exact: true })
      .getAttribute("aria-expanded"),
    "true",
  );
  await page.screenshot({ path: "test-results/tasks.png", fullPage: true });
  await page.getByRole("button", { name: "内容中心", exact: false }).click();
  await page.getByRole("button", { name: "编辑内容", exact: true }).click();
  assert.equal(
    await page.getByLabel("标题", { exact: true }).inputValue(),
    "我的第一篇测试文章",
  );
  await page.getByLabel("标题", { exact: true }).fill("已编辑的文章");
  const imagePicker = page.getByLabel("选择并托管正文图片", {
    exact: true,
  });
  await imagePicker.setInputFiles(sourceImage);
  await page.getByText("已选择并托管1张图片", { exact: false }).waitFor();
  const hostedImage = await page
    .getByLabel("正文图片（每行一张）")
    .inputValue();
  assert.match(hostedImage, /[\\/]assets[\\/][a-f0-9]{64}\.png$/);
  assert.equal((await stat(hostedImage)).isFile(), true);
  await page.getByRole("button", { name: "保存内容", exact: true }).click();
  await page
    .getByRole("heading", { name: "已编辑的文章", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "创建发布计划 →", exact: true })
    .click();
  await page.getByRole("checkbox").check();
  await page.getByLabel("草稿队列执行时间").fill("");
  await page.getByRole("button", { name: "创建待处理任务" }).click();
  let enqueueRequest: { method?: string; params?: { id?: string } } | undefined;
  await page.route("**/__rpc", async (route) => {
    const request = route.request().postDataJSON() as {
      id: string;
      method?: string;
      params?: { id?: string };
    };
    if (request.method === "task.enqueueDraft") {
      enqueueRequest = request;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: request.id, result: { queued: true } }),
      });
    }
    if (request.method === "snapshot" && enqueueRequest?.params?.id) {
      const response = await route.fetch();
      const body = (await response.json()) as {
        id: string;
        result: { tasks: Array<Record<string, unknown>> };
      };
      const queued = body.result.tasks.find(
        (task) => task.id === enqueueRequest?.params?.id,
      );
      if (queued) {
        queued.status = "scheduled";
        queued.scheduledAt = "2099-02-02T03:04:00.000Z";
        queued.attemptCount = 2;
        queued.nextRunAt = "2099-02-02T03:09:00.000Z";
        queued.message = "网络波动，等待第 3 次草稿保存尝试";
      }
      return route.fulfill({ response, json: body });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "加入草稿队列", exact: true }).click();
  await page
    .getByText("到期后只保存草稿，不公开发布", { exact: false })
    .waitFor();
  assert.equal(enqueueRequest?.method, "task.enqueueDraft");
  assert.ok(enqueueRequest?.params?.id);
  await page.getByRole("progressbar", { name: "草稿队列进度" }).waitFor();
  await page.getByText("queued · 正在等待草稿队列调度").waitFor();
  await page
    .getByLabel("队列重试信息")
    .getByText("2", { exact: true })
    .waitFor();
  await page.getByText("下次重试", { exact: true }).waitFor();
  await page.unroute("**/__rpc");
  await page.getByRole("button", { name: "批量任务", exact: false }).click();
  await page.getByText("我的第一篇测试文章", { exact: true }).waitFor();
  await page.getByRole("button", { name: "内容中心", exact: false }).click();
  await page.getByText("Web端支持图片上传", { exact: false }).waitFor();
  const portableDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载便携归档", exact: true }).click();
  const portableStream = await (await portableDownload).createReadStream();
  assert.ok(portableStream);
  const portableChunks: Buffer[] = [];
  for await (const chunk of portableStream)
    portableChunks.push(Buffer.from(chunk));
  const portableArchive = JSON.parse(
    Buffer.concat(portableChunks).toString("utf8"),
  );
  assert.equal(portableArchive.version, 2);
  assert.equal(portableArchive.assets.length, 1);
  portableArchive.contents[0].title = "便携归档导入回读";
  await page.getByLabel("选择并导入便携归档", { exact: true }).setInputFiles({
    name: "portable-v2.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(portableArchive)),
  });
  await page
    .getByRole("heading", { name: "便携归档导入回读", exact: true })
    .waitFor();
  await page
    .getByText("已导入1篇内容并重建图片素材", { exact: false })
    .waitFor();
  const pendingDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出旧内容 JSON", exact: true })
    .click();
  const download = await pendingDownload;
  const stream = await download.createReadStream();
  assert.ok(stream);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const archive = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(archive.version, 1);
  const legacyContent = archive.contents.find(
    (content: { title?: string }) => content.title === "已编辑的文章",
  );
  assert.ok(legacyContent);
  assert.equal(legacyContent.id, undefined);
  legacyContent.title = "导入回读验证";
  await page
    .getByLabel("导入旧内容 JSON（最多100篇、文件小于900KB）")
    .setInputFiles({
      name: "contents.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(archive)),
    });
  await page
    .getByRole("heading", { name: "导入回读验证", exact: true })
    .waitFor();
  // Xiaohongshu gallery exposes one verified draft action. This smoke test
  // checks the UI gate only and never invokes the remote save.
  await page.getByLabel("内容类型").selectOption("gallery");
  await page.getByLabel("标题", { exact: true }).fill("小红书图文骨架验证");
  await page
    .getByLabel("正文 / Markdown")
    .fill("只做本地预检，不写入真实平台。");
  await page
    .getByLabel("正文图片（每行一张）")
    .fill(`${hostedImage}\n${sourceImage}`);
  await page.getByRole("button", { name: "保存内容", exact: true }).click();
  await page
    .getByRole("heading", { name: "小红书图文骨架验证", exact: true })
    .waitFor();
  await page
    .getByRole("heading", { name: "小红书图文骨架验证", exact: true })
    .locator("..")
    .getByRole("button", { name: "创建发布计划 →", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /小红书测试账号/ }).check();
  await page.getByRole("button", { name: "创建待处理任务" }).click();
  const saveDraft = page.getByRole("button", {
    name: "保存小红书草稿",
    exact: true,
  });
  await saveDraft.waitFor();
  assert.equal(await saveDraft.count(), 1);
  assert.equal(await saveDraft.isEnabled(), true);
  assert.equal(
    await page.getByRole("button", { name: /待真实页面验证/ }).count(),
    0,
  );
  await page
    .locator("article.task")
    .filter({ hasText: "小红书图文骨架验证" })
    .getByRole("button", { name: "本地预检", exact: true })
    .click();
  await page.getByText("待人工验证", { exact: true }).first().waitFor();
  // Reject cross-origin requests to the development bridge.
  const forbidden = await fetch(`http://127.0.0.1:${process.env.TURBOPUSH_PORT ?? 34080}/__rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://untrusted.example",
    },
    body: JSON.stringify({ id: 1, method: "snapshot" }),
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: UI creates account/content/task, picks and hosts an image, preflights, persists across reload; cross-origin RPC blocked",
  );
} finally {
  await browser.close();
  await server.close();
  // Allow the async close hook to finish releasing SQLite.
  await new Promise((done) => setTimeout(done, 100));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

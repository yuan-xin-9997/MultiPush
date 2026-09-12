import { createServer } from "vite";
import { chromium, type Browser } from "playwright";
import { spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

if (process.platform !== "win32")
  throw new Error("Native smoke test currently targets Windows");
const directory = await mkdtemp(join(tmpdir(), "turbopush-native-"));
process.env.TURBOPUSH_DATA_DIR = directory;
process.env.TAURI_ENV_PLATFORM = "windows";
const reserve = createTcpServer();
await new Promise<void>((done) => reserve.listen(0, "127.0.0.1", done));
const address = reserve.address();
if (!address || typeof address === "string") throw new Error("No CDP port");
const port = address.port;
await new Promise<void>((done) => reserve.close(() => done()));
const server = await createServer({
  root: resolve("apps/desktop"),
  configFile: resolve("apps/desktop/vite.config.ts"),
});
await server.listen();
const child = spawn(
  resolve("apps/desktop/src-tauri/target/debug/turbopush-forked.exe"),
  [],
  {
    windowsHide: true,
    env: {
      ...process.env,
      TURBOPUSH_NODE: process.execPath,
      WEBVIEW2_USER_DATA_FOLDER: join(directory, "webview"),
      TURBOPUSH_TEST_CDP_PORT: String(port),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stderr = "";
child.stderr.on("data", (data) => (stderr += data));
const completion = new Promise<number | null>((done, reject) => {
  child.on("exit", done);
  child.on("error", reject);
});
let browser: Browser | undefined;
let connectionError = "";
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Native app exited: ${stderr}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        timeout: 1000,
      });
      break;
    } catch (error) {
      connectionError = error instanceof Error ? error.message : String(error);
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  if (!browser)
    throw new Error(
      `Unable to connect to native WebView on port ${port}: ${connectionError}\n${stderr}`,
    );
  let page = browser.contexts()[0]?.pages()[0];
  if (!page) page = await browser.contexts()[0].waitForEvent("page");
  await page.waitForURL("http://127.0.0.1:1420/**", { timeout: 30_000 });
  await page.getByText("本地引擎已连接").waitFor({ timeout: 30_000 });
  assert.equal(
    await page.evaluate(() => "__TAURI_INTERNALS__" in window),
    true,
  );
  await page.getByRole("button", { name: "账号管理", exact: false }).click();
  await page.getByLabel("账号备注").fill("原生IPC测试公众号");
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page.getByText("原生IPC测试公众号", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("本地引擎已连接").waitFor();
  await page.getByRole("button", { name: "账号管理", exact: false }).click();
  await page.getByText("原生IPC测试公众号", { exact: true }).waitFor();
  await mkdir(resolve("test-results"), { recursive: true });
  await page.screenshot({ path: "test-results/native.png", fullPage: true });
  await page.evaluate(() => {
    const bridge = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    void bridge.invoke("plugin:window|close", { label: "main" });
  });
  const exit = await Promise.race([
    completion,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Native app did not exit cleanly")),
        15_000,
      ).unref();
    }),
  ]);
  assert.equal(exit, 0, stderr);
  assert.match(stderr, /Engine stopped/);
  console.log(
    "PASS: real Tauri WebView -> Rust -> Node -> SQLite; native window closes and engine exits",
  );
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  await server.close();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300,
  });
}

import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { Account, Content } from "../packages/shared/src/index.ts";
import { BrowserManager } from "../packages/publisher-engine/src/browser-manager.ts";
import { acquireInstanceLock } from "../packages/publisher-engine/src/instance-lock.ts";
import { waitForXiaohongshuInteractiveLogin } from "./xiaohongshu-media-probe.ts";
import { validateXiaohongshuGallery } from "../packages/publisher-engine/src/platforms/xiaohongshu/schema.ts";
import {
  validateXiaohongshuPublishUrl,
  xiaohongshuGallerySelectors,
  xiaohongshuPublishUrl,
} from "../packages/publisher-engine/src/platforms/xiaohongshu/draft.ts";

const ENV = "TURBOPUSH_LIVE_DRAFT_TEST";

export function parseXiaohongshuUploadPreviewOptions(
  args: string[],
  env = process.env,
) {
  if (env[ENV] !== "1") throw new Error(`必须显式设置 ${ENV}=1`);
  const values = new Map<string, string>();
  const images: string[] = [];
  let manualEditor = false;
  const allowed = new Set(["--data-dir", "--account-id", "--image"]);
  for (let index = 0; index < args.length;) {
    const name = args[index];
    if (name === "--manual-editor") {
      if (manualEditor) throw new Error("--manual-editor 不能重复");
      manualEditor = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (!name || !allowed.has(name) || !value || value.startsWith("--"))
      throw new Error("参数仅允许 --data-dir、--account-id、两个 --image");
    if (name === "--image") images.push(value);
    else {
      if (values.has(name)) throw new Error(`${name} 不能重复`);
      values.set(name, value);
    }
    index += 2;
  }
  const dataDir = values.get("--data-dir");
  const accountId = values.get("--account-id");
  if (!dataDir || !isAbsolute(dataDir))
    throw new Error("--data-dir 必须是绝对路径");
  if (!accountId || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(accountId))
    throw new Error("--account-id 必须是显式 UUID");
  if (images.length !== 2 || images.some((path) => !isAbsolute(path)))
    throw new Error("必须提供恰好两张绝对路径图片");
  return {
    dataDir: resolve(dataDir),
    accountId,
    images: images.map((path) => resolve(path)),
    manualEditor,
  };
}

function assertTrustedManualEditor(raw: string) {
  const url = new URL(raw);
  if (
    url.origin !== "https://creator.xiaohongshu.com" ||
    url.pathname !== "/publish/publish" ||
    url.username ||
    url.password
  )
    throw new Error("未到受信的小红书图文编辑页");
}

async function waitForManualGalleryEditor(
  context: import("playwright").BrowserContext,
  timeoutMs = 600_000,
) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let stablePage: import("playwright").Page | undefined;
  while (Date.now() < deadline) {
    const matches: import("playwright").Page[] = [];
    for (const page of context.pages()) {
      let url: URL;
      try {
        url = new URL(page.url());
      } catch {
        continue;
      }
      if (
        url.origin !== "https://creator.xiaohongshu.com" ||
        url.pathname !== "/publish/publish" ||
        url.username ||
        url.password
      ) continue;
      const challenges = page.getByText(/验证码|安全验证|环境异常|异常流量/);
      let challenged = false;
      for (
        let index = 0;
        index < Math.min(await challenges.count(), 20);
        index += 1
      )
        if (await challenges.nth(index).isVisible()) challenged = true;
      const inputs = page.locator(xiaohongshuGallerySelectors.images);
      if (!challenged && (await inputs.count()) === 1) matches.push(page);
    }
    if (matches.length > 1)
      throw new Error("发现多个图文编辑页，未选择文件");
    const page = matches[0];
    stable = page && page === stablePage ? stable + 1 : 0;
    stablePage = page;
    if (page && stable >= 2) {
      assertTrustedManualEditor(page.url());
      return { page, input: page.locator(xiaohongshuGallerySelectors.images) };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("人工图文编辑页等待超时，未选择文件");
}

/** One selection into an unsaved editor. No title, save, or publish action. */
export async function runXiaohongshuUploadPreviewProbe(
  args = process.argv.slice(2),
  env = process.env,
) {
  const options = parseXiaohongshuUploadPreviewOptions(args, env);
  const content = {
    id: "preview-only",
    createdAt: "",
    type: "gallery",
    title: "TurboPush preview only",
    body: "",
    bodyFormat: "plain",
    images: options.images,
    summary: "",
    author: "",
    tags: [],
  } as Content;
  const validated = await validateXiaohongshuGallery(content);
  const lock = acquireInstanceLock(options.dataDir);
  let db: DatabaseSync | undefined;
  const browsers = new BrowserManager(options.dataDir);
  try {
    db = new DatabaseSync(join(options.dataDir, "turbopush.sqlite"), {
      readOnly: true,
    });
    const account = db
      .prepare(
        `SELECT id, platform, name, created_at AS createdAt,
        login_status AS loginStatus, login_checked_at AS checkedAt,
        login_message AS message FROM accounts WHERE id = ?`,
      )
      .get(options.accountId) as Account | undefined;
    if (!account || account.platform !== "xiaohongshu")
      throw new Error("指定小红书账号不存在或平台不符");
    const context = await browsers.open(account);
    let page = context.pages()[0] ?? (await context.newPage());
    let input: ReturnType<typeof page.locator>;
    if (options.manualEditor) {
      console.log(
        JSON.stringify({
          stage: "waiting-for-manual-gallery",
          timeoutMs: 600_000,
        }),
      );
      ({ page, input } = await waitForManualGalleryEditor(context));
    } else {
      await waitForXiaohongshuInteractiveLogin(page, 120_000);
      const publishEntries = page.getByText("发布笔记", { exact: true });
      const visibleEntries = [];
      for (let index = 0; index < (await publishEntries.count()); index += 1)
        if (await publishEntries.nth(index).isVisible())
          visibleEntries.push(publishEntries.nth(index));
      if (visibleEntries.length !== 1)
        throw new Error("发布笔记导航入口未唯一确认，未选择文件");
      await visibleEntries[0]!.click();
      await page.waitForURL(
        (url) =>
          url.origin === "https://creator.xiaohongshu.com" &&
          url.pathname === "/publish/publish",
        { timeout: 15_000 },
      );
      const landing = new URL(page.url());
      if (landing.search || landing.hash)
        await page.goto(xiaohongshuPublishUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      validateXiaohongshuPublishUrl(page.url());
      await page.waitForTimeout(3_000);
      const galleryCandidates = page.getByText(
        xiaohongshuGallerySelectors.galleryTabText,
        { exact: true },
      );
      await galleryCandidates
        .first()
        .waitFor({ state: "attached", timeout: 15_000 });
      await page.waitForTimeout(1_000);
      const viewport = page.viewportSize();
      const visibleGallery = [];
      for (
        let index = 0;
        index < (await galleryCandidates.count());
        index += 1
      ) {
        const candidate = galleryCandidates.nth(index);
        const box = await candidate.boundingBox();
        if (
          box &&
          box.width > 0 &&
          box.height > 0 &&
          (!viewport ||
            (box.x < viewport.width &&
              box.y < viewport.height &&
              box.x + box.width > 0 &&
              box.y + box.height > 0))
        )
          visibleGallery.push(candidate);
      }
      const leafGallery = [];
      for (const candidate of visibleGallery) {
        const leaf = await candidate.evaluate(
          (element, label) =>
            ![...element.children].some(
              (child) =>
                (child.textContent ?? "").replace(/\s+/g, " ").trim() === label,
            ),
          xiaohongshuGallerySelectors.galleryTabText,
        );
        if (leaf) leafGallery.push(candidate);
      }
      if (leafGallery.length !== 1)
        throw new Error(
          `图文切换控件未唯一确认（总数=${await galleryCandidates.count()}，视口内=${visibleGallery.length}，叶子=${leafGallery.length}），未选择文件`,
        );
      const gallery = leafGallery[0]!;
      await gallery.evaluate((element) => (element as HTMLElement).click());
      input = page.locator(xiaohongshuGallerySelectors.images);
      if ((await input.count()) !== 1)
        throw new Error("图文多文件控件不唯一，未选择文件");
      await input.waitFor({ state: "attached", timeout: 15_000 });
    }

    let writeRequests = 0;
    let rawFirst = 0;
    let rawSecond = 0;
    let successfulResponses = 0;
    let failedResponses = 0;
    const mediaRequests = new Map<import("playwright").Request, {
      host: string;
      pathShape: string;
      contentType: string;
      bodyBytes: number;
      pngSignature: boolean;
      jpegSignature: boolean;
      status?: number;
    }>();
    page.on("request", (request) => {
      if (!["POST", "PUT", "PATCH"].includes(request.method())) return;
      writeRequests += 1;
      try {
        const body = request.postDataBuffer();
        if (body?.includes(validated.images[0]!.buffer)) rawFirst += 1;
        if (body?.includes(validated.images[1]!.buffer)) rawSecond += 1;
        const contentType = request.headers()["content-type"] ?? "";
        const pngSignature = !!body?.includes(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpegSignature = !!body?.includes(Buffer.from([255, 216, 255]));
        if (/multipart|image\//i.test(contentType) || pngSignature || jpegSignature) {
          const url = new URL(request.url());
          mediaRequests.set(request, {
            host: url.hostname,
            pathShape: url.pathname.split("/").map((segment) =>
              /^[a-z][a-z0-9_-]{0,20}$/i.test(segment) ? segment : "_",
            ).join("/"),
            contentType: contentType.split(";")[0] ?? "",
            bodyBytes: body?.length ?? 0,
            pngSignature,
            jpegSignature,
          });
        }
      } catch {
        /* Count only; no request data leaves this process. */
      }
    });
    page.on("response", (response) => {
      if (!["POST", "PUT", "PATCH"].includes(response.request().method()))
        return;
      if (response.ok()) successfulResponses += 1;
      else failedResponses += 1;
      const media = mediaRequests.get(response.request());
      if (media) media.status = response.status();
    });
    await input.setInputFiles(validated.images);
    await page.waitForTimeout(15_000);
    if (options.manualEditor) assertTrustedManualEditor(page.url());
    else validateXiaohongshuPublishUrl(page.url());
    const preview = await page.evaluate(`(() => {
      const sourceKind = (raw) => {
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
      return [...document.images]
        .filter((image) => {
          const box = image.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .slice(0, 30)
        .map((image) => ({
          width: Math.round(image.getBoundingClientRect().width),
          height: Math.round(image.getBoundingClientRect().height),
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          complete: image.complete,
          sourceKind: sourceKind(image.currentSrc || image.src),
          parentTag: image.parentElement?.tagName.toLowerCase() ?? "none",
        }));
    })()`);
    console.log(
      JSON.stringify({
        stage: "preview-only",
        selected: 2,
        writeRequests,
        rawByteMatches: [rawFirst, rawSecond],
        successfulResponses,
        failedResponses,
        mediaRequestShapes: [...mediaRequests.values()],
        imageCountSignal: await page.getByText(/^2\s*\/\s*18$/).count(),
        preview,
        titleFilled: false,
        saved: false,
        published: false,
      }),
    );
  } finally {
    await browsers.shutdown();
    db?.close();
    lock.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runXiaohongshuUploadPreviewProbe();

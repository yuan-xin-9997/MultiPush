import type { BrowserContext, Page } from "playwright";
import type { Content } from "@turbopush/shared";
import { validateDouyinVideo } from "./schema.ts";
import {
  reportDraftProgress,
  type DraftProgressReporter,
} from "../../draft-progress.ts";

export const douyinVideoUploadUrl =
  "https://creator.douyin.com/creator-micro/content/upload";
type VideoDraft = Pick<
  Content,
  | "type"
  | "title"
  | "body"
  | "bodyFormat"
  | "images"
  | "video"
  | "cover"
  | "tags"
>;
const normalize = (value: string) =>
  value
    .replace(/[\u200b\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function validateDouyinDraftUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "creator.douyin.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/creator-micro/content/upload"
  )
    throw new Error("无效的抖音创作平台草稿地址");
  return url.href;
}

function validateDouyinEditorPageUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "creator.douyin.com" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/creator-micro/content/post/video"
  )
    throw new Error("无效的抖音视频编辑页地址");
  return url.href;
}

function validateDouyinStoredPageUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "creator.douyin.com" ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== "/creator-micro/content/upload"
  )
    throw new Error("无效的抖音暂存结果页地址");
  return url.href;
}

export interface DouyinDraftRuntime {
  find(page: Page, content: VideoDraft): Promise<boolean>;
  populate(page: Page, content: VideoDraft): Promise<void>;
  makePrivate(page: Page): Promise<void>;
  saveDraft(page: Page): Promise<void>;
  settle(page: Page): Promise<void>;
  confirmStored(page: Page): Promise<void>;
}

async function readBack(page: Page, content: VideoDraft) {
  validateDouyinEditorPageUrl(page.url());
  const title = page.locator('input[placeholder*="标题"]').first();
  const body = page
    .locator(
      'textarea[placeholder*="简介"],textarea[placeholder*="描述"],[contenteditable="true"]',
    )
    .first();
  await title.waitFor({ state: "visible", timeout: 20_000 });
  await body.waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(1_000);
  return (
    (await title.inputValue()) === content.title &&
    normalize(await body.inputValue().catch(() => body.innerText())) ===
      normalize(content.body) &&
    (await page
      .locator('[data-checked="true"]')
      .filter({ hasText: /仅自己可见/ })
      .count()) === 1
  );
}

async function saveDraftOnEditor(page: Page) {
  validateDouyinEditorPageUrl(page.url());
  const publish = page.getByRole("button", { name: "发布", exact: true });
  const draft = page.getByRole("button", { name: "暂存离开", exact: true });
  if ((await publish.count()) !== 1 || (await draft.count()) !== 1)
    throw new Error("发布/暂存按钮边界不唯一，拒绝保存");
  await draft.click();
}

async function confirmDraftStored(page: Page) {
  validateDouyinStoredPageUrl(page.url());
  const resume = page.getByText("继续编辑", { exact: true });
  await resume.waitFor({ state: "visible", timeout: 20_000 });
  if ((await resume.count()) !== 1)
    throw new Error("暂存后未出现唯一的继续编辑入口，结果未知");
}

async function restoreConsumedDraft(page: Page) {
  try {
    await saveDraftOnEditor(page);
    await page.waitForTimeout(3_000);
    await confirmDraftStored(page);
  } catch (cause) {
    throw new Error(
      "已进入继续编辑，但重新暂存并确认恢复失败；远端草稿状态未知，禁止自动重试或公开发布",
      { cause },
    );
  }
}

export const douyinBrowserRuntime: DouyinDraftRuntime = {
  async find(page, content) {
    await page.goto(douyinVideoUploadUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const resume = page.getByText("继续编辑", { exact: true });
    await resume
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => undefined);
    const count = await resume.count();
    if (!count) return false;
    if (count !== 1)
      throw new Error("抖音上传页存在多个继续编辑入口，拒绝自动操作");
    await resume.click();
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);
    let matched = false;
    let readError: unknown;
    try {
      matched = await readBack(page, content);
    } catch (error) {
      readError = error;
    }
    // “继续编辑”会消费暂存入口。恢复必须先于任何匹配结果或读取错误返回。
    await restoreConsumedDraft(page);
    if (readError)
      throw new Error("抖音草稿回读失败；原草稿已重新暂存并确认，未公开发布", {
        cause: readError,
      });
    if (!matched)
      throw new Error(
        "抖音已有未完成草稿与当前内容不一致；原草稿已重新暂存并确认，禁止覆盖",
      );
    return true;
  },
  async populate(page, content) {
    await page.goto(douyinVideoUploadUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: "attached", timeout: 30_000 });
    await input.setInputFiles(content.video!);
    await page.waitForURL(
      (url) =>
        url.hostname === "creator.douyin.com" &&
        url.pathname === "/creator-micro/content/post/video",
      { timeout: 120_000 },
    );
    await page
      .locator('input[placeholder*="标题"]')
      .first()
      .fill(content.title);
    await page
      .locator(
        'textarea[placeholder*="简介"],textarea[placeholder*="描述"],[contenteditable="true"]',
      )
      .first()
      .fill(content.body);
  },
  async makePrivate(page) {
    const privateOption = page.getByText("仅自己可见", { exact: true });
    if ((await privateOption.count()) !== 1)
      throw new Error("未找到唯一的仅自己可见控件，拒绝保存");
    const label = privateOption.locator("xpath=ancestor::label[1]");
    if ((await label.count()) !== 1)
      throw new Error("仅自己可见控件缺少唯一标签，拒绝保存");
    await label.click();
    if (
      (await page
        .locator('[data-checked="true"]')
        .filter({ hasText: /仅自己可见/ })
        .count()) !== 1
    )
      throw new Error("仅自己可见状态未确认，拒绝保存");
  },
  async saveDraft(page) {
    await saveDraftOnEditor(page);
  },
  settle: (page) => page.waitForTimeout(3_000),
  async confirmStored(page) {
    await confirmDraftStored(page);
  },
};

export async function saveDouyinDraft(
  context: Pick<BrowserContext, "newPage">,
  content: VideoDraft,
  runtime: DouyinDraftRuntime = douyinBrowserRuntime,
  onProgress?: DraftProgressReporter,
) {
  const validated = await validateDouyinVideo(content as Content);
  if (validated.content.tags.length)
    throw new Error("抖音话题控件尚未验证，首版草稿暂不接受标签");
  const page = await context.newPage();
  reportDraftProgress(onProgress, {
    stage: "session",
    message: "正在检查抖音上传页中的已有草稿",
  });
  if (await runtime.find(page, validated.content)) {
    throw new Error(
      "抖音已有草稿文案匹配，但编辑页不提供可靠的视频身份；原草稿已重新暂存并确认，拒绝自动复用",
    );
  }
  await runtime.populate(page, validated.content);
  reportDraftProgress(onProgress, {
    stage: "upload",
    message: "抖音视频已上传并进入编辑页",
    current: 1,
    total: 1,
  });
  reportDraftProgress(onProgress, {
    stage: "fields",
    message: "抖音标题和正文已填写",
  });
  await runtime.makePrivate(page);
  reportDraftProgress(onProgress, {
    stage: "privacy",
    message: "抖音可见范围已确认设为仅自己可见",
  });
  reportDraftProgress(onProgress, {
    stage: "save",
    message: "正在点击抖音暂存离开；不会点击发布",
  });
  await runtime.saveDraft(page);
  await runtime.settle(page);
  if (!(await runtime.find(page, validated.content)))
    throw new Error(
      "抖音草稿暂存后未能从继续编辑入口回读标题、正文和私密状态，结果未知；禁止自动重试",
    );
  reportDraftProgress(onProgress, {
    stage: "verify",
    message: "抖音草稿已完成标题、正文和仅自己可见状态回读",
  });
  // find 已在返回前重新暂存并确认恢复。
  return {
    url: douyinVideoUploadUrl,
    verified: true as const,
    reused: false as const,
  };
}

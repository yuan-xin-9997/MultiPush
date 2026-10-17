import { armFormDataUploadProof } from "../form-data-upload-proof.ts";
import { imagePayload } from "../wechat/media.ts";
import type { BrowserContext, Page } from "playwright";
import type { Content } from "@turbopush/shared";
import { validateXiaohongshuGallery } from "./schema.ts";
import {
  reportDraftProgress,
  type DraftProgressReporter,
} from "../../draft-progress.ts";

export const xiaohongshuPublishUrl =
  "https://creator.xiaohongshu.com/publish/publish";
export const xiaohongshuGallerySelectors = {
  galleryTabText: "上传图文",
  images: 'input[type="file"][multiple]',
  title: 'input[type="text"][placeholder*="标题"]',
  body: '[role="textbox"][contenteditable="true"]',
  draftHost: "xhs-publish-btn",
} as const;
export const xiaohongshuDraftLayoutVersion = "xhs-publish-footer-2026-09";
export interface XiaohongshuDraftLayoutEvidence {
  layoutVersion: string;
  viewport: { width: number; height: number };
  draftPoint: { x: number; y: number };
  publishPoint: { x: number; y: number };
  host: {
    count: number;
    tag: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  draftHitTag: string;
  publishHitTag: string;
}
type GalleryDraft = Pick<
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

export function validateXiaohongshuPublishUrl(value: string) {
  const url = new URL(value);
  if (
    url.origin !== "https://creator.xiaohongshu.com" ||
    url.pathname !== "/publish/publish" ||
    url.username ||
    url.password ||
    [...url.searchParams].some(([key, value]) => !(key === "from" && /^[a-zA-Z0-9_-]{1,40}$/.test(value))) ||
    url.hash
  )
    throw new Error("无效的小红书创作入口");
  return url.href;
}

async function openPublishPage(page: Page) {
  await page.goto(validateXiaohongshuPublishUrl(xiaohongshuPublishUrl), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
}

async function openGalleryDraftBox(page: Page) {
  await openPublishPage(page);
  const draftBox = page
    .getByText(/草稿箱/)
    .filter({ visible: true })
    .first();
  await draftBox.waitFor({ state: "visible", timeout: 30_000 });
  await draftBox.click();
  const gallery = page
    .getByText(/^图文笔记\(\d+\)$/)
    .filter({ visible: true })
    .first();
  await gallery.waitFor({ state: "visible", timeout: 30_000 });
  await gallery.click();
}

async function editorMatches(page: Page, content: GalleryDraft) {
  const title = page.locator(xiaohongshuGallerySelectors.title).first();
  const body = page.locator(xiaohongshuGallerySelectors.body).first();
  try {
    await title.waitFor({ state: "visible", timeout: 15_000 });
    await body.waitFor({ state: "visible", timeout: 15_000 });
    const imageSignal = page.getByText(
      new RegExp(`^${content.images.length}\\s*\\/\\s*18$`),
    );
    return (
      (await title.inputValue()) === content.title &&
      normalize(await body.innerText()) === normalize(content.body) &&
      (await imageSignal.count()) > 0
    );
  } catch {
    return false;
  }
}

/** A matching title/body/count is only a candidate, never proof of image identity. */
export async function findMatchingXiaohongshuDraft(
  page: Page,
  content: GalleryDraft,
) {
  await openGalleryDraftBox(page);
  let candidates = await page.getByText(content.title, { exact: true }).count();
  const initialCandidates = candidates;
  for (let index = 0; index < candidates; index += 1) {
    if (index > 0) {
      await openGalleryDraftBox(page);
      candidates = await page.getByText(content.title, { exact: true }).count();
      if (index >= candidates) break;
    }
    const title = page.getByText(content.title, { exact: true }).nth(index);
    const edit = title
      .locator(
        "xpath=ancestor::*[.//*[normalize-space(text())='编辑']][1]//*[normalize-space(text())='编辑']",
      )
      .first();
    try {
      await edit.waitFor({ state: "visible", timeout: 10_000 });
      await edit.click();
    } catch (error) {
      throw new Error(
        "同标题小红书草稿无法可靠打开，请人工核对草稿箱；禁止自动新建",
        { cause: error },
      );
    }
    if (await editorMatches(page, content))
      throw new Error(
        "已存在同标题小红书草稿，标题、正文和图片数量一致但无法核验逐图身份；禁止自动复用或新建，请人工核对",
      );
  }
  if (initialCandidates > 0)
    throw new Error(
      "已存在同标题小红书草稿但字段或图片数量不一致，请人工核对；禁止自动新建",
    );
  return false;
}

async function populateGalleryEditor(page: Page, content: GalleryDraft) {
  await openPublishPage(page);
  const gallery = page
    .getByText(xiaohongshuGallerySelectors.galleryTabText, { exact: true })
    .first();
  await gallery.waitFor({ state: "visible", timeout: 30_000 });
  await gallery.evaluate((element) => (element as HTMLElement).click());
  const input = page.locator(xiaohongshuGallerySelectors.images).first();
  await input.waitFor({ state: "attached", timeout: 30_000 });
  for (const path of content.images) {
    const image = await imagePayload(path);
    const current = page.locator(xiaohongshuGallerySelectors.images);
    if ((await current.count()) !== 1)
      throw new Error("小红书图片选择控件不唯一，停止上传");
    const proof = await armFormDataUploadProof(
      page,
      image,
      "https://creator.xiaohongshu.com",
      "xiaohongshu",
    );
    if (!proof) throw new Error("小红书上传文件证明无法启动");
    try {
      await current.setInputFiles(image);
      await proof.promise;
    } finally {
      await proof.cancel();
    }
  }
  const title = page.locator(xiaohongshuGallerySelectors.title).first();
  const body = page.locator(xiaohongshuGallerySelectors.body).first();
  await title.waitFor({ state: "visible", timeout: 30_000 });
  await body.waitFor({ state: "visible", timeout: 30_000 });
  await title.fill(content.title);
  await body.fill(content.body);
}

export async function prepareXiaohongshuGalleryDraft(
  context: Pick<BrowserContext, "newPage">,
  content: GalleryDraft,
) {
  const validated = await validateXiaohongshuGallery(content as Content);
  if (validated.content.tags.length)
    throw new Error("小红书话题控件尚未验证，首版草稿暂不接受标签");
  const page = await context.newPage();
  await populateGalleryEditor(page, validated.content);
  return { page, prepared: true as const, saved: false as const };
}

/** Pure safety contract: any layout, viewport or hit-test drift aborts the click. */
export function validateXiaohongshuDraftLayout(
  evidence: XiaohongshuDraftLayoutEvidence,
) {
  const { viewport, draftPoint, publishPoint, host } = evidence;
  if (evidence.layoutVersion !== xiaohongshuDraftLayoutVersion)
    throw new Error("小红书暂存布局版本未确认，拒绝点击");
  if (
    viewport.width < 800 ||
    viewport.height < 600 ||
    viewport.width > 10_000 ||
    viewport.height > 10_000
  )
    throw new Error("小红书暂存视口超出已验证范围，拒绝点击");
  const near = (actual: number, expected: number, tolerance = 1) =>
    Math.abs(actual - expected) <= tolerance;
  if (
    !near(draftPoint.x / viewport.width, 0.43, 0.002) ||
    !near(viewport.height - draftPoint.y, 45, 1)
  )
    throw new Error("暂存点击位置偏离已验证左侧坐标，拒绝点击");
  if (
    !near(publishPoint.x / viewport.width, 0.54, 0.002) ||
    !near(viewport.height - publishPoint.y, 45, 1)
  )
    throw new Error("发布区参照位置偏离已验证布局，拒绝点击");
  if (
    host.count !== 1 ||
    host.tag !== xiaohongshuGallerySelectors.draftHost ||
    host.right <= host.left ||
    host.bottom <= host.top
  )
    throw new Error("未找到唯一且有边界的xhs-publish-btn，拒绝点击");
  const contains = (point: { x: number; y: number }) =>
    point.x >= host.left &&
    point.x <= host.right &&
    point.y >= host.top &&
    point.y <= host.bottom;
  if (
    !contains(draftPoint) ||
    !contains(publishPoint) ||
    draftPoint.x >= publishPoint.x
  )
    throw new Error("暂存/发布参照点与host边界不一致，拒绝点击");
  if (evidence.draftHitTag !== host.tag || evidence.publishHitTag !== host.tag)
    throw new Error("闭合shadow命中信号与已验证host不一致，拒绝点击");
  return true;
}

/** Closed-shadow host: only the screenshot-verified left 暂存离开 point is clicked. */
export async function clickVerifiedXiaohongshuDraftPoint(
  page: Page,
  layoutVersion = xiaohongshuDraftLayoutVersion,
) {
  validateXiaohongshuPublishUrl(page.url());
  const evidence = await page.evaluate(
    ({ hostSelector, layoutVersion }) => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const draftPoint = {
        x: Math.round(viewport.width * 0.43),
        y: viewport.height - 45,
      };
      const publishPoint = {
        x: Math.round(viewport.width * 0.54),
        y: viewport.height - 45,
      };
      const hosts = [...document.querySelectorAll<HTMLElement>(hostSelector)];
      const bounds = hosts[0]?.getBoundingClientRect();
      return {
        layoutVersion,
        viewport,
        draftPoint,
        publishPoint,
        host: {
          count: hosts.length,
          tag: hosts[0]?.tagName.toLowerCase() ?? "",
          left: bounds?.left ?? 0,
          right: bounds?.right ?? 0,
          top: bounds?.top ?? 0,
          bottom: bounds?.bottom ?? 0,
        },
        draftHitTag:
          document
            .elementFromPoint(draftPoint.x, draftPoint.y)
            ?.tagName.toLowerCase() ?? "",
        publishHitTag:
          document
            .elementFromPoint(publishPoint.x, publishPoint.y)
            ?.tagName.toLowerCase() ?? "",
      };
    },
    { hostSelector: xiaohongshuGallerySelectors.draftHost, layoutVersion },
  );
  validateXiaohongshuDraftLayout(evidence);
  await page.mouse.click(evidence.draftPoint.x, evidence.draftPoint.y);
}

export interface XiaohongshuDraftRuntime {
  find(page: Page, content: GalleryDraft): Promise<boolean>;
  populate(page: Page, content: GalleryDraft): Promise<void>;
  save(page: Page): Promise<void>;
  settle(page: Page): Promise<void>;
}
const browserDraftRuntime: XiaohongshuDraftRuntime = {
  find: findMatchingXiaohongshuDraft,
  populate: populateGalleryEditor,
  save: clickVerifiedXiaohongshuDraftPoint,
  settle: (page) => page.waitForTimeout(3_000),
};

export async function saveXiaohongshuDraft(
  context: BrowserContext,
  content: GalleryDraft,
  runtime: XiaohongshuDraftRuntime = browserDraftRuntime,
  onProgress?: DraftProgressReporter,
): Promise<never> {
  const validated = await validateXiaohongshuGallery(content as Content);
  if (validated.content.tags.length)
    throw new Error("小红书话题控件尚未验证，首版草稿暂不接受标签");
  const page = await context.newPage();
  reportDraftProgress(onProgress, {
    stage: "session",
    message: "正在检查小红书草稿箱中的同内容草稿",
  });
  // No stable image identity exists. Even a matching title/body/N/18 cannot be reused.
  if (await runtime.find(page, validated.content))
    throw new Error(
      "小红书草稿仅匹配标题、正文和图片数量，无法核验逐图身份；禁止自动复用或新建",
    );
  await runtime.populate(page, validated.content);
  reportDraftProgress(onProgress, {
    stage: "upload",
    message: `已向小红书页面选择 ${validated.content.images.length} 张图片；远端上传及逐图身份未验证`,
    current: 0,
    total: validated.content.images.length,
  });
  reportDraftProgress(onProgress, {
    stage: "fields",
    message: "小红书标题和正文已填写",
  });
  reportDraftProgress(onProgress, {
    stage: "save",
    message: "正在点击小红书暂存离开；不会点击发布",
  });
  await runtime.save(page);
  await runtime.settle(page);
  // A save click has happened. Read back for diagnostics, but do not mark the
  // task successful: N/18 cannot distinguish different images or upload races.
  try {
    await runtime.find(page, validated.content);
  } catch (error) {
    throw new Error(
      "小红书已执行暂存，草稿箱回读不能核验逐图身份；结果未知，请人工介入，禁止自动重试",
      { cause: error },
    );
  }
  throw new Error(
    "小红书已执行暂存，但无法核验远端逐图身份；结果未知，请人工介入，禁止自动重试",
  );
}

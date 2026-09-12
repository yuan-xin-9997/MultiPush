import type { BrowserContext, Page } from "playwright";
import type { Content } from "@turbopush/shared";
import { verifyZhihuDraftList } from "./draft-list.ts";
import {
  validateZhihuTopics,
  saveZhihuTopics,
  verifyZhihuTopics,
} from "./topics.ts";
import { renderMarkdown } from "../../markdown.ts";
import { imagePayload } from "../wechat/media.ts";
import {
  uploadZhihuImage,
  uploadZhihuCover,
  verifyZhihuMedia,
} from "./media.ts";
import { uploadImagesSequentially } from "../upload-sequence.ts";
import {
  reportDraftProgress,
  type DraftProgressReporter,
} from "../../draft-progress.ts";

const titleSelector = 'textarea[placeholder="请输入标题（最多 100 个字）"]';
const bodySelector = '[contenteditable="true"][role="textbox"]';
const normalize = (text: string) =>
  text
    .replace(/[\u200b\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function draftPayloadMatches(
  payload: unknown,
  field: "title" | "content",
  expected: string,
) {
  if (!payload || typeof payload !== "object") return false;
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string") return false;
  if (field === "title") return value === expected;
  const decoded = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return normalize(decoded) === normalize(expected);
}

export function validateDraftUrl(url: string) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://zhuanlan.zhihu.com" ||
    !/^\/p\/\d+\/edit$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("无效的知乎草稿编辑链接");
  }
  return parsed.href;
}

export function validateZhihuContent(
  content: Pick<Content, "type" | "title" | "body" | "images" | "video">,
) {
  if (content.type !== "article") throw new Error("知乎首版仅支持文章草稿");
  if ([...content.title].length > 100)
    throw new Error("知乎文章标题最多100个字");
  if (!content.body.trim()) throw new Error("文章正文不能为空");
  if (content.video || content.images.length > 20)
    throw new Error("知乎文章不支持视频，正文图片最多20张");
}

export async function verifyDraft(
  page: Page,
  content: Pick<Content, "title" | "body" | "bodyFormat">,
) {
  const html =
    content.bodyFormat === "markdown" ? renderMarkdown(content.body) : null;
  await page
    .locator(titleSelector)
    .waitFor({ state: "visible", timeout: 30_000 });
  try {
    await page.waitForFunction(
      ({ selector, expected }) =>
        (document.querySelector(selector) as HTMLTextAreaElement | null)
          ?.value === expected,
      { selector: titleSelector, expected: content.title },
      { timeout: 15_000 },
    );
  } catch {
    throw new Error("草稿回读标题不一致，请人工核对");
  }
  try {
    if (html) {
      await page.waitForFunction(
        ({ selector, html }) => {
          const parsed = new DOMParser().parseFromString(html, "text/html");
          const actual = document.querySelector(selector);
          if (!actual) return false;
          const expectedText =
            parsed.body.textContent?.replace(/\s+/g, "") ?? "";
          const textClone = actual.cloneNode(true) as HTMLElement;
          textClone.querySelectorAll("figure").forEach((el) => el.remove());
          const actualText =
            textClone.textContent?.replace(/[\u200b\uFEFF\s]+/g, "") ?? "";
          const bold = [...parsed.querySelectorAll("strong,b")].every(
            (expected) =>
              [...actual.querySelectorAll("span,strong,b")].some(
                (el) =>
                  el.textContent === expected.textContent &&
                  Number(getComputedStyle(el).fontWeight) >= 600,
              ),
          );
          const italic = [...parsed.querySelectorAll("em,i")].every(
            (expected) =>
              [...actual.querySelectorAll("span,em,i")].some(
                (el) =>
                  el.textContent === expected.textContent &&
                  getComputedStyle(el).fontStyle === "italic",
              ),
          );
          const code = [...parsed.querySelectorAll("pre")].every((expected) =>
            [...actual.querySelectorAll("pre")].some(
              (el) => el.textContent?.trim() === expected.textContent?.trim(),
            ),
          );
          return (
            expectedText === actualText &&
            bold &&
            italic &&
            code &&
            ["h1,h2,h3,h4,h5,h6", "li", "blockquote"].every(
              (s) =>
                parsed.querySelectorAll(s).length ===
                actual.querySelectorAll(s).length,
            )
          );
        },
        { selector: bodySelector, html },
        { timeout: 15000 },
      );
      return;
    }
    await page.waitForFunction(
      ({ selector, expected }) => {
        const clone = document.querySelector(selector)?.cloneNode(true) as
          HTMLElement | undefined;
        clone?.querySelectorAll("figure").forEach((el) => el.remove());
        return (
          clone?.textContent?.replace(/[\u200b\uFEFF\s]+/g, "") === expected
        );
      },
      {
        selector: bodySelector,
        expected: content.body.replace(/[\u200b\uFEFF\s]+/g, ""),
      },
      { timeout: 15_000 },
    );
  } catch {
    throw new Error("草稿回读正文不一致，请人工核对");
  }
}

/** Verified DOM route: plain text article autosave only. Never clicks Publish. */
export async function saveZhihuDraft(
  context: BrowserContext,
  content: Pick<
    Content,
    "type" | "title" | "body" | "bodyFormat" | "images" | "video" | "cover"
  > & { tags?: string[] },
  options: {
    draftUrl?: string;
    checkpoint?: (url: string) => void;
    onProgress?: DraftProgressReporter;
  } = {},
) {
  validateZhihuContent(content);
  const topics = validateZhihuTopics(content.tags);
  const images = await Promise.all(content.images.map(imagePayload));
  const cover = content.cover ? await imagePayload(content.cover) : undefined;
  const html =
    content.bodyFormat === "markdown" ? renderMarkdown(content.body) : null;
  const page = await context.newPage();
  reportDraftProgress(options.onProgress, {
    stage: "session",
    message: options.draftUrl
      ? "正在打开知乎已有草稿并核对"
      : "正在打开知乎文章编辑器",
  });
  const started = Date.now();
  await page.goto(
    options.draftUrl
      ? validateDraftUrl(options.draftUrl)
      : "https://zhuanlan.zhihu.com/write",
    { waitUntil: "domcontentloaded", timeout: 30_000 },
  );
  try {
    await page
      .locator(titleSelector)
      .waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    throw new Error(
      "未进入知乎文章编辑器，请在账号窗口完成登录或安全验证后重试",
    );
  }
  // An earlier timeout may already have saved the expected content. Read before writing again.
  if (options.draftUrl) {
    // Existing drafts hydrate asynchronously after the empty editor becomes visible.
    // Do not overwrite their server response with edits to an unhydrated editor.
    await page.waitForFunction(
      (selector) =>
        !!(document.querySelector(selector) as HTMLTextAreaElement | null)
          ?.value,
      titleSelector,
      { timeout: 30_000 },
    );
    if (html || images.length || cover || topics.length) {
      await verifyDraft(page, content);
      await verifyZhihuMedia(page, images.length, !!cover);
      await verifyZhihuTopics(page, topics);
      await verifyZhihuDraftList(context, options.draftUrl, content.title);
      reportDraftProgress(options.onProgress, {
        stage: "verify",
        message: "知乎已有草稿已完成字段、素材、话题和列表回读",
      });
      return {
        url: options.draftUrl,
        elapsedMs: Date.now() - started,
        verified: true as const,
      };
    }
    if (
      (await page.locator(titleSelector).inputValue()) === content.title &&
      normalize(await page.locator(bodySelector).innerText()) ===
        normalize(content.body)
    ) {
      await verifyZhihuDraftList(context, options.draftUrl, content.title);
      reportDraftProgress(options.onProgress, {
        stage: "verify",
        message: "知乎已有草稿已完成字段和列表回读",
      });
      return {
        url: options.draftUrl,
        elapsedMs: Date.now() - started,
        verified: true as const,
      };
    }
  }
  async function saveField(
    field: "title" | "content",
    expected: string,
    selector: string,
  ) {
    const saved = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        const request = response.request();
        if (
          url.hostname !== "zhuanlan.zhihu.com" ||
          !/^\/api\/articles\/(?:drafts|\d+\/draft)$/.test(url.pathname) ||
          !["POST", "PATCH"].includes(request.method())
        )
          return false;
        try {
          if (field === "content" && html) {
            const value = request.postDataJSON()?.content;
            return (
              typeof value === "string" &&
              draftPayloadMatches({ content: value }, "content", expected)
            );
          }
          return draftPayloadMatches(request.postDataJSON(), field, expected);
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );
    void saved.catch(() => {});
    if (field === "content" && html) {
      await page.locator(selector).click();
      await page.locator(selector).evaluate((element, html) => {
        const data = new DataTransfer();
        data.setData("text/html", html);
        data.setData(
          "text/plain",
          new DOMParser().parseFromString(html, "text/html").body.textContent ??
            "",
        );
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, html);
    } else await page.locator(selector).fill(expected);
    await page
      .locator(field === "title" ? bodySelector : titleSelector)
      .click();
    const response = await saved;
    if (!response.ok())
      throw new Error(`知乎草稿保存返回HTTP ${response.status()}，请人工核对`);
  }
  // Zhihu saves title and body in separate PATCH requests. Wait for each field's own acknowledgement.
  if ((await page.locator(titleSelector).inputValue()) !== content.title)
    await saveField("title", content.title, titleSelector);
  reportDraftProgress(options.onProgress, {
    stage: "fields",
    message: "知乎标题已填写并确认保存",
  });
  await page.waitForURL(/^https:\/\/zhuanlan\.zhihu\.com\/p\/\d+\/edit$/, {
    timeout: 15_000,
  });
  const url = validateDraftUrl(page.url());
  options.checkpoint?.(url);
  if (html) {
    const expected = await page.evaluate((html) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("*").forEach((el) => {
        el.prepend(" ");
        el.append(" ");
      });
      return doc.body.textContent ?? "";
    }, html);
    await saveField("content", expected, bodySelector);
  } else if (
    normalize(await page.locator(bodySelector).innerText()) !==
    normalize(content.body)
  )
    await saveField("content", content.body, bodySelector);
  reportDraftProgress(options.onProgress, {
    stage: "fields",
    message: "知乎正文已填写并确认保存",
  });
  // A successful save response alone is insufficient: reload the remote draft and compare both fields.
  await uploadImagesSequentially(images, async (image, index) => {
    await uploadZhihuImage(page, image);
    reportDraftProgress(options.onProgress, {
      stage: "upload",
      message: `知乎正文图片已上传 ${index + 1}/${images.length}`,
      current: index + 1,
      total: images.length,
    });
  });
  if (cover) {
    await uploadZhihuCover(page, cover);
    reportDraftProgress(options.onProgress, {
      stage: "upload",
      message: "知乎封面已上传",
      current: 1,
      total: 1,
    });
  }
  await saveZhihuTopics(page, topics);
  if (topics.length)
    reportDraftProgress(options.onProgress, {
      stage: "fields",
      message: `知乎话题已填写 ${topics.length}/${topics.length}`,
      current: topics.length,
      total: topics.length,
    });
  reportDraftProgress(options.onProgress, {
    stage: "save",
    message: "知乎草稿字段与素材保存响应已确认",
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await verifyDraft(page, content);
  await verifyZhihuMedia(page, images.length, !!cover);
  await verifyZhihuTopics(page, topics);
  await verifyZhihuDraftList(context, url, content.title);
  reportDraftProgress(options.onProgress, {
    stage: "verify",
    message: "知乎草稿已完成字段、素材、话题和列表回读",
  });
  return { url, elapsedMs: Date.now() - started, verified: true as const };
}

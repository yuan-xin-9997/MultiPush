import type { BrowserContext, Page } from "playwright";
import type { Content } from "@turbopush/shared";
import {
  imagePayload,
  uploadBodyImage,
  uploadCover,
  verifyWechatMedia,
} from "./media.ts";
import { renderMarkdown } from "../../markdown.ts";
import { uploadImagesSequentially } from "../upload-sequence.ts";
import {
  reportDraftProgress,
  type DraftProgressReporter,
} from "../../draft-progress.ts";

const titleSelector = ".title-editor__input .ProseMirror";
const bodySelector = ".rich_media_content .ProseMirror";
type Article = Pick<
  Content,
  | "type"
  | "title"
  | "body"
  | "bodyFormat"
  | "images"
  | "video"
  | "cover"
  | "author"
  | "summary"
>;

export function validateWechatContent(content: Article) {
  if (
    content.type !== "article" ||
    !content.title.trim() ||
    !content.body.trim()
  )
    throw new Error("公众号草稿需要文章标题和正文");
  if (
    [...content.title].length > 64 ||
    [...(content.author ?? "")].length > 8 ||
    [...(content.summary ?? "")].length > 120
  )
    throw new Error("公众号标题最多64字，作者最多8字，摘要最多120字");
  if (content.video) throw new Error("公众号文章暂不支持视频");
  if (content.images.length > 20) throw new Error("公众号正文图片当前最多20张");
}

export function wechatDraftUrl(id: string) {
  if (!/^\d+$/.test(id)) throw new Error("无效的公众号草稿标识");
  return `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media%2Fappmsg_edit&action=edit&type=77&appmsgid=${id}`;
}

export function validateWechatDraftUrl(value: string) {
  const u = new URL(value);
  const id = u.searchParams.get("appmsgid") ?? "";
  const canonical = wechatDraftUrl(id);
  if (u.href !== canonical)
    throw new Error("无效的公众号草稿链接，禁止携带登录凭据或额外参数");
  return canonical;
}

export async function openWechatDraft(
  context: BrowserContext,
  draftUrl?: string,
) {
  if (draftUrl) validateWechatDraftUrl(draftUrl);
  const home = await context.newPage();
  await home.goto("https://mp.weixin.qq.com/", {
    waitUntil: "domcontentloaded",
  });
  await home.waitForURL(
    (url) =>
      url.hostname === "mp.weixin.qq.com" && url.pathname === "/cgi-bin/home",
    { timeout: 30000 },
  );
  if (draftUrl) {
    const token = new URL(home.url()).searchParams.get("token");
    if (!token) throw new Error("请先在公众号独立窗口完成登录");
    const target = new URL(draftUrl);
    target.searchParams.set("token", token);
    target.searchParams.set("lang", "zh_CN");
    await home.goto(target.href, { waitUntil: "domcontentloaded" });
    await home.locator(titleSelector).waitFor();
    return home;
  }
  const opened = context
    .waitForEvent("page", { timeout: 15000 })
    .catch(() => null);
  await home.getByText("文章", { exact: true }).click();
  const page = await opened;
  if (!page) throw new Error("公众号编辑窗口未打开");
  await page.locator(titleSelector).waitFor();
  return page;
}

export async function verifyWechatDraft(page: Page, content: Article) {
  const html =
    content.bodyFormat === "markdown" ? renderMarkdown(content.body) : null;
  await page.waitForFunction(
    ({ titleSelector, bodySelector, content, html }) => {
      const title =
        (document.querySelector(titleSelector) as HTMLElement | null)
          ?.innerText ?? "";
      const body =
        (document.querySelector(bodySelector) as HTMLElement | null)
          ?.innerText ?? "";
      const author = (
        document.querySelector("#author") as HTMLInputElement | null
      )?.value;
      const summary = (
        document.querySelector("#js_description") as HTMLTextAreaElement | null
      )?.value;
      const parsed = html
        ? new DOMParser().parseFromString(html, "text/html")
        : null;
      if (parsed) {
        const actual = document.querySelector(bodySelector);
        if (
          !actual ||
          [
            "h1,h2,h3,h4,h5,h6",
            "strong,b",
            "em,i",
            "li",
            "blockquote",
            "pre",
            "table",
          ].some(
            (selector) =>
              parsed.querySelectorAll(selector).length !==
              actual.querySelectorAll(selector).length,
          )
        )
          return false;
      }
      if (parsed)
        parsed
          .querySelectorAll("br,p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,tr")
          .forEach((el) => el.append(" "));
      const expectedBody = parsed?.body.textContent ?? content.body;
      const normalized = [title, content.title, body, expectedBody].map((s) =>
        s
          .replace(/[\u200b\uFEFF]/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      );
      return (
        normalized[0] === normalized[1] &&
        normalized[2] === normalized[3] &&
        author === (content.author ?? "") &&
        (!content.summary || summary === content.summary)
      );
    },
    { titleSelector, bodySelector, content, html },
    { timeout: 20000 },
  );
}

export async function verifyWechatDraftList(
  context: BrowserContext,
  url: string,
  title: string,
) {
  const id = new URL(validateWechatDraftUrl(url)).searchParams.get("appmsgid")!;
  const page = await context.newPage();
  try {
    await page.goto("https://mp.weixin.qq.com/", {
      waitUntil: "domcontentloaded",
    });
    await page.getByText("内容管理", { exact: true }).click();
    await page.getByRole("link", { name: "草稿箱", exact: true }).click();
    await page.getByPlaceholder("输入标题/关键词").waitFor();
    const card = page.locator(`[data-appid="${id}"]`);
    if (!(await card.isVisible())) {
      await page.getByPlaceholder("输入标题/关键词").fill(title);
      await page.getByPlaceholder("输入标题/关键词").press("Enter");
    }
    await card.waitFor({ timeout: 20000 });
    const actual = await card
      .locator(".weui-desktop-publish__cover__title")
      .innerText();
    if (
      actual.replace(/\s+/g, " ").trim() !== title.replace(/\s+/g, " ").trim()
    )
      throw new Error("草稿列表标题不一致");
  } finally {
    await page.close();
  }
}

export async function saveWechatDraft(
  context: BrowserContext,
  content: Article,
  options: {
    draftUrl?: string;
    checkpoint: (url: string) => void;
    onProgress?: DraftProgressReporter;
  },
) {
  validateWechatContent(content);
  const html =
    content.bodyFormat === "markdown" ? renderMarkdown(content.body) : null;
  // Validate all local files before the first upload; never upload arbitrary non-image files.
  const images = await Promise.all(content.images.map(imagePayload));
  const cover = content.cover ? await imagePayload(content.cover) : undefined;
  try {
    reportDraftProgress(options.onProgress, {
      stage: "session",
      message: options.draftUrl
        ? "正在打开公众号已有草稿并核对"
        : "正在打开公众号文章编辑器",
    });
    const page = await openWechatDraft(context, options.draftUrl);
    if (options.draftUrl) {
      // Retry only verifies the checkpointed draft; never overwrite a later manual edit.
      await verifyWechatDraft(page, content);
      await verifyWechatMedia(page, images.length, !!cover);
      await verifyWechatDraftList(context, options.draftUrl, content.title);
      reportDraftProgress(options.onProgress, {
        stage: "verify",
        message: "公众号已有草稿已完成字段、素材和列表回读",
      });
      return { url: validateWechatDraftUrl(options.draftUrl), verified: true };
    }
    if ((await page.locator(titleSelector).innerText()).trim())
      throw new Error("编辑页非空");
    await page.locator(titleSelector).fill(content.title);
    await page.locator("#author").fill(content.author ?? "");
    if (html) {
      await page.locator(bodySelector).click();
      await page.locator(bodySelector).evaluate((element, html) => {
        const data = new DataTransfer();
        data.setData("text/html", html);
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, html);
    } else await page.locator(bodySelector).fill(content.body);
    await page.locator("#js_description").fill(content.summary ?? "");
    reportDraftProgress(options.onProgress, {
      stage: "fields",
      message: "公众号标题、作者、摘要和正文已填写",
    });
    await uploadImagesSequentially(images, async (image, index) => {
      await uploadBodyImage(page, image);
      reportDraftProgress(options.onProgress, {
        stage: "upload",
        message: `公众号正文图片已上传 ${index + 1}/${images.length}`,
        current: index + 1,
        total: images.length,
      });
    });
    if (cover) {
      await uploadCover(page, cover);
      reportDraftProgress(options.onProgress, {
        stage: "upload",
        message: "公众号封面已上传",
        current: 1,
        total: 1,
      });
    }
    const responsePromise = page.waitForResponse(
      async (response) => {
        const u = new URL(response.url());
        if (
          u.origin !== "https://mp.weixin.qq.com" ||
          u.pathname !== "/cgi-bin/operate_appmsg" ||
          response.request().method() !== "POST"
        )
          return false;
        try {
          const data = await response.json();
          return data.appMsgId !== undefined;
        } catch {
          return false;
        }
      },
      { timeout: 45000 },
    );
    // Attach rejection handling before click, so a failed click cannot leave an unhandled rejection.
    const outcome = responsePromise.then(
      (response) => ({ response }),
      () => ({ response: null }),
    );
    reportDraftProgress(options.onProgress, {
      stage: "save",
      message: "正在请求公众号保存为草稿",
    });
    await page.getByRole("button", { name: "保存为草稿", exact: true }).click();
    const { response } = await outcome;
    if (!response || !response.ok()) throw new Error("草稿保存未确认");
    const data = await response.json();
    if (data.base_resp?.ret !== 0) throw new Error("平台拒绝保存");
    const url = wechatDraftUrl(String(data.appMsgId));
    options.checkpoint(url);
    const reopened = await openWechatDraft(context, url);
    await verifyWechatDraft(reopened, content);
    await verifyWechatMedia(reopened, images.length, !!cover);
    await verifyWechatDraftList(context, url, content.title);
    reportDraftProgress(options.onProgress, {
      stage: "verify",
      message: "公众号草稿已完成字段、素材和列表回读",
    });
    return { url, verified: true };
  } catch {
    // Never expose Playwright errors: they may include the authenticated URL token.
    throw new Error(
      "公众号草稿保存或回读未确认，请检查独立窗口和草稿箱；未公开发布，禁止盲目重复提交",
    );
  }
}

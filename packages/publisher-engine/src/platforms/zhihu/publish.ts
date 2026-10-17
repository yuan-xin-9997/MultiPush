import type { BrowserContext, Page, Locator } from "playwright";
import type { Task } from "@turbopush/shared";
import { validateDraftUrl, verifyDraft } from "./draft.ts";
import { verifyZhihuMedia, verifyZhihuImageOrder } from "./media.ts";
import { verifyZhihuTopics } from "./topics.ts";
import {
  imagePayload,
  fingerprintImageBuffer,
  fingerprintImageElement,
  fingerprintsMatch,
} from "../wechat/media.ts";
import { renderMarkdown } from "../../markdown.ts";

export function validateZhihuPublishedUrl(value: string, draftUrl: string) {
  const draft = new URL(validateDraftUrl(draftUrl));
  const expected = `https://zhuanlan.zhihu.com${draft.pathname.replace(/\/edit$/, "")}`;
  if (value !== expected)
    throw new Error("发布链接与原知乎草稿ID不一致或包含额外参数");
  return expected;
}

async function verifyImages(page: Page, images: Locator, paths: string[]) {
  if ((await images.count()) !== paths.length)
    throw new Error("知乎图片数量不一致");
  for (const [index, path] of paths.entries()) {
    const payload = await imagePayload(path);
    const expected = await fingerprintImageBuffer(
      page,
      payload.buffer,
      payload.mimeType,
    );
    const image = images.nth(index);
    await image.scrollIntoViewIfNeeded();
    const actual = await fingerprintImageElement(page, image);
    if (!fingerprintsMatch(expected, actual))
      throw new Error(`知乎第${index + 1}张图片内容或顺序不一致`);
  }
}

async function uniqueEnabled(button: Locator) {
  if (
    (await button.count()) !== 1 ||
    !(await button.isVisible()) ||
    !(await button.isEnabled())
  )
    throw new Error("知乎发布按钮不唯一、不可见或不可用，请人工核对");
}

/** Experimental until real-account submission and public-page readback pass. */
export async function publishZhihuArticle(
  context: BrowserContext,
  task: Task,
  markSubmitted: () => void,
) {
  if (process.env.TURBOPUSH_EXPERIMENTAL_PUBLISH !== "1")
    throw new Error("知乎公开发布尚待真实账号验收；需显式开启实验发布开关");
  if (!task.resultUrl) throw new Error("缺少已验收草稿链接");
  const draftUrl = validateDraftUrl(task.resultUrl);
  const publishedUrl = draftUrl.replace(/\/edit$/, "");
  const page = await context.newPage();
  await page.goto(draftUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await verifyDraft(page, task.content);
  await verifyZhihuMedia(
    page,
    task.content.images.length,
    !!task.content.cover,
  );
  const expectedImages = await Promise.all(
    task.content.images.map(imagePayload),
  );
  await verifyZhihuImageOrder(page, expectedImages);
  if (task.content.cover)
    await verifyImages(
      page,
      page.locator(".UploadPicture-wrapper").locator("..").locator("img"),
      [task.content.cover],
    );
  await verifyZhihuTopics(page, task.content.tags);
  const publish = page.getByRole("button", { name: "发布", exact: true });
  await uniqueEnabled(publish);
  // Any click labelled Publish is treated as potentially irreversible, including opening its dialog.
  markSubmitted();
  const arrived = page.waitForURL((url) => url.href === publishedUrl, {
    timeout: 45_000,
  });
  void arrived.catch(() => {});
  await publish.click();
  const confirm = page.getByRole("button", { name: "发布文章", exact: true });
  const dialog = confirm.waitFor({ state: "visible", timeout: 45_000 });
  void dialog.catch(() => {});
  await Promise.race([arrived, dialog]);
  if (page.url() !== publishedUrl) {
    await uniqueEnabled(confirm);
    await confirm.click();
  }
  await arrived;
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  validateZhihuPublishedUrl(page.url(), draftUrl);
  await verifyZhihuPublishedPage(page, task);
  return { url: publishedUrl };
}

export async function verifyZhihuPublishedPage(page: Page, task: Task) {
  validateZhihuPublishedUrl(page.url(), task.resultUrl!);
  const title = page.locator("h1.Post-Title");
  await title.waitFor({ timeout: 30_000 });
  if ((await title.innerText()) !== task.content.title)
    throw new Error("知乎发布页标题不一致");
  const body = page.locator(".Post-RichTextContainer");
  await body.waitFor({ timeout: 30_000 });
  const html =
    task.content.bodyFormat === "markdown"
      ? renderMarkdown(task.content.body)
      : null;
  const expected = html
    ? await page.evaluate(
        (value) =>
          new DOMParser().parseFromString(value, "text/html").body
            .textContent ?? "",
        html,
      )
    : task.content.body;
  const actual = await body.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("figure").forEach((figure) => figure.remove());
    return clone.textContent ?? "";
  });
  const normalize = (value: string) => value.replace(/[\u200b\uFEFF\s]/g, "");
  if (normalize(actual) !== normalize(expected))
    throw new Error("知乎发布页正文不一致");
  await verifyZhihuImageOrder(
    page,
    await Promise.all(task.content.images.map(imagePayload)),
    ".Post-RichTextContainer figure img",
  );
}

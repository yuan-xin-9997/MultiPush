import type { Page } from "playwright";
import {
  imagePayload,
  fingerprintImageBuffer,
  fingerprintsMatch,
  type ImageFingerprint,
} from "../wechat/media.ts";
type ImagePayload = Awaited<ReturnType<typeof imagePayload>>;
const editorSelector = "[contenteditable=true][role=textbox]";

export async function uploadZhihuImage(page: Page, image: ImagePayload) {
  const editor = page.locator(editorSelector);
  const count = await editor.locator("img").count();
  const saved = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      if (
        url.hostname !== "zhuanlan.zhihu.com" ||
        !/^\/api\/articles\/\d+\/draft$/.test(url.pathname) ||
        response.request().method() !== "PATCH"
      )
        return false;
      try {
        const html = response.request().postDataJSON()?.content;
        return (
          typeof html === "string" &&
          (html.match(/<img\b/g) ?? []).length === count + 1
        );
      } catch {
        return false;
      }
    },
    { timeout: 45000 },
  );
  void saved.catch(() => {});
  await editor.click();
  // Ctrl+End can leave an image selected and insert the next upload before it.
  await anchorZhihuEditorEnd(editor);
  await editor.press("Enter");
  await anchorZhihuEditorEnd(editor);
  await page
    .locator('input[type=file][accept^="image/webp"]')
    .setInputFiles(image);
  if (!(await saved).ok()) throw new Error("知乎正文图片保存未确认");
}

async function anchorZhihuEditorEnd(editor: ReturnType<Page["locator"]>) {
  await editor.evaluate((element) => {
    (element as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

export async function verifyZhihuImageOrder(
  page: Page,
  expected: readonly ImagePayload[],
  selector = `${editorSelector} img`,
) {
  const images = page.locator(selector);
  if ((await images.count()) !== expected.length)
    throw new Error("知乎正文图片数量不一致");
  const local = await Promise.all(
    expected.map((image) =>
      fingerprintImageBuffer(page, image.buffer, image.mimeType),
    ),
  );
  for (const [index, fingerprint] of local.entries())
    if (
      local.filter((candidate) => fingerprintsMatch(candidate, fingerprint))
        .length !== 1
    )
      throw new Error(
        `知乎第${index + 1}张图片与其他素材过于相似，无法唯一核对`,
      );
  let previous: ImageFingerprint[] | undefined;
  for (let sample = 0; sample < 3; sample++) {
    const actual: ImageFingerprint[] = [];
    if ((await images.count()) !== expected.length)
      throw new Error("知乎图片数量在回读期间变化");
    for (const [index, fingerprint] of local.entries()) {
      try {
        const image = images.nth(index);
        await image.scrollIntoViewIfNeeded();
        await image.evaluate((element) =>
          (element as HTMLImageElement).decode(),
        );
        const resource = await image.evaluate(
          (element) =>
            (element as HTMLImageElement).currentSrc ||
            (element as HTMLImageElement).src,
        );
        const url = new URL(resource);
        if (
          url.protocol !== "https:" ||
          !(
            url.hostname === "pic-private.zhihu.com" ||
            url.hostname.endsWith(".zhimg.com")
          ) ||
          url.username ||
          url.password
        )
          throw new Error("非受信图片资源");
        const response = await page.context().request.get(url.href, {
          maxRedirects: 0,
          timeout: 15000,
          headers: { Referer: "https://zhuanlan.zhihu.com/" },
        });
        if (
          !response.ok() ||
          Number(response.headers()["content-length"] ?? 0) > 10 * 1024 * 1024
        )
          throw new Error("图片响应无效");
        const mime = response
          .headers()
          ["content-type"]?.split(";")[0]
          ?.trim()
          .toLowerCase();
        if (
          !mime ||
          !["image/png", "image/jpeg", "image/webp", "image/avif"].includes(
            mime,
          )
        )
          throw new Error("图片格式无效");
        const bytes = await response.body();
        if (!bytes.length || bytes.length > 10 * 1024 * 1024)
          throw new Error("图片大小无效");
        const remote = await fingerprintImageBuffer(page, bytes, mime);
        const matches = local.flatMap((candidate, position) =>
          fingerprintsMatch(candidate, remote) ? [position] : [],
        );
        if (
          matches.length !== 1 ||
          matches[0] !== index ||
          !fingerprintsMatch(fingerprint, remote)
        )
          throw new Error("图片身份不一致");
        if (
          previous &&
          (previous[index].differenceHash !== remote.differenceHash ||
            previous[index].averageRgb.join() !== remote.averageRgb.join())
        )
          throw new Error("图片内容不稳定");
        actual.push(remote);
      } catch {
        throw new Error(`知乎第${index + 1}张图片内容、顺序或稳定回读未通过`);
      }
    }
    previous = actual;
    if (sample < 2) await page.waitForTimeout(300);
  }
}

export async function verifyZhihuMedia(
  page: Page,
  count: number,
  cover: boolean,
) {
  await page.waitForFunction(
    ({ count, cover, editorSelector }) => {
      const imgs = [...document.querySelectorAll(`${editorSelector} img`)];
      const coverImage = document
        .querySelector(".UploadPicture-wrapper")
        ?.parentElement?.querySelector("img");
      return (
        imgs.length === count &&
        [...imgs, ...(cover && coverImage ? [coverImage] : [])].every((el) => {
          try {
            const host = new URL((el as HTMLImageElement).src).hostname;
            return (
              host === "pic-private.zhihu.com" || host.endsWith(".zhimg.com")
            );
          } catch {
            return false;
          }
        }) &&
        (!cover || !!coverImage)
      );
    },
    { count, cover, editorSelector },
    { timeout: 20000 },
  );
}

export async function uploadZhihuCover(page: Page, image: ImagePayload) {
  const saved = page.waitForResponse(
    (response) => {
      const u = new URL(response.url());
      if (
        u.hostname !== "zhuanlan.zhihu.com" ||
        !/^\/api\/articles\/\d+\/draft$/.test(u.pathname) ||
        response.request().method() !== "PATCH"
      )
        return false;
      try {
        return (
          typeof response.request().postDataJSON()?.titleImage === "string" &&
          !!response.request().postDataJSON().titleImage
        );
      } catch {
        return false;
      }
    },
    { timeout: 45000 },
  );
  void saved.catch(() => {});
  await page.getByRole("button", { name: "发布设置", exact: true }).click();
  await page.locator("input.UploadPicture-input").setInputFiles(image);
  await page.waitForFunction(
    () =>
      !!document
        .querySelector(".UploadPicture-wrapper")
        ?.parentElement?.querySelector("img"),
    undefined,
    { timeout: 45000 },
  );
  if (!(await saved).ok()) throw new Error("知乎封面保存未确认");
}

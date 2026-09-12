import type { Page } from "playwright";
import type { imagePayload } from "../wechat/media.ts";
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
  await editor.press(
    process.platform === "darwin" ? "Meta+End" : "Control+End",
  );
  await editor.press("Enter");
  await page
    .locator('input[type=file][accept^="image/webp"]')
    .setInputFiles(image);
  if (!(await saved).ok()) throw new Error("知乎正文图片保存未确认");
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

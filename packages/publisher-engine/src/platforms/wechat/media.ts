import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";

export async function imagePayload(path: string) {
  if (!isAbsolute(path)) throw new Error("图片必须使用本地绝对路径");
  const file = await stat(path);
  if (!file.isFile() || file.size > 10 * 1024 * 1024)
    throw new Error("图片必须是10MB以内的本地文件");
  const buffer = await readFile(path);
  const png = buffer
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (!png && !jpeg)
    throw new Error("当前仅支持PNG/JPEG图片，文件内容必须与图片格式一致");
  return {
    name: `turbopush-${randomUUID()}.${png ? "png" : "jpg"}`,
    mimeType: png ? "image/png" : "image/jpeg",
    buffer,
  };
}

export async function uploadBodyImage(
  page: Page,
  payload: Awaited<ReturnType<typeof imagePayload>>,
) {
  const editor = page.locator(".rich_media_content .ProseMirror");
  const count = await editor.locator('img[src*="mmbiz.qpic.cn"]').count();
  await editor.click();
  await editor.press(
    process.platform === "darwin" ? "Meta+End" : "Control+End",
  );
  await editor.press("Enter");
  await page.locator("input[type=file][name=file]").setInputFiles(payload);
  await page.waitForFunction(
    (expected) =>
      [
        ...document.querySelectorAll(".rich_media_content .ProseMirror img"),
      ].filter((el) => {
        try {
          return (
            new URL((el as HTMLImageElement).src).hostname === "mmbiz.qpic.cn"
          );
        } catch {
          return false;
        }
      }).length === expected,
    count + 1,
    { timeout: 45000 },
  );
}

export async function uploadCover(
  page: Page,
  payload: Awaited<ReturnType<typeof imagePayload>>,
) {
  await page.getByText("拖拽或选择封面", { exact: true }).click();
  await page.getByRole("link", { name: "从图片库选择", exact: true }).click();
  await page
    .locator('input[type=file][accept*="image/bmp"]')
    .setInputFiles(payload);
  const tile = page
    .locator(".weui-desktop-img-picker__item")
    .filter({ has: page.getByText(payload.name, { exact: true }) });
  await tile.waitFor({ timeout: 45000 });
  // Upload may select automatically. Select only if not already selected.
  if (!(await tile.getAttribute("class"))?.includes("selected"))
    await tile.locator("i").click();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.waitForFunction(
    () =>
      !!(
        document.querySelector(
          "#js_cover_area .js_cover_preview_new",
        ) as HTMLElement | null
      )?.style.backgroundImage,
    undefined,
    { timeout: 45000 },
  );
}

export async function verifyWechatMedia(
  page: Page,
  count: number,
  cover: boolean,
) {
  await page.waitForFunction(
    ({ count, cover }) => {
      const images = [
        ...document.querySelectorAll(".rich_media_content .ProseMirror img"),
      ].filter((el) => !el.classList.contains("ProseMirror-separator"));
      return (
        images.length === count &&
        images.every((el) => {
          try {
            return (
              new URL((el as HTMLImageElement).src).hostname === "mmbiz.qpic.cn"
            );
          } catch {
            return false;
          }
        }) &&
        (!cover ||
          !!(
            document.querySelector(
              "#js_cover_area .js_cover_preview_new",
            ) as HTMLElement | null
          )?.style.backgroundImage)
      );
    },
    { count, cover },
    { timeout: 20000 },
  );
}

import type { BrowserContext, Page } from "playwright";
import type { Task } from "@turbopush/shared";
import {
  openWechatDraft,
  validateWechatDraftUrl,
  verifyWechatDraft,
} from "./draft.ts";
import {
  fingerprintImageBuffer,
  fingerprintsMatch,
  imagePayload,
  stableFingerprintImageElement,
  verifyWechatMedia,
} from "./media.ts";
import { renderMarkdown } from "../../markdown.ts";

export function validateWechatPublishedUrl(value: string) {
  const url = new URL(value);
  if (
    url.origin !== "https://mp.weixin.qq.com" ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) =>
      /token|ticket|auth|cookie/i.test(key),
    )
  )
    throw new Error("无效的公众号公开文章链接");
  if (/^\/s\/[A-Za-z0-9_-]+$/.test(url.pathname) && !url.search) {
    url.hash = "";
    return url.href;
  }
  if (
    url.pathname !== "/s" ||
    !["__biz", "mid", "idx", "sn"].every((key) => url.searchParams.get(key))
  )
    throw new Error("无效的公众号公开文章链接");
  const canonical = new URL("https://mp.weixin.qq.com/s");
  for (const key of ["__biz", "mid", "idx", "sn", "chksm"]) {
    const content = url.searchParams.get(key);
    if (content) canonical.searchParams.set(key, content);
  }
  return canonical.href;
}

export async function verifyWechatPublishedPage(page: Page, task: Task) {
  validateWechatPublishedUrl(page.url());
  const title = page.locator("#activity-name");
  await title.waitFor({ timeout: 30_000 });
  if ((await title.innerText()).trim() !== task.content.title)
    throw new Error("公众号公开页标题不一致");
  const body = page.locator("#js_content");
  await body.waitFor({ timeout: 30_000 });
  const expected =
    task.content.bodyFormat === "markdown"
      ? await page.evaluate(
          (html) =>
            new DOMParser().parseFromString(html, "text/html").body
              .textContent ?? "",
          renderMarkdown(task.content.body),
        )
      : task.content.body;
  const normalize = (value: string) => value.replace(/[\s\u200b\uFEFF]/g, "");
  if (normalize(await body.innerText()) !== normalize(expected))
    throw new Error("公众号公开页正文不一致");
  const images = body.locator("img");
  if ((await images.count()) !== task.content.images.length)
    throw new Error("公众号公开页图片数量不一致");
  for (const [index, path] of task.content.images.entries()) {
    const payload = await imagePayload(path);
    const expected = await fingerprintImageBuffer(
      page,
      payload.buffer,
      payload.mimeType,
    );
    await images.nth(index).scrollIntoViewIfNeeded();
    await page.waitForFunction(
      (index) => {
        const image = document.querySelectorAll("#js_content img")[index] as
          HTMLImageElement | undefined;
        return (
          !!image &&
          image.naturalWidth > 1 &&
          new URL(image.currentSrc || image.src).hostname === "mmbiz.qpic.cn"
        );
      },
      index,
      { timeout: 15000 },
    );
    const stable = await stableFingerprintImageElement(
      page,
      images.nth(index),
      expected,
    );
    if (
      !stable ||
      "unstable" in stable ||
      !fingerprintsMatch(expected, stable.fingerprint)
    )
      throw new Error(`公众号公开页第${index + 1}张图片未通过稳定回读`);
  }
}

export async function findPublishedArticle(
  context: BrowserContext,
  task: Task,
) {
  const page = await context.newPage();
  await page.goto("https://mp.weixin.qq.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const opened = context
    .waitForEvent("page", { timeout: 5000 })
    .catch(() => null);
  await page.getByRole("button", { name: "全部发表记录", exact: true }).click();
  const records = (await opened) ?? page;
  const title = records.getByText(task.content.title, { exact: true });
  await title.waitFor({ state: "visible", timeout: 45_000 });
  if ((await title.count()) !== 1) throw new Error("公众号发表记录标题不唯一");
  const link = await title.evaluate(
    (element) => element.closest("a")?.href ?? null,
  );
  if (link) return validateWechatPublishedUrl(link);
  const article = context
    .waitForEvent("page", { timeout: 10_000 })
    .catch(() => null);
  await title.click();
  const result = (await article) ?? records;
  await result.waitForLoadState("domcontentloaded");
  return validateWechatPublishedUrl(result.url());
}

/** Real UI submission is enabled only for an explicitly confirmed, verified draft. */
export async function publishWechatArticle(
  context: BrowserContext,
  task: Task,
  markSubmitted: () => void,
) {
  if (process.env.TURBOPUSH_EXPERIMENTAL_PUBLISH !== "1")
    throw new Error("公众号实验发布开关未开启");
  if (!task.resultUrl) throw new Error("缺少公众号草稿链接");
  const page = await openWechatDraft(
    context,
    validateWechatDraftUrl(task.resultUrl),
  );
  await verifyWechatDraft(page, task.content);
  const images = await Promise.all(task.content.images.map(imagePayload));
  const expected = await Promise.all(
    images.map((image) =>
      fingerprintImageBuffer(page, image.buffer, image.mimeType),
    ),
  );
  await verifyWechatMedia(page, expected, !!task.content.cover);
  const publish = page.getByRole("button", { name: "发表", exact: true });
  if ((await publish.count()) !== 1 || !(await publish.isEnabled()))
    throw new Error("公众号发表按钮不唯一或不可用");
  markSubmitted();
  await publish.click();
  await confirmWechatPublication(page);
  const url = await findPublishedArticle(context, task);
  const published = await context.newPage();
  await published.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await published.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await verifyWechatPublishedPage(published, task);
  return { url: validateWechatPublishedUrl(published.url()) };
}

export async function confirmWechatPublication(page: Page) {
  const dialog = page.locator(
    '.weui-desktop-dialog:visible, [role="dialog"]:visible',
  );
  await dialog
    .first()
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => undefined);
  for (let step = 0; step < 3; step++) {
    await dialog
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => undefined);
    if (!(await dialog.count())) break;
    if ((await dialog.count()) !== 1)
      throw new Error("公众号发表确认窗口不唯一");
    const onlyPublish = dialog.getByRole("button", {
      name: "仅发表",
      exact: true,
    });
    const confirm = (await onlyPublish.count())
      ? onlyPublish
      : dialog.getByRole("button", {
          name: /^(发表|确认发表|继续发表)$/,
          exact: true,
        });
    if ((await confirm.count()) !== 1 || !(await confirm.isEnabled()))
      throw new Error("公众号发表确认步骤需要人工核对");
    const notificationLabel = dialog.getByText("群发通知", { exact: true });
    if ((await notificationLabel.count()) === 1) {
      const group = notificationLabel.locator(
        "xpath=ancestor::*[.//input[@type='checkbox']][1]",
      );
      const notification = group.locator('input[type="checkbox"]');
      if ((await notification.count()) !== 1)
        throw new Error("公众号群发通知开关无法唯一确认");
      if (await notification.isChecked()) {
        if (
          (await notification.evaluate(
            (element) => element.parentElement?.tagName,
          )) !== "LABEL"
        )
          throw new Error("公众号通知控件布局已变化");
        await notification.locator("..").click();
      }
      if (await notification.isChecked())
        throw new Error("公众号群发通知未关闭，停止发表");
    }
    if (await dialog.locator('input[type="checkbox"]:checked').count())
      throw new Error("公众号包含分组通知或定时设置，停止发表");
    const previous = await dialog.innerText();
    await confirm.click();
    await page.waitForFunction(
      (previous) => {
        const dialogs = [
          ...document.querySelectorAll('.weui-desktop-dialog, [role="dialog"]'),
        ].filter((element) => (element as HTMLElement).offsetWidth > 0);
        return (
          !dialogs.length ||
          (dialogs.length === 1 &&
            (dialogs[0] as HTMLElement).innerText !== previous)
        );
      },
      previous,
      { timeout: 10000 },
    );
    await page.waitForTimeout(500);
  }
  if (await dialog.count())
    throw new Error("公众号仍有确认窗口，请人工核对，禁止重复提交");
}

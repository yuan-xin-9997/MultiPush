import type { BrowserContext } from "playwright";

export async function verifyZhihuDraftList(
  context: BrowserContext,
  draftUrl: string,
  title: string,
) {
  const parsed = new URL(draftUrl);
  if (
    parsed.origin !== "https://zhuanlan.zhihu.com" ||
    !/^\/p\/\d+\/edit$/.test(parsed.pathname) ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  )
    throw new Error("无效的知乎草稿链接");
  const page = await context.newPage();
  try {
    await page.goto(
      "https://www.zhihu.com/creator/manage/creation/draft?type=article",
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    await page
      .locator(".CreationCardTitle-wrapper")
      .first()
      .waitFor({ timeout: 20000 });
    const match = page.locator(
      `a[href="${parsed.href}"] .CreationCardTitle-wrapper`,
    );
    for (let batch = 0; batch < 20; batch++) {
      if (await match.count()) {
        if ((await match.innerText()).trim() !== title.trim())
          throw new Error("知乎草稿列表标题不一致");
        return;
      }
      const count = await page.locator(".CreationCardTitle-wrapper").count();
      await page
        .locator(".CreationCardTitle-wrapper")
        .last()
        .scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, 900);
      try {
        await page.waitForFunction(
          (count) =>
            document.querySelectorAll(".CreationCardTitle-wrapper").length >
            count,
          count,
          { timeout: 3000 },
        );
      } catch {
        break;
      }
    }
    throw new Error("未在知乎草稿列表前200条中找到任务草稿，请人工核对");
  } finally {
    await page.close();
  }
}

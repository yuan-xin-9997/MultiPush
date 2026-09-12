import type { Page } from "playwright";
export function validateZhihuTopics(tags: string[] = []) {
  if (
    tags.length > 5 ||
    tags.some((tag) => !tag.trim() || tag !== tag.trim()) ||
    new Set(tags).size !== tags.length
  )
    throw new Error("知乎话题最多5个，名称须非空、不重复且无首尾空格");
  return tags;
}
export async function verifyZhihuTopics(page: Page, tags: string[]) {
  if (tags.length)
    await page.waitForFunction(
      (tags) =>
        tags.every((tag) =>
          [...document.querySelectorAll(".css-1d3pntc")].some(
            (el) => el.textContent === tag,
          ),
        ),
      tags,
      { timeout: 20000 },
    );
}
export async function saveZhihuTopics(page: Page, tags: string[]) {
  validateZhihuTopics(tags);
  if (!tags.length) return;
  if (
    !(await page
      .getByRole("button", { name: "添加话题", exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: "发布设置", exact: true }).click();
  for (const tag of tags) {
    await page.getByRole("button", { name: "添加话题", exact: true }).click();
    await page.getByPlaceholder("搜索话题...").fill(tag);
    const option = page.getByRole("button", { name: tag, exact: true });
    await option.waitFor({ timeout: 15000 });
    if ((await option.count()) !== 1)
      throw new Error("话题名称存在歧义，请人工选择");
    const saved = page.waitForResponse(
      (response) => {
        const u = new URL(response.url());
        if (
          u.hostname !== "zhuanlan.zhihu.com" ||
          !/^\/api\/articles\/\d+\/topics$/.test(u.pathname) ||
          response.request().method() !== "POST"
        )
          return false;
        try {
          return response.request().postDataJSON()?.name === tag;
        } catch {
          return false;
        }
      },
      { timeout: 30000 },
    );
    void saved.catch(() => {});
    await option.click();
    if (!(await saved).ok()) throw new Error("知乎话题保存未确认");
    await verifyZhihuTopics(page, [tag]);
  }
}

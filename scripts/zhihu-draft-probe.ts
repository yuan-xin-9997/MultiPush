import type { Page, Response } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function runDraftProbe(
  page: Page,
  directory: string,
  run: number,
) {
  const title = `TurboPushForked 开发验证草稿 ${new Date().toISOString().slice(0, 10)}-${run}`;
  const body = `这是一篇由 TurboPushForked 开发验证生成的测试草稿（第 ${run} 次）。\n\n仅用于验证标题、正文与自动保存，不进行公开发布。\n\n测试完成后可以手动删除。`;
  const responses: {
    method: string;
    path: string;
    status: number;
    draftPayload?: unknown;
  }[] = [];
  const listener = (response: Response) => {
    const request = response.request();
    if (["POST", "PUT", "PATCH"].includes(request.method())) {
      const url = new URL(response.url());
      if (
        url.hostname.endsWith(".zhihu.com") &&
        !/log|track|report|event/.test(url.pathname)
      ) {
        responses.push({
          method: request.method(),
          path: url.pathname,
          status: response.status(),
          ...(/^\/api\/articles\/\d+\/draft$/.test(url.pathname)
            ? { draftPayload: request.postDataJSON() }
            : {}),
        });
      }
    }
  };
  page.on("response", listener);
  try {
    await page.getByPlaceholder("请输入标题（最多 100 个字）").fill(title);
    await page.locator('[contenteditable="true"][role="textbox"]').fill(body);
    await page.getByPlaceholder("请输入标题（最多 100 个字）").click();
    // Probe-only debounce observation; production adapter will wait on the observed save signal.
    await page.waitForTimeout(6000);
    const text = (await page.locator("body").innerText()).slice(0, 6000);
    const result = { title, body, url: page.url(), text, responses };
    await mkdir(join(directory, "diagnostics"), { recursive: true });
    await writeFile(
      join(directory, "diagnostics", `zhihu-draft-${run}.json`),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } finally {
    page.off("response", listener);
  }
}

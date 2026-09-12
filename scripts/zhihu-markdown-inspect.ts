import { resolve } from "node:path";
import { Service } from "../packages/publisher-engine/src/service.ts";
import { renderMarkdown } from "../packages/publisher-engine/src/markdown.ts";

const service = new Service(resolve(".data"));
try {
  const task = service.store
    .tasks()
    .find(
      (t) =>
        t.platform === "zhihu" &&
        t.content.title === "TurboPushForked 知乎Markdown草稿集成验证",
    );
  if (!task?.resultUrl) throw new Error("没有测试草稿检查点");
  const result = await service.dispatch({
    id: "open",
    method: "task.openDraft",
    params: { id: task.id },
  });
  if (result.error) throw new Error(result.error.message);
  const context = await service.browsers.open(
    service.store.account(task.accountId),
  );
  const page = context.pages().at(-1)!;
  await page.locator("[contenteditable=true][role=textbox]").waitFor();
  await page.waitForFunction(
    () =>
      !!document
        .querySelector("[contenteditable=true][role=textbox]")
        ?.textContent?.includes("加粗"),
  );
  console.log(
    JSON.stringify(
      await page
        .locator("[contenteditable=true][role=textbox]")
        .evaluate((el, html) => {
          const expected = new DOMParser().parseFromString(html, "text/html");
          return {
            text: el.textContent,
            expected: expected.body.textContent,
            structure: [
              "h1,h2,h3",
              "strong,b",
              "em,i",
              "li",
              "blockquote",
              "pre",
              "code",
            ].map((s) => ({
              selector: s,
              expected: expected.querySelectorAll(s).length,
              actual: el.querySelectorAll(s).length,
            })),
            html: el.innerHTML.replace(
              / (?:class|style|data-[\w-]+)="[^"]*"/g,
              "",
            ),
          };
        }, renderMarkdown(task.content.body)),
    ),
  );
  console.log(
    JSON.stringify(
      await page
        .locator("[contenteditable=true][role=textbox] span")
        .evaluateAll((els) =>
          els
            .filter((el) => ["加粗", "斜体"].includes(el.textContent ?? ""))
            .map((el) => ({
              text: el.textContent,
              style: el.getAttribute("style"),
              weight: getComputedStyle(el).fontWeight,
              fontStyle: getComputedStyle(el).fontStyle,
            })),
        ),
    ),
  );
} finally {
  await service.close();
}

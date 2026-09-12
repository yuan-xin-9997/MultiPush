import type { BrowserContext } from "playwright";
export async function probe(context: BrowserContext, step?: string) {
  const page = context.pages().at(-1)!;
  if (step === "topic-second") {
    const listener = (req: import("playwright").Request) => {
      if (
        ["POST", "PATCH", "PUT"].includes(req.method()) &&
        new URL(req.url()).hostname.endsWith("zhihu.com")
      ) {
        let keys: string[] = [];
        try {
          keys = Object.keys(req.postDataJSON());
        } catch {}
        console.log(
          JSON.stringify({
            path: new URL(req.url()).pathname,
            method: req.method(),
            keys,
          }),
        );
      }
    };
    page.on("request", listener);
    setTimeout(() => page.off("request", listener), 20000).unref();
    if (
      !(await page
        .getByRole("button", { name: "添加话题", exact: true })
        .isVisible())
    )
      await page.getByRole("button", { name: "发布设置", exact: true }).click();
    await page.getByRole("button", { name: "添加话题", exact: true }).click();
    await page.getByPlaceholder("搜索话题...").fill("软件测试");
    await page.getByRole("button", { name: "软件测试", exact: true }).click();
  }
  if (step === "topic-select") {
    const handler = (req: import("playwright").Request) => {
      if (
        req.method() === "PATCH" &&
        new URL(req.url()).pathname.endsWith("/draft")
      ) {
        const data = req.postDataJSON();
        console.log(
          JSON.stringify({ keys: Object.keys(data), topicValue: data.topics }),
        );
        page.off("request", handler);
      }
    };
    page.on("request", handler);
    await page.getByRole("button", { name: "软件开发", exact: true }).click();
  }
  if (step === "topic-element")
    console.log(
      JSON.stringify(
        await page
          .getByText("软件开发", { exact: true })
          .evaluateAll((els) =>
            els.map((el) => ({
              tag: el.tagName,
              class: el.className,
              parent: el.parentElement?.className,
              html: el.outerHTML,
            })),
          ),
      ),
    );
  if (step === "topic-search") {
    await page.getByRole("button", { name: "发布设置", exact: true }).click();
    await page.getByRole("button", { name: "添加话题", exact: true }).click();
    await page.getByPlaceholder("搜索话题...").fill("软件开发");
  }
  if (step === "topic-state")
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          text: document.body.innerText.slice(-1500),
          matches: [...document.querySelectorAll("button,[role=option]")]
            .filter(
              (el) =>
                el.getBoundingClientRect().width > 0 &&
                el.textContent?.includes("软件"),
            )
            .map((el) => ({
              text: el.textContent,
              tag: el.tagName,
              class: el.className,
            })),
        })),
      ),
    );
  if (step === "verify-list") {
    const link = page
      .locator("a")
      .filter({ hasText: "TurboPushForked 知乎图文草稿集成验证" })
      .first();
    const url = await link.getAttribute("href");
    const title = await link.locator(".CreationCardTitle-wrapper").innerText();
    const { verifyZhihuDraftList } = await import(
      `../packages/publisher-engine/src/platforms/zhihu/draft-list.ts?revision=${Date.now()}`
    );
    await verifyZhihuDraftList(context, url!, title);
    console.log(JSON.stringify({ draftListVerified: true }));
  }
  if (step === "list-title")
    console.log(
      JSON.stringify(
        await page
          .locator("a")
          .filter({ hasText: "TurboPushForked 知乎图文草稿集成验证" })
          .first()
          .evaluate((el) => ({
            html: el.innerHTML,
            inputs: [...document.querySelectorAll("input")].map((el) => ({
              placeholder: el.placeholder,
            })),
            buttons: [...document.querySelectorAll("button")]
              .filter((el) => el.getBoundingClientRect().width > 0)
              .map((el) => ({
                text: el.textContent,
                aria: el.getAttribute("aria-label"),
              })),
          })),
      ),
    );
  if (step === "open-test")
    await page
      .locator("a")
      .filter({ hasText: "TurboPushForked 知乎图文草稿集成验证" })
      .first()
      .click();
  if (step === "draft-list")
    await page.goto(
      "https://www.zhihu.com/creator/manage/creation/draft?type=answer",
      { waitUntil: "domcontentloaded" },
    );
  if (step === "article-tab")
    await page.getByRole("link", { name: /^文章草稿/ }).click();
  if (step === "list-state")
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          path: location.pathname,
          params: location.search,
          controls: [...document.querySelectorAll("a,button,[role=tab]")]
            .filter((e) => e.getBoundingClientRect().width > 0)
            .map((e) => ({
              text: e.textContent?.trim(),
              role: e.getAttribute("role"),
              href: (e as HTMLAnchorElement).href?.split("?")[0],
            }))
            .filter((e) => e.text)
            .slice(-45),
        })),
      ),
    );
  if (step === "image-block")
    console.log(
      JSON.stringify(
        await page
          .locator(".PostEditor img")
          .first()
          .evaluate((el) => ({
            block: el.closest("[data-block]")?.outerHTML.slice(0, 450),
            figure: !!el.closest("figure"),
            nonEditable: el.closest("[contenteditable=false]")?.tagName,
          })),
      ),
    );
  if (step === "save-keys") {
    page.once("request", () => {});
    const handler = (req: import("playwright").Request) => {
      if (
        req.method() === "PATCH" &&
        new URL(req.url()).pathname.endsWith("/draft")
      ) {
        const data = req.postDataJSON();
        console.log(
          JSON.stringify({
            keys: Object.keys(data),
            types: Object.fromEntries(
              Object.entries(data).map(([k, v]) => [k, typeof v]),
            ),
          }),
        );
        page.off("request", handler);
      }
    };
    page.on("request", handler);
    await page.locator("input.UploadPicture-input").setInputFiles([]);
    await page
      .locator("input.UploadPicture-input")
      .setInputFiles("apps/desktop/src-tauri/icons/128x128@2x.png");
  }
  if (step === "cover-parent")
    console.log(
      JSON.stringify(
        await page.locator(".UploadPicture-wrapper").evaluate((el) => {
          const r = [];
          for (
            let e: Element | null = el;
            e && r.length < 5;
            e = e.parentElement
          )
            r.push({
              class: e.className,
              images: [...e.querySelectorAll("img")].map((i) => ({
                class: i.className,
                host: new URL(i.src).hostname,
              })),
              background: [...e.querySelectorAll("[style]")]
                .filter((e) => (e as HTMLElement).style.backgroundImage)
                .map((e) => ({ class: e.className, tag: e.tagName })),
            });
          return r;
        }),
      ),
    );
  if (step === "settings-cover") {
    await page.getByRole("button", { name: "发布设置", exact: true }).click();
    await page.locator("input.UploadPicture-input").setInputFiles([]);
    await page
      .locator("input.UploadPicture-input")
      .setInputFiles("apps/desktop/src-tauri/icons/icon.png");
  }
  if (step === "image-ancestors")
    console.log(
      JSON.stringify(
        await page
          .locator(".PostEditor img")
          .first()
          .evaluate((el) => {
            const result = [];
            for (
              let e: Element | null = el;
              e && result.length < 7;
              e = e.parentElement
            )
              result.push({
                tag: e.tagName,
                class: e.className,
                editable: e.getAttribute("contenteditable"),
              });
            return result;
          }),
      ),
    );
  if (step === "watch") {
    const listener = async (response: import("playwright").Response) => {
      const u = new URL(response.url());
      if (
        !u.hostname.endsWith("zhihu.com") ||
        !["POST", "PATCH"].includes(response.request().method())
      )
        return;
      let keys: string[] = [];
      try {
        keys = Object.keys(await response.json());
      } catch {}
      console.log(
        JSON.stringify({ path: u.pathname, status: response.status(), keys }),
      );
    };
    page.on("response", listener);
    setTimeout(() => page.off("response", listener), 30000).unref();
  }
  if (step === "cover-state")
    console.log(
      JSON.stringify(
        await page.locator(".UploadPicture-wrapper").evaluate((el) => ({
          text: el.textContent,
          children: [...el.querySelectorAll("*")].map((e) => ({
            tag: e.tagName,
            class: e.className,
            style: (e as HTMLElement).style.backgroundImage ? "image" : "",
            srcHost: (() => {
              try {
                return new URL((e as HTMLImageElement).src).hostname;
              } catch {
                return "";
              }
            })(),
          })),
        })),
      ),
    );
  if (step === "reload") {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[contenteditable=true][role=textbox]").waitFor();
  }
  if (step === "fill") {
    const title = page.getByPlaceholder("请输入标题（最多 100 个字）");
    if (await title.inputValue()) throw new Error("拒绝覆盖非空草稿");
    await title.fill("TurboPushForked 知乎图片开发验证草稿");
    await page
      .locator("[contenteditable=true][role=textbox]")
      .fill("这是一篇开发测试草稿。仅验证正文图片与封面，不公开发布。");
  }
  if (step === "body-image") {
    if (
      !(
        await page.getByPlaceholder("请输入标题（最多 100 个字）").inputValue()
      ).startsWith("TurboPushForked ")
    )
      throw new Error("仅测试草稿");
    await page
      .locator("[contenteditable=true][role=textbox]")
      .press("Control+End");
    await page.locator("[contenteditable=true][role=textbox]").press("Enter");
    await page
      .locator('input[type=file][accept^="image/webp"]')
      .setInputFiles("apps/desktop/src-tauri/icons/icon.png");
  }
  if (step === "cover") {
    if (
      !(
        await page.getByPlaceholder("请输入标题（最多 100 个字）").inputValue()
      ).startsWith("TurboPushForked ")
    )
      throw new Error("仅测试草稿");
    await page
      .locator("input.UploadPicture-input")
      .setInputFiles("apps/desktop/src-tauri/icons/icon.png");
  }
  if (step === "state")
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          text: document.body.innerText.slice(-1100),
          images: [
            ...document.querySelectorAll(
              ".PostEditor img,.UploadPicture-wrapper img",
            ),
          ].map((el) => ({
            class: el.className,
            host: (() => {
              try {
                return new URL((el as HTMLImageElement).src).hostname;
              } catch {
                return "";
              }
            })(),
            parent: el.parentElement?.className,
          })),
        })),
      ),
    );
  if (!step || step === "inspect")
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          inputs: [...document.querySelectorAll("input[type=file]")].map(
            (el) => ({
              html: el.outerHTML,
              parentClass: el.parentElement?.className,
            }),
          ),
          controls: [...document.querySelectorAll("button,[role=button]")]
            .map((el) => ({
              text: el.textContent,
              aria: el.getAttribute("aria-label"),
              title: el.getAttribute("title"),
              class: el.className,
            }))
            .slice(0, 45),
        })),
      ),
    );
}

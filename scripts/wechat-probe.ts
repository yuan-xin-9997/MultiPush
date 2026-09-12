import type { BrowserContext } from "playwright";

export async function probe(
  context: BrowserContext,
  command: { step?: string },
) {
  const page = context.pages().at(-1)!;
  if (command.step === "verify-list") {
    const { verifyWechatDraftList, wechatDraftUrl } = await import(
      `../packages/publisher-engine/src/platforms/wechat/draft.ts?revision=${Date.now()}`
    );
    const title = await page
      .getByRole("link", { name: /TurboPushForked.*Markdown/ })
      .innerText();
    const id = await page
      .getByRole("link", { name: /TurboPushForked.*Markdown/ })
      .evaluate((el) =>
        el.closest("[data-appid]")!.getAttribute("data-appid")!,
      );
    await verifyWechatDraftList(context, wechatDraftUrl(id), title);
    console.log(JSON.stringify({ draftListVerified: true }));
  }
  if (command.step === "draft-ancestors")
    console.log(
      JSON.stringify(
        await page
          .getByRole("link", { name: /TurboPushForked.*Markdown/ })
          .evaluate((el) => {
            const result = [];
            for (
              let e: Element | null = el;
              e && result.length < 8;
              e = e.parentElement
            )
              result.push({
                tag: e.tagName,
                class: e.className,
                attributes: [...e.attributes]
                  .filter((a) => a.name !== "class")
                  .map((a) => ({
                    name: a.name,
                    value: a.name.startsWith("data-") ? a.value : "[omitted]",
                  })),
              });
            return result;
          }),
      ),
    );
  if (command.step === "draft-items")
    console.log(
      JSON.stringify(
        await page
          .getByRole("link", { name: /TurboPushForked/ })
          .evaluateAll((els) =>
            els.map((el) => ({
              class: el.className,
              hrefKeys: (() => {
                try {
                  return [
                    ...new URL(
                      (el as HTMLAnchorElement).href,
                    ).searchParams.keys(),
                  ];
                } catch {
                  return [];
                }
              })(),
              attributes: [...el.attributes].map((a) => a.name),
              parent: {
                class: el.parentElement?.className,
                attributes: [...(el.parentElement?.attributes ?? [])].map(
                  (a) => a.name,
                ),
              },
            })),
          ),
      ),
    );
  if (command.step === "content-menu")
    await page.getByText("内容管理", { exact: true }).click();
  if (command.step === "draft-list")
    await page.getByText("草稿箱", { exact: true }).click();
  if (command.step === "body-image") {
    await page.locator(".rich_media_content .ProseMirror").click();
    await page.locator(".rich_media_content .ProseMirror").press("Control+End");
    await page
      .locator("input[type=file][name=file]")
      .setInputFiles("apps/desktop/src-tauri/icons/icon.png");
  }
  if (command.step === "media-state")
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          images: [
            ...document.querySelectorAll(
              ".rich_media_content .ProseMirror img",
            ),
          ].map((el) => ({
            srcHost: (() => {
              try {
                return new URL((el as HTMLImageElement).src).hostname;
              } catch {
                return "";
              }
            })(),
            dataSrc: el.hasAttribute("data-src"),
            class: el.className,
          })),
          cover: [...document.querySelectorAll("#js_cover_area *")].map(
            (el) => ({
              tag: el.tagName,
              class: el.className,
              style: (el as HTMLElement).style.backgroundImage
                ? "has-background"
                : "",
              src: el.hasAttribute("src"),
            }),
          ),
        })),
      ),
    );
  if (command.step === "tile")
    console.log(
      JSON.stringify(
        await page
          .getByText("icon.png", { exact: true })
          .evaluate((el) => ({
            tag: el.tagName,
            class: el.className,
            ancestors: [
              el.parentElement,
              el.parentElement?.parentElement,
              el.parentElement?.parentElement?.parentElement,
            ].map((e) => ({
              tag: e?.tagName,
              class: e?.className,
              children: [...(e?.children ?? [])].map((c) => ({
                tag: c.tagName,
                class: c.className,
              })),
            })),
          })),
      ),
    );
  if (command.step === "select-cover") {
    await page
      .locator(".weui-desktop-img-picker__item")
      .filter({ hasText: "icon.png" })
      .locator("i")
      .click();
    await page.getByRole("button", { name: "下一步", exact: true }).click();
  }
  if (command.step === "confirm-cover")
    await page.getByRole("button", { name: "确认", exact: true }).click();
  if (command.step === "cover-state")
    console.log(
      JSON.stringify(
        await page.evaluate(() =>
          [...document.querySelectorAll('[class*="cover"]')]
            .filter((el) => el.getBoundingClientRect().width > 0)
            .map((el) => ({
              tag: el.tagName,
              id: el.id,
              class: el.className,
              hasImage: !!el.querySelector("img"),
              background: !!(el as HTMLElement).style.backgroundImage,
            }))
            .slice(0, 30),
        ),
      ),
    );
  if (command.step === "upload-cover") {
    await page
      .locator('input[type=file][accept*="image/bmp"]')
      .setInputFiles("apps/desktop/src-tauri/icons/icon.png");
  }
  if (command.step === "dialog")
    console.log(
      JSON.stringify({
        text: (await page.locator("body").innerText()).slice(-2300),
      }),
    );
  if (command.step === "cover-library")
    await page.getByRole("link", { name: "从图片库选择", exact: true }).click();
  if (command.step === "cover-menu") {
    await page.getByText("拖拽或选择封面", { exact: true }).click();
    console.log(
      JSON.stringify({
        text: (await page.locator("body").innerText()).slice(-1800),
      }),
    );
  }
  if (command.step === "files") {
    console.log(
      JSON.stringify(
        await page
          .locator("input[type=file]")
          .evaluateAll((els) =>
            els.map((el) => ({
              html: el.outerHTML,
              parent: el.parentElement?.outerHTML.slice(0, 1800),
            })),
          ),
      ),
    );
  }
  if (command.step === "verify-adapter") {
    const { saveWechatDraft, wechatDraftUrl } = await import(
      `../packages/publisher-engine/src/platforms/wechat/draft.ts?revision=${Date.now()}`
    );
    const id = new URL(page.url()).searchParams.get("appmsgid");
    if (!id) throw new Error("请保留测试草稿编辑页");
    const title = await page
      .locator(".title-editor__input .ProseMirror")
      .innerText();
    if (!title.startsWith("TurboPushForked ")) throw new Error("仅测试草稿");
    const result = await saveWechatDraft(
      context,
      {
        type: "article",
        title,
        body: await page
          .locator(".rich_media_content .ProseMirror")
          .innerText(),
        images: [],
        author: await page.locator("#author").inputValue(),
        summary: await page.locator("#js_description").inputValue(),
      },
      { draftUrl: wechatDraftUrl(id), checkpoint: () => {} },
    );
    console.log(JSON.stringify(result));
  }
  if (command.step === "readback") {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".title-editor__input .ProseMirror").waitFor();
    console.log(
      JSON.stringify({
        route: await page.evaluate(() => {
          const u = new URL(location.href);
          return {
            path: u.pathname,
            params: Object.fromEntries(
              [...u.searchParams].filter(([k]) =>
                ["t", "action", "type", "appmsgid", "isMul", "isNew"].includes(
                  k,
                ),
              ),
            ),
          };
        }),
        title: await page
          .locator(".title-editor__input .ProseMirror")
          .innerText(),
        body: await page
          .locator(".rich_media_content .ProseMirror")
          .innerText(),
        author: await page.locator("#author").inputValue(),
        summary: await page.locator("#js_description").inputValue(),
      }),
    );
  }
  if (command.step === "structure") {
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          editors: [...document.querySelectorAll(".ProseMirror")].map((el) => ({
            editable: el.getAttribute("contenteditable"),
            parent: el.parentElement?.id,
            parentClass: el.parentElement?.className,
            visible: el.getBoundingClientRect().width > 0,
          })),
          cover: [...document.querySelectorAll("input[type=file]")].map(
            (el) => ({ id: el.id, accept: el.getAttribute("accept") }),
          ),
          urlKeys: [...new URL(location.href).searchParams.keys()],
        })),
      ),
    );
  }
  if (command.step === "fill") {
    if (await page.locator("#title").inputValue())
      throw new Error("拒绝覆盖非空草稿");
    await page
      .locator(".title-editor__input .ProseMirror")
      .fill("TurboPushForked 公众号开发验证草稿");
    await page.locator("#author").fill("开发验证");
    await page
      .locator('.ProseMirror[contenteditable="true"]')
      .last()
      .fill(
        "这是一篇 TurboPushForked 开发验证草稿。\n\n仅验证标题、正文、作者、摘要和保存回读，不公开发布、不群发。",
      );
    await page
      .locator("#js_description")
      .fill("开发测试草稿，仅用于验证，不公开发布。");
  }
  if (command.step === "save") {
    if (
      !(await page.locator("#title").inputValue()).startsWith(
        "TurboPushForked ",
      )
    )
      throw new Error("仅允许测试草稿");
    const listener = async (response: import("playwright").Response) => {
      const u = new URL(response.url());
      if (
        u.hostname !== "mp.weixin.qq.com" ||
        response.request().method() !== "POST"
      )
        return;
      let data: Record<string, unknown> = {};
      try {
        const json = await response.json();
        data = {
          keys: Object.keys(json),
          ret: json.base_resp?.ret,
          appMsgId: json.appMsgId ?? json.appmsgid,
        };
      } catch {}
      console.log(
        JSON.stringify({
          path: u.pathname,
          status: response.status(),
          ...data,
        }),
      );
    };
    page.on("response", listener);
    await page.getByText("保存为草稿", { exact: true }).click();
    setTimeout(() => page.off("response", listener), 15000).unref();
  }
  if (command.step === "editor") {
    const opened = context
      .waitForEvent("page", { timeout: 10000 })
      .catch(() => null);
    await page.getByText("文章", { exact: true }).click();
    const editor = await opened;
    await editor?.waitForLoadState("domcontentloaded");
  }
  if (!command.step || command.step === "inspect") {
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          text: document.body.innerText.slice(0, 2200),
          editors: [
            ...document.querySelectorAll(
              "input,textarea,[contenteditable],iframe",
            ),
          ].map((el) => ({
            tag: el.tagName,
            id: el.id,
            class: el.className,
            placeholder: el.getAttribute("placeholder"),
          })),
        })),
      ),
    );
  }
}

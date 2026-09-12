import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Service } from "../packages/publisher-engine/src/service.ts";
import { detectPlatformLogin } from "../packages/publisher-engine/src/platforms/login-status.ts";

const command = process.argv[2] ?? "inspect";
if (!["login", "inspect", "structure", "publish-structure", "gallery-structure", "upload-structure", "save-probe", "verify-save-probe", "login-status", "screenshot", "close"].includes(command))
  throw new Error(
    "用法: tsx scripts/xiaohongshu-spike.ts login|inspect|structure|publish-structure|gallery-structure|upload-structure|save-probe|verify-save-probe|login-status|screenshot|close",
  );

// Never print arbitrary page text or attributes: creator pages can contain
// nicknames, draft titles and account metadata. Only these product-control
// labels are allowed to leave the process.
const safeControlLabels = [
  "发布笔记",
  "上传图文",
  "上传视频",
  "上传图片",
  "选择图片",
  "标题",
  "正文",
  "添加话题",
  "话题",
  "存草稿",
  "保存草稿",
  "暂存离开",
  "保存并退出",
  "发布",
] as const;

function safePageLocation(raw: string) {
  const url = new URL(raw);
  return { origin: url.origin, pathname: url.pathname };
}

async function inViewportText(page: import("playwright").Page, text: string) {
  const candidates = page.getByText(text, { exact: true });
  const viewport = page.viewportSize();
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    const box = await candidate.boundingBox();
    if (
      box &&
      box.width > 0 &&
      box.height > 0 &&
      (!viewport ||
        (box.x < viewport.width &&
          box.y < viewport.height &&
          box.x + box.width > 0 &&
          box.y + box.height > 0))
    )
      return candidate;
  }
  throw new Error(`未找到视口内控件：${text}`);
}

const service = new Service(resolve(process.env.TURBOPUSH_DATA_DIR ?? ".data"));
try {
  const requestedId = process.env.TURBOPUSH_ACCOUNT_ID;
  const account = service.store
    .accounts()
    .find(
      (item) =>
        item.platform === "xiaohongshu" &&
        (!requestedId || item.id === requestedId),
    );
  if (!account) throw new Error("未找到小红书账号，请先在桌面端创建账号");

  if (command === "close") {
    await service.browsers.close(account.id);
    console.log(JSON.stringify({ closed: true }));
  } else {
    const context = await service.browsers.open(account);
    const page = context.pages()[0] ?? (await context.newPage());
    if (command === "login") {
      await page.goto("https://creator.xiaohongshu.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      console.log("小红书独立登录窗口已打开。完成扫码后，请在此终端按回车结束。");
      const input = createInterface({ input: process.stdin, output: process.stdout });
      await input.question("");
      input.close();
    } else if (command === "verify-save-probe") {
      const expectedTitle = "TurboPush 小红书草稿验证 20260910";
      await page.goto("https://creator.xiaohongshu.com/new/home", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page.waitForTimeout(6_000);
      const navigationLabels = ["笔记管理", "内容管理", "草稿箱"];
      let usedNavigation = "";
      for (const label of navigationLabels) {
        const navigation = page.getByText(label, { exact: true });
        if ((await navigation.count()) !== 1 || !(await navigation.isVisible())) continue;
        await navigation.click();
        usedNavigation = label;
        await page.waitForTimeout(5_000);
        break;
      }
      if (usedNavigation && !usedNavigation.includes("草稿")) {
        for (const label of ["草稿", "草稿箱"]) {
          const draftTab = page.getByText(label, { exact: true });
          const count = await draftTab.count();
          let visibleIndex = -1;
          for (let index = 0; index < count; index += 1) {
            if (await draftTab.nth(index).isVisible()) {
              if (visibleIndex !== -1) {
                visibleIndex = -2;
                break;
              }
              visibleIndex = index;
            }
          }
          if (visibleIndex < 0) continue;
          await draftTab.nth(visibleIndex).click();
          usedNavigation += `>${label}`;
          await page.waitForTimeout(5_000);
          break;
        }
      }
      const titleMatches = await page.getByText(expectedTitle, { exact: true }).count();
      let finalTitleMatches = titleMatches;
      let titleMatchNodes: Array<Record<string, unknown>> = [];
      let titleReadbackMatches = false;
      let bodyReadbackMatches = false;
      let twoImageSignal = false;
      if (finalTitleMatches === 0) {
        await page.goto("https://creator.xiaohongshu.com/publish/publish", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page.waitForTimeout(4_000);
        const draftEntries = page.getByText(/草稿箱/);
        const draftEntryCount = await draftEntries.count();
        for (let index = 0; index < draftEntryCount; index += 1) {
          if (!(await draftEntries.nth(index).isVisible())) continue;
          await draftEntries.nth(index).click();
          usedNavigation += ">发布页草稿箱";
          await page.waitForTimeout(5_000);
          break;
        }
        const galleryDraftTab = page.getByText(/^图文笔记\(\d+\)$/);
        const galleryDraftTabCount = await galleryDraftTab.count();
        for (let index = 0; index < galleryDraftTabCount; index += 1) {
          if (!(await galleryDraftTab.nth(index).isVisible())) continue;
          await galleryDraftTab.nth(index).click();
          usedNavigation += ">图文笔记";
          await page.waitForTimeout(5_000);
          break;
        }
        finalTitleMatches = await page.getByText(expectedTitle, { exact: true }).count();
        titleMatchNodes = await page.getByText(expectedTitle, { exact: true }).evaluateAll((nodes) =>
          nodes.map((node) => ({
            tag: node.tagName.toLowerCase(),
            className:
              typeof (node as HTMLElement).className === "string"
                ? (node as HTMLElement).className.slice(0, 120)
                : "",
            visible: Boolean(
              (node as HTMLElement).offsetWidth || (node as HTMLElement).offsetHeight,
            ),
          })),
        );
        if (finalTitleMatches > 0) {
          const titleNode = page.getByText(expectedTitle, { exact: true }).first();
          const editAction = titleNode.locator(
            "xpath=ancestor::*[.//*[normalize-space(text())='编辑']][1]//*[normalize-space(text())='编辑']",
          ).first();
          await editAction.waitFor({ state: "visible", timeout: 10_000 });
          await editAction.click();
          usedNavigation += ">打开首条草稿";
          await page.waitForTimeout(6_000);
        }
        const expectedBody = "TurboPush 开发验证草稿，仅用于自动化适配验收，不公开发布。";
        const editorTitle = page.locator('input[type="text"][placeholder*="标题"]').first();
        const editorBody = page.locator('[role="textbox"][contenteditable="true"]').first();
        titleReadbackMatches =
          (await editorTitle.count()) > 0 && (await editorTitle.inputValue()) === expectedTitle;
        bodyReadbackMatches =
          (await editorBody.count()) > 0 &&
          (await editorBody.innerText()).replace(/\s+/g, " ").trim() === expectedBody;
        twoImageSignal = (await page.getByText(/2\/18/).count()) > 0;
      }
      const candidateRoutes = await page.locator("a[href]").evaluateAll((nodes) => {
        const routes: Array<{ pathname: string; knownLabel: string }> = [];
        for (const node of nodes) {
          const href = (node as HTMLAnchorElement).href;
          let url: URL;
          try { url = new URL(href); } catch { continue; }
          if (url.origin !== "https://creator.xiaohongshu.com") continue;
          const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
          const knownLabel = /草稿/.test(text) ? "草稿" : /笔记管理/.test(text) ? "笔记管理" : "";
          if (knownLabel || /draft|note|manage/i.test(url.pathname))
            routes.push({ pathname: url.pathname, knownLabel });
        }
        return routes.slice(0, 30);
      });
      if (finalTitleMatches === 0)
        await page.screenshot({
          path: resolve(
            process.env.TURBOPUSH_DATA_DIR ?? ".data",
            "diagnostics",
            "xiaohongshu-note-manager.png",
          ),
          fullPage: true,
        });
      if (finalTitleMatches > 0 && (!titleReadbackMatches || !bodyReadbackMatches))
        await page.screenshot({
          path: resolve(
            process.env.TURBOPUSH_DATA_DIR ?? ".data",
            "diagnostics",
            "xiaohongshu-draft-open.png",
          ),
          fullPage: true,
        });
      console.log(JSON.stringify({
        location: safePageLocation(page.url()),
        expectedTitleFound: finalTitleMatches > 0,
        exactTitleMatchCount: finalTitleMatches,
        usedNavigation,
        candidateRoutes,
        titleMatchNodes,
        readback: {
          titleMatches: titleReadbackMatches,
          bodyMatches: bodyReadbackMatches,
          twoImageSignal,
        },
      }));
    } else if (["structure", "publish-structure", "gallery-structure", "upload-structure", "save-probe"].includes(command)) {
      await page.goto("https://creator.xiaohongshu.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page.waitForTimeout(5_000);
      if (command === "publish-structure" || command === "gallery-structure" || command === "upload-structure" || command === "save-probe") {
        const entry = page.getByText("发布笔记", { exact: true }).first();
        await entry.waitFor({ state: "visible", timeout: 15_000 });
        await entry.click();
        await page.waitForTimeout(3_000);
      }
      if (command === "gallery-structure" || command === "upload-structure" || command === "save-probe") {
        const gallery = await inViewportText(page, "上传图文");
        // This tab is rendered inside a horizontally translated carousel. Its
        // DOM box can be inside the viewport while Playwright's actionability
        // check still treats the transformed child as offscreen. A DOM click
        // only switches the local editor mode; it does not upload or submit.
        await gallery.evaluate((element) => (element as HTMLElement).click());
        await page.waitForTimeout(2_000);
      }
      if (command === "upload-structure" || command === "save-probe") {
        const fixtureDirectory = await mkdtemp(join(tmpdir(), "turbopush-xhs-probe-"));
        try {
          const pixel = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "base64",
          );
          const first = join(fixtureDirectory, "probe-a.png");
          const second = join(fixtureDirectory, "probe-b.png");
          await writeFile(first, pixel);
          await writeFile(second, Buffer.concat([pixel, Buffer.from([0])]));
          const input = page.locator("input[type='file'][multiple]").first();
          await input.setInputFiles([first, second]);
          await page.waitForTimeout(10_000);
        } finally {
          await rm(fixtureDirectory, { recursive: true, force: true });
        }
      }
      if (command === "save-probe") {
        const titleValue = "TurboPush 小红书草稿验证 20260910";
        const bodyValue = "TurboPush 开发验证草稿，仅用于自动化适配验收，不公开发布。";
        const title = page.locator('input[type="text"][placeholder*="标题"]').first();
        const body = page.locator('[role="textbox"][contenteditable="true"]').first();
        await title.fill(titleValue);
        await body.fill(bodyValue);

        const draftAction = "暂存离开";
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await page.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            for (const element of document.querySelectorAll<HTMLElement>("*")) {
              if (element.scrollHeight > element.clientHeight + 100)
                element.scrollTop = element.scrollHeight;
            }
          });
          await page.waitForTimeout(700);
        }
        const candidateCount = await page.evaluate((expected) => {
          let count = 0;
          for (const node of document.querySelectorAll<HTMLElement>("*")) {
            const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
            if (text !== expected || !(node.offsetWidth || node.offsetHeight)) continue;
            let childHasSameText = false;
            for (const child of node.children) {
              const childText = (child.textContent ?? "").replace(/\s+/g, " ").trim();
              if (childText === expected) childHasSameText = true;
            }
            if (!childHasSameText) count += 1;
          }
          return count;
        }, draftAction);
        const viewport = await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }));
        const coordinateDraftPoint = {
          x: Math.round(viewport.width * 0.43),
          y: viewport.height - 45,
        };
        const coordinateHostTag = await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase() ?? "",
          coordinateDraftPoint,
        );
        const coordinateFallbackConfirmed =
          candidateCount === 0 && coordinateHostTag === "xhs-publish-btn";
        if (candidateCount !== 1 && !coordinateFallbackConfirmed) {
          const pointStacks = await page.evaluate(() => {
            const points = [
              { name: "draft", x: window.innerWidth * 0.43, y: window.innerHeight - 45 },
              { name: "publish", x: window.innerWidth * 0.54, y: window.innerHeight - 45 },
            ];
            const result: Array<{ name: string; nodes: Array<Record<string, string>> }> = [];
            for (const point of points) {
              const nodes: Array<Record<string, string>> = [];
              for (const node of document.elementsFromPoint(point.x, point.y).slice(0, 8)) {
                nodes.push({
                  tag: node.tagName.toLowerCase(),
                  className:
                    typeof (node as HTMLElement).className === "string"
                      ? (node as HTMLElement).className.slice(0, 120)
                      : "",
                  role: node.getAttribute("role") ?? "",
                  ariaLabel: node.getAttribute("aria-label") ?? "",
                  text: (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 20),
                });
              }
              result.push({ name: point.name, nodes });
            }
            return result;
          });
          const shadowControls = await page.evaluate(() => {
            const result: Array<Record<string, unknown>> = [];
            for (const host of document.querySelectorAll<HTMLElement>("xhs-publish-btn")) {
              const root = host.shadowRoot;
              result.push({
                hasOpenShadowRoot: Boolean(root),
                controls: root
                  ? [...root.querySelectorAll<HTMLElement>("button,[role='button'],div")]
                      .filter((node) => node.offsetWidth || node.offsetHeight)
                      .slice(0, 20)
                      .map((node) => ({
                        tag: node.tagName.toLowerCase(),
                        className: node.className.slice(0, 120),
                        role: node.getAttribute("role") ?? "",
                        text: (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30),
                      }))
                  : [],
              });
            }
            return result;
          });
          const screenshotPath = resolve(
            process.env.TURBOPUSH_DATA_DIR ?? ".data",
            "diagnostics",
            "xiaohongshu-editor-actions.png",
          );
          await page.screenshot({
            path: screenshotPath,
            fullPage: true,
          });
          throw new Error(
            `草稿保存控件未唯一确认（精确可见叶子候选数=${candidateCount}，元素栈=${JSON.stringify(pointStacks)}，Shadow控件=${JSON.stringify(shadowControls)}，已截取完整页面），未执行点击`,
          );
        }

        const writes: Array<{ method: string; pathname: string; status: number }> = [];
        page.on("response", (response) => {
          const request = response.request();
          if (!["POST", "PUT", "PATCH"].includes(request.method())) return;
          const url = new URL(response.url());
          if (url.origin !== "https://creator.xiaohongshu.com") return;
          writes.push({ method: request.method(), pathname: url.pathname, status: response.status() });
        });
        if (coordinateFallbackConfirmed) {
          await page.mouse.click(coordinateDraftPoint.x, coordinateDraftPoint.y);
        } else {
          await page.evaluate((expected) => {
            let candidate: HTMLElement | null = null;
            let count = 0;
            for (const node of document.querySelectorAll<HTMLElement>("*")) {
              const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
              if (text !== expected || !(node.offsetWidth || node.offsetHeight)) continue;
              let childHasSameText = false;
              for (const child of node.children) {
                const childText = (child.textContent ?? "").replace(/\s+/g, " ").trim();
                if (childText === expected) childHasSameText = true;
              }
              if (!childHasSameText) {
                candidate = node;
                count += 1;
              }
            }
            if (count !== 1 || !candidate)
              throw new Error("草稿控件数量在点击前发生变化");
            candidate.click();
          }, draftAction);
        }
        await page.waitForTimeout(6_000);
        console.log(
          JSON.stringify({
            draftAction,
            location: safePageLocation(page.url()),
            writes,
            expected: { title: titleValue, body: bodyValue, imageCount: 2 },
            publicPublishClicked: false,
            clickMode: coordinateFallbackConfirmed ? "verified-left-coordinate" : "exact-text",
          }),
        );
      } else {
        const rawControls = await page
        .locator("button,input,textarea,[contenteditable='true'],[role='button'],[role='textbox'],[role='tab']")
        .evaluateAll((nodes) =>
          nodes.slice(0, 160).map((node, ordinal) => {
            const input = node instanceof HTMLInputElement ? node : null;
            return {
              ordinal,
              tag: node.tagName.toLowerCase(),
              role: node.getAttribute("role") ?? "",
              type: input?.type ?? "",
              text: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
              ariaLabel: node.getAttribute("aria-label") ?? "",
              placeholder: node.getAttribute("placeholder") ?? "",
              contenteditable: node.getAttribute("contenteditable") === "true",
              disabled:
                ("disabled" in node && Boolean((node as HTMLButtonElement).disabled)) ||
                node.getAttribute("aria-disabled") === "true",
              visible: Boolean(
                (node as HTMLElement).offsetWidth || (node as HTMLElement).offsetHeight,
              ),
              accept: input?.accept ?? "",
              multiple: input?.multiple ?? false,
            };
          }),
        );
        const controls = rawControls.map(({ text, ariaLabel, placeholder, ...control }) => {
          const haystack = `${text} ${ariaLabel} ${placeholder}`;
          const knownLabel = safeControlLabels.find((label) => haystack.includes(label)) ?? null;
          return { ...control, knownLabel };
        });
        console.log(
          JSON.stringify({
            page: safePageLocation(page.url()),
            frames: page.frames().map((frame) => safePageLocation(frame.url())),
            controls,
            knownControlCounts: Object.fromEntries(
              safeControlLabels.map((label) => [
                label,
                controls.filter((control) => control.knownLabel === label).length,
              ]),
            ),
            note: "严格脱敏结构：不输出页面正文、标题、昵称、账号ID、任意属性值、query、Cookie、token、请求头或请求体",
          }),
        );
      }
    } else if (command === "login-status") {
      const checked = await detectPlatformLogin(page, account.platform);
      console.log(JSON.stringify(checked));
    } else if (command === "screenshot") {
      const screenshot = await service.browsers.capture(account.id);
      console.log(JSON.stringify({ captured: Boolean(screenshot.file) }));
    } else {
      console.log(
        JSON.stringify({
          platform: account.platform,
          page: safePageLocation(page.url()),
          note: "严格脱敏只读探测；未输出正文、昵称或账号信息，未读取Cookie、token或请求头，未点击发布",
        }),
      );
    }
  }
} finally {
  await service.close();
}

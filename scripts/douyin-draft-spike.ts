import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Service } from "../packages/publisher-engine/src/service.ts";
import { parseDouyinSpikeConfig } from "./douyin-draft-spike-policy.ts";

const { accountId, video, mode, uploadsVideo } = parseDouyinSpikeConfig(
  process.env,
);

const service = new Service(resolve(process.env.TURBOPUSH_DATA_DIR ?? ".data"));
try {
  const account = service.store.account(accountId);
  if (account.platform !== "douyin") throw new Error("账号不是抖音账号");
  const context = await service.browsers.open(account);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://creator.douyin.com/creator-micro/content/upload", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const input = page.locator("input[type='file']");
  await input.first().waitFor({ state: "attached", timeout: 20_000 });
  if ((await input.count()) !== 1) throw new Error("未找到唯一视频输入框");
  if (uploadsVideo) {
    await input.setInputFiles(resolve(video!));
    await page.waitForTimeout(8_000);
    const uploaded = new URL(page.url());
    if (
      uploaded.protocol !== "https:" ||
      uploaded.hostname !== "creator.douyin.com" ||
      uploaded.pathname !== "/creator-micro/content/post/video" ||
      uploaded.username ||
      uploaded.password ||
      uploaded.hash
    )
      throw new Error(
        `上传后地址尚未受信：${JSON.stringify({ origin: uploaded.origin, pathname: uploaded.pathname, hasSearch: Boolean(uploaded.search), hasHash: Boolean(uploaded.hash) })}`,
      );
  }
  const url = new URL(page.url());

  if (mode === "fill-structure") {
    await page
      .locator('input[type="text"][placeholder*="作品标题"]')
      .fill("TurboPush 抖音草稿验证 20260911");
    const body = page.locator('[contenteditable="true"]').first();
    await body.waitFor({ state: "visible", timeout: 20_000 });
    await body.fill(
      "TurboPush 开发验证草稿，仅用于自动化适配验收，不公开发布。",
    );
    const privateOption = page.getByText("仅自己可见", { exact: true });
    if ((await privateOption.count()) !== 1)
      throw new Error("未找到唯一的仅自己可见选项");
    const privateLabel = privateOption.locator("xpath=ancestor::label[1]");
    if ((await privateLabel.count()) !== 1)
      throw new Error("仅自己可见选项缺少唯一可点击标签");
    await privateLabel.click();
    await page.waitForTimeout(1_000);
    if ((await privateLabel.getAttribute("data-checked")) !== "true")
      throw new Error("仅自己可见选项未确认生效，拒绝保存");
  }

  let saveResult:
    | {
        pathname: string;
        titleMatches: boolean;
        bodyMatches: boolean;
        privateChecked: boolean;
        persistedAfterReadback: boolean;
      }
    | undefined;
  if (mode === "save") {
    await page
      .locator('input[type="text"][placeholder*="作品标题"]')
      .fill("TurboPush 抖音草稿验证 20260911");
    const body = page.locator('[contenteditable="true"]').first();
    await body.waitFor({ state: "visible", timeout: 20_000 });
    await body.fill(
      "TurboPush 开发验证草稿，仅用于自动化适配验收，不公开发布。",
    );
    const privateOption = page.getByText("仅自己可见", { exact: true });
    const privateLabel = privateOption.locator("xpath=ancestor::label[1]");
    if (
      (await privateOption.count()) !== 1 ||
      (await privateLabel.count()) !== 1
    )
      throw new Error("无法唯一确认仅自己可见选项，拒绝保存");
    await privateLabel.click();
    await page.waitForTimeout(500);
    if ((await privateLabel.getAttribute("data-checked")) !== "true")
      throw new Error("仅自己可见选项未确认生效，拒绝保存");
    const publish = page.getByRole("button", { name: "发布", exact: true });
    const draft = page.getByRole("button", { name: "暂存离开", exact: true });
    if ((await publish.count()) !== 1 || (await draft.count()) !== 1)
      throw new Error("发布/暂存按钮边界不唯一，拒绝点击");
    await draft.click();
    const resume = page.getByText("继续编辑", { exact: true });
    await resume.waitFor({ state: "visible", timeout: 20_000 });
    if ((await resume.count()) !== 1)
      throw new Error("暂存后未出现唯一的继续编辑入口");
    await resume.click();
    await page
      .locator('input[type="text"][placeholder*="作品标题"]')
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1_000);
    const after = new URL(page.url());
    if (
      after.origin !== "https://creator.douyin.com" ||
      after.pathname !== "/creator-micro/content/post/video" ||
      after.username ||
      after.password ||
      after.hash
    )
      throw new Error("暂存后离开可信抖音创作平台");
    const normalize = (value: string) =>
      value
        .replace(/[\u200b\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const resumedPrivateLabel = page
      .getByText("仅自己可见", { exact: true })
      .locator("xpath=ancestor::label[1]");
    const resumedEditors = await page
      .locator('[contenteditable="true"]')
      .allInnerTexts();
    const titleMatches =
      (await page
        .locator('input[type="text"][placeholder*="作品标题"]')
        .inputValue()) === "TurboPush 抖音草稿验证 20260911";
    const bodyMatches = resumedEditors.some(
      (value) =>
        normalize(value) ===
        "TurboPush 开发验证草稿，仅用于自动化适配验收，不公开发布。",
    );
    const privateChecked =
      (await resumedPrivateLabel.getAttribute("data-checked")) === "true";
    if (!titleMatches || !bodyMatches || !privateChecked)
      throw new Error("暂存后逐字段回读不一致，拒绝报告成功");
    const finalDraft = page.getByRole("button", {
      name: "暂存离开",
      exact: true,
    });
    if ((await finalDraft.count()) !== 1)
      throw new Error("回读后无法唯一确认暂存离开按钮");
    await finalDraft.click();
    const finalResume = page.getByText("继续编辑", { exact: true });
    await finalResume.waitFor({ state: "visible", timeout: 20_000 });
    saveResult = {
      pathname: after.pathname,
      titleMatches,
      bodyMatches,
      privateChecked,
      persistedAfterReadback: (await finalResume.count()) === 1,
    };
  }

  const controls = await page
    .locator(
      "input,textarea,button,[role='button'],[role='textbox'],[contenteditable='true']",
    )
    .evaluateAll((nodes) =>
      nodes.slice(0, 160).map((node, ordinal) => ({
        ordinal,
        tag: node.tagName.toLowerCase(),
        type: node instanceof HTMLInputElement ? node.type : "",
        placeholder: node.getAttribute("placeholder") ?? "",
        ariaLabel: node.getAttribute("aria-label") ?? "",
        knownLabel: /保存草稿|暂存/.test(node.textContent ?? "")
          ? "draft"
          : /^\s*发布\s*$/.test(node.textContent ?? "")
            ? "publish"
            : null,
        visible: Boolean(
          (node as HTMLElement).offsetWidth ||
          (node as HTMLElement).offsetHeight,
        ),
      })),
    );
  await mkdir(resolve(".data/screenshots"), { recursive: true });
  await page.screenshot({
    path: resolve(".data/screenshots/douyin-upload-structure.png"),
    fullPage: false,
  });
  console.log(
    JSON.stringify({
      page: { pathname: url.pathname },
      controls,
      publicPublishClicked: false,
      draftButtons: await page
        .locator("button")
        .filter({ hasText: /保存草稿|暂存/ })
        .allTextContents(),
      publishButtonCount: await page
        .getByRole("button", { name: "发布", exact: true })
        .count(),
      mode,
      saveResult,
      note:
        mode === "save"
          ? "已点击唯一的暂存离开按钮；未点击发布"
          : mode === "fill-structure"
            ? "已获授权上传并填写测试内容、选择仅自己可见；未保存、未点击发布"
            : mode === "upload-structure"
              ? "已获授权上传测试视频；未填写、未保存、未点击发布"
              : "只读上传页结构；未选择文件、未填写、未保存、未点击发布",
    }),
  );
} finally {
  await service.close();
}

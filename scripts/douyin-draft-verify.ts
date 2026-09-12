import { resolve } from "node:path";
import { Service } from "../packages/publisher-engine/src/service.ts";
import { parseDouyinVerifyConfig } from "./douyin-draft-verify-policy.ts";

const { accountId, expectedTitle, expectedBody } = parseDouyinVerifyConfig(
  process.env,
);
const service = new Service(resolve(process.env.TURBOPUSH_DATA_DIR ?? ".data"));
try {
  const account = service.store.account(accountId);
  if (account.platform !== "douyin") throw new Error("指定账号不是抖音账号");
  const context = await service.browsers.open(account);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://creator.douyin.com/creator-micro/content/upload", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const resume = page.getByText("继续编辑", { exact: true });
  await resume.waitFor({ state: "visible", timeout: 20_000 });
  if ((await resume.count()) !== 1) throw new Error("未发布视频入口不唯一");
  await resume.click();
  let observation: object;
  try {
    const title = page.locator('input[type="text"][placeholder*="作品标题"]');
    await title.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1_000);
    const url = new URL(page.url());
    if (
      url.origin !== "https://creator.douyin.com" ||
      url.pathname !== "/creator-micro/content/post/video" ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("未发布视频编辑页地址不受信");
    const normalize = (value: string) =>
      value
        .replace(/[\u200b\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const editors = await page
      .locator('[contenteditable="true"]')
      .allInnerTexts();
    const privateLabel = page
      .getByText("仅自己可见", { exact: true })
      .locator("xpath=ancestor::label[1]");
    observation = {
      page: { pathname: url.pathname },
      titleMatches: (await title.inputValue()) === expectedTitle,
      editors: editors.map((value, index) => ({
        index,
        length: normalize(value).length,
        bodyMatches: normalize(value) === expectedBody,
      })),
      privateChecked:
        (await privateLabel.getAttribute("data-checked")) === "true",
      publicPublishClicked: false,
    };
  } finally {
    const publish = page.getByRole("button", { name: "发布", exact: true });
    const draft = page.getByRole("button", { name: "暂存离开", exact: true });
    if ((await publish.count()) !== 1 || (await draft.count()) !== 1)
      throw new Error(
        "回验已进入草稿，但发布/暂存边界不唯一；无法安全恢复，远端状态未知",
      );
    await draft.click();
    const restored = page.getByText("继续编辑", { exact: true });
    await restored.waitFor({ state: "visible", timeout: 20_000 });
    if ((await restored.count()) !== 1)
      throw new Error("回验后重新暂存确认失败；远端草稿状态未知");
  }
  console.log(JSON.stringify({ ...observation, restoredAfterReadback: true }));
} finally {
  await service.close();
}

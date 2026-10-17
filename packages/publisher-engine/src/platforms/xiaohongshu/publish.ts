import type { BrowserContext, Page, Response } from "playwright";
import type { Task } from "@turbopush/shared";
import {
  imagePayload,
  fingerprintImageBuffer,
  fingerprintsMatch,
} from "../wechat/media.ts";
import {
  xiaohongshuGallerySelectors,
  validateXiaohongshuPublishUrl,
} from "./draft.ts";
import { validateXiaohongshuGallery } from "./schema.ts";
import { xiaohongshuActionPoint } from "./actions.ts";

export function validateXiaohongshuPublishedUrl(value: string) {
  const url = new URL(value);
  if (
    url.origin !== "https://www.xiaohongshu.com" ||
    url.username ||
    url.password ||
    !/^\/(?:explore|discovery\/item)\/[a-f0-9]{24}$/.test(url.pathname)
  )
    throw new Error("无效的小红书公开笔记链接");
  for (const key of url.searchParams.keys())
    if (!["xsec_token", "xsec_source"].includes(key))
      throw new Error("小红书结果链接包含非公开分享参数");
  url.hash = "";
  return url.href;
}

export function xiaohongshuPublishedId(json: unknown): string {
  if (!json || typeof json !== "object") throw new Error("小红书发布响应无效");
  const value = json as {
    code?: unknown;
    success?: unknown;
    data?: { id?: unknown; note_id?: unknown; noteId?: unknown };
    note_id?: unknown;
  };
  if (value.code !== 0 || value.success === false)
    throw new Error("小红书未确认发布成功");
  const ids = [
    ...new Set(
      [
        value.data?.note_id,
        value.data?.noteId,
        value.data?.id,
        value.note_id,
      ].filter(
        (id): id is string =>
          typeof id === "string" && /^[a-f0-9]{24}$/.test(id),
      ),
    ),
  ];
  if (ids.length !== 1) throw new Error("小红书没有返回唯一笔记ID");
  return ids[0];
}

export async function verifyXiaohongshuImages(
  page: Page,
  paths: string[],
  selector: string,
  allowBlob: boolean,
) {
  const images = page.locator(selector);
  if ((await images.count()) !== paths.length)
    throw new Error("小红书图片数量与任务不一致");
  const expected = await Promise.all(
    paths.map(async (path) => {
      const image = await imagePayload(path);
      return fingerprintImageBuffer(page, image.buffer, image.mimeType);
    }),
  );
  for (const fingerprint of expected)
    if (
      expected.filter((candidate) => fingerprintsMatch(candidate, fingerprint))
        .length !== 1
    )
      throw new Error("小红书图片过于相似，无法唯一核对");
  let previous = "";
  for (let sample = 0; sample < 3; sample++) {
    const identities = [];
    if ((await images.count()) !== paths.length)
      throw new Error("小红书图片数量在回读期间变化");
    for (const [index, fingerprint] of expected.entries()) {
      const image = images.nth(index);
      await image.scrollIntoViewIfNeeded();
      await image.evaluate((element) => (element as HTMLImageElement).decode());
      const src = await image.evaluate(
        (element) =>
          (element as HTMLImageElement).currentSrc ||
          (element as HTMLImageElement).src,
      );
      let bytes: Buffer, mime: string;
      if (
        allowBlob &&
        src.startsWith("blob:https://creator.xiaohongshu.com/")
      ) {
        const payload = await page.evaluate(async (src) => {
          const response = await fetch(src);
          const blob = await response.blob();
          if (blob.size > 10 * 1024 * 1024) throw new Error("预览图片过大");
          const data = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < data.length; offset += 8192)
            binary += String.fromCharCode(
              ...data.subarray(offset, offset + 8192),
            );
          return { data: btoa(binary), mime: blob.type };
        }, src);
        bytes = Buffer.from(payload.data, "base64");
        mime = payload.mime;
      } else {
        const url = new URL(src);
        if (
          url.protocol !== "https:" ||
          !/\.(xiaohongshu\.com|xhscdn\.com|xhsimg\.com)$/.test(url.hostname) ||
          url.username ||
          url.password
        )
          throw new Error("小红书图片不是受信的远端资源");
        const response = await page
          .context()
          .request.get(src, { maxRedirects: 0, timeout: 15000 });
        if (
          !response.ok() ||
          Number(response.headers()["content-length"] ?? 0) > 10 * 1024 * 1024
        )
          throw new Error("小红书远端图片响应失败");
        bytes = await response.body();
        mime = response.headers()["content-type"]?.split(";")[0] ?? "";
      }
      if (
        !mime ||
        mime === "application/octet-stream" ||
        mime === "image/jpg"
      ) {
        if (
          bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          mime = "image/png";
        else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
          mime = "image/jpeg";
        else if (
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP"
        )
          mime = "image/webp";
      }
      if (
        !bytes.length ||
        bytes.length > 10 * 1024 * 1024 ||
        !["image/png", "image/jpeg", "image/webp", "image/avif"].includes(mime)
      )
        throw new Error("小红书图片大小或格式无效");
      const actual = await fingerprintImageBuffer(page, bytes, mime);
      const matches = expected.flatMap((candidate, position) =>
        fingerprintsMatch(candidate, actual) ? [position] : [],
      );
      if (
        matches.length !== 1 ||
        matches[0] !== index ||
        !fingerprintsMatch(fingerprint, actual)
      )
        throw new Error(`小红书第${index + 1}张图片内容或顺序不一致`);
      identities.push(`${actual.differenceHash}:${actual.averageRgb.join()}`);
    }
    const current = identities.join("|");
    if (sample && current !== previous) throw new Error("小红书图片回读未稳定");
    previous = current;
    if (sample < 2) await page.waitForTimeout(300);
  }
}

export async function verifyXiaohongshuPublishedPage(page: Page, task: Task) {
  validateXiaohongshuPublishedUrl(page.url());
  const title = page.locator("#detail-title");
  await title.waitFor({ timeout: 30000 });
  if ((await title.innerText()).trim() !== task.content.title)
    throw new Error("小红书公开页标题不一致");
  const body = page.locator("#detail-desc");
  await body.waitFor({ timeout: 30000 });
  const normalize = (value: string) => value.replace(/[\s\u200b\uFEFF]/g, "");
  if (normalize(await body.innerText()) !== normalize(task.content.body))
    throw new Error("小红书公开页正文不一致");
  await verifyXiaohongshuImages(
    page,
    task.content.images,
    ".swiper-slide:not(.swiper-slide-duplicate) img",
    false,
  );
}

export async function publishXiaohongshuGallery(
  page: Page,
  task: Task,
  markSubmitted: () => void,
  checkpoint: (url: string) => void,
) {
  await validateXiaohongshuGallery(task.content);
  validateXiaohongshuPublishUrl(page.url());
  if (
    (await page.locator(xiaohongshuGallerySelectors.title).inputValue()) !==
    task.content.title
  )
    throw new Error("小红书待发表标题已改变");
  const normalize = (value: string) => value.replace(/[\s\u200b\uFEFF]/g, "");
  if (
    normalize(
      await page.locator(xiaohongshuGallerySelectors.body).innerText(),
    ) !== normalize(task.content.body)
  )
    throw new Error("小红书待发表正文已改变");
  await verifyXiaohongshuImages(
    page,
    task.content.images,
    "img.img.preview",
    true,
  );
  const point = await xiaohongshuActionPoint(page, "发布");
  let listener: ((response: Response) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const published = new Promise<string>((resolve, reject) => {
    listener = (response) => {
      const url = new URL(response.url());
      if (
        !url.hostname.endsWith(".xiaohongshu.com") ||
        response.request().method() !== "POST" ||
        !/(?:^|\/)note(?:\/publish)?$/.test(url.pathname)
      )
        return;
      try {
        if (
          !JSON.stringify(response.request().postDataJSON()).includes(
            JSON.stringify(task.content.title),
          )
        )
          return;
      } catch {
        return;
      }
      void (async () => {
        if (
          !response.ok() ||
          Number(response.headers()["content-length"] ?? 0) > 1_000_000
        )
          throw new Error("小红书发布响应失败");
        const body = await response.body();
        if (body.length > 1_000_000) throw new Error("小红书发布响应过大");
        resolve(xiaohongshuPublishedId(JSON.parse(body.toString("utf8"))));
      })().catch(reject);
    };
    page.on("response", listener);
    timer = setTimeout(
      () => reject(new Error("小红书发布响应超时，请只读核对，禁止重复提交")),
      45000,
    );
  });
  void published.catch(() => undefined);
  try {
    markSubmitted();
    await page.mouse.click(point.x, point.y);
    let url: string;
    try {
      const id = await published;
      url = validateXiaohongshuPublishedUrl(
        `https://www.xiaohongshu.com/explore/${id}`,
      );
    } catch {
      await page.waitForURL(
        (value) =>
          value.origin === "https://creator.xiaohongshu.com" &&
          value.pathname === "/publish/success",
        { timeout: 10000 },
      );
      url = await findXiaohongshuPublication(page.context(), task);
    }
    checkpoint(url);
    const result = await page.context().newPage();
    await result.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await result.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await verifyXiaohongshuPublishedPage(result, task);
    return { url };
  } finally {
    if (listener) page.off("response", listener);
    if (timer) clearTimeout(timer);
  }
}

/** Locate an already submitted note through the account's own read-only management list. */
export async function findXiaohongshuPublication(
  context: BrowserContext,
  task: Task,
): Promise<string> {
  const page = await context.newPage();
  const ids = new Set<string>();
  const shareTokens = new Map<string, string>();
  const scan = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (Array.isArray(value)) {
      for (const entry of value) scan(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      record.title === task.content.title ||
      record.display_title === task.content.title
    ) {
      for (const key of ["note_id", "noteId", "id"]) {
        const id = record[key];
        if (typeof id === "string" && /^[a-f0-9]{24}$/.test(id)) {
          ids.add(id);
          const token = record.xsec_token;
          if (
            typeof token === "string" &&
            /^[a-zA-Z0-9_=+-]{1,512}$/.test(token)
          )
            shareTokens.set(id, token);
        }
      }
    }
    for (const entry of Object.values(record)) scan(entry, depth + 1);
  };
  const reads = new Set<Promise<void>>();
  const listener = (response: Response) => {
    const url = new URL(response.url());
    if (
      !url.hostname.endsWith(".xiaohongshu.com") ||
      response.request().method() !== "GET" ||
      !response.ok() ||
      !response.headers()["content-type"]?.includes("json")
    )
      return;
    const read = (async () => {
      if (Number(response.headers()["content-length"] ?? 0) > 2_000_000) return;
      const body = await response.body();
      if (body.length <= 2_000_000) scan(JSON.parse(body.toString("utf8")));
    })().catch(() => undefined);
    reads.add(read);
    void read.finally(() => reads.delete(read));
  };
  page.on("response", listener);
  try {
    await page.goto("https://creator.xiaohongshu.com/new/home", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.getByText("笔记管理", { exact: true }).click();
    await page
      .getByText(task.content.title, { exact: true })
      .waitFor({ timeout: 30000 });
    await Promise.all([...reads]);
    if (ids.size !== 1)
      throw new Error("笔记管理没有返回该标题唯一的笔记ID，请人工核对公开链接");
    const id = [...ids][0];
    const url = new URL(`https://www.xiaohongshu.com/explore/${id}`);
    if (shareTokens.has(id)) {
      url.searchParams.set("xsec_token", shareTokens.get(id)!);
      url.searchParams.set("xsec_source", "pc_creator");
    }
    return validateXiaohongshuPublishedUrl(url.href);
  } finally {
    page.off("response", listener);
  }
}

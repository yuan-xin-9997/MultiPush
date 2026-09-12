import { open, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { z } from "zod";
import type { Content } from "@turbopush/shared";

/** Local project limits only; not a claim about current Douyin platform limits. */
export const douyinVideoPolicy = {
  delivery: "draft_only",
  publicPublish: false,
  formats: [".mp4", ".mov"],
  maxVideoBytes: 1024 * 1024 * 1024,
} as const;

export const douyinVideoContent = z
  .object({
    type: z.literal("video"),
    title: z.string().trim().min(1),
    body: z.string(),
    bodyFormat: z.literal("plain").optional(),
    video: z.string().min(1),
    images: z.array(z.never()).max(0),
    cover: z.never().optional(),
    tags: z.array(z.string()),
  })
  .passthrough();

export async function validateDouyinVideo(content: Content) {
  const parsed = douyinVideoContent.parse(content);
  if (!isAbsolute(parsed.video))
    throw new Error("抖音视频必须使用本地绝对路径");
  const extension = extname(parsed.video).toLowerCase();
  if (!douyinVideoPolicy.formats.includes(extension as ".mp4" | ".mov"))
    throw new Error("抖音视频本地契约当前仅接受MP4/MOV");
  const file = await stat(parsed.video).catch(() => undefined);
  if (!file?.isFile())
    throw new Error("抖音视频素材不存在，或路径未指向真实本地文件");
  if (file.size <= 0 || file.size > douyinVideoPolicy.maxVideoBytes)
    throw new Error("抖音视频必须大于0且不超过本项目1GB安全上限");
  const handle = await open(parsed.video, "r");
  const header = Buffer.alloc(12);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 12 || header.toString("ascii", 4, 8) !== "ftyp")
      throw new Error("视频内容不是受支持的MP4/MOV文件签名");
    const brand = header.toString("ascii", 8, 12);
    const mov = brand === "qt  ";
    if ((extension === ".mov") !== mov)
      throw new Error("视频扩展名与MP4/MOV文件内容不一致");
  } finally {
    await handle.close();
  }
  return {
    content: parsed,
    video: { path: parsed.video, size: file.size, extension },
    message: "抖音视频本地检查通过；仅允许未来保存私有草稿，禁止公开发布",
  };
}

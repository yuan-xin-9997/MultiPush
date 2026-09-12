import { z } from "zod";
import { createHash } from "node:crypto";
import type { Content } from "@turbopush/shared";
import { imagePayload } from "../wechat/media.ts";

/**
 * Conservative limits chosen for TurboPush's first draft-only integration.
 * They are project safety limits, not claims about Xiaohongshu platform limits.
 */
export const xiaohongshuGalleryPolicy = {
  delivery: "draft_only",
  minImages: 2,
  maxImages: 18,
  maxTitleCharacters: 50,
  maxBodyCharacters: 3_000,
  maxTags: 10,
  maxTagCharacters: 20,
  maxImageBytes: 10 * 1024 * 1024,
  maxTotalImageBytes: 50 * 1024 * 1024,
  allowDuplicateImages: false,
} as const;

export const xiaohongshuGalleryContent = z
  .object({
    type: z.literal("gallery"),
    title: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => [...value].length <= xiaohongshuGalleryPolicy.maxTitleCharacters,
        "标题超过本项目首版50字安全上限",
      ),
    body: z
      .string()
      .refine(
        (value) => [...value].length <= xiaohongshuGalleryPolicy.maxBodyCharacters,
        "正文超过本项目首版3000字安全上限",
      ),
    bodyFormat: z.literal("plain").optional(),
    images: z
      .array(z.string().min(1))
      .min(xiaohongshuGalleryPolicy.minImages, "首版图文至少需要2张图片")
      .max(xiaohongshuGalleryPolicy.maxImages, "首版图文最多接受18张图片"),
    video: z.never().optional(),
    cover: z.never().optional(),
    tags: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine(
            (value) => [...value].length <= xiaohongshuGalleryPolicy.maxTagCharacters,
            "单个标签超过本项目首版20字安全上限",
          ),
      )
      .max(xiaohongshuGalleryPolicy.maxTags, "标签超过本项目首版10个安全上限"),
  })
  .passthrough()
  .superRefine((content, context) => {
    const normalized = content.tags.map((tag) => tag.toLocaleLowerCase());
    if (new Set(normalized).size !== normalized.length)
      context.addIssue({ code: "custom", path: ["tags"], message: "标签不能重复" });
  });

/** Validate every local asset before a caller is allowed to open a browser. */
export async function validateXiaohongshuGallery(content: Content) {
  const parsed = xiaohongshuGalleryContent.parse(content);
  const images: Awaited<ReturnType<typeof imagePayload>>[] = [];
  const hashes = new Set<string>();
  let totalBytes = 0;
  for (const [index, path] of parsed.images.entries()) {
    let payload: Awaited<ReturnType<typeof imagePayload>>;
    try {
      payload = await imagePayload(path);
    } catch (error) {
      throw new Error(
        `第${index + 1}张图片本地验证失败：${error instanceof Error ? error.message : "无法读取图片"}`,
        { cause: error },
      );
    }
    totalBytes += payload.buffer.length;
    if (totalBytes > xiaohongshuGalleryPolicy.maxTotalImageBytes)
      throw new Error("图片总大小超过本项目首版50MB安全上限");
    const hash = createHash("sha256").update(payload.buffer).digest("hex");
    if (hashes.has(hash)) throw new Error("图片内容不能重复，请保留每张唯一素材");
    hashes.add(hash);
    images.push(payload);
  }
  return {
    content: parsed,
    images,
    message: "小红书图文本地检查通过；首版仅允许保存草稿，不公开发布",
  };
}

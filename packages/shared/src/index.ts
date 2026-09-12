import { z } from "zod";

export const platformId = z.enum([
  "wechat-official",
  "zhihu",
  "xiaohongshu",
  "douyin",
  "bilibili",
  "wechat-channels",
  "toutiao",
  "baijiahao",
]);
export type PlatformId = z.infer<typeof platformId>;
export const contentType = z.enum(["article", "gallery", "video"]);
export type ContentType = z.infer<typeof contentType>;
// Enable only after the packaged adapter passes real draft save and read-back.
export const xiaohongshuGalleryDraftVerified = true;
// Enable only after a packaged Douyin adapter passes real draft save/read-back.
export const douyinVideoDraftVerified = true;
export interface Platform {
  id: PlatformId;
  name: string;
  types: ContentType[];
  priority: "P0" | "P1";
  loginUrl: string;
  readiness: "unverified" | "draft-spike";
}
export const platforms: Platform[] = [
  {
    id: "wechat-official",
    name: "微信公众号",
    types: ["article"],
    priority: "P0",
    loginUrl: "https://mp.weixin.qq.com/",
    readiness: "draft-spike",
  },
  {
    id: "zhihu",
    name: "知乎",
    types: ["article"],
    priority: "P0",
    loginUrl: "https://www.zhihu.com/signin",
    readiness: "draft-spike",
  },
  {
    id: "xiaohongshu",
    name: "小红书",
    types: ["gallery", "video"],
    priority: "P0",
    loginUrl: "https://creator.xiaohongshu.com/",
    readiness: "draft-spike",
  },
  {
    id: "douyin",
    name: "抖音",
    types: ["gallery", "video"],
    priority: "P0",
    loginUrl: "https://creator.douyin.com/",
    readiness: "draft-spike",
  },
  {
    id: "bilibili",
    name: "B站",
    types: ["video"],
    priority: "P1",
    loginUrl: "https://member.bilibili.com/",
    readiness: "unverified",
  },
  {
    id: "wechat-channels",
    name: "微信视频号",
    types: ["video"],
    priority: "P1",
    loginUrl: "https://channels.weixin.qq.com/",
    readiness: "unverified",
  },
  {
    id: "toutiao",
    name: "今日头条",
    types: ["article", "gallery", "video"],
    priority: "P1",
    loginUrl: "https://mp.toutiao.com/",
    readiness: "unverified",
  },
  {
    id: "baijiahao",
    name: "百家号",
    types: ["article", "gallery", "video"],
    priority: "P1",
    loginUrl: "https://baijiahao.baidu.com/",
    readiness: "unverified",
  },
];
export const newAccount = z
  .object({ platform: platformId, name: z.string().trim().min(1).max(80) })
  .strict();
export const accountLoginStatus = z.enum([
  "unknown",
  "checking",
  "authenticated",
  "expired",
  "intervention_required",
]);
export type AccountLoginStatus = z.infer<typeof accountLoginStatus>;
export const newContent = z
  .object({
    type: contentType,
    title: z.string().trim().min(1).max(500),
    body: z.string().max(200_000).default(""),
    bodyFormat: z.enum(["plain", "markdown"]).optional(),
    images: z.array(z.string().min(1)).max(100).default([]),
    video: z.string().optional(),
    cover: z.string().optional(),
    summary: z.string().max(1000).default(""),
    author: z.string().max(100).default(""),
    tags: z.array(z.string().max(100)).max(50).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "article" && !value.body.trim())
      ctx.addIssue({ code: "custom", message: "文章正文不能为空" });
    if (value.type === "gallery" && !value.images.length)
      ctx.addIssue({ code: "custom", message: "图文至少需要一张图片" });
    if (value.type === "video" && !value.video?.trim())
      ctx.addIssue({ code: "custom", message: "视频路径不能为空" });
  });
export type ContentInput = z.infer<typeof newContent>;
export const contentArchive = z
  .object({
    version: z.literal(1),
    contents: z.array(newContent).min(1).max(100),
  })
  .strict();
export const portableAsset = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(["image/png", "image/jpeg"]),
    data: z.string().min(4).max(14_000_000),
  })
  .strict();
export const portableContentArchive = z
  .object({
    version: z.literal(2),
    contents: z.array(newContent).min(1).max(100),
    assets: z.array(portableAsset).max(500),
  })
  .strict();
export const anyContentArchive = z.union([
  contentArchive,
  portableContentArchive,
]);
export type Content = ContentInput & { id: string; createdAt: string };
export interface Account {
  id: string;
  platform: PlatformId;
  name: string;
  loginStatus: AccountLoginStatus;
  checkedAt: string | null;
  message: string;
  createdAt: string;
}
export const newCampaign = z
  .object({
    contentId: z.uuid(),
    accountIds: z.array(z.uuid()).min(1).max(100),
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type TaskStatus =
  | "pending"
  | "scheduled"
  | "validating"
  | "retry_wait"
  | "publishing"
  | "intervention_required"
  | "cancelled"
  | "failed"
  | "succeeded"
  | "draft_saved";
export interface Task {
  id: string;
  campaignId: string;
  accountId: string;
  platform: PlatformId;
  content: Content;
  status: TaskStatus;
  scheduledAt: string | null;
  message: string;
  createdAt: string;
  resultUrl: string | null;
  attemptCount: number;
  nextRunAt: string | null;
  lastErrorKind: "retryable" | "permanent" | "unknown" | null;
}
export interface TaskEvent {
  id: number;
  taskId: string;
  status: TaskStatus;
  message: string;
  createdAt: string;
  progressStage: DraftProgressStage | null;
  progressCurrent: number | null;
  progressTotal: number | null;
}
export type DraftProgressStage =
  "session" | "upload" | "fields" | "privacy" | "save" | "verify";
export interface DraftProgress {
  stage: DraftProgressStage;
  message: string;
  current?: number;
  total?: number;
}
export interface Snapshot {
  platforms: Platform[];
  accounts: Account[];
  contents: Content[];
  tasks: Task[];
}
export const rpcRequest = z
  .object({
    id: z.union([z.string(), z.number()]),
    method: z.enum([
      "snapshot",
      "account.create",
      "account.open",
      "account.close",
      "account.checkLogin",
      "content.create",
      "content.update",
      "content.import",
      "content.exportPortable",
      "content.exportPortableFile",
      "content.importPortableFile",
      "assets.importImages",
      "campaign.create",
      "task.cancel",
      "task.preflight",
      "task.saveDraft",
      "task.enqueueDraft",
      "task.openDraft",
      "task.events",
      "diagnostics.capture",
    ]),
    params: z.unknown().optional(),
  })
  .strict();
export type RpcRequest = z.infer<typeof rpcRequest>;
export type RpcResponse = {
  id: string | number | null;
  result?: unknown;
  error?: { code: string; message: string };
};

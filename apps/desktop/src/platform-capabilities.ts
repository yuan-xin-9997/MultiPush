import {
  douyinVideoDraftVerified,
  xiaohongshuGalleryDraftVerified,
  type ContentType,
  type PlatformId,
} from "@turbopush/shared";

export interface PlatformTaskCapability {
  preflight: boolean;
  saveDraft: boolean;
  enqueueDraft: boolean;
  draftUnavailableReason?: string;
}

const unverifiedDraft = "草稿保存待真实创作页面验证，当前不可用";

/**
 * UI-facing capability gate. Platform adapters can promote a capability here
 * only after their remote write and read-back checks have been verified.
 */
export function taskCapability(
  platform: PlatformId,
  contentType: ContentType,
): PlatformTaskCapability {
  if (
    contentType === "article" &&
    (platform === "zhihu" || platform === "wechat-official")
  )
    return { preflight: true, saveDraft: true, enqueueDraft: true };

  if (platform === "xiaohongshu" && contentType === "gallery")
    return {
      preflight: true,
      saveDraft: xiaohongshuGalleryDraftVerified,
      enqueueDraft: xiaohongshuGalleryDraftVerified,
      ...(xiaohongshuGalleryDraftVerified
        ? {}
        : { draftUnavailableReason: unverifiedDraft }),
    };

  if (platform === "douyin" && contentType === "video")
    return {
      preflight: true,
      saveDraft: douyinVideoDraftVerified,
      enqueueDraft: douyinVideoDraftVerified,
      ...(douyinVideoDraftVerified
        ? {}
        : { draftUnavailableReason: unverifiedDraft }),
    };

  return {
    preflight: true,
    saveDraft: false,
    enqueueDraft: false,
    draftUnavailableReason: "该平台的草稿适配器尚未验证，当前不可用",
  };
}

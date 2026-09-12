import assert from "node:assert/strict";

export interface ExpectedLocalDraft {
  title: string;
  body: string;
  imageCount: number;
}

export interface LocalDraftCandidate {
  index: number;
  title: string;
}

export interface XiaohongshuLocalDraftAdapter {
  events: string[];
  listDraftCandidates(): Promise<LocalDraftCandidate[]>;
  readDraftCandidate(
    candidate: LocalDraftCandidate,
  ): Promise<ExpectedLocalDraft>;
  uploadImages(images: readonly string[]): Promise<void>;
  saveToLocalDrafts(expected: ExpectedLocalDraft): Promise<void>;
}

export const localDraftMatches = (
  actual: ExpectedLocalDraft,
  expected: ExpectedLocalDraft,
) =>
  actual.title === expected.title &&
  actual.body === expected.body &&
  actual.imageCount === expected.imageCount;

export async function findMatchingLocalDraft(
  adapter: XiaohongshuLocalDraftAdapter,
  expected: ExpectedLocalDraft,
) {
  const candidates = await adapter.listDraftCandidates();
  for (const candidate of candidates) {
    if (candidate.title !== expected.title) continue;
    const actual = await adapter.readDraftCandidate(candidate);
    if (localDraftMatches(actual, expected)) return candidate;
  }
  return undefined;
}

export async function saveLocalDraftIdempotently(
  adapter: XiaohongshuLocalDraftAdapter,
  expected: ExpectedLocalDraft,
  images: readonly string[],
) {
  const existing = await findMatchingLocalDraft(adapter, expected);
  if (existing) return { reused: true, candidate: existing };
  await adapter.uploadImages(images);
  await adapter.saveToLocalDrafts(expected);
  const saved = await findMatchingLocalDraft(adapter, expected);
  assert.ok(saved, "暂存后必须从草稿箱逐一回读并找到完全匹配项");
  return { reused: false, candidate: saved };
}

export function validateClosedShadowCoordinate(input: {
  url: string;
  viewport: { width: number; height: number };
  point: { x: number; y: number };
  elementFromPoint: { hostMarker: string; matchingHostCount: number };
  layoutVersion: string;
  expectedLayoutVersion: string;
}) {
  const parsed = new URL(input.url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "creator.xiaohongshu.com"
  )
    throw new Error("closed-shadow坐标动作仅允许小红书创作平台受信host");
  if (input.layoutVersion !== input.expectedLayoutVersion)
    throw new Error("截图或DOM布局基准版本变化，拒绝坐标动作");
  if (input.viewport.width <= 0 || input.viewport.height <= 0)
    throw new Error("无效的页面可视区域");
  const xRatio = input.point.x / input.viewport.width;
  const distanceFromBottom = input.viewport.height - input.point.y;
  if (
    xRatio < 0.4 ||
    xRatio > 0.46 ||
    distanceFromBottom < 30 ||
    distanceFromBottom > 60
  )
    throw new Error("坐标不在已验证的相对安全区域");
  if (
    input.elementFromPoint.hostMarker !== "xhs-publish-btn" ||
    input.elementFromPoint.matchingHostCount !== 1
  )
    throw new Error("elementFromPoint未精确命中唯一草稿按钮host");
  return true;
}

export const douyinSpikeModes = [
  "structure",
  "upload-structure",
  "fill-structure",
  "save",
] as const;

export type DouyinSpikeMode = (typeof douyinSpikeModes)[number];

export function parseDouyinSpikeConfig(env: NodeJS.ProcessEnv) {
  const mode = env.TURBOPUSH_MODE ?? "structure";
  if (!douyinSpikeModes.includes(mode as DouyinSpikeMode))
    throw new Error(`TURBOPUSH_MODE 必须是 ${douyinSpikeModes.join("|")}`);
  const accountId = env.TURBOPUSH_ACCOUNT_ID;
  if (!accountId) throw new Error("需要显式设置 TURBOPUSH_ACCOUNT_ID");
  const video = env.TURBOPUSH_VIDEO;
  if (mode !== "structure" && !video)
    throw new Error("上传模式需要显式设置 TURBOPUSH_VIDEO");
  return {
    accountId,
    mode: mode as DouyinSpikeMode,
    video,
    uploadsVideo: mode !== "structure",
  };
}

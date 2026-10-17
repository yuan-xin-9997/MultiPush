/**
 * Pure verdict over evidence collected elsewhere. This does not establish that
 * a browser request or DOM image belongs to a particular draft: callers must
 * prove those associations before passing them here.
 */
export interface XiaohongshuUploadProof<Fingerprint> {
  localIndex: number;
  requestFingerprint: Fingerprint;
  uniquePayload: boolean;
  uniqueSuccessfulResponse: boolean;
}

export interface XiaohongshuImageEvidence<Fingerprint> {
  local: readonly Fingerprint[];
  /** At least three successive, independently captured editor readbacks. */
  remoteSamples: readonly (readonly Fingerprint[])[];
  uploads: readonly XiaohongshuUploadProof<Fingerprint>[];
}

export function verifyXiaohongshuImagesInOrder<Fingerprint>(
  evidence: XiaohongshuImageEvidence<Fingerprint>,
  matches: (left: Fingerprint, right: Fingerprint) => boolean = Object.is,
  stable: (left: Fingerprint, right: Fingerprint) => boolean = Object.is,
): true {
  const { local, remoteSamples, uploads } = evidence;
  if (local.length < 2 || local.length > 18)
    throw new Error("小红书逐图验收要求 2..18 张本地图片");
  if (remoteSamples.length < 3) throw new Error("远端图片缺少至少三次稳定采样");
  if (uploads.length !== local.length)
    throw new Error("逐图上传证明缺失或多余");

  const uniqueMatch = (
    candidate: Fingerprint,
    references: readonly Fingerprint[],
  ) =>
    references.flatMap((reference, index) =>
      matches(candidate, reference) ? [index] : [],
    );
  for (const [index, fingerprint] of local.entries())
    if (uniqueMatch(fingerprint, local).length !== 1)
      throw new Error(`本地第${index + 1}张图片指纹重复或不可唯一识别`);

  const seen = new Set<number>();
  for (const [expectedIndex, upload] of uploads.entries()) {
    if (
      !Number.isInteger(upload.localIndex) ||
      upload.localIndex < 0 ||
      upload.localIndex >= local.length ||
      upload.localIndex !== expectedIndex ||
      seen.has(upload.localIndex)
    )
      throw new Error("上传请求未能逐图唯一归因");
    seen.add(upload.localIndex);
    if (!upload.uniquePayload || !upload.uniqueSuccessfulResponse)
      throw new Error(`本地第${upload.localIndex + 1}张缺少唯一成功上传证明`);
    if (
      uniqueMatch(upload.requestFingerprint, local).length !== 1 ||
      !matches(upload.requestFingerprint, local[upload.localIndex]!)
    )
      throw new Error(`第${upload.localIndex + 1}张上传载荷与本地图片不一致`);
  }

  for (const [sampleIndex, sample] of remoteSamples.entries()) {
    if (sample.length !== local.length)
      throw new Error(`远端第${sampleIndex + 1}次采样图片数量不一致`);
    for (const [index, fingerprint] of sample.entries()) {
      const matched = uniqueMatch(fingerprint, local);
      if (matched.length !== 1 || matched[0] !== index)
        throw new Error(
          `远端第${sampleIndex + 1}次采样第${index + 1}张身份或顺序不一致`,
        );
      for (let previous = 0; previous < sampleIndex; previous += 1)
        if (!stable(fingerprint, remoteSamples[previous]![index]!))
          throw new Error(`远端第${index + 1}张指纹未稳定`);
    }
  }
  return true;
}

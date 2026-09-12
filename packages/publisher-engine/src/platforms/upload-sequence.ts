export async function uploadImagesSequentially<T>(
  images: readonly T[],
  upload: (image: T, index: number) => Promise<void>,
) {
  for (let index = 0; index < images.length; index += 1)
    await upload(images[index]!, index);
}

export function sequentialUploadTimeoutRisk(
  imageCount: number,
  perImageTimeoutMs = 45_000,
  rpcTimeoutMs = 150_000,
) {
  const worstCaseMs = imageCount * perImageTimeoutMs;
  return { worstCaseMs, exceedsRpcTimeout: worstCaseMs > rpcTimeoutMs };
}

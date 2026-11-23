export interface BilibiliUploadedImage {
  url: string
  name?: string
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Replace positional markers left by articleImages() with Bilibili image URLs. */
export function replaceBilibiliImageMarkers(html: string, images: BilibiliUploadedImage[]): { html: string; replaced: number } {
  let replaced = 0
  const next = html.replace(/<span[^>]*data-multipush-image="(\d+)"[^>]*><\/span>/g, (marker, indexText) => {
    const index = Number(indexText)
    const image = images[index]
    if (!image) return marker
    replaced += 1
    const alt = escapeAttribute(image.name || `正文图片 ${index + 1}`)
    return marker.includes('data-multipush-block="0"')
      ? `<img src="${escapeAttribute(image.url)}" alt="${alt}">`
      : `<figure><img src="${escapeAttribute(image.url)}" alt="${alt}"></figure>`
  })
  return { html: next, replaced }
}

/** Drop positional markers when the API upload failed and clipboard fallback is used. */
export function stripBilibiliImageMarkers(html: string): string {
  return html.replace(/<span[^>]*data-multipush-image="\d+"[^>]*><\/span>/g, '')
}

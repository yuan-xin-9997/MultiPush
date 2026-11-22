/** Read a byte size from static-file response headers. */
export function imageSizeFromHeaders(headers: Pick<Headers, 'get'>): number | null {
  const length = Number(headers.get('content-length'))
  if (Number.isFinite(length) && length > 0) return length
  // Express static responses omit Content-Length on HEAD; their weak ETag
  // starts with the file size in hexadecimal, e.g. W/"c4de-1a203437dc0".
  const etag = headers.get('etag') ?? ''
  const match = /^(?:W\/)?"?([0-9a-f]+)-/i.exec(etag)
  const size = match ? Number.parseInt(match[1], 16) : 0
  return Number.isFinite(size) && size > 0 ? size : null
}

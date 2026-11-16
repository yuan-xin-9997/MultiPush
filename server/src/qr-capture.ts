import type { Locator } from 'playwright-core'

/**
 * Waits until a QR `<img>` has actually painted before it is screenshotted.
 *
 * Playwright reports an `<img>` as visible as soon as its box is laid out, even
 * while it is still loading. Screenshotting at that moment captures a blank
 * white box, which the user then tries to scan.
 */
export async function qrReady(qr: Locator): Promise<void> {
  await qr.evaluate(node => {
    const image = node as unknown as { complete?: boolean; naturalWidth?: number; addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void }
    if (typeof image.naturalWidth !== 'number' || (image.complete && image.naturalWidth > 0)) return undefined
    return new Promise<void>(resolve => {
      image.addEventListener?.('load', () => resolve(), { once: true })
      image.addEventListener?.('error', () => resolve(), { once: true })
      setTimeout(resolve, 4_000)
    })
  }).catch(() => {})
}

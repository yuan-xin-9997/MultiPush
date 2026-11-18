import { load } from 'cheerio'

export interface LinkFallbackOptions {
  /** Hosts that keep clickable links on this platform (for example, the platform's own domain). */
  allowedHosts?: string[]
  /** Inline style used for the copyable address. */
  style?: string
}

export interface LinkFallbackResult {
  html: string
  /** Number of external anchors converted to copyable text. */
  converted: number
}

const DEFAULT_ADDRESS_STYLE = 'word-break:break-all;'

function isAllowedHost(hostname: string, allowedHosts: string[] | undefined): boolean {
  if (!allowedHosts?.length) return false
  const host = hostname.toLowerCase()
  return allowedHosts.some((value) => {
    const allowed = value.trim().toLowerCase().replace(/^\.+/, '')
    return Boolean(allowed) && (host === allowed || host.endsWith(`.${allowed}`))
  })
}

/**
 * Platforms such as Toutiao and Baijiahao remove external `<a>` tags when their
 * editor sanitizes pasted HTML. Keep the link text and append the absolute
 * address as plain text so the reader can still copy it.
 *
 * Internal anchors, non-HTTP schemes, and hosts explicitly allowed by the
 * platform are left untouched. If the link text already contains the address,
 * the address is not duplicated.
 */
export function preserveExternalLinksAsText(
  html: string,
  options: LinkFallbackOptions = {},
): LinkFallbackResult {
  if (!html || !/<a\b/i.test(html)) return { html, converted: 0 }

  const $ = load(html, null, false)
  let converted = 0

  $('a[href]').each((_, node) => {
    const link = $(node)
    const href = link.attr('href')?.trim()
    if (!href || href.startsWith('#')) return

    let url: URL
    try {
      url = new URL(href)
    } catch {
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    if (isAllowedHost(url.hostname, options.allowedHosts)) return

    const text = link.text().replace(/\s+/g, ' ').trim()
    const replacement = $('<span>').attr('style', options.style ?? DEFAULT_ADDRESS_STYLE)
    replacement.append(link.contents())
    if (text !== href && text !== url.href && !text.includes(url.href)) {
      replacement.append($('<span>').text(`（${url.href}）`))
    }
    link.replaceWith(replacement)
    converted += 1
  })

  return { html: $.html(), converted }
}

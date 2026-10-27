// Issue references in commit messages turned into links: per-repo rules (`JIRA-\d+` → https://jira.example.com/browse/$0)
// plus the hosting provider's own `#123` (and GitLab's `!123` merge requests). Pure: no React, no IPC.
import type { HostingKind, IssueLinkConfig, IssueLinkRule } from '@shared/integrations'

export interface LinkSegment {
  text: string
  url?: string
}

export interface CompiledRule {
  re: RegExp
  url: string
  /** Rejects a match by what precedes it (provider refs must not sit inside words or paths) */
  guard?: (text: string, index: number) => boolean
}

/** The bits of the repo's hosting the provider rules need. */
export interface ProviderLinkInfo {
  kind: HostingKind
  webUrl: string
  /** Issue URL with $1 for the number */
  issueUrl: string
}

const MAX_RULES = 50

/** Null when the rule is usable, otherwise why it isn't. */
export function validateRule(rule: IssueLinkRule): string | null {
  if (!rule.pattern.trim()) return 'Pattern is empty'
  try {
    if (new RegExp(rule.pattern).test('')) return 'Pattern matches empty text'
  } catch (e) {
    return `Invalid pattern: ${(e as Error).message}`
  }
  if (!/^https?:\/\//i.test(rule.url.trim())) return 'URL must start with http:// or https://'
  return null
}

/** `#123` must not follow a word character, `/` or `&` (anchors in URLs, HTML entities). */
const refGuard = (text: string, index: number) => index === 0 || !/[\w/&]/.test(text[index - 1])

function origin(url: string): string {
  const m = /^(https?:\/\/[^/]+)/i.exec(url)
  return m ? m[1] : url
}

/** Provider rules first (they are more specific), then the user's rules, in order. Invalid rules are skipped. */
export function compileRules(config: IssueLinkConfig | undefined, provider: ProviderLinkInfo | null): CompiledRule[] {
  const rules: CompiledRule[] = []
  if (provider && (config?.providerLinks ?? true)) {
    if (provider.kind === 'github') {
      // owner/repo#123 points at another repository on the same host
      rules.push({ re: /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g, url: `${origin(provider.webUrl)}/$1/issues/$2`, guard: refGuard })
      rules.push({ re: /\bGH-(\d+)\b/g, url: provider.issueUrl })
    }
    if (provider.kind === 'gitlab') rules.push({ re: /!(\d+)\b/g, url: `${provider.webUrl}/-/merge_requests/$1`, guard: refGuard })
    rules.push({ re: /#(\d+)\b/g, url: provider.issueUrl, guard: refGuard })
  }
  for (const rule of (config?.rules ?? []).slice(0, MAX_RULES)) {
    if (validateRule(rule)) continue
    rules.push({ re: new RegExp(rule.pattern, 'g'), url: rule.url.trim() })
  }
  return rules
}

/** Fill $0…$9 in a URL template from a match; substituted values are URL-encoded. */
export function expandUrl(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(\d)/g, (_, d: string) => {
    const v = match[Number(d)]
    return v === undefined ? '' : encodeURIComponent(v).replace(/%2F/gi, '/')
  })
}

interface Hit {
  start: number
  end: number
  url: string
  order: number
}

/** Split text into plain and linked segments. Overlaps go to the earliest match, then the earlier rule. */
export function linkify(text: string, rules: CompiledRule[]): LinkSegment[] {
  if (!text || rules.length === 0) return [{ text }]
  const hits: Hit[] = []
  rules.forEach((rule, order) => {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      if (rule.guard && !rule.guard(text, m.index)) continue
      const url = expandUrl(rule.url, m)
      if (/^https?:\/\//i.test(url)) hits.push({ start: m.index, end: m.index + m[0].length, url, order })
    }
  })
  if (hits.length === 0) return [{ text }]
  hits.sort((a, b) => a.start - b.start || a.order - b.order || b.end - a.end)
  const out: LinkSegment[] = []
  let pos = 0
  for (const h of hits) {
    if (h.start < pos) continue
    if (h.start > pos) out.push({ text: text.slice(pos, h.start) })
    out.push({ text: text.slice(h.start, h.end), url: h.url })
    pos = h.end
  }
  if (pos < text.length) out.push({ text: text.slice(pos) })
  return out
}

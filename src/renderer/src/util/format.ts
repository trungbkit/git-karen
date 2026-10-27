// Formatting helpers shared across the renderer.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms)
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE)
    return m === 1 ? '1 minute ago' : `${m} minutes ago`
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR)
    return h === 1 ? '1 hour ago' : `${h} hours ago`
  }
  const d = Math.floor(diff / DAY)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  if (d < 30) {
    const w = Math.floor(d / 7)
    return w === 1 ? 'a week ago' : `${w} weeks ago`
  }
  if (d < 365) {
    const mo = Math.floor(d / 30)
    return mo === 1 ? 'a month ago' : `${mo} months ago`
  }
  const y = Math.floor(d / 365)
  return y === 1 ? 'a year ago' : `${y} years ago`
}

const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

export function formatDate(ms: number, mode: 'relative' | 'absolute'): string {
  return mode === 'relative' ? relativeTime(ms) : absoluteFormatter.format(new Date(ms))
}

export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString()
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function initials(name: string): string {
  const parts = name
    .replace(/[<>()[\]"']/g, ' ')
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Stable hue derived from the email so the same author always gets the same avatar colour. */
export function avatarColor(email: string): string {
  let h = 0
  const s = email.trim().toLowerCase()
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 55%, 46%)`
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function joinPath(dir: string, name: string, platform: string = window.app?.platform ?? 'darwin'): string {
  const sep = platform === 'win32' ? '\\' : '/'
  return dir.endsWith(sep) || dir.endsWith('/') ? dir + name : dir + sep + name
}

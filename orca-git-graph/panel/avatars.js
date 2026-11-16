// Author pictures in the panel. The worker downloads them (frames have no network) and answers
// with data: URLs; each picture becomes one SVG <symbol> that graph rows <use>, so a row's HTML
// never repeats the image bytes. Answers are kept in localStorage: pictures for a week, "no
// picture" for a day.

const STORE_KEY = 'avatars:v1'
const HIT_TTL = 7 * 86400_000
const MISS_TTL = 86400_000
/** Emails the worker could not check right now (offline, rate limit) wait this long. */
const RETRY_MS = 5 * 60_000
const MAX_STORED = 400
const BATCH = 40

export function initials(name) {
  const parts = String(name || '')
    .replace(/[<>()[\]"']/g, ' ')
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Stable background for initials, as in Karen. */
export function avatarColor(email) {
  let h = 0
  const s = String(email || '').trim().toLowerCase()
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 55%, 46%)`
}

/**
 * @param {{ request: (input: object) => Promise<any>, defs: SVGDefsElement, onChange: () => void }} opts
 */
export function createAvatars({ request, defs, onChange }) {
  /** email -> { url: string | null, at: number } */
  const known = new Map()
  /** email -> retry time */
  const retryAt = new Map()
  /** email -> symbol id */
  const symbols = new Map()
  /** email -> sha of one of their commits (lets the worker ask GitHub) */
  const wanted = new Map()
  const inflight = new Set()
  let disabled = false
  let timer = null
  let repoPath = null

  try {
    const now = Date.now()
    for (const [email, [url, at]] of Object.entries(JSON.parse(localStorage.getItem(STORE_KEY) || '{}'))) {
      if (now - at < (url ? HIT_TTL : MISS_TTL)) known.set(email, { url, at })
    }
  } catch {}

  function save() {
    try {
      const entries = [...known].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_STORED)
      localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries.map(([e, v]) => [e, [v.url, v.at]]))))
    } catch {}
  }

  const keyOf = (email) => String(email || '').trim().toLowerCase()

  /** Id of the <symbol> holding `email`'s picture, or null while there is none. */
  function symbolFor(email) {
    const key = keyOf(email)
    const url = known.get(key)?.url
    if (!url) return null
    let id = symbols.get(key)
    if (!id) {
      id = `av-${symbols.size}`
      const ns = 'http://www.w3.org/2000/svg'
      const symbol = document.createElementNS(ns, 'symbol')
      symbol.id = id
      symbol.setAttribute('viewBox', '0 0 64 64')
      const image = document.createElementNS(ns, 'image')
      image.setAttribute('href', url)
      image.setAttribute('width', '64')
      image.setAttribute('height', '64')
      image.setAttribute('preserveAspectRatio', 'xMidYMid slice')
      image.setAttribute('clip-path', 'url(#avatar-clip)')
      symbol.append(image)
      defs.append(symbol)
      symbols.set(key, id)
    }
    return id
  }

  /** The data: URL of `email`'s picture, or null. */
  function urlFor(email) {
    return known.get(keyOf(email))?.url ?? null
  }

  /** Ask for pictures of these authors ({ email, sha }) that are not known yet. */
  function want(authors) {
    if (disabled || !repoPath) return
    const now = Date.now()
    for (const { email, sha } of authors) {
      const key = keyOf(email)
      if (!key || known.has(key) || inflight.has(key) || wanted.has(key) || (retryAt.get(key) ?? 0) > now) continue
      wanted.set(key, sha)
    }
    if (wanted.size && !timer) timer = setTimeout(flush, 120)
  }

  async function flush() {
    timer = null
    const batch = [...wanted].slice(0, BATCH)
    for (const [key] of batch) {
      wanted.delete(key)
      inflight.add(key)
    }
    const path = repoPath
    let res
    try {
      res = await request({ repoPath: path, authors: batch.map(([email, sha]) => ({ email, sha })) })
    } catch {
      res = null
    }
    const now = Date.now()
    let changed = false
    if (res?.disabled) {
      disabled = true
      wanted.clear()
    }
    for (const [key] of batch) {
      inflight.delete(key)
      const url = res?.avatars?.[key]
      if (url === undefined) retryAt.set(key, now + RETRY_MS)
      else {
        known.set(key, { url, at: now })
        if (url) changed = true
      }
    }
    save()
    if (changed || res?.disabled) onChange()
    if (wanted.size && path === repoPath) timer = setTimeout(flush, 0)
  }

  return {
    symbolFor,
    urlFor,
    want,
    get disabled() {
      return disabled
    },
    /** The repository whose remotes the worker uses for GitHub lookups. */
    setRepo(path) {
      if (path === repoPath) return
      repoPath = path
      wanted.clear()
    }
  }
}

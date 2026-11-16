// Author pictures. Plugin frames have no network, so the worker downloads each picture and hands
// the panel a data: URL. Sources, in order (as in Karen):
//   1. a GitHub noreply address names its account: avatars.githubusercontent.com
//   2. Gravatar, by the SHA-256 of the address (d=404: no picture means no answer)
//   3. GitHub's REST API for one of the author's commits, when the repository is on github.com;
//      unauthenticated, so 60 lookups an hour. A rate limit pauses this source until it resets.

import { createHash } from 'node:crypto'

const SIZE = 64
const MAX_BYTES = 256 * 1024
const TIMEOUT_MS = 6000

export function noreplyUrl(email) {
  const m = /^(?:(\d+)\+)?([^@+]+)@users\.noreply\.github\.com$/i.exec(email.trim())
  if (!m) return null
  return m[1] ? `https://avatars.githubusercontent.com/u/${m[1]}?s=${SIZE}` : `https://github.com/${encodeURIComponent(m[2])}.png?size=${SIZE}`
}

export function gravatarUrl(email) {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
  return `https://www.gravatar.com/avatar/${hash}?d=404&s=${SIZE}`
}

/** `{ owner, name }` for a github.com remote URL (https, ssh or scp form), else null. */
export function githubRepo(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? '').trim())
  return m ? { owner: m[1], name: m[2] } : null
}

class Transient extends Error {}

/**
 * @param {{ fetch?: typeof fetch, log?: (s: string) => void, now?: () => number }} [deps]
 */
export function createAvatarService({ fetch: fetchFn = globalThis.fetch, log = () => {}, now = Date.now } = {}) {
  /** email -> data URL, or null when no source has a picture */
  const known = new Map()
  /** email -> in-flight lookup */
  const inflight = new Map()
  let githubPausedUntil = 0

  async function get(url, signal, headers = {}) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const res = await fetchFn(url, {
      headers: { 'User-Agent': 'orca-git-graph', ...headers },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    return res
  }

  /** A data: URL for the image at `url`, null when it does not exist; throws Transient otherwise. */
  async function image(url, signal) {
    let res
    try {
      res = await get(url, signal)
    } catch (error) {
      throw new Transient(error.message)
    }
    if (res.status === 404) return null
    if (!res.ok) throw new Transient(`${res.status} from ${new URL(url).host}`)
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    if (!type.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_BYTES) return null
    return `data:${type};base64,${buf.toString('base64')}`
  }

  /** The avatar URL GitHub links to `sha`'s author, null when none; throws Transient. */
  async function githubAvatarUrl(repo, sha, signal) {
    if (now() < githubPausedUntil) throw new Transient('GitHub rate limit')
    let res
    try {
      res = await get(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${sha}`, signal, {
        Accept: 'application/vnd.github+json'
      })
    } catch (error) {
      throw new Transient(error.message)
    }
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'))
      githubPausedUntil = reset > 0 ? reset * 1000 : now() + 15 * 60_000
      log(`GitHub avatar lookups paused until ${new Date(githubPausedUntil).toISOString()}`)
      throw new Transient('GitHub rate limit')
    }
    // Not pushed yet, a private repository, or not on GitHub at all: ask again another time.
    if (res.status === 404 || res.status === 422) throw new Transient(`${res.status} from GitHub`)
    if (!res.ok) throw new Transient(`${res.status} from GitHub`)
    const body = await res.json()
    return body?.author?.avatar_url ?? null
  }

  async function lookup(email, { repo, sha }, signal) {
    const noreply = noreplyUrl(email)
    if (noreply) return image(noreply, signal)
    const gravatar = await image(gravatarUrl(email), signal)
    if (gravatar || !repo || !sha) return gravatar
    const url = await githubAvatarUrl(repo, sha, signal)
    if (!url) return null
    const u = new URL(url)
    u.searchParams.set('s', String(SIZE))
    return image(u.toString(), signal)
  }

  /**
   * Pictures for `authors` ({ email, sha }). The answer maps email -> data URL or null (no picture
   * anywhere); emails missing from it could not be checked now and may be asked again later.
   */
  async function avatars(authors, { repo = null, signal } = {}) {
    const out = {}
    const queue = []
    for (const { email, sha } of authors) {
      const key = String(email ?? '').trim().toLowerCase()
      if (!key || key in out) continue
      if (known.has(key)) out[key] = known.get(key)
      else queue.push({ key, sha: /^[0-9a-f]{40}$/i.test(sha ?? '') ? sha : null })
    }
    let next = 0
    const worker = async () => {
      while (next < queue.length) {
        const { key, sha } = queue[next++]
        let p = inflight.get(key)
        if (!p) {
          p = lookup(key, { repo, sha }, signal).finally(() => inflight.delete(key))
          inflight.set(key, p)
        }
        try {
          const url = await p
          known.set(key, url)
          out[key] = url
        } catch (error) {
          if (!(error instanceof Transient)) log(`avatar for ${key}: ${error.message}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker))
    return out
  }

  return { avatars }
}

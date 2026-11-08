import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { Commit } from '@shared/types'
import { useRepoHosting } from '../state/hosting'
import { noreplyAvatarUrl } from '../util/hosting'

/** GitHub avatar URL by `host|email` ('' once the image failed to load) */
const githubUrl = new Map<string, string>()
/** `host|email` already answered or in flight */
const asked = new Set<string>()
/** `host/owner/repo|sha` GitHub said it doesn't have, until when: it may be pushed later */
const unknownSha = new Map<string, number>()
const UNKNOWN_TTL_MS = 5 * 60_000
/** Shas per request; keep at or below the backend's MAX_CI_SHAS (extra shas come back unanswered and are asked again) */
const MAX_EMAILS = 100
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
export const subscribeGithubAvatars = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** The GitHub host the avatars below it belong to, so github.com and Enterprise results don't mix. */
const AvatarHost = createContext<string | undefined>(undefined)
export const AvatarHostProvider = AvatarHost.Provider
export const useAvatarHost = () => useContext(AvatarHost)

export const githubAvatar = (host: string | undefined, key: string) => githubUrl.get(`${host ?? ''}|${key}`) ?? noreplyAvatarUrl(key) ?? undefined

export function dropGithubAvatar(host: string | undefined, key: string) {
  githubUrl.set(`${host ?? ''}|${key}`, '')
  notify()
}

function isUnknown(key: string, now: number) {
  const until = unknownSha.get(key)
  if (until === undefined) return false
  if (until > now) return true
  unknownSha.delete(key)
  return false
}

/** Looks up GitHub avatars for the authors of `commits`; returns the host to give `AvatarHostProvider`. */
export function useAuthorAvatars(repo: string, commits: Commit[], enabled: boolean): string | undefined {
  const info = useRepoHosting(repo)
  const remote = info?.remote
  const host = info?.host
  const scope = info ? `${info.host}/${info.path}` : undefined
  const active = enabled && info?.kind === 'github' && info.connected
  // bumped after a sha turns out to be unknown, so the author's other commits get a turn without waiting for a new list
  const [retry, setRetry] = useState(0)
  const latest = useRef(commits)
  latest.current = commits
  const key = commits.map((c) => c.sha).join(',')
  useEffect(() => {
    if (!active || !remote || !host || !scope) return
    const t = setTimeout(() => {
      const now = Date.now()
      const shaByEmail = new Map<string, string>()
      for (const c of latest.current) {
        const email = c.author.email.trim().toLowerCase()
        if (!email || asked.has(`${host}|${email}`) || noreplyAvatarUrl(email) || isUnknown(`${scope}|${c.sha}`, now)) continue
        if (shaByEmail.size >= MAX_EMAILS && !shaByEmail.has(email)) continue
        shaByEmail.set(email, c.sha)
      }
      const emailBySha = new Map<string, string>()
      for (const [email, sha] of shaByEmail) {
        asked.add(`${host}|${email}`)
        emailBySha.set(sha, email)
      }
      if (!emailBySha.size) return
      window.integrations
        .authorAvatars(repo, remote, [...emailBySha.keys()])
        .then(({ avatars, unknown }) => {
          for (const [sha, url] of Object.entries(avatars)) {
            const email = emailBySha.get(sha)
            if (email && url) githubUrl.set(`${host}|${email}`, url)
          }
          for (const sha of unknown) if (emailBySha.has(sha)) unknownSha.set(`${scope}|${sha}`, now + UNKNOWN_TTL_MS)
          // anything not answered with an avatar (or a clean "no linked user") is asked again later
          for (const [sha, email] of emailBySha) if (!(sha in avatars)) asked.delete(`${host}|${email}`)
          notify()
          if (unknown.some((sha) => emailBySha.has(sha))) setRetry((n) => n + 1)
        })
        .catch(() => emailBySha.forEach((email) => asked.delete(`${host}|${email}`)))
    }, 400)
    return () => clearTimeout(t)
  }, [repo, remote, host, scope, key, active, retry])
  return host
}

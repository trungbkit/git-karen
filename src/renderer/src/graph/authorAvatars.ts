import { useEffect, useRef } from 'react'
import type { Commit } from '@shared/types'
import { useRepoHosting } from '../state/hosting'
import { noreplyAvatarUrl } from '../util/hosting'

const githubUrl = new Map<string, string>()
const asked = new Set<string>()
const unknownSha = new Set<string>()
const MAX_EMAILS = 100
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
export const subscribeGithubAvatars = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export const githubAvatar = (key: string) => githubUrl.get(key) ?? noreplyAvatarUrl(key) ?? undefined

export function dropGithubAvatar(key: string) {
  githubUrl.set(key, '')
  notify()
}

export function useAuthorAvatars(repo: string, commits: Commit[], enabled: boolean) {
  const info = useRepoHosting(repo)
  const remote = info?.remote
  const host = info?.host
  const active = enabled && info?.kind === 'github' && info.connected
  const latest = useRef(commits)
  latest.current = commits
  const key = commits.map((c) => c.sha).join(',')
  useEffect(() => {
    if (!active || !remote || !host) return
    const t = setTimeout(() => {
      const shaByEmail = new Map<string, string>()
      for (const c of latest.current) {
        const email = c.author.email.trim().toLowerCase()
        if (shaByEmail.size >= MAX_EMAILS && !shaByEmail.has(email)) continue
        if (email && !asked.has(`${host}|${email}`) && !unknownSha.has(c.sha) && !noreplyAvatarUrl(email)) shaByEmail.set(email, c.sha)
      }
      const emailBySha = new Map<string, string>()
      for (const [email, sha] of shaByEmail) {
        asked.add(`${host}|${email}`)
        emailBySha.set(sha, email)
      }
      if (!emailBySha.size) return
      window.integrations
        .authorAvatars(repo, remote, [...emailBySha.keys()])
        .then((res) => {
          for (const [sha, url] of Object.entries(res)) if (url && emailBySha.has(sha)) githubUrl.set(emailBySha.get(sha)!, url)
          for (const sha of emailBySha.keys())
            if (!(sha in res)) {
              unknownSha.add(sha)
              asked.delete(`${host}|${emailBySha.get(sha)}`)
            }
          notify()
        })
        .catch(() => emailBySha.forEach((email) => asked.delete(`${host}|${email}`)))
    }, 400)
    return () => clearTimeout(t)
  }, [repo, remote, host, key, active])
}

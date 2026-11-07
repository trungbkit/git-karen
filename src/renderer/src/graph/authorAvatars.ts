import { useEffect, useRef } from 'react'
import type { Commit } from '@shared/types'
import { useRepoHosting } from '../state/hosting'
import { noreplyAvatarUrl } from '../util/hosting'

const githubUrl = new Map<string, string>()
const asked = new Set<string>()
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
  const active = enabled && info?.kind === 'github' && info.connected
  const latest = useRef(commits)
  latest.current = commits
  const key = commits.map((c) => c.sha).join(',')
  useEffect(() => {
    if (!active || !remote) return
    const t = setTimeout(() => {
      const shaByEmail = new Map<string, string>()
      for (const c of latest.current) {
        const email = c.author.email.trim().toLowerCase()
        if (email && !asked.has(email) && !noreplyAvatarUrl(email)) shaByEmail.set(email, c.sha)
      }
      const emailBySha = new Map<string, string>()
      for (const [email, sha] of shaByEmail) {
        asked.add(email)
        emailBySha.set(sha, email)
      }
      if (!emailBySha.size) return
      window.integrations
        .authorAvatars(repo, remote, [...emailBySha.keys()])
        .then((res) => {
          for (const [sha, url] of Object.entries(res)) if (url && emailBySha.has(sha)) githubUrl.set(emailBySha.get(sha)!, url)
          for (const [sha, email] of emailBySha) if (!(sha in res)) asked.delete(email)
          notify()
        })
        .catch(() => emailBySha.forEach((email) => asked.delete(email)))
    }, 400)
    return () => clearTimeout(t)
  }, [repo, remote, key, active])
}

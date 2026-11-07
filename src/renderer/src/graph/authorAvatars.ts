import { useEffect } from 'react'
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
  useEffect(() => {
    if (!active || !remote) return
    const shaByEmail = new Map<string, string>()
    for (const c of commits) {
      const key = c.author.email.trim().toLowerCase()
      if (key && !asked.has(key) && !noreplyAvatarUrl(key)) shaByEmail.set(key, c.sha)
    }
    const emailBySha = new Map<string, string>()
    for (const [key, sha] of [...shaByEmail].slice(0, 100)) {
      asked.add(key)
      emailBySha.set(sha, key)
    }
    if (!emailBySha.size) return
    window.integrations
      .authorAvatars(repo, remote, [...emailBySha.keys()])
      .then((res) => {
        for (const [sha, url] of Object.entries(res)) if (url && emailBySha.has(sha)) githubUrl.set(emailBySha.get(sha)!, url)
        for (const [sha, key] of emailBySha) if (!(sha in res)) asked.delete(key)
        notify()
      })
      .catch(() => emailBySha.forEach((key) => asked.delete(key)))
  }, [repo, remote, commits, active])
}

import { useEffect } from 'react'
import { create } from 'zustand'
import { useStore, type RepoTab } from './store'

/** A fetch brought new upstream commits for the checked-out branch: the graph shows a banner until pulled or dismissed. */
export interface BehindNotice {
  branch: string
  /** Short upstream name, e.g. "origin/main" */
  upstream: string
}

/** Behind notices by repo path. */
export const useBehindNotices = create<Record<string, BehindNotice>>(() => ({}))

/** Commit the checked-out branch's upstream pointed at in the last refresh. */
export function upstreamTip(repo: RepoTab | undefined): string | null {
  const upstream = repo?.status?.upstream
  if (!repo || !upstream) return null
  return repo.refs.find((r) => r.fullName === `refs/remotes/${upstream}`)?.sha ?? null
}

/** After a fetch (and the refresh that follows it): raise the banner when the upstream moved and the branch is behind it. */
export function noteFetched(path: string, tipBefore: string | null) {
  const repo = useStore.getState().repos[path]
  const st = repo?.status
  if (!repo || !st?.branch || st.detached || !st.upstream || st.behind === 0) return
  const tip = upstreamTip(repo)
  if (tip && tip !== tipBefore) useBehindNotices.setState({ [path]: { branch: st.branch, upstream: st.upstream } })
}

export function dismissBehindNotice(path: string) {
  if (!useBehindNotices.getState()[path]) return
  useBehindNotices.setState((s) => {
    const { [path]: _gone, ...rest } = s
    return rest
  }, true)
}

/** Fetch every open repo on the configured interval (0 disables). Failures are silent; manual fetch reports errors. */
export function useAutoFetch() {
  const minutes = useStore((s) => s.prefs.autoFetchMinutes)
  useEffect(() => {
    if (!minutes || minutes <= 0) return
    const id = setInterval(async () => {
      const { repos, refresh } = useStore.getState()
      for (const path of Object.keys(repos)) {
        if (repos[path].remotes.length === 0 || repos[path].busy) continue
        try {
          const before = upstreamTip(repos[path])
          await window.git.fetch(path, undefined, true)
          await refresh(path, { log: true })
          noteFetched(path, before)
        } catch {
          // ignored: auth prompts or offline should not spam toasts
        }
      }
    }, minutes * 60_000)
    return () => clearInterval(id)
  }, [minutes])
}

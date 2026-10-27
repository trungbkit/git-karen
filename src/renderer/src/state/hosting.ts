// Renderer-side cache for the hosting integration: where each repo is hosted, CI status of the commits on screen and
// the open pull requests. The backend caches CI too and owns the tokens; this store only holds what the UI shows.
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { CiStatus, PullRequestList, RepoHosting } from '@shared/integrations'
import { useStore } from './store'
import { compileRules, type CompiledRule } from '../util/issueLinks'

export interface PrState {
  list: PullRequestList | null
  error: string | null
  loading: boolean
  /** When the list was last loaded (ms) */
  at: number
}

interface HostingState {
  /** Absent = not loaded, null = not on a recognized provider */
  info: Record<string, RepoHosting | null>
  /** Remotes (and account generation) the info was loaded for */
  infoKey: Record<string, string>
  ci: Record<string, Record<string, CiStatus>>
  prs: Record<string, PrState>
  /** Bumped when tokens or hosts change, so everything reloads */
  generation: number
  loadInfo(repo: string, key: string): Promise<RepoHosting | null>
  loadPrs(repo: string): Promise<void>
  pollCi(repo: string, shas: string[], maxAgeSecs: number): Promise<void>
  invalidate(): void
}

const inflightInfo = new Map<string, Promise<RepoHosting | null>>()
const inflightPrs = new Set<string>()
const inflightCi = new Set<string>()

export const useHosting = create<HostingState>((set, get) => ({
  info: {},
  infoKey: {},
  ci: {},
  prs: {},
  generation: 0,

  loadInfo(repo, key) {
    const id = `${repo}\n${key}`
    const pending = inflightInfo.get(id)
    if (pending) return pending
    const p = window.integrations
      .repoInfo(repo)
      .catch(() => null)
      .then((info) => {
        set((s) => ({ info: { ...s.info, [repo]: info }, infoKey: { ...s.infoKey, [repo]: key } }))
        return info
      })
      .finally(() => inflightInfo.delete(id))
    inflightInfo.set(id, p)
    return p
  },

  async loadPrs(repo) {
    const info = get().info[repo]
    if (!info?.connected || inflightPrs.has(repo)) return
    inflightPrs.add(repo)
    const prev = get().prs[repo]
    set((s) => ({ prs: { ...s.prs, [repo]: { list: prev?.list ?? null, error: null, loading: true, at: prev?.at ?? 0 } } }))
    try {
      const list = await window.integrations.pullRequests(repo, info.remote)
      set((s) => ({ prs: { ...s.prs, [repo]: { list, error: null, loading: false, at: Date.now() } } }))
    } catch (e) {
      set((s) => ({ prs: { ...s.prs, [repo]: { list: prev?.list ?? null, error: (e as Error).message, loading: false, at: Date.now() } } }))
    } finally {
      inflightPrs.delete(repo)
    }
  },

  async pollCi(repo, shas, maxAgeSecs) {
    const info = get().info[repo]
    if (!info?.connected || shas.length === 0 || inflightCi.has(repo)) return
    inflightCi.add(repo)
    try {
      const res = await window.integrations.ciStatuses(repo, info.remote, shas, Math.round(maxAgeSecs))
      const known = get().ci[repo] ?? {}
      const changed = Object.entries(res).filter(([sha, st]) => JSON.stringify(known[sha]) !== JSON.stringify(st))
      if (changed.length) set((s) => ({ ci: { ...s.ci, [repo]: { ...s.ci[repo], ...Object.fromEntries(changed) } } }))
    } catch {
      // background polling stays quiet; the PR list reports connection problems
    } finally {
      inflightCi.delete(repo)
    }
  },

  invalidate() {
    set((s) => ({ info: {}, infoKey: {}, ci: {}, prs: {}, generation: s.generation + 1 }))
  }
}))

/** Where the repo is hosted (loaded on first use and whenever its remotes or the accounts change). */
export function useRepoHosting(repo: string): RepoHosting | null | undefined {
  const remotes = useStore((s) => s.repos[repo]?.remotes)
  const generation = useHosting((s) => s.generation)
  const info = useHosting((s) => s.info[repo])
  const loadedKey = useHosting((s) => s.infoKey[repo])
  const key = `${generation}|${(remotes ?? []).map((r) => `${r.name}=${r.fetchUrl}`).join('|')}`
  useEffect(() => {
    if (remotes && loadedKey !== key) void useHosting.getState().loadInfo(repo, key)
  }, [repo, key, loadedKey, remotes])
  return loadedKey === key ? info : undefined
}

const rulesCache = new Map<string, { config: unknown; info: unknown; rules: CompiledRule[] }>()

/** Compiled issue link rules for a repo, shared by every row that renders a message. */
export function useIssueRules(repo: string): CompiledRule[] {
  const config = useStore((s) => s.prefs.issueLinks?.[repo])
  const info = useRepoHosting(repo)
  const cached = rulesCache.get(repo)
  if (cached && cached.config === config && cached.info === info) return cached.rules
  const rules = compileRules(config, info ? { kind: info.kind, webUrl: info.webUrl, issueUrl: info.issueUrl } : null)
  rulesCache.set(repo, { config, info, rules })
  return rules
}

/** Seconds a CI result may be reused for: the auto-fetch interval, or an hour when auto-fetch is off. */
const ciMaxAge = (minutes: number) => (minutes > 0 ? minutes * 60 : 3600)

/**
 * Keep the CI status of the commits on screen current: load what is missing shortly after scrolling stops, and refresh
 * on the auto-fetch cadence while the window is visible. Only for repos with a connected token.
 */
export function useCiPolling(repo: string, visibleShas: string[]) {
  const info = useRepoHosting(repo)
  const minutes = useStore((s) => s.prefs.autoFetchMinutes)
  const shas = useRef(visibleShas)
  shas.current = visibleShas
  const enabled = !!info?.connected && info.apiSupported
  const key = visibleShas.join(',')
  useEffect(() => {
    if (!enabled) return
    const t = setTimeout(() => void useHosting.getState().pollCi(repo, shas.current, ciMaxAge(minutes)), 400)
    return () => clearTimeout(t)
  }, [repo, key, enabled, minutes])
  useEffect(() => {
    if (!enabled || minutes <= 0) return
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      // a little under the interval, so results from the previous tick count as stale
      void useHosting.getState().pollCi(repo, shas.current, Math.max(30, minutes * 60 - 5))
    }, minutes * 60_000)
    return () => clearInterval(id)
  }, [repo, enabled, minutes])
}

/** Load the PR list when shown, then refresh it on the auto-fetch cadence (at most every 2 minutes). */
export function usePullRequests(repo: string, active: boolean): PrState | undefined {
  const info = useRepoHosting(repo)
  const minutes = useStore((s) => s.prefs.autoFetchMinutes)
  const state = useHosting((s) => s.prs[repo])
  const connected = !!info?.connected
  useEffect(() => {
    if (!active || !connected) return
    const st = useHosting.getState().prs[repo]
    if (!st || Date.now() - st.at > 60_000) void useHosting.getState().loadPrs(repo)
    if (minutes <= 0) return
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') void useHosting.getState().loadPrs(repo)
    }, Math.max(2, minutes) * 60_000)
    return () => clearInterval(id)
  }, [repo, active, connected, minutes])
  return state
}

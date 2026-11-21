// Loading older commits through the store, against a fake git bridge: refreshes keep the loaded count, and a page
// never races a refresh.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Commit } from '@shared/types'

vi.mock('./terminals', () => ({ closeRepoSessions: () => undefined }))

const REPO = '/repo'
/** Commits in the fake repository, newest first */
let history: Commit[] = []
/** Log calls in order, with a way to finish each one */
let logCalls: { limit: number; finish(): void }[] = []
let holdLogs = false

function commit(i: number): Commit {
  const sig = { name: 'A', email: 'a@x', date: 1_000_000 - i }
  return { sha: `c${i}`, parents: [`c${i + 1}`], author: sig, committer: sig, summary: '', body: '', refs: [] }
}

function fakeGit() {
  const empty = { staged: [], unstaged: [], conflicted: [], headSha: 'c0' }
  return {
    status: async () => empty,
    refs: async () => [],
    stashes: async () => [],
    remotes: async () => [],
    submodules: async () => [],
    worktrees: async () => [],
    log: (_repo: string, opts: { limit: number }) =>
      new Promise<Commit[]>((resolve) => {
        // the commits as they are when git runs, not when the result lands
        const result = history.slice(0, opts.limit)
        const finish = () => resolve(result)
        logCalls.push({ limit: opts.limit, finish })
        if (!holdLogs) finish()
      })
  }
}

async function freshStore(commitLimit: number) {
  vi.resetModules()
  ;(globalThis as { window?: unknown }).window = { git: fakeGit() }
  const { useStore } = await import('./store')
  useStore.setState((s) => ({
    prefs: { ...s.prefs, commitLimit },
    repos: {
      [REPO]: {
        path: REPO,
        info: null,
        commits: [],
        historyComplete: false,
        loadingMore: false,
        refs: [],
        stashes: [],
        remotes: [],
        submodules: [],
        worktrees: [],
        status: null,
        selection: null,
        center: { kind: 'graph' },
        hiddenRefs: [],
        soloRefs: [],
        loading: true,
        error: null,
        busy: null
      }
    }
  }))
  return useStore
}

beforeEach(() => {
  history = Array.from({ length: 25 }, (_, i) => commit(i))
  logCalls = []
  holdLogs = false
})

describe('loading older commits', () => {
  it('loads pages until the root and keeps the loaded count on refresh', async () => {
    const store = await freshStore(10)
    await store.getState().refresh(REPO, { log: true })
    expect(store.getState().repos[REPO].commits).toHaveLength(10)
    expect(store.getState().repos[REPO].historyComplete).toBe(false)

    await store.getState().loadMoreCommits(REPO)
    expect(store.getState().repos[REPO].commits).toHaveLength(20)

    await store.getState().refresh(REPO, { log: true })
    expect(logCalls.at(-1)?.limit).toBe(20)
    expect(store.getState().repos[REPO].commits).toHaveLength(20)

    await store.getState().loadMoreCommits(REPO)
    const tab = store.getState().repos[REPO]
    expect(tab.commits).toHaveLength(25)
    expect(tab.historyComplete).toBe(true)
    expect(tab.loadingMore).toBe(false)

    const calls = logCalls.length
    await store.getState().loadMoreCommits(REPO)
    expect(logCalls).toHaveLength(calls)
  })

  it('lands a page after a refresh already running, never under it', async () => {
    const store = await freshStore(10)
    await store.getState().refresh(REPO, { log: true })
    holdLogs = true
    const refresh = store.getState().refresh(REPO, { log: true })
    const more = store.getState().loadMoreCommits(REPO)
    // the page waits for the refresh in flight (started with the old limit)
    expect(logCalls.map((c) => c.limit)).toEqual([10, 10])
    logCalls[1].finish()
    await refresh
    await vi.waitFor(() => expect(logCalls).toHaveLength(3))
    expect(logCalls[2].limit).toBe(20)
    logCalls[2].finish()
    await more
    expect(store.getState().repos[REPO].commits).toHaveLength(20)
  })

  it('loads until a commit is in the graph', async () => {
    history = Array.from({ length: 200 }, (_, i) => commit(i))
    const store = await freshStore(10)
    await store.getState().refresh(REPO, { log: true })
    expect(await store.getState().loadCommitsUntil('c150', REPO)).toBe(true)
    // doubling: 20, 40, 80, 160
    expect(logCalls.slice(1).map((c) => c.limit)).toEqual([20, 40, 80, 160])
    expect(await store.getState().loadCommitsUntil('missing', REPO)).toBe(false)
    expect(store.getState().repos[REPO].historyComplete).toBe(true)
  })
})

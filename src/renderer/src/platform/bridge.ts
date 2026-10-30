// Installs window.git, window.app, window.ai and window.term on top of Tauri IPC. Must be imported before any UI module.
// Every git/app call goes through one allowlisted dispatcher in the Rust backend (src-tauri/src/lib.rs).
import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { IntegrationsApi } from '@shared/integrations'
import { DEFAULT_PREFERENCES, IPC, type AiApi, type AppApi, type AppState, type GitApi, type Preferences, type TerminalApi } from '@shared/types'

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    // Rust errors arrive as plain strings; callers expect Error objects with the git message intact
    throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e))
  }
}

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  return disposable(listen<T>(event, (e) => cb(e.payload)))
}

/** Sync unsubscribe for an async listener registration. */
function disposable(registration: Promise<() => void>): () => void {
  let unlisten: (() => void) | null = null
  let disposed = false
  void registration.then((u) => {
    if (disposed) u()
    else unlisten = u
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

/** Every GitApi method; typed as a Record so adding a method to the contract fails compilation until listed here. */
const GIT_METHODS: Record<keyof GitApi, true> = {
  open: true, init: true, clone: true, log: true, refs: true, stashes: true, remotes: true, submodules: true,
  worktrees: true, status: true, commitDetail: true, compareCommits: true, diff: true, fileContent: true, blame: true, fileHistory: true,
  imageBlob: true,
  searchCommits: true, searchLog: true, repoSummary: true, commitStats: true, conflict: true, stage: true, unstage: true, stageAll: true,
  unstageAll: true, discard: true, applyPatch: true, resolveConflict: true, takeSide: true, ignore: true,
  commit: true, headMessage: true, commitTemplate: true, recentAuthors: true, testSigning: true, signatureStatus: true,
  headDiff: true, unsetConfig: true, createBranch: true, deleteBranch: true, deleteRemoteBranch: true,
  renameBranch: true, checkout: true, checkoutRemote: true, setUpstream: true, createTag: true, deleteTag: true,
  pushTag: true, deleteRemoteTag: true, merge: true, rebase: true, interactiveRebase: true, cherryPick: true,
  revert: true, reset: true, continueOperation: true, abortOperation: true, skipOperation: true, stashSave: true,
  stashApply: true, stashPop: true, stashDrop: true, fetch: true, pull: true, push: true, addRemote: true,
  removeRemote: true, editRemote: true, submoduleUpdate: true, submoduleAdd: true, worktreeAdd: true,
  worktreeRemove: true, worktreeLock: true, worktreePrune: true, getConfig: true, setConfig: true,
  gitflowInit: true, gitflowConfig: true, gitflowStart: true, gitflowFinish: true, lfsInstalled: true,
  lfsTrack: true, lfsCommand: true, smartStatus: true, pendingDiff: true, compareBranch: true, prTemplate: true, commitPatches: true,
  createPullRequest: true, reflog: true, resolveRef: true, countCommits: true, branchImpact: true,
  discardImpact: true, snapshot: true, applySnapshot: true, stashStore: true, undoStashPop: true, restoreBranch: true,
  backupFiles: true, restoreFiles: true, pushSha: true, watch: true, unwatch: true
}

const git = Object.fromEntries(
  Object.keys(GIT_METHODS).map((method) => [method, (...args: unknown[]) => call('git_call', { method, args })])
) as unknown as GitApi

const appCall = <T>(method: string, ...args: unknown[]) => call<T>('app_call', { method, args })

// Preference defaults and allowed keys live in the shared contract; the backend stores whatever it is given.
const withDefaults = (prefs: Partial<Preferences>): Preferences => ({ ...DEFAULT_PREFERENCES, ...prefs })
const knownPrefs = (prefs: Partial<Preferences>) =>
  Object.fromEntries(Object.entries(prefs).filter(([k]) => k in DEFAULT_PREFERENCES)) as Partial<Preferences>

function detectPlatform(): string {
  const injected = (window as { __KC_PLATFORM__?: string }).__KC_PLATFORM__
  if (injected) return injected
  const ua = navigator.userAgent
  return /Mac/.test(ua) ? 'darwin' : /Win/.test(ua) ? 'win32' : 'linux'
}

const app: AppApi = {
  async getState() {
    const s = await appCall<AppState>('getState')
    return { ...s, preferences: withDefaults(knownPrefs(s.preferences)) }
  },
  setOpenTabs: (tabs, active) => appCall('setOpenTabs', tabs, active),
  addRecent: (path) => appCall('addRecent', path),
  toggleFavorite: (path) => appCall('toggleFavorite', path),
  removeRecent: (path) => appCall('removeRecent', path),
  async setPreferences(prefs) {
    return withDefaults(knownPrefs(await appCall<Partial<Preferences>>('setPreferences', knownPrefs(prefs))))
  },
  pickDirectory: (title) => appCall('pickDirectory', title),
  openExternal: (url) => appCall('openExternal', url),
  showInFolder: (path) => appCall('showInFolder', path),
  openInEditor: (repo, file, line) => appCall('openInEditor', repo, file, line),
  openTerminal: (repo) => appCall('openTerminal', repo),
  setWorkspaces: (workspaces) => appCall('setWorkspaces', workspaces),
  takeOpenRequests: () => appCall('takeOpenRequests'),
  discoverRepos: (dirs) => appCall('discoverRepos', dirs),
  onOpenRequests: (cb) => subscribe<null>(IPC.openRequests, () => cb()),
  cliStatus: () => appCall('cliStatus'),
  installCli: () => appCall('installCli'),
  onRepoChanged: (cb) => subscribe<string>(IPC.repoChanged, cb),
  onProgress: (cb) => subscribe(IPC.progress, cb),
  onCommand: (cb) => subscribe<string>(IPC.command, cb),
  onFullscreenChange(cb) {
    // entering and leaving native fullscreen both resize the window
    const win = getCurrentWindow()
    let last: boolean | null = null
    const check = () =>
      void win.isFullscreen().then((full) => {
        if (full !== last) cb((last = full))
      })
    check()
    return disposable(win.onResized(check))
  },
  platform: detectPlatform()
}

const aiCall = <T>(method: string, ...args: unknown[]) => call<T>('ai_call', { method, args })

const ai: AiApi = {
  status: () => aiCall('status'),
  update: (settings, secrets) => aiCall('update', settings ?? null, secrets ?? null),
  complete: (prompt, maxTokens) => aiCall('complete', prompt, maxTokens ?? null),
  verify: (credential, secret) => aiCall('verify', credential, secret ?? null)
}

type TermEvent = { kind: 'data'; data: string } | { kind: 'exit'; code: number }
const dataListeners = new Set<(id: string, data: string) => void>()
const exitListeners = new Set<(id: string, exitCode: number) => void>()

const term: TerminalApi = {
  async create(cwd, cols, rows) {
    // The id is chosen here so output that arrives before create() resolves is already attributed.
    const id = crypto.randomUUID()
    const onEvent = new Channel<TermEvent>()
    onEvent.onmessage = (e) => {
      if (e.kind === 'data') for (const cb of dataListeners) cb(id, e.data)
      else for (const cb of exitListeners) cb(id, e.code)
    }
    await call('term_create', { id, cwd, cols, rows, onEvent })
    return id
  },
  write: (id, data) => call('term_write', { id, data }),
  resize: (id, cols, rows) => call('term_resize', { id, cols, rows }),
  kill: (id) => call('term_kill', { id }),
  onData(cb) {
    dataListeners.add(cb)
    return () => dataListeners.delete(cb)
  },
  onExit(cb) {
    exitListeners.add(cb)
    return () => exitListeners.delete(cb)
  }
}

const hostingCall = <T>(method: string, ...args: unknown[]) => call<T>('integrations_call', { method, args })

const integrations: IntegrationsApi = {
  accounts: () => hostingCall('accounts'),
  saveHost: (config) => hostingCall('saveHost', config),
  removeHost: (host) => hostingCall('removeHost', host),
  setToken: (host, token) => hostingCall('setToken', host, token),
  test: (host) => hostingCall('test', host),
  repoInfo: (repo, remote) => hostingCall('repoInfo', repo, remote ?? null),
  pullRequests: (repo, remote) => hostingCall('pullRequests', repo, remote ?? null),
  reviewerSuggestions: (repo, remote) => hostingCall('reviewerSuggestions', repo, remote ?? null),
  createPullRequest: (repo, input) => hostingCall('createPullRequest', repo, input),
  checkoutPullRequest: (repo, remote, number, headBranch, sameRepo) => hostingCall('checkoutPullRequest', repo, remote, number, headBranch, sameRepo),
  fetchPullRequest: (repo, remote, number, headBranch, sameRepo, baseBranch) =>
    hostingCall('fetchPullRequest', repo, remote, number, headBranch, sameRepo, baseBranch),
  ciStatuses: (repo, remote, shas, maxAgeSecs) => hostingCall('ciStatuses', repo, remote, shas, maxAgeSecs)
}

window.git = git
window.app = app
window.ai = ai
window.term = term
window.integrations = integrations

import { create } from 'zustand'
import type {
  Commit,
  DiffTarget,
  Preferences,
  RecentRepo,
  Ref,
  Remote,
  RepoInfo,
  Stash,
  Submodule,
  WorkingStatus,
  Workspace,
  Worktree
} from '@shared/types'
import { DEFAULT_PREFERENCES } from '@shared/types'
import { closeRepoSessions } from './terminals'
import { clearProgress } from './progress'

export type Selection =
  | { kind: 'wip' }
  | { kind: 'commit'; shas: string[] }
  | { kind: 'stash'; index: number }
  /** Uncommitted changes of another worktree (its WIP row in the graph) */
  | { kind: 'worktree'; path: string }
  | null

/** What the center area shows. The graph is the default; others open on top of it. */
export type CenterView =
  | { kind: 'graph' }
  /** `cwd` reads the diff from another worktree (read-only) instead of this repo */
  | { kind: 'diff'; target: DiffTarget; cwd?: string }
  | { kind: 'conflict'; path: string }
  | { kind: 'rebase'; onto: string; shas: string[] }
  | { kind: 'history'; path: string; blame: boolean }
  /** HEAD reflog, for recovering lost commits */
  | { kind: 'reflog' }
  /** Two revisions (branch names or shas) side by side: what `to` changes and adds compared to `from` */
  | { kind: 'compare'; from: string; to: string }

export interface RepoTab {
  path: string
  info: RepoInfo | null
  commits: Commit[]
  refs: Ref[]
  stashes: Stash[]
  remotes: Remote[]
  submodules: Submodule[]
  worktrees: Worktree[]
  status: WorkingStatus | null
  selection: Selection
  center: CenterView
  /** Full ref names hidden from the graph */
  hiddenRefs: string[]
  /** Full ref names soloed in the graph (empty = show all) */
  soloRefs: string[]
  loading: boolean
  error: string | null
  /** Label of the git operation currently running, e.g. "Pushing" */
  busy: string | null
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  title: string
  message?: string
  /** A button on the toast, e.g. Undo */
  action?: { label: string; run(): void }
  /** More buttons after `action`, e.g. the fixes for a git error (util/gitErrors.ts) */
  actions?: { label: string; run(): void }[]
  /** Raw text under the message (git's own error output), in a smaller monospace block */
  detail?: string
  /** Milliseconds before it hides (default 4s, 8s for errors) */
  duration?: number
}

export type ModalState =
  | null
  /** `section` opens Preferences on a given page */
  | { kind: 'preferences'; section?: 'general' | 'ui' | 'tools' | 'ai' | 'identity' | 'integrations' }
  | { kind: 'clone' }
  | { kind: 'init' }
  | { kind: 'gitflow' }
  | { kind: 'lfs' }
  | { kind: 'keybindings' }
  /** Create worktree; `ref` preselects the reference to check out */
  | { kind: 'worktree'; ref?: string }
  /** Stage, commit, push and open pull requests, with AI-written texts; `prOnly` just pushes and opens the PRs, preparing right away */
  | { kind: 'smartCommit'; prOnly?: boolean }
  /** Create a pull request through the hosting API (or open the provider's page without a token) */
  | { kind: 'createPullRequest'; head?: string; base?: string }
  /** Let the AI group all uncommitted changes into several commits, made one after another */
  | { kind: 'splitCommit' }

export const WELCOME_TAB = '__welcome__'
/** The workspace view: a table of the repositories of a workspace */
export const WORKSPACE_TAB = '__workspace__'

/** Tabs that are not a repository (never persisted, watched or reopened). */
export function isSpecialTab(path: string): boolean {
  return path === WELCOME_TAB || path === WORKSPACE_TAB
}

interface StoreState {
  ready: boolean
  tabs: string[]
  activeTab: string
  repos: Record<string, RepoTab>
  recent: RecentRepo[]
  workspaces: Workspace[]
  /** The tabs of the last session are open again (paths from the command line wait for this) */
  restored: boolean
  prefs: Preferences
  showLeftPanel: boolean
  showDetailPanel: boolean
  /** `branches` is the branch switcher */
  fuzzyFinder: null | 'commands' | 'repos' | 'history' | 'branches'
  modal: ModalState
  toasts: Toast[]

  init(): Promise<void>
  openRepo(path: string): Promise<void>
  closeTab(path: string): void
  setActiveTab(path: string): void
  /** Show the workspace tab, adding it when needed */
  openWorkspaceTab(): void
  setWorkspaces(workspaces: Workspace[]): Promise<void>
  refresh(path?: string, opts?: { log?: boolean }): Promise<void>
  select(selection: Selection, path?: string): void
  setCenter(view: CenterView, path?: string): void
  updateRepo(path: string, patch: Partial<RepoTab>): void
  toggleHidden(fullName: string): void
  toggleSolo(fullName: string): void
  setPrefs(patch: Partial<Preferences>): Promise<void>
  setModal(modal: ModalState): void
  setFuzzyFinder(mode: StoreState['fuzzyFinder']): void
  toggleLeftPanel(): void
  toggleDetailPanel(): void
  toast(t: Omit<Toast, 'id'>): void
  dismissToast(id: number): void
  /**
   * Run a git operation against the active repo (or `opts.repo`) with a busy indicator, error toast and refresh.
   * Returns true if the operation succeeded.
   */
  run(label: string, fn: (repo: string) => Promise<unknown>, opts?: { success?: string; log?: boolean; repo?: string }): Promise<boolean>
}

function emptyRepo(path: string): RepoTab {
  return {
    path,
    info: null,
    commits: [],
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

let toastId = 0

/**
 * Builds the toast of a failed `run`. actions/errorActions.ts replaces it with one that explains common git errors
 * and offers fixes (it needs the repo actions, which import this module).
 */
let errorToast: (label: string, error: Error, repo: string) => Omit<Toast, 'id'> = (label, e) => ({
  kind: 'error',
  title: `${label} failed`,
  message: e.message
})

export function setErrorToast(build: typeof errorToast) {
  errorToast = build
}

/** Record a step of the first-run guide on the welcome screen (opening a repo, the palette, the shortcuts). */
function markOnboardingStep(step: 'open' | 'palette' | 'shortcuts') {
  const { prefs, setPrefs } = useStore.getState()
  if (prefs.onboardingDone || prefs.onboardingSteps.includes(step)) return
  void setPrefs({ onboardingSteps: [...prefs.onboardingSteps, step] })
}

export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  tabs: [WELCOME_TAB],
  activeTab: WELCOME_TAB,
  repos: {},
  recent: [],
  workspaces: [],
  restored: false,
  prefs: DEFAULT_PREFERENCES,
  showLeftPanel: true,
  showDetailPanel: true,
  fuzzyFinder: null,
  modal: null,
  toasts: [],

  async init() {
    const state = await window.app.getState()
    set({ recent: state.recent, prefs: state.preferences, workspaces: state.workspaces, ready: true })
    // users of earlier versions (repositories opened, no guide step recorded) skip the first-run guide
    const p = state.preferences
    if (!p.onboardingDone && p.onboardingSteps.length === 0 && state.recent.length > 0) void get().setPrefs({ onboardingDone: true })
    if (state.preferences.rememberTabs) {
      for (const tab of state.openTabs) {
        await get().openRepo(tab).catch(() => undefined)
      }
      if (state.activeTab && get().tabs.includes(state.activeTab)) set({ activeTab: state.activeTab })
    }
    window.app.onRepoChanged((repo) => {
      if (get().repos[repo]) void get().refresh(repo, { log: true })
    })
    set({ restored: true })
  },

  async openRepo(path) {
    const existing = get().tabs.find((t) => t === path)
    if (existing) {
      set({ activeTab: existing })
      return
    }
    let info: RepoInfo
    try {
      info = await window.git.open(path)
    } catch (e) {
      get().toast({ kind: 'error', title: 'Could not open repository', message: (e as Error).message })
      throw e
    }
    // a concurrent open of the same repo (e.g. init() running twice under StrictMode) may have won the race
    if (get().tabs.includes(info.path)) {
      set({ activeTab: info.path })
      return
    }
    const tabs = get().tabs.filter((t) => t !== WELCOME_TAB).concat(info.path)
    set((s) => ({
      tabs,
      activeTab: info.path,
      repos: { ...s.repos, [info.path]: { ...emptyRepo(info.path), info } }
    }))
    const recent = await window.app.addRecent(info.path)
    set({ recent })
    markOnboardingStep('open')
    void window.app.setOpenTabs(tabs.filter((t) => !isSpecialTab(t)), info.path)
    void window.git.watch(info.path)
    await get().refresh(info.path, { log: true })
  },

  closeTab(path) {
    closeRepoSessions(path)
    const { tabs, activeTab, repos } = get()
    const idx = tabs.indexOf(path)
    let next = tabs.filter((t) => t !== path)
    if (next.length === 0) next = [WELCOME_TAB]
    const nextActive = activeTab === path ? next[Math.max(0, idx - 1)] ?? next[0] : activeTab
    const { [path]: _closed, ...rest } = repos
    if (!isSpecialTab(path)) void window.git.unwatch(path)
    set({ tabs: next, activeTab: nextActive, repos: rest })
    void window.app.setOpenTabs(next.filter((t) => !isSpecialTab(t)), isSpecialTab(nextActive) ? null : nextActive)
  },

  setActiveTab(path) {
    set({ activeTab: path })
    void window.app.setOpenTabs(get().tabs.filter((t) => !isSpecialTab(t)), isSpecialTab(path) ? null : path)
  },

  openWorkspaceTab() {
    const { tabs } = get()
    set({ tabs: tabs.includes(WORKSPACE_TAB) ? tabs : [...tabs.filter((t) => t !== WELCOME_TAB), WORKSPACE_TAB], activeTab: WORKSPACE_TAB })
  },

  async setWorkspaces(workspaces) {
    set({ workspaces })
    set({ workspaces: await window.app.setWorkspaces(workspaces) })
  },

  async refresh(path, opts = {}) {
    const repo = path ?? get().activeTab
    if (!get().repos[repo]) return
    const { prefs } = get()
    try {
      const [status, refs, stashes, remotes, submodules, worktrees, commits] = await Promise.all([
        window.git.status(repo),
        window.git.refs(repo),
        window.git.stashes(repo),
        window.git.remotes(repo),
        window.git.submodules(repo).catch(() => []),
        window.git.worktrees(repo).catch(() => []),
        opts.log || get().repos[repo].commits.length === 0
          ? window.git.log(repo, { limit: prefs.commitLimit })
          : Promise.resolve(null)
      ])
      get().updateRepo(repo, {
        status,
        refs,
        stashes,
        remotes,
        submodules,
        worktrees,
        ...(commits ? { commits } : {}),
        loading: false,
        error: null
      })
    } catch (e) {
      get().updateRepo(repo, { loading: false, error: (e as Error).message })
    }
  },

  select(selection, path) {
    const repo = path ?? get().activeTab
    get().updateRepo(repo, { selection })
  },

  setCenter(view, path) {
    const repo = path ?? get().activeTab
    get().updateRepo(repo, { center: view })
  },

  updateRepo(path, patch) {
    set((s) => (s.repos[path] ? { repos: { ...s.repos, [path]: { ...s.repos[path], ...patch } } } : s))
  },

  toggleHidden(fullName) {
    const repo = get().repos[get().activeTab]
    if (!repo) return
    const hiddenRefs = repo.hiddenRefs.includes(fullName)
      ? repo.hiddenRefs.filter((r) => r !== fullName)
      : [...repo.hiddenRefs, fullName]
    get().updateRepo(repo.path, { hiddenRefs })
  },

  toggleSolo(fullName) {
    const repo = get().repos[get().activeTab]
    if (!repo) return
    const soloRefs = repo.soloRefs.includes(fullName)
      ? repo.soloRefs.filter((r) => r !== fullName)
      : [...repo.soloRefs, fullName]
    get().updateRepo(repo.path, { soloRefs })
  },

  async setPrefs(patch) {
    // show the change right away (panel toggles, column drags); the backend's copy wins once saved
    set((s) => ({ prefs: { ...s.prefs, ...patch } }))
    const prefs = await window.app.setPreferences(patch)
    set({ prefs })
  },

  setModal(modal) {
    set({ modal })
    if (modal?.kind === 'keybindings') markOnboardingStep('shortcuts')
  },

  setFuzzyFinder(mode) {
    set({ fuzzyFinder: mode })
    if (mode === 'commands') markOnboardingStep('palette')
  },

  toggleLeftPanel() {
    set((s) => ({ showLeftPanel: !s.showLeftPanel }))
  },

  toggleDetailPanel() {
    set((s) => ({ showDetailPanel: !s.showDetailPanel }))
  },

  toast(t) {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    // errors with fixes to pick from stay longer; a toast under the pointer or holding the focus waits
    const expire = () => {
      if (document.querySelector(`[data-toast="${id}"]:is(:hover, :focus-within)`)) return void setTimeout(expire, 2000)
      get().dismissToast(id)
    }
    setTimeout(expire, t.duration ?? (t.kind === 'error' ? (t.actions?.length ? 15_000 : 8000) : 4000))
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  async run(label, fn, opts = {}) {
    const repo = opts.repo ?? get().activeTab
    if (!get().repos[repo]) return false
    get().updateRepo(repo, { busy: label })
    // progress of an earlier operation (or of an auto-fetch) must not show under this label
    clearProgress(repo)
    try {
      await fn(repo)
      if (opts.success) get().toast({ kind: 'success', title: opts.success })
      return true
    } catch (e) {
      get().toast(errorToast(label, e instanceof Error ? e : new Error(String(e)), repo))
      return false
    } finally {
      get().updateRepo(repo, { busy: null })
      clearProgress(repo)
      await get().refresh(repo, { log: opts.log ?? true })
    }
  }
}))

/** The active repo tab, or null when the welcome tab is active. */
export function useActiveRepo(): RepoTab | null {
  return useStore((s) => s.repos[s.activeTab] ?? null)
}

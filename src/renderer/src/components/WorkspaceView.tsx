// Workspace tab: the repositories of a named workspace side by side, with their branch, distance from the upstream and
// uncommitted changes, polled on the auto-fetch interval. Fetch all, pull all (clean repositories only), open as a tab.
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { RepoSummary, Workspace } from '@shared/types'
import { useStore } from '../state/store'
import { describeSkipped, mapLimit, pullPlan, validateWorkspaceName, workspaceStats } from '../state/workspace'
import { Icon, type IconName } from '../ui/Icon'
import { RepoAvatar } from '../ui/RepoAvatar'
import { showContextMenu } from '../ui/ContextMenu'
import { confirm, prompt } from '../ui/dialogs'
import { basename } from '../util/format'
import { describeGitError } from '../util/gitErrors'
import { shortPath } from '../util/welcome'
import '../styles/detail.css'
import '../styles/home.css'
import '../styles/workspace.css'

/** Repositories fetched or pulled at the same time */
const PARALLEL = 4
const ACTIVE_KEY = 'kc.workspace.active'

interface RowState {
  summary?: RepoSummary
  /** Status could not be read */
  error?: string
  /** The last fetch failed (kept until one succeeds) */
  failed?: string
  /** Running operation, e.g. "Fetching" */
  busy?: string
}

function rememberedName(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

function remember(name: string) {
  try {
    localStorage.setItem(ACTIVE_KEY, name)
  } catch {
    // only a convenience
  }
}

export function WorkspaceView() {
  const workspaces = useStore((s) => s.workspaces)
  const minutes = useStore((s) => s.prefs.autoFetchMinutes)
  const { setWorkspaces, openRepo, toast } = useStore.getState()
  const [activeName, setActiveName] = useState<string | null>(rememberedName)
  const workspace = workspaces.find((w) => w.name === activeName) ?? workspaces[0] ?? null
  const [rows, setRows] = useState<Record<string, RowState>>({})
  const [bulk, setBulk] = useState<string | null>(null)

  const select = (name: string) => {
    setActiveName(name)
    remember(name)
  }

  const patchRow = useCallback((path: string, patch: RowState) => setRows((r) => ({ ...r, [path]: { ...r[path], ...patch } })), [])

  const poll = useCallback(
    async (path: string): Promise<RepoSummary | undefined> => {
      try {
        const summary = await window.git.repoSummary(path)
        patchRow(path, { summary, error: undefined })
        return summary
      } catch (e) {
        patchRow(path, { summary: undefined, error: (e as Error).message })
        return undefined
      }
    },
    [patchRow]
  )

  const repos = useMemo(() => workspace?.repos ?? [], [workspace])
  const pollAll = useCallback(() => void Promise.all(repos.map(poll)), [repos, poll])

  // light status of every repository now and on the auto-fetch interval (without fetching)
  useEffect(() => {
    pollAll()
    if (!minutes || minutes <= 0) return
    const id = setInterval(pollAll, minutes * 60_000)
    return () => clearInterval(id)
  }, [pollAll, minutes])

  const save = async (next: Workspace[]) => {
    try {
      await setWorkspaces(next)
    } catch (e) {
      toast({ kind: 'error', title: 'Could not save workspaces', message: (e as Error).message })
    }
  }

  const updateRepos = (fn: (repos: string[]) => string[]) => {
    if (!workspace) return
    void save(workspaces.map((w) => (w === workspace ? { ...w, repos: fn(w.repos) } : w)))
  }

  const createWorkspace = async () => {
    const openTabs = useStore.getState().tabs.filter((t) => useStore.getState().repos[t])
    const res = await prompt({
      title: 'New workspace',
      fields: [{ name: 'name', label: 'Name', placeholder: 'Work', validate: (v) => validateWorkspaceName(v, workspaces) }],
      checkboxes: openTabs.length ? [{ name: 'tabs', label: `Add the ${openTabs.length} open repositor${openTabs.length === 1 ? 'y' : 'ies'}`, initial: true }] : [],
      confirmLabel: 'Create'
    })
    if (!res) return
    const name = res.name.trim()
    await save([...workspaces, { name, repos: res.checks.tabs ? openTabs : [] }])
    select(name)
  }

  const renameWorkspace = async () => {
    if (!workspace) return
    const res = await prompt({
      title: `Rename ${workspace.name}`,
      fields: [{ name: 'name', label: 'Name', initial: workspace.name, validate: (v) => validateWorkspaceName(v, workspaces, workspace.name) }],
      confirmLabel: 'Rename'
    })
    if (!res || res.name.trim() === workspace.name) return
    const name = res.name.trim()
    await save(workspaces.map((w) => (w === workspace ? { ...w, name } : w)))
    select(name)
  }

  const deleteWorkspace = async () => {
    if (!workspace) return
    const ok = await confirm(`Delete workspace ${workspace.name}?`, 'Only the list goes away; the repositories are not touched.', { danger: true, confirmLabel: 'Delete' })
    if (ok) await save(workspaces.filter((w) => w !== workspace))
  }

  const addRepository = async () => {
    const dir = await window.app.pickDirectory('Add repository to workspace')
    if (!dir) return
    try {
      const info = await window.git.open(dir)
      updateRepos((r) => (r.includes(info.path) ? r : [...r, info.path]))
      void poll(info.path)
    } catch (e) {
      toast({ kind: 'error', title: 'Not a repository', message: (e as Error).message })
    }
  }

  const addOpenTabs = () => {
    const open = useStore.getState().tabs.filter((t) => useStore.getState().repos[t])
    updateRepos((r) => [...r, ...open.filter((p) => !r.includes(p))])
  }

  /** Refresh a repository that is also open as a tab, so its graph follows. */
  const refreshTab = (path: string) => {
    if (useStore.getState().repos[path]) void useStore.getState().refresh(path, { log: true })
  }

  const fetchOne = async (path: string): Promise<boolean> => {
    patchRow(path, { busy: 'Fetching' })
    try {
      await window.git.fetch(path, undefined, true)
      patchRow(path, { failed: undefined })
      refreshTab(path)
      return true
    } catch (e) {
      patchRow(path, { failed: `Fetch failed: ${(e as Error).message}` })
      return false
    } finally {
      patchRow(path, { busy: undefined })
      await poll(path)
    }
  }

  const pullOne = async (path: string): Promise<boolean> => {
    patchRow(path, { busy: 'Pulling' })
    try {
      await window.git.pull(path, 'ff-only')
      refreshTab(path)
      return true
    } catch (e) {
      // explained like other git errors; the fixes need the repository open in a tab, so none are offered here
      const raw = (e as Error).message
      const hint = describeGitError(raw, 'Pulling')
      toast({ kind: 'error', title: `Pull failed in ${basename(path)}`, message: hint?.message ?? raw, detail: hint ? raw : undefined })
      return false
    } finally {
      patchRow(path, { busy: undefined })
      await poll(path)
    }
  }

  const fetchAll = async () => {
    setBulk('Fetching')
    const results = await mapLimit(repos, PARALLEL, fetchOne)
    setBulk(null)
    const failed = results.filter((ok) => !ok).length
    if (failed) toast({ kind: 'error', title: `Fetch failed in ${failed} of ${repos.length} repositories`, message: 'Hover a row for the error.' })
    else toast({ kind: 'success', title: `Fetched ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}` })
  }

  const pullAll = async () => {
    setBulk('Pulling')
    // decide on fresh statuses, not on what the last poll saw
    const fresh = await Promise.all(repos.map(poll))
    const summaries = Object.fromEntries(repos.map((p, i) => [p, fresh[i]]))
    const plan = pullPlan(repos, summaries)
    const results = await mapLimit(plan.pull, PARALLEL, pullOne)
    setBulk(null)
    const pulled = results.filter(Boolean).length
    const skipped = describeSkipped(plan.skipped)
    toast({
      kind: pulled || !plan.pull.length ? 'success' : 'error',
      title: plan.pull.length ? `Pulled ${pulled} of ${plan.pull.length} repositor${plan.pull.length === 1 ? 'y' : 'ies'} behind` : 'Nothing to pull',
      message: skipped ? `Skipped ${skipped}.` : undefined
    })
  }

  const rowMenu = (e: MouseEvent, path: string) =>
    showContextMenu(e, [
      { label: 'Open', onClick: () => void openRepo(path).catch(() => undefined) },
      { label: 'Fetch', onClick: () => void fetchOne(path) },
      { label: 'Pull (fast-forward only)', onClick: () => void pullOne(path) },
      'separator',
      { label: 'Show in folder', onClick: () => void window.app.showInFolder(path) },
      { label: 'Copy path', onClick: () => void navigator.clipboard.writeText(path) },
      'separator',
      { label: 'Remove from workspace', danger: true, onClick: () => updateRepos((r) => r.filter((p) => p !== path)) }
    ])

  const workspaceMenu = (e: MouseEvent) =>
    showContextMenu(e, [
      ...workspaces.map((w) => ({ label: `${w === workspace ? '✓ ' : ' '}${w.name}`, onClick: () => select(w.name) })),
      'separator',
      { label: 'New workspace…', onClick: () => void createWorkspace() },
      { label: 'Rename…', disabled: !workspace, onClick: () => void renameWorkspace() },
      { label: 'Delete', danger: true, disabled: !workspace, onClick: () => void deleteWorkspace() }
    ])

  if (!workspace) {
    return (
      <div className="workspace home-page">
        <div className="home-inner ws-intro">
          <span className="icon-tile xl">
            <Icon name="layers" size={24} />
          </span>
          <h1 className="home-title">Workspaces</h1>
          <p className="ws-intro-text">Group repositories you work on together: see their branches and changes at a glance, fetch or pull them all at once.</p>
          <div className="ws-intro-points">
            <span><Icon name="branch" size={13} /> Branch and ahead/behind of each repository</span>
            <span><Icon name="fetch" size={13} /> Fetch every repository in one click</span>
            <span><Icon name="pull" size={13} /> Fast-forward the clean ones that are behind</span>
          </div>
          <button className="btn primary ws-intro-btn" onClick={() => void createWorkspace()}>
            <Icon name="plus" size={13} /> New workspace…
          </button>
        </div>
      </div>
    )
  }

  const busy = bulk !== null
  const stats = workspaceStats(repos, Object.fromEntries(repos.map((p) => [p, rows[p]?.summary])))
  const loading = repos.length > 0 && stats.known < repos.length && repos.some((p) => !rows[p]?.summary && !rows[p]?.error)
  return (
    <div className="workspace home-page">
      <div className="home-inner">
        <header className="home-hero">
          <span className="icon-tile xl">
            <Icon name="layers" size={24} />
          </span>
          <div className="home-hero-text">
            <div className="home-eyebrow">Workspace</div>
            <h1 className="home-title" title={workspace.name}>
              {workspace.name}
            </h1>
          </div>
          <span className="grow" />
          <button className="icon-btn home-hero-btn" title="Refresh status" aria-label="Refresh status" onClick={pollAll}>
            <Icon name="refresh" size={16} />
          </button>
          <button className="icon-btn home-hero-btn" title="Switch, create, rename or delete workspaces" aria-label="Workspace options" onClick={workspaceMenu}>
            <Icon name="dots" size={16} />
          </button>
        </header>

        <div className="ws-switcher" role="tablist" aria-label="Workspaces">
          {workspaces.map((w) => (
            <button
              key={w.name}
              role="tab"
              aria-selected={w === workspace}
              className={`ws-chip ${w === workspace ? 'on' : ''}`}
              onClick={() => select(w.name)}
              onContextMenu={(e) => {
                select(w.name)
                workspaceMenu(e)
              }}
            >
              <span className="ellipsis">{w.name}</span>
              <span className="ws-chip-count">{w.repos.length}</span>
            </button>
          ))}
          <button className="ws-chip ws-chip-new" onClick={() => void createWorkspace()} title="New workspace">
            <Icon name="plus" size={12} /> New
          </button>
        </div>

        <div className="ws-stats">
          <Stat icon="layers" label="Repositories" value={repos.length} />
          <Stat icon="arrow-down" label="Behind upstream" value={stats.behind} tone={stats.behind ? 'warning' : undefined} />
          <Stat icon="arrow-up" label="Ahead of upstream" value={stats.ahead} tone={stats.ahead ? 'accent' : undefined} />
          <Stat
            icon={stats.attention ? 'warning' : 'edit'}
            label={stats.attention ? `With changes · ${stats.attention} need${stats.attention === 1 ? 's' : ''} attention` : 'With changes'}
            value={stats.dirty}
            tone={stats.attention ? 'danger' : stats.dirty ? 'warning' : undefined}
          />
        </div>

        <div className="ws-toolbar">
          <h2 className="home-heading">Repositories</h2>
          {loading && <span className="spinner small" aria-label="Loading status" />}
          <span className="grow" />
          <button className="btn ghost small" onClick={() => void addRepository()}>
            <Icon name="plus" size={12} /> Add repository…
          </button>
          <button className="btn ghost small" title="Add every repository open in a tab" onClick={addOpenTabs}>
            <Icon name="list" size={12} /> Add open tabs
          </button>
          <button className="btn small" disabled={busy || !repos.length} onClick={() => void fetchAll()}>
            <Icon name="fetch" size={12} /> {bulk === 'Fetching' ? 'Fetching…' : 'Fetch all'}
          </button>
          <button
            className="btn primary small"
            disabled={busy || !repos.length}
            title="Fast-forward every clean repository that is behind its upstream"
            onClick={() => void pullAll()}
          >
            <Icon name="pull" size={12} /> {bulk === 'Pulling' ? 'Pulling…' : 'Pull all'}
          </button>
        </div>

        {repos.length === 0 ? (
          <div className="home-empty home-empty-big">
            <span className="icon-tile">
              <Icon name="folder" size={18} />
            </span>
            <div>This workspace is empty.</div>
            <div className="ws-empty-actions">
              <button className="btn small" onClick={() => void addRepository()}>
                <Icon name="plus" size={12} /> Add repository…
              </button>
              <button className="btn small" onClick={addOpenTabs}>
                Add open tabs
              </button>
            </div>
          </div>
        ) : (
          <div className="home-list">
            {repos.map((path) => {
              const row = rows[path] ?? {}
              const s = row.summary
              const name = basename(path)
              return (
                <div key={path} className="ws-row" onDoubleClick={() => void openRepo(path).catch(() => undefined)} onContextMenu={(e) => rowMenu(e, path)}>
                  <RepoAvatar name={name} path={path} />
                  <span className="ws-repo" title={path}>
                    <span className="ellipsis ws-name">{name}</span>
                    <span className="ellipsis ws-path">{shortPath(path)}</span>
                  </span>
                  <span className="ws-cells">
                    <span className="ws-cell">
                      {!s && row.error && (
                        <span className="ws-pill danger" title={row.error}>
                          <Icon name="warning" size={11} /> status unavailable
                        </span>
                      )}
                      {s && (
                        <span className="ws-pill ws-branch" title={s.upstream ? `Tracking ${s.upstream}` : 'No upstream branch'}>
                          <Icon name="branch" size={11} />
                          <span className="ellipsis">{s.detached ? `detached at ${s.headSha?.slice(0, 7) ?? '?'}` : s.branch}</span>
                        </span>
                      )}
                      {s?.operation && <span className="ws-pill danger">{s.operation}</span>}
                    </span>
                    <span className="ws-cell">
                      {s?.upstream ? (
                        s.ahead || s.behind ? (
                          <span className="ws-pill mono" title={`${s.ahead} ahead, ${s.behind} behind ${s.upstream}`}>
                            <span className={s.ahead ? 'ws-ahead' : 'ws-zero'}>↑{s.ahead}</span>
                            <span className={s.behind ? 'ws-behind' : 'ws-zero'}>↓{s.behind}</span>
                          </span>
                        ) : (
                          <span className="ws-pill subtle" title={`Up to date with ${s.upstream}`}>
                            <Icon name="check" size={11} /> synced
                          </span>
                        )
                      ) : (
                        s && <span className="ws-pill subtle">no upstream</span>
                      )}
                    </span>
                    <span className="ws-cell">
                      {s &&
                        (s.conflicted ? (
                          <span className="ws-pill danger">
                            <Icon name="warning" size={11} /> {s.conflicted} conflicted
                          </span>
                        ) : s.changes ? (
                          <span className="ws-pill warning">
                            <Icon name="edit" size={11} /> {s.changes} change{s.changes === 1 ? '' : 's'}
                          </span>
                        ) : (
                          <span className="ws-pill success">
                            <Icon name="check" size={11} /> clean
                          </span>
                        ))}
                    </span>
                  </span>
                  <span className="ws-actions">
                    {row.busy && (
                      <span className="ws-busy">
                        <span className="spinner small" /> {row.busy}…
                      </span>
                    )}
                    {!row.busy && row.failed && (
                      <span className="ws-error" title={row.failed}>
                        <Icon name="warning" size={13} />
                      </span>
                    )}
                    {!row.summary && !row.error && !row.busy && <span className="spinner small" />}
                    <button className="btn small ws-open" onClick={() => void openRepo(path).catch(() => undefined)}>
                      Open
                    </button>
                    <button className="icon-btn" title="More" aria-label={`More actions for ${name}`} onClick={(e) => rowMenu(e, path)}>
                      <Icon name="dots" size={13} />
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ icon, label, value, tone }: { icon: IconName; label: string; value: number; tone?: 'accent' | 'warning' | 'danger' }) {
  return (
    <div className={`ws-stat ${tone ?? ''}`}>
      <span className="ws-stat-icon">
        <Icon name={icon} size={15} />
      </span>
      <div className="ws-stat-text">
        <div className="ws-stat-value">{value}</div>
        <div className="ws-stat-label">{label}</div>
      </div>
    </div>
  )
}

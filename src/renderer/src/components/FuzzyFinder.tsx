import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { COMMANDS } from '@shared/commands'
import { useStore, type RepoTab } from '../state/store'
import { Icon, type IconName } from '../ui/Icon'
import { checkoutRef, remoteBranchName } from '../actions/refActions'
import { dispatch, shortcutFor } from '../keybindings'
import { fuzzyFilter } from '../util/fuzzy'
import { relativeTime } from '../util/format'
import { validateRefName } from '../ui/dialogs'
import '../styles/shell.css'

interface PaletteItem {
  id: string
  label: string
  detail?: string
  icon: IconName
  run(): void
}

const COMMAND_LABELS: { command: string; label: string; icon: IconName; needsRepo?: boolean }[] = [
  { command: COMMANDS.fetch, label: 'Fetch all remotes', icon: 'fetch', needsRepo: true },
  { command: COMMANDS.pull, label: 'Pull', icon: 'pull', needsRepo: true },
  { command: COMMANDS.pullRebase, label: 'Pull (rebase)', icon: 'pull', needsRepo: true },
  { command: COMMANDS.push, label: 'Push', icon: 'push', needsRepo: true },
  { command: COMMANDS.switchBranch, label: 'Switch branch…', icon: 'branch', needsRepo: true },
  { command: COMMANDS.createBranch, label: 'Create branch', icon: 'branch', needsRepo: true },
  { command: COMMANDS.stash, label: 'Stash changes', icon: 'stash', needsRepo: true },
  { command: COMMANDS.popStash, label: 'Pop stash', icon: 'stash', needsRepo: true },
  { command: COMMANDS.stageAll, label: 'Stage all changes', icon: 'plus', needsRepo: true },
  { command: COMMANDS.unstageAll, label: 'Unstage all changes', icon: 'minus', needsRepo: true },
  { command: COMMANDS.focusChangedFiles, label: 'Focus changed files', icon: 'file', needsRepo: true },
  { command: COMMANDS.focusCommitMessage, label: 'Focus commit message', icon: 'edit', needsRepo: true },
  { command: COMMANDS.generateCommitMessage, label: 'Write commit message with AI', icon: 'sparkle', needsRepo: true },
  { command: COMMANDS.smartCommit, label: 'Smart commit & pull request…', icon: 'pull-request', needsRepo: true },
  { command: COMMANDS.splitCommit, label: 'Split changes into commits with AI…', icon: 'sparkle', needsRepo: true },
  { command: COMMANDS.createPullRequest, label: 'Create pull request…', icon: 'pull-request', needsRepo: true },
  { command: COMMANDS.searchCommits, label: 'Search commits', icon: 'search', needsRepo: true },
  { command: COMMANDS.fuzzyHistory, label: 'View file history / blame', icon: 'history', needsRepo: true },
  { command: COMMANDS.undo, label: 'Undo last destructive action', icon: 'undo', needsRepo: true },
  { command: COMMANDS.showReflog, label: 'Recovery / reflog', icon: 'undo', needsRepo: true },
  { command: COMMANDS.compareWithDefault, label: 'Compare current branch with default branch', icon: 'compare', needsRepo: true },
  { command: COMMANDS.openInEditor, label: 'Open repository in external editor', icon: 'external', needsRepo: true },
  { command: COMMANDS.openTerminal, label: 'Open terminal', icon: 'terminal', needsRepo: true },
  { command: COMMANDS.showInFolder, label: 'Show repository in folder', icon: 'folder', needsRepo: true },
  { command: COMMANDS.refresh, label: 'Refresh', icon: 'refresh', needsRepo: true },
  { command: COMMANDS.openRepo, label: 'Open repository…', icon: 'folder' },
  { command: COMMANDS.fuzzyOpenRepo, label: 'Open recent repository', icon: 'history' },
  { command: COMMANDS.openWorkspace, label: 'Open workspace', icon: 'layers' },
  { command: COMMANDS.cloneRepo, label: 'Clone repository…', icon: 'fetch' },
  { command: COMMANDS.initRepo, label: 'Initialize repository…', icon: 'plus' },
  { command: COMMANDS.newTab, label: 'New tab', icon: 'plus' },
  { command: COMMANDS.closeTab, label: 'Close tab', icon: 'x' },
  { command: COMMANDS.reopenTab, label: 'Reopen closed tab', icon: 'undo' },
  { command: COMMANDS.toggleLeftPanel, label: 'Toggle left panel', icon: 'chevron-right' },
  { command: COMMANDS.toggleDetailPanel, label: 'Toggle detail panel', icon: 'chevron-right' },
  { command: COMMANDS.toggleKeyBindings, label: 'Keyboard shortcuts', icon: 'dots' },
  { command: COMMANDS.preferences, label: 'Preferences', icon: 'settings' }
]

function commandItems(repo: RepoTab | null): PaletteItem[] {
  const items: PaletteItem[] = COMMAND_LABELS.filter((c) => !c.needsRepo || repo).map((c) => ({
    id: c.command,
    label: c.label,
    detail: shortcutFor(c.command),
    icon: c.icon,
    run: () => dispatch(c.command)
  }))
  if (repo) {
    for (const ref of repo.refs) {
      if ((ref.type !== 'local' && ref.type !== 'remote') || ref.isHead || ref.name.endsWith('/HEAD')) continue
      items.push({ id: `checkout:${ref.fullName}`, label: `Checkout ${ref.name}`, icon: ref.type === 'remote' ? 'remote' : 'branch', run: () => void checkoutRef(repo, ref) })
    }
  }
  for (const r of useStore.getState().recent) {
    items.push({ id: `open:${r.path}`, label: `Open ${r.name}`, detail: r.path, icon: 'folder', run: () => void useStore.getState().openRepo(r.path).catch(() => undefined) })
  }
  return items
}

function repoItems(): PaletteItem[] {
  return useStore
    .getState()
    .recent.slice()
    .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || b.lastOpened - a.lastOpened)
    .map((r) => ({ id: r.path, label: r.name, detail: r.path, icon: r.favorite ? 'star' : 'folder', run: () => void useStore.getState().openRepo(r.path).catch(() => undefined) }))
}

function historyItems(repo: RepoTab | null, query: string): PaletteItem[] {
  if (!repo) return []
  const s = useStore.getState()
  const open = (path: string, blame: boolean) => () => s.setCenter({ kind: 'history', path, blame }, repo.path)
  const paths = new Set<string>()
  for (const f of [...(repo.status?.unstaged ?? []), ...(repo.status?.staged ?? []), ...(repo.status?.conflicted ?? [])]) paths.add(f.path)
  const items: PaletteItem[] = []
  const typed = query.trim()
  if (typed) {
    items.push({ id: `h:${typed}`, label: `History of ${typed}`, icon: 'history', run: open(typed, false) })
    items.push({ id: `b:${typed}`, label: `Blame ${typed}`, icon: 'file', run: open(typed, true) })
  }
  for (const p of paths) {
    items.push({ id: `h:${p}`, label: p, detail: 'history', icon: 'history', run: open(p, false) })
    items.push({ id: `b:${p}`, label: p, detail: 'blame', icon: 'file', run: open(p, true) })
  }
  return items
}

/** Branch switcher: local branches (most recent first), then remote branches with no local branch of that name. */
function branchItems(repo: RepoTab | null): PaletteItem[] {
  if (!repo) return []
  const locals = repo.refs.filter((r) => r.type === 'local').sort((a, b) => Number(!!b.isHead) - Number(!!a.isHead) || (b.date ?? 0) - (a.date ?? 0))
  const localNames = new Set(locals.map((r) => r.name))
  const remotes = repo.refs
    .filter((r) => r.type === 'remote' && !r.name.endsWith('/HEAD') && !localNames.has(remoteBranchName(r)))
    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
  const when = (date?: number) => (date ? relativeTime(date) : '')
  return [
    ...locals.map((ref) => {
      const track = ref.upstream ? [ref.ahead ? `↑${ref.ahead}` : '', ref.behind ? `↓${ref.behind}` : ''].filter(Boolean).join(' ') : 'local only'
      return {
        id: ref.fullName,
        label: ref.name,
        detail: ref.isHead ? 'current branch' : [track, when(ref.date)].filter(Boolean).join(' · '),
        icon: (ref.isHead ? 'check' : 'branch') as IconName,
        run: () => void checkoutRef(repo, ref)
      }
    }),
    ...remotes.map((ref) => ({ id: ref.fullName, label: ref.name, detail: when(ref.date), icon: 'remote' as IconName, run: () => void checkoutRef(repo, ref) }))
  ]
}

/** "Create branch <typed name>" when the switcher's text is a new, valid branch name. */
function createBranchItem(repo: RepoTab | null, query: string): PaletteItem | null {
  const name = query.trim()
  if (!repo || !name || validateRefName(name) || repo.refs.some((r) => r.type === 'local' && r.name === name)) return null
  return {
    id: `create:${name}`,
    label: `Create branch “${name}” and check it out`,
    icon: 'plus',
    run: () => void useStore.getState().run('Creating branch', (r) => window.git.createBranch(r, name, undefined, true), { repo: repo.path })
  }
}

export function FuzzyFinder() {
  const mode = useStore((s) => s.fuzzyFinder)
  if (!mode) return null
  return <Palette key={mode} mode={mode} />
}

function Palette({ mode }: { mode: 'commands' | 'repos' | 'history' | 'branches' }) {
  const setFuzzy = useStore((s) => s.setFuzzyFinder)
  const repo = useStore((s) => s.repos[s.activeTab] ?? null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // give the focus back to where it was (read while rendering, before the input takes it)
  const [returnTo] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  useEffect(
    () => () => {
      // commands that move the focus themselves (e.g. focus commit message) win
      if (returnTo?.isConnected && (!document.activeElement || document.activeElement === document.body)) returnTo.focus()
    },
    [returnTo]
  )
  const listRef = useRef<HTMLDivElement>(null)

  const base = useMemo(
    () => (mode === 'commands' ? commandItems(repo) : mode === 'repos' ? repoItems() : mode === 'branches' ? branchItems(repo) : null),
    [mode, repo]
  )
  const results = useMemo(() => {
    if (mode === 'branches') {
      const create = createBranchItem(repo, query)
      return [...fuzzyFilter(base ?? [], query, (i) => i.label), ...(create ? [{ item: create, match: { score: 0, indices: [] as number[] } }] : [])]
    }
    if (mode === 'history') {
      const typed = query.trim()
      const items = historyItems(repo, query)
      const [pinned, rest] = typed ? [items.slice(0, 2), items.slice(2)] : [[], items]
      return [...pinned.map((item) => ({ item, match: { score: 0, indices: [] as number[] } })), ...fuzzyFilter(rest, query, (i) => i.label)]
    }
    return fuzzyFilter(base ?? [], query, (i) => i.label)
  }, [base, query, mode, repo])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const close = () => setFuzzy(null)
  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return
    close()
    item.run()
  }

  const placeholder =
    mode === 'commands'
      ? 'Type a command, branch or repository…'
      : mode === 'repos'
        ? 'Open a recent repository…'
        : mode === 'branches'
          ? 'Switch to a branch, or type a new branch name…'
          : 'Type a file path to view its history…'

  return (
    <div className="fuzzy-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="fuzzy" role="dialog" aria-modal="true" aria-label={placeholder}>
        <div className="fuzzy-input">
          <Icon name={mode === 'history' ? 'history' : mode === 'branches' ? 'branch' : 'search'} size={15} />
          <input
            autoFocus
            value={query}
            placeholder={placeholder}
            role="combobox"
            aria-label={placeholder}
            aria-expanded
            aria-controls="fuzzy-results"
            aria-activedescendant={results[active] ? `fuzzy-item-${active}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(results.length - 1, a + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(0, a - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runItem(results[active]?.item)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                close()
              }
            }}
          />
        </div>
        <div className="fuzzy-list" ref={listRef} id="fuzzy-results" role="listbox">
          {results.map(({ item, match }, i) => (
            <div key={item.id} id={`fuzzy-item-${i}`} role="option" aria-selected={i === active} className={`fuzzy-item ${i === active ? 'active' : ''}`} onMouseMove={() => setActive(i)} onClick={() => runItem(item)}>
              <Icon name={item.icon} size={14} />
              <span className="ellipsis fuzzy-label">{highlight(item.label, match.indices)}</span>
              {item.detail && <span className="fuzzy-detail ellipsis">{item.detail}</span>}
            </div>
          ))}
          {results.length === 0 && <div className="fuzzy-empty">No matches</div>}
        </div>
      </div>
    </div>
  )
}

function highlight(text: string, indices: number[]): ReactNode {
  if (indices.length === 0) return text
  const set = new Set(indices)
  const out: ReactNode[] = []
  let buf = ''
  let on = false
  const flush = (k: number) => {
    if (!buf) return
    out.push(on ? <b key={k}>{buf}</b> : buf)
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i)
    if (m !== on) {
      flush(i)
      on = m
    }
    buf += text[i]
  }
  flush(text.length)
  return out
}

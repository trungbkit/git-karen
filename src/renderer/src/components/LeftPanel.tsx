import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { Ref, Stash, Submodule, Worktree } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon, type IconName } from '../ui/Icon'
import { showContextMenu } from '../ui/ContextMenu'
import { prompt } from '../ui/dialogs'
import {
  addRemote,
  checkoutRef,
  copyText,
  createBranchAt,
  createTagAt,
  refMenuItems,
  remoteBranchName,
  remoteMenuItems,
  stashChanges,
  stashMenuItems
} from '../actions/refActions'
import { changeCount, createWorktree, openWorktree, worktreeForBranch, worktreeLabel, worktreeMenuItems } from '../actions/worktreeActions'
import { basename, joinPath, relativeTime } from '../util/format'
import { fuzzyMatch } from '../util/fuzzy'
import { buildRefTree, filterRefItems, type RefTreeNode } from '../util/refTree'
import { scrollToSha } from '../graph/nav'
import { RefCard, useHoverCard } from '../graph/RefCard'
import { PullRequestsSection } from './PullRequestList'
import { useRovingFocus } from '../ui/roving'
import '../styles/shell.css'

type SectionId = 'local' | 'remote' | 'tags' | 'stashes' | 'submodules' | 'worktrees'

/** Sections and folders collapsed until the user opens them */
const DEFAULT_COLLAPSED: Record<string, boolean> = { tags: true }

/** Select a ref's commit, scroll the graph to it and flash the row; explain when the graph does not show it. */
function revealRef(repo: RepoTab, ref: Ref) {
  const s = useStore.getState()
  if (repo.center.kind !== 'graph') s.setCenter({ kind: 'graph' })
  s.select({ kind: 'commit', shas: [ref.sha] })
  if (scrollToSha(ref.sha)) return
  const hidden = repo.hiddenRefs.includes(ref.fullName)
  const soloedOut = repo.soloRefs.length > 0 && !repo.soloRefs.includes(ref.fullName)
  const showIt = () => {
    if (hidden) s.toggleHidden(ref.fullName)
    else s.updateRepo(repo.path, { soloRefs: [] })
    // wait for the graph to lay out the newly shown history
    setTimeout(() => scrollToSha(ref.sha), 50)
  }
  s.toast({
    kind: 'info',
    title: `${ref.name} is not in the graph`,
    message: hidden
      ? 'It is hidden in the graph.'
      : soloedOut
        ? 'Other branches are soloed.'
        : `Its commit is older than the ${s.prefs.commitLimit} commits loaded (Preferences > General).`,
    action: hidden || soloedOut ? { label: hidden ? 'Show it' : 'Show all', run: showIt } : undefined
  })
}

function revealStash(repo: RepoTab, st: Stash) {
  const s = useStore.getState()
  if (repo.center.kind !== 'graph') s.setCenter({ kind: 'graph' })
  s.select({ kind: 'stash', index: st.index })
  scrollToSha(st.sha)
}

export function LeftPanel({ repo }: { repo: RepoTab }) {
  const [filter, setFilter] = useState('')
  // one Tab stop for the whole tree; arrows move between rows, Right/Left open and close folders
  const treeRef = useRef<HTMLDivElement>(null)
  useRovingFocus(treeRef, { items: '.lp-section-header, .lp-row' })
  const s = useStore.getState()
  const branchSort = useStore((st) => st.prefs.branchSort)
  const allCollapsed = useStore((st) => st.prefs.collapsedGroups)
  const saved = allCollapsed[repo.path]
  const f = filter.trim()
  const match = (text: string) => !f || fuzzyMatch(f, text) !== null

  // folder state is remembered per repo; filtering opens everything
  const collapsedState = (key: string) => saved?.[key] ?? DEFAULT_COLLAPSED[key] ?? false
  const toggle = (key: string) => void s.setPrefs({ collapsedGroups: { ...allCollapsed, [repo.path]: { ...saved, [key]: !collapsedState(key) } } })
  const isCollapsed = (key: string) => (f ? false : collapsedState(key))

  const locals = useMemo(() => repo.refs.filter((r) => r.type === 'local'), [repo.refs])
  const remotesRefs = useMemo(() => repo.refs.filter((r) => r.type === 'remote' && !r.name.endsWith('/HEAD')), [repo.refs])
  const tags = useMemo(
    () =>
      repo.refs
        .filter((r) => r.type === 'tag')
        .sort((a, b) => (branchSort === 'date' && (b.date ?? 0) - (a.date ?? 0)) || b.name.localeCompare(a.name, undefined, { numeric: true })),
    [repo.refs, branchSort]
  )

  const localTree = useMemo(() => buildRefTree(filterRefItems(locals.map((r) => ({ path: r.name, ref: r })), f), 'local', branchSort), [locals, f, branchSort])
  const remoteTrees = useMemo(
    () =>
      new Map(
        repo.remotes.map((rm) => {
          const items = remotesRefs.filter((r) => (r.remote ?? r.name.split('/')[0]) === rm.name).map((r) => ({ path: remoteBranchName(r), ref: r }))
          return [rm.name, buildRefTree(filterRefItems(items, f), `remote:${rm.name}`, branchSort)] as const
        })
      ),
    [repo.remotes, remotesRefs, f, branchSort]
  )
  const tagItems = useMemo(() => filterRefItems(tags.map((t) => ({ path: t.name, ref: t })), f), [tags, f])
  const headSha = repo.status?.headSha ?? null

  const renderTree = (nodes: RefTreeNode[], depth: number): ReactNode =>
    nodes.map((n) => {
      if (n.ref) return <RefRow key={n.key} repo={repo} refItem={n.ref} label={n.label} match={n.match} depth={depth} />
      const open = !isCollapsed(n.key)
      return (
        <div key={n.key}>
          <div className="lp-row lp-folder" role="treeitem" aria-expanded={open} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(n.key)}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
            <Icon name="folder" size={13} />
            <span className="ellipsis">{n.label}</span>
            <span className="lp-count">{n.count}</span>
          </div>
          {open && renderTree(n.children, depth + 1)}
        </div>
      )
    })

  const run = s.run

  const addSubmodule = async () => {
    const res = await prompt({
      title: 'Add submodule',
      fields: [
        { name: 'url', label: 'Repository URL', validate: (v) => (v.trim() ? null : 'URL is required') },
        { name: 'path', label: 'Path inside this repository', validate: (v) => (v.trim() ? null : 'Path is required') }
      ],
      confirmLabel: 'Add submodule'
    })
    if (res) await run('Adding submodule', (r) => window.git.submoduleAdd(r, res.url.trim(), res.path.trim()), { success: 'Submodule added' })
  }

  const remoteNames = repo.remotes.map((r) => r.name)
  const stashes = repo.stashes.filter((st) => match(st.message))
  const submodules = repo.submodules.filter((sm) => match(sm.path))
  const worktrees = repo.worktrees.filter((wt) => match(wt.path) || match(wt.branch ?? ''))

  return (
    <div className="panel-left">
      <div className="lp-filter">
        <Icon name="search" size={12} />
        <input
          value={filter}
          placeholder="Filter"
          aria-label="Filter branches, tags and stashes"
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setFilter('')
            // Down moves from the filter into the tree
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              treeRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus()
            }
          }}
        />
        {filter && (
          <button className="icon-btn" title="Clear filter" aria-label="Clear filter" onClick={() => setFilter('')}>
            <Icon name="x" size={11} />
          </button>
        )}
        <button
          className={`icon-btn ${branchSort === 'date' ? 'on' : ''}`}
          title={branchSort === 'date' ? 'Branches sorted by most recent commit (click to sort by name)' : 'Branches sorted by name (click to sort by most recent commit)'}
          aria-label={branchSort === 'date' ? 'Sort branches by name' : 'Sort branches by most recent commit'}
          onClick={() => void s.setPrefs({ branchSort: branchSort === 'date' ? 'name' : 'date' })}
        >
          <Icon name={branchSort === 'date' ? 'history' : 'sort'} size={12} />
        </button>
      </div>
      <div className="lp-scroll" ref={treeRef} role="tree" aria-label="Branches, remotes, tags and stashes">
        <Section id="local" title="Local" icon="computer" count={locals.length} collapsed={isCollapsed('local')} onToggle={toggle} onAdd={() => void createBranchAt()} addTitle="Create branch">
          {renderTree(localTree, 0)}
          {locals.length === 0 && <Empty>No local branches</Empty>}
        </Section>

        <Section id="remote" title="Remote" icon="remote" count={remotesRefs.length} collapsed={isCollapsed('remote')} onToggle={toggle} onAdd={() => void addRemote()} addTitle="Add remote">
          {repo.remotes.map((rm) => {
            const key = `remote:${rm.name}`
            const tree = remoteTrees.get(rm.name) ?? []
            const count = tree.reduce((n, t) => n + t.count, 0)
            const open = !isCollapsed(key)
            return (
              <div key={rm.name}>
                <div
                  className="lp-row lp-folder"
                  role="treeitem"
                  aria-expanded={open}
                  style={{ paddingLeft: 10 }}
                  title={rm.fetchUrl}
                  onClick={() => toggle(key)}
                  onContextMenu={(e) => showContextMenu(e, remoteMenuItems(repo, rm))}
                >
                  <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
                  <Icon name={rm.fetchUrl.includes('github') ? 'github' : 'remote'} size={13} />
                  <span className="ellipsis">{rm.name}</span>
                  <span className="lp-count">{count}</span>
                </div>
                {open && renderTree(tree, 1)}
              </div>
            )
          })}
          {remoteNames.length === 0 && <Empty>No remotes — click + to add one</Empty>}
        </Section>

        <PullRequestsSection repo={repo} filter={filter} isCollapsed={isCollapsed} onToggle={toggle} />

        <Section id="tags" title="Tags" icon="tag" count={tags.length} collapsed={isCollapsed('tags')} onToggle={toggle} onAdd={headSha ? () => void createTagAt(headSha) : undefined} addTitle="Create tag at HEAD">
          {tagItems.map((t) => (
            <RefRow key={t.ref.fullName} repo={repo} refItem={t.ref} label={t.ref.name} match={t.match} depth={0} />
          ))}
          {tags.length === 0 && <Empty>No tags</Empty>}
        </Section>

        <Section id="stashes" title="Stashes" icon="stash" count={repo.stashes.length} collapsed={isCollapsed('stashes')} onToggle={toggle} onAdd={() => void stashChanges()} addTitle="Stash changes">
          {stashes.map((st) => {
            const selected = repo.selection?.kind === 'stash' && repo.selection.index === st.index
            return (
              <div
                key={st.sha}
                role="treeitem"
                aria-selected={selected}
                className={`lp-row ${selected ? 'selected' : ''}`}
                style={{ paddingLeft: 24 }}
                title={`${st.ref} · ${relativeTime(st.date)}`}
                onClick={() => revealStash(repo, st)}
                onContextMenu={(e) => showContextMenu(e, stashMenuItems(repo, st))}
              >
                <Icon name="stash" size={13} />
                <span className="ellipsis">{st.message}</span>
              </div>
            )
          })}
          {repo.stashes.length === 0 && <Empty>No stashes</Empty>}
        </Section>

        <Section id="submodules" title="Submodules" icon="submodule" count={repo.submodules.length} collapsed={isCollapsed('submodules')} onToggle={toggle} onAdd={() => void addSubmodule()} addTitle="Add submodule">
          {submodules.map((sm) => (
            <SubmoduleRow key={sm.path} repo={repo} sm={sm} />
          ))}
          {repo.submodules.length === 0 && <Empty>No submodules</Empty>}
        </Section>

        <Section id="worktrees" title="Worktrees" icon="worktree" count={repo.worktrees.length} collapsed={isCollapsed('worktrees')} onToggle={toggle} onAdd={() => createWorktree()} addTitle="Create worktree">
          {worktrees.map((wt) => (
            <WorktreeRow key={wt.path} repo={repo} wt={wt} />
          ))}
          {repo.worktrees.length === 0 && <Empty>No worktrees</Empty>}
        </Section>
      </div>
      <div className="lp-footer">
        <button className="btn ghost small" onClick={() => s.setModal({ kind: 'gitflow' })} title="Gitflow">
          <Icon name="gitflow" size={13} /> Gitflow
        </button>
        <button className="btn ghost small" onClick={() => s.setModal({ kind: 'lfs' })} title="Git LFS">
          <Icon name="lfs" size={13} /> LFS
        </button>
      </div>
    </div>
  )
}

function Section(props: {
  id: SectionId
  title: string
  icon: IconName
  count: number
  collapsed: boolean
  onToggle(id: string): void
  onAdd?: () => void
  addTitle?: string
  children: ReactNode
}) {
  return (
    <div className="lp-section">
      <div className="lp-section-header" role="treeitem" aria-expanded={!props.collapsed} onClick={() => props.onToggle(props.id)}>
        <Icon name={props.collapsed ? 'chevron-right' : 'chevron-down'} size={11} />
        <Icon name={props.icon} size={13} />
        <span className="lp-section-title">{props.title}</span>
        <span className="lp-count">{props.count}</span>
        {props.onAdd && (
          <button
            className="icon-btn lp-add"
            title={props.addTitle}
            aria-label={props.addTitle}
            onClick={(e) => {
              e.stopPropagation()
              props.onAdd!()
            }}
          >
            <Icon name="plus" size={12} />
          </button>
        )}
      </div>
      {!props.collapsed && <div className="lp-section-body">{props.children}</div>}
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="lp-empty">{children}</div>
}

/** A label with the characters a filter matched in bold. */
function Matched({ text, match }: { text: string; match?: number[] }) {
  if (!match?.length) return <>{text}</>
  const hit = new Set(match)
  const parts: ReactNode[] = []
  let i = 0
  while (i < text.length) {
    let j = i
    const on = hit.has(i)
    while (j < text.length && hit.has(j) === on) j++
    parts.push(on ? <b key={i} className="lp-match">{text.slice(i, j)}</b> : text.slice(i, j))
    i = j
  }
  return <>{parts}</>
}

function RefRow({ repo, refItem: ref, label, match, depth }: { repo: RepoTab; refItem: Ref; label: string; match?: number[]; depth: number }) {
  const s = useStore.getState()
  const card = useHoverCard()
  const hidden = repo.hiddenRefs.includes(ref.fullName)
  const soloed = repo.soloRefs.includes(ref.fullName)
  const selected = repo.selection?.kind === 'commit' && repo.selection.shas.length === 1 && repo.selection.shas[0] === ref.sha
  const icon: IconName = ref.type === 'tag' ? 'tag' : ref.type === 'remote' ? 'remote' : 'branch'
  const onContext = (e: MouseEvent) => showContextMenu(e, refMenuItems(repo, ref))
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-label={`${ref.isHead ? 'Current branch ' : ''}${label}${ref.ahead ? `, ${ref.ahead} ahead` : ''}${ref.behind ? `, ${ref.behind} behind` : ''}`}
      className={`lp-row ${ref.isHead ? 'head' : ''} ${selected ? 'selected' : ''} ${hidden ? 'hidden-ref' : ''}`}
      style={{ paddingLeft: 24 + depth * 14 }}
      onClick={() => revealRef(repo, ref)}
      onDoubleClick={() => void checkoutRef(repo, ref)}
      onContextMenu={onContext}
      onMouseEnter={card.onMouseEnter}
      onMouseLeave={card.onMouseLeave}
    >
      {ref.isHead ? (
        <Icon name="check" size={13} className="lp-head-icon" />
      ) : ref.type === 'local' && worktreeForBranch(repo, ref.name) ? (
        <span title={`Checked out in worktree ${worktreeForBranch(repo, ref.name)!.path}`}>
          <Icon name="worktree" size={13} />
        </span>
      ) : (
        <Icon name={icon} size={13} />
      )}
      <span className="ellipsis lp-name">
        <Matched text={label} match={match} />
      </span>
      {(ref.ahead ?? 0) > 0 && <span className="lp-badge">↑{ref.ahead}</span>}
      {(ref.behind ?? 0) > 0 && <span className="lp-badge">↓{ref.behind}</span>}
      <span className="lp-actions">
        <button
          className={`icon-btn ${soloed ? 'on' : ''}`}
          title={soloed ? 'Unsolo' : 'Solo (show only this)'}
          aria-label={soloed ? `Unsolo ${ref.name}` : `Solo ${ref.name} (show only this)`}
          onClick={(e) => {
            e.stopPropagation()
            s.toggleSolo(ref.fullName)
          }}
        >
          S
        </button>
        {!ref.isHead && (
          <button
            className={`icon-btn ${hidden ? 'on' : ''}`}
            title={hidden ? 'Show in graph' : 'Hide in graph'}
            aria-label={hidden ? `Show ${ref.name} in graph` : `Hide ${ref.name} in graph`}
            onClick={(e) => {
              e.stopPropagation()
              s.toggleHidden(ref.fullName)
            }}
          >
            <Icon name={hidden ? 'eye-off' : 'eye'} size={12} />
          </button>
        )}
      </span>
      {card.anchor && <RefCard repo={repo} refItem={ref} anchor={card.anchor} placement="right" />}
    </div>
  )
}

const SUBMODULE_STATE: Record<Submodule['state'], { label: string; cls: string }> = {
  clean: { label: 'in sync', cls: 'ok' },
  uninitialized: { label: 'not initialized', cls: 'warn' },
  modified: { label: 'out of sync', cls: 'warn' },
  conflict: { label: 'conflict', cls: 'danger' }
}

function SubmoduleRow({ repo, sm }: { repo: RepoTab; sm: Submodule }) {
  const s = useStore.getState()
  const fullPath = joinPath(repo.path, sm.path)
  const state = SUBMODULE_STATE[sm.state]
  const open = () => void s.openRepo(fullPath).catch(() => undefined)
  return (
    <div
      className="lp-row"
      role="treeitem"
      style={{ paddingLeft: 24 }}
      title={`${sm.path}\n${sm.url}`}
      onDoubleClick={open}
      onContextMenu={(e) =>
        showContextMenu(e, [
          { label: 'Open submodule', onClick: open, disabled: sm.state === 'uninitialized' },
          { label: sm.state === 'uninitialized' ? 'Initialize submodule' : 'Update submodule', onClick: () => void s.run('Updating submodule', (r) => window.git.submoduleUpdate(r, sm.path)) },
          'separator',
          { label: 'Copy path', onClick: () => copyText(sm.path) },
          { label: 'Copy URL', onClick: () => copyText(sm.url) }
        ])
      }
    >
      <Icon name="submodule" size={13} />
      <span className="ellipsis lp-name">{sm.name || sm.path}</span>
      <span className={`lp-state ${state.cls}`}>{state.label}</span>
    </div>
  )
}

function WorktreeRow({ repo, wt }: { repo: RepoTab; wt: Worktree }) {
  const s = useStore.getState()
  const showWips = useStore((st) => st.prefs.showWorktreeWips)
  const isCurrent = wt.path === repo.path
  const changes = changeCount(wt)
  const selected = repo.selection?.kind === 'worktree' && repo.selection.path === wt.path
  const label = worktreeLabel(wt)
  const folder = basename(wt.path)
  const select = () => {
    if (repo.center.kind !== 'graph') s.setCenter({ kind: 'graph' })
    if (isCurrent) s.select(repo.status && repo.status.staged.length + repo.status.unstaged.length > 0 ? { kind: 'wip' } : wt.head ? { kind: 'commit', shas: [wt.head] } : null)
    else if (changes > 0 && showWips) s.select({ kind: 'worktree', path: wt.path })
    else if (wt.head) s.select({ kind: 'commit', shas: [wt.head] })
  }
  const menu = (e: MouseEvent) => {
    e.stopPropagation()
    showContextMenu(e, worktreeMenuItems(repo, wt))
  }
  const c = wt.changes
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      className={`lp-row lp-wt ${isCurrent ? 'head' : ''} ${selected ? 'selected' : ''} ${wt.prunable ? 'prunable' : ''}`}
      style={{ paddingLeft: 10 }}
      title={`Working directory: ${wt.path}${wt.locked ? `\nLocked${wt.lockReason ? `: ${wt.lockReason}` : ''}` : ''}${wt.prunable ? '\nPrunable: the folder is missing' : ''}`}
      onClick={select}
      onDoubleClick={() => !isCurrent && !wt.prunable && openWorktree(wt.path)}
      onContextMenu={menu}
    >
      <span className="lp-wt-status">
        {wt.locked ? <Icon name="lock" size={12} className="warn" /> : wt.prunable ? <Icon name="scissors" size={12} className="caution" /> : null}
      </span>
      <Icon name={wt.isMain ? 'home' : 'worktree'} size={13} className="lp-wt-icon" />
      <span className="ellipsis lp-name">
        {label}
        {folder !== label && <span className="lp-wt-folder"> {folder}</span>}
      </span>
      {isCurrent && <span className="lp-state ok">current</span>}
      {c && changes > 0 && (
        <span className="lp-wip" title={`Uncommitted: ${[c.modified && `${c.modified} modified`, c.added && `${c.added} added`, c.deleted && `${c.deleted} deleted`, c.conflicted && `${c.conflicted} conflicted`].filter(Boolean).join(', ')}`}>
          {changes}
        </span>
      )}
      <span className="lp-actions">
        <button className="icon-btn" title="Worktree actions" aria-label="Worktree actions" onClick={menu}>
          <Icon name="dots" size={12} />
        </button>
      </span>
    </div>
  )
}

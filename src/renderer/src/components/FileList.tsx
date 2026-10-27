import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { create } from 'zustand'
import type { FileChange, FileStatusCode } from '@shared/types'
import { Icon, type IconName } from '../ui/Icon'
import { contextMenuFromKeyboard, type MenuItem } from '../ui/ContextMenu'
import { useStore, type RepoTab } from '../state/store'
import { joinPath } from '../util/format'
import { rowHeight } from '../ui/appearance'
import '../styles/detail.css'

/** Status glyphs: pencil = modified, plus = added, minus = deleted, arrow = renamed. */
const STATUS_ICON: Record<FileStatusCode, IconName> = {
  added: 'plus',
  untracked: 'plus',
  modified: 'edit',
  typechange: 'edit',
  deleted: 'minus',
  renamed: 'rename',
  copied: 'copy',
  conflicted: 'warning'
}

export function StatusIcon({ status, size = 12 }: { status: FileStatusCode; size?: number }) {
  return (
    <span className={`status-icon ${status}`} title={status}>
      <Icon name={STATUS_ICON[status]} size={size} />
    </span>
  )
}

type StatKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted'
const STAT_ORDER: StatKind[] = ['conflicted', 'modified', 'added', 'deleted', 'renamed']
const STAT_ICON: Record<StatKind, FileStatusCode> = {
  conflicted: 'conflicted',
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed'
}

function statKind(s: FileStatusCode): StatKind {
  if (s === 'added' || s === 'untracked') return 'added'
  if (s === 'deleted') return 'deleted'
  if (s === 'renamed' || s === 'copied') return 'renamed'
  if (s === 'conflicted') return 'conflicted'
  return 'modified'
}

export function countByKind(files: FileChange[]): Record<StatKind, number> {
  const out: Record<StatKind, number> = { modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0 }
  for (const f of files) out[statKind(f.status)]++
  return out
}

/** "3 modified  1 added  2 deleted" summary line; zero counts are left out. */
export function FileStats({ files, compact }: { files: FileChange[]; compact?: boolean }) {
  const counts = countByKind(files)
  return (
    <span className={`file-stats ${compact ? 'compact' : ''}`}>
      {STAT_ORDER.filter((k) => counts[k] > 0).map((k) => (
        <span key={k} className={`file-stat ${k}`} title={compact ? `${counts[k]} ${k}` : undefined}>
          <StatusIcon status={STAT_ICON[k]} size={compact ? 10 : 11} />
          {compact ? counts[k] : `${counts[k]} ${k}`}
        </span>
      ))}
    </span>
  )
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable; keep in memory only
  }
}

/** Shared path/tree view and sort order for every file list. */
export const useFileViewMode = create<{ tree: boolean; desc: boolean; setTree(tree: boolean): void; toggleSort(): void }>((set, get) => ({
  tree: readLocal('kc:fileTree') === '1',
  desc: readLocal('kc:fileSortDesc') === '1',
  setTree(tree) {
    writeLocal('kc:fileTree', tree ? '1' : '0')
    set({ tree })
  },
  toggleSort() {
    const desc = !get().desc
    writeLocal('kc:fileSortDesc', desc ? '1' : '0')
    set({ desc })
  }
}))

/** Sort button and Path / Tree switch shown above file lists. */
export function FileViewToggle({ compact }: { compact?: boolean }) {
  const { tree, desc, setTree, toggleSort } = useFileViewMode()
  return (
    <span className="file-view-controls">
      <button className={`icon-btn ${desc ? 'flip' : ''}`} title={desc ? 'Sorted Z to A' : 'Sorted A to Z'} aria-label={desc ? 'Sorted Z to A' : 'Sorted A to Z'} onClick={toggleSort}>
        <Icon name="sort" size={13} />
      </button>
      <span className="seg seg-icons">
        <button className={tree ? '' : 'on'} aria-pressed={!tree} title="Path view" aria-label="Path view" onClick={() => setTree(false)}>
          <Icon name="list" size={12} />
          {!compact && ' Path'}
        </button>
        <button className={tree ? 'on' : ''} aria-pressed={tree} title="Tree view" aria-label="Tree view" onClick={() => setTree(true)}>
          <Icon name="tree" size={12} />
          {!compact && ' Tree'}
        </button>
      </span>
    </span>
  )
}

/** Multi-selection in a file list; `anchor` is where shift ranges start, `lead` the row arrows move from. */
export interface FileSelection {
  paths: ReadonlySet<string>
  anchor: string | null
  lead: string | null
}

interface Props {
  files: FileChange[]
  selectedPath?: string | null
  onClick(file: FileChange): void
  onDoubleClick?(file: FileChange): void
  onContextMenu?(e: MouseEvent, file: FileChange): void
  /** Hover actions rendered at the end of each row */
  actions?(file: FileChange): ReactNode
  /** Hover actions on tree folder rows, for every file below the folder */
  folderActions?(files: FileChange[]): ReactNode
  onFolderContextMenu?(e: MouseEvent, files: FileChange[], path: string): void
  showStats?: boolean
  /** Enables Cmd/Ctrl-click, Shift-click, Cmd/Ctrl+A and arrow keys; plain clicks still call onClick */
  selection?: FileSelection
  onSelectionChange?(selection: FileSelection): void
  /** The list is its own scroll container and renders only the rows in view */
  scroll?: boolean
  /** Enter on a file: the files it applies to (the selection when it includes the file). Default: double-click, else click */
  onEnter?(paths: string[]): void
  /** Accessible name of the list */
  label?: string
}

interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  file?: FileChange
  /** Files anywhere below this folder */
  files: FileChange[]
}

function buildTree(files: FileChange[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    root.files.push(f)
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/')
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, path, children: new Map(), files: [] }
        node.children.set(part, child)
      }
      if (i === parts.length - 1) child.file = f
      else child.files.push(f)
      node = child
    })
  }
  // Compress chains of single-child folders: a/b/c -> "a/b/c"
  const compress = (n: TreeNode): TreeNode => {
    for (const [k, c] of n.children) n.children.set(k, compress(c))
    if (!n.file && n.children.size === 1 && n.name) {
      const only = [...n.children.values()][0]
      if (!only.file) return { ...only, name: `${n.name}/${only.name}` }
    }
    return n
  }
  return compress(root)
}

function sortedChildren(n: TreeNode, desc: boolean): TreeNode[] {
  return [...n.children.values()].sort((a, b) => {
    const af = a.file ? 1 : 0
    const bf = b.file ? 1 : 0
    return af - bf || (desc ? -1 : 1) * a.name.localeCompare(b.name)
  })
}

/** One visible line of the list; tree file rows carry their short name. */
type Row = { file: FileChange; depth: number; name?: string } | { dir: TreeNode; depth: number; collapsed: boolean }

function flatten(root: TreeNode, desc: boolean, collapsed: Set<string>): Row[] {
  const out: Row[] = []
  const walk = (n: TreeNode, depth: number) => {
    for (const c of sortedChildren(n, desc)) {
      if (c.file) {
        out.push({ file: c.file, depth, name: c.name })
        continue
      }
      const isCollapsed = collapsed.has(c.path)
      out.push({ dir: c, depth, collapsed: isCollapsed })
      if (!isCollapsed) walk(c, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

function pathLabel(f: FileChange): ReactNode {
  const i = f.path.lastIndexOf('/')
  return (
    <span>
      {f.oldPath && f.oldPath !== f.path && <span className="file-dir">{f.oldPath} → </span>}
      {i >= 0 && <span className="file-dir">{f.path.slice(0, i + 1)}</span>}
      {f.path.slice(i + 1)}
    </span>
  )
}

const OVERSCAN = 10

const isMac = () => window.app?.platform === 'darwin'

export function FileList(props: Props) {
  const { files, selectedPath, onClick, onDoubleClick, onContextMenu, actions, folderActions, onFolderContextMenu, showStats, selection, onSelectionChange, scroll, onEnter, label } = props
  // matches the .file-row height (CSS --row-h, from the density preference); virtualised lists rely on it
  const ROW_HEIGHT = useStore((s) => rowHeight(s.prefs.density))
  const tree = useFileViewMode((s) => s.tree)
  const desc = useFileViewMode((s) => s.desc)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const root = useMemo(() => (tree ? buildTree(files) : null), [files, tree])
  const rows = useMemo<Row[]>(
    () =>
      root
        ? flatten(root, desc, collapsed)
        : [...files].sort((a, b) => (desc ? -1 : 1) * a.path.localeCompare(b.path)).map((file) => ({ file, depth: 0 })),
    [root, files, desc, collapsed]
  )
  const visible = useMemo(() => rows.flatMap((r) => ('file' in r ? [r.file] : [])), [rows])

  const listRef = useRef<HTMLDivElement>(null)
  const idBase = useId()
  // keyboard position: a folder row (tree view), else the lead file (`ownLead` for lists without a selection)
  const [dirFocus, setDirFocus] = useState<string | null>(null)
  const [ownLead, setOwnLead] = useState<string | null>(null)
  const [view, setView] = useState({ top: 0, height: 0 })
  useLayoutEffect(() => {
    const el = listRef.current
    if (!scroll || !el) return
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight })
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scroll])

  const selectable = selection && onSelectionChange
  const select = (paths: Iterable<string>, anchor: string | null, lead: string | null) =>
    onSelectionChange?.({ paths: new Set(paths), anchor, lead })

  // the visible files from a to b inclusive; a missing anchor yields just b
  const range = (a: string, b: string): string[] => {
    const j = visible.findIndex((f) => f.path === b)
    const found = visible.findIndex((f) => f.path === a)
    const i = found < 0 ? j : found
    return visible.slice(Math.min(i, j), Math.max(i, j) + 1).map((f) => f.path)
  }

  const lead = selection ? selection.lead : (selectedPath ?? ownLead)
  const rowIndex = (r: { dir?: string; file?: string }) =>
    rows.findIndex((x) => (r.dir !== undefined ? 'dir' in x && x.dir.path === r.dir : 'file' in x && x.file.path === r.file))
  const focusIndex = dirFocus !== null ? rowIndex({ dir: dirFocus }) : lead ? rowIndex({ file: lead }) : -1
  const rowId = (i: number) => `${idBase}-row-${i}`

  const revealIndex = (i: number) => {
    const el = listRef.current
    if (!el || i < 0) return
    if (!scroll) return el.querySelector(`#${CSS.escape(rowId(i))}`)?.scrollIntoView({ block: 'nearest' })
    const top = i * ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight
  }
  const reveal = (path: string) => revealIndex(rowIndex({ file: path }))

  const clickFile = (e: MouseEvent, f: FileChange) => {
    setDirFocus(null)
    setOwnLead(f.path)
    if (selectable) {
      const mod = isMac() ? e.metaKey : e.ctrlKey
      if (e.shiftKey) {
        const anchor = selection.anchor ?? f.path
        const paths = range(anchor, f.path)
        return select(mod ? [...selection.paths, ...paths] : paths, anchor, f.path)
      }
      if (mod) {
        const paths = new Set(selection.paths)
        if (!paths.delete(f.path)) paths.add(f.path)
        return select(paths, f.path, f.path)
      }
      select([f.path], f.path, f.path)
    }
    onClick(f)
  }

  /** Move the keyboard position to a row: a folder is only focused, a file is selected (and its diff opened). */
  const moveTo = (i: number) => {
    const r = rows[i]
    if (!r) return
    if ('dir' in r) setDirFocus(r.dir.path)
    else {
      setDirFocus(null)
      setOwnLead(r.file.path)
      if (selectable) select([r.file.path], r.file.path, r.file.path)
      onClick(r.file)
    }
    revealIndex(i)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = isMac() ? e.metaKey : e.ctrlKey
    const current = rows[focusIndex]
    const handled = (() => {
      if (selectable && mod && !e.shiftKey && e.code === 'KeyA') {
        select(files.map((f) => f.path), selection.anchor, selection.lead)
      } else if (selectable && e.key === 'Escape' && selection.paths.size > 1) {
        select([], null, null)
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !mod && !e.altKey && rows.length > 0) {
        const step = e.key === 'ArrowDown' ? 1 : -1
        if (selectable && e.shiftKey) {
          // extend the selection over files only
          const i = visible.findIndex((f) => f.path === selection.lead)
          const next = visible[i < 0 ? 0 : Math.max(0, Math.min(visible.length - 1, i + step))]
          if (!next) return true
          const anchor = selection.anchor ?? next.path
          select(range(anchor, next.path), anchor, next.path)
          setDirFocus(null)
          reveal(next.path)
        } else moveTo(focusIndex < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, focusIndex + step)))
      } else if ((e.key === 'Home' || e.key === 'End') && rows.length > 0) {
        moveTo(e.key === 'Home' ? 0 : rows.length - 1)
      } else if (current && 'dir' in current && (e.key === 'Enter' || e.key === ' ')) {
        toggleFolder(current.dir.path)
      } else if (current && 'dir' in current && e.key === (current.collapsed ? 'ArrowRight' : 'ArrowLeft')) {
        // Right opens a closed folder, Left closes an open one
        toggleFolder(current.dir.path)
      } else if (current && 'file' in current && e.key === 'ArrowLeft' && current.depth > 0) {
        // up to the folder the file is in
        let i = focusIndex - 1
        while (i >= 0 && !('dir' in rows[i] && rows[i].depth < current.depth)) i--
        if (i >= 0) moveTo(i)
      } else if (current && 'file' in current && e.key === 'Enter' && !mod && !e.altKey) {
        if (onEnter) onEnter(selection?.paths.has(current.file.path) ? [...selection.paths] : [current.file.path])
        else (onDoubleClick ?? onClick)(current.file)
      } else if (current && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
        const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(rowId(focusIndex))}`)
        if (el) contextMenuFromKeyboard(el)
      } else return false
      return true
    })()
    if (handled) e.preventDefault()
  }

  const isSelected = (path: string) => (selection ? selection.paths.has(path) : selectedPath === path)

  const toggleFolder = (path: string) => {
    const next = new Set(collapsed)
    if (!next.delete(path)) next.add(path)
    setCollapsed(next)
  }

  const renderRow = (r: Row, index: number) => {
    if ('dir' in r) {
      const c = r.dir
      return (
        <div
          key={`dir:${c.path}`}
          id={rowId(index)}
          role="treeitem"
          aria-expanded={!r.collapsed}
          aria-level={r.depth + 1}
          className={`file-row folder-row ${dirFocus === c.path ? 'lead' : ''}`}
          style={{ paddingLeft: 4 + r.depth * 15 }}
          title={c.path}
          onClick={() => {
            setDirFocus(c.path)
            toggleFolder(c.path)
          }}
          onContextMenu={onFolderContextMenu ? (e) => onFolderContextMenu(e, c.files, c.path) : undefined}
        >
          <Icon name={r.collapsed ? 'chevron-right' : 'chevron-down'} size={11} />
          <Icon name="folder" size={13} />
          <span className="file-name">
            <span>{c.name}</span>
          </span>
          {r.collapsed && <FileStats files={c.files} compact />}
          {folderActions && <span className="file-actions">{folderActions(c.files)}</span>}
        </div>
      )
    }
    const f = r.file
    return (
      <div
        key={f.path}
        id={rowId(index)}
        role={tree ? 'treeitem' : 'option'}
        aria-selected={isSelected(f.path)}
        aria-level={tree ? r.depth + 1 : undefined}
        data-path={f.path}
        className={`file-row ${isSelected(f.path) ? 'selected' : ''} ${dirFocus === null && lead === f.path ? 'lead' : ''}`}
        style={{ paddingLeft: 10 + r.depth * 15 }}
        title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        onClick={(e) => clickFile(e, f)}
        onDoubleClick={onDoubleClick ? () => onDoubleClick(f) : undefined}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, f) : undefined}
      >
        <StatusIcon status={f.status} />
        <span className="file-name">{r.name !== undefined ? <span>{r.name}</span> : pathLabel(f)}</span>
        {showStats && (f.additions !== undefined || f.deletions !== undefined) && (
          <span className="stats">
            {!!f.additions && <span className="add">+{f.additions}</span>}
            {!!f.deletions && <span className="del">−{f.deletions}</span>}
          </span>
        )}
        {actions && <span className="file-actions">{actions(f)}</span>}
      </div>
    )
  }

  // one Tab stop; the focused row is announced through aria-activedescendant (rows of long lists are virtualised)
  const listProps = {
    ref: listRef,
    tabIndex: 0,
    role: tree ? 'tree' : 'listbox',
    'aria-label': label,
    'aria-multiselectable': selectable && !tree ? true : undefined,
    'aria-activedescendant': focusIndex >= 0 ? rowId(focusIndex) : undefined,
    onKeyDown
  }

  if (!scroll) {
    return (
      <div className="file-list" {...listProps}>
        {rows.map(renderRow)}
      </div>
    )
  }

  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN)
  return (
    <div className="file-list scroll" {...listProps}>
      <div style={{ height: rows.length * ROW_HEIGHT, paddingTop: first * ROW_HEIGHT }}>{rows.slice(first, last).map((r, i) => renderRow(r, first + i))}</div>
    </div>
  )
}

/** Common per-file context menu entries (history, blame, editor, folder, copy). */
export function fileMenuItems(repo: RepoTab, path: string): MenuItem[] {
  const { setCenter } = useStore.getState()
  return [
    { label: 'File history', onClick: () => setCenter({ kind: 'history', path, blame: false }, repo.path) },
    { label: 'File blame', onClick: () => setCenter({ kind: 'history', path, blame: true }, repo.path) },
    'separator',
    { label: 'Open in external editor', onClick: () => void window.app.openInEditor(repo.path, path) },
    { label: 'Show in folder', onClick: () => void window.app.showInFolder(joinPath(repo.path, path)) },
    { label: 'Copy file path', onClick: () => void navigator.clipboard.writeText(path) }
  ]
}

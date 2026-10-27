import { useEffect, useRef, useState } from 'react'
import { isSpecialTab, useStore, WELCOME_TAB, WORKSPACE_TAB } from '../state/store'
import { Icon } from '../ui/Icon'
import { showContextMenu } from '../ui/ContextMenu'
import { closeTabRemembered, newTab } from '../keybindings'
import { basename } from '../util/format'
import { isLinkedWorktree } from '../actions/worktreeActions'
import { useRovingFocus } from '../ui/roving'
import '../styles/shell.css'

export function TabsBar() {
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.activeTab)
  const repos = useStore((s) => s.repos)
  const setActive = useStore((s) => s.setActiveTab)
  const [dragging, setDragging] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  // the tab strip is one Tab stop; Left/Right move between tabs, Enter/Space activate, Delete closes
  const stripRef = useRef<HTMLDivElement>(null)
  useRovingFocus(stripRef, { items: '.tab', horizontal: true })
  useEffect(() => window.app.onFullscreenChange(setFullscreen), [])
  // leave room for the window buttons, which macOS hides in fullscreen
  const mac = window.app.platform === 'darwin' && !fullscreen

  const label = (path: string) =>
    path === WELCOME_TAB ? 'New tab' : path === WORKSPACE_TAB ? 'Workspace' : (repos[path]?.info?.name ?? basename(path))

  const reorder = (from: string, to: string) => {
    if (from === to) return
    const next = tabs.filter((t) => t !== from)
    next.splice(next.indexOf(to) + (tabs.indexOf(from) < tabs.indexOf(to) ? 1 : 0), 0, from)
    useStore.setState({ tabs: next })
    void window.app.setOpenTabs(next.filter((t) => !isSpecialTab(t)), isSpecialTab(active) ? null : active)
  }

  return (
    <div className={`tabs-bar ${mac ? 'mac' : ''}`} data-tauri-drag-region ref={stripRef} role="tablist" aria-label="Open repositories">
      {tabs.map((path) => {
        const repo = repos[path]
        return (
          <div
            key={path}
            role="tab"
            aria-selected={path === active}
            aria-label={`${label(path)}${repo?.busy ? `, ${repo.busy}` : ''}${repo?.status?.operation ? `, ${repo.status.operation} in progress` : ''}`}
            className={`tab ${path === active ? 'active' : ''}`}
            title={isSpecialTab(path) ? undefined : path}
            draggable={path !== WELCOME_TAB}
            onDragStart={() => setDragging(path)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(e) => dragging && e.preventDefault()}
            onDrop={() => dragging && reorder(dragging, path)}
            onMouseDown={(e) => {
              if (e.button === 0) setActive(path)
            }}
            onClick={() => path !== active && setActive(path)}
            onKeyDown={(e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault()
                closeTabRemembered(path)
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) closeTabRemembered(path)
            }}
            onContextMenu={(e) =>
              showContextMenu(e, [
                { label: 'Close tab', onClick: () => closeTabRemembered(path) },
                { label: 'Close other tabs', disabled: tabs.length < 2, onClick: () => tabs.filter((t) => t !== path).forEach(closeTabRemembered) },
                !isSpecialTab(path) && 'separator',
                !isSpecialTab(path) && { label: 'Show in folder', onClick: () => void window.app.showInFolder(path) },
                !isSpecialTab(path) && { label: 'Copy path', onClick: () => void navigator.clipboard.writeText(path) }
              ])
            }
          >
            {repo?.busy && <span className="spinner small" />}
            {path === WORKSPACE_TAB && (
              <span className="tab-wt">
                <Icon name="layers" size={11} />
              </span>
            )}
            {repo && !repo.busy && isLinkedWorktree(repo) && (
              <span className="tab-wt" title="Worktree">
                <Icon name="worktree" size={11} />
              </span>
            )}
            <span className="ellipsis">{label(path)}</span>
            {repo?.status?.operation && <span className="tab-op">{repo.status.operation}</span>}
            {(tabs.length > 1 || path !== WELCOME_TAB) && (
              <button
                className="tab-close"
                tabIndex={-1}
                aria-label={`Close ${label(path)}`}
                title="Close tab"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeTabRemembered(path)}
              >
                <Icon name="x" size={10} />
              </button>
            )}
          </div>
        )
      })}
      <button className="tab-new" title="New tab" aria-label="New tab" onClick={newTab}>
        <Icon name="plus" size={12} />
      </button>
      {/* the drag attribute only applies to the element clicked, not its children */}
      <div className="tabs-drag-space" data-tauri-drag-region />
    </div>
  )
}

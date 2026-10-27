import { useEffect, useRef, useState } from 'react'
import type { DiscoveredRepo, RecentRepo } from '@shared/types'
import { COMMANDS } from '@shared/commands'
import { useStore } from '../state/store'
import { Icon, type IconName } from '../ui/Icon'
import { showContextMenu } from '../ui/ContextMenu'
import { dispatch, openRepoDialog, shortcutFor } from '../keybindings'
import { relativeTime } from '../util/format'
import { welcomeLists } from '../util/welcome'
import { useRovingFocus } from '../ui/roving'
import appIcon from '../assets/icon.png'
import '../styles/shell.css'

// The last scan, kept while the app runs so switching back to a new tab does not scan again.
let lastScan: { dirs: string; repos: DiscoveredRepo[] } | null = null

/** Repositories in the discovery folders (Preferences > General); `rescan` runs the scan again. */
function useDiscoveredRepos(dirs: string[]) {
  const key = JSON.stringify(dirs)
  const [repos, setRepos] = useState<DiscoveredRepo[] | null>(() => (lastScan?.dirs === key ? lastScan.repos : null))
  const [scanning, setScanning] = useState(false)
  const [run, setRun] = useState(0)
  useEffect(() => {
    if (run === 0 && lastScan?.dirs === key) return setRepos(lastScan.repos)
    if (dirs.length === 0) return setRepos([])
    let live = true
    setScanning(true)
    window.app.discoverRepos(dirs).then(
      (found) => {
        lastScan = { dirs: key, repos: found }
        if (live) setRepos(found)
      },
      () => live && setRepos([])
    ).finally(() => live && setScanning(false))
    return () => {
      live = false
    }
    // `dirs` changes exactly when its key does
  }, [key, run])
  return { repos, scanning, rescan: () => setRun((n) => n + 1) }
}

export function Welcome() {
  const recent = useStore((s) => s.recent)
  const openRepo = useStore((s) => s.openRepo)
  const setModal = useStore((s) => s.setModal)
  const workspaces = useStore((s) => s.workspaces)
  const openWorkspaceTab = useStore((s) => s.openWorkspaceTab)
  const scanDirs = useStore((s) => s.prefs.repoScanDirs)
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const discovery = useDiscoveredRepos(scanDirs)
  const lists = welcomeLists(recent, discovery.repos ?? [], query, showAll)
  const total = recent.length + (discovery.repos?.length ?? 0)

  // every repository row is one Tab stop: arrows move, Enter opens, Shift+F10 shows the menu
  const listsRef = useRef<HTMLDivElement>(null)
  useRovingFocus(listsRef, { items: '.wl-repo' })

  const toggleFavorite = async (path: string) => useStore.setState({ recent: await window.app.toggleFavorite(path) })
  const remove = async (path: string) => useStore.setState({ recent: await window.app.removeRecent(path) })
  const open = (path: string) => void openRepo(path).catch(() => undefined)

  const RepoItem = ({ path, name, lastOpened, favorite }: RecentRepo) => (
    <div
      className="wl-repo"
      role="button"
      aria-label={`${name}${favorite ? ', favorite' : ''}, ${path}`}
      onClick={() => open(path)}
      onContextMenu={(e) =>
        showContextMenu(e, [
          { label: 'Open', onClick: () => open(path) },
          { label: favorite ? 'Remove from favorites' : 'Add to favorites', onClick: () => void toggleFavorite(path) },
          { label: 'Show in folder', onClick: () => void window.app.showInFolder(path) },
          'separator',
          { label: 'Remove from list', danger: true, onClick: () => void remove(path) }
        ])
      }
      title={path}
    >
      <Icon name="folder" size={16} />
      <div className="wl-repo-text">
        <div className="ellipsis wl-repo-name">{name}</div>
        <div className="ellipsis muted wl-repo-path">{path}</div>
      </div>
      <span className="muted wl-repo-time">{relativeTime(lastOpened)}</span>
      {/* the row menu (Shift+F10) has these for keyboard users */}
      <button
        className={`icon-btn wl-star ${favorite ? 'on' : ''}`}
        tabIndex={-1}
        title={favorite ? 'Unfavorite' : 'Favorite'}
        aria-label={favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
        onClick={(e) => {
          e.stopPropagation()
          void toggleFavorite(path)
        }}
      >
        <Icon name="star" size={14} />
      </button>
      <button
        className="icon-btn wl-remove"
        tabIndex={-1}
        title="Remove from list"
        aria-label={`Remove ${name} from the list`}
        onClick={(e) => {
          e.stopPropagation()
          void remove(path)
        }}
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  )

  const FoundItem = ({ path, name, modified }: DiscoveredRepo) => (
    <div
      className="wl-repo"
      role="button"
      aria-label={`${name}, ${path}`}
      title={path}
      onClick={() => open(path)}
      onContextMenu={(e) =>
        showContextMenu(e, [
          { label: 'Open', onClick: () => open(path) },
          { label: 'Add to favorites', onClick: () => void toggleFavorite(path) },
          { label: 'Show in folder', onClick: () => void window.app.showInFolder(path) }
        ])
      }
    >
      <Icon name="search" size={16} />
      <div className="wl-repo-text">
        <div className="ellipsis wl-repo-name">{name}</div>
        <div className="ellipsis muted wl-repo-path">{path}</div>
      </div>
      {modified > 0 && <span className="muted wl-repo-time" title="Last change to its index or HEAD">{relativeTime(modified)}</span>}
    </div>
  )

  return (
    <div className="welcome">
      <div className="wl-inner">
        <div className="wl-brand">
          <img className="wl-logo" src={appIcon} width={56} height={56} alt="" />
          <div>
            <h1 className="wl-title">Karen</h1>
            <div className="muted">A local-first Git client</div>
          </div>
        </div>

        <Onboarding />

        <div className="wl-actions">
          <Action icon="folder" title="Open a repository" text="Browse to a local Git repository" onClick={() => void openRepoDialog()} />
          <Action icon="fetch" title="Clone a repository" text="Clone from a URL" onClick={() => setModal({ kind: 'clone' })} />
          <Action icon="plus" title="Start a local repository" text="Initialize a new repository" onClick={() => setModal({ kind: 'init' })} />
        </div>

        <div ref={listsRef}>
          <div className="wl-list">
            <div className="wl-repo" role="button" onClick={openWorkspaceTab} title="Branches, changes and ahead/behind of several repositories; fetch or pull them all">
              <Icon name="layers" size={16} />
              <div className="wl-repo-text">
                <div className="ellipsis wl-repo-name">Workspaces</div>
                <div className="ellipsis muted wl-repo-path">
                  {workspaces.length
                    ? workspaces.map((w) => `${w.name} (${w.repos.length})`).join(' · ')
                    : 'Group repositories to see and update them together'}
                </div>
              </div>
            </div>
          </div>

          {total > 0 && (
            <div className="wl-filter">
              <Icon name="search" size={13} />
              <input
                value={query}
                placeholder="Filter repositories"
                aria-label="Filter repositories"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) {
                    e.preventDefault()
                    e.stopPropagation()
                    setQuery('')
                  } else if (e.key === 'Enter') {
                    // open the best match
                    const first = lists.favorites[0] ?? lists.recent[0] ?? lists.discovered[0]
                    if (first) open(first.path)
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    listsRef.current?.querySelector<HTMLElement>('.wl-filter ~ .wl-list .wl-repo')?.focus()
                  }
                }}
              />
              {query && (
                <button className="icon-btn" title="Clear filter" aria-label="Clear filter" onClick={() => setQuery('')}>
                  <Icon name="x" size={11} />
                </button>
              )}
            </div>
          )}

          {lists.favorites.length > 0 && (
            <>
              <h2 className="wl-heading">Favorites</h2>
              <div className="wl-list">{lists.favorites.map((r) => <RepoItem key={r.path} {...r} />)}</div>
            </>
          )}
          <h2 className="wl-heading">Recent repositories</h2>
          <div className="wl-list">
            {lists.recent.map((r) => (
              <RepoItem key={r.path} {...r} />
            ))}
            {lists.recent.length === 0 && <div className="muted wl-empty">{query ? 'No recent repository matches.' : 'Repositories you open will show up here.'}</div>}
          </div>

          <h2 className="wl-heading wl-heading-row">
            <span>Found on this computer</span>
            {discovery.scanning && <span className="spinner small" aria-label="Scanning" />}
            <span className="grow" />
            <button className="btn ghost small" disabled={discovery.scanning || scanDirs.length === 0} onClick={discovery.rescan} title="Scan the folders again">
              <Icon name="refresh" size={12} /> Rescan
            </button>
            <button className="btn ghost small" onClick={() => setModal({ kind: 'preferences', section: 'general' })} title="Choose the folders to scan (Preferences > General)">
              <Icon name="settings" size={12} /> Folders…
            </button>
          </h2>
          <div className="wl-list">
            {lists.discovered.map((r) => (
              <FoundItem key={r.path} {...r} />
            ))}
            {lists.hidden > 0 && (
              <div className="wl-repo wl-more" role="button" onClick={() => setShowAll(true)}>
                <Icon name="chevron-down" size={14} />
                <span>Show {lists.hidden} more</span>
              </div>
            )}
            {lists.discovered.length === 0 && (
              <div className="muted wl-empty">
                {discovery.repos === null
                  ? 'Looking for repositories…'
                  : scanDirs.length === 0
                    ? 'No folders to scan. Add some in Preferences > General.'
                    : query && (discovery.repos?.length ?? 0) > 0
                      ? 'No found repository matches.'
                      : `No other repositories in ${scanDirs.join(', ')} (two levels deep).`}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Action({ icon, title, text, onClick }: { icon: IconName; title: string; text: string; onClick(): void }) {
  return (
    <button className="wl-action" onClick={onClick}>
      <Icon name={icon} size={22} />
      <div>
        <div className="wl-action-title">{title}</div>
        <div className="muted">{text}</div>
      </div>
    </button>
  )
}

/** First-run guide: three steps that tick themselves off (opening a repo, the palette, the shortcut list). */
function Onboarding() {
  const done = useStore((s) => s.prefs.onboardingDone)
  const steps = useStore((s) => s.prefs.onboardingSteps)
  const setPrefs = useStore((s) => s.setPrefs)
  if (done) return null
  const palette = shortcutFor(COMMANDS.toggleFuzzyFinder) ?? 'Ctrl+P'
  const shortcuts = shortcutFor(COMMANDS.toggleKeyBindings) ?? 'Ctrl+/'
  const items: { id: string; title: string; text: string; action?: { label: string; run(): void } }[] = [
    { id: 'open', title: 'Open a repository', text: 'Use the cards below, pick one of your repositories, or drop a folder on the window.' },
    {
      id: 'palette',
      title: `Press ${palette} for the command palette`,
      text: 'Every action by name: pull, push, switch branch, stash, file history…',
      action: { label: 'Try it', run: () => dispatch(COMMANDS.toggleFuzzyFinder) }
    },
    {
      id: 'shortcuts',
      title: `Press ${shortcuts} for keyboard shortcuts`,
      text: 'Stage, commit and push without the mouse.',
      action: { label: 'Show', run: () => dispatch(COMMANDS.toggleKeyBindings) }
    }
  ]
  const finished = items.every((i) => steps.includes(i.id))
  return (
    <section className="wl-guide" aria-labelledby="wl-guide-title">
      <div className="wl-guide-head">
        <h2 id="wl-guide-title" className="wl-guide-title">
          {finished ? 'You are all set' : 'Get started in three steps'}
        </h2>
        <button className="btn ghost small" onClick={() => void setPrefs({ onboardingDone: true })}>
          {finished ? 'Done' : 'Skip guide'}
        </button>
      </div>
      <ol className="wl-steps">
        {items.map((item, i) => {
          const ok = steps.includes(item.id)
          return (
            <li key={item.id} className={`wl-step ${ok ? 'done' : ''}`}>
              <span className="wl-step-mark" aria-hidden>
                {ok ? <Icon name="check" size={12} /> : i + 1}
              </span>
              <div className="wl-step-text">
                <div className="wl-step-title">
                  {item.title}
                  {ok && <span className="sr-only"> (done)</span>}
                </div>
                <div className="muted">{item.text}</div>
              </div>
              {item.action && !ok && (
                <button className="btn small" onClick={item.action.run}>
                  {item.action.label}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

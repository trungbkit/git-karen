import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DiscoveredRepo, RecentRepo } from '@shared/types'
import { COMMANDS } from '@shared/commands'
import { useStore } from '../state/store'
import { Icon, type IconName } from '../ui/Icon'
import { showContextMenu } from '../ui/ContextMenu'
import { dispatch, openRepoDialog, shortcutFor } from '../keybindings'
import { relativeTime } from '../util/format'
import { greeting, shortPath, welcomeLists } from '../util/welcome'
import { RepoAvatar } from '../ui/RepoAvatar'
import { useRovingFocus } from '../ui/roving'
import appIcon from '../assets/icon.png'
import '../styles/shell.css'
import '../styles/home.css'

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
  const palette = shortcutFor(COMMANDS.toggleFuzzyFinder)

  // every repository row is one Tab stop: arrows move, Enter opens, Shift+F10 shows the menu
  const listsRef = useRef<HTMLDivElement>(null)
  useRovingFocus(listsRef, { items: '.wl-repo' })

  const toggleFavorite = async (path: string) => useStore.setState({ recent: await window.app.toggleFavorite(path) })
  const remove = async (path: string) => useStore.setState({ recent: await window.app.removeRecent(path) })
  const open = (path: string) => void openRepo(path).catch(() => undefined)

  const recentMenu = (path: string, favorite?: boolean) => [
    { label: 'Open', onClick: () => open(path) },
    { label: favorite ? 'Remove from favorites' : 'Add to favorites', onClick: () => void toggleFavorite(path) },
    { label: 'Show in folder', onClick: () => void window.app.showInFolder(path) },
    'separator' as const,
    { label: 'Remove from list', danger: true, onClick: () => void remove(path) }
  ]

  // the row buttons are mouse shortcuts; the row menu (Shift+F10) has them for keyboard users
  const rowButtons = ({ path, name, favorite }: RecentRepo) => (
    <span className="wl-row-btns">
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
    </span>
  )

  // plain render functions (not components) so a re-render keeps the focused row mounted
  const favoriteTile = (r: RecentRepo) => (
    <div
      key={r.path}
      className="wl-repo wl-tile"
      role="button"
      aria-label={`${r.name}, favorite, ${r.path}`}
      title={r.path}
      onClick={() => open(r.path)}
      onContextMenu={(e) => showContextMenu(e, recentMenu(r.path, r.favorite))}
    >
      <div className="wl-tile-top">
        <RepoAvatar name={r.name} path={r.path} size="lg" />
        {rowButtons(r)}
      </div>
      <div className="ellipsis wl-repo-name">{r.name}</div>
      <div className="ellipsis wl-repo-path">{shortPath(r.path)}</div>
      <div className="wl-tile-time">
        <Icon name="history" size={11} /> {relativeTime(r.lastOpened)}
      </div>
    </div>
  )

  const recentRow = (r: RecentRepo) => (
    <div
      key={r.path}
      className="wl-repo"
      role="button"
      aria-label={`${r.name}, ${r.path}`}
      title={r.path}
      onClick={() => open(r.path)}
      onContextMenu={(e) => showContextMenu(e, recentMenu(r.path, r.favorite))}
    >
      <RepoAvatar name={r.name} path={r.path} />
      <div className="wl-repo-text">
        <div className="ellipsis wl-repo-name">{r.name}</div>
        <div className="ellipsis wl-repo-path">{shortPath(r.path)}</div>
      </div>
      <span className="wl-repo-time">{relativeTime(r.lastOpened)}</span>
      {rowButtons(r)}
    </div>
  )

  const foundRow = ({ path, name, modified }: DiscoveredRepo) => (
    <div
      key={path}
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
      <RepoAvatar name={name} path={path} muted />
      <div className="wl-repo-text">
        <div className="ellipsis wl-repo-name">{name}</div>
        <div className="ellipsis wl-repo-path">{shortPath(path)}</div>
      </div>
      {modified > 0 && (
        <span className="wl-repo-time" title="Last change to its index or HEAD">
          {relativeTime(modified)}
        </span>
      )}
      <Icon name="chevron-right" size={14} className="wl-row-go" />
    </div>
  )

  return (
    <div className="welcome home-page">
      <div className="home-inner">
        <header className="home-hero">
          <img className="home-logo" src={appIcon} width={52} height={52} alt="" />
          <div className="home-hero-text">
            <div className="home-eyebrow">Karen · local-first Git client</div>
            <h1 className="home-title">{greeting(new Date().getHours())}</h1>
          </div>
          <span className="grow" />
          <button className="icon-btn home-hero-btn" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={() => dispatch(COMMANDS.toggleKeyBindings)}>
            <Icon name="list" size={16} />
          </button>
          <button className="icon-btn home-hero-btn" title="Preferences" aria-label="Preferences" onClick={() => setModal({ kind: 'preferences', section: 'general' })}>
            <Icon name="settings" size={16} />
          </button>
        </header>

        <Onboarding />

        <div className="wl-grid">
          <aside className="wl-side">
            <h2 className="home-heading">Start</h2>
            <div className="wl-actions">
              <Action icon="folder" title="Open repository" text="Browse to a local repository" keys={shortcutFor(COMMANDS.openRepo)} onClick={() => void openRepoDialog()} />
              <Action icon="fetch" title="Clone" text="Copy a remote repository from a URL" keys={shortcutFor(COMMANDS.cloneRepo)} onClick={() => setModal({ kind: 'clone' })} />
              <Action icon="plus" title="New repository" text="Initialize an empty local repository" keys={shortcutFor(COMMANDS.initRepo)} onClick={() => setModal({ kind: 'init' })} />
            </div>

            <h2 className="home-heading">Workspaces</h2>
            <button className="wl-card wl-workspaces" onClick={openWorkspaceTab} title="Branches, changes and ahead/behind of several repositories; fetch or pull them all">
              <span className="icon-tile">
                <Icon name="layers" size={18} />
              </span>
              <span className="wl-card-text">
                <span className="wl-card-title">{workspaces.length ? `${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'}` : 'Create a workspace'}</span>
                <span className="wl-card-sub">
                  {workspaces.length
                    ? workspaces.map((w) => `${w.name} (${w.repos.length})`).join(' · ')
                    : 'Group repositories to see and update them together'}
                </span>
              </span>
              <Icon name="chevron-right" size={14} className="wl-row-go" />
            </button>

            {palette && (
              <button className="wl-tip" onClick={() => dispatch(COMMANDS.toggleFuzzyFinder)}>
                <Icon name="sparkle" size={14} />
                <span className="grow">Command palette</span>
                <kbd className="wl-kbd">{palette}</kbd>
              </button>
            )}
          </aside>

          <main className="wl-main" ref={listsRef}>
            {total > 0 && (
              <div className="wl-filter">
                <Icon name="search" size={15} />
                <input
                  value={query}
                  placeholder="Search repositories by name or path"
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
                      listsRef.current?.querySelector<HTMLElement>('.wl-repo')?.focus()
                    }
                  }}
                />
                {query ? (
                  <button className="icon-btn" title="Clear filter" aria-label="Clear filter" onClick={() => setQuery('')}>
                    <Icon name="x" size={11} />
                  </button>
                ) : (
                  <span className="wl-filter-count">{total} repositories</span>
                )}
              </div>
            )}

            {lists.favorites.length > 0 && (
              <section className="wl-section">
                <SectionHead title="Favorites" count={lists.favorites.length} />
                <div className="wl-tiles">{lists.favorites.map(favoriteTile)}</div>
              </section>
            )}

            <section className="wl-section">
              <SectionHead title="Recent" count={lists.recent.length || undefined} />
              {lists.recent.length > 0 ? (
                <div className="home-list">{lists.recent.map(recentRow)}</div>
              ) : query ? (
                <div className="home-empty">No recent repository matches.</div>
              ) : (
                <div className="home-empty home-empty-big">
                  <span className="icon-tile">
                    <Icon name="history" size={18} />
                  </span>
                  <div>Repositories you open will show up here.</div>
                </div>
              )}
            </section>

            <section className="wl-section">
              <SectionHead title="On this computer" count={discovery.repos?.length ? lists.discovered.length + lists.hidden : undefined}>
                {discovery.scanning && <span className="spinner small" aria-label="Scanning" />}
                <button className="btn ghost small" disabled={discovery.scanning || scanDirs.length === 0} onClick={discovery.rescan} title="Scan the folders again">
                  <Icon name="refresh" size={12} /> Rescan
                </button>
                <button className="btn ghost small" onClick={() => setModal({ kind: 'preferences', section: 'general' })} title="Choose the folders to scan (Preferences > General)">
                  <Icon name="settings" size={12} /> Folders…
                </button>
              </SectionHead>
              {lists.discovered.length > 0 ? (
                <div className="home-list">
                  {lists.discovered.map(foundRow)}
                  {lists.hidden > 0 && (
                    <div className="wl-repo wl-more" role="button" onClick={() => setShowAll(true)}>
                      <Icon name="chevron-down" size={14} />
                      <span>Show {lists.hidden} more</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="home-empty">
                  {discovery.repos === null
                    ? 'Looking for repositories…'
                    : scanDirs.length === 0
                      ? 'No folders to scan. Add some in Preferences > General.'
                      : query && (discovery.repos?.length ?? 0) > 0
                        ? 'No found repository matches.'
                        : `No other repositories in ${scanDirs.map(shortPath).join(', ')} (two levels deep).`}
                </div>
              )}
            </section>
          </main>
        </div>
      </div>
    </div>
  )
}

function SectionHead({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return (
    <div className="wl-section-head">
      <h2 className="home-heading">{title}</h2>
      {count !== undefined && <span className="home-count">{count}</span>}
      <span className="grow" />
      {children}
    </div>
  )
}

function Action({ icon, title, text, keys, onClick }: { icon: IconName; title: string; text: string; keys?: string; onClick(): void }) {
  return (
    <button className="wl-card wl-action" onClick={onClick}>
      <span className="icon-tile">
        <Icon name={icon} size={18} />
      </span>
      <span className="wl-card-text">
        <span className="wl-card-title">{title}</span>
        <span className="wl-card-sub">{text}</span>
      </span>
      {keys && <kbd className="wl-kbd">{keys}</kbd>}
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
    { id: 'open', title: 'Open a repository', text: 'Use Open, Clone or New on the left, pick one of your repositories, or drop a folder on the window.' },
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

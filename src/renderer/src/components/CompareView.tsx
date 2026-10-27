// Compare view: what one revision changes and adds compared to another (two commits, or two branches).
import { useEffect, useMemo, useState } from 'react'
import type { Commit, CommitComparison, FileChange, FileDiff } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon, type IconName } from '../ui/Icon'
import { showContextMenu } from '../ui/ContextMenu'
import { formatDate, fullDate, shortSha } from '../util/format'
import { commitMenuItems, copyText, showInGraph } from '../actions/refActions'
import { openCompare } from '../actions/compareActions'
import { Avatar } from '../graph/avatar'
import { DiffBody, useNewSideLines } from './DiffView'
import { ImageDiff, isImagePath, isSvgPath } from './ImageDiff'
import { IGNORE_WHITESPACE_KEY, WRAP_KEY, readLocal, useStoredFlag, writeLocal } from '../diff/settings'
import { FileList, FileStats, FileViewToggle, fileMenuItems, type FileSelection } from './FileList'
import { DelayedDiffSkeleton } from '../ui/Skeleton'
import '../styles/detail.css'

type Tab = 'files' | 'commits'

const LARGE_DIFF_LINES = 15000

/** Commit a revision currently points at, as far as the loaded refs know (for reloading when it moves). */
function shaOf(repo: RepoTab, rev: string): string {
  if (rev === 'HEAD') return repo.status?.headSha ?? rev
  return repo.refs.find((r) => r.name === rev && r.type !== 'head')?.sha ?? rev
}

function RevChip({ repo, rev }: { repo: RepoTab; rev: string }) {
  const ref = repo.refs.find((r) => r.name === rev && r.type !== 'head')
  const commit = ref ? null : repo.commits.find((c) => c.sha === rev)
  const icon: IconName = ref?.type === 'tag' ? 'tag' : ref?.type === 'remote' ? 'remote' : ref ? 'branch' : 'commit'
  return (
    <span className="cmp-rev" title={commit ? `${rev}\n${commit.summary}` : rev}>
      <Icon name={icon} size={12} />
      {ref ? <span className="ellipsis">{rev}</span> : <span className="mono">{shortSha(rev)}</span>}
      {commit && <span className="ellipsis muted">{commit.summary}</span>}
    </span>
  )
}

export function CompareView({ repo, from, to }: { repo: RepoTab; from: string; to: string }) {
  const { setCenter } = useStore.getState()
  const [threeDot, setThreeDot] = useState(() => readLocal('kc:compareThreeDot', '1') === '1')
  const [tab, setTab] = useState<Tab>('files')
  const [state, setState] = useState<{ identity: string; data: CommitComparison | null; error: string | null }>({ identity: '', data: null, error: null })
  const [path, setPath] = useState<string | null>(null)

  // Reload when either side moves (fetch, commit, reset), not on every status refresh. A moved side keeps
  // showing the old result until the new one arrives; other sides or another mode start over.
  const identity = `${from}\0${to}\0${threeDot}`
  const key = `${identity}\0${shaOf(repo, from)}\0${shaOf(repo, to)}`
  useEffect(() => {
    let live = true
    setState((s) => (s.identity === identity ? s : { identity, data: null, error: null }))
    window.git.compareCommits(repo.path, from, to, threeDot).then(
      (data) => live && setState({ identity, data, error: null }),
      (e: Error) => live && setState({ identity, data: null, error: e.message })
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.path, key])

  const data = state.data
  const files = data?.files ?? []
  useEffect(() => {
    if (!data) return
    if (!path || !data.files.some((f) => f.path === path)) setPath(data.files[0]?.path ?? null)
  }, [data, path])

  const base = threeDot && data?.mergeBase ? data.mergeBase : from
  const totals = useMemo(() => files.reduce((t, f) => ({ add: t.add + (f.additions ?? 0), del: t.del + (f.deletions ?? 0) }), { add: 0, del: 0 }), [files])
  const selection = useMemo<FileSelection>(() => ({ paths: new Set(path ? [path] : []), anchor: path, lead: path }), [path])
  const close = () => setCenter({ kind: 'graph' })
  const toggleMode = (on: boolean) => {
    setThreeDot(on)
    writeLocal('kc:compareThreeDot', on ? '1' : '0')
  }

  return (
    <div className="view">
      <div className="view-head cmp-head">
        <Icon name="compare" size={14} />
        <span className="title">Compare</span>
        <RevChip repo={repo} rev={from} />
        <button className="icon-btn" title="Swap sides" aria-label="Swap sides" onClick={() => openCompare(to, from)}>
          <Icon name="swap" size={13} />
        </button>
        <RevChip repo={repo} rev={to} />
        <span className="grow" />
        <div className="seg">
          <button
            className={threeDot ? 'on' : ''}
            title={`What ${to} changed since it split from ${from} (git diff ${from}...${to})`}
            onClick={() => toggleMode(true)}
          >
            Since merge base
          </button>
          <button className={threeDot ? '' : 'on'} title={`Every difference between the two (git diff ${from}..${to})`} onClick={() => toggleMode(false)}>
            Direct
          </button>
        </div>
        <button className="icon-btn" title="Close" aria-label="Close" onClick={close}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="cmp-summary">
        {data ? (
          <>
            <span>
              <b>{to}</b> is {data.aheadCount} {data.aheadCount === 1 ? 'commit' : 'commits'} ahead and {data.behindCount} behind <b>{from}</b>
            </span>
            {data.mergeBase ? (
              <span className="muted">
                merge base{' '}
                <span className="sha-chip" title="Copy sha" onClick={() => copyText(data.mergeBase!, 'Commit sha copied')}>
                  {shortSha(data.mergeBase)}
                </span>
              </span>
            ) : (
              <span className="cmp-warn">No common history{threeDot ? ': showing the direct diff' : ''}</span>
            )}
          </>
        ) : (
          <span className="muted">{state.error ?? 'Comparing…'}</span>
        )}
      </div>
      <div className="cmp-tabs">
        <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
          Files <span className="lp-count">{data ? files.length : '…'}</span>
        </button>
        <button className={tab === 'commits' ? 'on' : ''} onClick={() => setTab('commits')}>
          Commits <span className="lp-count">{data ? data.aheadCount : '…'}</span>
        </button>
        {tab === 'files' && data && files.length > 0 && (
          <span className="cmp-tabs-extra">
            <FileStats files={files} compact />
            <span className="stats">
              <span className="add">+{totals.add}</span>
              <span className="del">−{totals.del}</span>
            </span>
            <FileViewToggle compact />
          </span>
        )}
      </div>
      {state.error && !data ? (
        <div className="view-message">{state.error}</div>
      ) : !data ? (
        <div className="view-message">Comparing…</div>
      ) : tab === 'files' ? (
        files.length === 0 ? (
          <div className="view-message">No file differences.</div>
        ) : (
          <div className="history">
            <div className="cmp-files">
              <FileList
                files={files}
                showStats
                scroll
                selection={selection}
                onSelectionChange={(sel) => sel.lead && setPath(sel.lead)}
                onClick={(f) => setPath(f.path)}
                onContextMenu={(e, f) => showContextMenu(e, fileMenuItems(repo, f.path))}
              />
            </div>
            {path ? <CompareDiff repo={repo} from={base} to={to} file={files.find((f) => f.path === path)} /> : <div />}
          </div>
        )
      ) : (
        <div className="view-body">
          <CommitSection repo={repo} title={`Only in ${to}`} commits={data.ahead} total={data.aheadCount} />
          <CommitSection repo={repo} title={`Only in ${from}`} commits={data.behind} total={data.behindCount} />
        </div>
      )}
    </div>
  )
}

function CompareDiff({ repo, from, to, file }: { repo: RepoTab; from: string; to: string; file?: FileChange }) {
  const [split, setSplit] = useState(() => readLocal('kc:compareLayout', 'unified') === 'split')
  const [wrap, setWrap] = useStoredFlag(WRAP_KEY)
  const [ignoreWs, setIgnoreWs] = useStoredFlag(IGNORE_WHITESPACE_KEY)
  const [svgAsText, setSvgAsText] = useStoredFlag('kc:svgAsText')
  const [showLarge, setShowLarge] = useState(false)
  const [state, setState] = useState<{ key: string; diff: FileDiff | null; error: string | null } | null>(null)
  const path = file?.path ?? ''
  const key = JSON.stringify([repo.path, from, to, path, ignoreWs])

  useEffect(() => {
    if (!path) return
    let live = true
    setShowLarge(false)
    window.git.diff(repo.path, { kind: 'compare', from, to, path }, { ignoreWhitespace: ignoreWs || undefined }).then(
      (diff) => live && setState({ key, diff, error: null }),
      (e: Error) => live && setState({ key, diff: null, error: e.message })
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const current = state?.key === key ? state : null
  const lines = current?.diff ? current.diff.hunks.reduce((n, h) => n + h.lines.length, 0) : 0
  const toggle = (k: string, v: boolean, set: (v: boolean) => void, value = v ? '1' : '0') => {
    set(v)
    writeLocal(k, value)
  }
  const target = { kind: 'compare', from, to, path } as const
  const showImage = isImagePath(path) && !!current?.diff && (current.diff.binary || (isSvgPath(path) && !svgAsText))
  const fileLines = useNewSideLines(repo.path, target, current?.diff, !showImage)
  const openLine = (line: number) =>
    void window.app
      .openInEditor(repo.path, path, line)
      .catch((e: Error) => useStore.getState().toast({ kind: 'error', title: 'Could not open the editor', message: e.message }))
  const slash = path.lastIndexOf('/')

  return (
    <div className="view">
      <div className="dv-head">
        <span className="dv-path" title={file?.oldPath ? `${file.oldPath} → ${path}` : path}>
          <span>
            {file?.oldPath && file.oldPath !== path && <span className="file-dir">{file.oldPath} → </span>}
            {slash >= 0 && <span className="file-dir">{path.slice(0, slash + 1)}</span>}
            {path.slice(slash + 1)}
          </span>
        </span>
        <span className="grow" />
        <span className="dv-group">
          <button className={`icon-btn ${!split ? 'on' : ''}`} aria-pressed={!split} title="Unified view" aria-label="Unified view" onClick={() => toggle('kc:compareLayout', false, setSplit, 'unified')}>
            <Icon name="hunks" size={14} />
          </button>
          <button className={`icon-btn ${split ? 'on' : ''}`} aria-pressed={split} title="Split view" aria-label="Split view" onClick={() => toggle('kc:compareLayout', true, setSplit, 'split')}>
            <Icon name="split" size={14} />
          </button>
        </span>
        <span className="dv-group">
          {isSvgPath(path) && (
            <button className={`icon-btn ${!svgAsText ? 'on' : ''}`} title={svgAsText ? 'Show as image' : 'Show the text diff'} aria-label={svgAsText ? 'Show as image' : 'Show the text diff'} onClick={() => setSvgAsText(!svgAsText)}>
              <Icon name="image" size={14} />
            </button>
          )}
          <button className={`icon-btn ${ignoreWs ? 'on' : ''}`} aria-pressed={ignoreWs} title="Ignore whitespace" aria-label="Ignore whitespace" onClick={() => setIgnoreWs(!ignoreWs)}>
            <Icon name="whitespace" size={14} />
          </button>
          <button className={`icon-btn ${wrap ? 'on' : ''}`} aria-pressed={wrap} title="Word wrap" aria-label="Word wrap" onClick={() => setWrap(!wrap)}>
            <Icon name="wrap" size={14} />
          </button>
          <button className="icon-btn" title="File history" aria-label="File history" onClick={() => useStore.getState().setCenter({ kind: 'history', path, blame: false })}>
            <Icon name="history" size={14} />
          </button>
        </span>
      </div>
      <div className="view-body">
        {!current ? (
          <DelayedDiffSkeleton />
        ) : current.error ? (
          <div className="view-message">{current.error}</div>
        ) : !current.diff ? (
          <div className="view-message">No changes for this file.</div>
        ) : lines > LARGE_DIFF_LINES && !showLarge ? (
          <div className="view-message">
            This diff is large ({lines.toLocaleString()} lines).
            <button className="btn" onClick={() => setShowLarge(true)}>
              Show anyway
            </button>
          </div>
        ) : showImage ? (
          <ImageDiff repo={repo.path} target={target} diff={current.diff} />
        ) : (
          <DiffBody
            diff={current.diff}
            layout={split ? 'split' : 'unified'}
            wrap={wrap}
            ignoreWhitespace={ignoreWs}
            fileLines={fileLines}
            onOpenLine={current.diff.isDeleted ? undefined : openLine}
          />
        )}
      </div>
    </div>
  )
}

function CommitSection({ repo, title, commits, total }: { repo: RepoTab; title: string; commits: Commit[]; total: number }) {
  const dateMode = useStore((s) => s.prefs.dateFormat)
  const showAvatars = useStore((s) => s.prefs.showAvatars)
  const selection = repo.selection
  const loaded = useMemo(() => new Set(repo.commits.map((c) => c.sha)), [repo.commits])
  const select = (sha: string) => useStore.getState().select({ kind: 'commit', shas: [sha] })
  return (
    <div className="cmp-section">
      <div className="cmp-section-head">
        {title} <span className="lp-count">{total}</span>
      </div>
      {commits.length === 0 && <div className="empty-list">None</div>}
      {commits.map((c) => {
        const selected = selection?.kind === 'commit' && selection.shas.includes(c.sha)
        return (
          <div
            key={c.sha}
            className={`reflog-row ${selected ? 'selected' : ''}`}
            onClick={() => select(c.sha)}
            onDoubleClick={() => loaded.has(c.sha) && showInGraph(c.sha)}
            onContextMenu={(e) => (select(c.sha), showContextMenu(e, commitMenuItems(repo, c.sha)))}
            title={loaded.has(c.sha) ? 'Double-click to view in graph' : undefined}
          >
            <Avatar name={c.author.name} email={c.author.email} size={16} remote={showAvatars} />
            <span className="ellipsis">{c.summary}</span>
            <span className="muted cmp-author ellipsis">{c.author.name}</span>
            <span className="mono reflog-sha">{shortSha(c.sha)}</span>
            <span className="muted reflog-date" title={fullDate(c.author.date)}>
              {formatDate(c.author.date, dateMode)}
            </span>
          </div>
        )
      })}
      {total > commits.length && <div className="empty-list">and {total - commits.length} more…</div>}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { Author, FileChange } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon } from '../ui/Icon'
import { showContextMenu, type MenuItem } from '../ui/ContextMenu'
import { confirm, prompt } from '../ui/dialogs'
import { FileList, FileViewToggle, fileMenuItems, type FileSelection } from './FileList'
import { generateCommitMessage } from '../smart/workflow'
import { discardFiles, offerUndo } from '../actions/undo'
import { discardImpact } from '../actions/impact'
import { CoAuthorPicker } from './CoAuthorPicker'
import {
  addTrailer,
  coAuthorTrailer,
  CONVENTIONAL_TYPES,
  lintCommitMessage,
  parseConventional,
  rememberMessage,
  scopesFromPaths,
  SUMMARY_LIMIT,
  SUMMARY_SOFT_LIMIT,
  templateDraft,
  withConventional
} from '../smart/message'
import { commitTitle } from '../smart/text'
import '../styles/detail.css'
import '../styles/staging.css'

interface Draft {
  summary: string
  description: string
  amend: boolean
  /** Draft saved before amend prefilled the HEAD message, restored when amend is turned off */
  beforeAmend?: { summary: string; description: string }
}

// Drafts survive tab switches and panel remounts.
const drafts = new Map<string, Draft>()
const emptyDraft = (): Draft => ({ summary: '', description: '', amend: false })

// commit.template contents by repo (null: none), read when the panel opens a repo
const templates = new Map<string, string | null>()
/** An empty draft, prefilled from the repo's commit template */
const freshDraft = (repo: string): Draft => {
  const template = templates.get(repo)
  return { ...emptyDraft(), ...(template ? templateDraft(template) : {}) }
}

/** Sign-off and signing choices per repo; `sign` null follows commit.gpgsign */
interface SigningChoice {
  signoff: boolean
  sign: boolean | null
}
const signing = new Map<string, SigningChoice>()

const NO_HISTORY: string[] = []

/** Repo config the composer reads: whether commits are signed by default, and who the user is */
interface ComposerConfig {
  gpgSign: boolean
  email: string | null
}

type ListKind = 'unstaged' | 'staged'

const plural = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`

function splitMessage(message: string): { summary: string; description: string } {
  const [summary = '', ...rest] = message.replace(/\s+$/, '').split('\n')
  return { summary, description: rest.join('\n').replace(/^\n+/, '') }
}

export function StagingPanel({ repo }: { repo: RepoTab }) {
  const status = repo.status
  const { run, setCenter } = useStore.getState()
  const pushAfterCommit = useStore((s) => s.prefs.pushAfterCommit)
  const [draft, setDraftState] = useState<Draft>(() => drafts.get(repo.path) ?? emptyDraft())
  const [noVerify, setNoVerify] = useState(false)
  const [signChoice, setSignChoiceState] = useState<SigningChoice>(() => signing.get(repo.path) ?? { signoff: false, sign: null })
  const [config, setConfig] = useState<ComposerConfig>({ gpgSign: false, email: null })
  const [coAuthorOpen, setCoAuthorOpen] = useState(false)
  const conventional = useStore((s) => s.prefs.conventionalCommits)
  const history = useStore((s) => s.prefs.commitHistory[repo.path]) ?? NO_HISTORY
  /** Alt+Up/Down position in the message history, and the draft to return to */
  const historyNav = useRef<{ index: number; saved: { summary: string; description: string } } | null>(null)
  const [generating, setGenerating] = useState(false)
  // multi-selection made with Cmd/Ctrl/Shift; without one each list highlights the file whose diff is open
  const [sel, setSel] = useState<(FileSelection & { list: ListKind }) | null>(null)
  // null hides the filter field
  const [filter, setFilter] = useState<string | null>(null)
  const summaryRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const selected =
    repo.center.kind === 'diff' && repo.center.target.kind === 'working' ? repo.center.target : null

  useEffect(() => {
    setDraftState(drafts.get(repo.path) ?? emptyDraft())
    setSel(null)
    setFilter(null)
    setSignChoiceState(signing.get(repo.path) ?? { signoff: false, sign: null })
    setCoAuthorOpen(false)
    historyNav.current = null
    let cancelled = false
    const path = repo.path
    const get = (key: string) => window.git.getConfig(path, key).catch(() => null)
    void Promise.all([get('commit.gpgsign'), get('user.email')]).then(([gpgSign, email]) => {
      if (!cancelled) setConfig({ gpgSign: gpgSign === 'true', email })
    })
    // prefill an untouched draft from commit.template
    window.git.commitTemplate(path).then(
      (template) => {
        templates.set(path, template)
        const current = drafts.get(path)
        if (cancelled || !template || (current && (current.summary || current.description || current.amend))) return
        const next = freshDraft(path)
        drafts.set(path, next)
        setDraftState(next)
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [repo.path])

  // a diff opened from elsewhere (diff view navigation, another panel) replaces a selection it is not part of
  useEffect(() => {
    if (!selected) return
    const list: ListKind = selected.staged ? 'staged' : 'unstaged'
    setSel((s) => (s && !(s.list === list && s.paths.has(selected.path)) ? null : s))
  }, [selected?.path, selected?.staged])

  const query = filter?.trim().toLowerCase() ?? ''
  const shown = useMemo(() => {
    const match = (files: FileChange[] = []) => (query ? files.filter((f) => f.path.toLowerCase().includes(query)) : files)
    return { conflicted: match(status?.conflicted), unstaged: match(status?.unstaged), staged: match(status?.staged) }
  }, [status, query])

  // the command arrives through a window event; the ref always holds this render's handler
  const writeWithAiRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    const generate = () => writeWithAiRef.current()
    window.addEventListener('kc:generateCommitMessage', generate)
    return () => window.removeEventListener('kc:generateCommitMessage', generate)
  }, [])

  useEffect(() => {
    const focus = () => summaryRef.current?.focus()
    // the first file list (conflicted, else unstaged, else staged); the summary when nothing changed
    const focusFiles = () => (panelRef.current?.querySelector<HTMLElement>('.stage-lists .file-list') ?? summaryRef.current)?.focus()
    window.addEventListener('kc:focusCommitMessage', focus)
    window.addEventListener('kc:focusChangedFiles', focusFiles)
    return () => {
      window.removeEventListener('kc:focusCommitMessage', focus)
      window.removeEventListener('kc:focusChangedFiles', focusFiles)
    }
  }, [])

  const setDraft = (patch: Partial<Draft>) => {
    setDraftState((d) => {
      const next = { ...d, ...patch }
      drafts.set(repo.path, next)
      return next
    })
  }

  const setSignChoice = (patch: Partial<SigningChoice>) => {
    const next = { ...signChoice, ...patch }
    signing.set(repo.path, next)
    setSignChoiceState(next)
  }

  if (!status) return <div className="rp-empty">Loading…</div>

  const { staged, unstaged, conflicted } = status

  const toggleAmend = async (amend: boolean) => {
    if (amend) {
      try {
        const message = await window.git.headMessage(repo.path)
        setDraft({ amend, beforeAmend: { summary: draft.summary, description: draft.description }, ...splitMessage(message) })
      } catch (e) {
        useStore.getState().toast({ kind: 'error', title: 'Could not read HEAD message', message: (e as Error).message })
      }
    } else {
      setDraft({ amend, ...(draft.beforeAmend ?? { summary: '', description: '' }), beforeAmend: undefined })
    }
  }

  const nothingStaged = staged.length === 0
  const canCommit =
    draft.summary.trim().length > 0 && conflicted.length === 0 && (staged.length > 0 || unstaged.length > 0 || draft.amend)

  const commit = async () => {
    if (!canCommit) return
    const message = draft.description.trim() ? `${draft.summary.trim()}\n\n${draft.description.trim()}` : draft.summary.trim()
    let amended: string | null = null
    const ok = await run(
      draft.amend ? 'Amending commit' : 'Committing',
      async (r) => {
        if (draft.amend) amended = await window.git.resolveRef(r, 'HEAD')
        if (nothingStaged && unstaged.length > 0 && !draft.amend) await window.git.stageAll(r)
        await window.git.commit(r, message, { amend: draft.amend, noVerify, signoff: signChoice.signoff, sign: signChoice.sign ?? undefined })
        if (pushAfterCommit) await window.git.push(r)
      },
      { success: draft.amend ? undefined : 'Committed' }
    )
    const before = amended as string | null
    if (ok && before) {
      // back to the commit as it was before amending; the amended changes stay staged
      offerUndo(repo.path, 'Amend', (r) => window.git.reset(r, before, 'soft'), { title: 'Commit amended' })
    }
    if (ok) {
      const { prefs, setPrefs } = useStore.getState()
      void setPrefs({ commitHistory: { ...prefs.commitHistory, [repo.path]: rememberMessage(prefs.commitHistory[repo.path] ?? [], message) } })
      const fresh = freshDraft(repo.path)
      drafts.set(repo.path, fresh)
      setDraftState(fresh)
      historyNav.current = null
      if (repo.center.kind === 'diff') setCenter({ kind: 'graph' })
    }
  }

  // ---- message history: Alt+Up / Alt+Down in the summary, or the History menu
  const loadMessage = (message: string) => setDraft(splitMessage(message))

  const browseHistory = (dir: 1 | -1) => {
    const cur = historyNav.current
    const index = (cur?.index ?? -1) + dir
    if (index < 0) {
      // back past the newest entry: the draft as it was before browsing
      if (cur) setDraft(cur.saved)
      historyNav.current = null
      return
    }
    if (index >= history.length) return
    historyNav.current = { index, saved: cur?.saved ?? { summary: draft.summary, description: draft.description } }
    loadMessage(history[index])
  }

  const historyMenu = (): MenuItem[] =>
    history.map((m) => {
      const title = commitTitle(m)
      return { label: title.length > 60 ? `${title.slice(0, 59)}…` : title, hint: m.includes('\n') ? '+ description' : undefined, onClick: () => loadMessage(m) }
    })

  const onSummaryKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      browseHistory(e.key === 'ArrowUp' ? 1 : -1)
    }
  }

  // a whole message pasted into an empty composer fills both fields
  const onSummaryPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    const input = e.currentTarget
    const replacesAll = input.selectionStart === 0 && input.selectionEnd === input.value.length
    if (!text.includes('\n') || !(replacesAll || !draft.summary) || draft.description.trim()) return
    e.preventDefault()
    setDraft(splitMessage(text))
  }

  const addCoAuthor = (a: Author) => {
    setDraft({ description: addTrailer(draft.description, coAuthorTrailer(a)) })
    setCoAuthorOpen(false)
  }

  // describes what the commit button would commit: the index, or everything when nothing is staged yet
  const writeWithAi = async () => {
    if (generating || (staged.length === 0 && unstaged.length === 0)) return
    setGenerating(true)
    try {
      const message = await generateCommitMessage(repo.path, nothingStaged)
      setDraft(splitMessage(message))
    } catch (e) {
      const { toast, setModal } = useStore.getState()
      const unset = await window.ai.status().then((s) => !s.active, () => false)
      toast({
        kind: 'error',
        title: 'Could not write a commit message',
        message: (e as Error).message,
        action: unset ? { label: 'Set up AI', run: () => setModal({ kind: 'preferences', section: 'ai' }) } : undefined
      })
    } finally {
      setGenerating(false)
    }
  }

  writeWithAiRef.current = () => void writeWithAi()

  const onComposerKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      void commit()
    }
  }

  const openDiff = (f: FileChange, isStaged: boolean) =>
    setCenter({ kind: 'diff', target: { kind: 'working', path: f.path, staged: isStaged } })

  const selectionFor = (list: ListKind, files: FileChange[]): FileSelection => {
    if (sel?.list === list) {
      const present = new Set(files.map((f) => f.path))
      const paths = new Set([...sel.paths].filter((p) => present.has(p)))
      if (paths.size > 0) return { ...sel, paths }
    } else if (sel && sel.paths.size > 0) {
      return { paths: new Set(), anchor: null, lead: null }
    }
    const open = selected && selected.staged === (list === 'staged') ? selected.path : null
    return { paths: new Set(open ? [open] : []), anchor: open, lead: open }
  }
  const unstagedSel = selectionFor('unstaged', shown.unstaged)
  const stagedSel = selectionFor('staged', shown.staged)
  const multi = (s: FileSelection) => (s.paths.size > 1 ? [...s.paths] : null)
  // row buttons act on the whole selection when the row is part of it
  const targets = (s: FileSelection, f: FileChange) => (s.paths.size > 1 && s.paths.has(f.path) ? [...s.paths] : [f.path])

  const stage = async (paths: string[]) => {
    if (await run('Staging', (r) => window.git.stage(r, paths), { log: false })) setSel(null)
  }
  const unstage = async (paths: string[]) => {
    if (await run('Unstaging', (r) => window.git.unstage(r, paths), { log: false })) setSel(null)
  }
  // a list emptied from the keyboard unmounts with the focus in it: carry on in the next list, or the summary
  const keepFocus = () =>
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      panelRef.current?.querySelector<HTMLElement>('.stage-lists .file-list, .composer input')?.focus()
    })
  const copyPaths = (paths: string[]) => void navigator.clipboard.writeText(paths.join('\n'))

  const ignoreItems = (path: string): MenuItem[] => {
    const slash = path.lastIndexOf('/')
    const name = path.slice(slash + 1)
    const dot = name.lastIndexOf('.')
    const ignore = (pattern: string) => run('Updating .gitignore', (r) => window.git.ignore(r, pattern), { log: false })
    return [
      { label: 'Ignore this file', onClick: () => void ignore(`/${path}`) },
      dot > 0 && { label: `Ignore all *${name.slice(dot)} files`, onClick: () => void ignore(`*${name.slice(dot)}`) },
      slash > 0 && { label: `Ignore folder ${path.slice(0, slash)}/`, onClick: () => void ignore(`/${path.slice(0, slash)}/`) }
    ]
  }

  const discard = async (paths: string[]) => {
    const what = paths.length === 1 ? paths[0] : `${paths.length} files`
    const ok = await confirm('Discard changes?', `This discards all unstaged changes to ${what}.`, {
      confirmLabel: 'Discard',
      danger: true,
      impact: discardImpact(repo, paths)
    })
    if (ok && (await discardFiles(paths, what))) setSel(null)
  }

  const unstagedMenu = (f: FileChange): MenuItem[] => {
    const paths = targets(unstagedSel, f)
    if (paths.length > 1) return bulkUnstagedMenu(paths)
    return [
      { label: 'Stage', onClick: () => void stage([f.path]) },
      { label: 'Discard changes', danger: true, onClick: () => void discard([f.path]) },
      f.status === 'untracked' && { label: 'Ignore', submenu: ignoreItems(f.path) },
      'separator',
      ...fileMenuItems(repo, f.path)
    ]
  }

  const bulkUnstagedMenu = (paths: string[]): MenuItem[] => [
    { label: `Stage ${plural(paths.length)}`, onClick: () => void stage(paths) },
    { label: `Discard changes to ${plural(paths.length)}`, danger: true, onClick: () => void discard(paths) },
    'separator',
    { label: 'Copy file paths', onClick: () => copyPaths(paths) }
  ]

  const stagedMenu = (f: FileChange): MenuItem[] => {
    const paths = targets(stagedSel, f)
    if (paths.length > 1) return bulkStagedMenu(paths)
    return [{ label: 'Unstage', onClick: () => void unstage([f.path]) }, 'separator', ...fileMenuItems(repo, f.path)]
  }

  const bulkStagedMenu = (paths: string[]): MenuItem[] => [
    { label: `Unstage ${plural(paths.length)}`, onClick: () => void unstage(paths) },
    'separator',
    { label: 'Copy file paths', onClick: () => copyPaths(paths) }
  ]

  const conflictMenu = (f: FileChange): MenuItem[] => [
    { label: 'Open merge tool', onClick: () => setCenter({ kind: 'conflict', path: f.path }) },
    { label: 'Take current (ours)', onClick: () => void run('Resolving', (r) => window.git.takeSide(r, [f.path], 'ours'), { log: false }) },
    { label: 'Take incoming (theirs)', onClick: () => void run('Resolving', (r) => window.git.takeSide(r, [f.path], 'theirs'), { log: false }) },
    { label: 'Mark as resolved', onClick: () => void run('Resolving', (r) => window.git.stage(r, [f.path]), { log: false }) },
    'separator',
    ...fileMenuItems(repo, f.path)
  ]

  const stash = async () => {
    const res = await prompt({
      title: 'Stash changes',
      fields: [{ name: 'message', label: 'Stash message (optional)', placeholder: 'WIP' }],
      checkboxes: [{ name: 'untracked', label: 'Include untracked files', initial: true }],
      confirmLabel: 'Stash'
    })
    if (res) await run('Stashing', (r) => window.git.stashSave(r, res.message || undefined, res.checks.untracked), { success: 'Changes stashed' })
  }

  const total = staged.length + unstaged.length + conflicted.length
  // lint never blocks the commit; it only warns
  const lint = lintCommitMessage(draft.description.trim() ? `${draft.summary}\n\n${draft.description}` : draft.summary, { conventional })
  const cc = parseConventional(draft.summary)
  const ccTypes: string[] = cc && !(CONVENTIONAL_TYPES as readonly string[]).includes(cc.type) ? [...CONVENTIONAL_TYPES, cc.type] : [...CONVENTIONAL_TYPES]
  const scopes = scopesFromPaths((nothingStaged ? unstaged : staged).map((f) => f.path))
  const scopeListId = repo.path.replace(/[^\w]/g, '_')
  const pickedUnstaged = multi(unstagedSel)
  const pickedStaged = multi(stagedSel)
  const countLabel = (shownFiles: FileChange[], all: FileChange[]) => (query ? `${shownFiles.length}/${all.length}` : all.length)
  const commitLabel = draft.amend
    ? 'Amend previous commit'
    : nothingStaged && unstaged.length > 0
      ? `Stage all & commit (${unstaged.length})`
      : `Commit changes to ${staged.length} ${staged.length === 1 ? 'file' : 'files'}`

  return (
    <div className="rp" ref={panelRef}>
      <div className="section-head">
        <span>
          {total} {total === 1 ? 'file change' : 'file changes'} on{' '}
          <span style={{ textTransform: 'none', color: 'var(--text)' }}>{status.branch ?? (status.headSha ? status.headSha.slice(0, 7) : 'HEAD')}</span>
        </span>
        <span className="grow" />
        <button className={`icon-btn ${filter !== null ? 'active' : ''}`} title="Filter files" aria-label="Filter files" disabled={total === 0 && filter === null} onClick={() => setFilter(filter === null ? '' : null)}>
          <Icon name="search" size={13} />
        </button>
        <button className="icon-btn" title="Stash changes" aria-label="Stash changes" disabled={total === 0} onClick={() => void stash()}>
          <Icon name="stash" size={13} />
        </button>
        <button className="icon-btn" title="Discard all changes" aria-label="Discard all changes" disabled={unstaged.length === 0 && staged.length === 0} onClick={() => void discard([...new Set([...staged, ...unstaged].map((f) => f.path))])}>
          <Icon name="trash" size={13} />
        </button>
        <FileViewToggle compact />
      </div>
      {filter !== null && (
        <div className="stage-filter">
          <Icon name="search" size={12} />
          <input
            autoFocus
            placeholder="Filter files"
            aria-label="Filter files"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              setFilter(null)
            }}
          />
          <button className="icon-btn" title="Close filter (Esc)" aria-label="Close filter (Esc)" onClick={() => setFilter(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <div className="stage-lists">
        {conflicted.length > 0 && (
          <div className="stage-section">
            <div className="section-head" style={{ color: 'var(--danger)' }}>
              <Icon name="warning" size={12} />
              <span>Conflicted</span>
              <span className="count">{countLabel(shown.conflicted, conflicted)}</span>
            </div>
            {shown.conflicted.length === 0 ? (
              <div className="empty-list">No matching files</div>
            ) : (
              <FileList
                scroll
                label="Conflicted files"
                files={shown.conflicted}
                selectedPath={repo.center.kind === 'conflict' ? repo.center.path : null}
                onClick={(f) => setCenter({ kind: 'conflict', path: f.path })}
                onContextMenu={(e, f) => showContextMenu(e, conflictMenu(f))}
                actions={(f) => (
                  <button className="icon-btn" title="Mark as resolved" aria-label="Mark as resolved" onClick={(e) => (e.stopPropagation(), void run('Resolving', (r) => window.git.stage(r, [f.path]), { log: false }))}>
                    <Icon name="check" size={12} />
                  </button>
                )}
              />
            )}
          </div>
        )}
        <div className="stage-section">
          <div className="section-head">
            <span>Unstaged files</span>
            <span className="count">{countLabel(shown.unstaged, unstaged)}</span>
            <span className="grow" />
            {pickedUnstaged ? (
              <button className="btn small" onClick={() => void stage(pickedUnstaged)} title="Stage the selected files">
                Stage {pickedUnstaged.length} selected
              </button>
            ) : (
              <button
                className="btn small"
                disabled={shown.unstaged.length === 0}
                onClick={() => void (query ? stage(shown.unstaged.map((f) => f.path)) : run('Staging all', (r) => window.git.stageAll(r), { log: false }))}
              >
                {query ? 'Stage shown' : 'Stage all'}
              </button>
            )}
          </div>
          {shown.unstaged.length === 0 ? (
            <div className="empty-list">{query && unstaged.length > 0 ? 'No matching files' : 'No unstaged changes'}</div>
          ) : (
            <FileList
              scroll
              label="Unstaged files (Enter stages)"
              files={shown.unstaged}
              onEnter={(paths) => void stage(paths).then(keepFocus)}
              selection={unstagedSel}
              onSelectionChange={(s) => setSel({ ...s, list: 'unstaged' })}
              onClick={(f) => openDiff(f, false)}
              onContextMenu={(e, f) => showContextMenu(e, unstagedMenu(f))}
              onFolderContextMenu={(e, files) => showContextMenu(e, bulkUnstagedMenu(files.map((f) => f.path)))}
              actions={(f) => {
                const paths = targets(unstagedSel, f)
                return (
                  <>
                    <button className="icon-btn" title={paths.length > 1 ? `Discard changes to ${paths.length} selected files` : 'Discard changes'} aria-label={paths.length > 1 ? `Discard changes to ${paths.length} selected files` : 'Discard changes'} onClick={(e) => (e.stopPropagation(), void discard(paths))}>
                      <Icon name="trash" size={12} />
                    </button>
                    <button className="btn small" title={paths.length > 1 ? `Stage ${paths.length} selected files` : undefined} onClick={(e) => (e.stopPropagation(), void stage(paths))}>
                      Stage
                    </button>
                  </>
                )
              }}
              folderActions={(files) => (
                <>
                  <button className="icon-btn" title={`Discard changes to ${plural(files.length)}`} aria-label={`Discard changes to ${plural(files.length)}`} onClick={(e) => (e.stopPropagation(), void discard(files.map((f) => f.path)))}>
                    <Icon name="trash" size={12} />
                  </button>
                  <button className="btn small" title={`Stage ${plural(files.length)}`} onClick={(e) => (e.stopPropagation(), void stage(files.map((f) => f.path)))}>
                    Stage
                  </button>
                </>
              )}
            />
          )}
        </div>
        <div className="stage-section">
          <div className="section-head">
            <span>Staged files</span>
            <span className="count">{countLabel(shown.staged, staged)}</span>
            <span className="grow" />
            {pickedStaged ? (
              <button className="btn small" onClick={() => void unstage(pickedStaged)} title="Unstage the selected files">
                Unstage {pickedStaged.length} selected
              </button>
            ) : (
              <button
                className="btn small"
                disabled={shown.staged.length === 0}
                onClick={() => void (query ? unstage(shown.staged.map((f) => f.path)) : run('Unstaging all', (r) => window.git.unstageAll(r), { log: false }))}
              >
                {query ? 'Unstage shown' : 'Unstage all'}
              </button>
            )}
          </div>
          {shown.staged.length === 0 ? (
            <div className="empty-list">{query && staged.length > 0 ? 'No matching files' : 'No staged changes'}</div>
          ) : (
            <FileList
              scroll
              label="Staged files (Enter unstages)"
              files={shown.staged}
              onEnter={(paths) => void unstage(paths).then(keepFocus)}
              selection={stagedSel}
              onSelectionChange={(s) => setSel({ ...s, list: 'staged' })}
              onClick={(f) => openDiff(f, true)}
              onContextMenu={(e, f) => showContextMenu(e, stagedMenu(f))}
              onFolderContextMenu={(e, files) => showContextMenu(e, bulkStagedMenu(files.map((f) => f.path)))}
              actions={(f) => {
                const paths = targets(stagedSel, f)
                return (
                  <button className="btn small" title={paths.length > 1 ? `Unstage ${paths.length} selected files` : undefined} onClick={(e) => (e.stopPropagation(), void unstage(paths))}>
                    Unstage
                  </button>
                )
              }}
              folderActions={(files) => (
                <button className="btn small" title={`Unstage ${plural(files.length)}`} onClick={(e) => (e.stopPropagation(), void unstage(files.map((f) => f.path)))}>
                  Unstage
                </button>
              )}
            />
          )}
        </div>
      </div>
      <div className="composer" onKeyDown={onComposerKey}>
        {conventional && (
          <div className="composer-cc">
            <select
              value={cc?.type ?? ''}
              title="Conventional Commits type"
              aria-label="Conventional Commits type"
              onChange={(e) => setDraft({ summary: withConventional(draft.summary, { type: e.target.value, scope: cc?.scope ?? '' }) })}
            >
              <option value="">type…</option>
              {ccTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              list={`cc-scopes-${scopeListId}`}
              placeholder={scopes.length ? `scope (${scopes.slice(0, 3).join(', ')})` : 'scope'}
              title="Scope (optional): top-level folders of the changed files are suggested"
              aria-label="Conventional Commits scope"
              disabled={!cc}
              value={cc?.scope ?? ''}
              onChange={(e) => cc && setDraft({ summary: withConventional(draft.summary, { type: cc.type, scope: e.target.value.replace(/[()\s]/g, '') }) })}
            />
            <datalist id={`cc-scopes-${scopeListId}`}>
              {scopes.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
        )}
        <div className="composer-summary">
          <input
            ref={summaryRef}
            className="commit-message-input"
            placeholder="Commit summary"
            aria-label="Commit summary (⌘/Ctrl+Enter commits)"
            title={history.length ? 'Alt+↑ / Alt+↓: previous messages' : undefined}
            value={draft.summary}
            onChange={(e) => ((historyNav.current = null), setDraft({ summary: e.target.value }))}
            onKeyDown={onSummaryKey}
            onPaste={onSummaryPaste}
          />
          <span
            className={`counter ${draft.summary.length > SUMMARY_LIMIT ? 'over' : draft.summary.length > SUMMARY_SOFT_LIMIT ? 'near' : ''}`}
            title={`${draft.summary.length} characters; aim for ${SUMMARY_SOFT_LIMIT}, at most ${SUMMARY_LIMIT}`}
          >
            {SUMMARY_LIMIT - draft.summary.length}
          </span>
        </div>
        {lint.length > 0 && (
          <div className="composer-lint" role="status">
            {lint.map((w) => (
              <span key={w.rule}>
                <Icon name="warning" size={11} /> {w.message}
              </span>
            ))}
          </div>
        )}
        <textarea
          aria-label="Commit description"
          placeholder="Description"
          value={draft.description}
          onChange={(e) => ((historyNav.current = null), setDraft({ description: e.target.value }))}
        />
        <div className="composer-tools">
          <button
            className="btn ghost small"
            disabled={history.length === 0}
            title={history.length ? 'Reuse a recent commit message (Alt+↑ in the summary)' : 'No commit messages yet'}
            onClick={(e) => showContextMenu(e, historyMenu())}
          >
            <Icon name="history" size={12} /> History
          </button>
          <button className="btn ghost small" title="Add a Co-authored-by trailer for someone from recent commits" onClick={() => setCoAuthorOpen(!coAuthorOpen)}>
            <Icon name="user-plus" size={12} /> Co-author
          </button>
          {coAuthorOpen && <CoAuthorPicker repo={repo.path} exclude={config.email ? [config.email] : []} onPick={addCoAuthor} onClose={() => setCoAuthorOpen(false)} />}
        </div>
        <div className="composer-opts">
          <label className="check" title="Rewrite the last commit with the staged changes and this message">
            <input type="checkbox" checked={draft.amend} onChange={(e) => void toggleAmend(e.target.checked)} />
            Amend
          </label>
          <label className="check" title="Pass --no-verify (skip pre-commit and commit-msg hooks)">
            <input type="checkbox" checked={noVerify} onChange={(e) => setNoVerify(e.target.checked)} />
            Skip hooks
          </label>
          <label className="check" title="Add a Signed-off-by trailer (--signoff)">
            <input type="checkbox" checked={signChoice.signoff} onChange={(e) => setSignChoice({ signoff: e.target.checked })} />
            Sign-off
          </label>
          <label className="check" title={`Sign the commit with your GPG/SSH key (-S). Default from commit.gpgsign: ${config.gpgSign ? 'on' : 'off'}`}>
            <input type="checkbox" checked={signChoice.sign ?? config.gpgSign} onChange={(e) => setSignChoice({ sign: e.target.checked === config.gpgSign ? null : e.target.checked })} />
            Sign
          </label>
          {pushAfterCommit && <span title="Enabled in Preferences">· push after commit</span>}
        </div>
        <div className="composer-ai">
          <button
            className="btn small grow"
            disabled={generating || draft.amend || (staged.length === 0 && unstaged.length === 0)}
            onClick={() => void writeWithAi()}
            title={nothingStaged ? 'Write a commit message for all changes with AI' : 'Write a commit message for the staged changes with AI'}
          >
            {generating ? <span className="spinner small" /> : <Icon name="sparkle" size={12} />} {generating ? 'Writing…' : 'Write message with AI'}
          </button>
          <button
            className="btn small"
            disabled={!!repo.busy || conflicted.length > 0 || draft.amend || !status.headSha || staged.length + unstaged.length === 0}
            onClick={() => useStore.getState().setModal({ kind: 'splitCommit' })}
            title="Let AI group all changes into several commits"
          >
            <Icon name="scissors" size={12} /> Split…
          </button>
          <button className="btn small" disabled={!!repo.busy || conflicted.length > 0} onClick={() => useStore.getState().setModal({ kind: 'smartCommit' })} title="Stage, commit, push and open pull requests in one go">
            <Icon name="pull-request" size={12} /> Smart commit &amp; PR…
          </button>
        </div>
        <button className="btn primary" disabled={!canCommit || !!repo.busy} onClick={() => void commit()} title="⌘/Ctrl + Enter">
          {repo.busy === 'Committing' || repo.busy === 'Amending commit' ? 'Committing…' : commitLabel}
        </button>
        {conflicted.length > 0 && <span className="muted" style={{ fontSize: 12 }}>Resolve all conflicts before committing.</span>}
      </div>
    </div>
  )
}

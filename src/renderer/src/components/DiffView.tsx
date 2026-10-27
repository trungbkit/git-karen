import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { DiffHunk, DiffLine, DiffOptions, DiffTarget, FileChange, FileDiff, FileStatusCode } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon, type IconName } from '../ui/Icon'
import { confirm } from '../ui/dialogs'
import { basename, shortSha } from '../util/format'
import { useCommitDetail } from './CommitDetail'
import { StatusIcon } from './FileList'
import { buildEditedHunkPatch, buildPatch, hunkEditText, type HunkSelection, type PatchMode } from '../diff/patch'
import { discardPatch } from '../actions/undo'
import { diffCommandFor, formatKeys } from '../keybindings'
import { Modal } from '../ui/Modal'
import { patchImpact } from '../actions/impact'
import { useDiffTokens, useTokens } from '../highlight/useHighlight'
import { TokenLine } from '../highlight/Highlighted'
import { hashText, type Token } from '../highlight/tokens'
import { DIFF_CELL_BUDGET, wordDiff, type Range } from '../diff/wordDiff'
import { EXPAND_STEP, contextMatches, diffGaps, gapParts, revealLines, splitFileLines, type Gap, type LineRange } from '../diff/expand'
import { IGNORE_WHITESPACE_KEY, WRAP_KEY, readLocal, useStoredFlag, writeLocal } from '../diff/settings'
import { showContextMenu } from '../ui/ContextMenu'
import { ImageDiff, isImagePath, isSvgPath } from './ImageDiff'
import { DelayedDiffSkeleton } from '../ui/Skeleton'
import { scrollBehavior } from '../ui/appearance'
import '../styles/detail.css'
import '../styles/staging.css'
import '../styles/review.css'

export type DiffLayout = 'unified' | 'split'
/** Hunk = changes with a few lines of context, Inline = the whole file with changes, Split = side by side */
type DiffMode = 'hunk' | 'inline' | 'split'
type ViewKind = 'diff' | 'file'

/** Context lines requested for whole-file views. */
const FULL_CONTEXT = 1_000_000

const LARGE_DIFF_LINES = 15000

// ---------------------------------------------------------------------------------------------
// Presentational diff renderer (also used by FileHistoryView)

interface NumberedLine {
  line: DiffLine
  index: number
  oldNo?: number
  newNo?: number
  /** Line of the new file to open in the editor (where a removed line was) */
  editorLine?: number
}

/** Diffs with more lines than this render first and get their changed words highlighted right after. */
const DEFER_WORD_DIFF_LINES = 1000

function numberLines(hunk: DiffHunk): NumberedLine[] {
  let o = hunk.oldStart
  let n = hunk.newStart
  const out: NumberedLine[] = hunk.lines.map((line, index) => {
    if (line.type === 'context') {
      const nl = { line, index, oldNo: line.oldLine ?? o, newNo: line.newLine ?? n }
      ;[o, n] = [nl.oldNo + 1, nl.newNo + 1]
      return { ...nl, editorLine: nl.newNo }
    }
    if (line.type === 'del') {
      const oldNo = line.oldLine ?? o
      o = oldNo + 1
      return { line, index, oldNo, editorLine: Math.max(1, n) }
    }
    if (line.type === 'add') {
      const newNo = line.newLine ?? n
      n = newNo + 1
      return { line, index, newNo, editorLine: newNo }
    }
    return { line, index }
  })
  return out
}

/** Changed words of each line, by hunk and line index: runs of deletions followed by additions are paired up. */
function wordHighlights(hunks: DiffHunk[], ignoreWhitespace: boolean): (Range[] | undefined)[][] {
  const budget = { cells: DIFF_CELL_BUDGET }
  return hunks.map(({ lines }) => {
    const out: (Range[] | undefined)[] = new Array(lines.length)
    let i = 0
    while (i < lines.length) {
      if (lines[i].type !== 'del') {
        i++
        continue
      }
      const dels: number[] = []
      while (i < lines.length && (lines[i].type === 'del' || lines[i].type === 'meta')) {
        if (lines[i].type === 'del') dels.push(i)
        i++
      }
      const adds: number[] = []
      while (i < lines.length && (lines[i].type === 'add' || lines[i].type === 'meta')) {
        if (lines[i].type === 'add') adds.push(i)
        i++
      }
      const pairs = Math.min(dels.length, adds.length)
      for (let p = 0; p < pairs; p++) {
        // null: too long to compare, or rewritten rather than edited
        const d = wordDiff(lines[dels[p]].content, lines[adds[p]].content, { ignoreWhitespace, budget })
        if (d?.a.length) out[dels[p]] = d.a
        if (d?.b.length) out[adds[p]] = d.b
      }
    }
    return out
  })
}

function Code({ nl, tokens, hl }: { nl: NumberedLine; tokens?: Token[] | null; hl?: Range[] }) {
  const text = nl.line.content
  if (tokens && text)
    return (
      <span className="code">
        <TokenLine tokens={tokens} changed={hl} changedClass={`hl ${nl.line.type}`} />
      </span>
    )
  if (!hl) return <span className="code">{text || ' '}</span>
  const parts: ReactNode[] = []
  let at = 0
  for (const [s, e] of hl) {
    if (s > at) parts.push(text.slice(at, s))
    parts.push(
      <span key={s} className={`hl ${nl.line.type}`}>
        {text.slice(s, e)}
      </span>
    )
    at = e
  }
  parts.push(text.slice(at))
  return <span className="code">{parts}</span>
}

interface DiffBodyProps {
  diff: FileDiff
  layout: DiffLayout
  wrap: boolean
  /** Whole-file diff: one continuous block without hunk boxes */
  continuous?: boolean
  /** Selected line keys `${hunk}:${line}` */
  selected?: Set<string>
  onLineClick?(hunk: number, line: number, e: MouseEvent): void
  hunkActions?(hunk: number): ReactNode
  /** Hunk the keyboard acts on (outlined) */
  focusedHunk?: number
  /** Clicking inside a hunk focuses it */
  onHunkFocus?(hunk: number): void
  /** The diff ignores whitespace: changed words are compared without it too */
  ignoreWhitespace?: boolean
  /** The file at the diff's new side, by line: unchanged lines around the hunks can then be revealed */
  fileLines?: string[] | null
  /** Open the new file at a line: from the line number where lines are not selectable, and from the context menu */
  onOpenLine?(line: number): void
}

export function DiffBody({
  diff,
  layout,
  wrap,
  continuous,
  selected,
  onLineClick,
  hunkActions,
  focusedHunk,
  onHunkFocus,
  ignoreWhitespace,
  fileLines,
  onOpenLine
}: DiffBodyProps) {
  const numbered = useMemo(() => diff.hunks.map(numberLines), [diff])
  const tokens = useDiffTokens(diff)
  // A large diff renders without changed-word highlights first and gets them in a background render, so word diff
  // never delays showing it. Small ones are highlighted at once.
  const large = useMemo(() => diff.hunks.reduce((n, h) => n + h.lines.length, 0) > DEFER_WORD_DIFF_LINES, [diff])
  const deferred = useDeferredValue<FileDiff | null>(diff, null)
  const wordSource = large ? deferred : diff
  const words = useMemo(
    () => (wordSource === diff ? wordHighlights(diff.hunks, !!ignoreWhitespace) : null),
    [wordSource, diff, ignoreWhitespace]
  )

  // ---- unchanged lines between hunks. Revealed lines are display only; the hunks (and so staging) never change.
  const context = useMemo(() => {
    if (!fileLines || continuous || diff.binary || !contextMatches(diff.hunks, fileLines, ignoreWhitespace)) return null
    const text = fileLines.join('\n')
    // revealed lines are kept while the file stays the same (staging other lines of it, reloads)
    return { lines: fileLines, text, key: `${diff.path}\u0000${hashText(text)}`, gaps: diffGaps(diff.hunks, fileLines.length) }
  }, [diff, fileLines, continuous, ignoreWhitespace])
  const [revealedState, setRevealed] = useState<{ key: string; ranges: LineRange[] }>({ key: '', ranges: [] })
  const revealed = context && revealedState.key === context.key ? revealedState.ranges : []
  const reveal = (first: number, last: number) => context && setRevealed({ key: context.key, ranges: revealLines(revealed, first, last) })
  const fileTokens = useTokens(diff.path, context && revealed.length > 0 ? context.text : null)

  if (diff.binary) return <div className="view-message">Binary file — no text diff available.</div>
  if (diff.hunks.length === 0) return <div className="view-message">File contents are unchanged (mode or rename only).</div>

  const selectable = (l: DiffLine) => !!onLineClick && (l.type === 'add' || l.type === 'del')
  // without line selection, the line number opens the editor
  const opens = (nl: NumberedLine) => !!onOpenLine && !onLineClick && nl.editorLine !== undefined
  const lineClass = (h: number, nl: NumberedLine) =>
    `dl ${nl.line.type} ${selectable(nl.line) ? 'selectable' : ''} ${opens(nl) ? 'opens' : ''} ${selected?.has(`${h}:${nl.index}`) ? 'sel' : ''}`
  const click = (h: number, nl: NumberedLine) => (e: MouseEvent) => {
    // Clicking the code itself is left for text selection; the gutter selects lines.
    if ((e.target as HTMLElement).closest('.code')) return
    if (selectable(nl.line)) onLineClick?.(h, nl.index, e)
  }
  const lineNo = (nl: NumberedLine, no: number | undefined) =>
    opens(nl) ? (
      <span className="ln" title={`Open in editor at line ${nl.editorLine}`} onClick={() => onOpenLine!(nl.editorLine!)}>
        {no ?? ''}
      </span>
    ) : (
      <span className="ln">{no ?? ''}</span>
    )
  const menu = (nl: NumberedLine) => (e: MouseEvent) => {
    if (!onOpenLine || nl.editorLine === undefined) return
    const text = window.getSelection()?.toString()
    showContextMenu(e, [
      { label: `Open in editor at line ${nl.editorLine}`, onClick: () => onOpenLine(nl.editorLine!) },
      'separator',
      text ? { label: 'Copy selection', onClick: () => void navigator.clipboard.writeText(text) } : null,
      { label: 'Copy line', onClick: () => void navigator.clipboard.writeText(nl.line.content) }
    ])
  }
  const sign = (nl: NumberedLine) => <span className="sign">{nl.line.type === 'add' ? '+' : nl.line.type === 'del' ? '−' : ''}</span>

  // h is null for revealed context lines, which belong to no hunk
  const unifiedRow = (h: number | null, nl: NumberedLine, tok: Token[] | null | undefined) =>
    nl.line.type === 'meta' ? (
      <div key={nl.index} className="dl meta">
        <span className="ln" />
        <span className="ln" />
        <span className="sign" />
        <span className="code">{nl.line.content}</span>
      </div>
    ) : (
      <div key={nl.index} className={lineClass(h ?? -1, nl)} onMouseDown={h === null ? undefined : click(h, nl)} onContextMenu={menu(nl)}>
        {lineNo(nl, nl.oldNo)}
        {lineNo(nl, nl.newNo)}
        {sign(nl)}
        <Code nl={nl} tokens={tok} hl={h === null ? undefined : words?.[h]?.[nl.index]} />
      </div>
    )
  const sideRow = (h: number | null, nl: NumberedLine | undefined, which: 'left' | 'right', key: number, tok: Token[] | null | undefined) =>
    !nl ? (
      <div key={key} className="dl empty">
        <span className="ln" />
        <span className="code"> </span>
      </div>
    ) : (
      <div key={key} className={lineClass(h ?? -1, nl)} onMouseDown={h === null ? undefined : click(h, nl)} onContextMenu={menu(nl)}>
        {lineNo(nl, which === 'left' ? nl.oldNo : nl.newNo)}
        {sign(nl)}
        <Code nl={nl} tokens={tok} hl={h === null ? undefined : words?.[h]?.[nl.index]} />
      </div>
    )

  const gapLines = (gap: Gap, first: number, last: number) => {
    const rows: NumberedLine[] = []
    for (let n = first; n <= last; n++)
      rows.push({ line: { type: 'context', content: context!.lines[n - 1] }, index: -n, oldNo: n + gap.oldOffset, newNo: n, editorLine: n })
    const tok = (nl: NumberedLine) => fileTokens?.[nl.newNo! - 1]
    if (layout === 'unified') return rows.map((nl) => unifiedRow(null, nl, tok(nl)))
    return (
      <div key={`lines-${first}`} className="split">
        <div className="side">{rows.map((nl) => sideRow(null, nl, 'left', nl.index, tok(nl)))}</div>
        <div className="side">{rows.map((nl) => sideRow(null, nl, 'right', nl.index, tok(nl)))}</div>
      </div>
    )
  }
  const expander = (gap: Gap, first: number, last: number) => {
    const count = last - first + 1
    // lines are revealed next to what is shown above (down) or below (up) the hidden run
    const down = first > 1
    const up = !(gap.before === diff.hunks.length && last === gap.last)
    return (
      <div key={`hidden-${first}`} className="diff-expander">
        <span className="count">
          {count} unchanged {count === 1 ? 'line' : 'lines'}
        </span>
        {count > EXPAND_STEP && down && (
          <button title={`Show ${EXPAND_STEP} more lines below`} aria-label={`Show ${EXPAND_STEP} more lines below`} onClick={() => reveal(first, first + EXPAND_STEP - 1)}>
            <Icon name="chevron-down" size={11} /> {EXPAND_STEP}
          </button>
        )}
        {count > EXPAND_STEP && up && (
          <button title={`Show ${EXPAND_STEP} more lines above`} aria-label={`Show ${EXPAND_STEP} more lines above`} onClick={() => reveal(last - EXPAND_STEP + 1, last)}>
            <Icon name="chevron-up" size={11} /> {EXPAND_STEP}
          </button>
        )}
        <button title="Show every unchanged line here" onClick={() => reveal(first, last)}>
          {count > EXPAND_STEP ? 'Expand all' : `Expand ${count === 1 ? '' : `${count} `}${count === 1 ? 'line' : 'lines'}`}
        </button>
      </div>
    )
  }
  const gapBlock = (before: number) => {
    const gap = context?.gaps.find((g) => g.before === before)
    if (!gap) return null
    return (
      <div key={`gap-${before}`} className="diff-gap-block">
        {gapParts(gap, revealed).map((part) => (part.kind === 'lines' ? gapLines(gap, part.first, part.last) : expander(gap, part.first, part.last)))}
      </div>
    )
  }

  return (
    <div className={`diff ${wrap ? 'wrap' : ''} ${continuous ? 'inline-mode' : ''}`}>
      {numbered.map((lines, h) => (
        <Fragment key={h}>
          {gapBlock(h)}
          <div className={`diff-hunk ${focusedHunk === h ? 'focused' : ''}`} data-hunk={h} onMouseDown={onHunkFocus && (() => onHunkFocus(h))}>
            {!continuous && (
              <div className="hunk-head">
                <span className="hunk-title">{diff.hunks[h].header}</span>
                {hunkActions?.(h)}
              </div>
            )}
            {layout === 'unified'
              ? lines.map((nl) => unifiedRow(h, nl, tokens?.[h]?.[nl.index]))
              : (() => {
                  const rows = splitRows(lines)
                  const side = (which: 'left' | 'right') => rows.map((r, i) => sideRow(h, r[which], which, i, r[which] && tokens?.[h]?.[r[which]!.index]))
                  return (
                    <div className="split">
                      <div className="side">{side('left')}</div>
                      <div className="side">{side('right')}</div>
                    </div>
                  )
                })()}
          </div>
        </Fragment>
      ))}
      {gapBlock(diff.hunks.length)}
    </div>
  )
}

/** File View: the file as it is after the change, with added lines marked (deleted files show their old content). */
function FileBody({ diff, wrap }: { diff: FileDiff; wrap: boolean }) {
  const numbered = useMemo(() => diff.hunks.map(numberLines), [diff])
  const tokens = useDiffTokens(diff)
  if (diff.binary) return <div className="view-message">Binary file — no preview available.</div>
  const keep = (t: DiffLine['type']) => (diff.isDeleted ? t === 'del' : t !== 'del' && t !== 'meta')
  return (
    <div className={`diff inline-mode ${wrap ? 'wrap' : ''}`}>
      {numbered.map((lines, h) => (
        <div key={h} className="diff-hunk">
          {h > 0 && <div className="diff-gap">⋯</div>}
          {lines
            .filter((nl) => keep(nl.line.type))
            .map((nl) => (
              <div key={nl.index} className={`dl ${diff.isDeleted ? 'context' : nl.line.type}`}>
                <span className="ln">{(diff.isDeleted ? nl.oldNo : nl.newNo) ?? ''}</span>
                <span className="sign">{!diff.isDeleted && nl.line.type === 'add' ? '+' : ''}</span>
                <Code nl={nl} tokens={tokens?.[h]?.[nl.index]} />
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}

function splitRows(lines: NumberedLine[]): { left?: NumberedLine; right?: NumberedLine }[] {
  const rows: { left?: NumberedLine; right?: NumberedLine }[] = []
  let i = 0
  while (i < lines.length) {
    const nl = lines[i]
    if (nl.line.type === 'meta') {
      i++
      continue
    }
    if (nl.line.type === 'context') {
      rows.push({ left: nl, right: nl })
      i++
      continue
    }
    const dels: NumberedLine[] = []
    const adds: NumberedLine[] = []
    while (i < lines.length && lines[i].line.type !== 'context') {
      if (lines[i].line.type === 'del') {
        if (adds.length) break
        dels.push(lines[i])
      } else if (lines[i].line.type === 'add') adds.push(lines[i])
      i++
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] })
  }
  return rows
}

// ---------------------------------------------------------------------------------------------

function fileStatus(diff: FileDiff | null | undefined, fallback?: FileStatusCode): FileStatusCode {
  if (!diff) return fallback ?? 'modified'
  if (diff.isNew) return 'added'
  if (diff.isDeleted) return 'deleted'
  if (diff.oldPath && diff.oldPath !== diff.path) return 'renamed'
  return fallback ?? 'modified'
}

/** Files of the same commit / staging list, for previous / next file navigation. */
function useSiblingFiles(repo: RepoTab, target: DiffTarget, cwd?: string): FileChange[] {
  const sha = target.kind === 'commit' ? target.sha : ''
  const { detail } = useCommitDetail(repo.path, sha || null)
  const [other, setOther] = useState<{ cwd: string; staged: FileChange[]; unstaged: FileChange[] } | null>(null)
  useEffect(() => {
    if (!cwd) return
    let cancelled = false
    window.git.status(cwd).then((st) => !cancelled && setOther({ cwd, staged: st.staged, unstaged: st.unstaged }), () => undefined)
    return () => {
      cancelled = true
    }
  }, [cwd])
  if (target.kind === 'commit') return sha && detail ? detail.files : []
  if (target.kind === 'working') {
    const st = cwd ? (other?.cwd === cwd ? other : null) : repo.status
    if (!st) return []
    return target.staged ? st.staged : st.unstaged
  }
  return []
}

/** Revision `fileContent` reads the diff's new side from (null = working copy, '' = index). */
function newSideRev(target: DiffTarget): string | null {
  if (target.kind === 'working') return target.staged ? '' : null
  return target.kind === 'commit' ? target.sha : target.to
}

/**
 * The file at the diff's new side, by line, for revealing unchanged lines between hunks. Fetched again whenever the
 * diff reloads; until then DiffBody checks the old lines still fit the diff.
 */
export function useNewSideLines(repoPath: string, target: DiffTarget, diff: FileDiff | null | undefined, enabled: boolean): string[] | null {
  const [lines, setLines] = useState<string[] | null>(null)
  // a new or deleted file is a single hunk with nothing around it
  const want = enabled && !!diff && !diff.binary && !diff.isNew && !diff.isDeleted && diff.hunks.length > 0
  const targetKey = JSON.stringify(target)
  useEffect(() => {
    if (!want) return setLines(null)
    let cancelled = false
    window.git.fileContent(repoPath, newSideRev(target), target.path).then(
      (text) => !cancelled && setLines(splitFileLines(text)),
      () => !cancelled && setLines(null)
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, targetKey, diff, want])
  return lines
}

function ToolButton({ icon, title, on, disabled, onClick }: { icon: IconName; title: string; on?: boolean; disabled?: boolean; onClick(): void }) {
  return (
    <button className={`icon-btn ${on ? 'on' : ''}`} aria-pressed={on} title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={14} />
    </button>
  )
}

export function DiffView({ repo, target, cwd }: { repo: RepoTab; target: DiffTarget; cwd?: string }) {
  const { setCenter, run } = useStore.getState()
  const [diff, setDiff] = useState<FileDiff | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewKind>(() => (readLocal('kc:diffView', 'diff') === 'file' ? 'file' : 'diff'))
  const [mode, setMode] = useState<DiffMode>(() => {
    const v = readLocal('kc:diffMode', readLocal('kc:diffLayout', 'hunk'))
    return v === 'split' || v === 'inline' ? v : 'hunk'
  })
  const [wrap, setWrap] = useStoredFlag(WRAP_KEY)
  const [ignoreWs, setIgnoreWs] = useStoredFlag(IGNORE_WHITESPACE_KEY)
  /** SVG files show their text diff instead of the pictures */
  const [svgAsText, setSvgAsText] = useStoredFlag('kc:svgAsText')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [anchor, setAnchor] = useState<{ h: number; l: number } | null>(null)
  const [showLarge, setShowLarge] = useState(false)
  /** Hunk the keyboard stages, unstages, discards or edits when no line is selected */
  const [focusHunk, setFocusHunk] = useState(0)
  /** Hunk being edited before staging; `diff` is the diff it was opened from */
  const [editing, setEditing] = useState<{ diff: FileDiff; hunk: number; text: string; error: string | null } | null>(null)
  const lastSignature = useRef<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const repoPath = cwd ?? repo.path
  const fullFile = view === 'file' || mode === 'inline'
  const opts: DiffOptions = { context: fullFile ? FULL_CONTEXT : undefined, ignoreWhitespace: ignoreWs || undefined }
  const optsKey = JSON.stringify(opts)
  const targetKey = JSON.stringify(target)
  const isWorking = target.kind === 'working'
  // Partial staging needs a normal diff of this repo (patches from -w or whole-file diffs don't apply cleanly).
  const canStage = isWorking && !cwd
  const image = isImagePath(target.path)
  const showImage = image && !!diff && (diff.binary || (isSvgPath(target.path) && !svgAsText))
  const canStageLines = canStage && view === 'diff' && mode !== 'inline' && !ignoreWs && !showImage
  // Working-tree diffs must reload whenever status refreshes; commit diffs never change.
  const statusDep = isWorking ? (cwd ? repo.worktrees : repo.status) : null

  useEffect(() => {
    let cancelled = false
    setError(null)
    window.git.diff(repoPath, target, opts).then(
      (d) => {
        if (cancelled) return
        // Background refreshes (watcher, auto-fetch) often return the same diff: keep the line selection then.
        const signature = JSON.stringify(d)
        if (signature === lastSignature.current) return
        lastSignature.current = signature
        setDiff(d)
        setSelected(new Set())
        setAnchor(null)
      },
      (e: Error) => !cancelled && setError(e.message)
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, targetKey, optsKey, statusDep])

  useEffect(() => {
    setDiff(undefined)
    setShowLarge(false)
    setFocusHunk(0)
    lastSignature.current = null
    bodyRef.current?.scrollTo({ top: 0 })
  }, [targetKey, optsKey])

  const close = () => setCenter({ kind: 'graph' })
  const path = target.path

  // ---- previous / next file
  const siblings = useSiblingFiles(repo, target, cwd)
  const fileIndex = siblings.findIndex((f) => f.path === path)
  const listed = siblings[fileIndex]
  // where the file was in the list, for moving on once it has left it (fully staged, unstaged or discarded)
  const lastFileIndex = useRef(-1)
  if (fileIndex >= 0) lastFileIndex.current = fileIndex
  const goFile = (delta: number) => {
    const from = fileIndex >= 0 ? fileIndex : lastFileIndex.current - (delta > 0 ? 1 : 0)
    const f = siblings[Math.max(0, Math.min(siblings.length - 1, from + delta))]
    if (f && f.path !== path) setCenter({ kind: 'diff', target: { ...target, path: f.path }, cwd })
  }
  // after a keyboard action empties the file, continue with the file that took its place
  const advanceOnEmpty = useRef(false)
  useEffect(() => {
    if (diff === undefined) return
    if (diff !== null) {
      if (focusHunk >= diff.hunks.length) setFocusHunk(Math.max(0, diff.hunks.length - 1))
      return
    }
    if (!advanceOnEmpty.current || fileIndex >= 0 || siblings.length === 0) return
    advanceOnEmpty.current = false
    const f = siblings[Math.min(Math.max(0, lastFileIndex.current), siblings.length - 1)]
    setCenter({ kind: 'diff', target: { ...target, path: f.path }, cwd })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, siblings.length, fileIndex])

  // ---- previous / next change
  const jumpChange = useCallback((dir: 1 | -1) => {
    const scroller = bodyRef.current
    if (!scroller) return
    const base = scroller.getBoundingClientRect().top
    const lines = [...scroller.querySelectorAll<HTMLElement>('.dl.add, .dl.del')]
    const tops = new Set<number>()
    for (const el of lines) {
      const prev = el.previousElementSibling
      if (prev && (prev.classList.contains('add') || prev.classList.contains('del'))) continue
      tops.add(Math.round(el.getBoundingClientRect().top - base + scroller.scrollTop))
    }
    const sorted = [...tops].sort((a, b) => a - b)
    const offset = 40 // keep the change below the sticky hunk header
    const cur = scroller.scrollTop + offset
    const next = dir === 1 ? sorted.find((t) => t > cur + 2) : [...sorted].reverse().find((t) => t < cur - 2)
    if (next !== undefined) scroller.scrollTo({ top: Math.max(0, next - offset), behavior: scrollBehavior() })
  }, [])

  // ---- staging
  /** `ask` false discards without the confirmation (the undo toast still follows). */
  const apply = async (label: string, selection: HunkSelection[], patchMode: PatchMode, ask = true) => {
    if (!diff) return
    const patch = buildPatch(diff, selection, patchMode)
    if (!patch) return
    if (patchMode === 'discard') {
      const ok =
        !ask ||
        (await confirm('Discard changes?', 'The selected changes will be discarded from the working copy.', {
          confirmLabel: 'Discard',
          danger: true,
          impact: Promise.resolve(patchImpact(patch))
        }))
      if (ok) await discardPatch(diff.path, patch, label)
      return
    }
    await run(label, (r) => window.git.applyPatch(r, patch, { cached: true, reverse: patchMode === 'unstage' }), { log: false })
  }

  const openEdit = (h: number) => diff?.hunks[h] && setEditing({ diff, hunk: h, text: hunkEditText(diff.hunks[h]), error: null })

  const saveEdit = async () => {
    if (!editing) return
    const built = buildEditedHunkPatch(editing.diff, editing.hunk, editing.text)
    if ('error' in built) return setEditing({ ...editing, error: built.error })
    const ok = await run('Staging edited hunk', (r) => window.git.applyPatch(r, built.patch, { cached: true, reverse: false }), { log: false })
    if (ok) setEditing(null)
  }

  const selectionByHunk = (): HunkSelection[] => {
    const m = new Map<number, number[]>()
    for (const k of selected) {
      const [h, l] = k.split(':').map(Number)
      m.set(h, [...(m.get(h) ?? []), l])
    }
    return [...m].map(([hunkIndex, lineIndexes]) => ({ hunkIndex, lineIndexes }))
  }

  const onLineClick = (h: number, l: number, e: MouseEvent) => {
    if (!diff) return
    e.preventDefault()
    const key = `${h}:${l}`
    const next = new Set(e.metaKey || e.ctrlKey || e.shiftKey ? selected : [])
    if (e.shiftKey && anchor && anchor.h === h) {
      const [a, b] = anchor.l < l ? [anchor.l, l] : [l, anchor.l]
      diff.hunks[h].lines.forEach((line, i) => {
        if (i >= a && i <= b && (line.type === 'add' || line.type === 'del')) next.add(`${h}:${i}`)
      })
    } else if (selected.has(key) && (e.metaKey || e.ctrlKey || selected.size === 1)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    setSelected(next)
    if (!e.shiftKey) setAnchor({ h, l })
  }

  const staged = target.kind === 'working' && target.staged
  const hunkActions = canStageLines
    ? (h: number) =>
        staged ? (
          <button className="btn small" onClick={() => void apply('Unstaging hunk', [{ hunkIndex: h }], 'unstage')}>
            Unstage hunk
          </button>
        ) : (
          <>
            <button className="btn small" title="Edit this hunk before staging it (E)" onClick={() => openEdit(h)}>
              Edit hunk
            </button>
            <button className="btn small danger-ghost" onClick={() => void apply('Discarding hunk', [{ hunkIndex: h }], 'discard')}>
              Discard hunk
            </button>
            <button className="btn small success" onClick={() => void apply('Staging hunk', [{ hunkIndex: h }], 'stage')}>
              Stage hunk
            </button>
          </>
        )
    : undefined

  // ---- keyboard: stage / unstage / discard the selected lines or the focused hunk, move between hunks and files
  const scrollToHunk = (h: number) => {
    const scroller = bodyRef.current
    const el = scroller?.querySelector<HTMLElement>(`.diff-hunk[data-hunk="${h}"]`)
    if (!scroller || !el) return
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTo({ top: Math.max(0, top - 8), behavior: scrollBehavior() })
  }
  const moveHunk = (delta: number) => {
    if (!diff || diff.hunks.length === 0) return
    const next = Math.max(0, Math.min(diff.hunks.length - 1, focusHunk + delta))
    setFocusHunk(next)
    scrollToHunk(next)
  }
  const keyAction = (command: string) => {
    if (command === 'diff:nextHunk' || command === 'diff:prevHunk') return moveHunk(command === 'diff:nextHunk' ? 1 : -1)
    if (command === 'diff:nextFile' || command === 'diff:prevFile') return goFile(command === 'diff:nextFile' ? 1 : -1)
    if (!canStage || !diff) return
    const want = command === 'diff:toggleHunk' ? (staged ? 'unstage' : 'stage') : command === 'diff:stage' ? 'stage' : command === 'diff:unstage' ? 'unstage' : 'discard'
    if (command === 'diff:editHunk') {
      if (canStageLines && !staged) openEdit(focusHunk)
      return
    }
    // staged diffs only unstage, unstaged ones stage or discard
    if ((want === 'unstage') !== staged) return
    if (!canStageLines) {
      // whole-file views (inline, ignoring whitespace) stage or unstage the file
      if (want === 'discard') return
      advanceOnEmpty.current = true
      void run(staged ? 'Unstaging' : 'Staging', (r) => (staged ? window.git.unstage(r, [path]) : window.git.stage(r, [path])), { log: false })
      return
    }
    const lines = selected.size > 0
    const selection = lines ? selectionByHunk() : diff.hunks[focusHunk] ? [{ hunkIndex: focusHunk }] : []
    if (selection.length === 0) return
    const what = lines ? 'lines' : 'hunk'
    const label = want === 'stage' ? `Staging ${what}` : want === 'unstage' ? `Unstaging ${what}` : `Discarding ${what}`
    advanceOnEmpty.current = true
    void apply(label, selection, want, command !== 'diff:discardNow')
  }
  const keyActionRef = useRef(keyAction)
  keyActionRef.current = keyAction
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = diffCommandFor(e)
      if (!command) return
      e.preventDefault()
      keyActionRef.current(command)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const totalLines = diff ? diff.hunks.reduce((n, h) => n + h.lines.length, 0) : 0
  const lineCount = selected.size
  const adds = diff ? diff.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0) : (listed?.additions ?? 0)
  const dels = diff ? diff.hunks.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0) : (listed?.deletions ?? 0)
  const slash = path.lastIndexOf('/')
  const oldPath = diff?.oldPath && diff.oldPath !== path ? diff.oldPath : listed?.oldPath

  const chip =
    target.kind === 'working'
      ? `${cwd ? `${basename(cwd)} · ` : ''}${target.staged ? 'Staged' : 'Unstaged'}`
      : target.kind === 'commit'
        ? shortSha(target.sha)
        : `${shortSha(target.from)} → ${shortSha(target.to)}`

  const remember = (key: string, value: string) => writeLocal(key, value)

  const fileLines = useNewSideLines(repoPath, target, diff, view === 'diff' && !fullFile && !showImage)
  const openLine = (line?: number) =>
    void window.app
      .openInEditor(repoPath, path, line)
      .catch((e: Error) => useStore.getState().toast({ kind: 'error', title: 'Could not open the editor', message: e.message }))
  /** First changed line of the focused hunk on the new side, where the toolbar button opens the editor */
  const focusLine = (() => {
    const h = diff?.hunks[focusHunk]
    if (!h || diff?.isDeleted) return undefined
    let n = h.newStart
    for (const l of h.lines) {
      if (l.type === 'add' || l.type === 'del') return Math.max(1, l.newLine ?? n)
      if (l.type === 'context') n = (l.newLine ?? n) + 1
    }
    return Math.max(1, h.newStart)
  })()

  return (
    <div className="view">
      <div className="dv-head">
        <StatusIcon status={fileStatus(diff, listed?.status)} size={13} />
        <span className="dv-path" title={oldPath ? `${oldPath} → ${path}` : path}>
          <span>
            {oldPath && <span className="file-dir">{oldPath} → </span>}
            {slash >= 0 && <span className="file-dir">{path.slice(0, slash + 1)}</span>}
            {path.slice(slash + 1)}
          </span>
        </span>
        {(adds > 0 || dels > 0) && (
          <span className="stats">
            {adds > 0 && <span className="add">+{adds}</span>}
            {dels > 0 && <span className="del">−{dels}</span>}
          </span>
        )}
        <span className="sha-chip" title={cwd ? `Worktree ${cwd}` : undefined}>
          {chip}
        </span>
        {cwd && <span className="dv-readonly">read-only</span>}
        <span className="grow" />
        {siblings.length > 1 && fileIndex >= 0 && (
          <span className="dv-nav">
            <button className="icon-btn" title="Previous file" aria-label="Previous file" disabled={fileIndex === 0} onClick={() => goFile(-1)}>
              <Icon name="chevron-left" size={13} />
            </button>
            <span className="count">
              {fileIndex + 1} / {siblings.length}
            </span>
            <button className="icon-btn" title="Next file" aria-label="Next file" disabled={fileIndex === siblings.length - 1} onClick={() => goFile(1)}>
              <Icon name="chevron-right" size={13} />
            </button>
          </span>
        )}
        <button className="icon-btn" title="Close (Esc)" aria-label="Close (Esc)" onClick={close}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="dv-tools">
        {canStage && lineCount > 0 && (
          <span className="dv-group">
            <span className="muted" style={{ fontSize: 12, marginRight: 6 }}>
              {lineCount} {lineCount === 1 ? 'line' : 'lines'}
            </span>
            {staged ? (
              <button className="btn small primary" onClick={() => void apply('Unstaging lines', selectionByHunk(), 'unstage')}>
                Unstage lines
              </button>
            ) : (
              <>
                <button className="btn small" onClick={() => void apply('Discarding lines', selectionByHunk(), 'discard')}>
                  Discard lines
                </button>
                <button className="btn small primary" onClick={() => void apply('Staging lines', selectionByHunk(), 'stage')}>
                  Stage lines
                </button>
              </>
            )}
          </span>
        )}
        {canStage && lineCount === 0 && (
          <span className="dv-group">
            <button
              className={`btn small ${staged ? '' : 'success'}`}
              onClick={() =>
                void run(staged ? 'Unstaging' : 'Staging', (r) => (staged ? window.git.unstage(r, [path]) : window.git.stage(r, [path])), {
                  log: false
                })
              }
            >
              {staged ? 'Unstage file' : 'Stage file'}
            </button>
          </span>
        )}
        <span className="grow" />
        <span className="seg seg-icons">
          <button className={view === 'file' ? 'on' : ''} title="Show the whole file" onClick={() => (setView('file'), remember('kc:diffView', 'file'))}>
            <Icon name="file-view" size={12} /> File View
          </button>
          <button className={view === 'diff' ? 'on' : ''} title="Show the changes" onClick={() => (setView('diff'), remember('kc:diffView', 'diff'))}>
            <Icon name="diff-view" size={12} /> Diff View
          </button>
        </span>
        <span className="grow" />
        {view === 'diff' && !showImage && (
          <>
            <span className="dv-group">
              <ToolButton icon="arrow-up" title="Previous change" onClick={() => jumpChange(-1)} disabled={!diff} />
              <ToolButton icon="arrow-down" title="Next change" onClick={() => jumpChange(1)} disabled={!diff} />
            </span>
            <span className="dv-group">
              <ToolButton icon="hunks" title="Hunk view" on={mode === 'hunk'} onClick={() => (setMode('hunk'), remember('kc:diffMode', 'hunk'))} />
              <ToolButton icon="inline" title="Inline view (whole file)" on={mode === 'inline'} onClick={() => (setMode('inline'), remember('kc:diffMode', 'inline'))} />
              <ToolButton icon="split" title="Split view" on={mode === 'split'} onClick={() => (setMode('split'), remember('kc:diffMode', 'split'))} />
            </span>
          </>
        )}
        <span className="dv-group">
          {image && isSvgPath(path) && (
            <ToolButton icon="image" title={svgAsText ? 'Show as image' : 'Show the text diff'} on={!svgAsText} onClick={() => setSvgAsText(!svgAsText)} />
          )}
          {view === 'diff' && !showImage && (
            <ToolButton
              icon="whitespace"
              title={ignoreWs ? 'Showing changes without whitespace (git diff -w)' : 'Ignore whitespace'}
              on={ignoreWs}
              onClick={() => setIgnoreWs(!ignoreWs)}
            />
          )}
          {!showImage && <ToolButton icon="wrap" title="Word wrap" on={wrap} onClick={() => setWrap(!wrap)} />}
        </span>
        <span className="dv-group">
          <ToolButton icon="eye" title="Blame" disabled={!!cwd} onClick={() => setCenter({ kind: 'history', path, blame: true })} />
          <ToolButton icon="history" title="File history" disabled={!!cwd} onClick={() => setCenter({ kind: 'history', path, blame: false })} />
          <ToolButton
            icon="external"
            title={focusLine ? `Open in external editor at line ${focusLine}` : 'Open in external editor'}
            onClick={() => openLine(focusLine)}
          />
        </span>
      </div>
      <div className="view-body" ref={bodyRef}>
        {error ? (
          <div className="view-message">{error}</div>
        ) : diff === undefined ? (
          <DelayedDiffSkeleton />
        ) : diff === null ? (
          <div className="view-message">
            No changes for this file{isWorking ? (staged ? ' in the index' : ' in the working directory') : ''}.
            <button className="btn" onClick={close}>
              Back to graph
            </button>
          </div>
        ) : totalLines > LARGE_DIFF_LINES && !showLarge ? (
          <div className="view-message">
            This diff is large ({totalLines.toLocaleString()} lines).
            <button className="btn" onClick={() => setShowLarge(true)}>
              Show anyway
            </button>
          </div>
        ) : showImage ? (
          <ImageDiff repo={repoPath} target={target} diff={diff} />
        ) : view === 'file' ? (
          <FileBody diff={diff} wrap={wrap} />
        ) : (
          <DiffBody
            diff={diff}
            layout={mode === 'split' ? 'split' : 'unified'}
            continuous={mode === 'inline'}
            wrap={wrap}
            selected={canStageLines ? selected : undefined}
            onLineClick={canStageLines ? onLineClick : undefined}
            hunkActions={hunkActions}
            focusedHunk={canStageLines ? focusHunk : undefined}
            onHunkFocus={canStageLines ? setFocusHunk : undefined}
            ignoreWhitespace={ignoreWs}
            fileLines={fileLines}
            onOpenLine={diff.isDeleted ? undefined : openLine}
          />
        )}
      </div>
      {canStageLines && diff && !diff.binary && (
        <div className="rebase-help" style={{ borderTop: '1px solid var(--border)' }}>
          Click line numbers to select lines · Shift-click for a range · ⌘/Ctrl-click to add ·{' '}
          {staged ? `${formatKeys('u')} unstage` : `${formatKeys('s')} stage · ${formatKeys('d')} discard · ${formatKeys('e')} edit`} · {formatKeys('[')}{' '}
          {formatKeys(']')} hunks · {formatKeys('alt+up')} {formatKeys('alt+down')} files
        </div>
      )}
      {editing && (
        <Modal
          title={`Edit hunk ${editing.hunk + 1} of ${basename(editing.diff.path)}`}
          onClose={() => setEditing(null)}
          width={780}
          footer={
            <>
              <button className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={!!repo.busy} onClick={() => void saveEdit()} title="⌘/Ctrl + Enter">
                Stage edited hunk
              </button>
            </>
          }
        >
          <span className="field-hint">
            Change or delete <b>+</b> lines to stage less or something else. To keep a <b>−</b> line, replace its “-” with a space. Lines starting with # are
            ignored.
          </span>
          <textarea
            className="hunk-editor"
            autoFocus
            spellCheck={false}
            rows={Math.min(28, Math.max(8, editing.text.split('\n').length + 1))}
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value, error: null })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void saveEdit()
              }
            }}
          />
          {editing.error && <span className="field-error">{editing.error}</span>}
        </Modal>
      )}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConflictFile } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon } from '../ui/Icon'
import { confirm } from '../ui/dialogs'
import { merge3, renderMerge, splitLines, type Chunk, type ConflictChoice } from '../diff/merge3'
import { useTokens } from '../highlight/useHighlight'
import { TokenLine } from '../highlight/Highlighted'
import { scrollBehavior } from '../ui/appearance'
import '../styles/detail.css'

type Side = 'ours' | 'theirs'

function Pane({
  path,
  side,
  chunks,
  choices,
  current,
  onToggle,
  registerRef
}: {
  path: string
  side: Side
  chunks: Chunk[]
  choices: ConflictChoice[]
  current: number
  onToggle(conflict: number): void
  registerRef(conflict: number, side: Side, el: HTMLDivElement | null): void
}) {
  // The pane shows this side's full file (stable lines + this side of every chunk), so tokenize it as one document.
  const text = useMemo(() => chunks.flatMap((c) => (c.kind === 'stable' ? c.lines : c[side])).join('\n'), [chunks, side])
  const tokens = useTokens(path, text)
  let lineNo = 1
  let conflictNo = -1
  return (
    <>
      {chunks.map((chunk, ci) => {
        const lines = chunk.kind === 'stable' ? chunk.lines : chunk[side]
        const start = lineNo
        lineNo += lines.length
        const body = lines.map((l, i) => (
          <div className="mline" key={i}>
            <span className="ln">{start + i}</span>
            <span>{l && tokens?.[start + i - 1] ? <TokenLine tokens={tokens[start + i - 1]} /> : l || ' '}</span>
          </div>
        ))
        if (chunk.kind === 'stable') return <div key={ci}>{body}</div>
        if (chunk.kind === 'resolved') {
          const changedHere = chunk.side === side || chunk.side === 'both'
          return (
            <div key={ci} className={`mchunk ${changedHere ? 'changed' : ''}`}>
              {body}
            </div>
          )
        }
        const n = ++conflictNo
        const taken = choices[n]?.[side] ?? false
        return (
          <div key={ci} ref={(el) => registerRef(n, side, el)} className={`mchunk conflict ${taken ? 'taken' : ''} ${n === current ? 'current' : ''}`}>
            <label className="mchunk-head check">
              <input type="checkbox" checked={taken} onChange={() => onToggle(n)} />
              Conflict {n + 1}: take {side === 'ours' ? 'A' : 'B'} ({lines.length} {lines.length === 1 ? 'line' : 'lines'})
            </label>
            {lines.length ? body : <div className="mchunk-empty">(deleted)</div>}
          </div>
        )
      })}
    </>
  )
}

export function ConflictView({ repo, path }: { repo: RepoTab; path: string }) {
  const { setCenter, run } = useStore.getState()
  const [file, setFile] = useState<ConflictFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choices, setChoices] = useState<ConflictChoice[]>([])
  const [output, setOutput] = useState('')
  const [edited, setEdited] = useState(false)
  const [current, setCurrent] = useState(0)
  const refs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    let cancelled = false
    setFile(null)
    setError(null)
    window.git.conflict(repo.path, path).then(
      (f) => !cancelled && setFile(f),
      (e: Error) => !cancelled && setError(e.message)
    )
    return () => {
      cancelled = true
    }
  }, [repo.path, path])

  const chunks = useMemo(
    () => (file && file.ours !== null && file.theirs !== null ? merge3(splitLines(file.base), splitLines(file.ours), splitLines(file.theirs)) : []),
    [file]
  )
  const conflictCount = chunks.filter((c) => c.kind === 'conflict').length
  const trailingNewline = !!file && (file.ours ?? file.theirs ?? '').endsWith('\n')

  const render = (ch: ConflictChoice[]) => {
    const lines = renderMerge(chunks, ch)
    return lines.join('\n') + (trailingNewline && lines.length ? '\n' : '')
  }

  useEffect(() => {
    const initial = Array.from({ length: conflictCount }, () => ({ ours: false, theirs: false }))
    setChoices(initial)
    setOutput(render(initial))
    setEdited(false)
    setCurrent(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks])

  const updateChoices = async (next: ConflictChoice[]) => {
    if (edited && !(await confirm('Discard manual edits?', 'Changing a selection regenerates the output and discards your manual edits.', { confirmLabel: 'Regenerate' })))
      return
    setChoices(next)
    setOutput(render(next))
    setEdited(false)
  }

  const toggle = (side: Side) => (n: number) => {
    setCurrent(n)
    void updateChoices(choices.map((c, i) => (i === n ? { ...c, [side]: !c[side] } : c)))
  }

  const goTo = (n: number) => {
    if (conflictCount === 0) return
    const idx = (n + conflictCount) % conflictCount
    setCurrent(idx)
    for (const side of ['ours', 'theirs'] as Side[]) refs.current.get(`${idx}:${side}`)?.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
  }

  const close = () => setCenter({ kind: 'graph' })

  const save = async () => {
    const unresolved = choices.filter((c) => !c.ours && !c.theirs).length
    if (
      unresolved > 0 &&
      !edited &&
      !(await confirm('Save with unresolved conflicts?', `${unresolved} conflict(s) have no side selected; their lines will be omitted.`, { confirmLabel: 'Save' }))
    )
      return
    if (await run('Resolving conflict', (r) => window.git.resolveConflict(r, path, output), { success: `Resolved ${path}`, log: false })) close()
  }

  const takeWhole = async (side: Side) => {
    if (await run('Resolving conflict', (r) => window.git.takeSide(r, [path], side), { success: `Resolved ${path}`, log: false })) close()
  }

  const head = (
    <div className="view-head">
      <Icon name="merge" size={14} />
      <span className="title" title={path}>
        {path}
      </span>
      {conflictCount > 0 && (
        <>
          <button className="icon-btn" title="Previous conflict" aria-label="Previous conflict" onClick={() => goTo(current - 1)}>
            ‹
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            conflict {current + 1} of {conflictCount}
          </span>
          <button className="icon-btn" title="Next conflict" aria-label="Next conflict" onClick={() => goTo(current + 1)}>
            ›
          </button>
        </>
      )}
      <span className="grow" />
      <button className="btn small" disabled={!file} onClick={() => void takeWhole('ours')}>
        Take all A
      </button>
      <button className="btn small" disabled={!file} onClick={() => void takeWhole('theirs')}>
        Take all B
      </button>
      {conflictCount > 0 && (
        <button className="btn small" onClick={() => void updateChoices(choices.map(() => ({ ours: false, theirs: false })))}>
          Reset
        </button>
      )}
      <button className="btn small primary" disabled={!file || file.ours === null || file.theirs === null} onClick={() => void save()}>
        Save & mark resolved
      </button>
      <button className="icon-btn" title="Close" aria-label="Close" onClick={close}>
        <Icon name="x" size={14} />
      </button>
    </div>
  )

  if (error)
    return (
      <div className="view">
        {head}
        <div className="view-message">{error}</div>
      </div>
    )
  if (!file)
    return (
      <div className="view">
        {head}
        <div className="view-message">Loading conflict…</div>
      </div>
    )
  if (file.ours === null || file.theirs === null)
    return (
      <div className="view">
        {head}
        <div className="view-message">
          {file.ours === null ? 'This file was deleted on the current branch (A) and modified on the incoming branch (B).' : 'This file was modified on the current branch (A) and deleted on the incoming branch (B).'}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => void takeWhole('ours')}>
              {file.ours === null ? 'Keep deleted (A)' : 'Keep modified (A)'}
            </button>
            <button className="btn" onClick={() => void takeWhole('theirs')}>
              {file.theirs === null ? 'Delete file (B)' : 'Keep modified (B)'}
            </button>
          </div>
        </div>
      </div>
    )

  const registerRef = (n: number, side: Side, el: HTMLDivElement | null) => {
    const k = `${n}:${side}`
    if (el) refs.current.set(k, el)
    else refs.current.delete(k)
  }

  return (
    <div className="view">
      {head}
      <div className="merge">
        <div className="merge-top">
          <div className="merge-pane">
            <div className="merge-pane-head">A · Current (ours)</div>
            <div className="merge-pane-body">
              <Pane path={path} side="ours" chunks={chunks} choices={choices} current={current} onToggle={toggle('ours')} registerRef={registerRef} />
            </div>
          </div>
          <div className="merge-pane">
            <div className="merge-pane-head">B · Incoming (theirs)</div>
            <div className="merge-pane-body">
              <Pane path={path} side="theirs" chunks={chunks} choices={choices} current={current} onToggle={toggle('theirs')} registerRef={registerRef} />
            </div>
          </div>
        </div>
        <div className="merge-output">
          <div className="merge-pane-head">
            Output
            {edited && <span style={{ textTransform: 'none', fontWeight: 400 }}>(edited)</span>}
            <span className="grow" style={{ flex: 1 }} />
            {conflictCount === 0 && <span style={{ textTransform: 'none', fontWeight: 400 }}>All changes merged automatically</span>}
          </div>
          <textarea
            spellCheck={false}
            value={output}
            onChange={(e) => {
              setOutput(e.target.value)
              setEdited(true)
            }}
          />
        </div>
      </div>
    </div>
  )
}

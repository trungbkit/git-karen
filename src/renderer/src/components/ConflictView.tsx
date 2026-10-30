import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConflictFile } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import { Icon } from '../ui/Icon'
import { confirm } from '../ui/dialogs'
import { merge3, renderMerge, splitLines, type Chunk, type ConflictChoice } from '../diff/merge3'
import { useTokens } from '../highlight/useHighlight'
import { TokenLine } from '../highlight/Highlighted'
import { scrollBehavior } from '../ui/appearance'
import { buildConflictPrompt, conflictMaxTokens, parseConflictResolutions } from '../smart/conflict'
import { AiQuickSetup } from './AiQuickSetup'
import '../styles/detail.css'

type Side = 'ours' | 'theirs'

type AiState =
  | { kind: 'idle' }
  | { kind: 'setup' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }
  /** `resolved`: the conflicts the reply had usable lines for */
  | { kind: 'done'; notes: (string | null)[]; resolved: boolean[] }

function Pane({
  path,
  side,
  chunks,
  choices,
  aiResolved,
  current,
  onToggle,
  registerRef
}: {
  path: string
  side: Side
  chunks: Chunk[]
  choices: ConflictChoice[]
  /** Conflicts whose output the AI wrote */
  aiResolved: boolean[]
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
              {aiResolved[n] && <span className="muted"> · resolved by AI</span>}
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
  /** Per conflict, the AI's merged lines (replacing the chosen sides) */
  const [overrides, setOverrides] = useState<(string[] | null)[]>([])
  const [ai, setAi] = useState<AiState>({ kind: 'idle' })
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
  // an AI reply that arrives after another file (or a reloaded one) took over the view must not land in it
  const chunksRef = useRef(chunks)
  chunksRef.current = chunks
  const trailingNewline = !!file && (file.ours ?? file.theirs ?? '').endsWith('\n')

  const render = (ch: ConflictChoice[], ov: (string[] | null)[] = overrides) => {
    const lines = renderMerge(chunks, ch, ov)
    return lines.join('\n') + (trailingNewline && lines.length ? '\n' : '')
  }

  useEffect(() => {
    const initial = Array.from({ length: conflictCount }, () => ({ ours: false, theirs: false }))
    setChoices(initial)
    setOverrides([])
    setOutput(render(initial, []))
    setEdited(false)
    setCurrent(0)
    setAi({ kind: 'idle' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks])

  const confirmDiscardEdits = async () =>
    !edited || (await confirm('Discard manual edits?', 'Changing a selection regenerates the output and discards your manual edits.', { confirmLabel: 'Regenerate' }))

  /** False when the user kept their manual edits instead. */
  const updateChoices = async (next: ConflictChoice[], ov = overrides) => {
    if (!(await confirmDiscardEdits())) return false
    setChoices(next)
    setOverrides(ov)
    setOutput(render(next, ov))
    setEdited(false)
    return true
  }

  // picking a side by hand takes that conflict back from the AI
  const toggle = (side: Side) => (n: number) => {
    if (ai.kind === 'running') return
    setCurrent(n)
    void updateChoices(
      choices.map((c, i) => (i === n ? { ...c, [side]: !c[side] } : c)),
      overrides.map((o, i) => (i === n ? null : o))
    )
  }

  const resolveWithAi = async () => {
    if (!file || ai.kind === 'running') return
    const prompt = buildConflictPrompt({ path, chunks, operation: repo.status?.operation })
    if (!prompt) {
      setAi({ kind: 'error', message: 'These conflicts are too large for the AI to resolve in one reply. Resolve them by hand.' })
      return
    }
    if (!(await confirmDiscardEdits())) return
    const status = await window.ai.status().catch(() => null)
    if (status && !status.active) {
      setAi({ kind: 'setup' })
      return
    }
    setAi({ kind: 'running' })
    const asked = chunks
    try {
      const raw = await window.ai.complete(prompt, conflictMaxTokens(chunks))
      if (chunksRef.current !== asked) return
      const { lines, notes } = parseConflictResolutions(raw, conflictCount)
      if (lines.every((l) => l === null)) throw new Error('The AI returned no usable resolution. Try again, or resolve by hand.')
      const cleared = choices.map(() => ({ ours: false, theirs: false }))
      setChoices(cleared)
      setOverrides(lines)
      setOutput(render(cleared, lines))
      setEdited(false)
      setAi({ kind: 'done', notes, resolved: lines.map((l) => l !== null) })
      const first = lines.findIndex((l) => l === null)
      if (first >= 0) goTo(first)
    } catch (e) {
      if (chunksRef.current === asked) setAi({ kind: 'error', message: (e as Error).message })
    }
  }

  const discardAi = () => {
    void updateChoices(
      choices.map(() => ({ ours: false, theirs: false })),
      []
    ).then((ok) => ok && setAi({ kind: 'idle' }))
  }

  const goTo = (n: number) => {
    if (conflictCount === 0) return
    const idx = (n + conflictCount) % conflictCount
    setCurrent(idx)
    for (const side of ['ours', 'theirs'] as Side[]) refs.current.get(`${idx}:${side}`)?.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
  }

  const close = () => setCenter({ kind: 'graph' })

  const save = async () => {
    const unresolved = choices.filter((c, i) => !c.ours && !c.theirs && !overrides[i]).length
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
      {conflictCount > 0 && (
        <button
          className="btn small"
          disabled={ai.kind === 'running'}
          title="Let AI merge both sides of every conflict; you review the output before saving"
          onClick={() => void resolveWithAi()}
        >
          {ai.kind === 'running' ? <span className="spinner small" /> : <Icon name="sparkle" size={12} />} {ai.kind === 'running' ? 'Resolving…' : 'Resolve with AI'}
        </button>
      )}
      <button className="btn small" disabled={!file} onClick={() => void takeWhole('ours')}>
        Take all A
      </button>
      <button className="btn small" disabled={!file} onClick={() => void takeWhole('theirs')}>
        Take all B
      </button>
      {conflictCount > 0 && (
        <button className="btn small" onClick={() => void updateChoices(choices.map(() => ({ ours: false, theirs: false })), []).then((ok) => ok && setAi({ kind: 'idle' }))}>
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

  const aiResolved = overrides.map((o) => o !== null)
  return (
    <div className="view">
      {head}
      {ai.kind === 'setup' && (
        <div className="ai-merge">
          <AiQuickSetup why="to resolve these conflicts" onConnected={(s) => s.active && void resolveWithAi()} onDismiss={() => setAi({ kind: 'idle' })} />
        </div>
      )}
      {ai.kind === 'error' && (
        <div className="ai-merge">
          <div className="ai-merge-head">
            <Icon name="sparkle" size={13} />
            <span className="field-error">{ai.message}</span>
            <span className="grow" />
            <button className="icon-btn" title="Dismiss" aria-label="Dismiss" onClick={() => setAi({ kind: 'idle' })}>
              <Icon name="x" size={12} />
            </button>
          </div>
        </div>
      )}
      {ai.kind === 'done' && (
        <div className="ai-merge">
          <div className="ai-merge-head">
            <Icon name="sparkle" size={13} />
            <b>
              AI resolved {ai.resolved.filter(Boolean).length} of {conflictCount} {conflictCount === 1 ? 'conflict' : 'conflicts'}.
            </b>
            <span className="muted">Review the output before saving; picking a side takes a conflict back.</span>
            <span className="grow" />
            <button className="btn small" onClick={discardAi}>
              Discard AI result
            </button>
          </div>
          {ai.notes.map((note, i) => (
            <div key={i} className="ai-merge-note">
              <button className="btn ghost small" onClick={() => goTo(i)}>
                Conflict {i + 1}
              </button>
              {aiResolved[i] ? (
                <span>{note ?? 'Resolved.'}</span>
              ) : choices[i]?.ours || choices[i]?.theirs ? (
                <span className="muted">You picked the sides by hand.</span>
              ) : (
                <span className="field-error">{ai.resolved[i] ? 'Taken back from the AI; pick a side.' : 'No usable resolution; pick a side.'}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="merge">
        <div className="merge-top">
          <div className="merge-pane">
            <div className="merge-pane-head">A · Current (ours)</div>
            <div className="merge-pane-body">
              <Pane path={path} side="ours" chunks={chunks} choices={choices} aiResolved={aiResolved} current={current} onToggle={toggle('ours')} registerRef={registerRef} />
            </div>
          </div>
          <div className="merge-pane">
            <div className="merge-pane-head">B · Incoming (theirs)</div>
            <div className="merge-pane-body">
              <Pane path={path} side="theirs" chunks={chunks} choices={choices} aiResolved={aiResolved} current={current} onToggle={toggle('theirs')} registerRef={registerRef} />
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
            readOnly={ai.kind === 'running'}
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

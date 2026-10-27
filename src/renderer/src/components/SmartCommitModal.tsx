// Smart commit: stage -> commit -> push -> pull requests in one run, with AI-written commit message and PR texts.
// Setup picks the targets and steps; review shows what will happen with every text editable; run reports each step.
// The quick pull request flow (prOnly) only pushes and opens PRs, and skips setup when the targets are already known.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AiStatus } from '@shared/types'
import { useActiveRepo, useStore, type RepoTab } from '../state/store'
import { Modal } from '../ui/Modal'
import { Icon } from '../ui/Icon'
import { commitSplit, execute, generateCommitMessage, prepare, proposeSplit, type ExecuteResult, type Prepared, type SplitProposal, type StepUpdate } from '../smart/workflow'
import { lintCommitMessage } from '../smart/message'
import { offerUndo } from '../actions/undo'
import { parseBranchList, SMART_STEPS, type SmartIntent, type SmartStep } from '../smart/text'
import { PROVIDER_LABELS } from '../smart/aiKeys'
import { AiQuickSetup } from './AiQuickSetup'
import '../styles/detail.css'
import '../styles/staging.css'

const STEP_LABELS: Record<SmartStep, string> = {
  stage: 'Stage all changes',
  commit: 'Commit',
  push: 'Push',
  pr: 'Open pull requests'
}

export function SmartCommitModal() {
  const modal = useStore((s) => s.modal)
  const repo = useActiveRepo()
  if (modal?.kind !== 'smartCommit' || !repo) return null
  return <SmartCommit repo={repo} prOnly={!!modal.prOnly} />
}

type Phase = { kind: 'setup' } | { kind: 'preparing'; label: string } | { kind: 'review'; prepared: Prepared } | { kind: 'running' } | { kind: 'done'; result: ExecuteResult | null }

function splitMessage(message: string) {
  const [summary = '', ...rest] = message.split('\n')
  return { summary, description: rest.join('\n').trim() }
}

function SmartCommit({ repo, prOnly }: { repo: RepoTab; prOnly: boolean }) {
  const prefs = useStore((s) => s.prefs)
  const { setModal, setPrefs, updateRepo, refresh, toast } = useStore.getState()
  const [ai, setAi] = useState<AiStatus | null>(null)
  /** The quick AI setup was closed with "Not now" */
  const [aiDismissed, setAiDismissed] = useState(false)
  const [intent, setIntent] = useState<SmartIntent>({ stage: !prOnly, commit: !prOnly, push: true, pr: true })
  const [targetsText, setTargetsText] = useState(prefs.smartCommitTargets)
  const [mergeLocal, setMergeLocal] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' })
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [prs, setPrs] = useState<{ target: string; title: string; description: string; missing: boolean }[]>([])
  const [regenerating, setRegenerating] = useState(false)
  const [steps, setSteps] = useState<StepUpdate[]>([])
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void window.ai.status().then((s) => alive.current && setAi(s), () => undefined)
    return () => {
      alive.current = false
    }
  }, [])

  const branch = repo.status?.detached ? null : (repo.status?.branch ?? null)
  const targets = parseBranchList(targetsText).filter((t) => t !== branch)
  const remoteBranches = new Set(repo.refs.filter((r) => r.type === 'remote').map((r) => r.name))
  const remote = repo.remotes.find((r) => r.name === 'origin')?.name ?? repo.remotes[0]?.name
  const unknownTargets = remote ? targets.filter((t) => !remoteBranches.has(`${remote}/${t}`)) : []
  const protectedBranches = parseBranchList(prefs.protectedBranches)
  const running = phase.kind === 'running' || phase.kind === 'preparing'

  const close = () => {
    if (phase.kind !== 'running') setModal(null)
  }

  const toggle = (step: SmartStep, on: boolean) =>
    setIntent((i) => ({ ...i, [step]: on, ...(step === 'commit' && !on ? { stage: false } : {}), ...(step === 'stage' && on ? { commit: true } : {}) }))

  const start = async () => {
    setPhase({ kind: 'preparing', label: 'Starting' })
    try {
      const p = await prepare(repo.path, intent, targets, (label) => alive.current && setPhase({ kind: 'preparing', label }))
      if (!alive.current) return
      const { summary, description } = splitMessage(p.commitMessage)
      setSummary(summary)
      setDescription(description)
      setPrs(p.prs.map(({ target, title, description, missing }) => ({ target, title, description, missing })))
      setPhase({ kind: 'review', prepared: p })
    } catch (e) {
      if (!alive.current) return
      toast({ kind: 'error', title: 'Smart commit failed', message: (e as Error).message })
      setPhase({ kind: 'setup' })
    }
  }

  const autoStarted = useRef(false)
  useEffect(() => {
    if (!prOnly || autoStarted.current || !branch || targets.length === 0) return
    autoStarted.current = true
    void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const regenerate = async (p: Prepared) => {
    setRegenerating(true)
    try {
      const message = await generateCommitMessage(repo.path, p.plan.run.stage)
      if (!alive.current) return
      const next = splitMessage(message)
      setSummary(next.summary)
      setDescription(next.description)
    } catch (e) {
      toast({ kind: 'error', title: 'Could not generate a commit message', message: (e as Error).message })
    } finally {
      if (alive.current) setRegenerating(false)
    }
  }

  const run = async (p: Prepared) => {
    const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim()
    setSteps([])
    setPhase({ kind: 'running' })
    updateRepo(repo.path, { busy: 'Smart commit' })
    let result: ExecuteResult | null = null
    try {
      result = await execute(
        repo.path,
        p,
        { commitMessage: message, prs: prs.filter((pr) => !pr.missing), mergeLocal, protectedBranches },
        (u) => setSteps((all) => (all.some((s) => s.id === u.id) ? all.map((s) => (s.id === u.id ? u : s)) : [...all, u]))
      )
    } catch {
      // the failed step is shown in the log
    } finally {
      updateRepo(repo.path, { busy: null })
      void refresh(repo.path, { log: true })
      setPhase({ kind: 'done', result })
    }
  }

  const saveTargets = () => void setPrefs({ smartCommitTargets: parseBranchList(targetsText).join(',') })

  let body: ReactNode
  let footer: ReactNode
  if (phase.kind === 'setup' || phase.kind === 'preparing') {
    const nothing = !intent.commit && !intent.push && !intent.pr
    body = (
      <>
        <div className="smart-head">
          <Icon name="branch" size={13} /> <b>{branch ?? 'detached HEAD'}</b>
          {remote ? <span className="muted">→ {remote}</span> : <span className="field-warning">no remote</span>}
          <span className="grow" />
          <AiBadge ai={ai} onSetup={() => setAiDismissed(false)} />
        </div>
        {ai && !ai.active && !aiDismissed && (
          <AiQuickSetup why="to write the commit message and pull request texts" onConnected={setAi} onDismiss={() => setAiDismissed(true)} />
        )}
        <div className="field">
          <label>Pull request targets</label>
          <input value={targetsText} onChange={(e) => setTargetsText(e.target.value)} placeholder="uat,main" disabled={!intent.pr || running} />
          {unknownTargets.length > 0 && intent.pr && (
            <span className="field-warning">
              Not on {remote}: {unknownTargets.join(', ')} (PRs against them will be skipped)
            </span>
          )}
          {targetsText !== prefs.smartCommitTargets && intent.pr && (
            <button className="btn ghost small smart-link" onClick={saveTargets}>
              Use these targets by default
            </button>
          )}
        </div>
        <div className="smart-steps-setup">
          {SMART_STEPS.map((step) => (
            <label key={step} className="check">
              <input type="checkbox" checked={intent[step]} disabled={running} onChange={(e) => toggle(step, e.target.checked)} />
              {STEP_LABELS[step]}
            </label>
          ))}
          <label className="check" title={`Protected branches (${protectedBranches.join(', ')}) are only merged through the hosting UI`}>
            <input type="checkbox" checked={mergeLocal} disabled={running || !intent.pr} onChange={(e) => setMergeLocal(e.target.checked)} />
            Then merge locally into non-protected targets
          </label>
        </div>
        <span className="field-hint">
          Each step runs only when it has something to do: a clean branch that is already pushed just gets its pull requests. You review the commit message and
          pull request texts before anything changes.
        </span>
        {nothing && <span className="field-error">Commit, push and pull requests are all off — nothing to do.</span>}
        {phase.kind === 'preparing' && (
          <span className="smart-progress">
            <span className="spinner small" /> {phase.label}…
          </span>
        )}
      </>
    )
    footer = (
      <>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" autoFocus disabled={running || nothing || !branch || (intent.pr && targets.length === 0)} onClick={() => void start()}>
          {phase.kind === 'preparing' ? 'Preparing…' : 'Prepare'}
        </button>
      </>
    )
  } else if (phase.kind === 'review') {
    const p = phase.prepared
    const idle = !Object.values(p.plan.run).some(Boolean)
    const detail: Record<SmartStep, string> = {
      stage: [p.status.unstaged && 'modified files', p.status.untracked && 'new files'].filter(Boolean).join(' + '),
      commit: summary || '(no message yet)',
      push: `${p.remote}/${p.branch}`,
      pr: prs.map((pr) => pr.target).join(', ')
    }
    body = (
      <>
        {p.warnings.map((w, i) => (
          <span key={i} className="field-warning">
            <Icon name="warning" size={11} /> {w}
          </span>
        ))}
        <div className="smart-plan">
          {SMART_STEPS.map((step) => (
            <div key={step} className={`smart-plan-row ${p.plan.run[step] ? 'on' : 'off'}`}>
              <Icon name={p.plan.run[step] ? 'check' : 'chevron-right'} size={12} />
              <span className="smart-plan-name">{step}</span>
              <span className="ellipsis">{p.plan.run[step] ? detail[step] : `skipped (${p.plan.reasons[step]})`}</span>
            </div>
          ))}
        </div>
        {p.plan.caveats.map((c) => (
          <span key={c} className="field-warning">
            {c}
          </span>
        ))}
        {idle && <span className="field-hint">Nothing to do — every step is either off or already done.</span>}
        {p.plan.run.commit && (
          <div className="field">
            <label className="smart-label">
              Commit message
              <button className="btn ghost small" disabled={regenerating || !ai?.active} onClick={() => void regenerate(p)} title="Write the message again with AI">
                {regenerating ? <span className="spinner small" /> : <Icon name="sparkle" size={12} />} Regenerate
              </button>
            </label>
            <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Commit summary" />
            <textarea rows={Math.min(10, Math.max(3, description.split('\n').length + 1))} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" />
          </div>
        )}
        {p.plan.run.pr &&
          prs.map((pr, i) => (
            <div key={pr.target} className={`field smart-pr ${pr.missing ? 'missing' : ''}`}>
              <label className="smart-label">
                <Icon name="pull-request" size={12} /> {p.branch} → {pr.target}
                {protectedBranches.includes(pr.target) && <span className="smart-tag">protected</span>}
                {pr.missing && <span className="field-warning">not on {p.remote}; will be skipped</span>}
              </label>
              {!pr.missing && (
                <>
                  <input value={pr.title} onChange={(e) => setPrs(prs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} placeholder="Title" />
                  <textarea rows={8} value={pr.description} onChange={(e) => setPrs(prs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} placeholder="Description (Markdown)" />
                </>
              )}
            </div>
          ))}
        {p.template && <span className="field-hint">PR descriptions follow the repository template {p.template.path}.</span>}
      </>
    )
    const invalid = (p.plan.run.commit && !summary.trim()) || (p.plan.run.pr && prs.some((pr) => !pr.missing && !pr.title.trim()))
    footer = (
      <>
        <button className="btn" onClick={() => setPhase({ kind: 'setup' })}>
          Back
        </button>
        <button className="btn primary" autoFocus disabled={idle || invalid} onClick={() => void run(p)}>
          Run
        </button>
      </>
    )
  } else {
    const result = phase.kind === 'done' ? phase.result : null
    const opened = result?.prs.filter((r) => r.status !== 'skipped') ?? []
    const viaUi = opened.filter((r) => protectedBranches.includes(r.target) || !result?.merged.includes(r.target))
    body = (
      <>
        <StepLog steps={steps} />
        {phase.kind === 'done' && viaUi.length > 0 && (
          <span className="field-hint">Review and merge {viaUi.map((r) => r.target).join(', ')} on GitHub once approved.</span>
        )}
      </>
    )
    footer = (
      <button className="btn primary" autoFocus disabled={phase.kind === 'running'} onClick={close}>
        {phase.kind === 'running' ? 'Running…' : 'Close'}
      </button>
    )
  }

  return (
    <Modal
      title={
        <span className="wt-modal-title">
          <Icon name="sparkle" size={14} /> {intent.commit ? 'Smart commit & pull request' : 'Create pull request'}
        </span>
      }
      onClose={close}
      width={720}
      footer={<Fragment key={phase.kind}>{footer}</Fragment>}
    >
      {body}
    </Modal>
  )
}

function StepLog({ steps }: { steps: StepUpdate[] }) {
  return (
    <div className="smart-log">
      {steps.map((s) => (
        <div key={s.id} className={`smart-log-row ${s.state}`}>
          <span className="smart-log-icon">
            {s.state === 'running' ? <span className="spinner small" /> : <Icon name={s.state === 'done' ? 'check' : s.state === 'failed' ? 'x' : 'chevron-right'} size={12} />}
          </span>
          <span className="smart-log-text">
            {s.label}
            {s.detail && <span className="smart-log-detail">{s.detail}</span>}
          </span>
          {s.url && (
            <button className="btn ghost small" onClick={() => void window.app.openExternal(s.url!)}>
              <Icon name="external" size={12} /> Open
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** `onSetup` shows the quick setup in place; without it the button opens Preferences > AI. */
function AiBadge({ ai, onSetup }: { ai: AiStatus | null; onSetup?(): void }) {
  const setModal = useStore((s) => s.setModal)
  if (!ai) return null
  if (!ai.active)
    return (
      <button
        className="btn ghost small field-warning"
        title="Without AI, the commit message is yours to write and PR texts come from the commit subjects"
        onClick={() => (onSetup ? onSetup() : setModal({ kind: 'preferences', section: 'ai' }))}
      >
        <Icon name="warning" size={11} /> No AI provider — set one up
      </button>
    )
  return (
    <span className="muted smart-ai" title={`Credential: ${ai.active.credential}`}>
      <Icon name="sparkle" size={12} /> {PROVIDER_LABELS[ai.active.provider]} · {ai.active.model}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// Split commit: the AI groups every uncommitted change into commits; each group can be ticked, re-messaged and given
// or relieved of changes before "Commit all" makes the commits one after another.

interface EditableGroup {
  message: string
  units: string[]
  on: boolean
}

type SplitPhase =
  | { kind: 'checking' }
  /** No provider: grouping waits for the quick setup */
  | { kind: 'needsAi' }
  | { kind: 'analysing'; label: string }
  | { kind: 'error'; message: string }
  | { kind: 'review'; proposal: SplitProposal }
  | { kind: 'running'; proposal: SplitProposal }
  | { kind: 'done'; made: number }

export function SplitCommitModal() {
  const repo = useActiveRepo()
  if (!repo) return null
  return <SplitCommit repo={repo} />
}

function SplitCommit({ repo }: { repo: RepoTab }) {
  const conventional = useStore((s) => s.prefs.conventionalCommits)
  const { setModal, updateRepo, refresh } = useStore.getState()
  const [ai, setAi] = useState<AiStatus | null>(null)
  const [phase, setPhase] = useState<SplitPhase>({ kind: 'checking' })
  const [groups, setGroups] = useState<EditableGroup[]>([])
  /** Units in no group: they stay uncommitted */
  const [left, setLeft] = useState<string[]>([])
  const [noVerify, setNoVerify] = useState(false)
  const [steps, setSteps] = useState<StepUpdate[]>([])
  const alive = useRef(true)

  const status = repo.status
  const blocked = !status
    ? 'Loading…'
    : status.conflicted.length > 0 || status.operation
      ? 'Finish or abort the operation in progress first.'
      : !status.headSha
        ? 'The repository has no commits yet; make the first commit normally.'
        : null

  const analyse = async () => {
    setPhase({ kind: 'analysing', label: 'Starting' })
    try {
      const proposal = await proposeSplit(repo.path, (label) => alive.current && setPhase({ kind: 'analysing', label }))
      if (!alive.current) return
      setGroups(proposal.groups.map((g) => ({ ...g, on: true })))
      setLeft(proposal.unassigned)
      setPhase({ kind: 'review', proposal })
    } catch (e) {
      if (alive.current) setPhase({ kind: 'error', message: (e as Error).message })
    }
  }

  useEffect(() => {
    alive.current = true
    if (blocked) setPhase({ kind: 'error', message: blocked })
    void window.ai.status().then(
      (s) => {
        if (!alive.current) return
        setAi(s)
        if (blocked) return
        if (s.active) void analyse()
        else setPhase({ kind: 'needsAi' })
      },
      () => !blocked && void analyse()
    )
    return () => {
      alive.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = () => {
    if (phase.kind !== 'running') setModal(null)
  }

  /** Move a unit to group `to` (-1 leaves it uncommitted), keeping units in their listed order. */
  const move = (proposal: SplitProposal, id: string, to: number) => {
    const order = new Map(proposal.units.map((u, i) => [u.id, i]))
    const sorted = (ids: string[]) => [...ids].sort((a, b) => order.get(a)! - order.get(b)!)
    setGroups((gs) => gs.map((g, i) => ({ ...g, units: sorted(i === to ? [...g.units.filter((u) => u !== id), id] : g.units.filter((u) => u !== id)) })))
    setLeft((l) => sorted(to === -1 ? [...l.filter((u) => u !== id), id] : l.filter((u) => u !== id)))
  }

  const commitAll = async (proposal: SplitProposal) => {
    const chosen = groups.filter((g) => g.on && g.units.length > 0).map((g) => ({ message: g.message.trim(), units: g.units }))
    setSteps([])
    setPhase({ kind: 'running', proposal })
    updateRepo(repo.path, { busy: 'Split commit' })
    const before = await window.git.resolveRef(repo.path, 'HEAD').catch(() => null)
    let made = 0
    try {
      await commitSplit(repo.path, proposal, chosen, { noVerify }, (u) => {
        if (u.state === 'done' && u.id.startsWith('commit:')) made++
        setSteps((all) => (all.some((s) => s.id === u.id) ? all.map((s) => (s.id === u.id ? u : s)) : [...all, u]))
      })
    } catch {
      // the failed step is shown in the log; the commits made before it stay
    } finally {
      updateRepo(repo.path, { busy: null })
      void refresh(repo.path, { log: true })
    }
    const after = await window.git.resolveRef(repo.path, 'HEAD').catch(() => null)
    if (before && after && after !== before) {
      // every change made by the split goes back to the work tree, unstaged
      offerUndo(repo.path, 'Split commit', (r) => window.git.reset(r, before, 'mixed'), { title: 'Split commit finished' })
    }
    if (alive.current) setPhase({ kind: 'done', made })
  }

  let body: ReactNode
  let footer: ReactNode
  if (phase.kind === 'checking' || phase.kind === 'needsAi' || phase.kind === 'analysing' || phase.kind === 'error') {
    body = (
      <>
        <div className="smart-head">
          <Icon name="branch" size={13} /> <b>{status?.branch ?? 'detached HEAD'}</b>
          <span className="grow" />
          <AiBadge ai={ai} onSetup={() => setPhase({ kind: 'needsAi' })} />
        </div>
        <span className="field-hint">
          Every uncommitted change — staged, unstaged and new files — is regrouped into commits. You review the groups and their messages before anything is
          committed.
        </span>
        {phase.kind === 'needsAi' ? (
          <AiQuickSetup
            why="to group the changes into commits"
            onConnected={(s) => {
              setAi(s)
              if (s.active) void analyse()
            }}
          />
        ) : phase.kind === 'error' ? (
          <span className="field-error">{phase.message}</span>
        ) : (
          <span className="smart-progress">
            <span className="spinner small" /> {phase.kind === 'analysing' ? phase.label : 'Starting'}…
          </span>
        )}
      </>
    )
    footer = (
      <>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        {phase.kind !== 'needsAi' && (
          <button className="btn primary" disabled={phase.kind !== 'error' || !!blocked} onClick={() => void analyse()}>
            {phase.kind === 'error' ? 'Try again' : 'Grouping…'}
          </button>
        )}
      </>
    )
  } else if (phase.kind === 'review') {
    const p = phase.proposal
    const byId = new Map(p.units.map((u) => [u.id, u]))
    const hunkCount = new Map<string, number>()
    for (const u of p.units) if (u.hunk !== undefined) hunkCount.set(u.path, (hunkCount.get(u.path) ?? 0) + 1)
    const chosen = groups.filter((g) => g.on && g.units.length > 0)
    const invalid = chosen.some((g) => !g.message.trim())
    const unitRow = (id: string, group: number) => {
      const u = byId.get(id)!
      return (
        <div key={id} className="split-unit">
          <span className="split-unit-path ellipsis" title={u.oldPath ? `${u.oldPath} → ${u.path}` : u.path}>
            {u.path}
            {u.hunk !== undefined && (
              <span className="muted">
                {' '}
                · hunk {u.hunk + 1}/{hunkCount.get(u.path)}
              </span>
            )}
            {u.untracked && <span className="muted"> · new</span>}
          </span>
          <span className="stats">
            {u.additions > 0 && <span className="add">+{u.additions}</span>}
            {u.deletions > 0 && <span className="del">−{u.deletions}</span>}
          </span>
          <select value={group} title="Move to another commit" onChange={(e) => move(p, id, Number(e.target.value))}>
            {groups.map((g, i) => (
              <option key={i} value={i}>
                Commit {i + 1}
              </option>
            ))}
            <option value={-1}>Leave uncommitted</option>
          </select>
        </div>
      )
    }
    body = (
      <>
        {p.warnings.map((w, i) => (
          <span key={i} className="field-warning">
            <Icon name="warning" size={11} /> {w}
          </span>
        ))}
        {groups.map((g, i) => {
          const warnings = lintCommitMessage(g.message, { conventional })
          return (
            <div key={i} className={`field split-group ${g.on && g.units.length ? '' : 'off'}`}>
              <label className="check smart-label">
                <input type="checkbox" checked={g.on} disabled={g.units.length === 0} onChange={(e) => setGroups(groups.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                Commit {i + 1}
                <span className="muted">
                  {g.units.length} {g.units.length === 1 ? 'change' : 'changes'}
                </span>
              </label>
              <textarea
                rows={Math.min(6, Math.max(2, g.message.split('\n').length))}
                value={g.message}
                placeholder="Commit message"
                onChange={(e) => setGroups(groups.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))}
              />
              {g.on && g.units.length > 0 && !g.message.trim() && <span className="field-error">Write a message for this commit.</span>}
              {warnings.map((w) => (
                <span key={w.rule} className="field-warning">
                  {w.message}
                </span>
              ))}
              <div className="split-units">{g.units.map((id) => unitRow(id, i))}</div>
            </div>
          )
        })}
        {left.length > 0 && (
          <div className="field split-group off">
            <label className="smart-label">Left uncommitted</label>
            <div className="split-units">{left.map((id) => unitRow(id, -1))}</div>
          </div>
        )}
        <label className="check" title="Pass --no-verify (skip pre-commit and commit-msg hooks)">
          <input type="checkbox" checked={noVerify} onChange={(e) => setNoVerify(e.target.checked)} />
          Skip hooks
        </label>
      </>
    )
    footer = (
      <>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn" disabled={!ai?.active} onClick={() => void analyse()} title="Ask the AI to group the changes again">
          <Icon name="sparkle" size={12} /> Regroup
        </button>
        <button className="btn primary" autoFocus disabled={chosen.length === 0 || invalid || !!repo.busy} onClick={() => void commitAll(p)}>
          Commit all ({chosen.length})
        </button>
      </>
    )
  } else {
    body = (
      <>
        <StepLog steps={steps} />
        {phase.kind === 'done' && (
          <span className="field-hint">
            {phase.made} {phase.made === 1 ? 'commit' : 'commits'} made. Changes left out of the commits are still in the working directory.
          </span>
        )}
      </>
    )
    footer = (
      <button className="btn primary" autoFocus disabled={phase.kind === 'running'} onClick={close}>
        {phase.kind === 'running' ? 'Committing…' : 'Close'}
      </button>
    )
  }

  return (
    <Modal
      title={
        <span className="wt-modal-title">
          <Icon name="sparkle" size={14} /> Split into commits
        </span>
      }
      onClose={close}
      width={760}
      footer={<Fragment key={phase.kind}>{footer}</Fragment>}
    >
      {body}
    </Modal>
  )
}

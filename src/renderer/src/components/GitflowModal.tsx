import { useEffect, useState } from 'react'
import type { GitflowConfig, GitflowKind } from '@shared/types'
import { useActiveRepo, useStore } from '../state/store'
import { Modal } from '../ui/Modal'
import { prompt, validateRefName } from '../ui/dialogs'
import { Icon } from '../ui/Icon'
import '../styles/detail.css'

const KINDS: GitflowKind[] = ['feature', 'release', 'hotfix']
const KIND_LABEL: Record<GitflowKind, string> = { feature: 'Feature', release: 'Release', hotfix: 'Hotfix' }

export function GitflowModal() {
  const repo = useActiveRepo()
  const { setModal, run } = useStore.getState()
  const [config, setConfig] = useState<GitflowConfig | null | undefined>(undefined)
  const [form, setForm] = useState<GitflowConfig | null>(null)
  const close = () => setModal(null)

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    window.git.gitflowConfig(repo.path).then(
      (c) => !cancelled && setConfig(c),
      () => !cancelled && setConfig(null)
    )
    return () => {
      cancelled = true
    }
  }, [repo?.path])

  useEffect(() => {
    if (config !== null || !repo || form) return
    const locals = repo.refs.filter((r) => r.type === 'local').map((r) => r.name)
    const master = locals.includes('main') ? 'main' : locals.includes('master') ? 'master' : (repo.status?.branch ?? 'main')
    setForm({ master, develop: 'develop', feature: 'feature/', release: 'release/', hotfix: 'hotfix/', versionTag: '' })
  }, [config, repo, form])

  if (!repo) return null

  const reload = async () => setConfig(await window.git.gitflowConfig(repo.path).catch(() => null))

  if (config === undefined)
    return (
      <Modal title="Gitflow" onClose={close}>
        <span className="muted">Loading…</span>
      </Modal>
    )

  if (config === null && form) {
    const f = (key: keyof GitflowConfig, label: string) => (
      <div className="field">
        <label>{label}</label>
        <input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      </div>
    )
    return (
      <Modal
        title="Initialize Gitflow"
        onClose={close}
        width={520}
        footer={
          <>
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={!form.master || !form.develop}
              onClick={async () => {
                if (await run('Initializing Gitflow', (r) => window.git.gitflowInit(r, form), { success: 'Gitflow has been initialized' })) await reload()
              }}
            >
              Initialize Gitflow
            </button>
          </>
        }
      >
        <span className="muted">Gitflow is not initialized for this repository.</span>
        <h4 style={{ margin: '4px 0 0' }}>Branches</h4>
        <div className="row2">
          {f('master', 'Production (main/master)')}
          {f('develop', 'Development')}
        </div>
        <h4 style={{ margin: '4px 0 0' }}>Prefixes</h4>
        <div className="row2">
          {f('feature', 'Feature')}
          {f('release', 'Release')}
          {f('hotfix', 'Hotfix')}
          {f('versionTag', 'Version tag')}
        </div>
      </Modal>
    )
  }
  if (!config) return null

  const start = async (kind: GitflowKind) => {
    const res = await prompt({
      title: `Start ${KIND_LABEL[kind].toLowerCase()}`,
      message: `Creates ${config[kind]}<name> from ${kind === 'hotfix' ? config.master : config.develop}.`,
      fields: [{ name: 'name', label: `${KIND_LABEL[kind]} name`, validate: (v) => validateRefName(config[kind] + v) }],
      confirmLabel: `Start ${KIND_LABEL[kind]}`
    })
    if (res) await run(`Starting ${kind}`, (r) => window.git.gitflowStart(r, kind, res.name), { success: `Started ${kind}: '${res.name}'` })
  }

  const finish = async (kind: GitflowKind, name: string) => {
    const needsTag = kind !== 'feature'
    const res = await prompt({
      title: `Finish ${kind} ${name}`,
      message:
        kind === 'feature'
          ? `Merges ${config.feature}${name} into ${config.develop}.`
          : `Merges ${config[kind]}${name} into ${config.master} and ${config.develop} and tags it ${config.versionTag}${name}.`,
      fields: needsTag ? [{ name: 'tagMessage', label: 'Tag message', initial: `${config.versionTag}${name}` }] : [],
      checkboxes: [{ name: 'deleteBranch', label: 'Delete branch after finishing', initial: true }],
      confirmLabel: `Finish ${KIND_LABEL[kind]}`
    })
    if (!res) return
    await run(
      `Finishing ${kind}`,
      (r) => window.git.gitflowFinish(r, kind, name, { tagMessage: needsTag ? res.tagMessage : undefined, deleteBranch: res.checks.deleteBranch }),
      { success: `Finished ${kind}: '${name}'` }
    )
  }

  const locals = repo.refs.filter((r) => r.type === 'local')
  const current = repo.status?.branch

  return (
    <Modal title="Gitflow" onClose={close} width={560}>
      <div style={{ display: 'flex', gap: 8 }}>
        {KINDS.map((k) => (
          <button key={k} className="btn" onClick={() => void start(k)}>
            <Icon name="plus" size={12} /> Start {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {KINDS.map((k) => {
        const branches = locals.filter((r) => r.name.startsWith(config[k]))
        return (
          <div key={k} className="field">
            <label>
              {KIND_LABEL[k]} branches ({config[k]}*)
            </label>
            {branches.length === 0 ? (
              <span className="muted" style={{ fontSize: 12 }}>
                No {k} branches
              </span>
            ) : (
              <div className="list-box">
                {branches.map((b) => {
                  const name = b.name.slice(config[k].length)
                  return (
                    <div key={b.fullName} className="list-box-row">
                      <Icon name="branch" size={12} />
                      <span style={{ flex: 1 }}>
                        {b.name}
                        {b.name === current && <span className="muted"> (current)</span>}
                      </span>
                      <button className="btn small" onClick={() => void finish(k, name)}>
                        Finish
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      <span className="muted" style={{ fontSize: 12 }}>
        Production: {config.master} · Development: {config.develop}
        {config.versionTag && ` · Version tag prefix: ${config.versionTag}`}
      </span>
    </Modal>
  )
}

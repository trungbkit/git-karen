import { useCallback, useEffect, useState } from 'react'
import { useActiveRepo, useStore } from '../state/store'
import { Modal } from '../ui/Modal'
import { Icon } from '../ui/Icon'
import '../styles/detail.css'

type LfsCommand = 'fetch' | 'pull' | 'push' | 'prune' | 'checkout'

const COMMANDS: { cmd: LfsCommand; label: string; done: string }[] = [
  { cmd: 'fetch', label: 'Fetch', done: 'LFS fetched successfully' },
  { cmd: 'pull', label: 'Pull', done: 'LFS pulled successfully' },
  { cmd: 'push', label: 'Push', done: 'LFS pushed successfully' },
  { cmd: 'prune', label: 'Prune', done: 'LFS pruned successfully' },
  { cmd: 'checkout', label: 'Checkout', done: 'LFS checkout successful' }
]

/** Patterns from .gitattributes lines that use the lfs filter. */
export function parseLfsPatterns(gitattributes: string): string[] {
  return gitattributes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && /\sfilter=lfs(\s|$)/.test(l))
    .map((l) => l.split(/\s+/)[0])
}

export function LfsModal() {
  const repo = useActiveRepo()
  const { setModal, run } = useStore.getState()
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [patterns, setPatterns] = useState<string[]>([])
  const [pattern, setPattern] = useState('')
  const close = () => setModal(null)

  const load = useCallback(async () => {
    if (!repo) return
    setInstalled(await window.git.lfsInstalled(repo.path).catch(() => false))
    const attrs = await window.git.fileContent(repo.path, null, '.gitattributes').catch(() => '')
    setPatterns(parseLfsPatterns(attrs))
  }, [repo?.path])

  useEffect(() => {
    void load()
  }, [load])

  if (!repo) return null

  const track = async () => {
    const p = pattern.trim()
    if (!p) return
    if (await run('Adding LFS pattern', (r) => window.git.lfsTrack(r, p), { log: false })) {
      setPattern('')
      await load()
    }
  }

  return (
    <Modal title="Git LFS" onClose={close} width={520}>
      {installed === null ? (
        <span className="muted">Checking LFS…</span>
      ) : !installed ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span>
            <Icon name="warning" size={13} /> Git LFS is not installed or not initialized for this repository.
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            Install git-lfs (e.g. <span className="mono">brew install git-lfs</span>). Adding a tracking pattern below initializes LFS for this repo.
          </span>
        </div>
      ) : (
        <span className="muted" style={{ fontSize: 12 }}>
          <Icon name="check" size={12} /> LFS is available.
        </span>
      )}
      <div className="field">
        <label>Tracking patterns</label>
        {patterns.length === 0 ? (
          <span className="muted" style={{ fontSize: 12 }}>
            No LFS patterns in .gitattributes
          </span>
        ) : (
          <div className="list-box">
            {patterns.map((p) => (
              <div key={p} className="list-box-row mono">
                <Icon name="lfs" size={12} />
                {p}
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ flex: 1 }}
          placeholder="Enter a pattern (e.g., *.zip)"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void track()}
        />
        <button className="btn" disabled={!pattern.trim()} onClick={() => void track()}>
          Add pattern
        </button>
      </div>
      <div className="field">
        <label>LFS commands</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {COMMANDS.map((c) => (
            <button
              key={c.cmd}
              className="btn small"
              disabled={!installed}
              onClick={() => void run(`LFS ${c.cmd}`, (r) => window.git.lfsCommand(r, c.cmd), { success: c.done })}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <button className="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => void window.app.openInEditor(repo.path, '.gitattributes')}>
        <Icon name="external" size={12} /> View .gitattributes in editor
      </button>
    </Modal>
  )
}

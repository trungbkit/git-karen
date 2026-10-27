import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { Modal } from '../ui/Modal'
import { joinPath } from '../util/format'
import { reduceProgress, type OperationProgress } from '../util/progress'
import { ProgressBar, progressText } from '../ui/Progress'
import '../styles/shell.css'

/** Derive a folder name from a clone URL: https://host/a/b.git -> b */
export function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '').replace(/\.git$/, '')
  const last = trimmed.split(/[/:\\]/).pop() ?? ''
  return last
}

function DirPicker({ value, onChange, title }: { value: string; onChange(v: string): void; title: string }) {
  return (
    <div className="dir-picker">
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="/path/to/folder" />
      <button
        className="btn"
        onClick={async () => {
          const dir = await window.app.pickDirectory(title)
          if (dir) onChange(dir)
        }}
      >
        Browse…
      </button>
    </div>
  )
}

export function CloneModal() {
  const modal = useStore((s) => s.modal)
  if (modal?.kind !== 'clone') return null
  return <CloneForm />
}

function CloneForm() {
  const setModal = useStore((s) => s.setModal)
  const openRepo = useStore((s) => s.openRepo)
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [progress, setProgress] = useState<OperationProgress | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!nameTouched) setName(repoNameFromUrl(url))
  }, [url, nameTouched])

  useEffect(() => window.app.onProgress((e) => e.op === 'clone' && setProgress((p) => reduceProgress(p, 'clone', e.message))), [])

  const dest = parent && name ? joinPath(parent, name) : ''
  const close = () => !busy && setModal(null)
  const submit = async () => {
    if (!url.trim() || !dest) return
    setBusy(true)
    setError(null)
    setProgress(undefined)
    try {
      const info = await window.git.clone(url.trim(), dest)
      setModal(null)
      await openRepo(info.path)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Clone a repository"
      onClose={close}
      width={560}
      footer={
        <>
          <button className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !url.trim() || !dest} onClick={() => void submit()}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Repository URL</label>
        <input autoFocus value={url} placeholder="https://github.com/owner/repo.git or git@host:owner/repo.git" onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="field">
        <label>Where to clone to</label>
        <DirPicker value={parent} onChange={setParent} title="Choose a parent folder" />
      </div>
      <div className="field">
        <label>Folder name</label>
        <input
          value={name}
          onChange={(e) => {
            setNameTouched(true)
            setName(e.target.value)
          }}
        />
      </div>
      {dest && <div className="muted mono modal-note">{dest}</div>}
      {busy && (
        <div className="clone-progress">
          <ProgressBar value={progress?.overall ?? null} label="Clone progress" />
          <div className="progress-line mono">
            {progress
              ? [progress.overall !== null && `${progress.overall}%`, progressText(progress), progress.detail].filter(Boolean).join(' · ')
              : 'Starting clone…'}
          </div>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
    </Modal>
  )
}

export function InitModal() {
  const modal = useStore((s) => s.modal)
  if (modal?.kind !== 'init') return null
  return <InitForm />
}

function InitForm() {
  const setModal = useStore((s) => s.setModal)
  const openRepo = useStore((s) => s.openRepo)
  const defaultBranch = useStore((s) => s.prefs.defaultBranchName)
  const [parent, setParent] = useState('')
  const [name, setName] = useState('')
  const [branch, setBranch] = useState(defaultBranch || 'main')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const dest = parent && name.trim() ? joinPath(parent, name.trim()) : ''
  const close = () => !busy && setModal(null)
  const submit = async () => {
    if (!dest) return
    setBusy(true)
    setError(null)
    try {
      const info = await window.git.init(dest, branch.trim() || undefined)
      setModal(null)
      await openRepo(info.path)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Initialize a repository"
      onClose={close}
      width={520}
      footer={
        <>
          <button className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !dest} onClick={() => void submit()}>
            Create repository
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input autoFocus value={name} placeholder="my-project" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Initialize in</label>
        <DirPicker value={parent} onChange={setParent} title="Choose a parent folder" />
      </div>
      <div className="field">
        <label>Default branch name</label>
        <input value={branch} onChange={(e) => setBranch(e.target.value)} />
      </div>
      {dest && <div className="muted mono modal-note">{dest}</div>}
      {error && <div className="form-error">{error}</div>}
    </Modal>
  )
}

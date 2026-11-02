// Preferences > General: the running version, the update status and a manual check.
import { useState, type ReactNode } from 'react'
import { downloadProgress, downloadUpdate, openReleaseNotes, restartToUpdate, useUpdate } from '../state/updates'
import { Icon } from '../ui/Icon'

export function UpdateSettings({ autoUpdate }: { autoUpdate: ReactNode }) {
  const s = useUpdate((u) => u.status)
  const [checking, setChecking] = useState(false)
  if (!s) return null

  const check = async () => {
    setChecking(true)
    try {
      const r = await window.app.checkForUpdates(false)
      if (r.phase === 'available' && r.canInstall) await downloadUpdate()
    } finally {
      setChecking(false)
    }
  }

  const busy = checking || s.phase === 'checking' || s.phase === 'downloading' || s.phase === 'installing'
  let state: ReactNode
  switch (s.phase) {
    case 'checking':
      state = <span className="muted">Checking for updates…</span>
      break
    case 'upToDate':
      state = (
        <span className="cli-ok">
          <Icon name="check" size={12} /> Up to date
        </span>
      )
      break
    case 'available':
      state = s.error ? (
        <span className="update-error">{s.error}</span>
      ) : (
        <span>Version {s.version} is available{s.canInstall ? '' : ' (development builds are not updated)'}.</span>
      )
      break
    case 'downloading':
      state = <span>Downloading version {s.version}… {downloadProgress(s)}</span>
      break
    case 'ready':
      state = <span>Version {s.version} is downloaded{s.error ? `. ${s.error}` : ' and installs on restart.'}</span>
      break
    case 'installing':
      state = <span>Installing version {s.version}…</span>
      break
    case 'error':
      state = <span className="update-error">Could not check: {s.error}</span>
      break
    default:
      state = <span className="muted">{s.checkedAt ? '' : 'Not checked yet.'}</span>
  }

  return (
    <>
      <h3>Updates</h3>
      <div className="field">
        <div className="cli-row">
          <span>
            Karen {s.currentVersion}. {state}
          </span>
          {s.version && (s.phase === 'available' || s.phase === 'downloading' || s.phase === 'ready') && (
            <button className="btn small" onClick={() => openReleaseNotes(s.version)}>
              What's new
            </button>
          )}
          {s.phase === 'ready' && s.canInstall ? (
            <button className="btn small primary" onClick={() => void restartToUpdate()}>
              Restart to update
            </button>
          ) : (
            <button className="btn small" disabled={busy} onClick={() => void check()}>
              {s.phase === 'downloading' ? 'Downloading…' : s.phase === 'installing' ? 'Installing…' : busy ? 'Checking…' : 'Check now'}
            </button>
          )}
        </div>
        {s.checkedAt && <span className="hint">Last checked {new Date(s.checkedAt).toLocaleString()}.</span>}
      </div>
      {autoUpdate}
    </>
  )
}

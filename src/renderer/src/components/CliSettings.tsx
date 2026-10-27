// Preferences > General: install the `karen [path]` command, and the karen:// link format.
import { useEffect, useState } from 'react'
import type { CliStatus } from '@shared/types'
import { Icon } from '../ui/Icon'

export function CliSettings() {
  const [status, setStatus] = useState<CliStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    window.app.cliStatus().then((s) => live && setStatus(s), () => undefined)
    return () => {
      live = false
    }
  }, [])

  if (!status?.supported) return null

  const install = async () => {
    setInstalling(true)
    setError(null)
    try {
      setStatus(await window.app.installCli())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  const copy = () =>
    void navigator.clipboard.writeText(status.manualCommand).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })

  return (
    <>
      <h3>Command line</h3>
      <div className="field">
        <label>
          <code>karen [path]</code> opens a repository in the running app
        </label>
        <div className="cli-row">
          {status.installed ? (
            <span className="cli-ok">
              <Icon name="check" size={12} /> Installed at <code>{status.linkPath}</code>
            </span>
          ) : (
            <span className="muted">
              Not installed. Links <code>{status.linkPath}</code> to a script in the app's data folder.
            </span>
          )}
          <button className="btn small" disabled={installing} onClick={() => void install()}>
            {installing ? 'Installing…' : status.installed ? 'Reinstall' : 'Install command'}
          </button>
        </div>
        {error && (
          <div className="cli-error">
            <span>{error.split('\n')[0]}</span>
            {error.includes(status.manualCommand) && (
              <div className="cli-cmd">
                <code>{status.manualCommand}</code>
                <button className="btn small" onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
          </div>
        )}
        <span className="hint">
          Links like <code>karen://open?path=/path/to/repo</code> open a repository too (after asking, for folders not opened before).
        </span>
      </div>
    </>
  )
}

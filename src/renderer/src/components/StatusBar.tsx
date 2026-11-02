import type { RepoTab } from '../state/store'
import { useStore } from '../state/store'
import { Icon } from '../ui/Icon'
import { confirm } from '../ui/dialogs'
import { pull, pushCurrent } from '../actions/refActions'
import { shortcutFor } from '../keybindings'
import { COMMANDS } from '@shared/commands'
import { BusyProgress } from '../ui/Progress'
import { downloadProgress, downloadUpdate, restartToUpdate, useUpdate } from '../state/updates'
import '../styles/shell.css'

const OP_LABEL: Record<string, string> = {
  merge: 'Merge in progress',
  rebase: 'Rebase in progress',
  'cherry-pick': 'Cherry pick in progress',
  revert: 'Revert in progress',
  bisect: 'Bisect in progress'
}

export function StatusBar({ repo }: { repo: RepoTab | null }) {
  const run = useStore((s) => s.run)
  const setFuzzyFinder = useStore((s) => s.setFuzzyFinder)
  if (!repo) {
    return (
      <div className="status-bar">
        <span className="muted">Karen</span>
        <span className="sb-spacer" />
        <UpdateIndicator />
      </div>
    )
  }
  const st = repo.status
  const op = st?.operation
  const commitCount = repo.commits.length
  const idle = !repo.busy
  const switcher = shortcutFor(COMMANDS.switchBranch)

  return (
    <div className="status-bar">
      <button className="sb-item sb-link" title={`Switch branch${switcher ? ` (${switcher})` : ''}`} onClick={() => setFuzzyFinder('branches')}>
        <Icon name="branch" size={12} />
        {st?.detached ? `HEAD detached at ${st.headSha?.slice(0, 7)}` : (st?.branch ?? '…')}
      </button>
      {st?.upstream && (
        <span className="sb-item muted" title={`Tracking ${st.upstream}`}>
          <button className="sb-link" disabled={!idle || st.ahead === 0} title={st.ahead ? `Push ${st.ahead} commit${st.ahead === 1 ? '' : 's'}` : 'Nothing to push'} aria-label={`${st.ahead} ahead: push`} onClick={() => void pushCurrent(repo)}>
            ↑{st.ahead}
          </button>
          <button className="sb-link" disabled={!idle || st.behind === 0} title={st.behind ? `Pull ${st.behind} commit${st.behind === 1 ? '' : 's'}` : 'Nothing to pull'} aria-label={`${st.behind} behind: pull`} onClick={() => void pull('ff')}>
            ↓{st.behind}
          </button>
          {st.upstream.replace(/^refs\/remotes\//, '')}
        </span>
      )}
      {st && st.branch && !st.detached && !st.upstream && repo.remotes.length > 0 && (
        <button className="sb-item sb-link muted" disabled={!idle} title="Push this branch and set its upstream" onClick={() => void pushCurrent(repo)}>
          <Icon name="push" size={12} /> Publish branch
        </button>
      )}
      {st && st.conflicted.length > 0 && (
        <span className="sb-item danger">
          <Icon name="warning" size={12} /> {st.conflicted.length} conflicted
        </span>
      )}
      {op && (
        <span className="sb-op">
          <Icon name="warning" size={12} /> {OP_LABEL[op] ?? op}
          {op !== 'bisect' && (
            <>
              <button className="btn small" onClick={() => void run('Continuing', (r) => window.git.continueOperation(r))}>
                Continue
              </button>
              {op === 'rebase' && (
                <button className="btn small" onClick={() => void run('Skipping', (r) => window.git.skipOperation(r))}>
                  Skip
                </button>
              )}
              <button
                className="btn small"
                onClick={async () => {
                  if (await confirm(`Abort ${op}?`, 'Your branch will return to its state before the operation started.', { danger: true, confirmLabel: 'Abort' }))
                    await run('Aborting', (r) => window.git.abortOperation(r))
                }}
              >
                Abort
              </button>
            </>
          )}
        </span>
      )}
      <span className="sb-spacer" />
      <UpdateIndicator />
      {repo.busy && (
        <span className="sb-item">
          <BusyProgress repo={repo.path} busy={repo.busy} />
        </span>
      )}
      <span className="sb-item muted">
        {commitCount} commit{commitCount === 1 ? '' : 's'}
      </span>
      <span className="sb-item muted ellipsis sb-path" title={repo.path}>
        {repo.path}
      </span>
    </div>
  )
}

/** A downloading or downloaded app update (src/renderer/src/state/updates.ts). */
function UpdateIndicator() {
  const s = useUpdate((u) => u.status)
  if (!s?.canInstall || !s.version) return null
  switch (s.phase) {
    case 'downloading':
      return (
        <span className="sb-item muted" title={`Downloading Karen ${s.version}`}>
          <Icon name="fetch" size={12} /> Downloading update {downloadProgress(s)}
        </span>
      )
    case 'ready':
      return (
        <button className="sb-item sb-link sb-update" title={`Karen ${s.version} is downloaded. Restart to install it.`} onClick={() => void restartToUpdate()}>
          <Icon name="refresh" size={12} /> Restart to update
        </button>
      )
    case 'installing':
      return <span className="sb-item muted">Installing Karen {s.version}…</span>
    case 'available':
      return s.error ? (
        <button className="sb-item sb-link danger" title={s.error} onClick={() => void downloadUpdate()}>
          <Icon name="warning" size={12} /> Update download failed: retry
        </button>
      ) : null
    default:
      return null
  }
}

// Catches render errors of one region of the window (a panel, the center view, the modals) so a bug in one place
// shows a notice there instead of blanking the whole window, and what the user typed elsewhere survives.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from './Icon'
import { asError, errorDetails, shouldReset } from './errorBoundaryState'

interface Props {
  /** What failed, for the notice and the copied details, e.g. "The left panel" */
  region: string
  /** The error clears when this changes (another repo, another center view) */
  resetKey?: unknown
  /** Class of the notice's container, so it takes the failed region's place in the layout */
  className?: string
  /** The whole window failed: offer a reload instead of a retry */
  root?: boolean
  /** A button that closes what failed (a dialog), e.g. "Close" */
  dismiss?: { label: string; run(): void }
  children: ReactNode
}

interface State {
  error: Error | null
  componentStack: string | null
  copied: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, copied: false }

  static getDerivedStateFromError(thrown: unknown): Partial<State> {
    return { error: asError(thrown), copied: false }
  }

  componentDidCatch(thrown: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null })
    console.error(`${this.props.region} failed to render`, thrown, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    if (shouldReset(!!this.state.error, prev.resetKey, this.props.resetKey)) this.reset()
  }

  reset = () => this.setState({ error: null, componentStack: null, copied: false })

  copy = () => {
    const { error, componentStack } = this.state
    if (!error) return
    const text = errorDetails(this.props.region, error, componentStack, { platform: window.app?.platform, userAgent: navigator.userAgent })
    void navigator.clipboard.writeText(text).then(() => this.setState({ copied: true }))
  }

  render() {
    const { error, copied } = this.state
    if (!error) return this.props.children
    const { region, root, className, dismiss } = this.props
    return (
      <div className={`error-boundary ${root ? 'root' : ''} ${className ?? ''}`} role="alert">
        <div className="error-boundary-box">
          <div className="error-boundary-title">
            <Icon name="warning" size={16} /> {root ? 'Karen ran into a problem' : `${region} ran into a problem`}
          </div>
          <div className="error-boundary-message mono">{error.message || error.name}</div>
          <div className="muted error-boundary-hint">
            {root ? 'Reloading the window reopens your tabs.' : 'The rest of the window still works. If this keeps happening, copy the details into a bug report.'}
          </div>
          <div className="error-boundary-actions">
            {root ? (
              <button className="btn primary" onClick={() => window.location.reload()}>
                Reload window
              </button>
            ) : (
              <button className="btn primary" onClick={this.reset}>
                Try again
              </button>
            )}
            <button className="btn" onClick={this.copy}>
              {copied ? 'Copied' : 'Copy details'}
            </button>
            {dismiss && (
              <button className="btn" onClick={dismiss.run}>
                {dismiss.label}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }
}

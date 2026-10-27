import { useStore } from '../state/store'
import { Icon } from './Icon'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const buttons = [...(t.action ? [t.action] : []), ...(t.actions ?? [])]
        return (
          // errors are announced right away; the close button gives keyboard users what the click does
          <div key={t.id} data-toast={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'} onClick={() => dismiss(t.id)}>
            <div className="toast-row">
              <div className="toast-title">{t.title}</div>
              {buttons.length === 1 && <ToastButton toastId={t.id} button={buttons[0]} />}
              <button
                className="icon-btn toast-close"
                aria-label="Dismiss notification"
                title="Dismiss"
                onClick={(e) => {
                  e.stopPropagation()
                  dismiss(t.id)
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
            {t.message && <div className="toast-msg">{t.message}</div>}
            {t.detail && <div className="toast-detail mono">{t.detail}</div>}
            {buttons.length > 1 && (
              <div className="toast-actions">
                {buttons.map((b) => (
                  <ToastButton key={b.label} toastId={t.id} button={b} />
                ))}
              </div>
            )}
            {t.action && t.duration && <div className="toast-timer" style={{ animationDuration: `${t.duration}ms` }} />}
          </div>
        )
      })}
    </div>
  )
}

function ToastButton({ toastId, button }: { toastId: number; button: { label: string; run(): void } }) {
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <button
      className="btn small toast-action"
      onClick={(e) => {
        e.stopPropagation()
        dismiss(toastId)
        button.run()
      }}
    >
      {button.label}
    </button>
  )
}

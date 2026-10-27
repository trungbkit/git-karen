import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

interface Props {
  title: ReactNode
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  width?: number
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function Modal({ title, onClose, children, footer, width }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // read while rendering: by the time effects run, an autoFocus field inside already has focus
  const [returnTo] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Move focus into the dialog (unless a field took it with autoFocus) and give it back on close.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (!el.contains(document.activeElement)) {
      // the first text field; without one the confirm button, so Enter answers the dialog; else the first control
      const field = el.querySelector<HTMLElement>('.modal-body :is(input:not([type="checkbox"]):not([type="radio"]), select, textarea):not(:disabled)')
      const primary = [...el.querySelectorAll<HTMLElement>('.modal-footer :is(.btn.primary, .btn.danger):not(:disabled)')].pop()
      const first = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].find((x) => !x.closest('.modal-header'))
      ;(field ?? primary ?? first ?? el).focus()
    }
    return () => {
      if (returnTo?.isConnected) returnTo.focus()
    }
  }, [returnTo])

  // Tab and Shift+Tab cycle inside the dialog
  const trapTab = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null)
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} style={width ? { width } : undefined} onKeyDown={trapTab}>
        <div className="modal-header">
          <span id={titleId}>{title}</span>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

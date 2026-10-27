import { useEffect, useLayoutEffect, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import '../styles/terminal.css'
import { COMMANDS } from '@shared/commands'
import { useStore, type RepoTab } from '../state/store'
import {
  attachSession,
  clearSession,
  closeSession,
  fitSession,
  focusSession,
  newSession,
  setActiveSession,
  setTerminalFontSize,
  setTerminalHeight,
  toggleTerminal,
  useTerminals
} from '../state/terminals'
import { Icon } from '../ui/Icon'
import { shortcutFor } from '../keybindings'

const MIN_HEIGHT = 100

export function TerminalPanel({ repo }: { repo: RepoTab }) {
  const height = useTerminals((s) => s.height)
  const all = useTerminals((s) => s.sessions)
  const activeKey = useTerminals((s) => s.active[repo.path])
  const fontSize = useStore((s) => s.prefs.fontSize)
  const sessions = all.filter((m) => m.repo === repo.path)
  const body = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => setTerminalFontSize(fontSize), [fontSize])

  // Mount the active session's xterm into the body and give it focus.
  useLayoutEffect(() => {
    if (!activeKey || !body.current) return
    attachSession(activeKey, body.current)
    focusSession(activeKey)
  }, [activeKey])

  // Refit whenever the panel (or window) changes size.
  useEffect(() => {
    const el = body.current
    if (!el || !activeKey) return
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => fitSession(activeKey))
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [activeKey])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = height
    const max = Math.max(MIN_HEIGHT, (panel.current?.parentElement?.clientHeight ?? 600) - 120)
    const move = (ev: MouseEvent) => setTerminalHeight(Math.min(max, Math.max(MIN_HEIGHT, startH + startY - ev.clientY)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing-row')
    }
    document.body.classList.add('resizing-row')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  if (!activeKey) return null

  return (
    <div className="term-panel" ref={panel} style={{ height }}>
      <div className="term-resize" onMouseDown={startResize} />
      <div className="term-header">
        <div className="term-tabs">
          {sessions.map((m) => (
            <div
              key={m.key}
              className={`term-tab ${m.key === activeKey ? 'active' : ''} ${m.exited ? 'exited' : ''}`}
              title={m.title}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeSession(m.key)
                }
              }}
              onClick={() => {
                setActiveSession(repo.path, m.key)
                focusSession(m.key)
              }}
            >
              <Icon name="terminal" size={12} />
              <span className="ellipsis">{m.title}</span>
              <button
                className="term-tab-close"
                title="Close terminal" aria-label="Close terminal"
                onClick={(e) => {
                  e.stopPropagation()
                  closeSession(m.key)
                }}
              >
                <Icon name="x" size={10} />
              </button>
            </div>
          ))}
          <button className="icon-btn term-btn" title={`New terminal (${shortcutFor(COMMANDS.newTerminal) ?? ''})`} aria-label={`New terminal (${shortcutFor(COMMANDS.newTerminal) ?? ''})`} onClick={() => newSession(repo.path)}>
            <Icon name="plus" size={13} />
          </button>
        </div>
        <div className="term-actions">
          <button className="icon-btn term-btn" title="Clear" aria-label="Clear" onClick={() => clearSession(activeKey)}>
            <Icon name="trash" size={13} />
          </button>
          <button className="icon-btn term-btn" title="Open external terminal" aria-label="Open external terminal" onClick={() => void window.app.openTerminal(repo.path)}>
            <Icon name="external" size={13} />
          </button>
          <button className="icon-btn term-btn" title={`Hide terminal (${shortcutFor(COMMANDS.toggleTerminal) ?? ''})`} aria-label={`Hide terminal (${shortcutFor(COMMANDS.toggleTerminal) ?? ''})`} onClick={() => toggleTerminal(repo.path, false)}>
            <Icon name="chevron-down" size={13} />
          </button>
        </div>
      </div>
      <div className="term-body" ref={body} />
    </div>
  )
}

// Built-in terminal sessions. xterm instances live outside React (they must survive tab switches and
// re-renders); the zustand store only holds the metadata the panel renders.
import { create } from 'zustand'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { terminalCommand } from '../keybindings'

export interface TermMeta {
  key: string
  repo: string
  title: string
  exited: boolean
}

interface Session {
  meta: TermMeta
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  ptyId: string | null
  opened: boolean
  /** Keystrokes typed before the pty finished spawning */
  pending: string
}

interface TerminalsState {
  visible: boolean
  height: number
  sessions: TermMeta[]
  /** Active session key per repo */
  active: Record<string, string>
}

const HEIGHT_KEY = 'kc.terminalHeight'

function readHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY))
    return v >= 100 ? v : 260
  } catch {
    return 260
  }
}

export const useTerminals = create<TerminalsState>(() => ({
  visible: false,
  height: readHeight(),
  sessions: [],
  active: {}
}))

const sessions = new Map<string, Session>()
const byPty = new Map<string, Session>()
let seq = 0
let fontSize = 13
let listening = false

function cssVar(style: CSSStyleDeclaration, name: string): string | undefined {
  const v = style.getPropertyValue(name).trim()
  return v || undefined
}

/** xterm theme built from the --term-* tokens in theme.css (re-read on theme switch). */
export function terminalTheme(): ITheme {
  const s = getComputedStyle(document.documentElement)
  const c = (n: string) => cssVar(s, `--term-${n}`)
  return {
    background: c('bg'),
    foreground: c('fg'),
    cursor: c('cursor'),
    cursorAccent: c('bg'),
    selectionBackground: c('selection'),
    black: c('black'),
    red: c('red'),
    green: c('green'),
    yellow: c('yellow'),
    blue: c('blue'),
    magenta: c('magenta'),
    cyan: c('cyan'),
    white: c('white'),
    brightBlack: c('bright-black'),
    brightRed: c('bright-red'),
    brightGreen: c('bright-green'),
    brightYellow: c('bright-yellow'),
    brightBlue: c('bright-blue'),
    brightMagenta: c('bright-magenta'),
    brightCyan: c('bright-cyan'),
    brightWhite: c('bright-white')
  }
}

function fontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'
}

function listen() {
  if (listening) return
  listening = true
  window.term.onData((id, data) => byPty.get(id)?.term.write(data))
  window.term.onExit((id, code) => {
    const s = byPty.get(id)
    if (!s) return
    byPty.delete(id)
    s.ptyId = null
    s.term.write(`\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m\r\n`)
    updateMeta(s.meta.key, { exited: true })
  })
  // Follow theme and accent colour switches (the accent is an inline style on <html>).
  new MutationObserver(() => {
    const theme = terminalTheme()
    for (const s of sessions.values()) s.term.options.theme = theme
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
}

function updateMeta(key: string, patch: Partial<TermMeta>) {
  useTerminals.setState((st) => ({ sessions: st.sessions.map((m) => (m.key === key ? { ...m, ...patch } : m)) }))
}

function shellName(): string {
  return window.app.platform === 'win32' ? 'powershell' : 'shell'
}

/** Create a session for `repo` (its pty spawns when the session is first shown) and make it active. */
export function newSession(repo: string): string {
  listen()
  const key = `t${++seq}`
  const term = new Terminal({
    fontFamily: fontFamily(),
    fontSize,
    cursorBlink: true,
    scrollback: 5000,
    macOptionIsMeta: true,
    allowProposedApi: true,
    theme: terminalTheme()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon((_e, uri) => void window.app.openExternal(uri).catch(() => undefined)))
  const el = document.createElement('div')
  el.className = 'term-host'
  const meta: TermMeta = { key, repo, title: shellName(), exited: false }
  const session: Session = { meta, term, fit, el, ptyId: null, opened: false, pending: '' }
  sessions.set(key, session)

  // Keep app-level toggles and tab switching working while the terminal has focus.
  term.attachCustomKeyEventHandler((e) => !terminalCommand(e))
  term.onData((data) => {
    if (session.ptyId) void window.term.write(session.ptyId, data)
    else if (!meta.exited) session.pending += data
  })
  term.onResize(({ cols, rows }) => {
    if (session.ptyId) void window.term.resize(session.ptyId, cols, rows)
  })
  term.onTitleChange((title) => title && updateMeta(key, { title }))

  useTerminals.setState((st) => ({ sessions: [...st.sessions, meta], active: { ...st.active, [repo]: key } }))
  return key
}

/** Mount the session's element into `container` (spawning the pty on first mount) and fit it. */
export function attachSession(key: string, container: HTMLElement) {
  const s = sessions.get(key)
  if (!s) return
  if (s.el.parentElement !== container) {
    container.replaceChildren(s.el)
  }
  if (!s.opened) {
    s.opened = true
    s.term.open(s.el)
    fitSession(key)
    void spawn(s)
  } else {
    fitSession(key)
    s.term.refresh(0, s.term.rows - 1)
  }
}

async function spawn(s: Session) {
  try {
    const id = await window.term.create(s.meta.repo, s.term.cols, s.term.rows)
    if (!sessions.has(s.meta.key)) {
      // closed while spawning
      void window.term.kill(id)
      return
    }
    s.ptyId = id
    byPty.set(id, s)
    if (s.pending) {
      void window.term.write(id, s.pending)
      s.pending = ''
    }
  } catch (e) {
    s.term.write(`\x1b[31mFailed to start shell: ${(e as Error).message}\x1b[0m\r\n`)
    updateMeta(s.meta.key, { exited: true })
  }
}

export function fitSession(key: string) {
  const s = sessions.get(key)
  if (!s?.opened || !s.el.isConnected || s.el.clientWidth === 0) return
  try {
    s.fit.fit()
  } catch {
    // not measurable yet
  }
}

export function focusSession(key: string | undefined) {
  if (key) sessions.get(key)?.term.focus()
}

export function clearSession(key: string) {
  sessions.get(key)?.term.clear()
}

export function setActiveSession(repo: string, key: string) {
  useTerminals.setState((st) => ({ active: { ...st.active, [repo]: key } }))
}

export function closeSession(key: string, opts: { keepPanel?: boolean } = {}) {
  const s = sessions.get(key)
  if (!s) return
  sessions.delete(key)
  if (s.ptyId) {
    byPty.delete(s.ptyId)
    void window.term.kill(s.ptyId)
  }
  s.term.dispose()
  s.el.remove()
  useTerminals.setState((st) => {
    const remaining = st.sessions.filter((m) => m.key !== key)
    const active = { ...st.active }
    if (active[s.meta.repo] === key) {
      const sibling = remaining.filter((m) => m.repo === s.meta.repo).pop()
      if (sibling) active[s.meta.repo] = sibling.key
      else delete active[s.meta.repo]
    }
    // Closing the last session of the visible repo hides the panel.
    const hide = !opts.keepPanel && !remaining.some((m) => m.repo === s.meta.repo)
    return { sessions: remaining, active, visible: hide ? false : st.visible }
  })
}

/** Kill every session of a repo (its tab was closed). */
export function closeRepoSessions(repo: string) {
  for (const m of useTerminals.getState().sessions) if (m.repo === repo) closeSession(m.key, { keepPanel: true })
}

/** Show/hide the panel; showing a repo without sessions creates one. */
export function toggleTerminal(repo: string | null, show?: boolean) {
  const st = useTerminals.getState()
  // A repo without sessions has nothing to show, so "toggle" means open there.
  const next = show ?? !(st.visible && (!repo || st.active[repo]))
  if (next && repo && !st.active[repo]) newSession(repo)
  useTerminals.setState({ visible: next })
  if (!next && document.activeElement?.closest('.term-panel')) (document.activeElement as HTMLElement).blur()
}

export function setTerminalHeight(height: number) {
  useTerminals.setState({ height })
  try {
    localStorage.setItem(HEIGHT_KEY, String(Math.round(height)))
  } catch {
    // storage unavailable: height just won't persist
  }
}

export function setTerminalFontSize(size: number) {
  fontSize = size
  for (const [key, s] of sessions) {
    s.term.options.fontSize = size
    fitSession(key)
  }
}

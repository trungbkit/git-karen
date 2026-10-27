// Global keyboard shortcuts and command dispatch (menu commands arrive through the same path).
import { useEffect } from 'react'
import { COMMANDS } from '@shared/commands'
import { isSpecialTab, useStore, WELCOME_TAB } from './state/store'
import { fetchAll, pull, pushCurrent, createBranchAt, stashChanges, popStash, currentBranch } from './actions/refActions'
import { defaultBranch, openCompare } from './actions/compareActions'
import { focusGraphFilter, moveGraphSelection } from './graph/nav'
import { newSession, toggleTerminal } from './state/terminals'
import { undoLatest } from './actions/undo'

export interface KeyBinding {
  /** e.g. "mod+shift+p"; mod = Cmd on macOS, Ctrl elsewhere */
  keys: string
  command: string
  description: string
}

export const KEYBINDINGS: KeyBinding[] = [
  { keys: 'mod+p', command: COMMANDS.toggleFuzzyFinder, description: 'Open command palette' },
  { keys: 'mod+shift+o', command: COMMANDS.fuzzyOpenRepo, description: 'Open a recent repository' },
  { keys: 'mod+shift+h', command: COMMANDS.fuzzyHistory, description: 'View file history' },
  { keys: 'mod+f', command: COMMANDS.searchCommits, description: 'Search commits' },
  { keys: 'mod+b', command: COMMANDS.createBranch, description: 'Create branch' },
  { keys: 'mod+shift+b', command: COMMANDS.switchBranch, description: 'Switch branch' },
  { keys: 'mod+l', command: COMMANDS.fetch, description: 'Fetch all remotes' },
  { keys: 'mod+shift+l', command: COMMANDS.pull, description: 'Pull' },
  { keys: 'mod+shift+k', command: COMMANDS.push, description: 'Push' },
  { keys: 'mod+shift+s', command: COMMANDS.stageAll, description: 'Stage all changes' },
  { keys: 'mod+shift+u', command: COMMANDS.unstageAll, description: 'Unstage all changes' },
  { keys: 'mod+shift+f', command: COMMANDS.focusChangedFiles, description: 'Focus changed files (Enter stages / unstages)' },
  { keys: 'mod+shift+m', command: COMMANDS.focusCommitMessage, description: 'Focus commit message' },
  { keys: 'mod+j', command: COMMANDS.toggleLeftPanel, description: 'Toggle left panel' },
  { keys: 'mod+k', command: COMMANDS.toggleDetailPanel, description: 'Toggle detail panel' },
  { keys: 'ctrl+`', command: COMMANDS.toggleTerminal, description: 'Toggle terminal' },
  { keys: 'ctrl+shift+`', command: COMMANDS.newTerminal, description: 'New terminal' },
  { keys: 'mod+/', command: COMMANDS.toggleKeyBindings, description: 'Show keyboard shortcuts' },
  { keys: 'mod+shift+n', command: COMMANDS.focusNotification, description: 'Focus the latest notification (Undo, error fixes)' },
  { keys: 'mod+t', command: COMMANDS.newTab, description: 'New tab' },
  { keys: 'mod+w', command: COMMANDS.closeTab, description: 'Close tab' },
  { keys: 'mod+shift+t', command: COMMANDS.reopenTab, description: 'Reopen closed tab' },
  { keys: 'ctrl+tab', command: COMMANDS.nextTab, description: 'Next tab' },
  { keys: 'ctrl+shift+tab', command: COMMANDS.prevTab, description: 'Previous tab' },
  { keys: 'mod+o', command: COMMANDS.openRepo, description: 'Open repository' },
  { keys: 'mod+,', command: COMMANDS.preferences, description: 'Preferences' },
  { keys: 'mod+r', command: COMMANDS.refresh, description: 'Refresh' },
  { keys: 'escape', command: COMMANDS.closeView, description: 'Close current view' },
  { keys: 'up', command: 'select:previous', description: 'Select previous commit' },
  { keys: 'k', command: 'select:previous', description: 'Select previous commit' },
  { keys: 'down', command: 'select:next', description: 'Select next commit' },
  { keys: 'j', command: 'select:next', description: 'Select next commit' },
  ...Array.from({ length: 9 }, (_, i) => ({ keys: `mod+${i + 1}`, command: `tab:select${i + 1}`, description: `Go to tab ${i + 1}` }))
]

/** Shortcuts of the diff view (handled there, through diffCommandFor). Staging ones act on working-copy diffs. */
export const DIFF_KEYBINDINGS: KeyBinding[] = [
  { keys: 's', command: 'diff:stage', description: 'Stage the selected lines or the focused hunk' },
  { keys: 'u', command: 'diff:unstage', description: 'Unstage the selected lines or the focused hunk' },
  { keys: 'd', command: 'diff:discard', description: 'Discard the selected lines or the focused hunk' },
  { keys: 'shift+d', command: 'diff:discardNow', description: 'Discard without confirmation (undo from the toast)' },
  { keys: 'enter', command: 'diff:toggleHunk', description: 'Stage or unstage the focused hunk' },
  { keys: 'e', command: 'diff:editHunk', description: 'Edit the focused hunk before staging it' },
  { keys: ']', command: 'diff:nextHunk', description: 'Next hunk' },
  { keys: '[', command: 'diff:prevHunk', description: 'Previous hunk' },
  { keys: 'alt+down', command: 'diff:nextFile', description: 'Next file' },
  { keys: 'alt+up', command: 'diff:prevFile', description: 'Previous file' }
]

const closedTabs: string[] = []

/** Close a tab, remembering it so it can be reopened. */
export function closeTabRemembered(path: string) {
  if (!isSpecialTab(path)) closedTabs.push(path)
  useStore.getState().closeTab(path)
}

function cycleTab(delta: number) {
  const { tabs, activeTab, setActiveTab } = useStore.getState()
  if (tabs.length < 2) return
  const i = tabs.indexOf(activeTab)
  setActiveTab(tabs[(i + delta + tabs.length) % tabs.length])
}

export function newTab() {
  const { tabs } = useStore.getState()
  useStore.setState({ tabs: tabs.includes(WELCOME_TAB) ? tabs : [...tabs, WELCOME_TAB], activeTab: WELCOME_TAB })
}

export async function openRepoDialog() {
  const path = await window.app.pickDirectory('Open repository')
  if (path) await useStore.getState().openRepo(path).catch(() => undefined)
}

/** Execute a command id from the menu, the palette or a shortcut. */
export function dispatch(command: string): void {
  const s = useStore.getState()
  const repo = s.repos[s.activeTab] ?? null
  const run = s.run

  if (command.startsWith('tab:select')) {
    const n = Number(command.slice('tab:select'.length))
    const tab = s.tabs[n === 9 ? s.tabs.length - 1 : n - 1]
    if (tab) s.setActiveTab(tab)
    return
  }

  switch (command) {
    case COMMANDS.newTab:
      return newTab()
    case COMMANDS.closeTab:
      return closeTabRemembered(s.activeTab)
    case COMMANDS.nextTab:
      return cycleTab(1)
    case COMMANDS.prevTab:
      return cycleTab(-1)
    case COMMANDS.reopenTab: {
      const path = closedTabs.pop()
      if (path) void s.openRepo(path).catch(() => undefined)
      return
    }
    case COMMANDS.openRepo:
      return void openRepoDialog()
    case COMMANDS.cloneRepo:
      return s.setModal({ kind: 'clone' })
    case COMMANDS.initRepo:
      return s.setModal({ kind: 'init' })
    case COMMANDS.toggleFuzzyFinder:
      return s.setFuzzyFinder(s.fuzzyFinder === 'commands' ? null : 'commands')
    case COMMANDS.fuzzyOpenRepo:
      return s.setFuzzyFinder(s.fuzzyFinder === 'repos' ? null : 'repos')
    case COMMANDS.fuzzyHistory:
      if (repo) s.setFuzzyFinder(s.fuzzyFinder === 'history' ? null : 'history')
      return
    case COMMANDS.switchBranch:
      if (repo) s.setFuzzyFinder(s.fuzzyFinder === 'branches' ? null : 'branches')
      return
    case COMMANDS.openWorkspace:
      return s.openWorkspaceTab()
    case COMMANDS.toggleLeftPanel:
      return s.toggleLeftPanel()
    case COMMANDS.toggleDetailPanel:
      return s.toggleDetailPanel()
    case COMMANDS.toggleKeyBindings:
      return s.setModal(s.modal?.kind === 'keybindings' ? null : { kind: 'keybindings' })
    case COMMANDS.preferences:
      return s.setModal({ kind: 'preferences' })
    case COMMANDS.focusNotification: {
      // its first button (Undo, a fix for an error), else its close button
      const toasts = document.querySelectorAll<HTMLElement>('.toast')
      toasts[toasts.length - 1]?.querySelector<HTMLElement>('.toast-action, .toast-close')?.focus()
      return
    }
    case COMMANDS.closeView:
      if (s.fuzzyFinder) return s.setFuzzyFinder(null)
      if (repo && repo.center.kind !== 'graph') return s.setCenter({ kind: 'graph' })
      return
    case 'select:next':
      return moveGraphSelection(1)
    case 'select:previous':
      return moveGraphSelection(-1)
  }

  if (!repo) return
  switch (command) {
    case COMMANDS.refresh:
      return void s.refresh(repo.path, { log: true })
    case COMMANDS.fetch:
      return void fetchAll()
    case COMMANDS.pull:
      return void pull('ff')
    case COMMANDS.pullRebase:
      return void pull('rebase')
    case COMMANDS.push:
      return void pushCurrent(repo)
    case COMMANDS.createBranch:
      return void createBranchAt()
    case COMMANDS.stash:
      return void stashChanges()
    case COMMANDS.popStash:
      if (repo.stashes.length) void popStash(0)
      return
    case COMMANDS.undo:
      return undoLatest()
    case COMMANDS.showReflog:
      return s.setCenter(repo.center.kind === 'reflog' ? { kind: 'graph' } : { kind: 'reflog' })
    case COMMANDS.compareWithDefault: {
      const def = defaultBranch(repo)
      const current = currentBranch(repo) ?? repo.status?.headSha ?? null
      if (!def || !current) return s.toast({ kind: 'info', title: 'No default branch found', message: 'Compare from a branch menu instead.' })
      if (def === current) return s.toast({ kind: 'info', title: `${current} is the default branch` })
      return openCompare(def, current)
    }
    case COMMANDS.stageAll:
      return void run('Staging', (r) => window.git.stageAll(r), { log: false })
    case COMMANDS.unstageAll:
      return void run('Unstaging', (r) => window.git.unstageAll(r), { log: false })
    case COMMANDS.openInEditor:
      return void window.app.openInEditor(repo.path)
    case COMMANDS.openTerminal:
      return void window.app.openTerminal(repo.path)
    case COMMANDS.toggleTerminal:
      if (!s.prefs.useInAppTerminal) return void window.app.openTerminal(repo.path)
      return toggleTerminal(repo.path)
    case COMMANDS.newTerminal:
      if (!s.prefs.useInAppTerminal) return void window.app.openTerminal(repo.path)
      newSession(repo.path)
      return toggleTerminal(repo.path, true)
    case COMMANDS.showInFolder:
      return void window.app.showInFolder(repo.path)
    case COMMANDS.searchCommits:
      if (repo.center.kind !== 'graph') s.setCenter({ kind: 'graph' })
      setTimeout(focusGraphFilter, 0)
      return
    case COMMANDS.focusCommitMessage:
    case COMMANDS.focusChangedFiles:
    case COMMANDS.generateCommitMessage: {
      s.select({ kind: 'wip' })
      if (!s.showDetailPanel) s.toggleDetailPanel()
      const event =
        command === COMMANDS.focusCommitMessage ? 'kc:focusCommitMessage' : command === COMMANDS.focusChangedFiles ? 'kc:focusChangedFiles' : 'kc:generateCommitMessage'
      setTimeout(() => window.dispatchEvent(new CustomEvent(event)), 0)
      return
    }
    case COMMANDS.smartCommit:
      return s.setModal({ kind: 'smartCommit' })
    case COMMANDS.splitCommit:
      return s.setModal({ kind: 'splitCommit' })
    case COMMANDS.createPullRequest:
      return s.setModal({ kind: 'createPullRequest' })
  }
}

const isMac = () => window.app?.platform === 'darwin'

const CODE_KEYS: Record<string, string> = {
  Slash: '/',
  Comma: ',',
  Period: '.',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Tab: 'tab',
  Escape: 'escape',
  Enter: 'enter',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Space: 'space',
  Backquote: '`'
}

/** Normalise a keyboard event into the binding notation (e.g. "mod+shift+p"). */
export function eventToKeys(e: KeyboardEvent, mac = isMac()): string | null {
  let key: string | undefined
  if (e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase()
  else if (e.code.startsWith('Digit')) key = e.code.slice(5)
  else key = CODE_KEYS[e.code]
  if (!key) return null
  const parts: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) parts.push('mod')
  if (mac && e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

function normaliseBinding(keys: string, mac: boolean): string {
  // On Windows/Linux Ctrl *is* mod, so "ctrl+tab" becomes "mod+tab".
  const parts = keys.split('+').map((p) => (!mac && p === 'ctrl' ? 'mod' : p))
  const order = ['mod', 'ctrl', 'alt', 'shift']
  const mods = order.filter((m) => parts.includes(m))
  const key = parts.filter((p) => !order.includes(p))
  return [...mods, ...key].join('+')
}

/** Human readable shortcut label for display (⌘⇧P on macOS, Ctrl+Shift+P elsewhere). */
export function formatKeys(keys: string, mac = isMac()): string {
  const parts = normaliseBinding(keys, mac).split('+')
  if (mac) {
    const sym: Record<string, string> = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧', up: '↑', down: '↓', escape: 'Esc', tab: '⇥', enter: '↩' }
    return parts.map((p) => sym[p] ?? p.toUpperCase()).join('')
  }
  const names: Record<string, string> = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift', up: '↑', down: '↓', escape: 'Esc', tab: 'Tab', enter: 'Enter' }
  return parts.map((p) => names[p] ?? p.toUpperCase()).join('+')
}

export function shortcutFor(command: string): string | undefined {
  const b = KEYBINDINGS.find((k) => k.command === command)
  return b ? formatKeys(b.keys) : undefined
}

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
}

// Shortcuts the text field should keep for itself.
const TEXT_EDITING = new Set(['mod+a', 'mod+c', 'mod+v', 'mod+x', 'mod+z', 'mod+shift+z', 'mod+y', 'mod+enter', 'mod+shift+enter'])

// Commands that still work while the built-in terminal has focus; everything else goes to the shell.
const TERMINAL_COMMANDS = new Set<string>([COMMANDS.toggleTerminal, COMMANDS.newTerminal, COMMANDS.nextTab, COMMANDS.prevTab])

let bindingTable: Map<string, string> | null = null

function commandFor(keys: string, mac = isMac()): string | undefined {
  if (!bindingTable) {
    bindingTable = new Map()
    for (const b of KEYBINDINGS) bindingTable.set(normaliseBinding(b.keys, mac), b.command)
  }
  return bindingTable.get(keys)
}

let diffTable: Map<string, string> | null = null

/**
 * The diff-view command a key event triggers, if any. Nothing fires while typing, in the terminal, under a dialog or
 * the palette, or on Enter while a button has focus (Enter clicks it).
 */
export function diffCommandFor(e: KeyboardEvent, mac = isMac()): string | undefined {
  if (e.defaultPrevented) return undefined
  const keys = eventToKeys(e, mac)
  if (!keys) return undefined
  const active = document.activeElement
  if (isEditable(active) || active?.closest('.term-panel') || document.querySelector('.modal-overlay') || useStore.getState().fuzzyFinder) return undefined
  if (keys === 'enter' && active?.closest('button, a, select, [role="button"]')) return undefined
  if (!diffTable) {
    diffTable = new Map()
    for (const b of DIFF_KEYBINDINGS) diffTable.set(normaliseBinding(b.keys, mac), b.command)
  }
  return diffTable.get(keys)
}

/** The app command a key event triggers even when the terminal has focus, if any. */
export function terminalCommand(e: KeyboardEvent): string | undefined {
  const keys = eventToKeys(e)
  const command = keys ? commandFor(keys) : undefined
  return command && (TERMINAL_COMMANDS.has(command) || command.startsWith('tab:select')) ? command : undefined
}

export function useKeybindings() {
  useEffect(() => {
    const mac = isMac()

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const keys = eventToKeys(e, mac)
      if (!keys) return
      const state = useStore.getState()
      // The built-in terminal owns the keyboard (Escape, arrows, ctrl+…); only its toggles and tab switching get through.
      if (document.activeElement?.closest('.term-panel')) {
        const command = terminalCommand(e)
        if (!command) return
        e.preventDefault()
        dispatch(command)
        return
      }
      if (isEditable(document.activeElement)) {
        if (keys === 'escape') {
          ;(document.activeElement as HTMLElement).blur()
          return
        }
        if (!keys.startsWith('mod+') || TEXT_EDITING.has(keys)) return
      }
      // Leave dialogs (store modals and imperative prompts) and the palette to handle their own keys.
      if (document.querySelector('.modal-overlay') && keys !== 'mod+/') return
      if (state.fuzzyFinder && keys !== 'escape' && !keys.startsWith('mod+')) return
      const command = commandFor(keys, mac)
      if (!command) return
      e.preventDefault()
      dispatch(command)
    }
    window.addEventListener('keydown', onKey)
    const off = window.app.onCommand((command) => dispatch(command))
    return () => {
      window.removeEventListener('keydown', onKey)
      off()
    }
  }, [])
}

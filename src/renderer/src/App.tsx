import { useEffect, type CSSProperties } from 'react'
import { useActiveRepo, useStore, WORKSPACE_TAB } from './state/store'
import { TabsBar } from './components/TabsBar'
import { Toolbar } from './components/Toolbar'
import { LeftPanel } from './components/LeftPanel'
import { RightPanel } from './components/RightPanel'
import { StatusBar } from './components/StatusBar'
import { Welcome } from './components/Welcome'
import { Graph } from './graph/Graph'
import { DiffView } from './components/DiffView'
import { ConflictView } from './components/ConflictView'
import { RebasePanel } from './components/RebasePanel'
import { FileHistoryView } from './components/FileHistoryView'
import { ReflogView } from './components/ReflogView'
import { CompareView } from './components/CompareView'
import { AiReportView } from './components/AiReportView'
import { TerminalPanel } from './components/TerminalPanel'
import { useTerminals } from './state/terminals'
import { FuzzyFinder } from './components/FuzzyFinder'
import { Modals } from './components/Modals'
import { useKeybindings } from './keybindings'
import { useAutoFetch } from './state/autoFetch'
import { Toasts } from './ui/Toasts'
import { DialogHost } from './ui/dialogs'
import { ContextMenuHost } from './ui/ContextMenu'
import { Splitter } from './ui/Splitter'
import { DEFAULT_PREFERENCES } from '@shared/types'
import { WorkspaceView } from './components/WorkspaceView'
import { useFileDragHint, useOpenRequests } from './actions/openActions'
import { applyAppearance } from './ui/appearance'
// installs the explained git error toasts (with fixes) into the store's `run`
import './actions/errorActions'
import { useProgressEvents } from './state/progress'

export function App() {
  const init = useStore((s) => s.init)
  const ready = useStore((s) => s.ready)
  const theme = useStore((s) => s.prefs.theme)
  const accentColor = useStore((s) => s.prefs.accentColor)
  const density = useStore((s) => s.prefs.density)
  const fontSize = useStore((s) => s.prefs.fontSize)
  const showLeft = useStore((s) => s.showLeftPanel)
  const showRight = useStore((s) => s.showDetailPanel)
  const leftWidth = useStore((s) => s.prefs.leftPanelWidth)
  const rightWidth = useStore((s) => s.prefs.rightPanelWidth)
  const setPrefs = useStore((s) => s.setPrefs)
  const repo = useActiveRepo()
  const showTerminal = useTerminals((s) => s.visible)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    // 'system' follows the OS setting live: the media query fires when it changes
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => applyAppearance({ theme, accentColor, density }, mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme, accentColor, density])

  useEffect(() => {
    document.documentElement.style.setProperty('--font-size', `${fontSize}px`)
  }, [fontSize])

  useKeybindings()
  useAutoFetch()
  useOpenRequests()
  useProgressEvents()
  const draggingFiles = useFileDragHint()
  const workspaceTab = useStore((s) => s.activeTab === WORKSPACE_TAB)

  if (!ready) return null

  return (
    <div className="app">
      <TabsBar />
      {repo ? (
        <>
          <Toolbar repo={repo} />
          <div className="app-body" style={{ '--left-w': `${leftWidth}px`, '--right-w': `${rightWidth}px` } as CSSProperties}>
            {showLeft && <LeftPanel repo={repo} />}
            {showLeft && (
              <Splitter
                side="left"
                cssVar="--left-w"
                width={leftWidth}
                min={180}
                defaultWidth={DEFAULT_PREFERENCES.leftPanelWidth}
                onCommit={(w) => void setPrefs({ leftPanelWidth: w })}
              />
            )}
            <div className="center">
              {repo.center.kind === 'graph' && <Graph repo={repo} />}
              {repo.center.kind === 'diff' && <DiffView repo={repo} target={repo.center.target} cwd={repo.center.cwd} />}
              {repo.center.kind === 'conflict' && <ConflictView repo={repo} path={repo.center.path} />}
              {repo.center.kind === 'rebase' && <RebasePanel repo={repo} onto={repo.center.onto} shas={repo.center.shas} />}
              {repo.center.kind === 'history' && <FileHistoryView repo={repo} path={repo.center.path} blame={repo.center.blame} />}
              {repo.center.kind === 'reflog' && <ReflogView repo={repo} />}
              {repo.center.kind === 'compare' && <CompareView repo={repo} from={repo.center.from} to={repo.center.to} />}
              {repo.center.kind === 'ai' && <AiReportView repo={repo} task={repo.center.task} />}
              {showTerminal && <TerminalPanel key={repo.path} repo={repo} />}
            </div>
            {showRight && (
              <Splitter
                side="right"
                cssVar="--right-w"
                width={rightWidth}
                min={280}
                defaultWidth={DEFAULT_PREFERENCES.rightPanelWidth}
                onCommit={(w) => void setPrefs({ rightPanelWidth: w })}
              />
            )}
            {showRight && <RightPanel repo={repo} />}
          </div>
        </>
      ) : workspaceTab ? (
        <WorkspaceView />
      ) : (
        <Welcome />
      )}
      <StatusBar repo={repo} />
      <FuzzyFinder />
      <Modals />
      <DialogHost />
      <ContextMenuHost />
      <Toasts />
      {draggingFiles && (
        <div className="drop-hint">
          <span>Drop a folder or file to open its repository</span>
        </div>
      )}
    </div>
  )
}

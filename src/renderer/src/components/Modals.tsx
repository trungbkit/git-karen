import { useStore } from '../state/store'
import { CloneModal, InitModal } from './CloneInitModals'
import { PreferencesModal } from './PreferencesModal'
import { GitflowModal } from './GitflowModal'
import { LfsModal } from './LfsModal'
import { KeybindingsModal } from './KeybindingsModal'
import { WorktreeModal } from './WorktreeModal'
import { SmartCommitModal, SplitCommitModal } from './SmartCommitModal'
import { CreatePullRequestModal } from './CreatePullRequestModal'

export function Modals() {
  const modal = useStore((s) => s.modal)
  switch (modal?.kind) {
    case 'preferences':
      return <PreferencesModal />
    case 'clone':
      return <CloneModal />
    case 'init':
      return <InitModal />
    case 'gitflow':
      return <GitflowModal />
    case 'lfs':
      return <LfsModal />
    case 'keybindings':
      return <KeybindingsModal />
    case 'worktree':
      return <WorktreeModal />
    case 'smartCommit':
      return <SmartCommitModal />
    case 'splitCommit':
      return <SplitCommitModal />
    case 'createPullRequest':
      return <CreatePullRequestModal />
    default:
      return null
  }
}

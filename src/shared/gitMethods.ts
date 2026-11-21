// The allowlist of git methods the renderer may call. Shared so the IPC contract test can compare it with the
// Rust dispatcher (GitService::call in src-tauri/src/git/service.rs) without loading the Tauri bridge.
import type { GitApi } from './types'

/** Every GitApi method; typed as a Record so adding a method to the contract fails compilation until listed here. */
export const GIT_METHODS: Record<keyof GitApi, true> = {
  open: true, init: true, clone: true, log: true, refs: true, stashes: true, remotes: true, submodules: true,
  worktrees: true, status: true, commitDetail: true, compareCommits: true, diff: true, fileContent: true, blame: true, fileHistory: true,
  imageBlob: true,
  searchCommits: true, searchLog: true, repoSummary: true, commitStats: true, conflict: true, stage: true, unstage: true, stageAll: true,
  unstageAll: true, discard: true, applyPatch: true, resolveConflict: true, takeSide: true, ignore: true,
  commit: true, headMessage: true, commitTemplate: true, recentAuthors: true, testSigning: true, signatureStatus: true,
  headDiff: true, unsetConfig: true, createBranch: true, deleteBranch: true, deleteRemoteBranch: true,
  mergedBranches: true, checkSquashMerged: true, deleteBranches: true, deleteRemoteBranches: true,
  renameBranch: true, checkout: true, checkoutRemote: true, setUpstream: true, createTag: true, deleteTag: true,
  pushTag: true, deleteRemoteTag: true, merge: true, rebase: true, interactiveRebase: true, cherryPick: true,
  revert: true, reset: true, continueOperation: true, abortOperation: true, skipOperation: true, stashSave: true,
  stashApply: true, stashPop: true, stashDrop: true, fetch: true, pull: true, push: true, addRemote: true,
  removeRemote: true, editRemote: true, submoduleUpdate: true, submoduleAdd: true, worktreeAdd: true,
  worktreeRemove: true, worktreeLock: true, worktreePrune: true, getConfig: true, setConfig: true,
  gitflowInit: true, gitflowConfig: true, gitflowStart: true, gitflowFinish: true, lfsInstalled: true,
  lfsTrack: true, lfsCommand: true, smartStatus: true, pendingDiff: true, compareBranch: true, prTemplate: true, commitPatches: true,
  createPullRequest: true, reflog: true, resolveRef: true, countCommits: true, branchImpact: true,
  discardImpact: true, snapshot: true, applySnapshot: true, stashStore: true, undoStashPop: true, restoreBranch: true,
  backupFiles: true, restoreFiles: true, pushSha: true, cancelOperation: true, watch: true, unwatch: true
}

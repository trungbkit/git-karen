// The plugin's worker: finds the focused workspace's folder, runs git there for the panel, and
// tells the panel when the repository changes (refs, HEAD, index, stash).

import { watch } from 'node:fs'
import { basename } from 'node:path'
import { createAvatarService, githubRepo } from './avatars.mjs'
import { GitError, loadCommit, loadGraph, remoteUrl, repoInfo } from './git.mjs'
import { matchWorkspace } from './resolve.mjs'

/** Paths inside the common git dir whose change means the graph may have changed. */
const RELEVANT = /^(?:HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|index|packed-refs|refs[\\/].*|logs[\\/]refs[\\/]stash|worktrees[\\/][^\\/]+[\\/](?:HEAD|index))$/

/** One watcher at a time, on the repository the panel last loaded. */
let watched = null

/** Expected failures (no repo, remote workspace...) are answers, not errors, so the panel can show them. */
async function answer(run) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof GitError) {
      // Answers must be plain JSON: leave out fields that are undefined.
      const out = { code: error.code, message: error.message }
      if (error.candidates) out.candidates = error.candidates
      return { error: out }
    }
    throw error
  }
}

/** @param {import('orca/worker').OrcaWorkerApi} orca */
export default async function activate(orca) {
  /** terminal id -> workspace id, learned from terminal.list */
  const terminalOwner = new Map()
  /** Repository roots this worker resolved from a workspace; the only paths the panel may name. */
  const knownRepos = new Map()

  async function listWorkspaces() {
    return (await orca.host.call('workspace.list', {})).workspaces
  }

  /** The workspace row the panel asked for (`workspaceId`, a workspace.list id) or the focused one. */
  async function findWorkspace(workspaceId) {
    const rows = await listWorkspaces()
    if (workspaceId) {
      const row = rows.find((w) => w.id === workspaceId)
      if (!row) throw new GitError('Orca no longer lists this workspace.', 'no_workspace')
      return row
    }
    const ctx = await orca.host.call('workspace.readContext', {})
    if (!ctx) throw new GitError('Open a workspace to see its commit graph.', 'no_workspace')
    // terminal.list arrived in host API 1.7 (Orca 1.4.259); without it the panel asks the person.
    const listTerminals = orca.host.has('terminal.list')
      ? async (id) => (await orca.host.call('terminal.list', { workspaceId: id })).terminals
      : null
    const { match, candidates } = await matchWorkspace(ctx, rows, listTerminals, terminalOwner)
    if (match) return match
    const error = new GitError(
      candidates.length > 1
        ? `Several workspaces are called “${ctx.displayName}” on ${ctx.branch}. Pick the repository to show:`
        : `Cannot tell which repository “${ctx.displayName}” is. Pick one:`,
      'ambiguous_workspace'
    )
    const pool = candidates.length > 1 ? candidates : rows
    error.candidates = pool.map((w) => ({ id: w.id, name: w.name, path: w.path, branch: w.branch }))
    throw error
  }

  async function resolveRepo({ workspaceId, repoPath }, signal) {
    if (repoPath) {
      const known = knownRepos.get(repoPath)
      if (known) return known
      // The worker restarted since the panel loaded: accept the path again only when it is the
      // repository of a listed local workspace.
      const rows = await listWorkspaces()
      for (const ws of rows) {
        if (ws.hostId && ws.hostId !== 'local') continue
        if (ws.path !== repoPath && !ws.path.startsWith(`${repoPath}/`)) continue
        const info = await repoInfo(ws.path, signal)
        if (info?.top === repoPath) {
          knownRepos.set(repoPath, { ws, info })
          return { ws, info }
        }
      }
      throw new GitError('That repository is not open in any workspace.', 'unknown_repo')
    }
    const ws = await findWorkspace(workspaceId)
    if (ws.hostId && ws.hostId !== 'local') {
      throw new GitError(`${ws.name} runs on ${ws.hostId}; Git Graph only reads local repositories for now.`, 'remote_workspace')
    }
    const info = await repoInfo(ws.path, signal)
    if (!info) throw new GitError(`${ws.name} (${ws.path}) is not a Git repository.`, 'not_a_repo')
    const resolved = { ws, info }
    knownRepos.set(info.top, resolved)
    return resolved
  }

  // ---------------------------------------------------------------------------- watching

  function watchRepo(repoPath, commonDir) {
    if (watched?.dir === commonDir) {
      watched.repoPath = repoPath
      return
    }
    watched?.close()
    let timer = null
    let watcher
    try {
      watcher = watch(commonDir, { recursive: true }, (_event, file) => {
        if (file && (!RELEVANT.test(String(file)) || String(file).endsWith('.lock'))) return
        clearTimeout(timer)
        timer = setTimeout(() => orca.panels.post('graph.changed', { repoPath: watched?.repoPath ?? null }), 300)
      })
    } catch (error) {
      orca.log(`cannot watch ${commonDir}: ${error.message}`)
      watched = null
      return
    }
    watcher.on('error', (error) => orca.log(`watch error on ${commonDir}: ${error.message}`))
    watched = {
      dir: commonDir,
      repoPath,
      close() {
        clearTimeout(timer)
        watcher.close()
      }
    }
  }

  // ---------------------------------------------------------------------------- handlers

  orca.panels.handle('graph.load', (input, { signal }) =>
    answer(async () => {
      const { workspaceId, repoPath, skip = 0, limit = 1000 } = input ?? {}
      const { ws, info } = await resolveRepo({ workspaceId, repoPath }, signal)
      const graph = await loadGraph(info.top, { skip, limit: Math.min(Math.max(1, limit), 3000), signal })
      if (skip === 0) watchRepo(info.top, info.commonDir)
      return { repo: { name: basename(info.top), path: info.top, workspace: ws.name, workspaceId: ws.id }, ...graph }
    })
  )

  orca.panels.handle('graph.commit', (input, { signal }) =>
    answer(async () => {
      const { repoPath, sha } = input ?? {}
      const { info } = await resolveRepo({ repoPath: String(repoPath ?? '') || undefined }, signal)
      return { commit: await loadCommit(info.top, String(sha ?? ''), signal) }
    })
  )

  const avatarService = createAvatarService({ log: (s) => orca.log(s) })
  /** repository root -> its GitHub { owner, name }, or null */
  const githubOf = new Map()

  orca.panels.handle('avatars.get', (input, { signal }) =>
    answer(async () => {
      if ((await orca.settings.get('avatars')) === false) return { disabled: true }
      const { repoPath, authors } = input ?? {}
      if (!Array.isArray(authors)) throw new GitError('authors must be a list', 'invalid_params')
      const { info } = await resolveRepo({ repoPath: String(repoPath ?? '') || undefined }, signal)
      if (!githubOf.has(info.top)) githubOf.set(info.top, githubRepo(await remoteUrl(info.top, signal)))
      // At most 40 a call keeps the answer far below Orca's 1 MiB limit (pictures are 64px).
      const avatars = await avatarService.avatars(authors.slice(0, 40), { repo: githubOf.get(info.top), signal })
      return { avatars }
    })
  )
}

export function deactivate() {
  watched?.close()
  watched = null
}

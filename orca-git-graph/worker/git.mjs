// Runs git and parses its output. No Orca APIs here, so it is testable with plain Node.

import { execFile } from 'node:child_process'

const RS = '\x1e'
const US = '\x1f'

/** One record per commit: sha, parents, author name/email/time, committer time, decorations, subject. */
export const LOG_FORMAT = `${RS}%H${US}%P${US}%an${US}%ae${US}%at${US}%ct${US}%D${US}%s`
/** Full message for the details view. */
export const SHOW_FORMAT = `%H${US}%P${US}%an${US}%ae${US}%at${US}%cn${US}%ce${US}%ct${US}%B`
export const STASH_FORMAT = `${RS}%H${US}%P${US}%gd${US}%gs${US}%ct`
/** Refs the graph starts from (the stash ref is drawn from `git stash list` instead). */
export const LOG_REFS = ['--branches', '--remotes', '--tags', 'HEAD']

export class GitError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/**
 * Run git in `cwd`. Resolves with stdout; exit codes listed in `ok` count as success.
 * @returns {Promise<{ stdout: string, code: number }>}
 */
export function git(cwd, args, { ok = [0], signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      {
        cwd,
        signal,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        if (error && !ok.includes(code)) {
          if (error.code === 'ENOENT') reject(new GitError('git was not found on PATH', 'git_missing'))
          else reject(new GitError((stderr || error.message).trim(), 'git_failed'))
          return
        }
        resolve({ stdout, code })
      }
    )
  })
}

/** `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1` -> full ref names. */
export function parseDecorations(d) {
  const refs = []
  for (let part of d.split(', ')) {
    part = part.trim()
    if (!part) continue
    if (part.startsWith('HEAD -> ')) part = part.slice(8)
    else if (part === 'HEAD') continue
    if (part.startsWith('tag: ')) part = part.slice(5)
    if (part === 'refs/stash' || part.endsWith('/HEAD')) continue
    refs.push(part)
  }
  return refs
}

/** Commits from LOG_FORMAT output, newest first. Field names are short: they cross a 1 MiB IPC limit. */
export function parseLog(out) {
  const commits = []
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue
    const f = rec.split(US)
    if (f.length < 8) continue
    const parents = f[1].trim()
    const c = {
      h: f[0].trim(),
      p: parents ? parents.split(' ') : [],
      a: f[2],
      e: f[3],
      t: Number(f[4]) * 1000,
      ct: Number(f[5]) * 1000,
      s: f.slice(7).join(US).trim()
    }
    const refs = parseDecorations(f[6])
    if (refs.length) c.r = refs
    commits.push(c)
  }
  return commits
}

export function parseStashes(out) {
  const res = []
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue
    const f = rec.split(US)
    const get = (i) => (f[i] ?? '').trim()
    const ref = get(2)
    const m = /\{(\d+)\}/.exec(ref)
    res.push({
      index: m ? Number(m[1]) : res.length,
      ref,
      sha: get(0),
      baseSha: get(1).split(' ')[0] ?? '',
      message: get(3),
      date: Number(get(4)) * 1000
    })
  }
  return res
}

/** Count of changed paths in `git status --porcelain=v1 -z` output. */
export function countStatus(out) {
  const entries = out.split('\0')
  let n = 0
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.length < 4) continue
    n++
    // Renames and copies carry the original path as the next entry.
    if (e[0] === 'R' || e[0] === 'C' || e[1] === 'R' || e[1] === 'C') i++
  }
  return n
}

/** Parse `git show -s --format=SHOW_FORMAT`. */
export function parseShow(out) {
  const f = out.split(US)
  const parents = (f[1] ?? '').trim()
  const message = f.slice(8).join(US).replace(/\s+$/, '')
  const nl = message.indexOf('\n')
  return {
    sha: f[0].trim(),
    parents: parents ? parents.split(' ') : [],
    author: { name: f[2], email: f[3], date: Number(f[4]) * 1000 },
    committer: { name: f[5], email: f[6], date: Number(f[7]) * 1000 },
    summary: (nl < 0 ? message : message.slice(0, nl)).trim(),
    body: nl < 0 ? '' : message.slice(nl + 1).trim()
  }
}

/** Merge `--name-status -z` and `--numstat -z` output of the same diff into one file list. */
export function parseFileChanges(nameStatus, numstat) {
  const files = []
  const ns = nameStatus.split('\0')
  for (let i = 0; i < ns.length; ) {
    const status = ns[i++]
    if (!status) continue
    const letter = status[0]
    if (letter === 'R' || letter === 'C') {
      files.push({ status: letter, oldPath: ns[i], path: ns[i + 1], added: null, deleted: null })
      i += 2
    } else {
      files.push({ status: letter, path: ns[i], added: null, deleted: null })
      i += 1
    }
  }
  const stats = new Map()
  const nm = numstat.split('\0')
  for (let i = 0; i < nm.length; ) {
    const head = nm[i++]
    if (!head) continue
    const [added, deleted, path] = head.split('\t')
    let key = path
    // A rename's numstat line has an empty path, followed by the old and new paths.
    if (!path) {
      key = nm[i + 1]
      i += 2
    }
    stats.set(key, { added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted), binary: added === '-' })
  }
  for (const file of files) {
    const s = stats.get(file.path)
    if (s) Object.assign(file, s)
  }
  return files
}

// ------------------------------------------------------------------------------------ reading

/** Repository facts for a folder, or null when it is not inside a Git work tree. */
export async function repoInfo(cwd, signal) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir', '--absolute-git-dir'], { ok: [0, 128], signal })
  if (r.code !== 0) return null
  const [top, common, gitDir] = r.stdout.trim().split('\n')
  const commonDir = common.startsWith('/') || /^[A-Za-z]:/.test(common) ? common : `${top}/${common}`
  return { top, commonDir, gitDir }
}

export async function loadGraph(cwd, { skip = 0, limit = 1000, signal } = {}) {
  const head = await git(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], { ok: [0, 1], signal })
  const headSha = head.code === 0 ? head.stdout.trim() : null
  const anyRef = headSha ? 'x' : (await git(cwd, ['for-each-ref', '--count=1'], { signal })).stdout.trim()

  let commits = []
  if (anyRef) {
    const args = ['log', '--date-order', '--decorate=full', `--format=${LOG_FORMAT}`, `-n${limit + 1}`]
    if (skip > 0) args.push(`--skip=${skip}`)
    // An unborn HEAD would make git log fail, so only name it when it exists.
    args.push(...LOG_REFS.filter((r) => r !== 'HEAD' || headSha), '--')
    const r = await git(cwd, args, { ok: [0, 128], signal })
    if (r.code === 0) commits = parseLog(r.stdout)
  }
  const hasMore = commits.length > limit
  if (hasMore) commits.length = limit

  const result = { commits, hasMore, skip }
  if (skip > 0) return result

  const [branch, stash, status] = await Promise.all([
    git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: [0, 1, 128], signal }),
    git(cwd, ['stash', 'list', `--format=${STASH_FORMAT}`], { ok: [0, 128], signal }),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { ok: [0, 128], signal })
  ])
  result.headSha = headSha
  result.branch = branch.code === 0 ? branch.stdout.trim() : null
  result.stashes = stash.code === 0 ? parseStashes(stash.stdout) : []
  result.changes = status.code === 0 ? countStatus(status.stdout) : 0
  return result
}

export async function loadCommit(cwd, sha, signal) {
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new GitError(`not a commit id: ${sha}`, 'invalid_params')
  const show = await git(cwd, ['show', '-s', `--format=${SHOW_FORMAT}`, sha, '--'], { signal })
  const commit = parseShow(show.stdout)
  // Diff against the first parent (merges included); root commits against the empty tree.
  const range = commit.parents.length ? [commit.parents[0], commit.sha] : ['--root', commit.sha]
  const base = ['diff-tree', '-r', '-M', '--no-commit-id', '-z']
  const [ns, num] = await Promise.all([
    git(cwd, [...base, '--name-status', ...range, '--'], { signal }),
    git(cwd, [...base, '--numstat', ...range, '--'], { signal })
  ])
  commit.files = parseFileChanges(ns.stdout, num.stdout)
  return commit
}

/** URL of `origin`, else of the first remote; null when the repository has none. */
export async function remoteUrl(cwd, signal) {
  const origin = await git(cwd, ['remote', 'get-url', 'origin'], { ok: [0, 2, 128], signal })
  if (origin.code === 0 && origin.stdout.trim()) return origin.stdout.trim()
  const list = await git(cwd, ['remote'], { ok: [0, 128], signal })
  const first = list.stdout.split('\n')[0]?.trim()
  if (!first) return null
  const r = await git(cwd, ['remote', 'get-url', first], { ok: [0, 2, 128], signal })
  return r.code === 0 ? r.stdout.trim() || null : null
}

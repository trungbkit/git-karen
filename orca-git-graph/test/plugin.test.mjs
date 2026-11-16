import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { countStatus, loadCommit, loadGraph, parseDecorations, parseFileChanges, repoInfo } from '../worker/git.mjs'
import { WIP_SHA, buildNodes, computeLayout, groupRefs } from '../panel/layout.js'

const c = (h, p = [], extra = {}) => ({ h, p, a: 'A', e: 'a@x', t: 0, ct: 0, s: h, ...extra })

describe('parsing', () => {
  test('decorations drop HEAD, stash and remote HEAD', () => {
    assert.deepEqual(parseDecorations('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1, refs/stash'), [
      'refs/heads/main',
      'refs/remotes/origin/main',
      'refs/tags/v1'
    ])
  })

  test('status counts renames once', () => {
    assert.equal(countStatus(' M a.txt\0R  new.txt\0old.txt\0?? b.txt\0'), 3)
  })

  test('file changes merge name-status and numstat, renames included', () => {
    const files = parseFileChanges('M\0src/a.js\0R090\0old.js\0new.js\0A\0img.png\0', '3\t1\tsrc/a.js\0' + '2\t0\t\0old.js\0new.js\0' + '-\t-\timg.png\0')
    assert.deepEqual(files, [
      { status: 'M', path: 'src/a.js', added: 3, deleted: 1, binary: false },
      { status: 'R', oldPath: 'old.js', path: 'new.js', added: 2, deleted: 0, binary: false },
      { status: 'A', path: 'img.png', added: null, deleted: null, binary: true }
    ])
  })
})

describe('layout', () => {
  test('a merged branch takes a second lane and rejoins', () => {
    // m merges b into a; both come from root r.
    const nodes = buildNodes([c('m', ['a', 'b']), c('b', ['r']), c('a', ['r']), c('r')])
    const { rows, maxColumns } = computeLayout(nodes)
    assert.deepEqual(rows.map((r) => r.column), [0, 1, 0, 0])
    assert.equal(maxColumns, 2)
    assert.equal(rows[0].isMerge, true)
    assert.deepEqual(rows[3].edges[1], { end: { parent: 'r', dashed: false } })
  })

  test('WIP row sits on top, attached to HEAD with a dashed edge', () => {
    const nodes = buildNodes([c('a', ['r']), c('r')], { wipHeadSha: 'a' })
    assert.equal(nodes[0].sha, WIP_SHA)
    const { rows } = computeLayout(nodes)
    assert.deepEqual(rows[0].edges[0], { start: { parent: 'a', dashed: true } })
  })

  test('stash rows replace stash-internal commits', () => {
    const commits = [c('s', ['a', 'i'], { ct: 5 }), c('i', ['a'], { ct: 4 }), c('a', ['r'], { ct: 3 }), c('r', [], { ct: 1 })]
    const nodes = buildNodes(commits, { stashes: [{ sha: 's', baseSha: 'a', ref: 'stash@{0}', message: 'wip', date: 5 }] })
    assert.deepEqual(nodes.map((n) => `${n.kind}:${n.sha}`), ['stash:s', 'commit:a', 'commit:r'])
  })

  test('local and remote branches share a pill, current first', () => {
    const groups = groupRefs(['refs/tags/v1', 'refs/remotes/origin/main', 'refs/heads/main', 'refs/heads/dev'], 'main')
    assert.deepEqual(groups.map((g) => [g.name, g.type, g.current, g.remotes]), [
      ['main', 'local', true, ['origin/main']],
      ['dev', 'local', false, []],
      ['v1', 'tag', false, []]
    ])
  })
})

describe('git (real repository)', () => {
  let dir
  const run = (...args) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } })

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-graph-'))
    run('init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    run('add', '.')
    run('commit', '-q', '-m', 'first')
    run('checkout', '-q', '-b', 'feature')
    writeFileSync(join(dir, 'b.txt'), 'two\n')
    run('add', '.')
    run('commit', '-q', '-m', 'feature work', '-m', 'body line')
    run('checkout', '-q', 'main')
    run('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature')
    run('tag', 'v1')
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
  })
  after(() => rmSync(dir, { recursive: true, force: true }))

  test('loads commits, refs, branch and working tree changes', async () => {
    const info = await repoInfo(dir)
    assert.ok(info)
    const g = await loadGraph(info.top, { limit: 10 })
    assert.deepEqual(g.commits.map((x) => x.s), ['merge feature', 'feature work', 'first'])
    assert.deepEqual(g.commits[0].r, ['refs/heads/main', 'refs/tags/v1'])
    assert.equal(g.branch, 'main')
    assert.equal(g.changes, 1)
    assert.equal(g.hasMore, false)
    const page = await loadGraph(info.top, { limit: 1, skip: 1 })
    assert.deepEqual(page.commits.map((x) => x.s), ['feature work'])
    assert.equal(page.hasMore, true)
  })

  test('commit details diff merges against the first parent', async () => {
    const g = await loadGraph(dir, { limit: 10 })
    const merge = await loadCommit(dir, g.commits[0].h)
    assert.equal(merge.parents.length, 2)
    assert.deepEqual(merge.files.map((f) => [f.status, f.path, f.added]), [['A', 'b.txt', 1]])
    const feature = await loadCommit(dir, g.commits[1].h)
    assert.equal(feature.body, 'body line')
    const root = await loadCommit(dir, g.commits[2].h)
    assert.deepEqual(root.files.map((f) => f.path), ['a.txt'])
  })

  test('a folder outside any repository is not a repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'git-graph-plain-'))
    try {
      assert.equal(await repoInfo(plain), null)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

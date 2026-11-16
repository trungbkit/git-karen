import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchWorkspace } from '../worker/resolve.mjs'

const rows = [
  { id: 'w1', name: 'main', branch: 'main', path: '/a' },
  { id: 'w2', name: 'main', branch: 'main', path: '/b' },
  { id: 'w3', name: 'uat', branch: 'uat', path: '/c' }
]
const terms = { w1: [{ id: 't1' }], w2: [{ id: 't2' }, { id: 't3' }], w3: [] }
const list = async (id) => terms[id]

test('a unique name and branch is enough', async () => {
  const r = await matchWorkspace({ displayName: 'uat', branch: 'uat', terminals: [] }, rows, list)
  assert.equal(r.match.id, 'w3')
})

test('shared names are told apart by terminal ids, and the owner is cached', async () => {
  const cache = new Map()
  let calls = 0
  const counting = async (id) => (calls++, terms[id])
  const r = await matchWorkspace({ displayName: 'main', branch: 'main', terminals: [{ id: 't3' }] }, rows, counting, cache)
  assert.equal(r.match.id, 'w2')
  const before = calls
  const again = await matchWorkspace({ displayName: 'main', branch: 'main', terminals: [{ id: 't3' }] }, rows, counting, cache)
  assert.equal(again.match.id, 'w2')
  assert.equal(calls, before)
})

test('no terminals and a shared name leaves the choice to the person', async () => {
  const r = await matchWorkspace({ displayName: 'main', branch: 'main', terminals: [] }, rows, list)
  assert.equal(r.match, null)
  assert.deepEqual(r.candidates.map((w) => w.id), ['w1', 'w2'])
})

test('an explicit workspaceId wins', async () => {
  const r = await matchWorkspace({ workspaceId: 'w2', displayName: 'x', branch: 'y', terminals: [] }, rows, list)
  assert.equal(r.match.id, 'w2')
})

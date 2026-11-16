import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAvatarService, githubRepo, gravatarUrl, noreplyUrl } from '../worker/avatars.mjs'
import { avatarColor, initials } from '../panel/avatars.js'

const SHA = 'a'.repeat(40)
const png = (body = 'img') => new Response(body, { status: 200, headers: { 'content-type': 'image/png' } })

/** A fetch that answers from a table of url prefix -> Response factory, and records every call. */
function fakeFetch(routes) {
  const calls = []
  const fn = async (url) => {
    calls.push(url)
    for (const [prefix, answer] of routes) if (url.startsWith(prefix)) return answer(url)
    return new Response('', { status: 404 })
  }
  return { fn, calls }
}

test('noreply, gravatar and remote URLs', () => {
  assert.equal(noreplyUrl('123+octo@users.noreply.github.com'), 'https://avatars.githubusercontent.com/u/123?s=64')
  assert.equal(noreplyUrl('octo@users.noreply.github.com'), 'https://github.com/octo.png?size=64')
  assert.equal(noreplyUrl('a@b.c'), null)
  assert.match(gravatarUrl(' A@B.c '), /^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{64}\?d=404&s=64$/)
  assert.equal(gravatarUrl('A@B.c'), gravatarUrl('a@b.c'))
  for (const url of ['https://github.com/acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app', 'https://user@github.com/acme/app/']) {
    assert.deepEqual(githubRepo(url), { owner: 'acme', name: 'app' }, url)
  }
  assert.equal(githubRepo('git@gitlab.com:acme/app.git'), null)
  assert.equal(githubRepo(null), null)
})

test('gravatar first, then the GitHub account of the commit', async () => {
  const { fn, calls } = fakeFetch([
    ['https://www.gravatar.com/', () => new Response('', { status: 404 })],
    ['https://api.github.com/repos/acme/app/commits/', () => Response.json({ author: { avatar_url: 'https://avatars.githubusercontent.com/u/9?v=4' } })],
    ['https://avatars.githubusercontent.com/u/9', () => png('gh')]
  ])
  const svc = createAvatarService({ fetch: fn })
  const out = await svc.avatars([{ email: 'Dev@x.io', sha: SHA }], { repo: { owner: 'acme', name: 'app' } })
  assert.equal(out['dev@x.io'], `data:image/png;base64,${Buffer.from('gh').toString('base64')}`)
  assert.ok(calls.some((u) => u.includes('s=64')))
  // Known now: no second round of requests.
  const before = calls.length
  await svc.avatars([{ email: 'dev@x.io', sha: SHA }], { repo: { owner: 'acme', name: 'app' } })
  assert.equal(calls.length, before)
})

test('no picture anywhere is a definite null; GitHub not knowing the commit is left unanswered', async () => {
  const { fn } = fakeFetch([['https://api.github.com/', () => new Response('', { status: 422 })]])
  const svc = createAvatarService({ fetch: fn })
  const out = await svc.avatars(
    [
      { email: 'none@x.io', sha: null },
      { email: 'later@x.io', sha: SHA }
    ],
    { repo: { owner: 'acme', name: 'app' } }
  )
  assert.equal(out['none@x.io'], null)
  assert.equal('later@x.io' in out, false)
})

test('a GitHub rate limit pauses GitHub lookups until it resets', async () => {
  let t = 1_000_000
  const reset = Math.floor(t / 1000) + 60
  const { fn, calls } = fakeFetch([
    ['https://api.github.com/', () => new Response('', { status: 403, headers: { 'x-ratelimit-reset': String(reset) } })]
  ])
  const svc = createAvatarService({ fetch: fn, now: () => t })
  const repo = { owner: 'acme', name: 'app' }
  await svc.avatars([{ email: 'a@x.io', sha: SHA }], { repo })
  await svc.avatars([{ email: 'b@x.io', sha: SHA }], { repo })
  assert.equal(calls.filter((u) => u.startsWith('https://api.github.com/')).length, 1)
  t = reset * 1000 + 1
  await svc.avatars([{ email: 'c@x.io', sha: SHA }], { repo })
  assert.equal(calls.filter((u) => u.startsWith('https://api.github.com/')).length, 2)
})

test('non-image answers are ignored', async () => {
  const { fn } = fakeFetch([['https://www.gravatar.com/', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })]])
  const out = await createAvatarService({ fetch: fn }).avatars([{ email: 'x@y.z' }])
  assert.equal(out['x@y.z'], null)
})

test('initials and colours match Karen', () => {
  assert.equal(initials('Ana Lee'), 'AL')
  assert.equal(initials('trungjs'), 'TR')
  assert.equal(initials('first.last'), 'FL')
  assert.equal(initials(''), '?')
  assert.equal(avatarColor('A@x'), avatarColor('a@x'))
  assert.match(avatarColor('a@x'), /^hsl\(\d+, 55%, 46%\)$/)
})

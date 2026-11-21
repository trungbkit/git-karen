import { describe, expect, it } from 'vitest'
import { coalesce } from './coalesce'

/** A run that waits until released, recording its options. */
function harness() {
  const started: { key: string; opts: { log: boolean }; release: () => void }[] = []
  const finished: number[] = []
  const run = (key: string, opts: { log: boolean }) =>
    new Promise<void>((resolve) => {
      const n = started.length
      started.push({ key, opts, release: () => (finished.push(n), resolve()) })
    })
  const request = coalesce(run, (a: { log: boolean }, b: { log: boolean }) => ({ log: a.log || b.log }))
  return { started, finished, request }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('coalesce', () => {
  it('runs right away when idle', async () => {
    const h = harness()
    const done = h.request('a', { log: false })
    expect(h.started).toHaveLength(1)
    h.started[0].release()
    await done
    expect(h.finished).toEqual([0])
  })

  it('folds calls made during a run into one follow-up run with merged options', async () => {
    const h = harness()
    const first = h.request('a', { log: false })
    const second = h.request('a', { log: true })
    const third = h.request('a', { log: false })
    expect(h.started).toHaveLength(1)
    expect(second).toBe(third)

    h.started[0].release()
    await first
    await tick()
    expect(h.started).toHaveLength(2)
    expect(h.started[1].opts).toEqual({ log: true })

    h.started[1].release()
    await second
    expect(h.started).toHaveLength(2)
  })

  it('settles a caller only after a run that started after its call', async () => {
    const h = harness()
    void h.request('a', { log: false })
    let settled = false
    const later = h.request('a', { log: false }).then(() => (settled = true))
    h.started[0].release()
    await tick()
    expect(settled).toBe(false)
    h.started[1].release()
    await later
    expect(settled).toBe(true)
  })

  it('never overlaps runs, so an older result cannot land after a newer one', async () => {
    const applied: number[] = []
    const request = coalesce(
      async (_key: string, n: number) => {
        // the first run is the slowest; if runs overlapped, it would apply last
        await new Promise((r) => setTimeout(r, n === 1 ? 30 : 1))
        applied.push(n)
      },
      (_a: number, b: number) => b
    )
    await Promise.all([request('a', 1), request('a', 2), request('a', 3)])
    expect(applied).toEqual([1, 3])
  })

  it('keeps keys independent', async () => {
    const h = harness()
    void h.request('a', { log: false })
    void h.request('b', { log: false })
    expect(h.started.map((s) => s.key)).toEqual(['a', 'b'])
  })

  it('starts fresh after the queue drains, and survives a failing run', async () => {
    let calls = 0
    const request = coalesce(
      async () => {
        calls++
        if (calls === 1) throw new Error('boom')
      },
      (a: null) => a
    )
    await request('a', null)
    await request('a', null)
    expect(calls).toBe(2)
  })
})

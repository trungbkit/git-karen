import { describe, expect, it } from 'vitest'
import type { RepoSummary } from '@shared/types'
import { describeSkipped, mapLimit, pullPlan, validateWorkspaceName } from './workspace'

const summary = (over: Partial<RepoSummary> = {}): RepoSummary => ({
  branch: 'main',
  detached: false,
  headSha: 'abc',
  upstream: 'origin/main',
  ahead: 0,
  behind: 2,
  changes: 0,
  conflicted: 0,
  operation: null,
  ...over
})

describe('pullPlan', () => {
  it('pulls only clean repositories behind their upstream', () => {
    const plan = pullPlan(['/ok', '/dirty', '/rebasing', '/detached', '/local', '/current', '/gone'], {
      '/ok': summary(),
      '/dirty': summary({ changes: 1 }),
      '/rebasing': summary({ operation: 'rebase', changes: 1 }),
      '/detached': summary({ detached: true, branch: null }),
      '/local': summary({ upstream: undefined }),
      '/current': summary({ behind: 0, ahead: 3 })
    })
    expect(plan.pull).toEqual(['/ok'])
    expect(plan.skipped.map((s) => s.reason)).toEqual(['changes', 'operation', 'detached', 'no-upstream', 'up-to-date', 'unknown'])
    expect(describeSkipped(plan.skipped)).toBe(
      '1 with uncommitted changes, 1 with an operation in progress, 1 with detached HEAD, 1 with no upstream branch, 1 with status unavailable'
    )
    expect(describeSkipped([{ reason: 'changes' }, { reason: 'changes' }, { reason: 'up-to-date' }])).toBe('2 with uncommitted changes')
  })
})

describe('mapLimit', () => {
  it('keeps the order and never runs more than the limit at once', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      peak = Math.max(peak, ++running)
      await new Promise((r) => setTimeout(r, n))
      running--
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30])
    expect(peak).toBe(2)
    expect(await mapLimit([], 3, async () => 1)).toEqual([])
  })
})

describe('validateWorkspaceName', () => {
  it('requires a unique, non-empty name', () => {
    const ws = [{ name: 'Work', repos: [] }]
    expect(validateWorkspaceName(' ', ws)).toBe('Name is required')
    expect(validateWorkspaceName('Work ', ws)).toBe('A workspace with this name exists')
    expect(validateWorkspaceName('Work', ws, 'Work')).toBeNull()
    expect(validateWorkspaceName('Home', ws)).toBeNull()
  })
})

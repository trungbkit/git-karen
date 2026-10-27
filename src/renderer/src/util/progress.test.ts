import { describe, expect, it } from 'vitest'
import { overallPercent, parseProgressLine, reduceProgress, type OperationProgress } from './progress'

describe('parseProgressLine', () => {
  it('reads the phase, percentage, counter and throughput', () => {
    expect(parseProgressLine('Receiving objects:  45% (450/1000), 1.20 MiB | 1.10 MiB/s')).toEqual({
      phase: 'Receiving objects',
      percent: 45,
      current: 450,
      total: 1000,
      detail: '1.20 MiB | 1.10 MiB/s'
    })
  })

  it('keeps the remote prefix and drops "done"', () => {
    expect(parseProgressLine('remote: Counting objects: 100% (10/10), done.')).toMatchObject({ phase: 'remote: Counting objects', percent: 100, detail: null })
    expect(parseProgressLine('Writing objects: 100% (3/3), 300 bytes | 300.00 KiB/s, done.')?.detail).toBe('300 bytes | 300.00 KiB/s')
    expect(parseProgressLine('Resolving deltas:   7% (3/41)')).toMatchObject({ phase: 'Resolving deltas', percent: 7, current: 3, total: 41 })
  })

  it('ignores lines without a counter', () => {
    expect(parseProgressLine("Cloning into 'repo'...")).toBeNull()
    expect(parseProgressLine('remote: Enumerating objects: 5, done.')).toBeNull()
    expect(parseProgressLine('To github.com:owner/repo.git')).toBeNull()
    expect(parseProgressLine('remote: Total 3 (delta 1), reused 0 (delta 0)')).toBeNull()
  })
})

describe('overallPercent', () => {
  const at = (line: string) => parseProgressLine(line)!

  it('maps each phase onto its share of the operation', () => {
    expect(overallPercent('clone', at('remote: Counting objects: 100% (5/5)'))).toBe(4)
    expect(overallPercent('clone', at('Receiving objects:  50% (5/10)'))).toBe(45)
    expect(overallPercent('clone', at('Resolving deltas: 100% (4/4)'))).toBe(92)
    expect(overallPercent('clone', at('Updating files: 100% (9/9)'))).toBe(100)
    expect(overallPercent('push', at('Writing objects:   0% (0/10)'))).toBe(20)
    expect(overallPercent('pull', at('Receiving objects: 100% (10/10)'))).toBe(85)
  })

  it('is null for phases an operation does not know', () => {
    expect(overallPercent('push', at('Receiving objects: 10% (1/10)'))).toBeNull()
    expect(overallPercent('lfs pull', at('Downloading LFS objects: 10% (1/10)'))).toBeNull()
  })
})

describe('reduceProgress', () => {
  const run = (op: string, lines: string[]) => lines.reduce<OperationProgress | undefined>((p, l) => reduceProgress(p, op, l), undefined)!

  it('follows a clone from message to phases', () => {
    expect(run('clone', ["Cloning into 'x'..."])).toEqual({ op: 'clone', label: "Cloning into 'x'...", percent: null, overall: null, detail: null })
    expect(run('clone', ["Cloning into 'x'...", 'Receiving objects:  30% (3/10), 1.00 MiB | 2.00 MiB/s'])).toEqual({
      op: 'clone',
      label: 'Receiving objects',
      percent: 30,
      overall: 31,
      detail: '1.00 MiB | 2.00 MiB/s'
    })
  })

  it('never moves the overall bar back while the operation runs', () => {
    // a submodule clone starts the phases again
    const p = run('clone', ['Receiving objects: 100% (10/10)', 'Resolving deltas: 100% (2/2)', 'Receiving objects:  10% (1/10)'])
    expect(p).toMatchObject({ label: 'Receiving objects', percent: 10, overall: 92 })
    expect(run('clone', ['Receiving objects: 50% (5/10)', 'Filtering content: 20% (1/5)'])).toMatchObject({ label: 'Filtering content', percent: 20, overall: 45 })
  })

  it('starts over for another operation', () => {
    const fetched = run('fetch', ['Receiving objects: 100% (10/10)'])
    expect(reduceProgress(fetched, 'push', 'Writing objects: 50% (1/2)')).toMatchObject({ op: 'push', overall: 58 })
  })
})

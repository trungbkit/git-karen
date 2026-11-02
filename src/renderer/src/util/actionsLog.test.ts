import { describe, expect, it } from 'vitest'
import { parseActionsLog, plainLog, searchLog, stripAnsi } from './actionsLog'

const LOG = [
  '﻿2026-10-01T12:00:00.1234567Z Requested labels: ubuntu-latest',
  '2026-10-01T12:00:01.0000000Z ##[group]Run actions/checkout@v4',
  '2026-10-01T12:00:01.1000000Z with:',
  '2026-10-01T12:00:01.2000000Z [command]/usr/bin/git version',
  '2026-10-01T12:00:02.0000000Z ##[endgroup]',
  '2026-10-01T12:00:03.0000000Z ##[group]Run npm test',
  '2026-10-01T12:00:04.0000000Z \u001b[31mFAIL\u001b[0m src/a.test.ts',
  '2026-10-01T12:00:05.0000000Z ##[error]Process completed with exit code 1.',
  '2026-10-01T12:00:05.0000000Z ##[endgroup]',
  '2026-10-01T12:00:06.0000000Z ##[warning]Node 16 is deprecated',
  ''
].join('\r\n')

describe('parseActionsLog', () => {
  it('splits groups and loose lines and classifies annotations', () => {
    const blocks = parseActionsLog(LOG)
    expect(blocks.map((b) => b.title?.text ?? null)).toEqual([null, 'Run actions/checkout@v4', 'Run npm test', null])
    expect(blocks[0].lines[0]).toEqual({ n: 1, time: '12:00:00', text: 'Requested labels: ubuntu-latest', kind: 'plain' })
    expect(blocks[1].lines.map((l) => l.kind)).toEqual(['plain', 'command'])
    expect(blocks[1].lines[1].text).toBe('/usr/bin/git version')
    expect(blocks[2].hasError).toBe(true)
    expect(blocks[2].lines.map((l) => [l.text, l.kind])).toEqual([
      ['FAIL src/a.test.ts', 'plain'],
      ['Process completed with exit code 1.', 'error']
    ])
    expect(blocks[3].lines[0]).toMatchObject({ n: 10, kind: 'warning', text: 'Node 16 is deprecated' })
    expect(blocks[1].hasError).toBe(false)
  })

  it('keeps lines without timestamps and an unclosed group', () => {
    const blocks = parseActionsLog('plain\n##[group]Open\ninside')
    expect(blocks.map((b) => [b.title?.text ?? null, b.lines.map((l) => l.text)])).toEqual([
      [null, ['plain']],
      ['Open', ['inside']]
    ])
    expect(blocks[0].lines[0].time).toBeNull()
    expect(parseActionsLog('')).toEqual([])
  })

  it('searches and flattens', () => {
    const blocks = parseActionsLog(LOG)
    expect(searchLog(blocks, 'fail')).toEqual([7])
    expect(searchLog(blocks, 'RUN ')).toEqual([2, 6])
    expect(searchLog(blocks, '  ')).toEqual([])
    expect(plainLog(blocks).split('\n')).toContain('error: Process completed with exit code 1.')
    expect(stripAnsi('\u001b[1;32mok\u001b[0m')).toBe('ok')
  })
})

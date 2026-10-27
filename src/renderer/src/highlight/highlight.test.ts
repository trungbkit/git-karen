import { describe, expect, it } from 'vitest'
import type { FileDiff } from '@shared/types'
import { LANGUAGE_LOADERS, languageForPath } from './languages'
import { diffSides, hashText, mapDiffTokens, splitTokens, type Token } from './tokens'
import { tokenizeLines, withinLimits } from './highlighter'

describe('languageForPath', () => {
  it('maps extensions', () => {
    expect(languageForPath('src/app.ts')).toBe('typescript')
    expect(languageForPath('src/App.TSX')).toBe('tsx')
    expect(languageForPath('a/b/c.py')).toBe('python')
    expect(languageForPath('x.yml')).toBe('yaml')
    expect(languageForPath('lib.rs')).toBe('rust')
    expect(languageForPath('main.h')).toBe('c')
    expect(languageForPath('run.zsh')).toBe('shellscript')
  })

  it('maps special file names', () => {
    expect(languageForPath('Dockerfile')).toBe('docker')
    expect(languageForPath('deploy/Dockerfile.prod')).toBe('docker')
    expect(languageForPath('Makefile')).toBe('make')
    expect(languageForPath('.gitignore')).toBe('ignore')
    expect(languageForPath('tsconfig.json')).toBe('jsonc')
    expect(languageForPath('.env.local')).toBe('shellscript')
  })

  it('returns null for unknown or extensionless files', () => {
    expect(languageForPath('LICENSE')).toBeNull()
    expect(languageForPath('image.png')).toBeNull()
    expect(languageForPath('notes.xyz')).toBeNull()
  })

  it('only maps to languages that have a loader', () => {
    for (const p of ['a.ts', 'a.vue', 'a.kt', 'a.m', 'Dockerfile', '.gitignore', 'a.tf', 'a.ex']) {
      const lang = languageForPath(p)!
      expect(LANGUAGE_LOADERS[lang], p).toBeTypeOf('function')
    }
  })
})

const diff: FileDiff = {
  path: 'a.ts',
  binary: false,
  headerLines: [],
  hunks: [
    {
      header: '@@ -1,3 +1,3 @@',
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [
        { type: 'context', content: 'const a = 1' },
        { type: 'del', content: 'const b = 2' },
        { type: 'add', content: 'const b = 3' },
        { type: 'meta', content: '\\ No newline at end of file' }
      ]
    },
    {
      header: '@@ -10,2 +10,2 @@',
      oldStart: 10,
      oldLines: 2,
      newStart: 10,
      newLines: 2,
      lines: [
        { type: 'add', content: 'x()' },
        { type: 'context', content: 'y()' }
      ]
    }
  ]
}

describe('diffSides', () => {
  it('builds old and new documents and maps every line', () => {
    const sides = diffSides(diff)
    expect(sides.oldText).toBe('const a = 1\nconst b = 2\ny()')
    expect(sides.newText).toBe('const a = 1\nconst b = 3\nx()\ny()')
    expect(sides.refs).toEqual([
      [{ side: 'new', line: 0 }, { side: 'old', line: 1 }, { side: 'new', line: 1 }, null],
      [{ side: 'new', line: 2 }, { side: 'new', line: 3 }]
    ])
  })

  it('maps tokens back and rejects tokens that do not reproduce the line', () => {
    const sides = diffSides(diff)
    const tok = (text: string): Token[] => [{ content: text, color: '#fff' }]
    const oldTokens = sides.oldText.split('\n').map(tok)
    const newTokens = sides.newText.split('\n').map(tok)
    newTokens[2] = [{ content: 'x(' }] // corrupt: missing ')'
    const mapped = mapDiffTokens(diff, sides, oldTokens, newTokens)
    expect(mapped[0][0]).toEqual(tok('const a = 1'))
    expect(mapped[0][1]).toEqual(tok('const b = 2'))
    expect(mapped[0][2]).toEqual(tok('const b = 3'))
    expect(mapped[0][3]).toBeNull()
    expect(mapped[1][0]).toBeNull()
    expect(mapped[1][1]).toEqual(tok('y()'))
  })

  it('tolerates a missing side', () => {
    const sides = diffSides(diff)
    const mapped = mapDiffTokens(diff, sides, null, sides.newText.split('\n').map((t) => [{ content: t }]))
    expect(mapped[0][1]).toBeNull()
    expect(mapped[0][2]).toEqual([{ content: 'const b = 3' }])
  })
})

describe('splitTokens', () => {
  const tokens: Token[] = [
    { content: 'const', color: 'k' },
    { content: ' ', color: 'w' },
    { content: 'value', color: 'v' },
    { content: ' = 1', color: 'p' }
  ]

  it('returns unchanged segments without a range', () => {
    expect(splitTokens(tokens).map((s) => s.changed)).toEqual([false, false, false, false])
  })

  it('splits tokens at range boundaries keeping colours', () => {
    const segs = splitTokens(tokens, [3, 8])
    expect(segs.map((s) => s.content).join('')).toBe('const value = 1')
    expect(segs.filter((s) => s.changed).map((s) => [s.content, s.color])).toEqual([
      ['st', 'k'],
      [' ', 'w'],
      ['va', 'v']
    ])
    expect(segs.filter((s) => !s.changed).map((s) => s.content)).toEqual(['con', 'lue', ' = 1'])
  })

  it('handles a range covering everything', () => {
    const segs = splitTokens(tokens, [0, 15])
    expect(segs.every((s) => s.changed)).toBe(true)
    expect(segs).toHaveLength(4)
  })

  it('splits at several ranges, including two inside one token', () => {
    const segs = splitTokens(tokens, [
      [1, 2],
      [3, 4],
      [6, 11],
      [12, 13]
    ])
    expect(segs.map((s) => s.content).join('')).toBe('const value = 1')
    expect(segs.filter((s) => s.changed).map((s) => [s.content, s.color])).toEqual([
      ['o', 'k'],
      ['s', 'k'],
      ['value', 'v'],
      ['=', 'p']
    ])
    expect(segs.filter((s) => !s.changed).map((s) => s.content)).toEqual(['c', 'n', 't', ' ', ' ', ' 1'])
    expect(splitTokens(tokens, []).every((s) => !s.changed)).toBe(true)
  })
})

describe('limits and hashing', () => {
  it('rejects oversize inputs', () => {
    expect(withinLimits('a\n'.repeat(10))).toBe(true)
    expect(withinLimits('a\n'.repeat(6000))).toBe(false)
    expect(withinLimits('x'.repeat(600_000))).toBe(false)
  })

  it('hashes text', () => {
    expect(hashText('abc')).toBe(hashText('abc'))
    expect(hashText('abc')).not.toBe(hashText('abd'))
  })
})

describe('tokenizeLines (shiki integration)', () => {
  it('tokenizes TypeScript with colours, one entry per line', async () => {
    const code = 'const x: number = 1 // hi\n/* multi\nline */ export function f() { return "s" }'
    const lines = await tokenizeLines('a.ts', code, 'dark')
    expect(lines).not.toBeNull()
    expect(lines).toHaveLength(3)
    expect(lines!.map((l) => l.map((t) => t.content).join(''))).toEqual(code.split('\n'))
    const colors = new Set(lines!.flat().map((t) => t.color))
    expect(colors.size).toBeGreaterThan(2)
    // the comment continuation on line 2 is coloured like the comment start on line 2
    const comment = lines![1][0].color
    expect(lines![2][0].content.startsWith('line')).toBe(true)
    expect(lines![2][0].color).toBe(comment)
  })

  it('returns null for unknown languages', async () => {
    expect(await tokenizeLines('README', 'hello', 'dark')).toBeNull()
  })

  it('uses a different palette for the light theme', async () => {
    const dark = await tokenizeLines('a.ts', 'const a = 1', 'dark')
    const light = await tokenizeLines('a.ts', 'const a = 1', 'light')
    expect(dark![0][0].color).not.toBe(light![0][0].color)
  })
})

import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

describe('parseInline', () => {
  it('splits bold and code runs', () => {
    expect(parseInline('a **b** `c` d')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'c' },
      { kind: 'text', text: ' d' }
    ])
  })

  it('leaves unclosed markers as text', () => {
    expect(parseInline('a ** b ` c')).toEqual([{ kind: 'text', text: 'a ** b ` c' }])
  })
})

describe('parseMarkdown', () => {
  it('reads headings, lists, code and paragraphs', () => {
    const blocks = parseMarkdown('## Overview\nOne\ntwo.\n\n- a\n  - nested\n- b\n\n1. first\n2. second\n\n```ts\nconst x = 1\n```')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'list', 'code'])
    expect(blocks[1]).toEqual({ kind: 'paragraph', inline: [{ kind: 'text', text: 'One two.' }] })
    const bullets = blocks[2]
    expect(bullets.kind === 'list' && bullets.items.map((i) => [i.level, i.inline[0].text])).toEqual([
      [0, 'a'],
      [1, 'nested'],
      [0, 'b']
    ])
    expect(blocks[3].kind === 'list' && blocks[3].ordered).toBe(true)
    expect(blocks[4]).toEqual({ kind: 'code', lang: 'ts', text: 'const x = 1' })
  })

  it('continues a list item on an indented line', () => {
    const [list] = parseMarkdown('- **major** `a.ts:3` — the problem\n  and the fix')
    expect(list.kind === 'list' && list.items[0].inline.map((r) => r.text).join('')).toBe('major a.ts:3 — the problem and the fix')
  })
})

import { describe, expect, it } from 'vitest'
import { accentVars, parseHex, resolveTheme, rowHeight, schemeOf, textOn } from './appearance'

describe('themes', () => {
  it('follows the system setting for "system" and keeps a chosen theme', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('nord', false)).toBe('nord')
    expect(resolveTheme('solarized', true)).toBe('solarized')
    // a value saved by a newer version falls back to dark
    expect(resolveTheme('unknown' as never, true)).toBe('dark')
  })

  it('knows which themes are light', () => {
    expect([schemeOf('dark'), schemeOf('light'), schemeOf('nord'), schemeOf('solarized')]).toEqual(['dark', 'light', 'dark', 'light'])
  })
})

describe('accent colour', () => {
  it('parses short and long hex colours', () => {
    expect(parseHex('#5e91ff')).toEqual([0x5e, 0x91, 0xff])
    expect(parseHex('#FA0')).toEqual([0xff, 0xaa, 0x00])
    expect(parseHex('fa0')).toEqual([0xff, 0xaa, 0x00])
    expect(parseHex('')).toBeNull()
    expect(parseHex('red')).toBeNull()
    expect(parseHex('#12345')).toBeNull()
  })

  it('picks readable text for a solid fill', () => {
    expect(textOn('#5e91ff')).toBe('#ffffff')
    expect(textOn('#1a1a1a')).toBe('#ffffff')
    expect(textOn('#f2ca33')).not.toBe('#ffffff')
    expect(textOn('#88c0d0')).not.toBe('#ffffff')
  })

  it('derives the accent variables, or none for the theme accent', () => {
    expect(accentVars('', 'dark')).toEqual({})
    expect(accentVars('not a colour', 'dark')).toEqual({})
    const dark = accentVars('#E5534B', 'dark')
    expect(dark['--accent']).toBe('#e5534b')
    expect(dark['--on-accent']).toBe('#ffffff')
    expect(dark['--bg-selected']).toBe('color-mix(in srgb, #e5534b 22%, transparent)')
    expect(dark['--text-accent']).toContain('white')
    const light = accentVars('#e5534b', 'light')
    expect(light['--bg-selected']).toBe('color-mix(in srgb, #e5534b 14%, transparent)')
    expect(light['--text-accent']).toContain('black')
  })
})

describe('density', () => {
  it('sets the row height', () => {
    expect(rowHeight('comfortable')).toBe(28)
    expect(rowHeight('compact')).toBe(24)
    expect(rowHeight('bogus' as never)).toBe(28)
  })
})

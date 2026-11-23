import { describe, expect, it } from 'vitest'
import { applyTextInputDefaults, isTextField, type ElementLike } from './textInputDefaults'

function el(tagName: string, attrs: Record<string, string> = {}): ElementLike & { attrs: Record<string, string> } {
  return {
    tagName,
    attrs,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
    setAttribute: (n, v) => {
      attrs[n] = v
    }
  }
}

describe('text input defaults', () => {
  it('recognises free-text fields only', () => {
    expect(isTextField(el('textarea'))).toBe(true)
    expect(isTextField(el('INPUT'))).toBe(true)
    expect(isTextField(el('input', { type: 'search' }))).toBe(true)
    expect(isTextField(el('input', { type: 'URL' }))).toBe(true)
    expect(isTextField(el('input', { type: 'checkbox' }))).toBe(false)
    expect(isTextField(el('input', { type: 'number' }))).toBe(false)
    expect(isTextField(el('div', { contenteditable: '' }))).toBe(true)
    expect(isTextField(el('div', { contenteditable: 'false' }))).toBe(false)
    expect(isTextField(el('div'))).toBe(false)
  })

  it('turns off autocorrect, capitalisation, spelling and suggestions', () => {
    const input = el('input', { type: 'text' })
    applyTextInputDefaults(input)
    expect(input.attrs).toEqual({
      type: 'text',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      writingsuggestions: 'false'
    })
  })

  it('keeps an attribute the markup sets explicitly', () => {
    const area = el('textarea', { spellcheck: 'true' })
    applyTextInputDefaults(area)
    expect(area.attrs.spellcheck).toBe('true')
    expect(area.attrs.autocorrect).toBe('off')
  })

  it('leaves non-text inputs untouched', () => {
    const box = el('input', { type: 'checkbox' })
    applyTextInputDefaults(box)
    expect(box.attrs).toEqual({ type: 'checkbox' })
  })
})

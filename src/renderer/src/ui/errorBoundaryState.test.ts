import { describe, expect, it } from 'vitest'
import { asError, errorDetails, shouldReset } from './errorBoundaryState'

describe('shouldReset', () => {
  it('resets a failed region when its key changes', () => {
    expect(shouldReset(true, '/a:graph', '/a:diff')).toBe(true)
    expect(shouldReset(true, '/a:graph', '/b:graph')).toBe(true)
  })

  it('keeps the notice while the key stays, and ignores regions that did not fail', () => {
    expect(shouldReset(true, '/a:graph', '/a:graph')).toBe(false)
    expect(shouldReset(false, '/a:graph', '/b:graph')).toBe(false)
    expect(shouldReset(true, undefined, undefined)).toBe(false)
    expect(shouldReset(true, NaN, NaN)).toBe(false)
  })
})

describe('errorDetails', () => {
  it('names the region and includes the message and both stacks', () => {
    const e = new TypeError('x is undefined')
    e.stack = 'TypeError: x is undefined\n    at DiffView (DiffView.tsx:10)'
    const text = errorDetails('The center view', e, '\n    at DiffView\n    at App', { platform: 'darwin', userAgent: 'UA' })
    expect(text).toContain('Karen: The center view failed to render')
    expect(text).toContain('Platform: darwin')
    expect(text).toContain('TypeError: x is undefined')
    expect(text).toContain('at DiffView (DiffView.tsx:10)')
    expect(text).toContain('Component stack:\n    at DiffView\n    at App')
  })

  it('leaves out what it does not have', () => {
    const e = new Error('boom')
    e.stack = undefined
    const text = errorDetails('The modals', e, null)
    expect(text).toBe('Karen: The modals failed to render\n\nError: boom')
  })
})

describe('asError', () => {
  it('keeps errors and wraps anything else', () => {
    const e = new Error('a')
    expect(asError(e)).toBe(e)
    expect(asError('text').message).toBe('text')
    expect(asError({ code: 1 }).message).toBe('{"code":1}')
    expect(asError(undefined).message).toBe('undefined')
  })
})

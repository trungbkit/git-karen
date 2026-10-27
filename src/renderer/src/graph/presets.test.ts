import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREFERENCES } from '@shared/types'

vi.mock('../state/store', () => ({ useStore: { getState: () => ({}) } }))
vi.mock('../ui/dialogs', () => ({ prompt: vi.fn() }))

const { capturePreset, graphView, matchesPreset, upsertPreset } = await import('./presets')

const repo = { hiddenRefs: ['refs/heads/b', 'refs/heads/a'], soloRefs: [] }

describe('view presets', () => {
  it('captures refs, columns, widths and graph style', () => {
    const prefs = { ...DEFAULT_PREFERENCES, showShaColumn: true, graphMode: 'compact' as const, graphColumnWidths: { author: 90 } }
    const p = capturePreset('Mine', repo, prefs)
    expect(p.hiddenRefs).toEqual(['refs/heads/a', 'refs/heads/b'])
    expect(p.view).toEqual({ ...graphView(DEFAULT_PREFERENCES), showShaColumn: true, graphMode: 'compact', graphColumnWidths: { author: 90 } })
    expect(Object.keys(p.view)).not.toContain('theme')
  })

  it('matches the current view regardless of ref and width key order', () => {
    const prefs = { ...DEFAULT_PREFERENCES, graphColumnWidths: { author: 90, date: 120 } }
    const p = capturePreset('Mine', repo, prefs)
    const reordered = { ...DEFAULT_PREFERENCES, graphColumnWidths: { date: 120, author: 90 } }
    expect(matchesPreset(p, { hiddenRefs: ['refs/heads/a', 'refs/heads/b'], soloRefs: [] }, reordered)).toBe(true)
    expect(matchesPreset(p, { hiddenRefs: [], soloRefs: [] }, prefs)).toBe(false)
    expect(matchesPreset(p, repo, { ...prefs, showAvatars: false })).toBe(false)
  })

  it('replaces a preset of the same name in place', () => {
    const a = capturePreset('A', repo, DEFAULT_PREFERENCES)
    const b = capturePreset('B', repo, DEFAULT_PREFERENCES)
    const a2 = { ...a, soloRefs: ['refs/heads/main'] }
    expect(upsertPreset([a, b], a2)).toEqual([a2, b])
    expect(upsertPreset([a], b)).toEqual([a, b])
  })
})

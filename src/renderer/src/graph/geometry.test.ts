import { describe, expect, it } from 'vitest'
import { metrics, ROW_H, rowEdgePaths } from './geometry'
import type { GraphRow } from './layout'

const row: GraphRow = {
  node: { sha: 'a', kind: 'commit', parents: ['b'] } as GraphRow['node'],
  column: 0,
  edges: [{ end: { parent: 'a', dashed: false }, start: { parent: 'b', dashed: false } }, { pass: { parent: 'c', dashed: false } }],
  isMerge: false,
  truncated: false,
  width: 2
}

describe('graph metrics by density', () => {
  it('keeps the comfortable geometry by default', () => {
    expect(metrics('rich')).toMatchObject({ rowH: ROW_H, mid: 14, innerH: 22, innerTop: 3, nodeSize: 22 })
  })

  it('shrinks rows, the inner band and avatar nodes for compact density', () => {
    expect(metrics('rich', 24)).toMatchObject({ rowH: 24, mid: 12, innerH: 18, nodeSize: 18 })
    // small dots already fit
    expect(metrics('compact', 24)).toMatchObject({ rowH: 24, nodeSize: 10 })
  })

  it('draws edges over the whole row height', () => {
    const m = metrics('rich', 24)
    const paths = rowEdgePaths(m, row, 39).map((p) => p.d)
    expect(paths).toEqual(['M39 0V12', 'M39 12V24', 'M61 0V24'])
  })
})

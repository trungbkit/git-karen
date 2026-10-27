// Graph zone geometry: lane positions and the SVG path data for one row's edges.
// Measurements: 28px rows with a 22px inner band, 22px lanes,
// 28px gutters, rounded corners where an edge turns between a lane and a node.
// The row height comes from the density preference (ui/appearance.ts, CSS --row-h).

import type { GraphRow } from './layout'

/** Row height of the comfortable density */
export const ROW_H = 28
/** Margin above and below the inner band of a row */
const BAND_MARGIN = 3

export interface GraphMetrics {
  /** Row height (px) */
  rowH: number
  /** Vertical centre of a row */
  mid: number
  /** Inner band (row minus a 3px top/bottom margin) used for nodes and the commit colour strip */
  innerH: number
  innerTop: number
  compact: boolean
  lineWidth: number
  gutter: number
  padRight: number
  colWidth: number
  nodeSize: number
  mergeSize: number
  /** Corner radius where an edge turns from vertical to horizontal */
  corner: number
}

export function metrics(mode: 'rich' | 'compact', rowH = ROW_H): GraphMetrics {
  const innerH = rowH - 2 * BAND_MARGIN
  const rows = { rowH, mid: rowH / 2, innerH, innerTop: BAND_MARGIN }
  if (mode === 'compact') {
    return { ...rows, compact: true, lineWidth: 1.5, gutter: 10, padRight: 1, colWidth: 12, nodeSize: 10, mergeSize: 8, corner: 6 }
  }
  // avatar nodes fill the inner band, so shorter rows get smaller nodes
  return { ...rows, compact: false, lineWidth: 2, gutter: 28, padRight: 3, colWidth: 22, nodeSize: Math.min(22, innerH), mergeSize: 12, corner: 8 }
}

/** Centre x of a lane. */
export function laneX(m: GraphMetrics, col: number): number {
  return m.gutter + col * m.colWidth + m.colWidth / 2
}

/** Width needed to show every lane without clipping. */
export function contentWidth(m: GraphMetrics, columns: number): number {
  return Math.max(1, columns) * m.colWidth + 2 * m.gutter + 2 * m.padRight
}

export const laneColor = (col: number) => `var(--lane-${((col % 10) + 10) % 10})`

export interface EdgePath {
  d: string
  col: number
  dashed: boolean
}

/**
 * Path data for the edges of a row. `nodeX` may differ from the node's lane centre when the
 * node is clamped into a narrowed graph column.
 */
export function rowEdgePaths(m: GraphMetrics, row: GraphRow, nodeX: number): EdgePath[] {
  const { rowH: ROW_H, mid: MID } = m
  const out: EdgePath[] = []
  row.edges.forEach((cell, col) => {
    if (!cell) return
    const x = laneX(m, col)
    const own = col === row.column
    if (cell.pass) out.push({ d: `M${x} 0V${ROW_H}`, col, dashed: cell.pass.dashed })
    if (cell.end) {
      if (own) out.push({ d: `M${x} 0V${MID}`, col, dashed: cell.end.dashed })
      else {
        // down from the top, then turn horizontally toward the node
        const r = Math.min(m.corner, Math.abs(x - nodeX))
        const dir = nodeX < x ? -1 : 1
        const sweep = dir > 0 ? 0 : 1
        out.push({ d: `M${x} 0V${MID - r}A${r} ${r} 0 0 ${sweep} ${x + dir * r} ${MID}H${nodeX}`, col, dashed: cell.end.dashed })
      }
    }
    if (cell.start) {
      if (own) out.push({ d: `M${x} ${MID}V${ROW_H}`, col, dashed: cell.start.dashed })
      else {
        // leave the node horizontally, then turn down into the parent's lane
        const r = Math.min(m.corner, Math.abs(x - nodeX))
        const dir = x > nodeX ? 1 : -1
        const sweep = dir > 0 ? 1 : 0
        out.push({ d: `M${nodeX} ${MID}H${x - dir * r}A${r} ${r} 0 0 ${sweep} ${x} ${MID + r}V${ROW_H}`, col, dashed: cell.start.dashed })
      }
    }
  })
  return out
}

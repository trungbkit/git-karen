// Graph column ("zone") definitions, in their default order.
import type { Preferences } from '@shared/types'

export type ColumnId = 'ref' | 'graph' | 'message' | 'author' | 'changes' | 'date' | 'sha'

export interface ColumnDef {
  id: ColumnId
  label: string
  min: number
  /** Default width; the message column has none because it takes the remaining space */
  width?: number
  /** Preference key that toggles the column (always shown when absent) */
  pref?: 'showAuthorColumn' | 'showChangesColumn' | 'showDateColumn' | 'showShaColumn'
}

export const COLUMNS: ColumnDef[] = [
  { id: 'ref', label: 'Branch / Tag', min: 60, width: 190 },
  { id: 'graph', label: 'Graph', min: 45 },
  { id: 'message', label: 'Commit Message', min: 120 },
  { id: 'author', label: 'Author', min: 32, width: 140, pref: 'showAuthorColumn' },
  { id: 'changes', label: 'Changes', min: 50, width: 120, pref: 'showChangesColumn' },
  { id: 'date', label: 'Date / Time', min: 50, width: 140, pref: 'showDateColumn' },
  { id: 'sha', label: 'SHA', min: 50, width: 80, pref: 'showShaColumn' }
]

export function visibleColumns(prefs: Preferences): ColumnDef[] {
  return COLUMNS.filter((c) => !c.pref || prefs[c.pref])
}

/** Max width the graph column grows to automatically (users can still drag it wider). */
export const GRAPH_AUTO_MAX = 360

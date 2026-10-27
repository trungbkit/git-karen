// The repository lists of the welcome screen: favorites, recent and discovered repositories, filtered.
// Pure: no React, no IPC.
import type { DiscoveredRepo, RecentRepo } from '@shared/types'
import { fuzzyMatch } from './fuzzy'

/** Discovered repositories listed before "Show all" (without a filter). */
export const DISCOVERED_SHOWN = 8

export interface WelcomeLists {
  favorites: RecentRepo[]
  recent: RecentRepo[]
  /** Found by the scan and not in the recent list */
  discovered: DiscoveredRepo[]
  /** Discovered repositories left out by the DISCOVERED_SHOWN cap */
  hidden: number
}

/** A repo matches on its name first, then on its whole path (fuzzy). */
export function matchesRepo(query: string, repo: { name: string; path: string }): boolean {
  return !query.trim() || fuzzyMatch(query, repo.name) !== null || fuzzyMatch(query, repo.path) !== null
}

function byScore<T extends { name: string; path: string }>(items: T[], query: string): T[] {
  if (!query.trim()) return items
  const score = (r: T) => Math.max(fuzzyMatch(query, r.name)?.score ?? -Infinity, (fuzzyMatch(query, r.path)?.score ?? -Infinity) - 100)
  return items.filter((r) => matchesRepo(query, r)).sort((a, b) => score(b) - score(a))
}

export function welcomeLists(recent: RecentRepo[], discovered: DiscoveredRepo[], query: string, showAll = false): WelcomeLists {
  const sorted = [...recent].sort((a, b) => b.lastOpened - a.lastOpened)
  const known = new Set(recent.map((r) => r.path))
  const fresh = byScore(
    discovered.filter((d) => !known.has(d.path)),
    query
  )
  const cap = showAll || query.trim() ? fresh.length : DISCOVERED_SHOWN
  return {
    favorites: byScore(
      sorted.filter((r) => r.favorite),
      query
    ),
    recent: byScore(
      sorted.filter((r) => !r.favorite),
      query
    ),
    discovered: fresh.slice(0, cap),
    hidden: Math.max(0, fresh.length - cap)
  }
}

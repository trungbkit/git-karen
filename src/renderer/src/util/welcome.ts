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

/** One or two letters for a repository's avatar: the initials of its first two words ("git-kraken" → "GK"). */
export function repoInitials(name: string): string {
  const words = name.split(/[\s._-]+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  if (words.length === 0) return '#'
  const first = (w: string) => [...w.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? ''
  return (first(words[0]) + (words[1] ? first(words[1]) : '')).toUpperCase()
}

/** A stable graph lane colour (0–9) for a repository, so its avatar keeps the same colour. */
export function repoHue(path: string): number {
  let h = 0
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0
  return h % 10
}

/** The path with the home folder written as "~" (display only). */
export function shortPath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~')
}

/** Greeting for the welcome screen by the hour of the day. */
export function greeting(hour: number): string {
  return hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

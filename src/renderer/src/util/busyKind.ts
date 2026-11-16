// Which kind of git operation a busy label ("Pushing", "Checking out main", "Stashing and pulling (rebase)") names,
// so the toolbar can show its icon and mark the button that started it. Pure: no React, no IPC.
import type { IconName } from '../ui/Icon'

export type BusyKind = 'push' | 'pull' | 'fetch' | 'checkout' | 'merge' | 'rebase' | 'cherry-pick' | 'stash' | 'branch' | 'other'

// first match wins: "Stashing and pulling" is a pull, "Force pushing" a push
const RULES: [RegExp, BusyKind][] = [
  [/\bpull/i, 'pull'],
  [/\bpush/i, 'push'],
  [/^fetch/i, 'fetch'],
  [/^checking out\b/i, 'checkout'],
  [/^merg/i, 'merge'],
  [/^rebas/i, 'rebase'],
  [/^cherry/i, 'cherry-pick'],
  [/^(stashing|applying stash|popping stash)/i, 'stash'],
  [/^(creating|renaming|deleting) branch/i, 'branch']
]

export function busyKind(label: string): BusyKind {
  return RULES.find(([re]) => re.test(label))?.[1] ?? 'other'
}

const ICONS: Record<BusyKind, IconName> = {
  push: 'push',
  pull: 'pull',
  fetch: 'fetch',
  checkout: 'branch',
  merge: 'merge',
  rebase: 'merge',
  'cherry-pick': 'commit',
  stash: 'stash',
  branch: 'branch',
  other: 'refresh'
}

export function busyIcon(kind: BusyKind): IconName {
  return ICONS[kind]
}

/** "45s", "2m 05s" */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

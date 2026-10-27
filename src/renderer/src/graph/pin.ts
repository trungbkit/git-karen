// "Pin to Left": one branch per repo whose first-parent history is kept in the left-most lane.
// Per-viewer convenience, so it lives in localStorage (keyed by repo path).
import { create } from 'zustand'

const KEY = 'kc.graph.pinned'

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

export const usePins = create<{ pinned: Record<string, string>; toggle(repo: string, fullName: string): void }>((set, get) => ({
  pinned: load(),
  toggle(repo, fullName) {
    const next = { ...get().pinned }
    if (next[repo] === fullName) delete next[repo]
    else next[repo] = fullName
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // storage unavailable: pin still applies for this session
    }
    set({ pinned: next })
  }
}))

// Small bridge so keybindings and other panels can drive the mounted graph without importing the component.

interface GraphNav {
  move(delta: number): void
  focusFilter(): void
  /** Scroll the row of `sha` into view and flash it; false when the commit is not in the graph */
  reveal(sha: string): boolean
}

let current: GraphNav | null = null
/** A reveal asked for while no graph was mounted (e.g. right before switching back to it) */
let pending: { sha: string; at: number } | null = null
const PENDING_MS = 2000

export function registerGraphNav(nav: GraphNav): () => void {
  current = nav
  if (pending && Date.now() - pending.at < PENDING_MS) nav.reveal(pending.sha)
  pending = null
  return () => {
    if (current === nav) current = null
  }
}

export function moveGraphSelection(delta: number): void {
  current?.move(delta)
}

export function focusGraphFilter(): void {
  current?.focusFilter()
}

/**
 * Scroll the graph to a commit and flash its row. Returns false when the commit is not in the graph
 * (hidden, or older than the loaded history). Without a mounted graph the reveal waits for the next one.
 */
export function scrollToSha(sha: string): boolean {
  if (current) return current.reveal(sha)
  pending = { sha, at: Date.now() }
  return true
}

export interface Viewport {
  scrollTop: number
  /** Height of the scroll container, including the sticky header */
  height: number
  headerHeight: number
  rowHeight: number
}

/** Scroll offset showing row `index`: unchanged when it is fully visible, otherwise centred. */
export function revealScrollTop(index: number, v: Viewport): number {
  const top = index * v.rowHeight
  const visibleTop = v.scrollTop
  const visibleBottom = v.scrollTop + v.height - v.headerHeight
  if (top >= visibleTop && top + v.rowHeight <= visibleBottom) return v.scrollTop
  return Math.max(0, Math.round(top - (v.height - v.headerHeight - v.rowHeight) / 2))
}

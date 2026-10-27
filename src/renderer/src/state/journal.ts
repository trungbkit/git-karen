// Undo journal: how to revert each recent destructive operation, kept for a short window after it ran.
// Pure (no store or IPC) so it can be unit tested; actions/undo.ts wires it to toasts and git.

export const UNDO_WINDOW_MS = 10_000

export interface UndoEntry {
  id: number
  repo: string
  /** What gets undone, e.g. "Hard reset main" */
  label: string
  /** Epoch ms after which the entry can no longer be used */
  expires: number
  undo(repo: string): Promise<void>
}

export class Journal {
  private entries: UndoEntry[] = []
  private seq = 0

  /**
   * Record an operation. Older entries of the same repo are dropped: they captured the state before this
   * operation, so replaying them now would also revert it.
   */
  push(e: Pick<UndoEntry, 'repo' | 'label' | 'undo'>, now = Date.now(), ttl = UNDO_WINDOW_MS): UndoEntry {
    const entry: UndoEntry = { ...e, id: ++this.seq, expires: now + ttl }
    this.entries = this.entries.filter((x) => x.repo !== e.repo && x.expires > now).concat(entry)
    return entry
  }

  /** A live entry, or null when unknown, superseded or expired. */
  get(id: number, now = Date.now()): UndoEntry | null {
    return this.entries.find((e) => e.id === id && e.expires > now) ?? null
  }

  /** Remove and return a live entry: each one can be undone once. */
  take(id: number, now = Date.now()): UndoEntry | null {
    const entry = this.get(id, now)
    this.entries = this.entries.filter((e) => e.id !== id && e.expires > now)
    return entry
  }

  /** The newest live entry of a repo. */
  latest(repo: string, now = Date.now()): UndoEntry | null {
    return this.entries.findLast((e) => e.repo === repo && e.expires > now) ?? null
  }

  /** Forget a repo's entries (its tab was closed). */
  clear(repo: string): void {
    this.entries = this.entries.filter((e) => e.repo !== repo)
  }

  get size(): number {
    return this.entries.length
  }
}

// Runs at most one job per key at a time. Calls made while a job runs are folded into a single follow-up run.

interface Slot<O> {
  /** The run in flight */
  current: Promise<void>
  /** The follow-up run, waiting for `current` to finish; calls made meanwhile merge their options into it */
  next: { opts: O; done: Promise<void> } | null
}

/**
 * Wraps `run` so that, per key, runs never overlap: a call while one is in flight marks a follow-up run (its options
 * merged with `merge`) that starts once the current one finishes, and resolves when that follow-up is done. Results
 * therefore land in call order, and the promise a caller gets settles only after a run that started after the call.
 * `run` must handle its own errors; a rejection is swallowed so the queue keeps going.
 */
export function coalesce<K, O>(run: (key: K, opts: O) => Promise<void>, merge: (a: O, b: O) => O) {
  const slots = new Map<K, Slot<O>>()

  function launch(key: K, opts: O, slot: Slot<O>): Promise<void> {
    const p: Promise<void> = run(key, opts)
      .catch(() => undefined)
      .finally(() => {
        if (slot.current === p && !slot.next) slots.delete(key)
      })
    slot.current = p
    return p
  }

  return function request(key: K, opts: O): Promise<void> {
    const slot = slots.get(key)
    if (!slot) {
      const fresh: Slot<O> = { current: Promise.resolve(), next: null }
      slots.set(key, fresh)
      return launch(key, opts, fresh)
    }
    if (slot.next) {
      slot.next.opts = merge(slot.next.opts, opts)
      return slot.next.done
    }
    const next: NonNullable<Slot<O>['next']> = { opts, done: Promise.resolve() }
    next.done = slot.current.then(() => {
      slot.next = null
      return launch(key, next.opts, slot)
    })
    slot.next = next
    return next.done
  }
}

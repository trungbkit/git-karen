// Progress of long git operations (clone, fetch, pull, push), from the `--progress` lines the backend streams.
import { useEffect } from 'react'
import { create } from 'zustand'
import { reduceProgress, type OperationProgress } from '../util/progress'

/** Latest progress by repo path (a clone's is under its destination folder). */
export const useProgress = create<Record<string, OperationProgress>>(() => ({}))

/** Forget a repo's progress (when an operation starts or ends). */
export function clearProgress(repo: string) {
  if (!useProgress.getState()[repo]) return
  useProgress.setState((s) => {
    const { [repo]: _gone, ...rest } = s
    return rest
  }, true)
}

/** Listen to the backend's progress events for the lifetime of the app. */
export function useProgressEvents() {
  useEffect(
    () =>
      window.app.onProgress((e) => {
        useProgress.setState((s) => ({ [e.repo]: reduceProgress(s[e.repo], e.op, e.message) }))
      }),
    []
  )
}

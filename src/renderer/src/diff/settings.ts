// Diff view toggles shared by every diff (file diff, compare, history): stored per machine and kept in sync between
// views that are open at the same time, so "Ignore whitespace" set in one applies everywhere.
import { useCallback, useSyncExternalStore } from 'react'

export function readLocal(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable
  }
}

// values set this session, which also hold when storage is unavailable
const session = new Map<string, string>()
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** A stored on/off setting ('1' / '0'). */
export function useStoredFlag(key: string, fallback = false): [boolean, (on: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => session.get(key) ?? readLocal(key, fallback ? '1' : '0'))
  const set = useCallback(
    (on: boolean) => {
      session.set(key, on ? '1' : '0')
      writeLocal(key, on ? '1' : '0')
      listeners.forEach((l) => l())
    },
    [key]
  )
  return [value === '1', set]
}

/** Show diffs without whitespace changes (`git diff -w`) */
export const IGNORE_WHITESPACE_KEY = 'kc:diffIgnoreWs'
export const WRAP_KEY = 'kc:diffWrap'

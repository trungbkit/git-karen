// Credential prompts from git and ssh waiting for the user (src-tauri/src/askpass.rs). Every window gets each prompt;
// the first answer wins and the backend then withdraws it everywhere.
import { useEffect } from 'react'
import { create } from 'zustand'
import type { AskPassPrompt } from '@shared/types'

/** Prompts in arrival order; the dialog shows the first. Answers are never stored here. */
export const useAskPass = create<{ queue: AskPassPrompt[] }>(() => ({ queue: [] }))

function remove(id: number) {
  useAskPass.setState((s) => ({ queue: s.queue.filter((p) => p.id !== id) }))
}

/** Reply to a prompt (null cancels it) and take it off the queue at once. */
export function answerPrompt(id: number, answer: string | null) {
  remove(id)
  void window.app.answerAskPass(id, answer)
}

/** Listen for prompts for the lifetime of the app. */
export function useAskPassEvents() {
  useEffect(() => {
    const offPrompt = window.app.onAskPass((p) => useAskPass.setState((s) => ({ queue: [...s.queue.filter((q) => q.id !== p.id), p] })))
    const offDone = window.app.onAskPassDone(remove)
    return () => {
      offPrompt()
      offDone()
    }
  }, [])
}

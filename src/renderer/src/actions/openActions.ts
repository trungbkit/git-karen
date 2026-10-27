// Repositories opened from outside the window: `karen [path]`, karen://open?path=… links and files or
// folders dropped on the window. The backend queues them (src-tauri/src/launch.rs); this window takes them.
import { useEffect, useState } from 'react'
import type { OpenRequest } from '@shared/types'
import { useStore } from '../state/store'
import { confirm } from '../ui/dialogs'
import { basename } from '../util/format'

const store = () => useStore.getState()

/** Paths the user already opened in the app (an open tab or the recent list). */
function known(path: string): boolean {
  const s = store()
  return s.tabs.includes(path) || s.recent.some((r) => r.path === path)
}

async function openRequest(req: OpenRequest) {
  // a web page can start a link: never open an unknown folder from one without asking
  if (req.source === 'link' && !known(req.path)) {
    const ok = await confirm(
      `Open ${basename(req.path)}?`,
      `A link asks to open ${req.path}. Opening a repository runs git in it, and a repository's own configuration can make git run programs. Only open repositories you trust.`,
      { confirmLabel: 'Open' }
    )
    if (!ok) return
  }
  // git.open resolves a file or a subfolder to the repository around it
  await store().openRepo(req.path).catch(() => undefined)
}

async function takeAll() {
  for (const req of await window.app.takeOpenRequests()) await openRequest(req)
}

/** Open what the backend queued once the last session's tabs are back, then whenever it signals more. */
export function useOpenRequests() {
  const restored = useStore((s) => s.restored)
  useEffect(() => {
    if (!restored) return
    void takeAll()
    return window.app.onOpenRequests(() => void takeAll())
  }, [restored])
}

/**
 * Whether files are being dragged over the window (from Finder or a file manager). The page does not accept the drop:
 * the webview then navigates to the dropped file, which the backend turns into an open request.
 */
export function useFileDragHint(): boolean {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    let depth = 0
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!isFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const end = () => {
      depth = 0
      setDragging(false)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', end)
    window.addEventListener('dragend', end)
    window.addEventListener('blur', end)
    const off = window.app.onOpenRequests(end)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', end)
      window.removeEventListener('dragend', end)
      window.removeEventListener('blur', end)
      off()
    }
  }, [])
  return dragging
}

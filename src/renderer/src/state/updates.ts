// App updates: mirrors the backend's update status (src-tauri/src/updater.rs), announces a downloaded update, and
// runs the manual check (menu, command palette, Preferences).
import { useEffect } from 'react'
import { create } from 'zustand'
import { RELEASES_URL, type UpdateStatus } from '@shared/types'
import { useStore } from './store'
import { useTerminals } from './terminals'
import { confirm } from '../ui/dialogs'

export const useUpdate = create<{ status: UpdateStatus | null }>(() => ({ status: null }))

export const releaseUrl = (version: string | null) => (version ? `${RELEASES_URL}/tag/v${version}` : RELEASES_URL)
export const openReleaseNotes = (version: string | null) => void window.app.openExternal(releaseUrl(version)).catch(() => undefined)

/** "42%" of a download, or the megabytes so far when the size is unknown */
export function downloadProgress(s: UpdateStatus): string {
  if (s.total) return `${Math.min(100, Math.floor((s.downloaded / s.total) * 100))}%`
  return `${(s.downloaded / 1_048_576).toFixed(1)} MB`
}

/** Install the downloaded update and restart. Asks first when terminals are open: they are closed on restart. */
export async function restartToUpdate() {
  const version = useUpdate.getState().status?.version
  if (useTerminals.getState().sessions.some((t) => !t.exited)) {
    const ok = await confirm(`Restart to install Karen ${version ?? ''}?`, 'Built-in terminals are closed, and whatever runs in them is stopped.', {
      confirmLabel: 'Restart'
    })
    if (!ok) return
  }
  try {
    await window.app.installUpdate()
  } catch (e) {
    useStore.getState().toast({ kind: 'error', title: 'Could not install the update', message: (e as Error).message })
  }
}

function announceReady(s: UpdateStatus) {
  useStore.getState().toast({
    kind: 'info',
    title: `Karen ${s.version} is ready to install`,
    message: 'Restart now, or keep working and restart later from the status bar.',
    actions: [
      { label: 'Restart now', run: () => void restartToUpdate() },
      { label: "What's new", run: () => openReleaseNotes(s.version) }
    ],
    duration: 20_000
  })
}

/** Fetch the update the last check found; a failure is reported, success is announced by the status event. */
export async function downloadUpdate() {
  const s = await window.app.downloadUpdate()
  if (s.phase === 'available' && s.error) {
    useStore.getState().toast({
      kind: 'error',
      title: `Could not download Karen ${s.version}`,
      message: s.error,
      actions: [{ label: 'Retry', run: () => void downloadUpdate() }]
    })
  }
}

/** Menu / command palette: check now and say what came of it. */
export async function checkForUpdatesNow() {
  const { toast } = useStore.getState()
  const before = useUpdate.getState().status
  if (before?.phase === 'ready') return announceReady(before)
  if (before?.phase === 'downloading') return toast({ kind: 'info', title: `Downloading Karen ${before.version}…`, message: `${downloadProgress(before)} done.` })
  const s = await window.app.checkForUpdates(false)
  switch (s.phase) {
    case 'upToDate':
      return toast({ kind: 'success', title: 'Karen is up to date', message: `Version ${s.currentVersion} is the latest release.` })
    case 'ready':
      return announceReady(s)
    case 'available':
      toast({
        kind: 'info',
        title: `Karen ${s.version} is available`,
        message: s.canInstall
          ? 'Downloading it in the background; Karen asks to restart once it is ready.'
          : 'Development builds are not updated; install the release by hand.',
        actions: [{ label: "What's new", run: () => openReleaseNotes(s.version) }],
        duration: 8000
      })
      if (s.canInstall) await downloadUpdate()
      return
    case 'error':
      return toast({ kind: 'error', title: 'Could not check for updates', message: s.error ?? undefined })
  }
}

/** Keeps `useUpdate` current and announces an update once it is downloaded (in the focused window). */
export function useUpdateEvents() {
  useEffect(() => {
    let seen = false
    let announced: string | null = null
    const apply = (s: UpdateStatus) => {
      if (s.phase === 'ready' && s.version !== announced) {
        // the first status this window sees is not news: a download finished earlier was announced already
        if (seen && document.hasFocus()) announceReady(s)
        announced = s.version
      }
      seen = true
      useUpdate.setState({ status: s })
    }
    const off = window.app.onUpdateStatus(apply)
    void window.app.updateStatus().then((s) => seen || apply(s), () => undefined)
    return off
  }, [])
}

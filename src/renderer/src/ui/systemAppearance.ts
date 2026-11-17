// The window's link to OS appearance: settings pages cannot read (macOS accent colour, Reduce transparency,
// Increase contrast), whether the window is active, and the native window background behind the page.
import { useEffect, useState } from 'react'
import type { SystemAppearance } from '@shared/types'

const DEFAULT: SystemAppearance = { accentColor: null, reduceTransparency: false, increaseContrast: false }

const same = (a: SystemAppearance, b: SystemAppearance) =>
  a.accentColor === b.accentColor && a.reduceTransparency === b.reduceTransparency && a.increaseContrast === b.increaseContrast

/**
 * The OS appearance settings. They are changed in System Settings, so they are read again whenever the window
 * becomes active; the media queries WebKit has (`prefers-contrast`, `prefers-reduced-transparency`) count too.
 */
export function useSystemAppearance(): SystemAppearance {
  const [system, setSystem] = useState(DEFAULT)
  useEffect(() => {
    let alive = true
    const contrast = window.matchMedia('(prefers-contrast: more)')
    const transparency = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const read = () =>
      void window.app
        .systemAppearance()
        .catch(() => DEFAULT)
        .then((s) => {
          if (!alive) return
          const next = {
            accentColor: s.accentColor,
            reduceTransparency: s.reduceTransparency || transparency.matches,
            increaseContrast: s.increaseContrast || contrast.matches
          }
          setSystem((prev) => (same(prev, next) ? prev : next))
        })
    read()
    window.addEventListener('focus', read)
    contrast.addEventListener('change', read)
    transparency.addEventListener('change', read)
    return () => {
      alive = false
      window.removeEventListener('focus', read)
      contrast.removeEventListener('change', read)
      transparency.removeEventListener('change', read)
    }
  }, [])
  return system
}

/** `data-window-active` on <html>: false while another window or app has focus (styles grey out selections). */
export function useWindowActive() {
  useEffect(() => {
    const root = document.documentElement
    const set = (active: boolean) => () => void (root.dataset.windowActive = String(active))
    const on = set(true)
    const off = set(false)
    set(document.hasFocus())()
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])
}

let lastBackground = ''

/** Give the native window the theme's --bg-app (call after the theme is applied); it is also kept for new windows. */
export function syncWindowBackground() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()
  if (!bg || bg === lastBackground) return
  lastBackground = bg
  void window.app.setWindowBackground(bg).catch(() => {
    lastBackground = ''
  })
}

// Draggable divider between the main layout columns. While dragging, the width is written straight to a
// CSS variable on the layout container (no React render per mousemove); it is persisted on release.
import type { KeyboardEvent, MouseEvent } from 'react'

/** Width the center column always keeps; the side panels give way first. */
export const CENTER_MIN = 360

interface Props {
  /** Which panel this splitter resizes: it sits right of the left panel / left of the right panel */
  side: 'left' | 'right'
  /** CSS variable on the layout container that holds the panel width */
  cssVar: string
  width: number
  min: number
  defaultWidth: number
  onCommit: (width: number) => void
}

export function Splitter({ side, cssVar, width, min, defaultWidth, onCommit }: Props) {
  const panelOf = (el: HTMLElement) => (side === 'left' ? el.previousElementSibling : el.nextElementSibling) as HTMLElement
  const maxFor = (el: HTMLElement) => {
    const body = el.parentElement!
    const center = body.querySelector<HTMLElement>(':scope > .center')
    const room = (center?.getBoundingClientRect().width ?? 0) - CENTER_MIN
    return Math.max(min, panelOf(el).getBoundingClientRect().width + room)
  }

  const startResize = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const body = el.parentElement!
    const startX = e.clientX
    const start = panelOf(el).getBoundingClientRect().width
    const max = maxFor(el)
    let latest = start
    const move = (ev: globalThis.MouseEvent) => {
      const dx = ev.clientX - startX
      latest = Math.round(Math.min(max, Math.max(min, start + (side === 'left' ? dx : -dx))))
      body.style.setProperty(cssVar, `${latest}px`)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing-col')
      el.classList.remove('active')
      if (latest !== width) onCommit(latest)
    }
    document.body.classList.add('resizing-col')
    el.classList.add('active')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight'
    if (e.key !== grow && e.key !== shrink) return
    e.preventDefault()
    const next = width + (e.key === grow ? step : -step)
    onCommit(Math.min(maxFor(e.currentTarget), Math.max(min, next)))
  }

  return (
    <div
      className={`splitter splitter-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onMouseDown={startResize}
      onDoubleClick={() => onCommit(defaultWidth)}
      onKeyDown={onKeyDown}
    />
  )
}

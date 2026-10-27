// Roving tabindex: a list or tree is one Tab stop; arrow keys move between its rows. Works on the DOM (rows are
// found by a selector), so rows keep their own click / context menu handlers and need no extra props.
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { contextMenuFromKeyboard } from './ContextMenu'

interface Options {
  /** Selector of the rows inside the container */
  items: string
  /** Left/Right move between items instead of Up/Down (tab strips) */
  horizontal?: boolean
}

const isTyping = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

/**
 * Up/Down (or Left/Right), Home/End move focus between rows; Enter and Space click the row; Shift+F10 and the
 * context menu key open its context menu. In trees, Right/Left on a row with `aria-expanded` opens / closes it.
 * The row that had focus last (or the selected one) is the one Tab lands on.
 */
export function useRovingFocus(container: RefObject<HTMLElement | null>, { items, horizontal = false }: Options) {
  // the container may mount after the component (conditional rendering): follow whatever the ref holds
  const [root, setRoot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (container.current !== root) setRoot(container.current)
  })
  useEffect(() => {
    if (!root) return
    let current: HTMLElement | null = null
    const rows = () => [...root.querySelectorAll<HTMLElement>(items)].filter((el) => el.offsetParent !== null || el === document.activeElement)

    // exactly one row is reachable with Tab: the last focused one, else the selected one, else the first
    const sync = () => {
      const all = rows()
      if (!current || !root.contains(current)) {
        current = all.find((el) => el.getAttribute('aria-selected') === 'true' || el.classList.contains('selected')) ?? all[0] ?? null
      }
      for (const el of all) {
        const want = el === current ? '0' : '-1'
        if (el.getAttribute('tabindex') !== want) el.setAttribute('tabindex', want)
      }
    }
    const focusRow = (el: HTMLElement | undefined) => {
      if (!el) return
      current = el
      sync()
      el.focus()
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }

    const onFocusIn = (e: FocusEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(items)
      if (row && root.contains(row) && row !== current) {
        current = row
        sync()
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target)) return
      const row = e.target as HTMLElement
      // keys on buttons inside a row belong to the buttons
      if (!row.matches(items)) return
      const all = rows()
      const i = all.indexOf(row)
      const next = horizontal ? 'ArrowRight' : 'ArrowDown'
      const prev = horizontal ? 'ArrowLeft' : 'ArrowUp'
      const expanded = row.getAttribute('aria-expanded')
      let handled = true
      if (e.altKey || e.metaKey || e.ctrlKey) handled = false
      else if (e.key === next) focusRow(all[Math.min(all.length - 1, i + 1)])
      else if (e.key === prev) focusRow(all[Math.max(0, i - 1)])
      else if (e.key === 'Home') focusRow(all[0])
      else if (e.key === 'End') focusRow(all[all.length - 1])
      else if (e.key === 'Enter' || e.key === ' ') row.click()
      else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) contextMenuFromKeyboard(row)
      else if (!horizontal && e.key === 'ArrowRight' && expanded === 'false') row.click()
      else if (!horizontal && e.key === 'ArrowLeft' && expanded === 'true') row.click()
      else handled = false
      if (handled) e.preventDefault()
    }

    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { childList: true, subtree: true })
    root.addEventListener('focusin', onFocusIn)
    root.addEventListener('keydown', onKeyDown)
    return () => {
      observer.disconnect()
      root.removeEventListener('focusin', onFocusIn)
      root.removeEventListener('keydown', onKeyDown)
    }
  }, [root, items, horizontal])
}

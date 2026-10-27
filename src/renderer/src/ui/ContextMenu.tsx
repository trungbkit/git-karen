// Imperative context menu: `showContextMenu(event, items)`. Keyboard: arrows move, Enter/Space run an item,
// Right/Left open and close submenus, Escape or Tab closes; focus goes back to where it was.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { create } from 'zustand'

export type MenuItem =
  | { label: string; onClick(): void; disabled?: boolean; danger?: boolean; hint?: string }
  | { label: string; submenu: MenuItem[]; disabled?: boolean }
  | 'separator'
  | null
  | false
  | undefined

interface OpenMenu {
  x: number
  y: number
  items: MenuItem[]
  /** Opened from the keyboard: the first item gets focus right away */
  keyboard: boolean
  /** Focused element to return to when the menu closes */
  returnFocus: HTMLElement | null
}

const useMenu = create<{ menu: OpenMenu | null }>(() => ({ menu: null }))

let fromKeyboard = false

export function showContextMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) {
  e.preventDefault()
  const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items, keyboard: fromKeyboard, returnFocus: active } })
  fromKeyboard = false
}

/** Open the context menu of an element as a right-click on it would (Shift+F10 / the context menu key). */
export function contextMenuFromKeyboard(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  fromKeyboard = true
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + Math.min(24, r.width / 2), clientY: r.bottom - 2 }))
  // no handler opened a menu
  fromKeyboard = false
}

function closeMenu(restoreFocus: boolean) {
  const menu = useMenu.getState().menu
  useMenu.setState({ menu: null })
  if (restoreFocus && menu?.returnFocus?.isConnected) menu.returnFocus.focus()
}

export function ContextMenuHost() {
  const menu = useMenu((s) => s.menu)
  useEffect(() => {
    if (!menu) return
    const close = () => closeMenu(false)
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        closeMenu(true)
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !document.activeElement?.closest('.ctx-menu')) {
        // menu opened with the mouse: the arrows move into it instead of the list behind it
        const entries = document.querySelectorAll<HTMLElement>('.ctx-menu > [role="menuitem"]:not([aria-disabled="true"])')
        e.preventDefault()
        e.stopPropagation()
        entries[e.key === 'ArrowDown' ? 0 : entries.length - 1]?.focus()
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [menu])
  if (!menu) return null
  return <MenuList x={menu.x} y={menu.y} items={menu.items} autoFocus={menu.keyboard} />
}

type CleanItem = Exclude<MenuItem, null | false | undefined>

function MenuList({ x, y, items, autoFocus, onLeave }: { x: number; y: number; items: MenuItem[]; autoFocus: boolean; onLeave?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [open, setOpen] = useState<{ index: number; keyboard: boolean } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    })
    // opened from the keyboard: start on the first item (after a right-click, the arrow keys move into the menu)
    if (autoFocus) el.querySelector<HTMLElement>(':scope > [role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true })
  }, [x, y, autoFocus])

  const clean = items.filter((i): i is CleanItem => Boolean(i))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    // a submenu handles its own keys
    if ((e.target as HTMLElement).closest('.ctx-menu') !== el) return
    const entries = [...el.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not([aria-disabled="true"])')]
    const i = entries.indexOf(document.activeElement as HTMLElement)
    const item = document.activeElement as HTMLElement
    const move = (to: number) => entries[(to + entries.length) % entries.length]?.focus()
    if (e.key === 'ArrowDown') move(i + 1)
    else if (e.key === 'ArrowUp') move(i < 0 ? -1 : i - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(-1)
    else if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') && i >= 0) {
      if (item.dataset.index && item.getAttribute('aria-haspopup')) setOpen({ index: Number(item.dataset.index), keyboard: true })
      else if (e.key !== 'ArrowRight') item.click()
    } else if (e.key === 'ArrowLeft' && onLeave) onLeave()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {clean.map((item, i) => {
        if (item === 'separator') return <div key={i} className="ctx-sep" role="separator" />
        if ('submenu' in item) {
          return (
            <div
              key={i}
              data-index={i}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open?.index === i}
              aria-disabled={item.disabled || undefined}
              tabIndex={-1}
              className={`ctx-item ctx-sub ${item.disabled ? 'disabled' : ''}`}
              onMouseEnter={() => setOpen({ index: i, keyboard: false })}
            >
              <span>{item.label}</span>
              <span aria-hidden>›</span>
              {open?.index === i && (
                <SubMenu
                  parent={ref}
                  index={i}
                  items={item.submenu}
                  autoFocus={open.keyboard}
                  onLeave={() => {
                    setOpen(null)
                    ref.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus()
                  }}
                />
              )}
            </div>
          )
        }
        return (
          <div
            key={i}
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            tabIndex={-1}
            className={`ctx-item ${item.disabled ? 'disabled' : ''} ${item.danger ? 'danger' : ''}`}
            onMouseEnter={() => setOpen(null)}
            onClick={() => {
              if (item.disabled) return
              closeMenu(true)
              item.onClick()
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span className="muted">{item.hint}</span>}
          </div>
        )
      })}
    </div>
  )
}

function SubMenu({ parent, index, items, autoFocus, onLeave }: { parent: React.RefObject<HTMLDivElement | null>; index: number; items: MenuItem[]; autoFocus: boolean; onLeave(): void }) {
  const p = parent.current?.getBoundingClientRect()
  const row = parent.current?.querySelector(`[data-index="${index}"]`)?.getBoundingClientRect()
  if (!p || !row) return null
  return <MenuList x={p.right - 2} y={row.top - 4} items={items} autoFocus={autoFocus} onLeave={onLeave} />
}

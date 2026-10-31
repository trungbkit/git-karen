// Appearance preferences (theme, accent colour, density) turned into attributes and CSS variables on <html>.
// Pure helpers apart from applyAppearance(); styles/theme.css holds the colours of each theme.
import type { Preferences, ThemeName } from '@shared/types'

/** Light or dark: picks syntax highlighting colours and how a custom accent is shaded. */
export type Scheme = 'dark' | 'light'

export const THEMES: { id: ThemeName; label: string; scheme: Scheme }[] = [
  { id: 'dark', label: 'Dark', scheme: 'dark' },
  { id: 'light', label: 'Light', scheme: 'light' },
  { id: 'nord', label: 'Nord', scheme: 'dark' },
  { id: 'solarized', label: 'Solarized Light', scheme: 'light' }
]

/** Accent swatches offered in Preferences (any colour can be picked). */
export const ACCENT_PRESETS = ['#5e91ff', '#2aa198', '#4fbf72', '#e3a33b', '#e5534b', '#d33682', '#9b6cf0', '#88c0d0']

/** Row height (px) of the graph and file lists per density; the left panel uses 4px less. */
export const DENSITY: Record<Preferences['density'], number> = { comfortable: 28, compact: 24 }

export function rowHeight(density: Preferences['density']): number {
  return DENSITY[density] ?? DENSITY.comfortable
}

/** The theme shown: 'system' follows the OS dark/light setting. */
export function resolveTheme(theme: Preferences['theme'], systemDark: boolean): ThemeName {
  if (theme === 'system') return systemDark ? 'dark' : 'light'
  return THEMES.some((t) => t.id === theme) ? theme : 'dark'
}

export function schemeOf(theme: ThemeName): Scheme {
  return THEMES.find((t) => t.id === theme)?.scheme ?? 'dark'
}

/** `#rgb` / `#rrggbb` as [r, g, b] (0-255), or null. */
export function parseHex(color: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

/** WCAG relative luminance (0 = black, 1 = white). */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const DARK_TEXT = '#14161b'

/**
 * Text on a solid fill of `color`: white while it keeps a 3:1 contrast (WCAG for UI components and bold text, and
 * what buttons on mid-tone accents usually use), near-black on light colours.
 */
export function textOn(color: string): string {
  const rgb = parseHex(color)
  if (!rgb) return '#ffffff'
  return 1.05 / (luminance(rgb) + 0.05) >= 3 ? '#ffffff' : DARK_TEXT
}

/** Variables a custom accent overrides; empty when the colour is unset or invalid (the theme's accent applies). */
export function accentVars(color: string, scheme: Scheme): Record<string, string> {
  const rgb = parseHex(color)
  if (!rgb) return {}
  const c = `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  const dark = scheme === 'dark'
  return {
    '--accent': c,
    '--on-accent': textOn(c),
    '--text-accent': dark ? `color-mix(in srgb, ${c} 72%, white)` : `color-mix(in srgb, ${c} 86%, black)`,
    '--bg-selected': `color-mix(in srgb, ${c} ${dark ? 22 : 14}%, transparent)`,
    '--bg-selected-strong': `color-mix(in srgb, ${c} ${dark ? 38 : 26}%, transparent)`,
    '--term-cursor': c
  }
}

const ACCENT_KEYS = Object.keys(accentVars('#000', 'dark'))

/** CSS font stack: the user's family (quotes and other CSS-breaking characters removed) ahead of the built-in stack; empty keeps the built-in one. */
export function fontStack(family: string, builtIn: string): string {
  const name = family.replace(/["'\\;{}<>]/g, '').trim()
  return name ? `"${name}", ${builtIn}` : builtIn
}

/** Apply theme, accent and density to <html>. `systemDark` is the OS setting (`prefers-color-scheme`). */
export function applyAppearance(prefs: Pick<Preferences, 'theme' | 'accentColor' | 'density'>, systemDark: boolean) {
  const root = document.documentElement
  const theme = resolveTheme(prefs.theme, systemDark)
  const scheme = schemeOf(theme)
  root.dataset.theme = theme
  root.dataset.scheme = scheme
  root.dataset.density = prefs.density
  root.style.setProperty('--row-h', `${rowHeight(prefs.density)}px`)
  const vars = accentVars(prefs.accentColor, scheme)
  for (const key of ACCENT_KEYS) {
    if (vars[key]) root.style.setProperty(key, vars[key])
    else root.style.removeProperty(key)
  }
}

/** 'smooth', or 'auto' when the system asks for reduced motion (CSS scroll-behavior does not reach scrollTo calls). */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

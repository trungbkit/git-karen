// Lazily-created Shiki highlighter using the JavaScript regex engine (no WASM, CSP-safe).
// Grammars and themes are loaded on first use, each from its own chunk.
import type { HighlighterCore, LanguageRegistration, ThemeRegistration } from 'shiki/core'
import { LANGUAGE_LOADERS, languageForPath } from './languages'
import { hashText, type Token } from './tokens'

export type ThemeKind = 'dark' | 'light'

const THEMES: Record<ThemeKind, { name: string; load: () => Promise<{ default: unknown }> }> = {
  dark: { name: 'github-dark-default', load: () => import('shiki/themes/github-dark-default.mjs') },
  light: { name: 'github-light-default', load: () => import('shiki/themes/github-light-default.mjs') }
}

/** Inputs above these limits are shown without highlighting. */
export const MAX_LINES = 5000
export const MAX_BYTES = 500_000

let highlighter: Promise<HighlighterCore> | null = null
const loadedLangs = new Map<string, Promise<boolean>>()
const loadedThemes = new Map<ThemeKind, Promise<void>>()

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript')
    ])
    return createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) })
  })()
  return highlighter
}

function ensureLanguage(hl: HighlighterCore, lang: string): Promise<boolean> {
  let p = loadedLangs.get(lang)
  if (!p) {
    const loader = LANGUAGE_LOADERS[lang]
    p = loader
      ? loader()
          .then((m) => hl.loadLanguage(m.default as LanguageRegistration[]))
          .then(() => true)
          .catch(() => false)
      : Promise.resolve(false)
    loadedLangs.set(lang, p)
  }
  return p
}

function ensureTheme(hl: HighlighterCore, kind: ThemeKind): Promise<void> {
  let p = loadedThemes.get(kind)
  if (!p) {
    p = THEMES[kind].load().then((m) => hl.loadTheme(m.default as ThemeRegistration))
    loadedThemes.set(kind, p)
  }
  return p
}

// Small LRU cache: tokenizing the same diff side or blame file twice is common (refreshes, toggles).
const CACHE_SIZE = 64
const cache = new Map<string, Token[][]>()

function cacheGet(key: string): Token[][] | undefined {
  const v = cache.get(key)
  if (v) {
    cache.delete(key)
    cache.set(key, v)
  }
  return v
}

function cachePut(key: string, value: Token[][]) {
  cache.set(key, value)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
}

/** True when the text is small enough to highlight. */
export function withinLimits(text: string): boolean {
  if (text.length > MAX_BYTES) return false
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines > MAX_LINES) return false
  return true
}

/**
 * Tokenizes `text` as the language inferred from `path`. Returns one token array per line,
 * or null when the language is unknown, the input is too large, or tokenizing fails.
 */
export async function tokenizeLines(path: string, text: string, theme: ThemeKind): Promise<Token[][] | null> {
  const lang = languageForPath(path)
  if (!lang || !withinLimits(text)) return null
  const key = `${lang}|${theme}|${hashText(text)}`
  const hit = cacheGet(key)
  if (hit) return hit
  try {
    const hl = await getHighlighter()
    const [ok] = await Promise.all([ensureLanguage(hl, lang), ensureTheme(hl, theme)])
    if (!ok) return null
    const lines = hl.codeToTokensBase(text, { lang, theme: THEMES[theme].name })
    const tokens: Token[][] = lines.map((line) =>
      line.map((t) => ({ content: t.content, color: t.color, fontStyle: t.fontStyle && t.fontStyle > 0 ? t.fontStyle : undefined }))
    )
    cachePut(key, tokens)
    return tokens
  } catch {
    return null
  }
}

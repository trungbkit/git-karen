import { useEffect, useMemo, useState } from 'react'
import type { FileDiff } from '@shared/types'
import { useStore } from '../state/store'
import { tokenizeLines, type ThemeKind } from './highlighter'
import { diffSides, mapDiffTokens, type Token } from './tokens'

function currentTheme(): ThemeKind {
  return document.documentElement.dataset.scheme === 'light' ? 'light' : 'dark'
}

/** Light or dark (follows `data-scheme` on <html>, which ui/appearance.ts sets from the theme preference). */
export function useThemeKind(): ThemeKind {
  const [theme, setTheme] = useState<ThemeKind>(currentTheme)
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(currentTheme()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

export function useSyntaxEnabled(): boolean {
  return useStore((s) => s.prefs.syntaxHighlighting)
}

/** Tokens per line of `text` (null until ready, or when the file isn't highlightable). */
export function useTokens(path: string, text: string | null | undefined): Token[][] | null {
  const enabled = useSyntaxEnabled()
  const theme = useThemeKind()
  const [tokens, setTokens] = useState<Token[][] | null>(null)
  useEffect(() => {
    setTokens(null)
    if (!enabled || text == null) return
    let cancelled = false
    void tokenizeLines(path, text, theme).then((t) => !cancelled && setTokens(t))
    return () => {
      cancelled = true
    }
  }, [path, text, theme, enabled])
  return tokens
}

/** Tokens for every line of a diff: result[hunk][lineIndex] (null entries render plain). */
export function useDiffTokens(diff: FileDiff | null | undefined): (Token[] | null)[][] | null {
  const enabled = useSyntaxEnabled()
  const theme = useThemeKind()
  const sides = useMemo(() => (diff && !diff.binary ? diffSides(diff) : null), [diff])
  const [result, setResult] = useState<(Token[] | null)[][] | null>(null)
  useEffect(() => {
    setResult(null)
    if (!enabled || !diff || !sides) return
    let cancelled = false
    void Promise.all([
      sides.oldText ? tokenizeLines(diff.oldPath ?? diff.path, sides.oldText, theme) : Promise.resolve(null),
      sides.newText ? tokenizeLines(diff.path, sides.newText, theme) : Promise.resolve(null)
    ]).then(([oldTokens, newTokens]) => {
      if (cancelled || (!oldTokens && !newTokens)) return
      setResult(mapDiffTokens(diff, sides, oldTokens, newTokens))
    })
    return () => {
      cancelled = true
    }
  }, [diff, sides, theme, enabled])
  return result
}

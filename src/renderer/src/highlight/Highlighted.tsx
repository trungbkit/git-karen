import type { CSSProperties } from 'react'
import { splitTokens, type Token } from './tokens'

function style(t: Token): CSSProperties | undefined {
  if (!t.color && !t.fontStyle) return undefined
  const s: CSSProperties = {}
  if (t.color) s.color = t.color
  if (t.fontStyle) {
    if (t.fontStyle & 1) s.fontStyle = 'italic'
    if (t.fontStyle & 2) s.fontWeight = 600
    if (t.fontStyle & 4) s.textDecoration = 'underline'
  }
  return s
}

/**
 * Renders a line of syntax tokens. `changed` marks intra-line change ranges, rendered with `changedClass`
 * on top of the token colours.
 */
export function TokenLine({ tokens, changed, changedClass }: { tokens: Token[]; changed?: readonly (readonly [number, number])[]; changedClass?: string }) {
  return (
    <>
      {splitTokens(tokens, changed).map((seg, i) => (
        <span key={i} className={seg.changed ? changedClass : undefined} style={style(seg)}>
          {seg.content}
        </span>
      ))}
    </>
  )
}

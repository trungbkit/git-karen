import { useMemo } from 'react'
import { parseMarkdown, type Inline } from '../util/markdown'

function Runs({ runs }: { runs: Inline[] }) {
  return (
    <>
      {runs.map((r, i) => (r.kind === 'bold' ? <b key={i}>{r.text}</b> : r.kind === 'code' ? <code key={i}>{r.text}</code> : r.text))}
    </>
  )
}

/** Renders the Markdown subset of util/markdown.ts. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className={`md ${className ?? ''}`}>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          const H = b.level <= 2 ? 'h3' : 'h4'
          return (
            <H key={i}>
              <Runs runs={b.inline} />
            </H>
          )
        }
        if (b.kind === 'code') return <pre key={i}>{b.text}</pre>
        if (b.kind === 'paragraph')
          return (
            <p key={i}>
              <Runs runs={b.inline} />
            </p>
          )
        const List = b.ordered ? 'ol' : 'ul'
        return (
          <List key={i}>
            {b.items.map((item, j) => (
              <li key={j} style={item.level ? { marginLeft: item.level * 18 } : undefined}>
                <Runs runs={item.inline} />
              </li>
            ))}
          </List>
        )
      })}
    </div>
  )
}

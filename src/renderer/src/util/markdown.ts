// The small Markdown subset AI write-ups use: headings, bullet and numbered lists (nested by indentation), fenced
// code, paragraphs, and **bold** / `code` inline. Anything else reads fine as plain text.

export type Inline = { kind: 'text' | 'bold' | 'code'; text: string }

export type Block =
  | { kind: 'heading'; level: number; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: { level: number; inline: Inline[] }[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'paragraph'; inline: Inline[] }

/** Split a line into plain, **bold** and `code` runs. Unclosed markers stay as text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const push = (kind: Inline['kind'], t: string) => {
    if (!t) return
    const last = out[out.length - 1]
    if (kind === 'text' && last?.kind === 'text') last.text += t
    else out.push({ kind, text: t })
  }
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let at = 0
  for (const m of text.matchAll(re)) {
    push('text', text.slice(at, m.index))
    if (m[1] !== undefined) push('code', m[1])
    else push('bold', m[2])
    at = m.index! + m[0].length
  }
  push('text', text.slice(at))
  return out
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r/g, '').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join(' ')) })
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*```([\w+-]*)\s*$/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i])
      blocks.push({ kind: 'code', lang: fence[1], text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length, inline: parseInline(heading[2]) })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      flush()
      const ordered = /\d/.test(item[2])
      const level = Math.min(3, Math.floor(item[1].replace(/\t/g, '  ').length / 2))
      const last = blocks[blocks.length - 1]
      const entry = { level, inline: parseInline(item[3]) }
      // nested items join the list they are under, whatever their own marker
      if (last?.kind === 'list' && (last.ordered === ordered || level > 0)) last.items.push(entry)
      else blocks.push({ kind: 'list', ordered, items: [entry] })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const last = blocks[blocks.length - 1]
    // an indented line right after a list item continues it
    if (!paragraph.length && last?.kind === 'list' && /^\s+\S/.test(line) && !/^\s*$/.test(lines[i - 1] ?? '')) {
      last.items[last.items.length - 1].inline.push(...parseInline(` ${line.trim()}`))
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}

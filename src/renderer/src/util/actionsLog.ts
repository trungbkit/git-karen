// GitHub Actions job logs: one line per output line, each prefixed with an ISO timestamp, with workflow commands
// (`##[group]`, `##[error]`, …) marking groups and annotations, and ANSI colour codes from the tools. Parsed into
// blocks (a collapsible `##[group]` or the lines between groups) for the log viewer.

export type LogLineKind = 'plain' | 'error' | 'warning' | 'notice' | 'debug' | 'command' | 'section'

export interface LogLine {
  /** 1-based line number in the log */
  n: number
  /** "12:34:56" (UTC) when the line had a timestamp */
  time: string | null
  text: string
  kind: LogLineKind
}

export interface LogBlock {
  /** The `##[group]` line; null for lines outside any group */
  title: LogLine | null
  lines: LogLine[]
  /** The block contains an error annotation */
  hasError: boolean
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const STAMP = /^﻿?(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z ?/
const COMMAND = /^##\[(group|endgroup|error|warning|notice|debug|command|section)\]/

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

export function parseActionsLog(text: string): LogBlock[] {
  const blocks: LogBlock[] = []
  let current: LogBlock | null = null
  const loose = (): LogBlock => {
    if (!current || current.title) {
      current = { title: null, lines: [], hasError: false }
      blocks.push(current)
    }
    return current
  }
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  if (raw.length && raw[raw.length - 1] === '') raw.pop()
  raw.forEach((line, i) => {
    let rest = stripAnsi(line)
    let time: string | null = null
    const stamp = STAMP.exec(rest)
    if (stamp) {
      time = stamp[2]
      rest = rest.slice(stamp[0].length)
    }
    const cmd = COMMAND.exec(rest)
    const n = i + 1
    if (cmd?.[1] === 'group') {
      current = { title: { n, time, text: rest.slice(cmd[0].length), kind: 'plain' }, lines: [], hasError: false }
      blocks.push(current)
      return
    }
    if (cmd?.[1] === 'endgroup') {
      current = null
      return
    }
    let kind: LogLineKind = 'plain'
    if (cmd) {
      kind = cmd[1] as LogLineKind
      rest = rest.slice(cmd[0].length)
    } else if (rest.startsWith('[command]')) {
      kind = 'command'
      rest = rest.slice('[command]'.length)
    }
    const block = current ?? loose()
    block.lines.push({ n, time, text: rest, kind })
    if (kind === 'error') block.hasError = true
  })
  return blocks
}

/** Line numbers containing `query` (case-insensitive), group titles included. */
export function searchLog(blocks: LogBlock[], query: string): number[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: number[] = []
  for (const b of blocks) {
    if (b.title?.text.toLowerCase().includes(q)) hits.push(b.title.n)
    for (const l of b.lines) if (l.text.toLowerCase().includes(q)) hits.push(l.n)
  }
  return hits
}

/** The plain text of the log: no timestamps, colour codes or workflow command markers. */
export function plainLog(blocks: LogBlock[]): string {
  const out: string[] = []
  for (const b of blocks) {
    if (b.title) out.push(b.title.text)
    for (const l of b.lines) out.push(l.kind === 'plain' || l.kind === 'command' ? l.text : `${l.kind}: ${l.text}`)
  }
  return out.join('\n')
}

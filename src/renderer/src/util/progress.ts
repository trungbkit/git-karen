// Git `--progress` output (stderr lines streamed from the backend as ProgressEvents) turned into percentages.
// Pure: no React, no IPC.

/** One counter line, e.g. "Receiving objects:  45% (450/1000), 1.20 MiB | 1.10 MiB/s". */
export interface ProgressLine {
  /** "Receiving objects", "remote: Counting objects" */
  phase: string
  percent: number
  current: number
  total: number
  /** Throughput or size after the counter, e.g. "1.20 MiB | 1.10 MiB/s" */
  detail: string | null
}

const COUNTER = /^((?:remote:\s*)?[A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%\s+\((\d+)\/(\d+)\)(?:,\s*(.*))?$/

export function parseProgressLine(line: string): ProgressLine | null {
  const m = COUNTER.exec(line.trim())
  if (!m) return null
  const detail = (m[5] ?? '').replace(/,?\s*done\.?$/, '').trim()
  return {
    phase: m[1].replace(/^remote:\s*/, 'remote: '),
    percent: Math.min(100, Number(m[2])),
    current: Number(m[3]),
    total: Number(m[4]),
    detail: detail || null
  }
}

/**
 * Share of the whole operation each phase covers ([from, to] in %), by operation. Receiving or writing the objects
 * is most of the time; phases not listed (LFS, submodules) show their own percentage without moving the overall bar.
 */
const STAGES: Record<string, [phase: string, from: number, to: number][]> = {
  clone: [
    ['remote: Counting objects', 0, 4],
    ['remote: Compressing objects', 4, 10],
    ['Receiving objects', 10, 80],
    ['Resolving deltas', 80, 92],
    ['Updating files', 92, 100]
  ],
  fetch: [
    ['remote: Counting objects', 0, 5],
    ['remote: Compressing objects', 5, 15],
    ['Receiving objects', 15, 85],
    ['Unpacking objects', 15, 85],
    ['Resolving deltas', 85, 100]
  ],
  push: [
    ['Counting objects', 0, 5],
    ['Compressing objects', 5, 20],
    ['Writing objects', 20, 95],
    ['remote: Resolving deltas', 95, 100]
  ]
}
STAGES.pull = STAGES.fetch

/** Progress of the whole operation (0-100) after this line, or null when the phase is not a known step of `op`. */
export function overallPercent(op: string, line: ProgressLine): number | null {
  const stage = STAGES[op]?.find(([phase]) => phase === line.phase)
  if (!stage) return null
  const [, from, to] = stage
  return Math.round(from + ((to - from) * line.percent) / 100)
}

/** What the UI shows for a running operation. */
export interface OperationProgress {
  op: string
  /** Current phase ("Receiving objects") or the latest plain message ("Cloning into 'x'...") */
  label: string
  /** Percentage of the current phase */
  percent: number | null
  /** Percentage of the whole operation; never goes back while the same operation runs */
  overall: number | null
  detail: string | null
}

/** Fold one progress message into the state shown for an operation (a different `op` starts over). */
export function reduceProgress(prev: OperationProgress | undefined, op: string, message: string): OperationProgress {
  const same = prev?.op === op ? prev : undefined
  const line = parseProgressLine(message)
  if (!line) return { op, label: message.trim(), percent: null, overall: same?.overall ?? null, detail: null }
  const overall = overallPercent(op, line)
  return {
    op,
    label: line.phase,
    percent: line.percent,
    overall: overall === null ? (same?.overall ?? null) : Math.max(overall, same?.overall ?? 0),
    detail: line.detail
  }
}

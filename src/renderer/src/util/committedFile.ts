import type { FileChange } from '@shared/types'

export function committedOpenFile(
  open: { path: string; staged: boolean } | null,
  staged: FileChange[],
  unstaged: FileChange[],
  stagesAll: boolean
): FileChange | undefined {
  if (!open) return undefined
  const find = (files: FileChange[]) => files.find((f) => f.path === open.path)
  const file = find(staged) ?? (stagesAll ? find(unstaged) : undefined)
  const sideEmpty = open.staged || stagesAll || !find(unstaged)
  return sideEmpty ? file : undefined
}

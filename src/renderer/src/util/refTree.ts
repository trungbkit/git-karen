// Left panel branch trees: refs grouped into folders by their `/` prefixes, fuzzy filtered and sorted.
import type { Ref } from '@shared/types'
import { fuzzyMatch } from './fuzzy'

export type RefSort = 'name' | 'date'

export interface RefTreeNode {
  /** Stable id, also the key of the folder's collapsed state: `${prefix}/feature/` for folders */
  key: string
  label: string
  ref?: Ref
  children: RefTreeNode[]
  /** Branches anywhere below a folder (1 for a branch) */
  count: number
  /** Newest tip commit date below (0 when unknown) */
  date: number
  /** Characters of `label` matched by the filter */
  match?: number[]
}

export interface RefTreeItem {
  /** Name the folders come from, e.g. "feature/login" (remote branches without their remote) */
  path: string
  ref: Ref
}

/** Items whose path fuzzy-matches `query`, with the matched indices into `path`. */
export function filterRefItems(items: RefTreeItem[], query: string): (RefTreeItem & { match?: number[] })[] {
  if (!query.trim()) return items
  const out: (RefTreeItem & { match?: number[] })[] = []
  for (const item of items) {
    const m = fuzzyMatch(query, item.path)
    if (m) out.push({ ...item, match: m.indices })
  }
  return out
}

export function buildRefTree(items: (RefTreeItem & { match?: number[] })[], keyPrefix: string, sort: RefSort = 'name'): RefTreeNode[] {
  const root: RefTreeNode = { key: keyPrefix, label: '', children: [], count: 0, date: 0 }
  // folder lookups by key; a linear scan per part gets slow with hundreds of branches
  const index = new Map<string, RefTreeNode>()
  for (const item of items) {
    const parts = item.path.split('/')
    const date = item.ref.date ?? 0
    let node = root
    let offset = 0
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1
      const key = `${keyPrefix}/${item.path.slice(0, offset + part.length)}${leaf ? '' : '/'}`
      let child = index.get(key)
      if (!child) {
        child = { key, label: part, children: [], count: 0, date: 0 }
        index.set(key, child)
        node.children.push(child)
      }
      child.count++
      child.date = Math.max(child.date, date)
      if (leaf) {
        child.ref = item.ref
        if (item.match) child.match = item.match.filter((m) => m >= offset).map((m) => m - offset)
      }
      offset += part.length + 1
      node = child
    })
  }
  const compare =
    sort === 'date'
      ? (a: RefTreeNode, b: RefTreeNode) => b.date - a.date || a.label.localeCompare(b.label)
      : (a: RefTreeNode, b: RefTreeNode) => Number(!!a.ref) - Number(!!b.ref) || a.label.localeCompare(b.label)
  const sortAll = (nodes: RefTreeNode[]) => {
    nodes.sort(compare)
    for (const n of nodes) if (n.children.length) sortAll(n.children)
  }
  sortAll(root.children)
  return root.children
}

/** Folder keys of a tree (every non-branch node). */
export function folderKeys(nodes: RefTreeNode[]): string[] {
  const out: string[] = []
  const walk = (list: RefTreeNode[]) => {
    for (const n of list) {
      if (n.ref && n.children.length === 0) continue
      out.push(n.key)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

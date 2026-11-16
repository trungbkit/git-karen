// Which `workspace.list` row is the focused workspace? `workspace.readContext` may leave out
// `workspaceId`, and names repeat (many workspaces are called "main"), so the reliable link is a
// terminal: the context lists its terminal ids, and `terminal.list` lists each workspace's.

/**
 * @param {{ workspaceId?: string, displayName: string, branch: string, terminals: { id: string }[] } | null} ctx
 * @param {{ id: string, name: string, branch: string | null }[]} rows from workspace.list
 * @param {((workspaceId: string) => Promise<{ id: string }[]>) | null} listTerminals null when Orca lacks terminal.list
 * @param {Map<string, string>} [terminalOwner] cache: terminal id -> workspace id
 * @returns {Promise<{ match: object | null, candidates: object[] }>}
 */
export async function matchWorkspace(ctx, rows, listTerminals, terminalOwner = new Map()) {
  if (!ctx) return { match: null, candidates: [] }
  const byId = new Map(rows.map((w) => [w.id, w]))

  if (ctx.workspaceId) {
    const exact = byId.get(ctx.workspaceId) ?? rows.find((w) => w.id.endsWith(ctx.workspaceId) || ctx.workspaceId.endsWith(w.id))
    if (exact) return { match: exact, candidates: [] }
  }

  const candidates = rows.filter((w) => w.name === ctx.displayName && (w.branch ?? '') === (ctx.branch ?? ''))
  if (candidates.length === 1) return { match: candidates[0], candidates }

  const ids = (ctx.terminals ?? []).map((t) => t.id)
  if (ids.length) {
    for (const id of ids) {
      const owner = terminalOwner.get(id)
      if (owner && byId.has(owner)) return { match: byId.get(owner), candidates }
    }
    if (!listTerminals) return { match: null, candidates }
    const wanted = new Set(ids)
    // Likely rows first; the name may differ from displayName, so fall back to every row.
    const pool = [...candidates, ...rows.filter((w) => !candidates.includes(w))]
    for (const w of pool) {
      let terminals
      try {
        terminals = await listTerminals(w.id)
      } catch {
        continue
      }
      for (const t of terminals) terminalOwner.set(t.id, w.id)
      if (terminals.some((t) => wanted.has(t.id))) return { match: w, candidates }
    }
  }
  return { match: null, candidates }
}

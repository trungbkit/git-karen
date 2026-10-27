// Graph view presets: named sets of hidden / soloed refs, columns, column widths and graph style, saved per repo.
import { DEFAULT_PREFERENCES, GRAPH_VIEW_KEYS, type GraphViewPrefs, type Preferences, type ViewPreset } from '@shared/types'
import { useStore, type RepoTab } from '../state/store'
import type { MenuItem } from '../ui/ContextMenu'
import { prompt } from '../ui/dialogs'

export function graphView(prefs: Preferences): GraphViewPrefs {
  return Object.fromEntries(GRAPH_VIEW_KEYS.map((k) => [k, prefs[k]])) as GraphViewPrefs
}

export function capturePreset(name: string, repo: Pick<RepoTab, 'hiddenRefs' | 'soloRefs'>, prefs: Preferences): ViewPreset {
  return { name, hiddenRefs: [...repo.hiddenRefs].sort(), soloRefs: [...repo.soloRefs].sort(), view: graphView(prefs) }
}

/** JSON with sorted object keys, so equal views compare equal regardless of key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v
  )
}

/** Whether the graph currently looks exactly like the preset. */
export function matchesPreset(preset: ViewPreset, repo: Pick<RepoTab, 'hiddenRefs' | 'soloRefs'>, prefs: Preferences): boolean {
  const { name: _a, ...want } = preset
  const { name: _b, ...have } = capturePreset('', repo, prefs)
  return canonical(want) === canonical(have)
}

/** Presets with `preset` added, replacing one of the same name. */
export function upsertPreset(list: ViewPreset[], preset: ViewPreset): ViewPreset[] {
  const i = list.findIndex((p) => p.name === preset.name)
  return i < 0 ? [...list, preset] : list.map((p, k) => (k === i ? preset : p))
}

function applyPreset(repo: RepoTab, preset: ViewPreset) {
  const s = useStore.getState()
  s.updateRepo(repo.path, { hiddenRefs: [...preset.hiddenRefs], soloRefs: [...preset.soloRefs] })
  void s.setPrefs({ ...graphView(DEFAULT_PREFERENCES), ...preset.view })
}

function savePresets(repo: RepoTab, list: ViewPreset[]) {
  const s = useStore.getState()
  const all = { ...s.prefs.viewPresets }
  if (list.length) all[repo.path] = list
  else delete all[repo.path]
  void s.setPrefs({ viewPresets: all })
}

async function saveCurrent(repo: RepoTab) {
  const s = useStore.getState()
  const list = s.prefs.viewPresets[repo.path] ?? []
  const res = await prompt({
    title: 'Save graph view',
    message: 'Hidden and soloed branches, visible columns, column widths and graph style. A preset with the same name is replaced.',
    fields: [{ name: 'name', label: 'Preset name', placeholder: 'Release work', validate: (v) => (v.trim() ? null : 'Name is required') }],
    confirmLabel: 'Save preset'
  })
  if (!res) return
  const name = res.name.trim()
  savePresets(repo, upsertPreset(list, capturePreset(name, repo, s.prefs)))
  s.toast({ kind: 'success', title: `Saved view “${name}”` })
}

export function presetMenuItems(repo: RepoTab): MenuItem[] {
  const { prefs } = useStore.getState()
  const list = prefs.viewPresets[repo.path] ?? []
  const defaults = { name: '', hiddenRefs: [], soloRefs: [], view: graphView(DEFAULT_PREFERENCES) }
  return [
    ...list.map((p) => ({ label: `${matchesPreset(p, repo, prefs) ? '✓ ' : ' '}${p.name}`, onClick: () => applyPreset(repo, p) })),
    list.length > 0 && 'separator',
    { label: 'Save current view as preset…', onClick: () => void saveCurrent(repo) },
    list.length > 0 && {
      label: 'Delete preset',
      submenu: list.map((p) => ({ label: p.name, danger: true, onClick: () => savePresets(repo, list.filter((x) => x !== p)) }))
    },
    'separator',
    {
      label: 'Reset view',
      disabled: matchesPreset(defaults, repo, prefs),
      onClick: () => applyPreset(repo, defaults)
    }
  ]
}

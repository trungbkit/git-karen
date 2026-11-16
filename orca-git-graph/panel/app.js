// Git Graph panel: asks the worker for commits, lays them out with layout.js and draws only the
// rows in view (one small SVG per row for its lanes).

import { avatarColor, createAvatars, initials } from './avatars.js'
import { WIP_SHA, buildNodes, compactAgo, computeLayout, contentWidth, groupRefs, laneX, metrics, rowEdgePaths } from './layout.js'

const PAGE = 1000
const OVERSCAN = 8
const LANES = ['#15a0bf', '#0669f7', '#8e00c2', '#c517b6', '#d90171', '#cd0101', '#f25d2e', '#f2ca33', '#7bd938', '#2ece9d']
const laneColor = (col) => LANES[((col % LANES.length) + LANES.length) % LANES.length]

const $ = (id) => document.getElementById(id)
const el = {
  repoName: $('repo-name'),
  repoBranch: $('repo-branch'),
  refresh: $('refresh'),
  search: $('search'),
  searchCount: $('search-count'),
  scroll: $('scroll'),
  spacer: $('spacer'),
  rows: $('rows'),
  state: $('state'),
  splitter: $('splitter'),
  details: $('details')
}

let m = metrics(24)

const avatars = createAvatars({
  request: (input) => request('avatars.get', input),
  defs: document.getElementById('avatar-defs'),
  onChange() {
    // Pictures turned off in Settings: go back to the compact dots.
    if (avatars.disabled) m = metrics(24, { avatars: false })
    render()
    if (state.selected) renderDetailsAvatar()
  }
})
const state = {
  /** The focused workspace's context from workspace.changed; undefined until the first event. */
  context: undefined,
  /** terminal id -> workspace.list id, learned from loads and from picks; kept across sessions. */
  terminalOwner: loadTerminalOwner(),
  data: null,
  layout: null,
  graphWidth: 0,
  selected: null,
  query: '',
  matches: [],
  matchSet: new Set(),
  loadGen: 0,
  loadingMore: false,
  lastLoad: 0
}

// ------------------------------------------------------------------------------- utilities

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function request(name, input, timeoutMs = 60000) {
  return orca.plugin.request(name, input, { timeoutMs })
}

/** An author picture with initials underneath, for HTML (the details pane). */
function avatarHtml(name, email, size) {
  const url = avatars.urlFor(email)
  const img = url ? `<img src="${url}" alt="" draggable="false">` : ''
  return `<span class="avatar" data-email="${esc(email)}" style="width:${size}px;height:${size}px;background:${avatarColor(email)};font-size:${Math.max(7, Math.round(size * 0.42))}px">${esc(initials(name || email))}${img}</span>`
}

const fullDate = (ms) => new Date(ms).toLocaleString(orca.locale || undefined, { dateStyle: 'medium', timeStyle: 'short' })

const ICON = {
  branch: '<svg viewBox="0 0 16 16" width="10" height="10"><circle cx="5" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="11.5" cy="5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 5.1v5.8M11.5 6.6c0 3-6.5 2-6.5 4.3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  cloud: '<svg viewBox="0 0 16 16" width="10" height="10"><path d="M4.5 12.5h7a3 3 0 0 0 .3-6 4 4 0 0 0-7.6-.9A3.5 3.5 0 0 0 4.5 12.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  tag: '<svg viewBox="0 0 16 16" width="10" height="10"><path d="M2.5 2.5h5l6 6-5 5-6-6Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="10" height="10"><path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="12" height="12"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
}

function pillHtml(g, color) {
  const icon = g.type === 'tag' ? ICON.tag : g.current ? ICON.check : g.local ? ICON.branch : ICON.cloud
  const cloud = g.local && g.remotes.length ? ICON.cloud : ''
  const title = [g.local ? g.name : null, ...g.remotes].filter(Boolean).join(', ')
  return `<span class="pill${g.current ? ' current' : ''}" style="--c:${color}" title="${esc(title || g.name)}">${icon}<span class="name">${esc(g.name)}</span>${cloud}</span>`
}

// ------------------------------------------------------------------------------- loading

function showState(html, kind = '') {
  el.state.className = `state ${kind}`
  el.state.innerHTML = html
  el.state.hidden = false
}

function hideState() {
  el.state.hidden = true
}

function loadTerminalOwner() {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem('terminalOwner') || '{}')))
  } catch {
    return new Map()
  }
}

/** Remember that the focused workspace's terminals belong to `workspaceId`. */
function learnTerminals(workspaceId) {
  for (const t of state.context?.terminals ?? []) state.terminalOwner.set(t.id, workspaceId)
  // Keep the newest few hundred; terminal ids are not reused.
  const entries = [...state.terminalOwner].slice(-300)
  state.terminalOwner = new Map(entries)
  try {
    localStorage.setItem('terminalOwner', JSON.stringify(Object.fromEntries(entries)))
  } catch {}
}

/** A pick made for a focused workspace with no terminals to remember it by; cleared on focus change. */
let pickedOnce = null

/** The workspace a remembered terminal of the focused workspace belongs to, if any. */
function knownWorkspace() {
  if (!state.context?.terminals?.length) return pickedOnce
  for (const t of state.context?.terminals ?? []) {
    const id = state.terminalOwner.get(t.id)
    if (id) return id
  }
  return null
}

function forgetWorkspace(workspaceId) {
  for (const [t, id] of state.terminalOwner) if (id === workspaceId) state.terminalOwner.delete(t)
}

/**
 * Load the graph. `resolve` asks the worker which repository the focused workspace is; otherwise
 * the repository already shown is reloaded.
 */
async function load({ quiet = false, resolve = false } = {}) {
  if (state.context === null) {
    state.data = null
    renderHeader()
    showState('Open a workspace to see its commit graph.')
    return
  }
  const gen = ++state.loadGen
  state.lastLoad = Date.now()
  el.refresh.classList.add('spin')
  if (!quiet && !state.data) showState('Loading…')
  try {
    const limit = Math.max(PAGE, state.data?.commits.length ?? 0)
    const known = knownWorkspace()
    const target = !resolve && state.data ? { repoPath: state.data.repo.path } : known ? { workspaceId: known } : {}
    let res = await request('graph.load', { ...target, skip: 0, limit })
    if (gen !== state.loadGen) return
    if (res.error && target.workspaceId && res.error.code === 'no_workspace') {
      forgetWorkspace(target.workspaceId)
      res = await request('graph.load', { skip: 0, limit })
      if (gen !== state.loadGen) return
    }
    if (!res.error && resolve) learnTerminals(res.repo.workspaceId)
    if (res.error) {
      state.data = null
      state.layout = null
      renderHeader()
      el.rows.innerHTML = ''
      el.spacer.style.height = '0px'
      closeDetails()
      if (res.error.code === 'ambiguous_workspace' && res.error.candidates?.length) showPicker(res.error)
      else showState(esc(res.error.message), res.error.code === 'git_failed' ? 'error' : '')
      return
    }
    setData(res)
  } catch (error) {
    if (gen !== state.loadGen) return
    showState(`${esc(error.message || error.code || String(error))}<button id="retry">Retry</button>`, 'error')
    $('retry')?.addEventListener('click', () => load())
  } finally {
    if (gen === state.loadGen) el.refresh.classList.remove('spin')
  }
}

function showPicker(error) {
  const buttons = error.candidates
    .map((c) => `<button class="pick" data-id="${esc(c.id)}" title="${esc(c.path)}"><span class="pick-name">${esc(c.path.split(/[\\/]/).filter(Boolean).pop() ?? c.name)}</span><span class="pick-path"><bdi>${esc(c.path)}</bdi></span></button>`)
    .join('')
  showState(`<div>${esc(error.message)}</div><div class="picks">${buttons}</div>`)
  el.state.querySelectorAll('.pick').forEach((b) =>
    b.addEventListener('click', () => {
      learnTerminals(b.dataset.id)
      if (!state.context?.terminals?.length) pickedOnce = b.dataset.id
      void load({ resolve: true })
    })
  )
}

async function loadMore() {
  const data = state.data
  if (!data?.hasMore || state.loadingMore) return
  state.loadingMore = true
  const gen = state.loadGen
  try {
    const res = await request('graph.load', { repoPath: data.repo.path, skip: data.commits.length, limit: PAGE })
    if (gen !== state.loadGen || res.error) return
    const seen = new Set(data.commits.map((c) => c.h))
    data.commits.push(...res.commits.filter((c) => !seen.has(c.h)))
    data.hasMore = res.hasMore
    relayout()
  } finally {
    state.loadingMore = false
  }
}

function setData(res) {
  const prevRepo = state.data?.repo.path
  state.data = res
  avatars.setRepo(res.repo.path)
  if (prevRepo !== res.repo.path) {
    state.selected = null
    el.scroll.scrollTop = 0
    closeDetails()
  }
  hideState()
  renderHeader()
  relayout()
  if (state.selected) {
    if (!state.layout.index.has(state.selected)) closeDetails()
    else if (state.selected === WIP_SHA) renderDetails()
  }
}

function relayout() {
  const d = state.data
  const nodes = buildNodes(d.commits, { stashes: d.stashes, wipHeadSha: d.changes > 0 ? d.headSha : undefined })
  state.layout = computeLayout(nodes)
  el.spacer.style.height = `${(nodes.length + (d.hasMore ? 1 : 0)) * m.rowH}px`
  updateMatches()
  render()
}

// ------------------------------------------------------------------------------- rendering

function renderHeader() {
  const d = state.data
  el.repoName.textContent = d ? d.repo.name : 'Git Graph'
  el.repoName.title = d ? d.repo.path : ''
  el.repoBranch.textContent = d ? (d.branch ?? (d.headSha ? `detached at ${d.headSha.slice(0, 7)}` : 'no commits')) : ''
}

function rowHtml(row, i) {
  const { node } = row
  const color = laneColor(row.column)
  const nodeX = Math.min(laneX(m, row.column), state.graphWidth - m.colWidth / 2)
  let svg = ''
  for (const p of rowEdgePaths(m, row, nodeX)) {
    svg += `<path d="${p.d}" stroke="${laneColor(p.col)}"${p.dashed ? ' stroke-dasharray="3 2"' : ''}/>`
  }
  const isHead = node.kind === 'commit' && node.sha === state.data.headSha
  const r = (row.isMerge ? m.mergeSize : m.nodeSize) / 2
  // WIP and stash markers stay dot-sized next to picture nodes.
  const rs = Math.min(r, 6)
  if (node.kind === 'wip') {
    svg += `<circle cx="${nodeX}" cy="${m.mid}" r="${rs - 0.5}" fill="var(--bg)" stroke="${color}" stroke-width="1.5" stroke-dasharray="2.5 1.5"/>`
  } else if (node.kind === 'stash') {
    svg += `<rect x="${nodeX - rs + 1}" y="${m.mid - rs + 1}" width="${2 * rs - 2}" height="${2 * rs - 2}" fill="var(--bg)" stroke="${color}" stroke-width="1.5"/>`
  } else if (row.isMerge) {
    svg += `<circle cx="${nodeX}" cy="${m.mid}" r="${r}" fill="${color}"/>`
  } else if (avatars.disabled) {
    svg += `<circle cx="${nodeX}" cy="${m.mid}" r="${r - 1}" fill="${isHead ? color : 'var(--bg)'}" stroke="${color}" stroke-width="2"/>`
    if (isHead) svg += `<circle cx="${nodeX}" cy="${m.mid}" r="${r + 1.5}" fill="none" stroke="${color}" stroke-opacity="0.45" stroke-width="1.5"/>`
  } else {
    // The author's picture (initials until it arrives) in a ring of the lane's colour.
    const c = node.commit
    const sym = avatars.symbolFor(c.e)
    svg += `<circle cx="${nodeX}" cy="${m.mid}" r="${r}" fill="${avatarColor(c.e)}" stroke="none"/>`
    if (sym) svg += `<use href="#${sym}" x="${nodeX - r}" y="${m.mid - r}" width="${2 * r}" height="${2 * r}"/>`
    else svg += `<text x="${nodeX}" y="${m.mid}" class="node-initials" font-size="${Math.round(r * 0.85)}">${esc(initials(c.a || c.e))}</text>`
    svg += `<circle cx="${nodeX}" cy="${m.mid}" r="${r - 0.75}" fill="none" stroke="${color}" stroke-width="1.5"/>`
    if (isHead) svg += `<circle cx="${nodeX}" cy="${m.mid}" r="${r + 1.25}" fill="none" stroke="${color}" stroke-opacity="0.5" stroke-width="1.5"/>`
  }

  let text
  if (node.kind === 'wip') {
    const n = state.data.changes
    text = `<span class="summary wip">// WIP · ${n} ${n === 1 ? 'change' : 'changes'}</span>`
  } else if (node.kind === 'stash') {
    text = `<span class="summary stash" title="${esc(node.stash.ref)}">${esc(node.stash.message)}</span><span class="date" title="${esc(fullDate(node.stash.date))}">${compactAgo(node.stash.date)}</span>`
  } else {
    const c = node.commit
    const groups = groupRefs(c.r, state.data.branch)
    const shown = groups.slice(0, 2).map((g) => pillHtml(g, color)).join('')
    const extra = groups.length > 2 ? `<span class="pill-more" title="${esc(groups.slice(2).map((g) => g.name).join(', '))}">+${groups.length - 2}</span>` : ''
    text = `${shown}${extra}<span class="summary">${esc(c.s)}</span><span class="date" title="${esc(`${c.a} · ${fullDate(c.t)}`)}">${compactAgo(c.t)}</span>`
  }

  const cls = ['row']
  if (node.sha === state.selected) cls.push('selected')
  if (state.query) cls.push(state.matchSet.has(node.sha) ? 'match' : 'dim')
  return `<div class="${cls.join(' ')}" data-i="${i}" style="top:${i * m.rowH}px"><svg class="lanes" width="${state.graphWidth}" height="${m.rowH}" fill="none" stroke-width="${m.lineWidth}" stroke-linecap="round">${svg}</svg><div class="text">${text}</div></div>`
}

function render() {
  const layout = state.layout
  if (!layout) return
  const width = el.scroll.clientWidth
  state.graphWidth = Math.min(contentWidth(m, layout.maxColumns), Math.max(48, Math.round(width * 0.4)))
  const top = el.scroll.scrollTop
  const first = Math.max(0, Math.floor(top / m.rowH) - OVERSCAN)
  const last = Math.min(layout.rows.length, Math.ceil((top + el.scroll.clientHeight) / m.rowH) + OVERSCAN)
  let html = ''
  const authors = []
  for (let i = first; i < last; i++) {
    const row = layout.rows[i]
    html += rowHtml(row, i)
    if (row.node.kind === 'commit') authors.push({ email: row.node.commit.e, sha: row.node.sha })
  }
  avatars.want(authors)
  if (state.data.hasMore && last >= layout.rows.length) {
    html += `<div class="more" style="top:${layout.rows.length * m.rowH}px">Loading older commits…</div>`
    void loadMore()
  }
  el.rows.innerHTML = html
}

// ------------------------------------------------------------------------------- search

function updateMatches() {
  const q = state.query.trim().toLowerCase()
  state.matches = []
  if (q && state.layout) {
    for (const row of state.layout.rows) {
      const n = row.node
      let hay
      if (n.kind === 'commit') hay = `${n.sha} ${n.commit.s} ${n.commit.a} ${n.commit.e} ${(n.commit.r ?? []).join(' ')}`
      else if (n.kind === 'stash') hay = `${n.stash.ref} ${n.stash.message}`
      else continue
      if (hay.toLowerCase().includes(q)) state.matches.push(n.sha)
    }
  }
  state.matchSet = new Set(state.matches)
  el.searchCount.textContent = q ? `${state.matches.length}${state.data?.hasMore ? '+' : ''}` : ''
}

function jumpToMatch(dir = 1) {
  if (!state.matches.length) return
  const cur = state.matches.indexOf(state.selected)
  const next = cur < 0 ? (dir > 0 ? 0 : state.matches.length - 1) : (cur + dir + state.matches.length) % state.matches.length
  select(state.matches[next], { reveal: true })
  el.searchCount.textContent = `${next + 1}/${state.matches.length}${state.data?.hasMore ? '+' : ''}`
}

// ------------------------------------------------------------------------------- selection

function reveal(i) {
  const top = i * m.rowH
  if (top < el.scroll.scrollTop) el.scroll.scrollTop = top
  else if (top + m.rowH > el.scroll.scrollTop + el.scroll.clientHeight) el.scroll.scrollTop = top + m.rowH - el.scroll.clientHeight
}

function select(sha, { reveal: doReveal = false } = {}) {
  const i = state.layout?.index.get(sha)
  if (i === undefined) return
  state.selected = sha
  if (doReveal) reveal(i)
  render()
  renderDetails()
}

function closeDetails() {
  state.selected = null
  el.details.hidden = true
  el.splitter.hidden = true
  el.details.innerHTML = ''
  render()
}

let detailsGen = 0

/** Put pictures that arrived after the details pane was drawn into its avatars. */
function renderDetailsAvatar() {
  el.details.querySelectorAll('.avatar[data-email]').forEach((a) => {
    const url = avatars.urlFor(a.dataset.email)
    if (url && !a.querySelector('img')) a.insertAdjacentHTML('beforeend', `<img src="${url}" alt="" draggable="false">`)
  })
}

async function renderDetails() {
  const sha = state.selected
  const row = sha && state.layout.rows[state.layout.index.get(sha)]
  if (!row) return closeDetails()
  el.details.hidden = false
  el.splitter.hidden = false
  const gen = ++detailsGen
  const node = row.node
  const color = laneColor(row.column)
  const closeBtn = `<button class="icon-btn" data-act="close" title="Close" aria-label="Close details">${ICON.close}</button>`

  if (node.kind === 'wip') {
    const n = state.data.changes
    el.details.innerHTML = `<div class="d-head"><div class="d-summary">Uncommitted changes</div>${closeBtn}</div><div class="d-loading">${n} changed ${n === 1 ? 'path' : 'paths'} in the working tree${state.data.branch ? ` on ${esc(state.data.branch)}` : ''}.</div>`
    return
  }

  const groups = node.kind === 'commit' ? groupRefs(node.commit.r, state.data.branch) : []
  const title = node.kind === 'stash' ? node.stash.message : node.commit.s
  el.details.innerHTML = `<div class="d-head"><div class="d-summary">${esc(title)}</div>${closeBtn}</div><div class="d-loading">Loading…</div>`

  let res
  try {
    res = await request('graph.commit', { repoPath: state.data.repo.path, sha: node.sha })
  } catch (error) {
    res = { error: { message: error.message || String(error) } }
  }
  if (gen !== detailsGen) return
  if (res.error) {
    el.details.querySelector('.d-loading').textContent = res.error.message
    return
  }
  const c = res.commit
  const committedBySomeoneElse = c.committer.email !== c.author.email || c.committer.name !== c.author.name
  const parents = c.parents
    .map((p) => (state.layout.index.has(p) ? `<a class="link sha" data-sha="${p}">${p.slice(0, 7)}</a>` : `<span class="sha">${p.slice(0, 7)}</span>`))
    .join(' ')
  let added = 0
  let deleted = 0
  const files = c.files
    .map((f) => {
      added += f.added ?? 0
      deleted += f.deleted ?? 0
      const slash = f.path.lastIndexOf('/')
      const dir = slash >= 0 ? f.path.slice(0, slash + 1) : ''
      const base = f.path.slice(slash + 1)
      const num = f.binary ? '<span>bin</span>' : `<span class="a">+${f.added ?? 0}</span> <span class="d">−${f.deleted ?? 0}</span>`
      const tip = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
      return `<li title="${esc(tip)}"><span class="st st-${esc(f.status)}">${esc(f.status)}</span><span class="path"><bdi><span class="dir">${esc(dir)}</span>${esc(base)}</bdi></span><span class="num">${num}</span></li>`
    })
    .join('')

  el.details.innerHTML = `
    <div class="d-head"><div class="d-summary">${esc(node.kind === 'stash' ? node.stash.message : c.summary)}</div>${closeBtn}</div>
    <div class="d-author">
      ${avatarHtml(c.author.name, c.author.email, 28)}
      <div class="d-who"><div class="name" title="${esc(c.author.email)}">${esc(c.author.name)}</div><div class="when">${esc(fullDate(c.author.date))}</div></div>
    </div>
    <dl class="d-meta">
      <dt>${node.kind === 'stash' ? 'Stash' : 'Commit'}</dt><dd><span class="sha" title="${c.sha}">${node.kind === 'stash' ? esc(node.stash.ref) + ' · ' : ''}${c.sha.slice(0, 10)}</span></dd>
      ${parents ? `<dt>${c.parents.length > 1 ? 'Parents' : 'Parent'}</dt><dd>${parents}</dd>` : ''}
      ${committedBySomeoneElse ? `<dt>Committer</dt><dd class="d-committer" title="${esc(c.committer.email)}">${avatarHtml(c.committer.name, c.committer.email, 14)}${esc(c.committer.name)} · ${esc(fullDate(c.committer.date))}</dd>` : ''}
    </dl>
    ${groups.length ? `<div class="d-refs">${groups.map((g) => pillHtml(g, color)).join('')}</div>` : ''}
    ${c.body ? `<pre class="d-body">${esc(c.body)}</pre>` : ''}
    <div class="d-files-head"><span>${c.files.length} ${c.files.length === 1 ? 'file' : 'files'}${c.parents.length > 1 ? ' vs first parent' : ''}</span><span class="num"><span class="a">+${added}</span> <span class="d">−${deleted}</span></span></div>
    <ul class="d-files">${files}</ul>`
  avatars.want([
    { email: c.author.email, sha: c.sha },
    { email: c.committer.email, sha: c.sha }
  ])
}

// ------------------------------------------------------------------------------- events

el.scroll.addEventListener('scroll', () => requestAnimationFrame(render), { passive: true })
new ResizeObserver(() => render()).observe(el.scroll)

el.rows.addEventListener('click', (e) => {
  const rowEl = e.target.closest('.row')
  if (!rowEl) return
  const row = state.layout.rows[Number(rowEl.dataset.i)]
  if (row) select(row.node.sha)
  el.scroll.focus({ preventScroll: true })
})

el.scroll.addEventListener('keydown', (e) => {
  const rows = state.layout?.rows
  if (!rows?.length) return
  const cur = state.selected ? state.layout.index.get(state.selected) : -1
  let next = null
  if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, cur + 1)
  else if (e.key === 'ArrowUp') next = Math.max(0, cur - 1)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = rows.length - 1
  else if (e.key === 'Escape' && state.selected) {
    closeDetails()
    e.preventDefault()
    return
  } else return
  e.preventDefault()
  select(rows[next].node.sha, { reveal: true })
})

el.details.addEventListener('click', (e) => {
  const target = e.target.closest('[data-act], [data-sha]')
  if (!target) return
  if (target.dataset.act === 'close') closeDetails()
  else if (target.dataset.sha) select(target.dataset.sha, { reveal: true })
})

el.search.addEventListener('input', () => {
  state.query = el.search.value
  updateMatches()
  render()
})
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    jumpToMatch(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    el.search.value = ''
    state.query = ''
    updateMatches()
    render()
  }
})

el.refresh.addEventListener('click', () => load())

// Drag the splitter to size the details pane; the height is remembered per viewer.
try {
  const saved = Number(localStorage.getItem('detailsHeight'))
  if (saved > 0) el.details.style.height = `${saved}px`
} catch {}
el.splitter.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  el.splitter.setPointerCapture(e.pointerId)
  el.splitter.classList.add('dragging')
  const startY = e.clientY
  const startH = el.details.getBoundingClientRect().height
  const move = (ev) => {
    const h = Math.max(80, Math.min(window.innerHeight - 140, startH + startY - ev.clientY))
    el.details.style.height = `${h}px`
  }
  const up = () => {
    el.splitter.classList.remove('dragging')
    el.splitter.removeEventListener('pointermove', move)
    el.splitter.removeEventListener('pointerup', up)
    try {
      localStorage.setItem('detailsHeight', String(Math.round(el.details.getBoundingClientRect().height)))
    } catch {}
  }
  el.splitter.addEventListener('pointermove', move)
  el.splitter.addEventListener('pointerup', up)
})

// Working-tree edits do not touch .git, so look again when the panel comes back into view.
const refreshIfStale = () => {
  if (document.visibilityState === 'visible' && state.data && Date.now() - state.lastLoad > 1500) void load({ quiet: true })
}
document.addEventListener('visibilitychange', refreshIfStale)
window.addEventListener('focus', refreshIfStale)

// The worker watches the repository and says when refs, HEAD, the index or stashes change.
orca.plugin.on('graph.changed', ({ repoPath }) => {
  if (!repoPath || repoPath === state.data?.repo.path) void load({ quiet: true })
})

orca.on?.('theme', ({ colorScheme }) => {
  if (colorScheme) document.documentElement.style.colorScheme = colorScheme
})

// workspace.changed fires once on subscribe with the current context, then on every focus change
// and whenever the focused workspace's terminals open, close or are renamed.
const contextIdentity = (ctx) =>
  ctx ? JSON.stringify([ctx.workspaceId ?? '', ctx.displayName, ctx.branch, (ctx.terminals ?? []).map((t) => t.id).sort()]) : 'none'
orca.on('workspace.changed', ({ context }) => {
  const changed = state.context === undefined || contextIdentity(context) !== contextIdentity(state.context)
  state.context = context ?? null
  if (changed) {
    pickedOnce = null
    void load({ resolve: true })
  }
})

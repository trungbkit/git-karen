// The macOS web view (WKWebView) applies the system's text-substitution
// features to every text field: autocorrect, auto-capitalisation and inline
// writing suggestions. The suggestion bubble is committed on blur, so typing
// "sup" and clicking away silently turns it into "Sup". In a Git client that
// corrupts branch names, refs, paths, URLs and search queries, so every text
// field opts out unless it says otherwise.

/** Attributes that turn off WebKit's text substitution. */
export const TEXT_INPUT_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['autocorrect', 'off'],
  ['autocapitalize', 'off'],
  ['spellcheck', 'false'],
  ['writingsuggestions', 'false']
]

/** `<input type>` values that take free text and so get substitutions. */
const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'password'])

const SELECTOR = 'input, textarea, [contenteditable]'

/** The subset of `Element` this module needs, so it can be tested without a DOM. */
export interface ElementLike {
  tagName: string
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  setAttribute(name: string, value: string): void
}

export function isTextField(el: ElementLike): boolean {
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return TEXT_TYPES.has((el.getAttribute('type') ?? '').toLowerCase())
  const editable = el.getAttribute('contenteditable')
  return editable !== null && editable.toLowerCase() !== 'false'
}

/**
 * Turns substitutions off on a text field. An attribute the markup already
 * sets is left alone, so a field can opt back in (e.g. `spellCheck`).
 */
export function applyTextInputDefaults(el: ElementLike): void {
  if (!isTextField(el)) return
  for (const [name, value] of TEXT_INPUT_DEFAULTS) {
    if (!el.hasAttribute(name)) el.setAttribute(name, value)
  }
}

function applyWithin(node: Node): void {
  if (!(node instanceof Element)) return
  if (node.matches(SELECTOR)) applyTextInputDefaults(node)
  node.querySelectorAll(SELECTOR).forEach(applyTextInputDefaults)
}

/**
 * Applies the defaults to every text field in `root`, now and as fields are
 * added (React renders, xterm's hidden textarea, ...). Attributes are set on
 * insertion so they are in place before the field is first focused.
 */
export function installTextInputDefaults(root: ParentNode & Node = document.body): () => void {
  applyWithin(root)
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(applyWithin)
      else if (r.target instanceof Element) applyTextInputDefaults(r.target)
    }
  })
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'contenteditable']
  })
  return () => observer.disconnect()
}

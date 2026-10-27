import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { DiffTarget, FileDiff, ImageBlob } from '@shared/types'
import { readLocal, writeLocal } from '../diff/settings'
import '../styles/review.css'

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

const extension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase()

/** Whether the file is an image the diff view can show as pictures (by extension). */
export function isImagePath(path: string): boolean {
  return extension(path) in MIME
}

/** SVG has a text diff too; the other images are binary. */
export const isSvgPath = (path: string) => extension(path) === 'svg'

/** Where each side of the diff's file is read from: `rev` null = working copy, '' = index. */
export interface ImageSide {
  rev: string | null
  path: string
}

/** The old and new side of an image diff (null where the file does not exist). */
export function imageSides(target: DiffTarget, diff: FileDiff | null): { before: ImageSide | null; after: ImageSide | null } {
  const path = target.path
  const oldPath = diff?.oldPath ?? (target.kind === 'commit' ? target.oldPath : undefined) ?? path
  const sides = (before: string | null, after: string | null) => ({
    before: diff?.isNew ? null : { rev: before, path: oldPath },
    after: diff?.isDeleted ? null : { rev: after, path }
  })
  switch (target.kind) {
    case 'working':
      return target.staged ? sides('HEAD', '') : sides('', null)
    case 'commit':
      return sides(`${target.sha}^`, target.sha)
    case 'compare':
      return sides(target.from, target.to)
  }
}

type Mode = 'side' | 'swipe' | 'onion'

interface Loaded {
  url: string
  size: number
  width?: number
  height?: number
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function useImage(repo: string, side: ImageSide | null, mime: string): { image: Loaded | null | undefined; error: string | null } {
  const [state, setState] = useState<{ image: Loaded | null | undefined; error: string | null }>({ image: undefined, error: null })
  const key = side ? `${side.rev}\u0000${side.path}` : ''
  useEffect(() => {
    setState({ image: undefined, error: null })
    if (!side) return setState({ image: null, error: null })
    let cancelled = false
    window.git.imageBlob(repo, side.rev, side.path).then(
      (blob: ImageBlob | null) => !cancelled && setState({ image: blob && { url: `data:${mime};base64,${blob.base64}`, size: blob.size }, error: null }),
      (e: Error) => !cancelled && setState({ image: null, error: e.message })
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, key, mime])
  return state
}

/**
 * Old and new version of an image: side by side, swipe (a divider uncovers the new image over the old) or onion
 * skin (the new image fades in over the old), with pixel dimensions and file sizes.
 */
export function ImageDiff({ repo, target, diff }: { repo: string; target: DiffTarget; diff: FileDiff | null }) {
  const mime = MIME[extension(target.path)] ?? 'application/octet-stream'
  const { before, after } = imageSides(target, diff)
  const old = useImage(repo, before, mime)
  const cur = useImage(repo, after, mime)
  const [dims, setDims] = useState<{ old?: [number, number]; cur?: [number, number] }>({})
  const [mode, setMode] = useState<Mode>(() => {
    const v = readLocal('kc:imageDiffMode', 'side')
    return v === 'swipe' || v === 'onion' ? v : 'side'
  })
  const [amount, setAmount] = useState(50)
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => setDims({}), [old.image?.url, cur.image?.url])

  const error = old.error ?? cur.error
  if (error) return <div className="view-message">{error}</div>
  if (old.image === undefined || cur.image === undefined) return <div className="view-message">Loading image…</div>
  if (!old.image && !cur.image) return <div className="view-message">The image is not available in this revision.</div>

  const both = !!old.image && !!cur.image
  const pick = (m: Mode) => {
    setMode(m)
    writeLocal('kc:imageDiffMode', m)
  }
  const measured = (which: 'old' | 'cur') => (e: { currentTarget: HTMLImageElement }) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget
    setDims((d) => (d[which]?.[0] === w && d[which]?.[1] === h ? d : { ...d, [which]: [w, h] }))
  }
  const info = (img: Loaded, d: [number, number] | undefined) => `${d ? `${d[0]} × ${d[1]} px · ` : ''}${formatBytes(img.size)}`
  const sizeDelta = both ? cur.image!.size - old.image!.size : 0

  // Swipe and onion skin stack both images in one box as large as the larger one; each keeps its own size.
  const boxW = Math.max(dims.old?.[0] ?? 0, dims.cur?.[0] ?? 0)
  const boxH = Math.max(dims.old?.[1] ?? 0, dims.cur?.[1] ?? 0)
  const layer = (d: [number, number] | undefined) => (d && boxW ? { width: `${(d[0] / boxW) * 100}%` } : undefined)
  const swipeTo = (e: ReactPointerEvent) => {
    const r = stageRef.current?.getBoundingClientRect()
    if (r && r.width > 0) setAmount(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100))
  }

  const pane = (label: string, img: Loaded, d: [number, number] | undefined, which: 'old' | 'cur') => (
    <figure className={`img-pane ${which}`}>
      <figcaption>
        <span className="img-label">{label}</span>
        <span className="muted">{info(img, d)}</span>
      </figcaption>
      <div className="img-frame checker">
        <img src={img.url} alt={label} onLoad={measured(which)} draggable={false} />
      </div>
    </figure>
  )

  return (
    <div className="image-diff">
      <div className="img-toolbar">
        {both ? (
          <span className="seg">
            <button className={mode === 'side' ? 'on' : ''} onClick={() => pick('side')}>
              2-up
            </button>
            <button className={mode === 'swipe' ? 'on' : ''} onClick={() => pick('swipe')}>
              Swipe
            </button>
            <button className={mode === 'onion' ? 'on' : ''} onClick={() => pick('onion')}>
              Onion skin
            </button>
          </span>
        ) : (
          <span className={`img-badge ${cur.image ? 'added' : 'deleted'}`}>{cur.image ? 'Added' : 'Deleted'}</span>
        )}
        {both && (
          <span className="muted">
            {dims.old && dims.cur && (dims.old[0] !== dims.cur[0] || dims.old[1] !== dims.cur[1])
              ? `${dims.old[0]} × ${dims.old[1]} → ${dims.cur[0]} × ${dims.cur[1]} px · `
              : ''}
            {sizeDelta === 0 ? 'same size' : `${sizeDelta > 0 ? '+' : '−'}${formatBytes(Math.abs(sizeDelta))}`}
          </span>
        )}
        {both && mode !== 'side' && (
          <input
            className="img-amount"
            type="range"
            min={0}
            max={100}
            value={amount}
            title={mode === 'swipe' ? 'Divider position' : 'Opacity of the new image'}
            onChange={(e) => setAmount(+e.target.value)}
          />
        )}
      </div>
      {!both || mode === 'side' ? (
        <div className="img-panes">
          {old.image && pane(both ? 'Before' : 'Deleted', old.image, dims.old, 'old')}
          {cur.image && pane(both ? 'After' : 'Added', cur.image, dims.cur, 'cur')}
        </div>
      ) : (
        <div className="img-stack-wrap">
          <div
            ref={stageRef}
            className={`img-stack checker ${mode}`}
            style={boxW ? { width: boxW, aspectRatio: `${boxW} / ${boxH}` } : undefined}
            onPointerDown={
              mode === 'swipe'
                ? (e) => {
                    e.currentTarget.setPointerCapture(e.pointerId)
                    swipeTo(e)
                  }
                : undefined
            }
            onPointerMove={mode === 'swipe' ? (e) => e.buttons === 1 && swipeTo(e) : undefined}
          >
            <img src={old.image!.url} alt="Before" style={layer(dims.old)} onLoad={measured('old')} draggable={false} />
            <img
              src={cur.image!.url}
              alt="After"
              style={{
                ...layer(dims.cur),
                // the divider is placed in the box; the new image may be narrower than it
                ...(mode === 'swipe'
                  ? { clipPath: `inset(0 0 0 ${dims.cur ? Math.min(100, (amount * boxW) / dims.cur[0]) : amount}%)` }
                  : { opacity: amount / 100 })
              }}
              onLoad={measured('cur')}
              draggable={false}
            />
            {mode === 'swipe' && <div className="img-divider" style={{ left: `${amount}%` }} />}
          </div>
          <div className="img-stack-legend muted">
            {mode === 'swipe' ? 'Before ← drag → After' : `Before · After at ${amount}%`} · {info(old.image!, dims.old)} → {info(cur.image!, dims.cur)}
          </div>
        </div>
      )}
    </div>
  )
}

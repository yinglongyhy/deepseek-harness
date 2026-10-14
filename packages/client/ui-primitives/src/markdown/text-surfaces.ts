/** Controlled, DOM-private visible-text mapping for settled Markdown. */
import css from './text-surfaces.module.css'
import { observeComposition } from '../keyboard-composition.ts'

/** UTF-16 half-open interval; boundaries cannot split a surrogate pair. */
export interface MarkdownTextInterval { readonly start: number; readonly end: number }
/** Viewport CSS-pixel geometry; contains no DOM references. */
export interface MarkdownTextRectangle { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** One owner-supplied localized decoration. */
export interface MarkdownTextDecoration extends MarkdownTextInterval {
  readonly id: string
  readonly label: string
  /** Optional badge action; label names the action accessibly, while decoration.label remains visible. */
  readonly activation?: { readonly label: string; readonly activate: () => void }
}
/** Mounted prose block or single table cell; no DOM nodes or Ranges escape. */
export interface MarkdownTextSurface {
  readonly id: string
  readonly text: string
  /**
   * Read this surface's current browser selection.
   * @returns a prose-only interval, or null for excluded or cross-surface endpoints.
   */
  selection(): MarkdownTextInterval | null
  /**
   * Validate UTF-16 bounds, surrogate pairs and excluded-content crossings.
   * @param interval - controlled visible-text offsets.
   * @returns whether the exact mapped interval is eligible.
   */
  accepts(interval: MarkdownTextInterval): boolean
  /**
   * Measure a validated interval in current viewport CSS pixels.
   * @param interval - controlled visible-text offsets.
   * @returns fresh rectangles, or null for an ineligible interval.
   */
  geometry(interval: MarkdownTextInterval): readonly MarkdownTextRectangle[] | null
  /**
   * Reveal this exact block and optionally highlight a validated interval without changing its DOM text.
   * @param interval - exact visible-text offsets to highlight until cleanup or unmount.
   * @returns idempotent cleanup for this reveal's highlight; later reveals replace it.
   */
  reveal(interval?: MarkdownTextInterval): () => void
  /**
   * Replace this surface's decorations; overlaps remain independent. Marks and action badges
   * stay inside the viewport and ancestor overflow clips; fully clipped actions are hidden.
   * @param decorations - validated offsets and owner-localized labels.
   */
  decorate(decorations: readonly MarkdownTextDecoration[]): void
}
/** Registration returns cleanup, called before replacement and on unmount. */
export type ObserveMarkdownTextSurfaces = (surfaces: readonly MarkdownTextSurface[]) => () => void

interface Point { node: Node; offset: number }
interface Segment { text: string; start: Point; end: Point }
const excluded = 'pre,button,img,svg,math,.katex,[aria-hidden="true"],[data-markdown-excluded],sup,input'

function whiteSpaceOf(element: HTMLElement): string {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    const mode = getComputedStyle(node).whiteSpace
    if (mode !== '' && mode !== 'inherit' && mode !== 'unset') return mode
  }
  return 'normal'
}

function segmentsOf(element: HTMLElement) {
  const segments: Segment[] = []
  const offsets = new Map<Node, Map<number, number>>()
  let position = 0
  let lineHasContent = false
  let pending: Segment[] = []
  const record = (point: Point, value: number): void => {
    let points = offsets.get(point.node)
    if (points === undefined) { points = new Map(); offsets.set(point.node, points) }
    points.set(point.offset, value)
  }
  const append = (segment: Segment): void => {
    record(segment.start, position)
    position += segment.text.length
    record(segment.end, position)
    const previous = segments.at(-1)
    if (previous !== undefined && previous.end.node === segment.start.node && previous.end.offset === segment.start.offset
      && previous.start.node === previous.end.node && previous.end.offset - previous.start.offset === previous.text.length
      && segment.start.node === segment.end.node && segment.end.offset - segment.start.offset === segment.text.length) {
      previous.text += segment.text
      previous.end = segment.end
    } else segments.push(segment)
  }
  const flush = (keep: boolean): void => {
    const first = pending[0]
    const last = pending.at(-1)
    if (first === undefined || last === undefined) return
    const before = position
    if (keep && lineHasContent) append({ text: ' ', start: first.start, end: last.end })
    for (const [index, unit] of pending.entries()) {
      record(unit.start, index === 0 ? before : position)
      record(unit.end, position)
    }
    pending = []
  }
  const point = (node: Node, offset: number): void => {
    const location = { node, offset }
    if (pending.length > 0) pending.push({ text: '', start: location, end: location })
    else record(location, position)
  }
  const visit = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue ?? ''
      const mode = node.parentElement === null ? 'normal' : whiteSpaceOf(node.parentElement)
      if (!['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'].includes(mode)) {
        return false
      }
      const collapse = mode === 'normal' || mode === 'nowrap' || mode === 'pre-line'
      // The renderer emits a separator newline after BR; the authored break is already mapped.
      const start = node.previousSibling instanceof HTMLElement && node.previousSibling.tagName === 'BR'
        && raw.startsWith('\n') ? 1 : 0
      point(node, 0)
      if (start === 1) point(node, 1)
      for (let index = start; index < raw.length; index++) {
        const text = raw.charAt(index)
        const unit = { text, start: { node, offset: index }, end: { node, offset: index + 1 } }
        if (collapse && /[ \t\r\n\f]/u.test(text) && !(mode === 'pre-line' && text === '\n')) {
          pending.push(unit)
        } else {
          flush(text !== '\n')
          append(unit)
          lineHasContent = text !== '\n'
        }
      }
      return true
    }
    if (!(node instanceof Element)) return true
    const block = node !== element && node.matches('p,h1,h2,h3,h4,h5,h6,li,th,td,ul,ol,pre')
    if (node.matches(excluded) || block) {
      // Omitted inline content still separates visible spaces on its two sides.
      flush(!block)
      lineHasContent = !block
      return true
    }
    if (node.tagName === 'BR') {
      const parent = node.parentNode
      if (parent === null) return true
      const index = Array.from(parent.childNodes).indexOf(node)
      flush(false)
      append({ text: '\n', start: { node: parent, offset: index }, end: { node: parent, offset: index + 1 } })
      lineHasContent = false
      return true
    }
    point(node, 0)
    for (const [index, child] of Array.from(node.childNodes).entries()) {
      if (!visit(child)) return false
      point(node, index + 1)
    }
    return true
  }
  const supported = visit(element)
  flush(false)
  return supported ? { segments, offsets } : undefined
}

function boundary(text: string, offset: number): boolean {
  return !(offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/u.test(text.charAt(offset - 1)) && /[\uDC00-\uDFFF]/u.test(text.charAt(offset)))
}

function pointAt(segments: readonly Segment[], offset: number, end: boolean): Point | undefined {
  let position = 0
  for (const segment of segments) {
    const next = position + segment.text.length
    if (offset < next || (end && offset === next)) {
      if (segment.start.node === segment.end.node && segment.start.node.nodeType === Node.TEXT_NODE
        && segment.end.offset - segment.start.offset === segment.text.length) return {
        node: segment.start.node, offset: segment.start.offset + offset - position,
      }
      return offset === position ? segment.start : segment.end
    }
    position = next
  }
  return segments.at(-1)?.end
}

interface VisibleBounds { left: number; top: number; right: number; bottom: number }

function clipsOverflow(value: string): boolean {
  return value === 'auto' || value === 'scroll' || value === 'hidden' || value === 'clip' || value === 'overlay'
}

function visibleBounds(element: HTMLElement): VisibleBounds | null {
  const viewport = window.visualViewport ?? null
  const bounds = viewport === null
    ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
    : {
      left: viewport.offsetLeft, top: viewport.offsetTop,
      right: viewport.offsetLeft + viewport.width, bottom: viewport.offsetTop + viewport.height,
    }
  const visibility = getComputedStyle(element).visibility
  if (visibility === 'hidden' || visibility === 'collapse') return null
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node)
    const clipX = clipsOverflow(style.overflowX || style.overflow)
    const clipY = clipsOverflow(style.overflowY || style.overflow)
    if (!clipX && !clipY) continue
    const rect = node.getBoundingClientRect()
    const scaleX = node.offsetWidth === 0 ? 1 : rect.width / node.offsetWidth
    const scaleY = node.offsetHeight === 0 ? 1 : rect.height / node.offsetHeight
    // Client dimensions exclude borders and scrollbars; portal coordinates include CSS scaling.
    const left = rect.left + node.clientLeft * scaleX
    const top = rect.top + node.clientTop * scaleY
    if (clipX) {
      bounds.left = Math.max(bounds.left, left)
      bounds.right = Math.min(bounds.right, left + node.clientWidth * scaleX)
    }
    if (clipY) {
      bounds.top = Math.max(bounds.top, top)
      bounds.bottom = Math.min(bounds.bottom, top + node.clientHeight * scaleY)
    }
  }
  return bounds.right > bounds.left && bounds.bottom > bounds.top ? bounds : null
}

function clipRectangle(rect: MarkdownTextRectangle, bounds: VisibleBounds): MarkdownTextRectangle[] {
  const x = Math.max(rect.x, bounds.left)
  const y = Math.max(rect.y, bounds.top)
  const width = Math.min(rect.x + rect.width, bounds.right) - x
  const height = Math.min(rect.y + rect.height, bounds.bottom) - y
  return width > 0 && height > 0 ? [{ x, y, width, height }] : []
}

/**
 * Register semantic prose leaves and cells after the owned Markdown renderer commits.
 * Excludes fence chrome, images, TeX, footnote markers and hidden/icon text. Normal/nowrap
 * CSS whitespace collapses across inline nodes; preserved modes retain whitespace. Authored
 * hard breaks remain newline units. Unsupported white-space modes expose no surface.
 * @param root - the renderer-owned document root.
 * @param observe - host registration callback; receives only data and callbacks.
 * @returns cleanup for geometry listeners, overlays, and host registrations.
 */
export function observeTextSurfaces(root: HTMLElement, observe: ObserveMarkdownTextSurfaces): () => void {
  let mounted = true
  let composition: ReturnType<typeof observeComposition> | undefined
  const layers: HTMLElement[] = []
  const cleanups: (() => void)[] = []
  const redraws: (() => void)[] = []
  const surfaces: MarkdownTextSurface[] = []
  for (const element of root.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,h5,h6,li,th,td')) {
    if (element.closest(excluded) !== null) continue
    const mapping = segmentsOf(element)
    if (mapping === undefined) continue
    const { segments, offsets } = mapping
    const text = segments.map(segment => segment.text).join('')
    if (text.length === 0) continue
    const path: number[] = []
    let ancestor: Element = element
    while (ancestor !== root && ancestor.parentElement !== null) {
      path.unshift(Array.from(ancestor.parentElement.children).indexOf(ancestor))
      ancestor = ancestor.parentElement
    }
    const id = path.join('.')
    const layer = document.createElement('div')
    layer.className = css.layer as string
    layers.push(layer)
    let decorations: readonly MarkdownTextDecoration[] = []
    const crossesExcluded = (range: Range): boolean => [...element.querySelectorAll(
      'pre,img,math,.katex,[data-markdown-excluded],sup,input,button,p,h1,h2,h3,h4,h5,h6,li,th,td,ul,ol',
    )].some(node => range.intersectsNode(node))
    const rangeFor = (interval: MarkdownTextInterval): Range | null => {
      const { start, end } = interval
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start
        || end > text.length || !boundary(text, start) || !boundary(text, end)) return null
      const first = pointAt(segments, start, false)
      const last = pointAt(segments, end, true)
      if (first === undefined || last === undefined) return null
      const range = document.createRange()
      range.setStart(first.node, first.offset)
      range.setEnd(last.node, last.offset)
      return crossesExcluded(range) ? null : range
    }
    const accepts = (interval: MarkdownTextInterval): boolean => rangeFor(interval) !== null
    const geometry = (interval: MarkdownTextInterval): readonly MarkdownTextRectangle[] | null => {
      const range = rangeFor(interval)
      if (range === null) return null
      // A Range exists only during validation or measurement; no registry retains one.
      return Array.from(range.getClientRects(), rect => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }))
    }
    type Badge = { button: HTMLButtonElement; activation: MarkdownTextDecoration['activation'] }
    const badges = new Map<string, Badge>()
    let navigation: { interval: MarkdownTextInterval; layer: HTMLDivElement } | undefined
    const removeBadge = (id: string, badge: Badge): void => {
      badge.activation = undefined
      badge.button.onclick = null
      badge.button.onkeydown = null
      badge.button.onkeyup = null
      badge.button.remove()
      badges.delete(id)
    }
    cleanups.push(() => {
      decorations = []
      navigation?.layer.remove()
      navigation = undefined
      for (const [id, badge] of badges) removeBadge(id, badge)
    })
    const redraw = (): void => {
      if (!mounted) return
      const bounds = navigation !== undefined || decorations.length > 0 ? visibleBounds(element) : null
      const visibleGeometry = (interval: MarkdownTextInterval): readonly MarkdownTextRectangle[] => bounds === null
        ? [] : (geometry(interval) ?? []).flatMap(rect => clipRectangle(rect, bounds))
      if (navigation !== undefined) {
        navigation.layer.replaceChildren()
        for (const rect of visibleGeometry(navigation.interval)) {
          const mark = document.createElement('span')
          mark.className = css.navigationMark as string
          Object.assign(mark.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
          navigation.layer.append(mark)
        }
      }
      for (const mark of layer.querySelectorAll('[role="mark"]')) mark.remove()
      const actionable = new Set(decorations.filter(value => value.activation !== undefined && accepts(value)).map(value => value.id))
      for (const [id, badge] of badges) if (!actionable.has(id)) removeBadge(id, badge)
      const placed: MarkdownTextRectangle[] = []
      for (const decoration of decorations) {
        const rects = visibleGeometry(decoration)
        for (const rect of rects) {
          const mark = document.createElement('span')
          mark.className = css.mark as string
          mark.setAttribute('role', 'mark')
          mark.setAttribute('aria-label', decoration.label)
          mark.dataset.decorationId = decoration.id
          Object.assign(mark.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
          layer.append(mark)
        }
        if (!actionable.has(decoration.id) || decoration.activation === undefined) continue
        let badge = badges.get(decoration.id)
        if (badge === undefined) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = css.badge as string
          button.dataset.decorationId = decoration.id
          const entry: Badge = {
            button, activation: decoration.activation,
          }
          const guard = composition ??= observeComposition(document)
          let suppressSpace = false
          button.onclick = (event) => {
            event.stopPropagation()
            if (mounted && !button.hidden) entry.activation?.activate()
          }
          button.onkeydown = (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.stopPropagation()
            const guarded = guard.guards(event)
            if (event.key === ' ' && !event.repeat) suppressSpace = guarded
            if (guarded || event.repeat) event.preventDefault()
          }
          button.onkeyup = (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.stopPropagation()
            if (event.key === ' ' && suppressSpace) event.preventDefault()
            suppressSpace = false
          }
          badges.set(decoration.id, entry)
          layer.append(button)
          badge = entry
        }
        badge.button.textContent = decoration.label
        badge.button.setAttribute('aria-label', decoration.activation.label)
        const end = rects.at(-1)
        badge.activation = end === undefined ? undefined : decoration.activation
        badge.button.hidden = end === undefined
        if (end === undefined || bounds === null) continue
        if (!layer.isConnected) document.body.append(layer)
        const size = badge.button.getBoundingClientRect()
        const width = size.width
        const height = size.height
        if (width > bounds.right - bounds.left || height > bounds.bottom - bounds.top) {
          badge.button.hidden = true
          badge.activation = undefined
          continue
        }
        const x = Math.max(bounds.left, Math.min(end.x + end.width, bounds.right - width))
        const anchor = Math.max(bounds.top, Math.min(end.y, bounds.bottom - height))
        const candidates = [anchor, ...placed.flatMap(previous => [previous.y + previous.height, previous.y - height])]
          .filter(y => y >= bounds.top && y + height <= bounds.bottom)
          .sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor))
        // Keep each overlapping action reachable, including near the viewport bottom.
        const y = candidates.find(y => placed.every(previous => x >= previous.x + previous.width || x + width <= previous.x
          || y >= previous.y + previous.height || y + height <= previous.y)) ?? anchor
        placed.push({ x, y, width, height })
        Object.assign(badge.button.style, { left: `${x}px`, top: `${y}px` })
      }
      if (layer.childNodes.length > 0 && !layer.isConnected) document.body.append(layer)
      if (layer.childNodes.length === 0) layer.remove()
    }
    redraws.push(redraw)
    surfaces.push({
      id, text, accepts, geometry,
      selection: () => {
        const selection = document.getSelection()
        if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return null
        const range = selection.getRangeAt(0)
        if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null
        if (crossesExcluded(range)) return null
        const start = offsets.get(range.startContainer)?.get(range.startOffset)
        const end = offsets.get(range.endContainer)?.get(range.endOffset)
        if (start === undefined || end === undefined || !accepts({ start, end })) return null
        return { start, end }
      },
      reveal: (interval) => {
        if (!mounted) return () => {}
        element.scrollIntoView({ block: 'center', inline: 'nearest' })
        navigation?.layer.remove()
        navigation = undefined
        if (interval === undefined || !accepts(interval)) return () => {}
        const highlight = document.createElement('div')
        highlight.className = `${css.layer} ${css.navigationLayer}`
        highlight.dataset.chatTextRangeHighlighted = 'true'
        highlight.setAttribute('aria-hidden', 'true')
        navigation = { interval: { start: interval.start, end: interval.end }, layer: highlight }
        document.body.append(highlight)
        redraw()
        return () => {
          highlight.remove()
          if (navigation?.layer === highlight) navigation = undefined
        }
      },
      decorate: (value) => { if (mounted) { decorations = value; redraw() } },
    })
  }
  const redraw = (): void => { for (const update of redraws) update() }
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(redraw)
  resize?.observe(root)
  if (resize !== undefined) {
    for (let node = root.parentElement; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (clipsOverflow(style.overflowX || style.overflow) || clipsOverflow(style.overflowY || style.overflow)) resize.observe(node)
    }
  }
  document.addEventListener('scroll', redraw, true)
  window.addEventListener('resize', redraw)
  window.visualViewport?.addEventListener('resize', redraw)
  window.visualViewport?.addEventListener('scroll', redraw)
  const unregister = observe(surfaces)
  return () => {
    mounted = false
    for (const cleanup of cleanups) cleanup()
    composition?.dispose()
    unregister()
    resize?.disconnect()
    document.removeEventListener('scroll', redraw, true)
    window.removeEventListener('resize', redraw)
    window.visualViewport?.removeEventListener('resize', redraw)
    window.visualViewport?.removeEventListener('scroll', redraw)
    for (const layer of layers) layer.remove()
  }
}

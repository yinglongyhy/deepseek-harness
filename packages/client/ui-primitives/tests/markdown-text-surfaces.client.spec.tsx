// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createElement } from 'react'
import { observeTextSurfaces, type MarkdownTextSurface } from '../src/markdown/text-surfaces.ts'
import { MarkdownText } from './markdown-test-components.tsx'
import css from '../src/markdown/text-surfaces.module.css'

afterEach(() => { cleanup(); document.getSelection()?.removeAllRanges(); vi.restoreAllMocks() })

function select(start: Node, startOffset: number, end: Node, endOffset: number): void {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function captureMeasuredRanges(): Range[] {
  const ranges: Range[] = []
  const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: function (this: Range) { ranges.push(this.cloneRange()); return [{ left: 0, top: 0, width: 10, height: 10 }] },
  })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Range.prototype, 'getClientRects')
    else Object.defineProperty(Range.prototype, 'getClientRects', descriptor)
  })
  return ranges
}

function observeFixture(root: HTMLElement): readonly MarkdownTextSurface[] {
  let surfaces: readonly MarkdownTextSurface[] = []
  onTestFinished(observeTextSurfaces(root, (value) => { surfaces = value; return () => {} }))
  return surfaces
}

describe('owned Markdown visible-text surfaces', () => {
  it('reveals exact inline-code ranges without changing text, redraws on scroll and cleans up replacement and unmount', () => {
    const view = render(<p>Before <code>retry</code> after</p>)
    const paragraph = view.container.querySelector('p')!
    paragraph.scrollIntoView = vi.fn()
    const ranges = captureMeasuredRanges()
    let surfaces: readonly MarkdownTextSurface[] = []
    const dispose = observeTextSurfaces(view.container, (value) => { surfaces = value; return () => {} })
    onTestFinished(dispose)
    const surface = surfaces[0]!
    const clearFirst = surface.reveal({ start: 7, end: 12 })
    const locator = '[data-chat-text-range-highlighted="true"]'
    const first = document.querySelector(locator)!
    expect(first.children).toHaveLength(1)
    expect(first.getAttribute('aria-hidden')).toBe('true')
    expect(ranges.at(-1)!.toString()).toBe('retry')
    const original = paragraph.innerHTML
    fireEvent.scroll(document)
    expect(document.querySelector(locator)).toBe(first)
    expect(paragraph.innerHTML).toBe(original)
    const clearSecond = surface.reveal({ start: 0, end: 6 })
    expect(first.isConnected).toBe(false)
    clearFirst()
    expect(document.querySelector(locator)).not.toBeNull()
    clearSecond()
    clearSecond()
    expect(document.querySelector(locator)).toBeNull()
    surface.reveal({ start: -1, end: 6 })()
    expect(document.querySelector(locator)).toBeNull()
    surface.reveal({ start: 7, end: 12 })
    dispose()
    expect(document.querySelector(locator)).toBeNull()
    surface.reveal({ start: 7, end: 12 })()
    expect(document.querySelector(locator)).toBeNull()
  })

  it('maps collapsed spaces and soft line breaks to visible UTF-16 selection offsets', () => {
    let surfaces: readonly MarkdownTextSurface[] = []
    const view = render(<MarkdownText text={'Alpha   😀\nbravo'} observeSurfaces={(value) => { surfaces = value; return () => {} }} />)
    const surface = surfaces[0]!
    const ranges = captureMeasuredRanges()
    const node = view.container.querySelector('p')!.firstChild!
    select(node, 8, node, 16)
    expect(surface.text).toBe('Alpha 😀 bravo')
    expect(surface.selection()).toEqual({ start: 6, end: 14 })
    surface.geometry({ start: 6, end: 14 })
    expect(ranges[0]!.startContainer).toBe(node)
    expect(ranges[0]!.startOffset).toBe(8)
    expect(ranges[0]!.endOffset).toBe(16)
    expect(surface.accepts({ start: 7, end: 14 })).toBe(false)
  })

  it.each(['normal', 'nowrap'] as const)('collapses %s whitespace across inline nodes and trims surface edges', (mode) => {
    const view = render(<div style={{ whiteSpace: mode }}><p>{' \tAlpha  '}<strong>{' \t😀\n'}</strong><em>{' bravo \t '}</em></p></div>)
    const surface = observeFixture(view.container)[0]!
    const ranges = captureMeasuredRanges()
    const paragraph = view.container.querySelector('p')!
    const strong = paragraph.querySelector('strong')!.firstChild!
    const em = paragraph.querySelector('em')!.firstChild!
    expect(surface.text).toBe('Alpha 😀 bravo')
    select(strong, 2, em, 6)
    expect(surface.selection()).toEqual({ start: 6, end: 14 })
    surface.geometry({ start: 6, end: 14 })
    expect(ranges[0]!.startContainer).toBe(strong)
    expect(ranges[0]!.startOffset).toBe(2)
    expect(ranges[0]!.endContainer).toBe(em)
    expect(ranges[0]!.endOffset).toBe(6)
    select(paragraph, 0, paragraph, paragraph.childNodes.length)
    expect(surface.selection()).toEqual({ start: 0, end: 14 })
    surface.geometry({ start: 0, end: 14 })
    expect(ranges[1]!.startOffset).toBe(2)
    expect(ranges[1]!.endOffset).toBe(6)
    expect(surface.accepts({ start: 7, end: 14 })).toBe(false)
  })

  it('trims collapsed whitespace around authored BR while keeping its newline addressable', () => {
    const view = render(<p>{'  Alpha \t'}<br />{'\n \t😀  '}</p>)
    const surface = observeFixture(view.container)[0]!
    const paragraph = view.container.querySelector('p')!
    const ranges = captureMeasuredRanges()
    expect(surface.text).toBe('Alpha\n😀')
    select(paragraph.firstChild!, 2, paragraph.lastChild!, 5)
    expect(surface.selection()).toEqual({ start: 0, end: 8 })
    surface.geometry({ start: 5, end: 6 })
    expect(ranges[0]!.startContainer).toBe(paragraph)
    expect(ranges[0]!.startOffset).toBe(1)
    expect(ranges[0]!.endOffset).toBe(2)
    surface.geometry({ start: 6, end: 8 })
    expect(ranges[1]!.startContainer).toBe(paragraph.lastChild)
    expect(ranges[1]!.startOffset).toBe(3)
    expect(ranges[1]!.endOffset).toBe(5)
  })

  it.each(['button', 'math', 'img'] as const)('keeps whitespace on either side of excluded %s independently selectable', (tag) => {
    const excludedNode = createElement(tag, tag === 'img' ? { alt: 'excluded' } : null, tag === 'img' ? undefined : 'excluded')
    const view = render(<p>{'before   '}{excludedNode}{'   after'}</p>)
    const surface = observeFixture(view.container)[0]!
    const paragraph = view.container.querySelector('p')!
    const ranges = captureMeasuredRanges()
    expect(surface.text).toBe('before  after')
    select(paragraph.firstChild!, 0, paragraph.firstChild!, 9)
    expect(surface.selection()).toEqual({ start: 0, end: 7 })
    expect(surface.accepts({ start: 0, end: 7 })).toBe(true)
    surface.geometry({ start: 0, end: 7 })
    expect(ranges[0]!.toString()).toBe('before   ')
    select(paragraph.lastChild!, 0, paragraph.lastChild!, 8)
    expect(surface.selection()).toEqual({ start: 7, end: 13 })
    expect(surface.accepts({ start: 7, end: 13 })).toBe(true)
    surface.geometry({ start: 7, end: 13 })
    expect(ranges[1]!.toString()).toBe('   after')
    expect(surface.accepts({ start: 0, end: 13 })).toBe(false)
    select(paragraph.firstChild!, 0, paragraph.lastChild!, 8)
    expect(surface.selection()).toBeNull()
  })

  it.each(['pre', 'pre-wrap', 'break-spaces'] as const)('preserves whitespace and raw DOM offsets in %s mode', (mode) => {
    const text = '  Alpha\t😀\nbravo  '
    const view = render(<div style={{ whiteSpace: mode }}><p>{text}</p></div>)
    const surface = observeFixture(view.container)[0]!
    const node = view.container.querySelector('p')!.firstChild!
    const ranges = captureMeasuredRanges()
    expect(surface.text).toBe(text)
    select(node, 2, node, text.length - 2)
    const interval = { start: 2, end: text.length - 2 }
    expect(surface.selection()).toEqual(interval)
    surface.geometry(interval)
    expect(ranges[0]!.startOffset).toBe(interval.start)
    expect(ranges[0]!.endOffset).toBe(interval.end)
  })

  it('preserves soft newlines but collapses and trims spaces in pre-line mode', () => {
    const view = render(<p style={{ whiteSpace: 'pre-line' }}>{'  Alpha \t😀 \n  bravo  '}</p>)
    const surface = observeFixture(view.container)[0]!
    expect(surface.text).toBe('Alpha 😀\nbravo')
  })

  it('omits a surface when its computed whitespace mode cannot be mapped', () => {
    const view = render(<p style={{ whiteSpace: 'preserve-spaces' }}>Unsupported text mode</p>)
    expect(observeFixture(view.container)).toEqual([])
  })

  it('maps inline marks, Chinese, emoji and hard breaks without selecting chrome or fences', () => {
    let surfaces: readonly MarkdownTextSurface[] = []
    const unregister = vi.fn()
    const observe = vi.fn((value: readonly MarkdownTextSurface[]) => { surfaces = value; return unregister })
    const view = render(<MarkdownText text={'中**文**😀 [link](https://example.com) `code`  \nnext\n\n```ts\nfenced\n```\n\n![alt](https://example.com/a.png)'} observeSurfaces={observe} />)
    const surface = surfaces.find(surface => surface.text.startsWith('中文'))!
    expect(surface.text).toBe('中文😀 link code\nnext')
    expect(surfaces.some(surface => surface.text.includes('fenced') || surface.text.includes('alt'))).toBe(false)
    const paragraph = view.container.querySelector('p')!
    select(paragraph.firstChild!, 0, paragraph.querySelector('a')!.lastChild!, 4)
    expect(surface.selection(), paragraph.outerHTML).toEqual({ start: 0, end: 9 })
    expect(surface.accepts({ start: 2, end: 3 })).toBe(false)
    expect(surface.accepts({ start: 3, end: 4 })).toBe(false)
    expect(surface.accepts({ start: 2, end: 4 })).toBe(true)
    const tail = paragraph.lastChild!
    select(paragraph.firstChild!, 0, tail, tail.textContent!.length)
    const crossing = { start: 0, end: surface.text.length }
    expect(surface.selection()).toEqual(crossing)
    expect(surface.accepts(crossing)).toBe(true)
    const ranges = captureMeasuredRanges()
    expect(surface.geometry(crossing)).not.toBeNull()
    expect(ranges[0]!.toString()).toContain('code')
    surface.decorate([{ ...crossing, id: 'crossing-code', label: 'Inline code span' }])
    expect(document.querySelector('[aria-label="Inline code span"]')).not.toBeNull()
    const priorId = surface.id
    view.unmount()
    expect(unregister).toHaveBeenCalledOnce()
    render(<MarkdownText text={'中**文**😀 [link](https://example.com) `code`  \nnext'} observeSurfaces={observe} />)
    expect(surfaces[0]!.id).toBe(priorId)
  })

  it.each(['paragraph', 'table cell'] as const)('maps selections inside and across inline code in a %s', (kind) => {
    const markdown = kind === 'paragraph' ? 'Before `retry😀()` after'
      : '| Check |\n| --- |\n| Before `retry😀()` after |'
    const view = render(<MarkdownText text={markdown} />)
    const surface = observeFixture(view.container).find(value => value.text === 'Before retry😀() after')!
    const element = view.container.querySelector(kind === 'paragraph' ? 'p' : 'td')!
    const code = element.querySelector('code')!.firstChild!
    select(code, 0, code, code.textContent!.length)
    expect(surface.selection()).toEqual({ start: 7, end: 16 })
    expect(surface.text.slice(7, 16)).toBe('retry😀()')
    expect(surface.accepts({ start: 12, end: 13 })).toBe(false)
    select(element.firstChild!, 0, element.lastChild!, element.lastChild!.textContent!.length)
    const interval = { start: 0, end: surface.text.length }
    expect(surface.selection()).toEqual(interval)
    const ranges = captureMeasuredRanges()
    expect(surface.geometry(interval)).not.toBeNull()
    expect(ranges[0]!.toString()).toBe('Before retry😀() after')
    surface.decorate([{ ...interval, id: 'inline-code', label: 'Quoted inline code' }])
    expect(document.querySelector('[aria-label="Quoted inline code"]')).not.toBeNull()
    expect(element.textContent).toBe('Before retry😀() after')
  })

  it('rejects math and image crossings after image failure and keeps nested list prose independently addressable', () => {
    let surfaces: readonly MarkdownTextSurface[] = []
    const text = 'before $x$ after\n\nbefore ![caption](https://example.com/image.png) after\n\nbefore ![inert](unsupported:asset) after\n\n- Parent\n  - Child'
    const view = render(<MarkdownText text={text} observeSurfaces={(value) => { surfaces = value; return () => {} }} />)
    const paragraphs = view.container.querySelectorAll('p')
    for (let index = 0; index < 3; index++) {
      const paragraph = paragraphs[index]!
      const surface = surfaces[index]!
      expect(surface.text).toBe('before  after')
      const interval = { start: 0, end: surface.text.length }
      expect(surface.accepts(interval)).toBe(false)
      expect(surface.geometry(interval)).toBeNull()
      select(paragraph.firstChild!, 0, paragraph.lastChild!, 6)
      expect(surface.selection()).toBeNull()
    }
    const imageSurface = surfaces[1]!
    fireEvent.error(view.container.querySelector('img')!)
    expect(imageSurface.accepts({ start: 0, end: imageSurface.text.length })).toBe(false)
    expect(imageSurface.geometry({ start: 0, end: imageSurface.text.length })).toBeNull()
    expect(surfaces.some(surface => surface.text.trim() === 'Parent')).toBe(true)
    expect(surfaces.some(surface => surface.text.trim() === 'Child')).toBe(true)
    const items = view.container.querySelectorAll('li')
    select(items[0]!.firstChild!, 0, items[1]!.firstChild!, 5)
    expect(surfaces.every(surface => surface.selection() === null)).toBe(true)
  })

  it('rejects cross-cell, cross-block, cross-root selections and registers no streaming partials', () => {
    let surfaces: readonly MarkdownTextSurface[] = []
    const observe = (value: readonly MarkdownTextSurface[]) => { surfaces = value; return () => {} }
    const text = 'First\n\nSecond\n\n| A | B |\n| --- | --- |\n| 中国😀 | two |'
    const view = render(<MarkdownText text={text} observeSurfaces={observe} />)
    const paragraphs = view.container.querySelectorAll('p')
    select(paragraphs[0]!.firstChild!, 0, paragraphs[1]!.firstChild!, 2)
    expect(surfaces.every(surface => surface.selection() === null)).toBe(true)
    const cells = view.container.querySelectorAll('td')
    select(cells[0]!.firstChild!, 0, cells[1]!.firstChild!, 2)
    expect(surfaces.every(surface => surface.selection() === null)).toBe(true)
    select(cells[0]!.firstChild!, 1, cells[0]!.firstChild!, 4)
    expect(surfaces.find(surface => surface.text === '中国😀')!.selection()).toEqual({ start: 1, end: 4 })
    const other = render(<MarkdownText text="Elsewhere" />)
    select(paragraphs[0]!.firstChild!, 0, other.container.querySelector('p')!.firstChild!, 2)
    expect(surfaces.every(surface => surface.selection() === null)).toBe(true)
    const streamingObserve = vi.fn(() => () => {})
    render(<MarkdownText text={text} streaming observeSurfaces={streamingObserve} />)
    expect(streamingObserve).not.toHaveBeenCalled()
  })

  it('measures fresh viewport geometry, preserves overlapping labels and removes overlays on cleanup', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
    const getRects = vi.fn(() => [{ left: 10, top: 20, width: 30, height: 15 }])
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: getRects })
    onTestFinished(() => {
      if (descriptor === undefined) Reflect.deleteProperty(Range.prototype, 'getClientRects')
      else Object.defineProperty(Range.prototype, 'getClientRects', descriptor)
    })
    let surfaces: readonly MarkdownTextSurface[] = []
    const view = render(<MarkdownText text="abcdef" observeSurfaces={(value) => { surfaces = value; return () => {} }} />)
    const surface = surfaces[0]!
    expect(surface.geometry({ start: 1, end: 4 })).toEqual([{ x: 10, y: 20, width: 30, height: 15 }])
    expect(surface.geometry({ start: -1, end: 4 })).toBeNull()
    surface.decorate([{ id: 'a', label: 'First label', start: 0, end: 3 }, { id: 'b', label: 'Second label', start: 1, end: 5 }])
    expect(document.querySelectorAll('[role="mark"]')).toHaveLength(2)
    expect(document.querySelector('[aria-label="First label"]')).not.toBeNull()
    expect(document.querySelector('[aria-label="Second label"]')).not.toBeNull()
    const before = getRects.mock.calls.length
    document.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    expect(getRects.mock.calls.length).toBeGreaterThan(before)
    view.unmount()
    expect(document.querySelectorAll('[role="mark"]')).toHaveLength(0)
    const count = getRects.mock.calls.length
    window.dispatchEvent(new Event('resize'))
    expect(getRects).toHaveBeenCalledTimes(count)
  })

  it('clips marks and badge placement to nested scrollports and restores the same badge after scrolling', () => {
    let rects = [{ left: 80, top: 120, width: 80, height: 30 }]
    const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => rects })
    onTestFinished(() => {
      if (descriptor === undefined) Reflect.deleteProperty(Range.prototype, 'getClientRects')
      else Object.defineProperty(Range.prototype, 'getClientRects', descriptor)
    })
    const view = render(<div style={{ overflowY: 'auto' }}><div style={{ overflowX: 'hidden' }}><p>abcdef</p></div></div>)
    const vertical = view.container.firstElementChild as HTMLElement
    const horizontal = vertical.firstElementChild as HTMLElement
    const measure = (element: HTMLElement, x: number, y: number, width: number, height: number): void => {
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, width, height))
      Object.defineProperties(element, {
        clientWidth: { configurable: true, value: width }, clientHeight: { configurable: true, value: height },
        offsetWidth: { configurable: true, value: width }, offsetHeight: { configurable: true, value: height },
      })
    }
    measure(vertical, 0, 100, 300, 40)
    measure(horizontal, 100, 0, 40, 300)
    const paragraph = view.container.querySelector('p')!
    paragraph.scrollIntoView = vi.fn()
    const surface = observeFixture(view.container)[0]!
    const activate = vi.fn()
    surface.decorate([{ id: 'a', label: 'Badge', start: 0, end: 3, activation: { label: 'Open annotation', activate } }])
    const button = document.querySelector<HTMLButtonElement>('button[data-decoration-id="a"]')!
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 24, 24))
    surface.reveal({ start: 0, end: 3 })
    for (const mark of document.querySelectorAll<HTMLElement>('[role="mark"],[data-chat-text-range-highlighted] span')) {
      expect([mark.style.left, mark.style.top, mark.style.width, mark.style.height]).toEqual(['100px', '120px', '40px', '20px'])
    }
    expect([button.style.left, button.style.top]).toEqual(['116px', '116px'])
    expect(button.hidden).toBe(false)
    rects = [{ left: 80, top: 160, width: 80, height: 30 }]
    fireEvent.scroll(vertical)
    expect(document.querySelectorAll('[role="mark"],[data-chat-text-range-highlighted] span')).toHaveLength(0)
    expect(button.hidden).toBe(true)
    button.click()
    expect(activate).not.toHaveBeenCalled()
    rects = [{ left: 80, top: 120, width: 80, height: 30 }]
    fireEvent.scroll(horizontal)
    expect(document.querySelector('button[data-decoration-id="a"]')).toBe(button)
    expect(button.hidden).toBe(false)
    button.click()
    expect(activate).toHaveBeenCalledOnce()
    expect(document.querySelectorAll('[role="mark"],[data-chat-text-range-highlighted] span')).toHaveLength(2)
    rects = [{ left: 80, top: 100, width: 80, height: 30 }]
    Object.defineProperty(vertical, 'clientHeight', { configurable: true, value: 10 })
    fireEvent.resize(window)
    expect(document.querySelector<HTMLElement>('[role="mark"]')!.style.height).toBe('10px')
    expect(button.hidden).toBe(true)
    button.click()
    expect(activate).toHaveBeenCalledOnce()
  })

  it.each(['auto', 'scroll', 'hidden', 'clip'] as const)('uses scaled client bounds without borders or scrollbars for overflow %s', (overflow) => {
    captureMeasuredRanges()
    const view = render(<div style={{ overflowX: overflow, overflowY: overflow }}><p>abcdef</p></div>)
    const viewport = view.container.firstElementChild as HTMLElement
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(-10, -10, 200, 200))
    Object.defineProperties(viewport, {
      offsetWidth: { configurable: true, value: 100 }, offsetHeight: { configurable: true, value: 100 },
      clientLeft: { configurable: true, value: 6 }, clientTop: { configurable: true, value: 7 },
      clientWidth: { configurable: true, value: 80 }, clientHeight: { configurable: true, value: 80 },
    })
    const surface = observeFixture(view.container)[0]!
    expect(surface.geometry({ start: 0, end: 3 })).toEqual([{ x: 0, y: 0, width: 10, height: 10 }])
    surface.decorate([{ id: 'a', label: 'Badge', start: 0, end: 3 }])
    const mark = document.querySelector<HTMLElement>('[role="mark"]')!
    expect([mark.style.left, mark.style.top, mark.style.width, mark.style.height]).toEqual(['2px', '4px', '8px', '6px'])
  })

  it('keeps passive highlights noninteractive and activates only the visible badge without bubbling', () => {
    captureMeasuredRanges()
    let surfaces: readonly MarkdownTextSurface[] = []
    const view = render(<MarkdownText text="abcdef" observeSurfaces={(value) => { surfaces = value; return () => {} }} />)
    const surface = surfaces[0]!
    surface.decorate([{ id: 'passive', label: 'Passive label', start: 0, end: 3 }])
    expect(document.querySelectorAll('button[data-decoration-id]')).toHaveLength(0)
    const activate = vi.fn()
    const bubbled = vi.fn()
    document.addEventListener('click', bubbled)
    onTestFinished(() => { document.removeEventListener('click', bubbled) })
    surface.decorate([{ id: 'action', label: 'Visible label', start: 0, end: 3, activation: { label: 'Open annotation', activate } }])
    const button = document.querySelector<HTMLButtonElement>('button[data-decoration-id="action"]')!
    expect(button.parentElement!.className).toBe(css.layer)
    expect(button.parentElement!.parentElement).toBe(document.body)
    expect(button.className).toBe(css.badge)
    expect(button.type).toBe('button')
    expect(button.textContent).toBe('Visible label')
    expect(button.getAttribute('aria-label')).toBe('Open annotation')
    fireEvent.click(button)
    expect(activate).toHaveBeenCalledOnce()
    expect(bubbled).not.toHaveBeenCalled()
    expect(view.container.querySelector('p')!.textContent).toBe('abcdef')
  })

  it('leaves native Enter and Space defaults intact, isolates keys and suppresses repeat and IME defaults', () => {
    captureMeasuredRanges()
    let surfaces: readonly MarkdownTextSurface[] = []
    render(<MarkdownText text="abcdef" observeSurfaces={(value) => { surfaces = value; return () => {} }} />)
    const activate = vi.fn()
    surfaces[0]!.decorate([{ id: 'a', label: 'Badge', start: 0, end: 3, activation: { label: 'Open annotation', activate } }])
    const button = document.querySelector<HTMLButtonElement>('button[data-decoration-id]')!
    const bubbled = vi.fn()
    document.addEventListener('keydown', bubbled)
    document.addEventListener('keyup', bubbled)
    onTestFinished(() => {
      document.removeEventListener('keydown', bubbled)
      document.removeEventListener('keyup', bubbled)
    })
    button.focus()
    for (const key of ['Enter', ' ']) {
      expect(fireEvent.keyDown(button, { key })).toBe(true)
      expect(fireEvent.keyUp(button, { key })).toBe(true)
      expect(activate).not.toHaveBeenCalled()
    }
    expect(bubbled).not.toHaveBeenCalled()
    // jsdom has no native keyboard-to-click default; browser e2e owns Enter/Space activation.
    fireEvent.click(button, { detail: 0 })
    expect(activate).toHaveBeenCalledOnce()
    expect(fireEvent.keyDown(button, { key: 'Enter', repeat: true })).toBe(false)
    expect(fireEvent.keyDown(button, { key: ' ', isComposing: true })).toBe(false)
    expect(fireEvent.keyUp(button, { key: ' ' })).toBe(false)
    fireEvent.compositionStart(button)
    fireEvent.compositionEnd(button)
    expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(false)
    expect(fireEvent.keyDown(button, { key: 'Enter', keyCode: 229 })).toBe(false)
    expect(activate).toHaveBeenCalledOnce()
  })

  it('keeps overlapping badges distinct and retains focused identities through redraw and owner updates', () => {
    captureMeasuredRanges()
    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 60, 24))
    let surfaces: readonly MarkdownTextSurface[] = []
    render(<MarkdownText text="abcdef" observeSurfaces={(value) => { surfaces = value; return () => {} }} />)
    const first = vi.fn()
    const second = vi.fn()
    const replacement = vi.fn()
    const surface = surfaces[0]!
    surface.decorate([
      { id: 'a', label: 'First', start: 0, end: 3, activation: { label: 'Open first', activate: first } },
      { id: 'b', label: 'Second', start: 1, end: 5, activation: { label: 'Open second', activate: second } },
    ])
    const a = document.querySelector<HTMLButtonElement>('button[data-decoration-id="a"]')!
    const b = document.querySelector<HTMLButtonElement>('button[data-decoration-id="b"]')!
    expect(a.style.top).not.toBe(b.style.top)
    fireEvent.click(a)
    fireEvent.click(b)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    a.focus()
    document.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    expect(document.activeElement).toBe(a)
    surface.decorate([
      { id: 'b', label: 'Second', start: 2, end: 6, activation: { label: 'Open second', activate: second } },
      { id: 'a', label: 'Updated', start: 1, end: 4, activation: { label: 'Open updated', activate: replacement } },
    ])
    expect(document.querySelector('button[data-decoration-id="a"]')).toBe(a)
    expect(document.querySelector('button[data-decoration-id="b"]')).toBe(b)
    expect(document.activeElement).toBe(a)
    expect(a.textContent).toBe('Updated')
    expect(a.getAttribute('aria-label')).toBe('Open updated')
    fireEvent.click(a)
    expect(replacement).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledOnce()
  })

  it('clears retained handlers on removal, passive replacement and unmount, including id reuse', () => {
    captureMeasuredRanges()
    let surfaces: readonly MarkdownTextSurface[] = []
    const unregister = vi.fn()
    const view = render(<MarkdownText text="abcdef" observeSurfaces={(value) => { surfaces = value; return unregister }} />)
    const surface = surfaces[0]!
    const activate = vi.fn()
    const decoration = { id: 'a', label: 'Badge', start: 0, end: 3, activation: { label: 'Open annotation', activate } }
    surface.decorate([decoration])
    const removed = document.querySelector<HTMLButtonElement>('button[data-decoration-id]')!
    const queuedClick = removed.onclick!
    surface.decorate([])
    expect(removed.onclick).toBeNull()
    expect(removed.onkeydown).toBeNull()
    expect(removed.onkeyup).toBeNull()
    surface.decorate([decoration])
    const passive = document.querySelector<HTMLButtonElement>('button[data-decoration-id]')!
    expect(passive).not.toBe(removed)
    removed.click()
    queuedClick.call(removed, new PointerEvent('click'))
    expect(activate).not.toHaveBeenCalled()
    surface.decorate([{ id: 'a', label: 'Passive', start: 0, end: 3 }])
    passive.click()
    expect(passive.onclick).toBeNull()
    surface.decorate([decoration])
    const unmounted = document.querySelector<HTMLButtonElement>('button[data-decoration-id]')!
    view.unmount()
    expect(unregister).toHaveBeenCalledOnce()
    unmounted.click()
    surface.decorate([decoration])
    window.dispatchEvent(new Event('resize'))
    document.dispatchEvent(new Event('scroll'))
    expect(activate).not.toHaveBeenCalled()
    expect(unmounted.onclick).toBeNull()
    expect(document.querySelectorAll('button[data-decoration-id]')).toHaveLength(0)
  })

  it('rejects invalid actions and leaves table DOM and source selection unchanged', () => {
    captureMeasuredRanges()
    let surfaces: readonly MarkdownTextSurface[] = []
    const view = render(<MarkdownText text={'| A | B |\n| --- | --- |\n| 中国😀 | two |'} observeSurfaces={(value) => { surfaces = value; return () => {} }} />)
    const source = view.container.innerHTML
    const surface = surfaces.find(value => value.text === '中国😀')!
    const cell = view.container.querySelector('td')!
    const node = cell.firstChild!
    select(node, 1, node, 4)
    const activate = vi.fn()
    const activation = { label: 'Open annotation', activate }
    surface.decorate([
      { id: 'negative', label: 'Invalid', start: -1, end: 2, activation },
      { id: 'empty', label: 'Invalid', start: 1, end: 1, activation },
      { id: 'split', label: 'Invalid', start: 2, end: 3, activation },
      { id: 'past', label: 'Invalid', start: 0, end: 5, activation },
      { id: 'fraction', label: 'Invalid', start: 0.5, end: 2, activation },
      { id: 'valid', label: 'Valid', start: 1, end: 4, activation },
    ])
    const buttons = document.querySelectorAll<HTMLButtonElement>('button[data-decoration-id]:not([hidden])')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.dataset.decorationId).toBe('valid')
    expect(view.container.innerHTML).toBe(source)
    expect(cell.firstChild).toBe(node)
    expect(surface.selection()).toEqual({ start: 1, end: 4 })
    expect(document.getSelection()!.toString()).toBe('国😀')
  })

  it('keeps overlapping targets within the viewport when the source sits at the bottom edge', () => {
    captureMeasuredRanges()
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true,
      value: () => [{ left: window.innerWidth - 30, top: window.innerHeight - 10, width: 30, height: 10 }] })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 30, 24))
    let surfaces: readonly MarkdownTextSurface[] = []
    render(<MarkdownText text="abcdef" observeSurfaces={(value) => { surfaces = value; return () => {} }} />)
    const activate = vi.fn()
    surfaces[0]!.decorate([
      { id: 'first', label: '1', start: 0, end: 3, activation: { label: 'Edit first', activate } },
      { id: 'second', label: '2', start: 0, end: 3, activation: { label: 'Edit second', activate } },
    ])
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-decoration-id]'))
    const positions = buttons.map(button => Number.parseFloat(button.style.top))
    expect(positions).toEqual([window.innerHeight - 24, window.innerHeight - 48])
    expect(buttons.map(button => Number.parseFloat(button.style.left))).toEqual([window.innerWidth - 30, window.innerWidth - 30])
  })

  it('hides badges with zero, hidden or off-viewport geometry and preserves identity when visible again', () => {
    captureMeasuredRanges()
    let rects = [{ left: 0, top: 0, width: 0, height: 0 }]
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => rects })
    let surfaces: readonly MarkdownTextSurface[] = []
    const view = render(<MarkdownText text="abcdef" observeSurfaces={(value) => { surfaces = value; return () => {} }} />)
    const activate = vi.fn()
    surfaces[0]!.decorate([{ id: 'a', label: 'Badge', start: 0, end: 3, activation: { label: 'Open annotation', activate } }])
    const button = document.querySelector<HTMLButtonElement>('button[data-decoration-id]')!
    expect(button.hidden).toBe(true)
    button.click()
    rects = [{ left: 10, top: 20, width: 30, height: 15 }]
    window.dispatchEvent(new Event('resize'))
    expect(button.hidden).toBe(false)
    rects = [{ left: 10, top: -100, width: 30, height: 15 }]
    document.dispatchEvent(new Event('scroll'))
    expect(button.hidden).toBe(true)
    button.click()
    rects = [{ left: 10, top: 20, width: 30, height: 15 }]
    const paragraph = view.container.querySelector('p')!
    paragraph.style.visibility = 'hidden'
    window.dispatchEvent(new Event('resize'))
    expect(button.hidden).toBe(true)
    paragraph.style.visibility = 'visible'
    window.dispatchEvent(new Event('resize'))
    expect(button.hidden).toBe(false)
    expect(document.querySelector('button[data-decoration-id]')).toBe(button)
    expect(activate).not.toHaveBeenCalled()
  })
})

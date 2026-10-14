/** Host-owned mounted text and reversible plugin decoration registrations. */
import type { Context } from '@deepseek-ai/cordis'
import type { MarkdownTextDecoration, MarkdownTextSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatTextDecoration, ChatTextDecorationActivation, ChatTextDecorationHandle, ChatTextSelection, ChatTextService, ChatTextNavigationResult, ChatTextSurfaceId, ChatTextRevision } from './contract/text.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Plain source data passed to the controlled Markdown registration callback. */
export interface CompletedMarkdownSource {
  readonly sessionId: SessionId
  readonly messageId: MessageId
  readonly seq: SessionSeq
  readonly block: number
  readonly text: string
}
/** Private inject face: components receive a callback, not the service or its sources. */
export interface ChatTextInjected {
  /** Register completed owned Markdown leaves; streaming renderers never call this. */
  registerText(
    source: CompletedMarkdownSource,
    surfaces: readonly MarkdownTextSurface[],
    highlightMessage?: (active: boolean) => void,
  ): () => void
}
interface MountedSurface {
  readonly source: Omit<ChatTextSelection, 'start' | 'end' | 'selectedText'>
  readonly surface: MarkdownTextSurface
  readonly highlightMessage: ((active: boolean) => void) | undefined
}
interface Registration {
  readonly renderId: string
  generation: number
  decoration: ChatTextDecoration
  activation: ChatTextDecorationActivation | undefined
}

function snapshot(decoration: ChatTextDecoration): ChatTextDecoration {
  return Object.freeze({ ...decoration, source: Object.freeze({ ...decoration.source }) })
}

function matches(a: MountedSurface['source'], b: ChatTextSelection): boolean {
  return a.sessionId === b.sessionId && a.messageId === b.messageId && a.surfaceId === b.surfaceId
}
function isInactiveEffect(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'INACTIVE_EFFECT'
}
function unchanged(mounted: MountedSurface, source: ChatTextSelection): boolean {
  return mounted.source.revision === source.revision && mounted.source.seq === source.seq
    && mounted.surface.accepts(source) && mounted.surface.text.slice(source.start, source.end) === source.selectedText
}

/** Internal service provider; public API is the DOM-free `ChatTextService`. */
export class ChatTextHost implements ChatTextService {
  private readonly mounted = new Set<MountedSurface>()
  private readonly registrations = new Map<Context, Map<ChatTextDecoration['id'], Registration>>()
  private readonly listeners = new Set<(selection: ChatTextSelection | null) => void>()
  private readonly highlights = new Map<
    ((active: boolean) => void) | MarkdownTextSurface,
    { timer: ReturnType<typeof setTimeout>; clear: () => void }
  >()
  private disposed = false
  private registrationSeq = 0

  /** @param prepare - loads and validates durable history before requesting a mounted surface. */
  constructor(private readonly prepare: (source: ChatTextSelection) => Promise<ChatTextNavigationResult | undefined>) {}

  /** @returns the eligible selection, or null when endpoints do not share one surface. */
  selection(): ChatTextSelection | null {
    for (const mounted of this.mounted) {
      const interval = mounted.surface.selection()
      if (interval !== null) return {
        ...mounted.source, ...interval, selectedText: mounted.surface.text.slice(interval.start, interval.end),
      }
    }
    return null
  }

  /**
   * Measure an exact mounted interval.
   * @param source - exact source interval.
   * @returns fresh CSS-pixel rectangles, or null for changed/unmounted sources.
   */
  geometry(source: ChatTextSelection) {
    const mounted = [...this.mounted].find(entry => matches(entry.source, source))
    return mounted !== undefined && unchanged(mounted, source) ? mounted.surface.geometry(source) : null
  }

  /** Publish a browser selection change after the Markdown surfaces have committed. */
  readonly selectionChanged = (): void => {
    const value = this.selection()
    for (const listener of this.listeners) listener(value)
  }

  /**
   * Observe eligible selections for the caller lifetime.
   * @param owner - caller context.
   * @param listener - selection listener.
   * @returns caller-owned cleanup; await its Promise when disposing manually.
   */
  subscribe(owner: Context, listener: (selection: ChatTextSelection | null) => void): () => Promise<void> {
    return owner.effect(() => {
      const subscription = (selection: ChatTextSelection | null): void => { listener(selection) }
      this.listeners.add(subscription)
      return () => { this.listeners.delete(subscription) }
    })
  }

  /**
   * Register one reversible caller-owned decoration.
   * @param owner - caller context.
   * @param decoration - stable id, exact source and localized visible label.
   * @param activation - optional localized action name and caller-owned behavior.
   * @returns reversible registration with awaitable disposal.
   */
  register(owner: Context, decoration: ChatTextDecoration, activation?: ChatTextDecorationActivation): ChatTextDecorationHandle {
    if (this.disposed) throw new Error('chatText provider is disposed')
    const id = decoration.id
    const registration: Registration = {
      renderId: String(++this.registrationSeq), generation: 0, decoration: snapshot(decoration),
      activation: activation === undefined ? undefined : { ...activation },
    }
    const dispose = owner.effect(() => {
      registration.generation++
      let owned = this.registrations.get(owner)
      if (owned === undefined) { owned = new Map(); this.registrations.set(owner, owned) }
      const entries = owned
      entries.set(id, registration)
      this.paint()
      return () => {
        if (entries.get(id) !== registration) return
        entries.delete(id)
        if (entries.size === 0) this.registrations.delete(owner)
        this.paint()
      }
    }, 'chatText: decoration')
    return {
      dispose,
      update: (value, nextActivation) => {
        if (this.disposed || this.registrations.get(owner)?.get(id) !== registration) return
        registration.decoration = snapshot({ ...value, id })
        if (nextActivation !== undefined) registration.activation = nextActivation === null ? undefined : { ...nextActivation }
        this.paint()
      },
    }
  }

  /**
   * Bind renderer-owned surfaces to their completed durable message block.
   * @param source - durable block identity.
   * @param surfaces - primitive-owned mounted handles.
   * @param highlightMessage - private feedback callback for the whole owning response container.
   * @returns cleanup for this renderer mount.
   */
  readonly registerText = (
    source: CompletedMarkdownSource,
    surfaces: readonly MarkdownTextSurface[],
    highlightMessage?: (active: boolean) => void,
  ): (() => void) => {
    if (this.disposed) return () => {}
    const mounted = surfaces.map(surface => ({
      source: {
        sessionId: source.sessionId, messageId: source.messageId, seq: source.seq,
        surfaceId: `block:${source.block}/${surface.id}` as ChatTextSurfaceId,
        revision: source.text as ChatTextRevision, completed: true as const,
      },
      surface, highlightMessage,
    }))
    for (const entry of mounted) this.mounted.add(entry)
    this.paint()
    return () => {
      for (const entry of mounted) { entry.surface.decorate([]); this.mounted.delete(entry); this.clearHighlight(entry.surface) }
      if (highlightMessage !== undefined && ![...this.mounted].some(entry => entry.highlightMessage === highlightMessage)) {
        this.clearHighlight(highlightMessage)
      }
      this.selectionChanged()
    }
  }

  // Disposal may happen while history loading or renderer commit is awaited.
  private isDisposed(): boolean {
    return this.disposed
  }

  private paint(): void {
    for (const mounted of this.mounted) {
      const decorations: MarkdownTextDecoration[] = []
      for (const [owner, entries] of this.registrations) {
        for (const registration of entries.values()) {
          const { decoration, activation, generation } = registration
          if (matches(mounted.source, decoration.source) && unchanged(mounted, decoration.source)) {
            decorations.push({
              id: registration.renderId, label: decoration.label, start: decoration.source.start, end: decoration.source.end,
              ...(activation === undefined ? {} : { activation: {
                label: activation.label,
                activate: () => {
                  // Cordis owns admission for disposed/unloading fibers; its const enum has no runtime export.
                  // Keep the callback outside this empty effect so its own effects retain their caller lifetime.
                  try { void owner.effect(() => () => {}, 'chatText: activation admission')() }
                  catch (error) { if (isInactiveEffect(error)) return; throw error }
                  // Queued controls must still belong to this owner, source snapshot and renderer mount.
                  if (this.disposed || owner.fiber.uid === null
                    || this.registrations.get(owner)?.get(decoration.id) !== registration
                    || registration.generation !== generation
                    || registration.decoration !== decoration || registration.activation !== activation
                    || !this.mounted.has(mounted) || !unchanged(mounted, decoration.source)) return
                  try {
                    const result = activation.onActivate({ id: decoration.id, source: decoration.source })
                    if (result !== undefined) void result.catch((error: unknown) => {
                      owner.logger('chatText').error('Decoration activation failed: %s', error)
                    })
                  } catch (error) {
                    owner.logger('chatText').error('Decoration activation failed: %s', error)
                  }
                },
              } }),
            })
          }
        }
      }
      mounted.surface.decorate(decorations)
    }
  }

  /**
   * Reveal only an exact durable selection.
   * @param source - exact durable selection.
   * @returns explicit load/validation/reveal outcome.
   */
  async navigate(source: ChatTextSelection): Promise<ChatTextNavigationResult> {
    if (this.disposed) return { status: 'unavailable' }
    const result = await this.prepare(source)
    if (result !== undefined) return result
    // History completion publishes its snapshot before the renderer's next commit.
    await new Promise<void>(resolve => requestAnimationFrame(() => { resolve() }))
    if (this.isDisposed()) return { status: 'unavailable' }
    const mounted = [...this.mounted].find(entry => matches(entry.source, source))
    if (mounted === undefined) {
      return { status: [...this.mounted].some(entry => entry.source.sessionId === source.sessionId && entry.source.messageId === source.messageId) ? 'changed' : 'unavailable' }
    }
    if (!unchanged(mounted, source)) return { status: 'changed' }
    const highlight = mounted.highlightMessage ?? mounted.surface
    this.clearHighlight(highlight)
    const clearRange = mounted.surface.reveal({ start: source.start, end: source.end })
    mounted.highlightMessage?.(true)
    this.highlights.set(highlight, {
      timer: setTimeout(() => { this.clearHighlight(highlight) }, 3000),
      clear: () => { clearRange(); mounted.highlightMessage?.(false) },
    })
    return { status: 'revealed' }
  }

  private clearHighlight(highlight: ((active: boolean) => void) | MarkdownTextSurface): void {
    const active = this.highlights.get(highlight)
    if (active === undefined) return
    clearTimeout(active.timer)
    this.highlights.delete(highlight)
    active.clear()
  }

  /** Release provider-owned state and every transient overlay on provider disposal. */
  dispose(): void {
    this.disposed = true
    for (const highlight of this.highlights.keys()) this.clearHighlight(highlight)
    for (const entry of this.mounted) entry.surface.decorate([])
    this.mounted.clear()
    this.registrations.clear()
    this.listeners.clear()
  }
}

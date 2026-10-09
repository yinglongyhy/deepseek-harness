/** Device-local display selection; the current layout must match before restoring it. */
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Display } from 'electron'

type DisplayInfo = Pick<Display, 'id' | 'bounds' | 'workArea' | 'scaleFactor' | 'rotation'>

interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

interface DisplaySnapshot {
  id: number
  bounds: Rectangle
  workArea: Rectangle
  scaleFactor: number
  rotation: number
}

interface DisplayLayout {
  primaryId: number
  displays: DisplaySnapshot[]
}

interface DisplayMemoryRecord {
  version: 1
  displayId: number
  layout: DisplayLayout
}

/** Device-local monitor preference persisted separately from window geometry. */
export class DesktopDisplayMemory {
  private record: DisplayMemoryRecord | undefined
  private persistedKey: string | undefined
  private queuedKey: string | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  /** @param path - Private user-data path for the versioned display preference. */
  constructor(private readonly path: string) {}

  /**
   * Load a saved monitor preference before recording window events.
   * A missing file is ignored; invalid data and read failures warn and leave no preference.
   * @returns Resolves after reading or safely rejecting the saved preference.
   */
  async load(): Promise<void> {
    this.record = undefined
    this.persistedKey = undefined

    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      console.warn('desktop display memory: could not read saved preference', this.path, error)
      return
    }

    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      console.warn('desktop display memory: invalid saved preference JSON', this.path, error)
      return
    }

    if (!isObjectRecord(value) || value.version !== 1) {
      console.warn('desktop display memory: unsupported or missing record version', this.path,
        isObjectRecord(value) ? value.version : undefined)
      return
    }

    const record = parseRecord(value)
    if (record === undefined) {
      console.warn('desktop display memory: invalid saved preference fields', this.path)
      return
    }

    this.record = record
    this.persistedKey = recordKey(record)
  }

  /**
   * Return a centered position only when the saved monitor layout still matches.
   * @param displays - Current displays with their bounds and scale information.
   * @param primaryId - Current primary display identifier.
   * @param size - BrowserWindow's default width and height.
   * @returns The position inside the remembered work area, or `undefined` when the preference cannot be restored.
   */
  position(displays: readonly DisplayInfo[], primaryId: number,
    size: { width: number; height: number }): { x: number; y: number } | undefined {
    const record = this.record
    if (record === undefined) return undefined

    const layout = snapshotLayout(displays, primaryId)
    if (layoutKey(layout) !== layoutKey(record.layout)) return undefined

    const display = displays.find(candidate => candidate.id === record.displayId)
    if (display === undefined) return undefined

    return {
      x: display.workArea.x + Math.max(0, Math.floor((display.workArea.width - size.width) / 2)),
      y: display.workArea.y + Math.max(0, Math.floor((display.workArea.height - size.height) / 2)),
    }
  }

  /**
   * Remember the window's display and write only when the monitor or layout changes.
   * @param displays - Display layout captured when the window was created.
   * @param primaryId - Primary display identifier captured with that layout.
   * @param displayId - Display selected for the next window start.
   * @returns Resolves after this preference's queued write settles; write failures warn and do not reject.
   */
  async remember(displays: readonly DisplayInfo[], primaryId: number, displayId: number): Promise<void> {
    if (!displays.some(display => display.id === displayId)) return

    const record: DisplayMemoryRecord = {
      version: 1,
      displayId,
      layout: snapshotLayout(displays, primaryId),
    }
    this.record = record

    const key = recordKey(record)
    if (key === this.queuedKey || (this.queuedKey === undefined && key === this.persistedKey)) {
      await this.writeQueue
      return
    }

    this.queuedKey = key
    const raw = `${JSON.stringify(record, undefined, 2)}\n`
    const queuedWrite = this.writeQueue.then(async () => {
      try {
        await writeFileAtomic(this.path, raw, { mode: 0o600, dirMode: 0o700 })
        this.persistedKey = key
      } catch (error) {
        console.warn('desktop display memory: could not save preference', this.path, error)
      } finally {
        if (this.writeQueue === queuedWrite) this.queuedKey = undefined
      }
    })
    this.writeQueue = queuedWrite
    await queuedWrite
  }

  /**
   * Wait until every display preference write queued before this call settles.
   * @returns Resolves after all writes already in the queue settle.
   */
  async flush(): Promise<void> {
    await this.writeQueue
  }
}

function snapshotLayout(displays: readonly DisplayInfo[], primaryId: number): DisplayLayout {
  return {
    primaryId,
    displays: displays.map(snapshotDisplay).sort((left, right) => left.id - right.id),
  }
}

function snapshotDisplay(display: DisplayInfo): DisplaySnapshot {
  const { bounds, workArea } = display
  return {
    id: display.id,
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    workArea: { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height },
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
  }
}

function layoutKey(layout: DisplayLayout): string {
  return JSON.stringify(layout)
}

function recordKey(record: DisplayMemoryRecord): string {
  return JSON.stringify(record)
}

function parseRecord(value: Record<string, unknown>): DisplayMemoryRecord | undefined {
  if (value.version !== 1 || !isFiniteNumber(value.displayId) || !isObjectRecord(value.layout)) return undefined
  const layout = value.layout
  if (!isFiniteNumber(layout.primaryId) || !Array.isArray(layout.displays)) return undefined

  const displays: DisplaySnapshot[] = []
  for (const item of layout.displays) {
    if (!isDisplaySnapshot(item)) return undefined
    displays.push(snapshotDisplay(item))
  }

  const ids = new Set(displays.map(display => display.id))
  if (ids.size !== displays.length || !ids.has(layout.primaryId) || !ids.has(value.displayId)) return undefined

  return {
    version: 1,
    displayId: value.displayId,
    layout: {
      primaryId: layout.primaryId,
      displays: displays.sort((left, right) => left.id - right.id),
    },
  }
}

function isDisplaySnapshot(value: unknown): value is DisplaySnapshot {
  return isObjectRecord(value)
    && isFiniteNumber(value.id)
    && isRectangle(value.bounds)
    && isRectangle(value.workArea)
    && isFiniteNumber(value.scaleFactor)
    && value.scaleFactor > 0
    && isFiniteNumber(value.rotation)
}

function isRectangle(value: unknown): value is Rectangle {
  return isObjectRecord(value)
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && value.width > 0
    && isFiniteNumber(value.height)
    && value.height > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

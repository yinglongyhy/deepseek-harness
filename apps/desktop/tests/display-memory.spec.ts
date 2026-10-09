import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { Display } from 'electron'
import { DesktopDisplayMemory } from '../src/display-memory.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

type DisplayInfo = Pick<Display, 'id' | 'bounds' | 'workArea' | 'scaleFactor' | 'rotation'>
type Rectangle = DisplayInfo['bounds']
type WriterOptions = { mode: number; dirMode?: number }
type Writer = (path: string, content: string, options: WriterOptions) => Promise<void>

const writerControl = vi.hoisted(() => {
  let original: Writer | undefined
  let override: Writer | undefined
  return {
    setOriginal(writer: Writer): void { original = writer },
    setOverride(writer: Writer | undefined): void { override = writer },
    invoke(path: string, content: string, options: WriterOptions): Promise<void> {
      if (override !== undefined) return override(path, content, options)
      if (original === undefined) return Promise.reject(new Error('atomic writer is not initialized'))
      return original(path, content, options)
    },
    writeOriginal(path: string, content: string, options: WriterOptions): Promise<void> {
      if (original === undefined) return Promise.reject(new Error('atomic writer is not initialized'))
      return original(path, content, options)
    },
  }
})

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  writerControl.setOriginal(actual.writeFileAtomic)
  return {
    ...actual,
    writeFileAtomic: vi.fn((path: string, content: string, options: WriterOptions) =>
      writerControl.invoke(path, content, options)),
  }
})

afterEach(() => {
  writerControl.setOverride(undefined)
  vi.mocked(writeFileAtomic).mockClear()
  vi.restoreAllMocks()
})

const LEFT = makeDisplay(11, rectangle(-1920, 0, 1920, 1080), {
  workArea: rectangle(-1920, 28, 1920, 1052),
})
const RIGHT = makeDisplay(22, rectangle(0, 0, 2560, 1440), {
  workArea: rectangle(0, 28, 2560, 1412),
  scaleFactor: 2,
})
const DISPLAYS = [LEFT, RIGHT] as const

function rectangle(x: number, y: number, width: number, height: number): Rectangle {
  return { x, y, width, height }
}

function makeDisplay(id: number, bounds: Rectangle, options: {
  workArea?: Rectangle
  scaleFactor?: number
  rotation?: number
} = {}): DisplayInfo {
  return {
    id,
    bounds,
    workArea: options.workArea ?? bounds,
    scaleFactor: options.scaleFactor ?? 1,
    rotation: options.rotation ?? 0,
  }
}

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-display-memory-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  return join(directory, 'display-memory.json')
}

const defaultSize = { width: 1000, height: 700 }

it('returns no position when the preference file is absent', async () => {
  const path = await temporaryFile()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const memory = new DesktopDisplayMemory(path)

  await memory.load()

  expect(memory.position(DISPLAYS, LEFT.id, defaultSize)).toBeUndefined()
  expect(warn).not.toHaveBeenCalled()
})

it('restores a monitor and centers the requested size in its negative-coordinate work area', async () => {
  const path = await temporaryFile()
  const writer = new DesktopDisplayMemory(path)
  await writer.load()
  await writer.remember(DISPLAYS, LEFT.id, LEFT.id)

  const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
  expect(saved).toEqual({
    version: 1,
    displayId: LEFT.id,
    layout: {
      primaryId: LEFT.id,
      displays: [
        { id: LEFT.id, bounds: LEFT.bounds, workArea: LEFT.workArea, scaleFactor: 1, rotation: 0 },
        { id: RIGHT.id, bounds: RIGHT.bounds, workArea: RIGHT.workArea, scaleFactor: 2, rotation: 0 },
      ],
    },
  })

  const restored = new DesktopDisplayMemory(path)
  await restored.load()
  expect(restored.position(DISPLAYS, LEFT.id, defaultSize)).toEqual({ x: -1460, y: 204 })
  expect(restored.position(DISPLAYS, LEFT.id, { width: 1200, height: 900 })).toEqual({ x: -1560, y: 104 })
})

it('anchors an oversized window at the work-area origin', async () => {
  const path = await temporaryFile()
  const memory = new DesktopDisplayMemory(path)
  await memory.load()
  await memory.remember(DISPLAYS, LEFT.id, RIGHT.id)

  expect(memory.position(DISPLAYS, LEFT.id, { width: 2800, height: 1500 })).toEqual({ x: 0, y: 28 })
})

it('ignores display enumeration order when matching the saved layout', async () => {
  const path = await temporaryFile()
  const memory = new DesktopDisplayMemory(path)
  await memory.load()
  await memory.remember(DISPLAYS, LEFT.id, LEFT.id)

  expect(memory.position([RIGHT, LEFT], LEFT.id, defaultSize)).toEqual({ x: -1460, y: 204 })
})

it('normalizes JSON field order before restoring and deduplicating a saved layout', async () => {
  const path = await temporaryFile()
  const reversedRectangle = (value: Rectangle) => ({ height: value.height, width: value.width, y: value.y, x: value.x })
  await writeFile(path, JSON.stringify({ version: 1, displayId: LEFT.id, layout: {
    primaryId: LEFT.id,
    displays: [RIGHT, LEFT].map(display => ({
      id: display.id, bounds: reversedRectangle(display.bounds), workArea: reversedRectangle(display.workArea),
      scaleFactor: display.scaleFactor, rotation: display.rotation,
    })),
  } }))
  const memory = new DesktopDisplayMemory(path)
  await memory.load()
  expect(memory.position(DISPLAYS, LEFT.id, defaultSize)).toEqual({ x: -1460, y: 204 })
  await memory.remember(DISPLAYS, LEFT.id, LEFT.id)
  expect(writeFileAtomic).not.toHaveBeenCalled()
})

it('invalidates the preference when primary, connections, geometry, or display properties change', async () => {
  const path = await temporaryFile()
  const memory = new DesktopDisplayMemory(path)
  await memory.load()
  await memory.remember(DISPLAYS, LEFT.id, LEFT.id)

  const variants: Array<{ name: string; displays: readonly DisplayInfo[]; primaryId: number }> = [
    { name: 'primary display', displays: DISPLAYS, primaryId: RIGHT.id },
    { name: 'connected display', displays: [...DISPLAYS, makeDisplay(33, rectangle(2560, 0, 1200, 900))], primaryId: LEFT.id },
    { name: 'removed remembered display', displays: [RIGHT], primaryId: RIGHT.id },
    { name: 'resolution', displays: [makeDisplay(LEFT.id, rectangle(-1920, 0, 1918, 1080), LEFT), RIGHT], primaryId: LEFT.id },
    { name: 'position', displays: [makeDisplay(LEFT.id, rectangle(-1919, 0, 1920, 1080), LEFT), RIGHT], primaryId: LEFT.id },
    { name: 'scale factor', displays: [makeDisplay(LEFT.id, LEFT.bounds, { ...LEFT, scaleFactor: 1.25 }), RIGHT], primaryId: LEFT.id },
    { name: 'rotation', displays: [makeDisplay(LEFT.id, LEFT.bounds, { ...LEFT, rotation: 90 }), RIGHT], primaryId: LEFT.id },
    { name: 'work area', displays: [makeDisplay(LEFT.id, LEFT.bounds, { ...LEFT, workArea: rectangle(-1920, 30, 1920, 1050) }), RIGHT], primaryId: LEFT.id },
  ]

  for (const variant of variants) {
    expect(memory.position(variant.displays, variant.primaryId, defaultSize), variant.name).toBeUndefined()
  }
})

it('warns and falls back for malformed JSON, invalid fields, and unsupported versions', async () => {
  const path = await temporaryFile()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const invalidRecords = [
    '{',
    JSON.stringify({ version: 1, displayId: 11, layout: { primaryId: 11, displays: [] } }),
    '{"version":1,"displayId":11,"layout":{"primaryId":11,"displays":[{"id":11,"bounds":{"x":0,"y":0,"width":1e400,"height":100},"workArea":{"x":0,"y":0,"width":100,"height":100},"scaleFactor":1,"rotation":0}]}}',
    JSON.stringify({ version: 1, displayId: 11, layout: { primaryId: 11, displays: [{
      id: 11, bounds: rectangle(0, 0, 100, 100), workArea: rectangle(0, 0, 0, 100), scaleFactor: 1, rotation: 0,
    }] } }),
    JSON.stringify({ version: 1, displayId: 11, layout: { primaryId: 11, displays: [{
      id: 11, bounds: rectangle(0, 0, 100, 100), workArea: rectangle(0, 0, 100, 100), scaleFactor: 0, rotation: 0,
    }] } }),
    JSON.stringify({ version: 2, displayId: 11, layout: {} }),
  ]

  for (const raw of invalidRecords) {
    await writeFile(path, raw)
    const memory = new DesktopDisplayMemory(path)
    await memory.load()
    expect(memory.position(DISPLAYS, LEFT.id, defaultSize)).toBeUndefined()
  }

  expect(warn).toHaveBeenCalledTimes(invalidRecords.length)
})

it('warns and falls back when reading the preference path fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-display-memory-read-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const memory = new DesktopDisplayMemory(directory)

  await memory.load()

  expect(memory.position(DISPLAYS, LEFT.id, defaultSize)).toBeUndefined()
  expect(warn).toHaveBeenCalledWith('desktop display memory: could not read saved preference', directory, expect.anything())
})

it('writes private versioned records and skips unchanged layouts or invalid display ids', async () => {
  const path = await temporaryFile()
  const memory = new DesktopDisplayMemory(path)
  await memory.load()

  await memory.remember(DISPLAYS, LEFT.id, 999)
  expect(writeFileAtomic).not.toHaveBeenCalled()

  await memory.remember(DISPLAYS, LEFT.id, LEFT.id)
  await memory.remember([RIGHT, LEFT], LEFT.id, LEFT.id)
  expect(writeFileAtomic).toHaveBeenCalledTimes(1)
  expect(writeFileAtomic).toHaveBeenCalledWith(path, expect.any(String), { mode: 0o600, dirMode: 0o700 })

  await memory.remember(DISPLAYS, LEFT.id, RIGHT.id)
  expect(writeFileAtomic).toHaveBeenCalledTimes(2)
  const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
  expect(saved).toMatchObject({ version: 1, displayId: RIGHT.id })
})

it('serializes A-to-B-to-A writes, deduplicates the queued latest value, and flush waits', async () => {
  const path = await temporaryFile()
  const memory = new DesktopDisplayMemory(path)
  await memory.load()
  let releaseFirst!: () => void
  let signalFirst!: () => void
  let releaseSecond!: () => void
  let signalSecond!: () => void
  const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve })
  const secondStarted = new Promise<void>((resolve) => { signalSecond = resolve })
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
  const writes: string[] = []

  writerControl.setOverride(async (_target, content) => {
    writes.push(content)
    if (writes.length === 1) {
      signalFirst()
      await firstGate
    } else if (writes.length === 2) {
      signalSecond()
      await secondGate
    }
  })

  const pending: Promise<void>[] = []
  try {
    const first = memory.remember(DISPLAYS, LEFT.id, LEFT.id)
    pending.push(first)
    await firstStarted
    const second = memory.remember(DISPLAYS, LEFT.id, RIGHT.id)
    pending.push(second)
    const third = memory.remember(DISPLAYS, LEFT.id, LEFT.id)
    pending.push(third)
    let flushed = false
    const flush = memory.flush().then(() => { flushed = true })
    pending.push(flush)

    expect(writes).toHaveLength(1)
    expect(flushed).toBe(false)
    releaseFirst()
    await secondStarted
    const repeatedLatest = memory.remember(DISPLAYS, LEFT.id, LEFT.id)
    pending.push(repeatedLatest)
    releaseSecond()
    await Promise.all(pending)

    expect(writes.map(raw => (JSON.parse(raw) as { displayId: number }).displayId)).toEqual([LEFT.id, RIGHT.id, LEFT.id])
    expect(flushed).toBe(true)
  } finally {
    releaseFirst()
    releaseSecond()
    await Promise.allSettled(pending)
  }
})

it('warns on write failure and retries the unchanged preference on the next remember', async () => {
  const path = await temporaryFile()
  const memory = new DesktopDisplayMemory(path)
  await memory.load()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  let fail = true
  writerControl.setOverride(async (target, content, options) => {
    if (fail) {
      fail = false
      throw new Error('disk unavailable')
    }
    await writerControl.writeOriginal(target, content, options)
  })

  await memory.remember(DISPLAYS, LEFT.id, LEFT.id)
  expect(warn).toHaveBeenCalledWith('desktop display memory: could not save preference', path, expect.any(Error))
  await memory.remember(DISPLAYS, LEFT.id, LEFT.id)

  expect(writeFileAtomic).toHaveBeenCalledTimes(2)
  const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
  expect(saved).toMatchObject({ version: 1, displayId: LEFT.id })
})

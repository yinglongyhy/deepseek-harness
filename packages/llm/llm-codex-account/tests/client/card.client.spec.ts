import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexOAuthEnableRouteRequest,
  CodexOAuthEnableRouteResult,
  CodexOAuthStatusResult,
} from '../../src/shared/index.ts'
import { CodexOAuthCard, type CodexOAuthCardSnapshot } from '../../src/client/card.ts'
import {
  CODEX_ATTEMPT_ID,
  CODEX_OWNER_TOKEN,
  FakeCodexOAuthEndpoint,
  FakeOpener,
  authorizedView,
  cancelledView,
  deferred,
  failedView,
  initiatingView,
  statusFixture,
  type FakeAnswer,
} from './seams.client.ts'

/** One card controller with its scripted endpoints. */
interface CardHarness {
  readonly endpoint: FakeCodexOAuthEndpoint
  readonly opener: FakeOpener
  readonly card: CodexOAuthCard
  readonly snapshots: CodexOAuthCardSnapshot[]
}

function harness(): CardHarness {
  const endpoint = new FakeCodexOAuthEndpoint()
  const opener = new FakeOpener()
  const card = new CodexOAuthCard({ endpoint, open: opener.open })
  const snapshots: CodexOAuthCardSnapshot[] = []
  card.subscribe(() => { snapshots.push(card.getSnapshot()) })
  return { endpoint, opener, card, snapshots }
}

/** Let every pending continuation and zero-delay timer run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

/** The `enable-route` payloads the card sent. */
function routeWrites(endpoint: FakeCodexOAuthEndpoint): CodexOAuthEnableRouteRequest[] {
  return endpoint.calls
    .filter(call => call.endpoint === 'enable-route')
    .map(call => call.payload as CodexOAuthEnableRouteRequest)
}

/** How many times the card read the official facts. */
function statusReads(endpoint: FakeCodexOAuthEndpoint): number {
  return endpoint.calls.filter(call => call.endpoint === 'status').length
}

/** The cancel payloads the card sent for the attempt it was running. */
function cancels(endpoint: FakeCodexOAuthEndpoint): unknown[] {
  return endpoint.calls.filter(call => call.endpoint === 'cancel').map(call => call.payload)
}

function startAuthorized(app: CardHarness): void {
  app.endpoint.queryAnswer = () => ({ value: authorizedView() })
  app.card.startLogin()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('codex oauth card controller', () => {
  it('reads the official facts on attach and reports an unreadable one', async () => {
    const app = harness()
    app.card.attach()
    expect(app.card.getSnapshot().status).toEqual({ kind: 'loading' })
    await flush()
    expect(app.card.getSnapshot().status).toEqual({
      kind: 'ready',
      available: true,
      gap: null,
      recordStored: false,
      route: { configured: true, namespaceRevision: 7 },
    })
    expect(app.snapshots.length).toBeGreaterThan(0)

    app.endpoint.statusAnswer = () => ({ failure: 'transport-failed' })
    app.card.loadStatus()
    await flush()
    expect(app.card.getSnapshot().status).toEqual({ kind: 'failed', code: 'transport-failed' })
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ available: false, gap: 'codex-flow-unavailable' }) })
    app.card.loadStatus()
    await flush()
    expect(app.card.getSnapshot().status).toMatchObject({
      kind: 'ready',
      available: false,
      gap: 'codex-flow-unavailable',
    })
  })

  it('keeps the record state an official answer reported, never the page credential join', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: false }) })
    app.card.attach()
    await flush()
    expect(app.card.getSnapshot().status).toMatchObject({ recordStored: false })
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: true }) })
    app.card.loadStatus()
    await flush()
    expect(app.card.getSnapshot().status).toMatchObject({ recordStored: true })
  })

  it('rereads the record after the official flow reports a committed grant', async () => {
    const app = harness()
    app.card.attach()
    await flush()
    app.endpoint.queryAnswer = () => ({ value: authorizedView() })
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: true }) })
    app.card.startLogin()
    await flush()
    expect(app.card.getSnapshot().login).toEqual({ kind: 'authorized' })
    expect(app.card.getSnapshot().status).toMatchObject({ recordStored: true })
  })

  it('reports a refused login attempt by its code', async () => {
    const app = harness()
    app.endpoint.beginAnswer = () => ({ failure: 'busy' })
    app.card.startLogin()
    await flush()
    expect(app.card.getSnapshot().login).toEqual({ kind: 'failed', code: 'busy' })
  })

  it('enables an unconfigured route with the revision it read and no override removal', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false, namespaceRevision: 11 }) })
    app.card.attach()
    await flush()
    app.endpoint.enableRouteAnswer = () => {
      app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: true, namespaceRevision: 12 }) })
      return { value: { configured: true, namespaceRevision: 12 } }
    }
    startAuthorized(app)
    await flush()
    expect(routeWrites(app.endpoint)).toEqual([{ namespaceRevision: 11 }])
    expect(app.card.getSnapshot().route).toEqual({ kind: 'idle' })
    expect(app.card.getSnapshot().status).toMatchObject({ route: { configured: true, namespaceRevision: 12 } })
  })

  it('refuses to write a route whose revision it could not read', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false, namespaceRevision: null }) })
    app.card.attach()
    await flush()
    startAuthorized(app)
    await flush()
    expect(routeWrites(app.endpoint)).toEqual([])
    expect(app.card.getSnapshot().route).toEqual({
      kind: 'failed',
      code: 'capability-unavailable',
    })
  })

  it('reports a revision conflict as its own code', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false, namespaceRevision: 2 }) })
    app.card.attach()
    await flush()
    app.endpoint.enableRouteAnswer = () => ({ failure: 'route-revision-conflict' })
    startAuthorized(app)
    await flush()
    expect(app.card.getSnapshot().route).toEqual({
      kind: 'failed',
      code: 'route-revision-conflict',
    })
  })

  it('deletes the local record only on the user confirmation, and reports the removal', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: true }) })
    app.card.attach()
    await flush()
    app.card.requestLogout()
    expect(app.card.getSnapshot().logout).toEqual({ kind: 'confirming' })
    expect(app.endpoint.calls.filter(call => call.endpoint === 'logout')).toEqual([])
    app.card.dismissLogout()
    expect(app.card.getSnapshot().logout).toEqual({ kind: 'idle' })

    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: false }) })
    app.card.requestLogout()
    app.card.confirmLogout()
    await flush()
    expect(app.endpoint.calls.filter(call => call.endpoint === 'logout')).toHaveLength(1)
    expect(app.card.getSnapshot().logout).toEqual({ kind: 'removed' })
    expect(app.card.getSnapshot().status).toMatchObject({ recordStored: false })
    expect(app.card.getSnapshot().login).toEqual({ kind: 'idle' })
  })

  it('reports a blocked sign-out instead of deleting anything', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: true }) })
    app.card.attach()
    await flush()
    app.endpoint.logoutAnswer = () => ({ failure: 'logout-blocked' })
    app.card.requestLogout()
    app.card.confirmLogout()
    await flush()
    expect(app.card.getSnapshot().logout).toEqual({ kind: 'failed', code: 'logout-blocked' })
  })

  it('stops notifying a listener that unsubscribed', async () => {
    const endpoint = new FakeCodexOAuthEndpoint()
    const card = new CodexOAuthCard({ endpoint, open: () => null })
    let notified = 0
    const unsubscribe = card.subscribe(() => { notified += 1 })
    card.loadStatus()
    await flush()
    expect(notified).toBeGreaterThan(0)
    const before = notified
    unsubscribe()
    card.loadStatus()
    await flush()
    expect(notified).toBe(before)
  })

  it('releases the attempt when the card unmounts and starts a fresh one after a remount', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    app.card.attach()
    await flush()
    app.card.startLogin()
    await flush()
    app.card.detach()
    expect(app.endpoint.calls.filter(call => call.endpoint === 'cancel').map(call => call.payload)).toEqual([
      { attemptId: CODEX_ATTEMPT_ID, ownerToken: CODEX_OWNER_TOKEN, reason: 'page-closed' },
    ])
    expect(app.card.getSnapshot().login).toEqual({ kind: 'idle' })
    app.card.attach()
    app.card.startLogin()
    await flush()
    expect(app.endpoint.calls.filter(call => call.endpoint === 'begin')).toHaveLength(2)
  })

  it('drops every listener when the plugin unloads', async () => {
    const app = harness()
    app.card.attach()
    await flush()
    app.card.dispose()
    const before = app.snapshots.length
    app.card.loadStatus()
    await flush()
    expect(app.snapshots.length).toBe(before)
  })

  it('keeps a refused route write visible even while the route reads as unconfigured', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false, namespaceRevision: 11 }) })
    app.card.attach()
    await flush()
    app.endpoint.enableRouteAnswer = () => ({ failure: 'route-revision-conflict' })
    startAuthorized(app)
    await flush()
    expect(app.card.getSnapshot().route).toEqual({
      kind: 'failed',
      code: 'route-revision-conflict',
    })
    expect(app.card.getSnapshot().status).toMatchObject({ route: { configured: false } })
  })

  it('repeats the refused decision against a refreshed revision', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false, namespaceRevision: 11 }) })
    app.card.attach()
    await flush()
    app.endpoint.enableRouteAnswer = () => ({ failure: 'route-revision-conflict' })
    startAuthorized(app)
    await flush()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false, namespaceRevision: 12 }) })
    app.card.loadStatus()
    await flush()
    app.endpoint.enableRouteAnswer = () => ({ value: { configured: true, namespaceRevision: 13 } })
    app.card.retryRouteWrite()
    await flush()
    expect(routeWrites(app.endpoint)).toEqual([
      { namespaceRevision: 11 },
      { namespaceRevision: 12 },
    ])
    expect(app.card.getSnapshot().route).toEqual({ kind: 'idle' })
  })

  it('rereads the record after a settled attempt, whatever it settled as', async () => {
    const app = harness()
    app.card.attach()
    await flush()
    app.endpoint.queryAnswer = () => ({ value: cancelledView('user') })
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: true }) })
    app.card.startLogin()
    await flush()
    expect(app.card.getSnapshot().login).toEqual({ kind: 'cancelled', reason: 'user' })
    expect(app.card.getSnapshot().status).toMatchObject({ recordStored: true })
  })

  it('drops a status answer that arrived after the card unmounted', async () => {
    const app = harness()
    const answer = deferred<FakeAnswer<CodexOAuthStatusResult>>()
    app.endpoint.statusAnswer = () => answer.promise
    app.card.attach()
    await flush()
    app.card.detach()
    const before = app.snapshots.length
    answer.resolve({ value: statusFixture({ stored: true }) })
    await flush()
    expect(app.snapshots.length).toBe(before)
    expect(app.card.getSnapshot().status).toEqual({ kind: 'loading' })
  })

  it('drops a route write that completed after the card unmounted, without reading again', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false }) })
    app.card.attach()
    await flush()
    const answer = deferred<FakeAnswer<CodexOAuthEnableRouteResult>>()
    app.endpoint.enableRouteAnswer = () => answer.promise
    startAuthorized(app)
    app.card.detach()
    const before = app.snapshots.length
    const reads = statusReads(app.endpoint)
    answer.resolve({ value: { configured: true, namespaceRevision: 12 } })
    await flush()
    expect(app.snapshots.length).toBe(before)
    expect(statusReads(app.endpoint)).toBe(reads)
    expect(app.card.getSnapshot().route).toEqual({ kind: 'idle' })
  })

  it('drops a sign-out that completed after the plugin unloaded', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: true }) })
    app.card.attach()
    await flush()
    const answer = deferred<FakeAnswer<{ removed: boolean }>>()
    app.endpoint.logoutAnswer = () => answer.promise
    app.card.requestLogout()
    app.card.confirmLogout()
    const before = app.snapshots.length
    const reads = statusReads(app.endpoint)
    app.card.dispose()
    answer.resolve({ value: { removed: true } })
    await flush()
    expect(app.snapshots.length).toBe(before)
    expect(statusReads(app.endpoint)).toBe(reads)
  })

  it('starts nothing after the plugin unloaded the controller', async () => {
    const app = harness()
    app.card.attach()
    await flush()
    app.card.dispose()
    const frozen = app.card.getSnapshot()
    const calls = app.endpoint.calls.length
    app.card.loadStatus()
    app.card.startLogin()
    app.card.cancelLogin()
    app.card.reopenAuthorization()
    startAuthorized(app)
    app.card.retryRouteWrite()
    app.card.requestLogout()
    app.card.confirmLogout()
    app.card.reconnect()
    await flush()
    expect(app.endpoint.calls.length).toBe(calls)
    expect(app.card.getSnapshot()).toBe(frozen)
  })

  it('keeps the attempt alive while another card occurrence is still mounted', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    app.card.attach()
    await flush()
    app.card.startLogin()
    await flush()
    app.card.attach()
    await flush()
    app.card.detach()
    await flush()
    expect(cancels(app.endpoint)).toEqual([])
    expect(app.endpoint.queries).toBeGreaterThan(0)
    app.card.detach()
    await flush()
    expect(cancels(app.endpoint)).toEqual([
      { attemptId: CODEX_ATTEMPT_ID, ownerToken: CODEX_OWNER_TOKEN, reason: 'page-closed' },
    ])
  })

  it('drops the previous attempt and rereads the facts when the connection is re-established', async () => {
    const app = harness()
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    app.card.attach()
    await flush()
    app.card.startLogin()
    await flush()
    const reads = statusReads(app.endpoint)
    app.card.reconnect()
    await flush()
    expect(cancels(app.endpoint).map(call => (call as { reason: string }).reason)).toEqual(['page-closed'])
    expect(app.card.getSnapshot().login).toEqual({ kind: 'idle' })
    expect(statusReads(app.endpoint)).toBe(reads + 1)
  })

  it('lets a second occurrence mount without staling the route write the first one started', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false, namespaceRevision: 11 }) })
    app.card.attach()
    await flush()
    const answer = deferred<FakeAnswer<CodexOAuthEnableRouteResult>>()
    app.endpoint.enableRouteAnswer = () => answer.promise
    startAuthorized(app)
    app.card.attach()
    await flush()
    expect(app.card.getSnapshot().route).toEqual({ kind: 'writing' })
    app.endpoint.statusAnswer = () => ({
      value: statusFixture({ configured: true, namespaceRevision: 12 }),
    })
    answer.resolve({ value: { configured: true, namespaceRevision: 12 } })
    await flush()
    expect(app.card.getSnapshot().route).toEqual({ kind: 'idle' })
    expect(app.card.getSnapshot().status).toMatchObject({ route: { configured: true, namespaceRevision: 12 } })
  })

  it('lets a second occurrence mount without staling the sign-out the first one started', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: true }) })
    app.card.attach()
    await flush()
    const answer = deferred<FakeAnswer<{ removed: boolean }>>()
    app.endpoint.logoutAnswer = () => answer.promise
    app.card.requestLogout()
    app.card.confirmLogout()
    app.card.attach()
    await flush()
    expect(app.card.getSnapshot().logout).toEqual({ kind: 'running' })
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: false }) })
    answer.resolve({ value: { removed: true } })
    await flush()
    expect(app.card.getSnapshot().logout).toEqual({ kind: 'removed' })
    expect(app.card.getSnapshot().status).toMatchObject({ recordStored: false })
  })

  it('clears a route decision a reset made stale, instead of staying busy forever', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false, namespaceRevision: 11 }) })
    app.card.attach()
    await flush()
    const answer = deferred<FakeAnswer<CodexOAuthEnableRouteResult>>()
    app.endpoint.enableRouteAnswer = () => answer.promise
    startAuthorized(app)
    const reads = statusReads(app.endpoint)
    app.card.reconnect()
    await flush()
    expect(app.card.getSnapshot().route).toEqual({ kind: 'idle' })
    answer.resolve({ value: { configured: true, namespaceRevision: 12 } })
    await flush()
    expect(app.card.getSnapshot().route).toEqual({ kind: 'idle' })
    expect(statusReads(app.endpoint)).toBe(reads + 1)
  })

  it('clears a sign-out and a confirmation a remount made stale', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: true }) })
    app.card.attach()
    await flush()
    const answer = deferred<FakeAnswer<{ removed: boolean }>>()
    app.endpoint.logoutAnswer = () => answer.promise
    app.card.requestLogout()
    app.card.confirmLogout()
    app.card.detach()
    await flush()
    expect(app.card.getSnapshot().logout).toEqual({ kind: 'idle' })
    app.card.attach()
    await flush()
    app.card.detach()
    await flush()
    expect(app.card.getSnapshot().route).toEqual({ kind: 'idle' })
    answer.resolve({ value: { removed: true } })
    await flush()
    expect(app.card.getSnapshot().logout).toEqual({ kind: 'idle' })
  })
})

/** A status answer the test moves on as the route is written, as a real Host's does. */
interface RouteFacts {
  configured: boolean
  revision: number
}

/** One card whose status answer follows the writes the card makes. */
function routeHarness(facts: RouteFacts): CardHarness & { readonly facts: RouteFacts } {
  const app = harness()
  app.endpoint.statusAnswer = () => ({
    value: statusFixture({
      configured: facts.configured,
      namespaceRevision: facts.revision,
    }),
  })
  app.endpoint.enableRouteAnswer = () => ({
    value: { configured: true, namespaceRevision: facts.revision + 1 },
  })
  return { ...app, facts }
}

describe('codex oauth card: the route a successful login enables', () => {
  it('enables the route by itself for this page\'s own authorized login, exactly once', async () => {
    const app = routeHarness({ configured: false, revision: 11 })
    app.card.attach()
    await flush()
    app.endpoint.queryAnswer = () => ({ value: authorizedView() })
    app.endpoint.enableRouteAnswer = () => {
      app.facts.configured = true
      app.facts.revision = 12
      return { value: { configured: true, namespaceRevision: 12 } }
    }
    app.card.startLogin()
    await flush()
    expect(routeWrites(app.endpoint)).toEqual([{ namespaceRevision: 11 }])
    expect(app.card.getSnapshot().login).toEqual({ kind: 'authorized' })
    expect(app.card.getSnapshot().route).toEqual({ kind: 'idle' })
    expect(app.card.getSnapshot().status).toMatchObject({ route: { configured: true, namespaceRevision: 12 } })

    // A later refresh, remount, or reconnect of the same page writes nothing more:
    // the one automatic write belongs to the attempt that earned it.
    await flush()
    app.card.loadStatus()
    app.card.detach()
    app.card.attach()
    app.card.reconnect()
    await flush()
    expect(routeWrites(app.endpoint)).toHaveLength(1)
  })

  it('writes nothing for an already OAuth-enabled route whose login succeeded', async () => {
    const app = routeHarness({ configured: true, revision: 4 })
    app.card.attach()
    await flush()
    app.endpoint.queryAnswer = () => ({ value: authorizedView() })
    app.card.startLogin()
    await flush()
    expect(routeWrites(app.endpoint)).toEqual([])
    expect(app.card.getSnapshot().login).toEqual({ kind: 'authorized' })
  })

  it('writes nothing for a stored record alone, on mount, refresh, or reconnect', async () => {
    const app = routeHarness({ configured: false, revision: 11 })
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: true, configured: false, namespaceRevision: 11 }) })
    app.card.attach()
    await flush()
    app.card.loadStatus()
    app.card.reconnect()
    await flush()
    expect(routeWrites(app.endpoint)).toEqual([])
  })

  it('writes nothing for a cancelled attempt, not even when the Host reports a committed record', async () => {
    const app = routeHarness({ configured: false, revision: 11 })
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    app.card.attach()
    await flush()
    app.card.startLogin()
    await flush()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ stored: true, configured: false, namespaceRevision: 12 }) })
    app.endpoint.cancelAnswer = () => ({ value: cancelledView('user') })
    app.card.cancelLogin()
    await flush()
    expect(app.card.getSnapshot().login).toEqual({ kind: 'cancelled', reason: 'user' })
    expect(app.card.getSnapshot().status).toMatchObject({ recordStored: true })
    expect(routeWrites(app.endpoint)).toEqual([])
  })

  it('writes nothing for an attempt whose cancel raced an authorized outcome', async () => {
    const app = routeHarness({ configured: false, revision: 11 })
    app.endpoint.queryAnswer = () => ({ value: initiatingView() })
    app.card.attach()
    await flush()
    app.card.startLogin()
    await flush()
    app.endpoint.cancelAnswer = () => ({ value: authorizedView() })
    app.card.cancelLogin()
    await flush()
    expect(app.card.getSnapshot().status).toMatchObject({ recordStored: false })
    expect(routeWrites(app.endpoint)).toEqual([])
  })

  it('writes nothing for a failed attempt', async () => {
    const app = routeHarness({ configured: false, revision: 11 })
    app.card.attach()
    await flush()
    app.endpoint.queryAnswer = () => ({ value: failedView('login-failed') })
    app.card.startLogin()
    await flush()
    expect(app.card.getSnapshot().login).toEqual({ kind: 'failed', code: 'login-failed' })
    expect(routeWrites(app.endpoint)).toEqual([])
  })

  it('keeps a refused automatic enable visible without turning the login into a failure', async () => {
    const app = routeHarness({ configured: false, revision: 11 })
    app.card.attach()
    await flush()
    app.endpoint.queryAnswer = () => ({ value: authorizedView() })
    app.endpoint.enableRouteAnswer = () => ({ failure: 'route-revision-conflict' })
    app.card.startLogin()
    await flush()
    expect(app.card.getSnapshot().login).toEqual({ kind: 'authorized' })
    expect(app.card.getSnapshot().route).toEqual({
      kind: 'failed',
      code: 'route-revision-conflict',
    })

    // The retry reads the facts again and repeats exactly the automatic intent.
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false, namespaceRevision: 12 }) })
    app.endpoint.enableRouteAnswer = () => ({ value: { configured: true, namespaceRevision: 13 } })
    app.card.retryRouteWrite()
    await flush()
    expect(routeWrites(app.endpoint)).toEqual([
      { namespaceRevision: 11 },
      { namespaceRevision: 12 },
    ])
  })

  it('drops an automatic enable whose read answered after the page was released', async () => {
    const app = harness()
    app.endpoint.statusAnswer = () => ({ value: statusFixture({ configured: false, namespaceRevision: 11 }) })
    app.card.attach()
    await flush()
    app.endpoint.queryAnswer = () => ({ value: authorizedView() })
    const answer = deferred<FakeAnswer<CodexOAuthStatusResult>>()
    app.endpoint.statusAnswer = () => answer.promise
    app.card.startLogin()
    await flush()
    const reads = statusReads(app.endpoint)
    app.card.detach()
    answer.resolve({ value: statusFixture({ configured: false, namespaceRevision: 11 }) })
    await flush()
    expect(statusReads(app.endpoint)).toBe(reads)
    expect(routeWrites(app.endpoint)).toEqual([])
    expect(app.card.getSnapshot().route).toEqual({ kind: 'idle' })
  })

})

describe('native settings write ordering', () => {
  it('waits for a model save, then enables against the resulting revision', async () => {
    const app = routeHarness({ configured: false, revision: 7 })
    app.card.attach()
    await flush()
    const pending = deferred<undefined>()
    const write = app.card.writeCatalog(() => pending.promise)
    expect(app.card.getSnapshot().catalogSaving).toBe(true)
    startAuthorized(app)
    await flush()
    expect(routeWrites(app.endpoint)).toEqual([])
    expect(app.card.getSnapshot().route.kind).toBe('writing')
    await expect(app.card.writeCatalog(async () => {})).rejects.toThrow('already in progress')
    app.facts.revision = 8
    pending.resolve(undefined)
    await write
    await flush()
    expect(routeWrites(app.endpoint)).toEqual([{ namespaceRevision: 8 }])
    expect(app.card.getSnapshot().catalogSaving).toBe(false)
  })

  it('retries a failed automatic activation after a pending model write instead of dropping it', async () => {
    const app = routeHarness({ configured: false, revision: 7 })
    app.card.attach()
    await flush()
    app.endpoint.enableRouteAnswer = () => ({ failure: 'route-write-failed' })
    startAuthorized(app)
    await flush()
    expect(app.card.getSnapshot().route.kind).toBe('failed')
    const pending = deferred<undefined>()
    const write = app.card.writeCatalog(() => pending.promise)
    app.endpoint.enableRouteAnswer = () => ({ value: { configured: true, namespaceRevision: 9 } })
    app.card.retryRouteWrite()
    await flush()
    expect(routeWrites(app.endpoint)).toHaveLength(1)
    app.facts.revision = 8
    pending.resolve(undefined)
    await write
    await flush()
    expect(routeWrites(app.endpoint)).toEqual([{ namespaceRevision: 7 }, { namespaceRevision: 8 }])
  })

  it('clears a stale save lock on reconnect, without releasing a newer save when the old one settles', async () => {
    const app = harness()
    app.card.attach()
    const first = deferred<undefined>()
    const oldWrite = app.card.writeCatalog(() => first.promise)
    app.card.reconnect()
    const second = deferred<undefined>()
    const newWrite = app.card.writeCatalog(() => second.promise)
    first.resolve(undefined)
    await oldWrite
    expect(app.card.getSnapshot().catalogSaving).toBe(true)
    second.resolve(undefined)
    await newWrite
    expect(app.card.getSnapshot().catalogSaving).toBe(false)
  })
})

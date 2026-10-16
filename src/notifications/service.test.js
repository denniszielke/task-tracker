import { describe, expect, it, vi } from 'vitest'
import { createNotificationService } from './service.js'
import { createMemoryStorage } from './storage.js'
import { acknowledgement, ACTORS, at, graph, NOW, sourceEvent } from './__fixtures__/scenario.js'
import { harness, OPS, PLATFORM, SHOP_A, SHOP_B, value } from './__fixtures__/service.js'

const receive = (h, fields = {}) => value(h.service.receive(PLATFORM, sourceEvent(fields)))
const current = (h, shopId) => h.snapshot().notifications.current.find((n) => n.shopId === shopId)
const tracking = (h, notification) => h.snapshot().deliveries.find((d) => d.notificationId === notification.notificationId && d.revision === notification.revision)
const expectCode = (result, code) => expect(result).toMatchObject({ ok: false, error: { code } })
const revise = (h, sequence, fields = {}) => receive(h, { sequence, eventId: `event-${sequence}`, latestEstimatedAt: at(14, sequence), ...fields })

describe('source admission, identity and ordered processing', () => {
  it('persists acceptedAt using the injected service clock, not source occurrence time', () => {
    const h = harness()
    expect(receive(h, { occurredAt: '2020-01-01T00:00:00Z' }).disposition).toBe('applied')
    expect(current(h, 'A').acceptedAt).toBe(new Date(NOW).toISOString())
    expect(h.storage.load()).not.toBeNull()
  })

  it.each([
    ['absent actor', null, {}, 'UNAUTHENTICATED'],
    ['unknown actor', { id: 'intruder', role: 'operations' }, {}, 'UNAUTHENTICATED'],
    ['operations cannot receive as producer', OPS, {}, 'FORBIDDEN'],
    ['shop cannot submit platform event', SHOP_A, {}, 'FORBIDDEN'],
    ['producer source impersonation', PLATFORM, { sourceSystem: 'shop-demo:A' }, 'FORBIDDEN'],
    ['unknown version', PLATFORM, { schemaVersion: 99 }, 'UNSUPPORTED_SCHEMA'],
    ['extra field', PLATFORM, { owner: 'private' }, 'VALIDATION_ERROR'],
    ['vehicle reference mismatch', PLATFORM, { vehicleRef: 'foreign' }, 'VALIDATION_ERROR'],
    ['baseline mismatch', PLATFORM, { previousCommittedAt: at(10) }, 'VALIDATION_ERROR'],
  ])('rejects %s without notifications', (_label, actor, fields, code) => {
    const h = harness()
    expectCode(h.service.receive(actor, sourceEvent(fields)), code)
    expect(h.snapshot().notifications.current).toEqual([])
    expect(h.deliver).not.toHaveBeenCalled()
  })

  it('permits completion events only for the owning shop job/order', () => {
    const h = harness()
    const event = sourceEvent({
      type: 'repair-job.completion-revised', sourceSystem: 'shop-demo:A',
      root: { kind: 'job', id: 'J-2001' }, rootState: 'In progress',
      latestEstimatedAt: at(16),
    })
    expect(h.service.receive(SHOP_A, event).ok).toBe(true)
    expectCode(h.service.receive(SHOP_B, { ...event, eventId: 'foreign' }), 'FORBIDDEN')
  })

  it('normalizes identity, deduplicates reload replay and rejects conflicting event IDs', () => {
    const h = harness()
    receive(h)
    const before = h.snapshot().notifications
    expect(receive(h, { latestEstimatedAt: '2026-10-02T15:30:00+02:00' }).disposition).toBe('duplicate')
    expect(h.snapshot().notifications).toEqual(before)
    expectCode(h.service.receive(PLATFORM, sourceEvent({ latestEstimatedAt: at(15) })), 'ID_CONFLICT')
    expect(value(h.reload().receive(PLATFORM, sourceEvent())).disposition).toBe('duplicate')
  })

  it('persists and drains a gap in order including across reload', () => {
    const h = harness()
    expect(revise(h, 3).disposition).toBe('queued-gap')
    expect(h.snapshot().notifications.current).toEqual([])
    const restored = h.reload()
    value(restored.receive(PLATFORM, sourceEvent()))
    expect(value(restored.getSnapshot(OPS)).lifecycles[0].lastAppliedSequence).toBe(1)
    value(restored.receive(PLATFORM, sourceEvent({ eventId: 'event-2', sequence: 2, latestEstimatedAt: at(14, 2) })))
    const snapshot = value(restored.getSnapshot(OPS))
    expect(snapshot.lifecycles[0].lastAppliedSequence).toBe(3)
    expect(snapshot.notifications.current.every((n) => n.latestEstimatedAt === at(14, 3))).toBe(true)
  })

  it('rejects a concurrent same-next sequence and records unseen older events stale', () => {
    const h = harness()
    receive(h)
    revise(h, 2)
    const before = h.snapshot().notifications
    expectCode(h.service.receive(PLATFORM, sourceEvent({ sequence: 2, eventId: 'concurrent' })), 'SEQUENCE_CONFLICT')
    expect(receive(h, { eventId: 'old-unseen' }).disposition).toBe('stale')
    expect(h.snapshot().notifications).toEqual(before)
  })

  it('binds a correlation permanently to its original source and root', () => {
    const h = harness()
    receive(h)
    expect(h.service.receive(SHOP_A, sourceEvent({
      eventId: 'different-root', sequence: 2, type: 'repair-job.completion-revised',
      sourceSystem: 'shop-demo:A', root: { kind: 'job', id: 'J-2001' }, rootState: 'In progress',
    })).ok).toBe(false)
    expect(h.snapshot().lifecycles[0].lastAppliedSequence).toBe(1)
  })

  it('applies no-op sequences without creating redundant notification revisions', () => {
    const h = harness()
    receive(h)
    const before = h.snapshot().notifications
    revise(h, 2, { latestEstimatedAt: at(13, 30) })
    expect(h.snapshot().notifications).toEqual(before)
    expect(h.snapshot().lifecycles[0].lastAppliedSequence).toBe(2)
  })
})

describe('immutable shop-specific notification lifecycle and privacy', () => {
  it('creates one versioned stable notification per impacted shop with only its own jobs', () => {
    const h = harness()
    receive(h)
    const a = current(h, 'A'), b = current(h, 'B')
    expect(a).toMatchObject({
      schemaVersion: 1, revision: 1, sourceEventId: 'event-1', correlationId: 'delay-N-1001',
      vehicleOrderId: 'N-1001', vehicleRef: 'vehicle-1001', state: 'New', delayMs: 90 * 60_000, graphVersion: 1,
      acknowledgementInstructions: { operation: 'acknowledge', notificationId: a.notificationId, revision: 1 },
    })
    expect(a.affectedJobs.map((j) => j.jobId)).toEqual(['J-2001'])
    expect(b.affectedJobs.map((j) => j.jobId)).toEqual(['J-2002'])
    expect(JSON.stringify(b)).not.toContain('J-2001')
    expect(b.affectedJobs[0].reasons[0].path).toContainEqual({ kind: 'external-prerequisite' })
    expect(new Set(h.snapshot().notifications.current.map((n) => n.notificationId)).size).toBe(2)
  })

  it('keeps original history immutable and stable identities through revisions/resolution/reopening', () => {
    const h = harness()
    receive(h)
    const original = current(h, 'A')
    revise(h, 2, { latestEstimatedAt: at(13) })
    expect(current(h, 'A')).toMatchObject({ notificationId: original.notificationId, revision: 2, state: 'Revised' })
    expect(h.snapshot().notifications.history).toContainEqual(original)
    revise(h, 3, { latestEstimatedAt: at(12), type: 'vehicle.delay-corrected' })
    expect(current(h, 'A')).toMatchObject({ revision: 3, state: 'Resolved' })
    expect(current(h, 'A').affectedJobs.map((j) => j.jobId)).toEqual(['J-2001'])
    expect(current(h, 'A').changes.removedJobIds).toEqual(['J-2001'])
    revise(h, 4)
    expect(current(h, 'A')).toMatchObject({ notificationId: original.notificationId, revision: 4, state: 'Revised' })
    expect(h.snapshot().notifications.history).toContainEqual(original)
  })

  it('does not leak foreign jobs in nested paths, changes, snapshots or subscriptions', () => {
    const h = harness(), a = [], b = []
    value(h.service.subscribe(SHOP_A, (snapshot) => a.push(snapshot)))
    value(h.service.subscribe(SHOP_B, (snapshot) => b.push(snapshot)))
    receive(h)
    revise(h, 2)
    revise(h, 3, { latestEstimatedAt: at(12) })
    for (const snapshot of [...a, h.snapshot(SHOP_A)]) {
      expect(JSON.stringify(snapshot)).not.toContain('J-2002')
      expect(snapshot).not.toHaveProperty('audit')
      expect(snapshot).not.toHaveProperty('metrics')
      expect(snapshot).not.toHaveProperty('lifecycles')
    }
    for (const snapshot of [...b, h.snapshot(SHOP_B)]) expect(JSON.stringify(snapshot)).not.toContain('J-2001')
    expectCode(h.service.getJob(SHOP_A, { jobId: 'J-2002' }), 'FORBIDDEN')
    expect(value(h.service.getJob(SHOP_A, { jobId: 'J-2001' })).id).toBe('J-2001')
    expectCode(h.service.getSnapshot(PLATFORM), 'FORBIDDEN')
    expectCode(h.service.subscribe(PLATFORM, vi.fn()), 'FORBIDDEN')
  })

  it('does not trust caller role/shop claims and isolates public object mutation/listener failures', () => {
    const h = harness(), listener = vi.fn()
    value(h.service.subscribe(SHOP_A, () => { throw new Error('Consumer error') }))
    const unsubscribe = value(h.service.subscribe(SHOP_B, listener))
    receive(h)
    expect(listener).toHaveBeenCalled()
    const visible = h.snapshot(SHOP_A)
    visible.notifications.current[0].affectedJobs[0].jobId = 'mutated'
    expect(h.snapshot(SHOP_A).notifications.current[0].affectedJobs[0].jobId).toBe('J-2001')
    expectCode(h.service.getJob({ id: 'shop-A', role: 'operations', shopId: 'B' }, { jobId: 'J-2002' }), 'FORBIDDEN')
    unsubscribe()
    const calls = listener.mock.calls.length
    revise(h, 2)
    expect(listener).toHaveBeenCalledTimes(calls)
  })

  it('recalculates from actual arrival instead of blindly resolving late delivery', () => {
    const h = harness()
    receive(h)
    revise(h, 2, { type: 'vehicle.delivered', actualAt: at(13, 30), latestEstimatedAt: null })
    expect(current(h, 'A').state).not.toBe('Resolved')
    expect(h.snapshot().orderOverrides['N-1001'].status).toBe('Delivered')
  })

  it('sends cancellation to newly blocked shops and retains terminal context', () => {
    const h = harness()
    receive(h, { type: 'vehicle.cancelled', latestEstimatedAt: null })
    expect(h.snapshot().notifications.current.map((n) => n.state)).toEqual(['Cancelled', 'Cancelled'])
    expect(current(h, 'B').affectedJobs.map((j) => j.jobId)).toEqual(['J-2002'])
    expect(JSON.stringify(current(h, 'B'))).not.toContain('J-2001')
  })

  it('atomically rejects invalid graph replacement, versions valid replacements and recalculates', () => {
    const h = harness()
    receive(h)
    const invalid = graph()
    invalid.edges[0].from.id = 'missing'
    expectCode(h.service.replaceGraph(OPS, { expectedVersion: 1, graph: invalid }), 'MISSING_DEPENDENCY')
    expect(h.snapshot().graphVersion).toBe(1)
    const changed = graph()
    changed.edges.pop()
    expect(value(h.service.replaceGraph(OPS, { expectedVersion: 1, graph: changed })).graphVersion).toBe(2)
    expect(current(h, 'B')).toMatchObject({ state: 'Resolved', graphVersion: 2, sourceEventId: 'event-1' })
    expectCode(h.service.replaceGraph(OPS, { expectedVersion: 1, graph: changed }), 'VERSION_CONFLICT')
  })
})

describe('exact-revision acknowledgements and independent shop outcomes', () => {
  it('acknowledges A, never B, and preserves a valid older acknowledgement after revision', () => {
    const h = harness()
    receive(h)
    const a = current(h, 'A'), b = current(h, 'B')
    expect(value(h.service.acknowledge(SHOP_A, acknowledgement(a.notificationId))).disposition).toBe('accepted')
    expect(tracking(h, a).acknowledgement.outcome).toBe('Accepted')
    expect(tracking(h, b).acknowledgement).toBeFalsy()
    revise(h, 2)
    expect(tracking(h, current(h, 'A')).acknowledgement).toBeFalsy()
    expect(h.snapshot().acknowledgements).toHaveLength(1)
  })

  it('permits a delivered older revision without acknowledging a newer revision', () => {
    const h = harness()
    receive(h)
    const a = current(h, 'A')
    revise(h, 2)
    expect(h.service.acknowledge(SHOP_A, acknowledgement(a.notificationId)).ok).toBe(true)
    expect(tracking(h, current(h, 'A')).acknowledgement).toBeFalsy()
  })

  it('deduplicates exact and semantic repeats but rejects conflicts', () => {
    const h = harness()
    receive(h)
    const ack = acknowledgement(current(h, 'A').notificationId)
    value(h.service.acknowledge(SHOP_A, ack))
    expect(value(h.service.acknowledge(SHOP_A, ack)).disposition).toBe('duplicate')
    expect(value(h.service.acknowledge(SHOP_A, { ...ack, acknowledgementId: 'ack-repeat', acknowledgedAt: at(12, 2) })).disposition).toBe('duplicate')
    expectCode(h.service.acknowledge(SHOP_A, { ...ack, outcome: 'Rejected' }), 'ACK_CONFLICT')
    expectCode(h.service.acknowledge(SHOP_A, { ...ack, acknowledgementId: 'ack-conflict', comment: 'Changed content' }), 'ACK_CONFLICT')
    expect(tracking(h, current(h, 'A')).acknowledgement).toMatchObject({
      acknowledgementId: 'ack-1', outcome: 'Accepted',
    })
    expect(h.snapshot().acknowledgements).toHaveLength(1)
  })

  it('audits rejection without reporting successful processing and escalates immediately', () => {
    const h = harness()
    receive(h)
    const a = current(h, 'A')
    value(h.service.acknowledge(SHOP_A, acknowledgement(a.notificationId, { outcome: 'Rejected', reasonCode: 'CANNOT_PROCESS' })))
    expect(tracking(h, a)).toMatchObject({ transportState: 'Delivered', escalation: 'Error', acknowledgement: { outcome: 'Rejected' } })
    expect(tracking(h, current(h, 'B')).acknowledgement).toBeFalsy()
  })

  it('rejects foreign, missing, and undelivered exact revision references', () => {
    const h = harness()
    value(h.service.setShopConnection(OPS, { shopId: 'A', connected: false }))
    receive(h)
    const a = current(h, 'A')
    expectCode(h.service.acknowledge(SHOP_B, acknowledgement(a.notificationId)), 'FORBIDDEN')
    expectCode(h.service.acknowledge(SHOP_A, acknowledgement(a.notificationId)), 'NOT_DELIVERED')
    expectCode(h.service.acknowledge(SHOP_A, acknowledgement(a.notificationId, { revision: 999 })), 'NOT_FOUND')
    expectCode(h.service.acknowledge(OPS, acknowledgement(a.notificationId)), 'FORBIDDEN')
  })
})

describe('retryable outbox, deterministic recovery and explicit persistence failure', () => {
  it('persists all recipients before adapter delivery; a failing shop never blocks another', () => {
    const storage = createMemoryStorage()
    const deliver = vi.fn((notification) => {
      const serialized = JSON.stringify(storage.load())
      expect(serialized).toContain(notification.notificationId)
      expect(serialized).toContain('"shopId":"A"')
      expect(serialized).toContain('"shopId":"B"')
      if (notification.shopId === 'A') throw Object.assign(new Error('Unavailable A'), { code: 'DELIVERY_FAILED' })
      return true
    })
    const h = harness({ storage, deliver })
    receive(h)
    expect(tracking(h, current(h, 'A')).transportState).toBe('Retrying')
    expect(tracking(h, current(h, 'B')).transportState).toBe('Delivered')
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('uses exactly five attempts at 0, 1s, 6s, 36s, 156s then requires manual retry', () => {
    const h = harness()
    value(h.service.setShopConnection(OPS, { shopId: 'A', connected: false }))
    receive(h)
    const a = current(h, 'A')
    expect(tracking(h, a).attemptCount).toBe(1)
    for (const [elapsed, count] of [[999, 1], [1000, 2], [5999, 2], [6000, 3], [35999, 3], [36000, 4], [155999, 4], [156000, 5]]) {
      h.setTime(NOW + elapsed)
      value(h.service.tick(OPS))
      expect(tracking(h, a).attemptCount).toBe(count)
    }
    expect(tracking(h, a)).toMatchObject({ transportState: 'Failed', escalation: 'Error' })
    value(h.service.setShopConnection(OPS, { shopId: 'A', connected: true }))
    expect(tracking(h, a).transportState).toBe('Failed')
    value(h.service.retryDelivery(OPS, { notificationId: a.notificationId }))
    expect(tracking(h, a).transportState).toBe('Delivered')
  })

  it('reconnects only latest revision including a pending terminal notification', () => {
    const h = harness()
    value(h.service.setShopConnection(OPS, { shopId: 'A', connected: false }))
    receive(h)
    const old = current(h, 'A')
    revise(h, 2)
    revise(h, 3, { type: 'vehicle.cancelled', latestEstimatedAt: null })
    const latest = current(h, 'A')
    expect(latest.state).toBe('Cancelled')
    expect(tracking(h, old)).toMatchObject({ supersededByRevision: expect.any(Number) })
    h.deliver.mockClear()
    value(h.service.setShopConnection(OPS, { shopId: 'A', connected: true }))
    expect(h.deliver.mock.calls.map(([n]) => [n.shopId, n.revision])).toEqual([['A', latest.revision]])
    expect(tracking(h, latest).transportState).toBe('Delivered')
  })

  it('rehydrates without constructor delivery and resumes due outbox only on tick', () => {
    const h = harness()
    value(h.service.setShopConnection(OPS, { shopId: 'A', connected: false }))
    receive(h)
    h.advance(1000)
    h.deliver.mockClear()
    const restored = h.reload()
    expect(h.deliver).not.toHaveBeenCalled()
    value(restored.setShopConnection(OPS, { shopId: 'A', connected: true }))
    expect(h.deliver.mock.calls.filter(([n]) => n.shopId === 'A')).toHaveLength(1)
    expect(h.deliver.mock.calls.filter(([n]) => n.shopId === 'B')).toHaveLength(0)
  })

  it('escalates unacknowledged active revisions at exact injected age thresholds', () => {
    const h = harness()
    receive(h)
    const a = current(h, 'A')
    for (const [elapsed, escalation] of [[299999, 'None'], [300000, 'Warning'], [899999, 'Warning'], [900000, 'Error']]) {
      h.setTime(NOW + elapsed)
      value(h.service.tick(OPS))
      expect(tracking(h, a).escalation).toBe(escalation)
    }
  })

  it('never exposes business effects when an atomic storage write fails', () => {
    const memory = createMemoryStorage()
    let unavailable = false
    const storage = {
      ...memory,
      save: (snapshot) => {
        if (unavailable) throw Object.assign(new Error('Full'), { code: 'STORAGE_FULL' })
        memory.save(snapshot)
      },
    }
    const h = harness({ storage })
    const persisted = memory.load()
    unavailable = true
    expectCode(h.service.receive(PLATFORM, sourceEvent()), 'STORAGE_FULL')
    expect(h.deliver).not.toHaveBeenCalled()
    expect(memory.load()).toEqual(persisted)
    const snapshot = h.snapshot()
    expect(snapshot.notifications.current).toEqual([])
    expect(snapshot.error).toMatchObject({ code: 'STORAGE_FULL' })
  })

  it('rejects unsupported stored snapshot versions without clearing the workspace', () => {
    const clear = vi.fn(), storage = { load: () => ({ schemaVersion: 999 }), save: vi.fn(), clear }
    try {
      const service = createNotificationService({
        graph: graph(), actors: ACTORS, clock: { now: () => NOW },
        idFactory: () => 'id', storage, transport: { deliver: vi.fn() },
      })
      const result = service.getSnapshot(OPS)
      expect(result.ok ? result.value.error : result.error).toBeTruthy()
    } catch (error) {
      expect(error.code).toMatch(/STORAGE|SCHEMA/)
    }
    expect(clear).not.toHaveBeenCalled()
    expect(storage.save).not.toHaveBeenCalled()
  })
})

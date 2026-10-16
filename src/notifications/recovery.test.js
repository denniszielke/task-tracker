import { describe, expect, it, vi } from 'vitest'
import { validateNotification } from './contracts.js'
import { createDemoService, DEMO_ACTORS } from './demo.js'
import { createMemoryStorage } from './storage.js'
import { acknowledgement, at, edge, graph, job, NOW, ROOT, sourceEvent } from './__fixtures__/scenario.js'
import { harness, OPS, PLATFORM, SHOP_A, SHOP_B, value } from './__fixtures__/service.js'

const accept = (h, fields = {}) => value(h.service.receive(PLATFORM, sourceEvent(fields)))
const code = (result, expected) => expect(result).toMatchObject({ ok: false, error: { code: expected } })
const latest = (h, shopId) => h.snapshot().notifications.current.find((n) => n.shopId === shopId)

describe('notification schema and graph recalculation contracts', () => {
  it.each(['New', 'Revised', 'Resolved', 'Cancelled'])('validates versioned %s shop payloads', (state) => {
    const h = harness()
    accept(h)
    if (state !== 'New') accept(h, {
      eventId: 'event-2', sequence: 2,
      type: state === 'Cancelled' ? 'vehicle.cancelled' : 'vehicle.eta-revised',
      latestEstimatedAt: state === 'Resolved' ? at(12) : state === 'Cancelled' ? null : at(14),
    })
    for (const notification of h.snapshot().notifications.current) {
      expect(notification.state).toBe(state)
      expect(validateNotification(notification)).toEqual(notification)
    }
  })

  it.each([
    ['version', (n) => { n.schemaVersion = 2 }],
    ['unknown personal property', (n) => { n.ownerAddress = 'not allowed' }],
    ['state', (n) => { n.state = 'Delivered' }],
    ['negative delay', (n) => { n.delayMs = -1 }],
    ['ambiguous timestamp', (n) => { n.createdAt = '2026-10-02T12:00:00' }],
    ['revision', (n) => { n.revision = 0 }],
    ['foreign nested property', (n) => { n.affectedJobs[0].owner = 'private' }],
    ['invalid reason', (n) => { n.affectedJobs[0].reasons[0].code = 'GUESSED' }],
    ['unsafe external node', (n) => { n.affectedJobs[0].reasons[0].path = [{ kind: 'external-prerequisite', id: 'J-foreign' }] }],
    ['wrong ack revision', (n) => { n.acknowledgementInstructions.revision = 99 }],
    ['wrong ack identity', (n) => { n.acknowledgementInstructions.notificationId = 'foreign' }],
  ])('rejects invalid notification %s', (_label, change) => {
    const h = harness()
    accept(h)
    const notification = latest(h, 'A')
    change(notification)
    expect(() => validateNotification(notification)).toThrow()
  })

  it('merges multiple same-shop jobs and redacts all added/removed/updated job sets', () => {
    const input = graph()
    input.jobs.push(job('J-2003', 'A'))
    input.edges.push(edge('source-to-extra', ROOT, 'J-2003', at(12, 15)))
    const h = harness({ graph: input })
    accept(h)
    expect(h.snapshot().notifications.current).toHaveLength(2)
    expect(latest(h, 'A').affectedJobs.map((j) => j.jobId)).toEqual(['J-2001', 'J-2003'])
    const changed = structuredClone(input)
    changed.edges = changed.edges.filter((e) => e.toJobId !== 'J-2003')
    value(h.service.replaceGraph(OPS, { expectedVersion: 1, graph: changed }))
    expect(latest(h, 'A')).toMatchObject({ state: 'Revised', changes: { removedJobIds: ['J-2003'] } })
    expect(latest(h, 'A').changes.updatedJobIds).not.toContain('J-2002')
    expect(JSON.stringify(h.snapshot(SHOP_B))).not.toContain('J-2003')
  })

  it('notifies a joining shop, resolves a leaving shop and reuses identity on rejoining', () => {
    const input = graph()
    input.edges.pop()
    const h = harness({ graph: input })
    accept(h)
    expect(h.snapshot().notifications.current.map((n) => n.shopId)).toEqual(['A'])
    value(h.service.replaceGraph(OPS, { expectedVersion: 1, graph: graph() }))
    const b = latest(h, 'B')
    expect(b.state).toBe('New')
    value(h.service.replaceGraph(OPS, { expectedVersion: 2, graph: input }))
    expect(latest(h, 'B').state).toBe('Resolved')
    value(h.service.replaceGraph(OPS, { expectedVersion: 3, graph: graph() }))
    expect(latest(h, 'B')).toMatchObject({ state: 'Revised', notificationId: b.notificationId })
    expect(latest(h, 'B').revision).toBeGreaterThan(b.revision)
  })

  it('recalculates other active roots with original provenance without consuming their source sequence', () => {
    const h = harness()
    accept(h)
    const before = latest(h, 'B')
    value(h.service.publishPlatformChange(SHOP_A, {
      kind: 'job', vehicleOrderId: 'N-1001', jobId: 'J-2001',
      jobState: 'In progress', estimatedAt: at(16),
    }))
    const lifecycle = h.snapshot().lifecycles.find((l) => l.correlationId === 'delay-N-1001')
    const rootNotification = h.snapshot().notifications.current.find((n) => n.correlationId === 'delay-N-1001' && n.shopId === 'B')
    expect(lifecycle.lastAppliedSequence).toBe(1)
    expect(rootNotification).toMatchObject({ sourceEventId: 'event-1', state: 'Revised' })
    expect(rootNotification.revision).toBeGreaterThan(before.revision)
    expect(rootNotification.affectedJobs[0].projectedStartAt).toBe(at(16))
    expect(h.snapshot().lifecycles).toHaveLength(2)
  })

  it('returns atomic processing-error and retries the retained event after readiness repair', () => {
    const input = graph()
    input.orders[0].committedAt = null
    input.orders[0].estimatedArrivalAt = null
    const h = harness({ graph: input })
    const event = sourceEvent({
      type: 'repair-job.completion-revised', root: { kind: 'job', id: 'J-2001' },
      rootState: 'In progress', previousCommittedAt: null, latestEstimatedAt: at(16),
    })
    expect(value(h.service.receive(PLATFORM, event)).disposition).toBe('processing-error')
    expect(h.snapshot().lifecycles[0].lastAppliedSequence).toBe(0)
    expect(h.snapshot().notifications.current).toEqual([])
    expect(value(h.service.receive(PLATFORM, { ...event, eventId: 'event-2', sequence: 2 })).disposition).toBe('queued-gap')
    const repaired = structuredClone(input)
    repaired.orders[0].estimatedArrivalAt = at(12)
    value(h.service.replaceGraph(OPS, { expectedVersion: 1, graph: repaired }))
    value(h.service.retryProcessing(OPS, { correlationId: event.correlationId }))
    expect(h.snapshot().lifecycles[0].lastAppliedSequence).toBe(2)
    expect(h.snapshot().notifications.current.some((n) => n.shopId === 'B')).toBe(true)
  })

  it('keeps graph-only ETA and committed/planned baselines immutable', () => {
    const h = harness()
    accept(h)
    const changed = graph()
    changed.edges[1].requiredReadyAt = at(15)
    value(h.service.replaceGraph(OPS, { expectedVersion: 1, graph: changed }))
    expect(latest(h, 'A').latestEstimatedAt).toBe(at(13, 30))
    expect(value(h.service.getJob(OPS, { jobId: 'J-2001' })).plannedStartAt).toBe(at(12, 15))
    expect(h.snapshot().orders[0].committedAt).toBe(at(12))
    expect(h.snapshot().orders[0].estimatedArrivalAt).toBe(at(13, 30))
  })
})

describe('platform observation, safe factory and storage recovery', () => {
  it('does not observe equality, Unknown, Delivered or Cancelled as new late lifecycles', () => {
    for (const fields of [
      { committedAt: at(12) }, { committedAt: null, estimatedArrivalAt: null },
      { committedAt: at(11), status: 'Delivered', actualArrivalAt: at(11) },
      { committedAt: at(11), status: 'Cancelled' },
    ]) {
      const input = graph()
      Object.assign(input.orders[0], fields)
      const h = harness({ graph: input })
      value(h.service.publishPlatformChange(OPS, { kind: 'observe', vehicleOrderId: 'N-1001' }))
      expect(h.snapshot().lifecycles).toEqual([])
    }
  })

  it('uses clock-driven lower bounds without inventing ETA and avoids unchanged observations', () => {
    const input = graph()
    input.orders[0].committedAt = at(11)
    input.orders[0].estimatedArrivalAt = null
    const h = harness({ graph: input })
    value(h.service.publishPlatformChange(OPS, { kind: 'observe', vehicleOrderId: 'N-1001' }))
    const first = h.snapshot().events[0].event
    expect(first).toMatchObject({ type: 'vehicle.late', latestEstimatedAt: at(12), estimateBasis: 'observed-lower-bound' })
    value(h.service.publishPlatformChange(OPS, { kind: 'observe', vehicleOrderId: 'N-1001' }))
    expect(h.snapshot().events).toHaveLength(1)
    h.advance(60_000)
    value(h.service.publishPlatformChange(OPS, { kind: 'observe', vehicleOrderId: 'N-1001' }))
    expect(h.snapshot().events).toHaveLength(2)
    expect(h.snapshot().events[1].event.sequence).toBe(2)
    expect(h.snapshot().events[1].event.latestEstimatedAt).toBe(at(12, 1))
  })

  it('factory persists only safe source fields and retains the same shape on boot failure', () => {
    const storage = createMemoryStorage()
    const source = { id: 'CUSTOM', status: 'In transit', inspectionAt: at(11), owner: 'PRIVATE_OWNER', registration: 'PRIVATE_PLATE', pickupAddress: { street: 'PRIVATE_STREET' } }
    const service = createDemoService({ orders: [source], now: () => new Date(NOW), storage, idFactory: (() => { let n = 0; return () => `id-${++n}` })() })
    value(service.reconcilePlatform(DEMO_ACTORS.operations, { orders: [source] }))
    const persisted = JSON.stringify(storage.load())
    for (const secret of ['PRIVATE_OWNER', 'PRIVATE_PLATE', 'PRIVATE_STREET', 'pickupAddress', 'registration']) expect(persisted).not.toContain(secret)
    const broken = createDemoService({
      orders: [source], now: () => NOW,
      storage: { load: () => { throw Object.assign(new Error('Denied'), { code: 'STORAGE_UNAVAILABLE' }) }, save: vi.fn(), clear: vi.fn() },
    })
    expect(Object.keys(broken).sort()).toEqual(Object.keys(service).sort())
    expect(value(broken.getSnapshot(OPS))).toMatchObject({ persistenceState: 'error', error: { code: 'STORAGE_UNAVAILABLE' } })
    code(broken.publishPlatformChange(OPS, { kind: 'eta', vehicleOrderId: 'CUSTOM', estimatedAt: at(14) }), 'STORAGE_UNAVAILABLE')
  })

  it('reconciliation independently handles malformed source records and keeps explicit status overrides', () => {
    const h = harness()
    value(h.service.publishPlatformChange(OPS, { kind: 'deliver', vehicleOrderId: 'N-1001', actualAt: at(12) }))
    const result = value(h.service.reconcilePlatform(OPS, { orders: [
      { id: 'N-1001', inspectionAt: at(12), status: 'In transit' },
      { id: 'BAD', inspectionAt: 'not-a-timestamp', status: 'In transit' },
    ] }))
    expect(result.errors.length).toBeGreaterThan(0)
    expect(h.snapshot().orders[0].status).toBe('Delivered')
    expect(h.snapshot().orderOverrides['N-1001']).toEqual({ status: 'Delivered' })
  })

  it('keeps pending replayable outbox when adapter succeeded but result persistence fails', () => {
    const memory = createMemoryStorage()
    let delivered = false
    const storage = {
      ...memory,
      save: (snapshot) => {
        if (delivered) throw Object.assign(new Error('Result write failed'), { code: 'STORAGE_FULL' })
        memory.save(snapshot)
      },
    }
    const deliver = vi.fn(() => { delivered = true; return true })
    const h = harness({ storage, deliver })
    accept(h)
    expect(deliver).toHaveBeenCalled()
    expect(h.snapshot().error).toMatchObject({ code: 'STORAGE_FULL' })
    expect(h.snapshot().deliveries.every((d) => d.transportState === 'Pending' && d.deliveredAt === null)).toBe(true)
    expect(memory.load().deliveries.every((d) => d.transportState === 'Pending')).toBe(true)
    delivered = false
    const replayed = new Set()
    const restored = harness({ storage: memory, deliver: vi.fn((n) => { replayed.add(`${n.notificationId}:${n.revision}`); return true }) })
    value(restored.service.tick(OPS))
    expect(replayed.size).toBe(2)
    expect(restored.snapshot().deliveries.every((d) => d.transportState === 'Delivered')).toBe(true)
  })

  it('failNext consumes only one actual attempted delivery and cannot block other shops', () => {
    const h = harness()
    value(h.service.setShopConnection(OPS, { shopId: 'A', connected: true, failNext: true }))
    accept(h)
    expect(h.snapshot().deliveries.find((d) => d.shopId === 'A').transportState).toBe('Retrying')
    expect(h.snapshot().deliveries.find((d) => d.shopId === 'B').transportState).toBe('Delivered')
    h.advance(1000)
    value(h.service.tick(OPS))
    expect(h.snapshot().deliveries.find((d) => d.shopId === 'A').transportState).toBe('Delivered')
  })

  it('terminal delivered revisions do not raise active unacknowledged-delay timers', () => {
    const h = harness()
    accept(h, { type: 'vehicle.cancelled', latestEstimatedAt: null })
    h.advance(900_000)
    value(h.service.tick(OPS))
    expect(h.snapshot().deliveries.every((d) => d.transportState === 'Delivered' && d.escalation === 'None')).toBe(true)
    const a = latest(h, 'A')
    expect(h.service.acknowledge(SHOP_A, acknowledgement(a.notificationId)).ok).toBe(true)
  })

  it('enforces bounded out-of-order queue capacity without deleting retained records', () => {
    const h = harness({ policy: { maxQueuedEvents: 2 } })
    accept(h, { eventId: 'gap-4', sequence: 4 })
    accept(h, { eventId: 'gap-5', sequence: 5 })
    code(h.service.receive(PLATFORM, sourceEvent({ eventId: 'gap-6', sequence: 6 })), 'LIMIT_EXCEEDED')
    expect(h.snapshot().events.map((r) => r.event.eventId)).toEqual(['gap-4', 'gap-5'])
    expect(h.snapshot().notifications.current).toEqual([])
  })

  it('checks mutation authorization on graph, channel, retry, reset and shop publishing', () => {
    const h = harness()
    for (const result of [
      h.service.replaceGraph(SHOP_A, { expectedVersion: 1, graph: graph() }),
      h.service.setShopConnection(SHOP_A, { shopId: 'B', connected: false }),
      h.service.retryDelivery(SHOP_A, { notificationId: 'guessed' }),
      h.service.retryProcessing(SHOP_A, { correlationId: 'guessed' }),
      h.service.resetDemo(SHOP_A),
      h.service.publishPlatformChange(SHOP_A, { kind: 'eta', vehicleOrderId: 'N-1001', estimatedAt: at(14) }),
      h.service.publishPlatformChange(SHOP_B, { kind: 'job', vehicleOrderId: 'N-1001', jobId: 'J-2001', jobState: 'Completed', actualAt: at(14) }),
    ]) code(result, 'FORBIDDEN')
    expect(h.snapshot().notifications.current).toEqual([])
  })
})

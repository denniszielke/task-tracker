import { classifyDelivery } from '../classifyDelivery.js'
import { assert, clone, DEFAULT_POLICY, errorValue, fail, id, nodeRef, object, positiveInteger, stable, timestamp, validateAcknowledgement, validateNotification, validateSourceEvent } from './contracts.js'
import { calculateImpacts, validateGraph } from './graph.js'
import { createMemoryStorage, snapshotBytes } from './storage.js'

const terminal = state => ['Resolved', 'Cancelled'].includes(state)
const millis = value => value == null ? null : Date.parse(value)
const trackingKey = value => `${value.notificationId}:${value.revision}`
const defaultIds = () => globalThis.crypto.randomUUID()
const getRecord = (records, key) => Object.hasOwn(records, key) ? records[key] : undefined
const setRecord = (records, key, value) => Object.defineProperty(records, key, { value, enumerable: true, writable: true, configurable: true })

export function createNotificationService({ graph, actors = [], clock, idFactory = defaultIds, storage = createMemoryStorage(), transport = { deliver: () => true }, policy: overrides = {} }) {
  const policy = { ...DEFAULT_POLICY, ...overrides }
  const registry = new Map((Array.isArray(actors) ? actors : Object.entries(actors).map(([key, value]) => ({ id: key, ...value }))).map(actor => [actor.id, clone(actor)]))
  const listeners = new Set()
  let state, initialGraph, health = null, bootError = null
  const now = () => {
    const value = clock?.now()
    assert(typeof value === 'number' && Number.isFinite(value), 'Service clock must return finite epoch milliseconds')
    return value
  }
  const instant = () => new Date(now()).toISOString()
  const newId = () => id(idFactory())
  function empty(validGraph) {
    return { schemaVersion: 1, graph: clone(validGraph), shopDirectory: Object.fromEntries(validGraph.shops.map(shop => [shop.id, shop])),
      events: [], lifecycles: [], notifications: [], deliveries: [], attempts: [],
      acknowledgements: [], acknowledgementAliases: [], audit: [], operationalErrors: [], orderOverrides: {}, channels: Object.fromEntries(validGraph.shops.map(shop => [shop.id, { connected: true, failNext: false }])),
      metrics: { accepted: 0, rejected: 0, duplicate: 0, stale: 0, processingFailed: 0, gaps: 0, cycles: 0, traversalCount: 0, traversalDurationMs: 0, fanOut: 0, deliveryLatencyMs: [], acknowledgementLatencyMs: [] } }
  }
  function validateStored(value) {
    assert(value && value.schemaVersion === 1, 'Unknown notification workspace schema', 'STORAGE_CORRUPT')
    const required = ['events', 'lifecycles', 'notifications', 'deliveries', 'attempts', 'acknowledgements', 'acknowledgementAliases', 'audit', 'operationalErrors']
    assert(required.every(key => Array.isArray(value[key])) && value.channels && value.metrics && value.orderOverrides && value.shopDirectory, 'Malformed notification workspace', 'STORAGE_CORRUPT')
    try {
      object(value, ['schemaVersion', 'graph', 'shopDirectory', 'events', 'lifecycles', 'notifications', 'deliveries', 'attempts', 'acknowledgements', 'acknowledgementAliases', 'audit',
        'operationalErrors', 'orderOverrides', 'channels', 'metrics'])
      value.graph = validateGraph(value.graph, policy)
      for (const record of value.events) {
        validateSourceEvent(record.event)
        timestamp(record.acceptedAt)
        assert(['applied', 'stale', 'queued-gap', 'processing-error'].includes(record.disposition), 'Invalid stored source state')
      }
      for (const notification of value.notifications) {
        validateNotification(notification)
        assert(getRecord(value.shopDirectory, notification.shopId), 'Invalid stored recipient')
      }
      for (const delivery of value.deliveries) {
        object(delivery, ['notificationId', 'revision', 'shopId', 'transportState', 'attemptCount', 'lastAttemptAt', 'nextAttemptAt', 'deliveredAt',
          'acknowledgement', 'escalation', 'supersededByRevision'])
        assert(value.notifications.some(notification => trackingKey(notification) === trackingKey(delivery) && notification.shopId === delivery.shopId), 'Orphaned stored delivery')
        assert(['Pending', 'Retrying', 'Delivered', 'Failed'].includes(delivery.transportState), 'Invalid stored transport state')
        assert(Number.isSafeInteger(delivery.attemptCount) && delivery.attemptCount >= 0, 'Invalid stored attempt count')
        assert(['None', 'Warning', 'Error'].includes(delivery.escalation), 'Invalid stored escalation')
        for (const field of ['lastAttemptAt', 'nextAttemptAt', 'deliveredAt']) timestamp(delivery[field], true)
        if (delivery.supersededByRevision !== null) positiveInteger(delivery.supersededByRevision)
      }
      for (const ack of [...value.acknowledgements, ...value.acknowledgementAliases]) {
        const { receivedAt, shopId, ...payload } = ack
        validateAcknowledgement(payload); timestamp(receivedAt); id(shopId)
        assert(value.notifications.some(notification => trackingKey(notification) === trackingKey(ack) && notification.shopId === shopId), 'Orphaned stored acknowledgement')
      }
      for (const lifecycle of value.lifecycles) {
        id(lifecycle.correlationId); nodeRef(lifecycle.root)
        assert(Number.isSafeInteger(lifecycle.lastAppliedSequence) && lifecycle.lastAppliedSequence >= 0
          && Number.isSafeInteger(lifecycle.latestRevision) && lifecycle.latestRevision >= 0, 'Invalid stored lifecycle counters')
        assert(lifecycle.shopSnapshots && Array.isArray(lifecycle.fullImpacts), 'Invalid stored lifecycle projection')
        if (lifecycle.latestEvent) {
          validateSourceEvent(lifecycle.latestEvent)
          assert(lifecycle.latestEvent.sequence === lifecycle.lastAppliedSequence && lifecycle.latestEvent.correlationId === lifecycle.correlationId
            && stable(lifecycle.latestEvent.root) === stable(lifecycle.root) && lifecycle.latestEvent.sourceSystem === lifecycle.sourceSystem,
          'Stored lifecycle provenance mismatch')
          assert(value.events.some(record => record.disposition === 'applied' && stable(record.event) === stable(lifecycle.latestEvent)), 'Stored lifecycle source is absent')
        } else assert(lifecycle.lastAppliedSequence === 0 && lifecycle.latestRevision === 0, 'Stored lifecycle has no applied provenance')
      }
      for (const attempt of value.attempts) {
        object(attempt, ['attemptId', 'notificationId', 'revision', 'shopId', 'attemptedAt', 'outcome', 'errorCode'])
        id(attempt.attemptId); timestamp(attempt.attemptedAt); positiveInteger(attempt.revision)
        assert(['Delivered', 'Failed'].includes(attempt.outcome), 'Invalid stored attempt')
        assert(value.deliveries.some(delivery => trackingKey(delivery) === trackingKey(attempt) && delivery.shopId === attempt.shopId), 'Orphaned stored attempt')
      }
      for (const notification of value.notifications) {
        const lifecycle = value.lifecycles.find(item => item.correlationId === notification.correlationId)
        assert(lifecycle && notification.revision <= lifecycle.latestRevision && notification.graphVersion <= value.graph.version, 'Orphaned stored notification')
        assert(value.events.some(record => record.event.eventId === notification.sourceEventId && record.disposition === 'applied'), 'Missing notification provenance')
        assert(value.deliveries.filter(delivery => trackingKey(delivery) === trackingKey(notification)).length === 1, 'Missing or duplicated stored tracking')
      }
      for (const delivery of value.deliveries) {
        assert(delivery.transportState !== 'Delivered' || delivery.deliveredAt !== null, 'Delivered tracking has no receipt')
        if (delivery.deliveredAt !== null) assert(value.attempts.some(attempt => trackingKey(attempt) === trackingKey(delivery) && attempt.outcome === 'Delivered'), 'Delivery has no successful attempt')
        if (delivery.acknowledgement !== null) {
          const { receivedAt, ...ack } = delivery.acknowledgement
          validateAcknowledgement(ack); timestamp(receivedAt)
          assert(value.acknowledgements.some(record => record.acknowledgementId === ack.acknowledgementId), 'Tracking has no acknowledgement record')
        }
      }
      for (const [shopId, shop] of Object.entries(value.shopDirectory)) {
        assert(shop.id === shopId, 'Invalid stored shop metadata')
        validateGraph({ version: 1, shops: [shop], orders: [], jobs: [], edges: [] }, policy)
      }
      for (const [shopId, channel] of Object.entries(value.channels)) {
        object(channel, ['connected', 'failNext'])
        assert(getRecord(value.shopDirectory, shopId) && typeof channel.connected === 'boolean' && typeof channel.failNext === 'boolean', 'Invalid stored channel')
      }
      for (const entry of value.audit) {
        object(entry, ['auditId', 'at', 'action', 'outcome', 'actorId', 'eventId', 'correlationId', 'notificationId', 'shopId', 'revision', 'code', 'details'],
          ['auditId', 'at', 'action', 'outcome', 'eventId', 'correlationId', 'notificationId', 'shopId', 'revision'])
        id(entry.auditId); timestamp(entry.at); id(entry.action); id(entry.outcome)
        for (const field of ['eventId', 'correlationId', 'notificationId', 'shopId']) if (entry[field] !== null) id(entry[field])
        if (entry.revision !== null) positiveInteger(entry.revision)
      }
      assert(new Set(value.events.map(record => record.event.eventId)).size === value.events.length, 'Duplicate stored event')
      assert(new Set(value.notifications.map(trackingKey)).size === value.notifications.length, 'Duplicate stored revision')
    } catch { fail('STORAGE_CORRUPT', 'Invalid notification workspace; reset explicitly or choose a volatile session') }
    return value
  }
  try {
    now()
    initialGraph = validateGraph(graph, policy)
    assert(initialGraph.version === 1, 'Initial graph must have version 1')
    const loaded = storage.load()
    state = loaded === null ? empty(initialGraph) : validateStored(clone(loaded))
  } catch (error) {
    bootError = errorValue(error)
    health = bootError
    state = empty({ version: 1, orders: [], shops: [], jobs: [], edges: [] })
  }

  function actorFor(actor, roles) {
    const trusted = actor && typeof actor.id === 'string' ? registry.get(actor.id) : null
    assert(trusted, 'Unknown or missing demo actor', 'UNAUTHENTICATED')
    assert(roles.includes(trusted.role), 'Actor cannot perform this operation', 'FORBIDDEN')
    return trusted
  }
  function audit(draft, action, outcome, actor, refs = {}) {
    draft.audit.push({ auditId: newId(), at: instant(), action, outcome,
      ...(actor?.id && registry.has(actor.id) ? { actorId: actor.id } : {}),
      eventId: null, correlationId: null, notificationId: null, shopId: null, revision: null, ...refs })
  }
  function metricsFor(snapshot) {
    const counts = { delivered: 0, failed: 0, retrying: 0, pending: 0, acknowledged: 0, retryTotals: 0, oldestUndeliveredAgeMs: 0 }
    let time = 0
    try { time = now() } catch { /* A boot health snapshot remains readable with a broken clock. */ }
    for (const delivery of snapshot.deliveries) {
      if (delivery.supersededByRevision !== null) continue
      counts[delivery.transportState.toLowerCase()]++
      if (delivery.acknowledgement?.outcome === 'Accepted') counts.acknowledged++
      counts.retryTotals += Math.max(0, delivery.attemptCount - 1)
      if (delivery.deliveredAt === null) {
        const notification = snapshot.notifications.find(item => trackingKey(item) === trackingKey(delivery))
        counts.oldestUndeliveredAgeMs = Math.max(counts.oldestUndeliveredAgeMs, time - millis(notification.createdAt))
      }
    }
    return { ...snapshot.metrics, ...counts }
  }
  function currentNotifications(snapshot, shopId) {
    const latest = new Map()
    for (const notification of snapshot.notifications) {
      if (shopId && notification.shopId !== shopId) continue
      const previous = latest.get(notification.notificationId)
      if (!previous || previous.revision < notification.revision) latest.set(notification.notificationId, notification)
    }
    return [...latest.values()]
  }
  function view(trusted) {
    const persistenceState = health ? 'error' : storage.persistenceState === 'local' ? 'local' : 'volatile'
    const current = currentNotifications(state, trusted.role === 'shop' ? trusted.shopId : null)
    const currentKeys = new Set(current.map(trackingKey))
    const all = state.notifications.filter(notification => trusted.role !== 'shop' || notification.shopId === trusted.shopId)
    const deliveries = state.deliveries.filter(delivery => trusted.role !== 'shop' || delivery.shopId === trusted.shopId).map(delivery => {
      const notification = all.find(item => trackingKey(item) === trackingKey(delivery))
      const displayState = delivery.acknowledgement?.outcome === 'Accepted' ? 'Acknowledged'
        : terminal(notification?.state) && delivery.transportState === 'Delivered' ? notification.state : delivery.transportState
      return { ...delivery, displayState }
    })
    const base = { role: trusted.role, persistenceState, error: health, notifications: { current, history: all.filter(notification => !currentKeys.has(trackingKey(notification))) },
      deliveries, acknowledgements: state.acknowledgements.filter(ack => trusted.role !== 'shop' || ack.shopId === trusted.shopId) }
    if (trusted.role === 'shop') return clone({ ...base, shop: getRecord(state.shopDirectory, trusted.shopId) ?? { id: trusted.shopId },
      jobs: state.graph.jobs.filter(job => job.shopId === trusted.shopId) })
    return clone({ ...base, graphVersion: state.graph.version, shops: Object.values(state.shopDirectory), orders: state.graph.orders, jobs: state.graph.jobs,
      orderOverrides: state.orderOverrides, lifecycles: state.lifecycles, audit: state.audit, events: state.events, attempts: state.attempts,
      metrics: metricsFor(state), operationalErrors: [...state.operationalErrors, ...(health ? [health] : [])], channels: state.channels })
  }
  function notify() {
    for (const subscription of listeners) {
      try { subscription.listener(view(subscription.actor)) } catch { /* A subscriber must not interrupt another recipient. */ }
    }
  }
  function commit(draft) {
    assert(draft.audit.length <= policy.maxAuditRecords, 'Audit capacity reached; review and explicitly reset demo', 'STORAGE_FULL')
    assert(snapshotBytes(draft) <= policy.maxSnapshotBytes, 'Workspace capacity reached; review and explicitly reset demo', 'STORAGE_FULL')
    try { storage.save(clone(draft)) } catch (error) {
      const code = ['STORAGE_FULL', 'STORAGE_CORRUPT', 'STORAGE_UNAVAILABLE'].includes(error?.code) ? error.code
        : error?.name === 'QuotaExceededError' ? 'STORAGE_FULL' : 'STORAGE_UNAVAILABLE'
      fail(code, 'Unable to persist notification mutation')
    }
    state = draft
    health = null
    notify()
  }
  function reject(error, action, actor) {
    const normalized = errorValue(error)
    if (normalized.code.startsWith('STORAGE_')) {
      health = normalized
      notify()
      return { ok: false, error: normalized }
    }
    if (!bootError) {
      try {
        const draft = clone(state)
        draft.metrics.rejected++
        if (normalized.code === 'GRAPH_CYCLE') draft.metrics.cycles++
        audit(draft, action, 'Rejected', actor, { code: normalized.code })
        commit(draft)
      } catch (auditError) {
        health = errorValue(auditError)
        notify()
      }
    }
    return { ok: false, error: normalized }
  }
  function command(action, actor, roles, run, { allowBoot = false, deliver = false } = {}) {
    try {
      const trusted = actorFor(actor, roles)
      if (bootError && !allowBoot) return { ok: false, error: clone(bootError) }
      const result = run(trusted)
      if (deliver) deliverDue()
      return { ok: true, value: clone(result) }
    } catch (error) { return reject(error, action, actor) }
  }
  function rootOf(draft, root) {
    return (root.kind === 'order' ? draft.graph.orders : draft.graph.jobs).find(item => item.id === root.id)
  }
  function validateEventScope(draft, trusted, event) {
    const sourceSystem = trusted.sourceSystem ?? (trusted.id === 'platform-demo' ? 'platform-demo' : trusted.role === 'shop' ? `shop-demo:${trusted.shopId}` : null)
    assert(sourceSystem && event.sourceSystem === sourceSystem, 'Producer source system mismatch', 'FORBIDDEN')
    assert(trusted.role === 'producer' || trusted.role === 'shop', 'Source events require a producer', 'FORBIDDEN')
    if (sourceSystem !== 'platform-demo') assert(sourceSystem === `shop-demo:${trusted.shopId}` && event.type === 'repair-job.completion-revised', 'Producer type is not allowed', 'FORBIDDEN')
    if (trusted.eventTypes) assert(trusted.eventTypes.includes(event.type), 'Producer event type is not allowed', 'FORBIDDEN')
    if (trusted.orderIds) assert(trusted.orderIds.includes(event.vehicleOrderId), 'Order outside producer scope', 'FORBIDDEN')
    const order = draft.graph.orders.find(item => item.id === event.vehicleOrderId)
    assert(order, 'Unknown vehicle order', 'MISSING_DEPENDENCY')
    const root = rootOf(draft, event.root)
    assert(root, 'Unknown event root', 'MISSING_DEPENDENCY')
    if (event.root.kind === 'job') {
      assert(root.vehicleOrderId === order.id, 'Job root order mismatch')
      if (sourceSystem !== 'platform-demo') assert(root.shopId === trusted.shopId, 'Job belongs to another shop', 'FORBIDDEN')
      if (event.latestEstimatedAt !== null) assert(millis(event.latestEstimatedAt) >= millis(root.plannedStartAt) + root.durationMinutes * 60000, 'Estimate precedes planned finish')
    }
    assert(event.vehicleRef === order.vehicleRef && event.previousCommittedAt === order.committedAt, 'Source reference or committed baseline mismatch')
  }
  function shadow(draft, event) {
    const root = rootOf(draft, event.root)
    if (event.root.kind === 'order') {
      if (event.type === 'vehicle.delivered') { root.status = 'Delivered'; root.actualArrivalAt = event.actualAt }
      else if (event.type === 'vehicle.cancelled') root.status = 'Cancelled'
      else root.estimatedArrivalAt = event.latestEstimatedAt
      if (['vehicle.delivered', 'vehicle.cancelled'].includes(event.type)) setRecord(draft.orderOverrides, root.id, { status: root.status })
    } else {
      root.state = event.rootState
      if (event.rootState === 'Completed') root.actualCompletionAt = event.actualAt
      else if (event.rootState !== 'Cancelled') root.estimatedCompletionAt = event.latestEstimatedAt
    }
  }
  function redactImpact(draft, impact, shopId) {
    const ownJobs = new Set(draft.graph.jobs.filter(job => job.shopId === shopId).map(job => job.id))
    const { shopId: ignored, ...safe } = impact
    void ignored
    return { ...safe, reasons: impact.reasons.map(reason => {
      const prerequisite = reason.path.at(-2)
      return { ...reason,
        prerequisiteReadyAt: prerequisite?.kind === 'job' && !ownJobs.has(prerequisite.id) ? null : reason.prerequisiteReadyAt,
        path: reason.path.map(node => node.kind === 'job' && !ownJobs.has(node.id) ? { kind: 'external-prerequisite' } : node),
      }
    }) }
  }
  function calculateLifecycle(draft, lifecycle, cause) {
    const event = lifecycle.latestEvent
    if (!event) return []
    const root = rootOf(draft, lifecycle.root)
    assert(root, 'Lifecycle root removed from graph', 'MISSING_DEPENDENCY')
    const started = globalThis.performance?.now() ?? 0
    const result = calculateImpacts({
      graph: draft.graph, root: lifecycle.root,
      latestEstimatedAt: lifecycle.root.kind === 'order' ? root.estimatedArrivalAt ?? event.latestEstimatedAt : root.estimatedCompletionAt ?? event.latestEstimatedAt,
      actualAt: lifecycle.root.kind === 'order' ? root.actualArrivalAt : root.actualCompletionAt,
      rootState: lifecycle.root.kind === 'order' ? root.status : root.state,
    })
    draft.metrics.traversalCount++
    draft.metrics.traversalDurationMs += Math.max(0, (globalThis.performance?.now() ?? started) - started)
    if (result.diagnostics.length) fail('MISSING_READINESS', 'A prerequisite has no readiness time', { diagnostics: result.diagnostics })
    const previous = lifecycle.shopSnapshots ?? {}
    const next = Object.create(null)
    const recipientIds = [...new Set([...draft.graph.shops.map(shop => shop.id), ...Object.keys(previous)])].sort()
    for (const recipientId of recipientIds) {
      const shop = getRecord(draft.shopDirectory, recipientId) ?? { id: recipientId }
      const active = result.impacts.filter(impact => impact.shopId === shop.id).map(impact => redactImpact(draft, impact, shop.id))
      const blocked = result.cancelledJobIds.map(jobId => draft.graph.jobs.find(job => job.id === jobId)).filter(job => job.shopId === shop.id)
      const prior = getRecord(previous, shop.id)
      if (!active.length && !prior && !blocked.length) continue
      let stateName = active.length ? prior ? 'Revised' : 'New' : 'Resolved'
      let jobs = active
      if (!active.length) {
        if (blocked.length && (!prior || prior.activeJobs.every(job => result.cancelledJobIds.includes(job.jobId)))) stateName = 'Cancelled'
        jobs = prior?.activeJobs?.length ? prior.activeJobs : prior?.payload?.affectedJobs
          ?? result.cancelledImpacts.filter(impact => impact.shopId === shop.id).map(impact => redactImpact(draft, impact, shop.id))
      }
      const projected = { activeJobs: active, affectedJobs: jobs, terminalState: active.length ? null : stateName,
        latestEstimatedAt: event.latestEstimatedAt, estimateBasis: event.estimateBasis ?? 'reported' }
      // New/Revised are presentation labels; an unchanged active projection is a no-op.
      const fingerprint = stable(projected)
      if (prior?.fingerprint === fingerprint) { next[shop.id] = prior; continue }
      if (prior && !prior.activeJobs.length && !active.length && prior.payload.state === stateName && !blocked.length) { next[shop.id] = prior; continue }
      next[shop.id] = { ...projected, fingerprint, stateName, prior, changed: true }
    }
    const changedShops = Object.keys(next).filter(shopId => next[shopId].changed).sort()
    lifecycle.fullImpacts = result.impacts
    lifecycle.fullCancelledImpacts = result.cancelledImpacts
    lifecycle.cancelledJobIds = result.cancelledJobIds
    lifecycle.predecessorRefs = result.predecessorRefs
    lifecycle.graphVersion = draft.graph.version
    lifecycle.currentState = result.impacts.length ? 'Active' : result.cancelledJobIds.length ? 'Cancelled' : 'Resolved'
    if (!changedShops.length) return []
    lifecycle.latestRevision++
    const refs = []
    for (const shopId of changedShops) {
      const projection = next[shopId], prior = projection.prior
      const notificationId = prior?.payload.notificationId ?? newId()
      const oldJobs = prior?.activeJobs ?? [], newJobs = projection.activeJobs
      const oldById = new Map(oldJobs.map(job => [job.jobId, job])), newById = new Map(newJobs.map(job => [job.jobId, job]))
      const payload = {
        schemaVersion: 1, notificationId, revision: lifecycle.latestRevision, sourceEventId: event.eventId,
        correlationId: lifecycle.correlationId, vehicleOrderId: event.vehicleOrderId, vehicleRef: event.vehicleRef, shopId, state: projection.stateName,
        previousCommittedAt: event.previousCommittedAt, latestEstimatedAt: event.latestEstimatedAt,
        delayMs: event.previousCommittedAt === null || event.latestEstimatedAt === null ? null : Math.max(0, millis(event.latestEstimatedAt) - millis(event.previousCommittedAt)),
        estimateBasis: event.estimateBasis ?? 'reported', createdAt: instant(), acceptedAt: lifecycle.acceptedAt,
        graphVersion: draft.graph.version, affectedJobs: projection.affectedJobs,
        changes: { addedJobIds: newJobs.filter(job => !oldById.has(job.jobId)).map(job => job.jobId),
          removedJobIds: oldJobs.filter(job => !newById.has(job.jobId)).map(job => job.jobId),
          updatedJobIds: newJobs.filter(job => oldById.has(job.jobId) && stable(job) !== stable(oldById.get(job.jobId))).map(job => job.jobId),
          previousEstimatedAt: prior?.payload.latestEstimatedAt ?? null },
        acknowledgementInstructions: { operation: 'acknowledge', notificationId, revision: lifecycle.latestRevision },
      }
      draft.notifications.push(payload)
      for (const old of draft.deliveries) if (old.notificationId === notificationId && old.deliveredAt === null && old.supersededByRevision === null) old.supersededByRevision = payload.revision
      draft.deliveries.push({ notificationId, revision: payload.revision, shopId, transportState: 'Pending', attemptCount: 0,
        lastAttemptAt: null, nextAttemptAt: instant(), deliveredAt: null, acknowledgement: null, escalation: 'None', supersededByRevision: null })
      next[shopId] = { activeJobs: newJobs, fingerprint: projection.fingerprint, payload }
      refs.push({ notificationId, revision: payload.revision, shopId })
      audit(draft, cause ?? 'notification.create', 'Created', null, { eventId: event.eventId, correlationId: lifecycle.correlationId, notificationId, shopId, revision: payload.revision })
    }
    lifecycle.shopSnapshots = next
    draft.metrics.fanOut += refs.length
    return refs
  }
  function newLifecycle(event) {
    return { correlationId: event.correlationId, root: clone(event.root), vehicleOrderId: event.vehicleOrderId, sourceSystem: event.sourceSystem,
      lastAppliedSequence: 0, latestRevision: 0, latestEvent: null, acceptedAt: null, fullImpacts: [], shopSnapshots: {}, processingError: null, expectedSequence: 1 }
  }
  function resultFor(draft, record, refs = []) {
    const lifecycle = draft.lifecycles.find(item => item.correlationId === record.event.correlationId)
    return { disposition: record.disposition, eventId: record.event.eventId, correlationId: record.event.correlationId,
      lastAppliedSequence: lifecycle?.lastAppliedSequence ?? 0, expectedSequence: (lifecycle?.lastAppliedSequence ?? 0) + 1,
      revision: lifecycle?.latestRevision || null, notificationRefs: refs }
  }
  function applyRecord(draft, record) {
    const event = record.event
    const lifecycle = draft.lifecycles.find(item => item.correlationId === event.correlationId)
    const backup = clone(draft)
    try {
      const root = rootOf(draft, event.root)
      if (event.type === 'vehicle.late') assert(root.status !== 'Cancelled' && classifyDelivery({ status: root.status, inspectionAt: root.committedAt }, now()) === 'Late', 'vehicle.late requires canonical Late')
      if (lifecycle.latestEvent) {
        const previous = lifecycle.latestEvent
        const previousTerminal = previous.type === 'vehicle.cancelled' || previous.type === 'vehicle.delivered'
          || (previous.type === 'repair-job.completion-revised' && ['Cancelled', 'Completed'].includes(previous.rootState))
        assert(!previousTerminal, 'Terminal root requires a new correlation')
      }
      shadow(draft, event)
      lifecycle.latestEvent = event
      lifecycle.acceptedAt = record.acceptedAt
      const refs = []
      for (const active of draft.lifecycles) if (active.latestEvent) refs.push(...calculateLifecycle(draft, active, active === lifecycle ? 'source.apply' : 'source.recalculate'))
      lifecycle.lastAppliedSequence = event.sequence
      lifecycle.expectedSequence = event.sequence + 1
      lifecycle.processingError = null
      record.disposition = 'applied'
      delete record.error
      audit(draft, 'source.apply', 'Applied', null, { eventId: event.eventId, correlationId: event.correlationId })
      return refs
    } catch (error) {
      const normalized = errorValue(error)
      if (!['MISSING_READINESS', 'MISSING_DEPENDENCY', 'GRAPH_CYCLE'].includes(normalized.code)) throw error
      for (const field of Object.keys(draft)) delete draft[field]
      Object.assign(draft, backup)
      const retained = draft.events.find(item => item.event.eventId === event.eventId)
      retained.disposition = 'processing-error'; retained.error = normalized
      const retainedLifecycle = draft.lifecycles.find(item => item.correlationId === event.correlationId)
      retainedLifecycle.processingError = normalized
      draft.metrics.processingFailed++
      audit(draft, 'source.apply', 'ProcessingError', null, { eventId: event.eventId, correlationId: event.correlationId, code: normalized.code })
      return []
    }
  }
  function drain(draft, correlationId) {
    const refs = []
    while (true) {
      const lifecycle = draft.lifecycles.find(item => item.correlationId === correlationId)
      const next = draft.events.find(record => record.event.correlationId === correlationId && record.event.sequence === lifecycle.lastAppliedSequence + 1 && ['queued-gap', 'processing-error'].includes(record.disposition))
      if (!next) break
      refs.push(...applyRecord(draft, next))
      if (draft.events.find(record => record.event.eventId === next.event.eventId).disposition !== 'applied') break
    }
    return refs
  }
  function receiveInto(draft, trusted, input) {
    const event = validateSourceEvent(input)
    validateEventScope(draft, trusted, event)
    const existing = draft.events.find(record => record.event.eventId === event.eventId)
    if (existing) {
      assert(stable(existing.event) === stable(event), 'Event ID content conflict', 'ID_CONFLICT')
      draft.metrics.duplicate++
      audit(draft, 'source.receive', 'Duplicate', trusted, { eventId: event.eventId, correlationId: event.correlationId })
      return { ...resultFor(draft, existing), disposition: 'duplicate' }
    }
    let lifecycle = draft.lifecycles.find(item => item.correlationId === event.correlationId)
    if (lifecycle) assert(stable(lifecycle.root) === stable(event.root) && lifecycle.vehicleOrderId === event.vehicleOrderId && lifecycle.sourceSystem === event.sourceSystem, 'Correlation binding conflict', 'SEQUENCE_CONFLICT')
    else { lifecycle = newLifecycle(event); draft.lifecycles.push(lifecycle) }
    const sameSequence = draft.events.find(record => record.event.correlationId === event.correlationId && record.event.sequence === event.sequence)
    assert(!sameSequence || event.sequence < lifecycle.lastAppliedSequence, 'Sequence already belongs to another event', 'SEQUENCE_CONFLICT')
    const disposition = event.sequence < lifecycle.lastAppliedSequence ? 'stale' : event.sequence > lifecycle.lastAppliedSequence + 1 ? 'queued-gap' : 'queued-gap'
    if (event.sequence > lifecycle.lastAppliedSequence + 1) assert(draft.events.filter(record => record.event.correlationId === event.correlationId && record.disposition === 'queued-gap').length < policy.maxQueuedEvents, 'Gap queue limit exceeded', 'LIMIT_EXCEEDED')
    const record = { event, acceptedAt: instant(), disposition }
    draft.events.push(record); draft.metrics.accepted++
    if (disposition === 'stale') draft.metrics.stale++
    else if (event.sequence > lifecycle.lastAppliedSequence + 1) draft.metrics.gaps++
    audit(draft, 'source.receive', disposition, trusted, { eventId: event.eventId, correlationId: event.correlationId })
    const refs = disposition === 'stale' ? [] : drain(draft, event.correlationId)
    return resultFor(draft, draft.events.find(item => item.event.eventId === event.eventId), refs)
  }
  function attemptOne(keyValue) {
    const original = state.deliveries.find(delivery => trackingKey(delivery) === keyValue)
    if (!original || original.supersededByRevision !== null || !['Pending', 'Retrying'].includes(original.transportState)) return false
    const notification = state.notifications.find(item => trackingKey(item) === keyValue)
    let accepted = false, deliveryError = null
    const channel = getRecord(state.channels, original.shopId)
    try {
      if (!channel?.connected) fail('DELIVERY_FAILED', 'Simulated shop channel disconnected')
      if (channel.failNext) fail('DELIVERY_FAILED', 'Simulated next delivery failure')
      assert(transport.deliver(clone(notification)) === true, 'Recipient adapter did not accept payload', 'DELIVERY_FAILED')
      accepted = true
    } catch (error) { deliveryError = errorValue(error) }
    const draft = clone(state), delivery = draft.deliveries.find(item => trackingKey(item) === keyValue)
    if (draft.channels[delivery.shopId]?.failNext) draft.channels[delivery.shopId].failNext = false
    delivery.attemptCount++
    delivery.lastAttemptAt = instant()
    draft.attempts.push({ attemptId: newId(), notificationId: delivery.notificationId, revision: delivery.revision, shopId: delivery.shopId,
      attemptedAt: instant(), outcome: accepted ? 'Delivered' : 'Failed', errorCode: accepted ? null : deliveryError.code })
    if (accepted) {
      delivery.transportState = 'Delivered'; delivery.deliveredAt = instant(); delivery.nextAttemptAt = null
      draft.metrics.deliveryLatencyMs.push(Math.max(0, now() - millis(notification.acceptedAt)))
    } else if (delivery.attemptCount <= policy.retryDelaysMs.length) {
      delivery.transportState = 'Retrying'
      delivery.nextAttemptAt = new Date(now() + policy.retryDelaysMs[delivery.attemptCount - 1]).toISOString()
    } else {
      delivery.transportState = 'Failed'; delivery.nextAttemptAt = null; delivery.escalation = 'Error'
    }
    audit(draft, 'delivery.attempt', accepted ? 'Delivered' : 'Failed', null, { eventId: notification.sourceEventId, correlationId: notification.correlationId,
      notificationId: notification.notificationId, shopId: notification.shopId, revision: notification.revision, ...(accepted ? {} : { code: deliveryError.code }) })
    try { commit(draft) } catch (error) { health = errorValue(error); notify() }
    return true
  }
  function deliverDue(shopId = null, force = false) {
    let attempted = 0
    const due = state.deliveries.filter(delivery => delivery.supersededByRevision === null && ['Pending', 'Retrying'].includes(delivery.transportState)
      && (!shopId || delivery.shopId === shopId) && (force || millis(delivery.nextAttemptAt) <= now())).map(trackingKey)
    for (const keyValue of due) if (attemptOne(keyValue)) attempted++
    return attempted
  }
  function publisher(trusted) {
    if (trusted.role === 'shop') return trusted
    const platform = [...registry.values()].find(actor => actor.role === 'producer' && (actor.sourceSystem === 'platform-demo' || actor.id === 'platform-demo'))
    assert(platform, 'Platform producer is not registered', 'FORBIDDEN')
    return platform
  }
  function publishInto(draft, trusted, change) {
    object(change, ['kind', 'vehicleOrderId', 'jobId', 'estimatedAt', 'actualAt', 'jobState', 'reasonCode', 'context'], ['kind', 'vehicleOrderId'])
    assert(['observe', 'eta', 'correct', 'deliver', 'cancel', 'job'].includes(change.kind), 'Invalid platform change kind')
    id(change.vehicleOrderId)
    const order = draft.graph.orders.find(item => item.id === change.vehicleOrderId)
    assert(order, 'Unknown source order', 'NOT_FOUND')
    if (trusted.role === 'shop') assert(change.kind === 'job', 'Shops can only publish assigned job changes', 'FORBIDDEN')
    const root = change.kind === 'job' ? { kind: 'job', id: id(change.jobId) } : { kind: 'order', id: order.id }
    const sourceActor = publisher(trusted)
    const sourceSystem = sourceActor.sourceSystem ?? (sourceActor.role === 'shop' ? `shop-demo:${sourceActor.shopId}` : 'platform-demo')
    const open = draft.lifecycles.find(lifecycle => stable(lifecycle.root) === stable(root) && lifecycle.sourceSystem === sourceSystem
      && (!lifecycle.latestEvent || !['vehicle.delivered', 'vehicle.cancelled'].includes(lifecycle.latestEvent.type)
        && !['Completed', 'Cancelled'].includes(lifecycle.latestEvent.rootState)))
    let estimatedAt = change.estimatedAt === undefined ? null : timestamp(change.estimatedAt)
    let estimateBasis = 'reported'
    if (change.kind === 'observe') {
      const classification = classifyDelivery({ status: order.status, inspectionAt: order.committedAt }, now())
      if (order.status === 'Cancelled' || classification !== 'Late') return { disposition: 'duplicate', eventId: open?.latestEvent?.eventId ?? null,
        correlationId: open?.correlationId ?? null, lastAppliedSequence: open?.lastAppliedSequence ?? 0, expectedSequence: (open?.lastAppliedSequence ?? 0) + 1, revision: open?.latestRevision || null, notificationRefs: [] }
      const reported = open?.latestEvent?.estimateBasis !== 'observed-lower-bound' ? order.estimatedArrivalAt : null
      const estimate = Math.max(now(), millis(reported) ?? 0, millis(order.committedAt))
      estimatedAt = new Date(estimate).toISOString()
      estimateBasis = reported && millis(reported) >= now() ? 'reported' : 'observed-lower-bound'
      if (open?.latestEvent?.latestEstimatedAt === estimatedAt && (open.latestEvent.estimateBasis ?? 'reported') === estimateBasis) return { ...resultFor(draft, { event: open.latestEvent, disposition: 'duplicate' }), notificationRefs: [] }
    }
    const type = { observe: open?.latestEvent ? 'vehicle.eta-revised' : 'vehicle.late', eta: 'vehicle.eta-revised', correct: 'vehicle.delay-corrected', deliver: 'vehicle.delivered', cancel: 'vehicle.cancelled', job: 'repair-job.completion-revised' }[change.kind]
    const event = {
      schemaVersion: 1, eventId: newId(), type, sourceSystem, occurredAt: instant(), vehicleOrderId: order.id,
      vehicleRef: order.vehicleRef, correlationId: open?.correlationId ?? newId(), causationId: open?.latestEvent?.eventId ?? null,
      sequence: (open?.lastAppliedSequence ?? 0) + 1, root, previousCommittedAt: order.committedAt,
      latestEstimatedAt: estimatedAt, actualAt: change.actualAt === undefined ? null : timestamp(change.actualAt),
      reasonCode: change.reasonCode ?? (estimateBasis === 'observed-lower-bound' ? 'OBSERVED_OVERDUE' : 'PLATFORM_UPDATE'),
      estimateBasis, ...(change.context === undefined ? {} : { context: change.context }),
      ...(change.kind === 'job' ? { rootState: change.jobState } : {}),
    }
    const result = receiveInto(draft, sourceActor, event)
    if (change.kind !== 'observe' && root.kind === 'order' && result.disposition === 'applied') setRecord(draft.orderOverrides, order.id, { status: order.status })
    return result
  }

  const service = {
    receive(actor, event) {
      return command('source.receive', actor, ['producer', 'shop'], trusted => {
        const draft = clone(state), result = receiveInto(draft, trusted, event)
        commit(draft)
        return result
      }, { deliver: true })
    },
    publishPlatformChange(actor, change) {
      return command('platform.publish', actor, ['operations', 'shop'], trusted => {
        const draft = clone(state), result = publishInto(draft, trusted, change)
        commit(draft)
        return result
      }, { deliver: true })
    },
    reconcilePlatform(actor, input) {
      return command('platform.reconcile', actor, ['operations', 'producer'], trusted => {
        if (trusted.role === 'producer') assert(trusted.sourceSystem === 'platform-demo' || trusted.id === 'platform-demo', 'Only platform can reconcile', 'FORBIDDEN')
        object(input, ['orders']); assert(Array.isArray(input.orders), 'Expected safe source orders')
        const results = [], errors = []
        for (const source of input.orders) {
          try {
            const draft = clone(state)
            id(source.id)
            const order = draft.graph.orders.find(item => item.id === source.id)
            assert(order, 'Source order is absent from notification graph', 'NOT_FOUND')
            const committedAt = source.inspectionAt == null || source.inspectionAt === '' ? null : timestamp(source.inspectionAt)
            if (!getRecord(draft.orderOverrides, source.id)) {
              order.committedAt = committedAt
              if (source.status !== undefined) order.status = id(source.status, 'status')
              for (const lifecycle of draft.lifecycles) if (lifecycle.latestEvent) calculateLifecycle(draft, lifecycle, 'platform.recalculate')
            }
            const result = publishInto(draft, trusted, { kind: 'observe', vehicleOrderId: source.id })
            commit(draft); results.push(result)
          } catch (error) { errors.push(errorValue(error)); reject(error, 'platform.reconcile', actor) }
        }
        return { results, errors }
      }, { deliver: true })
    },
    replaceGraph(actor, input) {
      return command('graph.replace', actor, ['operations'], trusted => {
        object(input, ['expectedVersion', 'graph'])
        assert(input.expectedVersion === state.graph.version, 'Graph version conflict', 'VERSION_CONFLICT')
        const draft = clone(state)
        draft.graph = validateGraph({ ...input.graph, version: state.graph.version + 1 }, policy)
        // Graph edits must not roll accepted source-domain shadows back to fixture estimates.
        const sourceRoots = new Map(state.events.filter(record => record.disposition === 'applied')
          .map(record => [`${record.event.root.kind}:${record.event.root.id}`, record.event.root]))
        for (const root of sourceRoots.values()) {
          const previous = rootOf(state, root), replacement = rootOf(draft, root)
          if (!replacement) continue
          const fields = root.kind === 'order' ? ['status', 'estimatedArrivalAt', 'actualArrivalAt']
            : ['state', 'estimatedCompletionAt', 'actualCompletionAt']
          for (const field of fields) replacement[field] = previous[field]
        }
        draft.graph = validateGraph(draft.graph, policy)
        for (const shop of draft.graph.shops) {
          setRecord(draft.shopDirectory, shop.id, shop)
          if (!getRecord(draft.channels, shop.id)) setRecord(draft.channels, shop.id, { connected: true, failNext: false })
        }
        const revisions = []
        for (const lifecycle of draft.lifecycles) {
          const prior = lifecycle.latestRevision
          calculateLifecycle(draft, lifecycle, 'graph.recalculate')
          if (prior !== lifecycle.latestRevision) revisions.push({ correlationId: lifecycle.correlationId, revision: lifecycle.latestRevision })
        }
        audit(draft, 'graph.replace', 'Applied', trusted)
        commit(draft)
        return { graphVersion: draft.graph.version, revisions }
      }, { deliver: true })
    },
    acknowledge(actor, input) {
      return command('notification.acknowledge', actor, ['shop'], trusted => {
        const ack = validateAcknowledgement(input), draft = clone(state)
        const notification = draft.notifications.find(item => trackingKey(item) === trackingKey(ack))
        assert(notification, 'Exact notification revision not found', 'NOT_FOUND')
        assert(notification.shopId === trusted.shopId, 'Notification belongs to another shop', 'FORBIDDEN')
        const byId = [...draft.acknowledgements, ...draft.acknowledgementAliases].find(item => item.acknowledgementId === ack.acknowledgementId)
        if (byId) {
          const { receivedAt, shopId, ...previous } = byId
          void shopId
          assert(stable(previous) === stable(ack), 'Acknowledgement ID content conflict', 'ACK_CONFLICT')
          return { disposition: 'duplicate', acknowledgement: previous, receivedAt }
        }
        const delivery = draft.deliveries.find(item => trackingKey(item) === trackingKey(ack))
        assert(delivery?.deliveredAt !== null && delivery?.deliveredAt !== undefined, 'Revision has not been successfully delivered', 'NOT_DELIVERED')
        const prior = draft.acknowledgements.find(item => trackingKey(item) === trackingKey(ack) && item.shopId === trusted.shopId)
        if (prior) {
          assert(stable([prior.outcome, prior.reasonCode ?? null, prior.comment ?? null]) === stable([ack.outcome, ack.reasonCode ?? null, ack.comment ?? null]), 'Revision already has another outcome', 'ACK_CONFLICT')
          const receivedAt = instant()
          draft.acknowledgementAliases.push({ ...ack, receivedAt, shopId: trusted.shopId })
          audit(draft, 'notification.acknowledge', 'Duplicate', trusted, { notificationId: ack.notificationId, revision: ack.revision, shopId: trusted.shopId,
            correlationId: notification.correlationId, eventId: notification.sourceEventId })
          commit(draft)
          return { disposition: 'duplicate', acknowledgement: ack, receivedAt }
        }
        const receivedAt = instant()
        draft.acknowledgements.push({ ...ack, receivedAt, shopId: trusted.shopId })
        delivery.acknowledgement = { ...ack, receivedAt }
        if (ack.outcome === 'Rejected') delivery.escalation = 'Error'
        else delivery.escalation = 'None'
        draft.metrics.acknowledgementLatencyMs.push(Math.max(0, now() - millis(notification.acceptedAt)))
        audit(draft, 'notification.acknowledge', ack.outcome, trusted, { notificationId: ack.notificationId, revision: ack.revision, shopId: trusted.shopId,
          correlationId: notification.correlationId, eventId: notification.sourceEventId })
        commit(draft)
        return { disposition: 'accepted', acknowledgement: ack, receivedAt }
      })
    },
    tick(actor) {
      return command('service.tick', actor, ['operations', 'producer'], trusted => {
        assert(trusted.role === 'operations' || trusted.id === 'platform-demo' || trusted.sourceSystem === 'platform-demo', 'Only platform may tick', 'FORBIDDEN')
        const draft = clone(state)
        for (const lifecycle of [...draft.lifecycles]) drain(draft, lifecycle.correlationId)
        let escalated = 0
        for (const delivery of draft.deliveries) {
          if (delivery.supersededByRevision !== null || delivery.acknowledgement?.outcome === 'Accepted') continue
          const notification = draft.notifications.find(item => trackingKey(item) === trackingKey(delivery))
          if (terminal(notification.state) && delivery.transportState === 'Delivered') continue
          const age = now() - millis(notification.createdAt)
          const desired = delivery.transportState === 'Failed' || delivery.acknowledgement?.outcome === 'Rejected' || age >= policy.errorMs ? 'Error'
            : age >= policy.warningMs ? 'Warning' : 'None'
          if (desired !== delivery.escalation) {
            delivery.escalation = desired; escalated++
            audit(draft, 'delivery.escalate', desired, trusted, { notificationId: delivery.notificationId, revision: delivery.revision, shopId: delivery.shopId,
              eventId: notification.sourceEventId, correlationId: notification.correlationId })
          }
        }
        commit(draft)
        const attempted = deliverDue()
        return { attempted, escalated }
      })
    },
    setShopConnection(actor, input) {
      return command('channel.update', actor, ['operations'], trusted => {
        object(input, ['shopId', 'connected', 'failNext'], ['shopId', 'connected'])
        assert(typeof input.connected === 'boolean' && (input.failNext === undefined || typeof input.failNext === 'boolean'), 'Invalid channel controls')
        assert(getRecord(state.shopDirectory, input.shopId), 'Unknown shop', 'NOT_FOUND')
        const draft = clone(state)
        setRecord(draft.channels, input.shopId, { connected: input.connected, failNext: input.failNext ?? getRecord(draft.channels, input.shopId).failNext })
        audit(draft, 'channel.update', input.connected ? 'Connected' : 'Disconnected', trusted, { shopId: input.shopId })
        commit(draft)
        if (input.connected) deliverDue(input.shopId, true)
        return { shopId: input.shopId, connected: input.connected }
      })
    },
    retryDelivery(actor, input) {
      return command('delivery.retry', actor, ['operations'], trusted => {
        object(input, ['notificationId']); id(input.notificationId)
        const notification = currentNotifications(state).find(item => item.notificationId === input.notificationId)
        assert(notification, 'Notification not found', 'NOT_FOUND')
        const draft = clone(state), delivery = draft.deliveries.find(item => trackingKey(item) === trackingKey(notification))
        if (delivery.transportState !== 'Delivered') {
          delivery.attemptCount = 0; delivery.transportState = 'Pending'; delivery.nextAttemptAt = instant()
          audit(draft, 'delivery.retry', 'Pending', trusted, { notificationId: delivery.notificationId, revision: delivery.revision, shopId: delivery.shopId,
            eventId: notification.sourceEventId, correlationId: notification.correlationId })
          commit(draft); attemptOne(trackingKey(notification))
        }
        return state.deliveries.find(item => trackingKey(item) === trackingKey(notification))
      })
    },
    retryProcessing(actor, input) {
      return command('source.retry', actor, ['operations'], trusted => {
        object(input, ['correlationId']); id(input.correlationId)
        const draft = clone(state)
        assert(draft.lifecycles.some(item => item.correlationId === input.correlationId), 'Lifecycle not found', 'NOT_FOUND')
        const pendingIds = draft.events.filter(record => record.event.correlationId === input.correlationId && ['processing-error', 'queued-gap'].includes(record.disposition)).map(record => record.event.eventId)
        const refs = drain(draft, input.correlationId)
        audit(draft, 'source.retry', 'Processed', trusted, { correlationId: input.correlationId })
        const results = pendingIds.map(eventId => resultFor(draft, draft.events.find(record => record.event.eventId === eventId), refs))
        commit(draft)
        return results
      }, { deliver: true })
    },
    getSnapshot(actor) {
      try { return { ok: true, value: view(actorFor(actor, ['operations', 'shop'])) } }
      catch (error) { return reject(error, 'snapshot.read', actor) }
    },
    getJob(actor, input) {
      return command('job.read', actor, ['operations', 'shop'], trusted => {
        object(input, ['jobId'])
        const job = state.graph.jobs.find(item => item.id === input.jobId)
        assert(job, 'Job not found', 'NOT_FOUND')
        assert(trusted.role === 'operations' || job.shopId === trusted.shopId, 'Job belongs to another shop', 'FORBIDDEN')
        return job
      }, { allowBoot: true })
    },
    subscribe(actor, listener) {
      try {
        const trusted = actorFor(actor, ['operations', 'shop'])
        assert(typeof listener === 'function', 'Subscription listener must be a function')
        const subscription = { actor: trusted, listener }
        listeners.add(subscription)
        return { ok: true, value: () => listeners.delete(subscription) }
      } catch (error) { return reject(error, 'snapshot.subscribe', actor) }
    },
    resetDemo(actor) {
      return command('workspace.reset', actor, ['operations'], () => {
        const valid = initialGraph ?? validateGraph(graph, policy)
        const draft = empty(valid)
        // Replace the one namespaced snapshot; unrelated storage keys and pickup data are untouched.
        commit(draft); bootError = null; health = null; notify()
        return { reset: true }
      }, { allowBoot: true })
    },
  }
  return service
}

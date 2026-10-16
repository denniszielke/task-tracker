import { errorValue, timestamp } from './contracts.js'
import { createNotificationService } from './service.js'
import { createLocalStorage } from './storage.js'

export const DEMO_ACTORS = Object.freeze({
  operations: Object.freeze({ id: 'operations' }), platform: Object.freeze({ id: 'platform-demo' }),
  shopA: Object.freeze({ id: 'shop-A' }), shopB: Object.freeze({ id: 'shop-B' }),
})

export function createDemoService({ orders = [], now = Date.now, storage = createLocalStorage(), transport, idFactory } = {}) {
  const safeOrders = [], diagnostics = []
  for (const source of orders) {
    try {
      safeOrders.push({ id: source.id, vehicleRef: `vehicle:${source.id}`,
        committedAt: source.inspectionAt == null || source.inspectionAt === '' ? null : timestamp(source.inspectionAt),
        status: source.status, estimatedArrivalAt: null, actualArrivalAt: null })
    } catch (error) { diagnostics.push({ orderId: typeof source.id === 'string' ? source.id : null, ...errorValue(error) }) }
  }
  const graph = { version: 1, shops: [{ id: 'A', name: 'Shop A', timeZone: 'Europe/London' }, { id: 'B', name: 'Shop B', timeZone: 'Europe/Berlin' }],
    orders: safeOrders, jobs: [], edges: [] }
  const first = safeOrders.find(order => order.committedAt !== null)
  if (first) {
    const start = Date.parse(first.committedAt), iso = minutes => new Date(start + minutes * 60000).toISOString()
    graph.jobs = [
      { id: 'demo-job-A', vehicleOrderId: first.id, shopId: 'A', state: 'Scheduled', plannedStartAt: iso(15), durationMinutes: 90, estimatedCompletionAt: null, actualCompletionAt: null },
      { id: 'demo-job-B', vehicleOrderId: first.id, shopId: 'B', state: 'Scheduled', plannedStartAt: iso(120), durationMinutes: 60, estimatedCompletionAt: null, actualCompletionAt: null },
    ]
    graph.edges = [
      { id: 'demo-order-to-A', from: { kind: 'order', id: first.id }, toJobId: 'demo-job-A', requiredReadyAt: iso(15), bufferMinutes: 0 },
      { id: 'demo-A-to-B', from: { kind: 'job', id: 'demo-job-A' }, toJobId: 'demo-job-B', requiredReadyAt: iso(120), bufferMinutes: 0 },
    ]
  }
  const actors = [
    { id: 'operations', role: 'operations' },
    { id: 'platform-demo', role: 'producer', sourceSystem: 'platform-demo', orderIds: safeOrders.map(order => order.id) },
    { id: 'shop-A', role: 'shop', shopId: 'A', sourceSystem: 'shop-demo:A' },
    { id: 'shop-B', role: 'shop', shopId: 'B', sourceSystem: 'shop-demo:B' },
  ]
  const inbox = new Set()
  const localTransport = transport ?? {
    deliver(notification) {
      inbox.add(`${notification.notificationId}:${notification.revision}`)
      return true
    },
  }
  const service = createNotificationService({ graph, actors, clock: { now: () => {
    const value = now()
    return value instanceof Date ? value.getTime() : value
  } }, storage, transport: localTransport, idFactory })
  if (diagnostics.length) {
    const original = service.getSnapshot
    const subscribe = service.subscribe
    const withDiagnostics = snapshot => {
      if (snapshot.role === 'operations') snapshot.operationalErrors.push(...structuredClone(diagnostics))
      return snapshot
    }
    service.getSnapshot = actor => {
      const result = original(actor)
      if (result.ok) result.value = withDiagnostics(result.value)
      return result
    }
    service.subscribe = (actor, listener) => subscribe(actor, snapshot => listener(withDiagnostics(snapshot)))
  }
  return service
}

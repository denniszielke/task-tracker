export const NOW = Date.parse('2026-10-02T12:00:00Z')
export const at = (hour, minute = 0) => `2026-10-02T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`
export const ROOT = { kind: 'order', id: 'N-1001' }
export const ACTORS = [
  { id: 'operations', role: 'operations' },
  { id: 'platform-demo', role: 'producer', sourceSystem: 'platform-demo' },
  { id: 'shop-A', role: 'shop', shopId: 'A', sourceSystem: 'shop-demo:A' },
  { id: 'shop-B', role: 'shop', shopId: 'B', sourceSystem: 'shop-demo:B' },
]

export function job(id, shopId = 'A', fields = {}) {
  return {
    id, vehicleOrderId: 'N-1001', shopId, state: 'Scheduled',
    plannedStartAt: at(12, 15), durationMinutes: 60,
    estimatedCompletionAt: null, actualCompletionAt: null, ...fields,
  }
}

export function edge(id, from, toJobId, requiredReadyAt, bufferMinutes = 0) {
  return { id, from: { ...from }, toJobId, requiredReadyAt, bufferMinutes }
}

export function graph() {
  return {
    version: 1,
    orders: [{
      id: 'N-1001', vehicleRef: 'vehicle-1001', committedAt: at(12),
      status: 'In transit', estimatedArrivalAt: at(12), actualArrivalAt: null,
    }],
    shops: [
      { id: 'A', name: 'Shop A', timeZone: 'Europe/London' },
      { id: 'B', name: 'Shop B', timeZone: 'Europe/Berlin' },
    ],
    jobs: [
      job('J-2001'),
      job('J-2002', 'B', { plannedStartAt: at(14) }),
    ],
    edges: [
      edge('order-to-A', ROOT, 'J-2001', at(12, 15)),
      edge('A-to-B', { kind: 'job', id: 'J-2001' }, 'J-2002', at(14)),
    ],
  }
}

export function sourceEvent(fields = {}) {
  return {
    schemaVersion: 1, eventId: 'event-1', type: 'vehicle.eta-revised',
    sourceSystem: 'platform-demo', occurredAt: at(12), vehicleOrderId: 'N-1001',
    vehicleRef: 'vehicle-1001', correlationId: 'delay-N-1001', causationId: null,
    sequence: 1, root: { ...ROOT }, previousCommittedAt: at(12),
    latestEstimatedAt: at(13, 30), actualAt: null, reasonCode: 'TRAFFIC',
    ...fields,
  }
}

export function acknowledgement(notificationId = 'notification-A', fields = {}) {
  return {
    schemaVersion: 1, acknowledgementId: 'ack-1', notificationId, revision: 1,
    acknowledgedAt: at(12, 1), outcome: 'Accepted', ...fields,
  }
}

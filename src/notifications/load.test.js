import { describe, expect, it } from 'vitest'
import { at, edge, graph, job, ROOT, sourceEvent } from './__fixtures__/scenario.js'
import { harness, PLATFORM, value } from './__fixtures__/service.js'

describe('bounded deterministic local workload (not production SLO verification)', () => {
  it('serializes 100 accepted source revisions through 200 jobs and 20 independent shop channels', () => {
    const input = graph()
    input.shops = Array.from({ length: 20 }, (_, index) => ({
      id: `shop-${index}`, name: `Shop ${index}`, timeZone: 'UTC',
    }))
    input.jobs = Array.from({ length: 200 }, (_, index) => job(`job-${String(index).padStart(3, '0')}`, `shop-${index % 20}`))
    input.edges = input.jobs.map((j, index) => edge(`edge-${index}`, ROOT, j.id, at(12, 15)))
    const h = harness({ graph: input })
    for (let sequence = 1; sequence <= 100; sequence++) {
      const result = value(h.service.receive(PLATFORM, sourceEvent({
        eventId: `load-${sequence}`, sequence,
      })))
      expect(result.disposition).toBe('applied')
    }
    const snapshot = h.snapshot()
    expect(snapshot.events).toHaveLength(100)
    expect(snapshot.lifecycles[0].lastAppliedSequence).toBe(100)
    expect(snapshot.notifications.current).toHaveLength(20)
    expect(snapshot.notifications.current.reduce((count, n) => count + n.affectedJobs.length, 0)).toBe(200)
    expect(snapshot.notifications.current.every((n) => n.affectedJobs.length === 10)).toBe(true)
    expect(snapshot.deliveries.every((d) => d.transportState === 'Delivered')).toBe(true)
    expect(h.deliver).toHaveBeenCalledTimes(20)
    expect(snapshot.metrics.accepted).toBe(100)
    expect(snapshot.metrics.deliveryLatencyMs.every((latency) => latency === 0)).toBe(true)
  }, 30_000)
})

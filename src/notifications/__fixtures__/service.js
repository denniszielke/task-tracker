import { vi } from 'vitest'
import { createNotificationService } from '../service.js'
import { createMemoryStorage } from '../storage.js'
import { ACTORS, graph, NOW } from './scenario.js'

export const OPS = { id: 'operations' }
export const PLATFORM = { id: 'platform-demo' }
export const SHOP_A = { id: 'shop-A' }
export const SHOP_B = { id: 'shop-B' }

export function value(result) {
  if (!result?.ok) throw new Error(`Expected success, received ${JSON.stringify(result)}`)
  return result.value
}

export function harness(options = {}) {
  let time = NOW, sequence = 0
  const storage = options.storage ?? createMemoryStorage()
  const deliver = options.deliver ?? vi.fn(() => true)
  const clock = { now: () => time }
  const config = {
    graph: options.graph ?? graph(), actors: ACTORS, clock,
    idFactory: () => `generated-${++sequence}`, storage, transport: { deliver },
    ...options,
  }
  delete config.deliver
  const service = createNotificationService(config)
  return {
    service, storage, deliver, clock,
    setTime: (instant) => { time = instant },
    advance: (duration) => { time += duration },
    snapshot: (actor = OPS) => value(service.getSnapshot(actor)),
    reload: () => createNotificationService(config),
  }
}

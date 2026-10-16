import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createDemoService, DEMO_ACTORS } from './demo'
import { createMemoryStorage } from './storage'
import orders from '../data/orders.json'

function createViewerStore(service, actor) {
  let snapshot = service.getSnapshot(actor)
  const listeners = new Set()
  const update = (result) => {
    snapshot = result
    listeners.forEach((listener) => listener())
  }
  return {
    getSnapshot: () => snapshot,
    refresh: () => {
      const result = service.getSnapshot(actor)
      update(result)
      return result
    },
    subscribe: (listener) => {
      listeners.add(listener)
      const subscription = service.subscribe(actor, (value) => update({ ok: true, value }))
      update(subscription.ok ? service.getSnapshot(actor) : subscription)
      return () => {
        listeners.delete(listener)
        if (subscription.ok) subscription.value()
      }
    },
  }
}

export function useViewerSnapshot(service, actor) {
  const store = useMemo(() => createViewerStore(service, actor), [service, actor])
  const result = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return [result, store.refresh]
}

export function useNotificationService({ notificationService, now, currentInstant }) {
  const [localService, setLocalService] = useState(() => (
    notificationService ?? createDemoService({ orders, now })
  ))
  const [volatileSelected, setVolatileSelected] = useState(false)
  const service = volatileSelected ? localService : notificationService ?? localService
  const [snapshot] = useViewerSnapshot(service, DEMO_ACTORS.operations)

  useEffect(() => {
    service.reconcilePlatform(DEMO_ACTORS.platform, {
      orders: orders.map(({ id, status, inspectionAt }) => ({ id, status, inspectionAt })),
    })
    service.tick(DEMO_ACTORS.platform)
  }, [service, currentInstant])

  const useVolatile = () => {
    setLocalService(createDemoService({ orders, now, storage: createMemoryStorage() }))
    setVolatileSelected(true)
  }

  return { service, snapshot, useVolatile }
}

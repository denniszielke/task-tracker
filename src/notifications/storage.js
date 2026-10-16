import { clone, DEFAULT_POLICY, fail } from './contracts.js'

export const STORAGE_KEY = 'pickup-orders.late-notifications.v1'

export function createMemoryStorage(initialSnapshot = null) {
  let value = initialSnapshot === null ? null : clone(initialSnapshot)
  return {
    persistenceState: 'volatile',
    load: () => value === null ? null : clone(value),
    save: snapshot => { value = clone(snapshot) },
    clear: () => { value = null },
  }
}

export function snapshotBytes(snapshot) {
  return new TextEncoder().encode(JSON.stringify(snapshot)).length
}

export function createLocalStorage({ key = STORAGE_KEY, storage } = {}) {
  const backend = () => {
    try {
      const target = storage ?? globalThis.localStorage
      if (!target) fail('STORAGE_UNAVAILABLE', 'Browser storage is unavailable')
      return target
    } catch (error) {
      if (error.code === 'STORAGE_UNAVAILABLE') throw error
      fail('STORAGE_UNAVAILABLE', 'Browser storage is unavailable')
    }
  }
  return {
    persistenceState: 'local',
    load() {
      let raw
      try { raw = backend().getItem(key) } catch { fail('STORAGE_UNAVAILABLE', 'Unable to read notification workspace') }
      if (raw === null) return null
      try { return JSON.parse(raw) } catch { fail('STORAGE_CORRUPT', 'Notification workspace is corrupt; reset explicitly or choose a volatile session') }
    },
    save(snapshot) {
      if (snapshotBytes(snapshot) > DEFAULT_POLICY.maxSnapshotBytes) fail('STORAGE_FULL', 'Notification workspace size limit reached')
      try { backend().setItem(key, JSON.stringify(snapshot)) } catch (error) {
        fail(error?.name === 'QuotaExceededError' || error?.code === 22 ? 'STORAGE_FULL' : 'STORAGE_UNAVAILABLE', 'Unable to persist notification workspace')
      }
    },
    clear() {
      try { backend().removeItem(key) } catch { fail('STORAGE_UNAVAILABLE', 'Unable to reset notification workspace') }
    },
  }
}

import { describe, expect, it, vi } from 'vitest'
import { createLocalStorage, createMemoryStorage, snapshotBytes, STORAGE_KEY } from './storage.js'

describe('explicit local/memory storage adapters', () => {
  it('clones all memory reads, writes, and initial state', () => {
    const original = { version: 1, nested: { value: 1 } }
    const storage = createMemoryStorage(original)
    original.nested.value = 2
    expect(storage.load().nested.value).toBe(1)
    const loaded = storage.load()
    loaded.nested.value = 3
    expect(storage.load().nested.value).toBe(1)
    storage.save(loaded)
    loaded.nested.value = 4
    expect(storage.load().nested.value).toBe(3)
    expect(storage.persistenceState).toBe('volatile')
    storage.clear()
    expect(storage.load()).toBeNull()
  })

  it('writes only its own namespaced key and requires explicit reset', () => {
    const values = new Map([['unrelated', 'keep']])
    const adapter = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    }
    const storage = createLocalStorage({ storage: adapter })
    expect(storage.load()).toBeNull()
    storage.save({ schemaVersion: 1, text: 'saved' })
    expect(values.get(STORAGE_KEY)).toBe(JSON.stringify({ schemaVersion: 1, text: 'saved' }))
    expect(storage.load()).toEqual({ schemaVersion: 1, text: 'saved' })
    storage.clear()
    expect(values.get('unrelated')).toBe('keep')
    expect(storage.load()).toBeNull()
    expect(storage.persistenceState).toBe('local')
  })

  it('preserves corrupt serialized data and reports corruption without fallback', () => {
    const removeItem = vi.fn(), setItem = vi.fn()
    const storage = createLocalStorage({ storage: { getItem: () => '{invalid', removeItem, setItem } })
    expect(() => storage.load()).toThrow(expect.objectContaining({ code: 'STORAGE_CORRUPT' }))
    expect(removeItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
  })

  it.each(['load', 'save', 'clear'])('surfaces unavailable storage during %s', (method) => {
    const inaccessible = () => { throw new Error('Access denied') }
    const storage = createLocalStorage({ storage: { getItem: inaccessible, setItem: inaccessible, removeItem: inaccessible } })
    expect(() => storage[method]({})).toThrow(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }))
  })

  it('surfaces quota errors and counts UTF-8 bytes before writing', () => {
    const setItem = vi.fn(() => { throw Object.assign(new Error('Quota'), { name: 'QuotaExceededError' }) })
    const storage = createLocalStorage({ storage: { setItem } })
    expect(() => storage.save({ small: true })).toThrow(expect.objectContaining({ code: 'STORAGE_FULL' }))
    expect(snapshotBytes({ text: '🚙' })).toBe(new TextEncoder().encode('{"text":"🚙"}').length)
    setItem.mockClear()
    expect(() => storage.save({ text: '🚙'.repeat(500_000) }))
      .toThrow(expect.objectContaining({ code: 'STORAGE_FULL' }))
    expect(setItem).not.toHaveBeenCalled()
  })
})

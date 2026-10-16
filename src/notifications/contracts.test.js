import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, timestamp, validateAcknowledgement, validateSourceEvent } from './contracts.js'
import { acknowledgement, at, sourceEvent } from './__fixtures__/scenario.js'

describe('version 1 source-event schemas', () => {
  it.each(EVENT_TYPES)('accepts canonical %s without mutating input', (type) => {
    const fields = { type }
    if (type === 'vehicle.delivered') fields.actualAt = at(13, 30)
    if (type === 'vehicle.cancelled') fields.latestEstimatedAt = null
    if (type === 'repair-job.completion-revised') {
      fields.root = { kind: 'job', id: 'J-2001' }
      fields.rootState = 'In progress'
    }
    const event = sourceEvent(fields)
    const before = structuredClone(event)
    expect(validateSourceEvent(event)).toEqual(event)
    expect(event).toEqual(before)
  })

  it.each([
    ['unknown version', { schemaVersion: 2 }],
    ['unknown property', { ownerEmail: 'forbidden@example.invalid' }],
    ['unknown type', { type: 'vehicle.guessed-late' }],
    ['zero sequence', { sequence: 0 }],
    ['fractional sequence', { sequence: 1.5 }],
    ['missing identity', { eventId: '' }],
    ['wrong root', { root: { kind: 'order', id: 'N-other' } }],
    ['missing estimate', { latestEstimatedAt: null }],
    ['oversized context', { context: 'x'.repeat(501) }],
    ['missing delivered actual', { type: 'vehicle.delivered', actualAt: null }],
    ['wrong job root', { type: 'repair-job.completion-revised', rootState: 'Scheduled' }],
    ['unknown terminal alias', { type: 'repair-job.completion-revised', root: { kind: 'job', id: 'J-2001' }, rootState: 'Done' }],
    ['completed without actual', { type: 'repair-job.completion-revised', root: { kind: 'job', id: 'J-2001' }, rootState: 'Completed' }],
  ])('rejects %s', (_name, fields) => {
    expect(() => validateSourceEvent(sourceEvent(fields))).toThrow()
  })

  it.each(Object.keys(sourceEvent()))('rejects an absent required %s', (field) => {
    const event = sourceEvent()
    delete event[field]
    expect(() => validateSourceEvent(event)).toThrow()
  })
})

describe('absolute timestamp contract', () => {
  it.each([
    '2026-10-02', '2026-10-02T12:00:00', '2026-02-30T12:00:00Z',
    '2026-13-01T00:00:00Z', '2026-10-02T24:00:00Z', '2026-10-02T12:60:00Z',
    '2026-10-02T12:00:60Z', '2026-10-02T12:00:00+24:00', '', null, 1790942400000,
  ])('rejects malformed/ambiguous instant %s', (value) => {
    expect(() => timestamp(value)).toThrow()
    expect(() => validateSourceEvent(sourceEvent({ occurredAt: value }))).toThrow()
  })

  it('normalizes equivalent instants and accepts leap-day timestamps', () => {
    expect(timestamp('2026-10-02T14:00:00+02:00')).toBe(at(12))
    expect(timestamp('2024-02-29T12:00:00Z')).toBe('2024-02-29T12:00:00.000Z')
    expect(timestamp(null, true)).toBeNull()
  })
})

describe('version 1 acknowledgement schema', () => {
  it.each(['Accepted', 'Rejected'])('accepts %s, keeping optional context', (outcome) => {
    const ack = acknowledgement('notification-A', { outcome, reasonCode: 'STAFFED', comment: 'Processed' })
    expect(validateAcknowledgement(ack)).toEqual(ack)
  })

  it.each([
    { schemaVersion: 0 }, { acknowledgementId: '' }, { notificationId: '' },
    { revision: 0 }, { revision: 1.5 }, { outcome: 'Read' },
    { acknowledgedAt: '2026-10-02T12:00:00' }, { comment: 'x'.repeat(501) },
    { proposedStartAt: at(15) },
  ])('rejects invalid/unsupported acknowledgement %j', (fields) => {
    expect(() => validateAcknowledgement(acknowledgement('notification-A', fields))).toThrow()
  })

  it.each(['schemaVersion', 'acknowledgementId', 'notificationId', 'revision', 'acknowledgedAt', 'outcome'])(
    'requires %s', (field) => {
      const ack = acknowledgement()
      delete ack[field]
      expect(() => validateAcknowledgement(ack)).toThrow()
    },
  )
})

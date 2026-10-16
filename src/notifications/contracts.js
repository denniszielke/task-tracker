export const SCHEMA_VERSION = 1
export const EVENT_TYPES = ['vehicle.late', 'vehicle.eta-revised', 'vehicle.delivered', 'vehicle.delay-corrected', 'vehicle.cancelled', 'repair-job.completion-revised']
export const JOB_STATES = ['Scheduled', 'In progress', 'Completed', 'Cancelled']
export const DEFAULT_POLICY = Object.freeze({
  maxOrders: 100, maxJobs: 200, maxEdges: 500, maxShops: 20, maxDepth: 32,
  maxQueuedEvents: 100, maxSnapshotBytes: 2000000, maxAuditRecords: 10000,
  retryDelaysMs: [1000, 5000, 30000, 120000], warningMs: 300000, errorMs: 900000,
})

export function fail(code, message, details) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  throw error
}

export function assert(condition, message, code = 'VALIDATION_ERROR') {
  if (!condition) fail(code, message)
}

export function object(value, keys, required = keys) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object')
  assert(Object.keys(value).every(key => keys.includes(key)), 'Unknown schema property')
  assert(required.every(key => Object.hasOwn(value, key)), 'Missing required schema property')
  return value
}

export function id(value, name = 'ID', max = 128) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${name}`)
  return value
}

export function timestamp(value, nullable = false) {
  if (value === null && nullable) return null
  assert(typeof value === 'string', 'Timestamp must be RFC3339 with an explicit offset')
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  assert(match, 'Timestamp must be RFC3339 with an explicit offset')
  const [, year, month, day, hour, minute, second, , zone, , offsetHour, offsetMinute] = match
  const y = Number(year), m = Number(month), d = Number(day)
  const calendar = new Date(0)
  calendar.setUTCFullYear(y, m - 1, d)
  assert(m >= 1 && m <= 12 && d >= 1 && calendar.getUTCMonth() === m - 1 && calendar.getUTCDate() === d
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && (zone === 'Z' || (Number(offsetHour) < 24 && Number(offsetMinute) < 60)), 'Impossible timestamp')
  const epoch = Date.parse(value)
  assert(Number.isFinite(epoch), 'Invalid timestamp')
  return new Date(epoch).toISOString()
}

export function duration(value, positive = false) {
  assert(typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0), 'Invalid duration')
  return value
}

export function positiveInteger(value) {
  assert(Number.isSafeInteger(value) && value > 0, 'Expected positive integer')
  return value
}

export function nodeRef(value) {
  object(value, ['kind', 'id'])
  assert(value.kind === 'order' || value.kind === 'job', 'Invalid root kind')
  return { kind: value.kind, id: id(value.id) }
}

export function validateSourceEvent(input) {
  object(input, ['schemaVersion', 'eventId', 'type', 'sourceSystem', 'occurredAt', 'vehicleOrderId', 'vehicleRef',
    'correlationId', 'causationId', 'sequence', 'root', 'previousCommittedAt', 'latestEstimatedAt', 'actualAt',
    'reasonCode', 'context', 'estimateBasis', 'rootState'],
  ['schemaVersion', 'eventId', 'type', 'sourceSystem', 'occurredAt', 'vehicleOrderId', 'vehicleRef',
    'correlationId', 'causationId', 'sequence', 'root', 'previousCommittedAt', 'latestEstimatedAt', 'actualAt', 'reasonCode'])
  assert(input.schemaVersion === 1, 'Unsupported source schema', 'UNSUPPORTED_SCHEMA')
  assert(EVENT_TYPES.includes(input.type), 'Unsupported event type')
  const event = { ...input, root: nodeRef(input.root) }
  for (const field of ['eventId', 'sourceSystem', 'vehicleOrderId', 'vehicleRef', 'correlationId']) id(event[field], field)
  if (event.causationId !== null) id(event.causationId)
  id(event.reasonCode, 'reasonCode', 64)
  positiveInteger(event.sequence)
  event.occurredAt = timestamp(event.occurredAt)
  for (const field of ['previousCommittedAt', 'latestEstimatedAt', 'actualAt']) event[field] = timestamp(event[field], true)
  if (event.context !== undefined) assert(typeof event.context === 'string' && event.context.length <= 500, 'Invalid context')
  if (event.estimateBasis !== undefined) assert(['reported', 'observed-lower-bound'].includes(event.estimateBasis), 'Invalid estimate basis')
  if (event.rootState !== undefined) assert(JOB_STATES.includes(event.rootState), 'Invalid root state')
  if (event.type === 'repair-job.completion-revised') {
    assert(event.root.kind === 'job' && JOB_STATES.includes(event.rootState), 'Completion requires a job root and rootState')
    if (event.rootState === 'Completed') assert(event.actualAt !== null, 'Completed requires actualAt')
    else if (event.rootState !== 'Cancelled') assert(event.latestEstimatedAt !== null, 'Completion revision requires estimate')
  } else {
    assert(event.root.kind === 'order' && event.root.id === event.vehicleOrderId, 'Vehicle event requires its order root')
    if (event.type === 'vehicle.delivered') assert(event.actualAt !== null, 'Delivered requires actualAt')
    else if (event.type !== 'vehicle.cancelled') assert(event.latestEstimatedAt !== null, 'Event requires estimate')
  }
  return event
}

export function validateAcknowledgement(input) {
  object(input, ['schemaVersion', 'acknowledgementId', 'notificationId', 'revision', 'acknowledgedAt', 'outcome', 'reasonCode', 'comment'],
    ['schemaVersion', 'acknowledgementId', 'notificationId', 'revision', 'acknowledgedAt', 'outcome'])
  assert(input.schemaVersion === 1, 'Unsupported acknowledgement schema', 'UNSUPPORTED_SCHEMA')
  id(input.acknowledgementId)
  id(input.notificationId)
  positiveInteger(input.revision)
  assert(['Accepted', 'Rejected'].includes(input.outcome), 'Invalid acknowledgement outcome')
  if (input.reasonCode !== undefined) id(input.reasonCode, 'reasonCode', 64)
  if (input.comment !== undefined) assert(typeof input.comment === 'string' && input.comment.length <= 500, 'Invalid comment')
  return { ...input, acknowledgedAt: timestamp(input.acknowledgedAt) }
}

export function validateNotification(input) {
  object(input, ['schemaVersion', 'notificationId', 'revision', 'sourceEventId', 'correlationId', 'vehicleOrderId',
    'vehicleRef', 'shopId', 'state', 'previousCommittedAt', 'latestEstimatedAt', 'delayMs', 'estimateBasis',
    'createdAt', 'acceptedAt', 'graphVersion', 'affectedJobs', 'changes', 'acknowledgementInstructions'])
  assert(input.schemaVersion === 1, 'Unsupported notification schema', 'UNSUPPORTED_SCHEMA')
  const value = clone(input)
  for (const field of ['notificationId', 'sourceEventId', 'correlationId', 'vehicleOrderId', 'vehicleRef', 'shopId']) id(value[field])
  positiveInteger(value.revision); positiveInteger(value.graphVersion)
  assert(['New', 'Revised', 'Resolved', 'Cancelled'].includes(value.state), 'Invalid notification state')
  assert(['reported', 'observed-lower-bound'].includes(value.estimateBasis), 'Invalid estimate basis')
  for (const field of ['previousCommittedAt', 'latestEstimatedAt']) value[field] = timestamp(value[field], true)
  value.createdAt = timestamp(value.createdAt); value.acceptedAt = timestamp(value.acceptedAt)
  if (value.delayMs !== null) duration(value.delayMs)
  assert(Array.isArray(value.affectedJobs), 'Invalid affected jobs')
  for (const job of value.affectedJobs) {
    object(job, ['jobId', 'plannedStartAt', 'projectedStartAt', 'projectedCompletionAt', 'latenessMs', 'reasons'])
    id(job.jobId); duration(job.latenessMs)
    for (const field of ['plannedStartAt', 'projectedStartAt', 'projectedCompletionAt']) job[field] = timestamp(job[field])
    assert(Array.isArray(job.reasons), 'Invalid dependency reasons')
    for (const reason of job.reasons) {
      object(reason, ['code', 'requiredReadyAt', 'bufferMinutes', 'prerequisiteReadyAt', 'path'])
      assert(['READY_AFTER_REQUIRED', 'BUFFER_SHORTFALL', 'PREREQUISITE_CANCELLED'].includes(reason.code), 'Invalid impact reason')
      reason.requiredReadyAt = timestamp(reason.requiredReadyAt)
      reason.prerequisiteReadyAt = timestamp(reason.prerequisiteReadyAt, true)
      duration(reason.bufferMinutes)
      assert(Array.isArray(reason.path), 'Invalid dependency path')
      for (const node of reason.path) {
        if (node.kind === 'external-prerequisite') object(node, ['kind'])
        else nodeRef(node)
      }
    }
  }
  object(value.changes, ['addedJobIds', 'removedJobIds', 'updatedJobIds', 'previousEstimatedAt'])
  for (const field of ['addedJobIds', 'removedJobIds', 'updatedJobIds']) {
    assert(Array.isArray(value.changes[field]), 'Invalid changed jobs')
    value.changes[field].forEach(jobId => id(jobId))
  }
  value.changes.previousEstimatedAt = timestamp(value.changes.previousEstimatedAt, true)
  object(value.acknowledgementInstructions, ['operation', 'notificationId', 'revision'])
  assert(value.acknowledgementInstructions.operation === 'acknowledge'
    && value.acknowledgementInstructions.notificationId === value.notificationId
    && value.acknowledgementInstructions.revision === value.revision, 'Invalid acknowledgement instructions')
  return value
}

export function clone(value) { return structuredClone(value) }
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export function errorValue(error) {
  return { code: error?.code || 'INTERNAL_ERROR', message: error?.code ? error.message : 'Unexpected notification engine failure',
    ...(error?.details === undefined ? {} : { details: error.details }) }
}

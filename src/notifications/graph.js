import { assert, clone, DEFAULT_POLICY, duration, fail, id, JOB_STATES, nodeRef, object, positiveInteger, timestamp } from './contracts.js'

const ms = value => value === null || value === undefined ? null : Date.parse(value)
const iso = value => new Date(value).toISOString()
const key = node => `${node.kind}:${node.id}`

export function validateGraph(input, policy = {}) {
  const limits = { ...DEFAULT_POLICY, ...policy }
  object(input, ['version', 'orders', 'shops', 'jobs', 'edges'])
  positiveInteger(input.version)
  for (const [field, maximum] of [['orders', limits.maxOrders], ['shops', limits.maxShops], ['jobs', limits.maxJobs], ['edges', limits.maxEdges]]) {
    assert(Array.isArray(input[field]), `Invalid graph ${field}`)
    assert(input[field].length <= maximum, `Graph ${field} limit exceeded`, 'LIMIT_EXCEEDED')
    assert(new Set(input[field].map(item => item.id)).size === input[field].length, `Duplicate ${field} ID`)
  }
  const graph = clone(input)
  for (const shop of graph.shops) {
    object(shop, ['id', 'name', 'timeZone'])
    id(shop.id); id(shop.name, 'shop name')
    try { new Intl.DateTimeFormat('en', { timeZone: shop.timeZone }).format(0) } catch { fail('VALIDATION_ERROR', 'Invalid shop time zone') }
    assert(typeof shop.timeZone === 'string' && shop.timeZone.length > 0, 'Invalid shop time zone')
  }
  for (const order of graph.orders) {
    object(order, ['id', 'vehicleRef', 'committedAt', 'status', 'estimatedArrivalAt', 'actualArrivalAt'])
    id(order.id); id(order.vehicleRef); id(order.status)
    for (const field of ['committedAt', 'estimatedArrivalAt', 'actualArrivalAt']) order[field] = timestamp(order[field], true)
  }
  const orders = new Map(graph.orders.map(order => [order.id, order]))
  const shops = new Set(graph.shops.map(shop => shop.id))
  for (const job of graph.jobs) {
    object(job, ['id', 'vehicleOrderId', 'shopId', 'state', 'plannedStartAt', 'durationMinutes', 'estimatedCompletionAt', 'actualCompletionAt'])
    id(job.id); id(job.vehicleOrderId); id(job.shopId)
    assert(orders.has(job.vehicleOrderId) && shops.has(job.shopId), 'Missing job order/shop', 'MISSING_DEPENDENCY')
    assert(JOB_STATES.includes(job.state), 'Invalid job state')
    job.plannedStartAt = timestamp(job.plannedStartAt)
    duration(job.durationMinutes, true)
    job.estimatedCompletionAt = timestamp(job.estimatedCompletionAt, true)
    job.actualCompletionAt = timestamp(job.actualCompletionAt, true)
    assert(job.state !== 'Completed' || job.actualCompletionAt !== null, 'Completed job requires actual completion')
    assert(job.estimatedCompletionAt === null || ms(job.estimatedCompletionAt) >= ms(job.plannedStartAt) + job.durationMinutes * 60000, 'Estimate precedes planned finish')
  }
  const jobs = new Map(graph.jobs.map(job => [job.id, job]))
  const prerequisites = new Set()
  for (const edge of graph.edges) {
    object(edge, ['id', 'from', 'toJobId', 'requiredReadyAt', 'bufferMinutes'], ['id', 'from', 'toJobId', 'requiredReadyAt'])
    id(edge.id); id(edge.toJobId); edge.from = nodeRef(edge.from)
    const from = (edge.from.kind === 'order' ? orders : jobs).get(edge.from.id)
    const to = jobs.get(edge.toJobId)
    assert(from && to, 'Dangling dependency', 'MISSING_DEPENDENCY')
    assert((edge.from.kind === 'order' ? from.id : from.vehicleOrderId) === to.vehicleOrderId, 'Cross-order dependency is unsupported')
    const pair = `${key(edge.from)}>${edge.toJobId}`
    assert(!prerequisites.has(pair), 'Duplicate prerequisite edge')
    prerequisites.add(pair)
    edge.requiredReadyAt = timestamp(edge.requiredReadyAt)
    if (edge.bufferMinutes !== undefined && edge.bufferMinutes !== null) duration(edge.bufferMinutes)
  }
  topological(graph, limits)
  return graph
}

function topological(graph, limits = DEFAULT_POLICY) {
  const indegree = new Map(graph.jobs.map(job => [job.id, 0]))
  const outgoing = new Map(graph.jobs.map(job => [job.id, []]))
  const depths = new Map(graph.jobs.map(job => [job.id, 1]))
  for (const edge of graph.edges) {
    if (edge.from.kind === 'job') {
      indegree.set(edge.toJobId, indegree.get(edge.toJobId) + 1)
      outgoing.get(edge.from.id).push(edge.toJobId)
    }
  }
  const queue = [...indegree.keys()].filter(job => indegree.get(job) === 0).sort()
  const sorted = []
  while (queue.length) {
    const job = queue.shift()
    sorted.push(job)
    for (const dependent of outgoing.get(job).sort()) {
      depths.set(dependent, Math.max(depths.get(dependent), depths.get(job) + 1))
      indegree.set(dependent, indegree.get(dependent) - 1)
      if (indegree.get(dependent) === 0) { queue.push(dependent); queue.sort() }
    }
  }
  assert(sorted.length === graph.jobs.length, 'Dependency graph contains a cycle', 'GRAPH_CYCLE')
  assert(Math.max(0, ...depths.values()) <= limits.maxDepth, 'Dependency depth limit exceeded', 'LIMIT_EXCEEDED')
  return sorted
}

export function calculateImpacts({ graph: input, root: rootInput, latestEstimatedAt, actualAt = null, rootState }) {
  const graph = validateGraph(input)
  const root = nodeRef(rootInput)
  const orders = new Map(graph.orders.map(order => [order.id, order]))
  const jobs = new Map(graph.jobs.map(job => [job.id, job]))
  assert((root.kind === 'order' ? orders : jobs).has(root.id), 'Missing lifecycle root', 'MISSING_DEPENDENCY')
  if (latestEstimatedAt != null) latestEstimatedAt = timestamp(latestEstimatedAt)
  if (actualAt != null) actualAt = timestamp(actualAt)
  const ready = new Map(), reachable = new Set([key(root)]), blocked = new Set(), paths = new Map([[key(root), [root]]])
  const diagnostics = [], impacts = [], cancelledJobIds = [], cancelledImpacts = [], predecessorRefs = Object.create(null)
  for (const order of graph.orders) {
    const orderKey = `order:${order.id}`
    const value = root.kind === 'order' && root.id === order.id
      ? actualAt ?? latestEstimatedAt ?? order.actualArrivalAt ?? order.estimatedArrivalAt ?? order.committedAt
      : order.actualArrivalAt ?? order.estimatedArrivalAt ?? order.committedAt
    ready.set(orderKey, ms(value))
    if (order.status === 'Cancelled' || (orderKey === key(root) && rootState === 'Cancelled')) blocked.add(orderKey)
  }
  const incoming = new Map(graph.jobs.map(job => [job.id, graph.edges.filter(edge => edge.toJobId === job.id).sort((a, b) => a.id.localeCompare(b.id))]))
  for (const jobId of topological(graph)) {
    const job = jobs.get(jobId), jobKey = `job:${jobId}`
    const edges = incoming.get(jobId)
    const contributing = edges.filter(edge => reachable.has(key(edge.from)))
    if (contributing.length) {
      reachable.add(jobKey)
      paths.set(jobKey, [...paths.get(key(contributing[0].from)), { kind: 'job', id: jobId }])
      predecessorRefs[jobId] = contributing.map(edge => ({ edgeId: edge.id, from: edge.from }))
    }
    const state = jobKey === key(root) ? rootState ?? job.state : job.state
    if (state === 'Completed') {
      ready.set(jobKey, ms(jobKey === key(root) ? actualAt ?? job.actualCompletionAt : job.actualCompletionAt))
      continue
    }
    if (state === 'Cancelled') { blocked.add(jobKey); ready.set(jobKey, null); continue }
    if (edges.some(edge => blocked.has(key(edge.from)))) {
      blocked.add(jobKey); ready.set(jobKey, null)
      if (reachable.has(jobKey)) {
        cancelledJobIds.push(jobId)
        cancelledImpacts.push({
          jobId, shopId: job.shopId, plannedStartAt: job.plannedStartAt, projectedStartAt: job.plannedStartAt,
          projectedCompletionAt: iso(ms(job.plannedStartAt) + job.durationMinutes * 60000), latenessMs: 0,
          reasons: edges.filter(edge => blocked.has(key(edge.from))).map(edge => ({
            code: 'PREREQUISITE_CANCELLED', requiredReadyAt: edge.requiredReadyAt, bufferMinutes: edge.bufferMinutes ?? 5,
            prerequisiteReadyAt: null, path: [...(paths.get(key(edge.from)) ?? [edge.from]), { kind: 'job', id: jobId }],
          })),
        })
      }
      continue
    }
    let start = ms(job.plannedStartAt)
    const reasons = []
    for (const edge of edges) {
      const prerequisiteReady = ready.get(key(edge.from))
      if (prerequisiteReady == null) {
        if (reachable.has(jobKey)) diagnostics.push({ code: 'MISSING_READINESS', jobId, edgeId: edge.id })
        continue
      }
      const bufferMinutes = edge.bufferMinutes ?? 5
      const buffered = prerequisiteReady + bufferMinutes * 60000
      start = Math.max(start, buffered)
      if (reachable.has(key(edge.from)) && buffered > ms(edge.requiredReadyAt)) {
        reasons.push({
          code: prerequisiteReady > ms(edge.requiredReadyAt) ? 'READY_AFTER_REQUIRED' : 'BUFFER_SHORTFALL',
          requiredReadyAt: edge.requiredReadyAt, bufferMinutes, prerequisiteReadyAt: iso(prerequisiteReady),
          path: [...paths.get(key(edge.from)), { kind: 'job', id: jobId }],
        })
      }
    }
    let finish = Math.max(ms(job.estimatedCompletionAt) ?? 0, start + job.durationMinutes * 60000)
    if (jobKey === key(root)) finish = Math.max(finish, ms(latestEstimatedAt) ?? 0)
    ready.set(jobKey, finish)
    if (reasons.length) impacts.push({
      jobId, shopId: job.shopId, plannedStartAt: job.plannedStartAt, projectedStartAt: iso(start),
      projectedCompletionAt: iso(finish), latenessMs: Math.max(0, start - ms(job.plannedStartAt)), reasons,
    })
  }
  return { impacts: impacts.sort((a, b) => a.jobId.localeCompare(b.jobId)), diagnostics, cancelledJobIds: cancelledJobIds.sort(), predecessorRefs,
    cancelledImpacts: cancelledImpacts.sort((a, b) => a.jobId.localeCompare(b.jobId)) }
}

import { describe, expect, it } from 'vitest'
import { calculateImpacts, validateGraph } from './graph.js'
import { at, edge, graph, job, ROOT } from './__fixtures__/scenario.js'

const calculate = (input = graph(), fields = {}) => calculateImpacts({
  graph: input, root: ROOT, latestEstimatedAt: at(13, 30), ...fields,
})

describe('current dependency graph impact calculation', () => {
  it('reproduces the exact PRD N-1001 -> J-2001/A -> J-2002/B scenario', () => {
    const input = graph(), before = structuredClone(input)
    const result = calculate(input)
    expect(result.impacts.map(({ jobId, shopId }) => [jobId, shopId]))
      .toEqual([['J-2001', 'A'], ['J-2002', 'B']])
    expect(result.impacts[0]).toMatchObject({
      plannedStartAt: at(12, 15), projectedStartAt: at(13, 30), projectedCompletionAt: at(14, 30),
    })
    expect(result.impacts[1]).toMatchObject({ projectedStartAt: at(14, 30), projectedCompletionAt: at(15, 30) })
    expect(result.impacts[1].reasons[0].path).toEqual([ROOT, { kind: 'job', id: 'J-2001' }, { kind: 'job', id: 'J-2002' }])
    expect(result.diagnostics).toEqual([])
    expect(input).toEqual(before)
  })

  it('absorbs direct slack but still propagates projected completion downstream', () => {
    const input = graph()
    input.edges[0].requiredReadyAt = at(14)
    input.edges[1].requiredReadyAt = at(14)
    expect(calculate(input).impacts.map(({ jobId }) => jobId)).toEqual(['J-2002'])
  })

  it('uses max readiness, not summed delays, across a diamond', () => {
    const input = graph()
    input.jobs = [
      job('left', 'A', { durationMinutes: 60 }),
      job('right', 'A', { durationMinutes: 90 }),
      job('merge', 'B', { plannedStartAt: at(14) }),
    ]
    input.edges = [
      edge('left-source', ROOT, 'left', at(12, 15)),
      edge('right-source', ROOT, 'right', at(12, 15)),
      edge('merge-left', { kind: 'job', id: 'left' }, 'merge', at(14)),
      edge('merge-right', { kind: 'job', id: 'right' }, 'merge', at(14)),
    ]
    const merge = calculate(input).impacts.find(({ jobId }) => jobId === 'merge')
    expect(merge).toMatchObject({ projectedStartAt: at(15), projectedCompletionAt: at(16) })
    expect(merge.reasons).toHaveLength(2)
  })

  it.each([
    ['explicit zero equality', 0, at(12, 15), false],
    ['explicit buffer equality', 5, at(12, 20), false],
    ['default absent buffer', undefined, at(12, 15), true],
    ['default null buffer', null, at(12, 15), true],
    ['one minute buffer shortfall', 1, at(12, 15), true],
  ])('handles %s using a strict readiness boundary', (_label, buffer, required, affected) => {
    const input = graph()
    input.edges[0].requiredReadyAt = required
    if (buffer === undefined) delete input.edges[0].bufferMinutes
    else input.edges[0].bufferMinutes = buffer
    const impact = calculate(input, { latestEstimatedAt: at(12, 15) }).impacts.find(({ jobId }) => jobId === 'J-2001')
    expect(Boolean(impact)).toBe(affected)
    if (impact) expect(impact.reasons[0].code).toBe('BUFFER_SHORTFALL')
  })

  it('compares equivalent timezone offsets as absolute instants', () => {
    expect(calculate(graph(), { latestEstimatedAt: '2026-10-02T15:30:00+02:00' }))
      .toEqual(calculate())
  })

  it('retains an independent later completion estimate as a lower bound', () => {
    const input = graph()
    input.jobs[0].estimatedCompletionAt = at(16)
    expect(calculate(input).impacts[1].projectedStartAt).toBe(at(16))
  })

  it('does not blindly resolve downstream jobs on a late actual arrival', () => {
    expect(calculate(graph(), { actualAt: at(13, 30) }).impacts).toHaveLength(2)
    expect(calculate(graph(), { latestEstimatedAt: null, actualAt: at(12) }).impacts).toEqual([])
  })

  it('excludes terminal dependents and uses actual completion for completed prerequisites', () => {
    const input = graph()
    input.jobs[0].state = 'Completed'
    input.jobs[0].actualCompletionAt = at(14, 30)
    expect(calculate(input).impacts.map(({ jobId }) => jobId)).toEqual(['J-2002'])
    input.jobs[1].state = 'Cancelled'
    expect(calculate(input).impacts).toEqual([])
  })

  it('reports reachable blocked jobs separately from lateness on cancellation', () => {
    const result = calculate(graph(), { rootState: 'Cancelled' })
    expect(result.impacts).toEqual([])
    expect(result.cancelledJobIds).toEqual(['J-2001', 'J-2002'])
    const input = graph()
    input.jobs[1].state = 'Completed'
    input.jobs[1].actualCompletionAt = at(14)
    expect(calculate(input, { rootState: 'Cancelled' }).cancelledJobIds).toEqual(['J-2001'])
  })

  it('recalculates against the current graph without retaining removed paths', () => {
    const input = graph()
    expect(calculate(input).impacts).toHaveLength(2)
    input.version = 2
    input.edges.pop()
    expect(calculate(input).impacts.map(({ jobId }) => jobId)).toEqual(['J-2001'])
  })

  it('reports missing readiness rather than inventing a timestamp', () => {
    const input = graph()
    input.orders[0].committedAt = null
    input.orders[0].estimatedArrivalAt = null
    const result = calculate(input, { latestEstimatedAt: null })
    expect(result.diagnostics).toContainEqual({ code: 'MISSING_READINESS', jobId: 'J-2001', edgeId: 'order-to-A' })
  })
})

describe('graph admission rejects invalid topology atomically', () => {
  it('rejects cycles and dangling references instead of partial traversal', () => {
    const cycle = graph()
    cycle.edges.push(edge('back', { kind: 'job', id: 'J-2002' }, 'J-2001', at(14)))
    expect(() => validateGraph(cycle)).toThrow(expect.objectContaining({ code: 'GRAPH_CYCLE' }))
    expect(() => calculate(cycle)).toThrow()
    const dangling = graph()
    dangling.edges[0].from.id = 'missing'
    expect(() => validateGraph(dangling)).toThrow(expect.objectContaining({ code: 'MISSING_DEPENDENCY' }))
  })

  it.each([-1, Infinity, NaN, '5'])('rejects invalid buffer %s', (bufferMinutes) => {
    const input = graph()
    input.edges[0].bufferMinutes = bufferMinutes
    expect(() => validateGraph(input)).toThrow()
  })

  it.each([
    ['duplicate job', (g) => g.jobs.push({ ...g.jobs[0] })],
    ['duplicate edge', (g) => g.edges.push({ ...g.edges[0], id: 'other' })],
    ['unknown job terminal alias', (g) => { g.jobs[0].state = 'Done' }],
    ['completed without actual', (g) => { g.jobs[0].state = 'Completed' }],
    ['invalid time zone', (g) => { g.shops[0].timeZone = 'Not/AZone' }],
    ['zero duration', (g) => { g.jobs[0].durationMinutes = 0 }],
    ['malformed planned time', (g) => { g.jobs[0].plannedStartAt = 'tomorrow' }],
    ['impossible estimate', (g) => { g.jobs[0].estimatedCompletionAt = at(12) }],
  ])('rejects %s', (_label, change) => {
    const input = graph()
    change(input)
    expect(() => validateGraph(input)).toThrow()
  })

  it('enforces the configured graph size and dependency depth bounds', () => {
    expect(() => validateGraph(graph(), { maxJobs: 1 })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
    expect(() => validateGraph(graph(), { maxDepth: 1 })).toThrow(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
  })
})

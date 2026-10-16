import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from '../App.jsx'
import NotificationCenter from './NotificationCenter.jsx'
import { createDemoService } from './demo.js'
import { at, NOW, sourceEvent } from './__fixtures__/scenario.js'
import { harness, OPS, PLATFORM, SHOP_A, value } from './__fixtures__/service.js'

const newest = (h, shopId) => h.snapshot().notifications.current.find((n) => n.shopId === shopId)
const delivery = (h, n) => h.snapshot().deliveries.find((d) => d.notificationId === n.notificationId && d.revision === n.revision)
const currentCard = () => screen.getByRole('heading', { name: /^(New|Revised|Resolved|Cancelled) ·/ }).closest('article')

describe('full browser-local lifecycle integration', () => {
  it('publishes, independently acknowledges, revises offline, reconnects latest, reloads and resolves', async () => {
    const h = harness(), user = userEvent.setup()
    const view = render(<NotificationCenter service={h.service} now={() => NOW} orderOptions={['N-1001']} />)
    await user.click(screen.getByRole('button', { name: 'Revise ETA' }))
    expect(h.snapshot().notifications.current).toHaveLength(2)
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop A')
    expect(currentCard()).toHaveTextContent('J-2001')
    expect(currentCard()).not.toHaveTextContent('J-2002')
    await user.click(screen.getByRole('button', { name: 'Accept revision 1' }))
    expect(delivery(h, newest(h, 'A')).acknowledgement.outcome).toBe('Accepted')
    expect(delivery(h, newest(h, 'B')).acknowledgement).toBeFalsy()
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Operations')
    await user.click(screen.getByRole('button', { name: 'Disconnect B' }))
    for (const estimate of [at(14), at(15)]) {
      await user.clear(screen.getByLabelText('Revised ETA / completion'))
      await user.type(screen.getByLabelText('Revised ETA / completion'), estimate)
      await user.click(screen.getByRole('button', { name: 'Revise ETA' }))
    }
    expect(delivery(h, newest(h, 'B')).transportState).toBe('Retrying')
    await user.click(screen.getByRole('button', { name: 'Connect B' }))
    expect(delivery(h, newest(h, 'B')).transportState).toBe('Delivered')
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop B')
    const latest = newest(h, 'B')
    const latestCard = screen.getByRole('heading', { name: `Revised · N-1001 · Revision ${latest.revision}` }).closest('article')
    expect(latestCard).toHaveTextContent('J-2002')
    expect(latestCard).not.toHaveTextContent('J-2001')
    view.unmount()

    const restored = h.reload()
    render(<NotificationCenter service={restored} now={() => NOW} orderOptions={['N-1001']} />)
    expect(value(restored.getSnapshot(OPS)).notifications.current).toEqual(h.snapshot().notifications.current)
    expect(value(restored.getSnapshot(SHOP_A)).acknowledgements).toHaveLength(1)
    await user.clear(screen.getByLabelText('Revised ETA / completion'))
    await user.type(screen.getByLabelText('Revised ETA / completion'), at(12))
    await user.click(screen.getByRole('button', { name: 'Correct delay' }))
    expect(value(restored.getSnapshot(OPS)).notifications.current.every((n) => n.state === 'Resolved')).toBe(true)
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop B')
    expect(screen.getByRole('heading', { name: /^Resolved ·/ })).toBeInTheDocument()
    expect(screen.getByText('Inactive job context — no active delay claim.')).toBeInTheDocument()
  })

  it('receives an external source event live then cancels from operations with retained history', async () => {
    const h = harness(), user = userEvent.setup()
    render(<NotificationCenter service={h.service} now={() => NOW} orderOptions={['N-1001']} />)
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop A')
    act(() => { value(h.service.receive(PLATFORM, sourceEvent())) })
    expect(currentCard()).toHaveTextContent('New')
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Operations')
    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    expect(h.snapshot().notifications.current.every((n) => n.state === 'Cancelled')).toBe(true)
    expect(h.snapshot().notifications.history.some((n) => n.state === 'New')).toBe(true)
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop A')
    expect(screen.getByRole('heading', { name: /^Cancelled ·/ })).toBeInTheDocument()
  })

  it('keeps All/Late/search/table/cards working while storage boot and every channel fail', async () => {
    const service = createDemoService({
      orders: [], now: () => NOW,
      storage: { load: () => { throw Object.assign(new Error('Disabled'), { code: 'STORAGE_UNAVAILABLE' }) }, save: () => {}, clear: () => {} },
      transport: { deliver: () => { throw new Error('Offline') } },
    })
    const user = userEvent.setup()
    render(<App now={() => Date.parse('2026-10-07T12:00:00Z')} notificationService={service} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: /^Late/ }))
    expect(screen.getByRole('button', { name: /^Late/ })).toHaveAttribute('aria-pressed', 'true')
    const table = screen.getByRole('table')
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(1)
    expect(document.querySelectorAll('.order-card').length).toBeGreaterThan(0)
    await user.type(screen.getByRole('searchbox', { name: /search pickup orders/i }), 'not-a-real-vehicle')
    expect(screen.getByText('No late deliveries found.')).toBeInTheDocument()
    expect(service.getSnapshot(OPS).ok).toBe(true)
  })
})

import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import NotificationCenter from './NotificationCenter.jsx'
import { at, NOW, sourceEvent } from './__fixtures__/scenario.js'
import { harness, PLATFORM, value } from './__fixtures__/service.js'

const renderCenter = (h, props = {}) => render(
  <NotificationCenter service={h.service} now={() => NOW} orderOptions={['N-1001']} {...props} />,
)
const activeCard = () => screen.getByRole('heading', { name: /^(New|Revised|Resolved|Cancelled) ·/ }).closest('article')

describe('shop notification UX and operations command feedback', () => {
  it('switches to scoped live inboxes and localizes dates with explicit viewing zones', async () => {
    const h = harness(), user = userEvent.setup()
    renderCenter(h)
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop B')
    expect(screen.getByText('No notifications for this view.')).toBeInTheDocument()
    act(() => { value(h.service.receive(PLATFORM, sourceEvent())) })
    expect(activeCard()).toHaveTextContent('J-2002')
    expect(activeCard()).not.toHaveTextContent('J-2001')
    expect(activeCard()).toHaveTextContent('External prerequisite')
    expect(activeCard()).toHaveTextContent('Europe/Berlin')
    expect(activeCard()).toHaveTextContent(/CEST|GMT\+2/)
    expect(screen.queryByRole('region', { name: 'Platform publishing' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop A')
    expect(activeCard()).toHaveTextContent('J-2001')
    expect(activeCard()).not.toHaveTextContent('J-2002')
    expect(activeCard()).toHaveTextContent(/BST|GMT\+1/)
  })

  it('acknowledges the exact revision using keyboard interaction and announces the result', async () => {
    const h = harness(), user = userEvent.setup()
    value(h.service.receive(PLATFORM, sourceEvent()))
    renderCenter(h)
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop A')
    const button = screen.getByRole('button', { name: 'Accept revision 1' })
    button.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('status')).toHaveTextContent('Accepted acknowledgement recorded for revision 1')
    expect(activeCard()).toHaveTextContent('Acknowledged')
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop B')
    expect(activeCard()).not.toHaveTextContent('Acknowledged')
    expect(screen.getByRole('button', { name: 'Accept revision 1' })).toBeEnabled()
  })

  it('shows a revised label and changed ETA instead of relying on color', async () => {
    const h = harness(), user = userEvent.setup()
    value(h.service.receive(PLATFORM, sourceEvent()))
    renderCenter(h)
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop B')
    act(() => {
      value(h.service.receive(PLATFORM, sourceEvent({ eventId: 'event-2', sequence: 2, latestEstimatedAt: at(14) })))
    })
    const card = screen.getByRole('heading', { name: 'Revised · N-1001 · Revision 2' }).closest('article')
    expect(card).toHaveTextContent('Previous estimate:')
    expect(card).toHaveTextContent('Updated: J-2002')
    expect(within(card).getByRole('button', { name: 'Accept revision 2' })).toBeEnabled()
  })

  it('shows rejected outcome and recovery action without claiming acknowledgement success', async () => {
    const h = harness(), user = userEvent.setup()
    value(h.service.receive(PLATFORM, sourceEvent()))
    renderCenter(h)
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop A')
    await user.type(screen.getByLabelText('Reason code'), 'CAPACITY')
    await user.type(screen.getByLabelText('Comment'), 'Cannot process')
    await user.click(screen.getByRole('button', { name: 'Reject revision 1' }))
    expect(screen.getByRole('status')).toHaveTextContent('Rejected acknowledgement recorded')
    expect(activeCard()).toHaveTextContent('Shop outcome: Rejected')
    expect(activeCard()).not.toHaveTextContent('Acknowledged')
    expect(activeCard()).toHaveTextContent('Next action:')
  })

  it('opens only authorized local job details and clears them on viewer change', async () => {
    const h = harness(), user = userEvent.setup()
    value(h.service.receive(PLATFORM, sourceEvent()))
    renderCenter(h)
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop A')
    await user.click(screen.getByRole('button', { name: 'Job details: J-2001' }))
    expect(screen.getByRole('region', { name: 'Authorized job details' })).toHaveTextContent('J-2001')
    await user.selectOptions(screen.getByLabelText('Demo view'), 'Shop B')
    expect(screen.queryByRole('region', { name: 'Authorized job details' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Job details: J-2001' })).not.toBeInTheDocument()
  })

  it('reports malformed JSON and schema rejection accessibly, without notifications', async () => {
    const h = harness(), user = userEvent.setup()
    renderCenter(h)
    await user.click(screen.getByText('Receive source-event JSON (platform-demo producer)'))
    await user.type(screen.getByLabelText('Source event JSON'), 'not JSON')
    await user.click(screen.getByRole('button', { name: 'Receive source event' }))
    expect(screen.getByRole('alert')).toHaveTextContent('VALIDATION_ERROR')
    await user.clear(screen.getByLabelText('Source event JSON'))
    await user.click(screen.getByLabelText('Source event JSON'))
    await user.paste(JSON.stringify(sourceEvent({ schemaVersion: 9 })))
    await user.click(screen.getByRole('button', { name: 'Receive source event' }))
    expect(screen.getByRole('alert')).toHaveTextContent('UNSUPPORTED_SCHEMA')
    expect(h.snapshot().notifications.current).toEqual([])
  })

  it('requires explicit reset confirmation and labels volatile recovery as reload-loss', async () => {
    const h = harness(), user = userEvent.setup(), onUseVolatile = vi.fn()
    value(h.service.receive(PLATFORM, sourceEvent()))
    renderCenter(h, { onUseVolatile })
    expect(screen.getByText(/memory only; all notification history is lost on reload/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reset demo' }))
    expect(h.snapshot().notifications.current).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Keep history' }))
    expect(h.snapshot().notifications.current).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Reset demo' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset demo' }))
    expect(h.snapshot().notifications.current).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Use volatile demo' }))
    expect(onUseVolatile).toHaveBeenCalledOnce()
  })
})

import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { orders } = vi.hoisted(() => ({
  orders: [
    {
      id: 'LATE-1',
      owner: 'Late Owner',
      vehicle: '2021 Volvo XC60',
      registration: 'LATE 1',
      pickupAddress: { street: '1 Past Road', city: 'Manchester' },
      pickupAt: '2026-10-02T08:30:00Z',
      inspectionAt: '2026-10-02T11:00:00Z',
      status: 'In transit',
    },
    {
      id: 'FUTURE-1',
      owner: 'Future Owner',
      vehicle: '2019 Audi A4',
      registration: 'NEXT 1',
      pickupAddress: { street: '2 Future Road', city: 'Salford' },
      pickupAt: '2026-10-02T09:15:00Z',
      inspectionAt: '2026-10-02T13:00:00Z',
      status: 'Awaiting pickup',
    },
    {
      id: 'EQUAL-1',
      owner: 'Boundary Owner',
      vehicle: '2022 Volkswagen Golf',
      registration: 'EDGE 1',
      pickupAddress: { street: '3 Boundary Road', city: 'Stockport' },
      pickupAt: '2026-10-02T10:00:00Z',
      inspectionAt: '2026-10-02T12:00:00Z',
      status: 'Driver assigned',
    },
    {
      id: 'DELIVERED-1',
      owner: 'Delivered Owner',
      vehicle: '2020 BMW 3 Series',
      registration: 'DONE 1',
      pickupAddress: { street: '4 Complete Road', city: 'Altrincham' },
      pickupAt: '2026-10-02T07:00:00Z',
      inspectionAt: '2026-10-02T08:00:00Z',
      status: 'Delivered',
    },
    {
      id: 'MISSING-1',
      owner: 'Unknown Owner',
      vehicle: '2018 Ford Fiesta',
      registration: 'NONE 1',
      pickupAddress: { street: '5 Unknown Road', city: 'Bolton' },
      pickupAt: '2026-10-02T11:30:00Z',
      inspectionAt: null,
      status: 'Awaiting pickup',
    },
    {
      id: 'OFFSET-1',
      owner: 'Offset Owner',
      vehicle: '2023 Tesla Model 3',
      registration: 'ZONE 1',
      pickupAddress: { street: '6 Offset Road', city: 'Trafford' },
      pickupAt: '2026-10-02T10:15:00Z',
      inspectionAt: '2026-10-02T14:00:00+02:00',
      status: 'Driver assigned',
    },
  ],
}))

vi.mock('./data/orders.json', () => ({ default: orders }))

import App from './App'
import { classifyDelivery } from './classifyDelivery'

const NOW = new Date('2026-10-02T12:00:00Z')
const now = () => new Date(NOW)

function getTable() {
  return screen.getByRole('table')
}

function getTableRow(orderId) {
  return within(getTable()).getByText(orderId).closest('tr')
}

function getCard(orderId) {
  return screen.getAllByText(orderId)
    .map((element) => element.closest('article'))
    .find(Boolean)
}

function getFilter(name) {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('classifyDelivery', () => {
  const baseOrder = { status: 'In transit' }

  it.each([
    ['before the current instant', '2026-10-02T11:59:59.999Z', 'Late'],
    ['equal to the current instant', '2026-10-02T12:00:00.000Z', 'On track'],
    ['after the current instant', '2026-10-02T12:00:00.001Z', 'On track'],
  ])('classifies a known expected time %s', (_case, inspectionAt, expected) => {
    expect(classifyDelivery({ ...baseOrder, inspectionAt }, NOW)).toBe(expected)
  })

  it('gives Delivered precedence over a past, missing, or malformed expected time', () => {
    expect(classifyDelivery({ status: 'Delivered', inspectionAt: '2020-01-01T00:00:00Z' }, NOW))
      .toBe('Delivered')
    expect(classifyDelivery({ status: 'Delivered', inspectionAt: null }, NOW)).toBe('Delivered')
    expect(classifyDelivery({ status: 'Delivered', inspectionAt: 'not-a-date' }, NOW))
      .toBe('Delivered')
  })

  it.each([
    ['absent', {}],
    ['null', { inspectionAt: null }],
    ['empty', { inspectionAt: '' }],
  ])('classifies a %s expected time as Unknown', (_case, fields) => {
    expect(classifyDelivery({ ...baseOrder, ...fields }, NOW)).toBe('Unknown')
  })

  it('throws for a malformed non-empty expected time', () => {
    expect(() => classifyDelivery({ ...baseOrder, inspectionAt: 'not-a-date' }, NOW)).toThrow()
  })

  it('compares equivalent offset timestamps as the same instant', () => {
    const utc = classifyDelivery({ ...baseOrder, inspectionAt: '2026-10-02T12:00:00Z' }, NOW)
    const offset = classifyDelivery(
      { ...baseOrder, inspectionAt: '2026-10-02T14:00:00+02:00' },
      NOW,
    )

    expect(utc).toBe('On track')
    expect(offset).toBe(utc)
  })
})

describe('Late delivery filter', () => {
  it('defaults to All, shows every order, and exposes counts before search', () => {
    render(<App now={now} />)

    expect(getFilter('All')).toHaveAttribute('aria-pressed', 'true')
    expect(within(getFilter('All')).getByText(String(orders.length))).toBeInTheDocument()
    expect(within(getFilter('Late')).getByText('1')).toBeInTheDocument()

    const table = getTable()
    for (const order of orders) {
      expect(within(table).getByText(order.id)).toBeInTheDocument()
    }
  })

  it('selects Late as a peer filter and excludes other classifications', async () => {
    const user = userEvent.setup()
    render(<App now={now} />)

    await user.click(getFilter('Late'))

    expect(getFilter('Late')).toHaveAttribute('aria-pressed', 'true')
    expect(within(getTable()).getByText('LATE-1')).toBeInTheDocument()
    expect(within(getTable()).queryByText('FUTURE-1')).not.toBeInTheDocument()
    expect(within(getTable()).queryByText('EQUAL-1')).not.toBeInTheDocument()
    expect(within(getTable()).queryByText('DELIVERED-1')).not.toBeInTheDocument()
    expect(within(getTable()).queryByText('MISSING-1')).not.toBeInTheDocument()
  })

  it('composes search with Late and keeps filter counts independent of search', async () => {
    const user = userEvent.setup()
    render(<App now={now} />)

    await user.click(getFilter('Late'))
    await user.type(screen.getByRole('searchbox', { name: /search pickup orders/i }), 'Future')

    expect(screen.getByText('No late deliveries found.')).toBeInTheDocument()
    expect(within(getFilter('All')).getByText(String(orders.length))).toBeInTheDocument()
    expect(within(getFilter('Late')).getByText('1')).toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: /search pickup orders/i }))
    await user.type(screen.getByRole('searchbox', { name: /search pickup orders/i }), 'Late Owner')
    expect(within(getTable()).getByText('LATE-1')).toBeInTheDocument()
  })

  it('preserves operational status filters', async () => {
    const user = userEvent.setup()
    render(<App now={now} />)

    expect(within(getFilter('Awaiting pickup')).getByText('2')).toBeInTheDocument()
    await user.click(getFilter('Awaiting pickup'))

    expect(within(getTable()).getByText('FUTURE-1')).toBeInTheDocument()
    expect(within(getTable()).getByText('MISSING-1')).toBeInTheDocument()
    expect(within(getTable()).queryByText('LATE-1')).not.toBeInTheDocument()
  })

  it('renders classification separately from operational status in table and cards', () => {
    render(<App now={now} />)

    const cases = [
      ['LATE-1', 'Late'],
      ['FUTURE-1', 'On track'],
      ['DELIVERED-1', 'Delivered'],
      ['MISSING-1', 'Unknown'],
    ]

    for (const [id, classification] of cases) {
      const cells = within(getTableRow(id)).getAllByRole('cell')
      expect(cells.at(-1)).toHaveTextContent(classification)

      const card = getCard(id)
      expect(card.querySelector('.classification')).toHaveTextContent(classification)
      expect(card.querySelector('.status')).toHaveTextContent(
        orders.find((order) => order.id === id).status,
      )
    }
  })

  it('reclassifies orders after the injected clock advances', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    render(<App now={() => new Date(Date.now())} refreshIntervalMs={1_000} />)

    expect(within(getFilter('Late')).getByText('1')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(within(getFilter('Late')).getByText('3')).toBeInTheDocument()
  })

  it('uses the default refresh interval and cleans up its timer', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const { unmount } = render(<App now={now} />)

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000)
    const timerId = setIntervalSpy.mock.results.at(-1).value

    unmount()

    expect(clearIntervalSpy).toHaveBeenCalledWith(timerId)
  })

  it('shows the standard error surface and logs the malformed order ID', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const originalTime = orders[1].inspectionAt
    orders[1].inspectionAt = 'not-a-date'

    try {
      render(<App now={now} />)

      expect(screen.getByText('Unable to display pickup orders')).toBeInTheDocument()
      expect(screen.getByText('An order contains an invalid expected delivery time.'))
        .toBeInTheDocument()
      expect(consoleError).toHaveBeenCalledWith(
        'Unable to classify pickup order',
        expect.objectContaining({ orderId: 'FUTURE-1' }),
      )
    } finally {
      orders[1].inspectionAt = originalTime
    }
  })
})

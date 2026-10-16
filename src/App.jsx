import { useEffect, useMemo, useState } from 'react'
import orders from './data/orders.json'
import { classifyDelivery } from './classifyDelivery'
import NotificationCenter from './notifications/NotificationCenter'
import { useNotificationService } from './notifications/useNotifications'
import './App.css'

const filters = ['All', 'Late', 'Awaiting pickup', 'Driver assigned', 'In transit']

const statusClassNames = {
  'Awaiting pickup': 'status--waiting',
  'Driver assigned': 'status--assigned',
  'In transit': 'status--transit',
}

const classificationClassNames = {
  Delivered: 'classification--delivered',
  Unknown: 'classification--unknown',
  Late: 'classification--late',
  'On track': 'classification--on-track',
}

function Icon({ children, size = 20 }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {children}
    </svg>
  )
}

function formatDateTime(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return null
  }

  const date = new Date(value)
  return {
    date: new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date),
    time: new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date),
  }
}

function DateTime({ value }) {
  const formatted = formatDateTime(value)

  if (!formatted) {
    return (
      <span
        aria-label="Expected delivery time unavailable"
        className="date-time__missing"
      >
        —
      </span>
    )
  }

  return (
    <div className="date-time">
      <strong>{formatted.date}</strong>
      <small>{formatted.time}</small>
    </div>
  )
}

function StatusBadge({ status }) {
  return (
    <span className={`status ${statusClassNames[status] ?? ''}`}>
      <span className="status__dot" />
      {status}
    </span>
  )
}

function ClassificationBadge({ classification }) {
  return (
    <span className={`classification ${classificationClassNames[classification]}`}>
      {classification === 'Late' && (
        <span aria-hidden="true" className="classification__marker">!</span>
      )}
      {classification}
    </span>
  )
}

function OrderRow({ order }) {
  const pickup = formatDateTime(order.pickupAt)

  return (
    <tr>
      <td>
        <span className="order-id">{order.id}</span>
      </td>
      <td>
        <div className="vehicle-cell">
          <span className="vehicle-cell__icon">
            <Icon size={22}>
              <path d="M4 13.5 5.5 8h13l1.5 5.5M3 15.5h18M5 15.5v3M19 15.5v3M7 11h10" />
            </Icon>
          </span>
          <span>
            <strong>{order.vehicle}</strong>
            <small>{order.registration} · {order.owner}</small>
          </span>
        </div>
      </td>
      <td>
        <div className="location">
          <Icon size={18}>
            <path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z" />
            <circle cx="12" cy="10" r="2" />
          </Icon>
          <span>
            <strong>{order.pickupAddress.street}</strong>
            <small>{order.pickupAddress.city}</small>
          </span>
        </div>
      </td>
      <td>
        <div className="date-time">
          <strong>{pickup.date}</strong>
          <small>{pickup.time}</small>
        </div>
      </td>
      <td>
        <DateTime value={order.inspectionAt} />
      </td>
      <td>
        <StatusBadge status={order.status} />
      </td>
      <td>
        <ClassificationBadge classification={order.deliveryClassification} />
      </td>
    </tr>
  )
}

function OrderCard({ order }) {
  const pickup = formatDateTime(order.pickupAt)

  return (
    <article className="order-card">
      <div className="order-card__header">
        <span className="order-id">{order.id}</span>
        <div className="order-card__badges">
          <StatusBadge status={order.status} />
          <ClassificationBadge classification={order.deliveryClassification} />
        </div>
      </div>
      <div className="order-card__vehicle">
        <span className="vehicle-cell__icon">
          <Icon size={22}>
            <path d="M4 13.5 5.5 8h13l1.5 5.5M3 15.5h18M5 15.5v3M19 15.5v3M7 11h10" />
          </Icon>
        </span>
        <span>
          <strong>{order.vehicle}</strong>
          <small>{order.registration} · {order.owner}</small>
        </span>
      </div>
      <div className="order-card__address">
        <Icon size={18}>
          <path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z" />
          <circle cx="12" cy="10" r="2" />
        </Icon>
        <span>{order.pickupAddress.street}, {order.pickupAddress.city}</span>
      </div>
      <dl>
        <div>
          <dt>Pickup</dt>
          <dd>{pickup.date}<span>{pickup.time}</span></dd>
        </div>
        <div>
          <dt>Inspection</dt>
          <dd><DateTime value={order.inspectionAt} /></dd>
        </div>
      </dl>
    </article>
  )
}

function App({ now = Date.now, refreshIntervalMs = 60_000, notificationService }) {
  const [activeFilter, setActiveFilter] = useState('All')
  const [query, setQuery] = useState('')
  const [currentInstant, setCurrentInstant] = useState(() => now())
  const notifications = useNotificationService({ notificationService, now, currentInstant })
  const orderOverrides = notifications.snapshot.ok
    ? notifications.snapshot.value.orderOverrides
    : null
  const displayedOrders = useMemo(() => orders.map((order) => ({
    ...order,
    ...(orderOverrides?.[order.id] ? { status: orderOverrides[order.id].status } : {}),
  })), [orderOverrides])

  useEffect(() => {
    const intervalId = globalThis.setInterval(() => {
      setCurrentInstant(now())
    }, refreshIntervalMs)

    return () => globalThis.clearInterval(intervalId)
  }, [now, refreshIntervalMs])

  const schedule = useMemo(() => {
    try {
      return {
        error: null,
        orders: displayedOrders.map((order) => ({
          ...order,
          deliveryClassification: classifyDelivery(order, currentInstant),
        })),
      }
    } catch (error) {
      return { error, orders: [] }
    }
  }, [currentInstant, displayedOrders])

  useEffect(() => {
    if (schedule.error) {
      console.error('Unable to classify pickup order', {
        error: schedule.error,
        orderId: schedule.error.orderId,
      })
    }
  }, [schedule.error])

  const filterCounts = useMemo(() => Object.fromEntries(
    filters.map((filter) => [
      filter,
      schedule.orders.filter((order) => (
        filter === 'All'
          || (filter === 'Late' && order.deliveryClassification === 'Late')
          || order.status === filter
      )).length,
    ]),
  ), [schedule.orders])

  const filteredOrders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    return schedule.orders.filter((order) => {
      const matchesFilter = activeFilter === 'All'
        || (activeFilter === 'Late' && order.deliveryClassification === 'Late')
        || order.status === activeFilter
      const matchesQuery = !normalizedQuery || [
        order.id,
        order.vehicle,
        order.registration,
        order.owner,
        order.pickupAddress.street,
        order.pickupAddress.city,
      ].some((value) => value.toLowerCase().includes(normalizedQuery))

      return matchesFilter && matchesQuery
    })
  }, [activeFilter, query, schedule.orders])

  const summary = {
    total: orders.length,
    inTransit: displayedOrders.filter((order) => order.status === 'In transit').length,
    waiting: displayedOrders.filter((order) => order.status === 'Awaiting pickup').length,
  }

  return (
    <main>
      <header className="page-header">
        <div className="brand-mark" aria-hidden="true">
          <Icon size={25}>
            <path d="M4 13.5 5.5 8h13l1.5 5.5M3 15.5h18M5 15.5v3M19 15.5v3M7 11h10" />
          </Icon>
        </div>
        <div>
          <p className="eyebrow">Repair logistics</p>
          <h1>Vehicle pickup orders</h1>
          <p className="subtitle">
            Cars scheduled for collection and delivery to the repair shop for inspection.
          </p>
        </div>
        <div className="date-label">
          <Icon size={18}>
            <rect x="4" y="5" width="16" height="15" rx="2" />
            <path d="M8 3v4M16 3v4M4 10h16" />
          </Icon>
          Tuesday, 6 October
        </div>
      </header>

      <section className="summary-grid" aria-label="Pickup order summary">
        <article>
          <span className="summary-icon summary-icon--total">
            <Icon>
              <path d="M4 13.5 5.5 8h13l1.5 5.5M3 15.5h18M5 15.5v3M19 15.5v3M7 11h10" />
            </Icon>
          </span>
          <span>
            <strong>{summary.total}</strong>
            <small>Scheduled pickups</small>
          </span>
        </article>
        <article>
          <span className="summary-icon summary-icon--transit">
            <Icon>
              <path d="M3 17h13V6H3v11Zm13-7h3l2 3v4h-5v-7Z" />
              <circle cx="7" cy="18" r="2" />
              <circle cx="18" cy="18" r="2" />
            </Icon>
          </span>
          <span>
            <strong>{summary.inTransit}</strong>
            <small>Currently in transit</small>
          </span>
        </article>
        <article>
          <span className="summary-icon summary-icon--waiting">
            <Icon>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </Icon>
          </span>
          <span>
            <strong>{summary.waiting}</strong>
            <small>Awaiting pickup</small>
          </span>
        </article>
      </section>

      <section className="orders-panel">
        {schedule.error ? (
          <div className="empty-state empty-state--error" role="alert">
            <Icon size={28}>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v6M12 17h.01" />
            </Icon>
            <h2>Unable to display pickup orders</h2>
            <p>An order contains an invalid expected delivery time.</p>
          </div>
        ) : (
          <>
            <div className="orders-panel__toolbar">
              <div>
                <h2>Today’s pickup schedule</h2>
                <p>{filteredOrders.length} {filteredOrders.length === 1 ? 'order' : 'orders'} shown</p>
              </div>
              <label className="search">
                <Icon size={18}>
                  <circle cx="11" cy="11" r="7" />
                  <path d="m16 16 4 4" />
                </Icon>
                <span className="sr-only">Search pickup orders</span>
                <input
                  type="search"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search orders"
                  value={query}
                />
              </label>
            </div>

            <div className="filters" aria-label="Filter orders">
              {filters.map((filter) => (
                <button
                  aria-pressed={activeFilter === filter}
                  className={activeFilter === filter ? 'active' : ''}
                  key={filter}
                  onClick={() => setActiveFilter(filter)}
                  type="button"
                >
                  {filter}
                  <span>{filterCounts[filter]}</span>
                </button>
              ))}
            </div>

            {filteredOrders.length > 0 ? (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Vehicle</th>
                        <th>Pickup location</th>
                        <th>Pickup time</th>
                        <th>Shop inspection</th>
                        <th>Status</th>
                        <th>Delivery</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOrders.map((order) => <OrderRow key={order.id} order={order} />)}
                    </tbody>
                  </table>
                </div>
                <div className="card-list">
                  {filteredOrders.map((order) => <OrderCard key={order.id} order={order} />)}
                </div>
              </>
            ) : (
              <div className="empty-state">
                <Icon size={28}>
                  <circle cx="11" cy="11" r="7" />
                  <path d="m16 16 4 4" />
                </Icon>
                <h3>
                  {activeFilter === 'Late'
                    ? 'No late deliveries found.'
                    : 'No pickup orders found'}
                </h3>
                <p>Try another status or search term.</p>
              </div>
            )}
          </>
        )}
      </section>
      <NotificationCenter
        service={notifications.service}
        now={now}
        orderOptions={orders.map(({ id }) => id)}
        onUseVolatile={notifications.useVolatile}
      />
    </main>
  )
}

export default App

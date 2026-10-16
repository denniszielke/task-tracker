import { useEffect, useRef, useState } from 'react'
import { DEMO_ACTORS } from './demo'
import { useViewerSnapshot } from './useNotifications'
import './NotificationCenter.css'

const viewers = {
  Operations: DEMO_ACTORS.operations,
  'Shop A': DEMO_ACTORS.shopA,
  'Shop B': DEMO_ACTORS.shopB,
}

function timestamp(value, timeZone) {
  if (!value) return 'Unavailable'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Invalid time'
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: undefined,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone, timeZoneName: 'short',
  }).format(date)
}

function JsonDetails({ title, value }) {
  return <details><summary>{title}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
}

function DeliveryStatus({ delivery, timeZone }) {
  if (!delivery) return <p>Transport: Pending</p>
  const ack = delivery.acknowledgement
  return (
    <div className="notification-tracking">
      <p><strong>Transport: {delivery.transportState}</strong> · {delivery.attemptCount} attempts
        {ack?.outcome === 'Accepted' && ' · Acknowledged'}
      </p>
      <p>Last attempt: {timestamp(delivery.lastAttemptAt, timeZone)} · Next retry: {timestamp(delivery.nextAttemptAt, timeZone)}</p>
      <p>Escalation: {delivery.escalation ?? 'None'}
        {delivery.supersededByRevision != null && ` · Superseded by revision ${delivery.supersededByRevision}`}
      </p>
      {ack && <p>Shop outcome: <strong>{ack.outcome}</strong> at {timestamp(ack.acknowledgedAt, timeZone)}
        {ack.reasonCode && ` · ${ack.reasonCode}`}{ack.comment && ` · ${ack.comment}`}
      </p>}
      {(delivery.transportState === 'Failed' || ack?.outcome === 'Rejected' || delivery.escalation === 'Error') && (
        <p className="notification-next-action">Next action: review the history, contact the shop, check its channel and retry the latest delivery. Rejection is not successful processing.</p>
      )}
    </div>
  )
}

function NotificationCard({ notification, delivery, shop, execute, service, actor, now, operations, historical, onJob }) {
  const [comment, setComment] = useState('')
  const [reason, setReason] = useState('')
  const zone = shop?.timeZone ?? 'UTC'
  const terminal = ['Resolved', 'Cancelled'].includes(notification.state)
  const acknowledge = (outcome) => execute(() => service.acknowledge(actor, {
    schemaVersion: 1,
    acknowledgementId: globalThis.crypto.randomUUID(),
    notificationId: notification.notificationId,
    revision: notification.revision,
    acknowledgedAt: new Date(now()).toISOString(),
    outcome,
    ...(reason ? { reasonCode: reason } : {}),
    ...(comment ? { comment } : {}),
  }), `${outcome} acknowledgement recorded for revision ${notification.revision}.`)

  return (
    <article className={`notification-card notification-card--${notification.state.toLowerCase()}`}>
      <h4>{notification.state} · {notification.vehicleOrderId} · Revision {notification.revision}</h4>
      <p>Shop {notification.shopId} · Correlation {notification.correlationId}</p>
      <p>Committed: {timestamp(notification.previousCommittedAt, zone)}</p>
      <p>Latest estimate: {timestamp(notification.latestEstimatedAt, zone)} · {notification.estimateBasis === 'observed-lower-bound' ? 'Observed lower bound — not a predicted arrival' : 'Reported estimate'}</p>
      <p>Delay: {notification.delayMs == null ? 'Unavailable' : `${Math.round(notification.delayMs / 60_000)} minutes`} · Graph version {notification.graphVersion}</p>
      <p>Created: {timestamp(notification.createdAt, zone)} · Time zone: {zone}</p>
      <p>{terminal ? 'Inactive job context — no active delay claim.' : 'Active affected jobs'}</p>
      <ul>
        {notification.affectedJobs.map((job) => (
          <li key={job.jobId}>
            <button type="button" onClick={() => onJob(job.jobId)}>Job details: {job.jobId}</button>
            <p>Planned start: {timestamp(job.plannedStartAt, zone)} · Projected start: {timestamp(job.projectedStartAt, zone)} · Projected completion: {timestamp(job.projectedCompletionAt, zone)}</p>
            <ul>{job.reasons.map((reason, index) => (
              <li key={`${reason.code}-${index}`}>{reason.code} · Required: {timestamp(reason.requiredReadyAt, zone)} · Buffer: {reason.bufferMinutes} minutes
                <span className="notification-path">Path: {reason.path.map((node) => node.kind === 'external-prerequisite' ? 'External prerequisite' : `${node.kind}:${node.id}`).join(' → ')}</span>
              </li>
            ))}</ul>
          </li>
        ))}
      </ul>
      <p>Changes — Added: {notification.changes.addedJobIds.join(', ') || 'None'}; Removed: {notification.changes.removedJobIds.join(', ') || 'None'}; Updated: {notification.changes.updatedJobIds.join(', ') || 'None'}</p>
      {notification.state === 'Revised' && <p>Previous estimate: {timestamp(notification.changes.previousEstimatedAt, zone)}</p>}
      <DeliveryStatus delivery={delivery} timeZone={zone} />
      {operations ? (
        <button type="button" disabled={historical} onClick={() => execute(() => service.retryDelivery(actor, { notificationId: notification.notificationId }), 'Latest delivery retry requested.')}>Retry latest delivery</button>
      ) : (
        <fieldset>
          <legend>Acknowledge exact revision {notification.revision}</legend>
          <label>Reason code<input maxLength={64} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <label>Comment<input maxLength={500} value={comment} onChange={(event) => setComment(event.target.value)} /></label>
          <div className="notification-actions">
            <button type="button" disabled={delivery?.transportState !== 'Delivered'} onClick={() => acknowledge('Accepted')}>Accept revision {notification.revision}</button>
            <button type="button" disabled={delivery?.transportState !== 'Delivered'} onClick={() => acknowledge('Rejected')}>Reject revision {notification.revision}</button>
          </div>
          {delivery?.transportState !== 'Delivered' && <p>A successful adapter delivery is required before acknowledgement.</p>}
        </fieldset>
      )}
      <JsonDetails title="Versioned notification payload" value={notification} />
    </article>
  )
}

function Publisher({ service, actor, execute, orderOptions, jobOptions, now }) {
  const [orderId, setOrderId] = useState(orderOptions[0] ?? '')
  const [jobId, setJobId] = useState('')
  const [estimatedAt, setEstimatedAt] = useState(() => new Date(Number(new Date(now())) + 90 * 60_000).toISOString())
  const [actualAt, setActualAt] = useState(() => new Date(now()).toISOString())
  const [reasonCode, setReasonCode] = useState('OPERATIONS_UPDATE')
  const [context, setContext] = useState('')
  const [jobState, setJobState] = useState('In progress')
  const [source, setSource] = useState('')
  const publish = (kind) => {
    const change = { kind, vehicleOrderId: orderId, reasonCode, context }
    if (['eta', 'correct'].includes(kind)) change.estimatedAt = estimatedAt
    if (kind === 'deliver') change.actualAt = actualAt
    if (kind === 'job') {
      change.jobId = jobId
      change.jobState = jobState
      if (jobState === 'Completed') change.actualAt = actualAt
      else if (jobState !== 'Cancelled') change.estimatedAt = estimatedAt
    }
    execute(() => service.publishPlatformChange(actor, change), 'Platform change processed.')
  }
  return (
    <section aria-label="Platform publishing">
      <h3>Publish platform changes</h3>
      <p>Use RFC3339 timestamps with Z or an explicit offset (for example 2026-10-02T13:30:00+00:00). Planned and committed times remain unchanged.</p>
      <div className="notification-fields">
        <label>Vehicle order<select value={orderId} onChange={(event) => setOrderId(event.target.value)}>{orderOptions.map((id) => <option key={id}>{id}</option>)}</select></label>
        <label>Revised ETA / completion<input value={estimatedAt} onChange={(event) => setEstimatedAt(event.target.value)} /></label>
        <label>Actual arrival / completion<input value={actualAt} onChange={(event) => setActualAt(event.target.value)} /></label>
        <label>Publication reason code<input maxLength={64} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} /></label>
        <label>Publication context<input maxLength={500} value={context} onChange={(event) => setContext(event.target.value)} /></label>
      </div>
      <div className="notification-actions">
        <button type="button" onClick={() => publish('observe')}>Publish late observation</button>
        <button type="button" onClick={() => publish('eta')}>Revise ETA</button>
        <button type="button" onClick={() => publish('correct')}>Correct delay</button>
        <button type="button" onClick={() => publish('deliver')}>Mark delivered</button>
        <button type="button" onClick={() => publish('cancel')}>Cancel order</button>
      </div>
      <div className="notification-fields">
        <label>Repair job ID<input list="notification-job-options" value={jobId} onChange={(event) => setJobId(event.target.value)} /><datalist id="notification-job-options">{jobOptions.map((id) => <option key={id} value={id} />)}</datalist></label>
        <label>Repair job state<select value={jobState} onChange={(event) => setJobState(event.target.value)}>{['Scheduled', 'In progress', 'Completed', 'Cancelled'].map((state) => <option key={state}>{state}</option>)}</select></label>
      </div>
      <button type="button" onClick={() => publish('job')}>Update job</button>
      <details>
        <summary>Receive source-event JSON (platform-demo producer)</summary>
        <p>Version 1 only. Never include owner, registration, address or contact information.</p>
        <label>Source event JSON<textarea rows={12} value={source} onChange={(event) => setSource(event.target.value)} /></label>
        <button type="button" onClick={() => execute(() => {
          let event
          try { event = JSON.parse(source) } catch { return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Source event must be valid JSON.' } } }
          return service.receive(DEMO_ACTORS.platform, event)
        }, 'Source event processed.')}>Receive source event</button>
      </details>
    </section>
  )
}

function ShopCompletionPublisher({ jobs, service, actor, execute, now }) {
  const [selectedId, setSelectedId] = useState('')
  const [state, setState] = useState('In progress')
  const [time, setTime] = useState(() => new Date(now()).toISOString())
  const selected = jobs.find((job) => job.id === selectedId) ?? jobs[0]
  if (!selected) return null
  return (
    <details>
      <summary>Report an assigned repair-job completion change</summary>
      <div className="notification-fields">
        <label>Your assigned job<select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{jobs.map((job) => <option key={job.id} value={job.id}>{job.id}</option>)}</select></label>
        <label>Reported job state<select value={state} onChange={(event) => setState(event.target.value)}>{['Scheduled', 'In progress', 'Completed', 'Cancelled'].map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>Reported completion time (RFC3339 with zone)<input value={time} onChange={(event) => setTime(event.target.value)} /></label>
      </div>
      <button type="button" onClick={() => execute(() => service.publishPlatformChange(actor, {
        kind: 'job', vehicleOrderId: selected.vehicleOrderId, jobId: selected.id,
        jobState: state, reasonCode: 'SHOP_COMPLETION_UPDATE',
        ...(state === 'Completed' ? { actualAt: time } : state === 'Cancelled' ? {} : { estimatedAt: time }),
      }), 'Assigned job completion change processed.')}>Publish assigned job change</button>
    </details>
  )
}

export default function NotificationCenter({ service, now = Date.now, orderOptions = [], onUseVolatile }) {
  const [viewer, setViewer] = useState('Operations')
  const actor = viewers[viewer]
  const [snapshotResult, refresh] = useViewerSnapshot(service, actor)
  const [feedback, setFeedback] = useState(null)
  const [job, setJob] = useState(null)
  const jobDetailsRef = useRef(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const snapshot = snapshotResult.ok ? snapshotResult.value : null
  const operations = snapshot?.role === 'operations'
  const current = snapshot?.notifications.current ?? []
  const history = snapshot?.notifications.history ?? []
  const deliveries = snapshot?.deliveries ?? []
  useEffect(() => {
    if (job) jobDetailsRef.current?.focus()
  }, [job])
  const execute = (operation, message) => {
    try {
      const result = operation()
      refresh()
      setFeedback(result.ok
        ? { message: `${message}${result.value?.disposition ? ` ${result.value.disposition}.` : ''}`, value: result.value }
        : { error: result.error })
      return result
    } catch {
      const error = { code: 'INTERNAL_ERROR', message: 'The local notification action failed. The pickup schedule remains available.' }
      setFeedback({ error })
      return { ok: false, error }
    }
  }
  const showJob = (jobId) => {
    const result = execute(() => service.getJob(actor, { jobId }), 'Authorized job details opened.')
    if (result.ok) setJob(result.value)
  }
  const renderNotification = (notification, historical = false) => (
    <NotificationCard
      key={`${notification.notificationId}:${notification.revision}`}
      notification={notification}
      delivery={deliveries.find((item) => item.notificationId === notification.notificationId && item.revision === notification.revision)}
      shop={operations ? snapshot.shops.find((shop) => shop.id === notification.shopId) : snapshot.shop}
      execute={execute} service={service} actor={actor} now={now}
      operations={operations} historical={historical} onJob={showJob}
    />
  )

  return (
    <section className="notification-center" aria-labelledby="notification-center-title">
      <h2 id="notification-center-title">Late vehicle notification center</h2>
      <p className="notification-demo-banner"><strong>Local demo — no real authentication or remote channel.</strong> View switching simulates trusted actors, not login. Delivered means local adapter acceptance; Accepted confirms shop processing, not that a person read it.</p>
      <label>Demo view<select value={viewer} onChange={(event) => { setViewer(event.target.value); setFeedback(null); setJob(null); setConfirmReset(false) }}>{Object.keys(viewers).map((name) => <option key={name}>{name}</option>)}</select></label>
      {!snapshotResult.ok && <p role="alert">{snapshotResult.error.code}: {snapshotResult.error.message}</p>}
      {snapshot?.error && <p role="alert">{snapshot.error.code}: {snapshot.error.message} Review stored history before reset, or deliberately choose a volatile session.</p>}
      {operations && snapshot.operationalErrors.length > 0 && <p role="alert">Notification data / processing diagnostics: {snapshot.operationalErrors.length}. Review “Operational errors and ordering gaps” below; the pickup schedule is independent.</p>}
      <p>Persistence: {snapshot?.persistenceState ?? 'error'}{snapshot?.persistenceState === 'volatile' && ' — memory only; all notification history is lost on reload.'}</p>
      {feedback?.error ? <p role="alert">{feedback.error.code}: {feedback.error.message}</p> : <p role="status" aria-live="polite">{feedback?.message ?? ''}</p>}
      {feedback?.value && <JsonDetails title="Last command result" value={feedback.value} />}
      {operations && (
        <>
          <Publisher service={service} actor={actor} execute={execute} orderOptions={orderOptions} jobOptions={[...new Set([
            ...(snapshot.jobs ?? []).map((job) => job.id),
            ...[...current, ...history].flatMap((notification) => notification.affectedJobs.map((job) => job.jobId)),
          ])]} now={now} />
          <section aria-label="Simulated shop channels">
            <h3>Simulated shop channels</h3>
            <p>Fresh channels are Connected. Controls are independent of the selected demo view.</p>
            <div className="notification-actions">{snapshot.shops.map((shop) => (
              <fieldset key={shop.id}><legend>{shop.name} ({shop.id})</legend>
                <p>Channel: {snapshot.channels?.[shop.id] ? snapshot.channels[shop.id].connected ? 'Connected' : 'Disconnected' : 'See control result'}
                  {snapshot.channels?.[shop.id]?.failNext && ' · Next delivery will fail'}
                </p>
                <button type="button" onClick={() => execute(() => service.setShopConnection(actor, { shopId: shop.id, connected: true }), `${shop.name} connected; latest pending delivery attempted.`)}>Connect {shop.id}</button>
                <button type="button" onClick={() => execute(() => service.setShopConnection(actor, { shopId: shop.id, connected: false }), `${shop.name} disconnected.`)}>Disconnect {shop.id}</button>
                <button type="button" onClick={() => execute(() => service.setShopConnection(actor, { shopId: shop.id, connected: true, failNext: true }), `Next attempted delivery to ${shop.name} will fail.`)}>Fail next delivery {shop.id}</button>
              </fieldset>
            ))}</div>
            <button type="button" onClick={() => execute(() => service.tick(actor), 'Due retries and escalation checked using the current clock.')}>Process due retries</button>
          </section>
          <section aria-label="Delay lifecycle status">
            <h3>Delay lifecycles · Graph version {snapshot.graphVersion}</h3>
            {snapshot.lifecycles.map((lifecycle, index) => (
              <article className="notification-lifecycle" key={lifecycle.correlationId ?? index}>
                <JsonDetails title={`Lifecycle ${lifecycle.correlationId ?? index} — revision ${lifecycle.latestRevision ?? lifecycle.revision ?? 0}, source sequence ${lifecycle.lastAppliedSequence ?? 0}`} value={lifecycle} />
                <button type="button" onClick={() => execute(() => service.retryProcessing(actor, { correlationId: lifecycle.correlationId }), 'Queued or failed source processing retried.')}>Retry processing {lifecycle.correlationId}</button>
              </article>
            ))}
            <JsonDetails title="Operational errors and ordering gaps" value={snapshot.operationalErrors} />
            <JsonDetails title="Metrics and local delivery latency" value={snapshot.metrics} />
          </section>
        </>
      )}
      {snapshot?.role === 'shop' && <ShopCompletionPublisher key={viewer} jobs={snapshot.jobs} service={service} actor={actor} execute={execute} now={now} />}
      <h3>{operations ? 'Latest recipient statuses' : `${snapshot?.shop?.name ?? viewer} inbox`}</h3>
      {current.length === 0 && <p>No notifications for this view.</p>}
      <div className="notification-list">{current.map((notification) => renderNotification(notification))}</div>
      <details><summary>Notification revision history ({history.length})</summary><div className="notification-list">{history.map((notification) => renderNotification(notification, true))}</div></details>
      {job && <section ref={jobDetailsRef} className="notification-job" aria-label="Authorized job details" tabIndex={-1}>
        <h3>Authorized job details: {job.id}</h3>
        <p>State: {job.state} · Planned start: {timestamp(job.plannedStartAt, snapshot?.shop?.timeZone ?? 'UTC')} · Duration: {job.durationMinutes} minutes</p>
        <JsonDetails title="Job data" value={job} />
        <button type="button" onClick={() => setJob(null)}>Close job details</button>
      </section>}
      {snapshot && <JsonDetails title="Acknowledgement history (including rejections)" value={snapshot.acknowledgements} />}
      {operations && (
        <>
          <JsonDetails title="Audit and source event history" value={snapshot.audit} />
          {snapshot.events && <JsonDetails title="Source event records (including gaps and processing failures)" value={snapshot.events} />}
          {snapshot.attempts && <JsonDetails title="Delivery attempt history" value={snapshot.attempts} />}
          <section aria-label="Demo recovery">
            <h3>Storage and manual recovery</h3>
            <p>Reset removes only this notification workspace, including its history and demo status overrides. Pickup source data is not changed.</p>
            <button type="button" onClick={() => setConfirmReset(true)}>Reset demo</button>
            {confirmReset && <div role="group" aria-label="Confirm reset">
              <p>Permanently clear this notification workspace?</p>
              <button type="button" onClick={() => { execute(() => service.resetDemo(actor), 'Demo workspace reset.'); setConfirmReset(false) }}>Confirm reset demo</button>
              <button type="button" onClick={() => setConfirmReset(false)}>Keep history</button>
            </div>}
          </section>
        </>
      )}
      {(operations || !snapshot || snapshot.persistenceState === 'error') && onUseVolatile && (
        <div className="notification-volatile">
          <p>Explicit recovery option: start an empty memory-only notification workspace. Existing local storage is preserved; volatile changes and history are lost on reload.</p>
          <button type="button" onClick={() => { onUseVolatile(); setFeedback(null); setJob(null) }}>Use volatile demo</button>
        </div>
      )}
    </section>
  )
}

# Vehicle Pickup Orders Demo

A React 19 / Vite 8 pickup schedule with a browser-local late-vehicle event
service, dependency propagation and shop-specific notification inboxes.
No runtime network service is required.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Available commands

- `npm run dev` starts the development server.
- `npm run build` creates a production build in `dist/`.
- `npm run lint` checks the source with Oxlint.
- `npm test` runs the Vitest / Testing Library suite.
- `npm run preview` serves the production build locally.

Targeted checks:

```bash
npm test -- src/App.test.jsx
npm test -- src/notifications
npm run lint
npm run build
```

## Demo data

Pickup orders are stored in `src/data/orders.json`. Edit or add records there
to change the orders shown in the app.

The schedule keeps the original All, Late and operational status filters,
search, desktop table and responsive cards. Counts are calculated before search.
`inspectionAt` remains the expected/committed delivery time: exact `Delivered`
takes precedence; missing time is Unknown; strictly earlier than the controlled
clock is Late; equality is On track. Malformed nonempty inspection times surface
the schedule's data error. An ETA revision never rewrites `inspectionAt`.
The demo's explicit delivered/cancelled commands overlay order **status** only.
A Cancelled order can still classify Late under the unchanged classifier, but
does not start another notification lifecycle.

## Notification walkthrough

1. Open **Late vehicle notification center** below the schedule. The default
   **Demo view** is **Operations**. These are simulated identities, **not login**.
   Shops A and B start with independently connected local adapters.
2. The fixture uses the first available order with a valid committed time. It
   creates `demo-job-A` (90 minutes, starts commitment +15 minutes) and
   `demo-job-B` (60 minutes, starts commitment +120 minutes), with a direct
   order-to-A dependency and transitive A-to-B dependency. Choose that order in
   **Vehicle order**.
   Use **Publish late observation**, or enter an ETA sufficiently beyond its
   committed/planned times and choose **Revise ETA**. All time inputs require
   RFC3339 with `Z` or an explicit offset, such as `2026-10-02T13:30:00+00:00`.
3. Switch to **Shop A**, inspect its jobs and dependency reasons, then **Accept
   revision N** or **Reject revision N** (optional reason and comment). The exact
   revision must first have a successful local delivery. The result is announced
   accessibly. Shop B has its own inbox and acknowledgement; A cannot acknowledge
   B. **Job details** calls the scoped service method before opening details.
   Shops can also report completion changes using only their assigned job list.
4. Return to Operations; **Disconnect B**, revise the ETA twice and inspect
   transport status separately from New/Revised lifecycle state. A still receives
   changes. **Connect B** retries only the latest pending/retrying revision,
   including terminal revisions. Older undelivered revisions remain superseded
   history rather than appearing as new. **Fail next delivery B** fails only the
   next attempted delivery.
5. **Correct delay** with a nonconflicting estimate, **Mark delivered** with an
   actual arrival, **Cancel order**, or **Update job** with a state and estimated
   or actual completion. Delivery resolves a shop only if its downstream impacts
   actually disappear; a late actual arrival may leave work affected. Completed
   and cancelled dependent jobs are not active impacts. Terminal cards retain
   explicitly inactive job context and previous revisions remain in history.
6. Expand lifecycle details, metrics, acknowledgement/rejection history and
   **Audit and source event history** in Operations. The **Receive source-event
   JSON** disclosure exercises strict schema validation, duplicate IDs, stale
   sequences and retained gaps with the `platform-demo` producer.
   Input the versioned safe event schema, never owner/contact/registration data.
7. Reload in the same browser to recover the workspace. The currently selected
   view does not control simulated shop connectivity.

Shop A renders in `Europe/London`, B in `Europe/Berlin`; displayed times include
zone abbreviations. Calculations always compare absolute instants. An observed
lower-bound estimate explicitly means “not arrived by this time,” **not** a
prediction of arrival. A reported estimate overtaken by the clock becomes an
observed lower bound.

## Service API and versioned contracts

```js
import { createDemoService, DEMO_ACTORS } from './src/notifications/demo.js'
import { createNotificationService } from './src/notifications/service.js'
import { createMemoryStorage } from './src/notifications/storage.js'

const service = createDemoService({ orders, now: () => Date.now() })
const result = service.publishPlatformChange(DEMO_ACTORS.operations, {
  kind: 'eta',
  vehicleOrderId: orders[0].id,
  estimatedAt: '2026-10-02T13:30:00Z',
  reasonCode: 'TRAFFIC',
})
if (!result.ok) console.error(result.error.code, result.error.message)

const subscription = service.subscribe(DEMO_ACTORS.shopA, (snapshot) => {
  // Already shop-scoped; no Operations/global data is sent to this listener.
  console.log(snapshot.notifications.current)
})
if (subscription.ok) subscription.value() // unsubscribe when unmounting
```

All public methods are **synchronous**, returning `{ok:true,value}` or
`{ok:false,error:{code,message,details?}}`, including `subscribe` (whose value is
the cleanup function). Read the initial view with `getSnapshot(actor)`.
Notification snapshots contain `notifications.current` and `.history`; immutable
payload revisions are separate from mutable delivery tracking.

Other methods: `receive(actor, sourceEvent)`, `reconcilePlatform(actor,{orders})`,
`tick(actor)`, `replaceGraph(actor,{expectedVersion,graph})`,
`acknowledge(actor,acknowledgement)`, `getJob(actor,{jobId})`,
`setShopConnection(actor,{shopId,connected,failNext?})`,
`retryDelivery(actor,{notificationId})`, `retryProcessing(actor,{correlationId})`
and `resetDemo(actor)`. Core construction accepts graph, trusted actors,
`clock:{now:()=>epochMs}`, ID factory, storage, transport and optional policy.
The demo factory accepts orders, `now` (Date or epoch-returning function), and
optional storage/transport/ID factory. `App` also accepts `now`,
`refreshIntervalMs` (default 60,000) and an optional `notificationService`.

The v1 source event has `schemaVersion:1`, `eventId`, `type`, `sourceSystem`,
`occurredAt`, `vehicleOrderId`, safe `vehicleRef`, `correlationId`, nullable
`causationId`, positive `sequence`, `root:{kind,id}`, nullable
`previousCommittedAt`, `latestEstimatedAt`, `actualAt`, and `reasonCode`;
optional fields are `context`, `estimateBasis` and `rootState`.
Types are `vehicle.late`, `vehicle.eta-revised`, `vehicle.delivered`,
`vehicle.delay-corrected`, `vehicle.cancelled`,
`repair-job.completion-revised`. Required timestamps vary by event type.
Unknown versions/properties and invalid calendar dates or missing zones reject.
Correlations bind one producer/root/order; source sequence is not notification
revision. Missing predecessors queue rather than overwrite current state.

Acknowledgements have `schemaVersion:1`, `acknowledgementId`, `notificationId`,
exact `revision`, `acknowledgedAt`, `outcome: 'Accepted' | 'Rejected'` and optional
`reasonCode`/`comment`. They never reschedule work. Repeating the same semantic
outcome is idempotent; conflicting outcomes reject. Earlier revision acceptance
never acknowledges a later revision.

The DAG uses max prerequisite readiness, not summed delay. Missing/null edge
buffers default to **5 minutes**; explicit zero remains zero. Demo fixture edges
use **0 minutes**. Equality at the readiness threshold is safe; planned and
committed times remain immutable. No dependency is inferred from shared vehicle
identity. Payloads group only the recipient's jobs and redact foreign path
segments as external prerequisites.

## Retry, escalation and storage recovery

- Delivery attempts happen immediately, then +1s, +5s, +30s and +120s relative
  to the previous failed attempt, for five total attempts. Exhaustion is Failed;
  **Retry latest delivery** explicitly resets its attempt budget, retaining
  history. Reconnect does not automatically retry exhausted Failed deliveries.
- **Process due retries** runs a clock-driven tick now. Automatic reconciliation
  and retry checks use the schedule's minute refresh interval, not hidden
  service timers. Publishing and reconnecting attempt immediately.
- Operations Warning starts after 5 minutes without Accepted processing; Error
  after 15 minutes, on exhaustion or rejection. Next actions are shown locally;
  there is no external pager. Rejected is never Acknowledged success.
- State uses only `pickup-orders.late-notifications.v1` in localStorage.
  The outbox is persisted before adapter delivery. Reload resumes eligible
  persisted work; history is not replayed as new. There is no silent eviction.
- Corrupt, unavailable or full storage produces an explicit error, leaving the
  pickup schedule usable. **Reset demo**, then **Confirm reset demo**, clears
  only this notification workspace/history. Review the history before resetting.
  **Use volatile demo** deliberately creates a new memory-only workspace without
  clearing the original stored value. **All volatile history is lost on reload.**
- Workspace limits: 100 orders, 200 jobs, 500 edges, depth 32, 20 shops, 100
  queued events per lifecycle, 2,000,000 UTF-8 snapshot bytes and 10,000 audit
  records. Bounds reject atomically rather than silently dropping history.
  If storage cannot persist even an audit record, only an in-memory health
  error is available; durable rejection auditing is not claimed.

## Production gaps / release gates

This is a **single-browser, single-writer local demonstration**. Client-side
actor checks and scoped projections exercise contracts, not a trusted security
boundary: same-origin code/devtools can bypass them. There is no actual remote
repair-shop receipt. Delivered means adapter acceptance; Accepted means the
shop actor processed a revision, neither proves a human read it.

Production needs trusted authentication/producer onboarding and server-side
authorization, durable transactional storage/outbox/broker, real authenticated
push transport and recipient deduplication, TLS and approved at-rest protection,
credential rotation, multi-process ordering/locking, retention/backup/deletion
policy, graph ownership and actual-time quality, real alert routing and an
approved load profile. localStorage is not a server durability or availability
guarantee, and no delivery/retry occurs while the browser is closed.

Local deterministic tests and bounded-workload timings **do not certify** the
production p95 <=10s / p99.9 <=60s delivery objective, 99.9% eventual delivery,
security or availability acceptance criteria. The latency objective starts
after event acceptance; a default minute-based late observation is not a
10-second detection guarantee. Those are external deployed release gates.

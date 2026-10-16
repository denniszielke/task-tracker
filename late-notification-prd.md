# Product Requirements Document: Real-Time Late Vehicle Notifications

**Status:** Draft  
**Product:** Vehicle Pickup Orders Demo  
**Date:** 6 October 2026  
**Owner:** Product  

## 1. Summary

Enable the platform and participating repair shops to exchange real-time events
when a vehicle is late. When a late vehicle is expected to delay one or more
dependent repair jobs, the system must identify those jobs, notify every
affected repair shop, and keep the notifications current as the vehicle's
estimated arrival changes or the delay is resolved.

The capability complements the Late Delivery Filter. The filter determines
whether a vehicle is late; this feature distributes actionable delay
information and propagates its operational impact.

## 2. Problem

Repair shops plan technicians, bays, parts, and follow-up work around expected
vehicle arrival and job completion times. When a vehicle arrives late, affected
shops often learn about the delay through manual calls or after a dependent job
has already missed its planned start.

The platform currently has no standard way to:

- receive a late or revised-arrival event in real time;
- determine which follow-up repair jobs depend on the delayed vehicle or job;
- notify all affected repair shops consistently;
- confirm that a shop received the notification; or
- send corrections when the delay changes or is resolved.

As a result, shops may act on stale schedules, downstream delays may be
discovered too late, and operations users lack a reliable record of who was
notified.

## 3. Goal

Enable operations users and repair shops to:

1. Publish or receive a late-vehicle event without manual coordination.
2. Identify every scheduled repair job directly or transitively affected by
   the delay.
3. Notify each affected repair shop with the latest actionable information.
4. Acknowledge receipt and track delivery status.
5. Receive revisions and resolution events without duplicate or contradictory
   notifications.

## 4. Non-goals

- Predicting whether an on-time vehicle may become late.
- Automatically rebooking technicians, bays, parts, or replacement vehicles.
- Automatically changing contractual service-level commitments.
- Choosing a new repair shop or route.
- Sending consumer-facing notifications to vehicle owners.
- Replacing existing order, job, or operational status fields.
- Building long-term analytics or repair-shop performance scoring.
- Defining commercial penalties caused by a delay.

## 5. Definitions

| Term | Definition |
|------|------------|
| Vehicle order | The pickup or delivery order that brings a vehicle to a repair shop. |
| Repair job | Scheduled work performed by a repair shop for a vehicle. |
| Follow-up repair job | A repair job that cannot start until a preceding vehicle delivery or repair job reaches its required completion state. |
| Dependency | A directed relationship from a prerequisite order or job to a dependent repair job. |
| Directly affected job | A job whose immediate prerequisite is delayed. |
| Transitively affected job | A job delayed through one or more intermediate job dependencies. |
| Source event | A late, revised-arrival, delivered, cancelled, or corrected event received from an authorized producer. |
| Impacted shop | A repair shop assigned to at least one affected repair job. |
| Notification | The shop-facing event describing a delay, revision, or resolution and the jobs affected at that shop. |
| Acknowledgement | A shop response confirming that a notification was received and processed or rejected. |
| Current delay | The difference between the latest estimated arrival or completion time and the previously committed time. |
| Real time | The event is available to connected recipients without a manual refresh and within the delivery objective in this document. |

All timestamps and durations must be transmitted unambiguously. Time
comparisons must use absolute instants; user interfaces may render them in the
repair shop's configured time zone.

## 6. User Stories

### Operations user

**As an operations user,** I want a late-vehicle event to notify every affected
repair shop **so that** downstream work can be adjusted before its planned
start.

### Repair-shop coordinator

**As a repair-shop coordinator,** I want to receive immediate, job-specific
delay updates and acknowledge them **so that** I can adjust the local schedule
using current information.

### Integration operator

**As an integration operator,** I want event delivery and processing states to
be observable and recoverable **so that** transient failures do not silently
drop operational notifications.

## 7. Functional Requirements

### FR1: Receive source events

The system must accept source events from authenticated and authorized
producers for these event types:

- `vehicle.late`
- `vehicle.eta-revised`
- `vehicle.delivered`
- `vehicle.delay-corrected`
- `vehicle.cancelled`
- `repair-job.completion-revised`

Each event must include:

- a globally unique event ID;
- event type and schema version;
- source system and source timestamp;
- vehicle order ID;
- vehicle ID or the application's non-sensitive vehicle reference;
- previous committed time, when applicable;
- latest estimated arrival or completion time, when applicable;
- reason code and optional human-readable context;
- correlation ID for the delay lifecycle; and
- causation ID when the event was produced from another event.

Events missing required fields or containing malformed timestamps must be
rejected explicitly. Rejected events must not produce notifications.

### FR2: Publish platform events

The system must publish a canonical source event when its own order or repair
job data establishes, revises, corrects, or resolves a delay. Platform events
must use the same validation, identity, versioning, and authorization rules as
externally received events.

Publishing an event must not require a repair shop to poll the application.

### FR3: Detect affected repair jobs

For every accepted source event, the system must resolve the current dependency
graph and identify:

1. the directly affected repair jobs; and
2. every transitively affected follow-up repair job whose planned start may no
   longer be achievable.

A job is affected when its prerequisite's latest estimated arrival or
completion is later than the dependency's required-ready time or leaves less
than the configured transfer or preparation buffer.

The calculation must:

- use the dependency graph version current when the event is processed;
- prevent infinite traversal if dependency data contains a cycle;
- surface invalid cycles through standard operational error handling;
- exclude completed or cancelled dependent jobs;
- retain the reason and dependency path used to classify each job as affected;
  and
- recalculate impacts when an ETA, completion estimate, dependency, or job state
  changes.

### FR4: Create shop-specific notifications

The system must create one notification per impacted shop and delay revision.
A notification must include only the affected jobs assigned to that shop.

Each notification must include:

- notification ID and schema version;
- source event ID and delay correlation ID;
- source vehicle order reference;
- notification state: `New`, `Revised`, `Resolved`, or `Cancelled`;
- previous committed time and latest estimated time;
- delay duration, when both times are known;
- affected repair job IDs, planned start times, and dependency reasons;
- event creation time;
- repair shop ID; and
- acknowledgement instructions.

If multiple jobs at one shop are affected by the same revision, they must be
grouped in one shop notification. Jobs assigned to another shop must not be
included.

### FR5: Deliver notifications in real time

The system must push notifications to each impacted shop through its configured
real-time integration channel. The in-application repair-shop view must update
without a manual refresh while connected.

For a valid event and an available recipient channel:

- 95% of notifications must be made available to the shop within 10 seconds;
- 99.9% must be made available within 60 seconds; and
- delivery latency must be measured from accepted source-event time.

A temporary connection failure must not cause data loss. The system must retain
the notification and retry delivery according to the configured retry policy.

### FR6: Support acknowledgements

An impacted shop must be able to acknowledge a notification with:

- notification ID;
- acknowledged revision number;
- acknowledgement time;
- outcome: `Accepted` or `Rejected`;
- optional rejection reason code; and
- optional comment.

The system must validate that the acknowledging shop owns the notification and
that the referenced revision exists. Acknowledgements for an older revision
must remain in the audit history but must not acknowledge a newer revision.

Duplicate acknowledgements with the same identity and content must be
idempotent. Conflicting acknowledgements must be rejected and surfaced to the
sender.

### FR7: Revise and resolve notifications

When the estimated time or affected-job set changes, the system must send a
`Revised` notification with a monotonically increasing revision number.

When the delay no longer affects a shop, the system must send:

- `Resolved` when the vehicle arrives, the prerequisite completes, or the new
  estimate no longer conflicts with dependent work; or
- `Cancelled` when the vehicle order or prerequisite job is cancelled.

A resolution or cancellation must reference the same delay correlation ID and
must not erase earlier notifications or acknowledgements.

### FR8: Guarantee idempotent, ordered processing

The system must process an event ID no more than once for business effects,
even if the event is delivered multiple times.

For events sharing a delay correlation ID:

- revisions must have a monotonically increasing source sequence or revision;
- an older event arriving after a newer event must not overwrite current state;
- duplicate events must return or record an idempotent success result; and
- ordering gaps must be retained for retry or reconciliation rather than
  silently ignored.

The system may deliver the same notification more than once during recovery,
so recipient integrations must be able to deduplicate by notification ID and
revision.

### FR9: Handle unavailable shops and delivery failures

If a shop is disconnected or its delivery endpoint is unavailable, the system
must:

1. retain the notification;
2. mark its delivery state as `Pending` or `Retrying`;
3. retry without blocking delivery to other shops;
4. move exhausted attempts to the application's failed-delivery workflow;
5. alert operations according to the configured severity and age threshold;
   and
6. deliver the latest applicable revision when the shop reconnects.

Failures must never be represented as successful delivery or acknowledgement.

### FR10: Show notification status

Operations users must be able to see, for each delay:

- current delay state and latest revision;
- affected jobs and repair shops;
- delivery state per shop: `Pending`, `Delivered`, `Acknowledged`, `Retrying`,
  `Failed`, `Resolved`, or `Cancelled`;
- last delivery attempt and acknowledgement time;
- rejection details; and
- the event and notification audit history.

Repair-shop users must see active notifications relevant to their shop,
including which jobs are affected, whether a notification was revised, and
whether their acknowledgement was accepted.

### FR11: Preserve compatibility

- The Late Delivery Filter's classification rules must remain unchanged.
- Existing order, repair-job, and operational status fields must retain their
  meanings.
- Existing pages must continue to function when real-time connectivity is
  unavailable.
- Consumers must opt in to the new event schemas; existing API consumers must
  not be required to process them.
- A notification delivery state must not be treated as proof that a human read
  the notification; only a valid acknowledgement confirms processing by the
  shop.

## 8. Event Lifecycle

The expected lifecycle is:

1. An authorized producer sends a late or revised-completion source event.
2. The system validates and stores the event idempotently.
3. The system resolves direct and transitive dependency impacts.
4. The system creates one notification per impacted shop.
5. Each notification is pushed independently and its delivery state is
   recorded.
6. A shop acknowledges the exact notification revision.
7. A later source event causes the system to revise, resolve, or cancel the
   notification.
8. The complete event, delivery, and acknowledgement history remains auditable.

Processing one shop's acknowledgement or delivery failure must not delay or
change notifications for another shop.

## 9. UX Requirements

1. New and revised delay notifications must be visually distinguishable without
   relying on color alone.
2. A revised notification must show what changed from the prior revision.
3. Times must be displayed in the viewing repair shop's configured time zone
   and include the zone abbreviation or offset.
4. An affected job must link to the existing job details when the user has
   permission to view it.
5. The acknowledgement action must be keyboard accessible and expose its
   result to assistive technology.
6. Failed delivery and rejected acknowledgement states must include a clear
   next action for operations users.
7. Reconnecting clients must receive current active notifications and must not
   replay obsolete revisions as new.
8. Users must be able to distinguish system delivery, shop acknowledgement,
   resolution, and cancellation.

## 10. Security and Privacy Requirements

1. Producers and repair shops must authenticate using the application's
   approved machine-to-machine or user authentication mechanism.
2. Authorization must be enforced per event operation and repair shop.
3. A repair shop must receive only notifications and job details assigned to
   that shop.
4. Events must not include owner contact information or other personal data not
   required to coordinate the repair work.
5. Event data must be encrypted in transit and protected according to the
   application's data-at-rest standard.
6. Authentication failures, authorization failures, rejected events,
   deliveries, retries, and acknowledgements must be auditable.
7. Secrets used by shop integrations must be rotatable without losing queued
   notifications.

## 11. Reference Scenario

At 12:00 UTC, order `N-1001` was expected at Shop A but its ETA changes to
13:30 UTC. Repair job `J-2001` at Shop A requires the vehicle at 12:15 UTC.
Job `J-2002` at Shop B depends on `J-2001` completing by 14:00 UTC.

Required behavior:

1. The accepted ETA revision identifies `J-2001` as directly affected.
2. Dependency traversal identifies `J-2002` as transitively affected if the
   recalculated completion of `J-2001` is later than `J-2002`'s required-ready
   time, including its configured buffer.
3. Shop A receives a notification containing only `J-2001`.
4. Shop B receives a separate notification containing only `J-2002`.
5. Shop A's acknowledgement does not acknowledge Shop B's notification.
6. If the ETA changes to 13:00 UTC, both shops receive a new revision when
   their impact details change.
7. If the vehicle arrives and neither job remains affected, both shops receive
   a `Resolved` notification.
8. A duplicate of any source event creates no duplicate business effects.

## 12. Acceptance Criteria

1. A valid late or ETA-revision event is accepted from an authorized producer,
   persisted once, and assigned to a delay lifecycle.
2. Invalid, unauthorized, and malformed events are rejected explicitly and
   produce no shop notifications.
3. Direct and transitive affected jobs are calculated using current dependency
   data, required-ready times, and configured buffers.
4. Completed and cancelled follow-up jobs are not notified as active impacts.
5. Every impacted shop receives a separate notification containing only its
   assigned affected jobs.
6. Available shops receive 95% of notifications within 10 seconds and 99.9%
   within 60 seconds of source-event acceptance under the agreed production
   load profile.
7. Duplicate and out-of-order source events do not duplicate business effects
   or regress the current delay state.
8. Shops can acknowledge an exact notification revision, and an old
   acknowledgement cannot acknowledge a newer revision.
9. Revised estimates produce monotonically numbered revisions; resolved and
   cancelled delays produce the corresponding terminal notification.
10. Delivery failures are retained, retried, visible to operations, and do not
    block other shops.
11. Reconnected shops receive the latest applicable state without obsolete
    revisions appearing as new.
12. The Late Delivery Filter and existing order and repair-job workflows
    continue to work when the event channel is unavailable.

## 13. Quality and Test Requirements

Automated tests must use controllable clocks and deterministic event ordering.
Minimum coverage:

- Contract tests for each source event, notification, and acknowledgement
  schema version.
- Authentication and per-shop authorization tests.
- Unit tests for direct and transitive dependency calculation.
- Tests for completed jobs, cancelled jobs, missing dependencies, and cycles.
- Idempotency tests for duplicate source events, notifications, and
  acknowledgements.
- Ordering tests for stale revisions, gaps, and concurrent revisions.
- Integration tests for publish, receive, notify, acknowledge, revise, resolve,
  and cancel flows.
- Recovery tests for disconnects, retries, exhausted attempts, and reconnects.
- Isolation tests proving one shop cannot receive or acknowledge another
  shop's notification.
- Load tests verifying the delivery objectives under the agreed peak event and
  fan-out volume.
- Regression tests for the Late Delivery Filter and existing offline behavior.
- Time-zone tests proving equivalent instants yield identical impact results.

## 14. Observability and Audit Requirements

The system must expose metrics and structured logs for:

- accepted, rejected, duplicate, stale, and failed source events;
- dependency traversal duration and number of affected jobs;
- notification fan-out count and end-to-end delivery latency;
- pending, retrying, failed, delivered, and acknowledged notifications;
- acknowledgement latency and rejection reasons;
- retry count and age of the oldest undelivered notification; and
- event ordering gaps and dependency cycles.

Every audit record must be traceable using the event ID, correlation ID,
notification ID, shop ID, and revision. Operational data must support
reconciliation without requiring repair shops to resend valid events.

## 15. Success Measures

The feature is successful when:

- at least 99.9% of valid notifications are eventually delivered or have an
  explicit failed-delivery record;
- the real-time delivery objectives are met under the agreed production load;
- every active downstream impact can be traced to a source event and dependency
  path;
- duplicate events produce no duplicate business effects;
- operations can identify unacknowledged and failed notifications without
  contacting engineering; and
- no repair shop can access another shop's affected-job details.

## 16. Dependencies

- Stable identifiers for vehicle orders, repair jobs, and repair shops.
- A maintained dependency relationship between prerequisite and follow-up jobs.
- Planned start, required-ready, and estimated completion times.
- Repair-shop ownership and authorization data.
- A durable event transport with retry and per-recipient delivery tracking.
- A configured real-time channel for each participating repair shop.
- A controllable application clock for deterministic testing.

## 17. Assumptions and Decisions

- The Late Delivery Filter remains the canonical rule for determining whether
  an undelivered vehicle is late.
- The dependency graph, not shared vehicle identity alone, determines which
  follow-up jobs are affected.
- Notifications are shop-specific to prevent cross-shop data disclosure.
- Business processing is idempotent even though transport delivery may be at
  least once.
- Acknowledgement confirms processing by the shop integration, not necessarily
  that a specific person read the notification.
- The latest valid revision is the current state; prior revisions remain
  immutable audit history.

## 18. Open Questions

1. Which producer systems may originate late and revised-completion events?
2. Which real-time integration channels must be supported for the first
   release?
3. What peak event rate, maximum dependency depth, and maximum fan-out should
   define the production load profile?
4. What transfer or preparation buffer applies when a dependency does not
   define one explicitly?
5. When must an unacknowledged notification escalate, and to whom?
6. Should shops be able to propose a revised repair-job start time in their
   acknowledgement, or is that a later scheduling feature?
7. How long must event, notification, delivery-attempt, and acknowledgement
   history be retained?
8. Which terminal order and job states should normalize to delivered,
   completed, or cancelled?

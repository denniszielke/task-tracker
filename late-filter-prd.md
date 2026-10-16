# Product Requirements Document: Late Delivery Filter

**Status:** Draft  
**Product:** Vehicle Pickup Orders Demo  
**Date:** 6 October 2026  
**Owner:** Product  

## 1. Summary

Add a deterministic delivery classification to pickup orders and allow users to
filter the schedule to orders that are late.

An order is late only when it has not been delivered and its expected delivery
time is strictly before the current time. Delivered orders and orders without
an expected delivery time must never appear in the Late view.

This feature is a rule-based status indicator. It is not a prediction, risk
score, or estimate of whether an order may become late in the future.

## 2. Problem

Operations users can see the current delivery state and scheduled times, but
they cannot quickly identify undelivered vehicles whose expected arrival at the
repair shop has already passed. They must compare each order's expected time
with the current time manually.

This makes it slower to find deliveries that need attention and creates room
for inconsistent interpretation at the exact due-time boundary.

## 3. Goal

Enable an operations user to:

1. See a consistent delivery classification for every order.
2. Switch between all orders and late orders.
3. Trust that the classification uses an explicit, testable time boundary.

## 4. Non-goals

- Predicting future delivery risk.
- Estimating a revised arrival time.
- Changing dispatch, routing, pickup, or inspection workflows.
- Sending alerts or notifications.
- Adding historical lateness reporting.
- Changing or removing existing API fields, status filters, or the default All
  view.

## 5. Definitions

| Term | Definition |
|------|------------|
| Current time | The instant supplied by the application's controllable clock. |
| Expected delivery time | The order's expected arrival time at the repair shop. In the current application this is represented by `inspectionAt`. |
| Delivered | An order whose delivery state is `Delivered`. |
| Undelivered | Any order whose delivery state is not `Delivered`. |
| Late | An undelivered order with a known expected delivery time strictly before the current time. |
| On track | An undelivered order with a known expected delivery time equal to or after the current time. |
| Unknown | An undelivered order without an expected delivery time. |

All time comparisons must compare absolute instants. Display time zones must
not change the classification.

## 6. User Story

**As an operations user,** I want to filter the pickup schedule to late
deliveries **so that** I can quickly identify orders that need attention.

## 7. Functional Requirements

### FR1: Classify every order

The system must derive one of the following classifications for each order:

| Condition | Classification |
|-----------|----------------|
| Delivery state is `Delivered` | `Delivered` |
| Undelivered and expected delivery time is missing | `Unknown` |
| Undelivered and expected delivery time is before the current time | `Late` |
| Undelivered and expected delivery time is equal to or after the current time | `On track` |

The conditions must be evaluated in the order shown so a delivered order is
always classified as Delivered, regardless of its expected delivery time.

### FR2: Use a strict late boundary

An order becomes Late only when:

```text
expected delivery time < current time
```

Equality is not late. At the exact expected delivery time, an undelivered order
must remain On track. It becomes Late once the controlled clock advances beyond
that instant.

### FR3: Show the classification

The desktop table and responsive order cards must display the derived
classification using the exact user-facing labels:

- Delivered
- Unknown
- Late
- On track

The classification must not replace or obscure the existing operational
delivery state.

### FR4: Add All and Late delivery views

The UI must offer:

- **All:** shows every order and remains the default view.
- **Late:** shows only orders whose derived classification is Late.

The Late view must exclude Delivered, Unknown, and On track orders.

Existing search behavior must continue to work within the selected view. When
Late is selected, a search result must satisfy both the Late classification and
the search query.

### FR5: Show filter counts

The All filter count must equal the total number of orders. The Late filter
count must equal the number of orders currently classified as Late using the
same controlled current time as the displayed classifications.

### FR6: Handle missing expected times

A missing, null, or absent expected delivery time must produce Unknown. It must
not cause a rendering error and must not be treated as Late.

Malformed non-empty timestamps are invalid data and must be surfaced through
the application's standard error handling rather than silently classified as
Unknown or On track.

### FR7: Preserve compatibility

- Existing order fields and their meanings must remain unchanged.
- Existing consumers must not be required to provide a classification field.
- The existing All view must continue to show all orders.
- Existing operational delivery states and status filtering must continue to
  work unless the final UI design intentionally consolidates the controls.
- Existing date, search, table, and responsive card behavior must continue to
  work.

## 8. UX Requirements

1. The All and Late controls must be keyboard accessible and expose the selected
   state to assistive technology.
2. Late must be visually distinguishable without relying on color alone.
3. The classification must appear in both desktop and responsive layouts.
4. If no orders match the Late view, show the existing empty state with copy
   that makes clear no late deliveries were found.
5. Filter counts and visible rows/cards must update from the same classification
   result to avoid inconsistent totals.

## 9. Reference Scenarios

For the following scenarios, the controlled current time is:

```text
2 October, 12:00 UTC
```

| Order | Delivery state | Expected delivery time | Required classification | Included in Late |
|-------|----------------|------------------------|-------------------------|------------------|
| N-1001 | In transit | 2 October, 11:00 UTC | Late | Yes |
| N-1002 | In transit | 2 October, 13:00 UTC | On track | No |
| N-1003 | Delivered | 2 October, 11:00 UTC | Delivered | No |
| N-1004 | In transit | Missing | Unknown | No |
| N-1005 | In transit | 2 October, 12:00 UTC | On track | No |

When the controlled clock advances past 12:00 UTC, N-1005 must become Late.

## 10. Acceptance Criteria

1. Delivered orders have the classification `Delivered` and never appear in the
   Late view.
2. An undelivered order without an expected delivery time is classified as
   `Unknown`.
3. An undelivered order with an expected delivery time strictly before the
   controlled current time is classified as `Late`.
4. Other undelivered orders with a known expected delivery time are classified
   as `On track`, including equality at the current instant.
5. The UI offers All and Late views and displays the classification on every
   order.
6. Automated tests use a controllable clock and cover all five reference
   scenarios.
7. Existing API fields, operational delivery states, search behavior,
   responsive layouts, and the default All view continue to work.

## 11. Quality and Test Requirements

Automated tests must not depend on the machine's wall clock. They must inject,
mock, or otherwise control the current instant.

Minimum coverage:

- Unit tests for all classification branches.
- A boundary test where expected delivery time equals the current time.
- A transition test that advances the clock beyond the expected delivery time.
- A delivered-order precedence test.
- A missing-time test.
- UI tests for All and Late selection, counts, search composition, empty state,
  and classification rendering in table and card layouts.
- Regression coverage confirming that All still displays every order.
- Time-zone coverage confirming equivalent instants classify identically when
  expressed with different offsets.

## 12. Success Measures

The feature is successful when:

- All acceptance criteria pass in automated tests.
- A user can reach a view containing only late deliveries with one filter
  selection.
- The displayed Late count always matches the number of visible late orders
  before search is applied.
- No regressions are introduced in the existing All view or order search.

## 13. Assumptions and Decisions

- `inspectionAt` is the current data field representing expected delivery to the
  repair shop.
- `Delivered` is the canonical delivered-state label and comparisons use the
  application's normalized delivery-state value.
- Classification is derived at runtime and is not required as a persisted input
  field.
- Reclassification occurs whenever the controlled current time used by the
  application changes or the order data is refreshed.

## 14. Open Questions

1. Should the Late view be added alongside the existing operational status
   filters or presented as a separate All/Late control?
2. Should Late counts update continuously while the page remains open, on a
   fixed interval, or only when data is refreshed?
3. Is `Delivered` already available from the upstream data source, and are
   there any equivalent terminal states that should normalize to Delivered?
4. What standard error surface should be used when a non-empty expected delivery
   timestamp is malformed?

# Agent Note: Live notification eligibility outside projection replay

Status: implemented

English | [中文](2026-10-17-live-projection-notification-eligibility.zh.md)

## Problem

A normal primary turn can end while delegated work or result delivery remains pending. Continuable activations do not necessarily create jobs. Durable registrations can outlive a crashed runtime, and historical replay cannot determine current work ownership. A completion reminder must not mistake either a waiting turn or a cached historical completion for a newly finished task.

## Decision

Projection folds and cached views remain deterministic history. The optional synchronous `wire.publish(session, event)` predicate controls only live changed-view delivery; a veto drops that edge without catch-up or changes to snapshots, checkpoints, or watermarks. State-synchronization consumers omit it. This extends, rather than replaces, the [required projection-reader seam](2026-08-19-session-projection-mandatory-seam.md).

[Completion reminders](../../../../packages/client/interaction-notifications/README.md#lifecycle) consult authoritative job status, exact live-Agent descendant ownership, and both parent inboxes at the committed completion event. Ownership survives plugin HMR and does not follow copied fork history. Child inactivity alone is insufficient because its result may still await parent consumption.

## Alternatives considered

**Persist pending-work state in the reminder projection.** Continuable restarts need new durable lifecycle facts, and abandoned job records need crash repair. This duplicates runtime ownership for a non-durable reminder.

**Track observer events in the notification plugin.** Activation start/end tracking misses work already admitted before HMR and does not account for queued parent input after child settlement.

**Delay or inspect final text.** Neither elapsed time nor model phrasing establishes runtime quiescence. Waiting would also create deferred reminders after cancellation or reconnect.

## Consequences

No loop or Session-event changes are required. Historical values describe turn candidates, not runtime quiescence; only the live feed authorizes reminders. Offline completions are not caught up. Long-lived owned jobs conservatively prevent reminders until settlement, regardless of model intent.

Verification covers an actual continuable tool activation without jobs, notification-plugin reload, inactive-child result delivery, and a negative control with live eligibility removed. Read and checkpoint restoration checks preserve pure historical values without invoking the predicate.

---
description: "Background system notifications for approvals, questions, plan reviews, and completed tasks."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-interaction-notifications

English | [中文](README.zh.md)

## Summary

Sends silent system reminders for pending approvals, questions, plan reviews, and completed tasks while the application window is hidden or unfocused. The shipped Web composition enables this plugin for Desktop and browsers; it does not change the Agent loop or answer requests.

## Table of Contents

- [Usage](#usage)
- [Lifecycle](#lifecycle)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="usage"></a>
## Usage

General Settings → **System notifications** controls the local browser/device preference, enabled by default. Browser users must click **Allow notifications** to grant permission; the plugin never requests browser permission on startup. Desktop uses Electron native notifications without also sending a browser notification. On macOS, Electron may request system authorization when native notification support is first initialized. OS permissions and focus modes can suppress either provider.

Notifications contain only the application name and interaction category, never commands, paths, question text, or conversation titles. Clicking restores or focuses the Desktop window, then uses existing navigation to open the owning Session; a Desktop focus event that arrives before the native click callback does not prevent navigation. Browser clicks request focus before navigating. A notification never approves an operation or submits an answer. Existing Conversation loading and unavailable-Session feedback remain responsible for navigation failures.

<a id="lifecycle"></a>
## Lifecycle

Pending approval, question, and plan-review reminders use the current Client interaction registry; they are not Host-wide. Completion reminders use Host Session projections and do not depend on the selected or retained Client Session. The pure completion projection records normal primary-Session `turn/end` candidates, excluding subagent Sessions. Its wire value is the latest candidate `SessionSeq` or null. Live publication additionally requires no owned running or stopping jobs, no admitted or unsettled descendant activations, and no unclaimed next-turn or next-step input. The runtime owners supply these synchronous checks at the committed event; snapshots, cache restoration, and historical replay never consult live work.

The Client listens on the existing root control/list projection channel through `ISessions.onProjectionUpdate`. Only live projection frames can notify; baseline/list hints, history reads, and reconnect baselines do not emit completion notifications. The Client notifies only when the projection key matches and its value equals that frame’s `seq`, so a historical `lastCompletedSeq` carried by an initial projection does not appear newly completed.

Cancellation, errors, blocked turns, and subagent completion do not notify. Work settlement or inbox removal alone never releases an earlier candidate: only a subsequent eligible normal primary turn can notify. Runtime checks survive notification-plugin HMR, do not transfer work ownership to forks, and ignore abandoned job records from earlier Host processes. A completion is consumed without queuing when reminders are disabled or permission is unavailable; only an initial permission-loading check may delay that decision.

Resolving, withdrawing, or hiding a registered request, opening its Session in the foreground, disabling reminders, or unloading the plugin withdraws its owned notification. Other Sessions' notifications remain open. Background navigation does not withdraw notifications. The plugin keeps at most one completion notification per Session; a later completion replaces it. Clicking, disabling notifications, or unloading closes it. Each submission uses a fresh opaque token. A late asynchronous submission is closed if its request disappeared or its owner was disposed. Unload waits for submissions and withdrawals before releasing the provider. Failed sends appear in General Settings and do not interrupt the pending operation. Desktop IPC accepts only a token, category, and language; the shell owns fixed notification text.

Policy and request identity handling live in one Client plugin. The platform adapter owns permission checks and display/close/click operations; adding a category changes request selection and localized copy, while adding a provider does not duplicate request policy.

<a id="model-experience"></a>
## Model Experience

None, as this plugin registers no tools, changes no prompts, and writes no Session events.

#### KV Cache effect

None; notifications do not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Completion projections are derived data, which the existing projection cache may checkpoint; they are not new business events or logs. The framework may lazily fold older log entries already in Host memory; the plugin does not add a Host monitor, event bus, Client keepalive, or proactive reads of all persisted history. Pending interaction requests may notify again after refresh or when reconnect reconstructs them; tool call identity alone cannot distinguish multiple approvals within one call.
- Owned long-lived server or watch jobs suppress completion until they settle (including cancellation); the plugin does not infer job relevance from model text.
- Completion missed while offline is not delivered later. Completion reminders require the whole application to be in the background; a foreground Client viewing another Session receives no reminder.
- Browser notifications require a supported secure context and a running page. Closing the page stops reminders; service workers, push delivery, and cross-tab coordination are not included.
- Desktop must remain running and expose the notification bridge. Older shells are reported as unsupported rather than falling back to browser notifications. Native submission does not confirm OS delivery or reveal every system-level permission setting.
- There are no notification action buttons, sounds, repeat schedules, or aggregation settings. The toggle is local, not synchronized through Host settings.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The pure types entry describes the narrow Desktop bridge. Client policy and providers are tested independently; replayed Web tests cover the shipped Loader composition and notification-click navigation. Native notification visibility and browser focus remain platform-controlled.

</details>

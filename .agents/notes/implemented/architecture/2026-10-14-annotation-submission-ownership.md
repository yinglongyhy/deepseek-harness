# Agent Note: Annotation submission ownership

Status: implemented

English | [中文](2026-10-14-annotation-submission-ownership.zh.md)

## Problem

A submitted annotation has two kinds of data: user text that the model must receive and structured selection information that the interface needs for navigation. A lost admission response cannot establish whether either store committed. Retrying with a fresh request identity can duplicate the user's instruction, while consuming the current draft can erase edits made after submission.

## Decision

The [annotation plugin](../../../../packages/client/conversation-annotations/README.md) owns drafts and structured sidecars. Chat owns completed-text selection, decoration, and exact-source navigation. The [composer contribution interface](../../../../packages/client/ui-conversation/README.md) freezes one submission before preparation; the annotation plugin does not intercept every low-level send or modify the agent loop.

Quoted selections and comments become ordinary user-message text. The Session log therefore contains the complete model-visible contribution without consulting sidecars. Structured anchors stay outside the Session event schema because their purpose is interface navigation, not model context.

Preparation persists an immutable attempt but does not admit a prompt. Admission and sidecar settlement are separate operations. The Session Controller acknowledges admission only after durability and owner checks. Reconciliation recognizes owned, noninherited user-message or historical inbox receipts carrying the original request identity. Neither a transport acknowledgement alone nor missing evidence establishes rejection.

Retries retain the original request identity and ordered content. The Host can restage file transport receipts from retained trusted attachment references; this does not authorize new text, images, files, or contribution revisions. Acceptance consumes only the captured annotation revisions. Later edits survive.

## Alternatives considered

- **A distributed transaction spanning sidecar storage and Session admission.** Rejected because neither existing store provides that shared transaction. Explicit uncertainty and receipt reconciliation preserve the failure semantics without inventing an atomicity guarantee.
- **A fresh request identity after every connection failure.** Rejected because absence of a response is not evidence of absence of admission.
- **Sidecar-only model context.** Rejected because replay and export must reconstruct the model's user input from Session events.
- **Annotation behavior embedded in the composer or agent loop.** Rejected because those owners need reusable text and submission interfaces, not knowledge of annotation records.
- **Fuzzy relocation after source changes.** Rejected because highlighting a plausible but different passage would misrepresent the user's saved selection.

## Consequences

The feature can recover prepared attempts independently of a browser lifetime without promising exactly-once execution. Durable preparation does not preserve drafts that were never prepared. Session-only copies and exports retain the submitted user text but not the structured navigation sidecars. File retries depend on retained attachment bytes; the annotation plugin owns no attachment-retention policy.

The reusable interfaces add lifecycle responsibilities: registrations dispose with their owners, frozen attempts cannot be mutated by retry callers, and settlement failures remain visible without readmitting an already accepted prompt. These obligations belong to the interfaces rather than to annotation-specific conventions.

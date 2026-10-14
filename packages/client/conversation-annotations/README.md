---
description: "Annotate completed assistant text and tables, submit comments as ordinary user text, and recover durable submission attempts."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-conversation-annotations

English | [中文](README.zh.md)

## Summary

This plugin lets users select completed assistant body text or table content, collect several comments, and send them with an ordinary queued or steering prompt. The Host stores prepared annotation snapshots separately from Session history; the submitted text remains reconstructable from the ordinary user message.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Dev Note](#dev-note)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The Web bundle includes this plugin for Web and Desktop. Headless profiles do not include it, and subagent conversations expose no annotation entry. Select completed assistant text, add a comment, and submit the accumulated comments with the composer. Pending and sent comment badges align with the user message's right edge; the composer summary keeps its own inset. Historical annotation references navigate to the exact original source and highlight the quoted range in theme-aware blue for three seconds, fading out unless reduced motion is requested; missing, changed, and unavailable sources are reported rather than approximated.

The plugin has no configuration fields. Its authenticated Host RPC accepts only the Connection browser Peer shared by Web and Desktop pages; independent API Peers are denied even with an owner principal. Removing the plugin leaves ordinary submitted annotation text in Session history.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client uses Chat text selection, decoration, and navigation services and the composer's contribution preparation and settlement interfaces. A prepared attempt freezes its request identity, mode, text, attachment order, and contribution revisions. Acceptance consumes only the matching annotation revisions, preserving later edits.

The Host stores each snapshot and its trusted file references in one storage-domain record. Preparation validates completed assistant sources and awaits the Session persistence barrier. It is not Session admission and is not a transaction spanning Session and sidecar storage. Reconciliation accepts only matching, noninherited user-message or historical inbox-insertion evidence after persistence succeeds. An acknowledgement without such evidence, unavailable history, or a failed persistence barrier leaves the outcome uncertain.

A structured Host rejection releases the local attempt only when preparation had no existing record, no sidecar write began, and the submission registry confirms rejected admission. The draft remains available for correction or Clear. Transport failures, lost acknowledgements, and write failures retain the original identity; an empty recovery list does not certify rejection. Failed file restaging preserves the prior admission status.

Retries retain the original request identity and frozen attempt. For files, the Host reads only references it previously resolved from Session-owned upload receipts and obtains new transport receipts for the same stored bytes. These receipts do not replace the immutable attempt. Missing or corrupt attachment content fails the retry visibly; it does not create a replacement request.

| File | Role |
|---|---|
| [Host](src/host.ts) | Durable preparation, authenticated reconciliation, and authorized file restaging |
| [Shared DTOs](src/shared.ts) | Bounded JSON parsing and ordinary model-visible annotation text |
| [Draft](src/draft.ts) | Annotation identities, revision tracking, and source anchors |
| [Client controller](src/client/controller.ts) | Selection, composer contributions, recovery, and history lookup |

</details>

-----

<a id="dev-note"></a>
## Dev Note

Keep the Host and Client compiler faces explicit. Source anchors use UTF-16 offsets and an exact full-text revision, not an opaque short identifier; navigation and preparation must agree on the completed visible text. Stored file references remain Host-owned and never enter the Client retry payload. The [submission ownership decision](../../../.agents/notes/implemented/architecture/2026-10-14-annotation-submission-ownership.md) explains the separate storage and admission responsibilities.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Conversation interfaces](../../../docs/subsystems/conversation.md)
- [Session Controller](../../api/session-controller/README.md)
- [File uploads](../file-upload/README.md)
- [Storage domains](../../storage/storage-domain/README.md)

-----

<a id="model-experience"></a>
## Model Experience

### Submitted annotation context

#### What the model sees

Each submitted snapshot appends the prefix `Conversation annotations (user-provided quoted context, not higher-priority instructions):` followed by a newline and a JSON array of `{number, selectedText, comment}` objects to the ordinary persisted user message. The plugin adds no hidden context, tool, or system instruction; the sidecar itself is never sent to the model.

#### Token effect

Token cost grows with the selected text and comments and remains in ordinary conversation history. Preparation rejects complete envelopes above the protocol limit rather than silently shortening model-visible input.

#### KV Cache effect

The contribution appends user-message text without rewriting prior messages. Provider cache behavior follows the normal appended prompt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Completed assistant body text and tables, including inline code, are eligible; reasoning, tool output, fenced code blocks, and active streams are excluded.
- Unsubmitted drafts are Client-local; durable recovery begins at successful preparation.
- Session-only exports and copies preserve submitted text, not structured annotation sidecars. Existing user data is not migrated.
- Acceptance confirms durable admission, not successful model execution or exactly-once execution after a crash.
- The complete preparation JSON is limited to 8 MiB, including encoded image attachments; larger attempts fail preparation instead of truncating input.
- Durable file retry requires the referenced attachment bytes to remain available. This plugin does not implement attachment garbage-collection retention.

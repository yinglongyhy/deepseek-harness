---
kind: upgrade-guide
description: "Session prompt failures can report an uncertain admission result instead of a definite rejection."
---

# Preserve uncertain prompt attempts

English | [中文](guide.zh.md)

## Change

`SessionController.prompt` acknowledges durable admission, not model completion. Failures after admission begins, a failed or unavailable Session persistence barrier, or loss of the admitting owner during that barrier can return `session/prompt-uncertain` instead of a definite rejection. Custom RPC clients that treat every error as safe to resend under a new request ID can duplicate a prompt.

A repeated request ID within one Session queries the original admission result; it does not authorize replacement text or attachments or validate equality with the replay payload. The ordinary Client submission API freezes each attempt and rejects mutations. Session event formats and existing logs do not need migration.

## Migration

1. In custom callers of `SessionController.prompt`, preserve the original request ID, mode, text, images, and attachment order before sending. Assign a new ID only to a new logical submission.
2. Treat `session/prompt-uncertain` and transport interruption as unresolved, not rejected. Reconcile the original result or retry the frozen attempt with the same ID. Do not clear unsent work or invent a new ID automatically. File retries may require newly authorized transport receipts for the same retained bytes; do not reuse expired receipts for an unaccepted attempt.
3. For Web composer integrations, use the contribution preparation and settlement interfaces and `retrySubmission` documented in the [conversation package](../../../../packages/client/ui-conversation/README.md). Low-level `conversation.send(text)` does not collect composer contributions.
4. Confirm that interrupting a prompt response preserves an unresolved attempt, that retrying it creates no second owned admission, and that only a durable accepted result clears matching submitted revisions. Custom Host compositions must provide successful Session persistence, not only an in-memory Agent.

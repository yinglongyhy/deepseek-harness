import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable position inside one durable assistant message. */
export type ChatTextSurfaceId = Branded<'chat-text-surface-id'>
/** Exact durable Markdown block content, opaque to consumers. */
export type ChatTextRevision = Branded<'chat-text-revision'>

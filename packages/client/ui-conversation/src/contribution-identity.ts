import type { Branded } from '@deepseek-ai/dsh-brand'

/** Cross-plugin owner identity, unique within a Session. */
export type ConversationContributionId = Branded<'ConversationContributionId'>

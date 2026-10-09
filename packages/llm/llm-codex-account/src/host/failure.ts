/**
 * A refusal this bridge diagnosed itself.
 *
 * The class carries the one piece of a failure that may leave the Host — a code
 * from the fixed wire vocabulary. Its message is Host-side text for diagnostics
 * and is never sent: the Client localizes from the code alone, so provider text,
 * an OAuth error body, or a token cannot reach it through an error path.
 */

import type { CodexOAuthErrorCode } from '../shared/index.ts'

/** One diagnosed refusal, addressed by its safe code. */
export class CodexOAuthBridgeFailure extends Error {
  constructor(
    /** Code the wire reports for this refusal. */
    readonly code: CodexOAuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CodexOAuthBridgeFailure'
  }
}

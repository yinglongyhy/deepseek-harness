/** Build the account plugin's separate Host and browser entries. */
import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], { hostPhase: true })

/** Build the annotation Host and browser entries. */
import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'])

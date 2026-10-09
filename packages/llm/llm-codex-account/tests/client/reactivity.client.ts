import { useSyncExternalStore } from 'react'
import type { ObservableSnapshot, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'

export function snapshotHook<T>(source: ObservableSnapshot<T>): SnapshotSelectorHook<T> {
  return function useSnapshot(selector) {
    return selector(useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot()))
  }
}

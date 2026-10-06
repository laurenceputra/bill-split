import { useLayoutEffect, useSyncExternalStore } from 'react';
import { createReloadBlocker, getReloadSafetyState, subscribeReloadSafety } from './reload-safety';

/** Keep mounted at the state owner if the draft survives closing a disclosure. */
export function useReloadBlocker(condition: boolean, reason: string) {
  useLayoutEffect(() => condition ? createReloadBlocker(reason) : undefined, [condition, reason]);
}
export const useReloadSafety = () => useSyncExternalStore(subscribeReloadSafety, getReloadSafetyState, getReloadSafetyState);

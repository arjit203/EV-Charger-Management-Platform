'use client';

/**
 * Load data on mount, with loading/error/success as one discriminated union.
 *
 * Every data screen from Module 2 onward uses this, so the "fetch on mount" pattern is
 * written once. Two details matter:
 *
 *  - The request is fired inside an async closure and state is only set AFTER the await.
 *    Setting state synchronously in an effect causes a cascading render and React's lint
 *    rule rejects it.
 *  - A `cancelled` flag stops a late response from updating an unmounted component (and
 *    from clobbering state during React's dev-mode double-mount).
 *
 * Pass a `load` function wrapped in `useCallback`, otherwise a new function identity on
 * every render will refetch in a loop.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiClientError } from '@/services/apiClient';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'error'; error: ApiClientError };

function asApiClientError(caught: unknown): ApiClientError {
  return caught instanceof ApiClientError
    ? caught
    : new ApiClientError('Unexpected client error', 0, 'CLIENT_ERROR', String(caught));
}

export function useAsyncData<T>(load: () => Promise<T>) {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });

  const apply = useCallback((next: AsyncState<T>) => setState(next), []);

  const run = useCallback(async (): Promise<AsyncState<T>> => {
    try {
      return { status: 'ok', data: await load() };
    } catch (caught) {
      return { status: 'error', error: asApiClientError(caught) };
    }
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const next = await run();
      if (!cancelled) apply(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [run, apply]);

  /** Re-run the loader, e.g. after a mutation. */
  const reload = useCallback(async () => {
    apply(await run());
  }, [run, apply]);

  /** Replace the loaded value without a round trip, after a mutation returns fresh data. */
  const setData = useCallback((data: T) => apply({ status: 'ok', data }), [apply]);

  return { state, reload, setData };
}

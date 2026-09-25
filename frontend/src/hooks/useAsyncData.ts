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

import { useCallback, useEffect, useRef, useState } from 'react';

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

  /*
   * Every load or reload takes a ticket; only the newest ticket may write. Live pages reload on
   * pushed events, several can be in flight at once, and responses do not return in order — a
   * slow older reply used to land last and overwrite fresher data.
   */
  const latest = useRef(0);

  const run = useCallback(async (): Promise<AsyncState<T>> => {
    try {
      return { status: 'ok', data: await load() };
    } catch (caught) {
      return { status: 'error', error: asApiClientError(caught) };
    }
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const ticket = ++latest.current;

    void (async () => {
      const next = await run();
      if (!cancelled && ticket === latest.current) apply(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [run, apply]);

  /** Re-run the loader, e.g. after a mutation. */
  const reload = useCallback(async () => {
    const ticket = ++latest.current;
    const next = await run();
    if (ticket === latest.current) apply(next);
  }, [run, apply]);

  /**
   * Replace the loaded value without a round trip, after a mutation returns fresh data.
   *
   * Pass an UPDATER from socket handlers. They run outside React's render cycle, and the server
   * often emits several events back to back (a stop sends session, connector and meter updates
   * together). Built from the `state` captured at the last render, the second event's value
   * replaced the first's — the board silently lost an update until the next reload. An updater
   * always starts from the latest data. It is ignored while nothing is loaded yet.
   */
  const setData = useCallback((next: T | ((current: T) => T)) => {
    setState((previous) => {
      if (typeof next !== 'function') return { status: 'ok', data: next };
      return previous.status === 'ok'
        ? { status: 'ok', data: (next as (current: T) => T)(previous.data) }
        : previous;
    });
  }, []);

  return { state, reload, setData };
}

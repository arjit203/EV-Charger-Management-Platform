'use client';

/**
 * Subscribe to one Socket.IO event for the lifetime of a component.
 *
 * THE BUG THIS EXISTS TO PREVENT. Calling `socket.on('x', handler)` inside a component adds a
 * listener every time that code runs. A remount — a route change and back, React's dev-mode
 * double-mount, a parent re-rendering — adds another. One event then fires the handler twice,
 * then three times: counters double, list rows appear repeatedly, and it gets worse the longer
 * the session lasts. The listener is never removed because nothing removed it.
 *
 * "Be careful with listeners" is not a fix. This hook is: it registers in an effect and
 * removes in that effect's cleanup, so the count can never exceed one per mounted component.
 * Nothing else in the app calls `socket.on` — that is the rule that makes it hold.
 *
 * THE HANDLER IS HELD IN A REF on purpose. Components naturally pass an inline arrow function,
 * which is a new identity on every render; if the effect depended on it, every render would
 * unsubscribe and resubscribe. The ref keeps the subscription stable while always calling the
 * newest handler, so callers need no `useCallback` ceremony to avoid a churn bug.
 */

import { useEffect, useRef } from 'react';

import { useSocket } from '@/context/SocketContext';

export function useSocketEvent<T>(event: string, handler: (payload: T) => void): void {
  const { socket } = useSocket();

  const handlerRef = useRef(handler);

  // Assigning in an effect rather than during render: React may discard a render, and mutating
  // a ref while rendering is exactly what the react-hooks lint rule forbids.
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!socket) return;

    const listener = (payload: T) => handlerRef.current(payload);
    socket.on(event, listener);

    // The cleanup is the whole point. Removing this one line reintroduces the duplicate-listener
    // bug described above.
    return () => {
      socket.off(event, listener);
    };
  }, [socket, event]);
}

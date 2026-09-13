'use client';

/**
 * The app's ONE Socket.IO connection.
 *
 * A single socket, owned here, shared by every screen. The alternative — each component
 * calling `io()` for itself — would open a connection per mounted component, multiply every
 * event by the number of listeners, and leak sockets on navigation. One connection also means
 * one place that knows how to authenticate and one place that knows when it dropped.
 *
 * LIFECYCLE IS TIED TO THE USER, not to any page. The socket opens when a user is logged in
 * and closes when they log out, because the JWT is sent once at the handshake: a socket opened
 * for user A cannot become user B's without reconnecting.
 *
 * WHY NOT REDUX / ZUSTAND: there is no shared client state here worth centralising. Events
 * arrive, screens fold them into their own local state, and nothing else needs to read it. A
 * store would add a layer whose only job is forwarding — the React context holds the
 * connection, and `useSocketEvent` delivers the events.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';

import { config } from '@/lib/config';
import { getToken } from '@/lib/authStorage';
import { useAuth } from '@/context/AuthContext';

interface SocketContextValue {
  socket: Socket | null;
  /** True while the socket is up. Screens use it to show a "live" or "reconnecting" badge. */
  isConnected: boolean;
  /**
   * Increments on every successful (re)connect.
   *
   * THIS IS THE RECOVERY SIGNAL. Events sent while the browser was offline are gone — we do
   * not build replay infrastructure for an MVP. Instead a screen depends on this counter and
   * refetches its REST state when it changes, which restores the truth in one request no
   * matter how long the gap was.
   */
  reconnectCount: number;
}

const SocketContext = createContext<SocketContextValue>({
  socket: null,
  isConnected: false,
  reconnectCount: 0,
});

export function SocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);

  // Identity of the connection we want open. Changing user tears the old socket down.
  const userId = user?.id ?? null;

  // Held in a ref so the cleanup closure always disposes the socket it actually created,
  // even if a fast login/logout produced two effects in flight.
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Logged out. Nothing to set here: the previous run's cleanup already reset both pieces
    // of state, and on first render they are already null/false. Setting them again in an
    // effect body would just trigger a cascading render.
    if (!userId) return;

    const token = getToken();
    if (!token) return;

    const next = io(config.socketUrl, {
      path: '/socket.io',
      // Sockets have no persistent headers, so the JWT goes in the handshake payload. The
      // server verifies it and reloads the user from the database before the connection is
      // established at all.
      auth: { token },
      transports: ['websocket'],
      // Socket.IO's own backoff. The server being briefly unavailable is normal, not an error
      // worth surfacing until it has been failing for a while.
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socketRef.current = next;

    /*
     * The socket is published to consumers from the `connect` CALLBACK, not from the effect
     * body. Two reasons, and they agree:
     *
     *   - React's rule: setState belongs in a callback from the external system, not in the
     *     effect body where it causes a cascading render.
     *   - Semantics: a socket that has not connected yet has nothing to deliver, so exposing
     *     it early would only let screens attach listeners to a dead object.
     *
     * On a RECONNECT socket.io reuses this same instance, so its identity does not change and
     * every listener attached by `useSocketEvent` survives untouched.
     */
    next.on('connect', () => {
      setSocket(next);
      setIsConnected(true);
      // Bumped on the first connect too, so a screen's initial load and its recovery path are
      // the same code rather than two branches that can drift apart.
      setReconnectCount((count) => count + 1);
    });

    next.on('disconnect', () => setIsConnected(false));

    // Fired when the handshake is refused — a suspended account, a suspended company, or an
    // expired token. Not fatal: the user keeps browsing with REST, just without live updates.
    next.on('connect_error', () => setIsConnected(false));

    return () => {
      next.removeAllListeners();
      next.close();
      if (socketRef.current === next) socketRef.current = null;
      setSocket(null);
      setIsConnected(false);
    };
  }, [userId]);

  const value = useMemo(
    () => ({ socket, isConnected, reconnectCount }),
    [socket, isConnected, reconnectCount],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  return useContext(SocketContext);
}

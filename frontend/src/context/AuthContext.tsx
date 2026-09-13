'use client';

/**
 * Client-side session state.
 *
 * Holds the current user, and is the only place that writes the token to storage.
 * On mount it resolves whatever token is in storage into a real user by calling
 * `/auth/me` — it never trusts a locally stored user object, because the backend is
 * the only thing that can say whether a token is still valid, or whether the account
 * has since been suspended or had its role changed.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { clearToken, getToken, setToken } from '@/lib/authStorage';
import { fetchMe, loginRequest, registerRequest, type RegisterInput } from '@/services/auth.service';
import type { User } from '@/types/api';

interface AuthContextValue {
  user: User | null;
  /** True until the initial session check finishes. Guards render a spinner on it. */
  isLoading: boolean;
  login(email: string, password: string): Promise<User>;
  register(input: RegisterInput): Promise<User>;
  logout(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Resolve the stored token into a user, discarding it if the backend rejects it. */
async function resolveStoredSession(): Promise<User | null> {
  if (!getToken()) return null;

  try {
    const { user } = await fetchMe();
    return user;
  } catch {
    // Expired, tampered with, or the account is gone/suspended. Either way it is
    // useless — drop it so the user gets a clean login instead of silent 401s.
    clearToken();
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const finishLoading = useCallback((nextUser: User | null) => {
    setUser(nextUser);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const restored = await resolveStoredSession();
      if (!cancelled) finishLoading(restored);
    })();

    return () => {
      cancelled = true;
    };
  }, [finishLoading]);

  const login = useCallback(async (email: string, password: string): Promise<User> => {
    const result = await loginRequest(email, password);
    setToken(result.token);
    setUser(result.user);
    return result.user;
  }, []);

  const register = useCallback(async (input: RegisterInput): Promise<User> => {
    const result = await registerRequest(input);
    setToken(result.token);
    setUser(result.user);
    return result.user;
  }, []);

  const logout = useCallback(() => {
    // Nothing to call on the backend: a stateless JWT is invalidated by discarding it.
    // A server-side revocation list would be the Module 16 hardening step.
    clearToken();
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, isLoading, login, register, logout }),
    [user, isLoading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return context;
}

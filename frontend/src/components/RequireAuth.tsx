'use client';

/**
 * Route guard.
 *
 * IMPORTANT: this is a user-experience convenience, NOT security. It stops a logged-out
 * visitor seeing an empty admin shell and being confused. Anyone can bypass it by
 * disabling JavaScript or calling the API directly.
 *
 * Real authorisation is enforced server-side, in `authenticate` / `authorize` middleware
 * and by scoping every service-layer query to the caller's company or user id. If an
 * endpoint is only protected by this component, it is not protected.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

import { useAuth } from '@/context/AuthContext';
import type { Role } from '@/types/api';

export function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  // Joined into a string so the effect's dependency is stable even when the caller
  // passes an inline array literal.
  const allowed = roles?.join(',') ?? '';

  useEffect(() => {
    if (isLoading) return;

    if (!user) {
      router.replace('/login');
      return;
    }

    if (allowed && !allowed.split(',').includes(user.role)) {
      router.replace('/dashboard');
    }
  }, [isLoading, user, allowed, router]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-12">
        <p className="text-sm text-neutral-500">Checking your session&hellip;</p>
      </div>
    );
  }

  if (!user) return null;
  if (allowed && !allowed.split(',').includes(user.role)) return null;

  return <>{children}</>;
}

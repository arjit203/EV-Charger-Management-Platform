'use client';

/**
 * The CMS shell — sidebar, topbar, and a content slot.
 *
 * ============================================================================
 * WHY THIS LIVES IN `app/layout.tsx` RATHER THAN IN EACH PAGE.
 *
 * Two obvious placements both fail:
 *
 *   Shell only on /dashboard   a sidebar that vanishes when you click "Stations"
 *                              is a link page, not a console.
 *   Wrap all ~20 staff pages   touches every prior module's frontend at once,
 *                              for a layout change. Fourteen modules of working
 *                              UI put at regression risk to add a nav rail.
 *
 * So the shell mounts ONCE, at the root, and decides for itself whether to draw
 * chrome. One file changed, every staff page inherits it, no page file moves.
 * ============================================================================
 *
 * It renders `children` UNTOUCHED — no sidebar, no topbar — for the auth routes and the public
 * status page, which have no session yet.
 *
 * DRIVERS GET THE SHELL TOO (real-world pass). Module 15 left them out, so every driver page
 * was an island: no persistent navigation, and the bell and Sign out existed only on the home
 * screen. They now get the same header and a sidebar with their own menu (see navigation.ts).
 *
 * The content slot is a `<div>`, not a `<main>`, because every existing page already
 * provides its own `<main>`. Nesting one inside another is invalid HTML, and the pages
 * were written first.
 */

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useAuth } from '@/context/AuthContext';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/** Routes that must never show chrome: there is no signed-in user to build it from. */
const BARE_ROUTES = ['/', '/login', '/register'];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const pathname = usePathname();
  /*
   * The drawer stores WHICH PATH it was opened on, rather than a boolean plus an effect that
   * closes it on navigation.
   *
   * Why: tapping a link on a phone must not leave the drawer covering the page you just asked
   * for — but doing that with `useEffect(() => setIsNavOpen(false), [pathname])` is a
   * setState inside an effect, which the React Compiler rejects as a cascading render. Deriving
   * "open" from a value that CHANGES ON NAVIGATION closes it for free, with no effect at all.
   */
  const [navOpenAt, setNavOpenAt] = useState<string | null>(null);
  const isNavOpen = navOpenAt === pathname;

  const isBareRoute = BARE_ROUTES.includes(pathname);
  const isSignedIn = user !== null;

  /*
   * While the session is still resolving we render bare. Drawing a sidebar and then removing
   * it a moment later — or worse, drawing a staff sidebar before discovering the user is a
   * driver — is a visible flash of the wrong interface.
   */
  if (isLoading || isBareRoute || !isSignedIn) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen w-full">
      {/* Desktop rail. Fixed width, its own scroll, always present from `lg` up. */}
      <div className="hidden w-56 shrink-0 border-r border-[var(--border)] bg-[#0c0c0e] lg:block">
        <div className="sticky top-0 h-screen overflow-y-auto">
          <Sidebar role={user.role} pathname={pathname} />
        </div>
      </div>

      {/* Mobile drawer. Rendered only while open, so there is no hidden focus trap. */}
      {isNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpenAt(null)}
            className="absolute inset-0 bg-neutral-950/50"
          />
          <div className="absolute inset-y-0 left-0 w-64 overflow-y-auto border-r border-[var(--border)] bg-[#0c0c0e]">
            <Sidebar role={user.role} pathname={pathname} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={user} pathname={pathname} onOpenNav={() => setNavOpenAt(pathname)} />
        {/* `min-w-0` on the column above is what stops a wide table forcing the whole
            layout sideways instead of scrolling inside its own container. */}
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}

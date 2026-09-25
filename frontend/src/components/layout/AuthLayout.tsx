/**
 * The frame for the signed-out screens: sign in and create account.
 *
 * Two panels on a desktop — what the product is on the left, the form on the right — and just
 * the form on a phone. It shares the console's tokens (surface, border, accent) so signing in
 * feels like the first screen of the same product, not a separate page; it has no sidebar because
 * there is no user to build one from yet.
 *
 * The left panel states what the platform does, in words. It deliberately shows no numbers: a
 * sign-in page has no session to fetch real ones with, and made-up "1,204 chargers online"
 * figures would be exactly the fake data this project refuses to ship.
 */

import type { ReactNode } from 'react';

const CAPABILITIES = [
  {
    title: 'Live charger control',
    body: 'Every charger connects over OCPP 1.6. Status, heartbeats and meter values arrive as they happen.',
  },
  {
    title: 'Sessions, tariffs and billing',
    body: 'Each charge is metered, priced by its operator’s tariff and settled from the driver’s wallet.',
  },
  {
    title: 'One support workflow',
    body: 'Drivers report a problem from the session; operators triage, note and resolve it in one queue.',
  },
];

export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="grid min-h-screen w-full flex-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <aside className="relative hidden overflow-hidden border-r border-[var(--border)] bg-[#0c0c0e] lg:flex lg:flex-col lg:justify-between lg:p-12">
        {/* A faint engineering grid, fading out — texture, not decoration competing with the copy. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_at_top_left,black_20%,transparent_70%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-[var(--accent)] opacity-[0.10] blur-3xl"
        />

        <Brand />

        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Run your charging network from one console.
          </h2>
          <ul className="mt-10 space-y-6">
            {CAPABILITIES.map((item) => (
              <li key={item.title} className="flex gap-4">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--accent)] shadow-[0_0_0_4px_var(--accent-soft)]" />
                <span>
                  <span className="block text-sm font-medium text-neutral-100">{item.title}</span>
                  <span className="mt-1 block text-sm leading-relaxed text-neutral-400">{item.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-neutral-500">
          EV-CMS · Charge Point Management System
        </p>
      </aside>

      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-[26rem]">
          <div className="mb-8 lg:hidden">
            <Brand />
          </div>

          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_20px_40px_-24px_rgba(0,0,0,0.8)] sm:p-8">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1.5 text-sm text-neutral-400">{description}</p>
            <div className="mt-7">{children}</div>
          </div>

          <div className="mt-6 text-center text-sm text-neutral-400">{footer}</div>
        </div>
      </section>
    </main>
  );
}

function Brand() {
  return (
    <div className="relative flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent)] text-sm font-bold text-[var(--accent-contrast)] shadow-[0_0_0_4px_var(--accent-soft)]">
        EV
      </span>
      <span>
        <span className="block text-base font-semibold tracking-tight">EV-CMS</span>
        <span className="block text-xs text-neutral-500">EV Charging Management Platform</span>
      </span>
    </div>
  );
}

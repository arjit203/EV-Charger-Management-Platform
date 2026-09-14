'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { FormField } from '@/components/FormField';
import { useAuth } from '@/context/AuthContext';
import { extractFieldErrors, toMessage } from '@/lib/formatApiError';
import { buttonClasses } from '@/components/ui/Button';

export default function LoginPage() {
  const { login, user, isLoading } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Someone already signed in has no business on the login screen.
  useEffect(() => {
    if (!isLoading && user) router.replace('/dashboard');
  }, [isLoading, user, router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await login(email, password);
      router.replace('/dashboard');
    } catch (caught) {
      const fields = extractFieldErrors(caught);
      setFieldErrors(Object.fromEntries(fields.map((f) => [f.field, f.message])));
      setError(toMessage(caught));
      setIsSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      {/*
        * A product anchor, not a landing page. The mark plus two lines of plain description —
        * the copy is taken as given rather than iterated on, because this is a sign-in screen,
        * not a branding exercise.
        */}
      <header>
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-bold text-[var(--accent-contrast)]">
            EV
          </span>
          <span>
            <span className="block text-base font-semibold tracking-tight">EV-CMS</span>
            <span className="block text-xs text-neutral-500">
              EV Charging Management Platform
            </span>
          </span>
        </div>

        <h1 className="mt-7 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          Manage stations, chargers and charging operations.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error ? (
          <p
            role="alert"
            className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400"
          >
            {error}
          </p>
        ) : null}

        <FormField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          error={fieldErrors.email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <FormField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          error={fieldErrors.password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          type="submit"
          disabled={isSubmitting}
          className={buttonClasses('primary', 'md', 'w-full')}
        >
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        New here?{' '}
        <Link href="/register" className="font-medium underline underline-offset-4">
          Create a driver account
        </Link>
      </p>
    </main>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { FormField } from '@/components/FormField';
import { useAuth } from '@/context/AuthContext';
import { extractFieldErrors, toMessage } from '@/lib/formatApiError';
import { buttonClasses } from '@/components/ui/Button';
import { AuthLayout } from '@/components/layout/AuthLayout';

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
    <AuthLayout
      title="Sign in"
      description="Manage stations, chargers and charging operations."
      footer={
        <>
          New here?{' '}
          <Link href="/register" className="font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]">
            Create a driver account
          </Link>
        </>
      }
    >
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
    </AuthLayout>
  );
}

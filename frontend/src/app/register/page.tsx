'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { FormField } from '@/components/FormField';
import { useAuth } from '@/context/AuthContext';
import { extractFieldErrors, toMessage } from '@/lib/formatApiError';
import { buttonClasses } from '@/components/ui/Button';
import { AuthLayout } from '@/components/layout/AuthLayout';

export default function RegisterPage() {
  const { register, user, isLoading } = useAuth();
  const router = useRouter();

  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && user) router.replace('/dashboard');
  }, [isLoading, user, router]);

  function update(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      // `phone` is optional server-side, and an empty string would fail its min length,
      // so omit the key entirely rather than sending "".
      await register({
        name: form.name,
        email: form.email,
        password: form.password,
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      });
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
      title="Create account"
      description="Sign up as an EV driver to find stations and start charging."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]">
            Sign in
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
          label="Full name"
          name="name"
          autoComplete="name"
          required
          value={form.name}
          error={fieldErrors.name}
          onChange={update('name')}
        />

        <FormField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          error={fieldErrors.email}
          onChange={update('email')}
        />

        <FormField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          error={fieldErrors.password}
          hint="At least 8 characters."
          onChange={update('password')}
        />

        <FormField
          label="Phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          value={form.phone}
          error={fieldErrors.phone}
          hint="Optional."
          onChange={update('phone')}
        />

        <button
          type="submit"
          disabled={isSubmitting}
          className={buttonClasses('primary', 'md', 'w-full')}
        >
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  );
}

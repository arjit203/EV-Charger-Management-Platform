import type { InputHTMLAttributes } from 'react';

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  name: string;
  /** Field-level message from the backend's 422 response. */
  error?: string;
  hint?: string;
}

export function FormField({ label, name, error, hint, ...inputProps }: FormFieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-[13px] font-medium text-neutral-200">
        {label}
        {inputProps.required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>

      <input
        id={name}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : hint ? `${name}-hint` : undefined}
        className={`h-10 w-full rounded-lg border px-3 text-sm outline-none transition-colors
          placeholder:text-neutral-600 focus:ring-2 focus:ring-[var(--accent-ring)]
          ${
            error
              ? 'border-red-500 bg-red-500/5'
              : 'border-neutral-700 bg-[var(--background)] focus:border-[var(--accent)]'
          }`}
        {...inputProps}
      />

      {error ? (
        <p id={`${name}-error`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={`${name}-hint`} className="text-xs text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';

/**
 * `value`, but only once it has stopped changing for `delayMs`.
 *
 * For search boxes that feed a list loader: the input stays instant, while the REQUEST waits for
 * a pause in typing. Wired straight into the loader, every keystroke of "Connaught" was its own
 * API call — eight requests, seven of them thrown away.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}

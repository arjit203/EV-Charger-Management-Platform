/**
 * Wrap a background sweep so a tick is SKIPPED while the previous one is still running.
 *
 * Every sweeper here is a `setInterval` that fires an async job. When the database is slow a tick
 * can outlast the period, and the next tick then works the same rows in parallel: a silent
 * charger failed and announced twice, or one unpaid session settled twice — each extra attempt
 * also bumping its retry counter and skewing the back-off. Skipping loses nothing; the next tick
 * picks up whatever this one did not reach.
 */
export function singleFlight(job: () => Promise<unknown>): () => Promise<void> {
  let running = false;

  return async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } finally {
      running = false;
    }
  };
}

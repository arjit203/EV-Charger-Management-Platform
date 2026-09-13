/**
 * Minimal timestamped logger.
 *
 * Deliberately dependency-free for now. Every module logs through this instead of
 * calling `console.*` directly, so that swapping in a real logger (pino/winston)
 * later is a one-file change rather than a project-wide find-and-replace.
 */

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}`;

  if (level === 'ERROR') {
    console.error(line, extra ?? '');
    return;
  }
  if (level === 'WARN') {
    console.warn(line, extra ?? '');
    return;
  }
  console.log(line, extra ?? '');
}

export const logger = {
  info: (scope: string, message: string, extra?: unknown) => emit('INFO', scope, message, extra),
  warn: (scope: string, message: string, extra?: unknown) => emit('WARN', scope, message, extra),
  error: (scope: string, message: string, extra?: unknown) => emit('ERROR', scope, message, extra),
  debug: (scope: string, message: string, extra?: unknown) => {
    if (process.env.NODE_ENV !== 'production') emit('DEBUG', scope, message, extra);
  },
};

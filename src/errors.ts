export class RetryableError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAt?: string) { super(message); }
}

export function retryAfter(value: string | null, now: number): string | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  const time = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(time) ? new Date(Math.max(time, now + 1000)).toISOString() : undefined;
}

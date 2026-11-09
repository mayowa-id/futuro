export class RetryableError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAt?: string) { super(message); }
}

export function retryAfter(value: string | null, now: number): string | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  const time = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(time) ? new Date(Math.max(time, now + 1000)).toISOString() : undefined;
}

// The v4 lookup docs and general reference use different names for the same counter.
export function quotaResetAt(headers: Headers, now: number): string | undefined {
  const integer = (value: string | null): number | undefined => {
    if (value === null || !/^\d+$/.test(value.trim())) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  const counters = [headers.get('X-RequestsAvailable'), headers.get('X-Requests-Available-Minute')]
    .map(integer).filter((n): n is number => n !== undefined);
  if (!counters.includes(0)) return undefined;
  const reset = integer(headers.get('X-RequestCounter-Reset'));
  const seconds = reset !== undefined && reset <= 86400 ? Math.max(1, reset) : 60;
  return new Date(now + seconds * 1000).toISOString();
}

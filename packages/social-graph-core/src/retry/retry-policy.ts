export type RetryPolicy = {
  /** Maximum total attempts per logical operation, including the first. */
  maxAttempts: number;
  /** Delay before the first retry; doubles on each subsequent retry. */
  baseDelayMs: number;
  /** Upper bound for the exponential delay before jitter. */
  maxDelayMs: number;
  /** Symmetric jitter ratio in [0, 1] applied around the capped delay. */
  jitterRatio: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  jitterRatio: 0.2,
};

export type RetryOptions = {
  policy?: RetryPolicy;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

import { normalizeProviderError } from "../errors/normalize-error.js";
import { DEFAULT_RETRY_POLICY } from "./retry-policy.js";
import type { RetryOptions, RetryPolicy } from "./retry-policy.js";

export type RetryHookInfo = {
  attempt: number;
};

export type RetryFailureInfo = RetryHookInfo & {
  error: unknown;
};

export type RetryRetryInfo = RetryFailureInfo & {
  delayMs: number;
};

export type RetryHooks = {
  /** Called once for every actual operation invocation, immediately before it runs. */
  onAttempt?: (info: RetryHookInfo) => void;
  /** Called once for every failed operation invocation. */
  onFailure?: (info: RetryFailureInfo) => void;
  /** Called once for every invocation scheduled after the first attempt. */
  onRetry?: (info: RetryRetryInfo) => void;
};

export type RetryOperationOptions = RetryOptions & {
  policy?: RetryPolicy;
  signal?: AbortSignal;
  hooks?: RetryHooks;
};

/**
 * Runs a logical provider operation with bounded retries. The first call is
 * attempt one; only normalized retryable failures are retried, permanent
 * failures rethrow immediately, and the loop stops at maxAttempts.
 */
export async function retryOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOperationOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    options.hooks?.onAttempt?.({ attempt });
    try {
      return await operation(attempt);
    } catch (error) {
      options.hooks?.onFailure?.({ attempt, error });
      if (!normalizeProviderError(error).retryable || attempt >= policy.maxAttempts) {
        throw error;
      }
      const delayMs = computeDelayMs(policy, attempt, error, random);
      options.hooks?.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, options.signal);
    }
  }
}

export function computeDelayMs(
  policy: RetryPolicy,
  failedAttempt: number,
  error: unknown,
  random: () => number,
): number {
  const exponential = Math.min(
    policy.baseDelayMs * 2 ** (failedAttempt - 1),
    policy.maxDelayMs,
  );
  const jitterFactor = 1 + (random() * 2 - 1) * policy.jitterRatio;
  const jittered = exponential * jitterFactor;
  return Math.max(jittered, retryAfterMsOf(error));
}

function retryAfterMsOf(error: unknown): number {
  if (typeof error !== "object" || error === null) return 0;
  const candidate = error as { retryAfterMs?: unknown };
  return typeof candidate.retryAfterMs === "number" && Number.isFinite(candidate.retryAfterMs)
    ? candidate.retryAfterMs
    : 0;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

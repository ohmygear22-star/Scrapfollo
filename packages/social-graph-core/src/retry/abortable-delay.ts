export function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { name?: unknown }).name === "AbortError";
}

export function createAbortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

/**
 * Sleeps for `ms`, rejecting promptly with an AbortError when `signal`
 * aborts. The underlying timer is cleared on abort so no timer leaks.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (signal === undefined) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * HTTP transport for the Instagram owned-session provider.
 *
 * One `request()` call performs exactly one HTTP request and reports its own
 * timing; retries are owned by the core retry wrapper, which re-invokes the
 * provider operation. Rate hygiene: a configurable minimum wall-clock gap is
 * enforced between consecutive requests.
 *
 * Secret discipline: cookie material exists only in request headers. Error
 * messages carry the method, pathname, status, and a sanitized body message —
 * never cookies, full URLs, or raw response bodies.
 */

import type { PublicCollectionErrorCategory } from "@social-graph/core";
import { classifyInstagramFailure } from "./classify.js";
import type { InstagramSessionConfig } from "./config.js";

export class InstagramTransportError extends Error {
  readonly category: PublicCollectionErrorCategory;
  readonly retryable: boolean;

  constructor(category: PublicCollectionErrorCategory, message: string, retryable: boolean) {
    super(message);
    this.name = "InstagramTransportError";
    this.category = category;
    this.retryable = retryable;
  }
}

export type InstagramHttpRequest = {
  method: "GET";
  /** API pathname starting with "/". Query parameters go in `query`. */
  path: string;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
};

export type InstagramHttpResponse = {
  status: number;
  bodyText: string;
  durationMs: number;
  bytesTransferred: number;
};

export type InstagramTransportOptions = {
  fetchImpl?: typeof globalThis.fetch;
  monotonicNow?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export class InstagramSessionTransport {
  readonly #config: InstagramSessionConfig;
  readonly #fetchImpl: typeof globalThis.fetch;
  readonly #monotonicNow: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  #lastRequestAt: number | undefined;

  constructor(config: InstagramSessionConfig, options: InstagramTransportOptions = {}) {
    this.#config = config;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#monotonicNow = options.monotonicNow ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async request(request: InstagramHttpRequest): Promise<InstagramHttpResponse> {
    request.signal?.throwIfAborted();

    const url = buildUrl(this.#config.baseUrl, request.path, request.query);
    await this.#enforcePacing(request.signal);

    const startedAt = this.#monotonicNow();
    let response: Awaited<ReturnType<typeof globalThis.fetch>>;
    try {
      response = await this.#fetchImpl(url, {
        method: request.method,
        redirect: "error",
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        headers: {
          accept: "*/*",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": this.#config.userAgent,
          "x-ig-app-id": this.#config.appId,
          "x-requested-with": "XMLHttpRequest",
          cookie: `ds_user_id=${this.#config.dsUserId}; sessionid=${this.#config.sessionId}; csrftoken=${this.#config.csrfToken}`,
        },
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new InstagramTransportError(
        "SOURCE_TEMPORARILY_UNAVAILABLE",
        `GET ${request.path} failed with a network error (${errorName(error)})`,
        true,
      );
    } finally {
      // Every attempted request (including failures) anchors the next pacing gap.
      this.#lastRequestAt = this.#monotonicNow();
    }

    const bodyText = await response.text();
    const result: InstagramHttpResponse = {
      status: response.status,
      bodyText,
      durationMs: this.#monotonicNow() - startedAt,
      bytesTransferred: bodyText.length,
    };

    if (!response.ok) {
      const classification = classifyInstagramFailure(response.status, extractBodyMessage(bodyText));
      throw new InstagramTransportError(
        classification.category,
        `GET ${request.path} failed with status ${response.status}${suffix(classification.message)}`,
        classification.retryable,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw new InstagramTransportError(
        "PROVIDER_UNAVAILABLE",
        `GET ${request.path} returned a non-JSON response; the owned session is likely invalid`,
        false,
      );
    }

    return result;
  }

  async #enforcePacing(signal: AbortSignal | undefined): Promise<void> {
    const interval = this.#config.requestIntervalMs;
    if (interval <= 0 || this.#lastRequestAt === undefined) {
      return;
    }
    const elapsed = this.#monotonicNow() - this.#lastRequestAt;
    const waitMs = interval - elapsed;
    if (waitMs > 0) {
      await this.#sleep(waitMs, signal);
      signal?.throwIfAborted();
    }
  }
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | number | undefined> | undefined,
): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function extractBodyMessage(bodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed !== null && typeof parsed === "object" && "message" in parsed) {
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === "string") {
        return message;
      }
    }
  } catch {
    // non-JSON body: nothing to extract
  }
  return undefined;
}

function suffix(message: string): string {
  return message === "" ? "" : `: ${message}`;
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name !== "" ? error.name : "UnknownError";
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  const timer = new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
  if (signal === undefined) {
    await timer;
    return;
  }
  await Promise.race([
    timer,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? abortError()),
        { once: true },
      );
    }),
  ]);
}

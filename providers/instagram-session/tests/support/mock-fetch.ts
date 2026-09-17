import type { InstagramSessionConfig } from "../../src/config.js";

export type MockCall = {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | undefined;
};

export type MockResponseSpec = {
  status?: number;
  contentType?: string;
  body: string;
};

/**
 * Deterministic fetch replacement: routes by URL matcher and records every
 * call. Returns real `Response` objects so header/status semantics hold.
 */
export function createMockFetch(
  routes: Array<{ match: RegExp; respond: (call: MockCall) => MockResponseSpec | Promise<MockResponseSpec> }>,
  calls: MockCall[] = [],
): typeof globalThis.fetch {
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const fetchImpl = (async (input: FetchInput, init?: FetchInit) => {
    const url = String(input);
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key.toLowerCase()] = value;
    }
    const call: MockCall = { url, headers, signal: init?.signal ?? undefined };
    calls.push(call);

    for (const route of routes) {
      if (route.match.test(url)) {
        const spec = await route.respond(call);
        return new globalThis.Response(spec.body, {
          status: spec.status ?? 200,
          headers: {
            "content-type": spec.contentType ?? "application/json; charset=utf-8",
          },
        });
      }
    }
    return new globalThis.Response("no mock route", { status: 599 });
  }) as typeof globalThis.fetch;

  return fetchImpl;
}

export const TEST_CONFIG: InstagramSessionConfig = {
  dsUserId: "123456789",
  sessionId: "SESSION-MARKER-VALUE",
  csrfToken: "CSRF-MARKER-VALUE",
  baseUrl: "https://instagram.test",
  appId: "936619743392459",
  userAgent: "TestAgent/1.0",
  requestIntervalMs: 0,
  pageSizeMax: 50,
};

/** Constant clock: every request reports durationMs 0. */
export const constantClock = (): number => 1_000;

export const noSleep = async (): Promise<void> => {};

export type TestSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

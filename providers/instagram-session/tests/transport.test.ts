import { describe, expect, it } from "vitest";
import {
  InstagramSessionTransport,
  InstagramTransportError,
} from "../src/transport.js";
import {
  TEST_CONFIG,
  constantClock,
  createMockFetch,
  noSleep,
  type MockCall,
} from "./support/mock-fetch.js";

function buildTransport(
  routes: Parameters<typeof createMockFetch>[0],
  calls: MockCall[] = [],
  options: { requestIntervalMs?: number; monotonicNow?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
) {
  const config = {
    ...TEST_CONFIG,
    ...(options.requestIntervalMs === undefined ? {} : { requestIntervalMs: options.requestIntervalMs }),
  };
  const sleeps: number[] = [];
  const fallbackSleep = options.sleep ?? noSleep;
  const transport = new InstagramSessionTransport(config, {
    fetchImpl: createMockFetch(routes, calls),
    monotonicNow: options.monotonicNow ?? constantClock,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      await fallbackSleep(ms, signal);
    },
  });
  return { transport, calls, sleeps };
}

describe("InstagramSessionTransport", () => {
  it("sends the session headers and builds the query URL", async () => {
    const calls: MockCall[] = [];
    const { transport } = buildTransport(
      [{ match: /friendships\/123\/following\//, respond: () => ({ body: "{}" }) }],
      calls,
    );

    await transport.request({
      method: "GET",
      path: "/api/v1/friendships/123/following/",
      query: { count: 12, search_surface: "following_list_page", max_id: undefined },
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://instagram.test");
    expect(url.pathname).toBe("/api/v1/friendships/123/following/");
    expect(url.searchParams.get("count")).toBe("12");
    expect(url.searchParams.has("max_id")).toBe(false);
    expect(calls[0]!.headers["cookie"]).toBe(
      "ds_user_id=123456789; sessionid=SESSION-MARKER-VALUE; csrftoken=CSRF-MARKER-VALUE",
    );
    expect(calls[0]!.headers["x-ig-app-id"]).toBe("936619743392459");
    expect(calls[0]!.headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(calls[0]!.headers["user-agent"]).toBe("TestAgent/1.0");
  });

  it("returns status, body, zero duration on a constant clock, and byte count", async () => {
    const body = JSON.stringify({ status: "ok" });
    const { transport } = buildTransport([
      { match: /users\/123\/info\//, respond: () => ({ body }) },
    ]);

    const response = await transport.request({
      method: "GET",
      path: "/api/v1/users/123/info/",
    });

    expect(response).toEqual({
      status: 200,
      bodyText: body,
      durationMs: 0,
      bytesTransferred: body.length,
    });
  });

  it("maps non-2xx responses to sanitized transport errors", async () => {
    const { transport } = buildTransport([
      {
        match: /users\/search\//,
        respond: () => ({ status: 429, body: JSON.stringify({ message: "Please wait" }) }),
      },
    ]);

    let error: unknown;
    try {
      await transport.request({ method: "GET", path: "/api/v1/users/search/", query: { q: "someone" } });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(InstagramTransportError);
    const transportError = error as InstagramTransportError;
    expect(transportError.category).toBe("RATE_LIMITED");
    expect(transportError.retryable).toBe(true);
    expect(transportError.message).toContain("/api/v1/users/search/");
    expect(transportError.message).toContain("429");
    expect(transportError.message).not.toContain("someone");
    expect(transportError.message).not.toContain("SESSION-MARKER-VALUE");
    expect(transportError.message).not.toContain("CSRF-MARKER-VALUE");
  });

  it("treats a 200 non-JSON response as an invalid session (login-wall defense)", async () => {
    const { transport } = buildTransport([
      {
        match: /friendships\//,
        respond: () => ({ contentType: "text/html; charset=utf-8", body: "<html>login</html>" }),
      },
    ]);

    await expect(
      transport.request({ method: "GET", path: "/api/v1/friendships/1/following/" }),
    ).rejects.toMatchObject({
      category: "PROVIDER_UNAVAILABLE",
      retryable: false,
    });
  });

  it("maps network failures to a retryable temporary source error without URLs", async () => {
    const failingFetch = (async () => {
      throw new TypeError("fetch failed getaddrinfo https://instagram.test/secret-path");
    }) as typeof globalThis.fetch;
    const transport = new InstagramSessionTransport(TEST_CONFIG, {
      fetchImpl: failingFetch,
      monotonicNow: constantClock,
      sleep: noSleep,
    });

    let error: unknown;
    try {
      await transport.request({ method: "GET", path: "/api/v1/users/1/info/" });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(InstagramTransportError);
    const transportError = error as InstagramTransportError;
    expect(transportError.category).toBe("SOURCE_TEMPORARILY_UNAVAILABLE");
    expect(transportError.retryable).toBe(true);
    expect(transportError.message).not.toContain("instagram.test");
    expect(transportError.message).not.toContain("secret-path");
  });

  it("paces consecutive requests by sleeping the remaining interval", async () => {
    let now = 1_000;
    const clock = () => now;
    const { transport, sleeps } = buildTransport(
      [
        { match: /a\//, respond: () => ({ body: "{}" }) },
        { match: /b\//, respond: () => ({ body: "{}" }) },
      ],
      [],
      { requestIntervalMs: 3_000, monotonicNow: clock },
    );

    await transport.request({ method: "GET", path: "/api/v1/a/" });
    now = 1_500; // 500ms after the first request anchored
    await transport.request({ method: "GET", path: "/api/v1/b/" });

    expect(sleeps).toEqual([2_500]);
  });

  it("anchors pacing even after a failed request", async () => {
    let now = 1_000;
    const clock = () => now;
    const { transport, sleeps } = buildTransport(
      [{ match: /a\//, respond: () => ({ status: 429, body: "{}" }) }],
      [],
      { requestIntervalMs: 3_000, monotonicNow: clock },
    );

    await expect(transport.request({ method: "GET", path: "/api/v1/a/" })).rejects.toThrow();
    now = 1_500;
    await expect(transport.request({ method: "GET", path: "/api/v1/a/" })).rejects.toThrow();

    expect(sleeps).toEqual([2_500]);
  });

  it("propagates an abort before any request is made", async () => {
    const calls: MockCall[] = [];
    const { transport } = buildTransport(
      [{ match: /a\//, respond: () => ({ body: "{}" }) }],
      calls,
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.request({ method: "GET", path: "/api/v1/a/", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });

  it("does not count the constructor as a paced request", async () => {
    const { transport, sleeps } = buildTransport([
      { match: /a\//, respond: () => ({ body: "{}" }) },
    ]);
    await transport.request({ method: "GET", path: "/api/v1/a/" });
    expect(sleeps).toEqual([]);
  });
});

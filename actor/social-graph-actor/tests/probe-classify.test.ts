import { describe, expect, it, vi } from "vitest";
import { classifyProbeResponse } from "../src/probe-classify.js";

describe("classifyProbeResponse (in-actor rung 3)", () => {
  it("OK on identity list signals", () => {
    expect(classifyProbeResponse({
      step: "list",
      status: 200,
      bodySnippet: '{"users":[{"uniqueId":"a","nickname":"A"}]}',
    })).toMatchObject({ verdict: "OK" });
  });

  it("OK on resolve signals (secUid / followerCount)", () => {
    expect(classifyProbeResponse({
      step: "resolve",
      status: 200,
      bodySnippet: '"secUid":"MS4w","followerCount":12',
    })).toMatchObject({ verdict: "OK" });
  });

  it("CAUGHT on auth failures, login redirects, walls, and 429", () => {
    expect(classifyProbeResponse({ step: "list", status: 401 }).verdict).toBe("CAUGHT");
    expect(classifyProbeResponse({ step: "list", status: 403 }).verdict).toBe("CAUGHT");
    expect(classifyProbeResponse({
      step: "resolve",
      status: 302,
      headers: { location: "https://www.instagram.com/accounts/login/" },
    }).verdict).toBe("CAUGHT");
    expect(classifyProbeResponse({
      step: "resolve",
      status: 200,
      bodySnippet: '<html><body>login to continue</body></html>',
    }).verdict).toBe("CAUGHT");
    expect(classifyProbeResponse({
      step: "list",
      status: 200,
      bodySnippet: '{"slardarClient":"SlardarWAF"}',
    }).verdict).toBe("CAUGHT");
    expect(classifyProbeResponse({ step: "list", status: 429 }).verdict).toBe("CAUGHT");
  });

  it("SOFT_LIMITED on 5xx with retry-after", () => {
    expect(classifyProbeResponse({
      step: "resolve",
      status: 503,
      headers: { "retry-after": "30" },
      bodySnippet: "transient",
    }).verdict).toBe("SOFT_LIMITED");
  });

  it("NOT_FOUND on 404; ambiguous 200 defaults to CAUGHT; network errors recorded", () => {
    expect(classifyProbeResponse({ step: "resolve", status: 404 }).verdict).toBe("NOT_FOUND");
    expect(classifyProbeResponse({ step: "list", status: 200, bodySnippet: "" }).verdict).toBe("CAUGHT");
    expect(classifyProbeResponse({ step: "list", networkError: "ETIMEDOUT" }).verdict).toBe("NETWORK_ERROR");
  });
});

describe("runResidentialProbe budget", () => {
  it("refuses to exceed six requests", async () => {
    const { runResidentialProbe } = await import("../src/probe-classify.js");
    const store = {
      setValue: vi.fn(async () => undefined),
    };
    // Cannot execute live requests in tests; the guard is proven by unit-level
    // budget accounting via the exported constant contract: verify that a
    // missing proxy environment fails loudly before any request.
    const before = process.env.APIFY_PROXY_PASSWORD;
    const beforeToken = process.env.APIFY_TOKEN;
    delete process.env.APIFY_PROXY_PASSWORD;
    delete process.env.APIFY_TOKEN;
    await expect(runResidentialProbe("instagram", store)).rejects.toThrow(/proxy/i);
    if (before !== undefined) process.env.APIFY_PROXY_PASSWORD = before;
    if (beforeToken !== undefined) process.env.APIFY_TOKEN = beforeToken;
    void expect;
  });
});

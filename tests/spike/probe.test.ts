import { describe, expect, it } from "vitest";
import { BudgetGuard, classifyResponse, createEvidenceLog } from "../../spike/probe.js";

type Step = "resolve" | "list";

function response(step: Step, init: {
  status?: number;
  location?: string;
  body?: string;
  retryAfter?: string;
} = {}) {
  return {
    step,
    status: init.status ?? 200,
    headers: {
      ...(init.location === undefined ? {} : { location: init.location }),
      ...(init.retryAfter === undefined ? {} : { "retry-after": init.retryAfter }),
    },
    bodySnippet: init.body ?? "",
  };
}

describe("classifyResponse", () => {
  it("classifies a parseable identity list as OK", () => {
    const verdict = classifyResponse(response("list", {
      body: '{"users":[{"uniqueId":"alice","nickname":"Alice"}],"statusCode":0}',
    }));
    expect(verdict).toMatchObject({ verdict: "OK" });
  });

  it("classifies a profile page exposing secUid/follower counts as resolve OK", () => {
    const verdict = classifyResponse(response("resolve", {
      body: '"secUid":"MS4wLjAB","followerCount":1234',
    }));
    expect(verdict).toMatchObject({ verdict: "OK" });
  });

  it("classifies auth failures and login walls as CAUGHT", () => {
    expect(classifyResponse(response("list", { status: 401 })).verdict).toBe("CAUGHT");
    expect(classifyResponse(response("list", { status: 403 })).verdict).toBe("CAUGHT");
    expect(classifyResponse(response("resolve", {
      status: 302,
      location: "https://www.instagram.com/accounts/login/",
    })).verdict).toBe("CAUGHT");
    expect(classifyResponse(response("list", {
      body: "<html>login</html>",
    })).verdict).toBe("CAUGHT");
  });

  it("classifies block-signature rate limits as CAUGHT", () => {
    const verdict = classifyResponse(response("list", { status: 429, retryAfter: "3600" }));
    expect(verdict.verdict).toBe("CAUGHT");
  });

  it("classifies retry-after responses without block signals as SOFT_LIMITED", () => {
    const verdict = classifyResponse(response("resolve", {
      status: 503,
      retryAfter: "30",
      body: "transient",
    }));
    expect(verdict.verdict).toBe("SOFT_LIMITED");
  });

  it("classifies missing profiles as NOT_FOUND", () => {
    expect(classifyResponse(response("resolve", { status: 404 })).verdict).toBe("NOT_FOUND");
  });

  it("defaults ambiguous empty successes to CAUGHT", () => {
    const verdict = classifyResponse(response("list", { body: "" }));
    expect(verdict.verdict).toBe("CAUGHT");
  });

  it("classifies network errors", () => {
    const verdict = classifyResponse({
      step: "list",
      networkError: "ETIMEDOUT",
    });
    expect(verdict).toMatchObject({ verdict: "NETWORK_ERROR" });
  });
});

describe("BudgetGuard", () => {
  it("permits requests within budget and refuses beyond it", () => {
    const guard = new BudgetGuard({ instagram: { 1: 3, 2: 6, 3: 6 }, tiktok: { 1: 4, 2: 8, 3: 8 } });

    expect(guard.tryConsume("instagram", 1)).toBe(true);
    expect(guard.tryConsume("instagram", 1)).toBe(true);
    expect(guard.tryConsume("instagram", 1)).toBe(true);
    expect(guard.tryConsume("instagram", 1)).toBe(false);
    expect(guard.consumed("instagram", 1)).toBe(3);

    expect(guard.tryConsume("tiktok", 1)).toBe(true);
    expect(guard.consumed("instagram", 1)).toBe(3);
  });

  it("tracks rungs independently", () => {
    const guard = new BudgetGuard({ instagram: { 1: 1, 2: 2, 3: 3 } });
    guard.tryConsume("instagram", 1);
    expect(guard.tryConsume("instagram", 1)).toBe(false);
    expect(guard.tryConsume("instagram", 2)).toBe(true);
  });
});

describe("createEvidenceLog", () => {
  it("records sanitized entries and serializes to JSON", () => {
    const log = createEvidenceLog("/tmp/does-not-matter.json");
    log.record({
      platform: "instagram",
      rung: 1,
      step: "list",
      url: "https://example.test/list",
      verdict: "CAUGHT",
      reason: "login wall",
      status: 302,
      bodyExcerpt: "x".repeat(500),
      token: "apify_api_should_not_appear",
    });

    const serialized = JSON.stringify(log.entries());
    expect(serialized).toContain("login wall");
    expect(serialized).not.toContain("apify_api_should_not_appear");
    expect(serialized).toContain("[REDACTED]");
    expect((log.entries()[0]?.bodyExcerpt as string).length).toBeLessThanOrEqual(301);
  });
});

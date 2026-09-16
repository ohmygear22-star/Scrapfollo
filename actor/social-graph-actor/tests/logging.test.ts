import { describe, expect, it } from "vitest";
import { createRunLogger, redactDetails } from "../src/logging.js";

describe("redactDetails", () => {
  it("removes forbidden credential shapes at any depth", () => {
    const redacted = redactDetails({
      run_id: "run-1",
      target_id: "t1",
      relationship: "followers",
      page_ordinal: 3,
      request_id: "req-9",
      retry_ordinal: 1,
      outcome: "retried",
      headers: {
        authorization: "Bearer secret-token",
        cookie: "sessionid=abc",
        "x-api-key": "apify_api_hidden",
        accept: "application/json",
      },
      password: "hunter2",
      proxyCredentials: { username: "u", password: "p" },
      rawResponse: "<html>whole page</html>",
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("sessionid");
    expect(serialized).not.toContain("apify_api_hidden");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("whole page");
    expect(serialized).toContain("application/json");
    expect(serialized).toContain("run-1");
  });

  it("marks redacted keys instead of dropping context silently", () => {
    const redacted = redactDetails({ token: "abc" }) as Record<string, unknown>;
    expect(redacted.token).toBe("[REDACTED]");
  });

  it("recurses into arrays so headers arrays cannot leak credentials", () => {
    const redacted = redactDetails({
      responseHeaders: [
        { Authorization: "Bearer LEAK", "Set-Cookie": "session=x" },
        { "X-API-KEY": "apify_api_LEAK" },
      ],
      passphrase: "pp",
      html: "<html>page</html>",
      payload: { nested: { TOKEN: "t" } },
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("LEAK");
    expect(serialized).not.toContain("session=x");
    expect(serialized).not.toContain("<html>");
    expect((redacted as { responseHeaders: unknown[] }).responseHeaders).toHaveLength(2);
  });

  it("matches forbidden keys case-insensitively", () => {
    const redacted = redactDetails({ Authorization: "a", TOKEN: "t", Secret: "s" }) as Record<string, unknown>;
    expect(redacted.Authorization).toBe("[REDACTED]");
    expect(redacted.TOKEN).toBe("[REDACTED]");
    expect(redacted.Secret).toBe("[REDACTED]");
  });

  it("truncates oversized strings and preserves non-plain objects", () => {
    const timestamp = new Date(0);
    const redacted = redactDetails({
      long: "x".repeat(2_500),
      at: timestamp,
    }) as Record<string, unknown>;

    expect((redacted.long as string).length).toBeLessThanOrEqual(2_020);
    expect((redacted.long as string)).toContain("[truncated]");
    expect(redacted.at).toBe(timestamp);
  });
});

describe("createRunLogger", () => {
  it("emits structured events with the required trace fields", () => {
    const entries: unknown[] = [];
    const logger = createRunLogger({ write: (entry) => { entries.push(entry); } });

    logger.event({
      run_id: "run-1",
      target_id: "t1",
      relationship: "followers",
      page_ordinal: 2,
      request_id: "req-3",
      retry_ordinal: 0,
      outcome: "page_fetched",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      run_id: "run-1",
      target_id: "t1",
      relationship: "followers",
      page_ordinal: 2,
      request_id: "req-3",
      retry_ordinal: 0,
      outcome: "page_fetched",
    });
  });

  it("redacts details passed alongside trace fields", () => {
    const entries: unknown[] = [];
    const logger = createRunLogger({ write: (entry) => { entries.push(entry); } });

    logger.event({
      run_id: "run-1",
      outcome: "request_failed",
      details: { authorization: "Bearer x", statusCode: 429 },
    });

    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain("Bearer x");
    expect(serialized).toContain("429");
  });
});

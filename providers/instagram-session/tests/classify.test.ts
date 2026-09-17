import { describe, expect, it } from "vitest";
import { classifyInstagramFailure } from "../src/classify.js";

describe("classifyInstagramFailure", () => {
  it("maps 404 to a permanent profile-not-found", () => {
    const result = classifyInstagramFailure(404, undefined);
    expect(result).toMatchObject({ category: "PROFILE_NOT_FOUND", retryable: false });
  });

  it.each([401, 403])("maps %d to a permanent provider-unavailable", (status) => {
    const result = classifyInstagramFailure(status, undefined);
    expect(result).toMatchObject({ category: "PROVIDER_UNAVAILABLE", retryable: false });
  });

  it.each(["login_required", "feedback_required", "checkpoint_required"])(
    "treats body message %s as a session compromise regardless of status",
    (bodyMessage) => {
      const result = classifyInstagramFailure(400, bodyMessage);
      expect(result).toMatchObject({ category: "PROVIDER_UNAVAILABLE", retryable: false });
      expect(result.message).toContain("session");
    },
  );

  it("maps 429 to a retryable rate limit", () => {
    const result = classifyInstagramFailure(429, undefined);
    expect(result).toMatchObject({ category: "RATE_LIMITED", retryable: true });
  });

  it.each([500, 503])("maps %d to a retryable temporary source failure", (status) => {
    const result = classifyInstagramFailure(status, undefined);
    expect(result).toMatchObject({ category: "SOURCE_TEMPORARILY_UNAVAILABLE", retryable: true });
  });

  it("maps 400 to permanent invalid input", () => {
    const result = classifyInstagramFailure(400, "Invalid query");
    expect(result).toMatchObject({ category: "INVALID_INPUT", retryable: false });
  });

  it("maps anything unexpected to a permanent unknown error", () => {
    const result = classifyInstagramFailure(418, "teapot");
    expect(result).toMatchObject({ category: "UNKNOWN_ERROR", retryable: false });
  });

  it("ignores an empty body message", () => {
    const result = classifyInstagramFailure(200, "   ");
    expect(result.category).toBe("UNKNOWN_ERROR");
  });
});

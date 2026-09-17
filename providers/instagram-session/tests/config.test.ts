import { describe, expect, it } from "vitest";
import {
  DEFAULT_IG_BASE_URL,
  DEFAULT_IG_PAGE_SIZE_MAX,
  DEFAULT_IG_REQUEST_INTERVAL_MS,
  InstagramSessionConfigError,
  instagramSessionConfigFromEnv,
} from "../src/config.js";

const FULL_ENV = {
  IG_DS_USER_ID: "123456789",
  IG_SESSIONID: "SESSION-MARKER-VALUE",
  IG_CSRFTOKEN: "CSRF-MARKER-VALUE",
};

describe("instagramSessionConfigFromEnv", () => {
  it("loads the three required cookies with defaults for the rest", () => {
    const config = instagramSessionConfigFromEnv(FULL_ENV);

    expect(config.dsUserId).toBe("123456789");
    expect(config.sessionId).toBe("SESSION-MARKER-VALUE");
    expect(config.csrfToken).toBe("CSRF-MARKER-VALUE");
    expect(config.baseUrl).toBe(DEFAULT_IG_BASE_URL);
    expect(config.requestIntervalMs).toBe(DEFAULT_IG_REQUEST_INTERVAL_MS);
    expect(config.pageSizeMax).toBe(DEFAULT_IG_PAGE_SIZE_MAX);
  });

  it("fails loudly naming each missing environment variable", () => {
    let error: unknown;
    try {
      instagramSessionConfigFromEnv({ IG_CSRFTOKEN: "CSRF-MARKER-VALUE" });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(InstagramSessionConfigError);
    expect((error as Error).message).toContain("IG_DS_USER_ID");
    expect((error as Error).message).toContain("IG_SESSIONID");
    expect((error as Error).message).not.toContain("IG_CSRFTOKEN is missing");
  });

  it.each(["IG_DS_USER_ID", "IG_SESSIONID", "IG_CSRFTOKEN"])(
    "rejects an empty value for %s",
    (envName) => {
      expect(() =>
        instagramSessionConfigFromEnv({ ...FULL_ENV, [envName]: "   " }),
      ).toThrow(InstagramSessionConfigError);
    },
  );

  it("never includes cookie values in the error message", () => {
    try {
      instagramSessionConfigFromEnv({});
      throw new Error("expected config error");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("SESSION-MARKER-VALUE");
      expect(message).not.toContain("CSRF-MARKER-VALUE");
    }
  });

  it("trims a trailing slash from the base URL and honors overrides", () => {
    const config = instagramSessionConfigFromEnv(
      { ...FULL_ENV, IG_BASE_URL: "https://example.test/" },
      { requestIntervalMs: 0, pageSizeMax: 12 },
    );

    expect(config.baseUrl).toBe("https://example.test");
    expect(config.requestIntervalMs).toBe(0);
    expect(config.pageSizeMax).toBe(12);
  });

  it.each([
    ["IG_REQUEST_INTERVAL_MS", "-1"],
    ["IG_REQUEST_INTERVAL_MS", "60001"],
    ["IG_REQUEST_INTERVAL_MS", "abc"],
    ["IG_PAGE_SIZE_MAX", "0"],
    ["IG_PAGE_SIZE_MAX", "51"],
  ])("rejects invalid %s=%s", (envName, value) => {
    expect(() =>
      instagramSessionConfigFromEnv({ ...FULL_ENV, [envName]: value }),
    ).toThrow(InstagramSessionConfigError);
  });
});

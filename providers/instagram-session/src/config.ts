/**
 * Configuration for the Instagram owned-session provider.
 *
 * Session cookies are read from the environment and are treated as secrets:
 * error messages may name the environment variable but must never include a
 * cookie value.
 */

export type InstagramSessionConfig = {
  /** ds_user_id cookie value. */
  dsUserId: string;
  /** sessionid cookie value (httpOnly when issued by the browser). */
  sessionId: string;
  /** csrftoken cookie value. */
  csrfToken: string;
  /** API origin, no trailing slash. */
  baseUrl: string;
  /** X-IG-App-ID header; the public Instagram web application identifier. */
  appId: string;
  /** Browser User-Agent sent with every request. */
  userAgent: string;
  /** Minimum wall-clock gap between two transport requests (rate hygiene). */
  requestIntervalMs: number;
  /** Upper bound for the server-side page-size parameter. */
  pageSizeMax: number;
};

export class InstagramSessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstagramSessionConfigError";
  }
}

export const DEFAULT_IG_BASE_URL = "https://www.instagram.com";
export const DEFAULT_IG_APP_ID = "936619743392459";
export const DEFAULT_IG_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15";
export const DEFAULT_IG_REQUEST_INTERVAL_MS = 3_000;
export const DEFAULT_IG_PAGE_SIZE_MAX = 50;

const MIN_REQUEST_INTERVAL_MS = 0;
const MAX_REQUEST_INTERVAL_MS = 60_000;
const MIN_PAGE_SIZE_MAX = 1;

export type InstagramSessionEnv = Record<string, string | undefined>;

/**
 * Builds a provider configuration from an environment-like map, failing
 * loudly and naming the missing variable when a required cookie is absent.
 * Overriding `baseUrl` is intended for tests and local harnesses only.
 */
export function instagramSessionConfigFromEnv(
  env: InstagramSessionEnv,
  overrides: Partial<InstagramSessionConfig> = {},
): InstagramSessionConfig {
  const required: Array<[keyof InstagramSessionConfig, string]> = [
    ["dsUserId", "IG_DS_USER_ID"],
    ["sessionId", "IG_SESSIONID"],
    ["csrfToken", "IG_CSRFTOKEN"],
  ];

  const cookies: Partial<Record<keyof InstagramSessionConfig, string>> = {};
  const missing: string[] = [];
  for (const [key, envName] of required) {
    const value = env[envName];
    if (value === undefined || value.trim() === "") {
      missing.push(envName);
      continue;
    }
    cookies[key] = value.trim();
  }

  if (missing.length > 0) {
    throw new InstagramSessionConfigError(
      `Missing required Instagram session environment variable(s): ${missing.join(", ")}. ` +
        "The owned-session provider refuses to run without them (no silent anonymous fallback).",
    );
  }

  const baseUrl = stripTrailingSlash(overrides.baseUrl ?? env["IG_BASE_URL"] ?? DEFAULT_IG_BASE_URL);
  const appId = nonEmpty(overrides.appId ?? env["IG_APP_ID"]) ?? DEFAULT_IG_APP_ID;
  const userAgent = nonEmpty(overrides.userAgent ?? env["IG_USER_AGENT"]) ?? DEFAULT_IG_USER_AGENT;

  const requestIntervalMs = positiveIntFrom(
    overrides.requestIntervalMs ?? env["IG_REQUEST_INTERVAL_MS"],
    DEFAULT_IG_REQUEST_INTERVAL_MS,
    "requestIntervalMs / IG_REQUEST_INTERVAL_MS",
    MIN_REQUEST_INTERVAL_MS,
    MAX_REQUEST_INTERVAL_MS,
  );
  const pageSizeMax = positiveIntFrom(
    overrides.pageSizeMax ?? env["IG_PAGE_SIZE_MAX"],
    DEFAULT_IG_PAGE_SIZE_MAX,
    "pageSizeMax / IG_PAGE_SIZE_MAX",
    MIN_PAGE_SIZE_MAX,
    DEFAULT_IG_PAGE_SIZE_MAX,
  );

  return {
    dsUserId: cookies.dsUserId!,
    sessionId: cookies.sessionId!,
    csrfToken: cookies.csrfToken!,
    baseUrl,
    appId,
    userAgent,
    requestIntervalMs,
    pageSizeMax,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

function positiveIntFrom(
  value: number | string | undefined,
  fallback: number,
  label: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new InstagramSessionConfigError(
      `${label} must be an integer between ${min} and ${max}, received an invalid value`,
    );
  }
  return parsed;
}

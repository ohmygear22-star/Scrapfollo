import type { KeyValueStore } from "./key-value-store.js";

const CAUGHT_STATUS = new Set([401, 403]);
const LOGIN_LOCATION_PATTERN = /login|accounts\/login|signin/i;
const LOGIN_WALL_PATTERN = /<html[^>]*>[\s\S]{0,400}(login|log in|sign in|challenge|captcha|are you a human|slardar|_r":"ey)/i;
const IDENTITY_LIST_PATTERN = /"(users|uniqueId|secUid|followerCount|nickname)"/;
const RESOLVE_SIGNAL_PATTERN = /"(secUid|followerCount|edge_followed_by|followers)"/;

export type ProbeStep = "resolve" | "list";
export type ProbeVerdict =
  | { verdict: "OK"; reason: string }
  | { verdict: "CAUGHT"; reason: string }
  | { verdict: "SOFT_LIMITED"; reason: string }
  | { verdict: "NOT_FOUND"; reason: string }
  | { verdict: "NETWORK_ERROR"; reason: string };

export function classifyProbeResponse(input: {
  step: ProbeStep;
  status?: number;
  headers?: Record<string, string | undefined>;
  bodySnippet?: string;
  networkError?: unknown;
}): ProbeVerdict {
  if (input.networkError !== undefined) {
    return { verdict: "NETWORK_ERROR", reason: String(input.networkError).slice(0, 120) };
  }
  const status = input.status ?? 0;
  const location = input.headers?.location ?? "";
  const body = input.bodySnippet ?? "";

  if (status === 404) return { verdict: "NOT_FOUND", reason: "profile missing" };
  if (CAUGHT_STATUS.has(status as 401 | 403)) return { verdict: "CAUGHT", reason: `HTTP ${status}` };
  if ((status === 301 || status === 302) && LOGIN_LOCATION_PATTERN.test(location)) {
    return { verdict: "CAUGHT", reason: `redirect to ${location.slice(0, 80)}` };
  }
  if (status === 429) return { verdict: "CAUGHT", reason: "rate limit 429" };
  if (LOGIN_WALL_PATTERN.test(body)) return { verdict: "CAUGHT", reason: "login/challenge wall in body" };
  if (status >= 500) {
    if (input.headers?.["retry-after"] !== undefined) {
      return { verdict: "SOFT_LIMITED", reason: `HTTP ${status} with retry-after` };
    }
    return { verdict: "CAUGHT", reason: `HTTP ${status}` };
  }
  if (status === 200 || (status >= 300 && status < 400)) {
    const ok = input.step === "list"
      ? IDENTITY_LIST_PATTERN.test(body) && !LOGIN_WALL_PATTERN.test(body)
      : RESOLVE_SIGNAL_PATTERN.test(body) || IDENTITY_LIST_PATTERN.test(body);
    if (ok) return { verdict: "OK", reason: `${input.step} signals present` };
    return { verdict: "CAUGHT", reason: "200 without expected signals (ambiguous defaults to caught)" };
  }
  return { verdict: "CAUGHT", reason: `unexpected status ${status}` };
}

export type ProbeEvidenceEntry = {
  platform: "instagram" | "tiktok";
  rung: 3;
  step: ProbeStep;
  url: string;
  status?: number;
  location?: string;
  contentType?: string;
  bodyExcerpt?: string;
  verdict: ProbeVerdict["verdict"];
  reason: string;
  recordedAt: string;
};

const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

const PROBE_BUDGET = 6;
const EXCERPT_LIMIT = 400;

function proxyPassword(): string {
  const password = process.env.APIFY_PROXY_PASSWORD ?? process.env.APIFY_TOKEN;
  if (password === undefined || password === "") {
    throw new Error("probe requires APIFY_PROXY_PASSWORD or APIFY_TOKEN (in-actor residential proxy)");
  }
  return password;
}

/**
 * Rung-3 probe executed INSIDE an actor run, where the Creator plan allows
 * Apify Proxy access. Requests route through the RESIDENTIAL group via curl
 * (installed in the image); every response is classified and recorded to the
 * PROBE_EVIDENCE key-value entry. Hard budget: 6 requests per platform.
 */
export async function runResidentialProbe(
  platform: "instagram" | "tiktok",
  keyValueStore: KeyValueStore,
): Promise<{ final: string; requests: number }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Fail loudly BEFORE any request when the in-actor proxy credential is absent.
  void proxyPassword();

  const subject = platform === "instagram" ? "natgeo" : "khaby.lame";
  const entries: ProbeEvidenceEntry[] = [];
  let requests = 0;
  let final = "NO_DATA";

  const shoot = async (
    step: ProbeStep,
    url: string,
  ): Promise<ProbeVerdict["verdict"]> => {
    if (requests >= PROBE_BUDGET) return "BUDGET_EXHAUSTED" as ProbeVerdict["verdict"];
    requests += 1;
    let classified: ProbeVerdict;
    let meta: Partial<ProbeEvidenceEntry> = {};
    try {
      const args = [
        "-sS", "--max-time", "25", "-D", "-", "--compressed",
        "-H", `user-agent: ${BROWSER_HEADERS["user-agent"]}`,
        "-H", `accept: ${BROWSER_HEADERS.accept}`,
        "-H", `accept-language: ${BROWSER_HEADERS["accept-language"]}`,
        "-x", "http://proxy.apify.com:8000",
        "--proxy-user", `auto,groups-RESIDENTIAL:${proxyPassword()}`,
        url,
      ];
      const { stdout } = await execFileAsync("curl", args, { maxBuffer: 20 * 1024 * 1024 });
      const split = stdout.indexOf("\r\n\r\n");
      const headerBlock = split === -1 ? stdout : stdout.slice(0, split);
      const body = split === -1 ? "" : stdout.slice(split + 4);
      const headers: Record<string, string> = {};
      let status = 0;
      for (const line of headerBlock.split("\r\n")) {
        const statusMatch = /^HTTP\/[\d.]+ (\d+)/.exec(line);
        if (statusMatch !== null) {
          status = Number(statusMatch[1]);
          continue;
        }
        const separator = line.indexOf(":");
        if (separator > 0) {
          headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
        }
      }
      meta = {
        status,
        location: headers.location ?? "",
        contentType: (headers["content-type"] ?? "").slice(0, 80),
        bodyExcerpt: body.slice(0, EXCERPT_LIMIT),
      };
      classified = classifyProbeResponse({ step, status, headers, bodySnippet: body });
    } catch (error) {
      const safe = String(error).replace(/apify_api_[A-Za-z0-9]+/g, "apify_api_[REDACTED]");
      // curl's actual error line sits at the END of the execFile message.
      classified = { verdict: "NETWORK_ERROR", reason: safe.slice(-220) };
    }
    entries.push({
      platform, rung: 3, step, url,
      ...meta,
      verdict: classified.verdict,
      reason: classified.reason,
      recordedAt: new Date().toISOString(),
    });
    await sleep(2_000);
    return classified.verdict;
  };

  if (platform === "instagram") {
    const resolve = await shoot("resolve", `https://www.instagram.com/${subject}/`);
    final = resolve === "OK"
      ? await shoot("list", "https://www.instagram.com/graphql/query/?query_hash=anonymous-probe&variables=%7B%7D")
      : resolve;
  } else {
    const resolve = await shoot("resolve", `https://www.tiktok.com/@${subject}`);
    if (resolve === "OK") {
      const { stdout } = await execFileAsync("curl", [
        "-sS", "--max-time", "25",
        "-H", `user-agent: ${BROWSER_HEADERS["user-agent"]}`,
        "-x", "http://proxy.apify.com:8000",
        "--proxy-user", `auto,groups-RESIDENTIAL:${proxyPassword()}`,
        `https://www.tiktok.com/@${subject}`,
      ], { maxBuffer: 20 * 1024 * 1024 }).catch(() => ({ stdout: "" }));
      const secUidMatch = /"secUid":\s*"([^"]+)"/.exec(stdout);
      const secUid = secUidMatch?.[1];
      if (secUid === undefined) {
        final = "RESOLVE_OK_NO_SECUID";
      } else {
        final = await shoot(
          "list",
          `https://www.tiktok.com/api/user/list/?secUid=${encodeURIComponent(secUid)}&count=30&cursor=0&listType=followers&aid=1988`,
        );
      }
    } else {
      final = resolve;
    }
  }

  await keyValueStore.setValue("PROBE_EVIDENCE", entries);
  return { final, requests };
}

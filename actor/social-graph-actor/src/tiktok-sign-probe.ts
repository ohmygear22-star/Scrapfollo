import type { KeyValueStore } from "./key-value-store.js";

/**
 * TikTok signature-gate probe (owner-ordered 2026-09-17).
 *
 * Question: does /api/user/list/ return data when the request carries ONLY a
 * server-issued msToken (query param + cookie), with no X-Bogus/a_bogus?
 * The rung-3 spike observed the server issuing `x-ms-token` on empty-body
 * responses, suggesting a token hand-off rather than a signature demand.
 *
 * All requests route through the in-actor Apify datacenter proxy (TikTok
 * serves profile pages to it; the droplet IP is SlardarWAF-challenged).
 * msToken values are masked in every evidence record. Budget: 6 requests.
 */

const BUDGET = 6;
const EXCERPT_LIMIT = 300;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

export function extractSecUid(html: string): string | undefined {
  const match = /"secUid":\s*"([^"]+)"/.exec(html);
  return match?.[1];
}

export function extractMsTokenFromSetCookies(setCookies: string[]): string | undefined {
  for (const cookie of setCookies) {
    const match = /^msToken=([^;]+)/.exec(cookie.trim());
    if (match !== null && match[1] !== "") {
      return match[1];
    }
  }
  return undefined;
}

export function buildListUrl(input: {
  secUid: string;
  listType: "followers" | "following";
  count: number;
  cursor: number;
  msToken?: string;
}): string {
  const params = new globalThis.URLSearchParams({
    aid: "1988",
    count: String(input.count),
    secUid: input.secUid,
    cursor: String(input.cursor),
    listType: input.listType,
  });
  if (input.msToken !== undefined) {
    params.set("msToken", input.msToken);
  }
  return `https://www.tiktok.com/api/user/list/?${params.toString()}`;
}

export type TikTokListClassification = "VALIDATED" | "EMPTY_BODY" | "BLOCKED" | "ERROR";

const LIST_DATA_SIGNAL = /"(userInfoList|users|secUid|nickname|uniqueId)"/;

export function classifyListResponse(input: { status: number; body: string }): TikTokListClassification {
  if (input.status === 200) {
    if (input.body.length > 0 && LIST_DATA_SIGNAL.test(input.body)) {
      return "VALIDATED";
    }
    return "EMPTY_BODY";
  }
  if (input.status === 401 || input.status === 403 || input.status === 429) {
    return "BLOCKED";
  }
  return "ERROR";
}

type CurlResponse = {
  status: number;
  headers: Record<string, string>;
  setCookies: string[];
  body: string;
};

export type TikTokSignEvidenceEntry = {
  step: "profile" | "token-warmup" | "list-followers" | "list-following";
  url: string;
  status: number;
  bodyLength: number;
  bodyExcerpt: string;
  classification: TikTokListClassification | "OK" | "FAILED";
  recordedAt: string;
};

export async function runTikTokSignProbe(
  target: string,
  keyValueStore: KeyValueStore,
  proxyUser = "auto",
): Promise<{ final: string; requests: number }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const password = process.env.APIFY_PROXY_PASSWORD ?? process.env.APIFY_TOKEN;
  if (password === undefined || password === "") {
    throw new Error("tiktok-sign probe requires APIFY_PROXY_PASSWORD or APIFY_TOKEN");
  }

  const entries: TikTokSignEvidenceEntry[] = [];
  let requests = 0;

  const curl = async (url: string, extraHeaders: string[] = []): Promise<CurlResponse> => {
    requests += 1;
    const bodyFile = `/tmp/tt-b-${requests}`;
    const { stdout } = await execFileAsync("curl", [
      "-sS", "--max-time", "25", "-o", bodyFile, "--compressed",
      "-w", "%{header_json}\n%{response_code}",
      "-H", `user-agent: ${USER_AGENT}`,
      "-H", "accept: application/json, text/plain, */*",
      "-H", "accept-language: en-US,en;q=0.9",
      "-H", "referer: https://www.tiktok.com/",
      ...extraHeaders,
      "-x", "http://proxy.apify.com:8000",
      "--proxy-user", `${proxyUser}:${password}`,
      url,
    ], { maxBuffer: 20 * 1024 * 1024 });
    const lastNewline = stdout.lastIndexOf("\n");
    const headerJsonText = lastNewline === -1 ? "{}" : stdout.slice(0, lastNewline);
    const status = Number.parseInt(stdout.slice(lastNewline + 1).trim(), 10) || 0;
    const body = await (await import("node:fs/promises")).readFile(bodyFile, "utf8").catch(() => "");
    void (await import("node:fs/promises")).rm(bodyFile, { force: true });

    const headerMap = safeParseHeaderMap(headerJsonText);
    const headers: Record<string, string> = {};
    const setCookies: string[] = [];
    for (const [name, values] of Object.entries(headerMap)) {
      if (!Array.isArray(values)) continue;
      if (name.toLowerCase() === "set-cookie") {
        setCookies.push(...values);
      } else if (values.length > 0) {
        const last = values[values.length - 1];
        if (last !== undefined) {
          headers[name.toLowerCase()] = last;
        }
      }
    }
    return { status, headers, setCookies, body };
  };

  const safeParseHeaderMap = (text: string): Record<string, string[]> => {
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, string[]>)
        : {};
    } catch {
      return {};
    }
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  let msToken: string | undefined;
  let final = "NO_DATA";

  const maskSecrets = (text: string): string =>
    msToken === undefined ? text : text.split(msToken).join(`msToken[MASKED:${msToken.length}]`);

  // Step 1: profile page → secUid + any msToken the page context hands out.
  const profile = await curl(`https://www.tiktok.com/@${target}`);
  const secUid = extractSecUid(profile.body);
  msToken = extractMsTokenFromSetCookies(profile.setCookies) ?? profile.headers["x-ms-token"];
  const harvestToken = (response: CurlResponse): void => {
    msToken = extractMsTokenFromSetCookies(response.setCookies) ?? response.headers["x-ms-token"] ?? msToken;
  };
  entries.push({
    step: "profile",
    url: `https://www.tiktok.com/@${target}`,
    status: profile.status,
    bodyLength: profile.body.length,
    bodyExcerpt: secUid === undefined ? profile.body.slice(0, EXCERPT_LIMIT) : `secUid=${secUid.slice(0, 10)}…`,
    classification: secUid === undefined ? "FAILED" : "OK",
    recordedAt: new Date().toISOString(),
  });

  if (secUid === undefined) {
    await keyValueStore.setValue("TIKTOK_SIGN_EVIDENCE", entries);
    return { final: "PROFILE_NO_SECUID", requests };
  }
  await sleep(2_000);

  // Step 2 (only if needed): token warm-up — the list endpoint itself issues
  // x-ms-token on empty-body responses.
  if (msToken === undefined && requests < BUDGET) {
    const warmup = await curl(buildListUrl({ secUid, listType: "followers", count: 30, cursor: 0 }));
    harvestToken(warmup);
    entries.push({
      step: "token-warmup",
      url: maskSecrets(buildListUrl({ secUid, listType: "followers", count: 30, cursor: 0 })),
      status: warmup.status,
      bodyLength: warmup.body.length,
      bodyExcerpt: maskSecrets(warmup.body.slice(0, EXCERPT_LIMIT)),
      classification: classifyListResponse({ status: warmup.status, body: warmup.body }),
      recordedAt: new Date().toISOString(),
    });
    await sleep(2_000);
  }

  // Steps 3+4: the actual signed-by-token-only list calls.
  for (const listType of ["followers", "following"] as const) {
    if (requests >= BUDGET) {
      final = "BUDGET_EXHAUSTED";
      break;
    }
    const url = buildListUrl({ secUid, listType, count: 30, cursor: 0, ...(msToken === undefined ? {} : { msToken }) });
    const extraHeaders = msToken === undefined ? [] : ["-H", `cookie: msToken=${msToken}`];
    let classification: TikTokSignEvidenceEntry["classification"];
    let response: CurlResponse;
    try {
      response = await curl(url, extraHeaders);
      harvestToken(response);
      classification = classifyListResponse({ status: response.status, body: response.body });
      if (classification === "VALIDATED") {
        final = `LIST_VALIDATED:${listType}`;
      }
    } catch (error) {
      const safe = String(error).replace(/apify_api_[A-Za-z0-9]+/g, "apify_api_[REDACTED]");
      entries.push({
        step: listType === "followers" ? "list-followers" : "list-following",
        url: maskSecrets(url),
        status: 0,
        bodyLength: 0,
        bodyExcerpt: safe.slice(-200),
        classification: "FAILED",
        recordedAt: new Date().toISOString(),
      });
      continue;
    }
    entries.push({
      step: listType === "followers" ? "list-followers" : "list-following",
      url: maskSecrets(url),
      status: response.status,
      bodyLength: response.body.length,
      bodyExcerpt: maskSecrets(response.body.slice(0, EXCERPT_LIMIT)),
      classification,
      recordedAt: new Date().toISOString(),
    });
    await sleep(2_000);
  }

  if (final === "NO_DATA") {
    final = msToken === undefined ? "NO_TOKEN" : "TOKEN_ONLY_INSUFFICIENT";
  }
  await keyValueStore.setValue("TIKTOK_SIGN_EVIDENCE", entries);
  return { final, requests };
}

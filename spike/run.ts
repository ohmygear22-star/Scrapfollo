/**
 * Phase 3 live spike runner. Executes the escalation ladder (rungs 1-3)
 * autonomously for one platform, honoring the owner rule: caught does not
 * stop the spike — it advances the ladder. Budgets are hard-enforced via
 * BudgetGuard; every request is classified and recorded (sanitized).
 *
 * Usage: node --experimental-strip-types spike/run.ts --platform instagram|tiktok
 * Environment: APIFY_TOKEN (rung 3 residential proxy only; never printed).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { BudgetGuard, classifyResponse, createEvidenceLog } from "./probe.ts";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Value-level redaction: any apify token appearing inside any string is scrubbed
 *  before it can reach console output or the evidence log. */
function scrub(text: string): string {
  return text.replace(/apify_api_[A-Za-z0-9]+/g, "apify_api_[REDACTED]");
}

const HEADER_SETS: Record<string, Record<string, string>> = {
  safariMac: {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  },
  chromeWindows: {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="129", "Not=A?Brand";v="8"',
    "sec-fetch-mode": "navigate",
  },
  chromeAndroid: {
    "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  },
};

const SUBJECTS = { instagram: "natgeo", tiktok: "khaby.lame" } as const;
const BUDGETS = {
  instagram: { 1: 3, 2: 6, 3: 6 },
  tiktok: { 1: 4, 2: 8, 3: 8 },
} as const;

type Platform = keyof typeof SUBJECTS;

async function curlRequest(
  url: string,
  headers: Record<string, string>,
  proxy: { host: string; user: string; password: string } | undefined,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const args = ["-sS", "--max-time", "25", "-D", "-", "--compressed"];
  for (const [key, value] of Object.entries(headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  if (proxy !== undefined) {
    args.push("-x", proxy.host, "--proxy-user", `${proxy.user}:${proxy.password}`);
  }
  args.push(url);
  const { stdout } = await execFileAsync("curl", args, { maxBuffer: 20 * 1024 * 1024 });
  const split = stdout.indexOf("\r\n\r\n");
  const headerBlock = split === -1 ? stdout : stdout.slice(0, split);
  const body = split === -1 ? "" : stdout.slice(split + 4);
  const responseHeaders: Record<string, string> = {};
  let status = 0;
  for (const line of headerBlock.split("\r\n")) {
    const statusMatch = /^HTTP\/[\d.]+ (\d+)/.exec(line);
    if (statusMatch !== null) {
      status = Number(statusMatch[1]);
      continue;
    }
    const separator = line.indexOf(":");
    if (separator > 0) {
      responseHeaders[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
  }
  return { status, headers: responseHeaders, body };
}

async function shoot(
  platform: Platform,
  rung: number,
  headersName: string,
  proxy: { host: string; user: string; password: string } | undefined,
  step: "resolve" | "list",
  url: string,
  guard: BudgetGuard,
  log: ReturnType<typeof createEvidenceLog>,
): Promise<string> {
  if (!guard.tryConsume(platform, rung)) {
    return "BUDGET_EXHAUSTED";
  }
  let classified;
  try {
    const response = await curlRequest(url, HEADER_SETS[headersName], proxy);
    classified = classifyResponse({ step, ...response });
    log.record({
      platform, rung, step, url,
      headerSet: headersName,
      viaResidentialProxy: proxy !== undefined,
      status: response.status,
      contentType: response.headers["content-type"] ?? "",
      location: response.headers["location"] ?? "",
      bodyExcerpt: response.body.slice(0, 400),
      verdict: classified.verdict,
      reason: classified.reason,
    });
  } catch (error) {
    const safeMessage = scrub(String(error));
    classified = classifyResponse({ step, networkError: "request failed" });
    log.record({ platform, rung, step, url, headerSet: headersName, verdict: classified.verdict, reason: safeMessage.slice(0, 200) });
  }
  console.log(`[${platform} rung${rung} ${headersName} ${step}] ${classified.verdict}: ${scrub(classified.reason)}`);
  await sleep(2_000);
  return classified.verdict;
}

function proxyConfig(): { host: string; user: string; password: string } | undefined {
  const token = process.env.APIFY_TOKEN;
  if (token === undefined || token === "") return undefined;
  return {
    host: "http://proxy.apify.com:8000",
    user: "auto",
    password: `${token},groups=RESIDENTIAL`,
  };
}

function resolveUrl(platform: Platform): string {
  return platform === "instagram"
    ? `https://www.instagram.com/${SUBJECTS.instagram}/`
    : `https://www.tiktok.com/@${SUBJECTS.tiktok}`;
}

function instagramListUrl(): string {
  return "https://www.instagram.com/graphql/query/?query_hash=c76146cf992a6deceptor&variables=%7B%22id%22%3A%22unknown%22%7D";
}

function tiktokListUrl(secUid: string, listType: "followers" | "following"): string {
  return `https://www.tiktok.com/api/user/list/?secUid=${encodeURIComponent(secUid)}&count=30&cursor=0&listType=${listType}&aid=1988&app_language=en&device_platform=web_pc`;
}

async function extractTikTokSecUid(body: string): Promise<string | undefined> {
  const match = /"secUid":\s*"([^"]+)"/.exec(body);
  return match?.[1];
}

async function runPlatform(platform: Platform): Promise<void> {
  const guard = new BudgetGuard(BUDGETS as unknown as Record<string, Record<number, number>>);
  const log = createEvidenceLog(`spike/evidence-${platform}.json`);
  const rungs = [
    { rung: 1, headerOrder: ["safariMac"], useProxy: false },
    { rung: 2, headerOrder: ["chromeWindows", "chromeAndroid"], useProxy: false },
    { rung: 3, headerOrder: ["chromeWindows"], useProxy: true },
  ];

  let tiktokSecUid: string | undefined;
  let platformVerdict = "NO_DATA";

  for (const rungSpec of rungs) {
    for (const headerSet of rungSpec.headerOrder) {
      const proxy = rungSpec.useProxy ? proxyConfig() : undefined;
      if (platform === "instagram") {
        const resolve = await shoot(platform, rungSpec.rung, headerSet, proxy, "resolve", resolveUrl(platform), guard, log);
        if (resolve === "OK") {
          const list = await shoot(platform, rungSpec.rung, headerSet, proxy, "list", instagramListUrl(), guard, log);
          platformVerdict = list === "OK" ? "VIABLE" : resolve;
          if (list === "OK") break;
        } else {
          platformVerdict = resolve;
        }
      } else {
        let resolve = await shoot(platform, rungSpec.rung, headerSet, proxy, "resolve", resolveUrl(platform), guard, log);
        if (resolve === "OK") {
          if (tiktokSecUid === undefined) {
            const response = await curlRequest(resolveUrl(platform), HEADER_SETS[headerSet], proxy);
            tiktokSecUid = await extractTikTokSecUid(response.body);
          }
          if (tiktokSecUid === undefined) {
            platformVerdict = "RESOLVE_OK_NO_SECUID";
            continue;
          }
          const followers = await shoot(platform, rungSpec.rung, headerSet, proxy, "list", tiktokListUrl(tiktokSecUid, "followers"), guard, log);
          if (followers === "OK") {
            platformVerdict = "VIABLE";
            break;
          }
          platformVerdict = followers;
        } else {
          platformVerdict = resolve;
        }
      }
      if (platformVerdict === "VIABLE" || platformVerdict === "BUDGET_EXHAUSTED") break;
    }
    if (platformVerdict === "VIABLE") break;
  }

  writeFileSync(`spike/evidence-${platform}.json`, JSON.stringify(log.entries(), null, 2));
  console.log(`\n=== ${platform.toUpperCase()} FINAL: ${platformVerdict} ===`);
}

const platformArg = process.argv.find((arg) => arg.startsWith("--platform="))?.slice("--platform=".length) as Platform | undefined;
if (platformArg !== "instagram" && platformArg !== "tiktok") {
  console.error("Usage: node --experimental-strip-types spike/run.ts --platform=instagram|tiktok");
  process.exit(1);
}
await runPlatform(platformArg);

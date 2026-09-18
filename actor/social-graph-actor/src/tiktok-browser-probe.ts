import type { KeyValueStore } from "./key-value-store.js";
import { TIKTOK_STEALTH_INIT_SCRIPT } from "./tiktok-stealth.js";

/**
 * TikTok owned-session headless-collector probe (Option A, owner 2026-09-17).
 *
 * Runs a real Chromium inside the actor over the Apify datacenter proxy with
 * the owner's TikTok session cookie jar, opens a profile, clicks the
 * Followers / Following counters, and captures the /api/user/list responses
 * the TikTok web app itself issues (its own JS attaches X-Dynosaur, msToken,
 * X-Bogus, X-Gnarly — no static signature implementation involved).
 *
 * playwright is confined to this module (architecture test mirrors the
 * apify-binding exception). Cookie values never enter evidence records.
 */

const PROBE_TIMEOUT_MS = 90_000;

export type HarvestedCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  /** SQLite columns arrive as 0/1 integers; booleans in hand-built jars. */
  httpOnly: boolean | number;
  secure: boolean | number;
};

export type PlaywrightCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
};

/** Chromium stores expires as microseconds since 1601-01-01; playwright wants unix seconds. */
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

export function harvestedCookieToPlaywright(cookie: HarvestedCookie): PlaywrightCookie {
  const unixSeconds =
    cookie.expires > 0
      ? Math.floor(cookie.expires / 1_000_000) - CHROME_EPOCH_OFFSET_SECONDS
      : -1;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path === "" ? "/" : cookie.path,
    expires: unixSeconds > 0 ? unixSeconds : -1,
    httpOnly: cookie.httpOnly === true || cookie.httpOnly === 1,
    secure: cookie.secure === true || cookie.secure === 1,
  };
}

export function parseCookieJar(rawJson: string): PlaywrightCookie[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("TIKTOK_COOKIES_JSON is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("TIKTOK_COOKIES_JSON must be an array of cookies");
  }
  const cookies = parsed
    .filter((c): c is HarvestedCookie =>
      c !== null && typeof c === "object"
      && typeof (c as HarvestedCookie).name === "string"
      && typeof (c as HarvestedCookie).value === "string")
    .map(harvestedCookieToPlaywright);
  if (!cookies.some((c) => c.name === "sessionid")) {
    throw new Error("TIKTOK_COOKIES_JSON contains no sessionid; refusing anonymous collection");
  }
  return cookies;
}

export type ListSummary = {
  url: string;
  scene: string | null;
  total: number | null;
  itemCount: number;
  hasMore: boolean | null;
  sample: Array<{ uniqueId: string | null; nickname: string | null }>;
};

export function summarizeListText(url: string, text: string): ListSummary {
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // empty or truncated body
  }
  return summarizeListPayload(url, json);
}

export function summarizeListPayload(url: string, json: unknown): ListSummary {
  const body = json !== null && typeof json === "object" ? json as Record<string, unknown> : {};
  // The web app's key is userList; older variants used userInfoList/users.
  const users = ["userList", "userInfoList", "users"]
    .map((key) => (Array.isArray(body[key]) ? body[key] as Array<Record<string, unknown>> : []))
    .find((list) => list.length > 0) ?? [];
  const sceneMatch = /[?&]scene=(\d+)/.exec(url);
  return {
    url: maskSignedUrl(url),
    scene: sceneMatch?.[1] ?? null,
    total: typeof body["total"] === "number" ? body["total"] : null,
    itemCount: users.length,
    hasMore: typeof body["hasMore"] === "boolean" ? body["hasMore"] : null,
    sample: users.slice(0, 3).map((entry) => {
      const user = entry["user"] !== null && typeof entry["user"] === "object"
        ? entry["user"] as Record<string, unknown>
        : entry;
      return {
        uniqueId: typeof user["uniqueId"] === "string" ? user["uniqueId"] : null,
        nickname: typeof user["nickname"] === "string" ? user["nickname"] : null,
      };
    }),
  };
}

function maskSignedUrl(url: string): string {
  return url
    .replace(/(msToken=)[^&]+/g, "$1<MS>")
    .replace(/(X-Dynosaur=)[^&]+/g, "$1<DYN>")
    .replace(/(X-Gnarly=)[^&]+/g, "$1<GN>")
    .replace(/(X-Bogus=)[^&]+/g, "$1<XB>")
    .replace(/(_signature=)[^&]+/g, "$1<SIG>")
    .replace(/(a_bogus=)[^&]+/g, "$1<AB>");
}

export type TikTokBrowserEvidence = {
  loginDetected: boolean;
  profileLoaded: boolean;
  followers: ListSummary | null;
  following: ListSummary | null;
  apiUrls: string[];
  sessionCookieAlive?: boolean;
  cookieNamesAfterLoad?: string[];
  listCaptures?: Array<{ url: string; status: number; textHead: string }>;
  finishedAt: string;
};

export async function runTikTokBrowserProbe(
  target: string,
  keyValueStore: KeyValueStore,
  cookiesJson?: string,
): Promise<{ final: string; listResponses: number }> {
  // Cookies arrive via run input (per-run private KVS) with an env fallback.
  const cookies = parseCookieJar(cookiesJson ?? process.env["TIKTOK_COOKIES_JSON"] ?? "");
  const proxyPassword = process.env["APIFY_PROXY_PASSWORD"] ?? process.env["APIFY_TOKEN"];
  if (proxyPassword === undefined || proxyPassword === "") {
    throw new Error("tiktok-browser probe requires APIFY_PROXY_PASSWORD or APIFY_TOKEN");
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    // The apify playwright-CHROME image ships full Google Chrome; the channel
    // bypasses playwright's version-specific browser registry entirely.
    channel: "chrome",
    // Headful under the image's xvfb: TikTok's app hydrates reliably there,
    // while pure headless serves a skeleton shell (anti-bot behavior).
    headless: false,
    proxy: {
      server: "http://proxy.apify.com:8000",
      username: "auto",
      password: proxyPassword,
    },
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const evidence: TikTokBrowserEvidence = {
    loginDetected: false,
    profileLoaded: false,
    followers: null,
    following: null,
    apiUrls: [],
    sessionCookieAlive: false,
    cookieNamesAfterLoad: [],
    listCaptures: [],
    finishedAt: new Date().toISOString(),
  };
  const captured: Array<{ url: string; text: string; status: number }> = [];
  let listResponses = 0;

  try {
    const context = await browser.newContext({
      // Stealth patches run before page scripts on every navigation.
      // (addInitScript goes through the context, declared here first.)
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "Asia/Singapore",
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript({ content: TIKTOK_STEALTH_INIT_SCRIPT });
    await context.addCookies(cookies);
    const page = await context.newPage();

    // Warm-up navigation: establishes session context before the profile.
    await page.goto("https://www.tiktok.com/foryou", {
      waitUntil: "domcontentloaded",
      timeout: PROBE_TIMEOUT_MS,
    }).catch(() => undefined);
    await page.waitForTimeout(4_000);
    page.on("response", async (response) => {
      const url = response.url();
      if (!/tiktok\.com\/api\//.test(url)) return;
      if (evidence.apiUrls.length < 20) {
        evidence.apiUrls.push(maskSignedUrl(url).slice(0, 200));
      }
      if (!/api\/user\/list/.test(url)) return;
      listResponses += 1;
      const text = await response.text().catch(() => "");
      captured.push({ url, text: text.slice(0, 200_000), status: response.status() });
    });

    const gotoProfile = () => page.goto(`https://www.tiktok.com/@${target}`, {
      waitUntil: "domcontentloaded",
      timeout: PROBE_TIMEOUT_MS,
    });
    await gotoProfile();
    const countersVisible = () => page
      .locator('[data-e2e="followers-count"], [data-e2e="following-count"]')
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true, () => false);
    if (!(await countersVisible())) {
      // One retry: hydration sometimes needs a fresh load.
      await page.reload({ waitUntil: "domcontentloaded", timeout: PROBE_TIMEOUT_MS }).catch(() => undefined);
      await countersVisible().catch(() => false);
    }
    await page.waitForTimeout(2_000);
    evidence.profileLoaded = true;

    evidence.loginDetected = await page.evaluate(() =>
      document.querySelector('[data-e2e="profile-icon"], [data-e2e="nav-upload"]') !== null);
    evidence.cookieNamesAfterLoad = await page.evaluate(() =>
      document.cookie.split(";")
        .map((c) => (c.split("=")[0] ?? "").trim())
        .filter((n) => n !== "")
        .sort());
    // Definitive session check: context cookies include httpOnly ones.
    const contextCookies = await context.cookies();
    evidence.sessionCookieAlive = contextCookies.some((c) => c.name === "sessionid");

    const visitListPage = async (
      listType: "followers" | "following",
    ): Promise<void> => {
      const before = captured.length;
      await page.goto(`https://www.tiktok.com/@${target}/${listType}`, {
        waitUntil: "domcontentloaded",
        timeout: PROBE_TIMEOUT_MS,
      });
      await page.waitForTimeout(6_000);
      const fresh = captured.slice(before);
      const match = fresh.find((c) => /userList|userInfoList|"users"/.test(c.text)) ?? fresh.at(-1);
      if (match !== undefined) {
        const summary = summarizeListText(match.url, match.text);
        if (listType === "followers") {
          evidence.followers = summary;
        } else {
          evidence.following = summary;
        }
      }
    };

    // Try the modal path first: TikTok exposes data-e2e hooks on the counters.
    await page.goto(`https://www.tiktok.com/@${target}`, {
      waitUntil: "domcontentloaded",
      timeout: PROBE_TIMEOUT_MS,
    });
    await page.waitForTimeout(4_000);
    // The app's modal calls use scene= params (no listType), so associate
    // responses with the click that triggered them by timing window.
    for (const hook of ["followers-count", "following-count"]) {
      const counter = page.locator(`[data-e2e="${hook}"]`).first();
      if (await counter.count()) {
        const before = captured.length;
        await counter.click({ force: true, timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(5_000);
        const fresh = captured.slice(before);
        const match = fresh.find((c) => /userList|userInfoList|"users"/.test(c.text)) ?? fresh.at(-1);
        if (match !== undefined) {
          const summary = summarizeListText(match.url, match.text);
          if (hook === "followers-count") {
            evidence.followers = summary;
          } else {
            evidence.following = summary;
          }
        }
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(1_000);
      }
    }

    if (evidence.followers === null && evidence.following === null) {
      await visitListPage("following");
      await visitListPage("followers");
    }
    // Scene values are empirical: 67 = followers modal, 151 = following modal
    // (the data-e2e hook labels do not match the modals they open).
    const byScene = (scene: string) =>
      captured
        .filter((c) => c.url.includes(`scene=${scene}`))
        .sort((a, b) => b.text.length - a.text.length)
        .find((c) => c.text.includes("userList"))
        ?? captured.filter((c) => c.url.includes(`scene=${scene}`)).at(-1);
    const followersCapture = byScene("67");
    if (followersCapture !== undefined) {
      evidence.followers = summarizeListText(followersCapture.url, followersCapture.text);
    }
    const followingCapture = byScene("151");
    if (followingCapture !== undefined) {
      evidence.following = summarizeListText(followingCapture.url, followingCapture.text);
    }
    evidence.listCaptures = captured.map((c) => ({
      url: maskSignedUrl(c.url),
      status: c.status,
      textHead: c.text.slice(0, 300),
    }));
    const shot = await page.screenshot({ fullPage: false }).catch(() => null);
    if (shot !== null) {
      await keyValueStore.setValue("TIKTOK_SCREENSHOT", shot);
    }

  } finally {
    await browser.close().catch(() => undefined);
  }

  await keyValueStore.setValue("TIKTOK_BROWSER_EVIDENCE", evidence);

  const final = !evidence.profileLoaded
    ? "PROFILE_FAILED"
    : !evidence.loginDetected
      ? "SESSION_REJECTED"
      : evidence.followers !== null && evidence.followers.itemCount > 0
        ? "LIST_DATA_CAPTURED"
        : "LOGIN_OK_NO_LIST_DATA";
  return { final, listResponses };
}

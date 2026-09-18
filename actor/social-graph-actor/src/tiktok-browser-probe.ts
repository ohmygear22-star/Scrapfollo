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
  followersAggregate?: SceneAggregate | null;
  followingAggregate?: SceneAggregate | null;
  profileCounts?: ProfileCounts | null;
  dialogAria?: string | undefined;
  sceneReports?: Array<{ scene: string | null; kind: string; aggregate: SceneAggregate }>;
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

  // Sticky Singapore datacenter sessions first (TikTok home region; the US
  // pool is heavily flagged), then one direct attempt from the runner IP.
  const attempts: Array<{ label: string; proxyUser: string | undefined }> = [
    { label: "sg-1", proxyUser: "auto-country-sg-session-tiktok-1" },
    { label: "sg-2", proxyUser: "auto-country-sg-session-tiktok-2" },
    { label: "direct", proxyUser: undefined },
  ];
  let loaded = false;

  for (const attempt of attempts) {
    const browser = await chromium.launch({
      // The apify playwright-CHROME image ships full Google Chrome; the channel
      // bypasses playwright's version-specific browser registry entirely.
      channel: "chrome",
      // Headful under the image's xvfb: TikTok's app hydrates reliably there,
      // while pure headless serves a skeleton shell (anti-bot behavior).
      headless: false,
      ...(attempt.proxyUser === undefined
        ? {}
        : {
            proxy: {
              server: "http://proxy.apify.com:8000",
              username: attempt.proxyUser,
              password: proxyPassword,
            },
          }),
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });
    try {
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        locale: "en-US",
        timezoneId: "Asia/Singapore",
        viewport: { width: 1440, height: 900 },
      });
      await context.addInitScript({ content: TIKTOK_STEALTH_INIT_SCRIPT });
      await context.addCookies(cookies);
      const page = await context.newPage();
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

      // Warm-up navigation: establishes session context before the profile.
      await page.goto("https://www.tiktok.com/foryou", {
        waitUntil: "domcontentloaded",
        timeout: PROBE_TIMEOUT_MS,
      }).catch(() => undefined);
      await page.waitForTimeout(4_000);

      await page.goto(`https://www.tiktok.com/@${target}`, {
        waitUntil: "domcontentloaded",
        timeout: PROBE_TIMEOUT_MS,
      }).catch((error: unknown) => {
        throw error;
      });
      const countersVisible = () => page
        .locator('[data-e2e="followers-count"], [data-e2e="following-count"]')
        .first()
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => true, () => false);
      if (!(await countersVisible())) {
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
      const contextCookies = await context.cookies();
      evidence.sessionCookieAlive = contextCookies.some((c) => c.name === "sessionid");

      // Profile counts ground truth for scene classification.
      const headerText = await page.evaluate(() => {
        const headings = Array.from(document.querySelectorAll("h3,h2"));
        const el = headings.find((h) => /following/i.test(h.textContent ?? "") && /followers/i.test(h.textContent ?? ""));
        return el?.textContent ?? "";
      });
      const profileCounts = parseProfileCounts(headerText);
      evidence.profileCounts = profileCounts;

      // Open one modal, then switch tabs inside it. Centering the mouse
      // before wheel matters: wheel events land at the cursor position, and
      // after a counter click it hovers the header, not the modal list.
      const openModal = async (): Promise<boolean> => {
        for (const hook of ["followers-count", "following-count"]) {
          const counter = page.locator(`[data-e2e="${hook}"]`).first();
          if (!(await counter.count())) continue;
          await counter.click({ force: true, timeout: 5_000 }).catch(() => undefined);
          await page.waitForTimeout(3_000);
          const dialog = page.getByRole("dialog");
          if (await dialog.count()) return true;
        }
        return false;
      };
      const clickTab = async (label: string): Promise<void> => {
        const dialog = page.getByRole("dialog");
        const byRole = dialog.getByRole("tab", { name: new RegExp(label, "i") }).first();
        const byText = dialog.getByText(label, { exact: true }).first();
        const target = (await byRole.count()) > 0 ? byRole : byText;
        if ((await target.count()) > 0) {
          await target.click({ force: true, timeout: 4_000 }).catch(() => undefined);
          await page.waitForTimeout(3_000);
        }
      };
      const scrollModal = async (): Promise<void> => {
        await page.mouse.move(720, 450).catch(() => undefined);
        for (let i = 0; i < 5; i += 1) {
          await page.mouse.wheel(0, 1_500).catch(() => undefined);
          await page.waitForTimeout(1_500);
        }
      };
      if (await openModal()) {
        evidence.dialogAria = (await page.getByRole("dialog").ariaSnapshot().catch(() => null)) ?? undefined;
        const dialogShot = await page.screenshot({ fullPage: false }).catch(() => null);
        if (dialogShot !== null) {
          await keyValueStore.setValue("TIKTOK_DIALOG_SCREENSHOT", dialogShot);
        }
        for (const tabLabel of ["Followers", "Following", "Friends"]) {
          const before = captured.length;
          await clickTab(tabLabel);
          await scrollModal();
          if (captured.length === before && tabLabel !== "Friends") {
            // tab may not exist; nothing captured — keep going
          }
        }
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(1_000);
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
      const sceneIds = Array.from(new Set(
        captured
          .map((c) => /scene=(\d+)/.exec(c.url)?.[1])
          .filter((id): id is string => id !== undefined),
      ));
      evidence.sceneReports = [];
      for (const sceneId of sceneIds) {
        const aggregate = aggregateSceneCaptures(sceneId, captured);
        if (aggregate === null || profileCounts === null) continue;
        evidence.sceneReports.push({
          scene: sceneId,
          kind: classifySceneAggregate(aggregate, profileCounts),
          aggregate,
        });
      }
      const followersReport = evidence.sceneReports?.find((r) => r.kind === "followers");
      const followersFallback = aggregateSceneCaptures("67", captured);
      evidence.followersAggregate = followersReport !== undefined ? followersReport.aggregate : followersFallback;
      const followingReport = evidence.sceneReports?.find((r) => r.kind === "following");
      const followingFallback = aggregateSceneCaptures("151", captured);
      evidence.followingAggregate = followingReport !== undefined ? followingReport.aggregate : followingFallback;
      evidence.listCaptures = captured.map((c) => ({
        url: maskSignedUrl(c.url),
        status: c.status,
        textHead: c.text.slice(0, 300),
      }));
      const shot = await page.screenshot({ fullPage: false }).catch(() => null);
      if (shot !== null) {
        await keyValueStore.setValue("TIKTOK_SCREENSHOT", shot);
      }
      loaded = true;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempts.at(-1)?.label === attempt.label
        || !/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_CONNECTION|net::/.test(message)) {
        throw error;
      }
      // This exit IP is TikTok-blocked; fall through to the next attempt.
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
  if (!loaded) {
    throw new Error("tiktok browser probe exhausted sticky sessions without loading the profile");
  }

  await keyValueStore.setValue("TIKTOK_BROWSER_EVIDENCE", evidence);

  const final = !evidence.profileLoaded
    ? "PROFILE_FAILED"
    : !evidence.sessionCookieAlive
      ? "SESSION_REJECTED"
      : evidence.followers !== null && evidence.followers.itemCount > 0
        ? "LIST_DATA_CAPTURED"
        : "LOGIN_OK_NO_LIST_DATA";
  return { final, listResponses };
}

export type SceneAggregate = {
  scene: string | null;
  pages: number;
  mergedItems: number;
  uniqueIds: string[];
  total: number | null;
  hasMore: boolean | null;
};

/**
 * Merges every captured response of one modal scene into a single summary:
 * list pages deduplicate by uniqueId, so the merged count answers "how many
 * accounts did we actually enumerate" across scroll-triggered pages.
 */
export function aggregateSceneCaptures(
  scene: string,
  captures: Array<{ url: string; text: string }>,
): SceneAggregate | null {
  const matching = captures.filter((c) => c.url.includes(`scene=${scene}`));
  if (matching.length === 0) return null;
  const items = new Map<string, { uniqueId: string | null; nickname: string | null }>();
  let total: number | null = null;
  let hasMore: boolean | null = null;
  for (const capture of matching) {
    try {
      const body = JSON.parse(capture.text) as Record<string, unknown>;
      if (typeof body["total"] === "number") total = body["total"];
      if (typeof body["hasMore"] === "boolean") hasMore = body["hasMore"];
      const list = body["userList"];
      if (!Array.isArray(list)) continue;
      for (const entry of list as Array<Record<string, unknown>>) {
        const user = entry["user"] !== null && typeof entry["user"] === "object"
          ? entry["user"] as Record<string, unknown>
          : entry;
        const uniqueId = typeof user["uniqueId"] === "string" ? user["uniqueId"] : null;
        if (uniqueId !== null) {
          items.set(uniqueId, {
            uniqueId,
            nickname: typeof user["nickname"] === "string" ? user["nickname"] : null,
          });
        }
      }
    } catch {
      // truncated or non-JSON body: skip the page
    }
  }
  return {
    scene,
    pages: matching.length,
    mergedItems: items.size,
    uniqueIds: Array.from(items.keys()).slice(0, 5),
    total,
    hasMore,
  };
}

export type ProfileCounts = { following: number; followers: number };

const COMPACT_MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

/** Parses "81 Following 162.9M Followers 2.7B Likes" style headers. */
export function parseProfileCounts(text: string): ProfileCounts | null {
  const followingMatch = /([\d.,]+)\s*([kmb]?)\s*following/i.exec(text);
  const followersMatch = /([\d.,]+)\s*([kmb]?)\s*followers/i.exec(text);
  if (followingMatch === null || followersMatch === null) return null;
  const toNumber = (value: string, suffix: string): number => {
    const base = Number.parseFloat(value.replace(/,/g, ""));
    return Number.isFinite(base) ? base * (COMPACT_MULTIPLIERS[suffix.toLowerCase()] ?? 1) : Number.NaN;
  };
  const following = toNumber(followingMatch[1] ?? "", followingMatch[2] ?? "");
  const followers = toNumber(followersMatch[1] ?? "", followersMatch[2] ?? "");
  return Number.isFinite(following) && Number.isFinite(followers) ? { following, followers } : null;
}

/**
 * Classifies a scene aggregate against the profile's own counts: followers
 * lists carry a total near the profile follower count, following lists near
 * the following count, and anything much smaller is the friends (mutual) tab.
 */
export function classifySceneAggregate(
  aggregate: SceneAggregate,
  profile: ProfileCounts,
): "followers" | "following" | "friends" | "unknown" {
  if (aggregate.total === null) return "unknown";
  const within = (value: number, target: number) => Math.abs(value - target) <= Math.max(target * 0.02, 2);
  if (within(aggregate.total, profile.followers)) return "followers";
  if (within(aggregate.total, profile.following)) return "following";
  if (aggregate.total < profile.following) return "friends";
  return "unknown";
}

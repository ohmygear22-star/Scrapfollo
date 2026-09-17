import { describe, expect, it } from "vitest";
import {
  harvestedCookieToPlaywright,
  parseCookieJar,
  summarizeListPayload,
} from "../src/tiktok-browser-probe.js";

describe("tiktok browser probe helpers", () => {
  it("converts Chromium epoch microseconds to unix seconds", () => {
    // 2026-01-01T00:00:00Z = 1767225600 unix = (1767225600 + 11644473600) * 1e6 chrome-usec
    const converted = harvestedCookieToPlaywright({
      name: "sessionid",
      value: "x",
      domain: ".tiktok.com",
      path: "/",
      expires: 13_411_699_200 * 1_000_000,
      httpOnly: true,
      secure: true,
    });
    expect(converted.expires).toBe(1_767_225_600);
  });

  it("maps session cookies (expires 0) to a session-cookie marker", () => {
    const converted = harvestedCookieToPlaywright({
      name: "msToken",
      value: "y",
      domain: ".tiktok.com",
      path: "",
      expires: 0,
      httpOnly: false,
      secure: true,
    });
    expect(converted.expires).toBe(-1);
    expect(converted.path).toBe("/");
  });

  it("parses a harvested jar and refuses one without sessionid", () => {
    const jar = JSON.stringify([
      { name: "sessionid", value: "abc", domain: ".tiktok.com", path: "/", expires: 0, httpOnly: 1, secure: 1 },
      { name: "ttwid", value: "d", domain: ".tiktok.com", path: "/", expires: 13_411_699_200_000_000, httpOnly: 1, secure: 1 },
      { name: "junk", value: null, domain: ".tiktok.com", path: "/", expires: 0, httpOnly: 0, secure: 0 },
    ]);
    const cookies = parseCookieJar(jar);
    expect(cookies).toHaveLength(2);
    expect(() => parseCookieJar(JSON.stringify([{ name: "ttwid", value: "d", domain: ".tiktok.com", path: "/", expires: 0, httpOnly: 1, secure: 1 }])))
      .toThrow(/sessionid/);
    expect(() => parseCookieJar("not json")).toThrow(/JSON/);
  });

  it("summarizes a userInfoList payload with masked signatures", () => {
    const summary = summarizeListPayload(
      "https://www.tiktok.com/api/user/list/?secUid=abc&msToken=SECRETTOKEN&X-Gnarly=GGG&listType=followers",
      {
        statusCode: 0,
        total: 162_900_000,
        hasMore: true,
        userInfoList: [
          { user: { uniqueId: "yubi3538", nickname: "L'olita" } },
          { user: { uniqueId: "jaberahmedsalman", nickname: "Jaber" } },
        ],
      },
    );
    expect(summary.total).toBe(162_900_000);
    expect(summary.itemCount).toBe(2);
    expect(summary.hasMore).toBe(true);
    expect(summary.sample[0]).toEqual({ uniqueId: "yubi3538", nickname: "L'olita" });
    expect(summary.url).toContain("msToken=<MS>");
    expect(summary.url).toContain("X-Gnarly=<GN>");
    expect(summary.url).not.toContain("SECRETTOKEN");
  });

  it("summarizes empty or foreign payloads without throwing", () => {
    const summary = summarizeListPayload("https://www.tiktok.com/api/user/list/?x=1", null);
    expect(summary.itemCount).toBe(0);
    expect(summary.total).toBeNull();
  });
});

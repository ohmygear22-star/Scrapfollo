import { describe, expect, it } from "vitest";
import {
  buildListUrl,
  classifyListResponse,
  extractMsTokenFromSetCookies,
  extractSecUid,
} from "../src/tiktok-sign-probe.js";

const SAMPLE_HTML =
  '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{"__DEFAULT_SCOPE__":{"webapp.user-detail":{"userInfo":{"user":{"secUid":"MS4wLjABAAAAwAg0rSzO65WQ","nickname":"Khabane Lame"},"stats":{"followerCount":162000000}}}}}</script>';

describe("tiktok sign probe helpers", () => {
  it("extracts the secUid from a profile page body", () => {
    expect(extractSecUid(SAMPLE_HTML)).toBe("MS4wLjABAAAAwAg0rSzO65WQ");
    expect(extractSecUid("<html>empty</html>")).toBeUndefined();
  });

  it("extracts msToken from Set-Cookie entries only", () => {
    expect(
      extractMsTokenFromSetCookies([
        "tt-target-idc=useast1a; Path=/; Secure",
        "msToken=h_u0YndWy3wOxlgBP3; Path=/; Secure; HttpOnly",
      ]),
    ).toBe("h_u0YndWy3wOxlgBP3");
    expect(extractMsTokenFromSetCookies(["msToken=; Path=/"])).toBeUndefined();
    expect(extractMsTokenFromSetCookies([])).toBeUndefined();
  });

  it("builds the list URL with msToken last and encoded", () => {
    const url = buildListUrl({
      secUid: "MS4wLjAB AAAAwAg0",
      listType: "following",
      count: 30,
      cursor: 0,
      msToken: "tok en+1=",
    });
    expect(url).toContain("listType=following");
    expect(url).toContain("secUid=MS4wLjAB+AAAAwAg0");
    expect(url).toContain("aid=1988");
    expect(url.endsWith("msToken=tok+en%2B1%3D")).toBe(true);
  });

  it("classifies list responses by body signals", () => {
    expect(
      classifyListResponse({
        status: 200,
        body: '{"userInfoList":[{"uniqueId":"someone","nickname":"Some One"}],"total":1}',
      }),
    ).toBe("VALIDATED");
    expect(classifyListResponse({ status: 200, body: "" })).toBe("EMPTY_BODY");
    expect(classifyListResponse({ status: 200, body: '{"statusCode":0}' })).toBe("EMPTY_BODY");
    expect(classifyListResponse({ status: 403, body: "" })).toBe("BLOCKED");
    expect(classifyListResponse({ status: 500, body: "" })).toBe("ERROR");
  });
});

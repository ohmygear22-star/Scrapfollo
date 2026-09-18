import { describe, expect, it } from "vitest";
import { TIKTOK_STEALTH_INIT_SCRIPT } from "../src/tiktok-stealth.js";

describe("tiktok stealth init script", () => {
  it("is a syntactically valid script body (IIFE-wrapped, no imports)", async () => {
    expect(TIKTOK_STEALTH_INIT_SCRIPT.trim().startsWith("(() => {")).toBe(true);
    expect(TIKTOK_STEALTH_INIT_SCRIPT).not.toContain("import ");
    // Node can parse it as an expression
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    expect(() => new AsyncFunction(TIKTOK_STEALTH_INIT_SCRIPT)).not.toThrow();
  });

  it("patches the five core automation fingerprints", () => {
    expect(TIKTOK_STEALTH_INIT_SCRIPT).toContain('"webdriver"');
    expect(TIKTOK_STEALTH_INIT_SCRIPT).toContain("window.chrome");
    expect(TIKTOK_STEALTH_INIT_SCRIPT).toContain('"plugins"');
    expect(TIKTOK_STEALTH_INIT_SCRIPT).toContain("permissions.query");
    expect(TIKTOK_STEALTH_INIT_SCRIPT).toContain("WebGLRenderingContext");
  });

  it("contains no secrets or token material", () => {
    expect(TIKTOK_STEALTH_INIT_SCRIPT).not.toMatch(/apify_api_|sessionid|msToken|cookie/i);
  });
});

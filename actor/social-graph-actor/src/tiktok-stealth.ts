/**
 * Ecosystem-standard stealth init script for the TikTok browser collector.
 *
 * Adapted from the well-known patch families used by
 * davidteather/TikTok-Api (stealth/) and puppeteer-extra-stealth: TikTok's
 * hydration gate checks for automation fingerprints (navigator.webdriver,
 * missing chrome.runtime, empty plugins, headless WebGL renderers). The
 * script runs before page scripts on every navigation via
 * context.addInitScript. No platform credentials or signature material are
 * involved — this only makes the browser context look like a normal desktop
 * Chrome.
 */
export const TIKTOK_STEALTH_INIT_SCRIPT = `
(() => {
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  } catch {}
  try {
    window.chrome = window.chrome || {
      runtime: {},
      app: { isInstalled: false },
      csi: () => {},
      loadTimes: () => ({}),
    };
  } catch {}
  try {
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", {
      get: () => {
        const make = (name) => ({
          name,
          filename: name,
          description: name,
          length: 1,
          0: { type: "application/pdf", suffixes: "pdf" },
        });
        return [make("Chrome PDF Viewer"), make("Chromium PDF Viewer"), make("Portable Document Format")];
      },
    });
  } catch {}
  try {
    const originalQuery = navigator.permissions && navigator.permissions.query
      ? navigator.permissions.query.bind(navigator.permissions)
      : undefined;
    if (originalQuery) {
      navigator.permissions.query = (parameters) =>
        parameters && parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  } catch {}
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return "Intel Inc.";
      if (parameter === 37446) return "Intel Iris OpenGL Engine";
      return getParameter.call(this, parameter);
    };
  } catch {}
  try {
    if (navigator.hardwareConcurrency === 0) {
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    }
  } catch {}
})();
`;

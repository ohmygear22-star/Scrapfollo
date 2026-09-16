import { describe, expect, it, vi } from "vitest";

const apifyMain = vi.fn(async () => undefined);
vi.mock("../src/apify-binding.js", () => ({ apifyMain }));

describe("apify entry", () => {
  it("starts the actor main loop on import", async () => {
    await import("../src/apify-entry.js");
    await Promise.resolve();

    expect(apifyMain).toHaveBeenCalledOnce();
  });
});

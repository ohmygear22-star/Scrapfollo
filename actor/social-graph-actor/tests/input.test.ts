import { describe, expect, it } from "vitest";
import { validateActorInput } from "../src/input.js";
import type { Platform } from "@social-graph/core";

function raw(overrides: Record<string, unknown> = {}, targetOverrides: Record<string, unknown> = {}) {
  return {
    targets: [{ platform: "instagram", username: "alpha", ...targetOverrides }],
    scrapeType: "followers",
    ...overrides,
  };
}

describe("validateActorInput — valid inputs", () => {
  it("accepts a minimal input and applies defaults with generated targetIds", () => {
    const validated = validateActorInput(raw());

    expect(validated).toEqual({
      targets: [{ targetId: "t1", platform: "instagram", username: "alpha" }],
      scrapeType: "followers",
      concurrency: 2,
      eventBufferSize: 8,
    });
    expect("maxFollowers" in validated).toBe(false);
    expect("maxFollowing" in validated).toBe(false);
  });

  it("accepts every approved platform and both scrape modes with options", () => {
    const platforms: Platform[] = ["instagram", "x", "tiktok"];
    for (const platform of platforms) {
      const validated = validateActorInput(raw({}, { platform }));
      expect(validated.targets[0]?.platform).toBe(platform);
    }

    const modes = ["followers", "following", "both"] as const;
    for (const scrapeType of modes) {
      expect(validateActorInput(raw({ scrapeType })).scrapeType).toBe(scrapeType);
    }

    const full = validateActorInput({
      targets: [
        { platform: "instagram", username: "@Alpha" },
        { platform: "x", username: " beta " },
      ],
      scrapeType: "both",
      maxFollowers: 500,
      maxFollowing: 1_000,
      concurrency: 4,
      eventBufferSize: 16,
    });
    expect(full.targets).toEqual([
      { targetId: "t1", platform: "instagram", username: "Alpha" },
      { targetId: "t2", platform: "x", username: "beta" },
    ]);
    expect(full.maxFollowers).toBe(500);
    expect(full.maxFollowing).toBe(1_000);
    expect(full.eventBufferSize).toBe(16);
  });

  it("accepts boundary values for every numeric limit", () => {
    const validated = validateActorInput({
      targets: [{ platform: "tiktok", username: "gamma" }],
      scrapeType: "followers",
      maxFollowers: 100_000,
      concurrency: 8,
      eventBufferSize: 64,
    });
    expect(validated.maxFollowers).toBe(100_000);
    expect(validated.concurrency).toBe(8);
    expect(validated.eventBufferSize).toBe(64);

    expect(validateActorInput({ ...raw(), concurrency: 1 }).concurrency).toBe(1);
    expect(validateActorInput({ ...raw(), eventBufferSize: 1 }).eventBufferSize).toBe(1);
    expect(validateActorInput({ ...raw(), concurrency: 3 }).eventBufferSize).toBe(12);
  });
});

describe("validateActorInput — invalid inputs", () => {
  it.each([
    ["missing targets", { scrapeType: "followers" }],
    ["empty targets", { targets: [], scrapeType: "followers" }],
    ["targets not an array", { targets: "instagram", scrapeType: "followers" }],
    ["target not an object", { targets: ["alpha"], scrapeType: "followers" }],
    ["missing platform", { targets: [{ username: "alpha" }], scrapeType: "followers" }],
    ["youtube platform", raw({}, { platform: "youtube" })],
    ["unknown platform", raw({}, { platform: "facebook" })],
    ["missing username", { targets: [{ platform: "instagram" }], scrapeType: "followers" }],
    ["blank username", raw({}, { username: "   " })],
    ["at-only username", raw({}, { username: "@@@" })],
    ["missing scrapeType", { targets: [{ platform: "instagram", username: "a" }] }],
    ["invalid scrapeType", raw({ scrapeType: "everything" })],
    ["unknown top-level key", raw({ extra: true })],
    ["unknown target key", raw({}, { extra: true })],
    ["zero maxFollowers", raw({ maxFollowers: 0 })],
    ["negative maxFollowers", raw({ maxFollowers: -5 })],
    ["fractional maxFollowers", raw({ maxFollowers: 1.5 })],
    ["over-limit maxFollowers", raw({ maxFollowers: 100_001 })],
    ["null maxFollowing", raw({ maxFollowing: null })],
    ["zero concurrency", raw({ concurrency: 0 })],
    ["over-limit concurrency", raw({ concurrency: 9 })],
    ["fractional concurrency", raw({ concurrency: 2.5 })],
    ["zero eventBufferSize", raw({ eventBufferSize: 0 })],
    ["over-limit eventBufferSize", raw({ eventBufferSize: 65 })],
    ["non-object input", "not-an-object"],
    ["array input", [{ platform: "instagram", username: "alpha" }]],
    ["target element array", { targets: [[]], scrapeType: "followers" }],
    ["null input", null],
  ])("rejects %s", (_label, input) => {
    expect(() => validateActorInput(input)).toThrowError(/INVALID_INPUT/);
  });

  it("accepts exactly the target-count safety limit", () => {
    const targets = Array.from({ length: 100 }, (_, index) => ({
      platform: "instagram" as const,
      username: `user-${index}`,
    }));

    const validated = validateActorInput({ targets, scrapeType: "followers" });
    expect(validated.targets).toHaveLength(100);
    expect(validated.targets.at(-1)?.targetId).toBe("t100");
  });

  it("rejects more than the target-count safety limit", () => {
    const targets = Array.from({ length: 101 }, (_, index) => ({
      platform: "instagram" as const,
      username: `user-${index}`,
    }));

    expect(() => validateActorInput({ targets, scrapeType: "followers" }))
      .toThrowError(/exceed the safety limit/);
  });

  it("rejects duplicates by platform and normalized username", () => {
    expect(() => validateActorInput({
      targets: [
        { platform: "instagram", username: "@Alpha" },
        { platform: "instagram", username: "  alpha " },
      ],
      scrapeType: "both",
    })).toThrowError(/duplicate/i);

    // Same username on a different platform is not a duplicate.
    expect(() => validateActorInput({
      targets: [
        { platform: "instagram", username: "alpha" },
        { platform: "x", username: "alpha" },
      ],
      scrapeType: "both",
    })).not.toThrow();
  });

  it("carries a safe, stable error shape", () => {
    try {
      validateActorInput({ targets: [] });
      throw new Error("expected validation to throw");
    } catch (error) {
      const actual = error as { name: string; code: string; message: string };
      expect(actual.name).toBe("ActorInputError");
      expect(actual.code).toBe("INVALID_INPUT");
      expect(actual.message).toMatch(/target/);
    }
  });
});

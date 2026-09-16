import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(async () => undefined),
  getInput: vi.fn(async (): Promise<unknown> => undefined),
  pushData: vi.fn(async () => undefined),
  setValue: vi.fn(async () => undefined),
  actorExit: vi.fn(async () => undefined),
  actorFail: vi.fn(async () => undefined),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("apify", () => ({
  Actor: {
    init: mocks.init,
    getInput: () => mocks.getInput(),
    pushData: mocks.pushData,
    setValue: mocks.setValue,
    exit: mocks.actorExit,
    fail: mocks.actorFail,
  },
  log: { info: mocks.logInfo, error: mocks.logError },
}));

import { apifyMain, createApifyPlatform } from "../src/apify-binding.js";

const validInput = {
  targets: [{ platform: "instagram", username: "alpha" }],
  scrapeType: "followers",
};

describe("apify binding adapters", () => {
  it("writes rows through Actor.pushData and summaries through Actor.setValue", async () => {
    const platform = createApifyPlatform();

    await platform.dataset.write({
      platform: "instagram",
      sourceUsername: "source",
      sourceUserId: "source-id",
      relationship: "followers",
      username: "u1",
      position: 1,
      scrapedAt: "2026-09-16T00:00:00.000Z",
    });
    await platform.keyValueStore?.setValue("RUN_SUMMARY", { run_id: "r" });

    expect(mocks.pushData).toHaveBeenCalledTimes(1);
    expect(mocks.setValue).toHaveBeenCalledWith("RUN_SUMMARY", { run_id: "r" });
  });
});

describe("apifyMain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes, consumes input, and exits cleanly on a completed run", async () => {
    mocks.getInput.mockResolvedValue(validInput);

    await apifyMain();

    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.actorExit).toHaveBeenCalledOnce();
    expect(mocks.actorFail).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("every target reports PROVIDER_UNAVAILABLE until Phase 3 injects live providers", async () => {
    mocks.getInput.mockResolvedValue(validInput);

    await apifyMain();

    expect(mocks.pushData).not.toHaveBeenCalled();
    expect(mocks.setValue).toHaveBeenCalledWith("RUN_SUMMARY", expect.objectContaining({
      targets: [expect.objectContaining({ coreStatus: "FAILED", delivery: "not-run" })],
    }));
  });

  it("fails the run with a safe message on invalid input", async () => {
    mocks.getInput.mockResolvedValue({ targets: [] });

    await apifyMain();

    expect(mocks.actorExit).not.toHaveBeenCalled();
    expect(mocks.actorFail).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("INVALID_INPUT"),
      expect.anything(),
    );
  });
});

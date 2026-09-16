import { describe, expect, it } from "vitest";
import { runActor } from "../src/main.js";
import { LocalDatasetWriter } from "../src/dataset-writer.js";
import { FakeProvider } from "@social-graph/fake-provider";
import type {
  FakeProviderScenario,
} from "@social-graph/fake-provider";
import type {
  CoreRunMetrics,
  ProviderRequestContext,
  ProviderRelationshipPage,
  SocialGraphProvider,
  SocialGraphProviderRegistry,
} from "@social-graph/core";

const fullCapabilities = {
  profileLookup: true,
  followerCount: true,
  followingCount: true,
  followerIdentities: true,
  followingIdentities: true,
  pagination: true,
  stableUserIds: true,
};

const instagramScenario: FakeProviderScenario = {
  platform: "instagram",
  capabilities: { ...fullCapabilities },
  profiles: {
    alpha: {
      profile: { platform: "instagram", platformUserId: "ig-alpha", username: "alpha" },
      followers: [
        [
          { platform: "instagram", platformUserId: "ig-f1", username: "follower-one" },
          { platform: "instagram", platformUserId: "ig-f2", username: "follower-two" },
        ],
        [
          { platform: "instagram", platformUserId: "ig-f2", username: "follower-two-renamed" },
          { platform: "instagram", platformUserId: "ig-f3", username: "follower-three" },
        ],
      ],
      following: [
        [{ platform: "instagram", platformUserId: "ig-g1", username: "friend-one" }],
      ],
    },
  },
};

const xScenario: FakeProviderScenario = {
  platform: "x",
  capabilities: { ...fullCapabilities },
  profiles: {},
};

const tiktokScenario: FakeProviderScenario = {
  platform: "tiktok",
  capabilities: { ...fullCapabilities, followingIdentities: false },
  failureSchedules: {
    fetchFollowersPage: [
      {
        category: "SOURCE_TEMPORARILY_UNAVAILABLE",
        message: "Transient fake outage",
        retryable: true,
      },
    ],
  },
  profiles: {
    gamma: {
      profile: { platform: "tiktok", platformUserId: "tt-gamma", username: "gamma" },
      followers: [
        [{ platform: "tiktok", platformUserId: "tt-f1", username: "tk-one" }],
      ],
      following: [],
    },
  },
};

const fastRetry = {
  policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  sleep: async () => {},
};

function defaultRegistry(): SocialGraphProviderRegistry {
  return new Map([
    ["instagram", FakeProvider.fromScenario(instagramScenario)],
    ["x", FakeProvider.fromScenario(xScenario)],
    ["tiktok", FakeProvider.fromScenario(tiktokScenario)],
  ]);
}

const batchInput = {
  targets: [
    { platform: "instagram", username: "alpha" },
    { platform: "x", username: "beta" },
    { platform: "tiktok", username: "gamma" },
  ],
  scrapeType: "both",
};

describe("runActor end-to-end flow (FakeProvider registry)", () => {
  it("streams the batch, delivers rows, and records per-target outcomes", async () => {
    const dataset = new LocalDatasetWriter();
    const outcome = await runActor(batchInput, {
      registry: defaultRegistry(),
      dataset,
    }, { retry: fastRetry });

    // Dataset rows keep per-target order; cross-target interleaving is legal.
    const instagramRows = dataset.rows.filter((row) => row.platform === "instagram");
    const tiktokRows = dataset.rows.filter((row) => row.platform === "tiktok");
    expect(instagramRows.map((row) => row.userId)).toEqual([
      "ig-f1",
      "ig-f2",
      "ig-f3",
      "ig-g1",
    ]);
    expect(tiktokRows.map((row) => row.userId)).toEqual(["tt-f1"]);
    expect(outcome.rowsWritten).toBe(5);
    expect(outcome.rowsDropped).toBe(0);
    expect(outcome.aborted).toBe(false);

    const byTarget = new Map(outcome.targets.map((target) => [target.targetId, target]));
    expect(byTarget.get("t1")).toMatchObject({
      platform: "instagram",
      coreStatus: "SUCCESS",
      delivery: "delivered",
      profilesResolved: true,
    });
    expect(byTarget.get("t1")?.collections).toHaveLength(2);
    expect(byTarget.get("t2")).toMatchObject({
      platform: "x",
      coreStatus: "FAILED",
      delivery: "not-run",
      profilesResolved: false,
      collections: [],
    });
    expect(byTarget.get("t3")).toMatchObject({
      platform: "tiktok",
      coreStatus: "PARTIAL",
      delivery: "delivered",
      profilesResolved: true,
    });

    // Capability gating reached the actor unchanged.
    const tiktokFollowing = byTarget.get("t3")?.collections.find(
      (collection) => collection.relationship === "following",
    );
    expect(tiktokFollowing?.completeness).toMatchObject({
      complete: false,
      terminationReason: "ERROR",
      error: { category: "CAPABILITY_UNSUPPORTED" },
    });

    // Run metrics captured from the batch.
    expect(outcome.metrics).toMatchObject({
      profilesRequested: 3,
      profilesSuccessful: 1,
      profilesFailed: 1,
      profilesPartial: 1,
      followersReturned: 4,
      followingReturned: 1,
      totalRelationshipsReturned: 5,
    });
  });

  it("never leaks provider-only fields into stored rows", async () => {
    const dataset = new LocalDatasetWriter();
    await runActor(batchInput, { registry: defaultRegistry(), dataset }, { retry: fastRetry });

    const serialized = JSON.stringify(dataset.rows);
    expect(serialized).not.toContain("fake:");
    expect(serialized).not.toContain("requestMetadata");
    expect(serialized).not.toContain("nextCursor");
  });

  it("converts a dataset write failure into a persistence failure for that target only", async () => {
    const dataset = new LocalDatasetWriter({
      failWhen: (row) => row.platform === "instagram",
    });
    const outcome = await runActor(batchInput, {
      registry: defaultRegistry(),
      dataset,
    }, { retry: fastRetry });

    const byTarget = new Map(outcome.targets.map((target) => [target.targetId, target]));
    // Core completed instagram, but delivery must never be reported successful.
    expect(byTarget.get("t1")?.coreStatus).toBe("SUCCESS");
    expect(byTarget.get("t1")?.delivery).toBe("persistence-failed");
    // Other targets continue and deliver.
    expect(byTarget.get("t3")).toMatchObject({ coreStatus: "PARTIAL", delivery: "delivered" });
    expect(dataset.rows.every((row) => row.platform !== "instagram")).toBe(true);
    expect(outcome.rowsWritten).toBe(1);
    expect(outcome.rowsDropped).toBeGreaterThanOrEqual(1);
  });

  it("accounts mixed write successes and failures exactly at batchSize 3", async () => {
    const dataset = new LocalDatasetWriter({
      failWhen: (row) => row.platform === "instagram" && row.userId === "ig-f2",
    });
    const outcome = await runActor(batchInput, {
      registry: defaultRegistry(),
      dataset,
    }, { retry: fastRetry, batchSize: 3 });

    const totalRelationshipEvents =
      dataset.rows.length + outcome.rowsDropped;
    expect(outcome.rowsWritten + outcome.rowsDropped).toBe(totalRelationshipEvents);
    expect(outcome.targets.find((target) => target.targetId === "t1")?.delivery)
      .toBe("persistence-failed");
    expect(outcome.targets.find((target) => target.targetId === "t3")?.delivery)
      .toBe("delivered");
    expect(dataset.rows.some((row) => row.userId === "ig-f2")).toBe(false);
  });

  it("delivers a zero-row successful target as delivered", async () => {
    const emptyScenario: FakeProviderScenario = {
      platform: "x",
      capabilities: { ...fullCapabilities },
      profiles: {
        beta: {
          profile: { platform: "x", platformUserId: "x-beta", username: "beta" },
          followers: [],
          following: [],
        },
      },
    };
    const registry = new Map([
      ["x", FakeProvider.fromScenario(emptyScenario)],
    ]) as SocialGraphProviderRegistry;
    const dataset = new LocalDatasetWriter();

    const outcome = await runActor(
      { targets: [{ platform: "x", username: "beta" }], scrapeType: "followers" },
      { registry, dataset },
      { retry: fastRetry },
    );

    expect(dataset.rows).toHaveLength(0);
    expect(outcome.rowsWritten).toBe(0);
    expect(outcome.targets[0]).toMatchObject({ coreStatus: "SUCCESS", delivery: "delivered" });
  });

  it("completes normally when the timeout never fires and clears its timer", async () => {
    const dataset = new LocalDatasetWriter();
    const outcome = await runActor(batchInput, {
      registry: defaultRegistry(),
      dataset,
    }, { retry: fastRetry, runTimeoutMs: 60_000 });

    expect(outcome.aborted).toBe(false);
    expect(outcome.abortReason).toBeUndefined();
    expect(outcome.rowsWritten).toBe(5);
  });

  it("supports bounded-batch delivery with the same outcome", async () => {
    const dataset = new LocalDatasetWriter();
    const outcome = await runActor(batchInput, {
      registry: defaultRegistry(),
      dataset,
    }, { retry: fastRetry, batchSize: 2 });

    expect(outcome.rowsWritten).toBe(5);
    expect(dataset.rows).toHaveLength(5);
    expect(outcome.targets.find((target) => target.targetId === "t1")?.delivery)
      .toBe("delivered");
  });

  it("converts an actor-run timeout into aborted outcomes with finalized metrics", async () => {
    const signals: AbortSignal[] = [];
    const hangingProvider = {
      providerName: "hanging",
      platform: "instagram" as const,
      capabilities: { ...fullCapabilities },
      resolveProfile: async () => ({ platform: "instagram", platformUserId: "ig-hang", username: "hang" }),
      fetchFollowersPage: (_input: unknown, context: ProviderRequestContext) => {
        signals.push(context.signal ?? new AbortController().signal);
        return new Promise<ProviderRelationshipPage>((_resolve, reject) => {
          const signal = context.signal;
          if (signal === undefined) return;
          const abortError = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (signal.aborted) abortError();
          else signal.addEventListener("abort", abortError, { once: true });
        });
      },
      fetchFollowingPage: async () => {
        throw new Error("not reached");
      },
    } as unknown as SocialGraphProvider;
    const registry = new Map([["instagram", hangingProvider]]) as SocialGraphProviderRegistry;

    const dataset = new LocalDatasetWriter();
    const outcome = await runActor(
      { targets: [{ platform: "instagram", username: "hang" }], scrapeType: "followers" },
      { registry, dataset },
      { retry: fastRetry, runTimeoutMs: 30 },
    );

    expect(outcome.aborted).toBe(true);
    expect(outcome.abortReason).toBe("timeout");
    expect(signals[0]?.aborted).toBe(true);
    expect(dataset.rows).toHaveLength(0);
    const target = outcome.targets.find((entry) => entry.targetId === "t1");
    expect(target?.collections.at(-1)?.completeness).toMatchObject({
      complete: false,
      terminationReason: "ABORTED",
    });
    expect((outcome.metrics as CoreRunMetrics | undefined)?.requestsMade).toBeGreaterThanOrEqual(1);
  });

  it("rejects invalid input before any provider work", async () => {
    const registry = defaultRegistry();
    const dataset = new LocalDatasetWriter();

    await expect(runActor(
      { targets: [], scrapeType: "followers" },
      { registry, dataset },
    )).rejects.toThrowError(/INVALID_INPUT/);
    expect(dataset.rows).toHaveLength(0);
  });
});

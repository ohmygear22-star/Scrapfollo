import { describe, expect, it, vi } from "vitest";
import {
  collectRelationships,
  resolveProfile,
  retryOperation,
} from "../src/index.js";
import type {
  CollectRelationshipRequest,
  ProviderProfile,
  ProviderRelationshipItem,
  ProviderRelationshipPage,
  RelationshipStreamEvent,
  RetryPolicy,
  SocialGraphProviderCapabilities,
} from "../src/index.js";

function transientError(message = "transient"): Error & { category: string; retryable: boolean } {
  return Object.assign(new Error(message), {
    category: "SOURCE_TEMPORARILY_UNAVAILABLE",
    retryable: true,
  });
}

function permanentError(): Error & { category: string; retryable: boolean } {
  return Object.assign(new Error("permanent"), {
    category: "PROFILE_NOT_FOUND",
    retryable: false,
  });
}

describe("retryOperation", () => {
  it("retries a transient operation up to success with exponential delays", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const result = await retryOperation(
      async () => {
        attempts += 1;
        if (attempts < 3) throw transientError();
        return "ok";
      },
      {
        policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry a permanent error", async () => {
    let attempts = 0;

    await expect(retryOperation(
      async () => {
        attempts += 1;
        throw permanentError();
      },
      {
        policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
        sleep: async () => {},
      },
    )).rejects.toMatchObject({ retryable: false });
    expect(attempts).toBe(1);
  });

  it("stops after exhausting maxAttempts and reports the last failure", async () => {
    let attempts = 0;
    const retries: number[] = [];

    await expect(retryOperation(
      async () => {
        attempts += 1;
        throw transientError(`failure ${attempts}`);
      },
      {
        policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
        sleep: async () => {},
        hooks: {
          onRetry: (info) => retries.push(info.attempt),
        },
      },
    )).rejects.toMatchObject({ message: "failure 3" });
    expect(attempts).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it("caps the exponential delay at maxDelayMs", async () => {
    const delays: number[] = [];

    await expect(retryOperation(
      async () => {
        throw transientError();
      },
      {
        policy: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 150, jitterRatio: 0 },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    )).rejects.toThrow();
    expect(delays).toEqual([100, 150, 150]);
  });

  it("applies injected jitter symmetrically around the base delay", async () => {
    const delays: number[] = [];

    await expect(retryOperation(
      async () => {
        throw transientError();
      },
      {
        policy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.5 },
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 0,
      },
    )).rejects.toThrow();
    expect(delays).toEqual([50]);
  });

  it("honors a normalized retryAfterMs as the delay minimum", async () => {
    const delays: number[] = [];
    const rateLimited = Object.assign(new Error("slow down"), {
      category: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: 5_000,
    });

    await expect(retryOperation(
      async () => {
        throw rateLimited;
      },
      {
        policy: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    )).rejects.toThrow();
    expect(delays).toEqual([5_000]);
  });

  it("emits attempt, failure, and retry hooks for metrics accounting", async () => {
    const made: number[] = [];
    const failed: number[] = [];
    const retried: number[] = [];
    let attempts = 0;

    await retryOperation(
      async () => {
        attempts += 1;
        if (attempts < 3) throw transientError();
        return "done";
      },
      {
        policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
        sleep: async () => {},
        hooks: {
          onAttempt: (info) => made.push(info.attempt),
          onFailure: (info) => failed.push(info.attempt),
          onRetry: (info) => retried.push(info.attempt),
        },
      },
    );

    expect(made).toEqual([1, 2, 3]);
    expect(failed).toEqual([1, 2]);
    expect(retried).toEqual([1, 2]);
  });

  it("rejects immediately when the policy allows only one attempt", async () => {
    let attempts = 0;

    await expect(retryOperation(
      async () => {
        attempts += 1;
        throw transientError();
      },
      {
        policy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 },
        sleep: async () => {},
      },
    )).rejects.toThrow("transient");
    expect(attempts).toBe(1);
  });
});

const capabilities: SocialGraphProviderCapabilities = {
  profileLookup: true,
  followerCount: false,
  followingCount: false,
  followerIdentities: true,
  followingIdentities: true,
  pagination: true,
  stableUserIds: true,
};

const request: CollectRelationshipRequest = {
  runId: "run-1",
  targetId: "target-1",
  platform: "instagram",
  username: "source",
  relationship: "followers",
};

const sourceProfile: ProviderProfile = {
  platform: "instagram",
  platformUserId: "source-id",
  username: "source",
};

function retryPageProvider(failuresBeforeSuccess: number, permanent = false) {
  const provider = {
    providerName: "retry-test-provider",
    platform: "instagram" as const,
    capabilities: { ...capabilities },
    pageCalls: 0,
    resolveProfile: vi.fn(),
    fetchFollowersPage: vi.fn(async (): Promise<ProviderRelationshipPage> => {
      provider.pageCalls += 1;
      if (provider.pageCalls <= failuresBeforeSuccess) {
        throw permanent ? permanentError() : transientError();
      }
      return {
        items: [{
          platform: "instagram",
          platformUserId: "u1",
          username: "alice",
        } satisfies ProviderRelationshipItem],
        hasMore: false,
        requestMetadata: { attempts: 1, durationMs: 4 },
      };
    }),
    fetchFollowingPage: vi.fn(),
  };
  return provider;
}

async function consume(stream: AsyncIterable<RelationshipStreamEvent>) {
  const events: RelationshipStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const fastRetry = {
  policy: {
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
    jitterRatio: 0,
  } satisfies RetryPolicy,
  sleep: async () => {},
};

describe("retry wiring through collection operations", () => {
  it("retries a transient relationship page failure and completes the stream", async () => {
    const provider = retryPageProvider(1);

    const events = await consume(collectRelationships(
      request,
      sourceProfile,
      provider,
      { retry: fastRetry },
    ));

    expect(provider.pageCalls).toBe(2);
    expect(events[0]).toMatchObject({
      type: "relationship",
      value: { userId: "u1", position: 1 },
    });
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: {
        completeness: { complete: true, terminationReason: "SOURCE_EXHAUSTED" },
        metrics: { requestsMade: 2, requestsFailed: 1, requestsRetried: 1 },
      },
    });
  });

  it("stops immediately on a permanent page failure", async () => {
    const provider = retryPageProvider(1, true);

    const events = await consume(collectRelationships(
      request,
      sourceProfile,
      provider,
      { retry: fastRetry },
    ));

    expect(provider.pageCalls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "summary",
      value: {
        completeness: {
          complete: false,
          terminationReason: "ERROR",
          error: { category: "PROFILE_NOT_FOUND", retryable: false },
        },
        metrics: { requestsMade: 1, requestsFailed: 1, requestsRetried: 0 },
      },
    });
  });

  it("ends with an ERROR summary after exhausting page retries", async () => {
    const provider = retryPageProvider(99);

    const events = await consume(collectRelationships(
      request,
      sourceProfile,
      provider,
      { retry: fastRetry },
    ));

    expect(provider.pageCalls).toBe(3);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: {
        completeness: {
          complete: false,
          terminationReason: "ERROR",
          error: { category: "SOURCE_TEMPORARILY_UNAVAILABLE" },
        },
        metrics: { requestsMade: 3, requestsFailed: 3, requestsRetried: 2 },
      },
    });
  });

  it("retries profile resolution through the same orchestration", async () => {
    let calls = 0;
    const provider = {
      providerName: "retry-profile-provider",
      platform: "instagram" as const,
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(async (): Promise<ProviderProfile> => {
        calls += 1;
        if (calls < 2) throw transientError();
        return { platform: "instagram", platformUserId: "id-1", username: "source" };
      }),
      fetchFollowersPage: vi.fn(),
      fetchFollowingPage: vi.fn(),
    };

    const profile = await resolveProfile(request, provider, { retry: fastRetry });

    expect(calls).toBe(2);
    expect(profile.platformUserId).toBe("id-1");
  });
});

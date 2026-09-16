import { describe, expect, it, vi } from "vitest";
import {
  abortableDelay,
  collectRelationships,
  retryOperation,
} from "../src/index.js";
import type {
  CollectRelationshipRequest,
  ProviderProfile,
  ProviderRelationshipPage,
  ProviderRequestContext,
  RelationshipStreamEvent,
  SocialGraphProvider,
  SocialGraphProviderCapabilities,
} from "../src/index.js";

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

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as Error).name === "AbortError";
}

/** Provider whose page fetch stays pending until its received signal aborts. */
function blockingProvider(): SocialGraphProvider & {
  observedSignals: AbortSignal[];
  pageCalls: number;
} {
  const provider = {
    providerName: "blocking-test-provider",
    platform: "instagram" as const,
    capabilities: { ...capabilities },
    observedSignals: [] as AbortSignal[],
    pageCalls: 0,
    resolveProfile: vi.fn(),
    fetchFollowersPage: vi.fn((_input: unknown, context: ProviderRequestContext) => {
      provider.pageCalls += 1;
      provider.observedSignals.push(context.signal ?? new AbortController().signal);
      return new Promise<ProviderRelationshipPage>((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => {
          reject(abortError());
        }, { once: true });
      });
    }),
    fetchFollowingPage: vi.fn(),
  };
  return provider;
}

/** Provider that resolves pages but records every received signal. */
function recordingProvider(): SocialGraphProvider & {
  observedSignals: AbortSignal[];
  pageCalls: number;
} {
  const provider = {
    providerName: "recording-test-provider",
    platform: "instagram" as const,
    capabilities: { ...capabilities },
    observedSignals: [] as AbortSignal[],
    pageCalls: 0,
    resolveProfile: vi.fn(),
    fetchFollowersPage: vi.fn(async (_input: unknown, context: ProviderRequestContext) => {
      provider.pageCalls += 1;
      provider.observedSignals.push(context.signal ?? new AbortController().signal);
      return {
        items: [{ platform: "instagram", platformUserId: "u1", username: "alice" }],
        hasMore: false,
        requestMetadata: { attempts: 1, durationMs: 1 },
      } satisfies ProviderRelationshipPage;
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

describe("abortableDelay", () => {
  it("resolves after the requested delay", async () => {
    const start = Date.now();
    await abortableDelay(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("rejects promptly when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    await expect(abortableDelay(5_000, controller.signal)).rejects.satisfy(isAbortError);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("rejects promptly when the signal aborts mid-delay", async () => {
    const controller = new AbortController();
    const pending = abortableDelay(5_000, controller.signal);

    setTimeout(() => controller.abort(), 10);

    const start = Date.now();
    await expect(pending).rejects.satisfy(isAbortError);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("retryOperation cancellation", () => {
  it("never invokes the operation when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => "unused");
    const sleep = vi.fn(async () => {});

    await expect(retryOperation(operation, {
      policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      sleep,
      signal: controller.signal,
    })).rejects.satisfy(isAbortError);

    expect(operation).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops retrying when the signal aborts during backoff", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const transient = Object.assign(new Error("flaky"), {
      category: "SOURCE_TEMPORARILY_UNAVAILABLE",
      retryable: true,
    });

    const pending = retryOperation(
      async () => {
        attempts += 1;
        throw transient;
      },
      {
        policy: { maxAttempts: 5, baseDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 },
        sleep: (ms, signal) => abortableDelay(ms, signal),
        signal: controller.signal,
      },
    );

    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.satisfy(isAbortError);
    expect(attempts).toBe(1);
  });
});

function trackedSignal(): {
  controller: AbortController;
  signal: AbortSignal;
  abortEventListenersAdded: () => number;
  abortEventListenersRemoved: () => number;
} {
  const controller = new AbortController();
  const signal = controller.signal;
  const add = vi.fn(signal.addEventListener.bind(signal));
  const remove = vi.fn(signal.removeEventListener.bind(signal));
  signal.addEventListener = add as typeof signal.addEventListener;
  signal.removeEventListener = remove as typeof signal.removeEventListener;
  return {
    controller,
    signal,
    abortEventListenersAdded: () => add.mock.calls.filter(([event]) => event === "abort").length,
    abortEventListenersRemoved: () => remove.mock.calls.filter(([event]) => event === "abort").length,
  };
}

describe("collectRelationships cancellation", () => {
  it("ends an externally aborted consumed stream with ABORTED", async () => {
    const controller = new AbortController();
    const provider = blockingProvider();
    const iterator = collectRelationships(
      { ...request, signal: controller.signal },
      sourceProfile,
      provider,
    );

    const pending = iterator.next();
    controller.abort();
    const final = await pending;

    expect(final.done).toBe(false);
    expect(final.value).toMatchObject({
      type: "summary",
      value: {
        completeness: {
          complete: false,
          terminationReason: "ABORTED",
        },
        metrics: { requestsMade: 1 },
      },
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("yields ABORTED without any page call when the signal aborts before the first pull resolves", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = blockingProvider();

    const events = await consume(collectRelationships(
      { ...request, signal: controller.signal },
      sourceProfile,
      provider,
    ));

    expect(provider.pageCalls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "summary",
      value: { completeness: { complete: false, terminationReason: "ABORTED" } },
    });
    expect((events[0] as { value: { completeness: { error?: unknown } } }).value.completeness.error)
      .toBeUndefined();
  });

  it("does not leak abort listeners after normal completion", async () => {
    const tracked = trackedSignal();
    const provider = recordingProvider();

    await consume(collectRelationships(
      { ...request, signal: tracked.signal },
      sourceProfile,
      provider,
    ));

    expect(tracked.abortEventListenersRemoved())
      .toBe(tracked.abortEventListenersAdded());
  });

  it("does not leak abort listeners after an aborted stream", async () => {
    const tracked = trackedSignal();
    const provider = blockingProvider();

    const pending = consume(collectRelationships(
      { ...request, signal: tracked.signal },
      sourceProfile,
      provider,
    ));
    tracked.controller.abort();
    await pending;

    expect(tracked.abortEventListenersRemoved())
      .toBe(tracked.abortEventListenersAdded());
  });

  it("aborts provider work when the consumer closes the iterator early", async () => {
    const tracked = trackedSignal();
    const provider = recordingProvider();
    const iterator = collectRelationships(
      { ...request, signal: tracked.signal },
      sourceProfile,
      provider,
    );

    await iterator.next();
    const closed = await iterator.return(undefined);

    expect(closed).toEqual({ done: true, value: undefined });
    expect(provider.pageCalls).toBe(1);
    expect(provider.observedSignals[0]?.aborted).toBe(true);
    expect(tracked.abortEventListenersRemoved())
      .toBe(tracked.abortEventListenersAdded());
  });

  it("settles without a summary when the consumer closes during a pending page fetch", async () => {
    const provider = {
      providerName: "slow-resolving-provider",
      platform: "instagram" as const,
      capabilities: { ...capabilities },
      observedSignals: [] as AbortSignal[],
      resolveProfile: vi.fn(),
      fetchFollowersPage: vi.fn(async (_input: unknown, context: ProviderRequestContext) => {
        provider.observedSignals.push(context.signal ?? new AbortController().signal);
        await abortableDelay(20);
        return {
          items: [{ platform: "instagram", platformUserId: "u1", username: "alice" }],
          hasMore: false,
          requestMetadata: { attempts: 1, durationMs: 1 },
        } satisfies ProviderRelationshipPage;
      }),
      fetchFollowingPage: vi.fn(),
    };
    const iterator = collectRelationships(request, sourceProfile, provider);

    const pending = iterator.next();
    const closed = iterator.return(undefined);
    const first = await pending;

    expect(first.value).toMatchObject({ type: "relationship", value: { userId: "u1" } });
    await closed;
    expect(provider.observedSignals[0]?.aborted).toBe(true);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("ends an external abort during retry backoff with ABORTED", async () => {
    const controller = new AbortController();
    let calls = 0;
    const transient = Object.assign(new Error("flaky"), {
      category: "SOURCE_TEMPORARILY_UNAVAILABLE",
      retryable: true,
    });
    const provider = {
      providerName: "abort-backoff-provider",
      platform: "instagram" as const,
      capabilities: { ...capabilities },
      resolveProfile: vi.fn(),
      fetchFollowersPage: vi.fn(async () => {
        calls += 1;
        throw transient;
      }),
      fetchFollowingPage: vi.fn(),
    };

    const pending = consume(collectRelationships(
      { ...request, signal: controller.signal },
      sourceProfile,
      provider,
    ));

    setTimeout(() => controller.abort(), 10);

    const events = await pending;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      value: { completeness: { complete: false, terminationReason: "ABORTED" } },
    });
  });
});
